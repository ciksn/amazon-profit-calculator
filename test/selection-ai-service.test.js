'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../lib/db');
const {
  validateDifferentiationItems,
  validateChecklist
}=require('../lib/selection-document');
const {
  createSelectionAiService,
  createDefaultSelectionAiService
}=require('../lib/selection-ai/service');
const {createSelectionAiRepository}=require('../lib/selection-ai/repository');

async function createProject(name) {
  const now=new Date().toISOString();
  const project=await db.one(
    'INSERT INTO projects(name,created_at,updated_at) VALUES ($1,$2,$2) RETURNING *',
    [name,now]
  );
  await db.query(`INSERT INTO selection_documents
    (project_id,positioning,review_issues,checklist,version,updated_at)
    VALUES ($1,'old position',$2,$3,0,$4)`,[
    project.id,
    JSON.stringify([{issue:'old issue',ratio:37.5,solution:'old solution'}]),
    JSON.stringify([{id:'existing',label:'existing item',checked:true}]),
    now
  ]);
  await db.query(`INSERT INTO selection_site_assessments
    (project_id,country_code,opportunity_notes,certification_gap_cost,updated_at)
    VALUES ($1,'US','old site note',900,$2)`,[project.id,now]);
  return project;
}

async function loadPayload(projectId) {
  const document=await db.one('SELECT * FROM selection_documents WHERE project_id=$1',[projectId]);
  const sites=await db.many('SELECT * FROM selection_site_assessments WHERE project_id=$1 ORDER BY country_code',[projectId]);
  return {project:{id:projectId,name:'service test'},document,sites,suppliers:[],profits:[],competitors:{standard:[],similar:[]},review_overviews:{standard:{},similar:{}}};
}

async function removeProject(project) {
  if (project) await db.query('DELETE FROM projects WHERE id=$1',[project.id]);
}

function fakeProviderThatThrows(code,message='Codex failed to start') {
  return {
    calls:0,healthCalls:0,disposed:false,
    async health() { this.healthCalls+=1;return {ok:true}; },
    async *streamTurn() {
      this.calls+=1;
      throw Object.assign(new Error(message),{code});
    },
    async interruptTurn() { return {status:'interrupted'}; },
    dispose() { this.disposed=true; }
  };
}

function fakeProviderThatReplies(answer='answer',proposal={summary:'',changes:[]}) {
  return {
    calls:0,healthCalls:0,disposed:false,inputs:[],
    async health() { this.healthCalls+=1;return {ok:true}; },
    async *streamTurn(input) {
      this.calls+=1;
      this.inputs.push(input);
      yield {type:'text_delta',delta:answer};
      yield {type:'completed',result:{answer,proposal},providerState:{openai_state_id:'response-1',codex_thread_id:'thread-1'}};
    },
    async interruptTurn() { return {status:'interrupted'}; },
    dispose() { this.disposed=true; }
  };
}

function fakeBlockingProvider() {
  let release;
  const gate=new Promise((resolve)=>{ release=resolve; });
  return {
    calls:0,interrupts:[],inputs:[],
    async health() { return {ok:true}; },
    async *streamTurn(input) {
      this.calls+=1;
      this.inputs.push(input);
      yield {type:'text_delta',delta:'working'};
      await Promise.race([
        gate,
        new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(Object.assign(new Error('interrupted'),{code:'CODEX_TURN_INTERRUPTED'})),{once:true}))
      ]);
      yield {type:'completed',result:{answer:'done',proposal:{summary:'',changes:[]}},providerState:{}};
    },
    async interruptTurn(turnId) { this.interrupts.push(turnId);release();return {status:'interrupted'}; },
    dispose() { release(); }
  };
}

function fakeOwnedIteratorProvider() {
  let active=false;
  let sent=false;
  const provider={
    order:[],interrupts:[],
    async health() { return {ok:true}; },
    streamTurn(input) {
      active=true;
      return {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (!sent) {
            sent=true;
            return {done:false,value:{type:'text_delta',delta:'owned'}};
          }
          return new Promise(()=>{});
        },
        async return() {
          active=false;
          this.closed=true;
          provider.order.push('return');
          return {done:true,value:undefined};
        }
      };
    },
    async interruptTurn(turnId) {
      if (!active) {
        this.order.push('interrupt-after-return');
        throw Object.assign(new Error('not active'),{code:'CODEX_TURN_FAILED'});
      }
      this.order.push('interrupt');
      this.interrupts.push(turnId);
      return {status:'interrupted'};
    },
    dispose() { active=false; }
  };
  return provider;
}

function createService({codex=fakeProviderThatReplies(),openai=fakeProviderThatReplies()}={}) {
  return createSelectionAiService({
    db,
    repository:createSelectionAiRepository(db),
    providers:{codex,openai},
    loadPayload
  });
}

async function collect(iterable) {
  const events=[];
  for await (const event of iterable) events.push(event);
  return events;
}

test('AI list validators return bounded complete replacement values',()=>{
  assert.deepEqual(validateDifferentiationItems([{direction:' x ','level':'L','difficulty':'d'}]),[
    {direction:'x',level:'L',difficulty:'d'}
  ]);
  assert.deepEqual(validateChecklist([{label:' review ','checked':1},null]),[
    {id:'ai-0',label:'review',checked:true},
    {id:'ai-1',label:'',checked:false}
  ]);
  assert.throws(()=>validateChecklist('[]'),/checklist/);
});

test('defaults to Codex and never automatically falls back to OpenAI',async(t)=>{
  const project=await createProject('AI no fallback');
  const codex=fakeProviderThatThrows('CODEX_START_FAILED');
  const openai=fakeProviderThatReplies('must not be called');
  const service=createService({codex,openai});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  await assert.rejects(collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'analyse'})),/Codex/);
  assert.equal(codex.calls,1);
  assert.equal(openai.calls,0);
  const state=await service.getState(project.id);
  assert.equal(state.messages.at(-1).status,'failed');
  assert.equal(state.messages.at(-1).error_code,'CODEX_START_FAILED');
});

test('calls OpenAI only after an explicit provider switch',async(t)=>{
  const project=await createProject('AI provider switch');
  const codex=fakeProviderThatReplies('codex');
  const openai=fakeProviderThatReplies('openai');
  const service=createService({codex,openai});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  await service.setProvider(project.id,'openai');
  assert.deepEqual(await service.health(project.id),{provider:'openai',ok:true});
  const events=await collect(service.streamTurn({projectId:project.id,chapter:'sites',message:'analyse sites'}));

  assert.equal(codex.calls,0);
  assert.equal(openai.calls,1);
  assert.equal(events.at(-1).type,'completed');
  assert.equal((await service.getState(project.id)).conversation.openai_state_id,'response-1');
});

test('rejects a concurrent turn for the same project and allows another project',async(t)=>{
  const firstProject=await createProject('AI lock A');
  const secondProject=await createProject('AI lock B');
  const codex=fakeBlockingProvider();
  const service=createService({codex,openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(firstProject);await removeProject(secondProject); });

  const first=service.streamTurn({projectId:firstProject.id,chapter:'overview',message:'first'});
  const firstStarted=(await first.next()).value;
  assert.equal(firstStarted.type,'status');
  await assert.rejects(
    ()=>service.streamTurn({projectId:firstProject.id,chapter:'overview',message:'second'}).next(),
    (error)=>error.code==='TURN_ALREADY_ACTIVE'
  );
  const other=service.streamTurn({projectId:secondProject.id,chapter:'overview',message:'other'});
  assert.equal((await other.next()).value.type,'status');

  await service.interrupt(firstProject.id,firstStarted.turnId);
  await other.return();
  await first.return();
});

test('claims the project lock before awaiting conversation state',async(t)=>{
  const project=await createProject('AI immediate lock');
  const provider=fakeProviderThatReplies('done');
  const baseRepository=createSelectionAiRepository(db);
  const repository={...baseRepository,async getState(projectId) {
    await new Promise((resolve)=>setImmediate(resolve));
    return baseRepository.getState(projectId);
  }};
  const service=createSelectionAiService({
    db,repository,providers:{codex:provider,openai:fakeProviderThatReplies()},loadPayload
  });
  t.after(async()=>{ service.dispose();await removeProject(project); });

  const first=collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'first'}));
  const second=collect(service.streamTurn({projectId:String(project.id),chapter:'overview',message:'second'}));
  const results=await Promise.allSettled([first,second]);

  assert.equal(results.filter((result)=>result.status==='fulfilled').length,1);
  assert.equal(results.filter((result)=>result.status==='rejected'&&result.reason.code==='TURN_ALREADY_ACTIVE').length,1);
  assert.equal(provider.calls,1);
});

test('persists a deterministic bounded summary without another provider call',async(t)=>{
  const project=await createProject('AI summary');
  const codex=fakeProviderThatReplies('new answer');
  const service=createService({codex,openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  const repository=createSelectionAiRepository(db);
  for (let index=0;index<23;index++) {
    await repository.createMessage({projectId:project.id,role:index%2?'assistant':'user',provider:'codex',content:`history-${index}-${'x'.repeat(500)}`,status:'completed'});
  }

  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'summarise'}));
  const state=await service.getState(project.id);
  assert.equal(codex.calls,1);
  assert.ok(state.conversation.summary.includes('history-0'));
  assert.ok(state.conversation.summary.length<=8000);
  assert.equal(codex.inputs[0].input.includes('history-0'),true);
});

test('persists the final buffered text when a provider fails',async(t)=>{
  const project=await createProject('AI partial failure');
  const provider={
    async health() { return {ok:true}; },
    async *streamTurn() {
      yield {type:'text_delta',delta:'partial answer'};
      throw Object.assign(new Error('Codex turn failed'),{code:'CODEX_TURN_FAILED'});
    },
    async interruptTurn() { return {status:'interrupted'}; },
    dispose() {}
  };
  const service=createService({codex:provider,openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  await assert.rejects(collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'analyse'})));
  const assistant=(await service.getState(project.id)).messages.at(-1);
  assert.equal(assistant.content,'partial answer');
  assert.equal(assistant.status,'failed');
});

test('publishes a public turn ID first and correlates it through every event and interrupt',async(t)=>{
  const project=await createProject('AI public turn');
  const proposal={summary:'edit',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'new position',reason:'clearer'}
  ]};
  const provider=fakeProviderThatReplies('answer',proposal);
  const service=createService({codex:provider,openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  const events=await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'analyse'}));
  assert.deepEqual(events[0],{type:'status',status:'started',turnId:events[0].turnId});
  assert.ok(events[0].turnId);
  assert.equal(events.some((event)=>event.type==='proposal'),true);
  assert.equal(events.every((event)=>event.turnId===events[0].turnId),true);

  const interrupted=service.streamTurn({projectId:project.id,chapter:'overview',message:'interrupt me'});
  const started=(await interrupted.next()).value;
  assert.deepEqual(await service.interrupt(project.id,started.turnId),{status:'interrupted'});
  await assert.rejects(interrupted.next(),(error)=>error.code==='TURN_INTERRUPTED');
  assert.equal(provider.calls,1);
});

test('aborts during delayed payload loading without invoking the Provider',async(t)=>{
  const project=await createProject('AI delayed abort');
  const provider=fakeProviderThatReplies('must not run');
  let releaseLoad;
  let markLoadStarted;
  const loadGate=new Promise((resolve)=>{ releaseLoad=resolve; });
  const loadStarted=new Promise((resolve)=>{ markLoadStarted=resolve; });
  const delayedLoad=async(projectId)=>{
    markLoadStarted();
    await loadGate;
    return loadPayload(projectId);
  };
  const service=createSelectionAiService({
    db,
    repository:createSelectionAiRepository(db),
    providers:{codex:provider,openai:fakeProviderThatReplies()},
    loadPayload:delayedLoad
  });
  const controller=new AbortController();
  t.after(async()=>{ releaseLoad();service.dispose();await removeProject(project); });

  const iterator=service.streamTurn({projectId:project.id,chapter:'overview',message:'analyse',signal:controller.signal});
  assert.equal((await iterator.next()).value.type,'status');
  const running=iterator.next();
  await loadStarted;
  controller.abort();
  releaseLoad();

  await assert.rejects(running,(error)=>error.code==='TURN_INTERRUPTED');
  assert.equal(provider.calls,0);
  assert.equal((await service.getState(project.id)).messages.at(-1).status,'interrupted');
});

test('iterator return interrupts the Provider and persists buffered text',async(t)=>{
  const project=await createProject('AI iterator return');
  const provider=fakeBlockingProvider();
  const service=createService({codex:provider,openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  const iterator=service.streamTurn({projectId:project.id,chapter:'overview',message:'analyse'});
  const started=(await iterator.next()).value;
  const delta=(await iterator.next()).value;
  assert.equal(delta.type,'text_delta');
  assert.equal(delta.turnId,started.turnId);
  assert.deepEqual(await iterator.return(),{value:undefined,done:true});

  const assistant=(await service.getState(project.id)).messages.at(-1);
  assert.equal(assistant.status,'interrupted');
  assert.equal(assistant.content,'working');
  assert.deepEqual(provider.interrupts,[started.turnId]);
  assert.equal((await iterator.next()).done,true);
});

test('iterator cleanup interrupts an active Provider before closing its owned iterator',async(t)=>{
  const project=await createProject('AI owned iterator return');
  const provider=fakeOwnedIteratorProvider();
  const service=createService({codex:provider,openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  const iterator=service.streamTurn({projectId:project.id,chapter:'overview',message:'analyse'});
  const started=(await iterator.next()).value;
  assert.equal((await iterator.next()).value.delta,'owned');
  await iterator.return();

  assert.deepEqual(provider.order,['interrupt','return']);
  assert.deepEqual(provider.interrupts,[started.turnId]);
  assert.equal((await service.getState(project.id)).messages.at(-1).status,'interrupted');
});

test('does not call a provider when the caller signal is already aborted',async(t)=>{
  const project=await createProject('AI pre-abort');
  const provider=fakeProviderThatReplies('must not run');
  const service=createService({codex:provider,openai:fakeProviderThatReplies()});
  const controller=new AbortController();
  controller.abort();
  t.after(async()=>{ service.dispose();await removeProject(project); });

  await assert.rejects(
    collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'analyse',signal:controller.signal})),
    (error)=>error.code==='TURN_INTERRUPTED'
  );
  assert.equal(provider.calls,0);
  assert.equal((await service.getState(project.id)).messages.at(-1).status,'interrupted');
});

test('applies only selected normalized document and site changes atomically and increments version once',async(t)=>{
  const project=await createProject('AI apply');
  const proposal={summary:'safe edits',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'new position',reason:'clearer'},
    {scope:'site',country_code:'US',field:'opportunity_notes',value:'new site note',reason:'evidence'},
    {scope:'site',country_code:'US',field:'certification_gap_cost',value:'0',reason:'numeric overwrite'},
    {scope:'document',country_code:'',field:'decision_status',value:'passed',reason:'forbidden'},
    {scope:'document',country_code:'',field:'competitor_summary',value:'leave unselected',reason:'optional'},
    {scope:'document',country_code:'',field:'review_issues',value:JSON.stringify([{issue:'new issue',ratio:0,solution:'new solution'}]),reason:'text update'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  await collect(service.streamTurn({projectId:project.id,chapter:'risks',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];
  assert.deepEqual(pending.changes.map((change)=>change.field),['positioning','opportunity_notes','competitor_summary','review_issues']);
  assert.equal(pending.changes[3].after[0].ratio,37.5);

  const applied=await service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0,1,3]});
  const document=await db.one('SELECT * FROM selection_documents WHERE project_id=$1',[project.id]);
  const site=await db.one("SELECT * FROM selection_site_assessments WHERE project_id=$1 AND country_code='US'",[project.id]);
  assert.equal(document.positioning,'new position');
  assert.equal(document.competitor_summary,'');
  assert.equal(document.version,1);
  assert.equal(document.decision_status,(await loadPayload(project.id)).document.decision_status);
  assert.equal(document.review_issues[0].ratio,37.5);
  assert.equal(site.opportunity_notes,'new site note');
  assert.equal(site.certification_gap_cost,900);
  assert.equal(applied.status,'applied');
  assert.deepEqual(applied.applied_changes,[pending.changes[0],pending.changes[1],pending.changes[3]]);
});

test('only one of two same-base proposals can apply',async(t)=>{
  const project=await createProject('AI concurrent apply');
  const proposal={summary:'edit',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'concurrent position',reason:'clearer'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'first'}));
  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'second'}));
  const proposals=(await service.getState(project.id)).proposals;

  assert.equal((await service.applyProposal({projectId:project.id,proposalId:proposals[0].id,changeIndexes:[0]})).status,'applied');
  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:proposals[1].id,changeIndexes:[0]}),
    (error)=>error.code==='PROPOSAL_CONFLICT'
  );
  assert.equal((await db.one('SELECT version FROM selection_documents WHERE project_id=$1',[project.id])).version,1);
});

test('conditional document update returns PROPOSAL_CONFLICT when its version predicate updates zero rows',async(t)=>{
  const project=await createProject('AI atomic version predicate');
  const proposal={summary:'edit',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'new position',reason:'clearer'}
  ]};
  const repository=createSelectionAiRepository(db);
  const queries=[];
  const guardedDb={transaction:async(callback)=>callback({query:async(sql,params=[])=>{
    queries.push(sql);
    if (/^UPDATE selection_documents/.test(sql.trim())) return {rows:[],rowCount:0};
    return db.query(sql,params);
  }})};
  const service=createSelectionAiService({
    db:guardedDb,repository,providers:{codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()},loadPayload
  });
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];

  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0]}),
    (error)=>error.code==='PROPOSAL_CONFLICT'
  );
  assert.equal(queries.some((sql)=>/WHERE project_id=\$\d+ AND version=\$\d+ RETURNING \*/.test(sql)),true);
  assert.equal((await db.one('SELECT version FROM selection_documents WHERE project_id=$1',[project.id])).version,0);
});

test('site edits after proposal creation cause a conflict with no writes',async(t)=>{
  const project=await createProject('AI stale site');
  const proposal={summary:'edits',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'new position',reason:'clearer'},
    {scope:'site',country_code:'US',field:'opportunity_notes',value:'AI site note',reason:'evidence'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'sites',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];
  await db.query("UPDATE selection_site_assessments SET opportunity_notes='manual site note' WHERE project_id=$1 AND country_code='US'",[project.id]);

  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0,1]}),
    (error)=>error.code==='PROPOSAL_CONFLICT'
  );
  const document=await db.one('SELECT positioning,version FROM selection_documents WHERE project_id=$1',[project.id]);
  assert.deepEqual(document,{positioning:'old position',version:0});
  assert.equal((await service.getState(project.id)).proposals[0].status,'pending');
});

test('a missing site row matches an aggregate default empty text value',async(t)=>{
  const project=await createProject('AI blank missing site');
  const proposal={summary:'site',changes:[
    {scope:'site',country_code:'CA',field:'opportunity_notes',value:'new Canada note',reason:'evidence'}
  ]};
  const aggregateLoad=async(projectId)=>{
    const payload=await loadPayload(projectId);
    payload.sites.push({country_code:'CA',opportunity_notes:''});
    return payload;
  };
  const service=createSelectionAiService({
    db,
    repository:createSelectionAiRepository(db),
    providers:{codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()},
    loadPayload:aggregateLoad
  });
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'sites',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];

  assert.equal((await service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0]})).status,'applied');
  assert.equal((await db.one("SELECT opportunity_notes FROM selection_site_assessments WHERE project_id=$1 AND country_code='CA'",[project.id])).opportunity_notes,'new Canada note');
});

test('conditional site upsert detects a conflicting first insert after the missing-row check',async(t)=>{
  const project=await createProject('AI site insert race');
  const proposal={summary:'site',changes:[
    {scope:'site',country_code:'CA',field:'opportunity_notes',value:'AI Canada note',reason:'evidence'}
  ]};
  const aggregateLoad=async(projectId)=>{
    const payload=await loadPayload(projectId);
    payload.sites.push({country_code:'CA',opportunity_notes:''});
    return payload;
  };
  const repository=createSelectionAiRepository(db);
  const queries=[];
  const raceDb={transaction:async(callback)=>callback({query:async(sql,params=[])=>{
    queries.push(sql);
    if (/^UPDATE selection_documents/.test(sql.trim())) return {rows:[{version:1}],rowCount:1};
    if (/^INSERT INTO selection_site_assessments/.test(sql.trim())) return {rows:[],rowCount:0};
    return db.query(sql,params);
  }})};
  const service=createSelectionAiService({
    db:raceDb,repository,providers:{codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()},loadPayload:aggregateLoad
  });
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'sites',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];

  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0]}),
    (error)=>error.code==='PROPOSAL_CONFLICT'
  );
  const upsert=queries.find((sql)=>/^INSERT INTO selection_site_assessments/.test(sql.trim()));
  assert.match(upsert,/DO UPDATE SET[\s\S]+WHERE[\s\S]+RETURNING \*/);
  assert.equal((await db.one('SELECT version FROM selection_documents WHERE project_id=$1',[project.id])).version,0);
  assert.equal((await service.getState(project.id)).proposals[0].status,'pending');
});

test('review issue proposals require one-to-one entries and preserve every ratio',async(t)=>{
  const cases=[
    {name:'empty',current:[{issue:'a',ratio:10,solution:'x'}],proposed:[]},
    {name:'short',current:[{issue:'a',ratio:10,solution:'x'},{issue:'b',ratio:20,solution:'y'}],proposed:[{issue:'a2',ratio:0,solution:'x2'}]},
    {name:'long',current:[{issue:'a',ratio:10,solution:'x'}],proposed:[{issue:'a2',ratio:0,solution:'x2'},{issue:'b',ratio:30,solution:'y'}]}
  ];
  for (const item of cases) {
    await t.test(item.name,async()=>{
      const project=await createProject(`AI review ${item.name}`);
      await db.query('UPDATE selection_documents SET review_issues=$1::jsonb WHERE project_id=$2',[JSON.stringify(item.current),project.id]);
      const proposal={summary:'review',changes:[
        {scope:'document',country_code:'',field:'review_issues',value:JSON.stringify(item.proposed),reason:'edit text'}
      ]};
      const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
      try {
        await collect(service.streamTurn({projectId:project.id,chapter:'risks',message:'propose'}));
        assert.equal((await service.getState(project.id)).proposals.length,0);
      } finally {
        service.dispose();
        await removeProject(project);
      }
    });
  }
});

test('proposal application rejects review issue cardinality tampering',async(t)=>{
  const project=await createProject('AI review tamper');
  const proposal={summary:'review',changes:[
    {scope:'document',country_code:'',field:'review_issues',value:JSON.stringify([{issue:'new',ratio:0,solution:'new'}]),reason:'edit text'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'risks',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];
  const changes=pending.changes;
  changes[0].after=[];
  await db.query('UPDATE selection_ai_proposals SET changes=$1::jsonb WHERE id=$2',[JSON.stringify(changes),pending.id]);

  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0]}),
    (error)=>error.code==='PROPOSAL_INVALID'
  );
  assert.equal((await db.one('SELECT version FROM selection_documents WHERE project_id=$1',[project.id])).version,0);
});

test('review issue one-to-one text edits preserve all existing ratios',async(t)=>{
  const project=await createProject('AI review one to one');
  const current=[
    {issue:'a',ratio:10,solution:'x'},
    {issue:'b',ratio:20,solution:'y'}
  ];
  await db.query('UPDATE selection_documents SET review_issues=$1::jsonb WHERE project_id=$2',[JSON.stringify(current),project.id]);
  const proposal={summary:'review',changes:[
    {scope:'document',country_code:'',field:'review_issues',value:JSON.stringify([
      {issue:'a2',ratio:999,solution:'x2'},
      {issue:'b2',ratio:-1,solution:'y2'}
    ]),reason:'edit text'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'risks',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];

  assert.deepEqual(pending.changes[0].after.map((item)=>item.ratio),[10,20]);
  await service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0]});
  assert.deepEqual((await db.one('SELECT review_issues FROM selection_documents WHERE project_id=$1',[project.id])).review_issues.map((item)=>item.ratio),[10,20]);
});

test('oversized review issue output is dropped instead of truncating to 100 entries',async(t)=>{
  const project=await createProject('AI oversized review normalization');
  const current=Array.from({length:100},(_,index)=>({issue:`old-${index}`,ratio:index,solution:'old'}));
  const proposed=Array.from({length:101},(_,index)=>({issue:`new-${index}`,ratio:999,solution:'new'}));
  await db.query('UPDATE selection_documents SET review_issues=$1::jsonb WHERE project_id=$2',[JSON.stringify(current),project.id]);
  const proposal={summary:'review',changes:[
    {scope:'document',country_code:'',field:'review_issues',value:JSON.stringify(proposed),reason:'edit text'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  await collect(service.streamTurn({projectId:project.id,chapter:'risks',message:'propose'}));
  assert.equal((await service.getState(project.id)).proposals.length,0);
});

test('proposal application rejects review issue lists over 100 entries',async(t)=>{
  const project=await createProject('AI oversized review application');
  const current=Array.from({length:100},(_,index)=>({issue:`old-${index}`,ratio:index,solution:'old'}));
  await db.query('UPDATE selection_documents SET review_issues=$1::jsonb WHERE project_id=$2',[JSON.stringify(current),project.id]);
  const proposal={summary:'review',changes:[
    {scope:'document',country_code:'',field:'review_issues',value:JSON.stringify(current),reason:'edit text'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'risks',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];
  const oversized=Array.from({length:101},(_,index)=>({issue:`tampered-${index}`,ratio:index,solution:'x'}));
  const changes=pending.changes;
  changes[0].after=oversized;
  await db.query('UPDATE selection_documents SET review_issues=$1::jsonb WHERE project_id=$2',[JSON.stringify(oversized),project.id]);
  await db.query('UPDATE selection_ai_proposals SET changes=$1::jsonb WHERE id=$2',[JSON.stringify(changes),pending.id]);

  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0]}),
    (error)=>error.code==='PROPOSAL_INVALID'
  );
  assert.equal((await service.getState(project.id)).proposals[0].status,'pending');
});

test('JSON proposal validation ignores object key order',async(t)=>{
  const project=await createProject('AI JSON equality');
  const proposal={summary:'differentiate',changes:[
    {scope:'document',country_code:'',field:'differentiation_items',value:JSON.stringify([{direction:'x',level:'L',difficulty:'d'}]),reason:'edit'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];
  const changes=pending.changes;
  changes[0].after=[{difficulty:'d',level:'L',direction:'x'}];
  await db.query('UPDATE selection_ai_proposals SET changes=$1::jsonb WHERE id=$2',[JSON.stringify(changes),pending.id]);

  const applied=await service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0]});
  assert.equal(applied.status,'applied');
  assert.deepEqual((await db.one('SELECT differentiation_items FROM selection_documents WHERE project_id=$1',[project.id])).differentiation_items,[
    {direction:'x',level:'L',difficulty:'d'}
  ]);
});

test('duplicate selected target keys are rejected before any write',async(t)=>{
  const project=await createProject('AI duplicate target');
  const proposal={summary:'duplicates',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'first',reason:'one'},
    {scope:'document',country_code:'',field:'positioning',value:'second',reason:'two'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];

  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0,1]}),
    (error)=>error.code==='PROPOSAL_INVALID'
  );
  assert.deepEqual(await db.one('SELECT positioning,version FROM selection_documents WHERE project_id=$1',[project.id]),{
    positioning:'old position',version:0
  });
  assert.deepEqual((await service.getState(project.id)).proposals[0].applied_changes,[]);
});

test('unknown errors persist only a sanitized INTERNAL_ERROR',async(t)=>{
  const project=await createProject('AI safe error');
  const provider=fakeProviderThatThrows('57P01','SQL password=super-secret failed');
  const service=createService({codex:provider,openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });

  await assert.rejects(
    collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'analyse'})),
    (error)=>error.code==='INTERNAL_ERROR'&&!error.message.includes('super-secret')
  );
  const assistant=(await service.getState(project.id)).messages.at(-1);
  assert.equal(assistant.error_code,'INTERNAL_ERROR');
  assert.equal(assistant.error_message,'内部错误，请稍后重试');
});

test('resolve failure rolls back document, site, and proposal writes',async(t)=>{
  const project=await createProject('AI rollback evidence');
  const proposal={summary:'edits',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'new position',reason:'clearer'},
    {scope:'site',country_code:'US',field:'opportunity_notes',value:'new site note',reason:'evidence'}
  ]};
  const baseRepository=createSelectionAiRepository(db);
  let pending;
  let rolledBack=false;
  let transactionClient;
  const transactionQueries=[];
  const trackingDb={transaction:async(callback)=>{
    transactionClient={query:async(sql)=>{
      transactionQueries.push(sql);
      if (/SELECT \* FROM selection_ai_proposals/.test(sql)) return {rows:[pending],rowCount:1};
      if (/SELECT \* FROM selection_documents/.test(sql)) {
        return {rows:[await db.one('SELECT * FROM selection_documents WHERE project_id=$1',[project.id])],rowCount:1};
      }
      if (/SELECT \* FROM selection_site_assessments/.test(sql)) {
        return {rows:[await db.one("SELECT * FROM selection_site_assessments WHERE project_id=$1 AND country_code='US'",[project.id])],rowCount:1};
      }
      if (/UPDATE selection_documents/.test(sql)) return {rows:[{version:1}],rowCount:1};
      if (/INSERT INTO selection_site_assessments/.test(sql)) return {rows:[],rowCount:1};
      if (sql==='ROLLBACK') return {rows:[],rowCount:0};
      throw new Error(`unexpected SQL: ${sql}`);
    }};
    try {
      return await callback(transactionClient);
    } catch (error) {
      rolledBack=true;
      await transactionClient.query('ROLLBACK');
      throw error;
    }
  }};
  const repository={...baseRepository,async resolveProposal(id,status,changes,client) {
    assert.equal(client,transactionClient);
    throw new Error('injected resolve failure');
  }};
  const service=createSelectionAiService({
    db:trackingDb,repository,providers:{codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()},loadPayload
  });
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'propose'}));
  pending=(await service.getState(project.id)).proposals[0];

  await assert.rejects(service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0,1]}),/injected/);
  assert.equal(rolledBack,true);
  assert.equal(transactionQueries.filter((sql)=>/UPDATE selection_documents|INSERT INTO selection_site_assessments/.test(sql)).length,2);
  assert.equal(transactionQueries.at(-1),'ROLLBACK');
  assert.deepEqual(await db.one('SELECT positioning,version FROM selection_documents WHERE project_id=$1',[project.id]),{
    positioning:'old position',version:0
  });
  assert.equal((await db.one("SELECT opportunity_notes FROM selection_site_assessments WHERE project_id=$1 AND country_code='US'",[project.id])).opportunity_notes,'old site note');
  assert.equal((await service.getState(project.id)).proposals[0].status,'pending');
});

test('proposal conflict rolls back site and document writes',async(t)=>{
  const project=await createProject('AI conflict');
  const proposal={summary:'edits',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'new position',reason:'clearer'},
    {scope:'site',country_code:'US',field:'opportunity_notes',value:'new site note',reason:'evidence'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];
  await db.query('UPDATE selection_documents SET version=version+1 WHERE project_id=$1',[project.id]);

  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0,1]}),
    (error)=>error.code==='PROPOSAL_CONFLICT'
  );
  assert.equal((await db.one('SELECT positioning FROM selection_documents WHERE project_id=$1',[project.id])).positioning,'old position');
  assert.equal((await db.one("SELECT opportunity_notes FROM selection_site_assessments WHERE project_id=$1 AND country_code='US'",[project.id])).opportunity_notes,'old site note');
  assert.equal((await service.getState(project.id)).proposals[0].status,'pending');
});

test('a rejected proposal cannot later be applied',async(t)=>{
  const project=await createProject('AI reject');
  const proposal={summary:'edit',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'new position',reason:'clearer'}
  ]};
  const service=createService({codex:fakeProviderThatReplies('answer',proposal),openai:fakeProviderThatReplies()});
  t.after(async()=>{ service.dispose();await removeProject(project); });
  await collect(service.streamTurn({projectId:project.id,chapter:'overview',message:'propose'}));
  const pending=(await service.getState(project.id)).proposals[0];

  assert.equal((await service.rejectProposal(project.id,pending.id)).status,'rejected');
  await assert.rejects(
    service.applyProposal({projectId:project.id,proposalId:pending.id,changeIndexes:[0]}),
    (error)=>error.code==='PROPOSAL_NOT_PENDING'
  );
  assert.equal((await db.one('SELECT version FROM selection_documents WHERE project_id=$1',[project.id])).version,0);
});

test('default factory is lazy and disposable without starting either real provider',async()=>{
  const service=createDefaultSelectionAiService({db,loadPayload});
  service.dispose();
});

test.after(async()=>db.close());
