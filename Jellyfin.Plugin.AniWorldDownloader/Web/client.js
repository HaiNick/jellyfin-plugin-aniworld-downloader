// AniWorld Downloader: adds an "AniWorld" entry next to Favorites in the
// jellyfin-web top bar (wide screens) and side menu (phones), and renders the
// plugin page at #/search?aniworld. Injected into index.html by the plugin.
//
// The page lives under /search because jellyfin-web only shows the side menu
// button on its own user routes; on an unknown route phones get the library
// list instead. The search page itself is hidden while ours is shown.
(function () {
    'use strict';

    var ROUTE = '#/search?aniworld';
    var LABEL = 'AniWorld';
    var MARK = 'data-aniworld-downloader';
    var PAGE_ID = 'aniworldDownloaderPage';
    var FAVORITES_HREF = '#/home?tab=1';

    // The tab title before our page took over, so it can be put back.
    var previousTitle = null;

    function isOurRoute() {
        var hash = window.location.hash;
        var query = hash.indexOf('?');
        return hash.slice(0, query < 0 ? hash.length : query) === '#/search'
            && query >= 0
            && new URLSearchParams(hash.slice(query + 1)).has('aniworld');
    }

    // The Material "Download" icon, drawn like the Favorites heart it replaces.
    function setDownloadIcon(svg) {
        var path = svg.querySelector('path');
        if (path) {
            path.setAttribute('d', 'M5 20h14v-2H5zM19 9h-4V3H9v6H5l7 7z');
        }
        svg.setAttribute('data-testid', 'DownloadIcon');
    }

    // Clones the Favorites link so the new entry picks up the same MUI classes.
    function addNavEntry(favorites) {
        // In the side menu the link sits in an <li>; in the top bar it stands alone.
        var host = favorites.closest('li') || favorites;
        if (host.nextElementSibling && host.nextElementSibling.hasAttribute(MARK)) {
            return;
        }

        var entry = host.cloneNode(true);
        entry.setAttribute(MARK, '');
        var link = entry.tagName === 'A' ? entry : entry.querySelector('a');
        link.setAttribute('href', ROUTE);
        link.removeAttribute('aria-current');
        link.classList.remove('Mui-selected');

        var svg = link.querySelector('svg');
        if (svg) {
            setDownloadIcon(svg);
        }

        // Replace the "Favorites" text, wherever MUI put it.
        var walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.trim() && !node.parentNode.closest('svg')) {
                node.nodeValue = LABEL;
                break;
            }
        }

        host.after(entry);
    }

    function addNavEntries() {
        var links = document.querySelectorAll('a[href="' + FAVORITES_HREF + '"]');
        for (var i = 0; i < links.length; i++) {
            if (!links[i].hasAttribute(MARK) && !links[i].closest('[' + MARK + ']')) {
                addNavEntry(links[i]);
            }
        }
    }

    function apiGet(path) {
        var client = window.ApiClient;
        if (!client) {
            return Promise.reject(new Error('Jellyfin ApiClient not ready'));
        }

        return client.fetch({ url: client.getUrl(path), type: 'GET', dataType: 'json' });
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // Shows our page next to jellyfin-web's search page and hides the search
    // page; on any other route, removes ours and shows the search page again.
    function renderPage() {
        var searchPage = document.getElementById('searchPage');
        var page = document.getElementById(PAGE_ID);

        if (!isOurRoute()) {
            if (page) {
                page.remove();
            }

            if (searchPage && searchPage.hasAttribute(MARK)) {
                searchPage.removeAttribute(MARK);
                searchPage.style.display = '';
            }

            if (previousTitle !== null) {
                if (document.title === LABEL) {
                    document.title = previousTitle;
                }

                previousTitle = null;
            }

            return;
        }

        if (!searchPage) {
            return;
        }

        if (!searchPage.hasAttribute(MARK)) {
            searchPage.setAttribute(MARK, '');
            searchPage.style.display = 'none';
        }

        if (previousTitle === null) {
            previousTitle = document.title;
        }

        // Only when it differs: writing <title> would wake the observer again.
        if (document.title !== LABEL) {
            document.title = LABEL;
        }

        if (page && page.previousElementSibling === searchPage) {
            return;
        }

        if (page) {
            page.remove();
        }

        page = document.createElement('div');
        page.id = PAGE_ID;
        page.className = 'libraryPage noSecondaryNavPage';
        searchPage.after(page);
        page.innerHTML =
            '<div class="padded-left padded-right padded-top">' +
            '<h1 class="sectionTitle">AniWorld Downloader</h1>' +
            '<p>Hello world from the plugin. If you can read this, the page works here.</p>' +
            '<div class="paperList" style="padding:1em;max-width:40em">' +
            '<div id="aniworld-whoami">Asking the server who you are…</div>' +
            '</div>' +
            '<p class="fieldDescription">client.js: ' + escapeHtml(window.AniWorldDownloaderBuild || 'unknown') + '</p>' +
            '</div>';

        apiGet('AniWorldDownloader/whoami').then(function (me) {
            page.querySelector('#aniworld-whoami').innerHTML =
                '<p><b>User:</b> ' + escapeHtml(me.UserName) + '</p>' +
                '<p><b>Admin:</b> ' + (me.IsAdmin ? 'yes' : 'no') + '</p>' +
                '<p><b>App:</b> ' + escapeHtml(me.Client) + '</p>' +
                '<p><b>Device:</b> ' + escapeHtml(me.Device) + '</p>';
        }).catch(function (err) {
            page.querySelector('#aniworld-whoami').textContent =
                'whoami failed: ' + ((err && (err.status || err.message)) || err);
        });
    }

    var scheduled = false;
    function update() {
        if (scheduled) {
            return;
        }

        scheduled = true;
        window.requestAnimationFrame(function () {
            scheduled = false;
            addNavEntries();
            renderPage();
        });
    }

    // React re-renders the bar and pages often, so keep checking.
    new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', update);
    update();
})();
