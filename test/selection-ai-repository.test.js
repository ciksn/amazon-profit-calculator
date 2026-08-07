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
  assert.equal((await db.one('SELECT COUNT(*)::int AS n FROM selection_ai_conversations WHERE project_id=$1',[p1.id])).n,0);
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

test('repository pages unsummarized messages by project and ascending summary cursor',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const firstProject=await project('AI summary pagination A');
  const secondProject=await project('AI summary pagination B');
  t.after(()=>removeProjects([firstProject,secondProject]));
  const firstProjectMessages=[];

  for (let index=0;index<205;index++) {
    firstProjectMessages.push(await repo.createMessage({
      projectId:firstProject.id,role:'user',provider:'codex',
      content:`project-a-${index}`,status:'completed'
    }));
    if (index%50===0) {
      await repo.createMessage({
        projectId:secondProject.id,role:'user',provider:'codex',
        content:`project-b-${index}`,status:'completed'
      });
    }
  }
  const beforeId=firstProjectMessages.at(-1).id+1;

  const firstPage=await repo.listMessagesForSummary(firstProject.id,{
    afterId:0,beforeId,limit:500
  });
  const secondPage=await repo.listMessagesForSummary(firstProject.id,{
    afterId:firstPage.at(-1).id,beforeId,limit:500
  });

  assert.equal(firstPage.length,200);
  assert.equal(secondPage.length,5);
  assert.deepEqual(
    [...firstPage,...secondPage].map((message)=>message.content),
    Array.from({length:205},(_,index)=>`project-a-${index}`)
  );
  const otherState=await repo.getState(secondProject.id);
  assert.equal(otherState.messages.length,5);
  assert.equal(Number(otherState.conversation.summary_message_id),0);
});

test('repository persists summary and cursor together and clear resets both',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const p=await project('AI summary cursor');
  t.after(()=>removeProjects([p]));
  const message=await repo.createMessage({
    projectId:p.id,role:'user',provider:'codex',content:'summarized',status:'completed'
  });

  await repo.setSummary(p.id,'cursor summary',message.id);
  let state=await repo.getState(p.id);
  assert.equal(state.conversation.summary,'cursor summary');
  assert.equal(Number(state.conversation.summary_message_id),message.id);

  await repo.setSummary(p.id,'compatible summary update');
  state=await repo.getState(p.id);
  assert.equal(state.conversation.summary,'compatible summary update');
  assert.equal(Number(state.conversation.summary_message_id),message.id);

  await repo.clear(p.id);
  state=await repo.getState(p.id);
  assert.equal(state.conversation.summary,'');
  assert.equal(Number(state.conversation.summary_message_id),0);
});

test('repository creates proposals and updates messages with an optional transaction client',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const p=await project('AI transactional finalization');
  t.after(()=>removeProjects([p]));
  const message=await repo.createMessage({projectId:p.id,role:'assistant',provider:'codex',content:'working',status:'streaming'});
  const calls=[];

  const result=await db.transaction(async(client)=>{
    const trackedClient={async query(sql,params) {
      calls.push(sql);
      return client.query(sql,params);
    }};
    const proposal=await repo.createProposal({
      projectId:p.id,messageId:message.id,baseDocumentVersion:0,
      changes:[{scope:'document',field:'positioning',before:'old',after:'new'}]
    },trackedClient);
    const completed=await repo.updateMessage(message.id,{content:'complete',status:'completed'},trackedClient);
    return {proposal,completed};
  });

  assert.equal(calls.length,2);
  assert.match(calls[0],/^INSERT INTO selection_ai_proposals/);
  assert.match(calls[1],/^UPDATE selection_ai_messages/);
  assert.equal(result.proposal.status,'pending');
  assert.equal(result.completed.status,'completed');
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

test('repository rejects invalid message inputs without persisting them',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const p=await project('AI validation');
  t.after(()=>removeProjects([p]));
  const valid={projectId:p.id,role:'user',provider:'codex',content:'message',status:'pending'};

  await assert.rejects(repo.createMessage({...valid,role:'system'}),/role/);
  await assert.rejects(repo.createMessage({...valid,provider:'gemini'}),/Provider/);
  await assert.rejects(repo.createMessage({...valid,status:'unknown'}),/status/);
  assert.equal((await repo.listRecentMessages(p.id)).length,0);
});

test('repository rejects invalid message status updates without persisting them',async(t)=>{
  const repo=createSelectionAiRepository(db);
  const p=await project('AI update validation');
  t.after(()=>removeProjects([p]));
  const message=await repo.createMessage({projectId:p.id,role:'assistant',provider:'openai',content:'message',status:'streaming'});

  await assert.rejects(repo.updateMessage(message.id,{status:'unknown'}),/status/);
  assert.equal((await repo.listRecentMessages(p.id))[0].status,'streaming');
});

test('repository returns null when resolving a proposal that does not exist',async()=>{
  const repo=createSelectionAiRepository(db);
  assert.equal(await repo.resolveProposal(-1,'applied',[]),null);
  await db.close();
});
