import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname,'..');
const docs = path.join(root,'docs');
const dataDir = path.join(docs,'data');
fs.mkdirSync(dataDir,{ recursive:true });

const pagesApiBaseRaw=String(process.env.MARGINGO_PAGES_API_BASE || '').trim();
let pagesApiUrl;
try {
  pagesApiUrl=new URL(pagesApiBaseRaw);
} catch {
  throw new Error('MARGINGO_PAGES_API_BASE must be an HTTPS origin, for example https://www.200392.xyz');
}
if (
  pagesApiUrl.protocol!=='https:' ||
  pagesApiUrl.pathname!=='/' ||
  pagesApiUrl.search ||
  pagesApiUrl.hash ||
  pagesApiUrl.username ||
  pagesApiUrl.password ||
  pagesApiUrl.origin==='null'
) {
  throw new Error('MARGINGO_PAGES_API_BASE must be an HTTPS origin without a path, query, hash, or credentials');
}
const pagesApiBase=pagesApiUrl.origin;

for (const name of ['styles.css','ui-fixes.css','admin.css','dimensions.js','app.js','embed.css','embed.js','competitor-import.js','site-card.css','site-card.js','selection-document.css','selection-document.js','selection-ai.css','selection-ai.js']) {
  fs.copyFileSync(path.join(root,'public',name),path.join(docs,name));
}
fs.copyFileSync(path.join(root,'node_modules','exceljs','dist','exceljs.min.js'),path.join(docs,'exceljs.min.js'));
fs.copyFileSync(path.join(root,'pages-src','static-api.js'),path.join(docs,'static-api.js'));
fs.copyFileSync(path.join(root,'pages-src','config.js'),path.join(docs,'config.js'));
fs.writeFileSync(
  path.join(docs,'embed-config.js'),
  `window.MARGINGO_API_BASE = ${JSON.stringify(pagesApiBase)};\nwindow.MARGINGO_STATIC_MODE = false;\n`
);

let html = fs.readFileSync(path.join(root,'public','index.html'),'utf8');
html = html.replace('<script src="./config.js"></script>','<script src="./config.js"></script>\n  <script src="./profit-engine.js"></script>\n  <script src="./static-api.js"></script>');
fs.writeFileSync(path.join(docs,'index.html'),html);

let embedHtml = fs.readFileSync(path.join(root,'public','embed.html'),'utf8');
embedHtml = embedHtml.replace('<script src="./config.js"></script>','<script src="./embed-config.js"></script>');
fs.writeFileSync(path.join(docs,'embed.html'),embedHtml);
let siteCardHtml = fs.readFileSync(path.join(root,'public','site-card.html'),'utf8');
siteCardHtml = siteCardHtml.replace('<script src="./config.js"></script>','<script src="./embed-config.js"></script>');
fs.writeFileSync(path.join(docs,'site-card.html'),siteCardHtml);
let selectionDocumentHtml = fs.readFileSync(path.join(root,'public','selection-document.html'),'utf8');
selectionDocumentHtml = selectionDocumentHtml.replace('<script src="./config.js"></script>','<script src="./config.js"></script>\n  <script src="./profit-engine.js"></script>\n  <script src="./static-api.js"></script>');
fs.writeFileSync(path.join(docs,'selection-document.html'),selectionDocumentHtml);
fs.writeFileSync(path.join(docs,'.nojekyll'),'');

let profit = fs.readFileSync(path.join(root,'lib','profit.js'),'utf8');
profit = profit.replace(/^'use strict';\s*/,'').replace(/module\.exports\s*=\s*\{([^}]+)\};\s*$/s,'window.MarginGoProfit = {$1};');
fs.writeFileSync(path.join(docs,'profit-engine.js'),`'use strict';\n(() => {\n${profit}\n})();\n`);

const output = JSON.parse(fs.readFileSync(path.join(dataDir,'rules.json'),'utf8'));
const tables = ['countries','commission_rules','size_tiers','fba_rules','freight_rules'];
console.log(`GitHub Pages 文件已生成：${docs}`);
console.log(tables.map((table) => `${table}=${output[table].length}`).join(' '));
