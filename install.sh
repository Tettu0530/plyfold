#!/bin/sh
# Install or update Plyfold from the newest GitHub release (macOS and Linux).
#   curl -fsSL https://raw.githubusercontent.com/Tettu0530/plyfold/main/install.sh | sh
#
# A file fetched by curl is not marked as downloaded from the internet, so macOS does not stop the unsigned app.
# The file is checked against the release's SHA256SUMS.txt (from 0.3.0 on).
#
# Environment:
#   PLYFOLD_VERSION      a version to install (e.g. 0.3.0) instead of the newest release
#   PLYFOLD_INSTALL_DIR  macOS: where Plyfold.app goes (default /Applications, or ~/Applications if that is not writable)
#                        Linux: where the AppImage goes (default ~/.local/share/plyfold)
#   PLYFOLD_LINUX_FORMAT Linux: "deb" or "appimage" (default: deb when apt is available, otherwise appimage)
set -eu

REPO="Tettu0530/plyfold"

say() { printf '%s\n' "$*"; }
fail() {
	printf 'plyfold: %s\n' "$*" >&2
	exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

need curl
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The newest release (pre-releases included) from the releases feed, which unlike the API has no rate limit for
# shared addresses
if [ -n "${PLYFOLD_VERSION:-}" ]; then
	TAG="v${PLYFOLD_VERSION#v}"
else
	TAG=$(curl -fsSL "https://github.com/$REPO/releases.atom" | sed -n 's|.*/releases/tag/\([^"<]*\)".*|\1|p' | head -n 1) ||
		fail "cannot reach GitHub"
	[ -n "$TAG" ] || fail "no release found"
fi
VERSION=${TAG#v}
BASE="https://github.com/$REPO/releases/download/$TAG"

# The first of the named files the release has (asks for one byte of each)
pick() {
	for name in "$@"; do
		if curl -fsL -r 0-0 -o /dev/null "$BASE/$name" 2>/dev/null; then
			printf '%s\n' "$name"
			return
		fi
	done
}

fetch() {
	file="$TMP/$1"
	say "Downloading $1"
	curl -fL --progress-bar "$BASE/$1" -o "$file" || fail "download failed: $BASE/$1"
	# Releases from 0.3.0 on list their checksums
	if curl -fsSL "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt" 2>/dev/null; then
		want=$(grep " $1\$" "$TMP/SHA256SUMS.txt" | cut -d ' ' -f 1)
		if command -v sha256sum >/dev/null 2>&1; then
			got=$(sha256sum "$file" | cut -d ' ' -f 1)
		else
			got=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
		fi
		[ -n "$want" ] && [ "$want" = "$got" ] || fail "checksum mismatch for $1"
	fi
	DOWNLOADED=$file
}

install_macos() {
	name=$(pick "Plyfold_${VERSION}_universal.dmg" "Plyfold_${VERSION}_$(uname -m | sed 's/arm64/aarch64/').dmg")
	[ -n "$name" ] || fail "$TAG has no macOS build for $(uname -m)"
	fetch "$name"

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
		name=$(pick "Plyfold_${VERSION}_amd64.deb")
		[ -n "$name" ] || fail "$TAG has no .deb"
		fetch "$name"
		say "Installing the package and what it needs (sudo asks for your password)"
		# A stale package list would point at versions the mirrors no longer have
		sudo apt-get update -qq
		sudo apt-get install -y "$DOWNLOADED"
		say "Installed Plyfold $TAG. Start it from the app menu or with: plyfold-desktop"
		;;
	appimage)
		name=$(pick "Plyfold_${VERSION}_amd64.AppImage")
		[ -n "$name" ] || fail "$TAG has no AppImage"
		fetch "$name"
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
