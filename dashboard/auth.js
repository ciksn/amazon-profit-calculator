'use strict';

const crypto = require('node:crypto');

const SESSION_COOKIE = 'margingo_session';
const STATE_COOKIE = 'margingo_oauth_state';

function requireConfig() {
  const required = ['FEISHU_APP_ID','FEISHU_APP_SECRET','FEISHU_REDIRECT_URI','SESSION_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`缺少登录配置：${missing.join(', ')}`);
  if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET 至少需要 32 个字符');
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [decodeURIComponent(part.slice(0,index)),decodeURIComponent(part.slice(index + 1))];
  }));
}

function sign(value) {
  return crypto.createHmac('sha256',process.env.SESSION_SECRET).update(value).digest('base64url');
}

function seal(payload) {
  const value = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${value}.${sign(value)}`;
}

function unseal(token) {
  const [value,signature] = String(token || '').split('.');
  if (!value || !signature) return null;
  const expected = sign(value);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    return Number(payload.exp) > Date.now() ? payload : null;
  } catch { return null; }
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`,'Path=/','HttpOnly','SameSite=Lax'];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function isSecure() {
  return process.env.NODE_ENV === 'production' || String(process.env.FEISHU_REDIRECT_URI || '').startsWith('https://');
}

function beginLogin(res) {
  requireConfig();
  const state = crypto.randomBytes(24).toString('base64url');
  const stateToken = seal({ state,exp:Date.now() + 5 * 60_000 });
  res.setHeader('Set-Cookie',cookie(STATE_COOKIE,stateToken,{ maxAge:300,secure:isSecure() }));
  const authorize = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  authorize.searchParams.set('client_id',process.env.FEISHU_APP_ID);
  authorize.searchParams.set('redirect_uri',process.env.FEISHU_REDIRECT_URI);
  authorize.searchParams.set('response_type','code');
  authorize.searchParams.set('state',state);
  res.writeHead(302,{ Location:authorize.toString() });
  res.end();
}

async function exchangeCode(code) {
  const response = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token',{
    method:'POST',
    headers:{ 'content-type':'application/json; charset=utf-8','accept':'application/json' },
    body:JSON.stringify({
      grant_type:'authorization_code',client_id:process.env.FEISHU_APP_ID,
      client_secret:process.env.FEISHU_APP_SECRET,code,redirect_uri:process.env.FEISHU_REDIRECT_URI
    }),
    signal:AbortSignal.timeout(10_000)
  });
  const body = await response.json();
  if (!response.ok || body.code) throw new Error(body.error_description || body.msg || '飞书授权码兑换失败');
  return body.access_token;
}

async function fetchUser(accessToken) {
  const response = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info',{
    headers:{ Authorization:`Bearer ${accessToken}`,'content-type':'application/json; charset=utf-8' },
    signal:AbortSignal.timeout(10_000)
  });
  const body = await response.json();
  if (!response.ok || body.code) throw new Error(body.msg || '获取飞书用户信息失败');
  return body.data || body;
}

async function finishLogin(req,res,url) {
  requireConfig();
  const statePayload = unseal(parseCookies(req)[STATE_COOKIE]);
  if (!statePayload || statePayload.state !== url.searchParams.get('state')) throw new Error('登录状态已失效，请重新从登录页进入');
  const code = url.searchParams.get('code');
  if (!code) throw new Error(url.searchParams.get('error_description') || '飞书未返回授权码');
  const accessToken = await exchangeCode(code);
  const user = await fetchUser(accessToken);
  const ttl = Number(process.env.SESSION_TTL_SECONDS || 28_800);
  const session = seal({
    open_id:user.open_id,union_id:user.union_id || '',user_id:user.user_id || '',
    name:user.name || user.en_name || '飞书用户',avatar_url:user.avatar_url || user.avatar_thumb || '',
    exp:Date.now() + ttl * 1000
  });
  res.setHeader('Set-Cookie',[
    cookie(SESSION_COOKIE,session,{ maxAge:ttl,secure:isSecure() }),
    cookie(STATE_COOKIE,'',{ maxAge:0,secure:isSecure() })
  ]);
  res.writeHead(302,{ Location:'/' });
  res.end();
}

function currentUser(req) {
  if (!process.env.SESSION_SECRET) return null;
  return unseal(parseCookies(req)[SESSION_COOKIE]);
}

function setDevUser(res,name) {
  if (process.env.NODE_ENV === 'production' || String(process.env.DEV_AUTH_BYPASS).toLowerCase() !== 'true') return false;
  const ttl = Number(process.env.SESSION_TTL_SECONDS || 28_800);
  const session = seal({ open_id:'dev-local',union_id:'',user_id:'',name,avatar_url:'',exp:Date.now() + ttl * 1000 });
  res.setHeader('Set-Cookie',cookie(SESSION_COOKIE,session,{ maxAge:ttl,secure:false }));
  return true;
}

function logout(res) {
  res.setHeader('Set-Cookie',cookie(SESSION_COOKIE,'',{ maxAge:0,secure:isSecure() }));
}

module.exports = { beginLogin, finishLogin, currentUser, setDevUser, logout, seal, unseal };
