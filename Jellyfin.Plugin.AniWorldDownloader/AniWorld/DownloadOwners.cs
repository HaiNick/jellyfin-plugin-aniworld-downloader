using System.Text.Json;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AniWorldDownloader.AniWorld;

/// <summary>
/// Remembers which Jellyfin user queued which AniWorld download, so the
/// "done" message goes to them. Kept in a file next to the plugin's settings,
/// so a restart in the middle of a download doesn't lose it.
/// </summary>
public class DownloadOwners
{
    // A download that hasn't finished in a week isn't coming back
    private static readonly TimeSpan _keepFor = TimeSpan.FromDays(7);

    private readonly string _path;
    private readonly TimeProvider _time;
    private readonly ILogger<DownloadOwners> _logger;
    private readonly Lock _lock = new();
    private readonly Dictionary<int, DownloadOwner> _owners;

    /// <summary>
    /// Initializes a new instance of the <see cref="DownloadOwners"/> class.
    /// </summary>
    /// <param name="applicationPaths">The server's paths.</param>
    /// <param name="logger">The logger.</param>
    public DownloadOwners(IApplicationPaths applicationPaths, ILogger<DownloadOwners> logger)
        : this(Path.Combine(applicationPaths.PluginConfigurationsPath, "AniWorldDownloader", "owners.json"), TimeProvider.System, logger)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="DownloadOwners"/> class
    /// with its own file and clock, for the tests.
    /// </summary>
    /// <param name="path">The file to keep the owners in.</param>
    /// <param name="time">The clock.</param>
    /// <param name="logger">The logger.</param>
    internal DownloadOwners(string path, TimeProvider time, ILogger<DownloadOwners> logger)
    {
        _path = path;
        _time = time;
        _logger = logger;
        _owners = Load();
    }

    /// <summary>
    /// Records who queued a download.
    /// </summary>
    /// <param name="queueId">AniWorld's queue ID.</param>
    /// <param name="userId">The Jellyfin user.</param>
    public void Add(int queueId, Guid userId)
    {
        lock (_lock)
        {
            var now = _time.GetUtcNow().UtcDateTime;
            foreach (var old in _owners.Where(o => now - o.Value.At > _keepFor).Select(o => o.Key).ToList())
            {
                _owners.Remove(old);
            }

            _owners[queueId] = new DownloadOwner(userId, now);
            Save();
        }
    }

    /// <summary>
    /// Takes the user who queued a download, if known.
    /// </summary>
    /// <param name="queueId">AniWorld's queue ID.</param>
    /// <returns>The user, or null.</returns>
    public Guid? Take(int queueId)
    {
        lock (_lock)
        {
            if (!_owners.Remove(queueId, out var owner))
            {
                return null;
            }

            Save();
            return owner.UserId;
        }
    }

    private Dictionary<int, DownloadOwner> Load()
    {
        try
        {
            if (File.Exists(_path))
            {
                return JsonSerializer.Deserialize<Dictionary<int, DownloadOwner>>(File.ReadAllText(_path)) ?? [];
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // The messages then go to the admins, as before there was a file
            _logger.LogWarning(ex, "AniWorld Downloader: could not read {Path}", _path);
        }

        return [];
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

            // Write next to it and swap, so a crash never leaves half a file
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_owners));
            File.Move(temp, _path, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "AniWorld Downloader: could not write {Path}", _path);
        }
    }
}

/// <summary>
/// Who queued a download, and when.
/// </summary>
/// <param name="UserId">The Jellyfin user.</param>
/// <param name="At">When it was queued, in UTC.</param>
public record DownloadOwner(Guid UserId, DateTime At);
