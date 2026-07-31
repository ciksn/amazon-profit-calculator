'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');

test('选品工作台包含五个章节、固定摘要和保存状态',()=>{
  const html=read('public/selection-document.html');
  for(const text of ['选品概览','站点机会','竞品洞察','供应商决赛','风险与自查'])assert.match(html,new RegExp(text));
  for(const id of ['decisionStatus','bestSiteMetric','targetMarginMetric','preferredSupplierMetric','completionMetric','saveState']) {
    assert.match(html,new RegExp(`id="${id}"`));
  }
});

test('选品页面脚本包含销量和澳洲 AUD、其他站点 USD 的竞品列',()=>{
  const script=read('public/selection-document.js');
  assert.match(script,/月销量/);
  assert.match(script,/country_code==='AU'/);
  assert.match(script,/selection_revenue/);
  assert.match(script,/AUD/);
  assert.match(script,/USD/);
});

test('主品类卡片提供选品文档入口',()=>{
  const script=read('public/app.js');
  assert.match(script,/selection-document\.html\?project=\$\{project\.id\}/);
  assert.match(script,/>选品文档</);
});

test('静态构建同步选品页面资源并提供独立持久化存储',()=>{
  const build=read('scripts/build_github_pages.mjs');
  const staticApi=read('pages-src/static-api.js');
  assert.match(build,/selection-document\.css/);
  assert.match(build,/selection-document\.js/);
  assert.match(build,/selection-document\.html/);
  assert.match(build,/selection-ai\.css/);
  assert.match(build,/selection-ai\.js/);
  assert.match(staticApi,/margingo-selection-documents-v1/);
  assert.match(staticApi,/selection-document/);
  assert.match(staticApi,/selection-suppliers/);
  assert.match(staticApi,/AI_BACKEND_REQUIRED/);
  assert.match(staticApi,/targetUrl\.origin !== location\.origin/);
  assert.match(staticApi,/validateSelectionDocument\(readBody\(options\)\)/);
  assert.match(staticApi,/validateSelectionSite\(readBody\(options\)\)/);
  assert.match(staticApi,/validateSelectionSupplier\(readBody\(options\),true\)/);
  assert.match(staticApi,/max:100/);
});
