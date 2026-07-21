'use strict';

const { Pool, types } = require('pg');

types.setTypeParser(1700, (value) => value == null ? null : Number(value));

let pool;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: String(process.env.PGSSL).toLowerCase() === 'true' ? { rejectUnauthorized:false } : false,
      max: Number(process.env.PG_POOL_SIZE || 10),
      idleTimeoutMillis: 30_000
    });
  }
  return pool;
}

async function closePool() {
  if (pool) await pool.end();
  pool = undefined;
}

module.exports = { getPool, closePool };
