using System.Reflection;
using Jellyfin.Plugin.AniWorldDownloader.Api;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationModels;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jellyfin.Plugin.AniWorldDownloader.Tests;

/// <summary>
/// Jellyfin builds every plugin controller when it starts, and a bad attribute
/// there takes the whole server down (a [Produces("image/*")] once did). These
/// tests build them the same way, so that happens here instead.
/// </summary>
public class ControllerStartupTests
{
    private static readonly Type[] _controllers = typeof(Plugin).Assembly
        .GetTypes()
        .Where(t => typeof(ControllerBase).IsAssignableFrom(t) && !t.IsAbstract)
        .ToArray();

    [Fact]
    public void ThePluginHasControllers()
    {
        Assert.Contains(typeof(AniWorldProxyController), _controllers);
        Assert.Contains(typeof(AniWorldDownloaderController), _controllers);
    }

    [Fact]
    public void EveryAttributeCanBeBuilt()
    {
        foreach (var controller in _controllers)
        {
            _ = controller.GetCustomAttributes(true);
            foreach (var method in controller.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                _ = method.GetCustomAttributes(true);
                foreach (var parameter in method.GetParameters())
                {
                    _ = parameter.GetCustomAttributes(true);
                }
            }
        }
    }

    [Fact]
    public void MvcCanBuildTheActionModels()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddMvcCore().AddApplicationPart(typeof(Plugin).Assembly);
        using var provider = services.BuildServiceProvider();

        var context = new ApplicationModelProviderContext(_controllers.Select(t => t.GetTypeInfo()));
        foreach (var modelProvider in provider.GetServices<IApplicationModelProvider>().OrderBy(p => p.Order))
        {
            modelProvider.OnProvidersExecuting(context);
        }

        var routes = context.Result.Controllers
            .SelectMany(c => c.Actions)
            .SelectMany(a => a.Selectors)
            .Select(s => s.AttributeRouteModel?.Template)
            .ToList();
        Assert.Contains("Image", routes);
        Assert.Contains("Queue/{id:int}/Retry", routes);
        Assert.Contains("Queue/Finished", routes);
    }
}
