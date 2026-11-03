#!/usr/bin/env bash
# One-shot bootstrap for a fresh Ubuntu/Debian server.
#
#   curl -fsSL https://raw.githubusercontent.com/zeetree11/Tree-Agent/main/deploy/bootstrap.sh | sudo bash
#
# It is deliberately chatty: every step prints PASS or FAIL with the next action, so a failed
# run can be diagnosed from its output alone without a shell on the box.
set -uo pipefail

REPO="${PI_RT_REPO:-https://github.com/zeetree11/Tree-Agent.git}"
DIR="${PI_RT_DIR:-/opt/pi-runtime}"
DATA="${PI_RT_DATA:-/srv/pi-rt/data}"
WORKSPACE="${PI_RT_WORKSPACE:-/srv/pi-rt/workspace}"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
step() { printf '\n== %s ==\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  fail "需要 root（sudo bash bootstrap.sh）"
  exit 1
fi

step "1/7 系统"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  pass "${PRETTY_NAME:-unknown}"
else
  fail "无法识别系统，脚本针对 Ubuntu/Debian"
  exit 1
fi
pass "磁盘可用 $(df -h / | awk 'NR==2{print $4}')，内存 $(awk '/MemTotal/{printf "%dMB", $2/1024}' /proc/meminfo)"

step "2/7 Docker"
if command -v docker >/dev/null 2>&1; then
  pass "已安装：$(docker --version)"
else
  echo "  未安装，开始安装（约 1-2 分钟）"
  if curl -fsSL https://get.docker.com | sh >/tmp/docker-install.log 2>&1; then
    pass "安装完成：$(docker --version)"
  else
    fail "Docker 安装失败，日志：/tmp/docker-install.log"
    exit 1
  fi
fi
if docker compose version >/dev/null 2>&1; then
  pass "compose 插件可用"
elif command -v docker-compose >/dev/null 2>&1; then
  fail "只有旧版 docker-compose，请用 docker-compose 替代后续命令"
  exit 1
else
  fail "缺少 compose 插件"
  exit 1
fi

step "3/7 代码"
mkdir -p /opt
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only >/dev/null 2>&1 && pass "已更新 $DIR" || fail "更新失败（本地有改动？）"
else
  git clone --depth 1 "$REPO" "$DIR" >/dev/null 2>&1 && pass "已克隆到 $DIR" || { fail "克隆失败（网络？）"; exit 1; }
fi

step "4/7 数据目录"
mkdir -p "$DATA" "$WORKSPACE"
pass "$DATA / $WORKSPACE"

step "5/7 配置"
ENV_FILE="$DIR/deploy/.env"
if [ -f "$ENV_FILE" ]; then
  pass "配置已存在，跳过"
else
  cp "$DIR/deploy/env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  fail "需要填写 $ENV_FILE 后再运行本脚本"
  echo "     必填：FEISHU_APP_ID / FEISHU_APP_SECRET / PI_RT_OWNER_IDS"
  exit 2
fi
if grep -q 'cli_xxxxxxxxxxxx\|replace-me\|ou_xxxxxxxx' "$ENV_FILE"; then
  fail "配置里还有占位符，请先填真实值"
  exit 2
fi
pass "配置已填写"

step "6/7 模型凭证"
if [ -n "$(ls -A "$DATA/pi" 2>/dev/null)" ]; then
  pass "凭证目录非空"
else
  fail "缺少模型凭证：本地执行 scp -r ~/.pi root@<server>:$DATA/pi"
  echo "     没有凭证时 pi 无法调用模型，服务会启动但每条消息都失败"
fi

step "7/7 构建并启动"
cd "$DIR" || exit 1
if docker compose -f deploy/docker-compose.yml up -d --build >/tmp/pi-rt-build.log 2>&1; then
  pass "容器已启动"
else
  fail "构建失败，日志：/tmp/pi-rt-build.log（最后 20 行如下）"
  tail -20 /tmp/pi-rt-build.log
  exit 1
fi

sleep 5
if docker exec pi-rt node src/cli.ts doctor >/tmp/pi-rt-doctor.log 2>&1; then
  pass "doctor 通过"
else
  fail "doctor 未通过："
  tail -20 /tmp/pi-rt-doctor.log
fi

echo
echo "== 完成 =="
echo "  日志：    docker compose -f $DIR/deploy/docker-compose.yml logs -f"
echo "  自检：    docker exec pi-rt node src/cli.ts doctor"
echo "  状态：    docker exec pi-rt node src/cli.ts stats"
echo "  下一步：  在飞书给 bot 发一条消息，然后关掉电脑再发一条"
