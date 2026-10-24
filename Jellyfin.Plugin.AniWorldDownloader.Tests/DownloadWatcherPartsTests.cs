using Jellyfin.Plugin.AniWorldDownloader.AniWorld;
using Jellyfin.Plugin.AniWorldDownloader.Library;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.AniWorldDownloader.Tests;

public sealed class DownloadOwnersTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "aniworld-owners-" + Guid.NewGuid().ToString("N"));
    private readonly FakeClock _clock = new();

    private string FilePath => Path.Combine(_dir, "owners.json");

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, true);
        }
    }

    [Fact]
    public void AnOwnerSurvivesARestart()
    {
        var user = Guid.NewGuid();
        Create().Add(7, user);

        Assert.Equal(user, Create().Take(7));
    }

    [Fact]
    public void AnOwnerIsTakenOnce()
    {
        var user = Guid.NewGuid();
        var owners = Create();
        owners.Add(7, user);

        Assert.Equal(user, owners.Take(7));
        Assert.Null(owners.Take(7));
        Assert.Null(Create().Take(7));
    }

    [Fact]
    public void FindingAnOwnerKeepsThem()
    {
        var user = Guid.NewGuid();
        var owners = Create();
        owners.Add(7, user);

        Assert.Equal(user, owners.Find(7));
        Assert.Equal(user, owners.Take(7));
        Assert.Null(owners.Find(7));
    }

    [Fact]
    public void OldOwnersAreDropped()
    {
        var owners = Create();
        owners.Add(1, Guid.NewGuid());
        _clock.Now += TimeSpan.FromDays(8);
        owners.Add(2, Guid.NewGuid());

        Assert.Null(Create().Take(1));
        Assert.NotNull(Create().Take(2));
    }

    [Fact]
    public void ABrokenFileStartsEmpty()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(FilePath, "not json");

        var owners = Create();
        Assert.Null(owners.Take(1));

        var user = Guid.NewGuid();
        owners.Add(1, user);
        Assert.Equal(user, Create().Take(1));
    }

    private DownloadOwners Create() => new(FilePath, _clock, NullLogger<DownloadOwners>.Instance);

    private sealed class FakeClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 10, 22, 12, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => Now;
    }
}

public class PendingScanTests
{
    private static readonly DateTime _start = new(2026, 10, 22, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void NothingFinishedMeansNoScan()
    {
        Assert.Null(new PendingScan().TakeIfDue(false, _start.AddHours(1)));
    }

    [Fact]
    public void ItWaitsForTheQueueToSettle()
    {
        var scan = new PendingScan();
        scan.Add("Naruto", _start);

        Assert.Null(scan.TakeIfDue(false, _start + PendingScan.Settle - TimeSpan.FromSeconds(1)));
        Assert.Equal(["Naruto"], scan.TakeIfDue(false, _start + PendingScan.Settle));
        Assert.Null(scan.TakeIfDue(false, _start + PendingScan.MaxWait));
    }

    [Fact]
    public void ARunOfDownloadsEndsInOneScan()
    {
        var scan = new PendingScan();
        scan.Add("Naruto", _start);
        scan.Add("One Piece", _start.AddSeconds(20));
        scan.Add("Naruto", _start.AddSeconds(40));

        Assert.Null(scan.TakeIfDue(false, _start.AddSeconds(60)));
        var titles = scan.TakeIfDue(false, _start.AddSeconds(70));
        Assert.NotNull(titles);
        Assert.Equal(["Naruto", "One Piece"], titles.Order());
    }

    [Fact]
    public void ABusyQueueWaitsAtMostMaxWait()
    {
        var scan = new PendingScan();
        scan.Add("Naruto", _start);

        Assert.Null(scan.TakeIfDue(true, _start + PendingScan.Settle));
        Assert.Null(scan.TakeIfDue(true, _start + PendingScan.MaxWait - TimeSpan.FromSeconds(1)));
        Assert.Equal(["Naruto"], scan.TakeIfDue(true, _start + PendingScan.MaxWait));
    }
}

public class ConnectionStateTests
{
    [Fact]
    public void OneFailureIsNotAnOutage()
    {
        var state = new ConnectionState();
        Assert.Null(state.Report(false));
        Assert.Null(state.Report(true));
        Assert.Null(state.Report(false));
    }

    [Fact]
    public void AnOutageIsReportedOnceEachWay()
    {
        var state = new ConnectionState();
        Assert.Null(state.Report(true));
        Assert.Null(state.Report(false));
        Assert.Equal(ConnectionChange.Down, state.Report(false));
        Assert.Null(state.Report(false));
        Assert.Null(state.Report(false));
        Assert.Equal(ConnectionChange.Up, state.Report(true));
        Assert.Null(state.Report(true));
    }

    [Fact]
    public void BeingDownFromTheStartCounts()
    {
        var state = new ConnectionState();
        Assert.Null(state.Report(false));
        Assert.Equal(ConnectionChange.Down, state.Report(false));
    }
}
