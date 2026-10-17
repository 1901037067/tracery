# Tracery 同步服务端

Tracery 的自托管同步中心。零依赖、单文件、只存数据和版本清单 —— 放在 NAS、树莓派、一台旧笔记本上都能跑。

```bash
npx tracery-sync                 # 0.0.0.0:9600，数据在 ~/.tracery-sync
npx tracery-sync --port 9600 --data /volume1/tracery --name 家里的NAS
```

启动后会打印：

```
  Tracery 同步服务端已启动
  服务名     家里的NAS
  数据目录   /volume1/tracery/<vaultId>
  配对码     ABCD-EFGH
  地址       http://192.168.1.10:9600
```

把**地址**和**配对码**填进客户端「设置 → 同步」即可。配对码只用于第一次换 token，之后每台设备用自己的 token。

## 数据存在哪

```
<data>/config.json                服务端身份、配对码、已配对设备 token
<data>/<vaultId>/manifest.json    { version, files: { 相对路径: { sha, size, mtime } } }
<data>/<vaultId>/blobs/<sha256>   文件内容（同内容只存一份）
<data>/<vaultId>/uploads/<id>/   分块上传的临时会话（24h 过期自动清理）
```

- 文件按 **sha256 内容寻址**，改一个字就是一个新 blob（旧 blob 暂时保留，便于其他设备回滚）
- 服务端不理解 Markdown、不解析双链，只保证「这台设备说路径 P 的内容是 sha S」这件事被如实记录
- 提交带 `baseVersion` 校验，两台设备同时提交时后到的会收到 409 并自动重试，不会静默覆盖

## 备份

直接复制 `<data>` 目录即可。要恢复，把目录放回去、用同一份 `config.json` 启动，客户端 token 继续有效。

## 部署示例

**systemd（Linux）**

```ini
[Unit]
Description=Tracery Sync
After=network.target

[Service]
ExecStart=/usr/bin/npx tracery-sync --data /var/lib/tracery-sync --port 9600
Restart=always
User=tracery

[Install]
WantedBy=multi-user.target
```

**Docker**

```dockerfile
FROM node:22-alpine
RUN npm i -g tracery-sync
VOLUME /data
EXPOSE 9600
CMD ["tracery-sync", "--data", "/data", "--port", "9600"]
```

```bash
docker build -t tracery-sync .
docker run -d -p 9600:9600 -v tracery-sync:/data --name tracery-sync tracery-sync
```

## 安全说明（v1 的边界，别当成已解决）

- **传输明文**：v1 走 HTTP。局域网自用可以；暴露到公网请放在 Caddy/Nginx 后面加 HTTPS，或者只通过 WireGuard/Tailscale 访问
- **服务端能看到内容**：v1 服务端存的是明文 blob。端到端加密（客户端加密后再上传，服务端只看到密文和 HMAC 后的路径）是路线图里的 v3，协议已经按这个方向设计，加的时候不用改接口
- **配对码等于管理员密码**：拿到配对码即可配对。配对完可以把配对码换掉（删除 `config.json` 里的 `pairCode` 后重启会重新生成）

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 服务名、vaultId、当前版本 |
| POST | `/api/pair` | 配对码 | `{code, deviceName}` → `{token}` |
| GET | `/api/manifest` | token | 全量清单 |
| GET | `/api/blob/:sha` | token | 下载内容（支持 `Range`，206 断点续传） |
| PUT | `/api/blob/:sha` | token | 小文件上传（校验哈希） |
| POST | `/api/upload/init` | token | `{sha,size}` → 建分块会话；已有 blob 直接返回 `done` |
| GET | `/api/upload/:id` | token | 查询已收到的分块序号（断点续传） |
| PUT | `/api/upload/:id/:index` | token | 上传第 index 块（1MB） |
| POST | `/api/upload/:id/complete` | token | 拼装 + 校验 sha256 |
| POST | `/api/commit` | token | `{baseVersion, changes[]}` → `{version}` |

清单版本号单调递增。客户端只在 `baseVersion` 与服务器一致时提交，因此一台设备不会覆盖另一台刚推上来的内容。
