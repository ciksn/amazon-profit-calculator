'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(
  path.resolve(__dirname,'../pages-src/static-api.js'),
  'utf8'
);

function memoryStorage(initial={}) {
  const values=new Map(Object.entries(initial).map(([key,value])=>[key,String(value)]));
  return {
    getItem:(key)=>values.has(key)?values.get(key):null,
    setItem:(key,value)=>values.set(key,String(value)),
    values
  };
}

function loadStaticApiModule() {
  const sandbox={
    module:{exports:{}},
    window:{
      fetch:async()=>new Response('{}',{status:200}),
      addEventListener(){}
    },
    localStorage:memoryStorage(),
    Response,
    URL,
    console
  };
  vm.runInNewContext(source,sandbox,{filename:'static-api.js'});
  return sandbox.module.exports;
}

function staticBrowserHarness({local,selectionLocal}) {
  const storage=memoryStorage({
    'margingo-github-pages-v1':JSON.stringify(local),
    'margingo-selection-documents-v1':JSON.stringify(selectionLocal)
  });
  const listeners=new Map();
  const exportButton={};
  const importButton={click(){}};
  const input={files:[],click(){}};
  const foot={before(){}};
  const elements={
    '.sidebar-foot':foot,
    '#exportLocalData':exportButton,
    '#importLocalData':importButton,
    '#importLocalFile':input
  };
  let exportedBlob=null;
  let reloads=0;
  const document={
    head:{append(){}},
    querySelector:(selector)=>elements[selector]||null,
    createElement:(tag)=>{
      if(tag==='a')return {click(){}};
      return {className:'',innerHTML:'',textContent:''};
    }
  };
  const window={
    document,
    fetch:async()=>new Response('{}',{status:200}),
    addEventListener:(type,listener)=>listeners.set(type,listener)
  };
  const sandbox={
    window,
    document,
    localStorage:storage,
    location:{
      origin:'https://example.test',
      href:'https://example.test/index.html',
      reload:()=>{reloads+=1}
    },
    Response,
    Blob,
    URL:{
      createObjectURL:(blob)=>{exportedBlob=blob;return 'blob:backup'},
      revokeObjectURL(){}
    },
    alert:()=>{},
    console
  };
  vm.runInNewContext(source,sandbox,{filename:'static-api.js'});
  listeners.get('DOMContentLoaded')();
  return {
    exportButton,
    input,
    storage,
    exportedBlob:()=>exportedBlob,
    reloads:()=>reloads
  };
}

const plain=(value)=>JSON.parse(JSON.stringify(value));

function localFixture() {
  return {
    version:1,
    nextProjectId:3,
    nextCompetitorId:4,
    projects:[{id:1,name:'Project one'}],
    listings:{'1:US':{project_id:1,country_code:'US',sale_price:29.99}},
    competitors:[{id:2,project_id:1,country_code:'US',name:'Competitor'}],
    overrides:{'countries:US':{priority:2}}
  };
}

function selectionFixture() {
  return {
    version:1,
    nextSupplierId:6,
    documents:{'1':{project_id:1,version:2,positioning:'Latest positioning'}},
    sites:{'1:US':{project_id:1,country_code:'US',opportunity_notes:'Strong'}},
    suppliers:[{id:5,project_id:1,name:'Supplier'}]
  };
}

test('v2 static backup round-trips both core and selection-local data',()=>{
  const {createStaticBackup,parseStaticBackup}=loadStaticApiModule();
  assert.equal(typeof createStaticBackup,'function');
  assert.equal(typeof parseStaticBackup,'function');

  const local=localFixture();
  const selectionLocal=selectionFixture();
  const backup=plain(createStaticBackup(local,selectionLocal));
  assert.equal(backup.version,2);
  assert.deepEqual(backup.local,local);
  assert.deepEqual(backup.selectionLocal,selectionLocal);

  const restored=plain(parseStaticBackup(backup,{
    ...selectionFixture(),
    documents:{}
  }));
  assert.deepEqual(restored,{local,selectionLocal});
});

test('browser backup controls export and restore the v2 selection-local envelope',async()=>{
  const local=localFixture();
  const selectionLocal=selectionFixture();
  const harness=staticBrowserHarness({local,selectionLocal});

  harness.exportButton.onclick();
  const exported=JSON.parse(await harness.exportedBlob().text());
  assert.equal(exported.version,2);
  assert.deepEqual(exported.selectionLocal,selectionLocal);

  const replacementSelection={
    ...selectionFixture(),
    documents:{'1':{project_id:1,version:3,positioning:'Restored positioning'}}
  };
  harness.input.files=[{
    text:async()=>JSON.stringify({
      version:2,
      local,
      selectionLocal:replacementSelection
    })
  }];
  await harness.input.onchange();

  assert.deepEqual(
    JSON.parse(harness.storage.getItem('margingo-selection-documents-v1')),
    replacementSelection
  );
  assert.equal(harness.reloads(),1);
});

test('legacy v1 backup restores core data without erasing current selection-local data',()=>{
  const {parseStaticBackup}=loadStaticApiModule();
  assert.equal(typeof parseStaticBackup,'function');

  const local=localFixture();
  const currentSelection=selectionFixture();
  const restored=plain(parseStaticBackup(local,currentSelection));

  assert.deepEqual(restored,{local,selectionLocal:currentSelection});
});

test('backup import rejects malformed containers and dangerous keys without pollution',()=>{
  const {parseStaticBackup}=loadStaticApiModule();
  assert.equal(typeof parseStaticBackup,'function');

  const local=localFixture();
  const selectionLocal=selectionFixture();
  assert.throws(
    ()=>parseStaticBackup({
      version:2,
      local:{...local,projects:{}},
      selectionLocal
    },selectionLocal),
    /备份格式不正确/
  );
  assert.throws(
    ()=>parseStaticBackup({
      version:2,
      local,
      selectionLocal:{...selectionLocal,documents:[]}
    },selectionLocal),
    /备份格式不正确/
  );

  const dangerous=JSON.parse(JSON.stringify({
    version:2,
    local,
    selectionLocal
  }).replace(
    '"documents":{',
    '"documents":{"__proto__":{"polluted":"yes"},'
  ));
  assert.throws(()=>parseStaticBackup(dangerous,selectionLocal),/危险字段|备份格式不正确/);
  assert.equal({}.polluted,undefined);
});
