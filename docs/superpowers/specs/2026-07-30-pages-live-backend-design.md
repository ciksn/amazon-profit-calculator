# GitHub Pages 联网卡片设计

## 目标

以当前服务器实际部署版本对应的提交 `ee2bf4a` 为基线，生成并部署功能一致的 GitHub Pages 卡片页面。飞书文档继续内嵌 `github.io` 地址，页面数据与分析请求发送到 `https://www.200392.xyz`，避免使用落后的纯静态 Pages 功能集。

## 边界

- 不合并或修改其他正在开发的分支。
- 不替换服务器端 Node.js、PostgreSQL 或 AI 服务。
- GitHub Pages 的完整站点仍保持现有纯静态模式；只有 `embed.html` 卡片入口使用线上 API。
- 后端地址由构建环境变量显式提供，仓库不保存密钥。
- Pages 部署从隔离分支触发 GitHub Actions，不要求先合并到 `main`。

## 架构

`scripts/build_github_pages.mjs` 继续生成完整静态站点，同时为卡片入口生成专用配置文件。该配置设置 `window.MARGINGO_API_BASE` 并关闭 `window.MARGINGO_STATIC_MODE`。`docs/embed.html` 只加载联网配置和正式 `embed.js`，不加载浏览器静态 API 适配器；其他 Pages 页面继续加载原来的 `config.js`、`profit-engine.js` 和 `static-api.js`。

构建脚本要求通过 `MARGINGO_PAGES_API_BASE` 提供 HTTPS API 根地址。缺失、非 HTTPS 或带路径的地址会导致构建失败，避免误发布一个表面成功但无法联网的卡片。

服务器需把精确 Pages Origin `https://ciksn.github.io` 加入 `CORS_ORIGINS`。现有服务端已经支持按 Origin 白名单返回 CORS 响应头，因此不修改服务器代码，只补充部署说明与发布前检查。

## 验证

- 自动化测试覆盖联网配置生成、静态适配器不注入卡片、普通 Pages 页面仍保持静态模式，以及非法 API 地址拒绝构建。
- 运行全量 `npm test`。
- 生成 `docs/` 后检查 `docs/embed.html` 和专用配置内容。
- 部署后请求 GitHub Pages 的 `embed.html`，并从 Pages Origin 对线上 `/api/health` 发起 CORS 预检检查。

## 发布

把隔离分支推送到 GitHub，使用 `workflow_dispatch` 在该分支运行 `.github/workflows/deploy-pages.yml`。工作流构建步骤注入 `MARGINGO_PAGES_API_BASE=https://www.200392.xyz`，成功后 GitHub Pages 即更新为本次隔离分支生成的内容。
