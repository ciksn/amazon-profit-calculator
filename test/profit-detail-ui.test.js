'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const js=fs.readFileSync(path.join(root,'public','embed.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public','embed.html'),'utf8');

test('国家利润测算操作列在复制左侧提供更多按钮',()=>{
  const more=js.indexOf('data-profit-detail=');
  const copy=js.indexOf('data-copy-listing=',more);
  assert.ok(more>=0&&copy>more);
});

test('更多弹窗展示 ROI、目标售价和完整利润参数',()=>{
  for(const text of ['预计 ROI','0% 利润率售价','30% 利润率售价','利润率计算参数','周期平均库存占货值'])assert.ok(html.includes(text)||js.includes(text));
  assert.ok(js.includes('include_target_prices:true'));
  assert.match(js,/result\.profit\|\|0\)\/averageInventory\*100/);
  for(const label of ['含税售价','VAT','净销售收入','亚马逊佣金','FBA 配送费','头程运费','产品成本','单件利润'])assert.ok(js.includes(label));
});
