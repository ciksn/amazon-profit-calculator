# Similar Competitor Selling Points and Review Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 兼容 Amazon 新版 Top Reviews 页面结构，并为卡片版同款竞品增加隔离的卖点分析与完整复制列。

**Architecture:** 评论修复保持在独立的 `lib/review-analysis.js` 中，仅扩展新旧 DOM selector。卖点分析复用现有 `lib/competitor-analysis.js`，由 `server.js` 根据路由映射 `standard/similar` 类型；前端复用现有状态、手动补充弹窗和文本展示函数，不复制业务逻辑。

**Tech Stack:** Node.js 22、Cheerio、原生 HTTP server、PostgreSQL、Gemini、原生 JavaScript/CSS、Node test runner、Docker Compose。

## Global Constraints

- 只读取 Amazon 商品详情页公开 Top Reviews，不进入全部评论页、不绕过登录或验证码。
- Top Reviews 按评论 ID 或规范化正文去重，最多保存 10 条。
- 普通竞品和同款竞品的数据、分析查询和失败重试严格隔离。
- A+ 和视频只加入同款复制结果，不增加页面表格列。
- 卖家精灵有 A+/视频数据时输出“是/否”；H10 没有对应数据时输出空白。
- 同款复制列固定为：图片、链接、是否有 A+、是否有视频、售价、销售额、利润率、上架时间、评分、评价数量、卖点分析、评论优点、评论缺点。
- 部署目标为韩国 Docker 服务器；部署前必须备份 PostgreSQL。

---

### Task 1: 兼容 Amazon 新版 Top Reviews DOM

**Files:**
- Modify: `test/competitor-review-analysis.test.js`
- Modify: `lib/review-analysis.js:39-50`

**Interfaces:**
- Consumes: `extractTopReviews(html, { limit })`
- Produces: 同时支持 `review-body/review-title` 与 `reviewText/reviewTitle` 的结构化评论数组。

- [ ] **Step 1: 写入新版 HTML 的失败测试**

在 `test/competitor-review-analysis.test.js` 新增：

```js
test('兼容 Amazon 新版 reviewText 和 reviewTitle 节点',()=>{
  const reviews=extractTopReviews(`
    <div data-hook="review" id="R-NEW-1">
      <span data-hook="review-star-rating">4.0 out of 5 stars</span>
      <a data-hook="reviewTitle">Works quickly</a>
      <span data-hook="reviewText">Removed creases in one pass.</span>
      <span data-hook="review-date">Reviewed on July 24, 2026</span>
    </div>`);
  assert.equal(reviews.length,1);
  assert.equal(reviews[0].title,'Works quickly');
  assert.equal(reviews[0].body,'Removed creases in one pass.');
});
```

- [ ] **Step 2: 运行测试并确认因正文 selector 缺失而失败**

Run: `node --test test/competitor-review-analysis.test.js`

Expected: FAIL，`reviews.length` 为 `0`。

- [ ] **Step 3: 最小化扩展 selector**

在 `lib/review-analysis.js` 中修改：

```js
const body=cleanText(root.find('[data-hook="review-body"], [data-hook="reviewText"]').first().text(),4000);
const titleText=root.find('[data-hook="review-title"], [data-hook="reviewTitle"]').first().text();
```

标题继续移除星级文本并经过 `cleanText(...,500)`，其余字段和安全限制不变。

- [ ] **Step 4: 运行评论分析测试**

Run: `node --test test/competitor-review-analysis.test.js`

Expected: PASS，新旧页面结构均可解析。

- [ ] **Step 5: 提交评论解析修复**

```powershell
git add -- lib/review-analysis.js test/competitor-review-analysis.test.js
git commit -m "fix: support current Amazon review markup"
```

---

### Task 2: 为同款竞品增加隔离的卖点分析接口

**Files:**
- Modify: `test/api.test.js`
- Modify: `server.js:483-513`

**Interfaces:**
- Consumes: `POST /api/projects/:id/similar-competitors/analyze`，请求 `{ country_code, manual_rows? }`
- Produces: 与普通竞品分析相同的 `{ analyzed,total,attempted,skipped,warnings,model }`，但只处理 `competitor_kind='similar'`。

- [ ] **Step 1: 写入同款卖点分析失败测试**

在现有 API 集成测试中导入 6 条同款竞品，替换 `competitorAnalysis.analyzeCompetitorBatch` 并断言：

```js
const response=await fetch(`${base}/api/projects/${created.id}/similar-competitors/analyze`,{
  method:'POST',
  headers:{'content-type':'application/json'},
  body:JSON.stringify({country_code:'JP'})
});
assert.equal(response.status,200);
assert.equal(receivedRows.length,5);
assert.ok(receivedRows.every((row)=>row.competitor_kind==='similar'));
assert.equal((await response.json()).attempted,5);
```

随后调用普通接口并断言普通、同款的 `selling_points` 不互相写入；再以 `manual_rows` 调用同款接口并断言只重试指定 ID。

- [ ] **Step 2: 运行 API 测试并确认 404**

Run: `npx cross-env NODE_ENV=test node --test test/api.test.js`

Expected: FAIL，同款 analyze 路由返回 `404`。

- [ ] **Step 3: 泛化现有分析路由**

将路由匹配改为：

```js
const competitorAnalyzeMatch=url.pathname.match(
  /^\/api\/projects\/(\d+)\/(competitors|similar-competitors)\/analyze$/
);
const kind=competitorAnalyzeMatch[2]==='similar-competitors'?'similar':'standard';
```

所有前五查询增加参数化类型：

```sql
SELECT * FROM project_competitors
WHERE project_id=$1 AND country_code=$2 AND competitor_kind=$3
ORDER BY monthly_revenue_local DESC,id LIMIT 5
```

复用现有 `manual_rows` ID 校验、已完成跳过、Gemini 调用及落库逻辑；落库继续同时校验 `id`、`project_id`，并确保所选 ID 来自本类型前五。

- [ ] **Step 4: 运行 API 测试**

Run: `npx cross-env NODE_ENV=test node --test test/api.test.js`

Expected: PASS，普通和同款各自只处理本类型前五。

- [ ] **Step 5: 提交接口改动**

```powershell
git add -- server.js test/api.test.js
git commit -m "feat: analyze selling points for similar competitors"
```

---

### Task 3: 同款表格卖点列、手动补充与复制列

**Files:**
- Modify: `test/embed-review-ui.test.js`
- Modify: `public/embed.js:3,240-252,307-371,515`
- Modify: `public/embed.css`
- Modify: `public/embed.html`

**Interfaces:**
- Consumes: Task 2 的同款 analyze API 和现有 `competitorAnalysisText(item)`。
- Produces: 同款卖点按钮、卖点表格列、类型化手动补充流程和 13 列复制数组。

- [ ] **Step 1: 写入前端静态行为失败测试**

扩展 `test/embed-review-ui.test.js`，断言源码包含：

```js
assert.match(script,/data-analyze-similar=/);
assert.match(script,/评价数量<\/th><th>卖点分析<\/th><th>评论分析/);
assert.match(script,/item\.product_url\|\|'',optionalYesNoLabel\(item\.has_aplus\),optionalYesNoLabel\(item\.has_video\)/);
assert.match(script,/competitorAnalysisText\(item\),reviewProsText\(item\),reviewConsText\(item\)/);
```

并断言 `optionalYesNoLabel(null)===''` 的实现文本存在，避免 H10 缺失值输出破折号。

- [ ] **Step 2: 运行前端测试并确认缺少同款卖点入口**

Run: `node --test test/embed-review-ui.test.js`

Expected: FAIL，找不到 `data-analyze-similar` 和卖点列。

- [ ] **Step 3: 泛化前端分析状态和手动补充类型**

在状态中增加：

```js
similarAnalyzingSiteCode:'',
manualAnalysisKind:'standard'
```

将以下函数增加 `kind='standard'` 参数并按类型选取数据及接口：

```js
analyzeCompetitors(code,kind='standard')
failedAnalysisRows(code,ids=null,kind='standard')
openManualAnalysis(code,rows,kind='standard')
submitManualAnalysis(event)
```

同款按钮调用 `analyzeCompetitors(code,'similar')`；手动弹窗提交到 `similar-competitors/analyze`，关闭时重置 `manualAnalysisKind`。

- [ ] **Step 4: 增加同款卖点列和复制映射**

同款表格在评价数量后插入：

```js
<td class="competitor-analysis" title="${escapeHtml(competitorAnalysisText(item))}">
  <span>${escapeHtml(competitorAnalysisText(item))}</span>
</td>
```

新增复制专用函数：

```js
function optionalYesNoLabel(value){
  return value==null?'':Number(value)?'是':'否';
}
```

同款复制数组固定为：

```js
[
  imageFormula,
  item.product_url||'',
  optionalYesNoLabel(item.has_aplus),
  optionalYesNoLabel(item.has_video),
  `${country.symbol}${number(item.sale_price,2)}`,
  `${country.symbol}${number(item.monthly_revenue_local,2)}`,
  item.profit_rate==null?'':`${number(item.profit_rate,1)}%`,
  item.listing_date||'',
  item.rating==null?'':number(item.rating,1),
  number(item.review_count,0),
  competitorAnalysisText(item),
  reviewProsText(item),
  reviewConsText(item)
]
```

- [ ] **Step 5: 调整同款表格宽度并运行前端测试**

为新增卖点列扩大 `.similar-table` 的最小宽度，并为第 9、10 列设置合理宽度；A+/视频不增加页面列。

Run: `node --test test/embed-review-ui.test.js`

Expected: PASS。

- [ ] **Step 6: 提交前端改动**

```powershell
git add -- public/embed.js public/embed.css public/embed.html test/embed-review-ui.test.js
git commit -m "feat: add similar competitor selling point UI"
```

---

### Task 4: 全量验证、静态构建与韩国服务器部署

**Files:**
- Regenerate: `docs/**`（由 `npm run build:pages` 生成）
- Deploy: `server.js`, `lib/review-analysis.js`, `public/embed.js`, `public/embed.css`, `public/embed.html`

**Interfaces:**
- Consumes: Tasks 1-3 的已验证源码。
- Produces: 通过测试的本地版本和健康的韩国 Docker 线上版本。

- [ ] **Step 1: 运行完整验证**

```powershell
npm.cmd test
npm.cmd run test:coverage
npm.cmd run build:pages
node --check lib/review-analysis.js
node --check server.js
node --check public/embed.js
git diff --check
```

Expected: 所有测试通过；覆盖率达到项目门槛；Pages 构建和语法检查退出码均为 `0`。

- [ ] **Step 2: 本地实看卡片版**

以 `NODE_ENV=test` 启动本地服务，导入一条同款竞品并检查：

- 同款操作区显示“卖点分析”。
- 表头顺序为“评价数量、卖点分析、评论分析”。
- A+/视频不显示在页面表格。

- [ ] **Step 3: 备份韩国 PostgreSQL**

```powershell
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$backup="margingo-before-similar-analysis-$stamp.dump"
ssh azure-profit-kr "mkdir -p /opt/margingo/backups && docker exec deploy-postgres-1 pg_dump -U margingo -d margingo -Fc > /opt/margingo/backups/$backup && test -s /opt/margingo/backups/$backup"
```

Expected: 备份文件存在且大小大于 `0`。

- [ ] **Step 4: 上传并校验服务文件**

使用 `scp` 上传 Task 4 列出的服务文件至 `/opt/margingo` 对应目录，逐个比较本地和远端 SHA-256。

Expected: 每个文件哈希一致。

- [ ] **Step 5: 重建应用容器**

```powershell
ssh azure-profit-kr "cd /opt/margingo && docker compose --env-file deploy/.env.production -f deploy/docker-compose.yml up -d --build app"
```

Expected: `deploy-app-1` 和 `deploy-postgres-1` 均为 `healthy`。

- [ ] **Step 6: 公网只读验证**

检查：

- `https://200392.xyz/api/health` 返回 PostgreSQL 健康。
- `embed.js` 包含 `data-analyze-similar`。
- 同款列表接口仍返回独立的同款数据。
- 不主动调用真实分析 POST，避免未经用户操作写入业务数据。
