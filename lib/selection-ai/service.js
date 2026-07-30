'use strict';

const crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {createSelectionAiRepository}=require('./repository');
const {createCodexProvider}=require('./providers/codex');
const {createOpenAiProvider}=require('./providers/openai');
const {resolveCodexCommand}=require('./codex-command');
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
const ERROR_MESSAGES={
  TURN_ALREADY_ACTIVE:'该品类已有进行中的 AI 对话',
  TURN_NOT_ACTIVE:'指定的 AI 对话不在进行中',
  TURN_INTERRUPTED:'AI 对话已中断',
  SERVICE_DISPOSED:'AI 服务已关闭',
  PROJECT_NOT_FOUND:'品类不存在',
  AI_RESPONSE_INVALID:'AI 返回内容无效',
  PROPOSAL_NOT_FOUND:'提案不存在',
  PROPOSAL_NOT_PENDING:'提案已处理',
  PROPOSAL_CONFLICT:'选品文档已更新，请刷新后重试',
  PROPOSAL_CHANGE_INVALID:'提案修改无效',
  PROPOSAL_INVALID:'提案无效',
  CODEX_NOT_INSTALLED:'Codex 未安装',
  CODEX_START_FAILED:'Codex 启动失败',
  CODEX_TIMEOUT:'Codex 请求超时',
  CODEX_TURN_FAILED:'Codex 对话失败',
  CODEX_TURN_INTERRUPTED:'Codex 对话已中断',
  OPENAI_NOT_CONFIGURED:'OpenAI 未配置',
  OPENAI_REQUEST_FAILED:'OpenAI 请求失败',
  OPENAI_RESPONSE_INVALID:'OpenAI 返回内容无效',
  OPENAI_INTERRUPTED:'OpenAI 对话已中断',
  OPENAI_TURN_ACTIVE:'OpenAI 对话已在进行中',
  OPENAI_TURN_NOT_FOUND:'OpenAI 对话不存在'
};
const INTERNAL_ERROR_MESSAGE='内部错误，请稍后重试';

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
  const code=typeof error?.code==='string'?error.code:'';
  if (Object.hasOwn(ERROR_MESSAGES,code)) {
    const safe=serviceError(code,ERROR_MESSAGES[code]);
    return {code,message:safe.message,error:safe};
  }
  const safe=serviceError('INTERNAL_ERROR',INTERNAL_ERROR_MESSAGE);
  return {code:safe.code,message:safe.message,error:safe};
}

function providerHealthStatus(code) {
  if (code==='CODEX_NOT_INSTALLED') return 'not_installed';
  if (code==='OPENAI_NOT_CONFIGURED') return 'not_configured';
  return 'unavailable';
}

async function probeProviderHealth(provider) {
  try {
    const state=await provider.health();
    return {status:'ready',...state,ok:state?.ok!==false};
  } catch (error) {
    const failure=safeError(error);
    return {
      ok:false,
      status:providerHealthStatus(failure.code),
      code:failure.code,
      error:failure.message
    };
  }
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
  if (value.length>100||current.length>100) {
    throw serviceError('PROPOSAL_INVALID','Review issue list cannot exceed 100 entries');
  }
  if (value.length!==current.length) {
    throw serviceError('PROPOSAL_INVALID','Review issue cardinality cannot be changed');
  }
  return value.map((item,index)=>{
    const existingRatio=Number(current[index]?.ratio);
    return {
      issue:safeText(item?.issue,1000),
      ratio:Number.isFinite(existingRatio)?existingRatio:0,
      solution:safeText(item?.solution,1000)
    };
  });
}

function omitOversizedReviewChanges(raw) {
  const proposal=raw?.proposal||raw;
  if (!proposal||typeof proposal!=='object'||!Array.isArray(proposal.changes)) return raw;
  const changes=proposal.changes.filter((change)=>{
    if (change?.scope!=='document'||change.field!=='review_issues'||typeof change.value!=='string') return true;
    if (change.value.length>10000) return false;
    try {
      const value=JSON.parse(change.value);
      return !Array.isArray(value)||value.length<=100;
    } catch {
      return true;
    }
  });
  const filtered={...proposal,changes};
  return raw?.proposal?{...raw,proposal:filtered}:filtered;
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
  const proposal=normalizeProposal(omitOversizedReviewChanges(raw),payload);
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
  if (!isDeepStrictEqual(actual,expected)) {
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

function throwIfAborted(signal) {
  if (signal.aborted) throw serviceError('TURN_INTERRUPTED','AI turn was interrupted');
}

function assertUniqueTargets(changes) {
  const targets=new Set();
  for (const change of changes) {
    const target=`${change.scope}\u0000${change.country_code}\u0000${change.field}`;
    if (targets.has(target)) throw serviceError('PROPOSAL_INVALID','Proposal contains duplicate target fields');
    targets.add(target);
  }
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

  async function requireProject(projectId) {
    if (!await repository.projectExists(projectId)) {
      throw serviceError('PROJECT_NOT_FOUND','Project does not exist');
    }
  }

  async function getState(projectId) {
    requireUsable();
    await requireProject(projectId);
    return repository.getState(projectId);
  }

  async function health(projectId,{providers:requestedProviders=['codex','openai']}={}) {
    requireUsable();
    await requireProject(projectId);
    const state=await repository.getState(projectId);
    const provider=validateProvider(state.conversation.active_provider);
    const providerNames=[...new Set(requestedProviders.map(validateProvider))];
    const healthEntries=await Promise.all(providerNames.map(async(name)=>[
      name,await probeProviderHealth(providers[name])
    ]));
    return {active_provider:provider,providers:Object.fromEntries(healthEntries)};
  }

  async function setProvider(projectId,provider) {
    requireUsable();
    await requireProject(projectId);
    if (activeTurns.has(projectLockKey(projectId))) throw serviceError('TURN_ALREADY_ACTIVE','A turn is already active for this project');
    return repository.setProvider(projectId,validateProvider(provider));
  }

  async function* streamTurn({projectId,chapter='overview',message='',signal}={}) {
    requireUsable();
    await requireProject(projectId);
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
    let terminalPersisted=false;
    let providerStarted=false;
    let providerIterator=null;
    let providerIteratorDone=false;

    try {
      yield {type:'status',status:'started',turnId};
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
      throwIfAborted(abortController.signal);

      const payload=await loadPayload(projectId);
      throwIfAborted(abortController.signal);
      if (!payload) throw serviceError('PROJECT_NOT_FOUND','Project does not exist');
      const messages=await repository.listRecentMessages(projectId,200);
      throwIfAborted(abortController.signal);
      let summary=initialState.conversation.summary||'';
      if (messages.length>20) {
        summary=deterministicSummary(messages);
        await repository.setSummary(projectId,summary);
        throwIfAborted(abortController.signal);
      }
      const context=buildSelectionAiContext({payload,chapter,messages,summary});
      throwIfAborted(abortController.signal);
      let persistedLength=0;
      let completion=null;

      throwIfAborted(abortController.signal);
      providerStarted=true;
      const providerStream=provider.streamTurn({
        state:initialState.conversation,
        system:context.system,
        input:context.input,
        turnId,
        signal:abortController.signal
      });
      providerIterator=providerStream[Symbol.asyncIterator]();
      while (true) {
        const step=await providerIterator.next();
        if (step.done) {
          providerIteratorDone=true;
          break;
        }
        const event=step.value;
        if (event?.type==='text_delta') {
          const delta=String(event.delta??'');
          content+=delta;
          if (content.length-persistedLength>=MESSAGE_BATCH_LENGTH) {
            await repository.updateMessage(assistantMessage.id,{content});
            persistedLength=content.length;
          }
          yield {type:'text_delta',delta,turnId};
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
      const {completedMessage,savedProposal}=await db.transaction(async(client)=>{
        const transactionProposal=proposal?await repository.createProposal({
          projectId,
          messageId:assistantMessage.id,
          baseDocumentVersion:context.snapshotVersion,
          changes:proposal.changes
        },client):null;
        const transactionMessage=await repository.updateMessage(assistantMessage.id,{
          content,status:'completed',errorCode:'',errorMessage:''
        },client);
        return {completedMessage:transactionMessage,savedProposal:transactionProposal};
      });
      terminalPersisted=true;
      if (savedProposal) yield {type:'proposal',proposal:savedProposal,turnId};
      yield {
        type:'completed',
        result:{answer:content,proposal},
        message:completedMessage,
        proposal:savedProposal,
        turnId
      };
    } catch (error) {
      const interrupted=isInterrupted(error,abortController.signal);
      const failure=interrupted&&error?.code!=='TURN_INTERRUPTED'
        ? safeError(serviceError('TURN_INTERRUPTED','AI turn was interrupted'))
        : safeError(error);
      if (assistantMessage) {
        await repository.updateMessage(assistantMessage.id,{
          content,
          status:interrupted?'interrupted':'failed',
          errorCode:failure.code,
          errorMessage:failure.message
        }).catch(()=>{});
      }
      terminalPersisted=true;
      throw failure.error;
    } finally {
      if (signal&&externalAbort) signal.removeEventListener('abort',externalAbort);
      if (providerIterator&&!providerIteratorDone) {
        abortController.abort();
        if (providerStarted&&provider) {
          await Promise.resolve(provider.interruptTurn(turnId)).catch(()=>{});
        }
        if (providerIterator?.return) {
          await Promise.resolve(providerIterator.return()).catch(()=>{});
        }
        providerIteratorDone=true;
      }
      if (!terminalPersisted&&assistantMessage) {
        await repository.updateMessage(assistantMessage.id,{
          content,
          status:'interrupted',
          errorCode:'TURN_INTERRUPTED',
          errorMessage:ERROR_MESSAGES.TURN_INTERRUPTED
        }).catch(()=>{});
      }
      if (activeTurns.get(lockKey)===lock) activeTurns.delete(lockKey);
    }
  }

  async function interrupt(projectId,turnId) {
    requireUsable();
    await requireProject(projectId);
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
    await requireProject(projectId);
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
      assertUniqueTargets(selected);
      const documentValues=new Map();
      const siteValues=new Map();
      for (const change of selected) {
        if (change.scope==='document') documentValues.set(change.field,change.after);
        else {
          const fields=siteValues.get(change.country_code)||new Map();
          fields.set(change.field,{before:change.before,after:change.after});
          siteValues.set(change.country_code,fields);
        }
      }

      for (const [countryCode,fieldMap] of siteValues) {
        const currentSite=await selectOne(client,
          'SELECT * FROM selection_site_assessments WHERE project_id=$1 AND country_code=$2 FOR UPDATE',
          [projectId,countryCode]
        );
        for (const [field,value] of fieldMap) {
          const currentValue=currentSite?currentSite[field]:'';
          if (!isDeepStrictEqual(currentValue,value.before)) {
            throw serviceError('PROPOSAL_CONFLICT','Site assessment changed after this proposal was created');
          }
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
      const documentUpdate=await client.query(
        `UPDATE selection_documents SET ${assignments.join(',')}
         WHERE project_id=$${values.length+2} AND version=$${values.length+3} RETURNING *`,
        [...values,updatedAt,projectId,proposal.base_document_version]
      );
      if (!documentUpdate.rowCount) {
        throw serviceError('PROPOSAL_CONFLICT','Selection document changed after this proposal was created');
      }

      for (const [countryCode,fieldMap] of siteValues) {
        const siteFields=[...fieldMap.keys()];
        const siteParams=[
          projectId,countryCode,
          ...siteFields.map((field)=>fieldMap.get(field).after),
          updatedAt,
          ...siteFields.map((field)=>fieldMap.get(field).before)
        ];
        const columns=['project_id','country_code',...siteFields,'updated_at'];
        const placeholders=columns.map((_,index)=>`$${index+1}`);
        const updatedAtIndex=siteFields.length+3;
        const beforeStartIndex=siteFields.length+4;
        const updates=[...siteFields.map((field,index)=>`${field}=$${index+3}`),`updated_at=$${updatedAtIndex}`];
        const predicates=siteFields.map((field,index)=>
          `selection_site_assessments.${field}=$${beforeStartIndex+index}`
        );
        const siteUpdate=await client.query(
          `INSERT INTO selection_site_assessments (${columns.join(',')}) VALUES (${placeholders.join(',')})
           ON CONFLICT (project_id,country_code) DO UPDATE SET ${updates.join(',')}
           WHERE ${predicates.join(' AND ')} RETURNING *`,
          siteParams
        );
        if (!siteUpdate.rowCount) {
          throw serviceError('PROPOSAL_CONFLICT','Site assessment changed after this proposal was created');
        }
      }

      return repository.resolveProposal(proposalId,'applied',selected,client);
    });
  }

  async function rejectProposal(projectId,proposalId) {
    requireUsable();
    await requireProject(projectId);
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
    await requireProject(projectId);
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

function selectionAiProviderConfig(env=process.env) {
  const configuredTimeout=Number(env.CODEX_AI_TIMEOUT_MS);
  const retryGraceText=String(env.CODEX_AI_RETRY_GRACE_MS||'').trim();
  const configuredRetryGrace=Number(retryGraceText);
  return {
    codex:{
      command:resolveCodexCommand({env}),
      timeoutMs:Number.isFinite(configuredTimeout)&&configuredTimeout>0
        ? Math.min(Math.max(configuredTimeout,1_000),600_000)
        : 120_000,
      retryGraceMs:retryGraceText&&Number.isFinite(configuredRetryGrace)&&configuredRetryGrace>=0
        ? Math.min(configuredRetryGrace,120_000)
        : 30_000
    }
  };
}

function createDefaultSelectionAiService({db,loadPayload}) {
  const config=selectionAiProviderConfig();
  return createSelectionAiService({
    db,
    loadPayload,
    repository:createSelectionAiRepository(db),
    providers:{codex:createCodexProvider(config.codex),openai:createOpenAiProvider()}
  });
}

module.exports={createSelectionAiService,createDefaultSelectionAiService,selectionAiProviderConfig};
