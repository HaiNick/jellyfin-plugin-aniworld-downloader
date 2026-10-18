using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AniWorldDownloader.AniWorld;

/// <summary>
/// Remembers which Jellyfin user queued which AniWorld download, so the
/// "done" message goes to them. Kept in memory only; after a restart the
/// message for an older download goes to the admins.
/// </summary>
public class DownloadOwners
{
    private readonly ConcurrentDictionary<int, Guid> _owners = new();

    /// <summary>
    /// Records who queued a download.
    /// </summary>
    /// <param name="queueId">AniWorld's queue ID.</param>
    /// <param name="userId">The Jellyfin user.</param>
    public void Add(int queueId, Guid userId) => _owners[queueId] = userId;

    /// <summary>
    /// Takes the user who queued a download, if known.
    /// </summary>
    /// <param name="queueId">AniWorld's queue ID.</param>
    /// <returns>The user, or null.</returns>
    public Guid? Take(int queueId) => _owners.TryRemove(queueId, out var userId) ? userId : null;
}

/// <summary>
/// Watches AniWorld Downloader's queue and tells people when a download is
/// done or has failed: a message in their open Jellyfin apps and an entry in
/// the dashboard's activity log.
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
    private readonly ILogger<DownloadWatcher> _logger;
    private readonly Dictionary<int, string> _lastStatus = new();
    private bool _primed;

    /// <summary>
    /// Initializes a new instance of the <see cref="DownloadWatcher"/> class.
    /// </summary>
    /// <param name="aniWorld">The AniWorld client.</param>
    /// <param name="owners">Who queued which download.</param>
    /// <param name="sessionManager">The session manager.</param>
    /// <param name="activityManager">The activity log.</param>
    /// <param name="userManager">The user manager.</param>
    /// <param name="logger">The logger.</param>
    public DownloadWatcher(
        AniWorldClient aniWorld,
        DownloadOwners owners,
        ISessionManager sessionManager,
        IActivityManager activityManager,
        IUserManager userManager,
        ILogger<DownloadWatcher> logger)
    {
        _aniWorld = aniWorld;
        _owners = owners;
        _sessionManager = sessionManager;
        _activityManager = activityManager;
        _userManager = userManager;
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
        var reply = await _aniWorld.SendAsync(HttpMethod.Get, "queue", query, null, cancellationToken).ConfigureAwait(false);
        if (reply.Status != 200 || reply.Json?["items"] is not JsonArray items)
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
        var text = done
            ? $"{title}: {episodes} {(episodes == 1 ? "episode" : "episodes")} downloaded"
            : $"{title}: the download failed";

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
}
