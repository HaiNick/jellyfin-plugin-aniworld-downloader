// AniWorld Downloader: adds an "AniWorld" entry next to Favorites in the
// jellyfin-web top bar (wide screens) and side menu (phones), and renders the
// plugin page at #/search?aniworld. Injected into index.html by the plugin.
//
// The page lives under /search because jellyfin-web only shows the side menu
// button on its own user routes; on an unknown route phones get the library
// list instead. The search page itself is hidden while ours is shown.
//
// Views, all in the hash so the back button works:
//   #/search?aniworld&q=frieren            search
//   #/search?aniworld&q=...&u=<url>        one title: seasons, episodes, download
//   #/search?aniworld&view=queue           the download queue
//   #/search?aniworld&view=autosync        what Auto-Sync follows (admins)
//
// The markup is jellyfin-web's own (cards, list items, tabs, buttons, inputs,
// see src/components and src/elements there), written in its upgraded form so
// it needs none of jellyfin-web's scripts. That way the page looks like the
// rest of Jellyfin and follows the theme, community themes included. The CSS
// below only does layout; colours, fonts and shapes come from the theme.
(function () {
    'use strict';

    var ROUTE = '#/search?aniworld';
    var LABEL = 'AniWorld';
    var MARK = 'data-aniworld-downloader';
    var PAGE_ID = 'aniworldDownloaderPage';
    var FAVORITES_HREF = '#/home?tab=1';

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

    // Search results come in sections by type, like Jellyfin's own search
    var RESULT_SECTIONS = [
        { type: 'anime', label: 'Anime' },
        { type: 'series', label: 'Series' },
        { type: 'movie', label: 'Movies' },
        { type: '', label: 'Other' }
    ];

    var LANGUAGES = ['German Dub', 'German Sub', 'English Dub', 'English Sub'];

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

    // Replies by key, so going back from a title doesn't search again.
    var cache = {};

    // GET Info, once per page load.
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

    function hashFor(values) {
        var params = new URLSearchParams();
        params.set('aniworld', '');
        Object.keys(values).forEach(function (key) {
            if (values[key]) {
                params.set(key, values[key]);
            }
        });

        // URLSearchParams writes "aniworld=", the nav link is plain "aniworld"
        return '#/search?' + params.toString().replace(/^aniworld=(&|$)/, 'aniworld$1');
    }

    function routeTo(values, replace) {
        var hash = hashFor(values);
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

    function plural(count, word) {
        return count + ' ' + word + (count === 1 ? '' : 's');
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

    // Short dates ("Oct 24, 2026, 3:42 PM"), and "in 3 hours" where it reads better
    var dateFormat = null;
    var relativeFormat = null;
    try {
        dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    } catch (e) { /* older browsers: toLocaleString */ }

    function formatTime(iso) {
        if (!iso) {
            return 'never';
        }

        var date = new Date(iso);
        return dateFormat ? dateFormat.format(date) : date.toLocaleString();
    }

    function relativeTime(iso) {
        if (!iso) {
            return 'never';
        }

        var seconds = (new Date(iso).getTime() - Date.now()) / 1000;
        if (!relativeFormat || Math.abs(seconds) > 6 * 86400) {
            return formatTime(iso);
        }

        var steps = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [Infinity, 'day', 86400]];
        for (var i = 0; i < steps.length; i++) {
            if (Math.abs(seconds) < steps[i][0]) {
                return relativeFormat.format(Math.round(seconds / steps[i][2]), steps[i][1]);
            }
        }

        return formatTime(iso);
    }

    // Jellyfin's own toast, see src/components/toast
    function toast(message) {
        var box = document.querySelector('.toastContainer');
        if (!box) {
            box = el('<div class="toastContainer"></div>');
            document.body.appendChild(box);
        }

        var item = el('<div class="toast" role="status"></div>');
        item.textContent = message;
        box.appendChild(item);
        window.setTimeout(function () {
            item.classList.add('toastVisible');
            window.setTimeout(function () {
                item.classList.add('toastHide');
                window.setTimeout(function () { item.remove(); }, 300);
            }, 3300);
        }, 30);
    }

    // ------------------------------------------------------------------
    // jellyfin-web's components, as its scripts would have left them
    // ------------------------------------------------------------------
    function materialIcon(name, extra) {
        return '<span class="material-icons ' + (extra ? extra + ' ' : '') + name + '" aria-hidden="true"></span>';
    }

    function iconButton(className, icon, title, attributes) {
        return '<button type="button" class="paper-icon-button-light listItemButton ' + className + '"' + (attributes || '') + ' title="' +
            escapeHtml(title) + '" aria-label="' + escapeHtml(title) + '">' + materialIcon(icon) + '</button>';
    }

    // emby-select
    function selectHtml(label, className, options, boxClass) {
        return '<div class="selectContainer' + (boxClass ? ' ' + boxClass : '') + '">' +
            '<label class="selectLabel">' + escapeHtml(label) + '</label>' +
            '<select class="emby-select emby-select-withcolor ' + className + '">' + (options || '') + '</select>' +
            '<div class="selectArrowContainer"><div style="visibility:hidden;display:none;">0</div>' +
            materialIcon('keyboard_arrow_down', 'selectArrow') + '</div></div>';
    }

    function optionsHtml(values, labels) {
        return values.map(function (value, i) {
            return '<option value="' + escapeHtml(value) + '">' + escapeHtml(labels ? labels[i] : value) + '</option>';
        }).join('');
    }

    // emby-input
    function inputHtml(label, className, attributes, boxClass) {
        return '<div class="inputContainer' + (boxClass ? ' ' + boxClass : '') + '">' +
            '<label class="inputLabel inputLabelUnfocused">' + escapeHtml(label) + '</label>' +
            '<input class="emby-input ' + className + '" ' + attributes + '></div>';
    }

    // emby-checkbox; the empty span is the label its CSS expects before the box
    function checkboxHtml(className, attributes, text) {
        return '<label class="emby-checkbox-label">' +
            '<input type="checkbox" class="emby-checkbox ' + className + '"' + (attributes || '') + '>' +
            '<span class="checkboxLabel">' + escapeHtml(text || '') + '</span>' +
            '<span class="checkboxOutline">' + materialIcon('check', 'checkboxIcon checkboxIcon-checked') +
            materialIcon('', 'checkboxIcon checkboxIcon-unchecked') + '</span></label>';
    }

    // cardBuilder's fallback colours for a card without an image
    function defaultBackground(text) {
        var sum = 0;
        for (var i = 0; i < text.length; i++) {
            sum += text.charCodeAt(i);
        }

        return 'defaultCardBackground defaultCardBackground' + ((sum % 5) + 1);
    }

    // A portrait card the way cardBuilder writes it, with the image as a link
    function cardHtml(options) {
        var title = options.title || '';
        var image = options.href
            ? '<a class="cardImageContainer coveredImage cardContent ' + defaultBackground(title) + '" href="' +
            escapeHtml(options.href) + '" aria-label="' + escapeHtml(title) + '">'
            : '<div class="cardImageContainer coveredImage cardContent ' + defaultBackground(title) + '">';
        return '<div class="card ' + (options.overflow ? 'overflowPortraitCard' : 'portraitCard') + ' card-hoverable">' +
            '<div class="cardBox' + (options.footer === false ? '' : ' cardBox-bottompadded') + '">' +
            '<div class="cardScalable"><div class="cardPadder cardPadder-portrait"></div>' + image +
            '<div class="cardText cardDefaultText"><bdi>' + escapeHtml(title) + '</bdi></div>' +
            (options.inLibrary
                ? '<div class="cardIndicators"><div class="playedIndicator indicator" title="In your library">' +
                materialIcon('check', 'indicatorIcon') + '</div></div>'
                : '') +
            (options.href ? '</a>' : '</div>') + '</div>' +
            (options.footer === false
                ? ''
                : '<div class="cardFooter"><div class="cardText cardTextCentered cardText-first"><bdi>' + escapeHtml(title) + '</bdi></div>' +
                '<div class="cardText cardTextCentered cardText-secondary"><bdi>' + escapeHtml(options.subtitle || '') + '</bdi></div></div>') +
            '</div></div>';
    }

    function addStyles() {
        if (document.getElementById('aniworldDownloaderStyles')) {
            return;
        }

        // Layout only. Everything visible (colours, fonts, borders, radii)
        // comes from jellyfin-web's classes, so themes restyle it too.
        var P = '#' + PAGE_ID;
        var style = document.createElement('style');
        style.id = 'aniworldDownloaderStyles';
        style.textContent = [
            P + ' .aniworld-inner{padding-top:.5em;padding-bottom:6em}',
            // emby-button sets its own display, which beats the hidden attribute
            P + ' [hidden]{display:none !important}',
            P + ' .aniworld-tabs{margin:0 0 1em;overflow-x:auto;white-space:nowrap;scrollbar-width:none}',
            // Links instead of buttons; the theme still colours the active one
            P + ' .aniworld-tabs .emby-tab-button{text-decoration:none}',
            P + ' .aniworld-search{max-width:40em}',
            P + ' .aniworld-search .inputContainer{flex:1;margin:0}',
            P + ' .aniworld-search .emby-button{margin:0 0 0 .5em;flex:none}',
            P + ' .aniworld-filter{margin:.75em 0}',
            P + ' .aniworld-status{margin:1em 0}',
            P + ' .aniworld-status:empty{display:none}',
            // Rows that scroll sideways, like the ones on Jellyfin's home page
            P + ' .aniworld-row{display:flex;flex-wrap:nowrap;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x proximity}',
            P + ' .aniworld-row > .card{flex:none;scroll-snap-align:start}',
            P + ' .cardImageContainer.aniworld-has-image > .cardDefaultText{display:none}',

            // Title page: poster beside the text, like Jellyfin's item page
            P + ' .aniworld-detail{display:grid;grid-template-columns:minmax(0,14em) minmax(0,1fr);grid-template-rows:auto 1fr;gap:0 2em;align-items:start}',
            // The poster spans the name and the overview; on a phone the
            // overview goes below both
            P + ' .aniworld-detail .card{width:100%;margin:0;grid-row:span 2}',
            P + ' .aniworld-detail-text{grid-column:2}',
            P + ' .aniworld-detail .itemName{white-space:normal;margin-top:0}',
            P + ' .aniworld-detail .mainDetailButtons{flex-wrap:wrap;margin:.5em 0}',
            // mediainfo's own spacing only loads with the player pages
            P + ' .aniworld-detail .mediaInfoItem{margin-right:1em}',
            P + ' .aniworld-detail .overview{max-width:50em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical}',
            P + ' .aniworld-detail .overview.aniworld-open{display:block}',
            P + ' .aniworld-pickers{display:flex;flex-wrap:wrap;gap:0 1em}',
            P + ' .aniworld-pickers .selectContainer{flex:1;min-width:10em;max-width:20em}',
            P + ' .aniworld-episode{cursor:pointer}',
            P + ' .aniworld-episode .emby-checkbox-label{flex:none;width:auto;margin:0 .25em 0 .75em}',
            // Kept above the episode list; the theme's page colour behind it
            P + ' .aniworld-actions{position:sticky;bottom:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:.5em 1em;' +
            'padding:.75em 0;background:var(--aniworld-page-background,#101010)}',
            P + ' .aniworld-actions .emby-button{margin:0}',
            P + ' .aniworld-actions-count{flex:1;min-width:10em}',

            // Auto-Sync fields
            P + ' .aniworld-sync-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(9em,1fr));gap:0 1em;max-width:44em;margin-top:1em}',
            P + ' .aniworld-sync-fields .inputContainer,' + P + ' .aniworld-sync-fields .selectContainer{margin-bottom:1em}',
            P + ' .aniworld-editor{padding:0 1em 1em}',
            P + ' .aniworld-editor .emby-button{margin:0 .5em 0 0}',
            P + ' .aniworld-list-poster{background-size:cover;background-position:center}',
            P + ' .aniworld-sync-item .listItemBodyText a{color:inherit;text-decoration:none}',
            P + ' .aniworld-section-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5em}',
            P + ' .aniworld-section-head .emby-button{margin:0}',
            P + ' .listItem .itemProgressBar{margin-top:.5em}',

            '@media (max-width:40em){' +
            P + ' .aniworld-detail{grid-template-columns:7.5em minmax(0,1fr);grid-template-rows:auto;gap:0 1em}' +
            P + ' .aniworld-detail .itemName{font-size:1.4em}' +
            P + ' .aniworld-detail .card{grid-row:auto}' +
            P + ' .aniworld-detail-text{grid-column:1 / -1}}'
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
    // Tabs: Jellyfin's library tabs, one per view
    // ------------------------------------------------------------------
    var VIEWS = [
        { id: 'search', label: 'Search', values: {} },
        { id: 'queue', label: 'Queue', values: { view: 'queue' } },
        { id: 'autosync', label: 'Auto-Sync', values: { view: 'autosync' }, admin: true }
    ];

    // Draws the tabs and returns the box the view goes in
    function renderShell(inner, info, active) {
        inner.innerHTML =
            '<nav class="aniworld-tabs emby-tabs" aria-label="AniWorld"><div class="emby-tabs-slider">' +
            VIEWS.filter(function (v) { return !v.admin || info.canManageSync; }).map(function (v) {
                return '<a class="emby-tab-button emby-button' + (v.id === active ? ' emby-tab-button-active" aria-current="page' : '') +
                    '" href="' + escapeHtml(hashFor(v.values)) + '"><div class="emby-button-foreground">' + v.label + '</div></a>';
            }).join('') +
            '</div></nav>' +
            '<div class="aniworld-view"></div>';
        return inner.querySelector('.aniworld-view');
    }

    function sectionHtml(title, className, content) {
        return '<div class="verticalSection' + (className ? ' ' + className : '') + '">' +
            '<h2 class="sectionTitle sectionTitle-cards">' + escapeHtml(title) + '</h2>' + content + '</div>';
    }

    // ------------------------------------------------------------------
    // Search view
    // ------------------------------------------------------------------
    function renderSearch(inner, params, info) {
        var keyword = params.get('q') || '';
        // Older links still carry a type; the server search honours it
        var type = params.get('t') || 'all';
        // Only titles already in a Jellyfin library, see LibraryMatcher
        var onlyLibrary = params.get('lib') === '1';

        var body = renderShell(inner, info, 'search');
        // The search box of Jellyfin's own search page
        body.innerHTML =
            '<form class="aniworld-search searchFields" role="search">' +
            '<div class="searchFieldsInner flex align-items-center">' +
            materialIcon('search', 'searchfields-icon') +
            '<div class="inputContainer flex-grow">' +
            '<input class="emby-input searchfields-txtSearch" type="search" name="q" autocomplete="off" enterkeyhint="search" ' +
            'placeholder="Anime, series or movie" aria-label="Search anime, series and movies" value="' + escapeHtml(keyword) + '">' +
            '</div>' +
            '<button type="submit" class="raised button-submit emby-button">Search</button>' +
            '</div></form>' +
            '<div class="aniworld-filter">' + checkboxHtml('aniworld-only-library', onlyLibrary ? ' checked' : '', 'Only titles in my library') + '</div>' +
            '<div class="aniworld-status"></div>' +
            '<div class="aniworld-results"></div>';

        var form = body.querySelector('form');
        var input = form.querySelector('input');
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            input.blur();
            var value = input.value.trim();
            if (value) {
                routeTo({ q: value, t: type === 'all' ? '' : type, lib: onlyLibrary ? '1' : '' });
            }
        });

        body.querySelector('.aniworld-only-library').addEventListener('change', function (e) {
            routeTo({ q: input.value.trim() || keyword, t: type === 'all' ? '' : type, lib: e.target.checked ? '1' : '' }, true);
        });

        var status = body.querySelector('.aniworld-status');
        if (!info.configured) {
            status.textContent = info.isAdmin
                ? 'Not set up yet. Add the AniWorld Downloader URL under Dashboard → Plugins → AniWorld Downloader.'
                : 'Not set up yet. Ask an admin to connect AniWorld Downloader.';
            return;
        }

        var results = body.querySelector('.aniworld-results');
        if (!keyword) {
            renderBrowse(inner, results, params, onlyLibrary);
            if (!('ontouchstart' in window)) {
                input.focus();
            }
            return;
        }

        var view = renderedHash;
        var total = 0;
        var shown = 0;

        // One section per type, made up front so they keep their order
        var sections = {};
        results.innerHTML = RESULT_SECTIONS.map(function (s) {
            return sectionHtml(s.label, 'aniworld-section-' + (s.type || 'other'), '<div class="itemsContainer vertical-wrap"></div>');
        }).join('');
        RESULT_SECTIONS.forEach(function (s) {
            var section = results.querySelector('.aniworld-section-' + (s.type || 'other'));
            section.hidden = true;
            sections[s.type] = section;
        });

        function show(found, pending) {
            total += found.length;
            found.forEach(function (item) {
                if (onlyLibrary && !item.libraryItemId) {
                    return;
                }

                shown++;
                var section = sections[item.type] || sections[''];
                section.hidden = false;
                section.querySelector('.itemsContainer').appendChild(makeCard(item, params, false));
            });

            var text;
            if (pending && pending.length) {
                text = 'Still searching ' + pending.map(siteName).join(', ') + '…';
            } else if (!total) {
                text = 'Nothing found for “' + keyword + '”.';
            } else if (onlyLibrary && !shown) {
                text = 'None of the ' + total + ' results for “' + keyword + '” are in your library.';
            } else {
                text = '';
            }
            status.textContent = text;
        }

        var key = 'search|' + type + '|' + keyword.toLowerCase();
        if (cache[key]) {
            // Back from a title: the finished search, at once
            cache[key].then(function (found) {
                if (!isStale(view, inner)) {
                    show(found, null);
                }
            });
            return;
        }

        status.textContent = 'Searching…';
        var collected = [];
        searchStream(keyword, type, function (event) {
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
    function searchStream(keyword, type, onEvent) {
        var client = window.ApiClient;
        if (!client || !window.fetch || !window.TextDecoder || !window.ReadableStream) {
            // No streaming here: one reply with everything
            return api('POST', 'Search', { Keyword: keyword, Type: type }).then(function (reply) {
                onEvent({ results: reply.results || [], pending: [] });
            });
        }

        return fetch(client.getUrl('AniWorldDownloader/SearchStream'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'MediaBrowser Token="' + client.accessToken() + '"'
            },
            body: JSON.stringify({ Keyword: keyword, Type: type })
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
        { id: 'new-animes', label: 'New anime' },
        { id: 'popular-animes', label: 'Popular anime' },
        { id: 'new-series', label: 'New series' },
        { id: 'popular-series', label: 'Popular series' },
        { id: 'popular-movies', label: 'Popular movies' }
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

    function renderBrowse(inner, results, params, onlyLibrary) {
        var view = renderedHash;
        BROWSE_LISTS.forEach(function (list) {
            var section = el(sectionHtml(list.label, '',
                '<div class="itemsContainer aniworld-row"><div class="aniworld-status">Loading…</div></div>'));
            results.appendChild(section);
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
                    }, params, true));
                });
            }, function () {
                section.remove();
            });
        });
    }

    // A real link, so it can be focused with a remote and opened in a new tab
    function makeCard(item, params, overflow) {
        var card = el(cardHtml({
            title: item.title,
            subtitle: siteName(item.site || ''),
            href: hashFor({ q: params.get('q'), t: params.get('t'), lib: params.get('lib'), u: item.url }),
            inLibrary: Boolean(item.libraryItemId),
            overflow: overflow
        }));

        var image = card.querySelector('.cardImageContainer');
        if (item.poster_url) {
            showPoster(image, item.poster_url);
        } else {
            // aniworld's search has no posters; fetch them as cards scroll in
            watchPoster(image, item.url);
        }

        return card;
    }

    // Swaps the default colour for the poster once it has loaded
    function showPoster(target, path) {
        var img = new Image();
        img.onload = function () {
            target.style.backgroundImage = 'url("' + img.src + '")';
            target.className = target.className.replace(/\s*defaultCardBackground\d?/g, '');
            target.classList.add('aniworld-has-image');
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

    function watchPoster(target, url) {
        target.setAttribute('data-series-url', url);
        if (posterObserver) {
            posterObserver.observe(target);
        }
    }

    function pumpPosters() {
        while (postersLoading < 3 && posterQueue.length) {
            var target = posterQueue.shift();
            if (!target.isConnected) {
                continue;
            }

            postersLoading++;
            (function (box) {
                var url = box.getAttribute('data-series-url');
                getSeries(url).then(function (series) {
                    if (series.poster_url && box.isConnected) {
                        showPoster(box, series.poster_url);
                    }
                }, function () { /* the default colour stays */ }).then(function () {
                    postersLoading--;
                    pumpPosters();
                });
            })(target);
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
    function detailButton(tag, attributes, icon, title) {
        return '<' + tag + ' class="button-flat detailButton emby-button" ' + attributes + ' title="' + escapeHtml(title) + '" aria-label="' +
            escapeHtml(title) + '"><div class="detailButton-content">' + materialIcon(icon, 'detailButton-icon') + '</div></' + tag + '>';
    }

    function renderDetail(inner, params, info) {
        var url = params.get('u');
        var body = renderShell(inner, info, 'search');
        body.innerHTML =
            '<div class="aniworld-detail">' +
            cardHtml({ title: '', footer: false }) +
            '<div class="aniworld-detail-head">' +
            '<div class="nameContainer"><h1 class="itemName infoText">…</h1></div>' +
            '<div class="itemMiscInfo itemMiscInfo-primary"></div>' +
            '<div class="mainDetailButtons"></div>' +
            '</div>' +
            '<div class="aniworld-detail-text detailSectionContent">' +
            '<p class="itemGenres"></p>' +
            '<p class="overview"></p>' +
            '<button type="button" class="button-link emby-button aniworld-more" hidden>Show more</button>' +
            '</div></div>' +
            '<div class="verticalSection aniworld-sync" hidden></div>' +
            '<div class="verticalSection">' +
            '<h2 class="sectionTitle sectionTitle-cards">Episodes</h2>' +
            '<div class="aniworld-pickers"></div>' +
            '<div class="aniworld-status">Loading…</div>' +
            '<div class="itemsContainer vertical-list paperList aniworld-episodes"></div>' +
            '</div>' +
            '<div class="aniworld-actions"></div>';

        var view = renderedHash;
        var status = body.querySelector('.aniworld-status');
        getSeries(url).then(function (series) {
            if (isStale(view, inner)) {
                return;
            }

            var title = series.title || 'Unknown';
            body.querySelector('.itemName').textContent = title;
            setTitle(title);
            body.querySelector('.itemMiscInfo').innerHTML = [series.release_year, siteName(siteFromUrl(url))]
                .filter(Boolean).map(function (part) {
                    return '<div class="mediaInfoItem">' + escapeHtml(part) + '</div>';
                }).join('');
            var genres = body.querySelector('.itemGenres');
            genres.textContent = (series.genres || []).length ? 'Genres: ' + series.genres.slice(0, 8).join(', ') : '';
            genres.hidden = !genres.textContent;

            var overview = body.querySelector('.overview');
            var more = body.querySelector('.aniworld-more');
            overview.textContent = series.description || '';
            // Only offer "Show more" when the four lines actually cut something off
            more.hidden = overview.scrollHeight <= overview.clientHeight + 2;
            more.addEventListener('click', function () {
                var open = overview.classList.toggle('aniworld-open');
                more.textContent = open ? 'Show less' : 'Show more';
            });

            var image = body.querySelector('.aniworld-detail .cardImageContainer');
            image.querySelector('bdi').textContent = title;
            if (series.poster_url) {
                showPoster(image, series.poster_url);
            }

            var buttons = [];
            if (series.libraryItemId) {
                var serverId = window.ApiClient.serverId ? window.ApiClient.serverId() : '';
                buttons.push(detailButton('a', 'href="#/details?id=' + encodeURIComponent(series.libraryItemId) +
                    (serverId ? '&amp;serverId=' + encodeURIComponent(serverId) : '') + '"', 'video_library', 'Open in your library'));
            }

            var siteHref = externalHref(url);
            if (siteHref) {
                buttons.push(detailButton('a', 'href="' + escapeHtml(siteHref) + '" target="_blank" rel="noopener noreferrer"',
                    'open_in_new', 'Open on ' + siteName(siteFromUrl(url))));
            }
            body.querySelector('.mainDetailButtons').innerHTML = buttons.join('');

            renderSync(inner, url, title, info, view);
        }, function (err) {
            if (isStale(view, inner)) {
                return;
            }

            body.querySelector('.itemName').textContent = 'Could not load this title';
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

    // Start point and schedule, shared by the detail page's switch and the
    // Auto-Sync view
    function syncFieldsHtml(extra) {
        return '<div class="aniworld-sync-fields">' + (extra || '') +
            inputHtml('From season', 'aniworld-sync-season', 'type="number" min="0" inputmode="numeric"') +
            inputHtml('From episode', 'aniworld-sync-episode', 'type="number" min="1" inputmode="numeric"') +
            selectHtml('Check', 'aniworld-sync-cadence', optionsHtml(['global', 'daily', 'weekly'],
                ['Auto-Sync schedule', 'Every day', 'Every week'])) +
            selectHtml('Day', 'aniworld-sync-weekday', optionsHtml(['0', '1', '2', '3', '4', '5', '6'], WEEKDAYS), 'aniworld-sync-weekday-box') +
            inputHtml('At', 'aniworld-sync-time', 'type="time"', 'aniworld-sync-time-box') +
            '</div>';
    }

    // Shows only the schedule fields that matter for the picked cadence
    function showCadenceFields(box) {
        var cadence = box.querySelector('.aniworld-sync-cadence').value;
        box.querySelector('.aniworld-sync-weekday-box').hidden = cadence !== 'weekly';
        box.querySelector('.aniworld-sync-time-box').hidden = cadence === 'global';
    }

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
                '<h2 class="sectionTitle sectionTitle-cards">Auto-Sync</h2>' +
                // A checkbox, not emby-toggle: the switch's CSS only loads on
                // pages that use one, so here it would be a bare checkbox
                '<div class="checkboxContainer checkboxContainer-withDescription">' +
                checkboxHtml('aniworld-sync-on', '', 'Keep up to date with Auto-Sync') +
                '<div class="fieldDescription checkboxFieldDescription aniworld-sync-note"></div></div>' +
                syncFieldsHtml();
            box.hidden = false;

            var on = box.querySelector('.aniworld-sync-on');
            var fields = box.querySelector('.aniworld-sync-fields');
            var season = box.querySelector('.aniworld-sync-season');
            var episode = box.querySelector('.aniworld-sync-episode');
            var cadence = box.querySelector('.aniworld-sync-cadence');
            var weekday = box.querySelector('.aniworld-sync-weekday');
            var time = box.querySelector('.aniworld-sync-time');
            var note = box.querySelector('.aniworld-sync-note');

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
                fields.hidden = !on.checked;
                showCadenceFields(box);
                var text = 'New episodes download by themselves, in the language picked for the episodes below.';
                if (on.checked && row) {
                    text = 'Syncs in ' + row.language + (row.schedule ? ', ' + row.schedule.charAt(0).toLowerCase() + row.schedule.slice(1) : '') +
                        (row.next_run ? '. Next check ' + relativeTime(row.next_run) + '.' : '.');
                } else if (on.checked) {
                    text = '';
                }
                note.textContent = text;
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
    var STATUS = {
        queued: { label: 'Waiting', icon: 'schedule' },
        running: { label: 'Downloading', icon: 'file_download' },
        completed: { label: 'Done', icon: 'check' },
        failed: { label: 'Failed', icon: 'error_outline' },
        cancelled: { label: 'Cancelled', icon: 'block' }
    };

    var QUEUE_GROUPS = [
        { title: 'Downloading', statuses: ['running'] },
        { title: 'Waiting', statuses: ['queued'] },
        { title: 'Finished', statuses: ['completed', 'failed', 'cancelled'] }
    ];

    function renderQueue(inner, info) {
        var view = renderedHash;
        var body = renderShell(inner, info, 'queue');
        body.innerHTML = '<div class="aniworld-status">Loading…</div><div class="aniworld-queue"></div>';
        setTitle('AniWorld queue');

        var status = body.querySelector('.aniworld-status');
        var list = body.querySelector('.aniworld-queue');

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

        // A list item like the ones on Jellyfin's dashboard
        function itemHtml(item, ffmpeg) {
            var known = STATUS[item.status] || { label: item.status, icon: 'help_outline' };
            var parts = [known.label];
            if (item.total_episodes) {
                parts.push(item.status === 'running'
                    ? 'episode ' + Math.max(1, item.current_episode) + ' of ' + item.total_episodes
                    : plural(item.total_episodes, 'episode'));
            }
            parts.push(item.language);
            if (item.provider) {
                parts.push(item.provider);
            }

            var progress = '';
            if (item.status === 'running') {
                var percent = ffmpeg.active ? Number(ffmpeg.percent) || 0 : 0;
                var done = item.total_episodes ? (Math.max(0, item.current_episode - 1) + percent / 100) / item.total_episodes : 0;
                progress = '<div class="itemProgressBar"><div class="itemProgressBarForeground" style="width:' + Math.round(done * 100) + '%;"></div></div>';
                if (ffmpeg.active && ffmpeg.speed) {
                    parts.push(Math.round(percent) + '% at ' + ffmpeg.speed);
                }
            }

            var cancel = info.canDownload && (item.status === 'queued' || item.status === 'running')
                ? iconButton('aniworld-cancel', 'close', 'Cancel', ' data-id="' + item.id + '"')
                : '';

            return '<div class="listItem listItem-border" data-status="' + escapeHtml(item.status) + '">' +
                materialIcon(known.icon, 'listItemIcon listItemIcon-transparent') +
                '<div class="listItemBody two-line">' +
                '<div class="listItemBodyText"><bdi>' + escapeHtml(item.title) + '</bdi></div>' +
                '<div class="listItemBodyText secondary">' + escapeHtml(parts.filter(Boolean).join(' · ')) + '</div>' +
                progress + '</div>' + cancel + '</div>';
        }

        function draw(queue) {
            var items = queue.items || [];
            var ffmpeg = queue.ffmpeg_progress || {};
            status.textContent = items.length ? '' : 'Nothing in the queue.';
            list.innerHTML = QUEUE_GROUPS.map(function (group) {
                var mine = items.filter(function (item) { return group.statuses.indexOf(item.status) >= 0; });
                return mine.length
                    ? sectionHtml(group.title, '', '<div class="paperList">' + mine.map(function (item) { return itemHtml(item, ffmpeg); }).join('') + '</div>')
                    : '';
            }).join('');

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

        poll();
    }

    // ------------------------------------------------------------------
    // Auto-Sync view
    // ------------------------------------------------------------------
    // The "status" of a series' last check, see sync_series in AniWorld's autosync.py
    var SYNC_RESULTS = {
        queued: 'Queued',
        'up-to-date': 'Up to date',
        skipped: 'Skipped',
        error: 'Failed'
    };

    function syncResult(result) {
        if (!result) {
            return 'Not checked yet';
        }

        var text = SYNC_RESULTS[result.status] || result.status;
        if (result.status === 'queued' && result.episodes) {
            text += ' ' + plural(result.episodes, 'episode');
        }

        return result.reason ? text + ': ' + result.reason : text;
    }

    function renderAutoSync(inner, info) {
        var view = renderedHash;
        var body = renderShell(inner, info, 'autosync');
        body.innerHTML = '<div class="aniworld-status">Loading…</div><div class="aniworld-sync-view"></div>';
        setTitle('AniWorld Auto-Sync');

        var status = body.querySelector('.aniworld-status');
        var content = body.querySelector('.aniworld-sync-view');
        if (!info.canManageSync) {
            status.textContent = info.isAdmin
                ? 'Add a key with full access under Dashboard → Plugins → AniWorld Downloader to manage Auto-Sync here.'
                : 'Only admins can manage Auto-Sync.';
            return;
        }

        // The series whose settings are open, so a refresh doesn't close them
        var editing = null;
        var running = false;
        // Each refresh bumps this, so only the newest one schedules the next
        var generation = 0;

        function refresh() {
            var mine = ++generation;
            api('GET', 'AutoSync/Status').then(function (state) {
                if (!isStale(view, inner) && mine === generation) {
                    draw(state);
                }
            }, function (err) {
                if (isStale(view, inner)) {
                    return;
                }

                // AniWorld answers a plain 404 page while Auto-Sync is off there
                status.textContent = /HTTP 404/.test(err.message)
                    ? 'Auto-Sync is off in AniWorld Downloader. Turn it on in its settings.'
                    : 'Could not load Auto-Sync: ' + err.message;
                content.innerHTML = '';
            }).then(function () {
                if (!isStale(view, inner) && mine === generation) {
                    // Fast while a run goes, slow otherwise
                    window.setTimeout(function () {
                        if (mine === generation && !isStale(view, inner)) {
                            refresh();
                        }
                    }, running ? 3000 : 30000);
                }
            });
        }

        function start(path, label) {
            return api('POST', path).then(function () {
                toast(label);
                refresh();
            }, function (err) {
                toast('Auto-Sync: ' + err.message);
            });
        }

        // Like a task on Jellyfin's Scheduled Tasks page
        function scheduleHtml(state) {
            var report = state.last_report;
            var last = running
                ? 'Running now…'
                : 'Last run ' + relativeTime(state.last_run) + (report ? ': ' + report.queued + ' of ' + report.checked + ' queued' : '');
            return '<div class="paperList"><div class="listItem listItem-border">' +
                materialIcon('schedule', 'listItemIcon listItemIcon-transparent') +
                '<div class="listItemBody two-line">' +
                '<div class="listItemBodyText">' + escapeHtml(state.schedule || 'No schedule') +
                (state.next_run ? ', next ' + escapeHtml(relativeTime(state.next_run)) : '') + '</div>' +
                '<div class="listItemBodyText secondary">' + escapeHtml(last) + '</div></div>' +
                iconButton('aniworld-sync-run', 'play_arrow', 'Check every series now') +
                '</div></div>';
        }

        function seriesHtml(row) {
            var name = row.title || row.series_url;
            var href = hashFor({ u: row.series_url });
            var open = row.id === editing;
            return '<div class="aniworld-sync-item" data-id="' + row.id + '">' +
                '<div class="listItem listItem-border">' +
                '<a class="listItemImage cardImageContainer aniworld-list-poster ' + defaultBackground(name) + '" href="' + escapeHtml(href) +
                '" tabindex="-1" aria-hidden="true"></a>' +
                '<div class="listItemBody two-line">' +
                '<div class="listItemBodyText"><a href="' + escapeHtml(href) + '"><bdi>' + escapeHtml(name) + '</bdi></a></div>' +
                '<div class="listItemBodyText secondary">' + escapeHtml([row.language, row.where, row.schedule].filter(Boolean).join(' · ')) + '</div>' +
                '<div class="listItemBodyText secondary">' + escapeHtml(syncResult(row.last_result) + ' · checked ' + relativeTime(row.last_checked) +
                    (row.next_run ? ' · next ' + relativeTime(row.next_run) : '')) + '</div>' +
                '</div>' +
                (running ? '' : iconButton('aniworld-sync-check', 'play_arrow', 'Check now')) +
                iconButton('aniworld-sync-edit', open ? 'expand_less' : 'edit', open ? 'Close' : 'Edit') +
                '</div>' +
                (open ? '<div class="aniworld-editor"></div>' : '') +
                '</div>';
        }

        // A refresh leaves the list alone while settings are open, or it would
        // throw away what is being typed; force redraws it anyway
        function draw(state, force) {
            var series = state.series || [];
            running = Boolean(state.running);
            status.textContent = '';

            if (editing !== null && !series.some(function (row) { return row.id === editing; })) {
                editing = null;
            }

            if (editing !== null && !force) {
                var schedule = content.querySelector('.aniworld-schedule');
                if (schedule) {
                    schedule.innerHTML = scheduleHtml(state);
                    bindRun();
                }
                return;
            }

            content.innerHTML =
                sectionHtml('Schedule', 'aniworld-schedule-section', '<div class="aniworld-schedule">' + scheduleHtml(state) + '</div>') +
                sectionHtml('Tracked series', '', series.length
                    ? '<div class="paperList">' + series.map(seriesHtml).join('') + '</div>'
                    : '<div class="fieldDescription">No series is tracked yet. Switch on "Keep up to date with Auto-Sync" on a title’s page.</div>');
            bindRun();

            series.forEach(function (row) {
                var item = content.querySelector('.aniworld-sync-item[data-id="' + row.id + '"]');
                // Same lookup as the search cards; cached, so a refresh doesn't ask again
                watchPoster(item.querySelector('.listItemImage'), row.series_url);
                var check = item.querySelector('.aniworld-sync-check');
                if (check) {
                    check.addEventListener('click', function () {
                        check.disabled = true;
                        start('AutoSync/Series/' + row.id + '/Run', 'Checking ' + (row.title || 'the series') + ' now');
                    });
                }
                item.querySelector('.aniworld-sync-edit').addEventListener('click', function () {
                    editing = editing === row.id ? null : row.id;
                    draw(state, true);
                });
                if (row.id === editing) {
                    renderSyncEditor(item.querySelector('.aniworld-editor'), row);
                }
            });
        }

        function bindRun() {
            var run = content.querySelector('.aniworld-sync-run');
            run.disabled = running;
            run.addEventListener('click', function () {
                run.disabled = true;
                start('AutoSync/Run', 'Auto-Sync checks every series now');
            });
        }

        function renderSyncEditor(box, row) {
            box.innerHTML =
                syncFieldsHtml(selectHtml('Language', 'aniworld-sync-language', optionsHtml(LANGUAGES))) +
                '<button type="button" class="raised button-submit emby-button aniworld-sync-save">Save</button>' +
                '<button type="button" class="raised emby-button aniworld-sync-remove">Stop syncing</button>';

            var language = box.querySelector('.aniworld-sync-language');
            var season = box.querySelector('.aniworld-sync-season');
            var episode = box.querySelector('.aniworld-sync-episode');
            var cadence = box.querySelector('.aniworld-sync-cadence');
            var weekday = box.querySelector('.aniworld-sync-weekday');
            var time = box.querySelector('.aniworld-sync-time');
            language.value = row.language;
            season.value = row.start_season;
            episode.value = row.start_episode;
            cadence.value = row.cadence;
            weekday.value = String(row.weekday);
            time.value = row.run_time;

            cadence.addEventListener('change', function () {
                showCadenceFields(box);
            });
            showCadenceFields(box);

            box.querySelector('.aniworld-sync-save').addEventListener('click', function (e) {
                var button = e.currentTarget;
                button.disabled = true;
                api('PUT', 'AutoSync/Series/' + row.id, {
                    language: language.value,
                    start_season: Number(season.value || 0),
                    start_episode: Number(episode.value || 1),
                    cadence: cadence.value,
                    weekday: Number(weekday.value),
                    run_time: time.value || '22:00'
                }).then(function () {
                    toast('Saved');
                    editing = null;
                    refresh();
                }, function (err) {
                    button.disabled = false;
                    toast('Auto-Sync: ' + err.message);
                });
            });

            box.querySelector('.aniworld-sync-remove').addEventListener('click', function (e) {
                var button = e.currentTarget;
                button.disabled = true;
                api('DELETE', 'AutoSync/Series/' + row.id).then(function () {
                    toast((row.title || 'The series') + ' is no longer synced');
                    editing = null;
                    refresh();
                }, function (err) {
                    button.disabled = false;
                    toast('Auto-Sync: ' + err.message);
                });
            });
        }

        refresh();
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
        pickers.innerHTML =
            (this.seasons.length > 1
                ? selectHtml('Season', 'aniworld-season', this.seasons.map(function (s, i) {
                    return '<option value="' + i + '">' + escapeHtml(seasonLabel(s)) + ' (' + s.episode_count + ')</option>';
                }).join(''))
                : '') +
            selectHtml('Language', 'aniworld-language', '') +
            selectHtml('Hoster', 'aniworld-provider', '', 'aniworld-provider-box');

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
                    ? 'Ticked the ' + plural(missing, 'episode') + ' of this season you don’t have yet.'
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

    // Episodes as Jellyfin lists them: "1. Title", with the languages below
    DetailState.prototype.renderEpisodes = function () {
        var self = this;
        var list = this.inner.querySelector('.aniworld-episodes');
        var single = this.episodes.length === 1;
        var site = siteName(siteFromUrl(this.seriesUrl));
        list.innerHTML = this.episodes.map(function (ep, i) {
            var name = ep.title_de || ep.title_en || '';
            var heading = self.season.are_movies
                ? name || 'Movie'
                : ep.episode_number + '. ' + (name || 'Episode ' + ep.episode_number);
            var details = (ep.available_languages || []).map(function (lang) {
                return LANGUAGE_SHORT[lang] || lang;
            });
            if (ep.downloaded) {
                details.push('In your library');
            }

            var href = externalHref(ep.url);
            var ticked = self.tickMissing ? !ep.downloaded : single;
            return '<div class="listItem listItem-border aniworld-episode" data-index="' + i + '">' +
                checkboxHtml('aniworld-pick', ' data-index="' + i + '" aria-label="' + escapeHtml(heading) + '"' + (ticked ? ' checked' : '')) +
                '<div class="listItemBody two-line">' +
                '<div class="listItemBodyText"><bdi>' + escapeHtml(heading) + '</bdi></div>' +
                '<div class="listItemBodyText secondary">' + escapeHtml(details.join(' · ')) + '</div>' +
                '</div>' +
                (ep.downloaded ? materialIcon('check', 'listItemAside') : '') +
                (href
                    ? '<a class="paper-icon-button-light listItemButton" href="' + escapeHtml(href) +
                    '" target="_blank" rel="noopener noreferrer" title="Open on ' + escapeHtml(site) +
                    '" aria-label="' + escapeHtml(heading + ': open on ' + site) + '">' + materialIcon('open_in_new') + '</a>'
                    : '') +
                '</div>';
        }).join('');

        // The whole row ticks the box, except the link out
        list.querySelectorAll('.aniworld-episode').forEach(function (row) {
            var box = row.querySelector('input');
            row.addEventListener('click', function (e) {
                if (!e.target.closest('a, label')) {
                    box.checked = !box.checked;
                    self.updateActions();
                }
            });
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
        this.languageSelect.innerHTML = optionsHtml(offered);

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
        this.providerSelect.innerHTML = optionsHtml(hosters);

        var wanted = [previous, this.info.defaultProvider];
        for (var i = 0; i < wanted.length; i++) {
            if (wanted[i] && hosters.indexOf(wanted[i]) >= 0) {
                this.providerSelect.value = wanted[i];
                break;
            }
        }

        // No probe answer: AniWorld picks a working hoster itself
        this.providerSelect.closest('.aniworld-provider-box').hidden = !hosters.length;
        this.updateActions();
    };

    DetailState.prototype.renderActions = function () {
        var self = this;
        var actions = this.inner.querySelector('.aniworld-actions');
        if (!this.info.canDownload) {
            actions.innerHTML = '<div class="fieldDescription aniworld-actions-count">You can browse here, but an admin has to allow you to download.</div>';
            return;
        }

        actions.innerHTML =
            '<div class="fieldDescription aniworld-actions-count"></div>' +
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
        return Array.prototype.slice.call(this.inner.querySelectorAll('.aniworld-episodes .aniworld-pick'));
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
        button.textContent = count ? 'Download ' + plural(count, 'episode') : 'Download';
        this.inner.querySelector('.aniworld-actions-count').textContent = count ? '' : 'Tick the episodes to download.';
        toggle.hidden = boxes.length < 2;
        toggle.textContent = boxes.length && boxes.every(function (b) { return b.checked; }) ? 'Select none' : 'Select all';
    };

    DetailState.prototype.download = function (button) {
        var self = this;
        var episodes = this.selected();
        if (!episodes.length) {
            return;
        }

        var title = this.inner.querySelector('.itemName').textContent;
        button.disabled = true;
        api('POST', 'Download', {
            Episodes: episodes.map(function (ep) { return ep.url; }),
            Language: this.languageSelect.value,
            Provider: this.providerSelect.value,
            Title: title,
            SeriesUrl: this.seriesUrl
        }).then(function () {
            toast('Added ' + plural(episodes.length, 'episode') + ' of ' + title + ' to the queue');
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
            } else if (params.get('view') === 'autosync') {
                renderAutoSync(inner, info);
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
