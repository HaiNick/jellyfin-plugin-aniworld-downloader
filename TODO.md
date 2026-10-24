# To-do

Ideas for the plugin, written down on 2026-10-22 against v0.2.1.0. All of
them are plugin-side work: where an item needs a downloader endpoint, that
endpoint already exists in AniWorld Downloader and needs no change there.

Each item has:

- **Why:** what is missing today and who notices.
- **Where:** the code it touches.
- **How:** a suggested approach.
- **Done when:** how you can tell it works.
- **Size:** S (an evening), M (a weekend), or L (several sessions).

Start with the first section: those items are small, need no UI, and fix
things users already run into.

## 1. Quick wins

### [x] 1.1 Scan the library when a download finishes

- **Why:** New episodes and the **In library** badge only show up after
  Jellyfin's own scheduled library scan runs, which can be hours later.
- **Where:** `AniWorld/DownloadWatcher.cs`, in `CheckAsync` where a finished
  download calls `NotifyAsync` (around line 144).
- **How:** After a `completed` status, queue a scan through
  `ILibraryManager`. The downloader's queue items don't say which folder a
  download went to, so the plugin can't scan just that folder. If
  `LibraryMatcher` finds the series in the library, refresh that item's
  folder; otherwise run `ValidateMediaLibrary`. Debounce it, so 12 episodes that finish within a minute cause
  one scan, not 12. Add a setting **Scan the library after a download**
  (on by default) to `PluginConfiguration` and `configPage.html`.
- **Done when:** A finished download appears in Jellyfin within about a
  minute without a manual scan, and several downloads in a row trigger one
  scan.
- **Size:** S

### [x] 1.2 Keep download owners across restarts

- **Why:** `DownloadOwners` lives in memory only. After a Jellyfin restart,
  the "done" message for a running download goes to all admins instead of
  the user who started it.
- **Where:** `AniWorld/DownloadWatcher.cs`, class `DownloadOwners`
  (line 20). Written from `Api/AniWorldProxyController.cs` in `Download`
  (line 426).
- **How:** Save the queue-ID-to-user map as a small JSON file under
  `IApplicationPaths.PluginConfigurationsPath/AniWorldDownloader/`. Load it
  on startup, write it on `Add` and `Take`, and drop entries older than,
  for example, 7 days so the file doesn't grow forever.
- **Done when:** You start a download, restart Jellyfin, and the "done"
  message still reaches the user who started it.
- **Size:** S

### [x] 1.3 Make downloader outages visible

- **Why:** When AniWorld Downloader is down, `AniWorldClient` logs a
  warning with a stack trace on every queue check (once a minute), while an
  error reply such as a rejected API key logs nothing. Neither reaches the
  Activity log, so nobody finds out from the dashboard.
- **Where:** `AniWorld/DownloadWatcher.cs`, `ExecuteAsync`.
- **How:** Track the state in `ConnectionState`. After two failed checks in
  a row, log one `Warning` and write an Activity log entry ("AniWorld
  Downloader is unavailable"). On the first success after that, log and
  record that it's back. The watcher's own requests log their failures at
  `Debug`.
- **Done when:** Stopping the downloader produces exactly one warning and
  one Activity log entry, and starting it again produces one "back online"
  entry.
- **Size:** S

### [x] 1.4 Log who started a download

- **Why:** The Activity log only has an entry when a download finishes or
  fails. An admin can't see who queued what, or when.
- **Where:** `Api/AniWorldProxyController.cs`, `Download` (around line 397).
- **How:** After the downloader returns a `queue_id`, write an Activity log
  entry with the user, title, episode count, language, and hoster. Inject
  `IActivityManager` into the controller.
- **Done when:** Every download from Jellyfin has a "started" and a
  "finished" or "failed" entry in **Dashboard > Activity**.
- **Size:** S

## 2. Queue and downloads

### [-] 2.1 Show and solve captchas in the queue

- **Dropped** on 2026-10-23: built and tried in dev builds 0.2.2.6 to 0.2.2.9.
  Kinox's verification wall didn't go through the captcha browser, the same
  titles are on other sites, and the viewer wasn't worth keeping for the rest.
- **Why:** Some hosters ask for a captcha. The downloader can show it, but
  `client.js` never asks, so in Jellyfin the download just looks stuck.
- **Where:** New proxy endpoints in `Api/AniWorldProxyController.cs`; the
  queue view in `Web/client.js` (`renderQueue`, line 947).
- **How:** Proxy the downloader's `GET captcha/{id}/status`,
  `GET captcha/{id}/screenshot`, and `POST captcha/{id}/click` (`{x, y}`).
  Limit them to users who may download. In the queue view, poll the status
  for running items; when a captcha is active, show the screenshot and send
  clicks with coordinates scaled to the image's real size.
- **Done when:** A download that needs a captcha shows it in the Jellyfin
  queue, and solving it there lets the download continue, also on a phone.
- **Size:** M

### [ ] 2.2 More queue actions

- **Why:** The queue view can only cancel. Removing, reordering, retrying,
  and clearing finished items needs the downloader's own web UI.
- **Where:** `Api/AniWorldProxyController.cs`, next to `CancelQueueItem`
  (line 378); `renderQueue` in `Web/client.js`.
- **How:** Proxy these downloader endpoints, all allowed for a write key:

  | Action | Downloader endpoint |
  |---|---|
  | Retry a failed item | `POST queue/{id}/retry` |
  | Remove an item | `DELETE queue/{id}` |
  | Move an item up or down | `POST queue/{id}/move` |
  | Clear finished items | `DELETE queue/completed` |

  Only users who may download get the buttons. Decide whether non-admins
  may act only on their own downloads (needs 1.2) or on everyone's.
- **Done when:** Each action works from the Jellyfin queue view and the
  view refreshes afterwards.
- **Size:** M

### [-] 2.3 Active-download count in the nav entry

- **Dropped** on 2026-10-23: tried in dev build 0.2.2.4. The badge looked
  out of place and didn't add anything, so it was removed again.
- **Why:** You can't see from anywhere else in Jellyfin that something is
  downloading.
- **Where:** `addNavEntry` in `Web/client.js` (line 315); a new proxy
  endpoint.
- **How:** Proxy `GET queue/counts` and show the number of queued plus
  running items as a small badge on the **AniWorld** entry. Poll slowly
  (30 to 60 seconds) and only while the tab is visible.
- **Done when:** The badge shows the right number and disappears when the
  queue is empty.
- **Size:** S

### [ ] 2.4 Pick the target folder

- **Why:** Everything goes to the downloader's default folder. With
  separate Jellyfin libraries for anime, series, and movies, files can land
  in the wrong one.
- **Where:** `DownloadRequest` and `Download` in
  `Api/AniWorldProxyController.cs`; the download dialog in `Web/client.js`.
- **How:** Proxy `GET custom-paths` and pass `custom_path_id` in the
  download body (the downloader already accepts it). Optionally let admins
  map each Jellyfin library to a downloader path in the settings, so the
  right one is preselected.
- **Done when:** A download can go to a chosen folder, and the default
  follows the mapping.
- **Size:** M

## 3. Permissions and settings

### [ ] 3.1 Download limits for non-admins

- **Why:** A user who may download can queue a 1,000-episode series in one
  click. There is no limit today.
- **Where:** `DenyDownloadAsync` and `Download` in
  `Api/AniWorldProxyController.cs`; `PluginConfiguration`.
- **How:** Add a setting such as **Episodes per user per day** (0 means no
  limit). Count episodes per user over a rolling 24 hours, stored with the
  owners file from 1.2. Return a clear 429 message the UI can show. Admins
  have no limit.
- **Done when:** A non-admin over the limit gets a readable error and
  nothing is queued.
- **Size:** M

### [ ] 3.2 Per-user default language and hoster

- **Why:** `DefaultLanguage` and `DefaultProvider` apply to everyone. One
  user may want German Dub, another German Sub.
- **Where:** `PluginConfiguration`; `Info` and `Download` in
  `Api/AniWorldProxyController.cs`; the download dialog in `Web/client.js`.
- **How:** Remember the last language and hoster each user picked (in
  `localStorage` for a client-only version, or server-side per user ID so it
  follows them across devices). Fall back to the global defaults.
- **Done when:** A user's choice is preselected the next time, also on
  another device if stored server-side.
- **Size:** S (client-only) or M (server-side)

## 4. Discovery

### [ ] 4.1 Browse by genre

- **Why:** The start page shows only the "new" and "popular" lists.
- **Where:** New proxy endpoints; `renderBrowse` in `Web/client.js`
  (line 575).
- **How:** Proxy `GET genres?site=` and `GET genre?site=&slug=&page=`. Show
  genres as chips above the lists and open a paged grid for one genre.
  Reuse the poster signing and **In library** badge from search results.
- **Done when:** You can open a genre and page through its titles.
- **Size:** M

### [ ] 4.2 Random title

- **Why:** A low-effort way to find something new.
- **Where:** A new proxy endpoint; a button on the search page.
- **How:** Proxy `GET random?site=` and open the detail page for the
  returned `url`. The downloader has no random title for s.to, so hide the
  button for it.
- **Done when:** The button opens a different title each time.
- **Size:** S

### [x] 4.3 Auto-Sync overview

- **Why:** You can switch Auto-Sync on per title, but there is no list of
  what it follows and when it last ran.
- **Where:** New admin-only proxy endpoints; a new view in `Web/client.js`.
- **How:** Proxy `GET autosync/status`, `GET autosync/series`, and
  `POST autosync/run`. These need a downloader key with **full access**,
  not the read-and-download key the plugin asks for today, so add a second,
  optional "admin key" setting and show the view only when it is set.
- **Done when:** Admins see the tracked series with their last run and can
  start a run from Jellyfin.
- **Size:** M

## 5. Library matching

### [ ] 5.1 Manual title links

- **Why:** `LibraryMatcher` only compares normalized titles. A title whose
  name differs between AniWorld and Jellyfin (German versus romaji, or a
  season in the name) is never marked **In library**, and **Missing
  episodes** can't find it.
- **Where:** `Library/LibraryMatcher.cs`; `FindSource` in
  `Api/AniWorldProxyController.cs` (line 206); the detail page in
  `Web/client.js`.
- **How:** Store a map from AniWorld URL to Jellyfin item ID in the
  configuration. Check it before the title match. On the detail page, add a
  **Link to a library item** action, and on Jellyfin's series page a
  **Link to AniWorld** action.
- **Done when:** A linked title is marked in the library and the series
  page button opens the right AniWorld page.
- **Size:** M

### [ ] 5.2 Mark episodes from Jellyfin's own library

- **Why:** The episode list's `downloaded` flag comes from the downloader,
  so it misses episodes you got some other way, and **Missing episodes**
  ticks them again.
- **Where:** `Episodes` in `Api/AniWorldProxyController.cs`; the episode
  list in `Web/client.js` (around line 1116).
- **How:** When the series is in the library, look up its episodes
  through `ILibraryManager` and add an `inLibrary` flag by season and
  episode number. Treat an episode as present if either source says so.
- **Done when:** An episode that exists only in Jellyfin shows as present
  and isn't ticked by **Missing episodes**.
- **Size:** M

## 6. Quality

### [ ] 6.1 More tests

- **Why:** The tests cover `LibraryMatcher` and controller startup only.
- **Where:** `Jellyfin.Plugin.AniWorldDownloader.Tests/`.
- **How:** Add tests for:
  - `DownloadWatcher.CheckAsync`: the first poll only learns the state, a
    change to `completed` or `failed` notifies once, and an item that
    finishes between polls still notifies. Extract the state logic so it
    runs without Jellyfin's services.
  - Poster link signing: a valid `sig` is accepted, and a changed URL or
    `sig` is rejected.
  - The "may download" check: admin, an allowed user, a blocked user, and
    an API key without a user.
- **Done when:** `dotnet test` covers these cases and runs in the release
  workflow, as the existing tests do.
- **Size:** M

### [ ] 6.2 German UI

- **Why:** The default language is German Dub, so many users are likely
  German speakers, but the UI is English only.
- **Where:** All user-facing strings in `Web/client.js` and
  `Configuration/configPage.html`.
- **How:** Move the strings into a small table keyed by language and pick
  the language from jellyfin-web's current culture, falling back to
  English.
- **Done when:** With Jellyfin set to German, the plugin's pages and
  messages are in German.
- **Size:** M
