# QQ 接入（OneBot v11）

> **两种情况分开读：**
>
> - **在有桌面的机器上跑**（Windows 本机）→ 读本文件即可，用 NapCat 或 SnowLuma 都行
> - **在无桌面的云服务器上跑**（要 7×24）→ 读 [`qq-desktop/README.md`](qq-desktop/README.md)，
>   用 SnowLuma 官方镜像。不要自己构建 QQ 桌面镜像，软件渲染会把 2GB 的机器卡死。

QQ 没有官方提供给个人开发者的私有协议，所以这里走 **OneBot v11**：一个本地协议端（NapCat / Lagrange）
负责登录 QQ，我们的运行时只和它说话 —— WebSocket 收消息，HTTP 发消息。

```
QQ 客户端 ──注入──> NapCat（协议端） ──WS/HTTP──> pi-runtime ──> pi ──> 回复
```

## ⚠️ 先说风险

OneBot 不是官方协议。用它登录的 QQ 号存在**被判定异常、验证码、封号**的可能，且协议端可能随 QQ 更新失效。

- **只用小号**，不要用主号
- 小号不要加重要群、不要绑支付
- 这个方案依赖一台常开的机器；关掉 NapCat，bot 就下线

如果想要稳定、7×24、无封号风险：用**飞书长连接**（`serve --channel feishu`），服务器常驻，不需要公网地址。

## 配置项

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `QQ_WS_URL` | 是 | NapCat 的正向 WebSocket，默认 `ws://127.0.0.1:3001` |
| `QQ_HTTP_URL` | 是 | NapCat 的 HTTP 服务，默认 `http://127.0.0.1:3001` |
| `QQ_ACCESS_TOKEN` | 建议 | 与 NapCat 里设置的一致；不设等于不鉴权 |
| `QQ_BOT_UIN` | **是** | bot 自己的 QQ 号。不填就认不出"有人在 @ 我"，群里永远不回复 |
| `QQ_ALLOW_USERS` | 建议 | 允许私聊的 QQ 号，逗号分隔；不填等于谁都能用 |
| `QQ_ALLOW_GROUPS` | 可选 | 允许服务的群号，逗号分隔 |

## Windows（本机）

### 1. 版本要对齐

NapCat 依赖 QQNT 的内部结构，**QQ 版本必须匹配**。当前 NapCat v4.18.41 对应 QQ **9.9.22**。

不匹配的典型表现：注入后 QQ 闪退，或 NapCat 完全不出现。

```powershell
# 看当前 QQ 版本
(Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ").DisplayVersion
```

### 2. 下载并解压

到 [NapCatQQ releases](https://github.com/NapNeko/NapCatQQ/releases) 下 `NapCat.Shell.zip`，解压到任意目录。

如果 GitHub 直连不通，用镜像（把原始链接拼在后面）：

```powershell
curl.exe -L -o NapCat.Shell.zip "https://ghproxy.net/https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.zip"
```

包内结构与入口：

```
launcher.bat        启动入口（会自动请求管理员权限，并从注册表找 QQ.exe）
NapCatWinBootMain.exe  注入器
napcat.mjs          主程序
config\napcat.json  运行时配置
```

### 3. 启动并登录

右键 `launcher.bat` → **以管理员身份运行**。QQ 会打开，用**小号**扫码登录。

### 4. 开启 HTTP 与 WebSocket

浏览器打开 `http://127.0.0.1:6099`，用控制台打印的 token 登录 WebUI：

- 网络配置 → **HTTP 服务**：开，端口 `3001`
- 网络配置 → **WebSocket 服务**：开（正向 WS），端口 `3001`
- 两处都设 **access token**，记下来

### 5. 启动运行时

```powershell
cd pi-runtime
$env:QQ_WS_URL="ws://127.0.0.1:3001"
$env:QQ_HTTP_URL="http://127.0.0.1:3001"
$env:QQ_ACCESS_TOKEN="你的token"
$env:QQ_BOT_UIN="小号QQ号"
$env:QQ_ALLOW_USERS="你的主号QQ号"
node src/cli.ts serve --channel qq
```

看到 `onebot: connected` 即接通。

## Linux（云服务器）

> 这一段没在本机验证过：服务器上没有桌面，QQNT 需要图形环境或 Xvfb。

常见做法是官方 Docker 镜像，把协议端和运行时放在同一台机器：

```bash
docker run -d --name napcat \
  -e NAPCAT_GID=0 -e NAPCAT_UID=0 \
  -p 3001:3001 -p 6099:6099 \
  -v /srv/napcat/config:/app/napcat/config \
  mlikiowa/napcat-docker:latest
```

然后 `docker logs napcat` 拿登录二维码（终端里输出的是字符画二维码，或用 WebUI）。

运行时侧：

```bash
QQ_WS_URL=ws://napcat:3001 QQ_HTTP_URL=http://napcat:3001 \
QQ_ACCESS_TOKEN=... QQ_BOT_UIN=... \
node src/cli.ts serve --channel qq
```

两个容器需要在同一 network 里（compose 里最常见）。

## 行为约定

| 场景 | 行为 |
|---|---|
| 私聊 | 每条都回 |
| 群聊 | **只有 @ 它才回**（`QQ_BOT_UIN` 必须正确，否则群里永远不回） |
| 群里 @ 别人 | 不回 |
| bot 自己的消息 | 忽略（否则自问自答死循环） |
| 图片 / 表情 / 卡片 | 跳过（没有文本内容） |
| 消息格式 | 段数组和 CQ 码字符串都支持 |

## 排查

| 现象 | 原因 |
|---|---|
| `onebot: connected` 但没有反应 | `QQ_BOT_UIN` 填错 → 群里判断不出 @；或 `QQ_ALLOW_USERS` 不含你 |
| 群里 @ 了也不回 | 同上；看日志有没有 `群消息未 @ 我，跳过` |
| 连不上 WS | NapCat 的 WS 没开、端口不对、token 不一致 |
| 注入后 QQ 闪退 | QQ 版本与 NapCat 不匹配（见上） |
| 回复重复 | 同时跑了两个 `serve`，或 NapCat 配了多个 WS 客户端 |

## 验证它真的在记

```bash
node src/cli.ts stats            # tasks / memory / tokens
node src/cli.ts trace <task-id>  # 这次运行时间花在哪一层
node src/cli.ts tools            # 工具调用次数与成功率
```
