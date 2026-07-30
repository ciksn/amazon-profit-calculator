'use strict';

const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {OUTPUT_SCHEMA}=require('../contracts');
const {createStructuredAnswerStream}=require('../structured-stream');

class ProviderError extends Error {
  constructor(code,message) {
    super(message);
    this.code=code;
  }
}

function providerError(code,message) {
  return new ProviderError(code,message);
}

function createNotificationQueue() {
  const values=[];
  const waiters=[];
  let closedError=null;

  function remove(waiter) {
    const index=waiters.indexOf(waiter);
    if (index>=0) waiters.splice(index,1);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort',waiter.onAbort);
  }

  return {
    push(value) {
      if (closedError) return;
      const waiter=waiters.shift();
      if (!waiter) {
        values.push(value);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.signal?.removeEventListener('abort',waiter.onAbort);
      waiter.resolve(value);
    },
    next({timeoutMs,signal}) {
      if (signal?.aborted) {
        return Promise.reject(providerError('CODEX_TURN_INTERRUPTED','Codex turn was interrupted'));
      }
      if (closedError) return Promise.reject(closedError);
      if (values.length) return Promise.resolve(values.shift());
      return new Promise((resolve,reject)=>{
        const waiter={resolve,reject,signal,timer:null,onAbort:null};
        waiter.onAbort=()=>{
          remove(waiter);
          reject(providerError('CODEX_TURN_INTERRUPTED','Codex turn was interrupted'));
        };
        waiter.timer=setTimeout(()=>{
          remove(waiter);
          reject(providerError('CODEX_TIMEOUT','Codex turn timed out waiting for completion'));
        },Math.max(0,timeoutMs));
        signal?.addEventListener('abort',waiter.onAbort,{once:true});
        waiters.push(waiter);
      });
    },
    close(error) {
      if (closedError) return;
      closedError=error;
      for (const waiter of [...waiters]) {
        remove(waiter);
        waiter.reject(error);
      }
      values.length=0;
    }
  };
}

function createTurnRecord() {
  return {settled:false,mapping:null,error:null,waiters:[]};
}

function settleTurnRecord(record,{mapping=null,error=null}) {
  if (record.settled) return;
  record.settled=true;
  record.mapping=mapping;
  record.error=error;
  for (const waiter of record.waiters) {
    if (error) waiter.reject(error);
    else waiter.resolve(mapping);
  }
  record.waiters.length=0;
}

function waitForTurnRecord(record) {
  if (record.settled) {
    return record.error?Promise.reject(record.error):Promise.resolve(record.mapping);
  }
  return new Promise((resolve,reject)=>record.waiters.push({resolve,reject}));
}

function awaitWithSignal(promise,signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(providerError('CODEX_TURN_INTERRUPTED','Codex turn was interrupted'));
  }
  return new Promise((resolve,reject)=>{
    const onAbort=()=>{
      signal.removeEventListener('abort',onAbort);
      reject(providerError('CODEX_TURN_INTERRUPTED','Codex turn was interrupted'));
    };
    signal.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(promise).then(
      (value)=>{ signal.removeEventListener('abort',onAbort); resolve(value); },
      (error)=>{ signal.removeEventListener('abort',onAbort); reject(error); }
    );
  });
}

function createCodexProvider({
  spawnProcess=spawn,command='codex',timeoutMs=10000,retryGraceMs=30000
}={}) {
  const boundedRetryGraceMs=Number.isFinite(retryGraceMs)&&retryGraceMs>=0
    ? Math.min(retryGraceMs,120000)
    : 30000;
  let transport=null;
  let initialization=null;
  let disposed=false;
  let nextRequestId=1;
  const pending=new Map();
  const threadSubscribers=new Map();
  const publicTurns=new Map();

  function invalidateTransport(target,error) {
    if (!target||target.dead) return;
    target.dead=true;

    for (const [id,request] of pending) {
      if (request.transport!==target) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(error);
    }
    for (const subscribers of threadSubscribers.values()) {
      for (const subscriber of subscribers) subscriber({internalError:error});
    }
    threadSubscribers.clear();
    for (const record of publicTurns.values()) settleTurnRecord(record,{error});
    publicTurns.clear();

    if (transport===target) {
      transport=null;
      initialization=null;
    }
    target.lines?.close();
    try { target.child.stdin?.end?.(); } catch { /* Transport is already failed. */ }
    try { target.child.kill?.(); } catch { /* Transport is already failed. */ }
  }

  function serverRequestResponse(message) {
    switch (message.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return {id:message.id,result:{decision:'decline'}};
      case 'mcpServer/elicitation/request':
        return {id:message.id,result:{action:'decline'}};
      case 'item/tool/call':
        return {
          id:message.id,
          result:{
            success:false,
            contentItems:[{type:'inputText',text:'Client tool requests are not supported'}]
          }
        };
      case 'applyPatchApproval':
      case 'execCommandApproval':
        return {id:message.id,result:{decision:'denied'}};
      default:
        return {
          id:message.id,
          error:{code:-32601,message:'Codex server request is not supported'}
        };
    }
  }

  function route(target,message) {
    if (message&&message.id!==undefined&&typeof message.method==='string') {
      if (transport!==target||target.dead) return;
      write(target,serverRequestResponse(message));
      return;
    }
    if (message&&message.id!==undefined) {
      const request=pending.get(message.id);
      if (!request||request.transport!==target) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(providerError(request.errorCode,request.errorMessage));
      else request.resolve(message.result);
      return;
    }
    if (transport!==target||target.dead) return;
    const threadId=message?.params?.threadId||message?.params?.thread?.id;
    if (!threadId) return;
    for (const subscriber of threadSubscribers.get(threadId)||[]) subscriber(message);
  }

  function startProcess() {
    if (transport&&!transport.dead) return transport;
    if (disposed) throw providerError('CODEX_START_FAILED','Codex Provider has been disposed');
    let child;
    try {
      child=spawnProcess(command,['app-server','--listen','stdio://'],{
        stdio:['pipe','pipe','pipe'],windowsHide:true
      });
    } catch (error) {
      if (error?.code==='ENOENT') throw providerError('CODEX_NOT_INSTALLED','Codex executable is not installed');
      throw providerError('CODEX_START_FAILED','Codex app server could not be started');
    }

    const target={child,lines:null,dead:false};
    transport=target;
    const failStart=(error)=>{
      const failure=error?.code==='ENOENT'
        ? providerError('CODEX_NOT_INSTALLED','Codex executable is not installed')
        : providerError('CODEX_START_FAILED','Codex app server transport failed');
      invalidateTransport(target,failure);
    };
    const failStdout=()=>invalidateTransport(
      target,providerError('CODEX_START_FAILED','Codex app server output transport closed')
    );
    try {
      target.lines=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
      target.lines.on('line',(line)=>{
        try { route(target,JSON.parse(line)); } catch { /* Ignore non-JSON diagnostics. */ }
      });
      target.lines.on('error',failStdout);
      target.lines.once('close',failStdout);
      child.stdout?.on?.('error',failStdout);
      child.stdout?.once?.('end',failStdout);
      child.stderr?.on('data',()=>{});
      child.stdin?.on?.('error',failStart);
      child.once('error',failStart);
      child.once('exit',()=>{
        if (!disposed) invalidateTransport(
          target,providerError('CODEX_START_FAILED','Codex app server exited unexpectedly')
        );
      });
    } catch {
      const failure=providerError('CODEX_START_FAILED','Codex app server transport could not be initialized');
      invalidateTransport(target,failure);
      throw failure;
    }
    return target;
  }

  function write(target,message) {
    if (!target||target.dead||transport!==target||!target.child.stdin) {
      throw providerError('CODEX_START_FAILED','Codex app server is unavailable');
    }
    try {
      target.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      const failure=providerError('CODEX_START_FAILED','Codex app server transport failed');
      invalidateTransport(target,failure);
      throw failure;
    }
  }

  function request(method,params,errorCode,errorMessage,requestTimeout=timeoutMs) {
    const target=transport;
    if (!target||target.dead) return Promise.reject(providerError('CODEX_START_FAILED','Codex app server is unavailable'));
    const id=nextRequestId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        pending.delete(id);
        reject(providerError(errorCode,errorMessage));
      },requestTimeout);
      pending.set(id,{resolve,reject,timer,errorCode,errorMessage,transport:target});
      try { write(target,{id,method,params}); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof ProviderError
          ? error
          : providerError('CODEX_START_FAILED','Codex app server transport failed'));
      }
    });
  }

  function interruptServerTurnBestEffort(threadId,serverTurnId) {
    if (!threadId||!serverTurnId) return;
    request('turn/interrupt',{threadId,turnId:serverTurnId},
      'CODEX_TURN_FAILED','Codex turn could not be interrupted').catch(()=>{});
  }

  async function initialize() {
    if (initialization) return initialization;
    const task=(async()=>{
      const target=startProcess();
      try {
        await request('initialize',{
          clientInfo:{name:'amazon-global-margin',version:'0.1.0'},capabilities:{}
        },'CODEX_TIMEOUT','Codex app server initialization timed out');
        write(target,{method:'initialized',params:{}});
      } catch (error) {
        const failure=error instanceof ProviderError
          ? error
          : providerError('CODEX_START_FAILED','Codex app server could not be initialized');
        invalidateTransport(target,failure);
        throw failure;
      }
    })();
    initialization=task;
    task.catch(()=>{ if (initialization===task) initialization=null; });
    return task;
  }

  async function health() {
    await initialize();
    return {ok:true};
  }

  async function startOrResumeConversation(state={},options={}) {
    await initialize();
    const savedThreadId=state?.codex_thread_id;
    const developerInstructions=typeof options.developerInstructions==='string'
      ? options.developerInstructions
      : '';
    const result=await request(
      savedThreadId?'thread/resume':'thread/start',
      savedThreadId
        ? {threadId:savedThreadId,developerInstructions}
        : {developerInstructions},
      'CODEX_START_FAILED','Codex conversation could not be started'
    );
    const threadId=result?.thread?.id||savedThreadId;
    if (!threadId) throw providerError('CODEX_START_FAILED','Codex conversation did not return a thread');
    return {codex_thread_id:threadId};
  }

  async function* streamTurn({state={},system='',input='',turnId:publicTurnId,signal}={}) {
    if (typeof publicTurnId!=='string'||!publicTurnId) {
      throw providerError('CODEX_TURN_FAILED','Codex turn ID is required');
    }
    if (publicTurns.has(publicTurnId)) {
      throw providerError('CODEX_TURN_FAILED','Codex turn ID is already active');
    }
    if (signal?.aborted) throw providerError('CODEX_TURN_INTERRUPTED','Codex turn was interrupted');

    const record=createTurnRecord();
    publicTurns.set(publicTurnId,record);
    let subscribers=null;
    let subscriber=null;
    let queue=null;
    let threadId=null;
    let serverTurnId=null;
    let abortServerTurn=null;
    try {
      const providerState=await awaitWithSignal(
        startOrResumeConversation(state,{developerInstructions:system}),
        signal
      );
      threadId=providerState.codex_thread_id;
      queue=createNotificationQueue();
      subscriber=(message)=>queue.push(message);
      subscribers=threadSubscribers.get(threadId)||new Set();
      subscribers.add(subscriber);
      threadSubscribers.set(threadId,subscribers);

      const turnStart=request('turn/start',{
        threadId,
        input:[{type:'text',text:input}],
        approvalPolicy:'never',
        sandboxPolicy:{
          type:'readOnly',
          networkAccess:false
        },
        outputSchema:OUTPUT_SCHEMA,
        summary:'concise'
      },'CODEX_TURN_FAILED','Codex turn could not be started');
      let result;
      try {
        result=await awaitWithSignal(turnStart,signal);
      } catch (error) {
        if (error instanceof ProviderError&&error.code==='CODEX_TURN_INTERRUPTED') {
          turnStart.then((started)=>{
            const lateTurnId=started?.turn?.id;
            interruptServerTurnBestEffort(threadId,lateTurnId);
          }).catch(()=>{});
        }
        throw error;
      }
      serverTurnId=result?.turn?.id;
      if (!serverTurnId) throw providerError('CODEX_TURN_FAILED','Codex turn did not return an ID');
      settleTurnRecord(record,{mapping:{threadId,serverTurnId}});

      abortServerTurn=()=>{
        interruptServerTurnBestEffort(threadId,serverTurnId);
      };
      signal?.addEventListener('abort',abortServerTurn,{once:true});
      if (signal?.aborted) abortServerTurn();

      const parser=createStructuredAnswerStream();
      const baseDeadline=Date.now()+timeoutMs;
      const absoluteDeadline=baseDeadline+boundedRetryGraceMs;
      let deadline=baseDeadline;
      while (true) {
        const message=await queue.next({timeoutMs:deadline-Date.now(),signal});
        if (message.internalError) throw message.internalError;
        if (message?.params?.turnId!==serverTurnId&&message?.params?.turn?.id!==serverTurnId) continue;
        if (message.method==='error') {
          if (message.params?.willRetry===true) {
            deadline=Math.max(
              deadline,
              Math.min(absoluteDeadline,Date.now()+boundedRetryGraceMs)
            );
          }
          continue;
        }
        if (message.method==='item/agentMessage/delta') {
          let delta;
          try { delta=parser.push(message.params.delta); }
          catch { throw providerError('CODEX_TURN_FAILED','Codex returned invalid structured output'); }
          if (delta) yield {type:'text_delta',delta};
          continue;
        }
        if (message.method!=='turn/completed') continue;
        const status=message.params.turn?.status;
        if (status==='completed') {
          let completed;
          try { completed=parser.finish(); }
          catch { throw providerError('CODEX_TURN_FAILED','Codex returned invalid structured output'); }
          yield {type:'completed',result:completed,providerState};
          return;
        }
        if (status==='interrupted'||status==='canceled'||status==='cancelled') {
          throw providerError('CODEX_TURN_INTERRUPTED','Codex turn was interrupted');
        }
        throw providerError('CODEX_TURN_FAILED','Codex turn failed');
      }
    } catch (error) {
      const failure=error instanceof ProviderError
        ? error
        : providerError('CODEX_TURN_FAILED','Codex turn failed');
      if (failure.code==='CODEX_TIMEOUT') {
        interruptServerTurnBestEffort(threadId,serverTurnId);
      }
      settleTurnRecord(record,{error:failure});
      throw failure;
    } finally {
      signal?.removeEventListener('abort',abortServerTurn);
      if (subscribers&&subscriber) {
        subscribers.delete(subscriber);
        if (!subscribers.size) {
          for (const [threadId,current] of threadSubscribers) {
            if (current===subscribers) threadSubscribers.delete(threadId);
          }
        }
      }
      queue?.close(providerError('CODEX_TURN_FAILED','Codex turn ended'));
      if (!record.settled) {
        settleTurnRecord(record,{error:providerError('CODEX_TURN_FAILED','Codex turn ended')});
      }
      if (publicTurns.get(publicTurnId)===record) publicTurns.delete(publicTurnId);
    }
  }

  async function interruptTurn(publicTurnId) {
    const record=publicTurns.get(publicTurnId);
    if (!record) throw providerError('CODEX_TURN_FAILED','Codex turn is not active');
    const {threadId,serverTurnId}=await waitForTurnRecord(record);
    await request('turn/interrupt',{threadId,turnId:serverTurnId},
      'CODEX_TURN_FAILED','Codex turn could not be interrupted');
    return {status:'interrupted'};
  }

  function dispose() {
    if (disposed) return;
    disposed=true;
    const failure=providerError('CODEX_START_FAILED','Codex Provider was disposed');
    if (transport) invalidateTransport(transport,failure);
    else {
      for (const record of publicTurns.values()) settleTurnRecord(record,{error:failure});
      publicTurns.clear();
    }
    initialization=null;
  }

  return {health,startOrResumeConversation,streamTurn,interruptTurn,dispose};
}

module.exports={createCodexProvider};
