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
  side menu (phones), and renders the plugin page at `#/aniworld`.
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

## Install by hand

1. Copy `Jellyfin.Plugin.AniWorldDownloader.dll` into
   `<jellyfin config>/plugins/AniWorldDownloader_0.0.1.0/`.
2. Restart Jellyfin.
