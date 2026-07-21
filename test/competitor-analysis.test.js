'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {canonicalProductUrl,amazonUrlAllowed,extractFeatureBullets,fetchAmazonBulletsWithRetry,analyzeCompetitorBatch,validateGeminiProducts,friendlyGeminiError}=require('../lib/competitor-analysis');
const {encryptGeminiApiKey,decryptGeminiApiKey,getGeminiApiKey}=require('../lib/gemini-secret');
const {normalizeProxyUrl,getGeminiProxyUrl}=require('../lib/network-proxy');

const amazonHtml=`<!doctype html><html><body><div id="feature-bullets"><ul>
  <li><span class="a-list-item"> Compact handheld size for international travel </span></li>
  <li><span class="a-list-item"> Automatically adapts to 100V-220V voltage </span></li>
  <li><span class="a-list-item"> Rotating steam head saves packing space </span></li>
  <li><span class="a-list-item"> Includes a travel storage bag </span></li>
  <li><span class="a-list-item"> 7.2 ft heat-resistant power cord </span></li>
</ul></div></body></html>`;

test('Amazon 链接限制在对应站点并可由 ASIN 生成',()=>{
  assert.equal(canonicalProductUrl({country_code:'JP',asin:'B0ABC12345'}),'https://www.amazon.co.jp/dp/B0ABC12345');
  assert.equal(canonicalProductUrl({country_code:'JP',product_url:'https://www.amazon.com/dp/B0ABC12345'}),'');
  assert.equal(amazonUrlAllowed('https://www.amazon.co.uk/dp/B0ABC12345','GB'),true);
  assert.equal(amazonUrlAllowed('http://127.0.0.1/product','US'),false);
});

test('只从 Amazon 五点区域提取内容并识别验证码',()=>{
  assert.deepEqual(extractFeatureBullets(amazonHtml).slice(0,2),[
    'Compact handheld size for international travel','Automatically adapts to 100V-220V voltage'
  ]);
  assert.throws(()=>extractFeatureBullets('<title>Robot Check</title><p>Enter the characters you see below</p>'),/验证码/);
});

test('Amazon 首次返回验证码时更换商品页参数重试五点抓取',async()=>{
  const urls=[];let calls=0;
  const bullets=await fetchAmazonBulletsWithRetry('https://www.amazon.com/dp/B0ABC12345','US',{scrapeAttempts:3,fetchImpl:async(url)=>{
    urls.push(url);calls+=1;
    return new Response(calls===1?'<title>Robot Check</title><p>Enter the characters you see below</p>':amazonHtml,{status:200,headers:{'content-type':'text/html'}});
  }});
  assert.equal(calls,2);assert.equal(bullets.length,5);assert.match(urls[1],/[?&]th=1/);assert.match(urls[1],/[?&]psc=1/);
});

test('前五竞品共用一次 Gemini 调用且标题只取数据库 name',async()=>{
  let fetchCount=0,geminiCount=0,received=null;
  const rows=Array.from({length:5},(_,index)=>({id:index+1,country_code:'US',name:`Excel 标题 ${index+1}`,asin:`B0TEST000${index}`,product_url:`https://www.amazon.com/dp/B0TEST000${index}`}));
  const result=await analyzeCompetitorBatch(rows,{apiKey:'test-key',fetchImpl:async()=>{fetchCount+=1;return new Response(amazonHtml,{status:200,headers:{'content-type':'text/html'}})},geminiCall:async(items)=>{
    geminiCount+=1;received=items;return items.map((item)=>({id:item.competitor_id,sellingPoints:['便携设计','电压自适应','易于收纳'],differentiation:['全球电压'],status:'complete'}));
  }});
  assert.equal(fetchCount,5);assert.equal(geminiCount,1);assert.equal(result.rows.length,5);
  assert.deepEqual(received.map((item)=>item.title),rows.map((row)=>row.name));
  assert.ok(received.every((item)=>item.feature_bullets.length===5&&item.product_url===''));
  assert.ok(result.rows.every((row)=>row.status==='complete'&&row.sellingPoints.includes('便携设计')));
});

test('Gemini 结果拒绝重复 ID 并限制短语长度',()=>{
  assert.throws(()=>validateGeminiProducts({products:[{competitor_id:1,selling_points:['便携设计','快速预热','全球电压'],differentiation:[]},{competitor_id:1,selling_points:['轻量便携','出汽稳定','易收纳'],differentiation:[]}]},new Set([1,2])),/重复/);
  const rows=validateGeminiProducts({products:[{competitor_id:1,selling_points:['便携设计','快速预热','全球电压','这是一个超过十个字符的无效卖点短语'],differentiation:['独有双电压','这是一个明显超过十二个字符的差异化短语']} ]},new Set([1]));
  assert.deepEqual(rows[0].sellingPoints,['便携设计','快速预热','全球电压']);
  assert.deepEqual(rows[0].differentiation,['独有双电压']);
  assert.equal(rows[0].status,'complete');
});

test('缺少 Gemini 密钥时在抓取前失败',async()=>{
  await assert.rejects(analyzeCompetitorBatch([],{apiKey:''}),/Gemini API/);
});

test('Gemini 代理支持环境变量和 Windows 代理格式',()=>{
  assert.equal(normalizeProxyUrl('https=127.0.0.1:7890;http=127.0.0.1:7891'),'http://127.0.0.1:7890/');
  assert.equal(normalizeProxyUrl('http://proxy.example:8080'),'http://proxy.example:8080/');
  assert.equal(getGeminiProxyUrl({GEMINI_HTTPS_PROXY:'127.0.0.1:9000'},{windowsProxyReader:()=>''}),'http://127.0.0.1:9000/');
  assert.equal(getGeminiProxyUrl({},{windowsProxyReader:()=> 'http://127.0.0.1:7890/'}),'http://127.0.0.1:7890/');
});

test('Gemini 网络错误转换为可操作的中文提示',()=>{
  const connection=friendlyGeminiError(new TypeError('fetch failed'));assert.equal(connection.statusCode,502);assert.match(connection.message,/代理/);
  const limited=friendlyGeminiError({status:429});assert.equal(limited.statusCode,429);assert.match(limited.message,/限流/);
});

test('Gemini 密钥使用可迁移 AES-256-GCM 密文并拒绝明文配置',()=>{
  const master=crypto.randomBytes(32).toString('base64url');const encrypted=encryptGeminiApiKey('test-gemini-secret',master);
  assert.match(encrypted,/^v1\./);assert.equal(decryptGeminiApiKey(encrypted,master),'test-gemini-secret');
  assert.equal(getGeminiApiKey({GEMINI_API_KEY_ENCRYPTED:encrypted,GEMINI_KEY_ENCRYPTION_KEY:master}),'test-gemini-secret');
  assert.throws(()=>getGeminiApiKey({GEMINI_API_KEY:'plaintext'}),/不允许使用明文/);
  const parts=encrypted.split('.');parts[3]=`${parts[3][0]==='A'?'B':'A'}${parts[3].slice(1)}`;
  assert.throws(()=>decryptGeminiApiKey(parts.join('.'),master),/解密失败/);
});
