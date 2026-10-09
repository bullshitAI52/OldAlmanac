#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo '请使用 sudo 运行安装脚本'; exit 1; }
NODE=$(command -v node)
"$NODE" -e 'if(Number(process.versions.node.split(".")[0])<22) process.exit(1)'
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if ! id oldalmanac-bot >/dev/null 2>&1; then useradd --system --home-dir /var/lib/oldalmanac-bot --shell /usr/sbin/nologin oldalmanac-bot; fi
install -d -m 755 /opt/oldalmanac-bot/bot /opt/oldalmanac-bot/runtime
# Copy the executable: system node may be a symlink into a protected home.
install -m 755 "$NODE" /opt/oldalmanac-bot/runtime/node
install -m 644 "$ROOT/lunar.js" /opt/oldalmanac-bot/lunar.js
for file in core.cjs server.cjs test.cjs; do install -m 644 "$ROOT/bot/$file" "/opt/oldalmanac-bot/bot/$file"; done
install -d -o oldalmanac-bot -g oldalmanac-bot -m 700 /var/lib/oldalmanac-bot
if [ ! -f /etc/oldalmanac-bot.env ]; then install -m 600 "$ROOT/bot/.env.example" /etc/oldalmanac-bot.env; fi
sed "s|/usr/local/bin/node|/opt/oldalmanac-bot/runtime/node|g" "$ROOT/bot/oldalmanac-bot.service" > /etc/systemd/system/oldalmanac-bot.service
chmod 644 /etc/systemd/system/oldalmanac-bot.service
systemctl daemon-reload
"$NODE" --test /opt/oldalmanac-bot/bot/test.cjs
printf '%s\n' '安装完成，未自动启动。填写 /etc/oldalmanac-bot.env 后执行 systemctl enable --now oldalmanac-bot。升级后执行 systemctl restart oldalmanac-bot。'
