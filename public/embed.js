'use strict';

const state={bootstrap:null,project:null,results:[],shareKey:'',saving:0,pending:Promise.resolve()};
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const apiBase=String(window.MARGINGO_API_BASE||'').replace(/\/$/,'');
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,digits=2)=>Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:digits});
const marketCode=(code)=>code==='GB'?'UK':code;
const resultFor=(code)=>state.results.find((item)=>item.country_code===code);

async function api(url,options={}){
  const target=/^https?:\/\//i.test(url)?url:`${apiBase}${url}`;
  const response=await fetch(target,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'请求失败');
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
  state.bootstrap=await api('/api/bootstrap');let project=null;
  const encoded=location.hash.startsWith('#data=')?location.hash.slice(6):'';
  if(encoded){project=await importSnapshot(decodeState(encoded),encoded);toast('已从链接恢复计算参数')}
  const requested=new URLSearchParams(location.search).get('project');
  if(!project&&requested)project=await api(`/api/projects/${requested}`).catch(()=>null);
  if(!project&&state.bootstrap.projects.length)project=await api(`/api/projects/${state.bootstrap.projects[0].id}`);
  if(!project)project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:'新品测算 01'})});
  state.project=project;state.shareKey=state.shareKey||localStorage.getItem(`margingo-embed-key:${project.id}`)||newShareKey();
  localStorage.setItem(`margingo-embed-key:${project.id}`,state.shareKey);
  await refreshProjects();fillProduct();await calculate();bindEvents();
}
async function refreshProjects(){
  state.bootstrap=await api('/api/bootstrap');
  const options=state.bootstrap.projects.map((item)=>`<option value="${item.id}" ${Number(item.id)===Number(state.project.id)?'selected':''}>${escapeHtml(item.name)}</option>`).join('');
  $('#projectPicker').innerHTML=options||`<option value="${state.project.id}">${escapeHtml(state.project.name)}</option>`;
}
function sharedCategory(){return state.project.listings.find((item)=>item.selected&&item.category_text)?.category_text||state.project.listings.find((item)=>item.category_text)?.category_text||''}
function fillProduct(){
  for(const key of ['name','cost_cny','weight','weight_unit','length','width','height','dimension_unit'])$(`[name="${key}"]`,$('#productFields')).value=state.project[key]??'';
  $('[name="category_text"]',$('#productFields')).value=sharedCategory();renderSites();
}
function renderSites(){
  $('#siteTabs').innerHTML=state.bootstrap.countries.map((country)=>{const listing=state.project.listings.find((item)=>item.country_code===country.code);return `<button class="site-tab ${listing?.selected?'active':''}" type="button" data-country="${country.code}" aria-pressed="${Boolean(listing?.selected)}">${country.flag} ${marketCode(country.code)}</button>`}).join('');
  $('#siteCount').textContent=`已选 ${state.project.listings.filter((item)=>item.selected).length} 个站点`;
  $$('[data-country]').forEach((button)=>button.onclick=()=>toggleSite(button.dataset.country));
}
async function calculate(){const payload=await api('/api/calculate',{method:'POST',body:JSON.stringify({project_id:state.project.id})});state.results=payload.results||[];renderResults()}
function renderResults(){
  const selected=state.project.listings.filter((item)=>item.selected);
  if(!selected.length){$('#resultRows').innerHTML='<tr><td class="empty-row" colspan="7">请至少选择一个测算站点</td></tr>';return}
  $('#resultRows').innerHTML=selected.map((listing)=>{
    const country=state.bootstrap.countries.find((item)=>item.code===listing.country_code);const result=resultFor(listing.country_code);const priced=Number(listing.sale_price)>0;const cls=priced?(Number(result?.profit)>=0?'positive':'negative'):'';const commission=listing.referral_rate_override??listing.matched_referral_rate??result?.referral_base_rate??15;
    return `<tr><td class="country-cell">${country.flag} ${marketCode(country.code)}<small>${escapeHtml(country.name)}</small></td><td><label class="price-input"><span>${escapeHtml(listing.symbol)}</span><input type="number" min="0" step="0.01" value="${listing.sale_price||''}" placeholder="0.00" data-price="${listing.country_code}"></label></td><td>${number(commission)}%<span class="subvalue">${escapeHtml(listing.matched_category||'默认费率')}</span></td><td>${result?`${escapeHtml(result.symbol)}${number(result.fba_fee)}`:'—'}<span class="subvalue">${escapeHtml(result?.size_tier_name||'待计算')}</span></td><td>${result?`${escapeHtml(result.symbol)}${number(result.freight_fee)}`:'—'}</td><td class="${cls}">${priced&&result?`${result.profit<0?'-':''}${escapeHtml(result.symbol)}${number(Math.abs(result.profit))}`:'—'}</td><td class="${cls}">${priced&&result?`${number(result.profit_rate,1)}%`:'—'}</td></tr>`;
  }).join('');
  $$('[data-price]').forEach((input)=>input.onchange=()=>{state.pending=savePrice(input.dataset.price,input.value)});
}

async function saveProduct(){
  const body={name:formValue('name').trim()||'未命名品类',cost_cny:Number(formValue('cost_cny'))||0,weight:Number(formValue('weight'))||0,weight_unit:formValue('weight_unit'),length:Number(formValue('length'))||0,width:Number(formValue('width'))||0,height:Number(formValue('height'))||0,dimension_unit:formValue('dimension_unit')};
  saving(true);
  try{state.project=await api(`/api/projects/${state.project.id}`,{method:'PUT',body:JSON.stringify(body)});await calculate();await refreshProjects();saving(false)}
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
    await calculate();saving(false);
  }catch(error){saving(false,true);toast(error.message)}
}
async function toggleSite(code){
  const listing=state.project.listings.find((item)=>item.country_code===code);
  if(listing.selected&&state.project.listings.filter((item)=>item.selected).length===1)return toast('至少保留一个测算站点');
  saving(true);
  try{state.project=await api(`/api/projects/${state.project.id}/countries/${code}`,{method:'PUT',body:JSON.stringify({selected:!listing.selected,category_text:sharedCategory()})});renderSites();await calculate();saving(false)}
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
  for(const [code,value] of Object.entries(draftPrices)){
    const listing=state.project.listings.find((item)=>item.country_code===code);
    if(Number(value||0)!==Number(listing?.sale_price||0))await savePrice(code,value);
  }
}
async function writeRows(rows,linkIndex=-1){
  const tsv=rows.map((row)=>row.join('\t')).join('\n');
  const html=`<table><tbody>${rows.map((row)=>`<tr>${row.map((item,index)=>index===linkIndex?`<td><a href="${escapeHtml(item)}">调整</a></td>`:`<td>${escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  try{
    if(globalThis.ClipboardItem&&navigator.clipboard?.write)await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([tsv],{type:'text/plain'})})]);
    else await navigator.clipboard.writeText(tsv);
  }catch{
    const helper=document.createElement('textarea');helper.value=tsv;helper.style.cssText='position:fixed;opacity:0';document.body.append(helper);helper.select();document.execCommand('copy');helper.remove();
  }
}
async function copyTable(){
  await flushDrafts();
  if(!state.project.listings.some((item)=>item.selected))return toast('请先选择测算站点');
  const link=stateLink();const rows=state.project.listings.filter((item)=>item.selected).map((listing)=>{const result=resultFor(listing.country_code);return [state.project.name,`${listing.symbol}${number(listing.sale_price)}`,result?`${number(result.profit_rate,1)}%`:'—',link]});
  await writeRows(rows,3);toast(`已复制 ${rows.length} 行产品结果`);
}
async function copySiteProfitTable(){
  await flushDrafts();
  const rows=state.project.listings.filter((item)=>item.selected).map((listing)=>{const country=state.bootstrap.countries.find((item)=>item.code===listing.country_code);const result=resultFor(listing.country_code);return [`${marketCode(country.code)} ${country.name}`,state.project.name,`${listing.symbol}${number(listing.sale_price)}`,result?`${number(result.profit_rate,1)}%`:'—']});
  await writeRows(rows);toast(`已复制 ${rows.length} 行站点利润率`);
}

function bindEvents(){
  $$('input,select',$('#productFields')).forEach((input)=>input.onchange=()=>{state.pending=input.name==='category_text'?saveCategory():saveProduct()});
  $('#projectPicker').onchange=async(event)=>{
    state.project=await api(`/api/projects/${event.target.value}`);state.shareKey=localStorage.getItem(`margingo-embed-key:${state.project.id}`)||newShareKey();localStorage.setItem(`margingo-embed-key:${state.project.id}`,state.shareKey);history.replaceState(null,'',`?project=${state.project.id}`);fillProduct();await calculate();
  };
  $('#newProjectBtn').onclick=async()=>{
    state.project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:`新品测算 ${state.bootstrap.projects.length+1}`})});state.shareKey=newShareKey();localStorage.setItem(`margingo-embed-key:${state.project.id}`,state.shareKey);history.replaceState(null,'',`?project=${state.project.id}`);await refreshProjects();fillProduct();await calculate();toast('已新建品类');
  };
  $('#copyTableBtn').onclick=copyTable;
  $('#copySiteProfitBtn').onclick=copySiteProfitTable;
}

initialize().catch((error)=>{console.error(error);toast(`加载失败：${error.message}`);$('#resultRows').innerHTML=`<tr><td class="empty-row" colspan="7">${escapeHtml(error.message)}</td></tr>`});
