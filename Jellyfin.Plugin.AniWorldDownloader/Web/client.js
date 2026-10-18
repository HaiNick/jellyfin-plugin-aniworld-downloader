// AniWorld Downloader: adds an "AniWorld" entry next to Favorites in the
// jellyfin-web top bar (wide screens) and side menu (phones), and renders the
// plugin page at #/aniworld. Injected into index.html by the plugin.
(function () {
    'use strict';

    var ROUTE = '#/aniworld';
    var LABEL = 'AniWorld';
    var MARK = 'data-aniworld-downloader';
    var FAVORITES_HREF = '#/home?tab=1';

    function isOurRoute() {
        return window.location.hash === ROUTE || window.location.hash.indexOf(ROUTE + '?') === 0;
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

    // jellyfin-web has no route for #/aniworld, so it shows its "page not found"
    // page. Swap that page's content for ours.
    function renderPage() {
        if (!isOurRoute()) {
            return;
        }

        var pages = document.querySelectorAll('#fallbackPage');
        var page = pages[pages.length - 1];
        if (!page || page.hasAttribute(MARK)) {
            return;
        }

        page.setAttribute(MARK, '');
        document.title = LABEL;
        page.innerHTML =
            '<div class="padded-left padded-right padded-top">' +
            '<h1 class="sectionTitle">AniWorld Downloader</h1>' +
            '<p>Hello world from the plugin. If you can read this, the page works here.</p>' +
            '<div class="paperList" style="padding:1em;max-width:40em">' +
            '<div id="aniworld-whoami">Asking the server who you are…</div>' +
            '</div></div>';

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
