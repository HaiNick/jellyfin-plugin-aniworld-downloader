using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.AniWorldDownloader.Configuration;

/// <summary>
/// Plugin configuration.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the AniWorld Downloader base URL, for example http://192.168.1.10:8069.
    /// </summary>
    public string AniWorldUrl { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the AniWorld Downloader API key. A write key is enough.
    /// It stays on the server; clients never see it.
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the non-admin users who may download. Admins always may,
    /// and anyone logged in may search.
    /// </summary>
    public Guid[] DownloadUserIds { get; set; } = [];

    /// <summary>
    /// Gets or sets the language picked by default in the download dialog.
    /// </summary>
    public string DefaultLanguage { get; set; } = "German Dub";

    /// <summary>
    /// Gets or sets the hoster picked by default in the download dialog.
    /// </summary>
    public string DefaultProvider { get; set; } = "VOE";

    /// <summary>
    /// Gets or sets a value indicating whether a finished download starts a
    /// library scan, so it shows up without waiting for the scheduled one.
    /// </summary>
    public bool ScanAfterDownload { get; set; } = true;

    /// <summary>
    /// Gets or sets the secret that signs poster links, so the image proxy
    /// only fetches what the plugin itself handed out. Made on first use.
    /// </summary>
    public string ImageSigningKey { get; set; } = string.Empty;
}
