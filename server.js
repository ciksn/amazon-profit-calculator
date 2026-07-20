'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const db = require('./lib/db');
const { calculateProfit } = require('./lib/profit');
const { lookupJapanTariff } = require('./lib/japan-tariff');
const PORT = Number(process.env.PORT || 4173);
const publicDir = path.join(__dirname, 'public');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function applyCors(req,res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowed = String(process.env.CORS_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error('请求内容过大'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 格式不正确')); }
    });
    req.on('error', reject);
  });
}

function getProject(id) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return null;
  project.listings = db.prepare(`SELECT pc.*, c.name AS country_name, c.flag, c.currency, c.symbol,
      f.id AS freight_rule_id, f.pricing_mode AS freight_pricing_mode,
      f.price_per_kg_cny AS freight_price_per_kg_cny, f.price_per_cbm_cny AS freight_price_per_cbm_cny
    FROM project_countries pc JOIN countries c ON c.code = pc.country_code
    LEFT JOIN freight_rules f ON f.country_code = pc.country_code
    WHERE pc.project_id = ? AND c.active = 1 ORDER BY c.priority`).all(id);
  for (const listing of project.listings) {
    if (listing.referral_rate_override != null || !listing.category_text) continue;
    const matched = matchCommission(listing.country_code,listing.category_text,listing.sale_price);
    if (matched.matched) {
      listing.matched_category = matched.rule.parent_category;
      listing.matched_referral_rate = matched.rule.rate;
      listing.matched_referral_threshold = matched.rule.threshold_price;
      listing.matched_referral_rate_above = matched.rule.rate_above;
      listing.matched_referral_minimum = matched.rule.minimum_fee || 0;
      listing.commission_fallback = Boolean(matched.fallback);
    }
  }
  return project;
}

function calculateCompetitor(row) {
  const project = getProject(Number(row.project_id));
  if (!project) return null;
  const listing = project.listings.find((item) => item.country_code === row.country_code);
  const country = db.prepare('SELECT * FROM countries WHERE code = ? AND active = 1').get(row.country_code);
  if (!listing || !country) return { ...row, profit_rate:null, profit:null };
  const usesProjectDefaults = Boolean(row.uses_project_defaults);
  const competitorProject = { ...project,
    cost_cny:usesProjectDefaults ? project.cost_cny : row.cost_cny,
    length:usesProjectDefaults ? project.length : row.length,
    width:usesProjectDefaults ? project.width : row.width,
    height:usesProjectDefaults ? project.height : row.height,
    dimension_unit:usesProjectDefaults ? project.dimension_unit : row.dimension_unit,
    weight:usesProjectDefaults ? project.weight : row.weight,
    weight_unit:usesProjectDefaults ? project.weight_unit : row.weight_unit
  };
  const categoryText = usesProjectDefaults ? listing.category_text : row.category_text;
  const competitorListing = { ...listing, sale_price:row.sale_price, category_text:categoryText };
  if (competitorListing.referral_rate_override == null && competitorListing.category_text) {
    const matched = matchCommission(row.country_code,competitorListing.category_text,row.sale_price);
    if (matched.matched) Object.assign(competitorListing,{ matched_category:matched.rule.parent_category,
      matched_referral_rate:matched.rule.rate, matched_referral_threshold:matched.rule.threshold_price,
      matched_referral_rate_above:matched.rule.rate_above, matched_referral_minimum:matched.rule.minimum_fee || 0 });
  }
  const fbaRules = db.prepare('SELECT * FROM fba_rules WHERE country_code = ?').all(country.code);
  const sizeTiers = db.prepare('SELECT * FROM size_tiers WHERE country_code = ?').all(country.code);
  const freightRule = db.prepare('SELECT * FROM freight_rules WHERE country_code = ?').get(country.code);
  const calculated = calculateProfit({ project:competitorProject,country,listing:competitorListing,fbaRules,sizeTiers,freightRule });
  const filled = Boolean(String(row.name || '').trim()) && Number(row.sale_price) > 0;
  return { ...row, cost_cny:competitorProject.cost_cny, length:competitorProject.length,
    width:competitorProject.width, height:competitorProject.height, dimension_unit:competitorProject.dimension_unit,
    weight:competitorProject.weight, weight_unit:competitorProject.weight_unit, category_text:categoryText,
    symbol:country.symbol, country_name:country.name, flag:country.flag,
    profit_rate:filled ? calculated.profit_rate : null, profit:filled ? calculated.profit : null };
}

function listCompetitors(projectId) {
  return db.prepare('SELECT * FROM project_competitors WHERE project_id = ? ORDER BY country_code, id')
    .all(projectId).map(calculateCompetitor);
}

function bootstrap() {
  return {
    countries: db.prepare('SELECT * FROM countries WHERE active = 1 ORDER BY priority').all(),
    projects: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, id DESC').all(),
    ruleCounts: {
      fba: db.prepare('SELECT COUNT(*) AS n FROM fba_rules f JOIN countries c ON c.code=f.country_code WHERE c.active=1').get().n,
      freightMissing: db.prepare("SELECT COUNT(*) AS n FROM freight_rules f JOIN countries c ON c.code=f.country_code WHERE c.active=1 AND f.status = 'missing'").get().n,
      commission: db.prepare('SELECT COUNT(*) AS n FROM commission_rules r JOIN countries c ON c.code=r.country_code WHERE c.active=1').get().n
    }
  };
}

function matchCommission(countryCode, text, salePrice = 0) {
  const rules = db.prepare('SELECT * FROM commission_rules WHERE country_code = ?').all(countryCode);
  const normalized = String(text || '').toLowerCase().replace(/[&/，、|]/g, ' ');
  let best = null;
  let bestScore = 0;
  let fallback = null;
  for (const rule of rules) {
    const price = Number(salePrice) || 0;
    if (rule.min_price != null && price < Number(rule.min_price)) continue;
    if (rule.max_price != null && price > Number(rule.max_price)) continue;
    const fallbackName = String(rule.parent_category || '').toLowerCase();
    const isFallback = fallbackName.includes('other') || fallbackName.includes('其他') || fallbackName.includes('其它');
    if (isFallback) { fallback ||= rule; continue; }
    const terms = `${rule.parent_category},${rule.keywords}`.toLowerCase().split(/[,/]/).map((x) => x.trim()).filter(Boolean);
    const score = terms.reduce((sum, term) => sum + (normalized.includes(term) ? Math.max(1, term.length) : 0), 0);
    if (score > bestScore) { best = rule; bestScore = score; }
  }
  if (bestScore) return { matched:true,fallback:false,score:bestScore,rule:best };
  if (fallback) return { matched:true,fallback:true,score:0,rule:fallback };
  return { matched:false,fallback:false,rule:null };
}

async function api(req, res, url) {
  const method = req.method;
  if (method === 'GET' && url.pathname === '/api/bootstrap') return json(res, 200, bootstrap());
  if (method === 'POST' && url.pathname === '/api/projects') {
    const body = await readBody(req);
    const now = new Date().toISOString();
    const result = db.prepare(`INSERT INTO projects
      (name,cost_cny,length,width,height,dimension_unit,weight,weight_unit,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(body.name || '未命名品类',0,0,0,0,'cm',0,'kg',now,now);
    const id = Number(result.lastInsertRowid);
    const stmt = db.prepare('INSERT INTO project_countries (project_id,country_code,selected) VALUES (?,?,?)');
    for (const country of db.prepare('SELECT code FROM countries').all()) stmt.run(id,country.code,country.code === 'AU' ? 1 : 0);
    return json(res, 201, getProject(id));
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
  if (projectMatch && method === 'GET') {
    const project = getProject(Number(projectMatch[1]));
    return project ? json(res,200,project) : json(res,404,{ error:'品类不存在' });
  }
  if (projectMatch && method === 'PUT') {
    const id = Number(projectMatch[1]);
    const body = await readBody(req);
    const allowed = ['name','cost_cny','length','width','height','dimension_unit','weight','weight_unit','image_data'];
    const fields = allowed.filter((key) => Object.hasOwn(body,key));
    if (fields.length) db.prepare(`UPDATE projects SET ${fields.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((key) => body[key]),new Date().toISOString(),id);
    return json(res,200,getProject(id));
  }
  if (projectMatch && method === 'DELETE') {
    const id = Number(projectMatch[1]);
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    if (!result.changes) return json(res,404,{ error:'品类不存在' });
    return json(res,200,{ ok:true });
  }

  const listingMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/countries\/([A-Z]{2})$/);
  if (listingMatch && method === 'PUT') {
    const body = await readBody(req);
    const allowed = ['selected','sale_price','category_text','referral_rate_override','matched_category','matched_referral_rate','matched_referral_threshold','matched_referral_rate_above','matched_referral_minimum','declaration_ratio','declared_value_override','customs_rate','consumption_tax_rate','customs_hs_code','customs_origin_country','customs_preference','customs_rate_type','customs_schedule_date','customs_source_url','screenshot_name'];
    const fields = allowed.filter((key) => Object.hasOwn(body,key));
    if (fields.length) {
      const values = fields.map((key) => key === 'selected' ? Number(Boolean(body[key])) : body[key]);
      db.prepare(`UPDATE project_countries SET ${fields.map((key) => `${key} = ?`).join(', ')} WHERE project_id = ? AND country_code = ?`)
        .run(...values,Number(listingMatch[1]),listingMatch[2]);
    }
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(),Number(listingMatch[1]));
    return json(res,200,getProject(Number(listingMatch[1])));
  }

  const competitorListMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/competitors$/);
  if (competitorListMatch && method === 'GET') {
    const projectId = Number(competitorListMatch[1]);
    if (!getProject(projectId)) return json(res,404,{ error:'品类不存在' });
    return json(res,200,{ competitors:listCompetitors(projectId) });
  }
  if (competitorListMatch && method === 'POST') {
    const projectId = Number(competitorListMatch[1]);
    const project = getProject(projectId);
    if (!project) return json(res,404,{ error:'品类不存在' });
    const body = await readBody(req);
    const countryCode = String(body.country_code || '').toUpperCase();
    if (!project.listings.some((item) => item.country_code === countryCode)) return json(res,400,{ error:'站点不存在' });
    const now = new Date().toISOString();
    const listing = project.listings.find((item) => item.country_code === countryCode);
    const result = db.prepare(`INSERT INTO project_competitors
      (project_id,country_code,name,sale_price,cost_cny,length,width,height,dimension_unit,weight,weight_unit,category_text,uses_project_defaults,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId,countryCode,String(body.name || ''),Number(body.sale_price)||0,
        Number(body.cost_cny ?? project.cost_cny)||0,Number(body.length ?? project.length)||0,
        Number(body.width ?? project.width)||0,Number(body.height ?? project.height)||0,
        body.dimension_unit || project.dimension_unit,Number(body.weight ?? project.weight)||0,
        body.weight_unit || project.weight_unit,body.category_text ?? listing.category_text,1,now,now);
    return json(res,201,calculateCompetitor(db.prepare('SELECT * FROM project_competitors WHERE id = ?').get(Number(result.lastInsertRowid))));
  }

  const competitorMatch = url.pathname.match(/^\/api\/competitors\/(\d+)$/);
  if (competitorMatch && method === 'PUT') {
    const id = Number(competitorMatch[1]);
    const body = await readBody(req);
    const allowed = ['country_code','name','sale_price','cost_cny','length','width','height','dimension_unit','weight','weight_unit','category_text','uses_project_defaults'];
    const fields = allowed.filter((key) => Object.hasOwn(body,key));
    const parameterFields = ['cost_cny','length','width','height','dimension_unit','weight','weight_unit','category_text'];
    if (fields.some((key) => parameterFields.includes(key)) && !fields.includes('uses_project_defaults')) {
      body.uses_project_defaults = false;fields.push('uses_project_defaults');
    }
    if (fields.length) db.prepare(`UPDATE project_competitors SET ${fields.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...fields.map((key) => key === 'uses_project_defaults' ? Number(Boolean(body[key])) : body[key]),new Date().toISOString(),id);
    const row = db.prepare('SELECT * FROM project_competitors WHERE id = ?').get(id);
    return row ? json(res,200,calculateCompetitor(row)) : json(res,404,{ error:'竞品不存在' });
  }
  if (competitorMatch && method === 'DELETE') {
    const result = db.prepare('DELETE FROM project_competitors WHERE id = ?').run(Number(competitorMatch[1]));
    return result.changes ? json(res,200,{ ok:true }) : json(res,404,{ error:'竞品不存在' });
  }

  if (method === 'POST' && url.pathname === '/api/commission/match') {
    const body = await readBody(req);
    return json(res,200,matchCommission(body.country_code,body.text,body.sale_price));
  }
  if (method === 'POST' && url.pathname === '/api/tariffs/japan/lookup') {
    const body = await readBody(req);
    return json(res,200,await lookupJapanTariff({
      hsCode:body.hs_code,
      originCountry:body.origin_country || 'CN',
      preference:body.preference || 'unknown'
    }));
  }
  if (method === 'POST' && url.pathname === '/api/calculate') {
    const body = await readBody(req);
    const project = getProject(Number(body.project_id));
    if (!project) return json(res,404,{ error:'品类不存在' });
    const countries = db.prepare('SELECT * FROM countries WHERE active = 1 ORDER BY priority').all();
    const results = [];
    const listings = body.country_code
      ? project.listings.filter((item) => item.country_code === body.country_code)
      : project.listings.filter((item) => item.selected);
    for (const listing of listings) {
      const country = countries.find((item) => item.code === listing.country_code);
      const fbaRules = db.prepare('SELECT * FROM fba_rules WHERE country_code = ?').all(country.code);
      const sizeTiers = db.prepare('SELECT * FROM size_tiers WHERE country_code = ?').all(country.code);
      const freightRule = db.prepare('SELECT * FROM freight_rules WHERE country_code = ?').get(country.code);
      results.push(calculateProfit({ project,country,listing,fbaRules,sizeTiers,freightRule }));
    }
    return json(res,200,{ project_id:project.id,results });
  }

  const ruleListMatch = url.pathname.match(/^\/api\/rules\/(countries|sizes|fba|freight|commission)$/);
  if (ruleListMatch && method === 'GET') {
    const table = { countries:'countries',sizes:'size_tiers',fba:'fba_rules',freight:'freight_rules',commission:'commission_rules' }[ruleListMatch[1]];
    const where = table === 'countries' ? 'WHERE active = 1' : "WHERE country_code IN (SELECT code FROM countries WHERE active = 1)";
    return json(res,200,db.prepare(`SELECT * FROM ${table} ${where} ORDER BY ${table === 'countries' ? 'priority' : 'country_code, id'}`).all());
  }
  const ruleItemMatch = url.pathname.match(/^\/api\/rules\/(countries|sizes|fba|freight|commission)\/([^/]+)$/);
  if (ruleItemMatch && method === 'PUT') {
    const type = ruleItemMatch[1];
    const id = decodeURIComponent(ruleItemMatch[2]);
    const body = await readBody(req);
    const config = {
      countries:{ table:'countries',key:'code',fields:['cny_per_local','tax_rate','tax_basis','tax_label','vat_rate','fba_volume_divisor','tax_note','source_note'] },
      sizes:{ table:'size_tiers',key:'id',fields:['tier_code','tier_name','max_long_cm','max_mid_cm','max_short_cm','min_item_weight_kg','max_item_weight_kg','max_volume_weight_kg','max_total_cm','dimension_mode','class_weight_mode','fee_weight_mode','status','source_note'] },
      fba:{ table:'fba_rules',key:'id',fields:['size_name','size_tier','max_weight_kg','included_weight_kg','base_fee','per_kg_fee','weight_increment_kg','surcharge_rate','min_price','max_price','category_group','status','source_note'] },
      freight:{ table:'freight_rules',key:'id',fields:['channel_name','pricing_mode','price_per_kg_cny','price_per_cbm_cny','min_charge_cny','status','source_note'] },
      commission:{ table:'commission_rules',key:'id',fields:['parent_category','keywords','rate','min_price','max_price','threshold_price','rate_above','minimum_fee','status','source_note'] }
    }[type];
    const fields = config.fields.filter((key) => Object.hasOwn(body,key));
    if (!fields.length) return json(res,400,{ error:'没有可更新字段' });
    db.prepare(`UPDATE ${config.table} SET ${fields.map((key) => `${key} = ?`).join(', ')} WHERE ${config.key} = ?`)
      .run(...fields.map((key) => body[key]),id);
    return json(res,200,{ ok:true });
  }
  return json(res,404,{ error:'接口不存在' });
}

const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml' };
function staticFile(req,res,url) {
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(publicDir,requestPath));
  if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file,(error,data) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200,{ 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req,res) => {
  const url = new URL(req.url,`http://${req.headers.host}`);
  try {
    applyCors(req,res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (url.pathname.startsWith('/api/')) return await api(req,res,url);
    return staticFile(req,res,url);
  } catch (error) {
    console.error(error);
    return json(res,500,{ error:error.message || '服务器异常' });
  }
});
if (require.main === module) {
  server.listen(PORT,'127.0.0.1',() => console.log(`亚马逊利润工具已启动：http://127.0.0.1:${PORT}`));
}

module.exports = { server, bootstrap, matchCommission };
