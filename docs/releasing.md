# Releasing

Pushing a version tag builds the installers on GitHub Actions and publishes them as a release (`.github/workflows/release.yml`):

| System | Files |
|---|---|
| macOS (one universal build for Apple silicon and Intel) | `.dmg` |
| Windows 10/11 (x64) | `-setup.exe` (NSIS) and `.msi` |
| Linux (x64, built on Ubuntu 22.04) | `.AppImage` and `.deb` |

Every release also gets `SHA256SUMS.txt`, which `install.sh` and `install.ps1` (at the repository root, fetched from `main`) check before installing. The notes are that version's section of `CHANGELOG.md`, followed by the install steps in `.github/release-install.md`. Versions below 1.0 are marked as pre-releases.

## Updates from inside the app

Installed copies check `https://github.com/Tettu0530/plyfold/releases/download/updater/latest.json` a little after they start and every six hours (Settings → Info checks on demand). The Release workflow signs the update files (`.app.tar.gz` for macOS, the NSIS `-setup.exe` for Windows, the AppImage for Linux) and replaces `latest.json` in the release tagged `updater` once a version is published. The app installs an update only when its signature matches the public key in `tauri.conf.json`.

The signing key is kept out of the repository:

- `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty if the key has none) are repository secrets. Without them the installers are still built, but no update files, and the feed stays as it was
- Keep a copy of the private key somewhere safe. If it is lost, installed copies can no longer update themselves: a new key means a new public key, which only a manually installed version carries

The `.deb` is not updated from inside the app; `install.sh` updates it.

## Steps

1. On a branch from `main`, set the new version everywhere and move the Unreleased notes under it:

   ```sh
   node scripts/bump-version.mjs 0.3.0
   ```

   This updates `tauri.conf.json`, `package.json`, `package-lock.json`, every `Cargo.toml`, `Cargo.lock` and `CHANGELOG.md`. Add a one-line summary under the new heading if you like.

2. Open a pull request, let CI pass, and merge it.

3. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag v0.3.0
   git push origin v0.3.0
   ```

4. The Release workflow checks that the tag matches the app version and that the changelog has a section for it, builds the three systems in parallel (about 20 minutes), and publishes the release. Edit the notes on GitHub afterwards if you want highlights at the top.

To build a tag again (for example after a runner failure), run the workflow by hand from the Actions tab with the tag. It replaces the files and keeps the notes.

A pull request that changes the workflow builds all three systems without publishing, so changes to it can be tried first.

## Not done yet

The builds are not signed (the macOS bundle is signed ad hoc, which avoids the "damaged" message but not the Gatekeeper warning). macOS needs an Apple Developer ID and notarization; Windows needs a code signing certificate. Until then the install steps in the notes explain how to get past the warnings.
