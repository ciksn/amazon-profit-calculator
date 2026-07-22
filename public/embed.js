'use strict';

const state={bootstrap:null,project:null,results:[],competitors:[],competitorCounts:{},activeCompetitorSiteCode:'',competitorExpanded:true,marketExpanded:true,editingCompetitorId:null,importCountryCode:'',manualCountryCode:'',manualAnalysisCountryCode:'',manualAnalysisIds:[],clearCountryCode:'',analyzingSiteCode:'',japanTariffPayload:null,japanTariffSelection:null,shareKey:'',newInstance:false,saving:0,pending:Promise.resolve()};
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const apiBase=String(window.MARGINGO_API_BASE||'').replace(/\/$/,'');
const widgetMode=new URLSearchParams(location.search).get('widget')==='1';
const syncChannel='BroadcastChannel' in window?new BroadcastChannel('margingo-project-sync'):null;
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,digits=2)=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:digits});
const inputNumber=(value,digits)=>Number(Number(value||0).toFixed(digits));
const marketCode=(code)=>code==='GB'?'UK':code;
const resultFor=(code)=>state.results.find((item)=>item.country_code===code);

function sharedCommissionOverride(){
  const values=state.project?.listings?.map((item)=>item.referral_rate_override) || [];
  if(!values.length || values.some((value)=>value===null || value===undefined || value===''))return '';
  const first=Number(values[0]);return values.every((value)=>Number(value)===first)?first:'';
}
function profitInfoIcon(result){
  if(!result || !Number(result.sale_price))return '';
  const money=(value)=>`${result.symbol}${number(value)}`;
  const explanation=[
    '利润率计算过程',
    `含税售价：${money(result.sale_price)}`,
    `减 VAT：${money(result.vat_amount)}`,
    `净销售收入：${money(result.net_revenue)}`,
    `减 ${result.tax_label||'税费'}：${money(result.tax_fee)}`,
    `减佣金：${money(result.referral_fee)}（${number(result.referral_rate,2)}%）`,
    `减 FBA：${money(result.fba_fee)}`,
    `减头程：${money(result.freight_fee)}`,
    `减产品成本：${money(result.product_cost)}`,
    `单件利润：${money(result.profit)}`,
    `利润率：${money(result.profit)} ÷ ${money(result.sale_price)} × 100 = ${number(result.profit_rate,1)}%`
  ].join('\n');
  return `<span class="profit-info" tabindex="0" title="${escapeHtml(explanation)}" aria-label="查看利润率计算过程">i</span>`;
}

async function api(url,options={}){
  const target=/^https?:\/\//i.test(url)?url:`${apiBase}${url}`;
  const response=await fetch(target,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(payload.error||'请求失败');error.status=response.status;throw error}
  if(String(options.method||'GET').toUpperCase()!=='GET'){
    const message={projectId:state.project?.id,source:'embed',at:Date.now()};syncChannel?.postMessage(message);
  }
  return payload;
}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(el.timer);el.timer=setTimeout(()=>el.classList.remove('show'),2200)}
function saving(start,error=false){state.saving=Math.max(0,state.saving+(start?1:-1));const el=$('#saveState');el.textContent=error?'保存失败':state.saving?'保存中…':'已保存';el.className=`save-state ${error?'error':state.saving?'saving':''}`}
function formValue(name){return $(`[name="${name}"]`,$('#productFields')).value}
async function initialize(){
  state.bootstrap=await api('/api/bootstrap');let project=null;
  const requested=Number(new URLSearchParams(location.search).get('project'));
  if(state.bootstrap.projects.some((item)=>Number(item.id)===requested))project=await api(`/api/projects/${requested}`);
  if(!project&&state.bootstrap.projects.length)project=await api(`/api/projects/${state.bootstrap.projects[0].id}`);
  if(!project)project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:'新品测算 01'})});
  state.project=project;state.shareKey='';await refreshProjects();
  state.activeCompetitorSiteCode=state.bootstrap.countries[0]?.code||'';
  fillProduct();await calculate();await loadCompetitors();bindEvents();
}
async function refreshProjects(){
  state.bootstrap=await api('/api/bootstrap');
  const options=state.bootstrap.projects.map((item)=>`<option value="${item.id}" ${Number(item.id)===Number(state.project.id)?'selected':''}>${escapeHtml(item.name)}</option>`).join('');
  $('#projectPicker').innerHTML=options||`<option value="${state.project.id}">${escapeHtml(state.project.name)}</option>`;
}
function sharedCategory(){return state.project.listings.find((item)=>item.selected&&item.category_text)?.category_text||state.project.listings.find((item)=>item.category_text)?.category_text||''}
function fillProduct(){
  for(const key of ['name','cost_cny','weight','weight_unit','length','width','height','dimension_unit'])$(`[name="${key}"]`,$('#productFields')).value=state.project[key]??'';
  $('[name="category_text"]',$('#productFields')).value=sharedCategory();
  $('[name="referral_rate_override"]',$('#productFields')).value=sharedCommissionOverride();renderSites();
}
function renderSites(){
  $('#siteTabs').innerHTML=state.bootstrap.countries.map((country)=>{const listing=state.project.listings.find((item)=>item.country_code===country.code);return `<button class="site-tab ${listing?.selected?'active':''}" type="button" data-country="${country.code}" aria-pressed="${Boolean(listing?.selected)}">${country.flag} ${marketCode(country.code)}</button>`}).join('');
  $('#siteCount').textContent=`已选 ${state.project.listings.filter((item)=>item.selected).length} 个站点`;
  $$('[data-country]').forEach((button)=>button.onclick=()=>toggleSite(button.dataset.country));
}
async function calculate(){const payload=await api('/api/calculate',{method:'POST',body:JSON.stringify({project_id:state.project.id})});state.results=payload.results||[];renderResults()}
function renderResults(){
  const selected=state.project.listings.filter((item)=>item.selected);
  if(!selected.length){$('#resultRows').innerHTML='<tr><td class="empty-row" colspan="8">请至少选择一个测算站点</td></tr>';return}
  $('#resultRows').innerHTML=selected.map((listing)=>{
    const country=state.bootstrap.countries.find((item)=>item.code===listing.country_code);const result=resultFor(listing.country_code);const priced=Number(listing.sale_price)>0;const cls=priced?(Number(result?.profit)>=0?'positive':'negative'):'';const commission=listing.referral_rate_override??listing.matched_referral_rate??result?.referral_base_rate??15;
    return `<tr><td class="country-cell">${country.flag} ${marketCode(country.code)}<small>${escapeHtml(country.name)}</small></td><td><label class="price-input"><span>${escapeHtml(listing.symbol)}</span><input type="number" min="0" step="0.01" value="${listing.sale_price||''}" placeholder="0.00" data-price="${listing.country_code}"></label></td><td>${number(commission)}%<span class="subvalue">${listing.referral_rate_override==null?escapeHtml(listing.matched_category||'默认费率'):'手动佣金'}</span></td><td>${result?`${escapeHtml(result.symbol)}${number(result.fba_fee)}`:'—'}<span class="subvalue">${escapeHtml(result?.size_tier_name||'待计算')}</span></td><td>${result?`${escapeHtml(result.symbol)}${number(result.freight_fee)}`:'—'}</td><td class="${cls}">${priced&&result?`${result.profit<0?'-':''}${escapeHtml(result.symbol)}${number(Math.abs(result.profit))}`:'—'}</td><td class="profit-rate-cell ${cls}"><b>${priced&&result?`${number(result.profit_rate,1)}%`:'—'}</b>${priced?profitInfoIcon(result):''}</td><td><div class="row-actions"><button class="row-copy-button" type="button" data-copy-listing="${listing.country_code}">复制</button><a class="row-card-link" href="./site-card.html?project=${state.project.id}&country=${listing.country_code}" target="_blank" rel="noopener">单站卡片</a>${listing.country_code==='JP'?'<button class="japan-tax-button" type="button" data-japan-tax>税项设置</button>':''}</div></td></tr>`;
  }).join('');
  $$('[data-price]').forEach((input)=>{
    input.oninput=()=>{clearTimeout(input.saveTimer);input.saveTimer=setTimeout(()=>{state.pending=savePrice(input.dataset.price,input.value)},450)};
    input.onchange=()=>{clearTimeout(input.saveTimer);state.pending=savePrice(input.dataset.price,input.value)};
  });
  $$('[data-copy-listing]').forEach((button)=>button.onclick=()=>copyListingResult(button.dataset.copyListing));
  $$('[data-japan-tax]').forEach((button)=>button.onclick=openJapanTaxModal);
}

function japanListing(){return state.project.listings.find((item)=>item.country_code==='JP')}
function openJapanTaxModal(){
  const listing=japanListing();if(!listing)return toast('当前品类没有日本站数据');
  const form=$('#japanTaxForm');form.elements.namedItem('customs_hs_code').value=listing.customs_hs_code||'';
  form.elements.namedItem('customs_preference').value=listing.customs_preference||'unknown';
  form.elements.namedItem('declaration_ratio').value=Number(listing.declaration_ratio??.15)*100;
  form.elements.namedItem('declared_value_override').value=listing.declared_value_override??'';
  form.elements.namedItem('customs_rate').value=Number(listing.customs_rate)||0;
  form.elements.namedItem('consumption_tax_rate').value=Number(listing.consumption_tax_rate??10);
  $('#japanCurrency').textContent=listing.symbol||'¥';
  state.japanTariffPayload=null;state.japanTariffSelection={rateType:listing.customs_rate_type||'',scheduleDate:listing.customs_schedule_date||'',sourceUrl:listing.customs_source_url||''};
  $('#japanTaxLookupResult').innerHTML=listing.customs_schedule_date?`当前税则：${escapeHtml(listing.customs_rate_type||'人工填写')} ${number(listing.customs_rate)}% · ${escapeHtml(listing.customs_schedule_date)}`:'可查询日本海关税率，也可以直接手动填写。';
  $('#japanTaxModal').hidden=false;form.elements.namedItem('customs_hs_code').focus();
}
function closeJapanTaxModal(){$('#japanTaxModal').hidden=true;state.japanTariffPayload=null}
function renderJapanTariffCandidates(payload){
  const result=$('#japanTaxLookupResult');
  if(payload.candidate){applyJapanTariffCandidate(payload.candidate,payload);result.innerHTML=`<b>已匹配 ${escapeHtml(payload.candidate.code)}：${number(payload.candidate.rate)}%</b><small>${escapeHtml(payload.candidate.description||'')} · ${escapeHtml(payload.scheduleDate)}</small>`;return}
  result.innerHTML=`<b>找到 ${payload.candidates.length} 个日本细分税目，请确认：</b><div class="tariff-candidates">${payload.candidates.map((item,index)=>`<button type="button" data-japan-tariff-index="${index}"><strong>${escapeHtml(item.code)}</strong><span>${escapeHtml(item.description||'')}</span><em>${item.rate==null?'需人工确认':`${number(item.rate)}%`}</em></button>`).join('')}</div>`;
  $$('[data-japan-tariff-index]',result).forEach((button)=>button.onclick=()=>{const item=payload.candidates[Number(button.dataset.japanTariffIndex)];if(item.rate==null)return toast('该税目包含复杂税率，请人工填写关税比例');applyJapanTariffCandidate(item,payload);result.innerHTML=`<b>已选择 ${escapeHtml(item.code)}：${number(item.rate)}%</b><small>${escapeHtml(item.description||'')} · ${escapeHtml(payload.scheduleDate)}</small>`});
}
function applyJapanTariffCandidate(candidate,payload){
  $('#japanTaxForm').elements.namedItem('customs_rate').value=candidate.rate;
  state.japanTariffSelection={rateType:candidate.rateType||'',scheduleDate:payload.scheduleDate||'',sourceUrl:payload.sourceUrl||''};
}
async function lookupJapanTax(){
  const form=$('#japanTaxForm');const hsCode=form.elements.namedItem('customs_hs_code').value.replace(/\D/g,'');
  if(hsCode.length!==10)return toast('请输入国内 10 位 HS 编码');
  const button=$('#lookupJapanTaxBtn');button.disabled=true;button.textContent='查询中…';$('#japanTaxLookupResult').textContent='正在读取日本海关税则…';
  try{const payload=await api('/api/tariffs/japan/lookup',{method:'POST',body:JSON.stringify({hs_code:hsCode,origin_country:'CN',preference:form.elements.namedItem('customs_preference').value})});state.japanTariffPayload=payload;renderJapanTariffCandidates(payload)}
  catch(error){$('#japanTaxLookupResult').textContent=`${error.message}；可继续手动填写`;toast(error.message)}
  finally{button.disabled=false;button.textContent='查询日本税率'}
}
async function saveJapanTax(event){
  event.preventDefault();const form=event.currentTarget;const value=(name)=>form.elements.namedItem(name).value;
  const changes={customs_hs_code:value('customs_hs_code').replace(/\D/g,''),customs_origin_country:'CN',customs_preference:value('customs_preference'),
    declaration_ratio:(Number(value('declaration_ratio'))||0)/100,declared_value_override:value('declared_value_override')===''?null:Number(value('declared_value_override')),
    customs_rate:Number(value('customs_rate'))||0,consumption_tax_rate:Number(value('consumption_tax_rate'))||0,
    customs_rate_type:state.japanTariffSelection?.rateType||'',customs_schedule_date:state.japanTariffSelection?.scheduleDate||'',customs_source_url:state.japanTariffSelection?.sourceUrl||''};
  saving(true);
  try{state.project=await api(`/api/projects/${state.project.id}/countries/JP`,{method:'PUT',body:JSON.stringify(changes)});closeJapanTaxModal();await calculate();await loadCompetitors();saving(false);toast('当前品类的日本税项已保存')}
  catch(error){saving(false,true);toast(error.message)}
}

async function loadCompetitors(){
  const payload=await api(`/api/projects/${state.project.id}/competitors`);state.competitors=payload.competitors||[];state.competitorCounts=payload.competitor_counts||{};renderCompetitors();
}
function renderCompetitorSiteTabs(){
  $('#competitorSiteTabs').innerHTML=state.bootstrap.countries.map((country)=>`<button class="site-tab ${state.activeCompetitorSiteCode===country.code?'active':''}" type="button" data-competitor-country="${country.code}" aria-pressed="${state.activeCompetitorSiteCode===country.code}">${country.flag} ${marketCode(country.code)}</button>`).join('');
  $$('[data-competitor-country]').forEach((button)=>button.onclick=()=>toggleCompetitorSite(button.dataset.competitorCountry));
}
function toggleCompetitorSite(code){
  state.activeCompetitorSiteCode=code;renderCompetitors();
}
function competitorRowsFor(code){return state.competitors.filter((item)=>item.country_code===code).sort((a,b)=>Number(b.monthly_revenue_local)-Number(a.monthly_revenue_local)||Number(a.id)-Number(b.id))}
function yesNoLabel(value){return value==null?'—':Number(value)?'是':'否'}
function competitorImage(item){
  if(!item.image_url)return '<span>无图</span>';
  const label=item.name||item.asin||'竞品';
  return `<button class="competitor-image-button" type="button" data-preview-image="${escapeHtml(item.image_url)}" data-preview-alt="${escapeHtml(label)}" aria-label="查看 ${escapeHtml(label)} 大图"><img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(label)}" loading="lazy" referrerpolicy="no-referrer"></button>`;
}
function openImagePreview(button){
  const url=button.dataset.previewImage;if(!url)return;
  const label=button.dataset.previewAlt||'竞品图片';const modal=$('#imagePreviewModal');
  $('#imagePreview').src=url;$('#imagePreview').alt=label;$('#imagePreviewCaption').textContent=label;modal.hidden=false;modal.querySelector('.image-preview-close').focus();
}
function closeImagePreview(){const modal=$('#imagePreviewModal');modal.hidden=true;$('#imagePreview').removeAttribute('src')}
function storedList(value){if(Array.isArray(value))return value;try{const parsed=JSON.parse(value||'[]');return Array.isArray(parsed)?parsed:[]}catch{return []}}
function competitorAnalysisText(item){
  if(item.analysis_status==='insufficient')return `资料不足：${item.analysis_warning||'未获取到合规卖点'}`;
  const points=storedList(item.selling_points),difference=storedList(item.differentiation);
  if(item.analysis_status!=='complete'||!points.length)return '待分析';
  return `卖点：${points.join('、')}${difference.length?`｜差异：${difference.join('、')}`:''}`;
}
function competitorRow(item,country){
  const rateClass=item.profit_rate==null?'':Number(item.profit_rate)>=0?'positive':'negative';
  const analysis=competitorAnalysisText(item);
  return `<tr title="${escapeHtml(item.name||item.asin||'竞品')}">
    <td class="competitor-image">${competitorImage(item)}</td>
    <td class="competitor-sale"><label class="competitor-price"><span>${escapeHtml(country.symbol)}</span><input type="number" min="0" step="0.01" data-competitor-price="${item.id}" value="${item.sale_price||''}" placeholder="0.00"></label><span class="competitor-name-hint">${escapeHtml(item.name||item.asin||'未命名竞品')}</span></td>
    <td class="competitor-link">${item.product_url?`<a href="${escapeHtml(item.product_url)}" target="_blank" rel="noopener">${escapeHtml(item.asin||'打开商品')}</a>`:'—'}</td>
    <td class="competitor-number competitor-revenue">${escapeHtml(country.symbol)}${number(item.monthly_revenue_local,2)}</td>
    <td class="competitor-number competitor-rating">${item.rating==null?'—':number(item.rating,1)}</td>
    <td class="competitor-cost"><label class="competitor-cost-input"><span>¥</span><input type="number" min="0" step="0.01" data-competitor-cost-input="${item.id}" value="${inputNumber(item.cost_cny,2)}" aria-label="${escapeHtml(item.name||item.asin||'竞品')}采购成本"></label><button class="competitor-params-button" type="button" data-competitor-params="${item.id}">${item.uses_project_defaults?'跟随产品参数':'独立参数'}</button></td>
    <td class="profit-rate-cell competitor-profit ${rateClass}"><b>${item.profit_rate==null?'—':`${number(item.profit_rate,1)}%`}</b>${profitInfoIcon(item.calculation)}</td>
    <td class="competitor-analysis" title="${escapeHtml(analysis)}"><span>${escapeHtml(analysis)}</span></td>
    <td><div class="competitor-actions"><button class="delete-competitor" type="button" data-delete-competitor="${item.id}">删除</button></div></td>
  </tr>`;
}
function renderCompetitors(){
  renderCompetitorSiteTabs();const selected=state.bootstrap.countries.filter((country)=>country.code===state.activeCompetitorSiteCode);
  if(!selected.length){$('#competitorGroups').innerHTML='<div class="competitor-stats-empty">暂无可用竞品站点</div>';renderCompetitorStats();return}
  $('#competitorGroups').innerHTML=selected.map((country)=>{
    const rows=competitorRowsFor(country.code);const visible=rows.slice(0,5);const total=Number(state.competitorCounts[country.code]??rows.length);
    const body=visible.length?visible.map((item)=>competitorRow(item,country)).join(''):'<tr><td class="competitor-empty" colspan="9">暂无竞品，可手动添加或导入 Excel</td></tr>';
    const sourceNames=[...new Set(rows.map((item)=>item.source_format).filter(Boolean).map((value)=>value==='seller_sprite'?'卖家精灵':value==='helium10'?'H10':value))];
    return `<div class="competitor-site"><div class="competitor-site-head"><div><b>${country.flag} ${marketCode(country.code)} ${escapeHtml(country.name)}</b><small>${total} 条竞品</small>${total>5?'<small class="display-limit">按月销售额显示前 5 条</small>':''}</div><div class="competitor-site-head-actions"><button class="copy-competitors" type="button" data-copy-competitors="${country.code}" ${visible.length?'':'disabled'}>复制表格</button><button class="import-competitors" type="button" data-import-competitors="${country.code}">导入 Excel</button><button class="add-competitor" type="button" data-add-competitor="${country.code}">+ 手动添加</button><button class="analyze-competitors" type="button" data-analyze-competitors="${country.code}" ${total&&state.analyzingSiteCode!==country.code?'':'disabled'}>${state.analyzingSiteCode===country.code?'分析中…':'卖点分析'}</button><button class="clear-competitors" type="button" data-clear-competitors="${country.code}" ${total?'':'disabled'}>清除本站</button></div></div><div class="competitor-table-wrap"><table class="competitor-table"><colgroup><col class="col-image"><col class="col-sale"><col class="col-link"><col class="col-revenue"><col class="col-rating"><col class="col-cost"><col class="col-profit"><col class="col-analysis"><col class="col-action"></colgroup><thead><tr><th>图片</th><th>售价</th><th>商品链接</th><th>月销售额（当地货币）</th><th>评分</th><th>竞品成本</th><th>预计利润率</th><th>卖点分析</th><th>操作</th></tr></thead><tbody>${body}</tbody></table></div><div class="competitor-import-note"><b>导入来源：</b>${sourceNames.length?sourceNames.map(escapeHtml).join('、'):'手动录入'}；多次导入与手动数据自动取并集并按 ASIN 去重，每份 Excel 仅保留前 30 条，表格按月销售额从高到低排列；导入参数按 Excel 计算，成本默认继承产品并可在表格中直接修改。</div></div>`;
  }).join('');
  $$('[data-competitor-price]').forEach((input)=>input.onchange=()=>saveCompetitor(input.dataset.competitorPrice,{sale_price:Number(input.value)||0}));
  $$('[data-competitor-cost-input]').forEach((input)=>{
    let committed=Number(input.value)||0;
    const commit=()=>{const next=Number(input.value)||0;if(next===committed)return;committed=next;saveCompetitor(input.dataset.competitorCostInput,{cost_cny:next})};
    input.onchange=commit;input.onblur=commit;input.onkeydown=(event)=>{if(event.key==='Enter')input.blur()};
  });
  renderCompetitorStats();
}
function renderCompetitorStats(){
  const cards=[];
  for(const country of state.bootstrap.countries){
    const filled=state.competitors.filter((item)=>item.country_code===country.code&&String(item.name||'').trim()&&Number(item.sale_price)>0&&item.profit_rate!=null);
    if(!filled.length)continue;
    const firstThree=filled.slice(0,3);const divisor=firstThree.length;
    const averageSales=firstThree.reduce((sum,item)=>sum+Number(item.monthly_sales),0)/divisor;
    const averageRevenueUsd=firstThree.reduce((sum,item)=>sum+Number(item.monthly_revenue_usd),0)/divisor;
    const averageProfit=firstThree.reduce((sum,item)=>sum+Number(item.profit_rate),0)/divisor;
    cards.push(`<div class="competitor-stat"><b>${country.flag} ${marketCode(country.code)} ${escapeHtml(country.name)}</b><div class="competitor-stat-metrics"><span><small>前三平均销量</small>${number(averageSales,0)}</span><span><small>前三平均销售额（USD）</small>$${number(averageRevenueUsd,2)}</span><span><small>前三平均利润率</small>${number(averageProfit,1)}%</span></div><small>按前 ${divisor} 条有效竞品统计 · 共 ${Number(state.competitorCounts[country.code]??filled.length)} 条数据</small></div>`);
  }
  $('#competitorStats').innerHTML=cards.join('')||'<div class="competitor-stats-empty">填写竞品名称和售价后，将在这里生成站点统计</div>';
}
function beginCompetitorImport(code){state.importCountryCode=code;const input=$('#competitorExcelInput');input.value='';input.click()}
async function importCompetitorExcel(event){
  const file=event.target.files?.[0];const code=state.importCountryCode;if(!file||!code)return;
  const country=state.bootstrap.countries.find((item)=>item.code===code);const usd=state.bootstrap.countries.find((item)=>item.code==='US');const button=$(`[data-import-competitors="${code}"]`);
  if(button)button.disabled=true;saving(true);
  try{
    const parsed=await window.MarginGoCompetitorImport.parseWorkbook(await file.arrayBuffer(),window.ExcelJS,{countryCode:code,countryCnyPerLocal:country.cny_per_local,usdCnyPerLocal:usd?.cny_per_local});
    if(!parsed.rows.length)throw new Error('Excel 中没有可导入的有效产品');
    const result=await api(`/api/projects/${state.project.id}/competitors/import`,{method:'POST',body:JSON.stringify({country_code:code,rows:parsed.rows})});
    await loadCompetitors();saving(false);toast(`已处理前 ${result.imported} 条：新增 ${result.created}，去重更新 ${result.updated}${result.discarded?`，已忽略后 ${result.discarded} 条`:''}`);
  }catch(error){saving(false,true);toast(error.message)}finally{if(button)button.disabled=false;event.target.value=''}
}
async function copyCompetitorTable(code){
  const country=state.bootstrap.countries.find((item)=>item.code===code);const rows=competitorRowsFor(code).slice(0,5);
  const data=rows.map((item)=>[item.image_url?`=IMAGE("${String(item.image_url).replace(/"/g,'""')}")`:'',`${country.symbol}${number(item.sale_price,2)}`,yesNoLabel(item.is_fba),yesNoLabel(item.has_aplus),yesNoLabel(item.has_video),item.listing_date||'',item.product_url||'',number(item.monthly_sales,0),`${country.symbol}${number(item.monthly_revenue_local,2)}`,`$${number(item.monthly_revenue_usd,2)}`,item.rating==null?'':number(item.rating,1),`¥${number(item.cost_cny,2)}`,item.profit_rate==null?'':`${number(item.profit_rate,1)}%`,competitorAnalysisText(item)]);
  await writeRows(data);toast(`已复制 ${marketCode(code)} 站前 ${rows.length} 条竞品表格（不含列名）`);
}
async function copyCompetitorStats(){
  const data=[];let populated=0;
  for(const code of ['US','JP','DE','GB','CA','AU','AE','SA']){
    const country=state.bootstrap.countries.find((item)=>item.code===code);if(!country)continue;
    const rows=state.competitors.filter((item)=>item.country_code===country.code&&String(item.name||'').trim()&&Number(item.sale_price)>0&&item.profit_rate!=null).slice(0,3);
    if(rows.length){
      data.push([number(rows.reduce((sum,item)=>sum+Number(item.monthly_revenue_usd),0)/rows.length,2),`${number(rows.reduce((sum,item)=>sum+Number(item.profit_rate),0)/rows.length,1)}%`,number(rows.reduce((sum,item)=>sum+Number(item.monthly_sales),0)/rows.length,0)]);populated+=1;
    }else data.push(['','','']);
    data.push(['','','']);
  }
  if(!populated)throw new Error('暂无可复制的竞品统计');
  await writeRows(data);toast(`已复制 ${populated} 个站点的前三竞品统计，可从 B2 一次粘贴`);
}
function addCompetitor(code){
  const country=state.bootstrap.countries.find((item)=>item.code===code);if(!country)return;
  state.manualCountryCode=code;const form=$('#manualCompetitorForm');form.reset();
  $('#manualCompetitorSubtitle').textContent=`${country.flag} ${marketCode(code)} · ${country.name}`;
  $$('[data-manual-currency]',form).forEach((item)=>item.textContent=country.currency);
  $('#manualCompetitorModal').hidden=false;form.elements.namedItem('name').focus();
}
function closeManualCompetitor(){$('#manualCompetitorModal').hidden=true;state.manualCountryCode=''}
async function saveManualCompetitor(event){
  event.preventDefault();const code=state.manualCountryCode;const country=state.bootstrap.countries.find((item)=>item.code===code);if(!code||!country)return;
  const form=event.currentTarget;const value=(name)=>form.elements.namedItem(name).value.trim();const numeric=(name)=>Number(value(name))||0;
  const usd=state.bootstrap.countries.find((item)=>item.code==='US');const localRevenue=numeric('monthly_revenue_local');
  const payload={country_code:code,name:value('name'),asin:value('asin'),sale_price:numeric('sale_price'),monthly_sales:numeric('monthly_sales'),monthly_revenue_local:localRevenue,
    monthly_revenue_usd:code==='US'?localRevenue:(Number(country.cny_per_local)&&Number(usd?.cny_per_local)?localRevenue*Number(country.cny_per_local)/Number(usd.cny_per_local):0),
    rating:value('rating')===''?null:numeric('rating'),product_url:value('product_url'),image_url:value('image_url')};
  closeManualCompetitor();saving(true);try{await flushDrafts();await api(`/api/projects/${state.project.id}/competitors`,{method:'POST',body:JSON.stringify(payload)});await loadCompetitors();saving(false);toast(`已添加 ${marketCode(code)} 手动竞品${localRevenue?'，已按月销售额重新排序':'；月销售额为 0，可能排在前五之外'}`)}catch(error){saving(false,true);toast(error.message)}
}
async function saveCompetitor(id,changes){
  saving(true);try{await api(`/api/competitors/${id}`,{method:'PUT',body:JSON.stringify(changes)});await loadCompetitors();saving(false)}catch(error){saving(false,true);toast(error.message)}
}
async function deleteCompetitor(id){
  saving(true);try{await api(`/api/competitors/${id}`,{method:'DELETE'});await loadCompetitors();saving(false);toast('已删除竞品数据')}catch(error){saving(false,true);toast(error.message)}
}
async function analyzeCompetitors(code){
  if(state.analyzingSiteCode)return;state.analyzingSiteCode=code;renderCompetitors();saving(true);
  try{let result;for(let attempt=0;attempt<3;attempt+=1){try{result=await api(`/api/projects/${state.project.id}/competitors/analyze`,{method:'POST',body:JSON.stringify({country_code:code})});break}catch(error){const transient=!error.status||error.status===408||error.status===425||error.status===429||error.status>=500;if(!transient||attempt===2)throw error;toast(`网络波动，正在重试 ${attempt+1}/2…`);await new Promise((resolve)=>setTimeout(resolve,1200*(attempt+1)))}}await loadCompetitors();saving(false);const failed=failedAnalysisRows(code);const summary=result.attempted===0?`前五竞品已有卖点，无需重复分析`:`本次分析 ${result.analyzed}/${result.attempted} 条${result.skipped?`，跳过已有结果 ${result.skipped} 条`:''}`;toast(failed.length?`${summary}，请补充 ${failed.length} 条竞品五点`:`${summary}，分析完成`);if(failed.length)openManualAnalysis(code,failed)}
  catch(error){saving(false,true);toast(error.message)}finally{state.analyzingSiteCode='';renderCompetitors()}
}
function failedAnalysisRows(code,ids=null){
  const allowed=ids?new Set(ids.map(Number)):null;
  return competitorRowsFor(code).slice(0,5).filter((item)=>(!allowed||allowed.has(Number(item.id)))&&item.analysis_status==='insufficient');
}
function manualAnalysisRow(item){
  const label=item.name||item.asin||'未命名竞品';const bullets=storedList(item.feature_bullets).join('\n');
  return `<section class="manual-analysis-row"><div class="manual-analysis-product">${item.image_url?`<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(label)}" loading="lazy" referrerpolicy="no-referrer">`:'<span class="manual-analysis-image-empty">无图</span>'}<div><b>${escapeHtml(label)}</b>${item.product_url?`<a href="${escapeHtml(item.product_url)}" target="_blank" rel="noopener">打开商品链接</a>`:'<small>无商品链接</small>'}<small class="manual-analysis-warning">${escapeHtml(item.analysis_warning||'未获取到合规卖点')}</small></div></div><label class="field"><span>五点描述（每行一条）</span><textarea data-manual-analysis-bullets="${item.id}" maxlength="10000" required placeholder="将五点描述粘贴到这里，每行一条">${escapeHtml(bullets)}</textarea></label></section>`;
}
function openManualAnalysis(code,rows=failedAnalysisRows(code)){
  if(!rows.length)return;state.manualAnalysisCountryCode=code;state.manualAnalysisIds=rows.map((item)=>Number(item.id));
  $('#manualAnalysisRows').innerHTML=rows.map(manualAnalysisRow).join('');$('#manualAnalysisError').textContent='';$('#manualAnalysisModal').hidden=false;$('#manualAnalysisRows textarea')?.focus();
}
function closeManualAnalysis(){$('#manualAnalysisModal').hidden=true;state.manualAnalysisCountryCode='';state.manualAnalysisIds=[];$('#manualAnalysisError').textContent=''}
async function submitManualAnalysis(event){
  event.preventDefault();const code=state.manualAnalysisCountryCode;if(!code)return;
  const manualRows=state.manualAnalysisIds.map((id)=>{const input=$(`[data-manual-analysis-bullets="${id}"]`);const feature_bullets=String(input?.value||'').split(/\r?\n/).map((line)=>line.replace(/^\s*[•·*-]+\s*/, '').trim()).filter(Boolean).slice(0,10);return {id,feature_bullets}});
  const missing=manualRows.find((row)=>!row.feature_bullets.length);if(missing){$(`[data-manual-analysis-bullets="${missing.id}"]`)?.focus();$('#manualAnalysisError').textContent='请为每个失败竞品输入至少一条五点描述。';return}
  const button=$('#submitManualAnalysis');button.disabled=true;button.textContent='分析中…';$('#manualAnalysisError').textContent='';saving(true);
  try{await api(`/api/projects/${state.project.id}/competitors/analyze`,{method:'POST',body:JSON.stringify({country_code:code,manual_rows:manualRows})});await loadCompetitors();const failed=failedAnalysisRows(code,state.manualAnalysisIds);saving(false);if(!failed.length){closeManualAnalysis();toast('手动补充的竞品已全部分析成功');return}state.manualAnalysisIds=failed.map((item)=>Number(item.id));$('#manualAnalysisRows').innerHTML=failed.map(manualAnalysisRow).join('');$('#manualAnalysisError').textContent=`仍有 ${failed.length} 条竞品未生成合规卖点，请检查五点内容后重试。`}
  catch(error){saving(false,true);$('#manualAnalysisError').textContent=error.message}finally{button.disabled=false;button.textContent='分析'}
}
function clearCompetitors(code){
  const country=state.bootstrap.countries.find((item)=>item.code===code);const total=Number(state.competitorCounts[code]||0);if(!country||!total)return;
  state.clearCountryCode=code;$('#competitorClearMessage').textContent=`确定清除 ${marketCode(code)} ${country.name} 的全部 ${total} 条竞品数据吗？`;
  $('#competitorClearModal').hidden=false;$('#confirmCompetitorClear').focus();
}
function cancelCompetitorClear(){$('#competitorClearModal').hidden=true;state.clearCountryCode=''}
async function confirmCompetitorClear(){
  const code=state.clearCountryCode;if(!code)return;cancelCompetitorClear();saving(true);
  try{const result=await api(`/api/projects/${state.project.id}/competitors?country_code=${encodeURIComponent(code)}`,{method:'DELETE'});await loadCompetitors();saving(false);toast(`已清除 ${result.deleted} 条竞品数据`)}catch(error){saving(false,true);toast(error.message)}
}
function openCostModal(id){
  const item=state.competitors.find((row)=>row.id===id);if(!item)return;state.editingCompetitorId=id;const form=$('#competitorCostForm');
  for(const key of ['category_text','weight','weight_unit','length','width','height','dimension_unit'])form.elements.namedItem(key).value=key==='weight'?inputNumber(item[key],3):['length','width','height'].includes(key)?inputNumber(item[key],2):(item[key]??'');
  const country=state.bootstrap.countries.find((row)=>row.code===item.country_code);$('#competitorCostSubtitle').textContent=`${country.flag} ${marketCode(country.code)} · ${item.name||'未命名竞品'}`;$('#competitorDefaultsState').textContent=item.uses_project_defaults?'当前跟随产品参数；保存修改后仅影响此条竞品。':'当前使用独立参数；可恢复为跟随产品。';$('#competitorCostModal').hidden=false;
}
function closeCostModal(){$('#competitorCostModal').hidden=true;state.editingCompetitorId=null}
async function saveCompetitorCost(event){
  event.preventDefault();const form=event.currentTarget;const field=(name)=>form.elements.namedItem(name);const changes={category_text:field('category_text').value.trim(),weight:Number(field('weight').value)||0,weight_unit:field('weight_unit').value,length:Number(field('length').value)||0,width:Number(field('width').value)||0,height:Number(field('height').value)||0,dimension_unit:field('dimension_unit').value};const id=state.editingCompetitorId;closeCostModal();await saveCompetitor(id,changes);toast('竞品尺寸参数已保存');
}
async function resetCompetitorDefaults(){const id=state.editingCompetitorId;if(!id)return;closeCostModal();await saveCompetitor(id,{uses_project_defaults:true});toast('已恢复跟随产品参数')}
function requestProjectDelete(){const project=state.project;if(!project)return;$('#projectDeleteMessage').textContent=`确定删除品类“${project.name}”吗？`;$('#projectDeleteModal').hidden=false;$('#confirmProjectDelete').focus()}
function cancelProjectDelete(){$('#projectDeleteModal').hidden=true}
async function confirmProjectDelete(){
  const project=state.project;if(!project)return;cancelProjectDelete();saving(true);
  try{await api(`/api/projects/${project.id}`,{method:'DELETE'});state.bootstrap=await api('/api/bootstrap');state.project=state.bootstrap.projects.length?await api(`/api/projects/${state.bootstrap.projects[0].id}`):await api('/api/projects',{method:'POST',body:JSON.stringify({name:'新品测算 01'})});history.replaceState(null,'',`?project=${state.project.id}`);await refreshProjects();fillProduct();await calculate();await loadCompetitors();saving(false);toast('品类已删除')}
  catch(error){saving(false,true);toast(error.message)}
}
function applyParsedDimensions(parsed){
  const fields=$('#productFields');for(const key of ['length','width','height'])$(`[name="${key}"]`,fields).value=parsed[key];$('[name="dimension_unit"]',fields).value=parsed.unit;toast(`已识别：${parsed.length} × ${parsed.width} × ${parsed.height} ${parsed.unit}`);state.pending=saveProduct();
}
function recognizeDimensions(text){
  const parsed=window.DimensionParser?.parseDimensions(text,formValue('dimension_unit')||'cm');if(!parsed){toast('未识别到完整尺寸，请使用如 27.2 × 12.5 × 54 cm 的格式');return false}applyParsedDimensions(parsed);return true;
}
async function readDimensionsFromClipboard(){
  if(!navigator.clipboard?.readText)return toast('当前浏览器无法读取剪贴板，请在任一尺寸框直接粘贴');
  try{const text=await navigator.clipboard.readText();if(!text.trim())return toast('剪贴板为空，请先复制完整尺寸');recognizeDimensions(text)}catch{toast('剪贴板读取被拦截，请在任一尺寸框直接粘贴')}
}
function handleDimensionPaste(event){const text=event.clipboardData?.getData('text')||'';const parsed=window.DimensionParser?.parseDimensions(text,formValue('dimension_unit')||'cm');if(!parsed)return;event.preventDefault();applyParsedDimensions(parsed)}
function toggleCompetitorPanel(){
  state.competitorExpanded=!state.competitorExpanded;const panel=$('.competitor-panel');panel.classList.toggle('collapsed',!state.competitorExpanded);$('#competitorToggle').setAttribute('aria-expanded',String(state.competitorExpanded));$('.competitor-toggle-label').firstChild.textContent=state.competitorExpanded?'收起 ':'展开 ';
}
function toggleMarketPanel(){
  state.marketExpanded=!state.marketExpanded;const panel=$('.market-panel');panel.classList.toggle('collapsed',!state.marketExpanded);$('#marketToggle').setAttribute('aria-expanded',String(state.marketExpanded));$('.market-toggle-label').firstChild.textContent=state.marketExpanded?'收起 ':'展开 ';
}

async function saveProduct(){
  const body={name:formValue('name').trim()||'未命名品类',cost_cny:Number(formValue('cost_cny'))||0,weight:Number(formValue('weight'))||0,weight_unit:formValue('weight_unit'),length:Number(formValue('length'))||0,width:Number(formValue('width'))||0,height:Number(formValue('height'))||0,dimension_unit:formValue('dimension_unit')};
  saving(true);
  try{state.project=await api(`/api/projects/${state.project.id}`,{method:'PUT',body:JSON.stringify(body)});await calculate();await loadCompetitors();saving(false)}
  catch(error){saving(false,true);toast(error.message)}
}
async function saveCategory(){
  const text=formValue('category_text').trim();saving(true);
  try{
    for(const listing of state.project.listings.filter((item)=>item.selected)){
      const matched=await api('/api/commission/match',{method:'POST',body:JSON.stringify({country_code:listing.country_code,text,sale_price:listing.sale_price})});
      const changes={category_text:text};
      if(matched.matched)Object.assign(changes,{matched_category:matched.rule.parent_category,matched_referral_rate:matched.rule.rate,matched_referral_threshold:matched.rule.threshold_price,matched_referral_rate_above:matched.rule.rate_above,matched_referral_minimum:matched.rule.minimum_fee||0});
      state.project=await api(`/api/projects/${state.project.id}/countries/${listing.country_code}`,{method:'PUT',body:JSON.stringify(changes)});
    }
    await calculate();await loadCompetitors();saving(false);
  }catch(error){saving(false,true);toast(error.message)}
}
async function saveCommission(){
  const raw=formValue('referral_rate_override');const value=raw===''?null:Number(raw);
  if(value!==null && (!Number.isFinite(value) || value<0 || value>100))return toast('佣金比例请输入 0–100');
  saving(true);
  try{
    for(const listing of state.project.listings)state.project=await api(`/api/projects/${state.project.id}/countries/${listing.country_code}`,{method:'PUT',body:JSON.stringify({referral_rate_override:value})});
    await calculate();await loadCompetitors();saving(false);toast(value===null?'已恢复按父品类匹配佣金':`全部站点佣金已设为 ${number(value,2)}%`);
  }catch(error){saving(false,true);toast(error.message)}
}
async function toggleSite(code){
  const listing=state.project.listings.find((item)=>item.country_code===code);
  if(listing.selected&&state.project.listings.filter((item)=>item.selected).length===1)return toast('至少保留一个测算站点');
  saving(true);
  try{state.project=await api(`/api/projects/${state.project.id}/countries/${code}`,{method:'PUT',body:JSON.stringify({selected:!listing.selected,category_text:sharedCategory()})});renderSites();await calculate();renderCompetitors();saving(false)}
  catch(error){saving(false,true);toast(error.message)}
}
async function savePrice(code,value){
  saving(true);
  try{state.project=await api(`/api/projects/${state.project.id}/countries/${code}`,{method:'PUT',body:JSON.stringify({sale_price:Number(value)||0})});await calculate();saving(false)}
  catch(error){saving(false,true);toast(error.message)}
}

async function flushDrafts(){
  await state.pending;
  const draftPrices=Object.fromEntries($$('[data-price]').map((input)=>[input.dataset.price,input.value]));
  await saveProduct();
  if(formValue('category_text').trim()!==sharedCategory())await saveCategory();
  const commissionDraft=formValue('referral_rate_override');
  if((commissionDraft===''?null:Number(commissionDraft))!==(sharedCommissionOverride()===''?null:Number(sharedCommissionOverride())))await saveCommission();
  for(const [code,value] of Object.entries(draftPrices)){
    const listing=state.project.listings.find((item)=>item.country_code===code);
    if(Number(value||0)!==Number(listing?.sale_price||0))await savePrice(code,value);
  }
}
async function writeRows(rows,linkIndex=-1){
  const tsv=rows.map((row)=>row.join('\t')).join('\n');
  const html=`<table><tbody>${rows.map((row)=>`<tr>${row.map((item,index)=>index===linkIndex?`<td><a href="${escapeHtml(item)}">调整</a></td>`:`<td>${escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  try{if(globalThis.ClipboardItem&&navigator.clipboard?.write){await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([tsv],{type:'text/plain'})})]);return}}catch{}
  const holder=document.createElement('div');holder.contentEditable='true';holder.setAttribute('aria-hidden','true');holder.style.cssText='position:fixed;left:-10000px;top:0;opacity:.01;pointer-events:none';holder.innerHTML=html;document.body.append(holder);
  const selection=getSelection();const range=document.createRange();range.selectNode(holder.firstElementChild);selection.removeAllRanges();selection.addRange(range);const copiedAsTable=document.execCommand('copy');selection.removeAllRanges();holder.remove();
  if(copiedAsTable)return;
  const helper=document.createElement('textarea');helper.value=tsv;helper.style.cssText='position:fixed;opacity:0';document.body.append(helper);helper.select();document.execCommand('copy');helper.remove();
}
async function copyListingResult(code){
  const listing=state.project.listings.find((item)=>item.country_code===code);const country=state.bootstrap.countries.find((item)=>item.code===code);const result=resultFor(code);const price=$(`[data-price="${code}"]`)?.value??listing.sale_price;
  await writeRows([[`${marketCode(country.code)} ${country.name}`,`${listing.symbol}${number(price)}`,result?`${number(result.profit_rate,1)}%`:'—']]);toast(`已复制 ${marketCode(code)} 站点数据`);flushDrafts().catch((error)=>toast(error.message));
}
async function copySiteProfitTable(){
  const rows=state.project.listings.filter((item)=>item.selected).map((listing)=>{const country=state.bootstrap.countries.find((item)=>item.code===listing.country_code);const result=resultFor(listing.country_code);const price=$(`[data-price="${listing.country_code}"]`)?.value??listing.sale_price;return [`${marketCode(country.code)} ${country.name}`,`${listing.symbol}${number(price)}`,result?`${number(result.profit_rate,1)}%`:'—']});
  await writeRows(rows);toast(`已复制 ${rows.length} 行站点利润率`);flushDrafts().catch((error)=>toast(error.message));
}

function bindEvents(){
  let commissionSaveTimer;
  $$('input,select',$('#productFields')).forEach((input)=>{
    if(input.name==='referral_rate_override'){
      input.oninput=()=>{clearTimeout(commissionSaveTimer);commissionSaveTimer=setTimeout(()=>{state.pending=saveCommission()},450)};
      input.onchange=()=>{clearTimeout(commissionSaveTimer);state.pending=saveCommission()};
      return;
    }
    input.onchange=()=>{state.pending=input.name==='category_text'?saveCategory():saveProduct()};
  });
  $('#projectPicker').onchange=async(event)=>{state.project=await api(`/api/projects/${event.target.value}`);history.replaceState(null,'',`?project=${state.project.id}`);fillProduct();await calculate();await loadCompetitors()};
  $('#newProjectBtn').onclick=async()=>{state.project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:`新品测算 ${state.bootstrap.projects.length+1}`})});history.replaceState(null,'',`?project=${state.project.id}`);await refreshProjects();fillProduct();await calculate();await loadCompetitors();toast('已新建品类')};
  $('#deleteProjectBtn').onclick=requestProjectDelete;
  $('#confirmProjectDelete').onclick=confirmProjectDelete;
  $$('[data-cancel-project-delete]').forEach((button)=>button.onclick=cancelProjectDelete);
  $('#copySiteProfitBtn').onclick=copySiteProfitTable;
  $('#japanTaxForm').onsubmit=saveJapanTax;
  $('#lookupJapanTaxBtn').onclick=lookupJapanTax;
  $$('[data-close-japan-tax]').forEach((button)=>button.onclick=closeJapanTaxModal);
  $('#copyCompetitorStatsBtn').onclick=()=>copyCompetitorStats().catch((error)=>toast(error.message));
  $('#readDimensionsBtn').onclick=readDimensionsFromClipboard;
  $$('[data-embed-dimension]').forEach((input)=>input.addEventListener('paste',handleDimensionPaste));
  $('#competitorToggle').onclick=toggleCompetitorPanel;
  $('#marketToggle').onclick=toggleMarketPanel;
  $('#competitorExcelInput').onchange=importCompetitorExcel;
  $('#competitorGroups').onclick=(event)=>{const preview=event.target.closest('[data-preview-image]');if(preview)return openImagePreview(preview);const imported=event.target.closest('[data-import-competitors]');if(imported)return beginCompetitorImport(imported.dataset.importCompetitors);const copy=event.target.closest('[data-copy-competitors]');if(copy)return copyCompetitorTable(copy.dataset.copyCompetitors).catch((error)=>toast(error.message));const add=event.target.closest('[data-add-competitor]');if(add)return addCompetitor(add.dataset.addCompetitor);const analyze=event.target.closest('[data-analyze-competitors]');if(analyze)return analyzeCompetitors(analyze.dataset.analyzeCompetitors);const clear=event.target.closest('[data-clear-competitors]');if(clear)return clearCompetitors(clear.dataset.clearCompetitors);const params=event.target.closest('[data-competitor-params]');if(params)return openCostModal(Number(params.dataset.competitorParams));const remove=event.target.closest('[data-delete-competitor]');if(remove)return deleteCompetitor(Number(remove.dataset.deleteCompetitor))};
  $$('[data-close-image-preview]').forEach((button)=>button.onclick=closeImagePreview);
  document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&!$('#imagePreviewModal').hidden)closeImagePreview()});
  $('#competitorCostForm').onsubmit=saveCompetitorCost;
  $('#manualCompetitorForm').onsubmit=saveManualCompetitor;
  $$('[data-close-manual-competitor]').forEach((button)=>button.onclick=closeManualCompetitor);
  $('#manualAnalysisForm').onsubmit=submitManualAnalysis;
  $$('[data-close-manual-analysis]').forEach((button)=>button.onclick=closeManualAnalysis);
  $('#confirmCompetitorClear').onclick=confirmCompetitorClear;
  $$('[data-cancel-competitor-clear]').forEach((button)=>button.onclick=cancelCompetitorClear);
  $('#resetCompetitorDefaults').onclick=resetCompetitorDefaults;
  $$('[data-close-cost-modal]').forEach((button)=>button.onclick=closeCostModal);
  syncChannel?.addEventListener('message',(event)=>{
    if(event.data?.source!=='site-card'||Number(event.data.projectId)!==Number(state.project?.id))return;
    clearTimeout(state.syncTimer);state.syncTimer=setTimeout(async()=>{try{state.project=await api(`/api/projects/${state.project.id}`);fillProduct();await calculate();await loadCompetitors()}catch{}},180);
  });
  window.addEventListener('focus',()=>{clearTimeout(state.syncTimer);state.syncTimer=setTimeout(async()=>{try{state.project=await api(`/api/projects/${state.project.id}`);fillProduct();await calculate();await loadCompetitors()}catch{}},180)});
}

initialize().catch((error)=>{console.error(error);toast(`加载失败：${error.message}`);$('#resultRows').innerHTML=`<tr><td class="empty-row" colspan="8">${escapeHtml(error.message)}</td></tr>`});
