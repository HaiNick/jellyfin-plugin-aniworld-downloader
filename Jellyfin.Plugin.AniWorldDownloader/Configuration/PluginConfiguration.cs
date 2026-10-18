using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.AniWorldDownloader.Configuration;

/// <summary>
/// Plugin configuration.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the AniWorld Downloader base URL.
    /// </summary>
    public string AniWorldUrl { get; set; } = string.Empty;
}
