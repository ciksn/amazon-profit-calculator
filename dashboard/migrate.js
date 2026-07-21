'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadLocalConfig } = require('./local-config');
const { getPool, closePool } = require('./db');

loadLocalConfig();

async function main() {
  const dir = path.join(__dirname,'migrations');
  const files = fs.readdirSync(dir).filter((name) => /^\d+_.*\.sql$/.test(name) && !name.includes('_demo_')).sort();
  for (const name of files) {
    await getPool().query(fs.readFileSync(path.join(dir,name),'utf8'));
    console.log(`已执行 ${name}`);
  }
  console.log('PostgreSQL 本地表和看板视图已初始化。');
}

main().finally(closePool).catch((error) => { console.error(error); process.exitCode = 1; });
