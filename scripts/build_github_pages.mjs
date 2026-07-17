import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../lib/db');
const root = path.resolve(import.meta.dirname,'..');
const docs = path.join(root,'docs');
const dataDir = path.join(docs,'data');
fs.mkdirSync(dataDir,{ recursive:true });

for (const name of ['styles.css','ui-fixes.css','admin.css','dimensions.js','app.js']) {
  fs.copyFileSync(path.join(root,'public',name),path.join(docs,name));
}
fs.copyFileSync(path.join(root,'pages-src','static-api.js'),path.join(docs,'static-api.js'));
fs.copyFileSync(path.join(root,'pages-src','config.js'),path.join(docs,'config.js'));

let html = fs.readFileSync(path.join(root,'public','index.html'),'utf8');
html = html.replace('<script src="./config.js"></script>','<script src="./config.js"></script>\n  <script src="./profit-engine.js"></script>\n  <script src="./static-api.js"></script>');
fs.writeFileSync(path.join(docs,'index.html'),html);
fs.writeFileSync(path.join(docs,'.nojekyll'),'');

let profit = fs.readFileSync(path.join(root,'lib','profit.js'),'utf8');
profit = profit.replace(/^'use strict';\s*/,'').replace(/module\.exports\s*=\s*\{([^}]+)\};\s*$/s,'window.MarginGoProfit = {$1};');
fs.writeFileSync(path.join(docs,'profit-engine.js'),`'use strict';\n(() => {\n${profit}\n})();\n`);

const tables = ['countries','commission_rules','size_tiers','fba_rules','freight_rules'];
const output = { generatedAt:new Date().toISOString() };
for (const table of tables) output[table] = db.prepare(`SELECT * FROM ${table}`).all();
fs.writeFileSync(path.join(dataDir,'rules.json'),JSON.stringify(output));

console.log(`GitHub Pages 文件已生成：${docs}`);
console.log(tables.map((table) => `${table}=${output[table].length}`).join(' '));
