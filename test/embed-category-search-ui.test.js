'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');

test('飞书卡片版使用可搜索组合框选择品类',()=>{
  const html=read('public/embed.html');
  assert.match(html,/id="projectPicker"[^>]*role="combobox"/);
  assert.match(html,/aria-controls="projectPickerList"/);
  assert.match(html,/id="projectPickerList"[^>]*role="listbox"/);
  assert.doesNotMatch(html,/<select id="projectPicker"/);
});

test('品类搜索结果具有展开、选中、键盘高亮和空结果样式',()=>{
  const css=read('public/embed.css');
  for(const selector of ['.project-picker-list','.project-picker-option','.project-picker-option.selected','.project-picker-option.highlighted','.project-picker-empty']) {
    assert.ok(css.includes(selector),`缺少 ${selector} 样式`);
  }
});
