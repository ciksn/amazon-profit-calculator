'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadLocalConfig } = require('../dashboard/local-config');
const { getPool, closePool } = require('../dashboard/db');

loadLocalConfig();

const TABLES = ['countries','size_tiers','fba_rules','freight_rules','commission_rules'];

async function main() {
  const sqlite = new DatabaseSync(path.join(__dirname,'..','data','margin.db'),{ readOnly:true });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // 先按依赖反序清理，再按正序导入，确保重复执行也不会触发外键冲突。
    for (const table of [...TABLES].reverse()) await client.query(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      if (!rows.length) continue;
      const pgColumns = (await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1`,[table]
      )).rows.map((row) => row.column_name);
      const columns = Object.keys(rows[0]).filter((column) => pgColumns.includes(column));
      for (const row of rows) {
        const values = columns.map((column) => table === 'countries' && column === 'active' ? Boolean(row[column]) : row[column]);
        await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${values.map((_,index) => `$${index + 1}`).join(',')})`,values);
      }
      console.log(`${table}: ${rows.length} 行`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    sqlite.close();
  }
}

main().finally(closePool).catch((error) => { console.error(error); process.exitCode = 1; });
