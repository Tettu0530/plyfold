
## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Tettu0530/plyfold/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Tettu0530/plyfold/main/install.ps1 | iex
```

The scripts install the newest release after checking it against `SHA256SUMS.txt`, and update an existing install. The builds are not signed yet, but a file fetched this way is not flagged as downloaded from the internet, so the system does not stop it.

Or download a file below:

| System | File |
|---|---|
| macOS (Apple silicon and Intel) | `Plyfold_<version>_universal.dmg` |
| Windows 10/11 (x64) | `Plyfold_<version>_x64-setup.exe` (or the `.msi`) |
| Linux (x64, WebKitGTK 4.1) | `Plyfold_<version>_amd64.deb` for Debian and Ubuntu, or the `.AppImage` |

A downloaded file is not signed, so the system warns the first time:

- **macOS**: drag Plyfold to Applications and open it. When macOS says it cannot verify the app, choose Done, then Open Anyway in System Settings → Privacy & Security (or run `xattr -dr com.apple.quarantine /Applications/Plyfold.app` in Terminal)
- **Windows**: if SmartScreen stops the installer, choose More info → Run anyway
- **Linux**: `sudo apt install ./Plyfold_*.deb`, or `chmod +x Plyfold_*.AppImage` and run it. API keys are kept in the Secret Service (GNOME Keyring or KWallet)

You also need the agent CLIs you want to use (and Node.js for the ones started through `npx`).
