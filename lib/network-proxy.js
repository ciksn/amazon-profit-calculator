'use strict';

const {execFileSync}=require('node:child_process');

function normalizeProxyUrl(value) {
  const raw=String(value||'').trim();
  if(!raw)return '';
  const entries=raw.split(';').map((item)=>item.trim()).filter(Boolean);
  const keyed=new Map();
  let unkeyed='';
  for(const entry of entries){
    const match=entry.match(/^([a-z]+)=(.+)$/i);
    if(match)keyed.set(match[1].toLowerCase(),match[2].trim());
    else if(!unkeyed)unkeyed=entry;
  }
  const selected=keyed.get('https')||keyed.get('http')||unkeyed;
  if(!selected)return '';
  const withScheme=/^[a-z][a-z0-9+.-]*:\/\//i.test(selected)?selected:`http://${selected}`;
  try {
    const parsed=new URL(withScheme);
    return ['http:','https:'].includes(parsed.protocol)&&parsed.hostname&&parsed.port?parsed.href:'';
  } catch { return ''; }
}

function readWindowsInternetProxy() {
  if(process.platform!=='win32')return '';
  try {
    const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const enabled=execFileSync('reg.exe',['query',key,'/v','ProxyEnable'],{encoding:'utf8',windowsHide:true,timeout:1500});
    if(!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled))return '';
    const output=execFileSync('reg.exe',['query',key,'/v','ProxyServer'],{encoding:'utf8',windowsHide:true,timeout:1500});
    const match=output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    return normalizeProxyUrl(match?.[1]);
  } catch { return ''; }
}

function getGeminiProxyUrl(env=process.env,{windowsProxyReader=readWindowsInternetProxy}={}) {
  const configured=env.GEMINI_HTTPS_PROXY||env.HTTPS_PROXY||env.https_proxy||env.HTTP_PROXY||env.http_proxy||env.ALL_PROXY||env.all_proxy;
  return normalizeProxyUrl(configured)||(windowsProxyReader?.()||'');
}

module.exports={normalizeProxyUrl,readWindowsInternetProxy,getGeminiProxyUrl};
