'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

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
  assert.match(js,/revenue:number\([^\n]+,0\)/);
  assert.match(js,/profit:number\([^\n]+,1\)/);
  assert.match(js,/`\$\{values\.revenue\}USD`,`\$\{values\.profit\}%`/);
  assert.match(js,/function copyCompetitorStat\(code\)/);
});

test('single-card copy writes revenue and profit into adjacent cells',async()=>{
  const start=js.indexOf('function competitorStatRows(code)');
  const end=js.indexOf('function renderCompetitorStats()',start);
  const written=[];
  const context={
    state:{competitors:[
      {country_code:'US',name:'A',sale_price:10,profit_rate:64.7,monthly_sales:1,monthly_revenue_usd:1085438.4},
      {country_code:'US',name:'B',sale_price:10,profit_rate:64.8,monthly_sales:1,monthly_revenue_usd:1085439.1},
      {country_code:'US',name:'C',sale_price:10,profit_rate:64.9,monthly_sales:1,monthly_revenue_usd:1085439.5}
    ]},
    number:(value,digits=2)=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:digits}),
    writeRows:async(rows)=>written.push(rows),toast:()=>{},marketCode:(code)=>code
  };
  vm.runInNewContext(js.slice(start,end),context);
  await context.copyCompetitorStat('US');
  assert.equal(written[0][0][0],'1,085,439USD');
  assert.equal(written[0][0][1],'64.8%');
});

test('statistics container delegates click Enter and Space to card copy',()=>{
  assert.match(js,/\$\('#competitorStats'\)\.onclick=/);
  assert.match(js,/\$\('#competitorStats'\)\.onkeydown=/);
  assert.match(js,/event\.key!==['"]Enter['"]&&event\.key!==['"] ['"]/);
});

test('copyable cards communicate pointer and keyboard focus',()=>{
  assert.match(css,/\.competitor-stat\[data-copy-competitor-stat\][^{]*\{/);
  assert.match(css,/cursor:pointer/);
  assert.match(css,/\.competitor-stat\[data-copy-competitor-stat\]:focus-visible/);
});
