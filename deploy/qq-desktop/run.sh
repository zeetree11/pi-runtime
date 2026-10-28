#!/usr/bin/env bash
# 用 SnowLuma 官方镜像跑无桌面 QQ。
#
# 不要再构建本目录以前的 qq-desktop 镜像。那个镜像给 QQ 设了
# LIBGL_ALWAYS_SOFTWARE=1，软件渲染会把 QQ + 虚拟桌面顶到 700–900MB，
# 2GB 的机器会在内存回收里把 SSH 卡死。官方镜像默认关掉 GPU 和软件光栅化，
# 同一套 QQ + SnowLuma + Xvfb 大约 250MB。
set -euo pipefail

IMAGE="${SNOWLUMA_IMAGE:-motricseven7/snowluma:v2.1.1}"
NAME="${SNOWLUMA_NAME:-snowluma}"
DATA_ROOT="${SNOWLUMA_DATA_ROOT:-/srv/pi-rt/snowluma}"
SCREEN="${SNOWLUMA_SCREEN:-1280x800x24}"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root" >&2
  exit 1
fi

# swappiness=0 时内核几乎不把匿名页换出去，2GB swap 会一直空着。
current="$(cat /proc/sys/vm/swappiness)"
if [ "${current}" -lt 10 ]; then
  sysctl -w vm.swappiness=10 >/dev/null
  printf 'vm.swappiness=10\n' > /etc/sysctl.d/99-swappiness.conf
fi

mkdir -p \
  "${DATA_ROOT}/data" \
  "${DATA_ROOT}/config" \
  "${DATA_ROOT}/share" \
  "${DATA_ROOT}/accounts"

# 旧的自建桌面容器和它的镜像。登录态在镜像层里，删掉后必须重新扫码。
docker rm -f qq-desktop pi-rt-qq >/dev/null 2>&1 || true
docker rmi qq-desktop:loggedin qq-desktop:latest >/dev/null 2>&1 || true

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  if [ -n "${SNOWLUMA_TAR:-}" ]; then
    docker load -i "${SNOWLUMA_TAR}"
  else
    docker pull "${IMAGE}"
  fi
fi
docker image inspect "${IMAGE}" >/dev/null

docker rm -f "${NAME}" >/dev/null 2>&1 || true
docker run -d --name "${NAME}" --restart unless-stopped \
  --init \
  --shm-size 1g \
  --memory 1g \
  --memory-swap 2g \
  --cap-add SYS_PTRACE \
  --security-opt seccomp=unconfined \
  -e SNOWLUMA_QQ_FLAGS="--disable-gpu --disable-software-rasterizer --disable-gpu-compositing" \
  -e "SNOWLUMA_SCREEN=${SCREEN}" \
  -e SNOWLUMA_WEBUI_HOST=0.0.0.0 \
  -e SNOWLUMA_WEBUI_PORT=5099 \
  -e SNOWLUMA_HOOK_AUTOLOAD=1 \
  -e SNOWLUMA_ONEBOT_HOST=0.0.0.0 \
  -p 127.0.0.1:6081:6081 \
  -p 127.0.0.1:5099:5099 \
  -v "${DATA_ROOT}/data:/app/data" \
  -v "${DATA_ROOT}/config:/app/.config" \
  -v "${DATA_ROOT}/share:/app/.local/share" \
  -v "${DATA_ROOT}/accounts:/app/qq-accounts" \
  "${IMAGE}"

echo "noVNC 只监听 127.0.0.1:6081"
echo "本机: ssh -L 6081:127.0.0.1:6081 <host>"
echo "浏览器: http://127.0.0.1:6081/vnc.html"
echo "密码: ${DATA_ROOT}/data/config/vnc-password"
