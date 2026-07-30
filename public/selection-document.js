'use strict';

(function selectionDocumentModule(root){
function cloneValue(value) {
  return value===undefined?undefined:JSON.parse(JSON.stringify(value));
}

function valuesMatch(left,right) {
  return JSON.stringify(left)===JSON.stringify(right);
}

function snapshotFields(entity,fields) {
  return Object.fromEntries(fields.map((fieldName)=>[
    fieldName,
    cloneValue(entity?.[fieldName])
  ]));
}

function createLatestSnapshotSaveQueue({
  delayMs=500,
  snapshot,
  request,
  applyResponse=()=>{},
  onSaved=()=>{},
  onError=()=>{},
  setTimer=setTimeout,
  clearTimer=clearTimeout
}={}) {
  let pending=null;
  let runningPromise=null;
  let timer=null;
  let idleWaiters=[];
  let closed=false;

  const isIdle=()=>!runningPromise&&!pending&&!timer;
  const isClosed=()=>closed;
  const settleIdle=()=>{
    if(!isIdle())return;
    const waiters=idleWaiters;
    idleWaiters=[];
    for(const waiter of waiters)waiter.resolve();
  };
  const rejectIdle=(error)=>{
    const waiters=idleWaiters;
    idleWaiters=[];
    for(const waiter of waiters)waiter.reject(error);
  };
  const whenIdle=()=>isIdle()
    ? Promise.resolve()
    : new Promise((resolve,reject)=>idleWaiters.push({resolve,reject}));

  function run() {
    if(runningPromise)return runningPromise;
    if(!pending)return Promise.resolve();
    if(timer){
      clearTimer(timer);
      timer=null;
    }

    runningPromise=(async()=>{
      while(pending&&!closed){
        const sent=pending;
        pending=null;
        try{
          const saved=await request(sent);
          const hasPending=Boolean(pending);
          if(!closed){
            applyResponse(saved,sent,{hasPending});
            onSaved(saved,{hasPending,sent});
          }
        }catch(error){
          if(!closed){
            if(!pending)pending=sent;
            onError(error);
          }
          throw error;
        }
      }
    })();
    runningPromise.then(()=>{
      runningPromise=null;
      settleIdle();
    },(error)=>{
      runningPromise=null;
      rejectIdle(error);
    });
    return runningPromise;
  }

  function enqueue() {
    if(closed)return false;
    pending=snapshot();
    if(runningPromise)return true;
    if(timer)clearTimer(timer);
    timer=setTimer(()=>{
      timer=null;
      run().catch(()=>{});
    },delayMs);
    return true;
  }

  function flush() {
    if(timer){
      clearTimer(timer);
      timer=null;
    }
    if(runningPromise)return whenIdle();
    return pending&&!closed?run():Promise.resolve();
  }

  function close() {
    closed=true;
    pending=null;
    if(timer){
      clearTimer(timer);
      timer=null;
    }
    settleIdle();
    return whenIdle();
  }

  return {enqueue,flush,whenIdle,isIdle,isClosed,close};
}

function createDocumentSaveQueue({
  readDocument,
  writeDocument,
  snapshotDocument,
  request,
  ...options
}={}) {
  return createLatestSnapshotSaveQueue({
    ...options,
    snapshot:snapshotDocument,
    request:(snapshot)=>request({
      ...snapshot,
      version:Number(readDocument()?.version)||0
    }),
    applyResponse:(saved,_sent,{hasPending})=>{
      if(hasPending){
        const live=readDocument();
        live.version=saved.version;
        if(Object.hasOwn(saved,'updated_at'))live.updated_at=saved.updated_at;
      }else{
        writeDocument(saved);
      }
    }
  });
}

function createEntitySaveQueue({
  readEntity,
  fields,
  metadataFields=[],
  dependentFields=[],
  request,
  ...options
}={}) {
  return createLatestSnapshotSaveQueue({
    ...options,
    snapshot:()=>snapshotFields(readEntity(),fields),
    request,
    applyResponse:(saved,sent)=>{
      const live=readEntity();
      if(!live)return;
      const allEditableFieldsUnchanged=fields.every((fieldName)=>
        valuesMatch(live[fieldName],sent[fieldName])
      );
      for(const fieldName of fields){
        if(
          Object.hasOwn(saved,fieldName)&&
          valuesMatch(live[fieldName],sent[fieldName])
        )live[fieldName]=cloneValue(saved[fieldName]);
      }
      for(const fieldName of metadataFields){
        if(Object.hasOwn(saved,fieldName))live[fieldName]=cloneValue(saved[fieldName]);
      }
      if(allEditableFieldsUnchanged){
        for(const fieldName of dependentFields){
          if(Object.hasOwn(saved,fieldName))live[fieldName]=cloneValue(saved[fieldName]);
        }
      }
    }
  });
}

function createAsyncOperationRegistry({onTrack=()=>{}}={}) {
  const operations=new Set();
  return {
    track(operation){
      const tracked=Promise.resolve(operation);
      operations.add(tracked);
      onTrack(tracked);
      tracked.then(
        ()=>operations.delete(tracked),
        ()=>operations.delete(tracked)
      );
      return tracked;
    },
    snapshot:()=>[...operations],
    isIdle:()=>operations.size===0
  };
}

async function loadDataAfterStableSaves({
  fetchData,
  flush,
  readRevision=()=>0,
  hasWork=()=>false,
  maxRefetches=2
}={}) {
  const refetchLimit=Math.max(0,Math.floor(Number(maxRefetches)||0));
  for(let attempt=0;attempt<=refetchLimit;attempt+=1){
    await flush();
    const revisionBeforeFetch=readRevision();
    const loaded=await fetchData();
    if(readRevision()===revisionBeforeFetch&&!hasWork())return loaded;
    if(attempt===refetchLimit){
      const error=new Error('刷新期间仍有新的保存操作，请稍后重试');
      error.code='RELOAD_SAVE_ACTIVITY';
      throw error;
    }
  }
}

function createExclusiveActionLock({setLocked=()=>{}}={}) {
  let lockDepth=0;
  return {
    async run(operation){
      if(lockDepth===0)setLocked(true);
      lockDepth+=1;
      try{
        return await operation();
      }finally{
        lockDepth-=1;
        if(lockDepth===0)setLocked(false);
      }
    },
    depth:()=>lockDepth,
    isLocked:()=>lockDepth>0
  };
}

async function deleteEntityAfterSave({
  queue,
  requestDelete,
  unregister=()=>{},
  onDeleted=()=>{}
}={}) {
  if(queue)await queue.flush();
  const result=await requestDelete();
  if(queue)await queue.close();
  unregister();
  onDeleted(result);
  return result;
}

const state={
  projectId:Number(new URLSearchParams(root.location?.search||'').get('project')),
  data:null,
  chapter:'overview',
  siteCode:'US',
  competitorKind:'standard',
  siteSaveQueues:new Map(),
  supplierSaveQueues:new Map(),
  lifecycleOperations:null,
  workRevision:0,
  lastRetry:null
};
state.lifecycleOperations=createAsyncOperationRegistry({
  onTrack:()=>{state.workRevision+=1}
});
const $=(selector,target=root.document)=>target.querySelector(selector);
const $$=(selector,target=root.document)=>[...target.querySelectorAll(selector)];
const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(char)=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
})[char]);
const apiBase=String(root.MARGINGO_API_BASE||'').replace(/\/$/,'');

function setWorkbenchEditingLocked(locked){
  for(const selector of ['.chapter-nav','.chapter-content']){
    const element=$(selector);
    if(!element)continue;
    element.inert=locked;
    if(locked)element.setAttribute('aria-busy','true');
    else element.removeAttribute('aria-busy');
  }
}

const exclusiveReloadLock=createExclusiveActionLock({
  setLocked:setWorkbenchEditingLocked
});

function withExclusiveReload(operation){
  return exclusiveReloadLock.run(operation);
}

async function api(path,options={}) {
  const response=await fetch(`${apiBase}${path}`,{
    headers:{'Content-Type':'application/json',...(options.headers||{})},
    ...options
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error(payload.error||'请求失败');
    error.status=response.status;
    throw error;
  }
  return payload;
}

function toast(message){
  const element=$('#toast');
  element.textContent=message;
  element.classList.add('show');
  clearTimeout(element.timer);
  element.timer=setTimeout(()=>element.classList.remove('show'),2400);
}

function setSaveState(text,isError=false,retry=null){
  const element=$('#saveState');
  element.textContent=text;
  element.classList.toggle('error',isError);
  const button=$('#retrySave');
  state.lastRetry=retry;
  button.hidden=!retry;
}

function number(value,digits=2){
  return Number(value||0).toLocaleString('zh-CN',{maximumFractionDigits:digits});
}
function textList(value){
  if(Array.isArray(value))return value.join('、');
  try{return JSON.parse(value||'[]').join('、')}catch{return ''}
}
function field(label,name,value,{type='text',full=false,placeholder='',min='',max='',step=''}={}){
  const input=type==='textarea'
    ?`<textarea name="${name}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
    :type==='select'
      ?value
      :`<input name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${min!==''?`min="${min}"`:''} ${max!==''?`max="${max}"`:''} ${step!==''?`step="${step}"`:''}>`;
  return `<label class="field ${full?'full':''}"><span>${escapeHtml(label)}</span>${input}</label>`;
}

function updateSummary(){
  const {document:doc,profits,suppliers,sites}=state.data;
  const ranked=profits.filter((item)=>item.calculation&&Number(item.sale_price)>0)
    .sort((a,b)=>Number(b.calculation.profit_rate)-Number(a.calculation.profit_rate));
  const best=ranked[0];
  const supplier=[...suppliers].sort((a,b)=>
    Number(b.post_sample_score??b.pre_sample_score??-1)-Number(a.post_sample_score??a.pre_sample_score??-1))[0];
  const checks=[
    doc.positioning,doc.use_scenarios,doc.competitive_points,
    Array.isArray(doc.differentiation_items)&&doc.differentiation_items.length,
    Array.isArray(doc.review_issues)&&doc.review_issues.length,
    doc.competitor_summary,
    sites.some((item)=>item.opportunity_status),
    suppliers.length,
    doc.patent_notes,
    Array.isArray(doc.checklist)&&doc.checklist.length&&doc.checklist.every((item)=>item.checked)
  ];
  const completion=Math.round(checks.filter(Boolean).length/checks.length*100);
  $('#decisionStatus').textContent=doc.decision_status||'观察中';
  $('#bestSiteMetric').textContent=best?`${best.country_name} ${number(best.calculation.profit_rate,1)}%`:'待填写售价';
  $('#targetMarginMetric').textContent=best?`${number(best.calculation.profit_rate,1)}%`:'—';
  $('#preferredSupplierMetric').textContent=supplier?.name||'待比较';
  $('#completionMetric').textContent=`${completion}%`;
}

function renderOverview(){
  const doc=state.data.document;
  $('#overviewContent').innerHTML=`
    <div class="panel">
      <div class="panel-title"><div><h3>最终判断</h3><p>指标用于辅助，立项结论由负责人确认。</p></div></div>
      <div class="decision-row">
        ${field('决策状态','decision_status',`<select name="decision_status"><option ${doc.decision_status==='观察中'?'selected':''}>观察中</option><option ${doc.decision_status==='通过'?'selected':''}>通过</option><option ${doc.decision_status==='淘汰'?'selected':''}>淘汰</option></select>`,{type:'select'})}
        ${field('决策理由','decision_reason',doc.decision_reason,{placeholder:'说明通过、观察或淘汰的关键依据'})}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title"><div><h3>产品判断</h3><p>保留飞书文档里真正影响选品的结论。</p></div></div>
      <div class="form-grid">
        ${field('产品定位','positioning',doc.positioning,{type:'textarea',placeholder:'例如：对中高端产品的升级替代'})}
        ${field('使用场景','use_scenarios',doc.use_scenarios,{type:'textarea',placeholder:'谁在什么场景下使用，解决什么问题'})}
        ${field('核心竞争点','competitive_points',doc.competitive_points,{type:'textarea',placeholder:'按优先级列出产品必须做好的能力'})}
        ${field('概览结论','overview_summary',doc.overview_summary,{type:'textarea',placeholder:'用几句话总结产品机会和主要顾虑'})}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title"><div><h3>差异化方案</h3><p>记录可执行方向、层级、成本难度与是否采用。</p></div><button class="secondary-button" type="button" data-add-list="differentiation_items">＋ 添加方案</button></div>
      <div class="list-editor" data-list="differentiation_items">${renderDifferentiationRows(doc.differentiation_items)}</div>
    </div>
    <div class="panel">
      <div class="panel-title"><div><h3>差评问题</h3><p>把高频差评转化为产品改进任务。</p></div><button class="secondary-button" type="button" data-add-list="review_issues">＋ 添加问题</button></div>
      <div class="list-editor" data-list="review_issues">${renderReviewRows(doc.review_issues)}</div>
    </div>`;
  bindDocumentFields($('#overviewContent'));
}

function renderDifferentiationRows(rows=[]){
  if(!rows.length)return '<div class="empty">还没有差异化方案</div>';
  return rows.map((item,index)=>`<div class="list-row" data-list-row="${index}">
    <input data-list-field="direction" value="${escapeHtml(item.direction)}" placeholder="差异化方向">
    <input data-list-field="level" value="${escapeHtml(item.level)}" placeholder="短期/中期/长期">
    <input data-list-field="difficulty" value="${escapeHtml(item.difficulty)}" placeholder="成本与难度">
    <button class="icon-button danger-button" type="button" data-remove-list="${index}">删除</button>
  </div>`).join('');
}

function renderReviewRows(rows=[]){
  if(!rows.length)return '<div class="empty">还没有差评问题</div>';
  return rows.map((item,index)=>`<div class="list-row review" data-list-row="${index}">
    <input data-list-field="issue" value="${escapeHtml(item.issue)}" placeholder="差评点">
    <input data-list-field="ratio" type="number" min="0" max="100" value="${escapeHtml(item.ratio)}" placeholder="比例 %">
    <textarea data-list-field="solution" placeholder="解决方法">${escapeHtml(item.solution)}</textarea>
    <button class="icon-button danger-button" type="button" data-remove-list="${index}">删除</button>
  </div>`).join('');
}

const DOCUMENT_FIELDS=[
  'decision_status','decision_reason','positioning','use_scenarios','competitive_points',
  'differentiation_items','review_issues','overview_summary','competitor_summary',
  'supplier_summary','patent_notes','checklist'
];
const SITE_FIELDS=[
  'market_average_revenue','market_average_sales','new_product_friendliness',
  'same_product_performance','opportunity_status','opportunity_notes',
  'certification_required','certification_actual','supplier_certifications',
  'certification_gap','certification_gap_cost','payback_period'
];
const SUPPLIER_FIELDS=[
  'name','product_url','image_url','cost_cny','moq','specifications','certifications',
  'sample_reason','pre_sample_score','post_sample_score','pros','cons',
  'target_country_code','target_sale_price'
];

function documentSnapshot(){
  const doc=state.data.document;
  return Object.fromEntries(DOCUMENT_FIELDS.map((fieldName)=>[
    fieldName,
    JSON.parse(JSON.stringify(doc[fieldName]))
  ]));
}

const documentSaveQueue=createDocumentSaveQueue({
  readDocument:()=>state.data.document,
  writeDocument:(saved)=>{state.data.document=saved},
  snapshotDocument:documentSnapshot,
  request:(payload)=>api(`/api/projects/${state.projectId}/selection-document`,{
    method:'PUT',body:JSON.stringify(payload)
  }),
  onSaved:(_saved,{hasPending})=>{
    updateSummary();
    if(!hasPending)setSaveState('已保存');
  },
  onError:(error)=>{
    if(error.status===409){
      setSaveState('数据已被他人更新，请刷新后再编辑',true);
    }else{
      setSaveState('保存失败',true,()=>documentSaveQueue.flush());
    }
    toast(error.message);
  }
});

function scheduleDocumentSave(){
  setSaveState('保存中…');
  state.workRevision+=1;
  documentSaveQueue.enqueue();
}

function handleEntitySaveError(error,queue){
  if(error.status===409){
    setSaveState('数据已被他人更新，请刷新后再编辑',true);
  }else{
    setSaveState('保存失败',true,()=>queue.flush());
  }
  toast(error.message);
}

function getSiteSaveQueue(countryCode){
  if(state.siteSaveQueues.has(countryCode))return state.siteSaveQueues.get(countryCode);
  let queue;
  queue=createEntitySaveQueue({
    readEntity:()=>state.data?.sites.find((item)=>item.country_code===countryCode),
    fields:SITE_FIELDS,
    metadataFields:['updated_at'],
    request:(payload)=>api(`/api/projects/${state.projectId}/selection-document/sites/${countryCode}`,{
      method:'PUT',body:JSON.stringify(payload)
    }),
    onSaved:(_saved,{hasPending})=>{
      updateSummary();
      if(!hasPending)setSaveState('已保存');
    },
    onError:(error)=>handleEntitySaveError(error,queue)
  });
  state.siteSaveQueues.set(countryCode,queue);
  return queue;
}

function scheduleSiteSave(site){
  setSaveState('保存中…');
  state.workRevision+=1;
  getSiteSaveQueue(site.country_code).enqueue();
}

function getSupplierSaveQueue(supplierId){
  if(state.supplierSaveQueues.has(supplierId))return state.supplierSaveQueues.get(supplierId);
  let queue;
  queue=createEntitySaveQueue({
    readEntity:()=>state.data?.suppliers.find((item)=>item.id===supplierId),
    fields:SUPPLIER_FIELDS,
    metadataFields:['updated_at'],
    dependentFields:['calculation'],
    request:(payload)=>api(`/api/selection-suppliers/${supplierId}`,{
      method:'PUT',body:JSON.stringify(payload)
    }),
    onSaved:(_saved,{hasPending})=>{
      updateSummary();
      if(!hasPending)setSaveState('已保存');
    },
    onError:(error)=>handleEntitySaveError(error,queue)
  });
  state.supplierSaveQueues.set(supplierId,queue);
  return queue;
}

function scheduleSupplierSave(supplier){
  setSaveState('保存中…');
  state.workRevision+=1;
  getSupplierSaveQueue(supplier.id).enqueue();
}

function allSaveQueues(){
  return [
    documentSaveQueue,
    ...state.siteSaveQueues.values(),
    ...state.supplierSaveQueues.values()
  ];
}

async function flushSaveQueues(readQueues,readOperations=()=>[]){
  while(true){
    const queues=[...new Set(readQueues())];
    const operations=[...new Set(readOperations())];
    const results=await Promise.allSettled([
      ...queues.map((queue)=>queue.flush()),
      ...operations
    ]);
    const failure=results.find((result)=>result.status==='rejected');
    if(failure)throw failure.reason;
    if(
      [...new Set(readQueues())].every((queue)=>queue.isIdle())&&
      readOperations().length===0
    )return;
  }
}

function flushPendingSaves(){
  return flushSaveQueues(
    allSaveQueues,
    state.lifecycleOperations.snapshot
  );
}

function hasActiveSaveWork(){
  return (
    !state.lifecycleOperations.isIdle()||
    allSaveQueues().some((queue)=>!queue.isIdle())
  );
}

function closeAndRemoveIdleQueues(queueMap){
  for(const [key,queue] of queueMap){
    if(!queue.isIdle())continue;
    void queue.close();
    queueMap.delete(key);
  }
}

function bindDocumentFields(root){
  $$('[name]',root).forEach((input)=>input.addEventListener('input',()=>{
    state.data.document[input.name]=input.value;
    updateSummary();
    scheduleDocumentSave();
  }));
  $$('[data-add-list]',root).forEach((button)=>button.addEventListener('click',()=>{
    const key=button.dataset.addList;
    state.data.document[key].push(key==='review_issues'?{issue:'',ratio:'',solution:''}:{direction:'',level:'',difficulty:''});
    renderOverview();
    scheduleDocumentSave();
  }));
  $$('[data-list]',root).forEach((list)=>{
    const key=list.dataset.list;
    list.addEventListener('input',(event)=>{
      const row=event.target.closest('[data-list-row]');
      if(!row||!event.target.dataset.listField)return;
      state.data.document[key][Number(row.dataset.listRow)][event.target.dataset.listField]=event.target.value;
      updateSummary();
      scheduleDocumentSave();
    });
    list.addEventListener('click',(event)=>{
      const button=event.target.closest('[data-remove-list]');
      if(!button||!confirm('删除这一项？'))return;
      state.data.document[key].splice(Number(button.dataset.removeList),1);
      renderOverview();
      updateSummary();
      scheduleDocumentSave();
    });
  });
}

function siteButtons(){
  return state.data.sites.map((site)=>`<button class="${site.country_code===state.siteCode?'active':''}" type="button" data-site="${site.country_code}">${site.flag} ${site.country_name}</button>`).join('');
}

function renderSites(){
  const site=state.data.sites.find((item)=>item.country_code===state.siteCode)||state.data.sites[0];
  state.siteCode=site.country_code;
  const profit=state.data.profits.find((item)=>item.country_code===site.country_code);
  $('#sitesContent').innerHTML=`
    <div class="panel">
      <div class="panel-title"><div><h3>站点利润卡片</h3><p>直接读取利润率计算器，不复制计算逻辑。</p></div></div>
      <div class="site-profit-grid">${state.data.profits.map(renderProfitCard).join('')}</div>
    </div>
    <div class="panel">
      <div class="site-selector">${siteButtons()}</div>
      <div class="form-grid" data-site-form>
        ${field('市场前三平均销售额','market_average_revenue',site.market_average_revenue,{type:'number',min:0,step:.01})}
        ${field('市场前三平均销量','market_average_sales',site.market_average_sales,{type:'number',min:0,step:1})}
        ${field('新品友好度','new_product_friendliness',site.new_product_friendliness,{type:'textarea',placeholder:'最近新品表现及进入难度'})}
        ${field('同款表现','same_product_performance',site.same_product_performance,{type:'textarea',placeholder:'同款销售额、售价、评价、销量和利润率'})}
        ${field('机会判断','opportunity_status',`<select name="opportunity_status"><option value="">未判断</option><option ${site.opportunity_status==='优先'?'selected':''}>优先</option><option ${site.opportunity_status==='观察'?'selected':''}>观察</option><option ${site.opportunity_status==='放弃'?'selected':''}>放弃</option></select>`,{type:'select'})}
        ${field('站点结论','opportunity_notes',site.opportunity_notes,{type:'textarea',placeholder:'为什么值得做，或为什么暂不进入'})}
      </div>
    </div>`;
  bindSiteControls($('#sitesContent'));
}

function renderProfitCard(item){
  const result=item.calculation;
  const rate=result&&Number(item.sale_price)>0?Number(result.profit_rate):null;
  return `<button class="profit-card ${rate==null?'':rate>=0?'positive':'negative'}" type="button" data-site="${item.country_code}">
    <header><b>${item.flag} ${escapeHtml(item.country_name)}</b><small>${escapeHtml(item.currency)}</small></header>
    <strong>${rate==null?'—':`${number(rate,1)}%`}</strong>
    <small>${item.sale_price?`售价 ${escapeHtml(item.symbol)}${number(item.sale_price)}`:'待填写售价'}</small>
  </button>`;
}

function bindSiteControls(root){
  $$('[data-site]',root).forEach((button)=>button.addEventListener('click',()=>{
    state.siteCode=button.dataset.site;
    renderSites();
  }));
  $$('[name]',root).forEach((input)=>input.addEventListener('input',()=>{
    const site=state.data.sites.find((item)=>item.country_code===state.siteCode);
    site[input.name]=input.type==='number'?Number(input.value)||0:input.value;
    updateSummary();
    scheduleSiteSave(site);
  }));
}

function renderCompetitors(){
  const countries=state.data.sites;
  if(!countries.some((item)=>item.country_code===state.siteCode))state.siteCode=countries[0].country_code;
  const rows=state.data.competitors[state.competitorKind].filter((item)=>item.country_code===state.siteCode);
  const selectedSite=countries.find((item)=>item.country_code===state.siteCode);
  $('#competitorsContent').innerHTML=`
    <div class="panel">
      <div class="competitor-toolbar">
        <div class="site-selector">${siteButtons()}</div>
        <span class="toolbar-spacer"></span>
        <div class="kind-tabs">
          <button class="${state.competitorKind==='standard'?'active':''}" data-kind="standard" type="button">普通竞品</button>
          <button class="${state.competitorKind==='similar'?'active':''}" data-kind="similar" type="button">同款竞品</button>
        </div>
        <a class="primary-button" href="./embed.html?project=${state.projectId}&country=${state.siteCode}">打开竞品导入与分析</a>
      </div>
      <div class="table-wrap">${competitorTable(rows,selectedSite)}</div>
    </div>
    <div class="panel">
      <div class="panel-title"><div><h3>竞品结论</h3><p>总结市场空白、软柿子、共性卖点和高频差评。</p></div></div>
      ${field('整章结论','competitor_summary',state.data.document.competitor_summary,{type:'textarea',full:true})}
    </div>`;
  $$('[data-site]',$('#competitorsContent')).forEach((button)=>button.addEventListener('click',()=>{state.siteCode=button.dataset.site;renderCompetitors()}));
  $$('[data-kind]',$('#competitorsContent')).forEach((button)=>button.addEventListener('click',()=>{state.competitorKind=button.dataset.kind;renderCompetitors()}));
  bindDocumentFields($('#competitorsContent'));
}

function competitorTable(rows,site){
  if(!rows.length)return '<div class="empty">当前站点暂无竞品，请打开竞品工具导入数据。</div>';
  const body=rows.map((item)=>{
    const revenue=item.selection_revenue||{
      monthly_sales:Number(item.monthly_sales)||0,
      revenue:item.country_code==='AU'?Number(item.monthly_revenue_local)||0:Number(item.monthly_revenue_usd)||0,
      currency:item.country_code==='AU'?'AUD':'USD',
      symbol:item.country_code==='AU'?'A$':'$'
    };
    return `<tr>
      <td>${item.image_url?`<img src="${escapeHtml(item.image_url)}" alt="">`:'—'}</td>
      <td>${item.product_url?`<a href="${escapeHtml(item.product_url)}" target="_blank" rel="noopener">${escapeHtml(item.asin||item.name||'打开商品')}</a>`:escapeHtml(item.name||'—')}</td>
      <td>${item.is_fba==null?'—':Number(item.is_fba)?'是':'否'}</td>
      <td>${escapeHtml(item.symbol||site.currency)}${number(item.sale_price)}</td>
      <td>${number(revenue.monthly_sales,0)}</td>
      <td>${escapeHtml(revenue.symbol)}${number(revenue.revenue)} <small>${revenue.currency}</small></td>
      <td>${item.profit_rate==null?'—':`${number(item.profit_rate,1)}%`}</td>
      <td>${escapeHtml(item.listing_date||'—')}</td>
      <td>${item.rating==null?'—':number(item.rating,1)} / ${number(item.review_count,0)}</td>
      <td>${escapeHtml(textList(item.selling_points)||'—')}</td>
      <td>${escapeHtml(textList(item.review_pros)||'—')}</td>
      <td>${escapeHtml(textList(item.review_cons)||'—')}</td>
    </tr>`;
  }).join('');
  return `<table class="data-table"><thead><tr><th>图片</th><th>商品</th><th>FBA</th><th>售价</th><th>月销量</th><th>月销售额</th><th>利润率</th><th>上架时间</th><th>评分 / 评价</th><th>卖点</th><th>评论优点</th><th>评论缺点</th></tr></thead><tbody>${body}</tbody></table>`;
}

function countryOptions(selected=''){
  return `<option value="">选择站点</option>${state.data.sites.map((site)=>`<option value="${site.country_code}" ${site.country_code===selected?'selected':''}>${site.flag} ${escapeHtml(site.country_name)}</option>`).join('')}`;
}

function renderSuppliers(){
  $('#suppliersContent').innerHTML=`
    <div class="panel">
      <div class="panel-title"><div><h3>添加候选供应商</h3><p>图片使用 HTTP/HTTPS 链接；保存后立即计算目标站点利润。</p></div></div>
      <form class="supplier-create" id="supplierCreateForm">
        <input name="name" placeholder="供应商 / 产品名称">
        <input class="wide" name="product_url" type="url" placeholder="1688 / Alibaba 商品链接">
        <input name="image_url" type="url" placeholder="图片链接">
        <input name="cost_cny" type="number" min="0" step=".01" placeholder="成本 ¥">
        <input name="moq" type="number" min="0" step="1" placeholder="MOQ">
        <select name="target_country_code">${countryOptions()}</select>
        <input name="target_sale_price" type="number" min="0" step=".01" placeholder="目标售价">
        <input class="wide" name="specifications" placeholder="规格与核心优势">
        <input name="certifications" placeholder="厂家认证">
        <input name="pre_sample_score" type="number" min="0" max="100" placeholder="拿样前评分">
        <button class="primary-button" type="submit">添加候选</button>
      </form>
    </div>
    <div class="supplier-grid">${state.data.suppliers.length?state.data.suppliers.map(supplierCard).join(''):'<div class="panel empty">还没有供应商候选</div>'}</div>
    <div class="panel">
      <div class="panel-title"><div><h3>供应商结论</h3><p>说明首选、备选和淘汰理由。</p></div></div>
      ${field('整章结论','supplier_summary',state.data.document.supplier_summary,{type:'textarea',full:true})}
    </div>`;
  $('#supplierCreateForm').addEventListener('submit',createSupplier);
  $$('.supplier-form',$('#suppliersContent')).forEach(bindSupplierForm);
  bindDocumentFields($('#suppliersContent'));
}

function supplierCard(supplier){
  const calculation=supplier.calculation;
  return `<article class="panel supplier-card" data-supplier="${supplier.id}">
    ${supplier.image_url?`<img class="supplier-preview" src="${escapeHtml(supplier.image_url)}" alt="">`:'<div class="supplier-preview"></div>'}
    <form class="supplier-form" data-supplier-form="${supplier.id}">
      <label>名称<input name="name" value="${escapeHtml(supplier.name)}"></label>
      <label class="wide">商品链接<input name="product_url" type="url" value="${escapeHtml(supplier.product_url)}"></label>
      <label>图片链接<input name="image_url" type="url" value="${escapeHtml(supplier.image_url)}"></label>
      <label>成本 ¥<input name="cost_cny" type="number" min="0" step=".01" value="${supplier.cost_cny}"></label>
      <label>MOQ<input name="moq" type="number" min="0" step="1" value="${supplier.moq}"></label>
      <label>目标站点<select name="target_country_code">${countryOptions(supplier.target_country_code)}</select></label>
      <label>目标售价<input name="target_sale_price" type="number" min="0" step=".01" value="${supplier.target_sale_price}"></label>
      <label class="wide">规格与优势<textarea name="specifications">${escapeHtml(supplier.specifications)}</textarea></label>
      <label>厂家认证<input name="certifications" value="${escapeHtml(supplier.certifications)}"></label>
      <label>拿样理由<input name="sample_reason" value="${escapeHtml(supplier.sample_reason)}"></label>
      <label>拿样前评分<input name="pre_sample_score" type="number" min="0" max="100" value="${supplier.pre_sample_score??''}"></label>
      <label>拿样后评分<input name="post_sample_score" type="number" min="0" max="100" value="${supplier.post_sample_score??''}"></label>
      <label class="wide">优点<textarea name="pros">${escapeHtml(supplier.pros)}</textarea></label>
      <label class="wide">缺点<textarea name="cons">${escapeHtml(supplier.cons)}</textarea></label>
      <div class="supplier-metrics">
        <span>利润率 <b>${calculation?`${number(calculation.profit_rate,1)}%`:'—'}</b></span>
        <span>单件利润 <b>${calculation?`${escapeHtml(calculation.symbol)}${number(calculation.profit)}`:'—'}</b></span>
        <span>ROI <b>${calculation?`${number(calculation.roi,1)}%`:'—'}</b></span>
      </div>
      <div class="supplier-actions"><button class="danger-button" type="button" data-delete-supplier="${supplier.id}">删除供应商</button></div>
    </form>
  </article>`;
}

async function createSupplier(event){
  event.preventDefault();
  const form=event.currentTarget;
  const body=Object.fromEntries(new FormData(form));
  const operation=(async()=>{
    const supplier=await api(`/api/projects/${state.projectId}/selection-document/suppliers`,{
      method:'POST',body:JSON.stringify(body)
    });
    state.data.suppliers.push(supplier);
    renderSuppliers();
    updateSummary();
    setSaveState('已保存');
    toast('供应商已添加');
    return supplier;
  })();
  try{
    setSaveState('保存中…');
    await state.lifecycleOperations.track(operation);
  }catch(error){setSaveState('保存失败',true,()=>createSupplier(event));toast(error.message)}
}

function bindSupplierForm(form){
  form.addEventListener('input',(event)=>{
    const supplier=state.data.suppliers.find((item)=>item.id===Number(form.dataset.supplierForm));
    supplier[event.target.name]=event.target.type==='number'?(event.target.value===''?null:Number(event.target.value)):event.target.value;
    updateSummary();
    scheduleSupplierSave(supplier);
  });
  $('[data-delete-supplier]',form).addEventListener('click',async(event)=>{
    if(!confirm('删除这个供应商候选？'))return;
    const id=Number(event.currentTarget.dataset.deleteSupplier);
    const queue=state.supplierSaveQueues.get(id);
    const operation=deleteEntityAfterSave({
      queue,
      requestDelete:()=>api(`/api/selection-suppliers/${id}`,{method:'DELETE'}),
      unregister:()=>{
        if(state.supplierSaveQueues.get(id)===queue)state.supplierSaveQueues.delete(id);
      },
      onDeleted:()=>{
        state.data.suppliers=state.data.suppliers.filter((item)=>item.id!==id);
        renderSuppliers();updateSummary();toast('供应商已删除');
      }
    });
    try{
      await state.lifecycleOperations.track(operation);
    }catch(error){toast(error.message)}
  });
}

function renderRisks(){
  const site=state.data.sites.find((item)=>item.country_code===state.siteCode)||state.data.sites[0];
  state.siteCode=site.country_code;
  const checklist=Array.isArray(state.data.document.checklist)?state.data.document.checklist:[];
  $('#risksContent').innerHTML=`
    <div class="panel">
      <div class="site-selector">${siteButtons()}</div>
      <div class="risk-grid" data-risk-form>
        ${field('认证要求','certification_required',site.certification_required,{type:'textarea'})}
        ${field('实际需要','certification_actual',site.certification_actual,{type:'textarea'})}
        ${field('厂家已有认证','supplier_certifications',site.supplier_certifications,{type:'textarea'})}
        ${field('缺少认证','certification_gap',site.certification_gap,{type:'textarea'})}
        ${field('补齐费用 ¥','certification_gap_cost',site.certification_gap_cost,{type:'number',min:0,step:.01})}
        ${field('费用回本周期','payback_period',site.payback_period)}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title"><div><h3>专利风险</h3><p>记录外观、发明专利查询结论和规避方案。</p></div></div>
      ${field('专利风险笔记','patent_notes',state.data.document.patent_notes,{type:'textarea',full:true})}
    </div>
    <div class="panel">
      <div class="panel-title"><div><h3>最终自查</h3><p>全部确认后再将状态改为“通过”。</p></div></div>
      <div class="checklist">${checklist.map((item,index)=>`<label class="check-item"><input type="checkbox" data-check="${index}" ${item.checked?'checked':''}><span>${escapeHtml(item.label)}</span><button class="icon-button danger-button" type="button" data-delete-check="${index}">删除</button></label>`).join('')}
        <button class="secondary-button" type="button" id="addChecklistItem">＋ 添加自定义检查项</button>
      </div>
    </div>`;
  $$('[data-site]',$('#risksContent')).forEach((button)=>button.addEventListener('click',()=>{state.siteCode=button.dataset.site;renderRisks()}));
  $$('[name]',$('[data-risk-form]')).forEach((input)=>input.addEventListener('input',()=>{
    site[input.name]=input.type==='number'?Number(input.value)||0:input.value;
    scheduleSiteSave(site);
  }));
  bindDocumentFields($('#risksContent'));
  $$('[data-check]',$('#risksContent')).forEach((input)=>input.addEventListener('change',()=>{
    state.data.document.checklist[Number(input.dataset.check)].checked=input.checked;
    updateSummary();scheduleDocumentSave();
  }));
  $$('[data-delete-check]',$('#risksContent')).forEach((button)=>button.addEventListener('click',()=>{
    if(!confirm('删除这个检查项？'))return;
    state.data.document.checklist.splice(Number(button.dataset.deleteCheck),1);
    renderRisks();updateSummary();scheduleDocumentSave();
  }));
  $('#addChecklistItem').addEventListener('click',()=>{
    const label=prompt('请输入检查项');
    if(!label?.trim())return;
    state.data.document.checklist.push({id:`custom-${Date.now()}`,label:label.trim(),checked:false});
    renderRisks();updateSummary();scheduleDocumentSave();
  });
}

function activateChapter(chapter){
  state.chapter=chapter;
  $$('[data-chapter]').forEach((button)=>button.classList.toggle('active',button.dataset.chapter===chapter));
  $$('[data-chapter-panel]').forEach((panel)=>panel.classList.toggle('active',panel.dataset.chapterPanel===chapter));
  if(chapter==='overview')renderOverview();
  if(chapter==='sites')renderSites();
  if(chapter==='competitors')renderCompetitors();
  if(chapter==='suppliers')renderSuppliers();
  if(chapter==='risks')renderRisks();
  window.dispatchEvent(new CustomEvent('selection-chapter-changed',{detail:{chapter}}));
  scrollTo({top:0,behavior:'smooth'});
}

async function load(){
  if(!Number.isInteger(state.projectId)||state.projectId<=0)throw new Error('链接中缺少有效的品类 ID');
  const nextData=await loadDataAfterStableSaves({
    flush:flushPendingSaves,
    fetchData:()=>api(`/api/projects/${state.projectId}/selection-document`),
    readRevision:()=>state.workRevision,
    hasWork:hasActiveSaveWork,
    maxRefetches:2
  });
  state.data=nextData;
  closeAndRemoveIdleQueues(state.siteSaveQueues);
  closeAndRemoveIdleQueues(state.supplierSaveQueues);
  state.siteCode=state.data.sites.find((item)=>item.country_code==='US')?.country_code||state.data.sites[0]?.country_code;
  $('#projectTitle').textContent=state.data.project.name||'未命名品类';
  document.title=`${state.data.project.name} · 选品文档`;
  renderOverview();
  updateSummary();
  setSaveState('已保存');
  window.SelectionDocumentApp={
    getSnapshot:()=>({projectId:state.projectId,chapter:state.chapter,data:state.data}),
    flushPendingSaves,
    withExclusiveReload,
    reload:()=>withExclusiveReload(async()=>{
      await flushPendingSaves();
      await load();
      activateChapter(state.chapter);
    })
  };
  window.dispatchEvent(new CustomEvent('selection-document-ready'));
}

function bootSelectionDocument(){
  $$('[data-chapter]').forEach((button)=>button.addEventListener('click',()=>activateChapter(button.dataset.chapter)));
  $('#retrySave').addEventListener('click',async()=>{
    if(!state.lastRetry)return;
    try{setSaveState('保存中…');await state.lastRetry();setSaveState('已保存')}catch(error){setSaveState('保存失败',true,state.lastRetry);toast(error.message)}
  });
  load().catch((error)=>{
    setSaveState('载入失败',true,()=>load());
    $('.chapter-content').innerHTML=`<div class="panel empty">${escapeHtml(error.message)}</div>`;
  });
}

if(typeof module!=='undefined'&&module.exports)module.exports={
  createDocumentSaveQueue,
  createEntitySaveQueue,
  createLatestSnapshotSaveQueue,
  createAsyncOperationRegistry,
  createExclusiveActionLock,
  deleteEntityAfterSave,
  loadDataAfterStableSaves,
  flushSaveQueues
};
if(root?.document)bootSelectionDocument();
})(typeof window!=='undefined'?window:globalThis);
