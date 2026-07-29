'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('../server');
const db=require('../lib/db');
const {createSelectionAiRepository}=require('../lib/selection-ai/repository');
const {createSelectionAiService}=require('../lib/selection-ai/service');

function serviceError(code,message=code) {
  const error=new Error(message);
  error.code=code;
  return error;
}

function createFakeService() {
  const calls=[];
  const state={
    conversation:{project_id:7,active_provider:'codex'},
    messages:[{id:1,role:'user',content:'history'}],
    proposals:[{id:11,status:'pending',changes:[]}]
  };
  const service={
    calls,
    disposed:false,
    completedSignal:null,
    async getState(projectId) {
      calls.push(['getState',projectId]);
      if (projectId===404) throw serviceError('PROJECT_NOT_FOUND','project missing');
      if (projectId===500) throw serviceError('23503','postgres detail: secret-row-value');
      return state;
    },
    async health(projectId,options) {
      calls.push(['health',projectId,options]);
      return {provider:'codex',ok:true,status:'ready'};
    },
    async setProvider(projectId,provider) {
      calls.push(['setProvider',projectId,provider]);
      return {...state.conversation,active_provider:provider};
    },
    async *streamTurn(input) {
      calls.push(['streamTurn',input]);
      if (input.message==='active') throw serviceError('TURN_ALREADY_ACTIVE','turn active');
      yield {type:'status',status:'started',turnId:'turn-1'};
      await new Promise((resolve)=>setImmediate(resolve));
      service.completedSignal=input.signal;
      if (input.signal.aborted) throw serviceError('TURN_INTERRUPTED','turn interrupted');
      yield {type:'text_delta',delta:'analysis',turnId:'turn-1'};
      yield {type:'proposal',proposal:{id:11,changes:[]},turnId:'turn-1'};
      yield {type:'completed',result:{answer:'analysis'},turnId:'turn-1'};
    },
    async interrupt(projectId,turnId) {
      calls.push(['interrupt',projectId,turnId]);
      return {status:'interrupted'};
    },
    async applyProposal(input) {
      calls.push(['applyProposal',input]);
      if (input.proposalId===99) throw serviceError('PROPOSAL_CONFLICT','proposal conflict');
      return {id:input.proposalId,status:'applied',applied_changes:input.changeIndexes};
    },
    async rejectProposal(projectId,proposalId) {
      calls.push(['rejectProposal',projectId,proposalId]);
      return {id:proposalId,status:'rejected'};
    },
    async clear(projectId) {
      calls.push(['clear',projectId]);
    },
    dispose() { service.disposed=true; }
  };
  return service;
}

async function withServer(service,run) {
  const server=createServer({selectionAiService:service});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try { await run(base); }
  finally { await new Promise((resolve)=>server.close(resolve)); }
}

async function requestJson(url,options) {
  const response=await fetch(url,options);
  return {response,body:await response.json()};
}

test('selection AI API exposes state, health, provider, SSE, interrupt, proposals and clear',async()=>{
  const service=createFakeService();
  await withServer(service,async(base)=>{
    const state=await requestJson(`${base}/api/projects/7/selection-ai`);
    assert.equal(state.response.status,200);
    assert.deepEqual(state.body.conversation,{project_id:7,active_provider:'codex'});
    assert.equal(state.body.messages.length,1);
    assert.equal(state.body.proposals.length,1);

    const health=await requestJson(`${base}/api/projects/7/selection-ai/health`);
    assert.equal(health.response.status,200);
    assert.deepEqual(Object.keys(health.body.providers).sort(),['codex','openai']);
    assert.deepEqual(health.body.providers.codex,{ok:true,status:'ready'});
    assert.deepEqual(health.body.providers.openai,{status:'inactive'});
    assert.deepEqual(health.body.codex,health.body.providers.codex);
    assert.deepEqual(health.body.openai,health.body.providers.openai);
    assert.equal(service.calls.some(([name])=>name==='streamTurn'),false);

    const codexOnlyHealth=await requestJson(`${base}/api/projects/7/selection-ai/health?provider=codex`);
    assert.equal(codexOnlyHealth.response.status,200);
    assert.deepEqual(
      service.calls.filter(([name])=>name==='health').at(-1),
      ['health',7,{providers:['codex']}]
    );

    const provider=await requestJson(`${base}/api/projects/7/selection-ai/provider`,{
      method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'openai'})
    });
    assert.equal(provider.response.status,200);
    assert.equal(provider.body.active_provider,'openai');

    const turnResponse=await fetch(`${base}/api/projects/7/selection-ai/turns`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chapter:'overview',message:'analyze current category'})
    });
    assert.equal(turnResponse.status,200);
    assert.equal(turnResponse.headers.get('content-type'),'text/event-stream; charset=utf-8');
    assert.equal(turnResponse.headers.get('cache-control'),'no-cache, no-transform');
    assert.equal(turnResponse.headers.get('x-accel-buffering'),'no');
    const turnBody=await turnResponse.text();
    for (const type of ['status','text_delta','proposal','completed']) {
      assert.match(turnBody,new RegExp(`event: ${type}\\ndata: `));
    }
    assert.equal(service.completedSignal.aborted,false);

    const interrupted=await requestJson(`${base}/api/projects/7/selection-ai/turns/turn-1/interrupt`,{method:'POST'});
    assert.equal(interrupted.response.status,200);
    assert.deepEqual(interrupted.body,{status:'interrupted'});

    const applied=await requestJson(`${base}/api/projects/7/selection-ai/proposals/11/apply`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({change_indexes:[0,2]})
    });
    assert.equal(applied.response.status,200);
    assert.deepEqual(service.calls.find(([name])=>name==='applyProposal')[1],{
      projectId:7,proposalId:11,changeIndexes:[0,2]
    });

    const rejected=await requestJson(`${base}/api/projects/7/selection-ai/proposals/11/reject`,{method:'POST'});
    assert.equal(rejected.response.status,200);
    assert.equal(rejected.body.status,'rejected');

    const cleared=await requestJson(`${base}/api/projects/7/selection-ai/messages`,{
      method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:true})
    });
    assert.equal(cleared.response.status,200);
    assert.deepEqual(cleared.body,{ok:true});
  });
  assert.equal(service.disposed,false);
});

test('selection AI API maps missing, conflict and validation failures before response headers',async()=>{
  const service=createFakeService();
  await withServer(service,async(base)=>{
    const missing=await requestJson(`${base}/api/projects/404/selection-ai`);
    assert.equal(missing.response.status,404);
    assert.equal(missing.body.code,'PROJECT_NOT_FOUND');

    const missingClear=await requestJson(`${base}/api/projects/404/selection-ai/messages`,{
      method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:true})
    });
    assert.equal(missingClear.response.status,404);
    assert.equal(missingClear.body.code,'PROJECT_NOT_FOUND');

    const active=await requestJson(`${base}/api/projects/7/selection-ai/turns`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chapter:'overview',message:'active'})
    });
    assert.equal(active.response.status,409);
    assert.equal(active.body.code,'TURN_ALREADY_ACTIVE');

    const conflict=await requestJson(`${base}/api/projects/7/selection-ai/proposals/99/apply`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({change_indexes:[0]})
    });
    assert.equal(conflict.response.status,409);
    assert.equal(conflict.body.code,'PROPOSAL_CONFLICT');

    for (const [path,options] of [
      ['/provider',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'auto'})}],
      ['/turns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chapter:'missing',message:'hello'})}],
      ['/turns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chapter:'overview',message:' '})}],
      ['/turns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chapter:'overview',message:'x'.repeat(10001)})}],
      ['/proposals/11/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({change_indexes:[0,'1']})}],
      ['/messages',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:false})}]
    ]) {
      const invalid=await requestJson(`${base}/api/projects/7/selection-ai${path}`,options);
      assert.equal(invalid.response.status,400,path);
      assert.equal(invalid.body.code,'VALIDATION_ERROR',path);
    }

    const unknown=await requestJson(`${base}/api/projects/7/selection-ai/not-found`);
    assert.equal(unknown.response.status,404);
  });
});

test('selection AI streaming failures after headers are returned as SSE errors',async()=>{
  const service=createFakeService();
  service.streamTurn=async function* streamTurn() {
    yield {type:'status',status:'started',turnId:'turn-error'};
    throw serviceError('CODEX_TURN_FAILED','safe provider failure');
  };
  await withServer(service,async(base)=>{
    const response=await fetch(`${base}/api/projects/7/selection-ai/turns`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chapter:'overview',message:'fail after start'})
    });
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');
    const body=await response.text();
    assert.match(body,/event: status\ndata: /);
    assert.match(body,/event: error\ndata: \{"code":"CODEX_TURN_FAILED","error":"Codex turn failed"\}/);
    assert.doesNotMatch(body,/safe provider failure/);
  });
});

test('selection AI API sanitizes database, network and forged stable-code diagnostics',async()=>{
  const service=createFakeService();
  await withServer(service,async(base)=>{
    const database=await requestJson(`${base}/api/projects/500/selection-ai`);
    assert.equal(database.response.status,500);
    assert.deepEqual(database.body,{code:'INTERNAL_ERROR',error:'Internal server error'});
    assert.doesNotMatch(JSON.stringify(database.body),/secret-row-value|23503/);

    service.streamTurn=async function* streamTurn() {
      yield {type:'status',status:'started',turnId:'turn-network'};
      throw serviceError('ECONNRESET','network secret: api-key-value');
    };
    const response=await fetch(`${base}/api/projects/7/selection-ai/turns`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chapter:'overview',message:'network fail'})
    });
    const body=await response.text();
    assert.match(body,/event: error\ndata: \{"code":"INTERNAL_ERROR","error":"Internal server error"\}/);
    assert.doesNotMatch(body,/ECONNRESET|api-key-value/);

    service.streamTurn=async function* streamTurn() {
      yield {type:'status',status:'started',turnId:'turn-forged'};
      throw serviceError('CODEX_TURN_FAILED','forged provider diagnostic');
    };
    const forged=await fetch(`${base}/api/projects/7/selection-ai/turns`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chapter:'overview',message:'known error'})
    });
    const forgedBody=await forged.text();
    assert.match(forgedBody,/"code":"CODEX_TURN_FAILED","error":"Codex turn failed"/);
    assert.doesNotMatch(forgedBody,/forged provider diagnostic/);
  });
});

test('selection AI API sanitizes synchronous owned service factory failures',async()=>{
  const server=createServer({selectionAiServiceFactory:()=>{
    throw Object.assign(new Error('factory-secret-value'),{code:'23503',statusCode:418});
  }});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const response=await fetch(`${base}/api/projects/7/selection-ai`);
    assert.equal(response.status,500);
    const body=await response.json();
    assert.deepEqual(body,{code:'INTERNAL_ERROR',error:'Internal server error'});
    assert.doesNotMatch(JSON.stringify(body),/factory-secret-value|23503|418/);
  } finally {
    await server.shutdown();
  }
});

test('selection AI interrupt rejects malformed percent encoding as validation error',async()=>{
  const service=createFakeService();
  await withServer(service,async(base)=>{
    const invalid=await requestJson(`${base}/api/projects/7/selection-ai/turns/%E0/interrupt`,{method:'POST'});
    assert.equal(invalid.response.status,400);
    assert.deepEqual(invalid.body,{code:'VALIDATION_ERROR',error:'Invalid request'});
    assert.equal(service.calls.some(([name])=>name==='interrupt'),false);
  });
});

function realServiceForApi() {
  const provider=()=>({
    healthCalls:0,turnCalls:0,
    async health() { this.healthCalls+=1;return {ok:true}; },
    async *streamTurn() { this.turnCalls+=1;yield {type:'completed',result:{answer:'',proposal:null}}; },
    async interruptTurn() { return {status:'interrupted'}; },
    dispose() {}
  });
  const codex=provider();
  const openai=provider();
  return {
    codex,openai,
    service:createSelectionAiService({
      db,
      repository:createSelectionAiRepository(db),
      providers:{codex,openai},
      loadPayload:async()=>null
    })
  };
}

test('real repository, service and HTTP chain returns PROJECT_NOT_FOUND for every project route',async(t)=>{
  const projectId=2_000_000_000;
  const real=realServiceForApi();
  const server=createServer({selectionAiService:real.service});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/projects/${projectId}/selection-ai`;
  t.after(async()=>{
    real.service.dispose();
    if (server.listening) await new Promise((resolve)=>server.close(resolve));
    await db.close();
  });

  const requests=[
    fetch(base),
    fetch(`${base}/health`),
    fetch(`${base}/provider`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'openai'})}),
    fetch(`${base}/turns`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chapter:'overview',message:'missing'})}),
    fetch(`${base}/turns/missing-turn/interrupt`,{method:'POST'}),
    fetch(`${base}/proposals/1/apply`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({change_indexes:[0]})}),
    fetch(`${base}/proposals/1/reject`,{method:'POST'}),
    fetch(`${base}/messages`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:true})})
  ];
  for (const response of await Promise.all(requests)) {
    assert.equal(response.status,404);
    assert.deepEqual(await response.json(),{code:'PROJECT_NOT_FOUND',error:'Project does not exist'});
  }
  assert.equal(real.codex.healthCalls,0);
  assert.equal(real.codex.turnCalls,0);
  assert.equal(real.openai.healthCalls,0);
  assert.equal(real.openai.turnCalls,0);
});

test('owned shutdown disposes the default service before waiting for active SSE and installs no signal handlers',async(t)=>{
  const service=createFakeService();
  const order=[];
  let failTurn;
  service.streamTurn=async function* streamTurn() {
    yield {type:'status',status:'started',turnId:'turn-shutdown'};
    await new Promise((_,reject)=>{ failTurn=reject; });
  };
  service.dispose=()=>{
    if (service.disposed) return;
    order.push('dispose');
    service.disposed=true;
    failTurn(serviceError('SERVICE_DISPOSED','owned internal detail'));
  };
  const before={sigint:process.listenerCount('SIGINT'),sigterm:process.listenerCount('SIGTERM')};
  const server=createServer({selectionAiServiceFactory:()=>service});
  t.after(async()=>{
    service.dispose();
    if (server.listening) await new Promise((resolve)=>server.close(resolve));
  });
  assert.deepEqual({sigint:process.listenerCount('SIGINT'),sigterm:process.listenerCount('SIGTERM')},before);
  server.on('close',()=>order.push('close'));
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(`${base}/api/projects/7/selection-ai/turns`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chapter:'overview',message:'wait for shutdown'})
  });

  await server.shutdown();
  const body=await response.text();
  assert.deepEqual(order,['dispose','close']);
  assert.equal(server.listening,false);
  assert.match(body,/event: error/);
  assert.match(body,/"code":"SERVICE_DISPOSED"/);
});
