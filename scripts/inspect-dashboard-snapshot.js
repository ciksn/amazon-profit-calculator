'use strict';

const { loadLocalConfig } = require('../dashboard/local-config');
const { getPool,closePool } = require('../dashboard/db');

async function main() {
  loadLocalConfig({ required:true });
  const pool=getPool();
  const run=await pool.query(`SELECT id,status,analysis_start_date,analysis_end_date,principal_count,seller_count,
    product_count,analysis_count,finished_at FROM datapool_sync_runs ORDER BY id DESC LIMIT 1`);
  const summary=await pool.query(`SELECT COUNT(*)::int AS rows,COUNT(DISTINCT asin)::int AS asins,
    COUNT(DISTINCT owner_name)::int AS owners,COUNT(DISTINCT country_code)::int AS sites,
    COUNT(*) FILTER(WHERE source_profit_rate IS NOT NULL)::int AS profit_rows,
    COUNT(*) FILTER(WHERE image_url IS NOT NULL AND image_url<>'')::int AS image_rows,
    COUNT(*) FILTER(WHERE category_text IS NOT NULL AND category_text<>'')::int AS category_rows,
    COUNT(*) FILTER(WHERE sale_price IS NOT NULL)::int AS price_rows,
    COUNT(*) FILTER(WHERE source_listing_currency IS NOT NULL AND source_listing_currency<>'')::int AS currency_rows,
    COUNT(*) FILTER(WHERE weight_kg IS NOT NULL)::int AS weight_rows,
    COUNT(*) FILTER(WHERE length_cm IS NOT NULL AND width_cm IS NOT NULL AND height_cm IS NOT NULL)::int AS dimension_rows,
    COUNT(*) FILTER(WHERE source_volume_cm3 IS NOT NULL)::int AS volume_rows
    FROM dashboard_product_sites_v`);
  const sites=await pool.query(`SELECT country_code,COUNT(*)::int AS rows FROM dashboard_product_sites_v
    GROUP BY country_code ORDER BY country_code`);
  console.log(JSON.stringify({ latestRun:run.rows[0],dashboard:summary.rows[0],sites:sites.rows },null,2));
}

main().finally(closePool).catch((error) => { console.error(error.message);process.exitCode=1; });
