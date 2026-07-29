'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {createCodexProvider}=require('../lib/selection-ai/providers/codex');
const {OUTPUT_SCHEMA}=require('../lib/selection-ai/contracts');

function createFakeJsonlProcess(responses=[],options={}) {
  const child=new EventEmitter();
  const stdout=new PassThrough();
  const stderr=new PassThrough();
  const stdin=new EventEmitter();
  const writes=[];
  const queued=[...responses];
  let killed=false;

  stdin.write=(chunk)=>{
    if (options.writeError) throw options.writeError;
    const request=JSON.parse(String(chunk).trim());
    writes.push(request);
    if (request.id!==undefined) {
      const index=queued.findIndex((message)=>message.id===request.id);
      if (index>=0) {
        const [response]=queued.splice(index,1);
        queueMicrotask(()=>stdout.write(`${JSON.stringify(response)}\n`));
        if (request.method==='turn/start') {
          setImmediate(()=>{
            while (queued.length&&queued[0].method) {
              stdout.write(`${JSON.stringify(queued.shift())}\n`);
            }
          });
        }
      }
    }
    return true;
  };
  stdin.end=()=>{};
  child.stdout=stdout;
  child.stderr=stderr;
  child.stdin=stdin;
  child.kill=()=>{ killed=true; };
  child.sent=()=>writes;
  child.wasKilled=()=>killed;
  child.emitJson=(message)=>stdout.write(`${JSON.stringify(message)}\n`);
  child.emitStdinError=(error)=>stdin.emit('error',error);

  if (options.error) queueMicrotask(()=>child.emit('error',options.error));
  if (options.exit) queueMicrotask(()=>child.emit('exit',options.exit.code??1,options.exit.signal??null));
  return child;
}

async function collect(iterable) {
  const events=[];
  for await (const event of iterable) events.push(event);
  return events;
}

function within(promise,ms=100) {
  return Promise.race([
    promise,
    new Promise((resolve,reject)=>setTimeout(()=>reject(Object.assign(new Error('test wait expired'),{code:'TEST_TIMEOUT'})),ms))
  ]);
}

test('Codex Provider uses the exact secure app-server protocol contract',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'server_turn_1',status:'inProgress'}}},
    {method:'item/agentMessage/delta',params:{threadId:'thr_1',turnId:'server_turn_1',delta:'{"answer":"yes"'}},
    {method:'item/agentMessage/delta',params:{threadId:'thr_1',turnId:'server_turn_1',delta:',"proposal":{"summary":"","changes":[]}}'}},
    {method:'turn/completed',params:{thread:{id:'thr_1'},turn:{id:'server_turn_1',status:'completed'}}}
  ]);
  let spawnCall;
  const provider=createCodexProvider({
    spawnProcess:(...args)=>{ spawnCall=args; return fake; },command:'codex',timeoutMs:1000
  });

  const events=await collect(provider.streamTurn({
    state:{codex_thread_id:'thr_1'},system:'rules',input:'data',turnId:'public_1'
  }));

  assert.equal(events.filter((event)=>event.type==='text_delta').map((event)=>event.delta).join(''),'yes');
  assert.deepEqual(events.at(-1),{
    type:'completed',result:{answer:'yes',proposal:{summary:'',changes:[]}},
    providerState:{codex_thread_id:'thr_1'}
  });
  const sent=fake.sent();
  assert.equal(sent[0].method,'initialize');
  assert.equal(sent[1].method,'initialized');
  assert.equal(sent[2].method,'thread/resume');
  assert.equal(sent[3].method,'turn/start');
  assert.equal(sent[3].params.approvalPolicy,'never');
  assert.deepEqual(sent[3].params.sandboxPolicy,{
    type:'readOnly',
    access:{type:'restricted',includePlatformDefaults:true,readableRoots:[]},
    networkAccess:false
  });
  assert.deepEqual(sent[3].params.outputSchema,OUTPUT_SCHEMA);
  assert.equal(sent[3].params.summary,'concise');
  assert.equal(Object.hasOwn(sent[3].params,'model'),false);
  assert.deepEqual(sent[3].params.input,[{type:'text',text:'rules\n\ndata'}]);
  assert.deepEqual(spawnCall,[
    'codex',['app-server','--listen','stdio://'],
    {stdio:['pipe','pipe','pipe'],windowsHide:true}
  ]);
  provider.dispose();
  assert.equal(fake.wasKilled(),true);
});

test('Codex Provider starts a new thread when no saved thread exists',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_new'}}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:1000});

  assert.deepEqual(await provider.startOrResumeConversation({}),{codex_thread_id:'thr_new'});
  assert.equal(fake.sent()[2].method,'thread/start');
  provider.dispose();
});

test('Codex Provider correlates an immediate public turn interrupt to the server turn',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'server_turn_1',status:'inProgress'}}},
    {id:4,result:{}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:1000});
  const running=collect(provider.streamTurn({
    state:{codex_thread_id:'thr_1'},system:'s',input:'i',turnId:'public_1'
  }));
  const interrupted=provider.interruptTurn('public_1');

  assert.deepEqual(await interrupted,{status:'interrupted'});
  fake.emitJson({
    method:'turn/completed',
    params:{thread:{id:'thr_1'},turn:{id:'server_turn_1',status:'interrupted'}}
  });
  await assert.rejects(running,(error)=>error.code==='CODEX_TURN_INTERRUPTED');
  const request=fake.sent().find((message)=>message.method==='turn/interrupt');
  assert.deepEqual(request.params,{threadId:'thr_1',turnId:'server_turn_1'});
  provider.dispose();
});

test('Codex Provider reports a missing executable with CODEX_NOT_INSTALLED',async()=>{
  const error=Object.assign(new Error('spawn codex ENOENT'),{code:'ENOENT'});
  const provider=createCodexProvider({spawnProcess:()=>createFakeJsonlProcess([],{error}),timeoutMs:1000});

  await assert.rejects(provider.health(),(failure)=>failure.code==='CODEX_NOT_INSTALLED');
  provider.dispose();
});

test('Codex Provider reports initialization timeout with CODEX_TIMEOUT',async()=>{
  const provider=createCodexProvider({spawnProcess:()=>createFakeJsonlProcess([]),timeoutMs:10});

  await assert.rejects(provider.health(),(failure)=>failure.code==='CODEX_TIMEOUT');
  provider.dispose();
});

test('Codex Provider reports an early process exit with CODEX_START_FAILED',async()=>{
  const provider=createCodexProvider({
    spawnProcess:()=>createFakeJsonlProcess([],{exit:{code:1}}),timeoutMs:1000
  });

  await assert.rejects(provider.health(),(failure)=>failure.code==='CODEX_START_FAILED');
  provider.dispose();
});

test('Codex Provider reports failed and malformed turns with CODEX_TURN_FAILED',async(t)=>{
  const cases=[
    {name:'failed terminal status',notifications:[
      {method:'turn/completed',params:{thread:{id:'thr_1'},turn:{id:'server_turn_1',status:'failed'}}}
    ]},
    {name:'malformed structured output',notifications:[
      {method:'item/agentMessage/delta',params:{threadId:'thr_1',turnId:'server_turn_1',delta:'{"answer":"broken'}},
      {method:'turn/completed',params:{thread:{id:'thr_1'},turn:{id:'server_turn_1',status:'completed'}}}
    ]}
  ];
  for (const [index,item] of cases.entries()) {
    await t.test(item.name,async()=>{
      const fake=createFakeJsonlProcess([
        {id:1,result:{platformFamily:'windows'}},
        {id:2,result:{thread:{id:'thr_1'}}},
        {id:3,result:{turn:{id:'server_turn_1',status:'inProgress'}}},
        ...item.notifications
      ]);
      const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:1000});
      await assert.rejects(collect(provider.streamTurn({
        state:{codex_thread_id:'thr_1'},system:'s',input:'i',turnId:`public_${index}`
      })),(error)=>error.code==='CODEX_TURN_FAILED');
      provider.dispose();
    });
  }
});

test('Codex Provider requires a caller-supplied public turn ID',async()=>{
  let spawned=false;
  const provider=createCodexProvider({spawnProcess:()=>{ spawned=true; return createFakeJsonlProcess([]); }});

  await assert.rejects(collect(provider.streamTurn({state:{},system:'s',input:'i'})),
    (error)=>error.code==='CODEX_TURN_FAILED');
  assert.equal(spawned,false);
  provider.dispose();
});

test('Codex Provider sanitizes synchronous stdin write failures and resets transport',async()=>{
  const secret='secret-sync-write';
  const first=createFakeJsonlProcess([],{writeError:Object.assign(new Error(secret),{code:'EPIPE'})});
  const second=createFakeJsonlProcess([{id:2,result:{platformFamily:'windows'}}]);
  const processes=[first,second];
  let spawns=0;
  const provider=createCodexProvider({spawnProcess:()=>processes[spawns++],timeoutMs:1000});

  await assert.rejects(provider.health(),(error)=>{
    assert.equal(error.code,'CODEX_START_FAILED');
    assert.equal(error.message.includes(secret),false);
    return true;
  });
  assert.equal(first.wasKilled(),true);
  assert.deepEqual(await provider.health(),{ok:true});
  assert.equal(spawns,2);
  provider.dispose();
});

test('Codex Provider sanitizes asynchronous stdin failures for active subscribers',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'server_turn_1',status:'inProgress'}}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:1000});
  const running=collect(provider.streamTurn({
    state:{codex_thread_id:'thr_1'},system:'s',input:'i',turnId:'public_1'
  }));

  while (!fake.sent().some((message)=>message.method==='turn/start')) await new Promise((resolve)=>setImmediate(resolve));
  fake.emitStdinError(Object.assign(new Error('secret async failure'),{code:'EPIPE'}));

  await assert.rejects(running,(error)=>{
    assert.equal(error.code,'CODEX_START_FAILED');
    assert.equal(error.message.includes('secret'),false);
    return true;
  });
  assert.equal(fake.wasKilled(),true);
  provider.dispose();
});

test('Codex Provider respawns after the initialized app server exits',async()=>{
  const first=createFakeJsonlProcess([{id:1,result:{platformFamily:'windows'}}]);
  const second=createFakeJsonlProcess([
    {id:2,result:{platformFamily:'windows'}},
    {id:3,result:{thread:{id:'thr_new'}}}
  ]);
  const processes=[first,second];
  let spawns=0;
  const provider=createCodexProvider({spawnProcess:()=>processes[spawns++],timeoutMs:1000});

  assert.deepEqual(await provider.health(),{ok:true});
  first.emit('exit',1,null);
  await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(await provider.health(),{ok:true});
  assert.deepEqual(await provider.startOrResumeConversation({}),{codex_thread_id:'thr_new'});
  assert.equal(spawns,2);
  provider.dispose();
});

test('Codex Provider times out while waiting for a terminal turn notification',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'server_turn_1',status:'inProgress'}}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:10});

  await assert.rejects(within(collect(provider.streamTurn({
    state:{codex_thread_id:'thr_1'},system:'s',input:'i',turnId:'public_1'
  })),100),(error)=>error.code==='CODEX_TIMEOUT');
  await assert.rejects(provider.interruptTurn('public_1'),(error)=>error.code==='CODEX_TURN_FAILED');
  provider.dispose();
});

test('Codex Provider aborts a turn wait and removes public turn bookkeeping',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'server_turn_1',status:'inProgress'}}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:30});
  const controller=new AbortController();
  const running=collect(provider.streamTurn({
    state:{codex_thread_id:'thr_1'},system:'s',input:'i',turnId:'public_1',signal:controller.signal
  }));

  while (!fake.sent().some((message)=>message.method==='turn/start')) await new Promise((resolve)=>setImmediate(resolve));
  controller.abort();

  await assert.rejects(within(running,100),(error)=>error.code==='CODEX_TURN_INTERRUPTED');
  await assert.rejects(provider.interruptTurn('public_1'),(error)=>error.code==='CODEX_TURN_FAILED');
  provider.dispose();
});

test('Codex Provider observes AbortSignal while conversation startup is pending',async()=>{
  const fake=createFakeJsonlProcess([]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:1000});
  const controller=new AbortController();
  const running=collect(provider.streamTurn({
    state:{},system:'s',input:'i',turnId:'public_startup',signal:controller.signal
  }));
  await new Promise((resolve)=>setImmediate(resolve));
  controller.abort();

  try {
    await assert.rejects(within(running,100),(error)=>error.code==='CODEX_TURN_INTERRUPTED');
  } finally {
    provider.dispose();
  }
});
