# UI overhaul

The plan for the bigger UI overhaul of the plugin page, started on
2026-10-24 on the `autosync-page` branch (after commit 4bf0cc6). Tick an
item when it works in `dev/preview.html` **and** on the server with SleekFin.

## Rules

- Jellyfin's own markup and classes only, written in their upgraded form.
  Our CSS does layout only: no colors, fonts, or shapes of our own.
- Nothing that looks generated: no pills, chips, stat tiles, gradients, or
  rows of icons.
- Works on phones (the Android app runs the web client).
- Light: lazy images, small image sizes, no CSS filters on large areas.
- Changes to Jellyfin's own pages (items 5 and 6) find their containers at
  runtime and do nothing when they're missing. SleekFin replaces some of
  them, so test with and without it.

## Decisions

Made on 2026-10-24:

- **Order:** 1, 4, 3, 2, 6, 5. The items that need only `client.js` come first.
- **Item 5:** new *titles* (new anime and new series) from the existing
  `Browse` lists, as a row on Jellyfin's home page. AniWorld Downloader's
  new-episodes scraper (`fetch_new_episodes`) is not used.
- **Item 3:** instant filters only (type, site, in library). Genre browsing
  goes on the start page instead of a genre filter on search results. No
  year or language filter.
- **Minimal, sized to the data** (2026-10-24, after testing 0.2.2.16 to
  0.2.2.18): don't recreate Jellyfin's item page. AniWorld has one small
  poster and short text per title, so backdrops, large thumbnails and hero
  banners end up as placeholders. Use compact layouts, and images only
  where real ones exist. This replaces the "How" of items 1 and 2.
- **Item 2:** the "Continue" row is for every user. It needs a read-only
  plugin endpoint that lists tracked series (title, URL, poster) through the
  Auto-Sync key. Confirm the endpoint's shape before building it.

## What the data allows

Checked in AniWorld Downloader's code and in real replies:

- `GET Series` has no backdrop, and `GET Episodes` has no thumbnails. Both
  come from Jellyfin only when the title is in the library.
- Search hits have no genre, year, or language. Getting them takes one
  `Series` lookup per hit, and each lookup makes AniWorld scrape a page.
- AniWorld has `/api/genres?site=` and `/api/genre?site=&slug=&page=` (30
  titles a page). The plugin doesn't proxy them yet.
- Queue items carry `source`: `manual`, or `autosync` for Auto-Sync jobs.
  They also carry `series_url`, `username`, and `errors` (a JSON string).
- `ffmpeg_progress` covers only the running job:
  - HLS: `speed` is a realtime factor ("12x") and `time` is the media
    position.
  - Direct download: `speed` is empty, `time` is "12.3/400.0 MB", and
    `bandwidth` is "5.1 MB/s".
- There is no history endpoint. A series' history is its queue items, and
  it goes back only as far as the queue still holds them.
- `AutoSync/Status` needs the Auto-Sync key, so only admins can call it
  today.
- SleekFin mounts its home banner into
  `#indexPage #homeTab.is-active .sections`. It draws its own episode list
  on the series page (`.sleekfin-details-episode-list`, with a season
  dropdown). Without SleekFin, the series page shows season cards, and the
  episode rows are on the season page.

## Items

### [x] 1. Title page like Jellyfin's item page

- **Why:** The title page is a poster next to plain episode rows.
- **Where:** `renderDetail`, `DetailState.renderEpisodes`, and `addStyles`
  in `Web/client.js`; `dev/capture.js` and `dev/preview.html` for the new
  Jellyfin calls.
- **How:**
  - Lay the page out like Jellyfin's item page: backdrop behind the title,
    poster on the left.
  - Backdrop: Jellyfin's `Backdrop` image at a capped width when the title
    has a `libraryItemId`. Otherwise, draw the 220px poster once onto a
    canvas about 40px wide and stretch that. The browser's smoothing blurs
    it with no CSS filter. The theme's page color dims it.
  - Episodes: Jellyfin's episode list with a thumbnail per row. The
    thumbnails come from one `Shows/{id}/Episodes` call, matched by season
    and episode number.
- **Can't do:** thumbnails for episodes that aren't in the library. Those
  rows get Jellyfin's default card background with the episode number.
  Titles whose season numbering differs between AniWorld and Jellyfin get
  the same fallback.
- **Done when:** A title in the library shows its backdrop and episode
  thumbnails, and a title outside it shows the dimmed poster, on desktop
  and at phone width, with SleekFin.

### [x] 4. More detail on Queue and Auto-Sync

- **Why:** The queue shows status and a progress bar only. The Auto-Sync
  page shows the last check only.
- **Where:** `renderQueue` and `renderAutoSync` in `Web/client.js`.
- **How:**
  - Running job: speed and time left for the current episode (from
    `time`, `percent`, and `speed` for HLS, or MB and `bandwidth` for
    direct downloads). For the whole job, an "about N minutes" estimate from
    the average time per finished episode.
  - Every job: Auto-Sync or manual, who queued it, error details for
    failed jobs, and **Show more** paging.
  - Auto-Sync: an opened series lists its recent queue jobs (date,
    episodes, result), grouped by `series_url` from a larger queue page.
- **Can't do:** speed or time left for anything but the running job.
  History older than the queue's oldest item.
- **Done when:** A running download shows speed and time left, and an
  opened Auto-Sync series shows its recent jobs.

### [x] 3. Search filters and a grid/list switch

- **Why:** Results can only be limited to titles in the library.
- **Where:** `renderSearch` and `makeCard` in `Web/client.js`.
- **How:** Filters for type, site, and in library, applied instantly in the
  page. A switch between the card grid and a list with small posters, kept
  in `localStorage`.
- **Done when:** The filters and the switch work without a new search, and
  the view is the same after a reload.

### [ ] 2. Start page

- **Why:** The start page is a stack of rows with nothing featured.
- **Where:** `renderBrowse` in `Web/client.js`; new `Genres`, `Genre`, and
  tracked-series endpoints in `Api/AniWorldProxyController.cs`, with tests.
- **How:**
  - One banner for a featured title from "Popular anime", with its
    description, year, and genres from `Series`. Background as on the title
    page. A single banner, no rotating carousel.
  - Genre rows for the first few genres, each loaded when it scrolls into
    view, plus a picker that opens one genre as a paged grid.
  - A "Continue" row with the tracked series, for every user (see
    Decisions).
- **Done when:** The start page shows the banner, the genre rows, and the
  tracked series, and loads no row until it is near the screen.

### [ ] 6. Missing episodes on Jellyfin's series page

- **Why:** The series page has a single button that opens the AniWorld page.
  You can't see what's missing without leaving it.
- **Where:** Next to `addSeriesButton` in `Web/client.js`.
- **How:**
  - `FindSource`, then `Episodes` for the season on screen only, cached for
    the session. An episode is missing when AniWorld has it and Jellyfin's
    episode list for that season doesn't.
  - Stock Jellyfin: rows for the missing episodes on the season page,
    styled like Jellyfin's own missing episodes, and a count on each season
    card.
  - SleekFin: the same rows in its episode list, refreshed when its season
    dropdown changes.
  - Each row has a download button that opens the title page with those
    episodes ticked.
  - Nothing is added when `FindSource` isn't sure of the match, or when
    the episode counts clearly don't line up.
- **Done when:** A series with missing episodes shows them in the season's
  list, with and without SleekFin, and a page without a match is unchanged.

### [ ] 5. "New on AniWorld" on Jellyfin's home page

- **Why:** You only see new titles when you open the plugin page.
- **Where:** A new function next to `addSeriesButton` in `Web/client.js`.
- **How:** One `verticalSection` row of new anime and new series from
  `Browse/new-animes` and `Browse/new-series`. It goes after the first
  section in `.sections`, is added again when the home page re-renders, and
  is skipped when the container is missing. One cached call per page load.
- **Done when:** The row shows on the home page with and without SleekFin,
  links to the plugin's title page, and doesn't break the home page when
  AniWorld Downloader is down.

## Log

- 2026-10-24: Plan and decisions written down. Starting with item 1.
- 2026-10-24: Item 1 works in the preview, desktop and phone. The title
  page uses Jellyfin's item page classes (`itemBackdrop`, `detailRibbon`,
  `detailImageContainer`, ...) and its season list rows (`listItem-largeImage`).
  On `/search` jellyfin-web already has their CSS loaded. Also:
  - Episodes in Jellyfin count as in the library even when AniWorld doesn't
    know them, which covers most of TODO 5.2.
  - AniWorld's language tags (`GerSub`, `EngSub`, `Ger`) are left out of
    the Genres line.
  - The preview now has jellyfin-web's inline `.hide-*` rules, `dir="ltr"`
    on `<body>`, `layout-mobile` in the phone frame, and answers
    `Shows/{id}/Episodes` from the fixtures (`capture.js` saves it).
  - Next: check on the server with SleekFin.
- 2026-10-24: Item 1 checked on the server with SleekFin (dev build
  0.2.2.16), at desktop width and in a 390px frame with `layout-mobile`.
  - SleekFin moves a bar from the header to the bottom of the screen on
    phones, and it covered the sticky download bar. `placeAboveBottomBars`
    now measures fixed header elements in the lower half of the screen and
    lifts the download bar above them. Tried in the 390px frame; ships in
    the next dev build.
  - An episode without an image gets Jellyfin's default card background,
    which SleekFin doesn't restyle (a bright blue box). Kept, since Jellyfin
    shows the same.
  - Next: item 4 (Queue and Auto-Sync).
- 2026-10-24: Item 4 works in the preview.
  - Queue: a running job shows its episode (S1:E5), percent, speed, time
    left in the episode, and from 30 s on an estimate for the whole job.
    Every job shows Auto-Sync or manual, when it was added or finished, and
    how long it took. Failed episodes open under the job, and **Show more**
    loads 30 more.
  - Fixed on the way: `current_episode` is the index of the episode being
    downloaded (0-based), so the old view showed the wrong episode number
    and too little progress.
  - "Who queued it" needed C#: `DownloadOwners.Find` (with a test), and
    `GetQueue` adds `requestedBy` for admins. The owners file forgets a job
    once it's done, so only waiting and running jobs have a name.
  - Auto-Sync: an opened series lists its last 5 jobs from `Queue?limit=200`,
    matched by `series_url`.
  - The preview's fake **Download** and sync runs now queue jobs that run,
    with ffmpeg-like progress, and the second episode fails.
  - Next: check on the server.
- 2026-10-24: Item-page look rejected on the server ("too little content,
  not enough images"). Reworked in the preview only, not yet committed:
  - Title page: a compact head (8em poster, 6em on phones, next to name,
    year · site, genres, buttons; overview cut to 3 lines). The tabs are
    back. No backdrop, and no episode thumbnails or overviews. Episodes
    are compact rows: box, "1. Title", languages · In your library. Jellyfin's
    episode list is still read, without images, for "In your library".
  - Queue: two lines per job, title and one line of details; a running job
    leads with progress and leaves out language and hoster.
  - Next: the user's verdict on the preview screenshots.
- 2026-10-24: The compact rework is in dev build 0.2.2.19. Before the
  remaining items, TODO 2.2 (queue actions) was built: retry, move, remove
  and clear, at most three buttons per row by state, and "Clear" asking
  once on the button itself. Works in the preview, including as a
  non-admin.
- 2026-10-24: The user checked 0.2.2.20 on the server: the compact title
  page, the queue and the queue actions look good. Items 1 (compact
  version) and 4 are done.
- 2026-10-25: Item 3 works in the preview (`search-filters` branch),
  desktop and phone.
  - Type and Site (`emby-select`) list only what the results have, and grow
    while sites are still answering. They and "Only titles in my library"
    hide cards in place, so a running search isn't restarted. They're kept
    in the hash (`ft`, `fs`, `lib`) with `replaceState`, so going back from
    a title brings them back.
  - The grid/list switch is one icon button at the end of the filter row,
    kept in `localStorage` (`aniworld-search-layout`, grid when storage is
    blocked). List rows are `listItem`s with a 4em portrait poster, the
    title, and "Site · In your library". Search results only; the start
    page keeps its rows.
  - Hits have no year, genre or language, so the list row isn't more
    detailed than a card, only denser. AniWorld and S.to hits still need
    one `Series` lookup each for their poster.
  - Next: check on the server with SleekFin.
- 2026-10-25: On the server (0.2.3.21) the switch was hard to find: it sat
  alone at the right end of the filter row, and only after a search. It
  now sits right after the checkbox and shows on the start page too. There,
  list mode shows each list's first 6 titles as rows, with a **Show all N**
  button for the rest (decided with the user; full lists would make the
  page 120 to 150 rows long).
- 2026-10-25: The user checked 0.2.3.24 on the server. Also fixed there:
  the start page's **Show all** button is `raised` like the queue's
  **Show more**, and list rows are `box-sizing:border-box`, since
  `listItem-button` is 100% wide and the padding pushed the row's border
  past the list. Item 3 is done and goes out in 0.2.4.0. Next: item 2.
- 2026-10-25: The user put item 2 back and chose items 6 and 5 next, in
  that order. Item 6 decisions: one **Download N episodes** button under the
  section instead of one per row, and the section goes after SleekFin's
  episode list, not into it (SleekFin renders that list with Preact).
- 2026-10-25: Item 6 works in the preview (`missing-episodes` branch) and,
  with the branch's client.js loaded by hand, on the server with SleekFin.
  - Season cards get "N more on AniWorld" from `Seasons`' `episode_count`
    minus Jellyfin's episodes, so a series page costs no `Episodes` call.
    SleekFin's season posters have no `.cardFooter`, so the line goes after
    the card's last `.cardText`.
  - Season page: a **Not in your library** section under the episode list
    (stock: after `#listChildrenCollapsible`; SleekFin: after
    `.sleekfin-details-episodes`, with `padded-left padded-right`). At most
    10 rows, then "And N more.", then a button that opens the title page
    with `s=<season>&missing=1`. The title page now opens at the season
    `s` names.
  - SleekFin has three layouts: its "season posters" setting (on on the
    user's server) shows season cards on the series page; with it off, the
    series page shows its episode list with a season dropdown, read from the
    dropdown's `select` or its trigger's label. The season page always shows
    its episode list. The dropdown case isn't tried on the server yet.
  - `FindSource` is kept in `localStorage` per series (a match 7 days, no
    match 1 day). Everything else is kept for the page load, failures too,
    so a downloader that is down isn't asked on every redraw.
  - Can't do: seasons Jellyfin doesn't have at all (Classroom of the Elite
    has seasons 3 and 4 of AniWorld's 4) get no card, so nothing points to
    them. The first `Episodes` call for a season takes AniWorld 10 to 15 s.
  - The preview has stock **Series page** and **Season page** views built
    from a library title in the fixtures, with its last episode taken out
    of Jellyfin's list. `capture.js` saves `Shows/{id}/Seasons` and
    `FindSource` for library titles.
  - Next: a dev build, and the user's check, also with season posters off.
