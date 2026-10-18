# AniWorld Downloader for Jellyfin

A Jellyfin plugin for searching and downloading anime, series and movies
through [AniWorld Downloader](https://github.com/HaiNick/AniWorld-Downloader),
right from Jellyfin, including the official Jellyfin Android and iOS apps.

**Status:** milestone 3. The **AniWorld** entry (top bar, or ☰ on phones)
opens a search with the tabs All, Anime, Series and Movies. A title shows its
seasons and episodes with their languages; pick a language and hoster, tick
episodes and download. Tested in the web client and the official Android app.

Titles you already have get an **In library** badge and a link to the
Jellyfin item; only libraries the user can see count. aniworld and s.to
titles have a **Keep up to date with Auto-Sync** switch with a start point
and schedule (when Auto-Sync is on in AniWorld Downloader). **Queue** shows
the downloads with live progress, and users who may download can cancel.

## API

Everything is under `/AniWorldDownloader` and needs a Jellyfin login.

| Endpoint | Who | What |
|---|---|---|
| `GET Info` | anyone | Set up yet? May this user download? Default picks |
| `POST Search` `{Keyword, Type}` | anyone | All sites, aniworld first; Type: all, anime, series, movie. Hits already in the library carry `libraryItemId` |
| `GET Series?url=` | anyone | Title, poster, description, genres, and `libraryItemId` when in the library |
| `GET Seasons?url=` | anyone | Seasons |
| `GET Episodes?url=&seriesUrl=` | anyone | Episodes with languages |
| `GET Providers?url=` | anyone | Hosters per language |
| `GET Queue?limit=&offset=&status=` | anyone | The download queue |
| `POST Queue/{id}/Cancel` | may download | Cancel a queued or running download |
| `POST Download` `{Episodes, Language, Provider, Title, SeriesUrl}` | may download | Queue episodes |
| `GET/POST AutoSync/Tracked` | POST: may download | "Sync this with Auto-Sync" |
| `GET Image?url=&sig=` | no login | Posters, only links the plugin signed |
| `POST TestConnection` `{Url, ApiKey}` | admins | AniWorld's `/api/ping` |

Admins may always download; other users only when ticked in the settings.
The AniWorld URL and key never leave the Jellyfin server.

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

## Releasing

Tag a version; the changelog is the tag message:

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
