using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.AniWorldDownloader.Library;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AniWorldDownloader.AniWorld;

/// <summary>
/// Watches AniWorld Downloader's queue and tells people when a download is
/// done or has failed: a message in their open Jellyfin apps and an entry in
/// the dashboard's activity log. Scans the library for finished downloads,
/// and logs once when AniWorld Downloader stops answering and once when it
/// is back.
/// </summary>
public class DownloadWatcher : BackgroundService
{
    // Quick while something downloads, slow while nothing does
    private static readonly TimeSpan _busyPoll = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan _idlePoll = TimeSpan.FromSeconds(60);

    private readonly AniWorldClient _aniWorld;
    private readonly DownloadOwners _owners;
    private readonly ISessionManager _sessionManager;
    private readonly IActivityManager _activityManager;
    private readonly IUserManager _userManager;
    private readonly ILibraryManager _libraryManager;
    private readonly LibraryMatcher _library;
    private readonly IFileSystem _fileSystem;
    private readonly ILogger<DownloadWatcher> _logger;
    private readonly Dictionary<int, string> _lastStatus = new();
    private readonly PendingScan _pendingScan = new();

    // Finished manga waiting for that scan. A manga shares its title with the
    // anime, so finding the title in the library says nothing about where it went.
    private readonly HashSet<string> _pendingManga = new(StringComparer.Ordinal);
    private readonly ConnectionState _connection = new();
    private bool _primed;

    /// <summary>
    /// Initializes a new instance of the <see cref="DownloadWatcher"/> class.
    /// </summary>
    /// <param name="aniWorld">The AniWorld client.</param>
    /// <param name="owners">Who queued which download.</param>
    /// <param name="sessionManager">The session manager.</param>
    /// <param name="activityManager">The activity log.</param>
    /// <param name="userManager">The user manager.</param>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="library">Matches titles against the Jellyfin library.</param>
    /// <param name="fileSystem">The file system.</param>
    /// <param name="logger">The logger.</param>
    public DownloadWatcher(
        AniWorldClient aniWorld,
        DownloadOwners owners,
        ISessionManager sessionManager,
        IActivityManager activityManager,
        IUserManager userManager,
        ILibraryManager libraryManager,
        LibraryMatcher library,
        IFileSystem fileSystem,
        ILogger<DownloadWatcher> logger)
    {
        _aniWorld = aniWorld;
        _owners = owners;
        _sessionManager = sessionManager;
        _activityManager = activityManager;
        _userManager = userManager;
        _libraryManager = libraryManager;
        _library = library;
        _fileSystem = fileSystem;
        _logger = logger;
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var busy = false;
            try
            {
                busy = await CheckAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "AniWorld Downloader: queue check failed");
            }

            try
            {
                await ScanIfDueAsync(busy, stoppingToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "AniWorld Downloader: library scan failed");
            }

            try
            {
                await Task.Delay(busy ? _busyPoll : _idlePoll, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task<bool> CheckAsync(CancellationToken cancellationToken)
    {
        if (!AniWorldClient.IsConfigured)
        {
            return false;
        }

        var query = new Dictionary<string, string?> { ["limit"] = "30" };
        var reply = await _aniWorld.SendAsync(HttpMethod.Get, "queue", query, null, cancellationToken, quiet: true).ConfigureAwait(false);
        var items = reply.Status == 200 ? reply.Json?["items"] as JsonArray : null;
        await ReportConnectionAsync(reply, items is not null).ConfigureAwait(false);
        if (items is null)
        {
            return false;
        }

        var busy = false;
        var seen = new HashSet<int>();
        foreach (var item in items.OfType<JsonObject>())
        {
            if (item["id"]?.GetValue<int>() is not int id || item["status"]?.GetValue<string>() is not { } status)
            {
                continue;
            }

            seen.Add(id);
            busy |= status is "queued" or "running";
            var known = _lastStatus.TryGetValue(id, out var previous);
            _lastStatus[id] = status;

            // The first look only learns what is there; after that, a download
            // that just finished either changed status or finished between looks
            var finished = status is "completed" or "failed";
            var wasOpen = !known || previous is "queued" or "running";
            if (_primed && finished && wasOpen)
            {
                await NotifyAsync(id, item, status == "completed", cancellationToken).ConfigureAwait(false);
            }
        }

        foreach (var id in _lastStatus.Keys.Where(id => !seen.Contains(id)).ToList())
        {
            _lastStatus.Remove(id);
        }

        _primed = true;
        return busy;
    }

    private async Task NotifyAsync(int id, JsonObject item, bool done, CancellationToken cancellationToken)
    {
        var title = item["title"]?.GetValue<string>() ?? "A download";
        var episodes = item["total_episodes"]?.GetValue<int>() ?? 0;
        // A manga's parts are chapters or volumes; the queue doesn't say which
        var manga = item["provider"]?.GetValue<string>() == "MangaFire";
        var unit = manga ? "part" : "episode";
        var text = done
            ? $"{title}: {episodes} {unit}{(episodes == 1 ? string.Empty : "s")} downloaded"
            : $"{title}: the download failed";

        if (done && Plugin.Instance?.Configuration.ScanAfterDownload != false)
        {
            _pendingScan.Add(title, DateTime.UtcNow);
            if (manga)
            {
                _pendingManga.Add(title);
            }
        }

        var owner = _owners.Take(id);
        var users = owner is { } userId
            ? [userId]
            : _userManager.GetUsers().Where(u => u.HasPermission(PermissionKind.IsAdministrator)).Select(u => u.Id).ToArray();

        await _activityManager.CreateAsync(new ActivityLog("AniWorld: " + text, "AniWorldDownloader", owner ?? Guid.Empty)
        {
            ShortOverview = done ? "Download finished" : "Download failed",
            LogSeverity = done ? LogLevel.Information : LogLevel.Warning,
        }).ConfigureAwait(false);

        var message = new MessageCommand { Header = "AniWorld", Text = text, TimeoutMs = 10000 };
        foreach (var session in _sessionManager.Sessions.Where(s => s.IsActive && users.Contains(s.UserId)).ToList())
        {
            try
            {
                await _sessionManager.SendMessageCommand(string.Empty, session.Id, message, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // A phone that just went away; the activity log still has it
                _logger.LogDebug(ex, "AniWorld Downloader: could not message session {Session}", session.Id);
            }
        }
    }

    private async Task ReportConnectionAsync(AniWorldReply reply, bool ok)
    {
        var change = _connection.Report(ok);
        if (change == ConnectionChange.Down)
        {
            var error = reply.Json?["error"] is JsonValue value && value.TryGetValue<string>(out var text)
                ? text
                : $"HTTP {reply.Status}";
            _logger.LogWarning("AniWorld Downloader is unavailable: {Error}", error);
            await _activityManager.CreateAsync(new ActivityLog("AniWorld: AniWorld Downloader is unavailable", "AniWorldDownloader", Guid.Empty)
            {
                ShortOverview = error,
                Overview = "Searches and downloads fail until it answers again. Check that it is running and the URL and API key in the plugin settings.",
                LogSeverity = LogLevel.Warning,
            }).ConfigureAwait(false);
        }
        else if (change == ConnectionChange.Up)
        {
            _logger.LogInformation("AniWorld Downloader is available again");
            await _activityManager.CreateAsync(new ActivityLog("AniWorld: AniWorld Downloader is available again", "AniWorldDownloader", Guid.Empty)
            {
                LogSeverity = LogLevel.Information,
            }).ConfigureAwait(false);
        }
    }

    private async Task ScanIfDueAsync(bool busy, CancellationToken cancellationToken)
    {
        if (_pendingScan.TakeIfDue(busy, DateTime.UtcNow) is not { } titles)
        {
            return;
        }

        var manga = titles.Where(_pendingManga.Contains).ToList();
        _pendingManga.Clear();
        if (manga.Count > 0)
        {
            _logger.LogInformation("AniWorld Downloader: new manga ({Titles}), scanning all libraries", string.Join(", ", manga));
            _libraryManager.QueueLibraryScan();
            return;
        }

        // A series already in the library only needs its own folder looked
        // at; anything new could be anywhere, so that takes a full scan
        var series = new List<Folder>();
        foreach (var title in titles)
        {
            if (_library.FindAnywhere(title) is { } id && _libraryManager.GetItemById(id) is Folder folder)
            {
                series.Add(folder);
                continue;
            }

            _logger.LogInformation("AniWorld Downloader: {Title} is not in the library yet, scanning all libraries", title);
            _libraryManager.QueueLibraryScan();
            return;
        }

        foreach (var folder in series.DistinctBy(f => f.Id))
        {
            _logger.LogInformation("AniWorld Downloader: looking for new episodes of {Name}", folder.Name);
            var options = new MetadataRefreshOptions(new DirectoryService(_fileSystem));
            await folder.ValidateChildren(new Progress<double>(), options, true, false, cancellationToken).ConfigureAwait(false);
        }
    }
}
