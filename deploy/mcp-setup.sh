#!/usr/bin/env bash
# 给运行时装上 MCP fetch，并启用 bash（沙箱 full）。
#
# 两件事一起改的原因：`safe` 模式排除 bash，而你要 bash，所以只能 full。
# 注意 full 意味着没有工具限制：agent 能以 agent 用户身份在容器内执行任意命令。
set -uo pipefail

ENV=/srv/pi-rt/env/pi-rt.env
MCP_DIR=/srv/pi-rt/workspace/mcp
DATA=/srv/pi-rt/data2
# pi 的 MCP 配置读 ~/.pi/agent/mcp.json，不受 PI_CODING_AGENT_DIR 影响，所以容器里要用
# HOME=/data 才能让配置落在持久化的数据卷上（否则写进容器层，重建即丢）。
CONF_DIR=$DATA/.pi/agent

echo "== 1) 放置 MCP server =="
mkdir -p "$MCP_DIR" "$CONF_DIR"
cp /opt/pi-runtime/mcp/fetch-server.mjs "$MCP_DIR/fetch-server.mjs"
chown -R 10001:10001 "$MCP_DIR" "$CONF_DIR"
ls -l "$MCP_DIR/fetch-server.mjs"

echo "== 2) 写 MCP 配置 =="
# exposure=direct：默认是 codemode（只能从脚本里调，模型看不到）。single small tool 直接声明
# 更合算——150 token 换模型能直接调，比让模型先写脚本再调便宜。
cat > "$CONF_DIR/mcp.json" <<'JSON'
{
  "mcpServers": {
    "fetch": {
      "command": "node",
      "args": ["/workspace/mcp/fetch-server.mjs"],
      "exposure": "direct",
      "description": "读取公网网页并返回纯文本（自动去标签、限长）"
    }
  }
}
JSON
chown 10001:10001 "$CONF_DIR/mcp.json"
chmod 600 "$CONF_DIR/mcp.json"
cat "$CONF_DIR/mcp.json"

echo "== 3) 沙箱切 full =="
if grep -q '^PI_RT_SANDBOX=' "$ENV"; then
  sed -i 's/^PI_RT_SANDBOX=.*/PI_RT_SANDBOX=full/' "$ENV"
else
  echo 'PI_RT_SANDBOX=full' >> "$ENV"
fi
grep '^PI_RT_SANDBOX=' "$ENV"

echo "== 4) 重建容器（env-file 改动必须重建，restart 不生效）=="
docker rm -f pi-rt >/dev/null 2>&1
docker run -d --name pi-rt --restart unless-stopped \
  --env-file "$ENV" \
  -e HOME=/data \
  -v "$DATA":/data -v /srv/pi-rt/workspace:/workspace \
  -e PI_RT_DATA_DIR=/data -e PI_RT_WORKSPACE=/workspace \
  pi-runtime:latest node src/cli.ts serve --channel feishu >/dev/null && echo "  已启动"

sleep 12

echo "== 5) 验证 =="
docker logs pi-rt --tail 4 2>&1 | tr -d '\r'
echo "--- MCP 清单 ---"
docker exec pi-rt node node_modules/.bin/pi mcp list 2>&1 | head -8
echo "--- 沙箱 ---"
docker exec pi-rt node src/cli.ts sandbox 2>&1 | head -8
