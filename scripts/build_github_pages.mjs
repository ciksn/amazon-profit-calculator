import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname,'..');
const docs = path.join(root,'docs');
const dataDir = path.join(docs,'data');
fs.mkdirSync(dataDir,{ recursive:true });

for (const name of ['styles.css','ui-fixes.css','admin.css','dimensions.js','app.js','embed.css','embed.js','site-card.css','site-card.js']) {
  fs.copyFileSync(path.join(root,'public',name),path.join(docs,name));
}
fs.copyFileSync(path.join(root,'pages-src','static-api.js'),path.join(docs,'static-api.js'));
fs.copyFileSync(path.join(root,'pages-src','config.js'),path.join(docs,'config.js'));

let html = fs.readFileSync(path.join(root,'public','index.html'),'utf8');
html = html.replace('<script src="./config.js"></script>','<script src="./config.js"></script>\n  <script src="./profit-engine.js"></script>\n  <script src="./static-api.js"></script>');
fs.writeFileSync(path.join(docs,'index.html'),html);

let embedHtml = fs.readFileSync(path.join(root,'public','embed.html'),'utf8');
embedHtml = embedHtml.replace('<script src="./config.js"></script>','<script src="./config.js"></script>\n  <script src="./profit-engine.js"></script>\n  <script src="./static-api.js"></script>');
fs.writeFileSync(path.join(docs,'embed.html'),embedHtml);
let siteCardHtml = fs.readFileSync(path.join(root,'public','site-card.html'),'utf8');
siteCardHtml = siteCardHtml.replace('<script src="./config.js"></script>','<script src="./config.js"></script>\n  <script src="./profit-engine.js"></script>\n  <script src="./static-api.js"></script>');
fs.writeFileSync(path.join(docs,'site-card.html'),siteCardHtml);
fs.writeFileSync(path.join(docs,'.nojekyll'),'');

let profit = fs.readFileSync(path.join(root,'lib','profit.js'),'utf8');
profit = profit.replace(/^'use strict';\s*/,'').replace(/module\.exports\s*=\s*\{([^}]+)\};\s*$/s,'window.MarginGoProfit = {$1};');
fs.writeFileSync(path.join(docs,'profit-engine.js'),`'use strict';\n(() => {\n${profit}\n})();\n`);

const output = JSON.parse(fs.readFileSync(path.join(dataDir,'rules.json'),'utf8'));
const tables = ['countries','commission_rules','size_tiers','fba_rules','freight_rules'];
console.log(`GitHub Pages 文件已生成：${docs}`);
console.log(tables.map((table) => `${table}=${output[table].length}`).join(' '));
