using System.Net.Mime;
using System.Text.Json.Nodes;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.AniWorldDownloader.AniWorld;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

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

    private readonly IAuthorizationContext _authContext;
    private readonly AniWorldClient _aniWorld;

    /// <summary>
    /// Initializes a new instance of the <see cref="AniWorldProxyController"/> class.
    /// </summary>
    /// <param name="authContext">The authorization context.</param>
    /// <param name="aniWorld">The AniWorld Downloader client.</param>
    public AniWorldProxyController(IAuthorizationContext authContext, AniWorldClient aniWorld)
    {
        _authContext = authContext;
        _aniWorld = aniWorld;
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
        return Reply(await _aniWorld.SendAsync(HttpMethod.Post, "search", null, body, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Title, poster, description and genres of a series or movie.
    /// </summary>
    /// <param name="url">The series page on its site.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The details.</returns>
    [HttpGet("Series")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public Task<ActionResult> GetSeries([FromQuery] string url, CancellationToken cancellationToken)
        => ForwardGet("series", new() { ["url"] = url }, cancellationToken);

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
    /// The download queue with live progress.
    /// </summary>
    /// <param name="limit">Page size.</param>
    /// <param name="offset">Page start.</param>
    /// <param name="status">Only items in this status.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The queue.</returns>
    [HttpGet("Queue")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public Task<ActionResult> GetQueue(
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? status,
        CancellationToken cancellationToken)
        => ForwardGet(
            "queue",
            new() { ["limit"] = limit?.ToString(), ["offset"] = offset?.ToString(), ["status"] = status },
            cancellationToken,
            requireUrl: false);

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
        var body = new JsonObject
        {
            ["episodes"] = new JsonArray(request.Episodes.Select(e => (JsonNode?)JsonValue.Create(e)).ToArray()),
            // Only a missing value gets the default: some sites have no hoster
            // to pick, and AniWorld expects an empty one for them
            ["language"] = request.Language ?? config.DefaultLanguage,
            ["provider"] = request.Provider ?? config.DefaultProvider,
            ["title"] = Pick(request.Title, "Unknown"),
            ["series_url"] = request.SeriesUrl ?? string.Empty,
        };
        return Reply(await _aniWorld.SendAsync(HttpMethod.Post, "download", null, body, cancellationToken).ConfigureAwait(false));
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
        return Reply(await _aniWorld.SendAsync(url, key, HttpMethod.Get, "ping", null, null, cancellationToken).ConfigureAwait(false));
    }

    private static string Pick(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();

    private async Task<ActionResult> ForwardGet(
        string path,
        Dictionary<string, string?> query,
        CancellationToken cancellationToken,
        bool requireUrl = true)
    {
        if (requireUrl && string.IsNullOrWhiteSpace(query.GetValueOrDefault("url")))
        {
            return BadRequest(new JsonObject { ["error"] = "url is required" });
        }

        return Reply(await _aniWorld.SendAsync(HttpMethod.Get, path, query, null, cancellationToken).ConfigureAwait(false));
    }

    private ObjectResult Reply(AniWorldReply reply) => StatusCode(reply.Status, reply.Json);

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
        return new Caller(isAdmin, isAdmin || allowed.Contains(auth.User.Id));
    }

    private sealed record Caller(bool IsAdmin, bool CanDownload);
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
}
