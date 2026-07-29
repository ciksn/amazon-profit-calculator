'use strict';

const fs=require('node:fs');
const path=require('node:path');

const WINDOWS_TARGETS={
  x64:{package:'@openai/codex-win32-x64',triple:'x86_64-pc-windows-msvc'},
  arm64:{package:'@openai/codex-win32-arm64',triple:'aarch64-pc-windows-msvc'}
};

function npmCodexRoots({env,pathApi,pathDelimiter,existsSync}) {
  const pathValue=String(env.PATH||env.Path||env.path||'');
  const roots=[];
  for (const entry of pathValue.split(pathDelimiter).map((value)=>value.trim()).filter(Boolean)) {
    const candidates=[pathApi.join(entry,'node_modules','@openai','codex')];
    if (pathApi.basename(entry).toLowerCase()==='.bin') {
      candidates.push(pathApi.join(pathApi.dirname(entry),'@openai','codex'));
    }
    for (const candidate of candidates) {
      if (!existsSync(pathApi.join(candidate,'package.json'))) continue;
      if (!roots.some((root)=>root.toLowerCase()===candidate.toLowerCase())) roots.push(candidate);
    }
  }
  return roots;
}

function resolveCodexCommand({
  env=process.env,
  platform=process.platform,
  arch=process.arch,
  pathApi=path,
  pathDelimiter=path.delimiter,
  existsSync=fs.existsSync,
  resolvePackage=require.resolve
}={}) {
  const explicit=String(env.CODEX_COMMAND||'').trim();
  if (explicit) return explicit;
  if (platform!=='win32') return 'codex';

  const target=WINDOWS_TARGETS[arch];
  if (!target) return 'codex';
  for (const codexRoot of npmCodexRoots({env,pathApi,pathDelimiter,existsSync})) {
    let vendorRoot=pathApi.join(codexRoot,'vendor');
    try {
      const packageJson=resolvePackage(`${target.package}/package.json`,{paths:[codexRoot]});
      vendorRoot=pathApi.join(pathApi.dirname(packageJson),'vendor');
    } catch {}
    const executable=pathApi.join(vendorRoot,target.triple,'bin','codex.exe');
    if (existsSync(executable)) return executable;
  }
  return 'codex';
}

module.exports={resolveCodexCommand};
