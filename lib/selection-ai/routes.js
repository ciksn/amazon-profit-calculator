'use strict';

const {CHAPTERS,validateProvider}=require('./contracts');

const INTERNAL_ERROR={status:500,code:'INTERNAL_ERROR',message:'Internal server error'};
const PUBLIC_ERRORS=Object.freeze({
  VALIDATION_ERROR:{status:400,message:'Invalid request'},
  PROJECT_NOT_FOUND:{status:404,message:'Project does not exist'},
  PROPOSAL_NOT_FOUND:{status:404,message:'Proposal does not exist'},
  TURN_ALREADY_ACTIVE:{status:409,message:'An AI turn is already active'},
  TURN_NOT_ACTIVE:{status:409,message:'The AI turn is not active'},
  TURN_INTERRUPTED:{status:409,message:'The AI turn was interrupted'},
  PROPOSAL_NOT_PENDING:{status:409,message:'The proposal is no longer pending'},
  PROPOSAL_CONFLICT:{status:409,message:'The selection document changed after this proposal was created'},
  PROPOSAL_CHANGE_INVALID:{status:400,message:'The proposal change is invalid'},
  PROPOSAL_INVALID:{status:400,message:'The proposal is invalid'},
  SERVICE_DISPOSED:{status:503,message:'The AI service is shutting down'},
  CODEX_NOT_INSTALLED:{status:503,message:'Codex is not installed'},
  CODEX_START_FAILED:{status:503,message:'Codex could not be started'},
  CODEX_TIMEOUT:{status:503,message:'Codex request timed out'},
  CODEX_TURN_FAILED:{status:502,message:'Codex turn failed'},
  CODEX_TURN_INTERRUPTED:{status:409,message:'Codex turn was interrupted'},
  OPENAI_NOT_CONFIGURED:{status:503,message:'OpenAI is not configured'},
  OPENAI_REQUEST_FAILED:{status:502,message:'OpenAI request failed'},
  OPENAI_RESPONSE_INVALID:{status:502,message:'OpenAI response was invalid'},
  OPENAI_INTERRUPTED:{status:409,message:'OpenAI turn was interrupted'},
  OPENAI_TURN_ACTIVE:{status:409,message:'An OpenAI turn is already active'},
  OPENAI_TURN_NOT_FOUND:{status:409,message:'The OpenAI turn is not active'},
  AI_RESPONSE_INVALID:{status:502,message:'AI response was invalid'}
});

function validationError(message) {
  const error=new Error(message);
  error.code='VALIDATION_ERROR';
  error.statusCode=400;
  return error;
}

function errorPayload(error) {
  const code=typeof error?.code==='string'&&Object.hasOwn(PUBLIC_ERRORS,error.code)
    ? error.code
    : INTERNAL_ERROR.code;
  const message=code===INTERNAL_ERROR.code?INTERNAL_ERROR.message:PUBLIC_ERRORS[code].message;
  return {code,error:message};
}

function errorStatus(error) {
  return typeof error?.code==='string'&&Object.hasOwn(PUBLIC_ERRORS,error.code)
    ? PUBLIC_ERRORS[error.code].status
    : INTERNAL_ERROR.status;
}

async function bodyFrom(req,readBody) {
  try {
    const body=await readBody(req);
    if (!body||typeof body!=='object'||Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw validationError('Request body must be valid JSON object');
  }
}

function sseEvent(res,type,payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function sendSelectionAiError({res,error,json}) {
  if (res.headersSent) {
    if (!res.destroyed&&!res.writableEnded) {
      sseEvent(res,'error',errorPayload(error));
      res.end();
    }
    return;
  }
  json(res,errorStatus(error),errorPayload(error));
}

function eventPayload(event) {
  const {type,...payload}=event||{};
  return {type,payload};
}

function providerHealth(value) {
  const provider=(value?.active_provider||value?.provider)==='openai'?'openai':'codex';
  const {provider:ignored,...activeHealth}=value||{};
  delete activeHealth.active_provider;
  delete activeHealth.providers;
  delete activeHealth.codex;
  delete activeHealth.openai;
  const providers={
    codex:value?.providers?.codex||value?.codex||(provider==='codex'?activeHealth:{status:'inactive'}),
    openai:value?.providers?.openai||value?.openai||(provider==='openai'?activeHealth:{status:'inactive'})
  };
  return {
    ...value,
    active_provider:provider,
    codex:providers.codex,
    openai:providers.openai,
    providers
  };
}

async function streamTurn({req,res,service,projectId,chapter,message}) {
  await service.getState(projectId);

  const abortController=new AbortController();
  let generating=true;
  const abortIfGenerating=()=>{ if (generating) abortController.abort(); };
  const onRequestClose=()=>{ if (!req.complete) abortIfGenerating(); };
  const onResponseClose=()=>{ if (!res.writableEnded) abortIfGenerating(); };
  req.on('close',onRequestClose);
  res.on('close',onResponseClose);

  const iterable=service.streamTurn({projectId,chapter,message,signal:abortController.signal});
  const iterator=iterable[Symbol.asyncIterator]();
  let first;
  try {
    first=await iterator.next();
  } catch (error) {
    generating=false;
    req.off('close',onRequestClose);
    res.off('close',onResponseClose);
    throw error;
  }

  res.writeHead(200,{
    'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'no-cache, no-transform',
    'Connection':'keep-alive',
    'X-Accel-Buffering':'no'
  });

  try {
    let step=first;
    while (!step.done) {
      const {type,payload}=eventPayload(step.value);
      if (typeof type==='string'&&type) sseEvent(res,type,payload);
      step=await iterator.next();
    }
  } catch (error) {
    if (!res.destroyed&&!res.writableEnded) sseEvent(res,'error',errorPayload(error));
  } finally {
    generating=false;
    req.off('close',onRequestClose);
    res.off('close',onResponseClose);
    if (!res.destroyed&&!res.writableEnded) res.end();
  }
}

async function handleSelectionAiRequest({req,res,url,service,readBody,json}) {
  const matched=url.pathname.match(/^\/api\/projects\/(\d+)\/selection-ai(?:\/(.*))?$/);
  if (!matched) return false;

  const projectId=Number(matched[1]);
  const path=matched[2]||'';
  const method=req.method;

  try {
    if (!path&&method==='GET') {
      json(res,200,await service.getState(projectId));
      return true;
    }
    if (path==='health'&&method==='GET') {
      json(res,200,providerHealth(await service.health(projectId)));
      return true;
    }
    if (path==='provider'&&method==='PUT') {
      const body=await bodyFrom(req,readBody);
      let provider;
      try { provider=validateProvider(body.provider); }
      catch { throw validationError('provider must be codex or openai'); }
      json(res,200,await service.setProvider(projectId,provider));
      return true;
    }
    if (path==='turns'&&method==='POST') {
      const body=await bodyFrom(req,readBody);
      if (typeof body.chapter!=='string'||!Object.hasOwn(CHAPTERS,body.chapter)) {
        throw validationError('chapter is invalid');
      }
      if (typeof body.message!=='string') throw validationError('message is required');
      const message=body.message.trim();
      if (!message||message.length>10000) {
        throw validationError('message must contain between 1 and 10000 characters');
      }
      await streamTurn({req,res,service,projectId,chapter:body.chapter,message});
      return true;
    }

    const interruptMatch=path.match(/^turns\/([^/]+)\/interrupt$/);
    if (interruptMatch&&method==='POST') {
      let turnId;
      try { turnId=decodeURIComponent(interruptMatch[1]); }
      catch { throw validationError('turnId encoding is invalid'); }
      if (!turnId) throw validationError('turnId is required');
      json(res,200,await service.interrupt(projectId,turnId));
      return true;
    }

    const proposalMatch=path.match(/^proposals\/(\d+)\/(apply|reject)$/);
    if (proposalMatch&&method==='POST') {
      const proposalId=Number(proposalMatch[1]);
      if (!Number.isSafeInteger(proposalId)||proposalId<=0) throw validationError('proposalId is invalid');
      if (proposalMatch[2]==='reject') {
        json(res,200,await service.rejectProposal(projectId,proposalId));
        return true;
      }
      const body=await bodyFrom(req,readBody);
      const indexes=body.change_indexes;
      if (!Array.isArray(indexes)||!indexes.every((index)=>Number.isInteger(index)&&index>=0)) {
        throw validationError('change_indexes must contain only non-negative integers');
      }
      json(res,200,await service.applyProposal({projectId,proposalId,changeIndexes:indexes}));
      return true;
    }

    if (path==='messages'&&method==='DELETE') {
      const body=await bodyFrom(req,readBody);
      if (body.confirm!==true) throw validationError('confirm must be true');
      await service.getState(projectId);
      await service.clear(projectId);
      json(res,200,{ok:true});
      return true;
    }

    json(res,404,{code:'NOT_FOUND',error:'Selection AI route not found'});
    return true;
  } catch (error) {
    sendSelectionAiError({res,error,json});
    return true;
  }
}

module.exports={handleSelectionAiRequest,sendSelectionAiError};
