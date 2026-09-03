'use strict';

const DEFAULT_CACHE_TTL_MS=30_000;
const MAX_CACHE_TTL_MS=60_000;

function bearerToken(req) {
  const header=String(req.headers.authorization||'');
  const match=header.match(/^Bearer\s+(.+)$/i);
  return match&&match[1].trim() ? match[1].trim() : '';
}

function createSsoVerifier({fetchImpl=globalThis.fetch,baseUrl=process.env.LOGIN_CENTER_BASE,
  cacheTtlMs=Number(process.env.SSO_CACHE_TTL_MS)||DEFAULT_CACHE_TTL_MS,now=Date.now}={}) {
  if(typeof fetchImpl!=='function')throw new Error('SSO 校验缺少 fetch 实现');
  if(!baseUrl)throw new Error('缺少 LOGIN_CENTER_BASE');
  const ttl=Math.max(0,Math.min(MAX_CACHE_TTL_MS,Number(cacheTtlMs)||0));
  const cache=new Map();

  async function verify(token) {
    if(!token){const error=new Error('未登录');error.statusCode=401;error.code='AUTH_REQUIRED';throw error;}
    const cached=cache.get(token);const current=now();
    if(cached&&cached.expiresAt>current)return cached.user;
    if(cached)cache.delete(token);

    let response;
    try {
      response=await fetchImpl(`${String(baseUrl).replace(/\/$/,'')}/api/me`,{
        method:'GET',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10_000)
      });
    } catch {
      const error=new Error('登录中心暂时不可用');error.statusCode=503;error.code='SSO_UNAVAILABLE';throw error;
    }
    if(!response.ok){
      cache.delete(token);
      const error=new Error('登录已失效');error.statusCode=401;error.code='AUTH_INVALID';throw error;
    }
    let body;
    try{body=await response.json();}catch{body=null;}
    if(!body||!Number.isSafeInteger(Number(body.id))){
      const error=new Error('登录中心返回了无效身份');error.statusCode=503;error.code='SSO_INVALID_RESPONSE';throw error;
    }
    const user={
      id:Number(body.id),name:String(body.name||''),roles:Array.isArray(body.roles)?body.roles.map(String):[],
      principal_uid:body.principal_uid==null?null:Number(body.principal_uid)
    };
    if(ttl>0){
      cache.set(token,{user,expiresAt:current+ttl});
      if(cache.size>1_000)for(const [key,value]of cache)if(value.expiresAt<=current)cache.delete(key);
    }
    return user;
  }

  return {verify,clear:()=>cache.clear()};
}

module.exports={MAX_CACHE_TTL_MS,bearerToken,createSsoVerifier};
