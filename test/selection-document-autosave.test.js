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

test('workbench bridge publishes flushPendingSaves before the ready event',()=>{
  const bridgeIndex=source.indexOf('flushPendingSaves,');
  const readyIndex=source.indexOf("dispatchEvent(new CustomEvent('selection-document-ready'))");
  assert.notEqual(bridgeIndex,-1);
  assert.notEqual(readyIndex,-1);
  assert.ok(bridgeIndex<readyIndex);
});

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

test('site autosave serializes requests and preserves a newer edit from an older response',async()=>{
  const {createEntitySaveQueue}=loadSelectionDocumentModule();
  assert.equal(typeof createEntitySaveQueue,'function');

  const site={
    country_code:'US',
    opportunity_notes:'first site draft',
    market_average_sales:10,
    updated_at:''
  };
  const firstResponse=deferred();
  const secondResponse=deferred();
  const requests=[];
  const queue=createEntitySaveQueue({
    delayMs:60_000,
    readEntity:()=>site,
    fields:['opportunity_notes','market_average_sales'],
    metadataFields:['updated_at'],
    request:async(payload)=>{
      requests.push(structuredClone(payload));
      return requests.length===1?firstResponse.promise:secondResponse.promise;
    }
  });

  queue.enqueue();
  void queue.flush();
  await waitFor(()=>requests.length===1,'first site save did not start');

  site.opportunity_notes='latest site draft';
  queue.enqueue();
  firstResponse.resolve({
    country_code:'US',
    opportunity_notes:'first site draft',
    market_average_sales:10,
    updated_at:'2026-07-30T05:00:00.000Z'
  });

  await waitFor(()=>requests.length===2,'latest site snapshot did not start after the first response');
  assert.equal(site.opportunity_notes,'latest site draft');
  assert.equal(site.updated_at,'2026-07-30T05:00:00.000Z');
  assert.deepEqual(requests[1],{
    opportunity_notes:'latest site draft',
    market_average_sales:10
  });

  secondResponse.resolve({
    country_code:'US',
    opportunity_notes:'latest site draft',
    market_average_sales:10,
    updated_at:'2026-07-30T05:00:01.000Z'
  });
  await queue.whenIdle();
  assert.equal(site.opportunity_notes,'latest site draft');
  assert.equal(site.updated_at,'2026-07-30T05:00:01.000Z');
});

test('supplier autosave keeps the row object and ignores stale editable and calculated fields',async()=>{
  const {createEntitySaveQueue}=loadSelectionDocumentModule();
  assert.equal(typeof createEntitySaveQueue,'function');

  const supplier={
    id:42,
    name:'first supplier draft',
    cost_cny:12,
    calculation:{profit:8},
    updated_at:''
  };
  const originalRow=supplier;
  const firstResponse=deferred();
  const secondResponse=deferred();
  const requests=[];
  const queue=createEntitySaveQueue({
    delayMs:60_000,
    readEntity:()=>supplier,
    fields:['name','cost_cny'],
    metadataFields:['updated_at'],
    dependentFields:['calculation'],
    request:async(payload)=>{
      requests.push(structuredClone(payload));
      return requests.length===1?firstResponse.promise:secondResponse.promise;
    }
  });

  queue.enqueue();
  void queue.flush();
  await waitFor(()=>requests.length===1,'first supplier save did not start');

  supplier.name='latest supplier draft';
  queue.enqueue();
  firstResponse.resolve({
    id:42,
    name:'first supplier draft',
    cost_cny:12,
    calculation:{profit:8},
    updated_at:'2026-07-30T05:10:00.000Z'
  });

  await waitFor(()=>requests.length===2,'latest supplier snapshot did not start after the first response');
  assert.equal(supplier,originalRow);
  assert.equal(supplier.name,'latest supplier draft');
  assert.deepEqual(supplier.calculation,{profit:8});
  assert.deepEqual(requests[1],{
    name:'latest supplier draft',
    cost_cny:12
  });

  secondResponse.resolve({
    id:42,
    name:'latest supplier draft',
    cost_cny:12,
    calculation:{profit:11},
    updated_at:'2026-07-30T05:10:01.000Z'
  });
  await queue.whenIdle();
  assert.equal(supplier,originalRow);
  assert.equal(supplier.name,'latest supplier draft');
  assert.equal(supplier.calculation.profit,11);
});

test('flush waits for every queue, including edits and entity queues added while flushing',async()=>{
  const {
    createLatestSnapshotSaveQueue,
    flushSaveQueues
  }=loadSelectionDocumentModule();
  const makeQueue=(readSnapshot,gates,requests)=>createLatestSnapshotSaveQueue({
    delayMs:100,
    snapshot:()=>structuredClone(readSnapshot()),
    request:async(payload)=>{
      requests.push(structuredClone(payload));
      return gates[requests.length-1].promise;
    }
  });

  let siteDraft={notes:'site first'};
  let supplierDraft={name:'supplier first'};
  let lateSiteDraft={notes:'late site'};
  const siteGates=[deferred(),deferred()];
  const supplierGates=[deferred()];
  const lateSiteGates=[deferred()];
  const siteRequests=[];
  const supplierRequests=[];
  const lateSiteRequests=[];
  const siteQueue=makeQueue(()=>siteDraft,siteGates,siteRequests);
  const supplierQueue=makeQueue(()=>supplierDraft,supplierGates,supplierRequests);
  const lateSiteQueue=makeQueue(()=>lateSiteDraft,lateSiteGates,lateSiteRequests);
  const queues=[siteQueue,supplierQueue];

  siteQueue.enqueue();
  supplierQueue.enqueue();
  const flushing=flushSaveQueues(()=>queues);
  await waitFor(
    ()=>siteRequests.length===1&&supplierRequests.length===1,
    'existing entity queues did not flush in parallel'
  );

  siteDraft={notes:'site latest'};
  siteQueue.enqueue();
  lateSiteQueue.enqueue();
  queues.push(lateSiteQueue);
  siteGates[0].resolve({});
  supplierGates[0].resolve({});

  await waitFor(()=>siteRequests.length===2,'flush did not include the latest site edit');
  assert.equal(siteRequests.length,2,'flush did not include the latest site edit');
  let settled=false;
  void flushing.then(()=>{settled=true});
  await Promise.resolve();
  assert.equal(settled,false);
  assert.deepEqual(siteRequests[1],{notes:'site latest'});

  siteGates[1].resolve({});
  await waitFor(
    ()=>lateSiteRequests.length===1,
    'flush did not include the newly added entity queue'
  );
  assert.equal(settled,false);
  assert.deepEqual(lateSiteRequests[0],{notes:'late site'});
  lateSiteGates[0].resolve({});
  await flushing;
  assert.equal(settled,true);
});

test('flush rejects when a pending entity save fails and leaves it retryable',async()=>{
  const {
    createLatestSnapshotSaveQueue,
    flushSaveQueues
  }=loadSelectionDocumentModule();
  let attempts=0;
  const queue=createLatestSnapshotSaveQueue({
    delayMs:60_000,
    snapshot:()=>({notes:'unsaved'}),
    request:async()=>{
      attempts+=1;
      throw new Error('save failed');
    }
  });

  queue.enqueue();
  await assert.rejects(flushSaveQueues(()=>[queue]),/save failed/);
  assert.equal(attempts,1);
  assert.equal(queue.isIdle(),false);
  await assert.rejects(queue.flush(),/save failed/);
  assert.equal(attempts,2);
});
