# AniWorld Downloader for Jellyfin

A Jellyfin plugin for searching and downloading anime, series and movies
through [AniWorld Downloader](https://github.com/HaiNick/AniWorld-Downloader),
right from Jellyfin, including the official Jellyfin Android and iOS apps.

**Status:** milestone 0 (spike). Right now the plugin only adds an **AniWorld**
entry next to Favorites and a hello-world page that shows the logged-in user.

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
dotnet publish Jellyfin.Plugin.AniWorldDownloader -c Release -o artifacts
```

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

## Install by hand

1. Copy `Jellyfin.Plugin.AniWorldDownloader.dll` into
   `<jellyfin config>/plugins/AniWorldDownloader_0.0.1.0/`.
2. Restart Jellyfin.
