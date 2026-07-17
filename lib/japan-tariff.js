'use strict';

const CUSTOMS_ROOT = 'https://www.customs.go.jp';
const TARIFF_INDEX = `${CUSTOMS_ROOT}/english/tariff/`;
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function cleanText(html = '') {
  return html
    .replace(/<br\s*\/?\s*>/gi,' / ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;|&#160;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&quot;/gi,'"')
    .replace(/\s+/g,' ')
    .trim();
}

function normalizeHsCode(value) {
  const digits = String(value || '').replace(/\D/g,'');
  if (![6,9].includes(digits.length)) throw new Error('请输入 6 位或 9 位日本 HS 编码');
  const chapter = Number(digits.slice(0,2));
  if (chapter < 1 || chapter > 97 || chapter === 77) throw new Error('HS 编码章节无效');
  return digits;
}

function parseRate(value) {
  const text = String(value || '').replace(/[()]/g,'').trim();
  if (!text) return { text:'',percent:null };
  if (/^free$/i.test(text)) return { text:'Free',percent:0 };
  const match = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
  return { text,percent:match ? Number(match[1]) : null };
}

function parseRows(html) {
  const start = html.search(/<table[^>]+id=["']datatable["']/i);
  if (start < 0) throw new Error('日本海关税则页面结构已变化，暂时无法自动解析');
  const rows = [...html.slice(start).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/gi)]
      .map((cell) => cleanText(cell[2])));
  const result = [];
  let currentHs6 = '';
  let baseRates = null;
  for (const cells of rows.slice(2)) {
    if (cells.length < 8) continue;
    const rawHs = String(cells[0] || '').replace(/\D/g,'');
    if (rawHs.length === 6) {
      currentHs6 = rawHs;
      baseRates = cells.slice(3,30);
    }
    if (!currentHs6) continue;
    const stat = String(cells[1] || '').replace(/\D/g,'');
    const rates = cells.slice(3,30).map((value,index) => value || baseRates?.[index] || '');
    result.push({
      hs6:currentHs6,
      statisticalCode:stat.length === 3 ? stat : '',
      code:stat.length === 3 ? `${currentHs6}${stat}` : currentHs6,
      description:cells[2] || '',
      general:parseRate(rates[0]),
      temporary:parseRate(rates[1]),
      wto:parseRate(rates[2]),
      chinaRcep:parseRate(rates[24])
    });
  }
  return result;
}

function chooseRate(row, preference) {
  if (preference === 'rcep') {
    if (row.chinaRcep.percent !== null) return { ...row.chinaRcep,type:'中国 RCEP' };
    return { text:row.chinaRcep.text,percent:null,type:'中国 RCEP',warning:'该税目未提供可直接换算的中国 RCEP 百分比税率' };
  }
  const selected = [
    ['WTO/MFN',row.wto],
    ['临时税率',row.temporary],
    ['一般税率',row.general]
  ].find(([,rate]) => rate.percent !== null);
  return selected
    ? { ...selected[1],type:selected[0] }
    : { text:row.wto.text || row.temporary.text || row.general.text,percent:null,type:'普通适用税率',warning:'该税目不是单一百分比税率，请人工确认' };
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url,{ headers:{ 'User-Agent':'MarginGo/1.0 tariff lookup' },signal:AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`日本海关返回 HTTP ${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve,300 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getLatestSchedule() {
  const cached = cache.get('schedule');
  if (cached && Date.now() - cached.savedAt < CACHE_MS) return cached.value;
  const response = await fetchWithRetry(TARIFF_INDEX);
  const html = new TextDecoder('shift-jis').decode(await response.arrayBuffer());
  const matches = [...html.matchAll(/(?:href=["']([^"']*?))?(\d{4})_(\d{2})_(\d{2})\/index\.htm/gi)];
  if (!matches.length) throw new Error('暂时无法识别日本海关最新税则版本');
  const versions = matches.map((match) => ({
    folder:`${match[2]}_${match[3]}_${match[4]}`,
    date:`${match[2]}-${match[3]}-${match[4]}`
  })).sort((a,b) => b.date.localeCompare(a.date));
  const value = versions[0];
  cache.set('schedule',{ savedAt:Date.now(),value });
  return value;
}

async function getChapterRows(schedule, chapter) {
  const key = `${schedule.folder}:${chapter}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.savedAt < CACHE_MS) return cached.value;
  const chapterText = String(chapter).padStart(2,'0');
  const url = `${CUSTOMS_ROOT}/english/tariff/${schedule.folder}/data/e_${chapterText}.htm`;
  const response = await fetchWithRetry(url);
  const html = new TextDecoder('shift-jis').decode(await response.arrayBuffer());
  const rows = parseRows(html);
  const value = { rows,url };
  cache.set(key,{ savedAt:Date.now(),value });
  return value;
}

async function lookupJapanTariff({ hsCode,originCountry = 'CN',preference = 'unknown' }) {
  const normalized = normalizeHsCode(hsCode);
  if (originCountry !== 'CN') throw new Error('第一版暂时仅支持中国原产商品');
  if (!['unknown','none','rcep'].includes(preference)) throw new Error('优惠资格选项无效');
  const schedule = await getLatestSchedule();
  const chapter = Number(normalized.slice(0,2));
  const { rows,url } = await getChapterRows(schedule,chapter);
  let matches = rows.filter((row) => normalized.length === 9 ? row.code === normalized : row.hs6 === normalized);
  if (normalized.length === 6) {
    const statisticalRows = matches.filter((row) => row.statisticalCode);
    if (statisticalRows.length) matches = statisticalRows;
  }
  matches = matches.filter((row,index,array) => array.findIndex((item) => item.code === row.code) === index);
  if (!matches.length) throw new Error('官方税则中未找到该编码，请确认是否为日本进口 HS 编码');
  const candidates = matches.map((row) => {
    const rate = chooseRate(row,preference === 'unknown' ? 'none' : preference);
    return {
      code:row.code,
      description:row.description,
      rate:rate.percent,
      rateText:rate.text,
      rateType:rate.type,
      warning:rate.warning || (preference === 'unknown' ? '优惠资格未知，暂按非优惠税率建议' : '')
    };
  });
  const autoApplicable = candidates.length === 1 && candidates[0].rate !== null;
  return {
    status:autoApplicable ? 'matched':'needs_confirmation',
    inputCode:normalized,
    originCountry,
    preference,
    scheduleDate:schedule.date,
    sourceUrl:url,
    referenceOnly:true,
    candidate:autoApplicable ? candidates[0] : null,
    candidates
  };
}

module.exports = { lookupJapanTariff,normalizeHsCode,parseRate,parseRows,chooseRate };
