'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const db=require('../lib/db');
const {createSelectionAiRepository}=require('../lib/selection-ai/repository');

async function project(name) {
  const now=new Date().toISOString();
  return db.one('INSERT INTO projects(name,created_at,updated_at) VALUES ($1,$2,$2) RETURNING *',[name,now]);
}

async function removeProjects(projects) {
  for (const item of projects) await db.query('DELETE FROM projects WHERE id=$1',[item.id]);
  await db.close();
}

test('each project keeps its own provider, messages, and proposals and cascades on deletion',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const p1=await project('AI A');
  const p2=await project('AI B');
  t.after(()=>removeProjects([p1,p2]));

  assert.equal((await repo.getState(p1.id)).conversation.active_provider,'codex');
  await repo.setProvider(p1.id,'openai');
  const message=await repo.createMessage({projectId:p1.id,role:'user',provider:'openai',content:'Analyse the US market',status:'completed'});
  await repo.createProposal({projectId:p1.id,messageId:message.id,baseDocumentVersion:0,changes:[]});

  assert.equal((await repo.getState(p1.id)).messages.length,1);
  assert.equal((await repo.getState(p2.id)).messages.length,0);
  await db.query('DELETE FROM projects WHERE id=$1',[p1.id]);
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM selection_ai_messages WHERE project_id=$1',[p1.id])).n,0);
});

test('repository stores provider state and normalizes proposal JSON values',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const p=await project('AI state');
  t.after(()=>removeProjects([p]));

  await repo.setProviderState(p.id,{codexThreadId:'thread-1',openaiStateId:'state-1'});
  await repo.setSummary(p.id,'short retained summary');
  const message=await repo.createMessage({projectId:p.id,role:'assistant',provider:'codex',content:'answer',status:'completed'});
  const proposal=await repo.createProposal({
    projectId:p.id,messageId:message.id,baseDocumentVersion:3,
    changes:[{scope:'document',field:'positioning',before:'old',after:'new'}]
  });
  const state=await repo.getState(p.id);

  assert.deepEqual(state.conversation,{...state.conversation,
    project_id:p.id,active_provider:'codex',codex_thread_id:'thread-1',openai_state_id:'state-1',summary:'short retained summary'
  });
  assert.deepEqual(state.proposals[0].changes,[{scope:'document',field:'positioning',before:'old',after:'new'}]);
  assert.deepEqual(proposal.applied_changes,[]);
});

test('repository caps recent messages and resolves proposals within the supplied transaction',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const p=await project('AI history');
  t.after(()=>removeProjects([p]));

  for (let index=0;index<201;index++) {
    await repo.createMessage({projectId:p.id,role:'user',provider:'codex',content:String(index),status:'completed'});
  }
  const messages=await repo.listRecentMessages(p.id,500);
  assert.equal(messages.length,200);
  assert.equal(messages[0].content,'1');
  const proposal=await repo.createProposal({projectId:p.id,messageId:messages.at(-1).id,baseDocumentVersion:1,changes:[]});

  const resolved=await db.transaction((client)=>repo.resolveProposal(proposal.id,'applied',[{field:'positioning',after:'new'}],client));
  assert.equal(resolved.status,'applied');
  assert.deepEqual(resolved.applied_changes,[{field:'positioning',after:'new'}]);
});

test('repository updates messages and clear removes all persisted AI state',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const p=await project('AI clear');
  t.after(()=>removeProjects([p]));

  const message=await repo.createMessage({projectId:p.id,role:'assistant',provider:'openai',content:'working',status:'streaming'});
  const updated=await repo.updateMessage(message.id,{content:'complete',status:'completed',errorCode:'',errorMessage:''});
  await repo.createProposal({projectId:p.id,messageId:message.id,baseDocumentVersion:0,changes:[]});
  assert.equal(updated.content,'complete');
  assert.equal(updated.status,'completed');

  await repo.clear(p.id);
  const state=await repo.getState(p.id);
  assert.equal(state.messages.length,0);
  assert.equal(state.proposals.length,0);
  assert.equal(state.conversation.active_provider,'codex');
});
