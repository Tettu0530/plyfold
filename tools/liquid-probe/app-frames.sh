#!/bin/zsh
# Opens the running app (the vite server of npm run tauri dev, http://localhost:1420/) in headless Chrome,
# captures frames while advancing virtual time 1/60 s at a time, and tiles them into one image (outside Tauri, so it runs with no sessions)
#   tools/liquid-probe/app-frames.sh '<JS such as a click>' x,y,w,h <frames> <output png>
# Example: tools/liquid-probe/app-frames.sh '[...document.querySelectorAll("button")].find(b=>b.textContent.includes("New session")).click()' 0,40,480,200 12 /tmp/new.png
set -e
HERE=${0:A:h}
TMP=$(mktemp -d)
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$C" --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$TMP --remote-debugging-port=9334 --window-size=1440,900 about:blank >/dev/null 2>&1 &
CP=$!
# Never leave Chrome and node behind, even on timeout (perl alarm) or interrupt (leftovers block the next capture)
cleanup() { kill $NP $CP 2>/dev/null; sleep 0.5; rm -rf $TMP 2>/dev/null; true }
trap cleanup EXIT
trap 'exit 142' ALRM TERM INT
for i in {1..30}; do curl -s http://127.0.0.1:9334/json/version >/dev/null && break; sleep 0.3; done
node $HERE/app-frames.mjs 9334 http://localhost:1420/ "$1" "$2" "$3" "$4" &
NP=$!
wait $NP
