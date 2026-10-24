using System.Net.Mime;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.AniWorldDownloader.AniWorld;
using Jellyfin.Plugin.AniWorldDownloader.Library;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using MediaBrowser.Model.Activity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AniWorldDownloader.Api;

/// <summary>
/// Passes the plugin UI's calls on to AniWorld Downloader. Every call needs a
/// Jellyfin login; downloading also needs the admin's permission.
/// </summary>
[ApiController]
[Authorize]
[Route("AniWorldDownloader")]
[Produces(MediaTypeNames.Application.Json)]
public class AniWorldProxyController : ControllerBase
{
    private static readonly string[] _searchTypes = ["all", "anime", "series", "movie"];

    // AniWorld's browse lists, see _BROWSE_ROWS in its api_media.py
    private static readonly string[] _browseLists = ["new-animes", "popular-animes", "new-series", "popular-series", "popular-movies"];

    private readonly IAuthorizationContext _authContext;
    private readonly AniWorldClient _aniWorld;
    private readonly LibraryMatcher _library;
    private readonly DownloadOwners _owners;
    private readonly ILibraryManager _libraryManager;
    private readonly IActivityManager _activityManager;
    private readonly IUserManager _userManager;

    /// <summary>
    /// Initializes a new instance of the <see cref="AniWorldProxyController"/> class.
    /// </summary>
    /// <param name="authContext">The authorization context.</param>
    /// <param name="aniWorld">The AniWorld Downloader client.</param>
    /// <param name="library">Matches titles against the Jellyfin library.</param>
    /// <param name="owners">Who queued which download, for the "done" message.</param>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="activityManager">The activity log.</param>
    /// <param name="userManager">The user manager, for the names in the queue.</param>
    public AniWorldProxyController(
        IAuthorizationContext authContext,
        AniWorldClient aniWorld,
        LibraryMatcher library,
        DownloadOwners owners,
        ILibraryManager libraryManager,
        IActivityManager activityManager,
        IUserManager userManager)
    {
        _authContext = authContext;
        _aniWorld = aniWorld;
        _library = library;
        _owners = owners;
        _libraryManager = libraryManager;
        _activityManager = activityManager;
        _userManager = userManager;
    }

    /// <summary>
    /// What the UI needs to know before it starts: whether the plugin is set
    /// up, whether this user may download, and the default picks.
    /// </summary>
    /// <returns>The info.</returns>
    [HttpGet("Info")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult> GetInfo()
    {
        var caller = await GetCallerAsync().ConfigureAwait(false);
        if (caller is null)
        {
            return Unauthorized();
        }

        var config = Plugin.Instance!.Configuration;
        return Ok(new JsonObject
        {
            ["configured"] = AniWorldClient.IsConfigured,
            ["isAdmin"] = caller.IsAdmin,
            ["canDownload"] = caller.CanDownload,
            ["canManageSync"] = caller.IsAdmin && AniWorldClient.HasAdminKey,
            ["defaultLanguage"] = config.DefaultLanguage,
            ["defaultProvider"] = config.DefaultProvider,
        });
    }

    /// <summary>
    /// Searches every site, with aniworld first.
    /// </summary>
    /// <param name="request">The search.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The results.</returns>
    [HttpPost("Search")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult> Search([FromBody] SearchRequest request, CancellationToken cancellationToken)
    {
        var keyword = request.Keyword?.Trim();
        var type = string.IsNullOrWhiteSpace(request.Type) ? "all" : request.Type.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(keyword))
        {
            return BadRequest(new JsonObject { ["error"] = "keyword is required" });
        }

        if (!_searchTypes.Contains(type))
        {
            return BadRequest(new JsonObject { ["error"] = "type must be all, anime, series or movie" });
        }

        var body = new JsonObject { ["keyword"] = keyword, ["site"] = "all", ["type"] = type };
        var reply = await _aniWorld.SendAsync(HttpMethod.Post, "search", null, body, cancellationToken).ConfigureAwait(false);
        if (reply.Json?["results"] is JsonArray results && await GetCallerAsync().ConfigureAwait(false) is { } caller)
        {
            foreach (var result in results.OfType<JsonObject>())
            {
                MarkLibraryItem(result, caller);
            }
        }

        return Reply(reply);
    }

    /// <summary>
    /// Searches every site and sends each site's results as soon as it
    /// answers: one JSON object per line, {site, results, pending}, then
    /// {"done": true}. Hits already in the library carry libraryItemId.
    /// </summary>
    /// <param name="request">The search.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>A task.</returns>
    [HttpPost("SearchStream")]
    [Produces("application/x-ndjson")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task SearchStream([FromBody] SearchRequest request, CancellationToken cancellationToken)
    {
        var keyword = request.Keyword?.Trim();
        var type = string.IsNullOrWhiteSpace(request.Type) ? "all" : request.Type.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(keyword) || !_searchTypes.Contains(type))
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            await Response.WriteAsJsonAsync(
                new JsonObject { ["error"] = string.IsNullOrEmpty(keyword) ? "keyword is required" : "type must be all, anime, series or movie" },
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var caller = await GetCallerAsync().ConfigureAwait(false);
        var body = new JsonObject { ["keyword"] = keyword, ["type"] = type };
        var (upstream, error) = await _aniWorld.OpenStreamAsync("search/stream", body, cancellationToken).ConfigureAwait(false);
        if (upstream is null)
        {
            Response.StatusCode = error!.Status;
            await Response.WriteAsJsonAsync(error.Json, cancellationToken).ConfigureAwait(false);
            return;
        }

        using (upstream)
        {
            Response.ContentType = "application/x-ndjson; charset=utf-8";
            Response.Headers.CacheControl = "no-cache";
            // Each line has to reach the phone when it is written, not at the end
            HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            using var reader = new StreamReader(await upstream.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false));
            string? line;
            while ((line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false)) is not null)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                JsonNode? node;
                try
                {
                    node = JsonNode.Parse(line);
                }
                catch (JsonException)
                {
                    continue;
                }

                AniWorldClient.RewritePosters(node);
                if (node?["results"] is JsonArray results && caller is not null)
                {
                    foreach (var result in results.OfType<JsonObject>())
                    {
                        MarkLibraryItem(result, caller);
                    }
                }

                await Response.WriteAsync(node!.ToJsonString() + "\n", cancellationToken).ConfigureAwait(false);
                await Response.Body.FlushAsync(cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Finds the AniWorld page for a series in the Jellyfin library, for the
    /// "missing episodes" button on Jellyfin's own series page.
    /// </summary>
    /// <param name="itemId">The Jellyfin series.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>{url, title, site} when found, {query} to search for otherwise.</returns>
    [HttpGet("FindSource")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> FindSource([FromQuery] Guid itemId, CancellationToken cancellationToken)
    {
        var caller = await GetCallerAsync().ConfigureAwait(false);
        if (caller is null)
        {
            return Unauthorized();
        }

        var item = _libraryManager.GetItemById(itemId);
        if (item is null || !item.IsVisible(caller.User))
        {
            return NotFound(new JsonObject { ["error"] = "Not in your library" });
        }

        // The folder name is what AniWorld itself named a download, so for
        // anything it fetched that is the surest match
        var names = new[] { item.Name, item.OriginalTitle, Path.GetFileName(item.Path?.TrimEnd('/', '\\')) }
            .Where(n => !string.IsNullOrWhiteSpace(n))
            .Select(n => n!)
            .DistinctBy(LibraryMatcher.Normalise)
            .ToList();
        var wanted = names.Select(LibraryMatcher.Normalise).ToHashSet();

        foreach (var name in names)
        {
            var body = new JsonObject { ["keyword"] = name, ["site"] = "all", ["type"] = "all" };
            var reply = await _aniWorld.SendAsync(HttpMethod.Post, "search", null, body, cancellationToken).ConfigureAwait(false);
            if (reply.Json?["results"] is not JsonArray results)
            {
                continue;
            }

            var match = results.OfType<JsonObject>().FirstOrDefault(r =>
                r["type"]?.GetValue<string>() is "anime" or "series"
                && wanted.Contains(LibraryMatcher.Normalise(r["title"]?.GetValue<string>())));
            if (match is not null)
            {
                return Ok(new JsonObject
                {
                    ["url"] = match["url"]?.DeepClone(),
                    ["title"] = match["title"]?.DeepClone(),
                    ["site"] = match["site"]?.DeepClone(),
                });
            }
        }

        // No sure match: let the user pick from a search instead
        return Ok(new JsonObject { ["query"] = names.FirstOrDefault() ?? item.Name });
    }

    /// <summary>
    /// One of AniWorld's browse lists, for the page before anything is searched.
    /// Hits already in the library carry libraryItemId.
    /// </summary>
    /// <param name="list">new-animes, popular-animes, new-series, popular-series or popular-movies.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The list.</returns>
    [HttpGet("Browse/{list}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Browse([FromRoute] string list, CancellationToken cancellationToken)
    {
        if (!_browseLists.Contains(list))
        {
            return NotFound(new JsonObject { ["error"] = "Unknown list" });
        }

        var reply = await _aniWorld.SendAsync(HttpMethod.Get, list, null, null, cancellationToken).ConfigureAwait(false);
        if (reply.Json?["results"] is JsonArray results && await GetCallerAsync().ConfigureAwait(false) is { } caller)
        {
            foreach (var result in results.OfType<JsonObject>())
            {
                MarkLibraryItem(result, caller);
            }
        }

        return Reply(reply);
    }

    /// <summary>
    /// Title, poster, description and genres of a series or movie, and the
    /// Jellyfin item when it is already in the library.
    /// </summary>
    /// <param name="url">The series page on its site.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The details.</returns>
    [HttpGet("Series")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult> GetSeries([FromQuery] string url, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return BadRequest(new JsonObject { ["error"] = "url is required" });
        }

        var query = new Dictionary<string, string?> { ["url"] = url };
        var reply = await _aniWorld.SendAsync(HttpMethod.Get, "series", query, null, cancellationToken).ConfigureAwait(false);
        if (reply.Json is JsonObject series && await GetCallerAsync().ConfigureAwait(false) is { } caller)
        {
            MarkLibraryItem(series, caller);
        }

        return Reply(reply);
    }

    /// <summary>
    /// The seasons of a series.
    /// </summary>
    /// <param name="url">The series page on its site.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The seasons.</returns>
    [HttpGet("Seasons")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public Task<ActionResult> GetSeasons([FromQuery] string url, CancellationToken cancellationToken)
        => ForwardGet("seasons", new() { ["url"] = url }, cancellationToken);

    /// <summary>
    /// The episodes of a season, with their languages.
    /// </summary>
    /// <param name="url">The season page.</param>
    /// <param name="seriesUrl">The series page, if known.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The episodes.</returns>
    [HttpGet("Episodes")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public Task<ActionResult> GetEpisodes([FromQuery] string url, [FromQuery] string? seriesUrl, CancellationToken cancellationToken)
        => ForwardGet("episodes", new() { ["url"] = url, ["series_url"] = seriesUrl }, cancellationToken);

    /// <summary>
    /// The hosters available per language for an episode.
    /// </summary>
    /// <param name="url">The episode page.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The hosters.</returns>
    [HttpGet("Providers")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public Task<ActionResult> GetProviders([FromQuery] string url, CancellationToken cancellationToken)
        => ForwardGet("providers", new() { ["url"] = url }, cancellationToken);

    /// <summary>
    /// The download queue with live progress. For admins, downloads that are
    /// still waiting or running carry "requestedBy", the Jellyfin user who
    /// started them.
    /// </summary>
    /// <param name="limit">Page size.</param>
    /// <param name="offset">Page start.</param>
    /// <param name="status">Only items in this status.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The queue.</returns>
    [HttpGet("Queue")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult> GetQueue(
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? status,
        CancellationToken cancellationToken)
    {
        var reply = await _aniWorld.SendAsync(
            HttpMethod.Get,
            "queue",
            new Dictionary<string, string?> { ["limit"] = limit?.ToString(), ["offset"] = offset?.ToString(), ["status"] = status },
            null,
            cancellationToken,
            // The queue page asks every few seconds and shows the error itself;
            // the download watcher reports an outage once
            quiet: true).ConfigureAwait(false);

        // The owners file forgets a download once it is done, so finished
        // ones have no name
        if (reply.Json?["items"] is JsonArray items && await GetCallerAsync().ConfigureAwait(false) is { IsAdmin: true })
        {
            foreach (var item in items.OfType<JsonObject>())
            {
                if (item["id"] is JsonValue id && id.TryGetValue<int>(out var queueId)
                    && _owners.Find(queueId) is { } userId
                    && _userManager.GetUserById(userId) is { } user)
                {
                    item["requestedBy"] = user.Username;
                }
            }
        }

        return Reply(reply);
    }

    /// <summary>
    /// Cancels a queued or running download. Needs the download permission.
    /// </summary>
    /// <param name="id">The queue item.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's reply.</returns>
    [HttpPost("Queue/{id:int}/Cancel")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> CancelQueueItem([FromRoute] int id, CancellationToken cancellationToken)
    {
        if (await DenyDownloadAsync().ConfigureAwait(false) is { } denied)
        {
            return denied;
        }

        return Reply(await _aniWorld.SendAsync(HttpMethod.Post, $"queue/{id}/cancel", null, null, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Queues a failed or cancelled download again. Needs the download
    /// permission; whoever retries it gets the "done" message.
    /// </summary>
    /// <param name="id">The queue item.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's reply.</returns>
    [HttpPost("Queue/{id:int}/Retry")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> RetryQueueItem([FromRoute] int id, CancellationToken cancellationToken)
    {
        if (await DenyDownloadAsync().ConfigureAwait(false) is { } denied)
        {
            return denied;
        }

        var reply = await _aniWorld.SendAsync(HttpMethod.Post, $"queue/{id}/retry", null, null, cancellationToken).ConfigureAwait(false);
        if (reply.Status == StatusCodes.Status200OK && await GetCallerAsync().ConfigureAwait(false) is { } caller)
        {
            // The owner was forgotten when it failed
            _owners.Add(id, caller.User.Id);
        }

        return Reply(reply);
    }

    /// <summary>
    /// Moves a waiting download one place up or down. Needs the download
    /// permission.
    /// </summary>
    /// <param name="id">The queue item.</param>
    /// <param name="request">Which way.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's reply.</returns>
    [HttpPost("Queue/{id:int}/Move")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> MoveQueueItem([FromRoute] int id, [FromBody] MoveRequest request, CancellationToken cancellationToken)
    {
        if (await DenyDownloadAsync().ConfigureAwait(false) is { } denied)
        {
            return denied;
        }

        if (request.Direction is not ("up" or "down"))
        {
            return BadRequest(new JsonObject { ["error"] = "Direction must be up or down" });
        }

        var body = new JsonObject { ["direction"] = request.Direction };
        return Reply(await _aniWorld.SendAsync(HttpMethod.Post, $"queue/{id}/move", null, body, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Removes a download from the queue; a running one has to be cancelled
    /// first. Needs the download permission.
    /// </summary>
    /// <param name="id">The queue item.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's reply.</returns>
    [HttpDelete("Queue/{id:int}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> RemoveQueueItem([FromRoute] int id, CancellationToken cancellationToken)
    {
        if (await DenyDownloadAsync().ConfigureAwait(false) is { } denied)
        {
            return denied;
        }

        return Reply(await _aniWorld.SendAsync(HttpMethod.Delete, $"queue/{id}", null, null, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Removes every finished, failed and cancelled download from the queue.
    /// Admins only, since it clears everyone's.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's reply.</returns>
    [HttpDelete("Queue/Finished")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> ClearFinishedQueueItems(CancellationToken cancellationToken)
    {
        var caller = await GetCallerAsync().ConfigureAwait(false);
        if (caller is null)
        {
            return Unauthorized();
        }

        if (!caller.IsAdmin)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new JsonObject { ["error"] = "Only admins can clear the finished downloads" });
        }

        return Reply(await _aniWorld.SendAsync(HttpMethod.Delete, "queue/completed", null, null, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Queues episodes for download. Needs the download permission.
    /// </summary>
    /// <param name="request">What to download.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The queue ID.</returns>
    [HttpPost("Download")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> Download([FromBody] DownloadRequest request, CancellationToken cancellationToken)
    {
        if (await DenyDownloadAsync().ConfigureAwait(false) is { } denied)
        {
            return denied;
        }

        if (request.Episodes is not { Length: > 0 })
        {
            return BadRequest(new JsonObject { ["error"] = "episodes list is required" });
        }

        var config = Plugin.Instance!.Configuration;
        // Only a missing value gets the default: some sites have no hoster
        // to pick, and AniWorld expects an empty one for them
        var language = request.Language ?? config.DefaultLanguage;
        var provider = request.Provider ?? config.DefaultProvider;
        var title = Pick(request.Title, "Unknown");
        var body = new JsonObject
        {
            ["episodes"] = new JsonArray(request.Episodes.Select(e => (JsonNode?)JsonValue.Create(e)).ToArray()),
            ["language"] = language,
            ["provider"] = provider,
            ["title"] = title,
            ["series_url"] = request.SeriesUrl ?? string.Empty,
        };
        var reply = await _aniWorld.SendAsync(HttpMethod.Post, "download", null, body, cancellationToken).ConfigureAwait(false);

        if (reply.Json?["queue_id"] is JsonValue queueId && queueId.TryGetValue<int>(out var id)
            && await GetCallerAsync().ConfigureAwait(false) is { } caller)
        {
            // So the "done" message goes to whoever asked for it
            _owners.Add(id, caller.User.Id);

            var episodes = request.Episodes.Length;
            var details = string.IsNullOrEmpty(provider) ? language : $"{language}, {provider}";
            await _activityManager.CreateAsync(new ActivityLog(
                $"AniWorld: {caller.User.Username} started a download of {title}: {episodes} {(episodes == 1 ? "episode" : "episodes")}",
                "AniWorldDownloader",
                caller.User.Id)
            {
                ShortOverview = "Download started: " + details,
                LogSeverity = LogLevel.Information,
            }).ConfigureAwait(false);
        }

        return Reply(reply);
    }

    /// <summary>
    /// Whether Auto-Sync follows a series.
    /// </summary>
    /// <param name="url">The series page.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The tracked state.</returns>
    [HttpGet("AutoSync/Tracked")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public Task<ActionResult> GetTracked([FromQuery] string url, CancellationToken cancellationToken)
        => ForwardGet("autosync/tracked", new() { ["url"] = url }, cancellationToken);

    /// <summary>
    /// Ticks or unticks "Sync this with Auto-Sync". Needs the download permission,
    /// because a tracked series downloads on its own.
    /// </summary>
    /// <param name="body">The AniWorld body: series_url, tracked, language and the rest.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The new state.</returns>
    [HttpPost("AutoSync/Tracked")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> SetTracked([FromBody] JsonObject body, CancellationToken cancellationToken)
    {
        if (await DenyDownloadAsync().ConfigureAwait(false) is { } denied)
        {
            return denied;
        }

        return Reply(await _aniWorld.SendAsync(HttpMethod.Post, "autosync/tracked", null, body, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Auto-Sync's schedule, last run and every tracked series. Admins only,
    /// with the full-access key.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's status.</returns>
    [HttpGet("AutoSync/Status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public Task<ActionResult> GetSyncStatus(CancellationToken cancellationToken)
        => ForwardAdmin(HttpMethod.Get, "autosync/status", null, cancellationToken);

    /// <summary>
    /// Starts a run over every tracked series. Admins only.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's reply; 409 while a run is going.</returns>
    [HttpPost("AutoSync/Run")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public Task<ActionResult> RunSync(CancellationToken cancellationToken)
        => ForwardAdmin(HttpMethod.Post, "autosync/run", null, cancellationToken);

    /// <summary>
    /// Checks one tracked series now. Admins only.
    /// </summary>
    /// <param name="id">The tracked series.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's reply; 409 while a run is going.</returns>
    [HttpPost("AutoSync/Series/{id:int}/Run")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public Task<ActionResult> RunSyncSeries([FromRoute] int id, CancellationToken cancellationToken)
        => ForwardAdmin(HttpMethod.Post, $"autosync/series/{id}/run", null, cancellationToken);

    /// <summary>
    /// Changes a tracked series' language, start point or schedule. Admins only.
    /// </summary>
    /// <param name="id">The tracked series.</param>
    /// <param name="body">The AniWorld body: language, start_season, cadence and the rest.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The updated series.</returns>
    [HttpPut("AutoSync/Series/{id:int}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public Task<ActionResult> UpdateSyncSeries([FromRoute] int id, [FromBody] JsonObject body, CancellationToken cancellationToken)
        => ForwardAdmin(HttpMethod.Put, $"autosync/series/{id}", body, cancellationToken);

    /// <summary>
    /// Stops Auto-Sync following a series. Admins only.
    /// </summary>
    /// <param name="id">The tracked series.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's reply.</returns>
    [HttpDelete("AutoSync/Series/{id:int}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public Task<ActionResult> DeleteSyncSeries([FromRoute] int id, CancellationToken cancellationToken)
        => ForwardAdmin(HttpMethod.Delete, $"autosync/series/{id}", null, cancellationToken);

    /// <summary>
    /// Serves a poster. Anonymous, because an &lt;img&gt; can't send the login,
    /// but only for links the plugin signed itself.
    /// </summary>
    /// <param name="url">The original image URL.</param>
    /// <param name="sig">The signature.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The image.</returns>
    [HttpGet("Image")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> GetImage([FromQuery] string url, [FromQuery] string? sig, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(url) || !AniWorldClient.IsSigned(url, sig))
        {
            // Not Forbid(): that would start an auth challenge for an anonymous route
            return StatusCode(StatusCodes.Status403Forbidden);
        }

        var image = await _aniWorld.GetImageAsync(url, cancellationToken).ConfigureAwait(false);
        if (image is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "public, max-age=86400";
        return File(image.Value.Data, image.Value.ContentType);
    }

    /// <summary>
    /// Checks a URL and key from the settings page, before or after saving.
    /// Admins only.
    /// </summary>
    /// <param name="request">The URL and key to try; empty ones fall back to the saved values.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>AniWorld's /api/ping reply.</returns>
    [HttpPost("TestConnection")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult> TestConnection([FromBody] TestConnectionRequest request, CancellationToken cancellationToken)
    {
        var caller = await GetCallerAsync().ConfigureAwait(false);
        if (caller is null)
        {
            return Unauthorized();
        }

        if (!caller.IsAdmin)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new JsonObject { ["error"] = "Only admins can test the connection" });
        }

        var config = Plugin.Instance!.Configuration;
        var url = Pick(request.Url, config.AniWorldUrl);
        var key = Pick(request.ApiKey, config.ApiKey);
        var reply = await _aniWorld.SendAsync(url, key, HttpMethod.Get, "ping", null, null, cancellationToken).ConfigureAwait(false);

        // The Auto-Sync key gets its own ping, so a wrong one shows up here
        // and not first in the overview
        var adminKey = Pick(request.AdminApiKey, config.AdminApiKey);
        if (reply.Status == StatusCodes.Status200OK && reply.Json is JsonObject json && !string.IsNullOrEmpty(adminKey))
        {
            var admin = await _aniWorld.SendAsync(url, adminKey, HttpMethod.Get, "ping", null, null, cancellationToken).ConfigureAwait(false);
            json["admin"] = admin.Json?.DeepClone();
        }

        return Reply(reply);
    }

    private static string Pick(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

    private async Task<ActionResult> ForwardGet(
        string path,
        Dictionary<string, string?> query,
        CancellationToken cancellationToken,
        bool requireUrl = true,
        bool quiet = false)
    {
        if (requireUrl && string.IsNullOrWhiteSpace(query.GetValueOrDefault("url")))
        {
            return BadRequest(new JsonObject { ["error"] = "url is required" });
        }

        return Reply(await _aniWorld.SendAsync(HttpMethod.Get, path, query, null, cancellationToken, quiet).ConfigureAwait(false));
    }

    private ObjectResult Reply(AniWorldReply reply) => StatusCode(reply.Status, reply.Json);

    private async Task<ActionResult> ForwardAdmin(HttpMethod method, string path, JsonNode? body, CancellationToken cancellationToken)
    {
        var caller = await GetCallerAsync().ConfigureAwait(false);
        if (caller is null)
        {
            return Unauthorized();
        }

        if (!caller.IsAdmin)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new JsonObject { ["error"] = "Only admins can manage Auto-Sync" });
        }

        if (!AniWorldClient.HasAdminKey)
        {
            return StatusCode(
                StatusCodes.Status403Forbidden,
                new JsonObject { ["error"] = "Add a key with full access under the plugin's Auto-Sync settings first." });
        }

        return Reply(await _aniWorld.SendAdminAsync(method, path, body, cancellationToken).ConfigureAwait(false));
    }

    private async Task<ActionResult?> DenyDownloadAsync()
    {
        var caller = await GetCallerAsync().ConfigureAwait(false);
        if (caller is null)
        {
            return Unauthorized();
        }

        if (!caller.CanDownload)
        {
            return StatusCode(
                StatusCodes.Status403Forbidden,
                new JsonObject { ["error"] = "You may search, but an admin has to allow you to download." });
        }

        return null;
    }

    private async Task<Caller?> GetCallerAsync()
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        if (auth.User is null)
        {
            // An API key passes [Authorize] but has no user to check
            return null;
        }

        var isAdmin = auth.User.HasPermission(PermissionKind.IsAdministrator);
        var allowed = Plugin.Instance!.Configuration.DownloadUserIds;
        return new Caller(auth.User, isAdmin, isAdmin || allowed.Contains(auth.User.Id));
    }

    // Adds "libraryItemId" to a result or title the caller already has in a
    // library they can see, so the UI can badge it and link to it
    private void MarkLibraryItem(JsonObject item, Caller caller)
    {
        var title = item["title"] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        if (_library.Find(caller.User, title) is { } id)
        {
            item["libraryItemId"] = id.ToString("N");
        }
    }

    private sealed record Caller(User User, bool IsAdmin, bool CanDownload);
}

/// <summary>
/// A search from the plugin UI.
/// </summary>
public class SearchRequest
{
    /// <summary>
    /// Gets or sets what to search for.
    /// </summary>
    public string? Keyword { get; set; }

    /// <summary>
    /// Gets or sets the tab: all, anime, series or movie.
    /// </summary>
    public string? Type { get; set; }
}

/// <summary>
/// A download from the plugin UI.
/// </summary>
public class DownloadRequest
{
    /// <summary>
    /// Gets or sets the episode page URLs.
    /// </summary>
    public string[]? Episodes { get; set; }

    /// <summary>
    /// Gets or sets the language; the default one when missing.
    /// </summary>
    public string? Language { get; set; }

    /// <summary>
    /// Gets or sets the hoster; the default one when missing.
    /// </summary>
    public string? Provider { get; set; }

    /// <summary>
    /// Gets or sets the title, which names the folder.
    /// </summary>
    public string? Title { get; set; }

    /// <summary>
    /// Gets or sets the series page URL.
    /// </summary>
    public string? SeriesUrl { get; set; }
}

/// <summary>
/// Moving a waiting download in the queue.
/// </summary>
public class MoveRequest
{
    /// <summary>
    /// Gets or sets the way to move it: up or down.
    /// </summary>
    public string? Direction { get; set; }
}

/// <summary>
/// The settings page's "Test connection".
/// </summary>
public class TestConnectionRequest
{
    /// <summary>
    /// Gets or sets the AniWorld URL to try.
    /// </summary>
    public string? Url { get; set; }

    /// <summary>
    /// Gets or sets the API key to try.
    /// </summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// Gets or sets the full-access key for Auto-Sync to try.
    /// </summary>
    public string? AdminApiKey { get; set; }
}
