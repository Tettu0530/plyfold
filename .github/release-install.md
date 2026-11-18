
## Install

| System | File |
|---|---|
| macOS (Apple silicon and Intel) | `Plyfold_<version>_universal.dmg` |
| Windows 10/11 (x64) | `Plyfold_<version>_x64-setup.exe` (or the `.msi`) |
| Linux (x64, WebKitGTK 4.1) | `Plyfold_<version>_amd64.AppImage`, or the `.deb` for Debian and Ubuntu |

The builds are not signed yet, so the system warns the first time:

- **macOS**: drag Plyfold to Applications, then run `xattr -dr com.apple.quarantine /Applications/Plyfold.app` in Terminal before opening it (or open it once, then choose Open Anyway in System Settings → Privacy & Security)
- **Windows**: if SmartScreen stops the installer, choose More info → Run anyway
- **Linux**: `chmod +x Plyfold_*.AppImage` and run it, or `sudo apt install ./Plyfold_*.deb`. API keys are kept in the Secret Service (GNOME Keyring or KWallet)

You also need the agent CLIs you want to use (and Node.js for the ones started through `npx`). `SHA256SUMS.txt` lists the checksums of the files.
