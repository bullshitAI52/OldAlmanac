#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo '请使用 sudo'; exit 1; }
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ -x /opt/oldalmanac-bot/runtime/node ] || { echo '请先运行 bot/install.sh'; exit 1; }
for file in daily.cjs daily.test.cjs package.json package-lock.json; do install -m 644 "$ROOT/bot/$file" "/opt/oldalmanac-bot/bot/$file"; done
cd /opt/oldalmanac-bot/bot
npm ci --ignore-scripts --omit=dev
# Chromium installation is explicit; preserve existing server browsers.
echo '请提供服务账号可访问的 Chromium 路径。无浏览器时可按README安装。'
install -m 644 "$ROOT/bot/oldalmanac-daily.service" /etc/systemd/system/
install -m 644 "$ROOT/bot/oldalmanac-daily.timer" /etc/systemd/system/
systemctl daemon-reload
echo '填写 DAILY_CHAT_IDS 和 CHROMIUM_EXECUTABLE 后，systemctl enable --now oldalmanac-daily.timer'
