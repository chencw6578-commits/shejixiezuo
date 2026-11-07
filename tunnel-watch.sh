#!/usr/bin/env bash
# 公网隧道守护：经代理 SSH 连 localhost.run，断线 3 秒后自动重连
# 新地址实时记录在 /workspace/tunnel.log，取最后一行 https://xxx.lhr.life 即当前入口
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

while true; do
  if ! pgrep -f 'ssh .*localhost\.run' >/dev/null 2>&1; then
    echo "[tunnel-watch] $(date '+%F %T') starting tunnel..." >> /workspace/tunnel.log
    tail -f /dev/null | ssh -tt \
      -o ProxyCommand='nc -X connect -x 127.0.0.1:18080 %h %p' \
      -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes \
      -R 80:127.0.0.1:3000 nokey@localhost.run >> /workspace/tunnel.log 2>&1
    echo "[tunnel-watch] tunnel exited, retrying in 3s..." >> /workspace/tunnel.log
    sleep 3
  fi
  sleep 3
done
