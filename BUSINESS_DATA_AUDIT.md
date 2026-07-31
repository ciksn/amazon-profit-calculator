# 业务数据 PostgreSQL 交付审计

审计日期：2026-07-21

## 结论

后端交付版的业务数据唯一持久化来源为 PostgreSQL。应用不使用 Redis、SQLite、本地 JSON、浏览器 localStorage、sessionStorage、IndexedDB 或服务进程内存保存业务数据，因此可以运行多个应用实例并共享同一个 PostgreSQL，无需粘性会话。

`docs/` 是原 GitHub Pages 静态版本，按交付要求保持独立，不属于本次后端版部署产物。生产镜像只从该目录复制初始化规则所需的 `docs/data/`，不会发布其中的页面。

## 数据归属

| 业务数据 | PostgreSQL 表 | 页面/功能 |
| --- | --- | --- |
| 品类、成本、尺寸、重量、图片、分享标识 | `projects` | 完整计算页、卡片版、小站点卡片版 |
| 站点选择、售价、佣金覆盖、日本税项 | `project_countries` | 三套计算页面 |
| 竞品、Excel 导入字段、独立成本参数 | `project_competitors` | 卡片版 |
| 竞品五点、卖点、差异化和分析状态 | `project_competitors` | 卡片版卖点分析 |
| 小站点方案记录和冻结计算快照 | `site_card_records` | 小站点卡片版 |
| 国家、佣金、尺寸、FBA、头程规则 | `countries`、`commission_rules`、`size_tiers`、`fba_rules`、`freight_rules` | 规则管理和全部计算页 |
| 初始化版本信息 | `app_meta` | 数据库初始化 |

## 浏览器与内存检查

- `public/` 中没有业务数据写入 localStorage。`site-card.js` 只保留旧版方案记录的一次性迁移读取：导入 PostgreSQL 成功后立即删除旧键，不再用于后续读写。
- 页面中的 `Map`、计时器、表单草稿和当前渲染状态只用于防抖、请求去重及显示；刷新后均以 PostgreSQL API 为准。
- 页面间即时刷新使用 `BroadcastChannel` 通知；它不承载或保存业务数据。窗口重新获得焦点时会再次从 PostgreSQL 读取。
- 分享链接的稳定标识为 `projects.share_key`，不再由浏览器维护链接到项目 ID 的映射。
- 后端没有业务对象缓存。`lib/japan-tariff.js` 的短时内存项仅加速公共日本税则参考资料读取，不含用户、项目或计算结果，不参与一致性判断；实例失效不会丢失业务数据。

## 多实例一致性

- 所有写入在响应成功前已经提交到 PostgreSQL。
- 任意应用实例均可读取完整业务状态；实例重启或扩缩容不丢数据。
- 无需 Redis、共享文件盘或浏览器缓存同步。
- 数据库应使用单一主库或具备一致写入语义的托管 PostgreSQL；所有实例配置同一个 `DATABASE_URL`。

## 排除项

- 原 GitHub Pages 版故意保留纯静态浏览器存储方案，未被本次改动覆盖，也不应执行 `npm run build:pages` 后覆盖原线上版本。
- 图片字段目前随项目记录保存于 PostgreSQL 的 `image_data`。若未来图片量显著增长，可另行迁移到对象存储，但数据库仍保存其业务引用。

