'use strict';

const state = { bootstrap:null, project:null, activeCountry:'AU', results:[], view:'calculator', ruleTab:'countries', ruleRows:[] };
const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g,(char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const saveTimers = new Map();
const apiBase = String(window.MARGINGO_API_BASE || '').replace(/\/$/,'');

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

function weightMetric(label,value,tooltip='') {
  const className = tooltip ? 'weight-metric has-tooltip' : 'weight-metric';
  const tooltipAttrs = tooltip
    ? ` tabindex="0" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(`${label} ${value}。${tooltip}`)}"`
    : '';
  return `<div class="${className}"${tooltipAttrs}><span>${escapeHtml(label)}${tooltip ? '<i aria-hidden="true">i</i>' : ''}</span><b>${escapeHtml(value)}</b></div>`;
}

function debounceSave(fn,key='default') {
  $('#saveState').textContent = '保存中…';
  clearTimeout(saveTimers.get(key));
  saveTimers.set(key,setTimeout(async () => {
    try { await fn(); $('#saveState').textContent = '已保存'; } catch (error) { $('#saveState').textContent = '保存失败'; toast(error.message); }
    finally { saveTimers.delete(key); }
  },350));
}

async function initialize() {
  state.bootstrap = await api('/api/bootstrap');
  $('#adminCountryFilter').innerHTML = '<option value="">全部国家</option>' + state.bootstrap.countries.map((c) => `<option value="${c.code}">${c.flag} ${c.name}</option>`).join('');
  if (!state.bootstrap.projects.length) return renderEmptyCalculator();
  await loadProject(state.bootstrap.projects[0].id);
}

async function refreshBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
  renderProjectTabs();
}

async function loadProject(id) {
  state.project = await api(`/api/projects/${id}`);
  const selected = state.project.listings.filter((item) => item.selected);
  if (!selected.some((item) => item.country_code === state.activeCountry)) state.activeCountry = selected[0]?.country_code || 'AU';
  renderAll();
  await calculate();
}

function renderAll() {
  renderProjectTabs(); renderProjectFields(); renderCountries(); renderListingEditor();
}

function renderProjectTabs() {
  $('#projectTabs').innerHTML = state.bootstrap.projects.map((project) => `<button class="project-tab ${state.project?.id === project.id ? 'active':''}" data-project-id="${project.id}">${escapeHtml(project.name)}</button>`).join('');
  $$('.project-tab').forEach((button) => button.onclick = () => loadProject(Number(button.dataset.projectId)));
}

function renderProjectFields() {
  const p = state.project;
  for (const key of ['name','cost_cny','length','width','height','dimension_unit','weight','weight_unit']) {
    const el = $(`[data-project="${key}"]`); if (el) { el.disabled = false; el.value = p[key] ?? ''; }
  }
  $('#readDimensionsBtn').disabled = false;
  $('#projectMenuBtn').disabled = false;
  $('#dimensionSuffix').textContent = p.dimension_unit;
}

function renderEmptyCalculator() {
  state.project = null;
  state.results = [];
  state.activeCountry = 'AU';
  renderProjectTabs();
  $$('[data-project]').forEach((input) => { input.value = ''; input.disabled = true; });
  $('#dimensionUnit').value = 'cm';
  $('#weightUnit').value = 'kg';
  $('#dimensionSuffix').textContent = 'cm';
  $('#readDimensionsBtn').disabled = true;
  $('#projectMenuBtn').disabled = true;
  $('#saveState').textContent = '等待新增';
  $('#selectedCount').textContent = '0 个站点';
  $('#countrySelector').innerHTML = '<p class="empty-calculator-message">新增品类后即可选择计算站点</p>';
  $('#countryTabs').innerHTML = '';
  $('#listingEditor').innerHTML = '<p class="empty-calculator-message">请先点击“新增品类”开始测算</p>';
  $('#resultPanel').innerHTML = '<div class="empty-result"><p>新增品类后显示利润结果</p></div>';
  $('#comparisonGrid').innerHTML = '<p class="empty-calculator-message">暂无测算品类</p>';
}

function applyParsedDimensions(parsed,sourceLabel) {
  const changes = { length:parsed.length,width:parsed.width,height:parsed.height,dimension_unit:parsed.unit };
  Object.assign(state.project,changes);
  renderProjectFields();
  debounceSave(async () => {
    state.project = await api(`/api/projects/${state.project.id}`,{ method:'PUT',body:JSON.stringify(changes) });
    await calculate();
  },`project:${state.project.id}:dimensions`);
  toast(`${sourceLabel}识别成功：${parsed.length} × ${parsed.width} × ${parsed.height} ${parsed.unit}`);
}

function recognizeDimensions(text,sourceLabel='尺寸') {
  const parsed = window.DimensionParser?.parseDimensions(text,state.project?.dimension_unit || 'cm');
  if (!parsed) {
    toast('未识别到完整尺寸，请使用如 27.2*12.5*54 cm 的格式');
    return false;
  }
  applyParsedDimensions(parsed,sourceLabel);
  return true;
}

async function readDimensionsFromClipboard() {
  if (!navigator.clipboard?.readText) return toast('当前浏览器无法读取剪贴板，请在任一尺寸框中直接粘贴');
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return toast('剪贴板为空，请先复制完整尺寸');
    recognizeDimensions(text,'剪贴板');
  } catch {
    toast('剪贴板读取被拦截，请在任一尺寸框中直接粘贴');
  }
}

function handleDimensionPaste(event) {
  const text = event.clipboardData?.getData('text') || '';
  const parsed = window.DimensionParser?.parseDimensions(text,state.project?.dimension_unit || 'cm');
  if (!parsed) return;
  event.preventDefault();
  applyParsedDimensions(parsed,'粘贴尺寸');
}

function renderCountries() {
  const listings = state.project.listings;
  $('#countrySelector').innerHTML = state.bootstrap.countries.map((country) => {
    const listing = listings.find((item) => item.country_code === country.code);
    return `<button class="country-check ${listing.selected ? 'active':''} ${country.code === 'AU' ? 'prior':''}" data-country-check="${country.code}"><span class="flag">${country.flag}</span><span>${country.name}</span><span class="check">${listing.selected ? '✓':''}</span></button>`;
  }).join('');
  const selected = listings.filter((item) => item.selected);
  $('#selectedCount').textContent = `${selected.length} 个站点`;
  $('#countryTabs').innerHTML = selected.map((listing) => `<button class="country-tab ${listing.country_code === state.activeCountry ? 'active':''}" data-country-tab="${listing.country_code}">${listing.flag} ${listing.country_name}</button>`).join('');
  $$('[data-country-check]').forEach((button) => button.onclick = () => toggleCountry(button.dataset.countryCheck));
  $$('[data-country-tab]').forEach((button) => button.onclick = () => { state.activeCountry = button.dataset.countryTab; renderCountries(); renderListingEditor(); renderResult(); });
}

async function toggleCountry(code) {
  const listing = state.project.listings.find((item) => item.country_code === code);
  const selectedCount = state.project.listings.filter((item) => item.selected).length;
  if (listing.selected && selectedCount === 1) return toast('至少保留一个计算站点');
  state.project = await api(`/api/projects/${state.project.id}/countries/${code}`,{ method:'PUT',body:JSON.stringify({ selected:!listing.selected }) });
  if (!listing.selected) state.activeCountry = code;
  else if (state.activeCountry === code) state.activeCountry = state.project.listings.find((item) => item.selected)?.country_code;
  renderCountries(); renderListingEditor(); await calculate();
}

function renderListingEditor() {
  const listing = state.project.listings.find((item) => item.country_code === state.activeCountry);
  if (!listing) { $('#listingEditor').innerHTML = '<p>请先勾选一个站点。</p>'; return; }
  const commission = listing.referral_rate_override ?? listing.matched_referral_rate ?? 15;
  const freightIsCbm = listing.freight_pricing_mode === 'cbm';
  const freightField = freightIsCbm ? 'freight_price_per_cbm_cny' : 'freight_price_per_kg_cny';
  const freightValue = Number(listing[freightField]) || 0;
  const autoDeclaredValue = (Number(listing.sale_price) || 0) * Number(listing.declaration_ratio ?? 0.15);
  const japanFields = listing.country_code === 'JP' ? `
    <div class="field span-2 japan-tariff-lookup">
      <span>日本进口关税查询</span>
      <div class="tariff-query-grid">
        <input id="customsHsCode" inputmode="numeric" value="${escapeHtml(listing.customs_hs_code)}" placeholder="输入6位或9位日本HS编码">
        <select id="customsOriginCountry"><option value="CN">中国原产</option></select>
        <select id="customsPreference">
          <option value="unknown" ${listing.customs_preference === 'unknown' ? 'selected':''}>RCEP资格未知</option>
          <option value="none" ${listing.customs_preference === 'none' ? 'selected':''}>不使用RCEP优惠</option>
          <option value="rcep" ${listing.customs_preference === 'rcep' ? 'selected':''}>具备RCEP原产地证明</option>
        </select>
        <button class="match-button" id="lookupJapanTariff" type="button">查询最新税率</button>
      </div>
      <div class="tariff-lookup-result" id="tariffLookupResult">${listing.customs_schedule_date ? `当前：${escapeHtml(listing.customs_rate_type || '人工填写')} ${Number(listing.customs_rate) || 0}% · 税则 ${escapeHtml(listing.customs_schedule_date)}` : '数据来自日本海关；查询失败时仍可手动填写关税比例'}</div>
    </div>
    <label class="field"><span>申报比例（留空申报价时使用）</span><div class="input-affix"><input id="declarationRatio" type="number" min="0" max="100" step="0.1" value="${Number(listing.declaration_ratio ?? 0.15) * 100}"><em>%</em></div></label>
    <label class="field"><span>申报价（可覆盖自动值）</span><div class="input-affix"><b>${listing.symbol}</b><input id="declaredValue" type="number" min="0" step="0.01" value="${listing.declared_value_override ?? ''}" placeholder="自动：${autoDeclaredValue.toFixed(2)}"><em>${listing.currency}</em></div></label>
    <label class="field"><span>关税比例（运营填写）</span><div class="input-affix"><input id="customsRate" type="number" min="0" max="100" step="0.1" value="${Number(listing.customs_rate) || 0}"><em>%</em></div></label>
    <label class="field"><span>消费税比例</span><div class="input-affix"><input id="consumptionTaxRate" type="number" min="0" max="100" step="0.1" value="${Number(listing.consumption_tax_rate ?? 10)}"><em>%</em></div></label>` : '';
  $('#listingEditor').innerHTML = `<div class="listing-form">
    <label class="field"><span>当地售价（${listing.currency}）</span><div class="input-affix"><b>${listing.symbol}</b><input id="salePrice" type="number" min="0" step="0.01" value="${listing.sale_price || ''}"><em>${listing.currency}</em></div></label>
    <label class="field"><span>佣金比例（可手动改）</span><div class="input-affix"><input id="referralRate" type="number" min="0" max="100" step="0.1" value="${commission}"><em>%</em></div></label>
    <label class="field"><span>货代单价（人民币，可手动改）</span><div class="input-affix"><b>¥</b><input id="freightUnitPrice" type="number" min="0" step="0.01" value="${freightValue}"><em>${freightIsCbm ? '元/方' : '元/KG'}</em></div></label>
    ${japanFields}
    <div class="field category-box"><span>父品类名称</span><div class="category-actions"><input id="categoryText" value="${escapeHtml(listing.category_text)}" placeholder="复制粘贴，例如 Home & Kitchen"><button class="match-button" id="matchCommission">智能匹配</button></div><div class="match-result" id="matchResult">${listing.matched_category ? `${listing.commission_fallback ? '未命中具体品类，使用' : '已匹配'}：${escapeHtml(listing.matched_category)} · ${listing.matched_referral_rate}%` : '粘贴父品类后点击匹配'}</div></div>
  </div>`;
  $('#salePrice').oninput = (event) => saveListing({ sale_price:Number(event.target.value) || 0 });
  $('#referralRate').oninput = (event) => saveListing({ referral_rate_override:event.target.value === '' ? null : Number(event.target.value) });
  $('#freightUnitPrice').oninput = (event) => saveFreightUnit(freightField,Number(event.target.value) || 0);
  if (listing.country_code === 'JP') {
    $('#customsHsCode').onchange = (event) => saveListing({ customs_hs_code:event.target.value.replace(/\D/g,'') },false);
    $('#customsPreference').onchange = (event) => saveListing({ customs_preference:event.target.value },false);
    $('#lookupJapanTariff').onclick = () => lookupJapanTariff();
    $('#declarationRatio').oninput = (event) => saveListing({ declaration_ratio:(Number(event.target.value) || 0) / 100 });
    $('#declaredValue').oninput = (event) => saveListing({ declared_value_override:event.target.value === '' ? null : Number(event.target.value) });
    $('#customsRate').oninput = (event) => saveListing({ customs_rate:Number(event.target.value) || 0 });
    $('#consumptionTaxRate').oninput = (event) => saveListing({ consumption_tax_rate:Number(event.target.value) || 0 });
  }
  $('#categoryText').oninput = (event) => saveListing({ category_text:event.target.value },false);
  $('#matchCommission').onclick = matchCommission;
}

function renderTariffCandidates(payload) {
  const result = $('#tariffLookupResult');
  const candidates = payload.candidates || [];
  result.innerHTML = `<b>需要确认日本细分编码</b><small>税则日期 ${escapeHtml(payload.scheduleDate)}，请选择与商品相符的描述</small><div class="tariff-candidates">${candidates.map((candidate) => `<button type="button" data-tariff-code="${candidate.code}"><b>${escapeHtml(candidate.code)}</b><span>${escapeHtml(candidate.description || '无英文描述')}</span><em>${escapeHtml(candidate.rateText || '需人工确认')}</em></button>`).join('')}</div>`;
  $$('[data-tariff-code]',result).forEach((button) => button.onclick = () => lookupJapanTariff(button.dataset.tariffCode));
}

async function lookupJapanTariff(selectedCode = '') {
  const button = $('#lookupJapanTariff');
  const hsCode = selectedCode || $('#customsHsCode').value;
  const preference = $('#customsPreference').value;
  if (!hsCode.replace(/\D/g,'')) return toast('请先输入日本 HS 编码');
  button.disabled = true;
  button.textContent = '查询中…';
  $('#tariffLookupResult').textContent = '正在读取日本海关最新税则…';
  try {
    const payload = await api('/api/tariffs/japan/lookup',{ method:'POST',body:JSON.stringify({ hs_code:hsCode,origin_country:'CN',preference }) });
    if (!payload.candidate) return renderTariffCandidates(payload);
    const candidate = payload.candidate;
    const changes = {
      customs_hs_code:candidate.code,
      customs_origin_country:'CN',
      customs_preference:preference,
      customs_rate:candidate.rate,
      customs_rate_type:candidate.rateType,
      customs_schedule_date:payload.scheduleDate,
      customs_source_url:payload.sourceUrl
    };
    state.project = await api(`/api/projects/${state.project.id}/countries/JP`,{ method:'PUT',body:JSON.stringify(changes) });
    renderListingEditor();
    await calculate();
    const result = $('#tariffLookupResult');
    result.innerHTML = `<b>已采用 ${escapeHtml(candidate.rateType)}：${candidate.rate}%</b><small>${escapeHtml(candidate.code)} · ${escapeHtml(candidate.description)} · 税则 ${escapeHtml(payload.scheduleDate)}${candidate.warning ? ` · ${escapeHtml(candidate.warning)}` : ''}</small><a href="${escapeHtml(payload.sourceUrl)}" target="_blank" rel="noopener">查看日本海关来源</a>`;
    toast('已填入最新关税比例并重新计算');
  } catch (error) {
    $('#tariffLookupResult').textContent = `${error.message}；可继续手动填写关税比例`;
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = '查询最新税率';
  }
}

function saveFreightUnit(field,value) {
  const listing = state.project.listings.find((item) => item.country_code === state.activeCountry);
  listing[field] = value;
  debounceSave(async () => {
    await api(`/api/rules/freight/${listing.freight_rule_id}`,{ method:'PUT',body:JSON.stringify({ [field.replace('freight_','')]:value }) });
    await calculate();
  },`freight:${listing.country_code}:${field}`);
}

function saveListing(changes, recalc=true) {
  Object.assign(state.project.listings.find((item) => item.country_code === state.activeCountry),changes);
  const saveKey = `listing:${state.project.id}:${state.activeCountry}:${Object.keys(changes).sort().join(',')}`;
  debounceSave(async () => {
    state.project = await api(`/api/projects/${state.project.id}/countries/${state.activeCountry}`,{ method:'PUT',body:JSON.stringify(changes) });
    if (recalc) await calculate();
  },saveKey);
}

async function matchCommission() {
  const text = $('#categoryText').value.trim();
  if (!text) return toast('请先粘贴父品类名称');
  const salePrice = Number($('#salePrice').value) || 0;
  const result = await api('/api/commission/match',{ method:'POST',body:JSON.stringify({ country_code:state.activeCountry,text,sale_price:salePrice }) });
  if (!result.matched) { $('#matchResult').textContent = '未找到匹配规则，请在后台添加或手动输入佣金'; return; }
  const changes = { category_text:text,matched_category:result.rule.parent_category,matched_referral_rate:result.rule.rate,matched_referral_threshold:result.rule.threshold_price,matched_referral_rate_above:result.rule.rate_above,matched_referral_minimum:result.rule.minimum_fee || 0,referral_rate_override:null };
  state.project = await api(`/api/projects/${state.project.id}/countries/${state.activeCountry}`,{ method:'PUT',body:JSON.stringify(changes) });
  renderListingEditor(); await calculate(); toast(result.fallback ? '未找到具体品类，已使用其他类别佣金' : '佣金规则匹配成功');
}

async function calculate() {
  const payload = await api('/api/calculate',{ method:'POST',body:JSON.stringify({ project_id:state.project.id }) });
  state.results = payload.results; renderResult(); renderComparison();
}

function renderResult() {
  const result = state.results.find((item) => item.country_code === state.activeCountry) || state.results[0];
  if (!result) { $('#resultPanel').innerHTML = '<div class="empty-result"><p>请选择站点</p></div>'; return; }
  const country = state.bootstrap.countries.find((item) => item.code === result.country_code);
  const hasPrice = result.sale_price > 0;
  const cls = !hasPrice ? '' : result.profit_rate >= 0 ? 'positive':'negative';
  const rateText = hasPrice ? result.profit_rate.toFixed(1) : '—';
  const profitText = result.profit < 0 ? `-${result.symbol}${Math.abs(result.profit).toFixed(2)}` : `${result.symbol}${result.profit.toFixed(2)}`;
  const exchangeRateText = Number(country.cny_per_local).toLocaleString('zh-CN',{ minimumFractionDigits:2,maximumFractionDigits:4 });
  const taxRows = result.tax_basis === 'japan_import'
    ? `<div class="breakdown-row"><span>申报价 · ${result.declared_value_overridden ? '手动填写' : `售价×${result.declaration_ratio}%`}</span><b>${result.symbol}${result.declared_value.toFixed(2)}</b></div><div class="breakdown-row"><span>关税 · 申报价×${result.customs_rate}%</span><b>-${result.symbol}${result.customs_duty.toFixed(2)}</b></div><div class="breakdown-row"><span>消费税 ·（申报价＋关税）×${result.consumption_tax_rate}%</span><b>-${result.symbol}${result.consumption_tax.toFixed(2)}</b></div><div class="breakdown-row"><span>日本税金合计</span><b>-${result.symbol}${result.tax_fee.toFixed(2)}</b></div>`
    : `<div class="breakdown-row"><span>${escapeHtml(result.tax_label)} · ${result.tax_basis === 'cost' ? '成本' : '售价'}×${result.tax_rate}%</span><b>-${result.symbol}${result.tax_fee.toFixed(2)}</b></div>${result.vat_rate > 0 ? `<div class="breakdown-row"><span>VAT · ${result.vat_rate}%（含税价拆分）</span><b>-${result.symbol}${result.vat_amount.toFixed(2)}</b></div>` : ''}`;
  const fbaRows = result.fba_surcharge_rate > 0
    ? `<div class="breakdown-row"><span>FBA基础配送费 · ${escapeHtml(result.fba_rule_name)}</span><b>-${result.symbol}${result.fba_base_fee.toFixed(2)}</b></div><div class="breakdown-row surcharge-row"><span>燃油及物流附加费 · FBA×${result.fba_surcharge_rate}%</span><b>-${result.symbol}${result.fba_surcharge_fee.toFixed(2)}</b></div>`
    : `<div class="breakdown-row"><span>FBA · ${escapeHtml(result.fba_rule_name)}</span><b>-${result.symbol}${result.fba_fee.toFixed(2)}</b></div>`;
  const freightWeightMetrics = result.freight_pricing_mode === 'cbm'
    ? [
        weightMetric('商品体积',`${result.volume_cbm} m³`),
        weightMetric('头程计费方式','按方计费')
      ]
    : [
        weightMetric('头程体积重',`${result.volume_weight_kg} kg`,`固定体积重除数：${result.freight_volume_divisor}`),
        weightMetric('头程计费重',`${result.billable_weight_kg} kg`)
      ];
  const weightMetrics = [
    weightMetric('实际重量',`${result.actual_weight_kg} kg`),
    ...freightWeightMetrics,
    weightMetric('FBA 体积重',`${result.fba_volume_weight_kg} kg`,`站点规则体积重除数：${result.fba_volume_divisor}`),
    weightMetric('FBA 计费重',`${result.fba_billable_weight_kg} kg`,'实重与体积重取较大值')
  ].join('');
  $('#resultPanel').innerHTML = `<div class="result-content"><div class="result-top"><div class="market-label"><span class="flag">${country.flag}</span><div><b>${country.name}站利润</b><small>${result.currency} · 含税售价口径</small></div></div><span class="estimate-tag">实时测算</span></div>
    <div class="exchange-rate-card"><span>当前汇率</span><b>1 ${escapeHtml(result.currency)} = ¥${exchangeRateText} CNY</b><small>人民币成本按此汇率换算</small></div>
    <div class="margin-hero"><small>预计利润率</small><div class="margin-number ${cls}">${rateText}${hasPrice ? '<sup>%</sup>' : ''}</div><div class="profit-value">单件利润 <b>${hasPrice ? profitText : '待填写售价'}</b></div></div>
    <div class="size-tier-box"><span>该站点尺寸分段</span><b>${escapeHtml(result.size_tier_name)}</b><small>${result.dimensions_cm.join(' × ')} cm</small></div>
    <div class="breakdown"><div class="breakdown-row"><span>含税售价</span><b>${result.symbol}${result.sale_price.toFixed(2)}</b></div>${taxRows}<div class="breakdown-row"><span>产品成本</span><b>-${result.symbol}${result.product_cost.toFixed(2)}</b></div><div class="breakdown-row"><span>平台佣金 · ${result.referral_threshold ? `${result.referral_base_rate}% / 超出${result.referral_threshold}后${result.referral_rate_above}%` : `${result.referral_rate}%`}</span><b>-${result.symbol}${result.referral_fee.toFixed(2)}</b></div>${fbaRows}<div class="breakdown-row"><span>头程运费</span><b>-${result.symbol}${result.freight_fee.toFixed(2)}</b></div><div class="breakdown-row total final-profit-row"><span>售价减去全部费用</span><b class="${hasPrice ? (result.profit >= 0 ? 'positive' : 'negative') : ''}">${hasPrice ? profitText : '—'}</b></div></div>
    <div class="weight-note"><div class="weight-note-head"><b>重量与计费依据</b><small>悬停 <i>i</i> 查看说明</small></div><div class="weight-metric-grid">${weightMetrics}</div></div>
    <ul class="warning-list">${result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></div>`;
}

function renderComparison() {
  $('#comparisonGrid').innerHTML = state.results.map((result) => {
    const country = state.bootstrap.countries.find((item) => item.code === result.country_code);
    const hasPrice = result.sale_price > 0;
    return `<article class="comparison-card ${result.country_code === 'AU' ? 'primary':''}"><div class="comparison-head"><b>${country.flag} ${country.name}</b><span>${result.currency}</span></div><div class="comparison-rate ${hasPrice ? (result.profit_rate >= 0 ? 'positive':'negative') : ''}">${hasPrice ? `${result.profit_rate.toFixed(1)}%` : '—'}</div><small>${hasPrice ? `单件利润 ${result.symbol}${result.profit.toFixed(2)}` : '待填写售价'}</small></article>`;
  }).join('') || '<p>暂无已选站点。</p>';
}

async function saveProjectField(event) {
  if (!state.project) return;
  const key = event.target.dataset.project; let value = event.target.value;
  if (event.target.type === 'number') value = Number(value) || 0;
  state.project[key] = value;
  if (key === 'dimension_unit') $('#dimensionSuffix').textContent = value;
  if (key === 'name') {
    const summary = state.bootstrap.projects.find((item) => item.id === state.project.id); if (summary) summary.name = value;
    renderProjectTabs();
  }
  debounceSave(async () => { state.project = await api(`/api/projects/${state.project.id}`,{ method:'PUT',body:JSON.stringify({ [key]:value }) }); await refreshBootstrap(); await calculate(); },`project:${state.project.id}:${key}`);
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
  } else {
    $('#adminTable').innerHTML = table(rows);
  }
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
  if (state.project) { state.project = await api(`/api/projects/${state.project.id}`); await calculate(); }
  toast('规则已保存并应用');
}

function switchView(view) {
  state.view = view; $('#calculatorView').classList.toggle('hidden',view !== 'calculator'); $('#adminView').classList.toggle('hidden',view !== 'admin');
  $$('.nav-item[data-view]').forEach((button) => button.classList.toggle('active',button.dataset.view === view));
  if (view === 'admin') renderAdmin(); window.scrollTo({ top:0,behavior:'smooth' });
}

$$('[data-project]').forEach((input) => input.addEventListener('input',saveProjectField));
$$('[data-dimension-input]').forEach((input) => input.addEventListener('paste',handleDimensionPaste));
$('#readDimensionsBtn').onclick = readDimensionsFromClipboard;
$('#addProjectBtn').onclick = async () => { const project = await api('/api/projects',{ method:'POST',body:JSON.stringify({ name:`新品测算 ${String(state.bootstrap.projects.length + 1).padStart(2,'0')}` }) }); await refreshBootstrap(); await loadProject(project.id); toast('已新增品类'); };
$('#projectMenuBtn').onclick = async () => { if (!state.project || !confirm(`删除“${state.project.name}”？`)) return; try { await api(`/api/projects/${state.project.id}`,{ method:'DELETE' }); await refreshBootstrap(); if (state.bootstrap.projects.length) await loadProject(state.bootstrap.projects[0].id); else renderEmptyCalculator(); toast('已删除品类'); } catch(error) { toast(error.message); } };
$$('.nav-item[data-view]').forEach((button) => button.onclick = () => switchView(button.dataset.view));
$$('[data-go-admin]').forEach((button) => button.onclick = () => switchView('admin'));
$$('[data-go-calculator]').forEach((button) => button.onclick = () => switchView('calculator'));
$$('[data-rule-tab]').forEach((button) => button.onclick = () => { $$('[data-rule-tab]').forEach((item) => item.classList.remove('active')); button.classList.add('active'); state.ruleTab = button.dataset.ruleTab; renderAdmin(); });
$('#adminCountryFilter').onchange = filterAdmin; $('#adminSearch').oninput = filterAdmin;

initialize().catch((error) => { console.error(error); toast(`加载失败：${error.message}`); });
