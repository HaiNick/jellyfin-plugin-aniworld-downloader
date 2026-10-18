using Jellyfin.Plugin.AniWorldDownloader.AniWorld;
using Jellyfin.Plugin.AniWorldDownloader.Web;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.AniWorldDownloader;

/// <summary>
/// Registers the plugin's services with the Jellyfin server.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddTransient<IStartupFilter, ScriptInjectionStartupFilter>();
        serviceCollection.AddSingleton<AniWorldClient>();
    }
}
