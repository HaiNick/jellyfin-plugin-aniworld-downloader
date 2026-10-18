using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.AniWorldDownloader.Library;

/// <summary>
/// Finds the Jellyfin series or movie a search result is about, by title,
/// so the UI can mark what is already in the library.
/// </summary>
public partial class LibraryMatcher
{
    // Long enough that a page of results and its title pages share one lookup,
    // short enough that a finished download shows up soon after
    private static readonly TimeSpan _cacheFor = TimeSpan.FromMinutes(1);

    private readonly ILibraryManager _libraryManager;
    private readonly ConcurrentDictionary<Guid, (DateTime At, Dictionary<string, Guid> Titles)> _cache = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="LibraryMatcher"/> class.
    /// </summary>
    /// <param name="libraryManager">The library manager.</param>
    public LibraryMatcher(ILibraryManager libraryManager)
    {
        _libraryManager = libraryManager;
    }

    /// <summary>
    /// The library item with this title that the user can see, if any.
    /// </summary>
    /// <param name="user">The user; only their libraries count.</param>
    /// <param name="title">The title from a site.</param>
    /// <returns>The item ID, or null.</returns>
    public Guid? Find(User user, string? title)
    {
        var key = Normalise(title);
        if (key.Length == 0)
        {
            return null;
        }

        return TitlesFor(user).TryGetValue(key, out var id) ? id : null;
    }

    /// <summary>
    /// Reduces a title to what two sites, or a site and a folder, agree on:
    /// lower case, no accents, punctuation or brackets, so "Dragon Ball Super:
    /// Beerus" and "Dragon Ball Super Beerus (2015)" come out the same.
    /// </summary>
    /// <param name="title">The title.</param>
    /// <returns>The normalised title, or empty.</returns>
    public static string Normalise(string? title)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return string.Empty;
        }

        var text = Brackets().Replace(title, " ").Normalize(NormalizationForm.FormD);
        var builder = new StringBuilder(text.Length);
        var space = false;
        foreach (var c in text)
        {
            var category = CharUnicodeInfo.GetUnicodeCategory(c);
            if (category == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            if (char.IsLetterOrDigit(c))
            {
                if (space && builder.Length > 0)
                {
                    builder.Append(' ');
                }

                builder.Append(char.ToLowerInvariant(c));
                space = false;
            }
            else
            {
                space = true;
            }
        }

        return builder.ToString();
    }

    private Dictionary<string, Guid> TitlesFor(User user)
    {
        if (_cache.TryGetValue(user.Id, out var hit) && DateTime.UtcNow - hit.At < _cacheFor)
        {
            return hit.Titles;
        }

        var items = _libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Series, BaseItemKind.Movie],
            Recursive = true,
            IsVirtualItem = false,
        });

        var titles = new Dictionary<string, Guid>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            foreach (var name in new[] { item.Name, item.OriginalTitle, item.ForcedSortName })
            {
                var key = Normalise(name);
                if (key.Length > 0)
                {
                    titles.TryAdd(key, item.Id);
                }
            }
        }

        _cache[user.Id] = (DateTime.UtcNow, titles);
        return titles;
    }

    [GeneratedRegex(@"\([^)]*\)|\[[^\]]*\]")]
    private static partial Regex Brackets();
}
