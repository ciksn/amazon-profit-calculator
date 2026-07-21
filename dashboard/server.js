'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { getPool, closePool } = require('./db');
const { loadLocalConfig } = require('./local-config');
const auth = require('./auth');
const { getDashboard: getCompanyDashboard } = require('./service');
const manual = require('./manual-service');
const { parseWorkbookBase64 } = require('./excel-import');

const PORT = Number(process.env.PORT || 4180);
const publicDir = path.join(__dirname,'public');
const localConfig=loadLocalConfig().config;
const authMode=String(process.env.AUTH_MODE || 'local').toLowerCase();

function requestUser(req,url) {
  if (authMode === 'local') {
    const name=String(localConfig.owner_name || url?.searchParams.get('owner') || '').trim();
    return { name:name || '本地数据',avatar_url:'',all_owners:!name };
  }
  return auth.currentUser(req);
}

function json(res,status,body) {
  res.writeHead(status,{ 'content-type':'application/json; charset=utf-8','cache-control':'no-store' });
  res.end(JSON.stringify(body));
}

function applyCors(req,res) {
  const origin=req.headers.origin;
  if (!origin || !['http://127.0.0.1:4173','http://localhost:4173'].includes(origin)) return;
  res.setHeader('access-control-allow-origin',origin);
  res.setHeader('vary','Origin');
  res.setHeader('access-control-allow-headers','Content-Type');
  res.setHeader('access-control-allow-methods','GET,POST,PUT,DELETE,OPTIONS');
}

function readBody(req) {
  return new Promise((resolve,reject) => {
    let raw='';
    req.on('data',(chunk) => { raw += chunk;if (raw.length > 16_000_000) reject(new Error('请求内容过大')); });
    req.on('end',() => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 格式不正确')); } });
    req.on('error',reject);
  });
}

function redirect(res,location) {
  res.writeHead(302,{ Location:location });
  res.end();
}

function staticFile(res,url) {
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(publicDir,requestPath));
  if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file,(error,data) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml' };
    res.writeHead(200,{ 'content-type':mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handle(req,res) {
  const url = new URL(req.url,`http://${req.headers.host || '127.0.0.1'}`);
  applyCors(req,res);
  if (req.method === 'OPTIONS') { res.writeHead(204);return res.end(); }
  if (req.method === 'GET' && url.pathname === '/calculator') return redirect(res,process.env.CALCULATOR_URL || 'http://127.0.0.1:4173');
  if (req.method === 'GET' && url.pathname === '/api/health') { await getPool().query('SELECT 1'); return json(res,200,{ ok:true }); }
  if (req.method === 'GET' && url.pathname === '/api/auth/login') return authMode === 'feishu' ? auth.beginLogin(res) : redirect(res,'/');
  if (req.method === 'GET' && url.pathname === '/api/auth/callback') return authMode === 'feishu' ? auth.finishLogin(req,res,url) : json(res,404,{ error:'飞书登录当前已隔离' });
  if (req.method === 'GET' && url.pathname === '/api/auth/dev') {
    const name = url.searchParams.get('name') || process.env.DEV_AUTH_NAME || '测试负责人';
    return auth.setDevUser(res,name) ? redirect(res,'/') : json(res,404,{ error:'接口不存在' });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') { auth.logout(res); return json(res,200,{ ok:true }); }
  if (url.pathname.startsWith('/api/')) {
    const user = requestUser(req,url);
    if (!user) return json(res,401,{ error:'请先通过飞书登录',login_url:'/api/auth/login' });
    if (req.method === 'GET' && url.pathname === '/api/me') return json(res,200,{ name:user.name,avatar_url:user.avatar_url || '' });
    if (req.method === 'GET' && url.pathname === '/api/owners' && authMode === 'local') {
      const available=await manual.filters(getPool());
      return json(res,200,{ configured_owner:String(localConfig.owner_name || '').trim(),owners:available.owners });
    }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const payload=await manual.getDashboard(getPool(),{
        owner:url.searchParams.get('owner'),site:url.searchParams.get('site'),search:url.searchParams.get('search'),
        profit:url.searchParams.get('profit'),sort:url.searchParams.get('sort')
      });
      return json(res,200,{ user:{ name:url.searchParams.get('owner') || '全部负责人',avatar_url:'' },...payload });
    }
    if (req.method === 'GET' && url.pathname === '/api/company-dashboard') {
      if (authMode === 'local' && user.all_owners) return json(res,400,{ error:'请先选择负责人' });
      return json(res,200,await getCompanyDashboard(getPool(),user,{ site:url.searchParams.get('site'),search:url.searchParams.get('search') }));
    }
    if (req.method === 'POST' && url.pathname === '/api/manual-products') return json(res,201,await manual.saveProduct(getPool(),await readBody(req)));
    if (req.method === 'POST' && url.pathname === '/api/manual-products/from-calculator') return json(res,200,await manual.saveProduct(getPool(),await readBody(req),{ upsert:true }));
    if (req.method === 'POST' && url.pathname === '/api/manual-products/import') return json(res,200,await manual.importProducts(getPool(),(await readBody(req)).rows));
    if (req.method === 'POST' && url.pathname === '/api/manual-products/import-excel') {
      const body=await readBody(req);
      return json(res,200,await manual.importProducts(getPool(),await parseWorkbookBase64(body.file_base64)));
    }
    const productMatch=url.pathname.match(/^\/api\/manual-products\/(\d+)$/);
    if (productMatch && req.method === 'GET') {
      const product=await manual.getProduct(getPool(),Number(productMatch[1]));
      return product ? json(res,200,product) : json(res,404,{ error:'产品不存在' });
    }
    if (productMatch && req.method === 'PUT') {
      const product=await manual.updateProduct(getPool(),Number(productMatch[1]),await readBody(req));
      return product ? json(res,200,product) : json(res,404,{ error:'产品不存在' });
    }
    if (productMatch && req.method === 'DELETE') {
      const deleted=await manual.deleteProduct(getPool(),Number(productMatch[1]));
      return json(res,deleted ? 200 : 404,deleted ? { ok:true } : { error:'产品不存在' });
    }
    return json(res,404,{ error:'接口不存在' });
  }
  return staticFile(res,url);
}

const server = http.createServer((req,res) => handle(req,res).catch((error) => {
  console.error(error);
  const status = /登录状态|授权码|飞书/.test(error.message) ? 401 : /请填写|缺少|格式|重复|不存在|Excel|不能/.test(error.message) ? 400 : 500;
  json(res,status,{ error:status === 500 ? '服务暂时不可用' : error.message });
}));

if (require.main === module) server.listen(PORT,'127.0.0.1',() => console.log(`个人利润率看板已启动：http://127.0.0.1:${PORT}`));

async function shutdown() { await new Promise((resolve) => server.close(resolve)); await closePool(); }

module.exports = { server,handle,shutdown };
