'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');

test('共享单站卡片优先采用查询串中的站点并兼容旧哈希站点',()=>{
  const js=read('public/site-card.js');
  assert.match(js,/state\.shareKey\?\(params\.get\('country'\)\|\|hashParams\.get\('country'\)\):params\.get\('country'\)/);
});

test('共享单站卡片地址只保留一份国家参数',()=>{
  const js=read('public/site-card.js');
  assert.match(js,/url\.searchParams\.set\('country',state\.country\.code\)/);
  assert.match(js,/url\.hash=new URLSearchParams\(\{key:state\.shareKey\}\)\.toString\(\)/);
  assert.doesNotMatch(js,/new URLSearchParams\(\{key:state\.shareKey,country:state\.country\.code\}\)/);
});

test('国家利润表生成的共享单站卡片把国家放在查询串',()=>{
  const js=read('public/embed.js');
  assert.match(js,/site-card\.html\?country=\$\{listing\.country_code\}#\$\{new URLSearchParams\(\{key:state\.shareKey\}\)\}/);
});

test('单站卡片更新脚本版本以绕过旧浏览器缓存',()=>{
  const html=read('public/site-card.html');
  assert.match(html,/site-card\.js\?v=20260920-4/);
});

test('单站卡片同时展示多个独立变体并可分别修改售价',()=>{
  const js=read('public/site-card.js');
  const html=read('public/site-card.html');
  assert.match(html,/id="variantGrid"/);
  assert.match(html,/新增变体/);
  assert.match(js,/data-variant-price/);
  assert.match(js,/variant_id:variant\.id/);
  assert.match(js,/保存时售价/);
  assert.match(js,/0% 利润率售价/);
  assert.match(js,/30% 利润率售价/);
});
