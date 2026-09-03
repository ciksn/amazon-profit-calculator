'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');

function build(appPublicUrl){
  const env={...process.env};
  delete env.MARGINGO_PAGES_API_BASE;
  if(appPublicUrl===undefined)delete env.APP_PUBLIC_URL;
  else env.APP_PUBLIC_URL=appPublicUrl;
  return spawnSync(process.execPath,['scripts/build_github_pages.mjs'],{cwd:root,env,encoding:'utf8'});
}

test('Pages build redirects every public entry to APP_PUBLIC_URL',()=>{
  const result=build('https://200392.xyz');
  assert.equal(result.status,0,result.stderr||result.stdout);
  const targets={
    'index.html':'https://200392.xyz/',
    'embed.html':'https://200392.xyz/embed.html',
    'site-card.html':'https://200392.xyz/site-card.html',
    'selection-document.html':'https://200392.xyz/selection-document.html'
  };
  for(const [filename,target]of Object.entries(targets)){
    const html=fs.readFileSync(path.join(root,'docs',filename),'utf8');
    assert.match(html,new RegExp(`location\\.replace\\("${target.replace(/[.]/g,'\\.')}`));
    assert.doesNotMatch(html,/static-api\.js|embed-config\.js/);
  }
});

test('Pages build rejects missing or unsafe APP_PUBLIC_URL',()=>{
  for(const value of [undefined,'javascript:alert(1)','https://user:password@example.com']){
    const result=build(value);
    assert.notEqual(result.status,0,`expected build failure for ${String(value)}`);
    assert.match(`${result.stdout}\n${result.stderr}`,/APP_PUBLIC_URL/);
  }
});

test('Pages workflow builds redirect artifacts from canonical main',()=>{
  const workflow=fs.readFileSync(path.join(root,'.github','workflows','deploy-pages.yml'),'utf8');
  assert.match(workflow,/actions\/checkout@v4[\s\S]*?with:\s*\n\s+ref:\s*main/);
  assert.match(workflow,/npm run build:pages/);
  assert.match(workflow,/APP_PUBLIC_URL:/);
  assert.match(workflow,/vars\.APP_PUBLIC_URL/);
  assert.doesNotMatch(workflow,/MARGINGO_PAGES_API_BASE/);
});
