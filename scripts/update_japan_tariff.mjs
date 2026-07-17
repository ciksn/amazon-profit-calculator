import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'https://www.customs.go.jp';
const outDir = path.resolve(import.meta.dirname,'..','docs','data','japan-tariff');
const requested = process.argv.find((arg) => arg.startsWith('--chapters='))?.split('=')[1];
const chapters = requested ? requested.split(',').map(Number) : Array.from({ length:97 },(_,index) => index + 1).filter((chapter) => chapter !== 77);
const clean = (html = '') => html.replace(/<br\s*\/?\s*>/gi,' / ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
const rate = (value) => {
  const text = String(value || '').replace(/[()]/g,'').trim();
  if (!text) return { text:'',percent:null };
  if (/^free$/i.test(text)) return { text:'Free',percent:0 };
  const match = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
  return { text,percent:match ? Number(match[1]) : null };
};

function parse(html) {
  const start = html.search(/<table[^>]+id=["']datatable["']/i);
  if (start < 0) throw new Error('datatable not found');
  const rows = [...html.slice(start).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => clean(cell[2])));
  const output = []; let currentHs6 = ''; let baseRates = null;
  for (const cells of rows.slice(2)) {
    if (cells.length < 8) continue;
    const rawHs = String(cells[0] || '').replace(/\D/g,'');
    if (rawHs.length === 6) { currentHs6 = rawHs; baseRates = cells.slice(3,30); }
    if (!currentHs6) continue;
    const statisticalCode = String(cells[1] || '').replace(/\D/g,'');
    const rates = cells.slice(3,30).map((value,index) => value || baseRates?.[index] || '');
    output.push({ hs6:currentHs6,statisticalCode:statisticalCode.length === 3 ? statisticalCode:'',
      code:statisticalCode.length === 3 ? `${currentHs6}${statisticalCode}`:currentHs6,description:cells[2] || '',
      general:rate(rates[0]),temporary:rate(rates[1]),wto:rate(rates[2]),chinaRcep:rate(rates[24]) });
  }
  return output;
}

async function fetchRetry(url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url,{ headers:{ 'User-Agent':'MarginGo GitHub Pages tariff updater' },signal:AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) { last = error; if (attempt < 3) await new Promise((resolve) => setTimeout(resolve,attempt * 600)); }
  }
  throw last;
}

await fs.mkdir(outDir,{ recursive:true });
const indexResponse = await fetchRetry(`${ROOT}/english/tariff/`);
const indexHtml = new TextDecoder('shift-jis').decode(await indexResponse.arrayBuffer());
const versions = [...indexHtml.matchAll(/(\d{4})_(\d{2})_(\d{2})\/index\.htm/gi)]
  .map((match) => ({ folder:`${match[1]}_${match[2]}_${match[3]}`,date:`${match[1]}-${match[2]}-${match[3]}` }))
  .sort((a,b) => b.date.localeCompare(a.date));
if (!versions.length) throw new Error('无法识别日本海关最新税则版本');
const schedule = versions[0]; const completed = []; const failed = [];

async function updateChapter(chapter) {
  const code = String(chapter).padStart(2,'0');
  const url = `${ROOT}/english/tariff/${schedule.folder}/data/e_${code}.htm`;
  try {
    const response = await fetchRetry(url); const html = new TextDecoder('shift-jis').decode(await response.arrayBuffer()); const rows = parse(html);
    await fs.writeFile(path.join(outDir,`${code}.json`),JSON.stringify(rows)); completed.push(code); console.log(`${code}: ${rows.length}`);
  } catch (error) { failed.push({ chapter:code,error:error.message }); console.error(`${code}: ${error.message}`); }
}

for (let index = 0; index < chapters.length; index += 4) await Promise.all(chapters.slice(index,index + 4).map(updateChapter));
await fs.writeFile(path.join(outDir,'manifest.json'),JSON.stringify({ scheduleDate:schedule.date,generatedAt:new Date().toISOString(),
  sourceRoot:`${ROOT}/english/tariff/${schedule.folder}`,chapters:completed.sort(),failed },null,2));
console.log(`完成 ${completed.length} 章，失败 ${failed.length} 章，税则日期 ${schedule.date}`);
if (!completed.length) process.exitCode = 1;
