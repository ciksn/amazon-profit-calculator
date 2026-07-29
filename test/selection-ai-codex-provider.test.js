'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {createCodexProvider}=require('../lib/selection-ai/providers/codex');

function createFakeJsonlProcess(responses=[],options={}) {
  const child=new EventEmitter();
  const stdout=new PassThrough();
  const stderr=new PassThrough();
  const writes=[];
  const queued=[...responses];
  let killed=false;

  child.stdout=stdout;
  child.stderr=stderr;
  child.stdin={
    write(chunk) {
      const request=JSON.parse(String(chunk).trim());
      writes.push(request);
      if (request.id!==undefined) {
        const index=queued.findIndex((message)=>message.id===request.id);
        if (index>=0) {
          const [response]=queued.splice(index,1);
          queueMicrotask(()=>stdout.write(`${JSON.stringify(response)}\n`));
          if (request.method==='turn/start') {
            setImmediate(()=>{
              while (queued.length && queued[0].method) {
                stdout.write(`${JSON.stringify(queued.shift())}\n`);
              }
            });
          }
        }
      }
      return true;
    },
    end() {}
  };
  child.kill=()=>{ killed=true; };
  child.sent=()=>writes;
  child.wasKilled=()=>killed;
  child.emitJson=(message)=>stdout.write(`${JSON.stringify(message)}\n`);

  if (options.error) queueMicrotask(()=>child.emit('error',options.error));
  if (options.exit) queueMicrotask(()=>child.emit('exit',options.exit.code??1,options.exit.signal??null));
  return child;
}

async function collect(iterable) {
  const events=[];
  for await (const event of iterable) events.push(event);
  return events;
}

test('Codex Provider completes the handshake, resumes a thread, and starts a read-only turn',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'turn_1',status:'inProgress'}}},
    {method:'item/agentMessage/delta',params:{threadId:'thr_1',turnId:'turn_1',delta:'{"answer":"可以"'}},
    {method:'item/agentMessage/delta',params:{threadId:'thr_1',turnId:'turn_1',delta:',"proposal":{"summary":"","changes":[]}}'}},
    {method:'turn/completed',params:{thread:{id:'thr_1'},turn:{id:'turn_1',status:'completed'}}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,command:'codex',timeoutMs:1000});

  const events=await collect(provider.streamTurn({state:{codex_thread_id:'thr_1'},system:'规则',input:'数据'}));

  assert.equal(events.filter((event)=>event.type==='text_delta').map((event)=>event.delta).join(''),'可以');
  assert.deepEqual(events.at(-1),{
    type:'completed',
    result:{answer:'可以',proposal:{summary:'',changes:[]}},
    providerState:{codex_thread_id:'thr_1'}
  });
  const sent=fake.sent();
  assert.equal(sent[0].method,'initialize');
  assert.equal(sent[1].method,'initialized');
  assert.equal(sent[2].method,'thread/resume');
  assert.equal(sent[3].method,'turn/start');
  assert.equal(sent[3].params.approvalPolicy,'never');
  assert.equal(sent[3].params.sandboxPolicy.type,'readOnly');
  assert.equal(sent[3].params.sandboxPolicy.networkAccess,false);
  assert.equal(sent[3].params.model,undefined);
  assert.deepEqual(sent[3].params.input,[{type:'text',text:'规则\n\n数据'}]);
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

test('Codex Provider sends turn/interrupt for the active turn',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'turn_1',status:'inProgress'}}},
    {id:4,result:{}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:1000});
  const iterator=provider.streamTurn({state:{codex_thread_id:'thr_1'},system:'s',input:'i'})[Symbol.asyncIterator]();
  const next=iterator.next();

  while (!fake.sent().some((message)=>message.method==='turn/start')) await new Promise((resolve)=>setImmediate(resolve));
  await provider.interruptTurn('turn_1');
  fake.emitJson({method:'turn/completed',params:{thread:{id:'thr_1'},turn:{id:'turn_1',status:'interrupted'}}});

  await assert.rejects(next,(error)=>error.code==='CODEX_TURN_INTERRUPTED');
  const request=fake.sent().find((message)=>message.method==='turn/interrupt');
  assert.deepEqual(request.params,{threadId:'thr_1',turnId:'turn_1'});
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
    spawnProcess:()=>createFakeJsonlProcess([],{exit:{code:1}}),
    timeoutMs:1000
  });

  await assert.rejects(provider.health(),(failure)=>failure.code==='CODEX_START_FAILED');
  provider.dispose();
});

test('Codex Provider reports a failed turn with CODEX_TURN_FAILED',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'turn_1',status:'inProgress'}}},
    {method:'turn/completed',params:{thread:{id:'thr_1'},turn:{id:'turn_1',status:'failed'},error:{message:'internal'}}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:1000});

  await assert.rejects(collect(provider.streamTurn({state:{codex_thread_id:'thr_1'},system:'s',input:'i'})),
    (error)=>error.code==='CODEX_TURN_FAILED');
  provider.dispose();
});

test('Codex Provider gives malformed structured output a stable turn error code',async()=>{
  const fake=createFakeJsonlProcess([
    {id:1,result:{platformFamily:'windows'}},
    {id:2,result:{thread:{id:'thr_1'}}},
    {id:3,result:{turn:{id:'turn_1',status:'inProgress'}}},
    {method:'item/agentMessage/delta',params:{threadId:'thr_1',turnId:'turn_1',delta:'{"answer":"broken'}},
    {method:'turn/completed',params:{thread:{id:'thr_1'},turn:{id:'turn_1',status:'completed'}}}
  ]);
  const provider=createCodexProvider({spawnProcess:()=>fake,timeoutMs:1000});

  await assert.rejects(collect(provider.streamTurn({state:{codex_thread_id:'thr_1'},system:'s',input:'i'})),
    (error)=>error.code==='CODEX_TURN_FAILED');
  provider.dispose();
});
