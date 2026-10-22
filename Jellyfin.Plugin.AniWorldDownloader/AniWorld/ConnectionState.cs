namespace Jellyfin.Plugin.AniWorldDownloader.AniWorld;

/// <summary>
/// Tells from the queue checks when AniWorld Downloader goes down and when it
/// comes back, so each is reported once instead of on every check.
/// </summary>
public class ConnectionState
{
    /// <summary>
    /// How many checks in a row must fail before it counts as down, so one
    /// slow answer doesn't raise an alarm.
    /// </summary>
    public const int FailuresUntilDown = 2;

    private int _failures;
    private bool _down;

    /// <summary>
    /// Records how a check went.
    /// </summary>
    /// <param name="ok">Whether AniWorld Downloader answered as expected.</param>
    /// <returns>Down or Up when that just changed, otherwise null.</returns>
    public ConnectionChange? Report(bool ok)
    {
        if (ok)
        {
            _failures = 0;
            if (!_down)
            {
                return null;
            }

            _down = false;
            return ConnectionChange.Up;
        }

        _failures++;
        if (_down || _failures < FailuresUntilDown)
        {
            return null;
        }

        _down = true;
        return ConnectionChange.Down;
    }
}

/// <summary>
/// A change in whether AniWorld Downloader answers.
/// </summary>
public enum ConnectionChange
{
    /// <summary>
    /// It stopped answering.
    /// </summary>
    Down,

    /// <summary>
    /// It answers again.
    /// </summary>
    Up,
}
