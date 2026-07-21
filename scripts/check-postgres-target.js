'use strict';

const { loadLocalConfig } = require('../dashboard/local-config');
const { getPool,closePool } = require('../dashboard/db');

async function main() {
  loadLocalConfig({ required:true });
  const pool=getPool();
  const connection=await pool.query('SELECT current_database() AS database,current_user AS username,inet_server_addr() AS host,inet_server_port() AS port');
  const objects=await pool.query(`SELECT table_name,'table' AS type FROM information_schema.tables
    WHERE table_schema='public' AND table_name=ANY($1)
    UNION ALL SELECT table_name,'view' AS type FROM information_schema.views
    WHERE table_schema='public' AND table_name='dashboard_product_sites_v' ORDER BY type,table_name`,[
    ['countries','size_tiers','fba_rules','freight_rules','commission_rules','datapool_sync_runs']
  ]);
  console.log(JSON.stringify({ connection:connection.rows[0],existingObjects:objects.rows },null,2));
}

main().finally(closePool).catch((error) => { console.error(error.message);process.exitCode=1; });
