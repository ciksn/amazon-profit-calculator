'use strict';

const {spawn}=require('node:child_process');
const readline=require('node:readline');
const {OUTPUT_SCHEMA}=require('../contracts');
const {createStructuredAnswerStream}=require('../structured-stream');

function providerError(code,message) {
  return Object.assign(new Error(message),{code});
}

function createNotificationQueue() {
  const values=[];
  const waiters=[];
  return {
    push(value) {
      const waiter=waiters.shift();
      if (waiter) waiter(value);
      else values.push(value);
    },
    next() {
      if (values.length) return Promise.resolve(values.shift());
      return new Promise((resolve)=>waiters.push(resolve));
    }
  };
}

function createCodexProvider({spawnProcess=spawn,command='codex',timeoutMs=10000}={}) {
  let child=null;
  let lines=null;
  let initialization=null;
  let disposed=false;
  let nextRequestId=1;
  const pending=new Map();
  const threadSubscribers=new Map();
  const activeTurns=new Map();

  function failPending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const subscribers of threadSubscribers.values()) {
      for (const subscriber of subscribers) subscriber({internalError:error});
    }
  }

  function route(message) {
    if (message && message.id!==undefined) {
      const request=pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(providerError(request.errorCode,request.errorMessage));
      else request.resolve(message.result);
      return;
    }
    const threadId=message?.params?.threadId||message?.params?.thread?.id;
    if (!threadId) return;
    for (const subscriber of threadSubscribers.get(threadId)||[]) subscriber(message);
  }

  function write(message) {
    if (!child?.stdin) throw providerError('CODEX_START_FAILED','Codex app server is unavailable');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method,params,errorCode,errorMessage,requestTimeout=timeoutMs) {
    const id=nextRequestId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        pending.delete(id);
        reject(providerError(errorCode,errorMessage));
      },requestTimeout);
      pending.set(id,{resolve,reject,timer,errorCode,errorMessage});
      try {
        write({id,method,params});
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function startProcess() {
    if (child) return;
    if (disposed) throw providerError('CODEX_START_FAILED','Codex Provider has been disposed');
    try {
      child=spawnProcess(command,['app-server','--listen','stdio://'],{
        stdio:['pipe','pipe','pipe'],
        windowsHide:true
      });
    } catch (error) {
      child=null;
      if (error?.code==='ENOENT') throw providerError('CODEX_NOT_INSTALLED','Codex executable is not installed');
      throw providerError('CODEX_START_FAILED','Codex app server could not be started');
    }

    lines=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
    lines.on('line',(line)=>{
      try { route(JSON.parse(line)); } catch { /* Ignore non-JSON diagnostics on stdout. */ }
    });
    child.stderr?.on('data',()=>{});
    child.once('error',(error)=>{
      const failure=error?.code==='ENOENT'
        ? providerError('CODEX_NOT_INSTALLED','Codex executable is not installed')
        : providerError('CODEX_START_FAILED','Codex app server could not be started');
      failPending(failure);
    });
    child.once('exit',()=>{
      if (!disposed) failPending(providerError('CODEX_START_FAILED','Codex app server exited unexpectedly'));
    });
  }

  async function initialize() {
    if (initialization) return initialization;
    initialization=(async()=>{
      startProcess();
      await request('initialize',{
        clientInfo:{name:'amazon-global-margin',version:'0.1.0'},
        capabilities:{}
      },'CODEX_TIMEOUT','Codex app server initialization timed out');
      write({method:'initialized',params:{}});
    })();
    return initialization;
  }

  async function health() {
    await initialize();
    return {ok:true};
  }

  async function startOrResumeConversation(state={}) {
    await initialize();
    const savedThreadId=state?.codex_thread_id;
    const method=savedThreadId?'thread/resume':'thread/start';
    const params=savedThreadId?{threadId:savedThreadId}:{};
    const result=await request(method,params,'CODEX_START_FAILED','Codex conversation could not be started');
    const threadId=result?.thread?.id||savedThreadId;
    if (!threadId) throw providerError('CODEX_START_FAILED','Codex conversation did not return a thread');
    return {codex_thread_id:threadId};
  }

  async function* streamTurn({state={},system='',input=''}) {
    const providerState=await startOrResumeConversation(state);
    const threadId=providerState.codex_thread_id;
    const queue=createNotificationQueue();
    const subscriber=(message)=>queue.push(message);
    const subscribers=threadSubscribers.get(threadId)||new Set();
    subscribers.add(subscriber);
    threadSubscribers.set(threadId,subscribers);
    let turnId;
    try {
      const result=await request('turn/start',{
        threadId,
        input:[{type:'text',text:`${system}\n\n${input}`}],
        approvalPolicy:'never',
        sandboxPolicy:{
          type:'readOnly',
          access:{type:'restricted',includePlatformDefaults:true,readableRoots:[]},
          networkAccess:false
        },
        outputSchema:OUTPUT_SCHEMA,
        summary:'concise'
      },'CODEX_TURN_FAILED','Codex turn could not be started');
      turnId=result?.turn?.id;
      if (!turnId) throw providerError('CODEX_TURN_FAILED','Codex turn did not return an ID');
      activeTurns.set(turnId,threadId);
      const parser=createStructuredAnswerStream();

      while (true) {
        const message=await queue.next();
        if (message.internalError) throw message.internalError;
        if (message?.params?.turnId!==turnId && message?.params?.turn?.id!==turnId) continue;
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
    } finally {
      subscribers.delete(subscriber);
      if (!subscribers.size) threadSubscribers.delete(threadId);
      if (turnId) activeTurns.delete(turnId);
    }
  }

  async function interruptTurn(turnId) {
    const threadId=activeTurns.get(turnId);
    if (!threadId) throw providerError('CODEX_TURN_FAILED','Codex turn is not active');
    await request('turn/interrupt',{threadId,turnId},'CODEX_TURN_FAILED','Codex turn could not be interrupted');
    return {status:'interrupted'};
  }

  function dispose() {
    if (disposed) return;
    disposed=true;
    const failure=providerError('CODEX_START_FAILED','Codex Provider was disposed');
    failPending(failure);
    lines?.close();
    child?.stdin?.end?.();
    child?.kill?.();
  }

  return {health,startOrResumeConversation,streamTurn,interruptTurn,dispose};
}

module.exports={createCodexProvider};
