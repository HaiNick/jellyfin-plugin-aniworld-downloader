using System.Net.Mime;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.AniWorldDownloader.Api;

/// <summary>
/// The plugin's API, under /AniWorldDownloader.
/// </summary>
[ApiController]
[Route("AniWorldDownloader")]
public class AniWorldDownloaderController : ControllerBase
{
    private readonly IAuthorizationContext _authContext;

    /// <summary>
    /// Initializes a new instance of the <see cref="AniWorldDownloaderController"/> class.
    /// </summary>
    /// <param name="authContext">The authorization context.</param>
    public AniWorldDownloaderController(IAuthorizationContext authContext)
    {
        _authContext = authContext;
    }

    /// <summary>
    /// Serves the script that adds the AniWorld tab to the web client.
    /// Anonymous, because index.html loads it before anyone logs in.
    /// </summary>
    /// <returns>The script.</returns>
    [HttpGet("client.js")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetClientScript()
    {
        var stream = GetType().Assembly.GetManifestResourceStream("Jellyfin.Plugin.AniWorldDownloader.Web.client.js");
        if (stream is null)
        {
            return NotFound();
        }

        Response.Headers.CacheControl = "no-cache";
        return File(stream, "application/javascript; charset=utf-8");
    }

    /// <summary>
    /// Returns the logged-in Jellyfin user.
    /// </summary>
    /// <returns>Who is calling.</returns>
    [HttpGet("whoami")]
    [Authorize]
    [Produces(MediaTypeNames.Application.Json)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<WhoAmIResponse>> WhoAmI()
    {
        var auth = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        if (auth.User is null)
        {
            // An API key passes [Authorize] but has no user behind it.
            return Unauthorized();
        }

        return new WhoAmIResponse(
            auth.User.Id,
            auth.User.Username,
            auth.User.HasPermission(PermissionKind.IsAdministrator),
            auth.Client,
            auth.Device);
    }
}

/// <summary>
/// The logged-in user, as seen by the plugin.
/// </summary>
/// <param name="UserId">The user's ID.</param>
/// <param name="UserName">The user's name.</param>
/// <param name="IsAdmin">Whether the user is a Jellyfin administrator.</param>
/// <param name="Client">The client app, for example "Jellyfin Web" or "Jellyfin Android".</param>
/// <param name="Device">The device name.</param>
public record WhoAmIResponse(Guid UserId, string UserName, bool IsAdmin, string? Client, string? Device);
