namespace Jellyfin.Plugin.AniWorldDownloader.Library;

/// <summary>
/// Collects finished downloads and says when to scan for them: once the queue
/// has settled, so a run of downloads ends in one scan instead of one each.
/// </summary>
public class PendingScan
{
    /// <summary>
    /// How long after the last finished download to wait for the next one.
    /// </summary>
    public static readonly TimeSpan Settle = TimeSpan.FromSeconds(30);

    /// <summary>
    /// The longest a finished download waits for its scan while the queue
    /// keeps going.
    /// </summary>
    public static readonly TimeSpan MaxWait = TimeSpan.FromMinutes(10);

    private readonly HashSet<string> _titles = new(StringComparer.Ordinal);
    private DateTime _first;
    private DateTime _last;

    /// <summary>
    /// Records a finished download.
    /// </summary>
    /// <param name="title">Its title, as AniWorld has it.</param>
    /// <param name="now">The time, in UTC.</param>
    public void Add(string title, DateTime now)
    {
        if (_titles.Count == 0)
        {
            _first = now;
        }

        _titles.Add(title);
        _last = now;
    }

    /// <summary>
    /// Takes the titles to scan for, when it is time.
    /// </summary>
    /// <param name="busy">Whether something is still queued or downloading.</param>
    /// <param name="now">The time, in UTC.</param>
    /// <returns>The titles, or null when it isn't time yet.</returns>
    public IReadOnlyCollection<string>? TakeIfDue(bool busy, DateTime now)
    {
        if (_titles.Count == 0)
        {
            return null;
        }

        var settled = !busy && now - _last >= Settle;
        if (!settled && now - _first < MaxWait)
        {
            return null;
        }

        var titles = _titles.ToList();
        _titles.Clear();
        return titles;
    }
}
