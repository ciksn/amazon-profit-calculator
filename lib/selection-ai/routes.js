'use strict';

const {CHAPTERS,validateProvider}=require('./contracts');

const NOT_FOUND_CODES=new Set(['PROJECT_NOT_FOUND','PROPOSAL_NOT_FOUND']);
const CONFLICT_CODES=new Set([
  'TURN_ALREADY_ACTIVE','TURN_NOT_ACTIVE','PROPOSAL_NOT_PENDING','PROPOSAL_CONFLICT'
]);
const BAD_REQUEST_CODES=new Set(['VALIDATION_ERROR','PROPOSAL_CHANGE_INVALID','PROPOSAL_INVALID']);

function validationError(message) {
  const error=new Error(message);
  error.code='VALIDATION_ERROR';
  error.statusCode=400;
  return error;
}

function errorPayload(error) {
  const code=typeof error?.code==='string'&&error.code ? error.code:'INTERNAL_ERROR';
  const message=code==='INTERNAL_ERROR'?'Internal server error':String(error?.message||'Request failed');
  return {code,error:message};
}

function errorStatus(error) {
  if (NOT_FOUND_CODES.has(error?.code)) return 404;
  if (CONFLICT_CODES.has(error?.code)) return 409;
  if (BAD_REQUEST_CODES.has(error?.code)) return 400;
  return Number(error?.statusCode)||500;
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
      const turnId=decodeURIComponent(interruptMatch[1]);
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
    if (res.headersSent) {
      if (!res.destroyed&&!res.writableEnded) {
        sseEvent(res,'error',errorPayload(error));
        res.end();
      }
      return true;
    }
    json(res,errorStatus(error),errorPayload(error));
    return true;
  }
}

module.exports={handleSelectionAiRequest};
