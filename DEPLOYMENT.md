# 前后端生产交付与部署

本项目是同域部署：Node 服务同时提供完整计算页面、卡片版、小站点卡片版、规则管理页面和全部 API；业务数据统一存储在 PostgreSQL。交付包不包含对原 GitHub Pages 线上版本的发布操作。

## 页面入口

- `/`：完整计算页面和规则管理
- `/embed.html`：卡片版（含竞品、Excel 导入、卖点分析、日本税项）
- `/site-card.html`：小站点卡片版（含 PostgreSQL 方案记录）
- `/api/health`：应用与数据库健康检查

## 推荐部署：Docker Compose

服务器准备 Docker Engine、Docker Compose、域名和 HTTPS 证书。把整个项目目录交付到服务器后：

1. 将 `deploy/.env.production.example` 复制为 `deploy/.env.production`，设置随机 PostgreSQL 密码、`GEMINI_API_KEY_ENCRYPTED` 和 `GEMINI_KEY_ENCRYPTION_KEY`。
2. 解密主密钥优先通过云平台 Secret、CI/CD Secret 或服务器受限环境变量注入；不得提交到 Git。
3. 在项目根目录执行：

   ```bash
   docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml up -d --build
   ```

4. 检查 `http://127.0.0.1:4173/api/health` 返回 `{"ok":true,"database":"postgresql"}`。
5. 将 `deploy/nginx.conf` 中的域名改为实际域名，启用 Nginx，并使用 Certbot 或云负载均衡配置 HTTPS。
6. 这是内部业务工具，正式公网开放前应在 Nginx、零信任网关或公司 SSO 层增加身份验证和访问控制。

Compose 中 PostgreSQL 使用命名卷 `postgres_data` 持久化；删除容器不会删除卷。不要使用 `docker compose down -v`，该参数会删除数据库卷。

## 使用已有托管 PostgreSQL

如果云上已有 PostgreSQL，可只运行应用容器，并设置：

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
PGSSL=require
NODE_ENV=production
PORT=4173
GEMINI_API_KEY_ENCRYPTED=...
GEMINI_KEY_ENCRYPTION_KEY=...
```

数据库账号需要对目标 schema 具备建表、建索引、查询和增删改权限。应用启动时会幂等创建或升级表结构，并为旧项目补齐数据库分享标识。

## 不使用 Docker

安装 Node.js 22 和 PostgreSQL 14 以上版本，在服务器项目目录执行：

```bash
npm ci --omit=dev
npm start
```

推荐使用 systemd、PM2 或云平台进程管理保持应用运行。无论运行一个还是多个 Node 实例，都必须指向同一个 PostgreSQL；不需要 Redis、共享磁盘或粘性会话。

## 数据迁移与备份

首次打开小站点卡片版时，若当前浏览器存在旧版 `margingo-site-card-records-v1` 方案记录，页面会逐条写入 PostgreSQL；全部成功后删除浏览器旧数据。迁移前可先做浏览器配置备份，迁移后用不同浏览器登录同一地址核对记录。

上线前和每次升级前备份：

```bash
pg_dump --format=custom --file=margingo.backup "$DATABASE_URL"
```

恢复到空数据库：

```bash
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" margingo.backup
```

建议启用云数据库自动备份和时间点恢复，并定期验证备份可恢复。

## 发布检查

```bash
npm test
npm run test:coverage
```

随后依次打开三个页面，验证项目修改互相可见、规则保存后重新计算、竞品分析结果重启后仍存在、小站点方案记录在另一浏览器可读取。不要执行 `npm run build:pages`，以免生成新的静态 Pages 文件并混淆原线上版本。

