'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('../server');
const db=require('../lib/db');
const {createSsoVerifier}=require('../lib/sso');
const fs=require('node:fs');
const path=require('node:path');

const users={
  'token-a':{id:101,name:'A',roles:['运营'],principal_uid:1001},
  'token-b':{id:202,name:'B',roles:['运营'],principal_uid:1002},
  'token-admin':{id:303,name:'Admin',roles:['管理员'],principal_uid:1003},
  'token-unbound':{id:404,name:'Unbound',roles:[],principal_uid:null}
};
const authVerifier={async verify(token){
  const user=users[token];if(user)return user;
  const error=new Error(token?'登录已失效':'未登录');error.statusCode=401;error.code='AUTH_INVALID';throw error;
}};
const headers=(token,extra={})=>({Authorization:`Bearer ${token}`,...extra});

test('SSO 身份是唯一的数据归属边界',async(t)=>{
  const server=createServer({authVerifier});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise((resolve)=>server.close(resolve));await db.close();});

  assert.equal((await fetch(`${base}/api/bootstrap`)).status,401);
  const unbound=await fetch(`${base}/api/bootstrap`,{headers:headers('token-unbound')});
  assert.equal(unbound.status,200);

  const projectResponse=await fetch(`${base}/api/projects`,{method:'POST',headers:headers('token-a',{'content-type':'application/json'}),body:JSON.stringify({name:'A 的品类'})});
  assert.equal(projectResponse.status,201);const project=await projectResponse.json();
  const competitorResponse=await fetch(`${base}/api/projects/${project.id}/competitors`,{method:'POST',headers:headers('token-a',{'content-type':'application/json'}),body:JSON.stringify({country_code:'AU',name:'A 的竞品'})});
  const competitor=await competitorResponse.json();

  assert.equal((await fetch(`${base}/api/projects/${project.id}`,{headers:headers('token-b')})).status,404);
  assert.equal((await fetch(`${base}/api/projects/by-share-key/${project.share_key}`,{headers:headers('token-b')})).status,404);
  assert.equal((await fetch(`${base}/api/calculate`,{method:'POST',headers:headers('token-b',{'content-type':'application/json'}),body:JSON.stringify({project_id:project.id,user_id:101})})).status,404);
  assert.equal((await fetch(`${base}/api/competitors/${competitor.id}`,{method:'PUT',headers:headers('token-b',{'content-type':'application/json'}),body:JSON.stringify({name:'篡改'})})).status,404);
  assert.equal((await fetch(`${base}/api/competitors/${competitor.id}`,{method:'DELETE',headers:headers('token-admin')})).status,404);
  assert.deepEqual((await (await fetch(`${base}/api/bootstrap`,{headers:headers('token-b')})).json()).projects,[]);
  assert.deepEqual((await (await fetch(`${base}/api/bootstrap`,{headers:headers('token-admin')})).json()).projects,[]);
  assert.equal((await fetch(`${base}/api/projects/${project.id}`,{method:'DELETE',headers:headers('token-a')})).status,200);
});

test('/api/me 缓存不超过 60 秒且不解析 JWT',async()=>{
  let calls=0;let clock=0;
  const verifier=createSsoVerifier({baseUrl:'https://login.example.com',cacheTtlMs:999_999,now:()=>clock,fetchImpl:async(_url,options)=>{
    calls+=1;assert.equal(options.headers.Authorization,'Bearer opaque.not-a-jwt.value');
    return new Response(JSON.stringify({id:7,name:'用户',roles:[],principal_uid:9}),{status:200,headers:{'content-type':'application/json'}});
  }});
  await verifier.verify('opaque.not-a-jwt.value');clock=59_999;await verifier.verify('opaque.not-a-jwt.value');assert.equal(calls,1);
  clock=60_000;await verifier.verify('opaque.not-a-jwt.value');assert.equal(calls,2);
});

test('前端使用完整飞书 SSO 路径并立即清除 token fragment',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','public','auth.js'),'utf8');
  assert.match(source,/MARGINGO_LOGIN_CENTER_BASE/);
  assert.match(source,/MARGINGO_APP_PUBLIC_URL/);
  assert.match(source,/\/api\/auth\/feishu\/sso/);
  assert.match(source,/\/api\/auth\/feishu\/logout/);
  assert.match(source,/history\.replaceState/);
  assert.doesNotMatch(source,/console-api-shmlkihdla-de\.a\.run\.app|200392\.xyz/);
});
