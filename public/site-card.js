'use strict';

const state={bootstrap:null,project:null,country:null,listing:null,result:null,records:[],recordResults:new Map(),recordTimers:new Map(),recordRequestVersions:new Map(),shareKey:'',saving:0,pending:Promise.resolve(),reloadTimer:null};
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const apiBase=String(window.MARGINGO_API_BASE||'').replace(/\/$/,'');
const syncChannel='BroadcastChannel' in window?new BroadcastChannel('margingo-project-sync'):null;
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,digits=2)=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:digits});
const marketCode=(code)=>code==='GB'?'UK':code;
const field=(name)=>$(`[name="${name}"]`);
const legacyRecordStorageKey='margingo-site-card-records-v1';

async function api(url,options={}){
  const scoped=state.shareKey?url
    .replace(/^\/api\/projects\/\d+\/site-card-records/,'/api/embed/site-card-records')
    .replace(/^\/api\/site-card-records\//,'/api/embed/site-card-records/')
    .replace(/^\/api\/projects\/\d+\/countries\//,'/api/embed/countries/')
    .replace(/^\/api\/projects\/\d+$/,'/api/embed/project')
    .replace(/^\/api\/calculate$/,'/api/embed/calculate'):url;
  const target=/^https?:\/\//i.test(scoped)?scoped:`${apiBase}${scoped}`;
  const workspaceHeader=state.shareKey&&scoped.startsWith('/api/embed/')?{'X-Workspace-Key':state.shareKey}:{};
  const response=await fetch(target,{headers:{'Content-Type':'application/json',...workspaceHeader,...(options.headers||{})},...options});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'请求失败');
  return payload;
}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(el.timer);el.timer=setTimeout(()=>el.classList.remove('show'),2200)}
function saving(start,error=false){state.saving=Math.max(0,state.saving+(start?1:-1));const el=$('#saveState');el.textContent=error?'保存失败':state.saving?'保存中…':'已保存';el.className=`save-state ${error?'error':state.saving?'saving':''}`}
function announceSync(){syncChannel?.postMessage({projectId:state.project?.id,countryCode:state.country?.code,source:'site-card',at:Date.now()})}
function updateLinks(){
  if(state.shareKey)return history.replaceState(null,'',`#${new URLSearchParams({key:state.shareKey,country:state.country.code})}`);
  history.replaceState(null,'',`?project=${state.project.id}&country=${state.country.code}`);
}
async function loadRecords(){const payload=await api(`/api/projects/${state.project.id}/site-card-records?country_code=${encodeURIComponent(state.country.code)}`);state.records=payload.records||[];return state.records}
function visibleRecords(){return state.records}
async function migrateLegacyRecords(){
  let records=[];try{records=JSON.parse(localStorage.getItem(legacyRecordStorageKey)||'[]')}catch{}
  if(!Array.isArray(records)||!records.length)return;
  const failures=[];
  for(const record of records){
    if(!record||!record.project_id||!record.country_code)continue;
    try{await api(`/api/projects/${Number(record.project_id)}/site-card-records`,{method:'POST',body:JSON.stringify({id:record.id,country_code:record.country_code,name:record.name,cost_cny:Number(record.cost_cny??record.snapshot?.cost_cny)||0,sale_price:Number(record.sale_price??record.snapshot?.sale_price)||0,snapshot:record.snapshot||{}})})}
    catch(error){if(!/品类不存在/.test(error.message))failures.push(error)}
  }
  if(!failures.length){try{localStorage.removeItem(legacyRecordStorageKey)}catch{}}
  else toast(`有 ${failures.length} 条旧方案迁移失败，请刷新后重试`);
}

async function initialize(){
  const hashParams=new URLSearchParams(location.hash.replace(/^#/,''));state.shareKey=hashParams.get('key')||'';
  if(state.shareKey){
    state.bootstrap=await api('/api/embed/bootstrap');state.project=state.bootstrap.project;
  }else state.bootstrap=await api('/api/bootstrap');
  if(!state.shareKey&&!state.bootstrap.projects.length)state.project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:'新品测算 01'})});
  const params=new URLSearchParams(location.search);const requestedProject=Number(params.get('project'));
  if(!state.shareKey){const projectId=state.bootstrap.projects.some((item)=>Number(item.id)===requestedProject)?requestedProject:(state.project?.id||state.bootstrap.projects[0]?.id);state.project=await api(`/api/projects/${projectId}`)}
  const requestedCountry=String((state.shareKey?hashParams:params).get('country')||'').toUpperCase();
  const defaultCountry=state.project.listings.find((item)=>item.selected)?.country_code||state.bootstrap.countries[0]?.code;
  setCountry(state.bootstrap.countries.some((item)=>item.code===requestedCountry)?requestedCountry:defaultCountry,false);
  await migrateLegacyRecords();await loadRecords();renderPickers();fillFields();await calculate();renderRecords();bindEvents();
}
function setCountry(code,shouldCalculate=true){
  state.country=state.bootstrap.countries.find((item)=>item.code===code)||state.bootstrap.countries[0];
  state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);
  $('#priceSymbol').textContent=state.country.symbol;
  updateLinks();if(shouldCalculate){fillFields();state.pending=calculate()}
}
function renderPickers(){
  const projects=state.bootstrap.projects||[state.project];
  $('#projectPicker').innerHTML=projects.map((item)=>`<option value="${item.id}" ${Number(item.id)===Number(state.project.id)?'selected':''}>${escapeHtml(item.name)}</option>`).join('');
  $('#projectPicker').closest('.project-picker').hidden=Boolean(state.shareKey);
}
function refreshProjectSummary(){const summary=state.bootstrap.projects?.find((item)=>Number(item.id)===Number(state.project.id));if(summary)summary.name=state.project.name;renderPickers()}
function fillFields(){
  for(const key of ['name','cost_cny','weight','weight_unit','length','width','height','dimension_unit'])field(key).value=state.project[key]??'';
  $('#inlineCostInput').value=state.project.cost_cny??'';
  field('sale_price').value=state.listing.sale_price||'';field('category_text').value=state.listing.category_text||'';field('referral_rate_override').value=state.listing.referral_rate_override??'';
  renderParameterSummary();
}
function renderParameterSummary(){}
async function calculate(){
  const payload=await api('/api/calculate',{method:'POST',body:JSON.stringify({project_id:state.project.id,country_code:state.country.code,include_target_prices:true})});state.result=payload.results?.[0]||null;renderResult();
}
function money(value){return `${state.result?.symbol||state.country.symbol}${number(value)}`}
function cny(value){return `¥${number(value)}`}
function profitExplanation(result){
  if(!result||!Number(result.sale_price))return '填写当地售价后显示完整计算过程';
  return ['利润率计算过程',`含税售价：${money(result.sale_price)}`,`减 VAT：${money(result.vat_amount)}`,`净销售收入：${money(result.net_revenue)}`,`减 ${result.tax_label||'税费'}：${money(result.tax_fee)}`,`减佣金：${money(result.referral_fee)}（${number(result.referral_rate,2)}%）`,`减 FBA：${money(result.fba_fee)}`,`减头程：${money(result.freight_fee)}`,`减产品成本：${money(result.product_cost)}`,`单件利润：${money(result.profit)}`].join('\n');
}
function fbaExplanation(result){
  const dimensions=(result.dimensions_cm||[]).map((value)=>number(value,2)).join(' × ')||'未填写';
  const weightFormula=`${dimensions} cm ÷ ${number(result.fba_volume_divisor,0)} = ${number(result.fba_volume_weight_kg,3)} kg`;
  const feeFormula=result.fba_per_kg_fee
    ? `${money(result.fba_rule_base_fee)} + ${number(result.fba_extra_weight_kg,3)} kg × ${money(result.fba_per_kg_fee)}/kg = ${money(result.fba_base_fee)}`
    : `当前费阶固定费用：${money(result.fba_base_fee)}`;
  const surcharge=Number(result.fba_surcharge_rate)>0?`附加费：${money(result.fba_base_fee)} × ${number(result.fba_surcharge_rate,2)}% = ${money(result.fba_surcharge_fee)}`:'附加费：无';
  return ['FBA 配送费计算',`站点：${state.country.code} · ${state.country.name}`,`商品尺寸：${dimensions} cm`,`尺寸分段：${result.size_tier_name||'未匹配'}（${result.size_tier_code||'无代码'}）`,`命中费阶：${result.fba_rule_name||'未匹配'}`,`实际重量：${number(result.actual_weight_kg,3)} kg`,`FBA 体积重：${weightFormula}`,`本费阶计费重量：${number(result.fba_billable_weight_kg,3)} kg`,`包含重量：${number(result.fba_included_weight_kg,3)} kg${result.fba_weight_increment_kg?`；续重按 ${number(result.fba_weight_increment_kg,3)} kg 向上取整`:''}`,`基础费用：${feeFormula}`,surcharge,`FBA 配送费：${money(result.fba_base_fee)} + ${money(result.fba_surcharge_fee)} = ${money(result.fba_fee)}`].join('\n');
}
function freightExplanation(result){
  const dimensions=(result.dimensions_cm||[]).map((value)=>number(value,2)).join(' × ')||'未填写';
  const mode=result.freight_pricing_mode==='cbm'?'按体积计费':'按重量计费';
  const core=result.freight_pricing_mode==='cbm'
    ? `${number(result.volume_cbm,6)} m³ × ${cny(result.freight_rate_cny)}/m³`
    : `${number(result.billable_weight_kg,3)} kg × ${cny(result.freight_rate_cny)}/kg`;
  return ['头程计算',`站点：${state.country.code} · ${state.country.name}`,`计费方式：${mode}`,`商品尺寸：${dimensions} cm`,`实际重量：${number(result.actual_weight_kg,3)} kg`,`头程体积重：${dimensions} cm ÷ ${number(result.freight_volume_divisor,0)} = ${number(result.volume_weight_kg,3)} kg`,`头程计费重量：max(实重, 体积重) = ${number(result.billable_weight_kg,3)} kg`,`运费人民币：max(${core}, 最低收费 ${cny(result.freight_min_charge_cny)}) = ${cny(result.freight_cny)}`,`汇率：1 ${state.country.currency} = ${cny(result.cny_per_local)}`,`头程：${cny(result.freight_cny)} ÷ ${number(result.cny_per_local,4)} = ${money(result.freight_fee)}`].join('\n');
}
function separatesVat(result){return ['GB','DE'].includes(result?.country_code)&&Number(result?.vat_rate)>0}
function taxExplanation(result,includeVat=!separatesVat(result)){
  const lines=['税金计算',`站点：${state.country.code} · ${state.country.name}`,`计税方式：${result.tax_label||'税费'}（${result.tax_basis||'none'}）`];
  if(result.tax_basis==='japan_import')lines.push(`申报价：${money(result.declared_value)}${result.declared_value_overridden?'（手动填写）':`（售价 × ${number(result.declaration_ratio,2)}%）`}`,`关税：${money(result.declared_value)} × ${number(result.customs_rate,2)}% = ${money(result.customs_duty)}`,`消费税：(${money(result.declared_value)} + ${money(result.customs_duty)}) × ${number(result.consumption_tax_rate,2)}% = ${money(result.consumption_tax)}`);
  else if(result.tax_basis==='sale')lines.push(`税费：${money(result.sale_price)} × ${number(result.tax_rate,2)}% = ${money(result.tax_fee)}`);
  else if(result.tax_basis==='cost')lines.push(`税费：${money(result.product_cost)} × ${number(result.tax_rate,2)}% = ${money(result.tax_fee)}`);
  else lines.push('本站当前未按售价或成本另计税费');
  if(includeVat){if(Number(result.vat_rate)>0)lines.push(`售价内含 VAT：${money(result.sale_price)} − ${money(result.sale_price)} ÷ (1 + ${number(result.vat_rate,2)}%) = ${money(result.vat_amount)}`);else lines.push('售价内含 VAT：无');lines.push(`税金合计：${money(result.tax_fee)} + ${money(result.vat_amount)} = ${money(Number(result.tax_fee)+Number(result.vat_amount))}`)}else lines.push(`税费预估合计：${money(result.tax_fee)}`);if(result.tax_note)lines.push(`规则说明：${result.tax_note}`);return lines.join('\n');
}
function vatExplanation(result){
  const net=Number(result.sale_price)-Number(result.vat_amount);const grossShare=Number(result.vat_rate)/(100+Number(result.vat_rate))*100;
  return ['VAT 计算',`站点：${state.country.code} · ${state.country.name}`,`含税售价：${money(result.sale_price)}`,`VAT 税率：${number(result.vat_rate,2)}%`,`未税售价：${money(result.sale_price)} ÷ (1 + ${number(result.vat_rate,2)}%) = ${money(net)}`,`售价内含 VAT：${money(result.sale_price)} − ${money(net)} = ${money(result.vat_amount)}`,`简便算法：${money(result.sale_price)} × ${number(grossShare,1)}% ≈ ${money(result.vat_amount)}`,`为什么是 ${number(grossShare,1)}%：VAT 在含税售价中的占比为 ${number(result.vat_rate,2)} ÷ ${number(100+Number(result.vat_rate),2)} = ${number(grossShare,3)}%，取一位小数为 ${number(grossShare,1)}%`].join('\n')
}
function resultCard(label,value,note='',className='',explanation=''){return `<div class="result-card ${className} ${explanation?'has-info':''}"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b>${note?`<span>${escapeHtml(note)}</span>`:''}${explanation?`<i class="profit-info" tabindex="0" title="${escapeHtml(explanation)}" aria-label="查看${escapeHtml(label)}计算过程">i</i>`:''}</div>`}
function syncCostDraft(value,source){field('cost_cny').value=value;const input=$('#inlineCostInput');if(input&&input!==source&&input.value!==value)input.value=value}
function bindCostEditor(input){if(!input)return;input.oninput=()=>{syncCostDraft(input.value,input);debounceSave(saveProduct,'productTimer')};input.onchange=()=>{syncCostDraft(input.value,input);clearTimeout(state.productTimer);state.pending=saveProduct()}}
function targetPriceText(result){return [0,10,20,30].map((rate)=>`${rate}%：${result?.target_prices?.[rate]==null?'—':money(result.target_prices[rate])}`).join('\n')}
function targetPriceGroup(result){return `<div class="result-card target-price-summary" tabindex="0" title="${escapeHtml(targetPriceText(result))}"><small>目标售价</small><b>0–30%</b><i class="profit-info" aria-hidden="true">i</i></div>`}
function renderResult(){
  const result=state.result;const priced=Number(state.listing.sale_price)>0;
  renderParameterSummary();
  if(!result||!priced){$('#resultGrid').innerHTML='<div class="empty-result">填写当地售价后显示利润结果</div>';return}
  const negative=Number(result.profit)<0?'negative':'';
  const cards=[
    resultCard('FBA 配送费',money(result.fba_fee),'','',fbaExplanation(result)),
    resultCard('头程',money(result.freight_fee),'','',freightExplanation(result)),
    resultCard('税金',money(separatesVat(result)?result.tax_fee:Number(result.tax_fee)+Number(result.vat_amount)),'','',taxExplanation(result))
  ];
  if(separatesVat(result))cards.push(resultCard('VAT',money(result.vat_amount),'','vat-card',vatExplanation(result)));
  cards.push(resultCard('利润率',`${number(result.profit_rate,1)}%`,'',`primary ${negative}`,profitExplanation(result)),
    targetPriceGroup(result)
  );$('#resultGrid').innerHTML=cards.join('');
}

function recordById(id){return state.records.find((item)=>item.id===id)}
async function calculateRecord(record){
  if(record.snapshot?.detail_version===1)return;
  const version=(state.recordRequestVersions.get(record.id)||0)+1;state.recordRequestVersions.set(record.id,version);
  if(!Number(record.sale_price))return;
  try{const payload=await api('/api/calculate',{method:'POST',body:JSON.stringify({project_id:state.project.id,country_code:state.country.code,cost_cny_override:Number(record.cost_cny??record.snapshot?.cost_cny)||0,sale_price_override:Number(record.sale_price??record.snapshot?.sale_price)||0,include_target_prices:true})});if(state.recordRequestVersions.get(record.id)!==version)return;const result=payload.results?.[0];if(result){record.snapshot={...result,cost_cny:Number(record.cost_cny??record.snapshot?.cost_cny)||0,detail_version:1};const saved=await api(`/api/site-card-records/${encodeURIComponent(record.id)}`,{method:'PUT',body:JSON.stringify({snapshot:record.snapshot,cost_cny:record.snapshot.cost_cny,sale_price:record.snapshot.sale_price})});Object.assign(record,saved);renderRecords()}}catch{}
}
function calculateVisibleRecords(){visibleRecords().filter((record)=>record.snapshot?.detail_version!==1).forEach((record)=>calculateRecord(record))}
function updateRecord(event){
  const input=event.target;const record=recordById(input.closest('[data-record-id]')?.dataset.recordId);if(!record)return;record.name=input.value;clearTimeout(state.recordTimers.get(record.id));state.recordTimers.set(record.id,setTimeout(async()=>{try{const saved=await api(`/api/site-card-records/${encodeURIComponent(record.id)}`,{method:'PUT',body:JSON.stringify({name:record.name})});Object.assign(record,saved);announceSync()}catch(error){toast(error.message)}},450));
}
function recordOutput(label,value,title='',className=''){return `<div class="record-output ${className}"${title?` tabindex="0" title="${escapeHtml(title)}"`:''}><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`}
function renderRecords(){
  const records=visibleRecords();const table=$('#recordTable');
  if(!records.length){table.innerHTML='<div class="record-empty">暂无对比记录，点击“新建记录”添加带配件或不带配件方案</div>';return}
  table.innerHTML=records.map((record)=>{const result=record.snapshot;const withVat=separatesVat(result);return `<div class="record-row ${withVat?'has-vat':''}" data-record-id="${record.id}">
    <label class="record-field record-name"><span>产品名</span><input data-record-field="name" value="${escapeHtml(record.name)}" maxlength="30"></label>
    ${result?recordOutput('FBA 配送费',money(result.fba_fee),fbaExplanation(result)):recordOutput('FBA 配送费','计算中…')}
    ${result?recordOutput('头程',money(result.freight_fee),freightExplanation(result)):recordOutput('头程','—')}
    ${result?recordOutput('税金',money(withVat?result.tax_fee:Number(result.tax_fee)+Number(result.vat_amount)),taxExplanation(result)):recordOutput('税金','—')}
    ${withVat?recordOutput('VAT',money(result.vat_amount),vatExplanation(result),'record-vat'):''}
    ${recordOutput('成本',cny(result?.cost_cny??record.cost_cny))}
    ${result?recordOutput('利润率',`${number(result.profit_rate,1)}%`,profitExplanation(result),Number(result.profit_rate)<0?'record-profit negative':'record-profit positive'):recordOutput('利润率','—')}
    ${result?recordOutput('目标售价','悬停查看',targetPriceText(result),'record-target'):recordOutput('目标售价','—')}
    <button class="record-delete" type="button" aria-label="删除记录" title="删除记录">×</button>
  </div>`}).join('');
  $$('[data-record-field]',table).forEach((input)=>input.oninput=updateRecord);$$('.record-delete',table).forEach((button)=>button.onclick=()=>deleteRecord(button.closest('[data-record-id]').dataset.recordId));calculateVisibleRecords();
}
async function addRecord(){
  if(!state.result||!Number(state.listing.sale_price))return toast('请先填写售价');const count=visibleRecords().length+1;const snapshot=JSON.parse(JSON.stringify({...state.result,cost_cny:Number(state.project.cost_cny)||0,detail_version:1}));
  try{const record=await api(`/api/projects/${state.project.id}/site-card-records`,{method:'POST',body:JSON.stringify({country_code:state.country.code,name:`${state.project.name} 方案${count}`,cost_cny:snapshot.cost_cny,sale_price:snapshot.sale_price,snapshot})});state.records.push(record);renderRecords();announceSync();toast('已保存当前计算记录')}catch(error){toast(error.message)}
}
async function deleteRecord(id){try{await api(`/api/site-card-records/${encodeURIComponent(id)}`,{method:'DELETE'});state.records=state.records.filter((item)=>item.id!==id);state.recordResults.delete(id);clearTimeout(state.recordTimers.get(id));state.recordTimers.delete(id);state.recordRequestVersions.delete(id);renderRecords();announceSync();toast('记录已删除')}catch(error){toast(error.message)}}

async function saveProduct(){
  saving(true);try{
    const body={name:field('name').value.trim()||'未命名品类',cost_cny:Number(field('cost_cny').value)||0,weight:Number(field('weight').value)||0,weight_unit:field('weight_unit').value,length:Number(field('length').value)||0,width:Number(field('width').value)||0,height:Number(field('height').value)||0,dimension_unit:field('dimension_unit').value};
    state.project=await api(`/api/projects/${state.project.id}`,{method:'PUT',body:JSON.stringify(body)});state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);refreshProjectSummary();await calculate();calculateVisibleRecords();saving(false);announceSync();
  }catch(error){saving(false,true);toast(error.message)}
}
async function saveListing(){
  saving(true);try{
    const category=field('category_text').value.trim();const overrideRaw=field('referral_rate_override').value;const override=overrideRaw===''?null:Number(overrideRaw);
    if(override!==null&&(!Number.isFinite(override)||override<0||override>100))throw new Error('佣金比例请输入 0–100');
    const changes={sale_price:Number(field('sale_price').value)||0,category_text:category,referral_rate_override:override};
    if(category&&category!==state.listing.category_text){const matched=await api('/api/commission/match',{method:'POST',body:JSON.stringify({country_code:state.country.code,text:category,sale_price:changes.sale_price})});if(matched.matched)Object.assign(changes,{matched_category:matched.rule.parent_category,matched_referral_rate:matched.rule.rate,matched_referral_threshold:matched.rule.threshold_price,matched_referral_rate_above:matched.rule.rate_above,matched_referral_minimum:matched.rule.minimum_fee||0})}
    state.project=await api(`/api/projects/${state.project.id}/countries/${state.country.code}`,{method:'PUT',body:JSON.stringify(changes)});state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);await calculate();calculateVisibleRecords();saving(false);announceSync();
  }catch(error){saving(false,true);toast(error.message)}
}
function debounceSave(fn,key){clearTimeout(state[key]);state[key]=setTimeout(()=>{state.pending=fn()},450)}
function openParameters(){$('#parametersModal').hidden=false;setTimeout(()=>field('cost_cny').focus(),40)}
function closeParameters(){$('#parametersModal').hidden=true}
function applyDimensions(parsed){for(const key of ['length','width','height'])field(key).value=parsed[key];field('dimension_unit').value=parsed.unit;toast(`已识别：${parsed.length} × ${parsed.width} × ${parsed.height} ${parsed.unit}`);state.pending=saveProduct()}
function recognizeDimensions(text){const parsed=window.DimensionParser?.parseDimensions(text,field('dimension_unit').value||'cm');if(!parsed){toast('未识别到完整尺寸，请使用 27.2 × 12.5 × 54 cm 格式');return false}applyDimensions(parsed);return true}
async function readDimensions(){if(!navigator.clipboard?.readText)return toast('请将完整尺寸直接粘贴到任一尺寸框');try{const text=await navigator.clipboard.readText();if(!text.trim())return toast('剪贴板为空');recognizeDimensions(text)}catch{toast('剪贴板读取被拦截，请直接粘贴到尺寸框')}}
function handleDimensionPaste(event){const text=event.clipboardData?.getData('text')||'';const parsed=window.DimensionParser?.parseDimensions(text,field('dimension_unit').value||'cm');if(!parsed)return;event.preventDefault();applyDimensions(parsed)}
async function copyResult(){if(!state.result||!Number(state.listing.sale_price))return toast('请先填写售价');const text=`${number(state.result.profit_rate,1)}%`;const helper=document.createElement('textarea');helper.value=text;helper.setAttribute('readonly','');helper.style.cssText='position:fixed;left:-10000px;top:0;opacity:0';document.body.append(helper);helper.focus();helper.select();let copied=document.execCommand('copy');helper.remove();if(!copied){try{await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'})})]);copied=true}catch{try{await navigator.clipboard.writeText(text);copied=true}catch{}}}toast(copied?`已复制利润率 ${text}`:'复制失败，请重试')}
async function reloadFromSharedData(message={}){if(message.projectId&&Number(message.projectId)!==Number(state.project.id))return;clearTimeout(state.reloadTimer);state.reloadTimer=setTimeout(async()=>{try{state.project=await api(`/api/projects/${state.project.id}`);state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);await loadRecords();refreshProjectSummary();fillFields();await calculate();renderRecords()}catch{}},180)}

function bindEvents(){
  $('#projectPicker').onchange=async(event)=>{await state.pending;state.project=await api(`/api/projects/${event.target.value}`);const code=state.project.listings.some((item)=>item.country_code===state.country.code)?state.country.code:state.bootstrap.countries[0].code;setCountry(code,false);await loadRecords();renderPickers();fillFields();await calculate();renderRecords()};
  for(const name of ['name','cost_cny','weight','weight_unit','length','width','height','dimension_unit']){const input=field(name);input.oninput=()=>debounceSave(saveProduct,'productTimer');input.onchange=()=>{clearTimeout(state.productTimer);state.pending=saveProduct()}}
  for(const name of ['sale_price','category_text','referral_rate_override']){const input=field(name);input.oninput=()=>debounceSave(saveListing,'listingTimer');input.onchange=()=>{clearTimeout(state.listingTimer);state.pending=saveListing()}}
  bindCostEditor($('#inlineCostInput'));
  $('#readDimensionsBtn').onclick=readDimensions;$$('[data-site-dimension]').forEach((input)=>input.addEventListener('paste',handleDimensionPaste));$('#copyResultBtn').onclick=copyResult;
  $('#openParametersBtn').onclick=openParameters;$('#newRecordBtn').onclick=addRecord;$$('[data-close-parameters]').forEach((button)=>button.onclick=closeParameters);document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&!$('#parametersModal').hidden)closeParameters()});
  syncChannel?.addEventListener('message',(event)=>{if(event.data?.source!=='site-card')reloadFromSharedData(event.data)});window.addEventListener('focus',()=>reloadFromSharedData());
}

initialize().catch((error)=>{console.error(error);toast(`加载失败：${error.message}`);$('#resultGrid').innerHTML=`<div class="empty-result">${escapeHtml(error.message)}</div>`});
