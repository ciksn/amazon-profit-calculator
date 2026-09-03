import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const docs=path.join(root,'docs');
const appPublicUrl=String(process.env.APP_PUBLIC_URL||'').trim();
if(!appPublicUrl)throw new Error('GitHub Pages 构建缺少 APP_PUBLIC_URL');

let redirectTarget;
try{redirectTarget=new URL(appPublicUrl);}catch{throw new Error('APP_PUBLIC_URL 必须是有效的 HTTP(S) 地址');}
if(!['http:','https:'].includes(redirectTarget.protocol)||redirectTarget.username||redirectTarget.password){
  throw new Error('APP_PUBLIC_URL 必须是不含账号信息的 HTTP(S) 地址');
}

fs.mkdirSync(docs,{recursive:true});

function writeRedirect(filename,targetUrl){
  const target=JSON.stringify(targetUrl.href);
  const escaped=targetUrl.href.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  fs.writeFileSync(path.join(docs,filename),`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${escaped}">
<title>正在打开利润率测算工具</title><script>location.replace(${target})</script></head>
<body><p>正在打开利润率测算工具……</p></body></html>\n`);
}

writeRedirect('index.html',redirectTarget);
for(const filename of ['embed.html','site-card.html','selection-document.html']){
  writeRedirect(filename,new URL(filename,`${redirectTarget.href.replace(/\/$/,'')}/`));
}
fs.writeFileSync(path.join(docs,'.nojekyll'),'');
console.log(`GitHub Pages 跳转目标：${redirectTarget.href}`);
