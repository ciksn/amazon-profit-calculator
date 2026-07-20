'use strict';

const state={bootstrap:null,project:null,country:null,listing:null,result:null,records:[],recordResults:new Map(),recordTimers:new Map(),recordRequestVersions:new Map(),saving:0,pending:Promise.resolve(),reloadTimer:null};
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const apiBase=String(window.MARGINGO_API_BASE||'').replace(/\/$/,'');
const syncChannel='BroadcastChannel' in window?new BroadcastChannel('margingo-project-sync'):null;
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,digits=2)=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:digits});
const marketCode=(code)=>code==='GB'?'UK':code;
const field=(name)=>$(`[name="${name}"]`);
const recordStorageKey='margingo-site-card-records-v1';

async function api(url,options={}){
  const target=/^https?:\/\//i.test(url)?url:`${apiBase}${url}`;
  const response=await fetch(target,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'????');
  return payload;
}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(el.timer);el.timer=setTimeout(()=>el.classList.remove('show'),2200)}
function saving(start,error=false){state.saving=Math.max(0,state.saving+(start?1:-1));const el=$('#saveState');el.textContent=error?'????':state.saving?'????':'???';el.className=`save-state ${error?'error':state.saving?'saving':''}`}
function announceSync(){const message={projectId:state.project?.id,countryCode:state.country?.code,source:'site-card',at:Date.now()};syncChannel?.postMessage(message);try{localStorage.setItem('margingo-sync-pulse',JSON.stringify(message))}catch{}}
function updateLinks(){history.replaceState(null,'',`?project=${state.project.id}&country=${state.country.code}`)}
function loadRecords(){try{const value=JSON.parse(localStorage.getItem(recordStorageKey));return Array.isArray(value)?value:[]}catch{return []}}
function saveRecords(){try{localStorage.setItem(recordStorageKey,JSON.stringify(state.records))}catch{toast('?????????????????')}}
function visibleRecords(){return state.records.filter((item)=>Number(item.project_id)===Number(state.project.id)&&item.country_code===state.country.code)}

async function initialize(){
  state.records=loadRecords();
  state.bootstrap=await api('/api/bootstrap');
  if(!state.bootstrap.projects.length)state.project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:'???? 01'})});
  const params=new URLSearchParams(location.search);const requestedProject=Number(params.get('project'));
  const projectId=state.bootstrap.projects.some((item)=>Number(item.id)===requestedProject)?requestedProject:(state.project?.id||state.bootstrap.projects[0]?.id);
  state.project=await api(`/api/projects/${projectId}`);
  const requestedCountry=String(params.get('country')||'').toUpperCase();
  const defaultCountry=state.project.listings.find((item)=>item.selected)?.country_code||state.bootstrap.countries[0]?.code;
  setCountry(state.bootstrap.countries.some((item)=>item.code===requestedCountry)?requestedCountry:defaultCountry,false);
  renderPickers();fillFields();await calculate();renderRecords();bindEvents();
}
function setCountry(code,shouldCalculate=true){
  state.country=state.bootstrap.countries.find((item)=>item.code===code)||state.bootstrap.countries[0];
  state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);
  $('#priceSymbol').textContent=state.country.symbol;
  updateLinks();if(shouldCalculate){fillFields();state.pending=calculate()}
}
function renderPickers(){
  $('#projectPicker').innerHTML=state.bootstrap.projects.map((item)=>`<option value="${item.id}" ${Number(item.id)===Number(state.project.id)?'selected':''}>${escapeHtml(item.name)}</option>`).join('');
}
function refreshProjectSummary(){const summary=state.bootstrap.projects.find((item)=>Number(item.id)===Number(state.project.id));if(summary)summary.name=state.project.name;renderPickers()}
function fillFields(){
  for(const key of ['name','cost_cny','weight','weight_unit','length','width','height','dimension_unit'])field(key).value=state.project[key]??'';
  field('sale_price').value=state.listing.sale_price||'';field('category_text').value=state.listing.category_text||'';field('referral_rate_override').value=state.listing.referral_rate_override??'';
  renderParameterSummary();
}
function renderParameterSummary(){}
async function calculate(){
  const payload=await api('/api/calculate',{method:'POST',body:JSON.stringify({project_id:state.project.id,country_code:state.country.code,include_target_prices:true})});state.result=payload.results?.[0]||null;renderResult();
}
function money(value){return `${state.result?.symbol||state.country.symbol}${number(value)}`}
function cny(value){return `?${number(value)}`}
function profitExplanation(result){
  if(!result||!Number(result.sale_price))return '???????????????';
  return ['???????',`?????${money(result.sale_price)}`,`? VAT?${money(result.vat_amount)}`,`??????${money(result.net_revenue)}`,`? ${result.tax_label||'??'}?${money(result.tax_fee)}`,`????${money(result.referral_fee)}?${number(result.referral_rate,2)}%?`,`? FBA?${money(result.fba_fee)}`,`????${money(result.freight_fee)}`,`??????${money(result.product_cost)}`,`?????${money(result.profit)}`].join('\n');
}
function fbaExplanation(result){
  const dimensions=(result.dimensions_cm||[]).map((value)=>number(value,2)).join(' ? ')||'???';
  const weightFormula=`${dimensions} cm ? ${number(result.fba_volume_divisor,0)} = ${number(result.fba_volume_weight_kg,3)} kg`;
  const feeFormula=result.fba_per_kg_fee
    ? `${money(result.fba_rule_base_fee)} + ${number(result.fba_extra_weight_kg,3)} kg ? ${money(result.fba_per_kg_fee)}/kg = ${money(result.fba_base_fee)}`
    : `?????????${money(result.fba_base_fee)}`;
  const surcharge=Number(result.fba_surcharge_rate)>0?`????${money(result.fba_base_fee)} ? ${number(result.fba_surcharge_rate,2)}% = ${money(result.fba_surcharge_fee)}`:'?????';
  return ['FBA ?????',`???${state.country.code} ? ${state.country.name}`,`?????${dimensions} cm`,`?????${result.size_tier_name||'???'}?${result.size_tier_code||'???'}?`,`?????${result.fba_rule_name||'???'}`,`?????${number(result.actual_weight_kg,3)} kg`,`FBA ????${weightFormula}`,`????????${number(result.fba_billable_weight_kg,3)} kg`,`?????${number(result.fba_included_weight_kg,3)} kg${result.fba_weight_increment_kg?`???? ${number(result.fba_weight_increment_kg,3)} kg ????`:''}`,`?????${feeFormula}`,surcharge,`FBA ????${money(result.fba_base_fee)} + ${money(result.fba_surcharge_fee)} = ${money(result.fba_fee)}`].join('\n');
}
function freightExplanation(result){
  const dimensions=(result.dimensions_cm||[]).map((value)=>number(value,2)).join(' ? ')||'???';
  const mode=result.freight_pricing_mode==='cbm'?'?????':'?????';
  const core=result.freight_pricing_mode==='cbm'
    ? `${number(result.volume_cbm,6)} m? ? ${cny(result.freight_rate_cny)}/m?`
    : `${number(result.billable_weight_kg,3)} kg ? ${cny(result.freight_rate_cny)}/kg`;
  return ['????',`???${state.country.code} ? ${state.country.name}`,`?????${mode}`,`?????${dimensions} cm`,`?????${number(result.actual_weight_kg,3)} kg`,`??????${dimensions} cm ? ${number(result.freight_volume_divisor,0)} = ${number(result.volume_weight_kg,3)} kg`,`???????max(??, ???) = ${number(result.billable_weight_kg,3)} kg`,`??????max(${core}, ???? ${cny(result.freight_min_charge_cny)}) = ${cny(result.freight_cny)}`,`???1 ${state.country.currency} = ${cny(result.cny_per_local)}`,`???${cny(result.freight_cny)} ? ${number(result.cny_per_local,4)} = ${money(result.freight_fee)}`].join('\n');
}
function separatesVat(result){return ['GB','DE'].includes(result?.country_code)&&Number(result?.vat_rate)>0}
function taxExplanation(result,includeVat=!separatesVat(result)){
  const lines=['????',`???${state.country.code} ? ${state.country.name}`,`?????${result.tax_label||'??'}?${result.tax_basis||'none'}?`];
  if(result.tax_basis==='japan_import')lines.push(`????${money(result.declared_value)}${result.declared_value_overridden?'??????':`??? ? ${number(result.declaration_ratio,2)}%?`}`,`???${money(result.declared_value)} ? ${number(result.customs_rate,2)}% = ${money(result.customs_duty)}`,`????(${money(result.declared_value)} + ${money(result.customs_duty)}) ? ${number(result.consumption_tax_rate,2)}% = ${money(result.consumption_tax)}`);
  else if(result.tax_basis==='sale')lines.push(`???${money(result.sale_price)} ? ${number(result.tax_rate,2)}% = ${money(result.tax_fee)}`);
  else if(result.tax_basis==='cost')lines.push(`???${money(result.product_cost)} ? ${number(result.tax_rate,2)}% = ${money(result.tax_fee)}`);
  else lines.push('???????????????');
  if(includeVat){if(Number(result.vat_rate)>0)lines.push(`???? VAT?${money(result.sale_price)} ? ${money(result.sale_price)} ? (1 + ${number(result.vat_rate,2)}%) = ${money(result.vat_amount)}`);else lines.push('???? VAT??');lines.push(`?????${money(result.tax_fee)} + ${money(result.vat_amount)} = ${money(Number(result.tax_fee)+Number(result.vat_amount))}`)}else lines.push(`???????${money(result.tax_fee)}`);if(result.tax_note)lines.push(`?????${result.tax_note}`);return lines.join('\n');
}
function vatExplanation(result){
  const net=Number(result.sale_price)-Number(result.vat_amount);const grossShare=Number(result.vat_rate)/(100+Number(result.vat_rate))*100;
  return ['VAT ??',`???${state.country.code} ? ${state.country.name}`,`?????${money(result.sale_price)}`,`VAT ???${number(result.vat_rate,2)}%`,`?????${money(result.sale_price)} ? (1 + ${number(result.vat_rate,2)}%) = ${money(net)}`,`???? VAT?${money(result.sale_price)} ? ${money(net)} = ${money(result.vat_amount)}`,`?????${money(result.sale_price)} ? ${number(grossShare,1)}% ? ${money(result.vat_amount)}`,`???? ${number(grossShare,1)}%?VAT ?????????? ${number(result.vat_rate,2)} ? ${number(100+Number(result.vat_rate),2)} = ${number(grossShare,3)}%??????? ${number(grossShare,1)}%`].join('\n')
}
function resultCard(label,value,note='',className='',explanation=''){return `<div class="result-card ${className} ${explanation?'has-info':''}"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b>${note?`<span>${escapeHtml(note)}</span>`:''}${explanation?`<i class="profit-info" tabindex="0" title="${escapeHtml(explanation)}" aria-label="??${escapeHtml(label)}????">i</i>`:''}</div>`}
function costInputCard(){return `<label class="result-card cost-input-card"><small>???????</small><div><i>?</i><input id="inlineCostInput" type="number" min="0" step="0.01" value="${Number(state.project.cost_cny)||0}" aria-label="???????"></div></label>`}
function targetPriceText(result){return [0,10,20,30].map((rate)=>`${rate}%?${result?.target_prices?.[rate]==null?'?':money(result.target_prices[rate])}`).join('\n')}
function targetPriceGroup(result){return `<div class="result-card target-price-summary" tabindex="0" title="${escapeHtml(targetPriceText(result))}"><small>????</small><b>0?30%</b><i class="profit-info" aria-hidden="true">i</i></div>`}
function renderResult(){
  const result=state.result;const priced=Number(state.listing.sale_price)>0;
  renderParameterSummary();
  if(!result||!priced){$('#resultGrid').innerHTML='<div class="empty-result">?????????????</div>';return}
  const negative=Number(result.profit)<0?'negative':'';
  const cards=[
    resultCard('FBA ???',money(result.fba_fee),'','',fbaExplanation(result)),
    resultCard('??',money(result.freight_fee),'','',freightExplanation(result)),
    resultCard('??',money(separatesVat(result)?result.tax_fee:Number(result.tax_fee)+Number(result.vat_amount)),'','',taxExplanation(result))
  ];
  if(separatesVat(result))cards.push(resultCard('VAT',money(result.vat_amount),'','vat-card',vatExplanation(result)));
  cards.push(costInputCard(),
    resultCard('???',`${number(result.profit_rate,1)}%`,'',`primary ${negative}`,profitExplanation(result)),
    targetPriceGroup(result)
  );$('#resultGrid').innerHTML=cards.join('');
  const costInput=$('#inlineCostInput');costInput.oninput=()=>{field('cost_cny').value=costInput.value;debounceSave(saveProduct,'productTimer')};costInput.onchange=()=>{field('cost_cny').value=costInput.value;clearTimeout(state.productTimer);state.pending=saveProduct()};
}

function recordById(id){return state.records.find((item)=>item.id===id)}
async function calculateRecord(record){
  if(record.snapshot?.detail_version===1)return;
  const version=(state.recordRequestVersions.get(record.id)||0)+1;state.recordRequestVersions.set(record.id,version);
  if(!Number(record.sale_price))return;
  try{const payload=await api('/api/calculate',{method:'POST',body:JSON.stringify({project_id:state.project.id,country_code:state.country.code,cost_cny_override:Number(record.cost_cny??record.snapshot?.cost_cny)||0,sale_price_override:Number(record.sale_price??record.snapshot?.sale_price)||0,include_target_prices:true})});if(state.recordRequestVersions.get(record.id)!==version)return;const result=payload.results?.[0];if(result){record.snapshot={...result,cost_cny:Number(record.cost_cny??record.snapshot?.cost_cny)||0,detail_version:1};saveRecords();renderRecords()}}catch{}
}
function calculateVisibleRecords(){visibleRecords().filter((record)=>record.snapshot?.detail_version!==1).forEach((record)=>calculateRecord(record))}
function updateRecord(event){
  const input=event.target;const record=recordById(input.closest('[data-record-id]')?.dataset.recordId);if(!record)return;record.name=input.value;saveRecords();
}
function recordOutput(label,value,title='',className=''){return `<div class="record-output ${className}"${title?` tabindex="0" title="${escapeHtml(title)}"`:''}><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`}
function renderRecords(){
  const records=visibleRecords();const table=$('#recordTable');
  if(!records.length){table.innerHTML='<div class="record-empty">???????????????????????????</div>';return}
  table.innerHTML=records.map((record)=>{const result=record.snapshot;const withVat=separatesVat(result);return `<div class="record-row ${withVat?'has-vat':''}" data-record-id="${record.id}">
    <label class="record-field record-name"><span>???</span><input data-record-field="name" value="${escapeHtml(record.name)}" maxlength="30"></label>
    ${result?recordOutput('FBA ???',money(result.fba_fee),fbaExplanation(result)):recordOutput('FBA ???','????')}
    ${result?recordOutput('??',money(result.freight_fee),freightExplanation(result)):recordOutput('??','?')}
    ${result?recordOutput('??',money(withVat?result.tax_fee:Number(result.tax_fee)+Number(result.vat_amount)),taxExplanation(result)):recordOutput('??','?')}
    ${withVat?recordOutput('VAT',money(result.vat_amount),vatExplanation(result),'record-vat'):''}
    ${recordOutput('??',cny(result?.cost_cny??record.cost_cny))}
    ${result?recordOutput('???',`${number(result.profit_rate,1)}%`,profitExplanation(result),Number(result.profit_rate)<0?'record-profit negative':'record-profit positive'):recordOutput('???','?')}
    ${result?recordOutput('????','????',targetPriceText(result),'record-target'):recordOutput('????','?')}
    <button class="record-delete" type="button" aria-label="????" title="????">?</button>
  </div>`}).join('');
  $$('[data-record-field]',table).forEach((input)=>input.oninput=updateRecord);$$('.record-delete',table).forEach((button)=>button.onclick=()=>deleteRecord(button.closest('[data-record-id]').dataset.recordId));calculateVisibleRecords();
}
function addRecord(){
  if(!state.result||!Number(state.listing.sale_price))return toast('??????');const count=visibleRecords().length+1;const snapshot=JSON.parse(JSON.stringify({...state.result,cost_cny:Number(state.project.cost_cny)||0,detail_version:1}));state.records.push({id:crypto.randomUUID?.()||`${Date.now()}-${Math.random()}`,project_id:Number(state.project.id),country_code:state.country.code,name:`${state.project.name} ??${count}`,snapshot});saveRecords();renderRecords();toast('?????????')
}
function deleteRecord(id){state.records=state.records.filter((item)=>item.id!==id);state.recordResults.delete(id);clearTimeout(state.recordTimers.get(id));state.recordTimers.delete(id);state.recordRequestVersions.delete(id);saveRecords();renderRecords();toast('?????')}

async function saveProduct(){
  saving(true);try{
    const body={name:field('name').value.trim()||'?????',cost_cny:Number(field('cost_cny').value)||0,weight:Number(field('weight').value)||0,weight_unit:field('weight_unit').value,length:Number(field('length').value)||0,width:Number(field('width').value)||0,height:Number(field('height').value)||0,dimension_unit:field('dimension_unit').value};
    state.project=await api(`/api/projects/${state.project.id}`,{method:'PUT',body:JSON.stringify(body)});state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);refreshProjectSummary();await calculate();calculateVisibleRecords();saving(false);announceSync();
  }catch(error){saving(false,true);toast(error.message)}
}
async function saveListing(){
  saving(true);try{
    const category=field('category_text').value.trim();const overrideRaw=field('referral_rate_override').value;const override=overrideRaw===''?null:Number(overrideRaw);
    if(override!==null&&(!Number.isFinite(override)||override<0||override>100))throw new Error('??????? 0?100');
    const changes={sale_price:Number(field('sale_price').value)||0,category_text:category,referral_rate_override:override};
    if(category&&category!==state.listing.category_text){const matched=await api('/api/commission/match',{method:'POST',body:JSON.stringify({country_code:state.country.code,text:category,sale_price:changes.sale_price})});if(matched.matched)Object.assign(changes,{matched_category:matched.rule.parent_category,matched_referral_rate:matched.rule.rate,matched_referral_threshold:matched.rule.threshold_price,matched_referral_rate_above:matched.rule.rate_above,matched_referral_minimum:matched.rule.minimum_fee||0})}
    state.project=await api(`/api/projects/${state.project.id}/countries/${state.country.code}`,{method:'PUT',body:JSON.stringify(changes)});state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);await calculate();calculateVisibleRecords();saving(false);announceSync();
  }catch(error){saving(false,true);toast(error.message)}
}
function debounceSave(fn,key){clearTimeout(state[key]);state[key]=setTimeout(()=>{state.pending=fn()},450)}
function openParameters(){$('#parametersModal').hidden=false;setTimeout(()=>field('cost_cny').focus(),40)}
function closeParameters(){$('#parametersModal').hidden=true}
function applyDimensions(parsed){for(const key of ['length','width','height'])field(key).value=parsed[key];field('dimension_unit').value=parsed.unit;toast(`????${parsed.length} ? ${parsed.width} ? ${parsed.height} ${parsed.unit}`);state.pending=saveProduct()}
function recognizeDimensions(text){const parsed=window.DimensionParser?.parseDimensions(text,field('dimension_unit').value||'cm');if(!parsed){toast('???????????? 27.2 ? 12.5 ? 54 cm ??');return false}applyDimensions(parsed);return true}
async function readDimensions(){if(!navigator.clipboard?.readText)return toast('????????????????');try{const text=await navigator.clipboard.readText();if(!text.trim())return toast('?????');recognizeDimensions(text)}catch{toast('??????????????????')}}
function handleDimensionPaste(event){const text=event.clipboardData?.getData('text')||'';const parsed=window.DimensionParser?.parseDimensions(text,field('dimension_unit').value||'cm');if(!parsed)return;event.preventDefault();applyDimensions(parsed)}
async function copyResult(){if(!state.result||!Number(state.listing.sale_price))return toast('??????');const text=`${number(state.result.profit_rate,1)}%`;const helper=document.createElement('textarea');helper.value=text;helper.setAttribute('readonly','');helper.style.cssText='position:fixed;left:-10000px;top:0;opacity:0';document.body.append(helper);helper.focus();helper.select();let copied=document.execCommand('copy');helper.remove();if(!copied){try{await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([text],{type:'text/plain'})})]);copied=true}catch{try{await navigator.clipboard.writeText(text);copied=true}catch{}}}toast(copied?`?????? ${text}`:'????????')}
async function reloadFromSharedData(message={}){if(message.projectId&&Number(message.projectId)!==Number(state.project.id))return;clearTimeout(state.reloadTimer);state.reloadTimer=setTimeout(async()=>{try{state.project=await api(`/api/projects/${state.project.id}`);state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);refreshProjectSummary();fillFields();await calculate();calculateVisibleRecords()}catch{}},180)}

function bindEvents(){
  $('#projectPicker').onchange=async(event)=>{await state.pending;state.project=await api(`/api/projects/${event.target.value}`);const code=state.project.listings.some((item)=>item.country_code===state.country.code)?state.country.code:state.bootstrap.countries[0].code;setCountry(code,false);renderPickers();fillFields();await calculate();renderRecords()};
  for(const name of ['name','cost_cny','weight','weight_unit','length','width','height','dimension_unit']){const input=field(name);input.oninput=()=>debounceSave(saveProduct,'productTimer');input.onchange=()=>{clearTimeout(state.productTimer);state.pending=saveProduct()}}
  for(const name of ['sale_price','category_text','referral_rate_override']){const input=field(name);input.oninput=()=>debounceSave(saveListing,'listingTimer');input.onchange=()=>{clearTimeout(state.listingTimer);state.pending=saveListing()}}
  $('#readDimensionsBtn').onclick=readDimensions;$$('[data-site-dimension]').forEach((input)=>input.addEventListener('paste',handleDimensionPaste));$('#copyResultBtn').onclick=copyResult;
  $('#openParametersBtn').onclick=openParameters;$('#newRecordBtn').onclick=addRecord;$$('[data-close-parameters]').forEach((button)=>button.onclick=closeParameters);document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&!$('#parametersModal').hidden)closeParameters()});
  syncChannel?.addEventListener('message',(event)=>{if(event.data?.source!=='site-card')reloadFromSharedData(event.data)});window.addEventListener('storage',(event)=>{if(event.key===recordStorageKey){state.records=loadRecords();renderRecords();return}if(!['margingo-github-pages-v1','margingo-sync-pulse'].includes(event.key))return;let message={};try{message=JSON.parse(event.newValue)||{}}catch{}reloadFromSharedData(message)});window.addEventListener('focus',()=>reloadFromSharedData());
}

initialize().catch((error)=>{console.error(error);toast(`?????${error.message}`);$('#resultGrid').innerHTML=`<div class="empty-result">${escapeHtml(error.message)}</div>`});
