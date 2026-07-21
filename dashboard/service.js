'use strict';

const { calculateProfit } = require('../lib/profit');

const PRODUCT_FIELDS = [
  ['image_url','图片'],['product_name','品名'],['length_cm','长度'],['width_cm','宽度'],
  ['height_cm','高度'],['weight_kg','重量'],['cost_cny','成本']
];
const REQUIRED_CALC_FIELDS = [
  ['sale_price','售价'],['cost_cny','成本'],['length_cm','长度'],['width_cm','宽度'],['height_cm','高度'],['weight_kg','重量']
];

function matchCommission(rules,text,salePrice) {
  const price = Number(salePrice) || 0;
  const normalized = String(text || '').toLowerCase().replace(/[&/，、|]/g,' ');
  let best;
  let bestScore = 0;
  let fallback;
  for (const rule of rules) {
    if (rule.min_price != null && price < Number(rule.min_price)) continue;
    if (rule.max_price != null && price > Number(rule.max_price)) continue;
    const name = String(rule.parent_category || '').toLowerCase();
    if (name.includes('other') || name.includes('其他') || name.includes('其它')) { fallback ||= rule; continue; }
    const terms = `${rule.parent_category},${rule.keywords}`.toLowerCase().split(/[,/]/).map((item) => item.trim()).filter(Boolean);
    const score = terms.reduce((sum,term) => sum + (normalized.includes(term) ? Math.max(1,term.length) : 0),0);
    if (score > bestScore) { best = rule; bestScore = score; }
  }
  return best || fallback || null;
}

function present(value) {
  return value !== null && value !== undefined && value !== '';
}

function normalizeSourceRate(value) {
  const rate=Number(value);
  if (!Number.isFinite(rate)) return null;
  return Math.abs(rate) <= 1 ? Math.round(rate * 10_000) / 100 : Math.round(rate * 100) / 100;
}

function buildResult(row,rules) {
  const country = rules.countries.get(row.country_code);
  const missing = REQUIRED_CALC_FIELDS.filter(([key]) => !present(row[key])).map(([,label]) => label);
  if (!country) missing.push('站点规则');
  const availableFields = PRODUCT_FIELDS.filter(([key]) => present(row[key])).map(([key]) => key);
  const base = {
    asin:row.asin,parent_asin:row.parent_asin || row.asin,product_name:row.product_name || row.asin,image_url:row.image_url || null,owner_name:row.owner_name,
    length_cm:present(row.length_cm) ? Number(row.length_cm) : null,
    width_cm:present(row.width_cm) ? Number(row.width_cm) : null,
    height_cm:present(row.height_cm) ? Number(row.height_cm) : null,
    weight_kg:present(row.weight_kg) ? Number(row.weight_kg) : null,
    cost_cny:present(row.cost_cny) ? Number(row.cost_cny) : null,
    available_fields:availableFields,country_code:row.country_code,
    site_name:country?.name || row.country_code,flag:country?.flag || '',symbol:country?.symbol || '',
    sale_price:present(row.sale_price) ? Number(row.sale_price) : null,category_text:row.category_text || null,
    source_total_sales:present(row.source_total_sales) ? Number(row.source_total_sales) : null,
    source_total_qty:present(row.source_total_qty) ? Number(row.source_total_qty) : null,
    source_head_unit_price:present(row.source_head_unit_price) ? Number(row.source_head_unit_price) : null,
    source_item_weight:present(row.source_item_weight) ? Number(row.source_item_weight) : null,
    source_weight_unit:row.source_weight_unit || null,
    source_dimension_unit:row.source_dimension_unit || null,
    source_listing_currency:row.source_listing_currency || null,
    missing_fields:[...new Set(missing)]
  };
  if (present(row.source_profit_rate)) {
    return {
      ...base,profit_rate:normalizeSourceRate(row.source_profit_rate),
      profit:present(row.source_profit) ? Number(row.source_profit) : null,
      currency:'CNY',symbol:'¥',missing_fields:[],warnings:[],calculation_source:'company_datapool'
    };
  }
  if (Object.hasOwn(row,'source_profit_rate')) {
    return { ...base,profit_rate:null,profit:null,missing_fields:[],warnings:['公司暂无毛利率'],calculation_source:'company_datapool_missing' };
  }
  if (missing.length) return { ...base,profit_rate:null,profit:null,warnings:[`缺少${[...new Set(missing)].join('、')}，暂不计算`] };
  const commission = matchCommission(rules.commissions.get(row.country_code) || [],row.category_text,row.sale_price);
  const listing = {
    sale_price:row.sale_price,category_text:row.category_text || '',referral_rate_override:row.referral_rate_override,
    matched_referral_rate:commission?.rate,matched_referral_threshold:commission?.threshold_price,
    matched_referral_rate_above:commission?.rate_above,matched_referral_minimum:commission?.minimum_fee || 0,
    declaration_ratio:row.declaration_ratio == null ? .15 : row.declaration_ratio,
    declared_value_override:row.declared_value_override,customs_rate:row.customs_rate || 0,
    consumption_tax_rate:row.consumption_tax_rate == null ? 10 : row.consumption_tax_rate
  };
  const result = calculateProfit({
    project:{ cost_cny:row.cost_cny,length:row.length_cm,width:row.width_cm,height:row.height_cm,dimension_unit:'cm',weight:row.weight_kg,weight_unit:'kg' },
    country,listing,fbaRules:rules.fba.get(row.country_code) || [],sizeTiers:rules.sizes.get(row.country_code) || [],
    freightRule:rules.freight.get(row.country_code) || null
  });
  return { ...base,...result,warnings:result.warnings || [] };
}

function groupBy(rows,key) {
  const map = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!map.has(value)) map.set(value,[]);
    map.get(value).push(row);
  }
  return map;
}

function groupDashboardProducts(rows) {
  const parentGroups = new Map();
  for (const row of rows) {
    const parentAsin=row.parent_asin || row.asin;
    if (!parentGroups.has(parentAsin)) parentGroups.set(parentAsin,[]);
    parentGroups.get(parentAsin).push(row);
  }
  return [...parentGroups].map(([parentAsin,children]) => {
    const representative=[...children].sort((a,b) => {
      const score=(item) => ['image_url','product_name','length_cm','width_cm','height_cm','weight_kg','cost_cny']
        .reduce((sum,key) => sum + (present(item[key]) ? 1 : 0),0);
      return score(b) - score(a);
    })[0];
    const siteMap=new Map();
    for (const child of children) {
      if (!siteMap.has(child.country_code)) siteMap.set(child.country_code,{
        country_code:child.country_code,site_name:child.site_name,flag:child.flag,symbol:child.symbol,children:[]
      });
      siteMap.get(child.country_code).children.push(child);
    }
    const sites=[...siteMap.values()].map((site) => {
      const asinGroups=groupBy(site.children,'asin');
      const mergedChildren=[...asinGroups.values()].map((items) => {
        if (items.length === 1) return items[0];
        const totalSales=items.reduce((sum,item) => sum + (present(item.source_total_sales) ? Number(item.source_total_sales) : 0),0);
        const totalQty=items.reduce((sum,item) => sum + (present(item.source_total_qty) ? Number(item.source_total_qty) : 0),0);
        const profit=items.reduce((sum,item) => sum + (present(item.profit) ? Number(item.profit) : 0),0);
        const weightedRate=totalSales
          ? items.reduce((sum,item) => sum + (present(item.profit_rate) ? Number(item.profit_rate) * Number(item.source_total_sales || 0) : 0),0) / totalSales
          : null;
        return { ...items[0],source_total_sales:totalSales || null,source_total_qty:totalQty || null,
          profit:profit || null,profit_rate:weightedRate };
      });
      return { ...site,children:mergedChildren.sort((a,b) => a.asin.localeCompare(b.asin)) };
    });
    return {
      parent_asin:parentAsin,product_name:representative.product_name,image_url:representative.image_url,
      owner_name:representative.owner_name,length_cm:representative.length_cm,width_cm:representative.width_cm,
      height_cm:representative.height_cm,weight_kg:representative.weight_kg,cost_cny:representative.cost_cny,
      representative_asin:representative.asin,child_count:new Set(children.map((item) => item.asin)).size,
      site_count:sites.length,sites
    };
  });
}

async function loadRules(pool) {
  const [countries,sizes,fba,freight,commissions] = await Promise.all([
    pool.query('SELECT * FROM countries WHERE active = TRUE ORDER BY priority'),pool.query('SELECT * FROM size_tiers'),
    pool.query('SELECT * FROM fba_rules'),pool.query('SELECT * FROM freight_rules'),pool.query('SELECT * FROM commission_rules')
  ]);
  return {
    countries:new Map(countries.rows.map((row) => [row.code,row])),sizes:groupBy(sizes.rows,'country_code'),
    fba:groupBy(fba.rows,'country_code'),freight:new Map(freight.rows.map((row) => [row.country_code,row])),
    commissions:groupBy(commissions.rows,'country_code')
  };
}

async function getDashboard(pool,user,params = {}) {
  const values = [];
  const where = [];
  if (!user.all_owners) { values.push(user.name);where.push('owner_name = $1'); }
  if (params.site) { values.push(params.site.toUpperCase()); where.push(`country_code = $${values.length}`); }
  if (params.search) { values.push(`%${params.search}%`); where.push(`(asin ILIKE $${values.length} OR parent_asin ILIKE $${values.length} OR product_name ILIKE $${values.length})`); }
  const query = `SELECT * FROM dashboard_product_sites_v${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY parent_asin,country_code,asin`;
  const ownerFilter=user.all_owners ? { sql:'',values:[] } : { sql:'WHERE v.owner_name=$1',values:[user.name] };
  const [source,siteRows,rules] = await Promise.all([
    pool.query(query,values),
    pool.query(`SELECT DISTINCT v.country_code,c.priority FROM dashboard_product_sites_v v
      LEFT JOIN countries c ON c.code=v.country_code ${ownerFilter.sql} ORDER BY c.priority NULLS LAST,v.country_code`,ownerFilter.values),
    loadRules(pool)
  ]);
  const calculated = source.rows.map((row) => buildResult(row,rules));
  const products = groupDashboardProducts(calculated);
  const complete = calculated.filter((item) => item.profit_rate != null);
  return {
    user:{ name:user.name,avatar_url:user.avatar_url || '' },
    summary:{
      products:products.length,sites:calculated.length,complete_sites:complete.length,
      profitable_sites:complete.filter((item) => item.profit_rate > 0).length,
      average_profit_rate:complete.length ? Math.round(complete.reduce((sum,item) => sum + item.profit_rate,0) / complete.length * 100) / 100 : null
    },
    filters:{ sites:siteRows.rows.map((row) => row.country_code) },products
  };
}

async function listOwners(pool) {
  const result=await pool.query(`SELECT owner_name,COUNT(DISTINCT COALESCE(NULLIF(parent_asin,''),asin))::int AS product_count
    FROM dashboard_product_sites_v WHERE owner_name<>'' AND owner_name<>'未分配'
    GROUP BY owner_name ORDER BY owner_name`);
  return result.rows;
}

module.exports = { getDashboard,listOwners,matchCommission,buildResult,normalizeSourceRate,groupDashboardProducts };
