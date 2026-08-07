# 飞书卡片版品类搜索选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将飞书卡片版顶部的原生品类下拉框替换为支持鼠标和键盘操作的搜索选择框，同时保持新建、删除和项目切换行为不变。

**Architecture:** 在 `embed.html` 中使用具备组合框语义的输入框和列表框替代 `<select>`，由 `embed.js` 根据启动数据生成候选项、过滤并复用现有项目切换流程。样式集中在 `embed.css`，完成后通过现有静态构建命令将 `public` 同步到 `docs`。

**Tech Stack:** 原生 HTML、CSS、JavaScript，Node.js 内置测试运行器，现有 GitHub Pages 构建脚本。

## Global Constraints

- 搜索只匹配已有品类，不提供通过搜索词新建品类的入口。
- 无匹配结果时显示“未找到品类”。
- 保留现有“新建”和“删除”按钮、位置与业务行为。
- 匹配规则为品类名称不区分大小写的包含匹配。
- 同步维护 `public` 正式页面和 `docs` 静态发布版本。

---

### Task 1: 建立搜索选择框的结构与样式

**Files:**
- Create: `test/embed-category-search-ui.test.js`
- Modify: `public/embed.html:14`
- Modify: `public/embed.css:6`
- Modify: `public/embed.css:61`

**Interfaces:**
- Consumes: `#projectPicker` 作为现有品类控件标识，`.project-picker` 作为顶部布局容器。
- Produces: `#projectPicker` 文本输入框、`#projectPickerList` 列表框、`.project-picker-option` 候选项和 `.project-picker-empty` 空结果提示，供 Task 2 的脚本控制。

- [ ] **Step 1: 写出结构和样式的失败测试**

```js
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
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/embed-category-search-ui.test.js`

Expected: FAIL，提示未找到 `role="combobox"` 或搜索结果样式。

- [ ] **Step 3: 将原生下拉框替换为组合框结构**

将 `public/embed.html` 顶部的品类控件替换为：

```html
<div class="project-picker">
  <label for="projectPicker">品类</label>
  <div class="project-picker-control">
    <input id="projectPicker" type="search" autocomplete="off" role="combobox" aria-label="搜索并选择品类" aria-autocomplete="list" aria-expanded="false" aria-controls="projectPickerList">
    <span class="project-picker-arrow" aria-hidden="true"></span>
    <div class="project-picker-list" id="projectPickerList" role="listbox" hidden></div>
  </div>
</div>
```

- [ ] **Step 4: 添加与现有顶部工具栏一致的样式**

在 `public/embed.css` 中保留 `.project-picker` 的尺寸和移动端整行布局，并增加以下规则：

```css
.project-picker>label{color:var(--muted);font-size:10px;white-space:nowrap}
.project-picker-control{position:relative;min-width:0;flex:1}
.project-picker input{width:100%;height:34px;padding:0 27px 0 6px;border:0;outline:0;background:transparent;font:inherit;font-weight:650;color:var(--ink)}
.project-picker-arrow{position:absolute;right:7px;top:50%;width:7px;height:7px;border-right:2px solid #777;border-bottom:2px solid #777;transform:translateY(-70%) rotate(45deg);pointer-events:none}
.project-picker-list{position:absolute;z-index:20;top:calc(100% + 7px);left:-35px;right:0;max-height:260px;overflow:auto;padding:5px;border:1px solid var(--line);border-radius:9px;background:#fff;box-shadow:0 12px 30px rgba(30,30,36,.14)}
.project-picker-list[hidden]{display:none}
.project-picker-option{display:block;width:100%;padding:8px 9px;border:0;border-radius:6px;background:#fff;color:var(--ink);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.project-picker-option:hover,.project-picker-option.highlighted{background:var(--orange-soft);color:var(--orange-dark)}
.project-picker-option.selected{font-weight:750}
.project-picker-empty{padding:10px 9px;color:#999;text-align:center;font-size:11px}
```

- [ ] **Step 5: 运行结构和样式测试**

Run: `node --test test/embed-category-search-ui.test.js`

Expected: 2 tests PASS。

- [ ] **Step 6: 提交结构与样式**

```powershell
git add -- test/embed-category-search-ui.test.js public/embed.html public/embed.css
git commit -m "feat: add embed category search control"
```

---

### Task 2: 实现过滤、键盘操作和项目切换

**Files:**
- Modify: `test/embed-category-search-ui.test.js`
- Modify: `public/embed.js:63-67`
- Modify: `public/embed.js:493-505`

**Interfaces:**
- Consumes: Task 1 提供的 `#projectPicker` 输入框和 `#projectPickerList` 列表框；`state.bootstrap.projects` 中的 `{ id, name }` 项目摘要；现有 `api()`、`fillProduct()`、`calculate()`、`loadCompetitors()`。
- Produces: `renderProjectPicker(query = '')`、`openProjectPicker()`、`closeProjectPicker({ restore = true } = {})`、`selectProject(projectId)`，并更新 `refreshProjects()` 与 `bindEvents()` 使用这些函数。

- [ ] **Step 1: 扩充失败测试以覆盖过滤、空状态和键盘交互**

在 `test/embed-category-search-ui.test.js` 追加：

```js
test('品类组合框支持过滤、空结果、键盘导航和复用项目切换流程',()=>{
  const js=read('public/embed.js');
  assert.match(js,/function renderProjectPicker\(query=''\)/);
  assert.match(js,/toLocaleLowerCase\(\)\.includes\(normalized\)/);
  assert.match(js,/未找到品类/);
  assert.match(js,/event\.key==='ArrowDown'/);
  assert.match(js,/event\.key==='ArrowUp'/);
  assert.match(js,/event\.key==='Enter'/);
  assert.match(js,/event\.key==='Escape'/);
  assert.match(js,/async function selectProject\(projectId\)/);
  assert.match(js,/history\.replaceState\(null,'',`\?project=\$\{state\.project\.id\}`\)/);
});

test('品类名称以文本方式写入候选项',()=>{
  const js=read('public/embed.js');
  assert.match(js,/button\.textContent=project\.name/);
});
```

- [ ] **Step 2: 运行测试并确认新测试失败**

Run: `node --test test/embed-category-search-ui.test.js`

Expected: 前 2 个测试 PASS，新增的 2 个测试 FAIL，提示缺少搜索交互函数。

- [ ] **Step 3: 实现候选项渲染和展开关闭状态**

在 `public/embed.js` 中实现：

```js
let highlightedProjectIndex=-1;

function projectSummaries(){return state.bootstrap?.projects||[]}
function currentProjectName(){return state.project?.name||''}
function matchingProjects(query=''){
  const normalized=query.trim().toLocaleLowerCase();
  return normalized?projectSummaries().filter((project)=>String(project.name||'').toLocaleLowerCase().includes(normalized)):projectSummaries();
}
function renderProjectPicker(query=''){
  const list=$('#projectPickerList');const projects=matchingProjects(query);list.replaceChildren();
  if(!projects.length){const empty=document.createElement('div');empty.className='project-picker-empty';empty.textContent='未找到品类';list.append(empty);highlightedProjectIndex=-1;return}
  if(highlightedProjectIndex>=projects.length)highlightedProjectIndex=projects.length-1;
  projects.forEach((project,index)=>{const button=document.createElement('button');button.type='button';button.className=`project-picker-option${Number(project.id)===Number(state.project.id)?' selected':''}${index===highlightedProjectIndex?' highlighted':''}`;button.dataset.projectId=project.id;button.role='option';button.setAttribute('aria-selected',String(Number(project.id)===Number(state.project.id)));button.textContent=project.name;list.append(button)});
}
function openProjectPicker(){const input=$('#projectPicker');highlightedProjectIndex=-1;renderProjectPicker(input.value===currentProjectName()?'':input.value);$('#projectPickerList').hidden=false;input.setAttribute('aria-expanded','true')}
function closeProjectPicker({restore=true}={}){const input=$('#projectPicker');$('#projectPickerList').hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');highlightedProjectIndex=-1;if(restore)input.value=currentProjectName()}
```

- [ ] **Step 4: 抽取并复用异步项目切换流程**

```js
async function selectProject(projectId){
  const nextId=Number(projectId);if(!nextId||nextId===Number(state.project.id)){closeProjectPicker();return}
  state.project=await api(`/api/projects/${nextId}`);history.replaceState(null,'',`?project=${state.project.id}`);fillProduct();closeProjectPicker();await calculate();await loadCompetitors();
}
```

将 `refreshProjects()` 改为刷新启动数据并设置输入框当前值：

```js
async function refreshProjects(){state.bootstrap=await api('/api/bootstrap');$('#projectPicker').value=currentProjectName();renderProjectPicker()}
```

- [ ] **Step 5: 绑定输入、鼠标和键盘事件**

在 `bindEvents()` 中将原有 `#projectPicker.onchange` 替换为：

```js
const projectPicker=$('#projectPicker');const projectPickerList=$('#projectPickerList');
projectPicker.onfocus=openProjectPicker;
projectPicker.onclick=openProjectPicker;
projectPicker.oninput=()=>{highlightedProjectIndex=-1;renderProjectPicker(projectPicker.value);openProjectPicker()};
projectPicker.onkeydown=(event)=>{
  const options=$$('.project-picker-option',projectPickerList);
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();if(projectPickerList.hidden)openProjectPicker();
    const count=$$('.project-picker-option',projectPickerList).length;if(!count)return;
    highlightedProjectIndex=event.key==='ArrowDown'?(highlightedProjectIndex+1)%count:(highlightedProjectIndex<=0?count-1:highlightedProjectIndex-1);renderProjectPicker(projectPicker.value===currentProjectName()?'':projectPicker.value);$$('.project-picker-option',projectPickerList)[highlightedProjectIndex]?.scrollIntoView({block:'nearest'});return;
  }
  if(event.key==='Enter'&&!projectPickerList.hidden){event.preventDefault();const option=$$('.project-picker-option',projectPickerList)[highlightedProjectIndex]||$$('.project-picker-option',projectPickerList)[0];if(option)selectProject(option.dataset.projectId);return}
  if(event.key==='Escape'){event.preventDefault();closeProjectPicker();projectPicker.blur()}
};
projectPickerList.onclick=(event)=>{const option=event.target.closest('[data-project-id]');if(option)selectProject(option.dataset.projectId)};
document.addEventListener('pointerdown',(event)=>{if(!event.target.closest('.project-picker'))closeProjectPicker()});
```

- [ ] **Step 6: 运行品类搜索测试**

Run: `node --test test/embed-category-search-ui.test.js`

Expected: 4 tests PASS。

- [ ] **Step 7: 运行完整测试套件**

Run: `npm test`

Expected: 全部测试 PASS，无新增失败。

- [ ] **Step 8: 提交交互逻辑**

```powershell
git add -- test/embed-category-search-ui.test.js public/embed.js
git commit -m "feat: support searching embed categories"
```

---

### Task 3: 构建静态版本并做最终回归验证

**Files:**
- Modify by build: `docs/embed.html`
- Modify by build: `docs/embed.css`
- Modify by build: `docs/embed.js`

**Interfaces:**
- Consumes: Tasks 1–2 完成的 `public/embed.*` 文件和现有 `scripts/build_github_pages.mjs`。
- Produces: 与正式页面一致的 `docs/embed.*` 静态发布文件。

- [ ] **Step 1: 构建 GitHub Pages 静态文件**

Run: `npm run build:pages`

Expected: 命令退出码为 0，`docs/embed.html`、`docs/embed.css`、`docs/embed.js` 被更新。

- [ ] **Step 2: 验证正式页面与静态版本一致**

Run:

```powershell
@('embed.html','embed.css','embed.js') | ForEach-Object { if ((Get-FileHash "public/$_").Hash -ne (Get-FileHash "docs/$_").Hash) { throw "$_ 未同步" } }
```

Expected: 命令退出码为 0，无“未同步”错误。

- [ ] **Step 3: 再次运行完整测试和差异检查**

Run: `npm test`

Expected: 全部测试 PASS。

Run: `git diff --check`

Expected: 命令退出码为 0，无空白错误。

- [ ] **Step 4: 提交静态发布版本**

```powershell
git add -- docs/embed.html docs/embed.css docs/embed.js
git commit -m "build: update embed category search"
```
