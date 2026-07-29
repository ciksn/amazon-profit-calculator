'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');
const ui=require('../public/selection-ai.js');

function memoryStorage() {
  const values=new Map();
  return {
    getItem:(key)=>values.has(key)?values.get(key):null,
    setItem:(key,value)=>values.set(key,String(value))
  };
}

test('选品页包含语义化 AI 工作台、手动 Provider 切换和提案操作',()=>{
  const html=read('public/selection-document.html');
  const script=read('public/selection-ai.js');
  for (const id of [
    'selectionAiPanel','aiProvider','aiProviderStatus','aiMessages','aiComposer',
    'aiSend','aiStop','aiErrorActions','aiDrawerToggle'
  ]) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/<aside[^>]+id="selectionAiPanel"[^>]+aria-labelledby="selectionAiTitle"/);
  assert.match(html,/<h2[^>]+id="selectionAiTitle"/);
  assert.match(html,/selection-ai\.css\?v=20260729-1/);
  assert.match(html,/selection-document\.js\?v=20260729-1[\s\S]*selection-ai\.js\?v=20260729-1/);
  assert.match(script,/分析当前章节/);
  assert.match(script,/切换到 OpenAI API/);
  assert.match(script,/change_indexes/);
  assert.match(script,/PROPOSAL_CONFLICT/);
  assert.doesNotMatch(script,/autoFallback|fallbackToOpenAI/);
});

test('SSE parser 跨任意字节 chunk 解码中文并保留完整事件边界',()=>{
  const events=[];
  const parser=ui.createSseParser((type,payload)=>events.push([type,payload]));
  const bytes=new TextEncoder().encode(
    'event: status\r\ndata: {"status":"started","turnId":"turn-1"}\r\n\r\n'+
    'event: text_delta\ndata: {"delta":"分析当前章节"}\n\n'+
    'event: completed\ndata: {"result":{"answer":"完成"}}\n\n'
  );
  for (let index=0;index<bytes.length;) {
    const width=(index%7)+1;
    parser.push(bytes.slice(index,index+width));
    index+=width;
  }
  parser.finish();
  assert.deepEqual(events,[
    ['status',{status:'started',turnId:'turn-1'}],
    ['text_delta',{delta:'分析当前章节'}],
    ['completed',{result:{answer:'完成'}}]
  ]);
});

test('显示缓存按 project 隔离，损坏缓存安全回退为空状态',()=>{
  const storage=memoryStorage();
  ui.writeProjectCache(storage,7,{messages:[{content:'品类 7'}],proposals:[]});
  ui.writeProjectCache(storage,8,{messages:[{content:'品类 8'}],proposals:[{id:2}]});
  assert.equal(ui.readProjectCache(storage,7).messages[0].content,'品类 7');
  assert.equal(ui.readProjectCache(storage,8).messages[0].content,'品类 8');
  storage.setItem(ui.CACHE_KEY,'{broken');
  assert.deepEqual(ui.readProjectCache(storage,7),{messages:[],proposals:[]});
});

test('停止生成先等待 interrupt，再 abort 浏览器流',async()=>{
  const order=[];
  await ui.interruptBeforeAbort(
    async()=>{order.push('interrupt:start');await Promise.resolve();order.push('interrupt:end')},
    ()=>order.push('abort')
  );
  assert.deepEqual(order,['interrupt:start','interrupt:end','abort']);

  const failed=[];
  await assert.rejects(
    ui.interruptBeforeAbort(async()=>{failed.push('interrupt');throw new Error('offline')},()=>failed.push('abort')),
    /offline/
  );
  assert.deepEqual(failed,['interrupt','abort']);

  const hung=[];
  const hungOutcome=await Promise.race([
    ui.interruptBeforeAbort(()=>new Promise(()=>{}),()=>hung.push('abort'),{timeoutMs:5})
      .then(()=>({type:'resolved'}),(error)=>({type:'rejected',message:error.message})),
    new Promise((resolve)=>setTimeout(()=>resolve({type:'still-pending'}),30))
  ]);
  assert.equal(hungOutcome.type,'rejected');
  assert.match(hungOutcome.message,/超时/);
  assert.deepEqual(hung,['abort']);
});

test('Provider 只有用户显式操作才允许写入，失败且无输出时恢复原输入',async()=>{
  const requests=[];
  await assert.rejects(
    ui.requestProviderSwitch({provider:'openai',userInitiated:false,request:async(value)=>requests.push(value)}),
    /用户操作/
  );
  assert.deepEqual(requests,[]);
  await ui.requestProviderSwitch({provider:'openai',userInitiated:true,request:async(value)=>requests.push(value)});
  assert.deepEqual(requests,['openai']);
  assert.equal(ui.composerValueAfterFailure('请分析风险',''),'请分析风险');
  assert.equal(ui.composerValueAfterFailure('请分析风险','已有输出'),'');
});

test('桌面三栏、窄屏抽屉、手机全宽并保留业务表格横滚',()=>{
  const aiCss=read('public/selection-ai.css');
  const documentCss=read('public/selection-document.css');
  assert.match(aiCss,/grid-template-columns:\s*210px minmax\(0,1fr\) 360px/);
  assert.match(aiCss,/@media\s*\(max-width:1100px\)/);
  assert.match(aiCss,/@media\s*\(max-width:560px\)[\s\S]*width:\s*100%/);
  assert.match(aiCss,/\.ai-history\{[^}]*flex-direction:column/);
  assert.match(documentCss,/\.table-wrap\{[^}]*overflow:auto/);
});

class FakeClassList {
  constructor(){this.values=new Set()}
  contains(value){return this.values.has(value)}
  toggle(value,force){
    const enabled=force===undefined?!this.values.has(value):force;
    if(enabled)this.values.add(value);else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(document){
    this.ownerDocument=document;this.listeners=new Map();this.attributes=new Map();
    this.classList=new FakeClassList();this.dataset={};this.children=[];this.value='';
    this.hidden=false;this.disabled=false;this.inert=false;this.textContent='';this._innerHTML='';
    this.scrollTop=0;this.scrollHeight=10;
  }
  addEventListener(type,listener){
    const listeners=this.listeners.get(type)||[];listeners.push(listener);this.listeners.set(type,listeners);
  }
  async emit(type,event={}){
    const payload={target:this,currentTarget:this,preventDefault(){},...event};
    for(const listener of this.listeners.get(type)||[])await listener(payload);
  }
  setAttribute(name,value){this.attributes.set(name,String(value))}
  removeAttribute(name){this.attributes.delete(name)}
  getAttribute(name){return this.attributes.get(name)??null}
  focus(){this.ownerDocument.activeElement=this}
  append(child){this.children.push(child)}
  set innerHTML(value){
    this._innerHTML=String(value);
    if(this._innerHTML.includes('ai-message-content')){
      this.messageContent=new FakeElement(this.ownerDocument);
    }
  }
  get innerHTML(){return this._innerHTML}
  querySelector(selector){return selector==='.ai-message-content'?this.messageContent:null}
  querySelectorAll(){return []}
}

function panelHarness({turn='complete',proposal=null}={}){
  const document={activeElement:null,elements:{},querySelector(selector){return this.elements[selector]||null}};
  for(const id of [
    'selectionAiPanel','aiProvider','aiProviderStatus','aiMessages','aiProposals','aiComposer',
    'aiSend','aiStop','aiErrorActions','aiQuickPrompts','aiClearHistory','aiDrawerToggle','aiDrawerClose'
  ])document.elements[`#${id}`]=new FakeElement(document);
  document.createElement=()=>new FakeElement(document);
  document.createTextNode=(data)=>({data});
  const listeners=new Map();
  const mediaListeners=[];
  const storage=memoryStorage();
  const requests=[];
  const order=[];
  const statePayload=()=>({
    conversation:{active_provider:'codex'},
    messages:turn==='complete'&&requests.some((item)=>item.path.endsWith('/turns'))
      ? [{id:1,role:'assistant',provider:'codex',content:'分析完成',status:'completed'}]:[],
    proposals:proposal?[proposal]:[]
  });
  const jsonResponse=(body,{ok=true,status=200}={})=>({ok,status,json:async()=>body});
  const root={
    document,localStorage:storage,AbortController,TextEncoder,TextDecoder,
    alert(){},confirm:()=>true,
    addEventListener(type,listener){const values=listeners.get(type)||[];values.push(listener);listeners.set(type,values)},
    matchMedia:()=>({matches:true,addEventListener(type,listener){if(type==='change')mediaListeners.push(listener)}}),
    async fetch(url,options={}){
      const path=new URL(url,'http://local').pathname;
      requests.push({path,options});
      if(path.endsWith('/health'))return jsonResponse({providers:{codex:{ok:true,status:'ready'}}});
      if(path.endsWith('/interrupt')){
        order.push('interrupt');
        return jsonResponse({status:'interrupted'});
      }
      if(path.endsWith('/apply'))return jsonResponse({code:'PROPOSAL_CONFLICT',error:'conflict'},{ok:false,status:409});
      if(path.endsWith('/turns')){
        const encoder=new TextEncoder();
        let reads=0;
        return {ok:true,body:{getReader:()=>({read(){
          reads+=1;
          if(reads===1)return Promise.resolve({done:false,value:encoder.encode('event: status\ndata: {"status":"started","turnId":"turn-1"}\n\n')});
          if(turn==='complete'&&reads===2)return Promise.resolve({done:false,value:encoder.encode('event: text_delta\ndata: {"delta":"分析')});
          if(turn==='complete'&&reads===3)return Promise.resolve({done:false,value:encoder.encode('完成"}\n\nevent: completed\ndata: {"result":{"answer":"分析完成"}}\n\n')});
          if(turn==='complete')return Promise.resolve({done:true});
          return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{
            order.push('abort');const error=new Error('aborted');error.name='AbortError';reject(error);
          },{once:true}));
        }})}};
      }
      return jsonResponse(statePayload());
    }
  };
  const app={reloads:0,getSnapshot:()=>({projectId:7,chapter:'risks',data:{}}),async reload(){this.reloads+=1}};
  return {root,document,elements:document.elements,requests,order,app,listeners};
}

test('轻量 DOM/fetch/SSE 集成：发送使用当前章节并跨 chunk 渲染完成消息',async()=>{
  const harness=panelHarness();
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  harness.elements['#aiComposer'].value='检查数字字段边界';
  await harness.elements['#aiSend'].emit('click');
  const turn=harness.requests.find((item)=>item.path.endsWith('/turns'));
  assert.deepEqual(JSON.parse(turn.options.body),{chapter:'risks',message:'检查数字字段边界'});
  assert.match(harness.elements['#aiMessages'].innerHTML,/分析完成/);
  assert.equal(harness.elements['#aiSend'].disabled,false);
});

test('轻量 DOM/fetch/SSE 集成：停止调用 interrupt 后 abort 并恢复控件',async()=>{
  const harness=panelHarness({turn:'pending'});
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  harness.elements['#aiComposer'].value='持续分析';
  const sending=harness.elements['#aiSend'].emit('click');
  for(let index=0;index<20&&harness.elements['#aiStop'].disabled;index++)await Promise.resolve();
  await harness.elements['#aiStop'].emit('click');
  await sending;
  assert.deepEqual(harness.order,['interrupt','abort']);
  assert.equal(harness.elements['#aiSend'].disabled,false);
});

test('轻量 DOM 集成：冲突禁用 apply/reject、刷新后同步并保持冲突标记',async()=>{
  const proposal={id:11,status:'pending',summary:'文本提案',changes:[{scope:'document',field:'positioning',before:'旧',after:'新',reason:'清晰'}]};
  const harness=panelHarness({proposal});
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  const card={dataset:{proposalId:'11'},querySelectorAll:()=>[{dataset:{changeIndex:'0'}}]};
  const applyTarget={closest(selector){if(selector==='[data-proposal-id]')return card;if(selector==='[data-apply-proposal]')return {};return null}};
  await harness.elements['#aiProposals'].emit('click',{target:applyTarget});
  assert.doesNotMatch(harness.elements['#aiProposals'].innerHTML,/data-apply-proposal|data-reject-proposal/);
  assert.match(harness.elements['#aiProposals'].innerHTML,/data-refresh-document/);
  const refreshTarget={closest(selector){if(selector==='[data-proposal-id]')return card;if(selector==='[data-refresh-document]')return {};return null}};
  await harness.elements['#aiProposals'].emit('click',{target:refreshTarget});
  assert.equal(harness.app.reloads,1);
  assert.equal(harness.requests.filter((item)=>item.path.endsWith('/selection-ai')).length>=2,true);
  assert.match(harness.elements['#aiProposals'].innerHTML,/版本冲突/);
});

test('轻量 DOM 集成：窄屏关闭时 inert/aria-hidden，打开移入焦点，Esc 关闭并归还焦点',async()=>{
  const harness=panelHarness();
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  const panelElement=harness.elements['#selectionAiPanel'];
  assert.equal(panelElement.inert,true);
  assert.equal(panelElement.getAttribute('aria-hidden'),'true');
  await harness.elements['#aiDrawerToggle'].emit('click');
  assert.equal(panelElement.inert,false);
  assert.equal(panelElement.getAttribute('aria-hidden'),null);
  assert.equal(harness.document.activeElement,harness.elements['#aiProvider']);
  for(const listener of harness.listeners.get('keydown')||[])listener({key:'Escape'});
  assert.equal(panelElement.inert,true);
  assert.equal(harness.document.activeElement,harness.elements['#aiDrawerToggle']);
});
