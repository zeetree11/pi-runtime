#!/usr/bin/env bash
# 把 QQ 通道接到共享记忆库（data2），并为它保留一份持久化配置。
#
# 之前 pi-rt-qq 挂在 /srv/pi-rt/data（旧库），飞书挂在 data2 —— 两个 bot 成了两套大脑。
# 这里统一切到 data2：飞书说过的，QQ 也知道。
#
# 两个进程写同一个 SQLite：靠 WAL 并发，但提炼/维护循环只留一份（QQ 侧加 --no-maintenance），
# 否则同一批事件会被提炼两次。
set -uo pipefail

CONF=/srv/pi-rt/env/qq.env
F=/app/data/config/onebot_3385592563.json

echo "== 从 snowluma 读 token =="
TOKENS=$(docker exec snowluma grep '"accessToken"' "$F" | sed -E 's/.*: "([^"]*)".*/\1/')
HTTP_TOKEN=$(echo "$TOKENS" | sed -n '1p')
WS_TOKEN=$(echo "$TOKENS" | sed -n '2p')
echo "http token 长度: ${#HTTP_TOKEN}   ws token 长度: ${#WS_TOKEN}"

echo "== 写持久化配置 =="
umask 077
cat > "$CONF" <<ENV
PI_RT_OWNER_NAME=Rick
PI_RT_PROVIDER=deepseek
PI_RT_MODEL=deepseek-flash
PI_RT_MAX_MINUTES=30
PI_RT_SANDBOX=full
QQ_WS_URL=ws://snowluma:3001/
QQ_HTTP_URL=http://snowluma:3000
QQ_WS_TOKEN=$WS_TOKEN
QQ_HTTP_TOKEN=$HTTP_TOKEN
QQ_BOT_UIN=3385592563
QQ_WAKE_WORDS=油桃
NPM_REGISTRY=https://registry.npmmirror.com
ENV
chmod 600 "$CONF"
sed -E 's/(TOKEN=).*/\1***/' "$CONF"

echo "== 重建 pi-rt-qq（挂 data2）=="
docker rm -f pi-rt-qq >/dev/null 2>&1
docker run -d --name pi-rt-qq --restart unless-stopped \
  --network pi-rt-net \
  --env-file /srv/pi-rt/env/pi-rt.env \
  --env-file "$CONF" \
  -v /srv/pi-rt/data2:/data -v /srv/pi-rt/workspace:/workspace \
  -e HOME=/data \
  -e PI_RT_DATA_DIR=/data -e PI_RT_WORKSPACE=/workspace \
  pi-runtime:latest node src/cli.ts serve --channel qq --no-maintenance >/dev/null && echo "  已启动"

sleep 14
echo "== 挂载 =="
docker inspect pi-rt-qq --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
echo "== 日志 =="
docker logs pi-rt-qq --tail 5 2>&1 | tr -d '\r'
echo "== 两个通道读到的记忆（应一致）=="
docker exec pi-rt node -e "const {MemoryStore}=await import('./src/memory.ts');const s=new MemoryStore('/data','Rick');console.log('feishu:', s.active().length)" 2>&1 | tail -1
docker exec pi-rt-qq node -e "const {MemoryStore}=await import('./src/memory.ts');const s=new MemoryStore('/data','Rick');console.log('qq    :', s.active().length)" 2>&1 | tail -1
