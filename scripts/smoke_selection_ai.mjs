import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
  cleanupTemporaryProjects,
  codexSmokeTerminalTimeoutMs,
  createSmokeProjectName,
  runAllCleanupSteps,
  validateCodexHealth
} from './smoke_selection_ai_lib.mjs';

const require=createRequire(import.meta.url);
const db=require('../lib/db');
const {
  createDefaultSelectionAiService,
  selectionAiProviderConfig
}=require('../lib/selection-ai/service');
const {createServer,selectionDocumentPayload}=require('../server');

if (!String(process.env.DATABASE_URL||'').trim()) {
  throw new Error('smoke_selection_ai requires DATABASE_URL before it can create test data');
}

const codexConfig=selectionAiProviderConfig(process.env).codex;
const terminalTimeoutMs=codexSmokeTerminalTimeoutMs({
  baseTimeoutMs:codexConfig.timeoutMs,
  retryGraceMs:codexConfig.retryGraceMs,
  transportMarginMs:30_000
});
const projectName=createSmokeProjectName();
let projectId=null;
let baseUrl='';
let cleanupConfirmed=false;
let primaryError=null;

const service=createDefaultSelectionAiService({db,loadPayload:selectionDocumentPayload});
const server=createServer({selectionAiService:service});

async function jsonRequest(path,options) {
  const response=await fetch(`${baseUrl}${path}`,options);
  const body=await response.json().catch(()=>null);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${body?.code||body?.error||'request failed'}`);
  }
  return body;
}

function parseSseBlock(block) {
  let event='';
  const data=[];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event=line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!event||!data.length) return null;
  return {event,payload:JSON.parse(data.join('\n'))};
}

async function readTerminalSse(response,signal) {
  assert.equal(response.status,200,`Codex turn returned HTTP ${response.status}`);
  assert.match(response.headers.get('content-type')||'',/^text\/event-stream\b/);
  const decoder=new TextDecoder();
  let buffer='';
  let streamedAnswer='';

  for await (const chunk of response.body) {
    if (signal.aborted) throw signal.reason;
    buffer+=decoder.decode(chunk,{stream:true});
    let separator;
    while ((separator=buffer.search(/\r?\n\r?\n/))>=0) {
      const delimiter=buffer.slice(separator).match(/^\r?\n\r?\n/)[0];
      const block=buffer.slice(0,separator);
      buffer=buffer.slice(separator+delimiter.length);
      const parsed=parseSseBlock(block);
      if (!parsed) continue;
      if (parsed.event==='text_delta') {
        streamedAnswer+=String(parsed.payload?.delta||'');
        process.stdout.write(String(parsed.payload?.delta||''));
      }
      if (parsed.event==='error') {
        throw new Error(`Codex SSE error ${parsed.payload?.code||'UNKNOWN'}: ${parsed.payload?.error||'turn failed'}`);
      }
      if (parsed.event==='completed') {
        const answer=String(parsed.payload?.result?.answer||streamedAnswer);
        return {answer,event:parsed.payload};
      }
    }
  }
  throw new Error('Codex SSE ended without a completed or error terminal event');
}

try {
  await db.ready();
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);
      resolve();
    });
  });
  baseUrl=`http://127.0.0.1:${server.address().port}`;

  const project=await jsonRequest('/api/projects',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({name:projectName})
  });
  projectId=project.id;
  assert.ok(Number.isSafeInteger(projectId)&&projectId>0,'temporary project ID is invalid');

  const health=await jsonRequest(`/api/projects/${projectId}/selection-ai/health?provider=codex`);
  const codexHealth=validateCodexHealth(health);
  console.log(`Codex health: ${codexHealth.status} (ok)`);

  const controller=new AbortController();
  const timer=setTimeout(
    ()=>controller.abort(new Error(`Codex smoke did not reach a terminal event within ${terminalTimeoutMs}ms`)),
    terminalTimeoutMs
  );
  try {
    const response=await fetch(`${baseUrl}/api/projects/${projectId}/selection-ai/turns`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({chapter:'overview',message:'只回复当前测试品类名称，不提出修改。'}),
      signal:controller.signal
    });
    const terminal=await readTerminalSse(response,controller.signal);
    assert.match(terminal.answer,new RegExp(projectName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    console.log(`\nCodex completed: answer contains "${projectName}"`);
  } finally {
    clearTimeout(timer);
  }
} catch (error) {
  primaryError=error;
} finally {
  primaryError=await runAllCleanupSteps({
    primaryError,
    steps:[
      ['temporary project cleanup',async()=>{
        const result=await cleanupTemporaryProjects({db,baseUrl,projectId,projectName});
        cleanupConfirmed=result.confirmed;
        console.log(`\n临时项目已删除：${projectName}`);
      }],
      ['service.dispose',async()=>{ await service.dispose(); }],
      ['server.shutdown',async()=>{ await server.shutdown(); }],
      ['db.close',async()=>{ await db.close(); }]
    ]
  });
}

if (!primaryError) assert.equal(cleanupConfirmed,true,'temporary project cleanup was not confirmed');
if (primaryError) throw primaryError;
