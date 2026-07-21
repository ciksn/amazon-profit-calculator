'use strict';

const fs = require('node:fs');
const path = require('node:path');

const defaultPath = path.join(__dirname,'..','config','datapool.local.json');

function loadLocalConfig(options = {}) {
  const file = path.resolve(options.path || process.env.DATAPOOL_CONFIG_PATH || defaultPath);
  if (!fs.existsSync(file)) {
    if (options.required) throw new Error(`缺少本地配置文件：${file}；请复制 config/datapool.example.json 后填写`);
    return { file,config:{} };
  }
  let config;
  try { config=JSON.parse(fs.readFileSync(file,'utf8')); }
  catch { throw new Error(`本地配置文件不是有效 JSON：${file}`); }
  if (!process.env.DATABASE_URL && config.database_url) process.env.DATABASE_URL=config.database_url;
  return { file,config };
}

function requireDatapoolConfig() {
  const loaded=loadLocalConfig({ required:true });
  const missing=['base_url','api_key','database_url'].filter((key) => !loaded.config[key]);
  if (missing.length) throw new Error(`本地配置缺少：${missing.join('、')}`);
  if (/请填|replace|change-me/i.test(String(loaded.config.api_key))) throw new Error('请先在 config/datapool.local.json 填写真实 api_key');
  return loaded;
}

module.exports = { loadLocalConfig, requireDatapoolConfig };
