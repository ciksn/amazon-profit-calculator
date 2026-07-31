'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {resolveCodexCommand}=require('../lib/selection-ai/codex-command');

test('Windows default resolves the npm Codex optional package native executable without a shell',()=>{
  const npmBin='C:\\Users\\tester\\AppData\\Roaming\\npm';
  const codexRoot=path.win32.join(npmBin,'node_modules','@openai','codex');
  const platformPackage=path.win32.join(
    codexRoot,'node_modules','@openai','codex-win32-x64'
  );
  const packageJson=path.win32.join(platformPackage,'package.json');
  const executable=path.win32.join(
    platformPackage,'vendor','x86_64-pc-windows-msvc','bin','codex.exe'
  );
  const existing=new Set([
    path.win32.join(codexRoot,'package.json').toLowerCase(),
    executable.toLowerCase()
  ]);
  const resolveCalls=[];

  const command=resolveCodexCommand({
    env:{PATH:`${npmBin};C:\\Windows\\System32`},
    platform:'win32',
    arch:'x64',
    pathApi:path.win32,
    pathDelimiter:';',
    existsSync:(candidate)=>existing.has(candidate.toLowerCase()),
    resolvePackage:(specifier,options)=>{
      resolveCalls.push([specifier,options]);
      return packageJson;
    }
  });

  assert.equal(command,executable);
  assert.deepEqual(resolveCalls,[
    ['@openai/codex-win32-x64/package.json',{paths:[codexRoot]}]
  ]);
});

test('explicit CODEX_COMMAND always wins and other platforms keep the PATH command',()=>{
  assert.equal(resolveCodexCommand({
    env:{CODEX_COMMAND:' C:\\custom\\codex.exe '},platform:'win32'
  }),'C:\\custom\\codex.exe');
  assert.equal(resolveCodexCommand({env:{},platform:'linux'}),'codex');
});
