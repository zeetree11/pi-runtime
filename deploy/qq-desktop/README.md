# QQ 通道：无桌面服务器上跑 SnowLuma

QQ 的协议端需要一个真实的 QQ 进程才能注入。云服务器没有屏幕，所以用 SnowLuma 官方镜像：里面已经带了 QQ、Xvfb、x11vnc 和 noVNC。

不要再自己构建 QQ 桌面镜像。旧的 `Dockerfile` 给 QQ 加了 `LIBGL_ALWAYS_SOFTWARE=1`，软件渲染会把这一套顶到 700–900MB，2GB 的机器会在内存回收里把 SSH 卡死。官方镜像 `motricseven7/snowluma:v2.1.1` 用的是：

```text
qq --no-sandbox --disable-gpu --disable-software-rasterizer --disable-gpu-compositing
```

同一套 QQ + SnowLuma + 虚拟桌面大约 250MB。

## 架构

```
你的浏览器 ──SSH 隧道──► noVNC :6081 ──► Xvfb ──► QQ（容器内）
                                                      │ 注入
                                                SnowLuma（同一容器）
                                                      │ OneBot v11
                                           HTTP :3000（发） / WS :3001（收）
```

noVNC 和 WebUI 只发布在宿主机的 `127.0.0.1`。OneBot 的 3000 / 3001 留在容器网络里，不映射到公网。

## 启动

在服务器上：

```bash
bash deploy/qq-desktop/run.sh
```

脚本会做四件事：

1. 把 `vm.swappiness` 提到 10，并写进 `/etc/sysctl.d/99-swappiness.conf`。值为 0 时，2GB swap 不会被使用。
2. 删掉旧的 `qq-desktop`、`pi-rt-qq` 容器和 `qq-desktop` 镜像。
3. 准备镜像 `motricseven7/snowluma:v2.1.1`。服务器能访问仓库时脚本会自己 `docker pull`。访问不了时，在能联网的机器上导出再传入：

```bash
docker pull motricseven7/snowluma:v2.1.1
docker save -o snowluma-v2.1.1.tar motricseven7/snowluma:v2.1.1
scp snowluma-v2.1.1.tar <host>:/tmp/
```

然后在服务器上 `SNOWLUMA_TAR=/tmp/snowluma-v2.1.1.tar bash deploy/qq-desktop/run.sh`。

4. 用 1GB 内存上限和 1GB 共享内存启动容器 `snowluma`。数据在 `/srv/pi-rt/snowluma`。

扫码：

```bash
ssh -L 6081:127.0.0.1:6081 <host>
```

浏览器打开 `http://127.0.0.1:6081/vnc.html`。密码在首次启动日志里，也写在 `/srv/pi-rt/snowluma/data/config/vnc-password`。

## 内存

| 组件 | 占用 |
|---|---|
| 官方镜像里的 QQ + SnowLuma + Xvfb + noVNC | 约 250MB |
| 自建镜像（`LIBGL_ALWAYS_SOFTWARE=1`） | 700–900MB，不要再用 |
| pi-runtime（每个通道） | 60–90MB |

容器有 `--memory 1g --memory-swap 2g`。超过上限时只杀掉这个容器，不会把宿主机拖死。稳态如果远高于 250MB，先停掉，不要把上限放宽。

2GB 机器可以同时跑这一个 QQ 容器和飞书通道。前提是 swappiness 不是 0，而且没有第二份 QQ 桌面。

## 坑

| 现象 | 原因 | 解法 |
|---|---|---|
| 宿主机访问 5099 超时 | WebUI 只听容器内 loopback，端口映射打到的是容器网卡 | 保持 `SNOWLUMA_WEBUI_HOST=0.0.0.0`，宿主机端口仍然只绑 `127.0.0.1` |
| 删掉容器后 QQ 回到登录页 | 登录态在 `/srv/pi-rt/snowluma` 的三个目录里，不在镜像层 | 保留这几个 bind mount；镜像层里的登录态随 `docker rmi` 一起没了 |
| 3001 的 HTTP 请求返回 `Upgrade Required` | 该端口是 WebSocket | HTTP 用 3000，WS 用 3001 |
| `onebot: websocket error`，但手工连同一个地址能通 | 客户端拼 URL 时丢了结尾斜杠 | `ws://<snowluma>:3001/` |
| 发送消息 401 | HTTP 和 WS 各有一个 token | 分别写入 `QQ_HTTP_TOKEN` 和 `QQ_WS_TOKEN` |
| SSH 握手超时、机器像死了 | swappiness 为 0，或又拉起了自建 `qq-desktop` | 用本目录的 `run.sh`；不要恢复 `LIBGL_ALWAYS_SOFTWARE` |

## 验证

```bash
docker stats --no-stream snowluma
docker exec snowluma ps -eo args | grep "[q]q --no-sandbox"
```

QQ 的参数里应有 `--disable-gpu`，不应有 `LIBGL_ALWAYS_SOFTWARE`。

## 相关变量

运行时的 QQ 通道读这些环境变量（见 `src/channels/onebot.ts`）：

```
QQ_WS_URL          ws://snowluma:3001/
QQ_HTTP_URL        http://snowluma:3000
QQ_WS_TOKEN        WS 服务的 token
QQ_HTTP_TOKEN      HTTP 服务的 token
QQ_BOT_UIN         机器人 QQ 号（用于判断 @ 是否指向自己）
QQ_ALLOW_USERS     私聊白名单
QQ_ALLOW_GROUPS    群白名单
QQ_GROUP_NO_MENTION  这些群不用 @ 也回复
QQ_WAKE_WORDS      消息里出现这些词就当在叫它
```

`QQ_WS_URL` / `QQ_HTTP_URL` 使用容器名时，pi-runtime 要和 `snowluma` 在同一个 Docker 网络里。
