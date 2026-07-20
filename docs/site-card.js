'use strict';

const state={bootstrap:null,project:null,country:null,listing:null,result:null,saving:0,pending:Promise.resolve(),reloadTimer:null};
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const apiBase=String(window.MARGINGO_API_BASE||'').replace(/\/$/,'');
const syncChannel='BroadcastChannel' in window?new BroadcastChannel('margingo-project-sync'):null;
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,digits=2)=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:digits});
const marketCode=(code)=>code==='GB'?'UK':code;
const field=(name)=>$(`[name="${name}"]`);

async function api(url,options={}){
  const target=/^https?:\/\//i.test(url)?url:`${apiBase}${url}`;
  const response=await fetch(target,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'请求失败');
  return payload;
}
function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(el.timer);el.timer=setTimeout(()=>el.classList.remove('show'),2200)}
function saving(start,error=false){state.saving=Math.max(0,state.saving+(start?1:-1));const el=$('#saveState');el.textContent=error?'保存失败':state.saving?'保存中…':'已保存';el.className=`save-state ${error?'error':state.saving?'saving':''}`}
function announceSync(){const message={projectId:state.project?.id,countryCode:state.country?.code,source:'site-card',at:Date.now()};syncChannel?.postMessage(message);try{localStorage.setItem('margingo-sync-pulse',JSON.stringify(message))}catch{}}
function updateLinks(){history.replaceState(null,'',`?project=${state.project.id}&country=${state.country.code}`)}

async function initialize(){
  state.bootstrap=await api('/api/bootstrap');
  if(!state.bootstrap.projects.length)state.project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:'新品测算 01'})});
  const params=new URLSearchParams(location.search);const requestedProject=Number(params.get('project'));
  const projectId=state.bootstrap.projects.some((item)=>Number(item.id)===requestedProject)?requestedProject:(state.project?.id||state.bootstrap.projects[0]?.id);
  state.project=await api(`/api/projects/${projectId}`);
  const requestedCountry=String(params.get('country')||'').toUpperCase();
  const defaultCountry=state.project.listings.find((item)=>item.selected)?.country_code||state.bootstrap.countries[0]?.code;
  setCountry(state.bootstrap.countries.some((item)=>item.code===requestedCountry)?requestedCountry:defaultCountry,false);
  renderPickers();fillFields();await calculate();bindEvents();
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
function profitExplanation(result){
  if(!result||!Number(result.sale_price))return '填写当地售价后显示完整计算过程';
  return ['利润率计算过程',`含税售价：${money(result.sale_price)}`,`减 VAT：${money(result.vat_amount)}`,`净销售收入：${money(result.net_revenue)}`,`减 ${result.tax_label||'税费'}：${money(result.tax_fee)}`,`减佣金：${money(result.referral_fee)}（${number(result.referral_rate,2)}%）`,`减 FBA：${money(result.fba_fee)}`,`减头程：${money(result.freight_fee)}`,`减产品成本：${money(result.product_cost)}`,`单件利润：${money(result.profit)}`,`利润率：${money(result.profit)} ÷ ${money(result.sale_price)} × 100 = ${number(result.profit_rate,1)}%`].join('\n');
}
function resultCard(label,value,note='',className='',withInfo=false){return `<div class="result-card ${className}"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b>${note?`<span>${escapeHtml(note)}</span>`:''}${withInfo?`<i class="profit-info" tabindex="0" title="${escapeHtml(profitExplanation(state.result))}" aria-label="查看利润率计算过程">i</i>`:''}</div>`}
function targetPriceGroup(result){return `<div class="result-card target-price-group"><small>FBA 目标售价</small><div class="target-price-values">${[0,10,20,30].map((rate)=>`<span><i>${rate}%</i><b>${result.target_prices?.[rate]==null?'—':escapeHtml(money(result.target_prices[rate]))}</b></span>`).join('')}</div></div>`}
function renderResult(){
  const result=state.result;const priced=Number(state.listing.sale_price)>0;
  renderParameterSummary();
  if(!result||!priced){$('#resultGrid').innerHTML='<div class="empty-result">填写当地售价后显示利润结果</div>';return}
  const negative=Number(result.profit)<0?'negative':'';
  $('#resultGrid').innerHTML=[
    resultCard('FBA 配送费',money(result.fba_fee)),
    resultCard('头程',money(result.freight_fee)),
    resultCard('税金',money(Number(result.tax_fee)+Number(result.vat_amount))),
    resultCard('利润率',`${number(result.profit_rate,1)}%`,'',`primary ${negative}`,true),
    targetPriceGroup(result)
  ].join('');
}

async function saveProduct(){
  saving(true);try{
    const body={name:field('name').value.trim()||'未命名品类',cost_cny:Number(field('cost_cny').value)||0,weight:Number(field('weight').value)||0,weight_unit:field('weight_unit').value,length:Number(field('length').value)||0,width:Number(field('width').value)||0,height:Number(field('height').value)||0,dimension_unit:field('dimension_unit').value};
    state.project=await api(`/api/projects/${state.project.id}`,{method:'PUT',body:JSON.stringify(body)});state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);refreshProjectSummary();await calculate();saving(false);announceSync();
  }catch(error){saving(false,true);toast(error.message)}
}
async function saveListing(){
  saving(true);try{
    const category=field('category_text').value.trim();const overrideRaw=field('referral_rate_override').value;const override=overrideRaw===''?null:Number(overrideRaw);
    if(override!==null&&(!Number.isFinite(override)||override<0||override>100))throw new Error('佣金比例请输入 0–100');
    const changes={sale_price:Number(field('sale_price').value)||0,category_text:category,referral_rate_override:override};
    if(category&&category!==state.listing.category_text){const matched=await api('/api/commission/match',{method:'POST',body:JSON.stringify({country_code:state.country.code,text:category,sale_price:changes.sale_price})});if(matched.matched)Object.assign(changes,{matched_category:matched.rule.parent_category,matched_referral_rate:matched.rule.rate,matched_referral_threshold:matched.rule.threshold_price,matched_referral_rate_above:matched.rule.rate_above,matched_referral_minimum:matched.rule.minimum_fee||0})}
    state.project=await api(`/api/projects/${state.project.id}/countries/${state.country.code}`,{method:'PUT',body:JSON.stringify(changes)});state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);await calculate();saving(false);announceSync();
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
async function reloadFromSharedData(message={}){if(message.projectId&&Number(message.projectId)!==Number(state.project.id))return;clearTimeout(state.reloadTimer);state.reloadTimer=setTimeout(async()=>{try{state.project=await api(`/api/projects/${state.project.id}`);state.listing=state.project.listings.find((item)=>item.country_code===state.country.code);refreshProjectSummary();fillFields();await calculate()}catch{}},180)}

function bindEvents(){
  $('#projectPicker').onchange=async(event)=>{await state.pending;state.project=await api(`/api/projects/${event.target.value}`);const code=state.project.listings.some((item)=>item.country_code===state.country.code)?state.country.code:state.bootstrap.countries[0].code;setCountry(code,false);renderPickers();fillFields();await calculate()};
  for(const name of ['name','cost_cny','weight','weight_unit','length','width','height','dimension_unit']){const input=field(name);input.oninput=()=>debounceSave(saveProduct,'productTimer');input.onchange=()=>{clearTimeout(state.productTimer);state.pending=saveProduct()}}
  for(const name of ['sale_price','category_text','referral_rate_override']){const input=field(name);input.oninput=()=>debounceSave(saveListing,'listingTimer');input.onchange=()=>{clearTimeout(state.listingTimer);state.pending=saveListing()}}
  $('#readDimensionsBtn').onclick=readDimensions;$$('[data-site-dimension]').forEach((input)=>input.addEventListener('paste',handleDimensionPaste));$('#copyResultBtn').onclick=copyResult;
  $('#openParametersBtn').onclick=openParameters;$$('[data-close-parameters]').forEach((button)=>button.onclick=closeParameters);document.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&!$('#parametersModal').hidden)closeParameters()});
  syncChannel?.addEventListener('message',(event)=>{if(event.data?.source!=='site-card')reloadFromSharedData(event.data)});window.addEventListener('storage',(event)=>{if(!['margingo-github-pages-v1','margingo-sync-pulse'].includes(event.key))return;let message={};try{message=JSON.parse(event.newValue)||{}}catch{}reloadFromSharedData(message)});window.addEventListener('focus',()=>reloadFromSharedData());
}

initialize().catch((error)=>{console.error(error);toast(`加载失败：${error.message}`);$('#resultGrid').innerHTML=`<div class="empty-result">${escapeHtml(error.message)}</div>`});
