'use strict';

require('./styles.css');
const { BlockitClient }=require('@lark-opdev/block-docs-addon-api');
const { normalizeContext,bindingMatches,createBinding }=require('./binding');

const EMBED_URL=process.env.MARGINGO_EMBED_URL;
const RECORD_KEY='marginGoBinding';
const client=new BlockitClient();
const docs=client.initAPI();
let bootPromise=null;

function status(message,error=false){
  const el=document.querySelector('#statusText');if(!el)return;el.textContent=message;el.classList.toggle('error',error);
}

async function createWorkspace(){
  const endpoint=new URL('/api/embed/instances',EMBED_URL);
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||!payload.access_key)throw new Error(payload.error||'无法创建测算实例');
  return payload.access_key;
}

async function saveBinding(record,binding){
  const type=Object.prototype.hasOwnProperty.call(record,RECORD_KEY)?'replace':'insert';
  await docs.Record.setRecord([{type,data:{path:[RECORD_KEY],value:binding}}]);
}

function renderCalculator(workspaceKey){
  const src=new URL(EMBED_URL);src.searchParams.set('widget','1');src.hash=new URLSearchParams({key:workspaceKey}).toString();
  const frame=document.createElement('iframe');frame.className='calculator-frame';frame.title='MarginGo 亚马逊利润计算器';frame.src=src.href;
  frame.allow='clipboard-read; clipboard-write';frame.setAttribute('allowfullscreen','');
  document.querySelector('#app').replaceChildren(frame);
}

async function boot(){
  if(bootPromise)return bootPromise;
  bootPromise=(async()=>{
    status('正在识别当前文档实例…');
    const [blockRef,record]=await Promise.all([docs.getActiveBlockRef(),docs.Record.getRecord()]);
    const context=normalizeContext(blockRef);let binding=record?.[RECORD_KEY];
    if(!bindingMatches(binding,context)){
      status('正在为本文档创建独立测算…');
      binding=createBinding(await createWorkspace(),context);await saveBinding(record||{},binding);
    }
    renderCalculator(binding.workspaceKey);await docs.Bridge.updateHeight(900);
  })().catch((error)=>{console.error(error);status(`初始化失败：${error.message}`,true);throw error});
  return bootPromise;
}

docs.Record.onRecordChange((record)=>{
  const binding=record?.[RECORD_KEY];if(binding?.workspaceKey){bootPromise=null;boot().catch(()=>{})}
}).catch(()=>{});

docs.LifeCycle.notifyAppReady().then(boot).catch((error)=>{console.error(error);status(`小组件启动失败：${error.message}`,true)});
