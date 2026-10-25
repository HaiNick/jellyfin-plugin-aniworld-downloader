// Saves real plugin replies for dev/preview.html.
//
// Open the AniWorld page in Jellyfin while logged in as an admin, paste this
// into the browser console and press Enter. It downloads fixtures.js; move
// that file into this dev/ folder. Only GET calls and one search are made,
// nothing is queued or changed.
(async function () {
    var SEARCH = 'dragon ball';
    var LIST_SIZE = 12;
    var DETAIL_COUNT = 8;

    function get(path) {
        return ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('AniWorldDownloader/' + path), dataType: 'json' })
            .catch(function () { return null; });
    }

    var replies = {};
    async function keep(path) {
        var reply = await get(path);
        if (reply) {
            replies['GET ' + path] = reply;
        }

        return reply;
    }

    await keep('Info');
    await keep('Queue?limit=30');
    var status = await keep('AutoSync/Status');

    var urls = [];
    for (var list of ['new-animes', 'popular-animes', 'new-series', 'popular-series', 'popular-movies']) {
        var browse = await get('Browse/' + list);
        if (browse) {
            browse.results = (browse.results || []).slice(0, LIST_SIZE);
            replies['GET Browse/' + list] = browse;
        }
    }

    var search = await ApiClient.ajax({
        type: 'POST',
        url: ApiClient.getUrl('AniWorldDownloader/Search'),
        data: JSON.stringify({ Keyword: SEARCH, Type: 'all' }),
        contentType: 'application/json',
        dataType: 'json'
    }).catch(function () { return null; });
    if (search) {
        replies['POST Search'] = search;
        (search.results || []).slice(0, DETAIL_COUNT).forEach(function (item) { urls.push(item.url); });
    }

    // Tracked series first, so the Auto-Sync page gets its posters
    ((status && status.series) || []).forEach(function (row) { urls.unshift(row.series_url); });
    urls = urls.filter(function (url, i) { return url && urls.indexOf(url) === i; });

    for (var i = 0; i < urls.length; i++) {
        var url = encodeURIComponent(urls[i]);
        var series = await keep('Series?url=' + url);
        // Jellyfin's own episodes of a title in the library, for the thumbnails
        if (series && series.libraryItemId) {
            var shows = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('Shows/' + series.libraryItemId + '/Episodes',
                    { UserId: ApiClient.getCurrentUserId(), Fields: 'Overview', IsMissing: false }),
                dataType: 'json'
            }).catch(function () { return null; });
            if (shows) {
                replies['GET Shows/' + series.libraryItemId + '/Episodes'] = shows;
            }

            // For the missing episodes on the preview's series and season page
            var seasonsOfShow = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('Shows/' + series.libraryItemId + '/Seasons', { UserId: ApiClient.getCurrentUserId() }),
                dataType: 'json'
            }).catch(function () { return null; });
            if (seasonsOfShow) {
                replies['GET Shows/' + series.libraryItemId + '/Seasons'] = seasonsOfShow;
            }

            await keep('FindSource?itemId=' + series.libraryItemId);
        }

        await keep('AutoSync/Tracked?url=' + url);
        var seasons = await keep('Seasons?url=' + url);
        // Episodes and hosters only for the first title, to keep the file small
        var first = i === 0 && seasons && seasons.seasons && seasons.seasons[0];
        if (first) {
            var episodes = await keep('Episodes?url=' + encodeURIComponent(first.url) + '&seriesUrl=' + url);
            var episode = episodes && episodes.episodes && episodes.episodes[0];
            if (episode) {
                await keep('Providers?url=' + encodeURIComponent(episode.url));
            }
        }
    }

    var fixtures = {
        server: ApiClient.serverAddress(),
        captured: new Date().toISOString(),
        search: SEARCH,
        replies: replies
    };

    if (!window.__aniworldNoDownload) {
        var blob = new Blob(['window.ANIWORLD_FIXTURES = ' + JSON.stringify(fixtures, null, 1) + ';\n'], { type: 'text/javascript' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'fixtures.js';
        link.click();
    }

    return fixtures;
})();
