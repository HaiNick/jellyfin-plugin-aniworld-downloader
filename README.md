# AniWorld Downloader for Jellyfin

A Jellyfin plugin for searching and downloading anime, series and movies
through [AniWorld Downloader](https://github.com/HaiNick/AniWorld-Downloader),
right from Jellyfin, including the official Jellyfin Android and iOS apps.

The **AniWorld** entry (top bar, or ☰ on phones) opens a search with the tabs
All, Anime, Series and Movies. Results arrive site by site as each site
answers, so one slow site doesn't hold up the rest. Before you search, the
page shows AniWorld's lists of new and popular anime, series and movies.

A title shows its seasons and episodes with their languages; pick a language
and hoster, tick episodes and download. When it's done, whoever started it
gets a message in their open Jellyfin apps, and the dashboard's Activity log
has an entry. This works across a Jellyfin restart: the plugin keeps who
queued what in `owners.json` next to its settings. Tested in the web client
and the official Android app.

- **In library:** titles you already have get a badge and a link to the
  Jellyfin item; only libraries the user can see count. A switch next to the
  tabs shows only those.
- **Missing episodes:** Jellyfin's own series page gets a download button
  that opens the series on AniWorld with the episodes you don't have ticked.
- **Auto-Sync:** aniworld and s.to titles have a **Keep up to date with
  Auto-Sync** switch with a start point and schedule (when Auto-Sync is on in
  AniWorld Downloader).
- **Auto-Sync page:** with a second key with full access in the settings,
  admins get an **Auto-Sync** button next to **Queue**. It lists every
  tracked series with its schedule, last check and result, and lets admins
  change a series' language, start point and schedule, check one series or
  all of them now, or stop syncing a series.
- **Queue:** the downloads with live progress; users who may download can
  cancel.
- **Library scan:** a finished download shows up in Jellyfin within about a
  minute. A series already in the library gets only its own folder scanned;
  anything new starts a full library scan. A run of downloads ends in one
  scan, at most 10 minutes after the first one finished. Turn it off in the
  settings with **Scan the library after a download**.
- **Outages:** when AniWorld Downloader stops answering, or rejects the API
  key, the Activity log gets one "unavailable" entry, and one "available
  again" entry when it is back.

## API

Everything is under `/AniWorldDownloader` and needs a Jellyfin login.

| Endpoint | Who | What |
|---|---|---|
| `GET Info` | anyone | Set up yet? May this user download? Default picks |
| `POST Search` `{Keyword, Type}` | anyone | All sites, aniworld first; Type: all, anime, series, movie. Hits already in the library carry `libraryItemId` |
| `POST SearchStream` `{Keyword, Type}` | anyone | The same, one JSON line per site as it answers: `{site, results, pending}`, then `{"done": true}` |
| `GET Browse/{list}` | anyone | new-animes, popular-animes, new-series, popular-series or popular-movies |
| `GET FindSource?itemId=` | anyone | The AniWorld page of a library series: `{url, title, site}`, or `{query}` to search for |
| `GET Series?url=` | anyone | Title, poster, description, genres, and `libraryItemId` when in the library |
| `GET Seasons?url=` | anyone | Seasons |
| `GET Episodes?url=&seriesUrl=` | anyone | Episodes with languages |
| `GET Providers?url=` | anyone | Hosters per language |
| `GET Queue?limit=&offset=&status=` | anyone | The download queue |
| `POST Queue/{id}/Cancel` | may download | Cancel a queued or running download |
| `POST Download` `{Episodes, Language, Provider, Title, SeriesUrl}` | may download | Queue episodes |
| `GET/POST AutoSync/Tracked` | POST: may download | "Sync this with Auto-Sync" |
| `GET AutoSync/Status` | admins, Auto-Sync key | Schedule, last run and every tracked series |
| `POST AutoSync/Run` | admins, Auto-Sync key | Check every tracked series now |
| `PUT AutoSync/Series/{id}` | admins, Auto-Sync key | Change a series' language, start point or schedule |
| `DELETE AutoSync/Series/{id}` | admins, Auto-Sync key | Stop syncing a series |
| `POST AutoSync/Series/{id}/Run` | admins, Auto-Sync key | Check one series now |
| `GET Image?url=&sig=` | no login | Posters, only links the plugin signed |
| `POST TestConnection` `{Url, ApiKey, AdminApiKey}` | admins | AniWorld's `/api/ping`, with the Auto-Sync key's ping under `admin` |

Admins may always download; other users only when ticked in the settings.
The AniWorld URL and keys never leave the Jellyfin server. The Auto-Sync key
is used only for the Auto-Sync endpoints above, and only for Jellyfin admins.

## How it works

- `ScriptInjectionMiddleware` adds `<script src="../AniWorldDownloader/client.js">`
  to jellyfin-web's `index.html` as it is served. Nothing on disk is changed,
  so Jellyfin image updates don't undo it.
- `client.js` adds the **AniWorld** entry to the top bar (wide screens) and the
  side menu (phones), and renders the plugin page at `#/search?aniworld`. It
  lives under `/search` because jellyfin-web only shows the ☰ side-menu button
  on its own user routes; the search page is hidden while the plugin page shows.
- `GET /AniWorldDownloader/whoami` requires a logged-in Jellyfin user and
  returns the user's name and whether they are an admin.

## Requirements

- Jellyfin 12.2 (`targetAbi` 12.2.0.0)
- .NET 10 SDK to build

## Build

```sh
dotnet test Jellyfin.Plugin.AniWorldDownloader.Tests
dotnet publish Jellyfin.Plugin.AniWorldDownloader -c Release -o artifacts
```

Run the tests before every install. Jellyfin builds all plugin controllers
at startup, and one bad attribute stops the whole server from starting; the
tests build them the same way and fail first.

Without a local SDK:

```sh
docker run --rm -v "$PWD":/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 \
  dotnet publish Jellyfin.Plugin.AniWorldDownloader -c Release -o /src/artifacts
```

## Working on the UI without Jellyfin

`dev/preview.html` runs `Web/client.js` straight from the repo, with no
build and no Jellyfin login, and answers its calls with saved replies:

1. Open the AniWorld page in Jellyfin as an admin, paste `dev/capture.js`
   into the browser console, and move the downloaded `fixtures.js` into
   `dev/`. Git ignores it, since it holds your own server's data.
2. Serve the repo root, for example `python -m http.server 8765`, and open
   `http://localhost:8765/dev/preview.html`.
3. Change `client.js` and reload. The toolbar switches between the views and
   has a 390px phone frame and an admin switch.

Posters and Jellyfin's own styles still come from the server that made the
fixtures. Saves, downloads and sync runs change only the page's copy of the
data; nothing reaches AniWorld Downloader. When a Jellyfin update renames its
stylesheets, copy the new names from the real page into `preview.html`.

## Changing the UI without restarting Jellyfin

The plugin serves `client.js` from
`<jellyfin config>/plugins/configurations/AniWorldDownloader/client.js` when
that file exists, and its built-in copy otherwise. Copy a new version there,
then reload the web client (on Android: close the app and open it again).

The plugin page shows which script is running, for example
`client.js: built-in 0.0.1.0` or `client.js: override 2026-10-18 17:12:44 UTC`.
Delete the override when you're done, or it keeps winning over newer
built-in versions.

## Install

1. In Jellyfin, open **Dashboard → Plugins → Repositories** (the gear or
   "Manage Repositories") and add:

   ```
   https://raw.githubusercontent.com/HaiNick/jellyfin-plugin-aniworld-downloader/main/manifest.json
   ```

2. Install **AniWorld Downloader** from the catalog and restart Jellyfin.
3. Open the plugin's settings and enter the AniWorld Downloader URL (and an
   API key with "Read and download" access if its login is on).

Updates then show up in the catalog like any other plugin.

## Development builds

Every push to a branch other than `main` builds a development version and
lists it in a second plugin repository. To get them, add this URL in
**Dashboard → Plugins → Repositories** as well, next to the stable one:

```
https://raw.githubusercontent.com/HaiNick/jellyfin-plugin-aniworld-downloader/dev-manifest/manifest.json
```

- A dev build has the newest release's version with the build number as the
  last part, for example `0.2.1.57` on top of `0.2.1.0`. Jellyfin offers it as
  an update, and the next release (`0.2.2.0`) is newer than it again.
- Its changelog names the branch and commit, and lists the commits that
  aren't on `main` yet. Builds from different branches share one list, so the
  newest push wins; pick an older version on the plugin's page to go back.
- Only the newest 10 builds stay listed. The
  [Dev build workflow](.github/workflows/dev-build.yml) deletes the
  pre-release and tag of older ones.
- Pushes that change only Markdown files don't build. Run the workflow by
  hand under **Actions → Dev build** to build anyway.

To leave the dev channel, remove the repository, then install the newest
release from the catalog once it is newer than your dev build.

## Releasing

Raise the version in `build.yaml` and in the `.csproj` (`Version`,
`AssemblyVersion` and `FileVersion`), then merge that into `main`. The Auto
tag workflow sees a version without a tag, tags it with the commits since the
last release as the changelog, and starts the Release workflow.

To write the changelog yourself, tag by hand instead; the tag message is the
changelog, and Auto tag then leaves that version alone:

```sh
git tag -a v0.2.0.0 -m "What changed"
git push origin v0.2.0.0
```

The Release workflow runs the tests, builds the DLL, publishes
`aniworld-downloader_<version>.zip` as a GitHub release and adds it with its
MD5 checksum to `manifest.json`.

## Install by hand

1. Copy `Jellyfin.Plugin.AniWorldDownloader.dll` into
   `<jellyfin config>/plugins/AniWorld Downloader_<version>/`.
2. Restart Jellyfin.

## License

GPL-3.0, like the Jellyfin plugin template it is built from. See [LICENSE](LICENSE).
