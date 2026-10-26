#!/usr/bin/env bash
# 停掉 QQ 那套，并禁止它自动复活。
#
# 顺序很重要：先 --restart=no 再 stop。
# 如果先 stop 再改 restart 策略，Docker 在 daemon 重启时仍会把 unless-stopped 的容器拉起来
# ——注意 unless-stopped 只对"被手动停止过"的容器生效，而这几个容器是随整机一起挂的，
# 没被 stop 过，所以默认会复活。
set -uo pipefail

echo "== 内存（停之前）=="
free -m | sed -n '1,3p'

echo "== 1) 关闭自启 =="
for c in qq-desktop pi-rt-qq; do
  if docker inspect "$c" >/dev/null 2>&1; then
    docker update --restart=no "$c" >/dev/null && echo "  $c: restart=no"
  else
    echo "  $c: 不存在"
  fi
done

echo "== 2) 停止容器 =="
docker stop qq-desktop pi-rt-qq >/dev/null 2>&1 && echo "  已停止" || echo "  停止失败（可能已经停了）"

echo "== 3) 结果 =="
docker ps -a --format '  {{.Names}}  {{.Status}}  restart={{.Label "restart"}}' 2>/dev/null || docker ps -a
for c in qq-desktop pi-rt-qq pi-rt; do
  [ "$(docker inspect "$c" >/dev/null 2>&1 && echo ok)" = "ok" ] &&
    printf "  %-12s %s\n" "$c" "$(docker inspect "$c" --format '{{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}}')"
done

echo "== 内存（停之后）=="
free -m | sed -n '1,3p'
