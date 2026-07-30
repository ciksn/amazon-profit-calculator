'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(
  path.resolve(__dirname,'../public/selection-document.js'),
  'utf8'
);

function loadSelectionDocumentModule() {
  const element={
    classList:{add(){},toggle(){}},
    addEventListener(){},
    textContent:'',
    hidden:false
  };
  const document={
    querySelector:()=>element,
    querySelectorAll:()=>[]
  };
  const sandbox={
    module:{exports:{}},
    window:{MARGINGO_API_BASE:''},
    document,
    location:{search:'?project=7'},
    fetch:()=>new Promise(()=>{}),
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console
  };
  vm.runInNewContext(source,sandbox,{filename:'selection-document.js'});
  return sandbox.module.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise=new Promise((accept,decline)=>{
    resolve=accept;
    reject=decline;
  });
  return {promise,resolve,reject};
}

async function waitFor(predicate,message) {
  for(let attempt=0;attempt<50;attempt+=1) {
    if(predicate())return;
    await new Promise((resolve)=>setImmediate(resolve));
  }
  assert.fail(message);
}

test('document autosave queues the latest edit and sends it with the saved server version',async()=>{
  const {createDocumentSaveQueue}=loadSelectionDocumentModule();
  assert.equal(typeof createDocumentSaveQueue,'function');

  let liveDocument={
    version:0,
    updated_at:'',
    positioning:'first draft',
    checklist:[{id:'one',label:'first',checked:false}]
  };
  const firstResponse=deferred();
  const secondResponse=deferred();
  const requests=[];
  const delayedFetch=async(_url,options)=>{
    const payload=JSON.parse(options.body);
    requests.push(structuredClone(payload));
    const responseBody=await (requests.length===1?firstResponse.promise:secondResponse.promise);
    return new Response(JSON.stringify(responseBody),{
      status:200,
      headers:{'content-type':'application/json'}
    });
  };
  const queue=createDocumentSaveQueue({
    delayMs:60_000,
    readDocument:()=>liveDocument,
    writeDocument:(value)=>{liveDocument=value},
    snapshotDocument:()=>({
      positioning:liveDocument.positioning,
      checklist:liveDocument.checklist.map((item)=>({...item}))
    }),
    request:async(payload)=>{
      const response=await delayedFetch('/api/projects/7/selection-document',{
        method:'PUT',
        body:JSON.stringify(payload)
      });
      return response.json();
    }
  });

  queue.enqueue();
  void queue.flush();
  await waitFor(()=>requests.length===1,'first save did not start');
  assert.deepEqual(requests[0],{
    version:0,
    positioning:'first draft',
    checklist:[{id:'one',label:'first',checked:false}]
  });

  liveDocument.positioning='latest draft';
  liveDocument.checklist[0].label='latest';
  queue.enqueue();
  firstResponse.resolve({
    ...requests[0],
    version:1,
    updated_at:'2026-07-30T04:00:00.000Z'
  });

  await waitFor(()=>requests.length===2,'queued save did not start after the first response');
  assert.equal(liveDocument.positioning,'latest draft');
  assert.equal(liveDocument.checklist[0].label,'latest');
  assert.deepEqual(requests[1],{
    version:1,
    positioning:'latest draft',
    checklist:[{id:'one',label:'latest',checked:false}]
  });

  secondResponse.resolve({
    ...requests[1],
    version:2,
    updated_at:'2026-07-30T04:00:01.000Z'
  });
  await queue.whenIdle();

  assert.equal(liveDocument.version,2);
  assert.equal(liveDocument.positioning,'latest draft');
  assert.equal(liveDocument.checklist[0].label,'latest');
});
