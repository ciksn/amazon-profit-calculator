'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');

const helpers=import('../scripts/smoke_selection_ai_lib.mjs');

test('smoke project names include a cryptographic UUID',async()=>{
  const {createSmokeProjectName}=await helpers;
  const name=createSmokeProjectName({now:()=>123,randomUUID:()=>'2b286a92-b945-4d61-a0b8-043b826c931f'});
  assert.equal(name,'AI 冒烟测试 123 2b286a92-b945-4d61-a0b8-043b826c931f');
});

test('Codex smoke health requires a well-formed ready result',async()=>{
  const {validateCodexHealth}=await helpers;
  assert.deepEqual(
    validateCodexHealth({providers:{codex:{ok:true,status:'ready'}}}),
    {ok:true,status:'ready'}
  );

  for (const malformed of [
    null,
    [],
    {},
    {providers:[]},
    {providers:{}},
    {providers:{codex:[]}},
    {providers:{codex:{ok:true}}},
    {providers:{codex:{ok:'yes',status:'ready'}}},
    {providers:{codex:{ok:false,status:'ready'}}},
    {providers:{codex:{ok:false,status:'not_installed'}}},
    {providers:{codex:{ok:false,status:'unavailable'}}},
    {providers:{codex:{ok:true,status:'surprising'}}}
  ]) {
    assert.throws(()=>validateCodexHealth(malformed));
  }
});

test('response-loss cleanup finds projects by exact unique name and deletes every matching ID',async()=>{
  const {cleanupTemporaryProjects}=await helpers;
  const projectName='AI 冒烟测试 123 unique-id';
  const existing=new Set([41,42]);
  const calls=[];
  const db={
    async many(sql,params) {
      calls.push({kind:'many',sql,params});
      assert.equal(params[0],projectName);
      return [...existing].map((id)=>({id}));
    },
    async one(sql,params) {
      calls.push({kind:'one',sql,params});
      return {count:existing.has(params[0])?1:0};
    },
    async query(sql,params) {
      calls.push({kind:'query',sql,params});
      existing.delete(params[0]);
    }
  };
  const deletedByHttp=[];
  const fetchImpl=async(url)=>{
    deletedByHttp.push(url);
    throw new Error('creation response was lost and HTTP cleanup is unavailable');
  };

  const result=await cleanupTemporaryProjects({
    db,
    baseUrl:'http://127.0.0.1:4173',
    projectId:null,
    projectName,
    fetchImpl
  });

  assert.deepEqual(result,{confirmed:true,projectIds:[41,42]});
  assert.deepEqual(deletedByHttp,[
    'http://127.0.0.1:4173/api/projects/41',
    'http://127.0.0.1:4173/api/projects/42'
  ]);
  assert.equal(existing.size,0);
  assert.ok(calls.some(({sql})=>/WHERE name=\$1/.test(sql)));
  assert.ok(calls.every(({sql})=>!/(?:LIKE|ILIKE)/i.test(sql)));
});

test('cleanup attempts every resource and preserves the primary failure',async()=>{
  const {runAllCleanupSteps}=await helpers;
  const primaryError=new Error('turn failed first');
  const frozenCleanupError=Object.freeze(new Error('dispose failed'));
  const attempted=[];
  const finalError=await runAllCleanupSteps({
    primaryError,
    steps:[
      ['project',async()=>{attempted.push('project');throw new Error('project cleanup failed');}],
      ['service.dispose',()=>{attempted.push('service.dispose');throw frozenCleanupError;}],
      ['server.shutdown',async()=>{attempted.push('server.shutdown');throw new Error('shutdown failed');}],
      ['db.close',async()=>{attempted.push('db.close');throw new Error('close failed');}]
    ]
  });

  assert.deepEqual(attempted,['project','service.dispose','server.shutdown','db.close']);
  assert.ok(finalError instanceof AggregateError);
  assert.equal(finalError.errors[0],primaryError);
  assert.equal(finalError.cause,primaryError);
  assert.match(finalError.message,/turn failed first/);
});

test('cleanup returns the primary failure unchanged when cleanup succeeds',async()=>{
  const {runAllCleanupSteps}=await helpers;
  const primaryError=new Error('primary');
  const finalError=await runAllCleanupSteps({primaryError,steps:[['ok',async()=>{}]]});
  assert.equal(finalError,primaryError);
});
