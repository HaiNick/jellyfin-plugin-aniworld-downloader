using Jellyfin.Plugin.AniWorldDownloader.Library;
using Xunit;

namespace Jellyfin.Plugin.AniWorldDownloader.Tests;

public class LibraryMatcherTests
{
    [Theory]
    [InlineData("Dragon Ball Super: Beerus", "Dragon Ball Super Beerus")]
    [InlineData("Naruto", "Naruto (2002)")]
    [InlineData("Naruto", "Naruto [imdbid-tt0409591]")]
    [InlineData("Frieren: Beyond Journey's End", "frieren beyond journey’s end")]
    [InlineData("Pokémon", "Pokemon")]
    [InlineData("K-On!", "K On")]
    public void TheSameTitleMatches(string site, string library)
    {
        Assert.Equal(LibraryMatcher.Normalise(site), LibraryMatcher.Normalise(library));
    }

    [Theory]
    [InlineData("Naruto", "Naruto Shippuden")]
    [InlineData("Dune", "Dune: Part Two")]
    public void ADifferentTitleDoesNot(string site, string library)
    {
        Assert.NotEqual(LibraryMatcher.Normalise(site), LibraryMatcher.Normalise(library));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("(2002)")]
    public void NothingLeftIsEmpty(string? title)
    {
        Assert.Equal(string.Empty, LibraryMatcher.Normalise(title));
    }
}
