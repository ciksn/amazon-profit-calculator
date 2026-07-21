'use strict';

const state={bootstrap:null,project:null,results:[],competitors:[],competitorCounts:{},activeCompetitorSiteCode:'',competitorExpanded:true,marketExpanded:true,editingCompetitorId:null,importCountryCode:'',shareKey:'',saving:0,pending:Promise.resolve()};
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const apiBase=String(window.MARGINGO_API_BASE||'').replace(/\/$/,'');
const syncChannel='BroadcastChannel' in window?new BroadcastChannel('margingo-project-sync'):null;
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,digits=2)=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:digits});
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
  if(!response.ok)throw new Error(payload.error||'请求失败');
  if(String(options.method||'GET').toUpperCase()!=='GET'){
    const message={projectId:state.project?.id,source:'embed',at:Date.now()};syncChannel?.postMessage(message);
    try{localStorage.setItem('margingo-sync-pulse',JSON.stringify(message))}catch{}
  }
  return payload;
}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(el.timer);el.timer=setTimeout(()=>el.classList.remove('show'),2200)}
function saving(start,error=false){state.saving=Math.max(0,state.saving+(start?1:-1));const el=$('#saveState');el.textContent=error?'保存失败':state.saving?'保存中…':'已保存';el.className=`save-state ${error?'error':state.saving?'saving':''}`}
function formValue(name){return $(`[name="${name}"]`,$('#productFields')).value}
function newShareKey(){return globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`}

function encodeState(value){
  const bytes=new TextEncoder().encode(JSON.stringify(value));let binary='';
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function decodeState(value){
  const padded=value.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((value.length+3)%4);
  const binary=atob(padded);const bytes=Uint8Array.from(binary,(char)=>char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function snapshot(){
  const p=state.project;
  return {v:1,key:state.shareKey||newShareKey(),product:{name:p.name,cost_cny:p.cost_cny,length:p.length,width:p.width,height:p.height,dimension_unit:p.dimension_unit,weight:p.weight,weight_unit:p.weight_unit},listings:p.listings.filter((item)=>item.selected).map((item)=>({country_code:item.country_code,selected:true,sale_price:item.sale_price,category_text:item.category_text,referral_rate_override:item.referral_rate_override,declaration_ratio:item.declaration_ratio,declared_value_override:item.declared_value_override,customs_rate:item.customs_rate,consumption_tax_rate:item.consumption_tax_rate,customs_hs_code:item.customs_hs_code,customs_preference:item.customs_preference}))};
}
function stateLink(){const data=snapshot();localStorage.setItem(`margingo-shared-project:${data.key}`,String(state.project.id));const url=new URL('./index.html',location.href);url.search='';url.hash=`data=${encodeState(data)}`;return url.href}

async function importSnapshot(payload,encoded){
  if(payload?.v!==1||!payload.product||!Array.isArray(payload.listings))throw new Error('恢复链接格式不正确');
  state.shareKey=payload.key||newShareKey();const mappingKey=`margingo-embed-import:${encoded.slice(0,80)}`;
  let project=null;const mappedId=localStorage.getItem(mappingKey);
  if(mappedId)project=await api(`/api/projects/${mappedId}`).catch(()=>null);
  if(!project){project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:payload.product.name||'恢复的品类'})});localStorage.setItem(mappingKey,String(project.id))}
  project=await api(`/api/projects/${project.id}`,{method:'PUT',body:JSON.stringify(payload.product)});
  for(const row of project.listings){
    if(row.selected)project=await api(`/api/projects/${project.id}/countries/${row.country_code}`,{method:'PUT',body:JSON.stringify({selected:false})});
  }
  for(const item of payload.listings){
    if(!project.listings.some((row)=>row.country_code===item.country_code))continue;
    project=await api(`/api/projects/${project.id}/countries/${item.country_code}`,{method:'PUT',body:JSON.stringify(item)});
  }
  return project;
}

async function initialize(){
  state.bootstrap=await api('/api/bootstrap');state.activeCompetitorSiteCode=state.bootstrap.countries[0]?.code||'';let project=null;
  const encoded=location.hash.startsWith('#data=')?location.hash.slice(6):'';
  if(encoded){project=await importSnapshot(decodeState(encoded),encoded);toast('已从链接恢复计算参数')}
  const requested=new URLSearchParams(location.search).get('project');
  if(!project&&requested)project=await api(`/api/projects/${requested}`).catch(()=>null);
  if(!project&&state.bootstrap.projects.length)project=await api(`/api/projects/${state.bootstrap.projects[0].id}`);
  if(!project)project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:'新品测算 01'})});
  state.project=project;state.shareKey=state.shareKey||localStorage.getItem(`margingo-embed-key:${project.id}`)||newShareKey();
  localStorage.setItem(`margingo-embed-key:${project.id}`,state.shareKey);
  await refreshProjects();fillProduct();await calculate();await loadCompetitors();bindEvents();
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
    return `<tr><td class="country-cell">${country.flag} ${marketCode(country.code)}<small>${escapeHtml(country.name)}</small></td><td><label class="price-input"><span>${escapeHtml(listing.symbol)}</span><input type="number" min="0" step="0.01" value="${listing.sale_price||''}" placeholder="0.00" data-price="${listing.country_code}"></label></td><td>${number(commission)}%<span class="subvalue">${listing.referral_rate_override==null?escapeHtml(listing.matched_category||'默认费率'):'手动佣金'}</span></td><td>${result?`${escapeHtml(result.symbol)}${number(result.fba_fee)}`:'—'}<span class="subvalue">${escapeHtml(result?.size_tier_name||'待计算')}</span></td><td>${result?`${escapeHtml(result.symbol)}${number(result.freight_fee)}`:'—'}</td><td class="${cls}">${priced&&result?`${result.profit<0?'-':''}${escapeHtml(result.symbol)}${number(Math.abs(result.profit))}`:'—'}</td><td class="profit-rate-cell ${cls}"><b>${priced&&result?`${number(result.profit_rate,1)}%`:'—'}</b>${priced?profitInfoIcon(result):''}</td><td><div class="row-actions"><button class="row-copy-button" type="button" data-copy-listing="${listing.country_code}">复制</button><a class="row-card-link" href="./site-card.html?project=${state.project.id}&country=${listing.country_code}" target="_blank" rel="noopener">单站卡片</a></div></td></tr>`;
  }).join('');
  $$('[data-price]').forEach((input)=>{
    input.oninput=()=>{clearTimeout(input.saveTimer);input.saveTimer=setTimeout(()=>{state.pending=savePrice(input.dataset.price,input.value)},450)};
    input.onchange=()=>{clearTimeout(input.saveTimer);state.pending=savePrice(input.dataset.price,input.value)};
  });
  $$('[data-copy-listing]').forEach((button)=>button.onclick=()=>copyListingResult(button.dataset.copyListing));
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
function competitorRowsFor(code){return state.competitors.filter((item)=>item.country_code===code)}
function yesNoLabel(value){return value==null?'—':Number(value)?'是':'否'}
function competitorImage(item){return item.image_url?`<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.name||item.asin||'竞品')}" loading="lazy" referrerpolicy="no-referrer">`:'<span>无图</span>'}
function competitorRow(item,country){
  const rateClass=item.profit_rate==null?'':Number(item.profit_rate)>=0?'positive':'negative';
  return `<tr title="${escapeHtml(item.name||item.asin||'竞品')}">
    <td class="competitor-image">${competitorImage(item)}</td>
    <td><label class="competitor-price"><span>${escapeHtml(country.symbol)}</span><input type="number" min="0" step="0.01" data-competitor-price="${item.id}" value="${item.sale_price||''}" placeholder="0.00"></label><span class="competitor-name-hint">${escapeHtml(item.name||item.asin||'未命名竞品')}</span></td>
    <td class="competitor-flag">${yesNoLabel(item.is_fba)}</td><td>${yesNoLabel(item.has_aplus)}</td><td>${yesNoLabel(item.has_video)}</td>
    <td>${escapeHtml(item.listing_date||'—')}</td>
    <td class="competitor-link">${item.product_url?`<a href="${escapeHtml(item.product_url)}" target="_blank" rel="noopener">${escapeHtml(item.asin||'打开商品')}</a>`:'—'}</td>
    <td class="competitor-number">${number(item.monthly_sales,0)}</td>
    <td class="competitor-number">${escapeHtml(country.symbol)}${number(item.monthly_revenue_local,2)}</td>
    <td class="competitor-number">$${number(item.monthly_revenue_usd,2)}</td>
    <td class="competitor-number">${item.rating==null?'—':number(item.rating,1)}</td>
    <td class="profit-rate-cell competitor-profit ${rateClass}"><b>${item.profit_rate==null?'—':`${number(item.profit_rate,1)}%`}</b>${profitInfoIcon(item.calculation)}<button class="cost-button" type="button" data-competitor-cost="${item.id}">${item.uses_project_defaults?'跟随产品':'独立成本'} · ¥${number(item.cost_cny)}</button></td>
    <td><div class="competitor-actions"><button class="delete-competitor" type="button" data-delete-competitor="${item.id}">删除</button></div></td>
  </tr>`;
}
function renderCompetitors(){
  renderCompetitorSiteTabs();const selected=state.bootstrap.countries.filter((country)=>country.code===state.activeCompetitorSiteCode);
  if(!selected.length){$('#competitorGroups').innerHTML='<div class="competitor-stats-empty">暂无可用竞品站点</div>';renderCompetitorStats();return}
  $('#competitorGroups').innerHTML=selected.map((country)=>{
    const rows=competitorRowsFor(country.code);const visible=rows.slice(0,5);const total=Number(state.competitorCounts[country.code]??rows.length);
    const body=visible.length?visible.map((item)=>competitorRow(item,country)).join(''):'<tr><td class="competitor-empty" colspan="13">暂无竞品，可手动添加或导入 Excel</td></tr>';
    const sourceNames=[...new Set(rows.map((item)=>item.source_format).filter(Boolean).map((value)=>value==='seller_sprite'?'卖家精灵':value==='helium10'?'H10':value))];
    return `<div class="competitor-site"><div class="competitor-site-head"><div><b>${country.flag} ${marketCode(country.code)} ${escapeHtml(country.name)}</b><small>${total} 条竞品</small>${total>5?'<small class="display-limit">前端仅显示前 5 条</small>':''}</div><div class="competitor-site-head-actions"><button class="copy-competitors" type="button" data-copy-competitors="${country.code}" ${visible.length?'':'disabled'}>复制表格</button><button class="import-competitors" type="button" data-import-competitors="${country.code}">导入 Excel</button><button class="add-competitor" type="button" data-add-competitor="${country.code}">+ 手动添加</button></div></div><div class="competitor-table-wrap"><table class="competitor-table"><thead><tr><th>图片</th><th>售价</th><th>是否FBA</th><th>有无A+</th><th>有无视频</th><th>上架时间</th><th>商品链接</th><th>月销量</th><th>月销售额（当地货币）</th><th>月销售额（美元）</th><th>评分</th><th>预计利润率</th><th>操作</th></tr></thead><tbody>${body}</tbody></table></div><div class="competitor-import-note"><b>导入来源：</b>${sourceNames.length?sourceNames.map(escapeHtml).join('、'):'手动录入'}；重复 ASIN 会更新商品数据并保留已修改的独立成本。</div></div>`;
  }).join('');
  $$('[data-competitor-price]').forEach((input)=>input.onchange=()=>saveCompetitor(input.dataset.competitorPrice,{sale_price:Number(input.value)||0}));
  renderCompetitorStats();
}
function renderCompetitorStats(){
  const cards=[];
  for(const country of state.bootstrap.countries){
    const filled=state.competitors.filter((item)=>item.country_code===country.code&&String(item.name||'').trim()&&Number(item.sale_price)>0&&item.profit_rate!=null);
    if(!filled.length)continue;
    const firstFive=filled.slice(0,5);const average=firstFive.reduce((sum,item)=>sum+Number(item.profit_rate),0)/firstFive.length;
    cards.push(`<div class="competitor-stat"><b>${country.flag} ${marketCode(country.code)} ${escapeHtml(country.name)}</b><span>${number(average,1)}%</span><small>前 ${firstFive.length} 条平均利润率 · 共 ${Number(state.competitorCounts[country.code]??filled.length)} 条数据</small></div>`);
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
    await loadCompetitors();saving(false);toast(`已导入 ${result.imported} 条：新增 ${result.created}，更新 ${result.updated}`);
  }catch(error){saving(false,true);toast(error.message)}finally{if(button)button.disabled=false;event.target.value=''}
}
async function copyCompetitorTable(code){
  const country=state.bootstrap.countries.find((item)=>item.code===code);const rows=competitorRowsFor(code).slice(0,5);
  const headers=['图片','售价','是否FBA','有无A+','有无视频','上架时间','商品链接','月销量','月销售额（当地货币）','月销售额（美元）','评分','预计利润率'];
  const data=rows.map((item)=>[item.image_url?`=IMAGE("${String(item.image_url).replace(/"/g,'""')}")`:'',`${country.symbol}${number(item.sale_price,2)}`,yesNoLabel(item.is_fba),yesNoLabel(item.has_aplus),yesNoLabel(item.has_video),item.listing_date||'',item.product_url||'',number(item.monthly_sales,0),`${country.symbol}${number(item.monthly_revenue_local,2)}`,`$${number(item.monthly_revenue_usd,2)}`,item.rating==null?'':number(item.rating,1),item.profit_rate==null?'':`${number(item.profit_rate,1)}%`]);
  await writeRows([headers,...data]);toast(`已复制 ${marketCode(code)} 站前 ${rows.length} 条竞品表格`);
}
async function addCompetitor(code){
  saving(true);try{await flushDrafts();await api(`/api/projects/${state.project.id}/competitors`,{method:'POST',body:JSON.stringify({country_code:code})});await loadCompetitors();saving(false)}catch(error){saving(false,true);toast(error.message)}
}
async function saveCompetitor(id,changes){
  saving(true);try{await api(`/api/competitors/${id}`,{method:'PUT',body:JSON.stringify(changes)});await loadCompetitors();saving(false)}catch(error){saving(false,true);toast(error.message)}
}
async function deleteCompetitor(id){
  saving(true);try{await api(`/api/competitors/${id}`,{method:'DELETE'});await loadCompetitors();saving(false);toast('已删除竞品数据')}catch(error){saving(false,true);toast(error.message)}
}
function openCostModal(id){
  const item=state.competitors.find((row)=>row.id===id);if(!item)return;state.editingCompetitorId=id;const form=$('#competitorCostForm');
  for(const key of ['category_text','cost_cny','weight','weight_unit','length','width','height','dimension_unit'])form.elements.namedItem(key).value=item[key]??'';
  const country=state.bootstrap.countries.find((row)=>row.code===item.country_code);$('#competitorCostSubtitle').textContent=`${country.flag} ${marketCode(country.code)} · ${item.name||'未命名竞品'}`;$('#competitorDefaultsState').textContent=item.uses_project_defaults?'当前跟随产品参数；保存修改后仅影响此条竞品。':'当前使用独立参数；可恢复为跟随产品。';$('#competitorCostModal').hidden=false;
}
function closeCostModal(){$('#competitorCostModal').hidden=true;state.editingCompetitorId=null}
async function saveCompetitorCost(event){
  event.preventDefault();const form=event.currentTarget;const field=(name)=>form.elements.namedItem(name);const changes={category_text:field('category_text').value.trim(),cost_cny:Number(field('cost_cny').value)||0,weight:Number(field('weight').value)||0,weight_unit:field('weight_unit').value,length:Number(field('length').value)||0,width:Number(field('width').value)||0,height:Number(field('height').value)||0,dimension_unit:field('dimension_unit').value};const id=state.editingCompetitorId;closeCostModal();await saveCompetitor(id,changes);toast('竞品费用参数已保存');
}
async function resetCompetitorDefaults(){const id=state.editingCompetitorId;if(!id)return;closeCostModal();await saveCompetitor(id,{uses_project_defaults:true});toast('已恢复跟随产品参数')}
function requestProjectDelete(){const project=state.project;if(!project)return;$('#projectDeleteMessage').textContent=`确定删除品类“${project.name}”吗？`;$('#projectDeleteModal').hidden=false;$('#confirmProjectDelete').focus()}
function cancelProjectDelete(){$('#projectDeleteModal').hidden=true}
async function confirmProjectDelete(){
  const project=state.project;if(!project)return;cancelProjectDelete();
  saving(true);try{await api(`/api/projects/${project.id}`,{method:'DELETE'});state.bootstrap=await api('/api/bootstrap');state.project=state.bootstrap.projects.length?await api(`/api/projects/${state.bootstrap.projects[0].id}`):await api('/api/projects',{method:'POST',body:JSON.stringify({name:'新品测算 01'})});state.shareKey=localStorage.getItem(`margingo-embed-key:${state.project.id}`)||newShareKey();localStorage.setItem(`margingo-embed-key:${state.project.id}`,state.shareKey);history.replaceState(null,'',`?project=${state.project.id}`);await refreshProjects();fillProduct();await calculate();await loadCompetitors();saving(false);toast('品类已删除')}
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
  try{state.project=await api(`/api/projects/${state.project.id}`,{method:'PUT',body:JSON.stringify(body)});await calculate();await refreshProjects();await loadCompetitors();saving(false)}
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
  $('#projectPicker').onchange=async(event)=>{
    state.project=await api(`/api/projects/${event.target.value}`);state.shareKey=localStorage.getItem(`margingo-embed-key:${state.project.id}`)||newShareKey();localStorage.setItem(`margingo-embed-key:${state.project.id}`,state.shareKey);history.replaceState(null,'',`?project=${state.project.id}`);fillProduct();await calculate();await loadCompetitors();
  };
  $('#newProjectBtn').onclick=async()=>{
    state.project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:`新品测算 ${state.bootstrap.projects.length+1}`})});state.shareKey=newShareKey();localStorage.setItem(`margingo-embed-key:${state.project.id}`,state.shareKey);history.replaceState(null,'',`?project=${state.project.id}`);await refreshProjects();fillProduct();await calculate();await loadCompetitors();toast('已新建品类');
  };
  $('#deleteProjectBtn').onclick=requestProjectDelete;
  $('#confirmProjectDelete').onclick=confirmProjectDelete;
  $$('[data-cancel-project-delete]').forEach((button)=>button.onclick=cancelProjectDelete);
  $('#copySiteProfitBtn').onclick=copySiteProfitTable;
  $('#readDimensionsBtn').onclick=readDimensionsFromClipboard;
  $$('[data-embed-dimension]').forEach((input)=>input.addEventListener('paste',handleDimensionPaste));
  $('#competitorToggle').onclick=toggleCompetitorPanel;
  $('#marketToggle').onclick=toggleMarketPanel;
  $('#competitorExcelInput').onchange=importCompetitorExcel;
  $('#competitorGroups').onclick=(event)=>{const imported=event.target.closest('[data-import-competitors]');if(imported)return beginCompetitorImport(imported.dataset.importCompetitors);const copy=event.target.closest('[data-copy-competitors]');if(copy)return copyCompetitorTable(copy.dataset.copyCompetitors).catch((error)=>toast(error.message));const add=event.target.closest('[data-add-competitor]');if(add)return addCompetitor(add.dataset.addCompetitor);const cost=event.target.closest('[data-competitor-cost]');if(cost)return openCostModal(Number(cost.dataset.competitorCost));const remove=event.target.closest('[data-delete-competitor]');if(remove)return deleteCompetitor(Number(remove.dataset.deleteCompetitor))};
  $('#competitorCostForm').onsubmit=saveCompetitorCost;
  $('#resetCompetitorDefaults').onclick=resetCompetitorDefaults;
  $$('[data-close-cost-modal]').forEach((button)=>button.onclick=closeCostModal);
  syncChannel?.addEventListener('message',(event)=>{
    if(event.data?.source!=='site-card'||Number(event.data.projectId)!==Number(state.project?.id))return;
    clearTimeout(state.syncTimer);state.syncTimer=setTimeout(async()=>{try{state.project=await api(`/api/projects/${state.project.id}`);await refreshProjects();fillProduct();await calculate();await loadCompetitors()}catch{}},180);
  });
  window.addEventListener('storage',(event)=>{if(!['margingo-github-pages-v1','margingo-sync-pulse'].includes(event.key))return;clearTimeout(state.syncTimer);state.syncTimer=setTimeout(async()=>{try{state.project=await api(`/api/projects/${state.project.id}`);await refreshProjects();fillProduct();await calculate();await loadCompetitors()}catch{}},180)});
}

initialize().catch((error)=>{console.error(error);toast(`加载失败：${error.message}`);$('#resultRows').innerHTML=`<tr><td class="empty-row" colspan="8">${escapeHtml(error.message)}</td></tr>`});
