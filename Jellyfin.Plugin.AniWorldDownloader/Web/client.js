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
            '#' + PAGE_ID + ' .aniworld-card{display:block;color:inherit;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent}',
            // Not Jellyfin's cardImageContainer: it forces background-clip to
            // the content box, which leaves a box like this one blank
            '#' + PAGE_ID + ' .aniworld-poster{position:relative;aspect-ratio:2/3;border-radius:.3em;overflow:hidden;' +
            'background-color:rgba(128,128,128,.2);background-size:cover;background-position:center}',
            '#' + PAGE_ID + ' .aniworld-poster-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:2em;opacity:.5}',
            '#' + PAGE_ID + ' .aniworld-card-title{margin-top:.4em;font-size:.95em;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
            '#' + PAGE_ID + ' .aniworld-badge{display:inline-block;padding:.1em .45em;margin:.3em .3em 0 0;border-radius:.25em;font-size:.75em;background:rgba(128,128,128,.25)}',
            '#' + PAGE_ID + ' .aniworld-badge-site{position:absolute;left:.4em;bottom:.4em;margin:0;background:rgba(0,0,0,.7);color:#fff}',
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

        inner.innerHTML =
            '<h1 class="sectionTitle">AniWorld</h1>' +
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
            '</div>' +
            '<div class="aniworld-status"></div>' +
            '<div class="aniworld-grid"></div>';

        var form = inner.querySelector('form');
        var input = form.querySelector('input');
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            input.blur();
            var value = input.value.trim();
            if (value) {
                routeTo({ q: value, t: tab });
            }
        });

        inner.querySelectorAll('[data-tab]').forEach(function (button) {
            button.addEventListener('click', function () {
                routeTo({ q: input.value.trim() || keyword, t: button.getAttribute('data-tab') }, true);
            });
        });

        var status = inner.querySelector('.aniworld-status');
        if (!info.configured) {
            status.textContent = info.isAdmin
                ? 'Not set up yet. Add the AniWorld Downloader URL under Dashboard → Plugins → AniWorld Downloader.'
                : 'Not set up yet. Ask an admin to connect AniWorld Downloader.';
            return;
        }

        if (!keyword) {
            status.textContent = 'Anime come from AniWorld, series from S.to, movies from every movie site.';
            if (!('ontouchstart' in window)) {
                input.focus();
            }
            return;
        }

        var view = renderedHash;
        status.textContent = 'Searching…';
        cached('search|' + tab + '|' + keyword.toLowerCase(), function () {
            return api('POST', 'Search', { Keyword: keyword, Type: tab });
        }).then(function (reply) {
            if (isStale(view, inner)) {
                return;
            }

            var results = reply.results || [];
            status.textContent = results.length ? '' : 'Nothing found for “' + keyword + '”.';
            renderResults(inner.querySelector('.aniworld-grid'), results, params);
        }, function (err) {
            status.textContent = 'Search failed: ' + err.message;
        });
    }

    function renderResults(grid, results, params) {
        grid.innerHTML = '';
        results.forEach(function (item) {
            var card = el(
                '<a class="aniworld-card" role="button">' +
                '<div class="aniworld-poster">' +
                '<div class="aniworld-poster-empty" aria-hidden="true">' + escapeHtml(item.title.charAt(0)) + '</div>' +
                '<span class="aniworld-badge aniworld-badge-site">' + escapeHtml(siteName(item.site)) + '</span>' +
                '</div>' +
                '<div class="aniworld-card-title">' + escapeHtml(item.title) + '</div>' +
                '</a>');
            card.addEventListener('click', function () {
                routeTo({ q: params.get('q'), t: params.get('t'), u: item.url });
            });
            grid.appendChild(card);

            var poster = card.querySelector('.aniworld-poster');
            if (item.poster_url) {
                showPoster(poster, item.poster_url);
            } else {
                // aniworld's search has no posters; fetch them as cards scroll in
                watchPoster(poster, item.url);
            }
        });
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
            '</div></div>' +
            '<p class="aniworld-description"></p>' +
            '<button type="button" class="aniworld-more" hidden>More</button>' +
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

            new DetailState(inner, url, seasons, info).start();
        }, function (err) {
            status.textContent = 'Could not load the seasons: ' + err.message;
        });
    }

    function seasonLabel(season) {
        if (season.are_movies) {
            return 'Movies';
        }

        return 'Season ' + season.season_number;
    }

    function DetailState(inner, seriesUrl, seasons, info) {
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

            return '<label class="aniworld-episode listItem">' +
                '<input type="checkbox" data-index="' + i + '"' + (single ? ' checked' : '') + '>' +
                '<div class="aniworld-episode-text">' +
                '<div class="aniworld-episode-title">' + escapeHtml(heading) + '</div>' +
                '<div>' + badges + '</div>' +
                '</div></label>';
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

            if (params.get('u')) {
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
        });
    }

    // React re-renders the bar and pages often, so keep checking.
    new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', update);
    update();
})();
