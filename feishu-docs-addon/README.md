# MarginGo 飞书云文档小组件

小组件使用飞书云文档 `Record` 保存测算绑定，并记录所在文档 `docToken` 与组件 `blockId`。模板被复制后上下文发生变化，小组件会自动创建新的空白测算实例，不会复用原文档数据。

## 开放平台准备

1. 在飞书开放平台创建企业自建应用，并添加“云文档小组件”能力。
2. 把应用的 App ID 和小组件 BlockTypeID 填入 `app.json`。
3. 在应用安全设置中，把 MarginGo 服务域名加入请求/iframe 相关白名单。
4. 应用可用范围应覆盖模板使用者。

上传工具要求 `opdev >= 3.3.0`。公开 npm 版构建辅助包当前依赖未公开模块，因此本项目直接生成与其一致的 `project.config.json` 和 `index.json`，上传仍交给官方 `opdev`。

## 本地调试

```powershell
npm install
npm install -g @lark-opdev/cli@latest
opdev login
$env:MARGINGO_EMBED_URL='https://你的域名/embed.html'
npm run build
npm run upload
```

MarginGo 服务必须使用 HTTPS，并在飞书应用后台配置为安全域名。上传测试版本后，把小组件插入测试文档验证。

## 构建与上传

```powershell
$env:MARGINGO_EMBED_URL='https://你的正式域名/embed.html'
npm run test
npm run build
npm run upload
```

上传后在开放平台选择新版本并发布。选品模板中插入这个小组件即可，不再放置普通网页卡片链接。
