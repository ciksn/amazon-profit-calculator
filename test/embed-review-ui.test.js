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
