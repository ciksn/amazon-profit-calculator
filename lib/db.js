'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let pool;
let readyPromise;

function createPool() {
  if (process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL) {
    const { newDb } = require('pg-mem');
    const memory = newDb({ autoCreateForeignKeyIndices:true });
    const adapter = memory.adapters.createPg();
    return new adapter.Pool();
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('缺少 DATABASE_URL，无法连接 PostgreSQL');
  const { Pool } = require('pg');
  return new Pool({
    connectionString,
    max:Number(process.env.PG_POOL_MAX) || 10,
    ssl:process.env.PGSSL === 'require' ? { rejectUnauthorized:false } : undefined
  });
}

const schema = `
CREATE TABLE IF NOT EXISTS countries (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, flag TEXT NOT NULL, currency TEXT NOT NULL, symbol TEXT NOT NULL,
  cny_per_local DOUBLE PRECISION NOT NULL, vat_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  tax_rate DOUBLE PRECISION NOT NULL DEFAULT 0, tax_basis TEXT NOT NULL DEFAULT 'none',
  tax_label TEXT NOT NULL DEFAULT '税费预估', active BOOLEAN NOT NULL DEFAULT TRUE,
  fba_volume_divisor DOUBLE PRECISION NOT NULL DEFAULT 6000, priority INTEGER NOT NULL DEFAULT 99,
  tax_note TEXT NOT NULL DEFAULT '', source_note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY, share_key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, cost_cny DOUBLE PRECISION NOT NULL DEFAULT 0,
  length DOUBLE PRECISION NOT NULL DEFAULT 0, width DOUBLE PRECISION NOT NULL DEFAULT 0,
  height DOUBLE PRECISION NOT NULL DEFAULT 0, dimension_unit TEXT NOT NULL DEFAULT 'cm',
  weight DOUBLE PRECISION NOT NULL DEFAULT 0, weight_unit TEXT NOT NULL DEFAULT 'kg',
  image_data TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_countries (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL REFERENCES countries(code), selected INTEGER NOT NULL DEFAULT 0,
  sale_price DOUBLE PRECISION NOT NULL DEFAULT 0, category_text TEXT NOT NULL DEFAULT '',
  referral_rate_override DOUBLE PRECISION, matched_category TEXT NOT NULL DEFAULT '',
  matched_referral_rate DOUBLE PRECISION, matched_referral_threshold DOUBLE PRECISION,
  matched_referral_rate_above DOUBLE PRECISION, matched_referral_minimum DOUBLE PRECISION NOT NULL DEFAULT 0,
  declaration_ratio DOUBLE PRECISION NOT NULL DEFAULT .15, declared_value_override DOUBLE PRECISION,
  customs_rate DOUBLE PRECISION NOT NULL DEFAULT 0, consumption_tax_rate DOUBLE PRECISION NOT NULL DEFAULT 10,
  customs_hs_code TEXT NOT NULL DEFAULT '', customs_origin_country TEXT NOT NULL DEFAULT 'CN',
  customs_preference TEXT NOT NULL DEFAULT 'unknown', customs_rate_type TEXT NOT NULL DEFAULT '',
  customs_schedule_date TEXT NOT NULL DEFAULT '', customs_source_url TEXT NOT NULL DEFAULT '',
  screenshot_name TEXT NOT NULL DEFAULT '', PRIMARY KEY(project_id,country_code)
);
CREATE TABLE IF NOT EXISTS project_competitors (
  id SERIAL PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL REFERENCES countries(code), name TEXT NOT NULL DEFAULT '',
  sale_price DOUBLE PRECISION NOT NULL DEFAULT 0, cost_cny DOUBLE PRECISION NOT NULL DEFAULT 0,
  length DOUBLE PRECISION NOT NULL DEFAULT 0, width DOUBLE PRECISION NOT NULL DEFAULT 0,
  height DOUBLE PRECISION NOT NULL DEFAULT 0, dimension_unit TEXT NOT NULL DEFAULT 'cm',
  weight DOUBLE PRECISION NOT NULL DEFAULT 0, weight_unit TEXT NOT NULL DEFAULT 'kg',
  category_text TEXT NOT NULL DEFAULT '', uses_project_defaults INTEGER NOT NULL DEFAULT 1,
  asin TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', product_url TEXT NOT NULL DEFAULT '',
  is_fba INTEGER, has_aplus INTEGER, has_video INTEGER, listing_date TEXT NOT NULL DEFAULT '',
  monthly_sales DOUBLE PRECISION NOT NULL DEFAULT 0, monthly_revenue_local DOUBLE PRECISION NOT NULL DEFAULT 0,
  monthly_revenue_usd DOUBLE PRECISION NOT NULL DEFAULT 0, rating DOUBLE PRECISION,
  source_format TEXT NOT NULL DEFAULT '', source_row INTEGER NOT NULL DEFAULT 0,
  feature_bullets JSONB NOT NULL DEFAULT '[]'::jsonb, selling_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  differentiation JSONB NOT NULL DEFAULT '[]'::jsonb, analysis_status TEXT NOT NULL DEFAULT '',
  analysis_warning TEXT NOT NULL DEFAULT '', analysis_model TEXT NOT NULL DEFAULT '', analysis_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_competitors_project ON project_competitors(project_id,country_code,id);
CREATE TABLE IF NOT EXISTS site_card_records (
  id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL REFERENCES countries(code), name TEXT NOT NULL DEFAULT '',
  cost_cny DOUBLE PRECISION NOT NULL DEFAULT 0, sale_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_card_records_scope ON site_card_records(project_id,country_code,created_at,id);
CREATE TABLE IF NOT EXISTS commission_rules (
  id INTEGER PRIMARY KEY, country_code TEXT NOT NULL REFERENCES countries(code), parent_category TEXT NOT NULL,
  keywords TEXT NOT NULL, rate DOUBLE PRECISION NOT NULL, min_price DOUBLE PRECISION, max_price DOUBLE PRECISION,
  threshold_price DOUBLE PRECISION, rate_above DOUBLE PRECISION, minimum_fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'estimate', source_note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS size_tiers (
  id INTEGER PRIMARY KEY, country_code TEXT NOT NULL REFERENCES countries(code), tier_code TEXT NOT NULL,
  tier_name TEXT NOT NULL, max_long_cm DOUBLE PRECISION NOT NULL, max_mid_cm DOUBLE PRECISION NOT NULL,
  max_short_cm DOUBLE PRECISION NOT NULL, min_item_weight_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_item_weight_kg DOUBLE PRECISION NOT NULL, max_volume_weight_kg DOUBLE PRECISION,
  max_total_cm DOUBLE PRECISION, dimension_mode TEXT NOT NULL DEFAULT 'none',
  class_weight_mode TEXT NOT NULL DEFAULT 'actual', fee_weight_mode TEXT NOT NULL DEFAULT 'max',
  status TEXT NOT NULL DEFAULT 'verified', source_note TEXT NOT NULL DEFAULT '', UNIQUE(country_code,tier_code)
);
CREATE TABLE IF NOT EXISTS fba_rules (
  id INTEGER PRIMARY KEY, country_code TEXT NOT NULL REFERENCES countries(code), size_name TEXT NOT NULL,
  size_tier TEXT NOT NULL DEFAULT '', max_long_cm DOUBLE PRECISION NOT NULL,
  max_mid_cm DOUBLE PRECISION NOT NULL, max_short_cm DOUBLE PRECISION NOT NULL,
  max_weight_kg DOUBLE PRECISION NOT NULL, max_total_cm DOUBLE PRECISION,
  included_weight_kg DOUBLE PRECISION NOT NULL DEFAULT 0, base_fee DOUBLE PRECISION NOT NULL,
  per_kg_fee DOUBLE PRECISION NOT NULL DEFAULT 0, surcharge_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  weight_increment_kg DOUBLE PRECISION NOT NULL DEFAULT 0, min_price DOUBLE PRECISION,
  max_price DOUBLE PRECISION, category_group TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL DEFAULT 'estimate', source_note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS freight_rules (
  id INTEGER PRIMARY KEY, country_code TEXT NOT NULL UNIQUE REFERENCES countries(code),
  channel_name TEXT NOT NULL DEFAULT '默认渠道', price_per_kg_cny DOUBLE PRECISION NOT NULL DEFAULT 0,
  pricing_mode TEXT NOT NULL DEFAULT 'kg', price_per_cbm_cny DOUBLE PRECISION NOT NULL DEFAULT 0,
  min_charge_cny DOUBLE PRECISION NOT NULL DEFAULT 0, volume_divisor DOUBLE PRECISION NOT NULL DEFAULT 6000,
  status TEXT NOT NULL DEFAULT 'missing', source_note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

async function seedRules(client) {
  const { rows:[count] } = await client.query('SELECT COUNT(*)::int AS count FROM countries');
  if (count.count) return;
  const rulesPath = path.join(__dirname,'..','docs','data','rules.json');
  const rules = JSON.parse(fs.readFileSync(rulesPath,'utf8'));
  const tables = ['countries','commission_rules','size_tiers','fba_rules','freight_rules'];
  for (const table of tables) {
    for (const row of rules[table]) {
      const columns = Object.keys(row);
      const values = columns.map((column) => table === 'countries' && column === 'active' ? Boolean(row[column]) : row[column]);
      const placeholders = values.map((_,index) => `$${index + 1}`).join(',');
      await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`,values);
    }
  }
  await client.query("INSERT INTO app_meta(key,value) VALUES ('rules_seed_generated_at',$1)",[rules.generatedAt]);
}

async function migrateSchema(client) {
  await client.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS share_key TEXT NOT NULL DEFAULT ''");
  const { rows:projectsWithoutShareKey } = await client.query("SELECT id FROM projects WHERE share_key='' OR share_key IS NULL");
  for (const project of projectsWithoutShareKey) {
    await client.query('UPDATE projects SET share_key=$1 WHERE id=$2',[crypto.randomUUID(),project.id]);
  }
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_share_key ON projects(share_key) WHERE share_key<>''");
  const competitorColumns = {
    asin:"TEXT NOT NULL DEFAULT ''",image_url:"TEXT NOT NULL DEFAULT ''",product_url:"TEXT NOT NULL DEFAULT ''",
    is_fba:'INTEGER',has_aplus:'INTEGER',has_video:'INTEGER',listing_date:"TEXT NOT NULL DEFAULT ''",
    monthly_sales:'DOUBLE PRECISION NOT NULL DEFAULT 0',monthly_revenue_local:'DOUBLE PRECISION NOT NULL DEFAULT 0',
    monthly_revenue_usd:'DOUBLE PRECISION NOT NULL DEFAULT 0',rating:'DOUBLE PRECISION',
    source_format:"TEXT NOT NULL DEFAULT ''",source_row:'INTEGER NOT NULL DEFAULT 0',
    feature_bullets:"JSONB NOT NULL DEFAULT '[]'::jsonb",selling_points:"JSONB NOT NULL DEFAULT '[]'::jsonb",
    differentiation:"JSONB NOT NULL DEFAULT '[]'::jsonb",analysis_status:"TEXT NOT NULL DEFAULT ''",
    analysis_warning:"TEXT NOT NULL DEFAULT ''",analysis_model:"TEXT NOT NULL DEFAULT ''",analysis_at:"TEXT NOT NULL DEFAULT ''"
  };
  for (const [column,type] of Object.entries(competitorColumns)) {
    await client.query(`ALTER TABLE project_competitors ADD COLUMN IF NOT EXISTS ${column} ${type}`);
  }
}

async function initialize() {
  pool ||= createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await migrateSchema(client);
    await seedRules(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function ready() { return readyPromise ||= initialize(); }
async function query(text,params=[]) { await ready(); return pool.query(text,params); }
async function one(text,params=[]) { const result=await query(text,params); return result.rows[0] || null; }
async function many(text,params=[]) { return (await query(text,params)).rows; }
async function transaction(callback) {
  await ready();const client=await pool.connect();
  try { await client.query('BEGIN');const result=await callback(client);await client.query('COMMIT');return result; }
  catch (error) { await client.query('ROLLBACK').catch(()=>{});throw error; }
  finally { client.release(); }
}
async function close() { if (pool) { await pool.end();pool=null;readyPromise=null; } }

module.exports = { ready,query,one,many,transaction,close };
