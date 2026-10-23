// AniWorld Downloader: adds an "AniWorld" entry next to Favorites in the
// jellyfin-web top bar (wide screens) and side menu (phones), and renders the
// plugin page at #/search?aniworld. Injected into index.html by the plugin.
//
// The page lives under /search because jellyfin-web only shows the side menu
// button on its own user routes; on an unknown route phones get the library
// list instead. The search page itself is hidden while ours is shown.
//
// Views, all in the hash so the back button works:
//   #/search?aniworld&q=frieren&t=anime   search, with its tab
//   #/search?aniworld&q=...&u=<url>        one title: seasons, episodes, download
(function () {
    'use strict';

    var ROUTE = '#/search?aniworld';
    var LABEL = 'AniWorld';
    var MARK = 'data-aniworld-downloader';
    var PAGE_ID = 'aniworldDownloaderPage';
    var FAVORITES_HREF = '#/home?tab=1';

    var TABS = [
        { id: 'all', label: 'All' },
        { id: 'anime', label: 'Anime' },
        { id: 'series', label: 'Series' },
        { id: 'movie', label: 'Movies' }
    ];

    var SITE_NAMES = {
        aniworld: 'AniWorld',
        sto: 'S.to',
        burningseries: 'BurningSeries',
        kinox: 'Kinox',
        moflix: 'Moflix',
        megakino: 'MegaKino',
        filmpalast: 'FilmPalast',
        filmo: 'Filmo'
    };

    var LANGUAGE_SHORT = {
        'German Dub': 'DE',
        'German Sub': 'DE Sub',
        'English Dub': 'EN',
        'English Sub': 'EN Sub'
    };

    // The tab title before our page took over, so it can be put back.
    var previousTitle = null;

    // What the page has drawn, so a re-render only happens when the hash changes.
    var renderedHash = null;

    // Replies kept for the session: going back to a search must not search again.
    var cache = {};

    // GET /Info, once per page load
    var infoPromise = null;

    // ------------------------------------------------------------------
    // Routing
    // ------------------------------------------------------------------
    function hashParams() {
        var hash = window.location.hash;
        var query = hash.indexOf('?');
        if (query < 0 || hash.slice(0, query) !== '#/search') {
            return null;
        }

        var params = new URLSearchParams(hash.slice(query + 1));
        return params.has('aniworld') ? params : null;
    }

    function isOurRoute() {
        return hashParams() !== null;
    }

    function routeTo(values, replace) {
        var params = new URLSearchParams();
        params.set('aniworld', '');
        Object.keys(values).forEach(function (key) {
            if (values[key]) {
                params.set(key, values[key]);
            }
        });

        // URLSearchParams writes "aniworld=", the nav link is plain "aniworld"
        var hash = '#/search?' + params.toString().replace(/^aniworld=(&|$)/, 'aniworld$1');
        if (replace) {
            window.history.replaceState(window.history.state, '', hash);
            update();
        } else {
            window.location.hash = hash;
        }
    }

    // ------------------------------------------------------------------
    // Server calls
    // ------------------------------------------------------------------
    function api(method, path, body) {
        var client = window.ApiClient;
        if (!client) {
            return Promise.reject(new Error('Jellyfin is still starting'));
        }

        var options = { type: method, url: client.getUrl('AniWorldDownloader/' + path), dataType: 'json' };
        if (body) {
            options.data = JSON.stringify(body);
            options.contentType = 'application/json';
        }

        return client.ajax(options).catch(function (err) {
            // ApiClient rejects with the fetch Response; turn it into a message
            if (err && typeof err.json === 'function') {
                return err.json().then(function (data) {
                    throw new Error((data && data.error) || ('HTTP ' + err.status));
                }, function () {
                    throw new Error('HTTP ' + err.status);
                });
            }

            throw err instanceof Error ? err : new Error(String(err));
        });
    }

    function cached(key, load) {
        if (!cache[key]) {
            cache[key] = load().catch(function (err) {
                delete cache[key];
                throw err;
            });
        }

        return cache[key];
    }

    function getInfo() {
        if (!infoPromise) {
            infoPromise = api('GET', 'Info').catch(function (err) {
                infoPromise = null;
                throw err;
            });
        }

        return infoPromise;
    }

    function imageUrl(path) {
        return path ? window.ApiClient.getUrl(path) : '';
    }

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------
    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function el(html) {
        var holder = document.createElement('div');
        holder.innerHTML = html.trim();
        return holder.firstChild;
    }

    // The search and detail views share one container, so a reply that comes
    // back after the user moved on must not write into the next view.
    function isStale(view, inner) {
        return renderedHash !== view || !inner.isConnected;
    }

    function siteName(site) {
        return SITE_NAMES[site] || site;
    }

    // Links out to the title's own page on its site. Only http(s), since the
    // URL comes from AniWorld's replies.
    function externalHref(url) {
        try {
            var parsed = new URL(url);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
        } catch (e) {
            return '';
        }
    }

    // The Material "Open in new" icon
    var EXTERNAL_ICON = '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" focusable="false">' +
        '<path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3z"/></svg>';

    var toastTimer = null;
    function toast(message) {
        var box = document.getElementById('aniworldToast');
        if (!box) {
            box = el('<div id="aniworldToast" class="aniworld-toast" role="status"></div>');
            document.body.appendChild(box);
        }

        box.textContent = message;
        box.classList.add('aniworld-toast-visible');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            box.classList.remove('aniworld-toast-visible');
        }, 4000);
    }

    function addStyles() {
        if (document.getElementById('aniworldDownloaderStyles')) {
            return;
        }

        // Only layout here; colours and fonts come from Jellyfin's own classes
        // and theme, so the page follows whatever theme is picked.
        var style = document.createElement('style');
        style.id = 'aniworldDownloaderStyles';
        style.textContent = [
            '#' + PAGE_ID + ' .aniworld-inner{padding-top:1em;padding-bottom:5em;max-width:90em}',
            '#' + PAGE_ID + ' .aniworld-searchbar{display:flex;gap:.5em;align-items:center;max-width:40em}',
            '#' + PAGE_ID + ' .aniworld-searchbar .emby-input{flex:1;margin:0}',
            '#' + PAGE_ID + ' .aniworld-tabs{display:flex;flex-wrap:wrap;gap:.5em;margin:1em 0}',
            '#' + PAGE_ID + ' .aniworld-tabs .emby-button{margin:0;min-height:2.75em}',
            '#' + PAGE_ID + ' .aniworld-status{margin:1.5em 0;opacity:.8}',
            // Three across on a phone, like Jellyfin's own library pages
            '#' + PAGE_ID + ' .aniworld-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(9.5em,28%),1fr));gap:1.25em .9em}',
            // Browse lists scroll sideways, like the rows on Jellyfin's home page
            '#' + PAGE_ID + ' .aniworld-browse-list{margin-bottom:1.5em}',
            '#' + PAGE_ID + ' .aniworld-browse-list .sectionTitle{margin:0 0 .5em}',
            '#' + PAGE_ID + ' .aniworld-row{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(min(9.5em,28%),9.5em);' +
            'gap:.9em;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity;padding-bottom:.5em}',
            '#' + PAGE_ID + ' .aniworld-row .aniworld-card{scroll-snap-align:start}',
            '#' + PAGE_ID + ' .aniworld-card{display:block;color:inherit;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent}',
            // Not Jellyfin's cardImageContainer: it forces background-clip to
            // the content box, which leaves a box like this one blank
            '#' + PAGE_ID + ' .aniworld-poster{position:relative;aspect-ratio:2/3;border-radius:.3em;overflow:hidden;' +
            'background-color:rgba(128,128,128,.2);background-size:cover;background-position:center}',
            '#' + PAGE_ID + ' .aniworld-poster-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:2em;opacity:.5}',
            '#' + PAGE_ID + ' .aniworld-card-title{margin-top:.4em;font-size:.95em;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
            '#' + PAGE_ID + ' .aniworld-badge{display:inline-block;padding:.1em .45em;margin:.3em .3em 0 0;border-radius:.25em;font-size:.75em;background:rgba(128,128,128,.25)}',
            '#' + PAGE_ID + ' .aniworld-badge-site{position:absolute;left:.4em;bottom:.4em;margin:0;background:rgba(0,0,0,.7);color:#fff}',
            '#' + PAGE_ID + ' .aniworld-badge-library{position:absolute;right:.4em;top:.4em;margin:0;color:#fff;' +
            'background:var(--aniworld-accent,#00a4dc)}',
            '#' + PAGE_ID + ' .aniworld-titlebar{display:flex;align-items:center;justify-content:space-between;gap:1em}',
            '#' + PAGE_ID + ' .aniworld-titlebar .emby-button{margin:0;min-height:2.75em}',
            '#' + PAGE_ID + ' .aniworld-library-link{display:inline-block;margin-top:.75em;min-height:2.75em}',
            '#' + PAGE_ID + ' .aniworld-links{display:flex;flex-wrap:wrap;gap:.5em;align-items:center}',
            '#' + PAGE_ID + ' .aniworld-site-link{display:inline-flex;align-items:center;gap:.4em;margin-top:.75em;min-height:2.75em;' +
            'color:inherit;opacity:.85}',
            '#' + PAGE_ID + ' .aniworld-sync{margin:1em 0;padding:.75em 1em;border-radius:.3em}',
            '#' + PAGE_ID + ' .aniworld-sync-switch{display:flex;align-items:center;gap:.75em;min-height:2.75em;cursor:pointer}',
            '#' + PAGE_ID + ' .aniworld-sync-switch input{width:1.35em;height:1.35em;margin:0;accent-color:var(--aniworld-accent,auto)}',
            // Season and episode side by side, the schedule picker on a row of its
            // own so it isn't cut off on a phone, then day and time
            '#' + PAGE_ID + ' .aniworld-sync-fields{display:grid;grid-template-columns:1fr 1fr;gap:.75em 1em;margin-top:.75em;max-width:32em}',
            '#' + PAGE_ID + ' .aniworld-sync-fields > div{margin:0;min-width:0}',
            '#' + PAGE_ID + ' .aniworld-sync-fields .aniworld-sync-cadence-box{grid-column:1 / -1}',
            '#' + PAGE_ID + ' .aniworld-sync-fields label{display:block;margin-bottom:.3em;white-space:nowrap}',
            // Inside the panel the fields would have the panel's own colour; give them an edge
            '#' + PAGE_ID + ' .aniworld-sync .emby-input,#' + PAGE_ID + ' .aniworld-sync .emby-select{width:100%;box-sizing:border-box;' +
            'border:1px solid rgba(128,128,128,.4);border-radius:.2em;padding:.5em .6em;background:rgba(0,0,0,.15);color:inherit;font:inherit}',
            '#' + PAGE_ID + ' .aniworld-queue-item{display:flex;align-items:center;gap:1em;padding:.75em 1em}',
            '#' + PAGE_ID + ' .aniworld-queue-item + .aniworld-queue-item{border-top:1px solid rgba(128,128,128,.2)}',
            '#' + PAGE_ID + ' .aniworld-queue-text{flex:1;min-width:0}',
            '#' + PAGE_ID + ' .aniworld-queue-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '#' + PAGE_ID + ' .aniworld-queue-sub{font-size:.85em;opacity:.75;margin-top:.2em}',
            '#' + PAGE_ID + ' .aniworld-progress{height:.3em;border-radius:.15em;margin-top:.45em;background:rgba(128,128,128,.25);overflow:hidden}',
            '#' + PAGE_ID + ' .aniworld-progress span{display:block;height:100%;background:var(--aniworld-accent,#00a4dc);transition:width .5s}',
            '#' + PAGE_ID + ' .aniworld-queue-item .emby-button{margin:0;min-height:2.5em;flex:none}',
            '#' + PAGE_ID + ' .aniworld-queue-buttons{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.5em}',
            // The captcha over the whole screen, so it is as big as a phone allows
            '#' + PAGE_ID + ' .aniworld-captcha{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;align-items:center;' +
            'justify-content:center;gap:.75em;padding:1em;box-sizing:border-box;background:rgba(0,0,0,.9);color:#fff}',
            '#' + PAGE_ID + ' .aniworld-captcha-bar{display:flex;align-items:center;justify-content:space-between;gap:1em;width:100%;max-width:60em}',
            '#' + PAGE_ID + ' .aniworld-captcha-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '#' + PAGE_ID + ' .aniworld-captcha-bar .emby-button{margin:0;min-height:2.75em;flex:none}',
            // No object-fit: the box has to match the picture, or clicks land off target
            '#' + PAGE_ID + ' .aniworld-captcha img{display:block;width:auto;height:auto;max-width:100%;max-height:calc(100vh - 9em);' +
            'max-height:calc(100dvh - 9em);border-radius:.2em;cursor:crosshair;touch-action:manipulation}',
            '#' + PAGE_ID + ' .aniworld-captcha-hint{max-width:40em;font-size:.9em;opacity:.8;text-align:center}',
            '#' + PAGE_ID + ' .aniworld-head{display:flex;gap:1em;align-items:flex-start}',
            '#' + PAGE_ID + ' .aniworld-head .aniworld-poster{width:10em;flex:none}',
            '#' + PAGE_ID + ' .aniworld-head-text{flex:1;min-width:0}',
            '#' + PAGE_ID + ' .aniworld-head h1{margin:0 0 .25em;overflow-wrap:anywhere}',
            '@media (max-width:40em){#' + PAGE_ID + ' .aniworld-head .aniworld-poster{width:7em}' +
            '#' + PAGE_ID + ' .aniworld-head h1{font-size:1.4em}}',
            // Four lines until "More", so the episodes stay near the top on a phone
            '#' + PAGE_ID + ' .aniworld-description{line-height:1.5;opacity:.85;max-width:50em;margin:1em 0 0;' +
            'overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical}',
            '#' + PAGE_ID + ' .aniworld-description.aniworld-open{display:block}',
            '#' + PAGE_ID + ' .aniworld-more{background:none;border:0;padding:.5em 0;color:inherit;font:inherit;' +
            'text-decoration:underline;cursor:pointer;opacity:.8}',
            '#' + PAGE_ID + ' .aniworld-pickers{display:flex;flex-wrap:wrap;gap:1em;margin:1.5em 0 .5em}',
            '#' + PAGE_ID + ' .aniworld-pickers .selectContainer{margin:0;min-width:11em;flex:1;max-width:20em}',
            '#' + PAGE_ID + ' .aniworld-episodes{margin:.5em 0 1em;border-radius:.3em;overflow:hidden}',
            '#' + PAGE_ID + ' .aniworld-episode{display:flex;align-items:center;gap:.75em;padding:.65em .9em;min-height:2.75em;cursor:pointer}',
            '#' + PAGE_ID + ' .aniworld-episode + .aniworld-episode{border-top:1px solid rgba(128,128,128,.2)}',
            '#' + PAGE_ID + ' .aniworld-episode input{width:1.35em;height:1.35em;flex:none;margin:0;' +
            'accent-color:var(--aniworld-accent,auto)}',
            '#' + PAGE_ID + ' .aniworld-episode-text{flex:1;min-width:0}',
            '#' + PAGE_ID + ' .aniworld-episode-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            // Big enough to tap on a phone without hitting the checkbox row
            '#' + PAGE_ID + ' .aniworld-episode-link{flex:none;display:flex;align-items:center;justify-content:center;' +
            'width:2.75em;height:2.75em;margin:-.5em -.5em -.5em 0;color:inherit;opacity:.7;font-size:1.2em}',
            '#' + PAGE_ID + ' .aniworld-actions{display:flex;flex-wrap:wrap;gap:.75em;position:sticky;bottom:0;padding:.75em 0;z-index:2;' +
            'background:var(--aniworld-page-background,#101010)}',
            '#' + PAGE_ID + ' .aniworld-actions .emby-button{margin:0;flex:1;min-width:12em;min-height:3em}',
            '.aniworld-toast{position:fixed;left:50%;bottom:1.5em;transform:translate(-50%,2em);opacity:0;pointer-events:none;',
            'max-width:calc(100% - 2em);padding:.85em 1.25em;border-radius:.3em;background:#303030;color:#fff;',
            'box-shadow:0 .2em .8em rgba(0,0,0,.4);transition:opacity .2s,transform .2s;z-index:9999}',
            '.aniworld-toast-visible{opacity:1;transform:translate(-50%,0)}'
        ].join('\n');
        document.head.appendChild(style);
    }

    // ------------------------------------------------------------------
    // Nav entry
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // Search view
    // ------------------------------------------------------------------
    function renderSearch(inner, params, info) {
        var keyword = params.get('q') || '';
        var tab = params.get('t') || 'all';
        // Only titles already in a Jellyfin library, see LibraryMatcher
        var onlyLibrary = params.get('lib') === '1';

        inner.innerHTML =
            '<div class="aniworld-titlebar"><h1 class="sectionTitle">AniWorld</h1>' +
            '<button type="button" class="raised emby-button aniworld-open-queue">Queue</button></div>' +
            '<form class="aniworld-searchbar">' +
            '<input type="search" class="emby-input" name="q" autocomplete="off" enterkeyhint="search" ' +
            'placeholder="Search anime, series and movies" aria-label="Search" value="' + escapeHtml(keyword) + '">' +
            '<button type="submit" class="raised button-submit emby-button" style="margin:0;min-height:2.75em">Search</button>' +
            '</form>' +
            '<div class="aniworld-tabs" role="tablist">' +
            TABS.map(function (t) {
                var active = t.id === tab;
                return '<button type="button" role="tab" aria-selected="' + active + '" data-tab="' + t.id + '" ' +
                    'class="raised emby-button' + (active ? ' button-submit' : '') + '">' + t.label + '</button>';
            }).join('') +
            // A filter on top of the tab, not a tab of its own
            '<button type="button" aria-pressed="' + onlyLibrary + '" ' +
            'class="raised emby-button aniworld-only-library' + (onlyLibrary ? ' button-submit' : '') + '">' +
            (onlyLibrary ? '✓ ' : '') + 'In library</button>' +
            '</div>' +
            '<div class="aniworld-status"></div>' +
            '<div class="aniworld-grid"></div>';

        inner.querySelector('.aniworld-open-queue').addEventListener('click', function () {
            routeTo({ view: 'queue' });
        });

        var form = inner.querySelector('form');
        var input = form.querySelector('input');
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            input.blur();
            var value = input.value.trim();
            if (value) {
                routeTo({ q: value, t: tab, lib: onlyLibrary ? '1' : '' });
            }
        });

        inner.querySelectorAll('[data-tab]').forEach(function (button) {
            button.addEventListener('click', function () {
                routeTo({ q: input.value.trim() || keyword, t: button.getAttribute('data-tab'), lib: onlyLibrary ? '1' : '' }, true);
            });
        });

        inner.querySelector('.aniworld-only-library').addEventListener('click', function () {
            routeTo({ q: input.value.trim() || keyword, t: tab, lib: onlyLibrary ? '' : '1' }, true);
        });

        var status = inner.querySelector('.aniworld-status');
        if (!info.configured) {
            status.textContent = info.isAdmin
                ? 'Not set up yet. Add the AniWorld Downloader URL under Dashboard → Plugins → AniWorld Downloader.'
                : 'Not set up yet. Ask an admin to connect AniWorld Downloader.';
            return;
        }

        var grid = inner.querySelector('.aniworld-grid');
        if (!keyword) {
            renderBrowse(inner, grid, status, params, tab, onlyLibrary);
            if (!('ontouchstart' in window)) {
                input.focus();
            }
            return;
        }

        var view = renderedHash;
        var total = 0;
        var shown = 0;

        function show(results, pending) {
            total += results.length;
            results.forEach(function (item) {
                if (!onlyLibrary || item.libraryItemId) {
                    shown++;
                    grid.appendChild(makeCard(item, params));
                }
            });

            var text;
            if (pending && pending.length) {
                text = 'Still searching ' + pending.map(siteName).join(', ') + '…';
            } else if (!total) {
                text = 'Nothing found for “' + keyword + '”.';
            } else if (onlyLibrary && !shown) {
                text = 'None of the ' + total + ' results for “' + keyword + '” are in your library.';
            } else {
                text = onlyLibrary ? shown + ' of ' + total + ' results are in your library.' : '';
            }
            status.textContent = text;
        }

        var key = 'search|' + tab + '|' + keyword.toLowerCase();
        if (cache[key]) {
            // Back from a title: the finished search, at once
            cache[key].then(function (results) {
                if (!isStale(view, inner)) {
                    show(results, null);
                }
            });
            return;
        }

        status.textContent = 'Searching…';
        var collected = [];
        searchStream(keyword, tab, function (event) {
            if (isStale(view, inner)) {
                return false;
            }

            collected = collected.concat(event.results || []);
            show(event.results || [], event.pending);
            return true;
        }).then(function () {
            cache[key] = Promise.resolve(collected);
            if (!isStale(view, inner)) {
                show([], null);
            }
        }, function (err) {
            if (!isStale(view, inner)) {
                status.textContent = 'Search failed: ' + err.message;
            }
        });
    }

    // Reads /SearchStream line by line: each site's results arrive as soon as
    // that site has answered. onEvent returns false to stop listening.
    function searchStream(keyword, tab, onEvent) {
        var client = window.ApiClient;
        if (!client || !window.fetch || !window.TextDecoder || !window.ReadableStream) {
            // No streaming here: one reply with everything
            return api('POST', 'Search', { Keyword: keyword, Type: tab }).then(function (reply) {
                onEvent({ results: reply.results || [], pending: [] });
            });
        }

        return fetch(client.getUrl('AniWorldDownloader/SearchStream'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'MediaBrowser Token="' + client.accessToken() + '"'
            },
            body: JSON.stringify({ Keyword: keyword, Type: tab })
        }).then(function (response) {
            if (!response.ok) {
                return response.json().then(function (data) {
                    throw new Error((data && data.error) || ('HTTP ' + response.status));
                }, function () {
                    throw new Error('HTTP ' + response.status);
                });
            }

            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';

            function read() {
                return reader.read().then(function (chunk) {
                    buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
                    var lines = buffer.split('\n');
                    buffer = chunk.done ? '' : lines.pop();
                    for (var i = 0; i < lines.length; i++) {
                        if (!lines[i].trim()) {
                            continue;
                        }

                        var event = JSON.parse(lines[i]);
                        if (event.done) {
                            return undefined;
                        }

                        if (onEvent(event) === false) {
                            reader.cancel();
                            return undefined;
                        }
                    }

                    return chunk.done ? undefined : read();
                });
            }

            return read();
        });
    }

    // What the page shows before anything is searched: AniWorld's own lists
    var BROWSE_LISTS = [
        { id: 'new-animes', label: 'New anime', tabs: ['all', 'anime'] },
        { id: 'popular-animes', label: 'Popular anime', tabs: ['all', 'anime'] },
        { id: 'new-series', label: 'New series', tabs: ['all', 'series'] },
        { id: 'popular-series', label: 'Popular series', tabs: ['all', 'series'] },
        { id: 'popular-movies', label: 'Popular movies', tabs: ['all', 'movie'] }
    ];

    // AniWorld's lists don't say which site a title is on; the link does
    function siteFromUrl(url) {
        try {
            var host = new URL(url).hostname.replace(/^www\./, '');
            if (host === 'aniworld.to') {
                return 'aniworld';
            }

            if (host === 'serienstream.to' || host === 's.to') {
                return 'sto';
            }

            return host.split('.')[0];
        } catch (e) {
            return '';
        }
    }

    function renderBrowse(inner, grid, status, params, tab, onlyLibrary) {
        var view = renderedHash;
        status.textContent = '';
        grid.className = 'aniworld-browse';
        BROWSE_LISTS.filter(function (list) { return list.tabs.indexOf(tab) >= 0; }).forEach(function (list) {
            var section = el(
                '<div class="aniworld-browse-list">' +
                '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(list.label) + '</h2>' +
                '<div class="aniworld-row"><div class="aniworld-status">Loading…</div></div>' +
                '</div>');
            grid.appendChild(section);
            var row = section.querySelector('.aniworld-row');

            cached('browse|' + list.id, function () {
                return api('GET', 'Browse/' + list.id);
            }).then(function (reply) {
                if (isStale(view, inner)) {
                    return;
                }

                var items = (reply.results || []).filter(function (item) {
                    return !onlyLibrary || item.libraryItemId;
                });
                if (!items.length) {
                    // An empty list is just noise on the page
                    section.remove();
                    return;
                }

                row.innerHTML = '';
                items.forEach(function (item) {
                    row.appendChild(makeCard({
                        title: item.title,
                        url: item.url,
                        site: siteFromUrl(item.url),
                        poster_url: item.poster_url,
                        libraryItemId: item.libraryItemId
                    }, params));
                });
            }, function () {
                section.remove();
            });
        });
    }

    function makeCard(item, params) {
        var card = el(
            '<a class="aniworld-card" role="button">' +
            '<div class="aniworld-poster">' +
            '<div class="aniworld-poster-empty" aria-hidden="true">' + escapeHtml(item.title.charAt(0)) + '</div>' +
            (item.site ? '<span class="aniworld-badge aniworld-badge-site">' + escapeHtml(siteName(item.site)) + '</span>' : '') +
            (item.libraryItemId ? '<span class="aniworld-badge aniworld-badge-library">In library</span>' : '') +
            '</div>' +
            '<div class="aniworld-card-title">' + escapeHtml(item.title) + '</div>' +
            '</a>');
        card.addEventListener('click', function () {
            routeTo({ q: params.get('q'), t: params.get('t'), lib: params.get('lib'), u: item.url });
        });

        var poster = card.querySelector('.aniworld-poster');
        if (item.poster_url) {
            showPoster(poster, item.poster_url);
        } else {
            // aniworld's search has no posters; fetch them as cards scroll in
            watchPoster(poster, item.url);
        }

        return card;
    }

    function showPoster(poster, path) {
        var img = new Image();
        img.onload = function () {
            poster.style.backgroundImage = 'url("' + img.src + '")';
            var empty = poster.querySelector('.aniworld-poster-empty');
            if (empty) {
                empty.remove();
            }
        };
        img.src = imageUrl(path);
    }

    // At most a few detail lookups at once, so a long result list doesn't
    // hammer the sites.
    var posterQueue = [];
    var postersLoading = 0;
    var posterObserver = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                posterObserver.unobserve(entry.target);
                posterQueue.push(entry.target);
            }
        });
        pumpPosters();
    }, { rootMargin: '200px' }) : null;

    function watchPoster(poster, url) {
        poster.setAttribute('data-series-url', url);
        if (posterObserver) {
            posterObserver.observe(poster);
        }
    }

    function pumpPosters() {
        while (postersLoading < 3 && posterQueue.length) {
            var poster = posterQueue.shift();
            if (!poster.isConnected) {
                continue;
            }

            postersLoading++;
            (function (target) {
                var url = target.getAttribute('data-series-url');
                getSeries(url).then(function (series) {
                    if (series.poster_url && target.isConnected) {
                        showPoster(target, series.poster_url);
                    }
                }, function () { /* the initial stays */ }).then(function () {
                    postersLoading--;
                    pumpPosters();
                });
            })(poster);
        }
    }

    function getSeries(url) {
        return cached('series|' + url, function () {
            return api('GET', 'Series?url=' + encodeURIComponent(url));
        });
    }

    // ------------------------------------------------------------------
    // Detail view
    // ------------------------------------------------------------------
    function renderDetail(inner, params, info) {
        var url = params.get('u');
        inner.innerHTML =
            '<div class="aniworld-head">' +
            '<div class="aniworld-poster"></div>' +
            '<div class="aniworld-head-text">' +
            '<h1>…</h1><div class="aniworld-meta"></div>' +
            '<div class="aniworld-links"><span class="aniworld-library"></span><span class="aniworld-site"></span></div>' +
            '</div></div>' +
            '<p class="aniworld-description"></p>' +
            '<button type="button" class="aniworld-more" hidden>More</button>' +
            '<div class="aniworld-sync paperList" hidden></div>' +
            '<div class="aniworld-pickers"></div>' +
            '<div class="aniworld-status">Loading…</div>' +
            '<div class="aniworld-episodes paperList"></div>' +
            '<div class="aniworld-actions"></div>';

        var view = renderedHash;
        var status = inner.querySelector('.aniworld-status');
        getSeries(url).then(function (series) {
            if (isStale(view, inner)) {
                return;
            }

            var title = series.title || 'Unknown';
            inner.querySelector('h1').textContent = title;
            setTitle(title);
            var meta = [];
            if (series.release_year) {
                meta.push('<span class="aniworld-badge">' + escapeHtml(series.release_year) + '</span>');
            }
            (series.genres || []).slice(0, 6).forEach(function (genre) {
                meta.push('<span class="aniworld-badge">' + escapeHtml(genre) + '</span>');
            });
            inner.querySelector('.aniworld-meta').innerHTML = meta.join('');
            var description = inner.querySelector('.aniworld-description');
            var more = inner.querySelector('.aniworld-more');
            description.textContent = series.description || '';
            // Only offer "More" when the four lines actually cut something off
            more.hidden = description.scrollHeight <= description.clientHeight + 2;
            more.addEventListener('click', function () {
                var open = description.classList.toggle('aniworld-open');
                more.textContent = open ? 'Less' : 'More';
            });
            if (series.poster_url) {
                showPoster(inner.querySelector('.aniworld-head .aniworld-poster'), series.poster_url);
            }

            if (series.libraryItemId) {
                var serverId = window.ApiClient.serverId ? window.ApiClient.serverId() : '';
                inner.querySelector('.aniworld-library').innerHTML =
                    '<a class="raised emby-button aniworld-library-link" href="#/details?id=' +
                    encodeURIComponent(series.libraryItemId) +
                    (serverId ? '&serverId=' + encodeURIComponent(serverId) : '') +
                    '">In your library: open</a>';
            }

            var siteHref = externalHref(url);
            if (siteHref) {
                inner.querySelector('.aniworld-site').innerHTML =
                    '<a class="aniworld-site-link" href="' + escapeHtml(siteHref) +
                    '" target="_blank" rel="noopener noreferrer">' +
                    escapeHtml('Open on ' + siteName(siteFromUrl(url))) + EXTERNAL_ICON + '</a>';
            }

            renderSync(inner, url, title, info, view);
        }, function (err) {
            if (isStale(view, inner)) {
                return;
            }

            inner.querySelector('h1').textContent = 'Could not load this title';
            status.textContent = err.message;
        });

        cached('seasons|' + url, function () {
            return api('GET', 'Seasons?url=' + encodeURIComponent(url));
        }).then(function (reply) {
            if (isStale(view, inner)) {
                return;
            }

            var seasons = reply.seasons || [];
            if (!seasons.length) {
                status.textContent = 'No seasons found.';
                return;
            }

            new DetailState(inner, url, seasons, info, params.get('missing') === '1').start();
        }, function (err) {
            status.textContent = 'Could not load the seasons: ' + err.message;
        });
    }

    // ------------------------------------------------------------------
    // Auto-Sync switch
    // ------------------------------------------------------------------
    // AniWorld only syncs these two sites, see SYNC_SITES in its home.js
    function canSync(url) {
        try {
            var host = new URL(url).hostname.replace(/^www\./, '');
            return host === 'aniworld.to' || host === 'serienstream.to' || host === 's.to';
        } catch (e) {
            return false;
        }
    }

    var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    function renderSync(inner, seriesUrl, title, info, view) {
        var box = inner.querySelector('.aniworld-sync');
        if (!info.canDownload || !canSync(seriesUrl)) {
            return;
        }

        api('GET', 'AutoSync/Tracked?url=' + encodeURIComponent(seriesUrl)).then(function (state) {
            if (isStale(view, inner)) {
                return;
            }

            box.innerHTML =
                '<label class="aniworld-sync-switch"><input type="checkbox" class="aniworld-sync-on">' +
                '<span>Keep up to date with Auto-Sync</span></label>' +
                '<div class="aniworld-sync-fields">' +
                '<div><label class="inputLabel">From season</label>' +
                '<input type="number" min="0" class="emby-input aniworld-sync-season"></div>' +
                '<div><label class="inputLabel">From episode</label>' +
                '<input type="number" min="1" class="emby-input aniworld-sync-episode"></div>' +
                '<div class="aniworld-sync-cadence-box"><label class="selectLabel">When</label>' +
                '<select class="emby-select-withcolor emby-select aniworld-sync-cadence">' +
                '<option value="global">With the global schedule</option>' +
                '<option value="daily">Every day</option>' +
                '<option value="weekly">Every week</option></select></div>' +
                '<div class="aniworld-sync-weekday-box"><label class="selectLabel">Day</label>' +
                '<select class="emby-select-withcolor emby-select aniworld-sync-weekday">' +
                WEEKDAYS.map(function (day, i) { return '<option value="' + i + '">' + day + '</option>'; }).join('') +
                '</select></div>' +
                '<div class="aniworld-sync-time-box"><label class="inputLabel">At</label>' +
                '<input type="time" class="emby-input aniworld-sync-time"></div>' +
                '</div>' +
                '<div class="fieldDescription aniworld-sync-status"></div>';
            box.hidden = false;

            var on = box.querySelector('.aniworld-sync-on');
            var season = box.querySelector('.aniworld-sync-season');
            var episode = box.querySelector('.aniworld-sync-episode');
            var cadence = box.querySelector('.aniworld-sync-cadence');
            var weekday = box.querySelector('.aniworld-sync-weekday');
            var time = box.querySelector('.aniworld-sync-time');
            var status = box.querySelector('.aniworld-sync-status');

            function fill(row) {
                on.checked = Boolean(row);
                season.value = row ? row.start_season : 1;
                episode.value = row ? row.start_episode : 1;
                cadence.value = row ? row.cadence : 'global';
                weekday.value = row ? String(row.weekday) : '0';
                time.value = row ? row.run_time : '22:00';
                show(row);
            }

            function show(row) {
                box.querySelector('.aniworld-sync-fields').style.display = on.checked ? '' : 'none';
                box.querySelector('.aniworld-sync-weekday-box').style.display = cadence.value === 'weekly' ? '' : 'none';
                box.querySelector('.aniworld-sync-time-box').style.display = cadence.value === 'global' ? 'none' : '';
                var text = '';
                if (on.checked && row) {
                    text = 'Syncs in ' + row.language + (row.schedule ? ', ' + row.schedule.charAt(0).toLowerCase() + row.schedule.slice(1) : '');
                    if (row.next_run) {
                        text += '. Next check ' + new Date(row.next_run).toLocaleString() + '.';
                    }
                } else if (!on.checked) {
                    text = 'New episodes download by themselves, in the language picked below.';
                }
                status.textContent = text;
            }

            function save() {
                var language = inner.querySelector('.aniworld-language');
                return api('POST', 'AutoSync/Tracked', {
                    series_url: seriesUrl,
                    title: title,
                    tracked: true,
                    language: (language && language.value) || info.defaultLanguage,
                    start_season: Number(season.value || 1),
                    start_episode: Number(episode.value || 1),
                    cadence: cadence.value,
                    weekday: Number(weekday.value),
                    run_time: time.value || '22:00'
                }).then(function (reply) {
                    show(reply.series);
                    return reply;
                });
            }

            fill(state.tracked ? state.series : null);

            on.addEventListener('change', function () {
                show(null);
                var request = on.checked
                    ? save()
                    : api('POST', 'AutoSync/Tracked', { series_url: seriesUrl, tracked: false });
                request.then(function () {
                    toast(on.checked ? 'Auto-Sync keeps ' + title + ' up to date' : title + ' is no longer synced');
                }, function (err) {
                    on.checked = !on.checked;
                    show(null);
                    toast('Auto-Sync: ' + err.message);
                });
            });

            [season, episode, cadence, weekday, time].forEach(function (field) {
                field.addEventListener('change', function () {
                    show(null);
                    if (on.checked) {
                        save().catch(function (err) {
                            toast('Auto-Sync: ' + err.message);
                        });
                    }
                });
            });
        }, function () {
            // 404 while Auto-Sync is off in AniWorld: no switch then
            box.hidden = true;
        });
    }

    // ------------------------------------------------------------------
    // Queue view
    // ------------------------------------------------------------------
    var STATUS_LABELS = {
        queued: 'Waiting',
        running: 'Downloading',
        completed: 'Done',
        failed: 'Failed',
        cancelled: 'Cancelled'
    };

    function renderQueue(inner, info) {
        var view = renderedHash;
        inner.innerHTML =
            '<div class="aniworld-titlebar"><h1 class="sectionTitle">Queue</h1>' +
            '<button type="button" class="raised emby-button aniworld-back">Search</button></div>' +
            '<div class="aniworld-status">Loading…</div>' +
            '<div class="aniworld-queue paperList"></div>';
        setTitle('AniWorld queue');
        inner.querySelector('.aniworld-back').addEventListener('click', function () {
            routeTo({});
        });

        var status = inner.querySelector('.aniworld-status');
        var list = inner.querySelector('.aniworld-queue');

        function poll() {
            if (isStale(view, inner)) {
                return;
            }

            api('GET', 'Queue?limit=30').then(function (queue) {
                if (isStale(view, inner)) {
                    return;
                }

                draw(queue);
            }, function (err) {
                status.textContent = 'Could not load the queue: ' + err.message;
            }).then(function () {
                // Fast while something downloads, slow otherwise
                var busy = list.querySelector('[data-status="running"],[data-status="queued"]');
                window.setTimeout(poll, busy ? 2000 : 10000);
            });
        }

        function draw(queue) {
            var items = queue.items || [];
            var ffmpeg = queue.ffmpeg_progress || {};
            status.textContent = items.length ? '' : 'Nothing in the queue.';
            list.innerHTML = items.map(function (item) {
                var label = STATUS_LABELS[item.status] || item.status;
                var parts = [label];
                if (item.total_episodes) {
                    parts.push(item.status === 'running'
                        ? 'episode ' + Math.max(1, item.current_episode) + ' of ' + item.total_episodes
                        : item.total_episodes + (item.total_episodes === 1 ? ' episode' : ' episodes'));
                }
                parts.push(item.language);
                if (item.provider) {
                    parts.push(item.provider);
                }

                var progress = '';
                if (item.status === 'running') {
                    var percent = ffmpeg.active ? Number(ffmpeg.percent) || 0 : 0;
                    var done = item.total_episodes ? (Math.max(0, item.current_episode - 1) + percent / 100) / item.total_episodes : 0;
                    progress = '<div class="aniworld-progress"><span style="width:' + Math.round(done * 100) + '%"></span></div>';
                    if (ffmpeg.active && ffmpeg.speed) {
                        parts.push(Math.round(percent) + '% at ' + ffmpeg.speed);
                    }
                }

                var buttons = '';
                // AniWorld sets captcha_url while its browser waits for someone to solve one
                if (info.canDownload && item.status === 'running' && item.captcha_url) {
                    parts.push('waiting for a captcha');
                    buttons += '<button type="button" class="raised button-submit emby-button aniworld-captcha-open" data-id="' + item.id + '">' +
                        'Solve captcha</button>';
                }

                if (info.canDownload && (item.status === 'queued' || item.status === 'running')) {
                    buttons += '<button type="button" class="raised emby-button aniworld-cancel" data-id="' + item.id + '">Cancel</button>';
                }

                return '<div class="aniworld-queue-item" data-status="' + escapeHtml(item.status) + '">' +
                    '<div class="aniworld-queue-text">' +
                    '<div class="aniworld-queue-title">' + escapeHtml(item.title) + '</div>' +
                    '<div class="aniworld-queue-sub">' + escapeHtml(parts.join(' · ')) + '</div>' +
                    progress + '</div>' +
                    (buttons ? '<div class="aniworld-queue-buttons">' + buttons + '</div>' : '') + '</div>';
            }).join('');

            list.querySelectorAll('.aniworld-captcha-open').forEach(function (button) {
                button.addEventListener('click', function () {
                    var id = Number(button.getAttribute('data-id'));
                    var item = items.filter(function (i) { return i.id === id; })[0];
                    openCaptcha(id, item ? item.title : '');
                });
            });

            list.querySelectorAll('.aniworld-cancel').forEach(function (button) {
                button.addEventListener('click', function () {
                    button.disabled = true;
                    api('POST', 'Queue/' + button.getAttribute('data-id') + '/Cancel').then(function () {
                        toast('Cancelled');
                    }, function (err) {
                        button.disabled = false;
                        toast('Cancel failed: ' + err.message);
                    });
                });
            });
        }

        // The captcha viewer: a fresh screenshot every second, and clicks sent
        // to AniWorld's browser at the same spot on its page
        var captchaViewer = null;

        function openCaptcha(id, title) {
            closeCaptcha();
            var viewer = el('<div class="aniworld-captcha" role="dialog" aria-modal="true" aria-label="Solve captcha">' +
                '<div class="aniworld-captcha-bar"><div class="aniworld-captcha-title"></div>' +
                '<button type="button" class="raised emby-button aniworld-captcha-close">Close</button></div>' +
                '<img alt="The captcha, as AniWorld Downloader\'s browser shows it">' +
                '<div class="aniworld-captcha-hint">Loading the captcha…</div></div>');
            viewer.querySelector('.aniworld-captcha-title').textContent = title ? 'Captcha for ' + title : 'Captcha';
            inner.appendChild(viewer);
            captchaViewer = viewer;
            document.addEventListener('keydown', closeOnEscape);

            var img = viewer.querySelector('img');
            var hint = viewer.querySelector('.aniworld-captcha-hint');
            var objectUrl = null;
            viewer.querySelector('.aniworld-captcha-close').addEventListener('click', closeCaptcha);
            viewer.querySelector('.aniworld-captcha-close').focus();

            img.addEventListener('click', function (e) {
                if (!img.naturalWidth) {
                    return;
                }

                // The picture is shrunk to fit; AniWorld wants its own pixels
                var rect = img.getBoundingClientRect();
                api('POST', 'Queue/' + id + '/Captcha/Click', {
                    X: Math.round((e.clientX - rect.left) * img.naturalWidth / rect.width),
                    Y: Math.round((e.clientY - rect.top) * img.naturalHeight / rect.height)
                }).catch(function (err) {
                    toast('Click failed: ' + err.message);
                });
            });

            function tick() {
                if (captchaViewer !== viewer || isStale(view, inner)) {
                    if (objectUrl) {
                        URL.revokeObjectURL(objectUrl);
                    }

                    if (captchaViewer === viewer) {
                        closeCaptcha();
                    }

                    return;
                }

                Promise.all([api('GET', 'Queue/' + id + '/Captcha'), captchaScreenshot(id)]).then(function (replies) {
                    if (captchaViewer !== viewer) {
                        return;
                    }

                    var state = replies[0];
                    if (!state.active || state.done) {
                        closeCaptcha();
                        toast('The captcha is closed. The download goes on, or the queue shows why not.');
                        return;
                    }

                    // A 404 between two frames keeps the last picture
                    if (replies[1]) {
                        var next = URL.createObjectURL(replies[1]);
                        img.src = next;
                        if (objectUrl) {
                            URL.revokeObjectURL(objectUrl);
                        }

                        objectUrl = next;
                    }

                    hint.textContent = 'Tap or click where you would on the page. It updates every second.';
                }, function (err) {
                    hint.textContent = 'Could not load the captcha: ' + err.message;
                }).then(function () {
                    window.setTimeout(tick, 1000);
                });
            }

            tick();
        }

        function closeCaptcha() {
            document.removeEventListener('keydown', closeOnEscape);
            if (captchaViewer) {
                captchaViewer.remove();
                captchaViewer = null;
            }
        }

        function closeOnEscape(e) {
            if (e.key === 'Escape') {
                closeCaptcha();
            }
        }

        poll();
    }

    // An <img> can't send the Jellyfin login, so the picture comes as a blob
    function captchaScreenshot(id) {
        var client = window.ApiClient;
        return fetch(client.getUrl('AniWorldDownloader/Queue/' + id + '/Captcha/Screenshot'), {
            headers: { 'Authorization': 'MediaBrowser Token="' + client.accessToken() + '"' },
            cache: 'no-store'
        }).then(function (response) {
            return response.ok ? response.blob() : null;
        });
    }

    function seasonLabel(season) {
        if (season.are_movies) {
            return 'Movies';
        }

        return 'Season ' + season.season_number;
    }

    // tickMissing: opened from Jellyfin's series page, so the episodes not in
    // the library yet start ticked
    function DetailState(inner, seriesUrl, seasons, info, tickMissing) {
        this.tickMissing = tickMissing;
        this.inner = inner;
        this.seriesUrl = seriesUrl;
        this.seasons = seasons;
        this.info = info;
        this.season = seasons[0];
        this.episodes = [];
        this.providers = null;
        this.languageSelect = null;
        this.providerSelect = null;
    }

    DetailState.prototype.start = function () {
        var self = this;
        var pickers = this.inner.querySelector('.aniworld-pickers');
        var seasonPicker = this.seasons.length > 1
            ? '<div class="selectContainer"><label class="selectLabel">Season</label>' +
            '<select class="emby-select-withcolor emby-select aniworld-season">' +
            this.seasons.map(function (s, i) {
                return '<option value="' + i + '">' + escapeHtml(seasonLabel(s)) + ' (' + s.episode_count + ')</option>';
            }).join('') +
            '</select></div>'
            : '';

        pickers.innerHTML = seasonPicker +
            '<div class="selectContainer"><label class="selectLabel">Language</label>' +
            '<select class="emby-select-withcolor emby-select aniworld-language"></select></div>' +
            '<div class="selectContainer"><label class="selectLabel">Hoster</label>' +
            '<select class="emby-select-withcolor emby-select aniworld-provider"></select></div>';

        this.languageSelect = pickers.querySelector('.aniworld-language');
        this.providerSelect = pickers.querySelector('.aniworld-provider');
        this.languageSelect.addEventListener('change', function () {
            self.fillProviders();
        });

        var seasonSelect = pickers.querySelector('.aniworld-season');
        if (seasonSelect) {
            seasonSelect.addEventListener('change', function () {
                self.season = self.seasons[Number(seasonSelect.value)];
                self.loadSeason();
            });
        }

        this.renderActions();
        this.loadSeason();
    };

    DetailState.prototype.loadSeason = function () {
        var self = this;
        var season = this.season;
        var status = this.inner.querySelector('.aniworld-status');
        var list = this.inner.querySelector('.aniworld-episodes');
        status.textContent = 'Loading episodes…';
        list.innerHTML = '';
        this.episodes = [];
        this.updateActions();

        cached('episodes|' + season.url, function () {
            return api('GET', 'Episodes?url=' + encodeURIComponent(season.url) +
                '&seriesUrl=' + encodeURIComponent(self.seriesUrl));
        }).then(function (reply) {
            if (season !== self.season || !list.isConnected) {
                return;
            }

            self.episodes = reply.episodes || [];
            status.textContent = self.episodes.length ? '' : 'No episodes in this season.';
            if (self.tickMissing && self.episodes.length) {
                var missing = self.episodes.filter(function (ep) { return !ep.downloaded; }).length;
                status.textContent = missing
                    ? 'Ticked the ' + missing + (missing === 1 ? ' episode' : ' episodes') + ' of this season you don’t have yet.'
                    : 'You already have every episode of this season.';
            }
            self.renderEpisodes();
            self.loadProviders();
        }, function (err) {
            if (season === self.season) {
                status.textContent = 'Could not load the episodes: ' + err.message;
            }
        });
    };

    DetailState.prototype.renderEpisodes = function () {
        var self = this;
        var list = this.inner.querySelector('.aniworld-episodes');
        var single = this.episodes.length === 1;
        var site = siteName(siteFromUrl(this.seriesUrl));
        list.innerHTML = this.episodes.map(function (ep, i) {
            var name = ep.title_de || ep.title_en || '';
            var heading = self.season.are_movies
                ? name || 'Movie'
                : 'Episode ' + ep.episode_number + (name ? ' · ' + name : '');
            var badges = (ep.available_languages || []).map(function (lang) {
                return '<span class="aniworld-badge">' + escapeHtml(LANGUAGE_SHORT[lang] || lang) + '</span>';
            }).join('');
            if (ep.downloaded) {
                badges += '<span class="aniworld-badge">✓ In library</span>';
            }

            var href = externalHref(ep.url);
            // A link inside a label opens the link and leaves the checkbox alone
            var link = href
                ? '<a class="aniworld-episode-link" href="' + escapeHtml(href) +
                '" target="_blank" rel="noopener noreferrer" title="Open on ' + escapeHtml(site) +
                '" aria-label="' + escapeHtml(heading + ': open on ' + site) + '">' + EXTERNAL_ICON + '</a>'
                : '';

            return '<label class="aniworld-episode listItem">' +
                '<input type="checkbox" data-index="' + i + '"' +
                ((self.tickMissing ? !ep.downloaded : single) ? ' checked' : '') + '>' +
                '<div class="aniworld-episode-text">' +
                '<div class="aniworld-episode-title">' + escapeHtml(heading) + '</div>' +
                '<div>' + badges + '</div>' +
                '</div>' + link + '</label>';
        }).join('');

        list.querySelectorAll('input').forEach(function (box) {
            box.addEventListener('change', function () {
                self.updateActions();
            });
        });
        this.updateActions();
    };

    // The hosters per language come from the first episode, like in
    // AniWorld's own UI; the episodes' own language lists fill in otherwise.
    DetailState.prototype.loadProviders = function () {
        var self = this;
        var season = this.season;
        this.providers = null;
        this.fillLanguages();
        var first = this.episodes[0];
        if (!first) {
            return;
        }

        cached('providers|' + first.url, function () {
            return api('GET', 'Providers?url=' + encodeURIComponent(first.url));
        }).then(function (reply) {
            if (season !== self.season) {
                return;
            }

            var providers = reply.providers || {};
            self.providers = Object.keys(providers).length ? providers : null;
            self.fillLanguages();
        }, function () { /* keep the episode languages */ });
    };

    DetailState.prototype.fillLanguages = function () {
        var offered = [];
        if (this.providers) {
            offered = Object.keys(this.providers);
        } else {
            this.episodes.forEach(function (ep) {
                (ep.available_languages || []).forEach(function (lang) {
                    if (offered.indexOf(lang) < 0) {
                        offered.push(lang);
                    }
                });
            });
        }

        var previous = this.languageSelect.value;
        this.languageSelect.innerHTML = offered.map(function (lang) {
            return '<option value="' + escapeHtml(lang) + '">' + escapeHtml(lang) + '</option>';
        }).join('');

        var wanted = [previous, this.info.defaultLanguage];
        for (var i = 0; i < wanted.length; i++) {
            if (wanted[i] && offered.indexOf(wanted[i]) >= 0) {
                this.languageSelect.value = wanted[i];
                break;
            }
        }

        this.fillProviders();
    };

    DetailState.prototype.fillProviders = function () {
        var hosters = (this.providers && this.providers[this.languageSelect.value]) || [];
        var previous = this.providerSelect.value;
        this.providerSelect.innerHTML = hosters.map(function (name) {
            return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
        }).join('');

        var wanted = [previous, this.info.defaultProvider];
        for (var i = 0; i < wanted.length; i++) {
            if (wanted[i] && hosters.indexOf(wanted[i]) >= 0) {
                this.providerSelect.value = wanted[i];
                break;
            }
        }

        // No probe answer: AniWorld picks a working hoster itself
        this.providerSelect.closest('.selectContainer').style.display = hosters.length ? '' : 'none';
        this.updateActions();
    };

    DetailState.prototype.renderActions = function () {
        var self = this;
        var actions = this.inner.querySelector('.aniworld-actions');
        if (!this.info.canDownload) {
            actions.innerHTML = '<div class="aniworld-status">You can browse here, but an admin has to allow you to download.</div>';
            return;
        }

        actions.innerHTML =
            '<button type="button" class="raised emby-button aniworld-select-all">Select all</button>' +
            '<button type="button" class="raised button-submit emby-button aniworld-download" disabled>Download</button>';
        actions.querySelector('.aniworld-select-all').addEventListener('click', function () {
            var boxes = self.boxes();
            var all = boxes.every(function (b) { return b.checked; });
            boxes.forEach(function (b) { b.checked = !all; });
            self.updateActions();
        });
        actions.querySelector('.aniworld-download').addEventListener('click', function () {
            self.download(this);
        });
    };

    DetailState.prototype.boxes = function () {
        return Array.prototype.slice.call(this.inner.querySelectorAll('.aniworld-episodes input[type=checkbox]'));
    };

    DetailState.prototype.selected = function () {
        var self = this;
        return this.boxes().filter(function (b) { return b.checked; }).map(function (b) {
            return self.episodes[Number(b.getAttribute('data-index'))];
        });
    };

    DetailState.prototype.updateActions = function () {
        var button = this.inner.querySelector('.aniworld-download');
        var toggle = this.inner.querySelector('.aniworld-select-all');
        if (!button) {
            return;
        }

        var boxes = this.boxes();
        var count = this.selected().length;
        button.disabled = count === 0 || !this.languageSelect || !this.languageSelect.value;
        button.textContent = count ? 'Download ' + count + (count === 1 ? ' episode' : ' episodes') : 'Download';
        toggle.style.display = boxes.length > 1 ? '' : 'none';
        toggle.textContent = boxes.length && boxes.every(function (b) { return b.checked; }) ? 'Select none' : 'Select all';
    };

    DetailState.prototype.download = function (button) {
        var self = this;
        var episodes = this.selected();
        if (!episodes.length) {
            return;
        }

        var title = this.inner.querySelector('h1').textContent;
        button.disabled = true;
        api('POST', 'Download', {
            Episodes: episodes.map(function (ep) { return ep.url; }),
            Language: this.languageSelect.value,
            Provider: this.providerSelect.value,
            Title: title,
            SeriesUrl: this.seriesUrl
        }).then(function () {
            toast('Added ' + episodes.length + (episodes.length === 1 ? ' episode' : ' episodes') + ' of ' + title + ' to the queue');
            self.boxes().forEach(function (b) { b.checked = false; });
        }, function (err) {
            toast('Download failed: ' + err.message);
        }).then(function () {
            self.updateActions();
        });
    };

    // ------------------------------------------------------------------
    // Button on Jellyfin's own series page
    // ------------------------------------------------------------------
    // Item types by ID, so a page that re-renders doesn't ask again
    var itemTypes = {};

    function detailsItemId() {
        var hash = window.location.hash;
        var query = hash.indexOf('?');
        if (query < 0 || hash.slice(0, query) !== '#/details') {
            return null;
        }

        return new URLSearchParams(hash.slice(query + 1)).get('id');
    }

    function addSeriesButton() {
        var id = detailsItemId();
        if (!id || !window.ApiClient) {
            return;
        }

        // Jellyfin keeps earlier pages in the DOM; the one on screen counts
        var boxes = document.querySelectorAll('.mainDetailButtons');
        var box = null;
        for (var i = 0; i < boxes.length; i++) {
            if (boxes[i].offsetParent !== null) {
                box = boxes[i];
            }
        }

        if (!box || box.querySelector('[' + MARK + ']')) {
            return;
        }

        if (!(id in itemTypes)) {
            itemTypes[id] = null;
            window.ApiClient.getItem(window.ApiClient.getCurrentUserId(), id).then(function (item) {
                itemTypes[id] = item.Type;
                update();
            }, function () {
                itemTypes[id] = '';
            });
            return;
        }

        if (itemTypes[id] !== 'Series') {
            return;
        }

        getInfo().then(function (info) {
            if (!info.configured || box.querySelector('[' + MARK + ']')) {
                return;
            }

            var button = el(
                '<button type="button" is="emby-button" class="button-flat detailButton emby-button" ' +
                'title="Download missing episodes from AniWorld">' +
                '<div class="detailButton-content"><span class="material-icons detailButton-icon get_app" aria-hidden="true"></span></div>' +
                '</button>');
            button.setAttribute(MARK, '');
            button.addEventListener('click', function () {
                button.disabled = true;
                toast('Looking it up on AniWorld…');
                api('GET', 'FindSource?itemId=' + encodeURIComponent(id)).then(function (found) {
                    if (found.url) {
                        routeTo({ u: found.url, missing: '1' });
                    } else {
                        // No sure match: let the user pick from the search
                        toast('Not sure which one it is, pick it from the search');
                        routeTo({ q: found.query });
                    }
                }, function (err) {
                    toast('AniWorld: ' + err.message);
                }).then(function () {
                    button.disabled = false;
                });
            });
            // Before the ⋮ menu, which Jellyfin keeps last
            var more = box.querySelector('.btnMoreCommands');
            box.insertBefore(button, more && more.parentNode === box ? more : null);
        }, function () { /* no plugin page reachable, no button */ });
    }

    // ------------------------------------------------------------------
    // Page
    // ------------------------------------------------------------------
    // The sticky download bar needs a solid background, or the episode list
    // shows through it. Take whatever the theme painted behind the page.
    function pageBackground(node) {
        for (; node && node.nodeType === 1; node = node.parentNode) {
            var color = window.getComputedStyle(node).backgroundColor;
            if (color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color)) {
                return color;
            }
        }

        return '';
    }

    function setTitle(title) {
        // Only when it differs: writing <title> would wake the observer again.
        if (document.title !== title) {
            document.title = title;
        }
    }

    function leavePage(searchPage, page) {
        if (page) {
            page.remove();
        }

        if (searchPage && searchPage.hasAttribute(MARK)) {
            searchPage.removeAttribute(MARK);
            searchPage.style.display = '';
        }

        if (previousTitle !== null) {
            document.title = previousTitle;
            previousTitle = null;
        }

        renderedHash = null;
    }

    // Shows our page next to jellyfin-web's search page and hides the search
    // page; on any other route, removes ours and shows the search page again.
    function renderPage() {
        var searchPage = document.getElementById('searchPage');
        var page = document.getElementById(PAGE_ID);
        var params = hashParams();

        if (!params) {
            if (page || renderedHash !== null) {
                leavePage(searchPage, page);
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

        var hash = window.location.hash;
        if (page && page.previousElementSibling === searchPage && renderedHash === hash) {
            return;
        }

        if (!page || page.previousElementSibling !== searchPage) {
            if (page) {
                page.remove();
            }

            addStyles();
            page = document.createElement('div');
            page.id = PAGE_ID;
            page.className = 'libraryPage noSecondaryNavPage';
            page.innerHTML = '<div class="aniworld-inner padded-left padded-right"></div>' +
                '<p class="fieldDescription padded-left padded-right aniworld-build"></p>';
            searchPage.after(page);
            var background = pageBackground(page) || pageBackground(document.querySelector('.backgroundContainer'));
            if (background) {
                page.style.setProperty('--aniworld-page-background', background);
            }

            // Tick boxes in the theme's accent, read off a Jellyfin button
            var probe = el('<button class="raised button-submit emby-button" style="position:absolute;visibility:hidden"></button>');
            page.appendChild(probe);
            var accent = window.getComputedStyle(probe).backgroundColor;
            probe.remove();
            if (accent && !/^rgba\(.*,\s*0\)$/.test(accent)) {
                page.style.setProperty('--aniworld-accent', accent);
            }
        }

        renderedHash = hash;
        window.scrollTo(0, 0);
        page.querySelector('.aniworld-build').textContent =
            'client.js: ' + (window.AniWorldDownloaderBuild || 'unknown');

        var inner = page.querySelector('.aniworld-inner');
        setTitle(LABEL);
        inner.innerHTML = '<div class="aniworld-status">Loading…</div>';
        getInfo().then(function (info) {
            if (renderedHash !== hash || !inner.isConnected) {
                return;
            }

            if (params.get('view') === 'queue') {
                renderQueue(inner, info);
            } else if (params.get('u')) {
                renderDetail(inner, params, info);
            } else {
                renderSearch(inner, params, info);
            }
        }, function (err) {
            inner.innerHTML = '<div class="aniworld-status"></div>';
            inner.firstChild.textContent = 'AniWorld Downloader is not reachable: ' + err.message;
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
            addSeriesButton();
        });
    }

    // React re-renders the bar and pages often, so keep checking.
    new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', update);
    update();
})();
