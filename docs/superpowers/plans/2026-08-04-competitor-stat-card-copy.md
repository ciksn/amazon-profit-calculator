# Competitor Stat Card Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each populated competitor country-stat card copy `前三平均销售额USD/前三平均利润率%`, for example `1,085,439USD/64.8%`, in both server and GitHub Pages deployments.

**Architecture:** Keep `public/embed.js` as the source of truth. Extract the single-card display values into a small helper used by rendering and copying, add delegated pointer and keyboard handling to the existing statistics container, then use the existing Pages build to copy source assets into `docs`.

**Tech Stack:** Browser JavaScript, CSS, Node.js built-in test runner, existing clipboard and toast helpers, GitHub Pages build script.

## Global Constraints

- Copy exactly one plain-text line in the form `1,085,439USD/64.8%`.
- Sales revenue uses thousands separators and zero decimal places; profit rate uses one decimal place.
- The whole populated country card must support click, Enter, and Space.
- Keep the existing bulk “复制统计” button unchanged.
- Server (`public`) and GitHub Pages (`docs`) behavior must match.

---

### Task 1: Specify the card-copy behavior

**Files:**
- Create: `test/competitor-stat-card-copy-ui.test.js`
- Test: `test/competitor-stat-card-copy-ui.test.js`

**Interfaces:**
- Consumes: generated markup and event bindings in `public/embed.js`, interactive styles in `public/embed.css`.
- Produces: regression checks for `competitorStatValues(rows)`, `copyCompetitorStat(code)`, `data-copy-competitor-stat`, card accessibility attributes, delegated click/keyboard handlers, and focus styling.

- [ ] **Step 1: Write the failing test**

```js
'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const js=fs.readFileSync(path.join(root,'public','embed.js'),'utf8');
const css=fs.readFileSync(path.join(root,'public','embed.css'),'utf8');

test('competitor country cards expose copy data and keyboard button semantics',()=>{
  assert.match(js,/data-copy-competitor-stat="\$\{country\.code\}"/);
  assert.match(js,/role="button"/);
  assert.match(js,/tabindex="0"/);
  assert.match(js,/aria-label="复制 \$\{marketCode\(country\.code\)\} 站竞品统计"/);
});

test('single-card copy uses integer USD revenue and one-decimal profit rate',()=>{
  assert.match(js,/function competitorStatValues\(rows\)/);
  assert.match(js,/number\(averageRevenueUsd,0\)/);
  assert.match(js,/`\$\{values\.revenue\}USD\/\$\{values\.profit\}%`/);
  assert.match(js,/function copyCompetitorStat\(code\)/);
});

test('statistics container delegates click Enter and Space to card copy',()=>{
  assert.match(js,/\$\('#competitorStats'\)\.onclick=/);
  assert.match(js,/\$\('#competitorStats'\)\.onkeydown=/);
  assert.match(js,/event\.key==='Enter'\|\|event\.key===' '/);
});

test('copyable cards communicate pointer and keyboard focus',()=>{
  assert.match(css,/\.competitor-stat\[data-copy-competitor-stat\][^{]*\{/);
  assert.match(css,/cursor:pointer/);
  assert.match(css,/\.competitor-stat\[data-copy-competitor-stat\]:focus-visible/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/competitor-stat-card-copy-ui.test.js`

Expected: FAIL because the card data attribute, helper functions, delegated handlers, and interactive styles do not exist.

### Task 2: Implement accessible single-card copying

**Files:**
- Modify: `public/embed.js:228-240, 500-525`
- Modify: `public/embed.css:43-48`
- Test: `test/competitor-stat-card-copy-ui.test.js`

**Interfaces:**
- Consumes: `number(value, decimals)`, `writeRows(rows)`, `toast(message)`, `marketCode(code)`, and `state.competitors`.
- Produces: `competitorStatRows(code): object[]`, `competitorStatValues(rows): {sales:string,revenue:string,profit:string,divisor:number}`, and `copyCompetitorStat(code): Promise<void>`.

- [ ] **Step 1: Add the minimal shared statistics helpers and copy function**

```js
function competitorStatRows(code){
  return state.competitors.filter((item)=>item.country_code===code&&String(item.name||'').trim()&&Number(item.sale_price)>0&&item.profit_rate!=null).slice(0,3);
}
function competitorStatValues(rows){
  const divisor=rows.length;
  return {
    divisor,
    sales:number(rows.reduce((sum,item)=>sum+Number(item.monthly_sales),0)/divisor,0),
    revenue:number(rows.reduce((sum,item)=>sum+Number(item.monthly_revenue_usd),0)/divisor,0),
    profit:number(rows.reduce((sum,item)=>sum+Number(item.profit_rate),0)/divisor,1)
  };
}
async function copyCompetitorStat(code){
  const rows=competitorStatRows(code);if(!rows.length)throw new Error('暂无可复制的竞品统计');
  const values=competitorStatValues(rows);
  await writeRows([[`${values.revenue}USD/${values.profit}%`]]);
  toast(`已复制 ${marketCode(code)} 站竞品统计`);
}
```

- [ ] **Step 2: Render each populated card with shared values and button semantics**

Replace the inline average calculations in `renderCompetitorStats()` with `competitorStatRows(country.code)` and `competitorStatValues(firstThree)`, then render the opening card tag as:

```js
<div class="competitor-stat" data-copy-competitor-stat="${country.code}" role="button" tabindex="0" aria-label="复制 ${marketCode(country.code)} 站竞品统计">
```

Use `values.sales`, `values.revenue`, `values.profit`, and `values.divisor` for all displayed statistics so copied and displayed values follow the same rounding rules.

- [ ] **Step 3: Bind delegated mouse and keyboard activation**

Add to `bind()`:

```js
$('#competitorStats').onclick=(event)=>{
  const card=event.target.closest('[data-copy-competitor-stat]');
  if(!card||event.target.closest('button,a,input,select,textarea'))return;
  copyCompetitorStat(card.dataset.copyCompetitorStat).catch((error)=>toast(error.message));
};
$('#competitorStats').onkeydown=(event)=>{
  const card=event.target.closest('[data-copy-competitor-stat]');
  if(!card||event.target!==card||(event.key!=='Enter'&&event.key!==' '))return;
  event.preventDefault();
  copyCompetitorStat(card.dataset.copyCompetitorStat).catch((error)=>toast(error.message));
};
```

- [ ] **Step 4: Add interactive card styling**

```css
.competitor-stat[data-copy-competitor-stat]{cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}
.competitor-stat[data-copy-competitor-stat]:hover{border-color:#9ed8bf;box-shadow:0 4px 14px rgba(16,124,82,.1);transform:translateY(-1px)}
.competitor-stat[data-copy-competitor-stat]:focus-visible{outline:3px solid rgba(16,124,82,.2);outline-offset:2px;border-color:#5fbd97}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `node --test test/competitor-stat-card-copy-ui.test.js`

Expected: PASS with four passing subtests.

- [ ] **Step 6: Commit the tested source implementation**

```powershell
git add -- test/competitor-stat-card-copy-ui.test.js public/embed.js public/embed.css
git commit -m "feat: copy individual competitor stat cards"
```

### Task 3: Synchronize and verify both deployments

**Files:**
- Modify (generated): `docs/embed.js`
- Modify (generated): `docs/embed.css`
- Verify: `public/embed.js`, `public/embed.css`, `docs/embed.js`, `docs/embed.css`

**Interfaces:**
- Consumes: tested source assets from Task 2 and `scripts/build_github_pages.mjs`.
- Produces: identical server and GitHub Pages card-copy behavior.

- [ ] **Step 1: Build the GitHub Pages assets**

Run: `npm run build:pages`

Expected: exit code 0 and a summary beginning with `GitHub Pages`.

- [ ] **Step 2: Verify generated assets match source assets**

Run:

```powershell
if ((Get-FileHash public/embed.js).Hash -ne (Get-FileHash docs/embed.js).Hash) { throw 'embed.js mismatch' }
if ((Get-FileHash public/embed.css).Hash -ne (Get-FileHash docs/embed.css).Hash) { throw 'embed.css mismatch' }
```

Expected: exit code 0 with no mismatch error.

- [ ] **Step 3: Run focused and full regression tests**

Run: `npm test`

Expected: exit code 0 and all tests pass.

- [ ] **Step 4: Review generated diff and whitespace**

Run: `git diff --check` and `git diff -- public/embed.js public/embed.css docs/embed.js docs/embed.css test/competitor-stat-card-copy-ui.test.js`

Expected: no whitespace errors; diff is limited to the card-copy feature and generated Pages synchronization.

- [ ] **Step 5: Commit the GitHub Pages synchronization**

```powershell
git add -- docs/embed.js docs/embed.css
git commit -m "build: sync competitor card copy to pages"
```
