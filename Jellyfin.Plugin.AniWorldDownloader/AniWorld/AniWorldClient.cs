using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.AniWorldDownloader.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.AniWorldDownloader.AniWorld;

/// <summary>
/// Talks to the AniWorld Downloader API. The URL and key live only here, on
/// the server, so phones and browsers never see them.
/// </summary>
public class AniWorldClient
{
    /// <summary>
    /// The plugin route that serves posters, relative to the Jellyfin server.
    /// </summary>
    public const string ImageRoute = "AniWorldDownloader/Image";

    // AniWorld routes its posters through its own proxy, see media.proxy_image()
    private const string AniWorldImagePrefix = "/api/proxy-image?url=";

    private static readonly TimeSpan _timeout = TimeSpan.FromSeconds(60);

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<AniWorldClient> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="AniWorldClient"/> class.
    /// </summary>
    /// <param name="httpClientFactory">The HTTP client factory.</param>
    /// <param name="logger">The logger.</param>
    public AniWorldClient(IHttpClientFactory httpClientFactory, ILogger<AniWorldClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    private static PluginConfiguration Config => Plugin.Instance?.Configuration ?? new PluginConfiguration();

    /// <summary>
    /// Gets a value indicating whether an AniWorld URL is set.
    /// </summary>
    public static bool IsConfigured => !string.IsNullOrWhiteSpace(Config.AniWorldUrl);

    /// <summary>
    /// Calls an AniWorld API endpoint with the saved URL and key.
    /// </summary>
    /// <param name="method">The HTTP method.</param>
    /// <param name="path">The path below /api/, for example "search".</param>
    /// <param name="query">Query parameters; null values are left out.</param>
    /// <param name="body">A JSON body, or null.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The status and the JSON reply, with poster links rewritten.</returns>
    public Task<AniWorldReply> SendAsync(
        HttpMethod method,
        string path,
        IDictionary<string, string?>? query,
        JsonNode? body,
        CancellationToken cancellationToken)
    {
        return SendAsync(Config.AniWorldUrl, Config.ApiKey, method, path, query, body, cancellationToken);
    }

    /// <summary>
    /// Calls an AniWorld API endpoint with the given URL and key, for the
    /// settings page's "Test connection" before anything is saved.
    /// </summary>
    /// <param name="baseUrl">The AniWorld base URL.</param>
    /// <param name="apiKey">The API key, or empty for none.</param>
    /// <param name="method">The HTTP method.</param>
    /// <param name="path">The path below /api/.</param>
    /// <param name="query">Query parameters; null values are left out.</param>
    /// <param name="body">A JSON body, or null.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The status and the JSON reply, with poster links rewritten.</returns>
    public async Task<AniWorldReply> SendAsync(
        string baseUrl,
        string apiKey,
        HttpMethod method,
        string path,
        IDictionary<string, string?>? query,
        JsonNode? body,
        CancellationToken cancellationToken)
    {
        if (!TryBuildUri(baseUrl, "api/" + path, query, out var uri))
        {
            return AniWorldReply.Error(503, "AniWorld Downloader is not set up yet. An admin can add its URL in the plugin settings.");
        }

        using var request = new HttpRequestMessage(method, uri);
        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            request.Headers.Add("X-API-Key", apiKey.Trim());
        }

        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (body is not null)
        {
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }

        try
        {
            using var client = CreateClient();
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var status = (int)response.StatusCode;

            JsonNode? json;
            try
            {
                json = string.IsNullOrWhiteSpace(text) ? new JsonObject() : JsonNode.Parse(text);
            }
            catch (JsonException)
            {
                // A login page or a proxy error, not the API
                _logger.LogWarning("AniWorld Downloader sent no JSON for {Path} (HTTP {Status})", path, status);
                return AniWorldReply.Error(502, $"AniWorld Downloader answered HTTP {status} without JSON. Check the URL.");
            }

            RewritePosters(json);
            return new AniWorldReply(status, json);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning(ex, "AniWorld Downloader unreachable for {Path}", path);
            return AniWorldReply.Error(502, "Could not reach AniWorld Downloader: " + ex.Message);
        }
    }

    /// <summary>
    /// Fetches a poster through AniWorld's image proxy.
    /// </summary>
    /// <param name="imageUrl">The original image URL.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>The image bytes and type, or null when it failed.</returns>
    public async Task<(byte[] Data, string ContentType)?> GetImageAsync(string imageUrl, CancellationToken cancellationToken)
    {
        var query = new Dictionary<string, string?> { ["url"] = imageUrl };
        if (!TryBuildUri(Config.AniWorldUrl, "api/proxy-image", query, out var uri))
        {
            return null;
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        if (!string.IsNullOrWhiteSpace(Config.ApiKey))
        {
            request.Headers.Add("X-API-Key", Config.ApiKey.Trim());
        }

        try
        {
            using var client = CreateClient();
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var type = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
            if (!response.IsSuccessStatusCode || !type.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            return (await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false), type);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            _logger.LogDebug(ex, "Poster fetch failed for {Url}", imageUrl);
            return null;
        }
    }

    /// <summary>
    /// Signs an image URL so <see cref="ImageRoute"/> only serves posters the
    /// plugin handed out, and can't be used to fetch anything else.
    /// </summary>
    /// <param name="imageUrl">The original image URL.</param>
    /// <returns>The signature.</returns>
    public static string Sign(string imageUrl)
    {
        var key = Encoding.UTF8.GetBytes(SigningKey());
        var hash = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(imageUrl));
        return Convert.ToHexString(hash, 0, 16).ToLowerInvariant();
    }

    /// <summary>
    /// Checks a signature made by <see cref="Sign"/>.
    /// </summary>
    /// <param name="imageUrl">The original image URL.</param>
    /// <param name="signature">The signature from the link.</param>
    /// <returns>Whether it matches.</returns>
    public static bool IsSigned(string imageUrl, string? signature)
    {
        if (string.IsNullOrEmpty(signature))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(Sign(imageUrl)),
            Encoding.ASCII.GetBytes(signature.ToLowerInvariant()));
    }

    private static string SigningKey()
    {
        var plugin = Plugin.Instance;
        if (plugin is null)
        {
            throw new InvalidOperationException("Plugin not loaded");
        }

        var config = plugin.Configuration;
        if (string.IsNullOrEmpty(config.ImageSigningKey))
        {
            config.ImageSigningKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            plugin.SaveConfiguration();
        }

        return config.ImageSigningKey;
    }

    private static bool TryBuildUri(string baseUrl, string path, IDictionary<string, string?>? query, out Uri uri)
    {
        uri = null!;
        if (string.IsNullOrWhiteSpace(baseUrl)
            || !Uri.TryCreate(baseUrl.Trim().TrimEnd('/') + "/", UriKind.Absolute, out var root)
            || (root.Scheme != Uri.UriSchemeHttp && root.Scheme != Uri.UriSchemeHttps))
        {
            return false;
        }

        var builder = new StringBuilder(path);
        var separator = '?';
        foreach (var (name, value) in query ?? new Dictionary<string, string?>())
        {
            if (value is null)
            {
                continue;
            }

            builder.Append(separator).Append(Uri.EscapeDataString(name)).Append('=').Append(Uri.EscapeDataString(value));
            separator = '&';
        }

        uri = new Uri(root, builder.ToString());
        return true;
    }

    // Swaps AniWorld's own poster links for signed links to the plugin's image
    // route, wherever they sit in the reply.
    private static void RewritePosters(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var name in obj.Select(p => p.Key).ToList())
                {
                    if (obj[name] is JsonValue value && value.TryGetValue<string>(out var text))
                    {
                        if (text.StartsWith(AniWorldImagePrefix, StringComparison.Ordinal))
                        {
                            obj[name] = PosterLink(Uri.UnescapeDataString(text[AniWorldImagePrefix.Length..]));
                        }
                    }
                    else
                    {
                        RewritePosters(obj[name]);
                    }
                }

                break;
            case JsonArray array:
                foreach (var item in array)
                {
                    RewritePosters(item);
                }

                break;
        }
    }

    private static string PosterLink(string imageUrl)
    {
        return $"{ImageRoute}?url={Uri.EscapeDataString(imageUrl)}&sig={Sign(imageUrl)}";
    }

    private HttpClient CreateClient()
    {
        var client = _httpClientFactory.CreateClient(nameof(AniWorldClient));
        client.Timeout = _timeout;
        return client;
    }
}

/// <summary>
/// A reply from AniWorld Downloader.
/// </summary>
/// <param name="Status">The HTTP status.</param>
/// <param name="Json">The JSON body.</param>
public record AniWorldReply(int Status, JsonNode? Json)
{
    /// <summary>
    /// Makes an error reply in AniWorld's own {"error": ...} shape.
    /// </summary>
    /// <param name="status">The HTTP status.</param>
    /// <param name="message">The message.</param>
    /// <returns>The reply.</returns>
    public static AniWorldReply Error(int status, string message) => new(status, new JsonObject { ["error"] = message });
}
