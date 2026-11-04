"""Write a download table, grouped by platform, at the top of a release's notes.

GitHub lists release assets alphabetically and cannot group them, so the
release notes carry the table instead. Update files (.sig, latest.json,
.app.tar.gz) stay attached for the auto-updater but are left out of it.

Usage: python release_downloads.py <tag>   (needs the gh CLI, logged in)

The table goes between two markers, so running it again replaces it and keeps
any notes written by hand below.
"""

import json
import re
import subprocess
import sys

START = "<!-- downloads -->"
END = "<!-- /downloads -->"

# (platform, file kind, test on the asset name), in the order shown.
KINDS = [
    ("Windows", "Installer (recommended)", lambda n: n.endswith("-setup.exe")),
    ("Windows", "MSI package", lambda n: n.endswith(".msi")),
    ("macOS", "Apple Silicon (M1 and later)", lambda n: n.endswith(".dmg") and "aarch64" in n),
    ("macOS", "Intel", lambda n: n.endswith(".dmg") and ("x64" in n or "x86_64" in n)),
    ("Linux", "AppImage (any distribution)", lambda n: n.endswith(".AppImage")),
    ("Linux", "Debian / Ubuntu (.deb)", lambda n: n.endswith(".deb")),
    ("Linux", "Fedora / RHEL (.rpm)", lambda n: n.endswith(".rpm")),
    ("Android", "Tablet, 64-bit ARM (.apk)", lambda n: n.endswith(".apk")),
]


def size(n_bytes: int) -> str:
    return f"{n_bytes / 1_000_000:.0f} MB"


def table(assets: list[dict]) -> str:
    rows = []
    for platform, kind, matches in KINDS:
        for a in sorted(assets, key=lambda a: a["name"]):
            if matches(a["name"]):
                rows.append(
                    f"| {platform} | {kind} | [{a['name']}]({a['url']}) | {size(a['size'])} |"
                )
    if not rows:
        return ""
    return "\n".join(
        [
            START,
            "## Downloads",
            "",
            "| Platform | Package | File | Size |",
            "| --- | --- | --- | --- |",
            *rows,
            "",
            "The other files are used by the automatic updater.",
            END,
        ]
    )


def main() -> None:
    tag = sys.argv[1]
    release = json.loads(
        subprocess.check_output(["gh", "release", "view", tag, "--json", "assets,body"])
    )
    block = table(release["assets"])
    if not block:
        print("No installers found: notes left as they are.")
        return

    body = release["body"] or ""
    old = re.compile(re.escape(START) + ".*?" + re.escape(END), re.DOTALL)
    if old.search(body):
        body = old.sub(lambda _: block, body)
    else:
        body = block + ("\n\n" + body if body.strip() else "")

    subprocess.run(["gh", "release", "edit", tag, "--notes-file", "-"], input=body, text=True, check=True)
    print(block)


if __name__ == "__main__":
    main()
