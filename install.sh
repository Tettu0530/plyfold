#!/bin/sh
# Install or update Plyfold from the newest GitHub release (macOS and Linux).
#   curl -fsSL https://raw.githubusercontent.com/Tettu0530/plyfold/main/install.sh | sh
#
# A file fetched by curl is not marked as downloaded from the internet, so macOS does not stop the unsigned app.
# The file is checked against the release's SHA256SUMS.txt when the release has one.
#
# Environment:
#   PLYFOLD_VERSION      a version to install (e.g. 0.3.0) instead of the newest release
#   PLYFOLD_INSTALL_DIR  macOS: where Plyfold.app goes (default /Applications, or ~/Applications if that is not writable)
#                        Linux: where the AppImage goes (default ~/.local/share/plyfold)
#   PLYFOLD_LINUX_FORMAT Linux: "deb" or "appimage" (default: deb when apt is available, otherwise appimage)
set -eu

REPO="Tettu0530/plyfold"
API="https://api.github.com/repos/$REPO/releases"

say() { printf '%s\n' "$*"; }
fail() {
	printf 'plyfold: %s\n' "$*" >&2
	exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

need curl
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The release's JSON: the newest one (pre-releases included), or the version asked for
if [ -n "${PLYFOLD_VERSION:-}" ]; then
	curl -fsSL "$API/tags/v${PLYFOLD_VERSION#v}" -o "$TMP/release.json" || fail "no release v${PLYFOLD_VERSION#v}"
else
	curl -fsSL "$API?per_page=1" -o "$TMP/release.json" || fail "cannot reach GitHub"
fi
TAG=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$TMP/release.json" | head -n 1)
[ -n "$TAG" ] || fail "no release found"
URLS=$(sed -n 's/.*"browser_download_url": *"\([^"]*\)".*/\1/p' "$TMP/release.json")

# The first asset whose name matches one of the patterns, in order
pick() {
	for pattern in "$@"; do
		url=$(printf '%s\n' "$URLS" | grep -E "$pattern" | head -n 1 || true)
		if [ -n "$url" ]; then
			printf '%s\n' "$url"
			return
		fi
	done
}

fetch() {
	file="$TMP/$(basename "$1")"
	say "Downloading $(basename "$1")"
	curl -fL --progress-bar "$1" -o "$file" || fail "download failed: $1"
	sums=$(pick '/SHA256SUMS\.txt$')
	if [ -n "$sums" ]; then
		curl -fsSL "$sums" -o "$TMP/SHA256SUMS.txt"
		want=$(grep " $(basename "$file")\$" "$TMP/SHA256SUMS.txt" | cut -d ' ' -f 1)
		if command -v sha256sum >/dev/null 2>&1; then
			got=$(sha256sum "$file" | cut -d ' ' -f 1)
		else
			got=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
		fi
		[ -n "$want" ] && [ "$want" = "$got" ] || fail "checksum mismatch for $(basename "$file")"
	fi
	DOWNLOADED=$file
}

install_macos() {
	url=$(pick '_universal\.dmg$' "_$(uname -m | sed 's/arm64/aarch64/')\.dmg$")
	[ -n "$url" ] || fail "$TAG has no macOS build for $(uname -m)"
	fetch "$url"

	dir=${PLYFOLD_INSTALL_DIR:-/Applications}
	if [ -z "${PLYFOLD_INSTALL_DIR:-}" ] && [ ! -w "$dir" ]; then
		dir="$HOME/Applications"
	fi
	mkdir -p "$dir"
	if pgrep -qf "$dir/Plyfold.app/Contents/MacOS/"; then
		fail "Plyfold is running. Quit it (⌘Q) and run this again"
	fi

	mnt="$TMP/mnt"
	mkdir -p "$mnt"
	hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$DOWNLOADED"
	rm -rf "$dir/Plyfold.app"
	ditto "$mnt/Plyfold.app" "$dir/Plyfold.app"
	hdiutil detach -quiet "$mnt"
	# In case the file was marked anyway (some proxies and security tools do)
	xattr -dr com.apple.quarantine "$dir/Plyfold.app" 2>/dev/null || true

	say "Installed Plyfold $TAG in $dir. Open it with: open \"$dir/Plyfold.app\""
}

install_linux() {
	[ "$(uname -m)" = x86_64 ] || fail "only x86_64 builds are published for Linux"
	format=${PLYFOLD_LINUX_FORMAT:-}
	if [ -z "$format" ]; then
		if command -v apt-get >/dev/null 2>&1; then format=deb; else format=appimage; fi
	fi

	case "$format" in
	deb)
		url=$(pick '_amd64\.deb$')
		[ -n "$url" ] || fail "$TAG has no .deb"
		fetch "$url"
		say "Installing the package (sudo asks for your password)"
		sudo apt-get install -y "$DOWNLOADED"
		say "Installed Plyfold $TAG. Start it from the app menu or with: plyfold-desktop"
		;;
	appimage)
		url=$(pick '_amd64\.AppImage$')
		[ -n "$url" ] || fail "$TAG has no AppImage"
		fetch "$url"
		dir=${PLYFOLD_INSTALL_DIR:-$HOME/.local/share/plyfold}
		mkdir -p "$dir" "$HOME/.local/bin" "$HOME/.local/share/applications"
		install -m 755 "$DOWNLOADED" "$dir/Plyfold.AppImage"
		# Without FUSE 2 (not installed by default on recent Ubuntu) an AppImage can still run by extracting itself
		cat >"$HOME/.local/bin/plyfold" <<EOF
#!/bin/sh
command -v fusermount >/dev/null 2>&1 || export APPIMAGE_EXTRACT_AND_RUN=1
exec "$dir/Plyfold.AppImage" "\$@"
EOF
		chmod 755 "$HOME/.local/bin/plyfold"
		curl -fsSL "https://raw.githubusercontent.com/$REPO/$TAG/apps/desktop/src-tauri/icons/128x128.png" -o "$dir/plyfold.png" || true
		cat >"$HOME/.local/share/applications/plyfold.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Plyfold
Comment=Run coding agents side by side
Exec=$HOME/.local/bin/plyfold
Icon=$dir/plyfold.png
Categories=Development;
Terminal=false
EOF
		say "Installed Plyfold $TAG in $dir. Start it from the app menu or with: plyfold"
		case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "(~/.local/bin is not on your PATH)" ;; esac
		;;
	*) fail "PLYFOLD_LINUX_FORMAT must be deb or appimage" ;;
	esac
}

case "$(uname -s)" in
Darwin) install_macos ;;
Linux) install_linux ;;
*) fail "this script is for macOS and Linux. On Windows run: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
esac
