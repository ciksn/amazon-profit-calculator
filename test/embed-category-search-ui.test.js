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
  assert.match(html,/class="project-picker-search-icon"/);
  assert.doesNotMatch(html,/class="project-picker-arrow"/);
  assert.doesNotMatch(html,/<select id="projectPicker"/);
});

test('品类搜索结果具有展开、选中、键盘高亮和空结果样式',()=>{
  const css=read('public/embed.css');
  for(const selector of ['.project-picker-list','.project-picker-option','.project-picker-option.selected','.project-picker-option.highlighted','.project-picker-empty']) {
    assert.ok(css.includes(selector),`缺少 ${selector} 样式`);
  }
});

test('品类组合框支持过滤、空结果、键盘导航和复用项目切换流程',()=>{
  const js=read('public/embed.js');
  assert.match(js,/function renderProjectPicker\(query=''\)/);
  assert.match(js,/toLocaleLowerCase\(\)\.includes\(normalized\)/);
  assert.match(js,/未找到品类/);
  assert.match(js,/event\.key==='ArrowDown'/);
  assert.match(js,/event\.key==='ArrowUp'/);
  assert.match(js,/event\.key==='Enter'/);
  assert.match(js,/event\.key==='Escape'/);
  assert.match(js,/aria-activedescendant/);
  assert.match(js,/\.onfocusout=/);
  assert.match(js,/async function selectProject\(projectId\)/);
  assert.match(js,/history\.replaceState\(null,'',`\?project=\$\{state\.project\.id\}`\)/);
});

test('品类名称以文本方式写入候选项',()=>{
  const js=read('public/embed.js');
  assert.match(js,/button\.textContent=project\.name/);
});
