#!/bin/zsh
# 動いているアプリ（npm run tauri dev の vite、http://localhost:1420/）を、ヘッドレスの Chrome で開き、
# 仮想時間を 1/60 秒ずつ進めてコマを撮り、1 枚に並べる（Tauri の外なので、セッションのない画面で動く）
#   tools/liquid-probe/app-frames.sh '<クリックなどの JS>' x,y,w,h <コマ数> <出力 png>
# 例: tools/liquid-probe/app-frames.sh '[...document.querySelectorAll("button")].find(b=>b.textContent.includes("新しいセッション")).click()' 0,40,480,200 12 /tmp/new.png
set -e
HERE=${0:A:h}
TMP=$(mktemp -d)
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$C" --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$TMP --remote-debugging-port=9334 --window-size=1440,900 about:blank >/dev/null 2>&1 &
CP=$!
# 時間切れ（perl の alarm）や中断でも Chrome と node を残さない（残ると次の撮影がつながらない）
cleanup() { kill $NP $CP 2>/dev/null; sleep 0.5; rm -rf $TMP 2>/dev/null; true }
trap cleanup EXIT
trap 'exit 142' ALRM TERM INT
for i in {1..30}; do curl -s http://127.0.0.1:9334/json/version >/dev/null && break; sleep 0.3; done
node $HERE/app-frames.mjs 9334 http://localhost:1420/ "$1" "$2" "$3" "$4" &
NP=$!
wait $NP
