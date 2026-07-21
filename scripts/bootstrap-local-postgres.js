'use strict';

const { Pool } = require('pg');
const { loadLocalConfig } = require('../dashboard/local-config');

async function main() {
  const config=loadLocalConfig({ required:true }).config;
  const target=new URL(config.database_url);
  const password=decodeURIComponent(target.password);
  const admin=new URL(config.database_url);
  admin.username='postgres';
  admin.pathname='/postgres';
  const pool=new Pool({ connectionString:admin.toString(),max:1 });
  try {
    const role=(await pool.query("SELECT 1 FROM pg_roles WHERE rolname='margingo'")).rowCount > 0;
    const database=(await pool.query("SELECT 1 FROM pg_database WHERE datname='margingo'")).rowCount > 0;
    console.log(JSON.stringify({ adminConnection:true,targetRoleExists:role,targetDatabaseExists:database,mode:process.argv.includes('--apply') ? 'apply':'check' }));
    if (!process.argv.includes('--apply')) return;
    const literal=`'${password.replace(/'/g,"''")}'`;
    if (!role) await pool.query(`CREATE ROLE margingo LOGIN PASSWORD ${literal}`);
    else await pool.query(`ALTER ROLE margingo LOGIN PASSWORD ${literal}`);
    if (!database) await pool.query('CREATE DATABASE margingo OWNER margingo');
    console.log(JSON.stringify({ ready:true,role:'margingo',database:'margingo' }));
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.message);process.exitCode=1; });
