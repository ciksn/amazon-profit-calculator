'use strict';
(() => {
  const SSO_BASE=String(window.MARGINGO_LOGIN_CENTER_BASE||'').replace(/\/$/,'');
  const APP_PUBLIC_URL=String(window.MARGINGO_APP_PUBLIC_URL||'').replace(/\/$/,'');
  const TOKEN_KEY='margingo_sso_token';
  const nativeFetch=window.fetch.bind(window);
  const redirectUrl=()=>APP_PUBLIC_URL;
  const ssoUrl=(path,params={})=>{const url=new URL(path,SSO_BASE);url.searchParams.set('redirect',redirectUrl());for(const[key,value]of Object.entries(params))url.searchParams.set(key,value);return url.href;};
  const clearFragment=()=>history.replaceState(null,document.title,`${location.pathname}${location.search}`);
  const fragment=new URLSearchParams(location.hash.replace(/^#/,''));
  const returnedToken=fragment.get('token');const loggedOut=fragment.has('loggedout');const noSession=fragment.get('sso')==='none';
  if(returnedToken){localStorage.setItem(TOKEN_KEY,returnedToken);clearFragment();}
  if(loggedOut){localStorage.removeItem(TOKEN_KEY);clearFragment();}
  if(noSession)clearFragment();
  function token(){return localStorage.getItem(TOKEN_KEY)||'';}
  function goLogin(silent=false){location.replace(ssoUrl('/api/auth/feishu/sso',silent?{silent:'1'}:{}));}
  function logout(){localStorage.removeItem(TOKEN_KEY);location.assign(ssoUrl('/api/auth/feishu/logout'));}
  function showGate(message='使用公司账号登录后继续'){
    const render=()=>{if(document.getElementById('ssoGate'))return;const gate=document.createElement('div');gate.id='ssoGate';gate.className='sso-gate';gate.innerHTML=`<div class="sso-card"><div class="sso-mark">M</div><h1>MarginGo</h1><p>${message}</p><button type="button" id="ssoLoginButton">飞书扫码登录</button></div>`;document.body.appendChild(gate);document.getElementById('ssoLoginButton').addEventListener('click',()=>goLogin(false));};
    document.readyState==='loading'?document.addEventListener('DOMContentLoaded',render,{once:true}):render();
  }
  function showIdentity(user){
    const render=()=>{if(document.getElementById('ssoIdentity'))return;const box=document.createElement('div');box.id='ssoIdentity';box.className='sso-identity';const name=document.createElement('span');name.textContent=user.name||'已登录';const button=document.createElement('button');button.type='button';button.textContent='退出';button.addEventListener('click',logout);box.append(name,button);document.body.appendChild(box);};
    document.readyState==='loading'?document.addEventListener('DOMContentLoaded',render,{once:true}):render();
  }
  if(!SSO_BASE||!APP_PUBLIC_URL)throw new Error('缺少 SSO 前端配置');
  let resolveReady;const ready=new Promise((resolve)=>{resolveReady=resolve;});const hasToken=Boolean(token());
  if(!hasToken){if(noSession||loggedOut)showGate();else goLogin(true);}else resolveReady();
  function isOwnApi(input){try{const apiBase=String(window.MARGINGO_API_BASE||'');const target=new URL(typeof input==='string'?input:input.url,location.href);const configured=apiBase?new URL(apiBase,location.href):new URL(location.origin);return target.origin===configured.origin&&target.pathname.startsWith('/api/');}catch{return false;}}
  window.fetch=async(input,options={})=>{
    if(!isOwnApi(input))return nativeFetch(input,options);await ready;
    const headers=new Headers(options.headers||(input instanceof Request?input.headers:undefined));headers.set('Authorization',`Bearer ${token()}`);
    const response=await nativeFetch(input,{...options,headers});
    if(response.status===401){localStorage.removeItem(TOKEN_KEY);goLogin(true);}
    return response;
  };
  if(hasToken)window.addEventListener('DOMContentLoaded',async()=>{try{const base=String(window.MARGINGO_API_BASE||'').replace(/\/$/,'');const response=await window.fetch(`${base}/api/me`);if(response.ok)showIdentity(await response.json());}catch{}},{once:true});
  window.MarginGoAuth={login:()=>goLogin(false),logout,token,ready};
})();
