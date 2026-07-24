'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const js=fs.readFileSync(path.join(root,'public','embed.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','embed.html'),'utf8');
const css=fs.readFileSync(path.join(root,'public','embed.css'),'utf8');

test('普通与同款竞品都提供评论分析按钮和 C 样式行内入口',()=>{
  assert.match(js,/data-review-analysis="standard:/);
  assert.match(js,/data-review-analysis="similar:/);
  assert.match(js,/查看总结 · \$\{[^}]+\}条 ›/);
  assert.match(js,/查看总结 · 链接读取 ›/);
  assert.match(css,/\.review-summary-link/);
  assert.doesNotMatch(css,/\.review-summary-link[^}]*background:\s*#[0-9a-f]{6}/i);
});

test('评论总览和逐品详情弹窗存在',()=>{
  assert.match(js,/前五评论总览/);
  assert.match(html,/id="reviewDetailModal"/);
  assert.match(html,/id="reviewDetailPros"/);
  assert.match(html,/id="reviewDetailCons"/);
  assert.match(html,/id="reviewDetailMeta"/);
});

test('复制结果把评论优点和评论缺点紧跟在卖点分析后',()=>{
  assert.match(js,/competitorAnalysisText\(item\),reviewProsText\(item\),reviewConsText\(item\)/);
  assert.match(js,/copySimilarTable[\s\S]*reviewProsText\(item\),reviewConsText\(item\)/);
});

test('同款式竞品提供卖点分析按钮并把卖点列放在评论分析前',()=>{
  assert.match(js,/data-analyze-similar="\$\{country\.code\}"/);
  assert.match(js,/评价数量<\/th><th>卖点分析<\/th><th>评论分析/);
  assert.match(js,/number\(item\.review_count,0\)\}<\/td>[\s\S]*competitorAnalysisText\(item\)[\s\S]*reviewSummaryCell\(item,'similar'\)/);
});

test('同款式复制严格输出包含可空 A+ 视频和卖点的 13 列',()=>{
  assert.match(js,/item\.product_url\|\|'',optionalYesNoLabel\(item\.has_aplus\),optionalYesNoLabel\(item\.has_video\)/);
  assert.match(js,/number\(item\.review_count,0\),competitorAnalysisText\(item\),reviewProsText\(item\),reviewConsText\(item\)/);
  assert.match(js,/function optionalYesNoLabel\(value\)\{return value==null\?'':Number\(value\)\?'是':'否'\}/);
});

test('同款式页面表头不展示 A+ 或视频列',()=>{
  const header=js.match(/<table class="similar-table"><thead><tr>(.*?)<\/tr><\/thead>/)?.[1]||'';
  assert.ok(header,'应找到同款式表头');
  assert.doesNotMatch(header,/>A\+</);
  assert.doesNotMatch(header,/>视频</);
});

test('普通与同款卖点分析全局互斥，避免共用手工补入弹窗互相覆盖',()=>{
  assert.match(js,/function sellingPointAnalysisBusy\(\)\{return Boolean\(state\.analyzingSiteCode\|\|state\.similarAnalyzingSiteCode\)\}/);
  assert.match(js,/if\(sellingPointAnalysisBusy\(\)\)return;state\[stateKey\]=code/);
  assert.match(js,/total&&!sellingPointAnalysisBusy\(\)/);
});
