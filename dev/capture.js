// Saves real plugin replies for dev/preview.html.
//
// Open the AniWorld page in Jellyfin while logged in as an admin, paste this
// into the browser console and press Enter. It downloads fixtures.js; move
// that file into this dev/ folder. Only GET calls and one search are made,
// nothing is queued or changed.
//
// For the preview's Series page and Season page with SleekFin, name a series
// first: window.__aniworldDetailsId = '<Jellyfin series ID>'. The script then
// opens that series and its first season here, keeps a copy of both pages as
// drawn, and goes back to where it started.
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

    var details = window.__aniworldDetailsId ? await captureDetails(window.__aniworldDetailsId) : null;

    var fixtures = {
        server: ApiClient.serverAddress(),
        captured: new Date().toISOString(),
        search: SEARCH,
        replies: replies,
        details: details
    };

    function jellyfin(path, params) {
        return ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(path, params), dataType: 'json' })
            .catch(function () { return null; });
    }

    function sleep(ms) {
        return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
    }

    // The theme's classes on <html>; jellyfin-web's layout ones the preview sets itself
    function themeClasses() {
        return document.documentElement.className.split(/\s+/).filter(function (name) { return !/^layout-/.test(name); }).join(' ');
    }

    // What client.js reads off an item
    function itemFields(item) {
        return { Id: item.Id, Type: item.Type, Name: item.Name, SeriesId: item.SeriesId, IndexNumber: item.IndexNumber };
    }

    // The page as drawn, without what this plugin added to it, so the
    // preview's client.js adds that itself
    async function snapshot(id) {
        window.location.hash = '#/details?id=' + id;
        // Jellyfin, the theme and the plugin's lookups take a few seconds
        await sleep(8000);
        var pages = Array.from(document.querySelectorAll('.itemDetailPage')).filter(function (page) {
            return page.offsetParent !== null;
        });
        if (!pages.length) {
            return null;
        }

        var copy = pages[pages.length - 1].cloneNode(true);
        copy.querySelectorAll('.aniworld-missing, .aniworld-card-missing, .detailButton[data-aniworld-downloader]').forEach(function (node) {
            node.remove();
        });
        copy.querySelectorAll('[data-aniworld-downloader]').forEach(function (node) {
            node.removeAttribute('data-aniworld-downloader');
        });
        var backdrop = document.querySelector('.backdropContainer');
        return { html: copy.outerHTML, backdrop: backdrop ? backdrop.innerHTML : '', htmlClass: themeClasses() };
    }

    async function captureDetails(seriesId) {
        var userId = ApiClient.getCurrentUserId();
        var seasons = await jellyfin('Shows/' + seriesId + '/Seasons', { UserId: userId });
        var episodes = await jellyfin('Shows/' + seriesId + '/Episodes', { UserId: userId, IsMissing: false });
        if (!seasons || !episodes) {
            return null;
        }

        replies['GET Shows/' + seriesId + '/Seasons'] = seasons;
        replies['GET Shows/' + seriesId + '/Episodes'] = episodes;
        var found = await keep('FindSource?itemId=' + seriesId);
        var aniworld = found && found.url ? await keep('Seasons?url=' + encodeURIComponent(found.url)) : null;

        // The season page worth seeing: the first where AniWorld has more
        // episodes than Jellyfin, else the first season
        var numbered = (seasons.Items || []).filter(function (s) { return s.IndexNumber > 0; });
        var season = numbered.filter(function (s) {
            var there = ((aniworld && aniworld.seasons) || []).filter(function (a) {
                return !a.are_movies && a.season_number === s.IndexNumber;
            })[0];
            var here = (episodes.Items || []).filter(function (ep) { return ep.ParentIndexNumber === s.IndexNumber; }).length;
            return there && there.episode_count > here;
        })[0] || numbered[0];
        var items = {};
        items[seriesId] = itemFields(await ApiClient.getItem(userId, seriesId));
        if (season) {
            items[season.Id] = itemFields(await ApiClient.getItem(userId, season.Id));
        }

        var start = window.location.hash;
        var pages = {};
        pages[seriesId] = await snapshot(seriesId);
        if (season) {
            pages[season.Id] = await snapshot(season.Id);
        }

        window.location.hash = start;

        return {
            series: seriesId,
            season: season ? season.Id : null,
            items: items,
            pages: pages,
            // The theme's look: its stylesheets, inline styles and page classes
            stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(function (link) { return link.href; }),
            styles: Array.from(document.querySelectorAll('style')).filter(function (style) {
                return style.id !== 'aniworldDownloaderStyles' && style.textContent.trim();
            }).map(function (style) { return style.textContent; }),
            htmlClass: themeClasses(),
            bodyClass: document.body.className
        };
    }

    // The access token must never end up in the file
    var token = ApiClient.accessToken();
    if (token && JSON.stringify(fixtures).indexOf(token) >= 0) {
        fixtures = JSON.parse(JSON.stringify(fixtures).split(token).join(''));
    }

    if (!window.__aniworldNoDownload) {
        var blob = new Blob(['window.ANIWORLD_FIXTURES = ' + JSON.stringify(fixtures, null, 1) + ';\n'], { type: 'text/javascript' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'fixtures.js';
        link.click();
    }

    return fixtures;
})();
