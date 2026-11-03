# 部署到阿里云

## 选型：**轻量应用服务器**（不是函数计算）

这个进程是**有状态长驻**的：SQLite、飞书长连接、后台定时器、本地文件。函数计算（FC）跑不了长连接、没有持久磁盘、没有常驻定时器，所以不适用。

| 项 | 建议 |
|---|---|
| 产品 | 轻量应用服务器 或 ECS |
| 规格 | 2 vCPU / 2 GB（模型推理在远端，本机只跑编排和 pi 子进程） |
| 系统 | Ubuntu 24.04 |
| 磁盘 | 40 GB（数据目录很小，主要给系统） |
| 带宽 | 1–3 Mbps 足够（长连接只有心跳和少量 JSON） |
| 地域 | 就近（cn-hangzhou / cn-shanghai） |
| 安全组 | **不需要开放任何入站端口** |

## 为什么用长连接而不是 webhook

飞书长连接是**纯出站** WebSocket。这意味着：

- 不需要公网 IP、不需要域名、不需要 HTTPS 证书
- 不需要 ICP 备案（没有对外 Web 服务）
- 不需要在安全组开 80/443

webhook 模式必须在公网暴露一个 HTTPS 端点，还要验签、要证书、要备案。个人助理没有理由付这个成本。

## 部署（Docker，推荐）

```bash
# 1. 装 Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

# 2. 取代码
git clone https://github.com/zeetree11/Tree-Agent.git /opt/pi-runtime
cd /opt/pi-runtime

# 3. 配置（唯一含密钥的文件，权限 600）
sudo mkdir -p /srv/pi-rt/data /srv/pi-rt/workspace
sudo cp deploy/env.example deploy/.env
sudo chmod 600 deploy/.env
sudo vim deploy/.env          # 填 FEISHU_APP_ID / SECRET / PI_RT_OWNER_IDS / 模型

# 4. 让 pi 拿到模型凭证（写进数据卷，容器重建不丢）
docker run --rm -it -v /srv/pi-rt/data:/data \
  --entrypoint node pi-runtime:latest \
  node_modules/@earendil-works/pi-coding-agent/dist/cli.js auth login
# 若交互不便：在本地已完成授权的机器上，把 ~/.pi 整个目录拷到 /srv/pi-rt/data/pi

# 5. 起服务
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

看到 `feishu long connection starting` 之后，在飞书里给 bot 发一条消息即可。

## 部署（裸机，不用 Docker）

```bash
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
sudo useradd -r -m -d /opt/pi-runtime piagent
sudo git clone https://github.com/zeetree11/Tree-Agent.git /opt/pi-runtime
cd /opt/pi-runtime && sudo npm ci --omit=dev
sudo install -m 600 deploy/env.example /etc/pi-rt.env && sudo vim /etc/pi-rt.env
sudo install -m 644 deploy/pi-rt.service /etc/systemd/system/pi-rt.service
sudo systemctl daemon-reload && sudo systemctl enable --now pi-rt
journalctl -u pi-rt -f
```

## 上线后必须做的三件事

```bash
# 1. 自检（pi 可用、模型可用、配置正确）
docker exec pi-rt node src/cli.ts doctor

# 2. 只给一个群/私聊用，避免陌生人消耗预算
#    /etc/pi-rt.env → FEISHU_CHAT_ALLOW=oc_xxx
docker exec pi-rt node src/cli.ts sandbox     # 确认模式与工作区

# 3. 备份要出机器
#    本地 data/backups 每天自动生成；再同步到 OSS，机器挂了才不丢
```

OSS 同步示例（可选，用 ossutil 或 aliyun-cli）：

```bash
0 4 * * * ossutil cp -r /srv/pi-rt/data/backups oss://your-bucket/pi-rt/ --update
```

## 成本

| 项 | 估算 |
|---|---|
| 轻量应用服务器 2C2G | ¥24–60 / 月（新用户常有优惠） |
| 磁盘/流量 | 包含在套餐内 |
| 模型 token | 按量；日常私聊量级约 ¥1–10 / 月（deepseek-flash） |
| OSS 备份 | 几毛钱 / 月（压缩后几十 KB） |

## 已知限制（上线前必须知道）

1. **单实例**：SQLite + 一条长连接，不能水平扩容。两个副本会开两条连接、写两个库。
2. **无入站健康检查**：长连接模式没有 HTTP 端口，健康靠 Docker healthcheck（`pi-rt doctor`）和日志。
3. **凭证在文件里**：`/srv/pi-rt/data/pi` 存模型凭证，`deploy/.env` 存飞书 secret。两者都要 600 权限，且**不要进 git**（`.gitignore` 已含 `data/`、`config.json`）。
4. **重启会中断对话**：进行中的任务会失败；已完成的记忆和事件不受影响（WAL + 事务）。
5. **沙箱在容器里才真正生效**：裸机部署时 `safe` 只是关掉 shell 工具，agent 仍能读你用户可读的文件。

## 安全

- `deploy/.env` 含真实密钥，已在 `.gitignore` 中，**永远不要提交**。
- 推送前跑一次 `node scripts/leakscan.mjs`：它按“形状”扫描工作区与历史，找 IP、open_id、token、私钥、赋值式密码；测试夹具和占位符会自动豁免。
- 服务器密码若曾出现在任何文本里，立刻 `passwd` 更换，并改用 SSH 密钥登录（`PasswordAuthentication no`）。
