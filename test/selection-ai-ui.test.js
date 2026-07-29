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

function streamResponse(chunks,{ok=true,json={}}={}){
  let index=0;
  return {
    ok,status:ok?200:500,json:async()=>json,
    body:{getReader:()=>({async read(){
      if(index>=chunks.length)return {done:true};
      const value=typeof chunks[index]==='string'?new TextEncoder().encode(chunks[index]):chunks[index];
      index+=1;return {done:false,value};
    }})}
  };
}

test('SSE 只有 completed terminal 才成功，error 与无 terminal EOF 都失败',async()=>{
  const completed=[];
  const result=await ui.consumeSseResponse(streamResponse([
    'event: text_delta\ndata: {"delta":"完成"}\n\n',
    'event: completed\ndata: {"result":{"answer":"完成"},"turnId":"t1"}\n\n'
  ]),(type,payload)=>completed.push([type,payload]));
  assert.equal(result.completed,true);
  assert.deepEqual(completed.map(([type])=>type),['text_delta','completed']);

  await assert.rejects(
    ui.consumeSseResponse(streamResponse(['event: text_delta\ndata: {"delta":"半截"}\n\n']),()=>{}),
    /未完成|terminal/i
  );
  await assert.rejects(
    ui.consumeSseResponse(streamResponse(['event: error\ndata: {"code":"CODEX_TURN_FAILED","error":"failed"}\n\n']),()=>{}),
    (error)=>error.code==='CODEX_TURN_FAILED'
  );
});

test('显示缓存按 project 隔离，损坏缓存安全回退为空状态',()=>{
  const storage=memoryStorage();
  ui.writeProjectCache(storage,7,{messages:[{id:1,role:'user',provider:'codex',status:'completed',content:'品类 7'}],proposals:[]});
  ui.writeProjectCache(storage,8,{messages:[{id:2,role:'assistant',provider:'openai',status:'completed',content:'品类 8'}],proposals:[]});
  assert.equal(ui.readProjectCache(storage,7).messages[0].content,'品类 7');
  assert.equal(ui.readProjectCache(storage,8).messages[0].content,'品类 8');
  storage.setItem(ui.CACHE_KEY,'{broken');
  assert.deepEqual(ui.readProjectCache(storage,7),{messages:[],proposals:[]});
});

test('缓存深度规范化并丢弃 null、坏 shape 与属性注入 ID',()=>{
  const storage=memoryStorage();
  storage.setItem(ui.CACHE_KEY,JSON.stringify({'7':{
    messages:[
      null,{id:1,role:'user',provider:'codex',status:'completed',content:'安全'},
      {id:'1" onclick="alert(1)',role:'assistant',provider:'codex',status:'completed',content:'坏 ID'},
      {id:2,role:'system',provider:'codex',status:'completed',content:'坏角色'}
    ],
    proposals:[
      null,{id:11,status:'pending',changes:[{scope:'document',field:'positioning',before:'旧',after:'新',reason:'原因'}]},
      {id:'11" onclick="alert(1)',status:'pending',changes:[]},
      {id:12,status:'pending',changes:[null]}
    ]
  }}));
  const cached=ui.readProjectCache(storage,7);
  assert.deepEqual(cached.messages.map((item)=>item.id),[1]);
  assert.deepEqual(cached.proposals.map((item)=>item.id),[11]);
  assert.doesNotMatch(JSON.stringify(cached),/onclick|system/);
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
  assert.equal(ui.composerValueAfterFailure('请分析风险',{completed:false,generatedText:'半截'}),'请分析风险');
  assert.equal(ui.composerValueAfterFailure('请分析风险',{completed:true,generatedText:'完整'}),'');
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
  add(value){this.values.add(value)}
  remove(value){this.values.delete(value)}
}

class FakeElement {
  constructor(document){
    this.ownerDocument=document;this.listeners=new Map();this.attributes=new Map();
    this.classList=new FakeClassList();this.dataset={};this.children=[];this.value='';
    this.hidden=false;this.disabled=false;this.inert=false;this.textContent='';this._innerHTML='';
    this.checked=false;this.isConnected=true;this.scrollTop=0;this.scrollHeight=10;
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
  append(child){this.children.push(child);if(child?.data)this.textContent+=child.data}
  set innerHTML(value){
    this._innerHTML=String(value);
    if(this._innerHTML.includes('ai-message-content')){
      this.messageContent=new FakeElement(this.ownerDocument);
    }
  }
  get innerHTML(){return this._innerHTML}
  querySelector(selector){return selector==='.ai-message-content'?this.messageContent:null}
  querySelectorAll(selector){
    if(selector.includes('button')||selector.includes('select')||selector.includes('textarea'))return this.focusables||[];
    if(selector==='[data-change-index]:checked')return (this.checkboxes||[]).filter((item)=>item.checked);
    return [];
  }
}

function panelHarness({
  turn='complete',proposal=null,apply='conflict',narrow=true,confirmResponses=[true],
  interrupt='success',providerError=false,resolvedStatus='',delayStateAfterTurn=false
}={}){
  const document={activeElement:null,elements:{},querySelector(selector){return this.elements[selector]||null}};
  for(const id of [
    'selectionAiPanel','aiProvider','aiProviderStatus','aiMessages','aiProposals','aiComposer',
    'aiSend','aiStop','aiErrorActions','aiQuickPrompts','aiClearHistory','aiDrawerToggle','aiDrawerClose'
  ])document.elements[`#${id}`]=new FakeElement(document);
  for(const selector of ['.workspace','.topbar','.summary-strip','.chapter-nav','.chapter-content']){
    document.elements[selector]=new FakeElement(document);
  }
  document.createElement=()=>new FakeElement(document);
  document.createTextNode=(data)=>({data});
  const listeners=new Map();
  const media={matches:narrow,listeners:[],addEventListener(type,listener){if(type==='change')this.listeners.push(listener)},set(value){this.matches=value;for(const listener of this.listeners)listener({matches:value})}};
  const storage=memoryStorage();
  const requests=[];
  const order=[];
  const alerts=[];
  let confirmIndex=0;
  let notifyInterruptStarted;
  const interruptStarted=new Promise((resolve)=>{notifyInterruptStarted=resolve});
  let releaseState;
  const stateGate=new Promise((resolve)=>{releaseState=resolve});
  const statePayload=()=>({
    conversation:{active_provider:'codex'},
    messages:turn==='complete'&&requests.some((item)=>item.path.endsWith('/turns'))
      ? [{id:1,role:'assistant',provider:'codex',content:'分析完成',status:'completed'}]:[],
    proposals:proposal?(Array.isArray(proposal)?proposal:[proposal]).map((item)=>
      resolvedStatus&&requests.some((request)=>request.path.endsWith('/apply'))?{...item,status:resolvedStatus}:item
    ):[]
  });
  const jsonResponse=(body,{ok=true,status=200}={})=>({ok,status,json:async()=>body});
  const root={
    document,localStorage:storage,AbortController,TextEncoder,TextDecoder,
    alert(message){alerts.push(message)},confirm:()=>confirmResponses[Math.min(confirmIndex++,confirmResponses.length-1)],
    addEventListener(type,listener,options={}){const values=listeners.get(type)||[];values.push({listener,once:Boolean(options.once)});listeners.set(type,values)},
    async emit(type,event={}){const values=[...(listeners.get(type)||[])];for(const entry of values){await entry.listener(event);if(entry.once)listeners.set(type,(listeners.get(type)||[]).filter((item)=>item!==entry))}},
    matchMedia:()=>media,
    async fetch(url,options={}){
      const path=new URL(url,'http://local').pathname;
      requests.push({path,options});
      if(path.endsWith('/health'))return jsonResponse({providers:{codex:{ok:true,status:'ready'}}});
      if(path.endsWith('/provider'))return providerError
        ? jsonResponse({code:'TURN_ALREADY_ACTIVE',error:'busy'},{ok:false,status:409})
        : jsonResponse({active_provider:JSON.parse(options.body).provider});
      if(path.endsWith('/interrupt')){
        order.push('interrupt');
        notifyInterruptStarted();
        if(interrupt==='not-active')return jsonResponse({code:'TURN_NOT_ACTIVE',error:'not active'},{ok:false,status:409});
        if(interrupt==='delayed-not-active'){
          await new Promise((resolve)=>setTimeout(resolve,15));
          return jsonResponse({code:'TURN_NOT_ACTIVE',error:'not active'},{ok:false,status:409});
        }
        if(interrupt==='delayed-error'){
          await new Promise((resolve)=>setTimeout(resolve,15));
          return jsonResponse({code:'INTERRUPT_FAILED',error:'late interrupt failure'},{ok:false,status:500});
        }
        if(interrupt==='hang')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{order.push('interrupt-abort');const error=new Error('aborted');error.name='AbortError';reject(error)},{once:true}));
        return jsonResponse({status:'interrupted'});
      }
      if(path.endsWith('/apply'))return apply==='success'
        ? jsonResponse({id:11,status:'applied'})
        : jsonResponse({code:'PROPOSAL_CONFLICT',error:'conflict'},{ok:false,status:409});
      if(path.endsWith('/reject'))return jsonResponse({id:11,status:'rejected'});
      if(path.endsWith('/turns')){
        const encoder=new TextEncoder();
        let reads=0;
        return {ok:true,body:{getReader:()=>({read(){
          reads+=1;
          if(reads===1)return Promise.resolve({done:false,value:encoder.encode('event: status\ndata: {"status":"started","turnId":"turn-1"}\n\n')});
          if(turn==='complete'&&reads===2)return Promise.resolve({done:false,value:encoder.encode('event: text_delta\ndata: {"delta":"分析')});
          if(turn==='complete'&&reads===3)return Promise.resolve({done:false,value:encoder.encode('完成"}\n\nevent: completed\ndata: {"result":{"answer":"分析完成"}}\n\n')});
          if(turn==='complete')return Promise.resolve({done:true});
          if(turn==='completed-delay'&&reads===2)return Promise.resolve({done:false,value:encoder.encode('event: completed\ndata: {"result":{"answer":"完成"},"turnId":"turn-1"}\n\n')});
          if(turn==='completed-delay')return new Promise((resolve)=>setTimeout(()=>resolve({done:true}),30));
          if(turn==='complete-after-stop'&&reads===2)return interruptStarted.then(()=>({done:false,value:encoder.encode('event: completed\ndata: {"result":{"answer":"完成"},"turnId":"turn-1"}\n\n')}));
          if(turn==='complete-after-stop')return Promise.resolve({done:true});
          if(turn==='eof')return Promise.resolve({done:true});
          if(turn==='error'&&reads===2)return Promise.resolve({done:false,value:encoder.encode('event: error\ndata: {"code":"CODEX_TURN_FAILED","error":"failed"}\n\n')});
          if(turn==='error')return Promise.resolve({done:true});
          return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{
            order.push('abort');const error=new Error('aborted');error.name='AbortError';reject(error);
          },{once:true}));
        }})}};
      }
      if(delayStateAfterTurn&&requests.some((item)=>item.path.endsWith('/turns')))await stateGate;
      return jsonResponse(statePayload());
    }
  };
  const app={reloads:0,getSnapshot:()=>({projectId:7,chapter:'risks',data:{}}),async reload(){this.reloads+=1}};
  const panelElement=document.elements['#selectionAiPanel'];
  panelElement.focusables=[document.elements['#aiDrawerClose'],document.elements['#aiProvider'],document.elements['#aiComposer'],document.elements['#aiSend']];
  return {root,document,elements:document.elements,requests,order,app,listeners,media,alerts,releaseState};
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

test('panel 把 error 与无 completed EOF 视为失败并保留原输入',async()=>{
  for(const turn of ['eof','error']){
    const harness=panelHarness({turn});
    const panel=ui.createPanel(harness.root);
    await panel.init({app:harness.app,apiBase:''});
    harness.elements['#aiComposer'].value=`保留-${turn}`;
    await harness.elements['#aiSend'].emit('click');
    assert.equal(harness.elements['#aiComposer'].value,`保留-${turn}`);
    assert.match(harness.elements['#aiErrorActions'].innerHTML,/重试/);
  }
});

test('completed 到达即关闭 generating，随后 stop 不发 interrupt 或覆盖成功',async()=>{
  const harness=panelHarness({turn:'completed-delay',interrupt:'not-active'});
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  harness.elements['#aiComposer'].value='立即完成';
  const sending=harness.elements['#aiSend'].emit('click');
  for(let index=0;index<30&&!harness.elements['#aiStop'].hidden;index++)await Promise.resolve();
  assert.equal(harness.elements['#aiStop'].hidden,true);
  await harness.elements['#aiStop'].emit('click');
  await sending;
  assert.equal(harness.requests.some((item)=>item.path.endsWith('/interrupt')),false);
  assert.doesNotMatch(harness.elements['#aiErrorActions'].innerHTML,/TURN_NOT_ACTIVE|not active/);
});

test('completed 后忽略迟到的 interrupt error，不覆盖成功状态',async()=>{
  const harness=panelHarness({turn:'complete-after-stop',interrupt:'delayed-error'});
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  harness.elements['#aiComposer'].value='完成与停止竞态';
  const sending=harness.elements['#aiSend'].emit('click');
  for(let index=0;index<30&&harness.elements['#aiStop'].disabled;index++)await Promise.resolve();
  const stopping=harness.elements['#aiStop'].emit('click');
  await Promise.all([sending,stopping]);
  assert.equal(harness.elements['#aiProviderStatus'].dataset.state,'ready');
  assert.doesNotMatch(harness.elements['#aiErrorActions'].innerHTML,/late interrupt failure|操作失败/);
});

test('completed 后忽略迟到的 TURN_NOT_ACTIVE，不覆盖成功状态',async()=>{
  const harness=panelHarness({turn:'complete-after-stop',interrupt:'delayed-not-active'});
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  harness.elements['#aiComposer'].value='完成与停止竞态';
  const sending=harness.elements['#aiSend'].emit('click');
  for(let index=0;index<30&&harness.elements['#aiStop'].disabled;index++)await Promise.resolve();
  const stopping=harness.elements['#aiStop'].emit('click');
  await Promise.all([sending,stopping]);
  assert.equal(harness.elements['#aiProviderStatus'].dataset.state,'ready');
  assert.doesNotMatch(harness.elements['#aiErrorActions'].innerHTML,/not active|操作失败/);
});

test('completed 后服务端状态同步完成前继续锁定 send/provider',async()=>{
  const harness=panelHarness({turn:'complete',delayStateAfterTurn:true});
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  harness.elements['#aiComposer'].value='等待最终状态';
  const sending=harness.elements['#aiSend'].emit('click');
  for(let index=0;index<50&&!harness.elements['#aiStop'].hidden;index++)await Promise.resolve();
  assert.equal(harness.elements['#aiStop'].hidden,true);
  assert.equal(harness.elements['#aiSend'].disabled,true);
  assert.equal(harness.elements['#aiProvider'].disabled,true);
  harness.releaseState();
  await sending;
  assert.equal(harness.elements['#aiSend'].disabled,false);
  assert.equal(harness.elements['#aiProvider'].disabled,false);
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

test('interrupt 自带超时 AbortController，挂起请求取消后再 abort 主流',async()=>{
  const harness=panelHarness({turn:'pending',interrupt:'hang'});
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:'',interruptTimeoutMs:5});
  harness.elements['#aiComposer'].value='停止挂起';
  const sending=harness.elements['#aiSend'].emit('click');
  for(let index=0;index<30&&harness.elements['#aiStop'].disabled;index++)await Promise.resolve();
  await harness.elements['#aiStop'].emit('click');
  await sending;
  assert.deepEqual(harness.order,['interrupt','interrupt-abort','abort']);
});

test('Provider PUT 期间锁定 send/select，非生成操作错误不显示重试或切换动作',async()=>{
  const harness=panelHarness({providerError:true});
  let releaseProvider;
  const originalFetch=harness.root.fetch;
  harness.root.fetch=async(url,options)=>{
    if(new URL(url,'http://local').pathname.endsWith('/provider'))await new Promise((resolve)=>{releaseProvider=resolve});
    return originalFetch(url,options);
  };
  const panel=ui.createPanel(harness.root);await panel.init({app:harness.app,apiBase:''});
  harness.elements['#aiProvider'].value='openai';
  const switching=harness.elements['#aiProvider'].emit('change');
  for(let index=0;index<20&&!releaseProvider;index++)await Promise.resolve();
  assert.equal(harness.elements['#aiSend'].disabled,true);
  assert.equal(harness.elements['#aiProvider'].disabled,true);
  releaseProvider();await switching;
  assert.equal(harness.elements['#aiSend'].disabled,false);
  assert.doesNotMatch(harness.elements['#aiErrorActions'].innerHTML,/data-retry-message|data-switch-provider/);
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
  assert.doesNotMatch(harness.elements['#aiErrorActions'].innerHTML,/data-retry-message|data-switch-provider/);
  const refreshTarget={closest(selector){if(selector==='[data-proposal-id]')return card;if(selector==='[data-refresh-document]')return {};return null}};
  await harness.elements['#aiProposals'].emit('click',{target:refreshTarget});
  assert.equal(harness.app.reloads,1);
  assert.equal(harness.requests.filter((item)=>item.path.endsWith('/selection-ai')).length>=2,true);
  assert.match(harness.elements['#aiProposals'].innerHTML,/版本冲突/);
});

test('本地冲突只继承到服务端 pending，applied 终态清除冲突卡片',async()=>{
  const proposal={id:11,status:'pending',summary:'文本提案',changes:[{scope:'document',field:'positioning',before:'旧',after:'新',reason:'清晰'}]};
  const harness=panelHarness({proposal,resolvedStatus:'applied'});
  const panel=ui.createPanel(harness.root);
  await panel.init({app:harness.app,apiBase:''});
  const card={dataset:{proposalId:'11'},querySelectorAll:()=>[{dataset:{changeIndex:'0'}}]};
  await harness.elements['#aiProposals'].emit('click',{target:proposalTarget(card,'apply')});
  assert.match(harness.elements['#aiProposals'].innerHTML,/版本冲突/);
  const refreshTarget={closest(selector){if(selector==='[data-proposal-id]')return card;if(selector==='[data-refresh-document]')return {};return null}};
  await harness.elements['#aiProposals'].emit('click',{target:refreshTarget});
  assert.equal(harness.elements['#aiProposals'].hidden,true);
  assert.doesNotMatch(harness.elements['#aiProposals'].innerHTML,/版本冲突/);
});

function fakeProposalCard(document,checkedValues=[]){
  const card=new FakeElement(document);card.dataset.proposalId='11';
  card.checkboxes=checkedValues.map((checked,index)=>{const input=new FakeElement(document);input.checked=checked;input.dataset.changeIndex=String(index);return input});
  return card;
}

function proposalTarget(card,action){
  return {closest(selector){if(selector==='[data-proposal-id]')return card;if(selector===`[data-${action}-proposal]`)return {};return null}};
}

test('proposal 实际 checked/body：成功 apply、取消、零勾选与 reject',async()=>{
  const proposal={id:11,status:'pending',summary:'文本提案',changes:[
    {scope:'document',field:'positioning',before:'旧',after:'新',reason:'清晰'},
    {scope:'site',country_code:'US',field:'opportunity_notes',before:'旧',after:'新',reason:'明确'}
  ]};
  const success=panelHarness({proposal,apply:'success',confirmResponses:[true]});
  const successPanel=ui.createPanel(success.root);await successPanel.init({app:success.app,apiBase:''});
  const successCard=fakeProposalCard(success.document,[true,false]);
  await success.elements['#aiProposals'].emit('click',{target:proposalTarget(successCard,'apply')});
  const applyRequest=success.requests.find((item)=>item.path.endsWith('/apply'));
  assert.deepEqual(JSON.parse(applyRequest.options.body),{change_indexes:[0]});
  assert.equal(success.app.reloads,1);

  const cancelled=panelHarness({proposal,apply:'success',confirmResponses:[false]});
  const cancelledPanel=ui.createPanel(cancelled.root);await cancelledPanel.init({app:cancelled.app,apiBase:''});
  await cancelled.elements['#aiProposals'].emit('click',{target:proposalTarget(fakeProposalCard(cancelled.document,[true]),'apply')});
  assert.equal(cancelled.requests.some((item)=>item.path.endsWith('/apply')),false);

  const empty=panelHarness({proposal,apply:'success'});
  const emptyPanel=ui.createPanel(empty.root);await emptyPanel.init({app:empty.app,apiBase:''});
  await empty.elements['#aiProposals'].emit('click',{target:proposalTarget(fakeProposalCard(empty.document,[false,false]),'apply')});
  assert.equal(empty.requests.some((item)=>item.path.endsWith('/apply')),false);
  assert.match(empty.alerts[0],/至少选择/);

  const rejected=panelHarness({proposal,confirmResponses:[true]});
  const rejectedPanel=ui.createPanel(rejected.root);await rejectedPanel.init({app:rejected.app,apiBase:''});
  await rejected.elements['#aiProposals'].emit('click',{target:proposalTarget(fakeProposalCard(rejected.document,[true]),'reject')});
  assert.equal(rejected.requests.some((item)=>item.path.endsWith('/reject')),true);
});

test('正式 conflicted proposal 可见、禁 apply/reject，并拒绝服务端属性注入',async()=>{
  const conflicted={id:11,status:'conflicted',summary:'冲突',changes:[{scope:'document',field:'positioning',before:'旧',after:'新',reason:'原因'}]};
  const injected={...conflicted,id:'11" onclick="alert(1)',status:'pending'};
  const harness=panelHarness({proposal:[conflicted,injected]});
  const panel=ui.createPanel(harness.root);await panel.init({app:harness.app,apiBase:''});
  const html=harness.elements['#aiProposals'].innerHTML;
  assert.match(html,/版本冲突|conflicted/);
  assert.match(html,/data-refresh-document|data-regenerate-proposal/);
  assert.doesNotMatch(html,/data-apply-proposal|data-reject-proposal|onclick|alert/);
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
  await harness.root.emit('keydown',{key:'Escape'});
  assert.equal(panelElement.inert,true);
  assert.equal(harness.document.activeElement,harness.elements['#aiDrawerToggle']);
});

test('窄屏 drawer 动态 dialog、背景 inert、Tab trap；breakpoint 切换完整复位',async()=>{
  const harness=panelHarness({narrow:true});
  const panel=ui.createPanel(harness.root);await panel.init({app:harness.app,apiBase:''});
  const drawer=harness.elements['#selectionAiPanel'];
  const toggle=harness.elements['#aiDrawerToggle'];
  assert.equal(drawer.getAttribute('role'),'dialog');
  assert.equal(drawer.getAttribute('aria-modal'),'true');
  await toggle.emit('click');
  for(const selector of ['.topbar','.summary-strip','.chapter-nav','.chapter-content'])assert.equal(harness.elements[selector].inert,true);
  harness.document.activeElement=harness.elements['#aiSend'];
  let prevented=false;
  await harness.root.emit('keydown',{key:'Tab',shiftKey:false,preventDefault(){prevented=true}});
  assert.equal(prevented,true);
  assert.equal(harness.document.activeElement,harness.elements['#aiDrawerClose']);
  harness.media.set(false);
  assert.equal(drawer.getAttribute('role'),null);
  assert.equal(drawer.getAttribute('aria-modal'),null);
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(toggle.textContent,'收起 AI');
  assert.equal(harness.elements['.chapter-content'].inert,false);
  harness.media.set(true);
  assert.equal(toggle.getAttribute('aria-expanded'),'false');
  assert.equal(toggle.textContent,'AI 助手');
  assert.equal(harness.elements['.chapter-content'].inert,false);
});

test('桌面折叠释放第三列并可恢复，窄屏仍使用 drawer toggle',async()=>{
  const harness=panelHarness({narrow:false});
  const panel=ui.createPanel(harness.root);await panel.init({app:harness.app,apiBase:''});
  const workspace=harness.elements['.workspace'];
  const drawer=harness.elements['#selectionAiPanel'];
  const toggle=harness.elements['#aiDrawerToggle'];
  assert.equal(toggle.textContent,'收起 AI');
  await toggle.emit('click');
  assert.equal(workspace.classList.contains('ai-panel-collapsed'),true);
  assert.equal(drawer.hidden,true);
  assert.equal(toggle.getAttribute('aria-expanded'),'false');
  await toggle.emit('click');
  assert.equal(workspace.classList.contains('ai-panel-collapsed'),false);
  assert.equal(drawer.hidden,false);
});

test('boot 在已有 app 与 ready listener 两条路径中二选一且只 init 一次',async()=>{
  const existing=panelHarness();existing.root.SelectionDocumentApp=existing.app;
  let existingCalls=0;
  await ui.bootSelectionAiPanel(existing.root,{async init(){existingCalls+=1}});
  await existing.root.emit('selection-document-ready');
  assert.equal(existingCalls,1);
  assert.equal((existing.listeners.get('selection-document-ready')||[]).length,0);

  const delayed=panelHarness();let delayedCalls=0;
  ui.bootSelectionAiPanel(delayed.root,{async init(){delayedCalls+=1}});
  assert.equal((delayed.listeners.get('selection-document-ready')||[]).length,1);
  delayed.root.SelectionDocumentApp=delayed.app;
  await delayed.root.emit('selection-document-ready');
  await delayed.root.emit('selection-document-ready');
  assert.equal(delayedCalls,1);
});
