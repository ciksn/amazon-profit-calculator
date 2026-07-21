'use strict';

const { requireDatapoolConfig } = require('../dashboard/local-config');
const { getPool,closePool } = require('../dashboard/db');

function value(row,...keys) {
  for (const key of keys) if (row?.[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  return null;
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed=Number(String(value).replace(/[%,$¥￥\s]/g,''));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(input) {
  if (input === null || input === undefined || input === '') return null;
  if (Array.isArray(input)) return input.map((item) => String(item)).join(', ');
  if (typeof input === 'object') return JSON.stringify(input);
  return String(input);
}

function items(body) {
  if (Array.isArray(body)) return body;
  for (const key of ['items','data','rows','list','records','result']) {
    if (Array.isArray(body?.[key])) return body[key];
    if (Array.isArray(body?.data?.[key])) return body.data[key];
  }
  return [];
}

const COUNTRY_CODES = new Map([
  ['澳洲','AU'],['澳大利亚','AU'],['AU','AU'],['美国','US'],['US','US'],['USA','US'],
  ['英国','GB'],['UK','GB'],['GB','GB'],['德国','DE'],['DE','DE'],['日本','JP'],['JP','JP'],
  ['加拿大','CA'],['CA','CA'],['阿联酋','AE'],['AE','AE'],['沙特','SA'],['沙特阿拉伯','SA'],['SA','SA']
  ,['法国','FR'],['FR','FR'],['意大利','IT'],['IT','IT'],['西班牙','ES'],['ES','ES'],
  ['荷兰','NL'],['NL','NL'],['比利时','BE'],['BE','BE'],['瑞典','SE'],['SE','SE'],
  ['波兰','PL'],['PL','PL'],['爱尔兰','IE'],['IE','IE'],['墨西哥','MX'],['MX','MX'],
  ['巴西','BR'],['BR','BR'],['土耳其','TR'],['TR','TR']
]);

function countryCode(input) {
  const text=String(input || '').trim();
  return COUNTRY_CODES.get(text) || COUNTRY_CODES.get(text.toUpperCase()) || text.toUpperCase();
}

function isoDate(value) {
  const text=String(value || '').slice(0,10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

async function fetchJson(baseUrl,apiKey,pathname,options = {},timeoutMs = 60_000) {
  const url=new URL(pathname,`${baseUrl.replace(/\/$/,'')}/`);
  for (const [key,val] of Object.entries(options.query || {})) if (val !== null && val !== undefined && val !== '') url.searchParams.set(key,String(val));
  const response=await fetch(url,{
    method:options.method || 'GET',
    headers:{ 'X-API-Key':apiKey,'accept':'application/json',...(options.body ? { 'content-type':'application/json' } : {}) },
    body:options.body ? JSON.stringify(options.body) : undefined,
    signal:AbortSignal.timeout(timeoutMs)
  });
  const body=await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${pathname} 请求失败（HTTP ${response.status}）：${body?.detail || body?.message || '无返回说明'}`);
  return body;
}

function resolveDateRange(config,rangeBody) {
  const raw=rangeBody?.data || rangeBody || {};
  const end=config.analysis_end_date || value(raw,'end','end_date','max_date','latest_date','数据结束日');
  const start=config.analysis_start_date || value(raw,'start','start_date','min_date','earliest_date','数据开始日');
  const today=new Date();
  const fallbackEnd=today.toISOString().slice(0,10);
  const fallbackStart=new Date(Date.UTC(today.getUTCFullYear(),0,1)).toISOString().slice(0,10);
  return { start:isoDate(start) || fallbackStart,end:isoDate(end) || fallbackEnd };
}

async function saveSnapshot(client,syncId,endpoint,requestKey,response) {
  await client.query(`INSERT INTO datapool_raw_snapshots(sync_id,endpoint,request_key,response)
    VALUES($1,$2,$3,$4::jsonb)`,[syncId,endpoint,requestKey,JSON.stringify(response)]);
}

async function sync() {
  const { config }=requireDatapoolConfig();
  const baseUrl=config.base_url;
  const timeout=Number(config.request_timeout_ms || 60_000);
  const pool=getPool();
  const run=await pool.query("INSERT INTO datapool_sync_runs(status) VALUES('running') RETURNING id");
  const syncId=run.rows[0].id;
  try {
    const [principalBody,sellerBody,rangeBody]=await Promise.all([
      fetchJson(baseUrl,config.api_key,'/api/principals',{},timeout),
      fetchJson(baseUrl,config.api_key,'/api/sellers',{ query:{ status:1 } },timeout),
      fetchJson(baseUrl,config.api_key,'/api/sales/range',{},timeout)
    ]);
    const principals=items(principalBody);
    const sellers=items(sellerBody);
    if (!sellers.length) throw new Error('数据池没有返回在售店铺，已停止同步');
    const productResponses=await Promise.all(sellers.map(async (seller) => {
      const sid=value(seller,'sid','店铺ID');
      const body=await fetchJson(baseUrl,config.api_key,'/api/products',{ query:{ sid,limit:10000 } },timeout);
      return { sid,body };
    }));
    const range=resolveDateRange(config,rangeBody);
    const sids=sellers.map((row) => number(value(row,'sid','店铺ID'))).filter(Number.isFinite);
    const analysisBody=await fetchJson(baseUrl,config.api_key,'/api/analysis/products',{
      method:'POST',body:{ start_date:range.start,end_date:range.end,sids }
    },timeout);
    const analyses=items(analysisBody);
    const products=productResponses.flatMap(({ body }) => items(body));

    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await saveSnapshot(client,syncId,'/api/principals','all',principalBody);
      await saveSnapshot(client,syncId,'/api/sellers','status=1',sellerBody);
      await saveSnapshot(client,syncId,'/api/sales/range','all',rangeBody);
      for (const entry of productResponses) await saveSnapshot(client,syncId,'/api/products',`sid=${entry.sid}`,entry.body);
      await saveSnapshot(client,syncId,'/api/analysis/products',`${range.start}:${range.end}`,analysisBody);

      for (const row of principals) {
        const uid=String(value(row,'uid','负责人ID') || '');
        const name=String(value(row,'name','姓名') || '');
        if (uid && name) await client.query('INSERT INTO datapool_principals(sync_id,uid,name,raw) VALUES($1,$2,$3,$4::jsonb)',[syncId,uid,name,JSON.stringify(row)]);
      }
      for (const row of sellers) {
        const sid=number(value(row,'sid','店铺ID'));
        if (sid == null) continue;
        await client.query(`INSERT INTO datapool_sellers(sync_id,sid,name,country,marketplace_id,region,status,raw)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[syncId,sid,value(row,'name','店铺名'),countryCode(value(row,'country','站点')),
          value(row,'marketplace_id','市场ID'),value(row,'region','区域'),number(value(row,'status','在售状态')),JSON.stringify(row)]);
      }
      for (const row of products) {
        const sid=number(value(row,'sid','店铺ID'));
        const asin=String(value(row,'asin','子ASIN') || '');
        if (sid == null || !asin) continue;
        await client.query(`INSERT INTO datapool_products
          (sync_id,sid,asin,parent_asin,seller_sku,fnsku,item_name,small_image_url,principal_uid,status,item_weight,
           category,listing_price,currency,package_weight,package_weight_unit,weight_kg,weight_lb,weight_g,
           package_length,package_width,package_height,package_dim_unit,length_cm,width_cm,height_cm,
           length_in,width_in,height_in,volume_cm3,raw)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::jsonb)`,[syncId,sid,asin,value(row,'parent_asin','父ASIN'),
          value(row,'seller_sku','后台SKU'),value(row,'fnsku','FNSKU'),value(row,'item_name','标题'),
          value(row,'small_image_url','缩略图'),value(row,'principal_uid','负责人ID'),number(value(row,'status','在售状态')),
          number(value(row,'item_weight','单件重量')),stringValue(value(row,'category','品类')),
          number(value(row,'listing_price','price','当前售价')),stringValue(value(row,'currency','币种')),
          number(value(row,'package_weight','包装重量')),stringValue(value(row,'package_weight_unit','包装重量单位')),
          number(value(row,'weight_kg')),number(value(row,'weight_lb')),number(value(row,'weight_g')),
          number(value(row,'package_length')),number(value(row,'package_width')),number(value(row,'package_height')),
          stringValue(value(row,'package_dim_unit')),number(value(row,'length_cm')),number(value(row,'width_cm')),
          number(value(row,'height_cm')),number(value(row,'length_in')),number(value(row,'width_in')),
          number(value(row,'height_in')),number(value(row,'volume_cm3')),JSON.stringify(row)]);
      }
      for (const row of analyses) {
        const sid=number(value(row,'sid','店铺ID'));
        const asin=String(value(row,'asin','子ASIN','ASIN') || '');
        if (!asin) continue;
        await client.query(`INSERT INTO datapool_analysis_products
          (sync_id,sid,asin,product_name,owner_name,image_url,country,gross_profit,gross_rate,total_sales,total_qty,purchase_unit_price,head_unit_price,raw)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,[syncId,sid,asin,
          value(row,'product_name','item_name','品名'),value(row,'owner_name','principal_name','负责人'),
          value(row,'image_url','small_image_url','缩略图'),countryCode(value(row,'country','国家','站点')),
          number(value(row,'gross_profit','毛利润')),number(value(row,'gross_rate','毛利率')),
          number(value(row,'total_sales','总销售额')),number(value(row,'total_qty','总销量')),
          number(value(row,'purchase_unit_price','cg_unit_price_eff','采购均价')),
          number(value(row,'head_unit_price','head_unit_price_eff','头程均价')),JSON.stringify(row)]);
      }
      await client.query(`UPDATE datapool_sync_runs SET status='completed',finished_at=now(),analysis_start_date=$2,
        analysis_end_date=$3,principal_count=$4,seller_count=$5,product_count=$6,analysis_count=$7 WHERE id=$1`,
      [syncId,range.start,range.end,principals.length,sellers.length,products.length,analyses.length]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    console.log(`同步完成：负责人 ${principals.length}，店铺 ${sellers.length}，产品行 ${products.length}，利润分析 ${analyses.length}。`);
    console.log(`利润分析区间：${range.start} 至 ${range.end}；本地快照 ID：${syncId}`);
  } catch (error) {
    await pool.query("UPDATE datapool_sync_runs SET status='failed',finished_at=now(),error_message=$2 WHERE id=$1",[syncId,String(error.message).slice(0,2000)]).catch(()=>{});
    throw error;
  }
}

if (require.main === module) sync().finally(closePool).catch((error) => { console.error(error.message);process.exitCode=1; });

module.exports = { value,number,stringValue,items,countryCode,resolveDateRange,sync };
