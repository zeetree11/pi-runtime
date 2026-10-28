---
name: deploy-check
description: 部署或更新 pi-runtime 到服务器时使用。四步固定流程：构建、重启、验证、可回滚。禁止跳过验证。
---

# 部署 pi-runtime

## 0. 先确认要部署的是什么

```bash
git log --oneline -1
git status --short    # 必须是干净的
```

工作区不干净时**不要部署**：线上跑的和仓库里的不是同一份代码，出问题时无法复现。

## 1. 构建

```bash
cd /opt/pi-runtime
docker build -f deploy/Dockerfile -t pi-runtime:latest .
```

构建失败就停。**不要用旧镜像继续重启**——那会让人以为部署成功了。

## 2. 重启

```bash
docker rm -f pi-rt pi-rt-qq
docker run -d --name pi-rt ... node src/cli.ts serve --channel feishu
docker run -d --name pi-rt-qq ... node src/cli.ts serve --channel qq --no-maintenance
```

两个容器的关键参数必须一致：

| 参数 | 值 | 少了会怎样 |
|---|---|---|
| `--env-file` | `/srv/pi-rt/env/pi-rt.env` | 没有 API key |
| `-e HOME=/data` | 必须 | pi 找不到 `mcp.json` |
| `-v /srv/pi-rt/data2:/data` | 必须 | 记忆和任务全丢（空库） |
| `--network pi-rt-net` | 仅 QQ | 连不上 snowluma |

## 3. 验证（不可跳过）

```bash
docker ps --format '{{.Names}} {{.Status}}'        # 两个 Up
docker logs pi-rt --tail 5                          # 有 long connection established
docker exec pi-rt node node_modules/.bin/pi mcp list | grep -E '^(fetch|memory|fanout|knowledge)'
curl -s http://127.0.0.1:8899/health  # 容器内
```

**四条都过才算部署成功。** 缺一条就是"起来了但没工作"。

## 4. 回滚

```bash
docker run -d --name pi-rt <上一条命令，镜像标签换成上一个版本>
```

所以**部署前必须先 tag 当前镜像**：

```bash
docker tag pi-runtime:latest pi-runtime:prev
```

## 常见失败

| 现象 | 原因 |
|---|---|
| `No API key found for deepseek` | 只挂了 persona，没挂整个 `pi/` 目录（`-e HOME=/data` 缺失） |
| `ERR_MODULE_NOT_FOUND /app/mcp/...` | Dockerfile 没 `COPY mcp ./mcp` |
| QQ 显示「等待登录」 | snowluma 登录态没持久化 |
| 记忆是空的 | 挂载路径写成了 `/srv/pi-rt/data`（旧的）而不是 `data2` |
