'use strict';

const state = {
  bootstrap:null,
  projects:[],
  resultsByProject:{},
  expanded:new Set(),
  editingProjectId:null,
  editingProjectImage:'',
  editingListing:null,
  view:'calculator',
  ruleTab:'countries',
  ruleRows:[]
};
const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g,(char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const saveTimers = new Map();
const apiBase = String(window.MARGINGO_API_BASE || '').replace(/\/$/,'');

const MARKET_PORTALS = [
  ['US','纽约','10001','https://www.amazon.com'],
  ['AU','悉尼','2000','https://www.amazon.com.au'],
  ['UK','伦敦','SW1A 1AA','https://www.amazon.co.uk'],
  ['DE','柏林','10115','https://www.amazon.de'],
  ['FR','巴黎','75000','https://www.amazon.fr'],
  ['IT','罗马','00100','https://www.amazon.it'],
  ['JP','东京','163-8001','https://www.amazon.co.jp'],
  ['CA','多伦多','M4Y1M7','https://www.amazon.ca'],
  ['AE','迪拜','00000','https://www.amazon.ae'],
  ['SA','利雅得','11564','https://www.amazon.sa'],
  ['MX','墨西哥城','11529','https://www.amazon.com.mx']
];

async function api(url, options={}) {
  const target = /^https?:\/\//i.test(url) ? url : `${apiBase}${url}`;
  const response = await fetch(target,{ headers:{ 'Content-Type':'application/json',...(options.headers||{}) },...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(el.timer); el.timer = setTimeout(() => el.classList.remove('show'),2200);
}

function setSaveState(text='已保存',isError=false) {
  const el = $('#saveState');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('save-error',isError);
}

function debounceSave(fn,key='default') {
  setSaveState('保存中…');
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key,setTimeout(async () => {
    try { await fn(); setSaveState('已保存'); }
    catch (error) { setSaveState('保存失败',true); toast(error.message); }
    finally { saveTimers.delete(key); }
  },320));
}

function marketCode(code) { return code === 'GB' ? 'UK' : code; }
function formField(form,name) { return form.elements.namedItem(name); }
function findProject(id) { return state.projects.find((project) => project.id === Number(id)); }
function replaceProject(project) {
  const index = state.projects.findIndex((item) => item.id === project.id);
  if (index >= 0) state.projects[index] = project; else state.projects.unshift(project);
}
function countryFor(code) { return state.bootstrap.countries.find((country) => country.code === code); }
function resultFor(projectId,code) { return (state.resultsByProject[projectId] || []).find((result) => result.country_code === code); }
function formatNumber(value,digits=2) { return Number(value || 0).toLocaleString('zh-CN',{ maximumFractionDigits:digits }); }

async function initialize() {
  state.bootstrap = await api('/api/bootstrap');
  $('#adminCountryFilter').innerHTML = '<option value="">全部国家</option>' + state.bootstrap.countries.map((c) => `<option value="${c.code}">${c.flag} ${c.name}</option>`).join('');
  renderSitePortal();
  await loadAllProjects();
}

async function refreshBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
}

async function loadAllProjects() {
  const summaries = state.bootstrap.projects || [];
  state.projects = await Promise.all(summaries.map((project) => api(`/api/projects/${project.id}`)));
  state.projects.forEach((project) => state.expanded.add(project.id));
  await Promise.all(state.projects.map((project) => calculateProject(project.id,false)));
  renderCategoryList();
}

async function calculateProject(projectId,render=true) {
  const payload = await api('/api/calculate',{ method:'POST',body:JSON.stringify({ project_id:projectId }) });
  state.resultsByProject[projectId] = payload.results || [];
  if (render) renderCategoryList();
}

async function calculateAll() {
  await Promise.all(state.projects.map((project) => calculateProject(project.id,false)));
  renderCategoryList();
}

function renderSitePortal() {
  $('#sitePortal').innerHTML = MARKET_PORTALS.map(([code,city,postal,url]) => `<div class="portal-site"><a href="${url}" target="_blank" rel="noopener" title="打开 ${city} 所在亚马逊站点">${code}</a><button type="button" data-copy-postal="${escapeHtml(postal)}" title="复制${city}邮编">${escapeHtml(postal)}</button></div>`).join('');
  $$('[data-copy-postal]').forEach((button) => button.onclick = () => copyPostal(button.dataset.copyPostal));
}

async function copyPostal(postal) {
  try {
    await navigator.clipboard.writeText(postal);
  } catch {
    const helper = document.createElement('textarea'); helper.value = postal; helper.style.position = 'fixed'; helper.style.opacity = '0';
    document.body.appendChild(helper); helper.select(); document.execCommand('copy'); helper.remove();
  }
  toast(`邮编 ${postal} 已复制`);
}

function renderCategoryList() {
  $('#categoryCount').textContent = `${state.projects.length} 个品类`;
  if (!state.projects.length) {
    $('#categoryList').innerHTML = `<div class="empty-categories"><div class="empty-category-icon">＋</div><b>还没有品类数据</b><p>先增加一个品类，再填写产品信息和选择测算站点。</p><button class="project-add-button empty-add-button" type="button" data-add-empty>＋ 增加品类</button></div>`;
    bindCategoryEvents();
    return;
  }
  $('#categoryList').innerHTML = state.projects.map(categoryCard).join('');
  bindCategoryEvents();
}

function categoryCard(project,index) {
  const selected = project.listings.filter((listing) => listing.selected);
  const expanded = state.expanded.has(project.id);
  const dimensions = `${formatNumber(project.length)} × ${formatNumber(project.width)} × ${formatNumber(project.height)} ${String(project.dimension_unit || 'cm').toUpperCase()}`;
  const weight = `${formatNumber(project.weight,3)} ${String(project.weight_unit || 'kg').toUpperCase()}`;
  const productImage = project.image_data
    ? `<img src="${escapeHtml(project.image_data)}" alt="${escapeHtml(project.name || '商品')}图片">`
    : '<span aria-hidden="true">▧</span>';
  const siteButtons = state.bootstrap.countries.map((country) => {
    const listing = project.listings.find((item) => item.country_code === country.code);
    return `<button class="site-toggle ${listing?.selected ? 'active':''}" type="button" data-toggle-site="${country.code}" data-project-id="${project.id}" aria-pressed="${Boolean(listing?.selected)}" title="${listing?.selected ? '移除' : '加入'}${country.name}站">${marketCode(country.code)}</button>`;
  }).join('');
  return `<article class="category-card ${expanded ? 'expanded':''}" data-project-card="${project.id}">
    <div class="category-main-row">
      <button class="category-info" type="button" data-edit-project="${project.id}" aria-label="编辑 ${escapeHtml(project.name)}">
        <span class="category-index">${String(index + 1).padStart(2,'0')}</span>
        <span class="category-image">${productImage}</span>
        <span class="category-name"><small>品名</small><b>${escapeHtml(project.name || '未命名品类')}</b></span>
        <span class="category-metric"><small>成本</small><b>¥${formatNumber(project.cost_cny)}</b></span>
        <span class="category-metric category-size"><small>长 × 宽 × 高</small><b>${escapeHtml(dimensions)}</b></span>
        <span class="category-metric"><small>重量</small><b>${escapeHtml(weight)}</b></span>
      </button>
      <div class="category-sites"><small>测算站点</small><div>${siteButtons}</div></div>
      <div class="category-row-actions">
        <button class="delete-category" type="button" data-delete-project="${project.id}" aria-label="删除品类" title="删除品类"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg></button>
        <button class="expand-category" type="button" data-expand-project="${project.id}" aria-expanded="${expanded}" aria-label="${expanded ? '收起' : '展开'}站点数据" title="${expanded ? '收起' : '展开'} ${selected.length} 个站点"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>
      </div>
    </div>
    ${expanded ? marketTable(project,selected) : ''}
  </article>`;
}

function marketTable(project,selected) {
  if (!selected.length) return `<div class="no-market-row">请在上方选择至少一个测算站点</div>`;
  return `<div class="market-table">
    <div class="market-table-head"><span>国家</span><span>售价</span><span>类目佣金</span><span>FBA费用</span><span>头程费用</span><span>汇率</span><span>利润</span><span>利润率</span><span></span></div>
    ${selected.map((listing) => marketRow(project,listing)).join('')}
  </div>`;
}

function marketRow(project,listing) {
  const result = resultFor(project.id,listing.country_code);
  const country = countryFor(listing.country_code);
  const commission = listing.referral_rate_override ?? listing.matched_referral_rate ?? result?.referral_base_rate ?? 15;
  const hasPrice = Number(listing.sale_price) > 0;
  const cls = !hasPrice ? '' : Number(result?.profit) >= 0 ? 'positive':'negative';
  const profit = result ? `${result.profit < 0 ? '-' : ''}${result.symbol}${Math.abs(result.profit).toFixed(2)}` : '—';
  const fba = result ? `${result.symbol}${result.fba_fee.toFixed(2)}` : '—';
  const freight = result ? `${result.symbol}${result.freight_fee.toFixed(2)}` : '—';
  const exchange = `¥${Number(country.cny_per_local).toLocaleString('zh-CN',{ maximumFractionDigits:4 })}`;
  const warning = result?.warnings?.length ? `<span class="row-warning" title="${escapeHtml(result.warnings.join('；'))}">!</span>` : '';
  return `<div class="market-data-row ${cls}">
    <div class="market-country"><span>${country.flag}</span><div><b>${marketCode(country.code)}</b><small>${country.name}</small></div>${warning}</div>
    <label class="table-input"><b>${escapeHtml(listing.symbol)}</b><input type="number" min="0" step="0.01" value="${listing.sale_price || ''}" placeholder="0.00" data-listing-input="sale_price" data-project-id="${project.id}" data-country-code="${listing.country_code}" aria-label="${country.name}站售价"></label>
    <button class="calculated-cell cell-editor" type="button" data-edit-commission="${listing.country_code}" data-project-id="${project.id}" aria-label="编辑${country.name}站佣金"><b>${formatNumber(commission,2)}%</b><small>${listing.referral_rate_override == null ? escapeHtml(listing.matched_category || '点击识别品类') : '手动佣金'}</small></button>
    <div class="calculated-cell"><b>${fba}</b><small>${escapeHtml(result?.size_tier_name || '待计算')}</small></div>
    <button class="calculated-cell cell-editor" type="button" data-edit-freight="${listing.country_code}" data-project-id="${project.id}" aria-label="查看并编辑${country.name}站头程费用"><b>${freight}</b><small>${result?.freight_pricing_mode === 'cbm' ? '按方 · 点击查看' : '按计费重 · 点击查看'}</small></button>
    <div class="calculated-cell"><b>${exchange}</b><small>1 ${escapeHtml(listing.currency)}</small></div>
    <div class="profit-cell ${cls}"><b>${hasPrice ? profit : '—'}</b><small>${hasPrice ? '单件' : '待填售价'}</small></div>
    <div class="rate-cell ${cls}"><b>${hasPrice ? `${Number(result?.profit_rate || 0).toFixed(1)}%` : '—'}</b></div>
    ${listing.country_code === 'JP' ? `<button class="listing-settings special" type="button" data-edit-tax="JP" data-project-id="${project.id}" title="日本进口税项设置">日本税项</button>` : '<span></span>'}
  </div>`;
}

function bindCategoryEvents() {
  $$('[data-add-empty]').forEach((button) => button.onclick = addProject);
  $$('[data-edit-project]').forEach((button) => button.onclick = () => openProductModal(button.dataset.editProject));
  $$('[data-toggle-site]').forEach((button) => button.onclick = () => toggleCountry(button.dataset.projectId,button.dataset.toggleSite));
  $$('[data-expand-project]').forEach((button) => button.onclick = () => toggleExpanded(button.dataset.expandProject));
  $$('[data-delete-project]').forEach((button) => button.onclick = () => deleteProject(button.dataset.deleteProject));
  $$('[data-edit-commission]').forEach((button) => button.onclick = () => openListingModal(button.dataset.projectId,button.dataset.editCommission,'commission'));
  $$('[data-edit-freight]').forEach((button) => button.onclick = () => openListingModal(button.dataset.projectId,button.dataset.editFreight,'freight'));
  $$('[data-edit-tax]').forEach((button) => button.onclick = () => openListingModal(button.dataset.projectId,button.dataset.editTax,'tax'));
  $$('[data-listing-input]').forEach((input) => input.onblur = () => saveInlineListing(input));
}

function toggleExpanded(projectId) {
  const id = Number(projectId);
  if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
  renderCategoryList();
}

async function toggleCountry(projectId,code) {
  const project = findProject(projectId);
  const listing = project.listings.find((item) => item.country_code === code);
  const selectedCount = project.listings.filter((item) => item.selected).length;
  if (listing.selected && selectedCount === 1) return toast('每个品类至少保留一个测算站点');
  try {
    setSaveState('保存中…');
    const updated = await api(`/api/projects/${project.id}/countries/${code}`,{ method:'PUT',body:JSON.stringify({ selected:!listing.selected }) });
    replaceProject(updated); state.expanded.add(project.id);
    await calculateProject(project.id);
    setSaveState('已保存');
  } catch (error) { setSaveState('保存失败',true); toast(error.message); }
}

function saveInlineListing(input) {
  const project = findProject(input.dataset.projectId);
  const code = input.dataset.countryCode;
  const listing = project.listings.find((item) => item.country_code === code);
  const field = input.dataset.listingInput;
  const value = field === 'referral_rate_override' ? (input.value === '' ? null : Number(input.value)) : Number(input.value) || 0;
  listing[field] = value;
  debounceSave(async () => {
    const updated = await api(`/api/projects/${project.id}/countries/${code}`,{ method:'PUT',body:JSON.stringify({ [field]:value }) });
    replaceProject(updated); await calculateProject(project.id);
  },`listing:${project.id}:${code}:${field}`);
}

function openModal(modal) { modal.classList.remove('hidden'); document.body.classList.add('modal-open'); }
function closeModal(modal) { modal.classList.add('hidden'); if ($$('.modal-backdrop:not(.hidden)').length === 0) document.body.classList.remove('modal-open'); }

function openProductModal(projectId) {
  const project = findProject(projectId);
  if (!project) return;
  state.editingProjectId = project.id;
  state.editingProjectImage = project.image_data || '';
  $('#productModalTitle').textContent = `编辑 · ${project.name}`;
  const form = $('#productForm');
  for (const key of ['name','cost_cny','length','width','height','dimension_unit','weight','weight_unit']) formField(form,key).value = project[key] ?? '';
  $('#dimensionSuffix').textContent = project.dimension_unit || 'cm';
  renderProductImagePreview();
  openModal($('#productModal'));
  setTimeout(() => formField(form,'name').focus(),60);
}

async function saveProductForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const changes = {};
  for (const key of ['name','dimension_unit','weight_unit']) changes[key] = formField(form,key).value.trim();
  for (const key of ['cost_cny','length','width','height','weight']) changes[key] = Number(formField(form,key).value) || 0;
  changes.image_data = state.editingProjectImage || '';
  if (!changes.name) return toast('请填写品名');
  try {
    setSaveState('保存中…');
    const updated = await api(`/api/projects/${state.editingProjectId}`,{ method:'PUT',body:JSON.stringify(changes) });
    replaceProject(updated);
    const summary = state.bootstrap.projects.find((item) => item.id === updated.id); if (summary) summary.name = updated.name;
    closeModal($('#productModal'));
    await calculateProject(updated.id);
    setSaveState('已保存'); toast('品类信息已更新');
  } catch (error) { setSaveState('保存失败',true); toast(error.message); }
}

function renderProductImagePreview() {
  const preview = $('#productImagePreview');
  preview.innerHTML = state.editingProjectImage
    ? `<img src="${escapeHtml(state.editingProjectImage)}" alt="商品图片预览">`
    : '<span>图片</span>';
  $('#removeProductImage').classList.toggle('hidden',!state.editingProjectImage);
  $('#productImageInput').classList.toggle('has-image',Boolean(state.editingProjectImage));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

async function compressProductImage(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 12 * 1024 * 1024) throw new Error('图片不能超过 12MB');
  const source = await readFileAsDataUrl(file);
  const image = await new Promise((resolve,reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('图片格式无法识别'));
    element.src = source;
  });
  const maxSide = 640;
  const scale = Math.min(1,maxSide / Math.max(image.naturalWidth,image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1,Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1,Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/webp',.82);
}

async function setProductImage(file) {
  try {
    state.editingProjectImage = await compressProductImage(file);
    renderProductImagePreview();
    toast('图片已加入，保存品类后生效');
  } catch (error) { toast(error.message); }
}

function handleProductImagePaste(event) {
  if ($('#productModal').classList.contains('hidden')) return;
  const imageItem = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith('image/'));
  if (!imageItem) return;
  event.preventDefault();
  setProductImage(imageItem.getAsFile());
}

function fillParsedDimensions(parsed) {
  const form = $('#productForm');
  formField(form,'length').value = parsed.length; formField(form,'width').value = parsed.width; formField(form,'height').value = parsed.height;
  formField(form,'dimension_unit').value = parsed.unit; $('#dimensionSuffix').textContent = parsed.unit;
  toast(`已识别：${parsed.length} × ${parsed.width} × ${parsed.height} ${parsed.unit}`);
}

function recognizeDimensions(text) {
  const parsed = window.DimensionParser?.parseDimensions(text,formField($('#productForm'),'dimension_unit').value || 'cm');
  if (!parsed) { toast('未识别到完整尺寸，请使用如 27.2 × 12.5 × 54 cm 的格式'); return false; }
  fillParsedDimensions(parsed); return true;
}

async function readDimensionsFromClipboard() {
  if (!navigator.clipboard?.readText) return toast('当前浏览器无法读取剪贴板，请在任一尺寸框直接粘贴');
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return toast('剪贴板为空，请先复制完整尺寸');
    recognizeDimensions(text);
  } catch { toast('剪贴板读取被拦截，请在任一尺寸框直接粘贴'); }
}

function handleDimensionPaste(event) {
  const text = event.clipboardData?.getData('text') || '';
  const parsed = window.DimensionParser?.parseDimensions(text,formField($('#productForm'),'dimension_unit').value || 'cm');
  if (!parsed) return;
  event.preventDefault(); fillParsedDimensions(parsed);
}

async function addProject() {
  try {
    const count = state.projects.length + 1;
    const project = await api('/api/projects',{ method:'POST',body:JSON.stringify({ name:`新品测算 ${String(count).padStart(2,'0')}` }) });
    state.projects.unshift(project); state.bootstrap.projects.unshift({ id:project.id,name:project.name }); state.expanded.add(project.id);
    await calculateProject(project.id); openProductModal(project.id); toast('已增加品类，请填写基础信息');
  } catch (error) { toast(error.message); }
}

async function deleteProject(projectId) {
  const project = findProject(projectId);
  if (!project || !confirm(`删除“${project.name}”？该品类的全部站点数据也会删除。`)) return;
  try {
    await api(`/api/projects/${project.id}`,{ method:'DELETE' });
    state.projects = state.projects.filter((item) => item.id !== project.id);
    state.bootstrap.projects = state.bootstrap.projects.filter((item) => item.id !== project.id);
    delete state.resultsByProject[project.id]; state.expanded.delete(project.id);
    renderCategoryList(); toast('品类已删除');
  } catch (error) { toast(error.message); }
}

function openListingModal(projectId,code,mode='commission') {
  state.editingListing = { projectId:Number(projectId),code,mode };
  renderListingModal(); openModal($('#listingModal'));
}

function renderListingModal() {
  const { projectId,code,mode } = state.editingListing;
  const project = findProject(projectId);
  const listing = project.listings.find((item) => item.country_code === code);
  const country = countryFor(code);
  const result = resultFor(projectId,code);
  const commission = listing.referral_rate_override ?? listing.matched_referral_rate ?? result?.referral_base_rate ?? 15;
  const freightIsCbm = listing.freight_pricing_mode === 'cbm';
  const freightField = freightIsCbm ? 'freight_price_per_cbm_cny' : 'freight_price_per_kg_cny';
  const autoDeclaredValue = (Number(listing.sale_price) || 0) * Number(listing.declaration_ratio ?? 0.15);
  const japanFields = code === 'JP' ? `<section class="modal-section japan-section"><div class="modal-section-title"><div><b>日本进口税项</b><small>国内编码前 6 位匹配日本税则</small></div><span>JP ONLY</span></div>
    <div class="tariff-query-grid"><input id="customsHsCode" inputmode="numeric" maxlength="10" value="${escapeHtml(listing.customs_hs_code)}" placeholder="国内10位HS编码"><select id="customsPreference"><option value="unknown" ${listing.customs_preference === 'unknown' ? 'selected':''}>RCEP资格未知</option><option value="none" ${listing.customs_preference === 'none' ? 'selected':''}>不使用RCEP</option><option value="rcep" ${listing.customs_preference === 'rcep' ? 'selected':''}>具备RCEP证明</option></select><button class="match-button" id="lookupJapanTariff" type="button">查询税率</button></div>
    <div class="tariff-lookup-result" id="tariffLookupResult">${listing.customs_schedule_date ? `当前：${escapeHtml(listing.customs_rate_type || '人工填写')} ${Number(listing.customs_rate) || 0}% · 税则 ${escapeHtml(listing.customs_schedule_date)}` : '查询失败时仍可手动填写关税比例'}</div>
    <div class="compact-form japan-form"><label class="field"><span>申报比例</span><div class="input-affix"><input name="declaration_ratio" type="number" min="0" max="100" step="0.1" value="${Number(listing.declaration_ratio ?? 0.15) * 100}"><em>%</em></div></label><label class="field"><span>申报价（留空自动）</span><div class="input-affix"><b>${listing.symbol}</b><input name="declared_value_override" type="number" min="0" step="0.01" value="${listing.declared_value_override ?? ''}" placeholder="自动 ${autoDeclaredValue.toFixed(2)}"></div></label><label class="field"><span>关税比例</span><div class="input-affix"><input name="customs_rate" type="number" min="0" max="100" step="0.1" value="${Number(listing.customs_rate) || 0}"><em>%</em></div></label><label class="field"><span>消费税比例</span><div class="input-affix"><input name="consumption_tax_rate" type="number" min="0" max="100" step="0.1" value="${Number(listing.consumption_tax_rate ?? 10)}"><em>%</em></div></label></div>
  </section>` : '';
  const commissionSection = mode === 'commission' ? `<section class="modal-section"><div class="modal-section-title"><div><b>类目佣金</b><small>可粘贴父品类自动识别，也可以直接填写佣金</small></div></div>
    <div class="compact-form"><label class="field span-2"><span>亚马逊父品类名称</span><div class="category-actions"><input name="category_text" value="${escapeHtml(listing.category_text)}" placeholder="例如 Home & Kitchen"><button class="match-button" id="matchCommission" type="button">智能匹配</button></div><div class="match-result" id="matchResult">${listing.matched_category ? `${listing.commission_fallback ? '使用默认' : '已匹配'}：${escapeHtml(listing.matched_category)} · ${listing.matched_referral_rate}%` : '粘贴父品类后点击匹配'}</div></label><label class="field span-2"><span>手动佣金比例（留空使用自动匹配）</span><div class="input-affix"><input name="referral_rate_override" type="number" min="0" max="100" step="0.1" value="${listing.referral_rate_override ?? ''}" placeholder="当前自动 ${formatNumber(commission,2)}"><em>%</em></div></label></div>
  </section>` : '';
  const freightSection = mode === 'freight' ? `<section class="modal-section"><div class="modal-section-title"><div><b>头程费用</b><small>查看本品类计算依据，并可修改该站点货代单价</small></div></div>
    <div class="freight-detail-grid"><div><small>计费方式</small><b>${freightIsCbm ? '按体积（立方米）' : '按计费重量'}</b></div><div><small>当前头程费用</small><b>${result ? `${result.symbol}${result.freight_fee.toFixed(2)}` : '待计算'}</b></div><div><small>${freightIsCbm ? '商品体积' : '实际 / 体积重'}</small><b>${freightIsCbm ? `${formatNumber(result?.volume_cbm,6)} m³` : `${formatNumber(result?.actual_weight_kg,3)} / ${formatNumber(result?.volume_weight_kg,3)} kg`}</b></div><div><small>${freightIsCbm ? '计算公式' : '头程计费重'}</small><b>${freightIsCbm ? `${formatNumber(result?.volume_cbm,6)} × ¥${formatNumber(listing[freightField])}` : `${formatNumber(result?.billable_weight_kg,3)} kg`}</b></div></div>
    <div class="compact-form freight-rate-form"><label class="field span-2"><span>货代单价（修改后用于该站点全部品类）</span><div class="input-affix"><b>¥</b><input name="freight_rate" type="number" min="0" step="0.01" value="${Number(listing[freightField]) || 0}"><em>${freightIsCbm ? '元/方' : '元/KG'}</em></div></label></div>
  </section>` : '';
  $('#listingModalTitle').textContent = `${country.flag} ${country.name}站${mode === 'commission' ? '佣金' : mode === 'freight' ? '头程费用' : '税项'}设置`;
  $('#listingModalBody').innerHTML = `<form id="listingSettingsForm">
    ${commissionSection}${freightSection}${mode === 'tax' && code === 'JP' ? japanFields : ''}
    <div class="modal-actions"><button class="secondary-button" type="button" data-close-modal>取消</button><button class="primary-button" type="submit">保存设置</button></div>
  </form>`;
  $('#listingSettingsForm').onsubmit = saveListingSettings;
  if ($('#matchCommission')) $('#matchCommission').onclick = matchCommission;
  if (mode === 'tax' && code === 'JP') $('#lookupJapanTariff').onclick = () => lookupJapanTariff();
  $$('[data-close-modal]',$('#listingModalBody')).forEach((button) => button.onclick = () => closeModal($('#listingModal')));
}

async function saveListingSettings(event) {
  event.preventDefault();
  const { projectId,code,mode } = state.editingListing;
  const project = findProject(projectId);
  const listing = project.listings.find((item) => item.country_code === code);
  const form = event.currentTarget;
  const changes = {};
  if (mode === 'commission') {
    changes.category_text = formField(form,'category_text').value.trim();
    changes.referral_rate_override = formField(form,'referral_rate_override').value === '' ? null : Number(formField(form,'referral_rate_override').value);
  }
  if (mode === 'tax' && code === 'JP') {
    changes.customs_hs_code = $('#customsHsCode').value.replace(/\D/g,'');
    changes.customs_preference = $('#customsPreference').value;
    changes.declaration_ratio = (Number(formField(form,'declaration_ratio').value) || 0) / 100;
    changes.declared_value_override = formField(form,'declared_value_override').value === '' ? null : Number(formField(form,'declared_value_override').value);
    changes.customs_rate = Number(formField(form,'customs_rate').value) || 0;
    changes.consumption_tax_rate = Number(formField(form,'consumption_tax_rate').value) || 0;
  }
  try {
    setSaveState('保存中…');
    let updated;
    if (mode === 'freight') {
      const freightField = listing.freight_pricing_mode === 'cbm' ? 'price_per_cbm_cny' : 'price_per_kg_cny';
      await api(`/api/rules/freight/${listing.freight_rule_id}`,{ method:'PUT',body:JSON.stringify({ [freightField]:Number(formField(form,'freight_rate').value) || 0 }) });
      state.projects = await Promise.all(state.projects.map((item) => api(`/api/projects/${item.id}`)));
      updated = findProject(projectId);
    } else {
      updated = Object.keys(changes).length
        ? await api(`/api/projects/${projectId}/countries/${code}`,{ method:'PUT',body:JSON.stringify(changes) })
        : await api(`/api/projects/${projectId}`);
    }
    replaceProject(updated); closeModal($('#listingModal')); await calculateAll(); setSaveState('已保存'); toast('站点设置已更新');
  } catch (error) { setSaveState('保存失败',true); toast(error.message); }
}

async function matchCommission() {
  const { projectId,code } = state.editingListing;
  const project = findProject(projectId);
  const listing = project.listings.find((item) => item.country_code === code);
  const text = formField($('#listingSettingsForm'),'category_text').value.trim();
  if (!text) return toast('请先粘贴父品类名称');
  try {
    const result = await api('/api/commission/match',{ method:'POST',body:JSON.stringify({ country_code:code,text,sale_price:Number(listing.sale_price) || 0 }) });
    if (!result.matched) { $('#matchResult').textContent = '未找到匹配规则，可在表格中手动输入佣金'; return; }
    const changes = { category_text:text,matched_category:result.rule.parent_category,matched_referral_rate:result.rule.rate,matched_referral_threshold:result.rule.threshold_price,matched_referral_rate_above:result.rule.rate_above,matched_referral_minimum:result.rule.minimum_fee || 0,referral_rate_override:null };
    const updated = await api(`/api/projects/${projectId}/countries/${code}`,{ method:'PUT',body:JSON.stringify(changes) });
    replaceProject(updated); await calculateProject(projectId,false); renderCategoryList(); renderListingModal();
    toast(result.fallback ? '未命中具体品类，已使用默认佣金' : '佣金规则匹配成功');
  } catch (error) { toast(error.message); }
}

function renderTariffCandidates(payload) {
  const result = $('#tariffLookupResult');
  const candidates = payload.candidates || [];
  result.innerHTML = `<b>已按前6位 ${escapeHtml(payload.matchingHs6)} 匹配</b><small>请选择与商品相符的日本细分项 · 税则 ${escapeHtml(payload.scheduleDate)}</small><div class="tariff-candidates">${candidates.map((candidate) => `<button type="button" data-tariff-code="${candidate.code}"><b>${escapeHtml(candidate.code)}</b><span>${escapeHtml(candidate.description || '无英文描述')}</span><em>${escapeHtml(candidate.rateText || '需人工确认')}</em></button>`).join('')}</div>`;
  $$('[data-tariff-code]',result).forEach((button) => button.onclick = () => lookupJapanTariff(button.dataset.tariffCode));
}

async function lookupJapanTariff(selectedCode='') {
  const { projectId } = state.editingListing;
  const button = $('#lookupJapanTariff');
  const domesticHsCode = $('#customsHsCode').value.replace(/\D/g,'');
  const hsCode = selectedCode || domesticHsCode;
  const preference = $('#customsPreference').value;
  if (!selectedCode && domesticHsCode.length !== 10) return toast('请输入国内 10 位 HS 编码');
  button.disabled = true; button.textContent = '查询中…'; $('#tariffLookupResult').textContent = '正在读取日本海关税则…';
  try {
    const payload = await api('/api/tariffs/japan/lookup',{ method:'POST',body:JSON.stringify({ hs_code:hsCode,origin_country:'CN',preference }) });
    if (!payload.candidate) return renderTariffCandidates(payload);
    const candidate = payload.candidate;
    const changes = { customs_hs_code:domesticHsCode,customs_origin_country:'CN',customs_preference:preference,customs_rate:candidate.rate,customs_rate_type:candidate.rateType,customs_schedule_date:payload.scheduleDate,customs_source_url:payload.sourceUrl };
    const updated = await api(`/api/projects/${projectId}/countries/JP`,{ method:'PUT',body:JSON.stringify(changes) });
    replaceProject(updated); await calculateProject(projectId,false); renderCategoryList(); renderListingModal();
    const result = $('#tariffLookupResult');
    result.innerHTML = `<b>已采用 ${escapeHtml(candidate.rateType)}：${candidate.rate}%</b><small>国内 ${escapeHtml(domesticHsCode)} → 日本 ${escapeHtml(candidate.code)} · ${escapeHtml(candidate.description)} · ${escapeHtml(payload.scheduleDate)}</small><a href="${escapeHtml(payload.sourceUrl)}" target="_blank" rel="noopener">查看日本海关来源</a>`;
    toast('已填入最新关税比例');
  } catch (error) { $('#tariffLookupResult').textContent = `${error.message}；可继续手动填写`; toast(error.message); }
  finally { const current = $('#lookupJapanTariff'); if (current) { current.disabled = false; current.textContent = '查询税率'; } }
}

const adminConfigs = {
  countries:{ title:'税费、VAT与汇率',description:'税费可按售价或成本计提；VAT 从顾客看到的含税售价中拆分。',columns:[['code','站点','readonly'],['name','国家','readonly'],['cny_per_local','人民币汇率','number'],['tax_basis','税费基数','basis'],['tax_rate','税费 %','number'],['vat_rate','VAT %','number'],['fba_volume_divisor','FBA体积除数','number'],['tax_note','预估说明','text']] },
  freight:{ title:'货代价格',description:'支持按计费 KG 或立方米维护；所有站点按 KG 计费时，体积重除数固定为 6000。',columns:[['country_code','站点','readonly'],['channel_name','渠道','text'],['pricing_mode','计价方式','freightMode'],['price_per_kg_cny','元/KG','number'],['price_per_cbm_cny','元/方','number'],['min_charge_cny','最低收费','number'],['status','状态','status'],['source_note','说明','text']] },
  sizes:{ title:'各国尺寸分段',description:'每个国家独立判断尺寸段；长度与重量统一换算为厘米和 KG 后匹配。',columns:[['country_code','站点','readonly'],['tier_code','分段编码','text'],['tier_name','前台名称','text'],['max_long_cm','最长边','number'],['max_mid_cm','次长边','number'],['max_short_cm','最短边','number'],['min_item_weight_kg','商品最小KG','number'],['max_item_weight_kg','商品最大KG','number'],['max_volume_weight_kg','体积重上限KG','number'],['max_total_cm','组合尺寸上限','number'],['dimension_mode','组合方式','text'],['class_weight_mode','分段重量','text'],['fee_weight_mode','计费重量','text'],['status','状态','status'],['source_note','来源','text']] },
  fba:{ title:'FBA 计算规则',description:'先按国家尺寸段匹配，再按售价、品类和发货重量选择费阶；续重可按指定重量单位向上取整。',columns:[['country_code','站点','readonly'],['size_tier','尺寸段','text'],['size_name','费阶','text'],['min_price','最低售价','number'],['max_price','最高售价','number'],['category_group','品类组','text'],['max_weight_kg','计费重上限KG','number'],['base_fee','基础费','number'],['per_kg_fee','续重/KG','number'],['weight_increment_kg','续重档KG','number'],['surcharge_rate','附加费%','number'],['status','状态','status'],['source_note','来源','text']] },
  commission:{ title:'品类佣金',description:'已按国家收起整理；支持售价分档、阶梯佣金和最低佣金。',columns:[['country_code','站点','readonly'],['parent_category','父品类','text'],['keywords','识别关键词','text'],['min_price','最低售价','number'],['max_price','最高售价','number'],['rate','基础佣金 %','number'],['threshold_price','阶梯点','number'],['rate_above','超出部分 %','number'],['minimum_fee','最低佣金','number'],['status','状态','status'],['source_note','说明','text']] }
};

async function renderAdmin() {
  const config = adminConfigs[state.ruleTab];
  $('#adminTitle').textContent = config.title; $('#adminDescription').textContent = config.description;
  state.ruleRows = await api(`/api/rules/${state.ruleTab}`);
  $('#adminSummary').innerHTML = `<div class="summary-card"><strong>${state.bootstrap.countries.length}</strong><span>覆盖国家站点</span></div><div class="summary-card"><strong>${state.bootstrap.ruleCounts.fba}</strong><span>FBA 费阶规则</span></div><div class="summary-card"><strong>${state.bootstrap.ruleCounts.freightMissing}</strong><span>待补货代站点</span></div>`;
  filterAdmin();
}

function filterAdmin() {
  const country = $('#adminCountryFilter').value; const search = $('#adminSearch').value.toLowerCase();
  const rows = state.ruleRows.filter((row) => (!country || row.code === country || row.country_code === country) && (!search || JSON.stringify(row).toLowerCase().includes(search)));
  const config = adminConfigs[state.ruleTab];
  const table = (groupRows) => `<table class="admin-table"><thead><tr>${config.columns.map((col) => `<th>${col[1]}</th>`).join('')}<th>操作</th></tr></thead><tbody>${groupRows.map((row) => adminRow(row,config)).join('')}</tbody></table>`;
  if (state.ruleTab === 'commission' && !country) {
    const groups = rows.reduce((result,row) => { (result[row.country_code] ||= []).push(row); return result; },{});
    $('#adminTable').innerHTML = state.bootstrap.countries.map((item) => {
      const group = groups[item.code] || [];
      return `<details class="rule-country-group" ${search && group.length ? 'open':''}><summary><span>${item.flag} ${item.name}</span><em>${group.length} 条佣金规则</em></summary>${group.length ? table(group) : '<p class="empty-group">暂无佣金规则</p>'}</details>`;
    }).join('');
  } else $('#adminTable').innerHTML = table(rows);
  $$('.save-row').forEach((button) => button.onclick = () => saveRuleRow(button));
}

function adminRow(row,config) {
  const id = row.id ?? row.code;
  const cells = config.columns.map(([key,label,type]) => {
    const value = row[key] ?? '';
    if (type === 'readonly') return `<td><b>${escapeHtml(value)}</b></td>`;
    if (type === 'basis') return `<td><select data-field="${key}"><option value="none" ${value === 'none' ? 'selected':''}>不计算</option><option value="sale" ${value === 'sale' ? 'selected':''}>按售价</option><option value="cost" ${value === 'cost' ? 'selected':''}>按成本</option><option value="japan_import" ${value === 'japan_import' ? 'selected':''}>日本进口公式</option></select></td>`;
    if (type === 'freightMode') return `<td><select data-field="${key}"><option value="kg" ${value === 'kg' ? 'selected':''}>按 KG</option><option value="cbm" ${value === 'cbm' ? 'selected':''}>按方</option></select></td>`;
    if (type === 'status') return `<td><select data-field="${key}"><option value="verified" ${value === 'verified' ? 'selected':''}>已核验</option><option value="estimate" ${value === 'estimate' ? 'selected':''}>待核验</option><option value="missing" ${value === 'missing' ? 'selected':''}>待维护</option></select></td>`;
    return `<td><input data-field="${key}" type="${type}" step="any" value="${escapeHtml(value)}"></td>`;
  }).join('');
  return `<tr data-rule-id="${id}">${cells}<td><button class="save-row">保存</button></td></tr>`;
}

async function saveRuleRow(button) {
  const row = button.closest('tr'); const body = {};
  $$('[data-field]',row).forEach((input) => body[input.dataset.field] = input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value);
  await api(`/api/rules/${state.ruleTab}/${encodeURIComponent(row.dataset.ruleId)}`,{ method:'PUT',body:JSON.stringify(body) });
  await refreshBootstrap(); await renderAdmin();
  if (state.projects.length) { state.projects = await Promise.all(state.projects.map((project) => api(`/api/projects/${project.id}`))); await calculateAll(); }
  toast('规则已保存并应用');
}

function switchView(view) {
  state.view = view; $('#calculatorView').classList.toggle('hidden',view !== 'calculator'); $('#adminView').classList.toggle('hidden',view !== 'admin');
  $$('.nav-item[data-view]').forEach((button) => button.classList.toggle('active',button.dataset.view === view));
  if (view === 'admin') renderAdmin(); window.scrollTo({ top:0,behavior:'smooth' });
}

$('#addProjectBtn').onclick = addProject;
$('#productForm').onsubmit = saveProductForm;
$('#readDimensionsBtn').onclick = readDimensionsFromClipboard;
$('#selectProductImage').onclick = () => $('#productImageFile').click();
$('#productImageFile').onchange = (event) => { const [file] = event.target.files; if (file) setProductImage(file); event.target.value = ''; };
$('#removeProductImage').onclick = () => { state.editingProjectImage = ''; renderProductImagePreview(); };
$('#productImageInput').onclick = (event) => { if (!event.target.closest('button')) $('#productImageFile').click(); };
$('#productImageInput').onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#productImageFile').click(); } };
formField($('#productForm'),'dimension_unit').onchange = (event) => { $('#dimensionSuffix').textContent = event.target.value; };
$$('[data-modal-dimension]').forEach((input) => input.addEventListener('paste',handleDimensionPaste));
document.addEventListener('paste',handleProductImagePaste);
$$('[data-close-modal]').forEach((button) => button.onclick = () => closeModal(button.closest('.modal-backdrop')));
$$('.modal-backdrop').forEach((modal) => modal.addEventListener('mousedown',(event) => { if (event.target === modal) closeModal(modal); }));
document.addEventListener('keydown',(event) => { if (event.key === 'Escape') $$('.modal-backdrop:not(.hidden)').forEach(closeModal); });
$$('.nav-item[data-view]').forEach((button) => button.onclick = () => switchView(button.dataset.view));
$$('[data-go-calculator]').forEach((button) => button.onclick = () => switchView('calculator'));
$$('[data-rule-tab]').forEach((button) => button.onclick = () => { $$('[data-rule-tab]').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.ruleTab = button.dataset.ruleTab; renderAdmin(); });
$('#adminCountryFilter').onchange = filterAdmin; $('#adminSearch').oninput = filterAdmin;

initialize().catch((error) => { console.error(error); toast(`加载失败：${error.message}`); });
