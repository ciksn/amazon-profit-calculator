'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('./lib/db');
const { calculateProfit,findSalePriceForProfitRate } = require('./lib/profit');
const { lookupJapanTariff } = require('./lib/japan-tariff');
const competitorAnalysis = require('./lib/competitor-analysis');
const PORT = Number(process.env.PORT || 4173);
const publicDir = path.join(__dirname,'public');
const excelJsBrowserFile = require.resolve('exceljs/dist/exceljs.min.js');

function json(res,status,body) {
  res.writeHead(status,{ 'Content-Type':'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function applyCors(req,res) {
  const origin=req.headers.origin;
  if (!origin) return;
  const allowed=String(process.env.CORS_ORIGINS || '').split(',').map((item)=>item.trim()).filter(Boolean);
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Workspace-Key');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  }
}

function readBody(req) {
  return new Promise((resolve,reject)=>{
    let raw='';
    req.on('data',(chunk)=>{ raw+=chunk;if (raw.length>2_000_000) reject(new Error('请求内容过大')); });
    req.on('end',()=>{ try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 格式不正确')); } });
    req.on('error',reject);
  });
}

function updateSql(table,fields,key,indexOffset=1) {
  return `UPDATE ${table} SET ${fields.map((field,index)=>`${field} = $${index+indexOffset}`).join(', ')} WHERE ${key}`;
}

async function matchCommission(countryCode,text,salePrice=0) {
  const rules=await db.many('SELECT * FROM commission_rules WHERE country_code = $1',[countryCode]);
  const normalized=String(text || '').toLowerCase().replace(/[&/，、|]/g,' ');
  let best=null;let bestScore=0;let fallback=null;
  for (const rule of rules) {
    const price=Number(salePrice) || 0;
    if (rule.min_price != null && price<Number(rule.min_price)) continue;
    if (rule.max_price != null && price>Number(rule.max_price)) continue;
    const fallbackName=String(rule.parent_category || '').toLowerCase();
    const isFallback=fallbackName.includes('other') || fallbackName.includes('其他') || fallbackName.includes('其它');
    if (isFallback) { fallback ||= rule;continue; }
    const terms=`${rule.parent_category},${rule.keywords}`.toLowerCase().split(/[,/]/).map((x)=>x.trim()).filter(Boolean);
    const score=terms.reduce((sum,term)=>sum+(normalized.includes(term) ? Math.max(1,term.length) : 0),0);
    if (score>bestScore) { best=rule;bestScore=score; }
  }
  if (bestScore) return { matched:true,fallback:false,score:bestScore,rule:best };
  if (fallback) return { matched:true,fallback:true,score:0,rule:fallback };
  return { matched:false,fallback:false,rule:null };
}

async function getProject(id) {
  const project=await db.one('SELECT * FROM projects WHERE id = $1',[id]);
  if (!project) return null;
  project.listings=await db.many(`SELECT pc.*,c.name AS country_name,c.flag,c.currency,c.symbol,
      f.id AS freight_rule_id,f.pricing_mode AS freight_pricing_mode,
      f.price_per_kg_cny AS freight_price_per_kg_cny,f.price_per_cbm_cny AS freight_price_per_cbm_cny
    FROM project_countries pc JOIN countries c ON c.code=pc.country_code
    LEFT JOIN freight_rules f ON f.country_code=pc.country_code
    WHERE pc.project_id=$1 AND c.active=TRUE ORDER BY c.priority`,[id]);
  for (const listing of project.listings) {
    if (listing.referral_rate_override != null || !listing.category_text) continue;
    const matched=await matchCommission(listing.country_code,listing.category_text,listing.sale_price);
    if (matched.matched) Object.assign(listing,{ matched_category:matched.rule.parent_category,
      matched_referral_rate:matched.rule.rate,matched_referral_threshold:matched.rule.threshold_price,
      matched_referral_rate_above:matched.rule.rate_above,matched_referral_minimum:matched.rule.minimum_fee || 0,
      commission_fallback:Boolean(matched.fallback) });
  }
  return project;
}

async function calculateCompetitor(row) {
  const project=await getProject(Number(row.project_id));
  if (!project) return null;
  const listing=project.listings.find((item)=>item.country_code===row.country_code);
  const country=await db.one('SELECT * FROM countries WHERE code=$1 AND active=TRUE',[row.country_code]);
  if (!listing || !country) return { ...row,profit_rate:null,profit:null };
  const usesProjectDefaults=Boolean(row.uses_project_defaults);
  const competitorProject={ ...project,
    cost_cny:usesProjectDefaults ? project.cost_cny : row.cost_cny,
    length:usesProjectDefaults ? project.length : row.length,width:usesProjectDefaults ? project.width : row.width,
    height:usesProjectDefaults ? project.height : row.height,
    dimension_unit:usesProjectDefaults ? project.dimension_unit : row.dimension_unit,
    weight:usesProjectDefaults ? project.weight : row.weight,weight_unit:usesProjectDefaults ? project.weight_unit : row.weight_unit };
  const categoryText=usesProjectDefaults ? listing.category_text : row.category_text;
  const competitorListing={ ...listing,sale_price:row.sale_price,category_text:categoryText };
  if (competitorListing.referral_rate_override == null && competitorListing.category_text) {
    const matched=await matchCommission(row.country_code,competitorListing.category_text,row.sale_price);
    if (matched.matched) Object.assign(competitorListing,{ matched_category:matched.rule.parent_category,
      matched_referral_rate:matched.rule.rate,matched_referral_threshold:matched.rule.threshold_price,
      matched_referral_rate_above:matched.rule.rate_above,matched_referral_minimum:matched.rule.minimum_fee || 0 });
  }
  const [fbaRules,sizeTiers,freightRule]=await Promise.all([
    !usesProjectDefaults && row.is_fba === 0 ? [] : db.many('SELECT * FROM fba_rules WHERE country_code=$1',[country.code]),
    db.many('SELECT * FROM size_tiers WHERE country_code=$1',[country.code]),
    db.one('SELECT * FROM freight_rules WHERE country_code=$1',[country.code])
  ]);
  const calculated=calculateProfit({ project:competitorProject,country,listing:competitorListing,fbaRules,sizeTiers,freightRule });
  const filled=Boolean(String(row.name || '').trim()) && Number(row.sale_price)>0;
  return { ...row,cost_cny:competitorProject.cost_cny,length:competitorProject.length,width:competitorProject.width,
    height:competitorProject.height,dimension_unit:competitorProject.dimension_unit,weight:competitorProject.weight,
    weight_unit:competitorProject.weight_unit,category_text:categoryText,symbol:country.symbol,country_name:country.name,
    flag:country.flag,profit_rate:filled ? calculated.profit_rate : null,profit:filled ? calculated.profit : null,
    calculation:filled ? calculated : null };
}

async function listCompetitors(projectId) {
  const rows=await db.many('SELECT * FROM project_competitors WHERE project_id=$1 ORDER BY country_code,monthly_revenue_local DESC,id',[projectId]);
  const perCountry={};const visible=rows.filter((row)=>(perCountry[row.country_code]=(perCountry[row.country_code]||0)+1)<=5);
  return Promise.all(visible.map(calculateCompetitor));
}

async function competitorCounts(projectId) {
  const rows=await db.many('SELECT country_code,COUNT(*)::int AS count FROM project_competitors WHERE project_id=$1 GROUP BY country_code',[projectId]);
  return Object.fromEntries(rows.map((row)=>[row.country_code,row.count]));
}

const competitorImportFields=['asin','image_url','product_url','is_fba','has_aplus','has_video','listing_date',
  'monthly_sales','monthly_revenue_local','monthly_revenue_usd','rating','source_format','source_row'];
const competitorParameterImportFields=['length','width','height','dimension_unit','weight','weight_unit','category_text'];
function importedCompetitorValues(body={}) {
  const short=(value,max=4000)=>String(value??'').trim().slice(0,max);
  const numeric=(value)=>Number.isFinite(Number(value))?Number(value):0;
  const rounded=(value,digits)=>Number(numeric(value).toFixed(digits));
  const nullableNumber=(value)=>value==null||value===''?null:(Number.isFinite(Number(value))?Number(value):null);
  const nullableBoolean=(value)=>value==null?null:Number(Boolean(value));
  const webUrl=(value)=>{const url=short(value);return /^https?:\/\//i.test(url)?url:''};
  return { name:short(body.name,1000),sale_price:numeric(body.sale_price),asin:short(body.asin,32).toUpperCase(),
    image_url:webUrl(body.image_url),product_url:webUrl(body.product_url),is_fba:nullableBoolean(body.is_fba),
    has_aplus:nullableBoolean(body.has_aplus),has_video:nullableBoolean(body.has_video),listing_date:short(body.listing_date,80),
    monthly_sales:numeric(body.monthly_sales),monthly_revenue_local:numeric(body.monthly_revenue_local),
    monthly_revenue_usd:numeric(body.monthly_revenue_usd),rating:nullableNumber(body.rating),
    source_format:short(body.source_format,40),source_row:Math.max(0,Math.trunc(numeric(body.source_row))),
    length:rounded(body.length,2),width:rounded(body.width,2),height:rounded(body.height,2),dimension_unit:body.dimension_unit==='ft'?'ft':'cm',
    weight:rounded(body.weight,3),weight_unit:body.weight_unit==='lb'?'lb':'kg',category_text:short(body.category_text,500) };
}

async function insertCompetitor(project,countryCode,body={},importedFromExcel=false,client=null) {
  const listing=project.listings.find((item)=>item.country_code===countryCode);const imported=importedCompetitorValues(body);const now=new Date().toISOString();
  const values={ project_id:project.id,country_code:countryCode,name:imported.name,sale_price:imported.sale_price,
    cost_cny:Number(body.cost_cny??project.cost_cny)||0,
    length:importedFromExcel?imported.length:Number(body.length??project.length)||0,
    width:importedFromExcel?imported.width:Number(body.width??project.width)||0,
    height:importedFromExcel?imported.height:Number(body.height??project.height)||0,
    dimension_unit:importedFromExcel?imported.dimension_unit:(body.dimension_unit||project.dimension_unit),
    weight:importedFromExcel?imported.weight:Number(body.weight??project.weight)||0,
    weight_unit:importedFromExcel?imported.weight_unit:(body.weight_unit||project.weight_unit),
    category_text:importedFromExcel?imported.category_text:(body.category_text??listing.category_text),
    uses_project_defaults:importedFromExcel?0:1,created_at:now,updated_at:now };
  for (const field of competitorImportFields) values[field]=imported[field];
  const columns=Object.keys(values);const params=columns.map((column)=>values[column]);
  const sql=`INSERT INTO project_competitors (${columns.join(',')}) VALUES (${columns.map((_,index)=>`$${index+1}`).join(',')}) RETURNING *`;
  return client ? (await client.query(sql,params)).rows[0] : db.one(sql,params);
}

async function bootstrap() {
  const [countries,projects,fba,freightMissing,commission]=await Promise.all([
    db.many('SELECT * FROM countries WHERE active=TRUE ORDER BY priority'),
    db.many('SELECT * FROM projects ORDER BY updated_at DESC,id DESC'),
    db.one('SELECT COUNT(*)::int AS n FROM fba_rules f JOIN countries c ON c.code=f.country_code WHERE c.active=TRUE'),
    db.one("SELECT COUNT(*)::int AS n FROM freight_rules f JOIN countries c ON c.code=f.country_code WHERE c.active=TRUE AND f.status='missing'"),
    db.one('SELECT COUNT(*)::int AS n FROM commission_rules r JOIN countries c ON c.code=r.country_code WHERE c.active=TRUE')
  ]);
  return { countries,projects,ruleCounts:{ fba:fba.n,freightMissing:freightMissing.n,commission:commission.n } };
}

async function embedBootstrap(project) {
  const [countries,fba,freightMissing,commission]=await Promise.all([
    db.many('SELECT * FROM countries WHERE active=TRUE ORDER BY priority'),
    db.one('SELECT COUNT(*)::int AS n FROM fba_rules f JOIN countries c ON c.code=f.country_code WHERE c.active=TRUE'),
    db.one("SELECT COUNT(*)::int AS n FROM freight_rules f JOIN countries c ON c.code=f.country_code WHERE c.active=TRUE AND f.status='missing'"),
    db.one('SELECT COUNT(*)::int AS n FROM commission_rules r JOIN countries c ON c.code=r.country_code WHERE c.active=TRUE')
  ]);
  return { countries,project,ruleCounts:{ fba:fba.n,freightMissing:freightMissing.n,commission:commission.n } };
}

async function createProject(body) {
  const now=new Date().toISOString();
  const requestedShareKey=String(body.share_key||'').trim();
  const shareKey=/^[A-Za-z0-9_-]{8,120}$/.test(requestedShareKey)?requestedShareKey:crypto.randomUUID();
  const project=await db.one(`INSERT INTO projects
    (share_key,name,cost_cny,length,width,height,dimension_unit,weight,weight_unit,created_at,updated_at)
    VALUES ($1,$2,0,0,0,0,'cm',0,'kg',$3,$3) RETURNING *`,[shareKey,body.name || '未命名品类',now]);
  await db.query(`INSERT INTO project_countries(project_id,country_code,selected)
    SELECT $1::integer,code,CASE WHEN code='AU' THEN 1 ELSE 0 END FROM countries`,[project.id]);
  return getProject(project.id);
}

function workspaceKey(req) {
  const value=String(req.headers['x-workspace-key'] || '').trim();
  return /^[A-Za-z0-9_-]{8,120}$/.test(value) ? value : '';
}

async function prepareEmbedRequest(req,res,url) {
  if (url.pathname==='/api/embed/instances' && req.method==='POST') {
    const project=await createProject({ name:'新品测算 01' });
    return json(res,201,{ access_key:project.share_key,project });
  }

  const key=workspaceKey(req);
  if (!key) { json(res,401,{ error:'缺少测算实例访问码' });return true; }
  const row=await db.one('SELECT id FROM projects WHERE share_key=$1',[key]);
  if (!row) { json(res,404,{ error:'测算实例不存在或访问码已失效' });return true; }
  const projectId=Number(row.id);req.embedProjectId=projectId;

  if (url.pathname==='/api/embed/bootstrap' && req.method==='GET') {
    return json(res,200,await embedBootstrap(await getProject(projectId)));
  }
  if (url.pathname==='/api/embed/project') {
    if (!['GET','PUT'].includes(req.method)) { json(res,405,{ error:'嵌入卡片不能删除测算实例' });return true; }
    url.pathname=`/api/projects/${projectId}`;return false;
  }
  const country=url.pathname.match(/^\/api\/embed\/countries\/([A-Z]{2})$/);
  if (country) { url.pathname=`/api/projects/${projectId}/countries/${country[1]}`;return false; }
  const competitorCollection=url.pathname.match(/^\/api\/embed\/competitors(?:\/(import|analyze))?$/);
  if (competitorCollection) {
    url.pathname=`/api/projects/${projectId}/competitors${competitorCollection[1] ? `/${competitorCollection[1]}` : ''}`;return false;
  }
  const competitorItem=url.pathname.match(/^\/api\/embed\/competitors\/(\d+)$/);
  if (competitorItem) {
    const owned=await db.one('SELECT id FROM project_competitors WHERE id=$1 AND project_id=$2',[Number(competitorItem[1]),projectId]);
    if (!owned) { json(res,404,{ error:'竞品不存在' });return true; }
    url.pathname=`/api/competitors/${competitorItem[1]}`;return false;
  }
  if (url.pathname==='/api/embed/calculate') { url.pathname='/api/calculate';return false; }
  if (url.pathname==='/api/embed/site-card-records') {
    url.pathname=`/api/projects/${projectId}/site-card-records`;return false;
  }
  const recordItem=url.pathname.match(/^\/api\/embed\/site-card-records\/([^/]+)$/);
  if (recordItem) {
    const id=decodeURIComponent(recordItem[1]);
    const owned=await db.one('SELECT id FROM site_card_records WHERE id=$1 AND project_id=$2',[id,projectId]);
    if (!owned) { json(res,404,{ error:'方案记录不存在' });return true; }
    url.pathname=`/api/site-card-records/${encodeURIComponent(id)}`;return false;
  }
  json(res,404,{ error:'嵌入接口不存在' });return true;
}

async function api(req,res,url) {
  if (url.pathname.startsWith('/api/embed/')) {
    const handled=await prepareEmbedRequest(req,res,url);
    if (handled !== false) return handled;
  }
  const method=req.method;
  if (method==='GET' && url.pathname==='/api/health') { await db.ready();return json(res,200,{ ok:true,database:'postgresql' }); }
  if (method==='GET' && url.pathname==='/api/bootstrap') return json(res,200,await bootstrap());
  if (method==='POST' && url.pathname==='/api/projects') return json(res,201,await createProject(await readBody(req)));

  const shareProjectMatch=url.pathname.match(/^\/api\/projects\/by-share-key\/([A-Za-z0-9_-]{8,120})$/);
  if (shareProjectMatch && method==='GET') {
    const row=await db.one('SELECT id FROM projects WHERE share_key=$1',[shareProjectMatch[1]]);
    if (!row) return json(res,404,{ error:'分享项目不存在' });
    return json(res,200,await getProject(row.id));
  }

  const siteCardCollectionMatch=url.pathname.match(/^\/api\/projects\/(\d+)\/site-card-records$/);
  if (siteCardCollectionMatch && method==='GET') {
    const projectId=Number(siteCardCollectionMatch[1]);
    if (!await db.one('SELECT id FROM projects WHERE id=$1',[projectId])) return json(res,404,{ error:'品类不存在' });
    const countryCode=String(url.searchParams.get('country_code')||'').toUpperCase();
    const params=[projectId];let where='project_id=$1';
    if (countryCode) { params.push(countryCode);where+=' AND country_code=$2'; }
    const records=await db.many(`SELECT * FROM site_card_records WHERE ${where} ORDER BY created_at,id`,params);
    return json(res,200,{ records });
  }
  if (siteCardCollectionMatch && method==='POST') {
    const projectId=Number(siteCardCollectionMatch[1]);const project=await getProject(projectId);
    if (!project) return json(res,404,{ error:'品类不存在' });
    const body=await readBody(req);const countryCode=String(body.country_code||'').toUpperCase();
    if (!project.listings.some((item)=>item.country_code===countryCode)) return json(res,400,{ error:'站点不存在' });
    const requestedId=String(body.id||'').trim();const id=/^[A-Za-z0-9._:-]{1,120}$/.test(requestedId)?requestedId:crypto.randomUUID();
    const existing=await db.one('SELECT * FROM site_card_records WHERE id=$1',[id]);
    if (existing) {
      if (Number(existing.project_id)!==projectId) return json(res,409,{ error:'方案记录 ID 已存在' });
      return json(res,200,existing);
    }
    const snapshot=body.snapshot&&typeof body.snapshot==='object'&&!Array.isArray(body.snapshot)?body.snapshot:{};
    const now=new Date().toISOString();
    const record=await db.one(`INSERT INTO site_card_records
      (id,project_id,country_code,name,cost_cny,sale_price,snapshot,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,[
      id,projectId,countryCode,String(body.name||'').trim().slice(0,200),Number(body.cost_cny)||0,
      Number(body.sale_price)||0,JSON.stringify(snapshot),now]);
    return json(res,201,record);
  }

  const siteCardRecordMatch=url.pathname.match(/^\/api\/site-card-records\/([^/]+)$/);
  if (siteCardRecordMatch && method==='PUT') {
    const id=decodeURIComponent(siteCardRecordMatch[1]);const body=await readBody(req);
    const allowed=['name','cost_cny','sale_price','snapshot'];const fields=allowed.filter((key)=>Object.hasOwn(body,key));
    const values=fields.map((key)=>key==='name'?String(body[key]||'').trim().slice(0,200):key==='snapshot'?JSON.stringify(body[key]&&typeof body[key]==='object'&&!Array.isArray(body[key])?body[key]:{}):Number(body[key])||0);
    if (fields.length) { fields.push('updated_at');values.push(new Date().toISOString());await db.query(updateSql('site_card_records',fields,`id=$${fields.length+1}`),[...values,id]); }
    const record=await db.one('SELECT * FROM site_card_records WHERE id=$1',[id]);
    return record?json(res,200,record):json(res,404,{ error:'方案记录不存在' });
  }
  if (siteCardRecordMatch && method==='DELETE') {
    const result=await db.query('DELETE FROM site_card_records WHERE id=$1',[decodeURIComponent(siteCardRecordMatch[1])]);
    return result.rowCount?json(res,200,{ ok:true }):json(res,404,{ error:'方案记录不存在' });
  }

  const projectMatch=url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (projectMatch && method==='GET') {
    const project=await getProject(Number(projectMatch[1]));
    return project ? json(res,200,project) : json(res,404,{ error:'品类不存在' });
  }
  if (projectMatch && method==='PUT') {
    const id=Number(projectMatch[1]);const body=await readBody(req);
    const allowed=['name','cost_cny','length','width','height','dimension_unit','weight','weight_unit','image_data'];
    const fields=allowed.filter((key)=>Object.hasOwn(body,key));
    if (fields.length) {
      const setFields=[...fields,'updated_at'];
      await db.query(updateSql('projects',setFields,`id = $${setFields.length+1}`),
        [...fields.map((key)=>body[key]),new Date().toISOString(),id]);
    }
    const project=await getProject(id);
    return project ? json(res,200,project) : json(res,404,{ error:'品类不存在' });
  }
  if (projectMatch && method==='DELETE') {
    const result=await db.query('DELETE FROM projects WHERE id=$1',[Number(projectMatch[1])]);
    return result.rowCount ? json(res,200,{ ok:true }) : json(res,404,{ error:'品类不存在' });
  }

  const listingMatch=url.pathname.match(/^\/api\/projects\/(\d+)\/countries\/([A-Z]{2})$/);
  if (listingMatch && method==='PUT') {
    const projectId=Number(listingMatch[1]);const code=listingMatch[2];const body=await readBody(req);
    const allowed=['selected','sale_price','category_text','referral_rate_override','matched_category','matched_referral_rate','matched_referral_threshold','matched_referral_rate_above','matched_referral_minimum','declaration_ratio','declared_value_override','customs_rate','consumption_tax_rate','customs_hs_code','customs_origin_country','customs_preference','customs_rate_type','customs_schedule_date','customs_source_url','screenshot_name'];
    const fields=allowed.filter((key)=>Object.hasOwn(body,key));
    if (fields.length) await db.query(updateSql('project_countries',fields,`project_id=$${fields.length+1} AND country_code=$${fields.length+2}`),
      [...fields.map((key)=>key==='selected' ? Number(Boolean(body[key])) : body[key]),projectId,code]);
    await db.query('UPDATE projects SET updated_at=$1 WHERE id=$2',[new Date().toISOString(),projectId]);
    const project=await getProject(projectId);
    return project ? json(res,200,project) : json(res,404,{ error:'品类不存在' });
  }

  const competitorImportMatch=url.pathname.match(/^\/api\/projects\/(\d+)\/competitors\/import$/);
  if (competitorImportMatch && method==='POST') {
    const projectId=Number(competitorImportMatch[1]);const project=await getProject(projectId);
    if (!project) return json(res,404,{ error:'品类不存在' });
    const body=await readBody(req);const countryCode=String(body.country_code||'').toUpperCase();
    if (!project.listings.some((item)=>item.country_code===countryCode)) return json(res,400,{ error:'站点不存在' });
    if (!Array.isArray(body.rows)||!body.rows.length) return json(res,400,{ error:'Excel 中没有可导入的竞品数据' });
    const rows=body.rows.slice(0,30);const discarded=Math.max(0,body.rows.length-rows.length);let created=0;let updated=0;
    await db.transaction(async (client)=>{
      for (const source of rows) {
        const row=importedCompetitorValues(source);let existing=null;
        if (row.asin) existing=(await client.query('SELECT id FROM project_competitors WHERE project_id=$1 AND country_code=$2 AND UPPER(asin)=$3 ORDER BY id LIMIT 1',[projectId,countryCode,row.asin])).rows[0]||null;
        if (!existing&&row.product_url) existing=(await client.query("SELECT id FROM project_competitors WHERE project_id=$1 AND country_code=$2 AND product_url=$3 AND product_url<>'' ORDER BY id LIMIT 1",[projectId,countryCode,row.product_url])).rows[0]||null;
        if (existing) {
          const fields=['name','sale_price',...competitorImportFields,...competitorParameterImportFields,'uses_project_defaults','updated_at'];
          const values=[row.name,row.sale_price,...competitorImportFields.map((key)=>row[key]),...competitorParameterImportFields.map((key)=>row[key]),0,new Date().toISOString(),existing.id];
          await client.query(updateSql('project_competitors',fields,`id=$${fields.length+1}`),values);updated+=1;
        } else { await insertCompetitor(project,countryCode,row,true,client);created+=1; }
      }
    });
    return json(res,200,{ imported:rows.length,created,updated,discarded });
  }

  const competitorAnalyzeMatch=url.pathname.match(/^\/api\/projects\/(\d+)\/competitors\/analyze$/);
  if (competitorAnalyzeMatch && method==='POST') {
    const projectId=Number(competitorAnalyzeMatch[1]);const project=await getProject(projectId);
    if (!project) return json(res,404,{ error:'品类不存在' });
    const body=await readBody(req);const countryCode=String(body.country_code||'').toUpperCase();
    if (!project.listings.some((item)=>item.country_code===countryCode)) return json(res,400,{ error:'站点不存在' });
    const rows=await db.many('SELECT * FROM project_competitors WHERE project_id=$1 AND country_code=$2 ORDER BY monthly_revenue_local DESC,id LIMIT 5',[projectId,countryCode]);
    if (!rows.length) return json(res,400,{ error:'当前站点没有可分析的竞品' });
    const storedPoints=(row)=>{const value=Array.isArray(row.selling_points)?row.selling_points:(()=>{try{return JSON.parse(row.selling_points||'[]')}catch{return []}})();return Array.isArray(value)&&value.length>0};
    const pendingRows=rows.filter((row)=>!storedPoints(row));const skipped=rows.length-pendingRows.length;
    if(!pendingRows.length)return json(res,200,{country_code:countryCode,analyzed:0,total:rows.length,attempted:0,skipped,warnings:[],model:null});
    const result=await competitorAnalysis.analyzeCompetitorBatch(pendingRows);const analyzedAt=new Date().toISOString();
    await db.transaction(async(client)=>{
      for(const row of result.rows) await client.query(`UPDATE project_competitors SET feature_bullets=$1,selling_points=$2,differentiation=$3,
        analysis_status=$4,analysis_model=$5,analysis_at=$6,updated_at=$6 WHERE id=$7 AND project_id=$8`,[
        JSON.stringify(row.featureBullets),JSON.stringify(row.sellingPoints),JSON.stringify(row.differentiation),row.status,result.model,analyzedAt,row.id,projectId]);
    });
    return json(res,200,{country_code:countryCode,analyzed:result.rows.filter((row)=>row.status==='complete').length,total:rows.length,attempted:result.rows.length,skipped,
      warnings:result.rows.filter((row)=>row.warning).map((row)=>({id:row.id,message:row.warning})),model:result.model});
  }

  const competitorListMatch=url.pathname.match(/^\/api\/projects\/(\d+)\/competitors$/);
  if (competitorListMatch && method==='GET') {
    const projectId=Number(competitorListMatch[1]);
    if (!await getProject(projectId)) return json(res,404,{ error:'品类不存在' });
    return json(res,200,{ competitors:await listCompetitors(projectId),competitor_counts:await competitorCounts(projectId) });
  }
  if (competitorListMatch && method==='POST') {
    const projectId=Number(competitorListMatch[1]);const project=await getProject(projectId);
    if (!project) return json(res,404,{ error:'品类不存在' });
    const body=await readBody(req);const countryCode=String(body.country_code || '').toUpperCase();
    if (!project.listings.some((item)=>item.country_code===countryCode)) return json(res,400,{ error:'站点不存在' });
    const row=await insertCompetitor(project,countryCode,body);
    return json(res,201,await calculateCompetitor(row));
  }
  if (competitorListMatch && method==='DELETE') {
    const projectId=Number(competitorListMatch[1]);
    if (!await getProject(projectId)) return json(res,404,{ error:'品类不存在' });
    const countryCode=String(url.searchParams.get('country_code')||'').toUpperCase();
    const result=countryCode
      ? await db.query('DELETE FROM project_competitors WHERE project_id=$1 AND country_code=$2',[projectId,countryCode])
      : await db.query('DELETE FROM project_competitors WHERE project_id=$1',[projectId]);
    return json(res,200,{ ok:true,deleted:result.rowCount });
  }

  const competitorMatch=url.pathname.match(/^\/api\/competitors\/(\d+)$/);
  if (competitorMatch && method==='PUT') {
    const id=Number(competitorMatch[1]);const body=await readBody(req);
    const allowed=['country_code','name','sale_price','cost_cny','length','width','height','dimension_unit','weight','weight_unit','category_text','uses_project_defaults',...competitorImportFields];
    const fields=allowed.filter((key)=>Object.hasOwn(body,key));
    const parameterFields=['cost_cny','length','width','height','dimension_unit','weight','weight_unit','category_text'];
    if (fields.some((key)=>parameterFields.includes(key)) && !fields.includes('uses_project_defaults')) { body.uses_project_defaults=false;fields.push('uses_project_defaults'); }
    if (fields.length) {
      const setFields=[...fields,'updated_at'];
      await db.query(updateSql('project_competitors',setFields,`id=$${setFields.length+1}`),
        [...fields.map((key)=>key==='uses_project_defaults' ? Number(Boolean(body[key])) : body[key]),new Date().toISOString(),id]);
    }
    const row=await db.one('SELECT * FROM project_competitors WHERE id=$1',[id]);
    return row ? json(res,200,await calculateCompetitor(row)) : json(res,404,{ error:'竞品不存在' });
  }
  if (competitorMatch && method==='DELETE') {
    const result=await db.query('DELETE FROM project_competitors WHERE id=$1',[Number(competitorMatch[1])]);
    return result.rowCount ? json(res,200,{ ok:true }) : json(res,404,{ error:'竞品不存在' });
  }

  if (method==='POST' && url.pathname==='/api/commission/match') {
    const body=await readBody(req);return json(res,200,await matchCommission(body.country_code,body.text,body.sale_price));
  }
  if (method==='POST' && url.pathname==='/api/tariffs/japan/lookup') {
    const body=await readBody(req);return json(res,200,await lookupJapanTariff({ hsCode:body.hs_code,originCountry:body.origin_country || 'CN',preference:body.preference || 'unknown' }));
  }
  if (method==='POST' && url.pathname==='/api/calculate') {
    const body=await readBody(req);const project=await getProject(Number(req.embedProjectId || body.project_id));
    if (!project) return json(res,404,{ error:'品类不存在' });
    const countries=await db.many('SELECT * FROM countries WHERE active=TRUE ORDER BY priority');const results=[];
    const listings=body.country_code ? project.listings.filter((item)=>item.country_code===body.country_code) : project.listings.filter((item)=>item.selected);
    for (const listing of listings) {
      const country=countries.find((item)=>item.code===listing.country_code);
      const [fbaRules,sizeTiers,freightRule]=await Promise.all([db.many('SELECT * FROM fba_rules WHERE country_code=$1',[country.code]),db.many('SELECT * FROM size_tiers WHERE country_code=$1',[country.code]),db.one('SELECT * FROM freight_rules WHERE country_code=$1',[country.code])]);
      const result=calculateProfit({ project,country,listing,fbaRules,sizeTiers,freightRule });
      if (body.include_target_prices) result.target_prices=Object.fromEntries([0,10,20,30].map((targetRate)=>[targetRate,findSalePriceForProfitRate({ project,country,listing,fbaRules,sizeTiers,freightRule,targetRate })]));
      results.push(result);
    }
    return json(res,200,{ project_id:project.id,results });
  }

  const ruleListMatch=url.pathname.match(/^\/api\/rules\/(countries|sizes|fba|freight|commission)$/);
  if (ruleListMatch && method==='GET') {
    const table={ countries:'countries',sizes:'size_tiers',fba:'fba_rules',freight:'freight_rules',commission:'commission_rules' }[ruleListMatch[1]];
    const where=table==='countries' ? 'WHERE active=TRUE' : 'WHERE country_code IN (SELECT code FROM countries WHERE active=TRUE)';
    return json(res,200,await db.many(`SELECT * FROM ${table} ${where} ORDER BY ${table==='countries' ? 'priority' : 'country_code,id'}`));
  }
  const ruleItemMatch=url.pathname.match(/^\/api\/rules\/(countries|sizes|fba|freight|commission)\/([^/]+)$/);
  if (ruleItemMatch && method==='PUT') {
    const type=ruleItemMatch[1];const id=decodeURIComponent(ruleItemMatch[2]);const body=await readBody(req);
    const config={
      countries:{ table:'countries',key:'code',fields:['cny_per_local','tax_rate','tax_basis','tax_label','vat_rate','fba_volume_divisor','tax_note','source_note'] },
      sizes:{ table:'size_tiers',key:'id',fields:['tier_code','tier_name','max_long_cm','max_mid_cm','max_short_cm','min_item_weight_kg','max_item_weight_kg','max_volume_weight_kg','max_total_cm','dimension_mode','class_weight_mode','fee_weight_mode','status','source_note'] },
      fba:{ table:'fba_rules',key:'id',fields:['size_name','size_tier','max_weight_kg','included_weight_kg','base_fee','per_kg_fee','weight_increment_kg','surcharge_rate','min_price','max_price','category_group','status','source_note'] },
      freight:{ table:'freight_rules',key:'id',fields:['channel_name','pricing_mode','price_per_kg_cny','price_per_cbm_cny','min_charge_cny','status','source_note'] },
      commission:{ table:'commission_rules',key:'id',fields:['parent_category','keywords','rate','min_price','max_price','threshold_price','rate_above','minimum_fee','status','source_note'] }
    }[type];
    const fields=config.fields.filter((key)=>Object.hasOwn(body,key));
    if (!fields.length) return json(res,400,{ error:'没有可更新字段' });
    const result=await db.query(updateSql(config.table,fields,`${config.key}=$${fields.length+1}`),[...fields.map((key)=>body[key]),id]);
    return result.rowCount ? json(res,200,{ ok:true }) : json(res,404,{ error:'规则不存在' });
  }
  return json(res,404,{ error:'接口不存在' });
}

const mime={ '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml' };
function staticFile(req,res,url) {
  const requestPath=url.pathname==='/' ? '/index.html' : url.pathname;
  const file=requestPath==='/exceljs.min.js' ? excelJsBrowserFile:path.normalize(path.join(publicDir,requestPath));
  if (file!==excelJsBrowserFile && !file.startsWith(publicDir)) { res.writeHead(403);return res.end('Forbidden'); }
  fs.readFile(file,(error,data)=>{ if (error) { res.writeHead(404);return res.end('Not found'); } res.writeHead(200,{ 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' });res.end(data); });
}

const server=http.createServer(async (req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host}`);
  try {
    applyCors(req,res);if (req.method==='OPTIONS') { res.writeHead(204);return res.end(); }
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    return staticFile(req,res,url);
  } catch (error) { console.error(error);return json(res,Number(error.statusCode)||500,{ error:error.message || '服务器异常' }); }
});

/* node:coverage ignore next 3 */
if (require.main===module) {
  db.ready().then(()=>server.listen(PORT,'0.0.0.0',()=>console.log(`亚马逊利润工具已启动：http://127.0.0.1:${PORT}`))).catch((error)=>{ console.error(error);process.exitCode=1; });
}

module.exports={ server,bootstrap,matchCommission,getProject };
