using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AniWorldDownloader.Web;

/// <summary>
/// Adds the plugin's client script to jellyfin-web's index.html as it is served.
/// Nothing on disk changes, so a Jellyfin image update can't wipe it.
/// </summary>
public class ScriptInjectionMiddleware
{
    // Relative to /web/, so it also works when Jellyfin runs under a base URL.
    private const string ScriptTag = "<script defer src=\"../AniWorldDownloader/client.js\"></script>";

    private readonly RequestDelegate _next;
    private readonly ILogger<ScriptInjectionMiddleware> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjectionMiddleware"/> class.
    /// </summary>
    /// <param name="next">The next middleware.</param>
    /// <param name="logger">The logger.</param>
    public ScriptInjectionMiddleware(RequestDelegate next, ILogger<ScriptInjectionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    /// <summary>
    /// Handles a request.
    /// </summary>
    /// <param name="context">The HTTP context.</param>
    /// <returns>A task.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        if (!IsIndexRequest(context.Request))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        // Ask for the full, uncompressed file so it can be edited.
        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("If-None-Match");
        context.Request.Headers.Remove("If-Modified-Since");

        var originalBody = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;

        try
        {
            await _next(context).ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = originalBody;
        }

        buffer.Position = 0;
        var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
            && (context.Response.ContentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) ?? false)
            && string.IsNullOrEmpty(context.Response.Headers.ContentEncoding);

        if (!isHtml)
        {
            await buffer.CopyToAsync(originalBody).ConfigureAwait(false);
            return;
        }

        var html = Encoding.UTF8.GetString(buffer.ToArray());
        var index = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (index < 0)
        {
            _logger.LogWarning("AniWorld Downloader: no </body> in {Path}, client script not added", context.Request.Path);
        }
        else if (!html.Contains(ScriptTag, StringComparison.Ordinal))
        {
            html = html.Insert(index, ScriptTag);
        }

        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.Remove("Last-Modified");
        context.Response.Headers.CacheControl = "no-cache";
        context.Response.ContentLength = bytes.Length;
        await originalBody.WriteAsync(bytes).ConfigureAwait(false);
    }

    private static bool IsIndexRequest(HttpRequest request)
    {
        if (!HttpMethods.IsGet(request.Method))
        {
            return false;
        }

        var path = (request.PathBase + request.Path).Value ?? string.Empty;
        return path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase);
    }
}
