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
  assert.equal((await first.next()).value.type,'text_delta');
  await assert.rejects(
    ()=>service.streamTurn({projectId:firstProject.id,chapter:'overview',message:'second'}).next(),
    (error)=>error.code==='TURN_ALREADY_ACTIVE'
  );
  const other=service.streamTurn({projectId:secondProject.id,chapter:'overview',message:'other'});
  assert.equal((await other.next()).value.type,'text_delta');

  await service.interrupt(firstProject.id,codex.inputs[0].turnId);
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
