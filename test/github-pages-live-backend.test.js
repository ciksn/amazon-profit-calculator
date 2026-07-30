'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

const root=path.resolve(__dirname,'..');

function build(apiBase) {
  const env={...process.env};
  if (apiBase===undefined) delete env.MARGINGO_PAGES_API_BASE;
  else env.MARGINGO_PAGES_API_BASE=apiBase;
  return spawnSync(process.execPath,['scripts/build_github_pages.mjs'],{
    cwd:root,
    env,
    encoding:'utf8'
  });
}

test('Pages build generates a live-backed embed without the static API adapter',()=>{
  const result=build('https://www.200392.xyz');
  assert.equal(result.status,0,result.stderr || result.stdout);

  const config=fs.readFileSync(path.join(root,'docs','embed-config.js'),'utf8');
  const html=fs.readFileSync(path.join(root,'docs','embed.html'),'utf8');
  assert.match(config,/window\.MARGINGO_API_BASE = "https:\/\/www\.200392\.xyz";/);
  assert.match(config,/window\.MARGINGO_STATIC_MODE = false;/);
  assert.match(html,/<script src="\.\/embed-config\.js"><\/script>/);
  assert.doesNotMatch(html,/static-api\.js/);
  assert.equal(
    fs.readFileSync(path.join(root,'docs','competitor-import.js'),'utf8'),
    fs.readFileSync(path.join(root,'public','competitor-import.js'),'utf8')
  );
  assert.ok(fs.statSync(path.join(root,'docs','exceljs.min.js')).size>100_000);
});

test('Pages build rejects a missing or unsafe live API origin',()=>{
  for (const value of [undefined,'http://www.200392.xyz','https://www.200392.xyz/api']) {
    const result=build(value);
    assert.notEqual(result.status,0,`expected build failure for ${String(value)}`);
    assert.match(`${result.stdout}\n${result.stderr}`,/MARGINGO_PAGES_API_BASE/);
  }
});
