"""Add a release to the Jellyfin plugin repository manifest.

Jellyfin reads manifest.json to offer the plugin in its catalog: one package
with a list of versions, each pointing at a zip and its MD5. A version that is
already listed gets replaced, so re-running a release is safe.

With KEEP, only the newest KEEP versions stay listed, and the ones dropped
are printed one per line, so the dev builds' workflow can delete their
releases.

Usage: update_manifest.py MANIFEST VERSION SOURCE_URL CHECKSUM CHANGELOG [KEEP]
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# The same as build.yaml and Plugin.cs
PACKAGE = {
    "guid": "31b711c1-95e5-4481-b7cc-3e43b0476b6d",
    "name": "AniWorld Downloader",
    "overview": "Search for and download anime, series and movies through AniWorld Downloader",
    "description": (
        "Adds an AniWorld page to the Jellyfin web client and the official Android "
        "and iOS apps. It searches AniWorld Downloader, queues downloads into your "
        "libraries and can keep series up to date with Auto-Sync."
    ),
    "owner": "HaiNick",
    "category": "General",
}
TARGET_ABI = "12.2.0.0"


def main(manifest_path, version, source_url, checksum, changelog, keep=None):
    path = Path(manifest_path)
    packages = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []

    package = next((p for p in packages if p.get("guid") == PACKAGE["guid"]), None)
    if package is None:
        package = {**PACKAGE, "versions": []}
        packages.append(package)
    else:
        package.update(PACKAGE)

    entry = {
        "version": version,
        "changelog": changelog.strip() or f"Version {version}",
        "targetAbi": TARGET_ABI,
        "sourceUrl": source_url,
        "checksum": checksum.lower(),
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    versions = [v for v in package.get("versions", []) if v.get("version") != version]
    versions.append(entry)
    # Newest first, compared as numbers so 0.10.0.0 sorts above 0.9.0.0
    versions.sort(key=lambda v: tuple(int(p) for p in v["version"].split(".")), reverse=True)
    if keep is not None:
        for dropped in versions[int(keep):]:
            print(dropped["version"])
        versions = versions[: int(keep)]
    package["versions"] = versions

    path.write_text(json.dumps(packages, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) not in (6, 7):
        sys.exit(__doc__)
    main(*sys.argv[1:])
