import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const db=require('../lib/db');
const {createDefaultSelectionAiService}=require('../lib/selection-ai/service');
const {createServer,selectionDocumentPayload}=require('../server');

if (!String(process.env.DATABASE_URL||'').trim()) {
  throw new Error('smoke_selection_ai requires DATABASE_URL before it can create test data');
}

const terminalTimeoutMs=120_000;
const projectName=`AI 冒烟测试 ${Date.now()}`;
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

async function cleanupProject() {
  if (projectId==null) return;
  let httpDeleteError=null;
  try {
    const response=await fetch(`${baseUrl}/api/projects/${projectId}`,{method:'DELETE'});
    if (!response.ok&&response.status!==404) {
      throw new Error(`temporary project delete returned HTTP ${response.status}`);
    }
  } catch (error) {
    httpDeleteError=error;
  }

  let remaining=await db.one('SELECT COUNT(*)::int AS count FROM projects WHERE id=$1',[projectId]);
  if (Number(remaining?.count)>0) {
    await db.query('DELETE FROM projects WHERE id=$1',[projectId]);
    remaining=await db.one('SELECT COUNT(*)::int AS count FROM projects WHERE id=$1',[projectId]);
  }
  assert.equal(Number(remaining?.count),0,'temporary smoke project was not deleted');
  cleanupConfirmed=true;
  console.log(`\n临时项目已删除：${projectName}`);
  if (httpDeleteError) throw httpDeleteError;
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

  const health=await jsonRequest(`/api/projects/${projectId}/selection-ai/health`);
  const codexHealth=health?.providers?.codex||health?.codex;
  assert.notEqual(codexHealth?.status,'not_installed','Codex executable is not installed');
  console.log(`Codex health: ${codexHealth?.status||'unknown'} (${codexHealth?.ok?'ok':'not ready'})`);

  const controller=new AbortController();
  const timer=setTimeout(
    ()=>controller.abort(new Error(`Codex smoke did not reach a terminal event within ${terminalTimeoutMs}ms`)),
    terminalTimeoutMs
  );
  try {
    const response=await fetch(`${baseUrl}/api/projects/${projectId}/selection-ai/turns`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({chapter:'overview',message:'只回复当前测试品类名称，不提出修改'}),
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
  let cleanupError=null;
  try { await cleanupProject(); }
  catch (error) { cleanupError=error; }
  service.dispose();
  try { await server.shutdown(); }
  catch (error) { cleanupError||=error; }
  try { await db.close(); }
  catch (error) { cleanupError||=error; }
  if (cleanupError) {
    if (primaryError) primaryError=new AggregateError([primaryError,cleanupError],'Smoke test and cleanup both failed');
    else primaryError=cleanupError;
  }
}

if (projectId!=null) assert.equal(cleanupConfirmed,true,'temporary project cleanup was not confirmed');
if (primaryError) throw primaryError;
