'use strict';

const crypto=require('node:crypto');
const {createSelectionAiRepository}=require('./repository');
const {createCodexProvider}=require('./providers/codex');
const {createOpenAiProvider}=require('./providers/openai');
const {buildSelectionAiContext}=require('./context');
const {
  DOCUMENT_AI_FIELDS,
  SITE_AI_FIELDS,
  validateProvider,
  normalizeProposal
}=require('./contracts');
const {
  validateDocumentPatch,
  validateSiteInput,
  validateDifferentiationItems,
  validateChecklist
}=require('../selection-document');

const MAX_SUMMARY_LENGTH=8000;
const MESSAGE_BATCH_LENGTH=1024;
const JSON_DOCUMENT_FIELDS=new Set(['differentiation_items','review_issues','checklist']);

class SelectionAiServiceError extends Error {
  constructor(code,message) {
    super(message);
    this.code=code;
  }
}

function serviceError(code,message) {
  return new SelectionAiServiceError(code,message);
}

function safeError(error) {
  if (error&&typeof error.code==='string'&&error.code) {
    return {
      code:error.code,
      message:typeof error.message==='string'&&error.message ? error.message : 'AI turn failed'
    };
  }
  return {code:'AI_TURN_FAILED',message:'AI turn failed'};
}

function isInterrupted(error,signal) {
  return Boolean(signal?.aborted)||String(error?.code||'').includes('INTERRUPT')||error?.name==='AbortError';
}

function deterministicSummary(messages) {
  const older=messages.length>20 ? messages.slice(0,-20) : [];
  let summary='';
  for (const message of older) {
    const role=message?.role==='assistant'?'assistant':'user';
    const content=String(message?.content??'').replace(/\s+/g,' ').trim().slice(0,1000);
    const excerpt=`${role}: ${content}\n`;
    if (summary.length+excerpt.length>MAX_SUMMARY_LENGTH) {
      summary+=excerpt.slice(0,MAX_SUMMARY_LENGTH-summary.length);
      break;
    }
    summary+=excerpt;
  }
  return summary.trimEnd();
}

function safeText(value,max=10000) {
  return String(value??'').trim().slice(0,max);
}

function normalizeReviewIssues(value,currentValue) {
  if (!Array.isArray(value)) throw new Error('review_issues is invalid');
  const current=Array.isArray(currentValue)?currentValue:[];
  return value.slice(0,100).map((item,index)=>{
    const existingRatio=Number(current[index]?.ratio);
    return {
      issue:safeText(item?.issue,1000),
      ratio:Number.isFinite(existingRatio)?existingRatio:0,
      solution:safeText(item?.solution,1000)
    };
  });
}

function normalizeDocumentListChange(change,payload) {
  if (change.field==='differentiation_items') {
    return {...change,after:validateDifferentiationItems(change.after)};
  }
  if (change.field==='checklist') {
    return {...change,after:validateChecklist(change.after)};
  }
  if (change.field==='review_issues') {
    return {...change,after:normalizeReviewIssues(change.after,payload.document?.review_issues)};
  }
  return change;
}

function normalizePersistedProposal(raw,payload) {
  const proposal=normalizeProposal(raw,payload);
  if (!proposal) return null;
  const changes=[];
  for (const change of proposal.changes) {
    try {
      changes.push(change.scope==='document'?normalizeDocumentListChange(change,payload):change);
    } catch {
      // A malformed AI list replacement is not persisted.
    }
  }
  return changes.length?{...proposal,changes}:null;
}

function assertSameValue(actual,expected) {
  if (JSON.stringify(actual)!==JSON.stringify(expected)) {
    throw serviceError('PROPOSAL_CHANGE_INVALID','Proposal change is no longer valid');
  }
}

function validateSelectedChange(change,document) {
  if (!change||typeof change!=='object') {
    throw serviceError('PROPOSAL_CHANGE_INVALID','Proposal change is invalid');
  }
  if (change.scope==='document') {
    if (change.country_code!==''||!DOCUMENT_AI_FIELDS.includes(change.field)||change.field==='decision_status') {
      throw serviceError('PROPOSAL_CHANGE_INVALID','Proposal document field is not allowed');
    }
    let value;
    if (change.field==='differentiation_items') value=validateDifferentiationItems(change.after);
    else if (change.field==='checklist') value=validateChecklist(change.after);
    else if (change.field==='review_issues') value=normalizeReviewIssues(change.after,document.review_issues);
    else value=validateDocumentPatch({version:document.version,[change.field]:change.after})[change.field];
    assertSameValue(value,change.after);
    return {...change,after:value};
  }
  if (change.scope==='site') {
    if (!SITE_AI_FIELDS.includes(change.field)||typeof change.country_code!=='string'||!change.country_code) {
      throw serviceError('PROPOSAL_CHANGE_INVALID','Proposal site field is not allowed');
    }
    const value=validateSiteInput({[change.field]:change.after})[change.field];
    assertSameValue(value,change.after);
    return {...change,after:value};
  }
  throw serviceError('PROPOSAL_CHANGE_INVALID','Proposal scope is invalid');
}

async function selectOne(client,text,params=[]) {
  const result=await client.query(text,params);
  return result.rows[0]||null;
}

function normalizeIndexes(indexes,total) {
  if (!Array.isArray(indexes)) throw serviceError('PROPOSAL_CHANGE_INVALID','Proposal change indexes are invalid');
  const unique=new Set();
  for (const index of indexes) {
    if (!Number.isInteger(index)||index<0||index>=total||unique.has(index)) {
      throw serviceError('PROPOSAL_CHANGE_INVALID','Proposal change index is invalid');
    }
    unique.add(index);
  }
  return [...unique];
}

function projectLockKey(projectId) {
  const numericId=Number(projectId);
  return Number.isSafeInteger(numericId)&&numericId>=0 ? String(numericId) : String(projectId);
}

function createSelectionAiService({db,repository,providers,loadPayload}) {
  if (!db||typeof db.transaction!=='function') throw new TypeError('db is required');
  if (!repository) throw new TypeError('repository is required');
  if (!providers?.codex||!providers?.openai) throw new TypeError('codex and openai providers are required');
  if (typeof loadPayload!=='function') throw new TypeError('loadPayload is required');

  const activeTurns=new Map();
  let disposed=false;

  function requireUsable() {
    if (disposed) throw serviceError('SERVICE_DISPOSED','Selection AI service has been disposed');
  }

  async function getState(projectId) {
    requireUsable();
    return repository.getState(projectId);
  }

  async function health(projectId) {
    requireUsable();
    const state=await repository.getState(projectId);
    const provider=validateProvider(state.conversation.active_provider);
    return {provider,...await providers[provider].health()};
  }

  async function setProvider(projectId,provider) {
    requireUsable();
    if (activeTurns.has(projectLockKey(projectId))) throw serviceError('TURN_ALREADY_ACTIVE','A turn is already active for this project');
    return repository.setProvider(projectId,validateProvider(provider));
  }

  async function* streamTurn({projectId,chapter='overview',message='',signal}={}) {
    requireUsable();
    const lockKey=projectLockKey(projectId);
    if (activeTurns.has(lockKey)) throw serviceError('TURN_ALREADY_ACTIVE','A turn is already active for this project');

    const turnId=crypto.randomUUID();
    const abortController=new AbortController();
    const lock={provider:null,turnId,abortController};
    activeTurns.set(lockKey,lock);
    let provider=null;
    let providerName=null;
    let assistantMessage=null;
    let externalAbort=null;
    let content='';

    try {
      const initialState=await repository.getState(projectId);
      providerName=validateProvider(initialState.conversation.active_provider);
      provider=providers[providerName];
      lock.provider=providerName;
      if (signal) {
        externalAbort=()=>{
          abortController.abort();
          Promise.resolve(provider.interruptTurn(turnId)).catch(()=>{});
        };
        signal.addEventListener('abort',externalAbort,{once:true});
        if (signal.aborted) externalAbort();
      }

      await repository.createMessage({
        projectId,role:'user',provider:providerName,content:String(message??''),status:'completed'
      });
      assistantMessage=await repository.createMessage({
        projectId,role:'assistant',provider:providerName,content:'',status:'streaming'
      });
      if (abortController.signal.aborted) {
        throw serviceError('TURN_INTERRUPTED','AI turn was interrupted');
      }

      const payload=await loadPayload(projectId);
      if (!payload) throw serviceError('PROJECT_NOT_FOUND','Project does not exist');
      const messages=await repository.listRecentMessages(projectId,200);
      let summary=initialState.conversation.summary||'';
      if (messages.length>20) {
        summary=deterministicSummary(messages);
        await repository.setSummary(projectId,summary);
      }
      const context=buildSelectionAiContext({payload,chapter,messages,summary});
      let persistedLength=0;
      let completion=null;

      for await (const event of provider.streamTurn({
        state:initialState.conversation,
        system:context.system,
        input:context.input,
        turnId,
        signal:abortController.signal
      })) {
        if (event?.type==='text_delta') {
          const delta=String(event.delta??'');
          content+=delta;
          if (content.length-persistedLength>=MESSAGE_BATCH_LENGTH) {
            await repository.updateMessage(assistantMessage.id,{content});
            persistedLength=content.length;
          }
          yield {type:'text_delta',delta};
        } else if (event?.type==='completed') {
          completion=event;
        }
      }

      if (!completion?.result||typeof completion.result.answer!=='string') {
        throw serviceError('AI_RESPONSE_INVALID','AI Provider did not return a completed answer');
      }
      content=completion.result.answer;
      const proposal=normalizePersistedProposal(completion.result.proposal,payload);
      if (completion.providerState) await repository.setProviderState(projectId,{
        ...(Object.hasOwn(completion.providerState,'codex_thread_id')
          ? {codexThreadId:completion.providerState.codex_thread_id}
          : {}),
        ...(Object.hasOwn(completion.providerState,'openai_state_id')
          ? {openaiStateId:completion.providerState.openai_state_id}
          : {})
      });
      const completedMessage=await repository.updateMessage(assistantMessage.id,{
        content,status:'completed',errorCode:'',errorMessage:''
      });
      const savedProposal=proposal?await repository.createProposal({
        projectId,
        messageId:assistantMessage.id,
        baseDocumentVersion:context.snapshotVersion,
        changes:proposal.changes
      }):null;
      yield {
        type:'completed',
        result:{answer:content,proposal},
        message:completedMessage,
        proposal:savedProposal
      };
    } catch (error) {
      const interrupted=isInterrupted(error,abortController.signal);
      const failure=safeError(error);
      if (assistantMessage) {
        await repository.updateMessage(assistantMessage.id,{
          content,
          status:interrupted?'interrupted':'failed',
          errorCode:failure.code,
          errorMessage:failure.message
        }).catch(()=>{});
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort',externalAbort);
      if (activeTurns.get(lockKey)===lock) activeTurns.delete(lockKey);
    }
  }

  async function interrupt(projectId,turnId) {
    requireUsable();
    const active=activeTurns.get(projectLockKey(projectId));
    if (!active||active.turnId!==turnId) throw serviceError('TURN_NOT_ACTIVE','The requested turn is not active');
    active.abortController.abort();
    if (!active.provider) return {status:'interrupted'};
    try {
      await providers[active.provider].interruptTurn(turnId);
    } catch (error) {
      if (!String(error?.code||'').match(/NOT_FOUND|TURN_FAILED/)) throw error;
    }
    return {status:'interrupted'};
  }

  async function applyProposal({projectId,proposalId,changeIndexes}={}) {
    requireUsable();
    return db.transaction(async(client)=>{
      const proposal=await selectOne(client,
        'SELECT * FROM selection_ai_proposals WHERE id=$1 FOR UPDATE',[proposalId]
      );
      if (!proposal||Number(proposal.project_id)!==Number(projectId)) {
        throw serviceError('PROPOSAL_NOT_FOUND','Proposal does not exist');
      }
      if (proposal.status!=='pending') {
        throw serviceError('PROPOSAL_NOT_PENDING','Proposal is no longer pending');
      }
      const document=await selectOne(client,
        'SELECT * FROM selection_documents WHERE project_id=$1 FOR UPDATE',[projectId]
      );
      if (!document||Number(document.version)!==Number(proposal.base_document_version)) {
        throw serviceError('PROPOSAL_CONFLICT','Selection document changed after this proposal was created');
      }
      const storedChanges=Array.isArray(proposal.changes)?proposal.changes:JSON.parse(proposal.changes||'[]');
      const indexes=normalizeIndexes(changeIndexes,storedChanges.length);
      const selected=indexes.map((index)=>validateSelectedChange(storedChanges[index],document));
      const documentValues=new Map();
      const siteValues=new Map();
      for (const change of selected) {
        if (change.scope==='document') documentValues.set(change.field,change.after);
        else {
          const fields=siteValues.get(change.country_code)||new Map();
          fields.set(change.field,change.after);
          siteValues.set(change.country_code,fields);
        }
      }

      const updatedAt=new Date().toISOString();
      const fields=[...documentValues.keys()];
      const values=fields.map((field)=>JSON_DOCUMENT_FIELDS.has(field)
        ? JSON.stringify(documentValues.get(field))
        : documentValues.get(field)
      );
      const assignments=fields.map((field,index)=>
        `${field}=$${index+1}${JSON_DOCUMENT_FIELDS.has(field)?'::jsonb':''}`
      );
      assignments.push('version=version+1',`updated_at=$${values.length+1}`);
      await client.query(
        `UPDATE selection_documents SET ${assignments.join(',')} WHERE project_id=$${values.length+2}`,
        [...values,updatedAt,projectId]
      );

      for (const [countryCode,fieldMap] of siteValues) {
        const siteFields=[...fieldMap.keys()];
        const siteParams=[projectId,countryCode,...siteFields.map((field)=>fieldMap.get(field)),updatedAt];
        const columns=['project_id','country_code',...siteFields,'updated_at'];
        const placeholders=columns.map((_,index)=>`$${index+1}`);
        const updates=[...siteFields.map((field,index)=>`${field}=$${index+3}`),`updated_at=$${siteParams.length}`];
        await client.query(
          `INSERT INTO selection_site_assessments (${columns.join(',')}) VALUES (${placeholders.join(',')})
           ON CONFLICT (project_id,country_code) DO UPDATE SET ${updates.join(',')}`,
          siteParams
        );
      }

      return repository.resolveProposal(proposalId,'applied',selected,client);
    });
  }

  async function rejectProposal(projectId,proposalId) {
    requireUsable();
    return db.transaction(async(client)=>{
      const proposal=await selectOne(client,
        'SELECT * FROM selection_ai_proposals WHERE id=$1 FOR UPDATE',[proposalId]
      );
      if (!proposal||Number(proposal.project_id)!==Number(projectId)) {
        throw serviceError('PROPOSAL_NOT_FOUND','Proposal does not exist');
      }
      if (proposal.status!=='pending') {
        throw serviceError('PROPOSAL_NOT_PENDING','Proposal is no longer pending');
      }
      return repository.resolveProposal(proposalId,'rejected',[],client);
    });
  }

  async function clear(projectId) {
    requireUsable();
    if (activeTurns.has(projectLockKey(projectId))) throw serviceError('TURN_ALREADY_ACTIVE','A turn is already active for this project');
    return repository.clear(projectId);
  }

  function dispose() {
    if (disposed) return;
    disposed=true;
    for (const active of activeTurns.values()) {
      active.abortController.abort();
      if (active.provider) Promise.resolve(providers[active.provider].interruptTurn(active.turnId)).catch(()=>{});
    }
    activeTurns.clear();
    providers.codex.dispose();
    providers.openai.dispose();
  }

  return {getState,health,setProvider,streamTurn,interrupt,applyProposal,rejectProposal,clear,dispose};
}

function createDefaultSelectionAiService({db,loadPayload}) {
  return createSelectionAiService({
    db,
    loadPayload,
    repository:createSelectionAiRepository(db),
    providers:{codex:createCodexProvider(),openai:createOpenAiProvider()}
  });
}

module.exports={createSelectionAiService,createDefaultSelectionAiService};
