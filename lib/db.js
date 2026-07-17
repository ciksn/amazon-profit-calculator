'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { migrateStrictRules } = require('./strict-rules');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'margin.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

function initialize() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS countries (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, flag TEXT NOT NULL,
      currency TEXT NOT NULL, symbol TEXT NOT NULL, cny_per_local REAL NOT NULL,
      vat_rate REAL NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 0,
      tax_basis TEXT NOT NULL DEFAULT 'none', tax_label TEXT NOT NULL DEFAULT '税费预估',
      active INTEGER NOT NULL DEFAULT 1,
      fba_volume_divisor REAL NOT NULL DEFAULT 6000,
      priority INTEGER NOT NULL DEFAULT 99,
      tax_note TEXT NOT NULL DEFAULT '', source_note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      cost_cny REAL NOT NULL DEFAULT 0, length REAL NOT NULL DEFAULT 0,
      width REAL NOT NULL DEFAULT 0, height REAL NOT NULL DEFAULT 0,
      dimension_unit TEXT NOT NULL DEFAULT 'cm', weight REAL NOT NULL DEFAULT 0,
      weight_unit TEXT NOT NULL DEFAULT 'kg', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_countries (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      country_code TEXT NOT NULL REFERENCES countries(code), selected INTEGER NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0, category_text TEXT NOT NULL DEFAULT '',
      referral_rate_override REAL, matched_category TEXT NOT NULL DEFAULT '',
      matched_referral_rate REAL, matched_referral_threshold REAL,
      matched_referral_rate_above REAL, matched_referral_minimum REAL NOT NULL DEFAULT 0,
      declaration_ratio REAL NOT NULL DEFAULT 0.15,
      declared_value_override REAL,
      customs_rate REAL NOT NULL DEFAULT 0,
      consumption_tax_rate REAL NOT NULL DEFAULT 10,
      customs_hs_code TEXT NOT NULL DEFAULT '',
      customs_origin_country TEXT NOT NULL DEFAULT 'CN',
      customs_preference TEXT NOT NULL DEFAULT 'unknown',
      customs_rate_type TEXT NOT NULL DEFAULT '',
      customs_schedule_date TEXT NOT NULL DEFAULT '',
      customs_source_url TEXT NOT NULL DEFAULT '',
      screenshot_name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (project_id, country_code)
    );
    CREATE TABLE IF NOT EXISTS commission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country_code TEXT NOT NULL REFERENCES countries(code),
      parent_category TEXT NOT NULL, keywords TEXT NOT NULL, rate REAL NOT NULL,
      min_price REAL, max_price REAL,
      threshold_price REAL, rate_above REAL, minimum_fee REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'estimate', source_note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS fba_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country_code TEXT NOT NULL REFERENCES countries(code),
      size_name TEXT NOT NULL, max_long_cm REAL NOT NULL, max_mid_cm REAL NOT NULL,
      max_short_cm REAL NOT NULL, max_weight_kg REAL NOT NULL,
      max_total_cm REAL,
      included_weight_kg REAL NOT NULL DEFAULT 0, base_fee REAL NOT NULL,
      per_kg_fee REAL NOT NULL DEFAULT 0, surcharge_rate REAL NOT NULL DEFAULT 0,
      weight_increment_kg REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'estimate', source_note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS freight_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, country_code TEXT NOT NULL UNIQUE REFERENCES countries(code),
      channel_name TEXT NOT NULL DEFAULT '默认渠道', price_per_kg_cny REAL NOT NULL DEFAULT 0,
      pricing_mode TEXT NOT NULL DEFAULT 'kg', price_per_cbm_cny REAL NOT NULL DEFAULT 0,
      min_charge_cny REAL NOT NULL DEFAULT 0, volume_divisor REAL NOT NULL DEFAULT 6000,
      status TEXT NOT NULL DEFAULT 'missing', source_note TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const countryColumns = new Set(db.prepare('PRAGMA table_info(countries)').all().map((item) => item.name));
  if (!countryColumns.has('tax_rate')) db.exec("ALTER TABLE countries ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0");
  if (!countryColumns.has('tax_basis')) db.exec("ALTER TABLE countries ADD COLUMN tax_basis TEXT NOT NULL DEFAULT 'none'");
  if (!countryColumns.has('tax_label')) db.exec("ALTER TABLE countries ADD COLUMN tax_label TEXT NOT NULL DEFAULT '税费预估'");
  if (!countryColumns.has('active')) db.exec('ALTER TABLE countries ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  if (!countryColumns.has('fba_volume_divisor')) db.exec('ALTER TABLE countries ADD COLUMN fba_volume_divisor REAL NOT NULL DEFAULT 6000');
  const commissionColumns = new Set(db.prepare('PRAGMA table_info(commission_rules)').all().map((item) => item.name));
  if (!commissionColumns.has('min_price')) db.exec('ALTER TABLE commission_rules ADD COLUMN min_price REAL');
  if (!commissionColumns.has('max_price')) db.exec('ALTER TABLE commission_rules ADD COLUMN max_price REAL');
  if (!commissionColumns.has('threshold_price')) db.exec('ALTER TABLE commission_rules ADD COLUMN threshold_price REAL');
  if (!commissionColumns.has('rate_above')) db.exec('ALTER TABLE commission_rules ADD COLUMN rate_above REAL');
  if (!commissionColumns.has('minimum_fee')) db.exec('ALTER TABLE commission_rules ADD COLUMN minimum_fee REAL NOT NULL DEFAULT 0');
  const listingColumns = new Set(db.prepare('PRAGMA table_info(project_countries)').all().map((item) => item.name));
  if (!listingColumns.has('matched_referral_threshold')) db.exec('ALTER TABLE project_countries ADD COLUMN matched_referral_threshold REAL');
  if (!listingColumns.has('matched_referral_rate_above')) db.exec('ALTER TABLE project_countries ADD COLUMN matched_referral_rate_above REAL');
  if (!listingColumns.has('matched_referral_minimum')) db.exec('ALTER TABLE project_countries ADD COLUMN matched_referral_minimum REAL NOT NULL DEFAULT 0');
  if (!listingColumns.has('declaration_ratio')) db.exec('ALTER TABLE project_countries ADD COLUMN declaration_ratio REAL NOT NULL DEFAULT 0.15');
  if (!listingColumns.has('declared_value_override')) db.exec('ALTER TABLE project_countries ADD COLUMN declared_value_override REAL');
  if (!listingColumns.has('customs_rate')) db.exec('ALTER TABLE project_countries ADD COLUMN customs_rate REAL NOT NULL DEFAULT 0');
  if (!listingColumns.has('consumption_tax_rate')) db.exec('ALTER TABLE project_countries ADD COLUMN consumption_tax_rate REAL NOT NULL DEFAULT 10');
  if (!listingColumns.has('customs_hs_code')) db.exec("ALTER TABLE project_countries ADD COLUMN customs_hs_code TEXT NOT NULL DEFAULT ''");
  if (!listingColumns.has('customs_origin_country')) db.exec("ALTER TABLE project_countries ADD COLUMN customs_origin_country TEXT NOT NULL DEFAULT 'CN'");
  if (!listingColumns.has('customs_preference')) db.exec("ALTER TABLE project_countries ADD COLUMN customs_preference TEXT NOT NULL DEFAULT 'unknown'");
  if (!listingColumns.has('customs_rate_type')) db.exec("ALTER TABLE project_countries ADD COLUMN customs_rate_type TEXT NOT NULL DEFAULT ''");
  if (!listingColumns.has('customs_schedule_date')) db.exec("ALTER TABLE project_countries ADD COLUMN customs_schedule_date TEXT NOT NULL DEFAULT ''");
  if (!listingColumns.has('customs_source_url')) db.exec("ALTER TABLE project_countries ADD COLUMN customs_source_url TEXT NOT NULL DEFAULT ''");
  const fbaColumns = new Set(db.prepare('PRAGMA table_info(fba_rules)').all().map((item) => item.name));
  if (!fbaColumns.has('max_total_cm')) db.exec('ALTER TABLE fba_rules ADD COLUMN max_total_cm REAL');
  if (!fbaColumns.has('weight_increment_kg')) db.exec('ALTER TABLE fba_rules ADD COLUMN weight_increment_kg REAL NOT NULL DEFAULT 0');
  const freightColumns = new Set(db.prepare('PRAGMA table_info(freight_rules)').all().map((item) => item.name));
  if (!freightColumns.has('pricing_mode')) db.exec("ALTER TABLE freight_rules ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'kg'");
  if (!freightColumns.has('price_per_cbm_cny')) db.exec('ALTER TABLE freight_rules ADD COLUMN price_per_cbm_cny REAL NOT NULL DEFAULT 0');
  const count = db.prepare('SELECT COUNT(*) AS count FROM countries').get().count;
  if (!count) seed();
  migrateOperatingTaxV2();
  migrateJapanImportTaxV1();
  migrateSourceRulesV3();
  migrateCommissionFallbackV1();
  migrateStrictRules(db);
}

function migrateJapanImportTaxV1() {
  const version = db.prepare("SELECT value FROM app_meta WHERE key = 'japan_import_tax_version'").get();
  if (version?.value === '1') return;
  db.prepare(`UPDATE countries SET tax_rate = 0, vat_rate = 0, tax_basis = 'japan_import',
    tax_label = '日本进口税金', tax_note = '申报价×关税率＋（申报价＋关税）×消费税率；申报比例默认15%，消费税默认10%' WHERE code = 'JP'`).run();
  db.prepare("INSERT INTO app_meta (key,value) VALUES ('japan_import_tax_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
}

function migrateCommissionFallbackV1() {
  const version = db.prepare("SELECT value FROM app_meta WHERE key = 'commission_fallback_version'").get();
  if (version?.value === '1') return;
  const stmt = db.prepare(`INSERT INTO commission_rules
    (country_code,parent_category,keywords,rate,min_price,max_price,minimum_fee,status,source_note)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const rows = [
    ['AU','Other / 其他类别',15,null,null,0,'AU2.png；Everything Else'],
    ['US','Other / 其他类别',15,null,null,.30,'美国.png；Everything Else'],
    ['GB','Other / 其他类别',15,null,null,.25,'UK.png；Everything else'],
    ['DE','Other / 其他类别',15,null,null,.30,'德国.png；Everything else'],
    ['CA','Other / 其他类别',15,null,null,.40,'canada.png；Everything Else'],
    ['AE','Other / 其他类别',10,null,null,1,'阿联酋ae.png；All Other Categories'],
    ['JP','Other / 其他类别',5,null,750,30,'JP.png；其他类别，售价不高于750日元'],
    ['JP','Other / 其他类别',15.4,750.000001,null,30,'JP.png；其他类别，售价高于750日元']
  ];
  for (const [code,name,rate,min,max,minimum,note] of rows) {
    stmt.run(code,name,'other,everything else,all other categories,其他,其它',rate,min,max,minimum,'verified',note);
  }
  db.prepare("INSERT INTO app_meta (key,value) VALUES ('commission_fallback_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
}

function migrateSourceRulesV3() {
  const version = db.prepare("SELECT value FROM app_meta WHERE key = 'source_rules_version'").get();
  if (version?.value === '5') return;

  db.prepare("UPDATE countries SET active = CASE WHEN code IN ('FR','IT','MX') THEN 0 ELSE 1 END").run();
  db.prepare("UPDATE countries SET fba_volume_divisor = CASE WHEN code = 'AU' THEN 4000 ELSE 6000 END").run();

  const freight = {
    AU:['kg',4.8,0,'澳大利亚预估空运', '运营提供预估价：4.8 RMB/计费KG'],
    US:['kg',7,0,'美国预估空运', '运营提供预估价：7 RMB/计费KG'],
    CA:['kg',8,0,'加拿大预估空运', '运营提供预估价：8 RMB/计费KG'],
    DE:['kg',12,0,'德国预估空运', '运营提供预估价：12 RMB/计费KG'],
    SA:['cbm',0,1500,'沙特预估海运', '运营提供预估价：1500 RMB/立方米'],
    AE:['cbm',0,900,'阿联酋预估海运', '运营提供预估价：900 RMB/立方米'],
    JP:['cbm',0,850,'日本预估海运', '运营提供预估价：850 RMB/立方米'],
    GB:['cbm',0,700,'英国预估海运', '运营提供预估价：700 RMB/立方米']
  };
  const freightStmt = db.prepare(`UPDATE freight_rules SET pricing_mode = ?, price_per_kg_cny = ?,
    price_per_cbm_cny = ?, channel_name = ?, volume_divisor = 6000, status = 'estimate', source_note = ?
    WHERE country_code = ?`);
  for (const [code, values] of Object.entries(freight)) freightStmt.run(...values, code);

  db.prepare("DELETE FROM commission_rules WHERE country_code IN ('AU','US','GB','DE','JP','CA','AE')").run();
  const commissionStmt = db.prepare(`INSERT INTO commission_rules
    (country_code,parent_category,keywords,rate,min_price,max_price,status,source_note)
    VALUES (?,?,?,?,?,?,?,?)`);
  const source = 'marginGO 品类佣金截图/表格（2025-2026）';
  const addCommission = (code, name, keywords, rate, min = null, max = null) =>
    commissionStmt.run(code,name,keywords,rate,min,max,'verified',source);
  const plainRules = {
    AU:[['Home & Kitchen','home,kitchen,家居,厨房',13],['Consumer Electronics','consumer electronics,消费电子',8],['Electronics Accessories','electronics accessories,电子配件',13.5],['Computers','computer,电脑',8],['Furniture','furniture,家具',12],['Office Products','office,办公',11],['Sports & Outdoors','sports,outdoors,运动,户外',13],['Toys & Games','toy,game,玩具',12],['Automotive','automotive,汽车',10.5],['Power Tools','power tools,电动工具',7]],
    US:[['Home & Kitchen','home,kitchen,家居,厨房',15],['Consumer Electronics','consumer electronics,消费电子',8],['Computers','computer,电脑',8],['Electronics Accessories','electronics accessories,电子配件',15],['Office Products','office,办公',15],['Sports & Outdoors','sports,outdoors,运动,户外',15],['Toys & Games','toy,game,玩具',15],['Tools & Home Improvement','tools,home improvement,工具,家装',15]],
    GB:[['Kitchen','kitchen,厨房',15],['Computers','computer,电脑',7],['Consumer Electronics','consumer electronics,消费电子',7],['Office Products','office,办公',15],['Sports & Outdoors','sports,outdoors,运动,户外',15],['Toys & Games','toy,game,玩具',15],['Tools & Home Improvement','tools,home improvement,工具,家装',13]],
    DE:[['Kitchen','kitchen,厨房',15],['Computers','computer,电脑',7],['Consumer Electronics','consumer electronics,消费电子',7],['Office Products','office,办公',15],['Sports & Outdoors','sports,outdoors,运动,户外',15],['Toys & Games','toy,game,玩具',15],['Tools & Home Improvement','tools,home improvement,工具,家装',13]],
    JP:[['Media','media,媒体',15.4],['Home & Kitchen','home,kitchen,家居,厨房',15.4],['Office Products','office,办公',15.4],['Consumer Electronics','consumer electronics,消费电子',8.4],['Computers','computer,电脑',10.4],['Sports & Outdoors','sports,outdoors,运动,户外',10.4],['Toys & Games','toy,game,玩具',10.4],['Tools & Home Improvement','tools,home improvement,工具,家装',15.4]],
    CA:[['Home & Kitchen','home,kitchen,家居,厨房',15],['Consumer Electronics','consumer electronics,消费电子',8],['Computers','computer,电脑',8],['Electronics Accessories','electronics accessories,电子配件',15],['Office Products','office,办公',15],['Sports & Outdoors','sports,outdoors,运动,户外',15],['Toys & Games','toy,game,玩具',15],['Tools & Home Improvement','tools,home improvement,工具,家装',15]],
    AE:[['Home','home,家居',15],['Kitchen','kitchen,厨房',15],['Consumer Electronics','consumer electronics,消费电子',7],['Camera','camera,相机',8],['Office Products','office,办公',14],['Outdoor','outdoor,户外',15],['Tools & Home Improvement','tools,home improvement,工具,家装',15],['Toys & Games','toy,game,玩具',14],['Automotive','automotive,汽车',12]]
  };
  for (const [code, rows] of Object.entries(plainRules)) for (const row of rows) addCommission(code,...row);
  db.prepare("UPDATE commission_rules SET min_price = 750.000001 WHERE country_code = 'JP' AND parent_category IN ('Consumer Electronics','Computers','Sports & Outdoors','Toys & Games')").run();
  for (const code of ['GB','DE']) {
    addCommission(code,'Home Products','home products,家居用品',8,null,20);
    addCommission(code,'Home Products','home products,家居用品',15,20.000001,null);
    addCommission(code,'Beauty','beauty,美妆',8,null,10);
    addCommission(code,'Beauty','beauty,美妆',15,10.000001,null);
    addCommission(code,'Clothing','clothing,apparel,服装',5,null,15);
    addCommission(code,'Clothing','clothing,apparel,服装',10,15.000001,20);
    addCommission(code,'Clothing','clothing,apparel,服装',15,20.000001,null);
    addCommission(code,'Electronics Accessories','electronics accessories,电子配件',15,null,100);
    addCommission(code,'Electronics Accessories','electronics accessories,电子配件',8,100.000001,null);
  }
  for (const code of ['AU']) {
    addCommission(code,'Beauty','beauty,美妆',8,null,20); addCommission(code,'Beauty','beauty,美妆',13,20.000001,null);
    addCommission(code,'Clothing','clothing,apparel,服装',10,null,20); addCommission(code,'Clothing','clothing,apparel,服装',13,20.000001,null);
    addCommission(code,'Grocery','grocery,food,食品,杂货',8,null,20); addCommission(code,'Grocery','grocery,food,食品,杂货',10,20.000001,null);
  }
  for (const code of ['US']) {
    addCommission(code,'Beauty','beauty,美妆',8,null,10); addCommission(code,'Beauty','beauty,美妆',15,10.000001,null);
    addCommission(code,'Baby Products','baby,婴儿',8,null,10); addCommission(code,'Baby Products','baby,婴儿',15,10.000001,null);
  }
  for (const category of [['Consumer Electronics','consumer electronics,消费电子'],['Computers','computer,电脑'],['Beauty','beauty,美妆'],['Sports & Outdoors','sports,outdoors,运动,户外'],['Toys & Games','toy,game,玩具']]) {
    addCommission('JP',category[0],category[1],5,null,750);
  }
  for (const category of [['Baby Products','baby,婴儿'],['Beauty','beauty,美妆'],['Pet Supplies','pet,宠物']]) {
    addCommission('AE',category[0],category[1],8,null,50); addCommission('AE',category[0],category[1],15,50.000001,null);
  }
  addCommission('AE','Electronics Accessories','electronics accessories,电子配件',15,null,250);
  addCommission('AE','Electronics Accessories','electronics accessories,电子配件',8,250.000001,null);

  seedVerifiedFbaRules();
  db.prepare("INSERT INTO app_meta (key,value) VALUES ('source_rules_version','5') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
}

function seedVerifiedFbaRules() {
  db.prepare("DELETE FROM fba_rules WHERE country_code IN ('AU','AE','CA','JP','GB','DE')").run();
  const stmt = db.prepare(`INSERT INTO fba_rules
    (country_code,size_name,max_long_cm,max_mid_cm,max_short_cm,max_weight_kg,max_total_cm,included_weight_kg,base_fee,per_kg_fee,surcharge_rate,status,source_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const add = (code,name,l,m,s,w,total,base,perKg=0,note='marginGO FBA 截图/表格') =>
    stmt.run(code,name,l,m,s,w,total,0,base,perKg,0,'verified',note);

  [['小号信封 75g',20,15,1,.075,4.55],['标准信封 75g',33,23,2.5,.075,4.58],['标准信封 225g',33,23,2.5,.225,5.26],['标准信封 475g',33,23,2.5,.475,5.61],['大号信封 225g',33,23,5,.225,6.78],['大号信封 475g',33,23,5,.475,7.02],['大号信封 975g',33,23,5,.975,7.24],['包裹 250g',45,34,20,.25,7.05],['包裹 500g',45,34,20,.5,7.05],['包裹 1kg',45,34,20,1,7.24],['包裹 1.5kg',45,34,20,1.5,8.88],['包裹 2kg',45,34,20,2,9.81],['包裹 3kg',45,34,20,3,9.86],['包裹 4kg',45,34,20,4,10.18],['包裹 5kg',45,34,20,5,10.19],['包裹 6kg',45,34,20,6,11.10],['包裹 7kg',45,34,20,7,11.26],['包裹 8kg',45,34,20,8,11.26],['包裹 9kg',45,34,20,9,11.27],['包裹 10kg',45,34,20,10,11.27],['包裹 11kg',45,34,20,11,13.80],['包裹 12kg',45,34,20,12,13.93],['小号大件 1kg',61,46,46,1,9.94],['小号大件 1.25kg',61,46,46,1.25,10.41],['小号大件 1.5kg',61,46,46,1.5,10.65],['小号大件 1.75kg',61,46,46,1.75,10.66],['小号大件 2kg',61,46,46,2,10.66],['标准大件 1kg',105,60,60,1,12.30],['标准大件 2kg',105,60,60,2,12.95],['标准大件 3kg',105,60,60,3,13.04],['标准大件 5kg',105,60,60,5,13.41],['标准大件 10kg',105,60,60,10,14.52],['标准大件 15kg',105,60,60,15,15.86],['标准大件 22kg',105,60,60,22,16.42],['大号大件 5kg',193,122,102,5,17.80],['大号大件 10kg',193,122,102,10,19.35],['大号大件 15kg',193,122,102,15,21.15],['大号大件 20kg',193,122,102,20,21.48],['大号大件 25kg',193,122,102,25,22.52],['大号大件 30kg',193,122,102,30,26.88],['大号大件 35kg',193,122,102,35,26.91],['超大件 35kg',250,250,250,35,90]].forEach(r=>add('AU',r[0],r[1],r[2],r[3],r[4],null,r[5],0,'marginGO AU 截图；采用售价≥20澳元/通用费率列'));
  stmt.run('AU','小号大件 >2kg',61,46,46,20,null,2,11.43,.1,0,'verified','marginGO AU 截图；超过2kg每kg AUD0.10');
  stmt.run('AU','标准大件 >22kg',105,60,60,35,null,22,19.39,.1,0,'verified','marginGO AU 截图；超过22kg每kg AUD0.10');
  stmt.run('AU','大号大件 >35kg',193,122,102,250,null,35,38.59,.1,0,'verified','marginGO AU 截图；超过35kg每kg AUD0.10');
  stmt.run('AU','超大件 >35kg',250,250,250,250,null,35,90,.1,0,'verified','marginGO AU 截图；超过35kg每kg AUD0.10');

  [['小信封 0.1kg',20,15,1,.1,7.5],['标准信封 0.1kg',33,23,2.5,.1,8],['标准信封 0.2kg',33,23,2.5,.2,8.2],['标准信封 0.5kg',33,23,2.5,.5,8.5],['大信封 1kg',33,23,5,1,9],['标准箱 0.25kg',45,34,26,.25,9.2],['标准箱 0.5kg',45,34,26,.5,9.5],['标准箱 1kg',45,34,26,1,10.5],['标准箱 2kg',45,34,26,2,11.5],['标准箱 3kg',45,34,26,3,12.5],['标准箱 5kg',45,34,26,5,14.5],['标准箱 8kg',45,34,26,8,17.5],['标准箱 12kg',45,34,26,12,21.5],['大件 15kg',45,34,26,15,26.5],['大件 20kg',45,34,26,20,31.5],['大件 25kg',45,34,26,25,36.5],['大件 30kg',45,34,26,30,41.5]].forEach(r=>add('AE',r[0],r[1],r[2],r[3],r[4],null,r[5]));

  [['信封 0.1kg',38,27,2,.1,4.46],['信封 0.2kg',38,27,2,.2,4.71],['信封 0.3kg',38,27,2,.3,5.01],['信封 0.4kg',38,27,2,.4,5.28],['信封 0.5kg',38,27,2,.5,5.62],['标准件 0.5kg',45,35,20,.5,7.23],['标准件 1kg',45,35,20,1,8.49],['标准件 1.5kg',45,35,20,1.5,9.60]].forEach(r=>add('CA',r[0],r[1],r[2],r[3],r[4],null,r[5]));
  stmt.run('CA','标准件 1.5-9kg',45,35,20,9,null,1.5,10.32,.9,0,'verified','marginGO CA1；超过1.5kg每100g CAD0.09');
  stmt.run('CA','小号超大件',152,76,76,32,330,.5,15.43,.92,0,'verified','marginGO CA1/CA2；续重 CAD0.46/500g');
  stmt.run('CA','中号超大件',270,270,270,68,330,.5,37.78,1.04,0,'verified','marginGO CA1/CA2；续重 CAD0.52/500g');
  stmt.run('CA','大号超大件',270,270,270,68,419,.5,82.20,1.16,0,'verified','marginGO CA1/CA2；续重 CAD0.58/500g');

  [['小型 250g',25,18,2,.25,45,288],['标准1 1kg',35,30,3.3,1,68.3,318],['标准2a',20,20,20,2,20,410],['标准2b',30,30,30,2,30,415],['标准2c',40,40,40,2,40,420],['标准2d',50,50,50,2,50,425],['标准2e',60,60,60,2,60,430],['标准3',80,80,80,5,80,472],['标准4',100,100,100,9,100,532],['大件1',60,60,60,2,60,589],['大件2',80,80,80,5,80,624],['大件3',100,100,100,10,100,675],['大件4',120,120,120,15,120,781],['大件5',140,140,140,20,140,1020],['大件6',160,160,160,25,160,1100],['大件7',180,180,180,30,180,1532],['大件8',200,200,200,40,200,1756],['超大件1',200,200,200,50,200,2755],['超大件2',220,220,220,50,220,3573],['超大件3',240,240,240,50,240,4496],['超大件4a',260,260,260,50,260,5625],['超大件4b',400,400,400,50,400,13950]].forEach(r=>add('JP',r[0],r[1],r[2],r[3],r[4],r[5],r[6],0,'marginGO JP 2026-04-01；按售价>1000日元费率'));

  const euRows = [
    ['轻小信封 20g',33,23,2.5,.02,1.8326236,2.330933],['轻小信封 40g',33,23,2.5,.04,1.869408,2.371043],['轻小信封 60g',33,23,2.5,.06,1.892972,2.389163],['轻小信封 80g',33,23,2.5,.08,2.068412,2.516006],['轻小信封 100g',33,23,2.5,.1,2.077807,2.542059],
    ['标准信封 210g',33,23,2.5,.21,2.097571,2.566423],['标准信封 460g',33,23,2.5,.46,2.156863,2.68107],['大信封 960g',33,23,4,.96,2.721823,3.03562],['超大信封 960g',33,23,6,.96,2.940903,3.42056],
    ['小包裹 150g',35,25,12,.15,2.91,3.38],['小包裹 400g',35,25,12,.4,3,3.39],['小包裹 900g',35,25,12,.9,3.04,3.4],['小包裹 1.4kg',35,25,12,1.4,3.05,3.41],['小包裹 1.9kg',35,25,12,1.9,3.25,3.43],['小包裹 3.9kg',35,25,12,3.9,3.27,4.54],
    ['标准包裹 150g',45,34,26,.15,2.94,3.39],['标准包裹 400g',45,34,26,.4,3.01,3.42],['标准包裹 900g',45,34,26,.9,3.06,3.44],['标准包裹 1.4kg',45,34,26,1.4,3.26,3.93],['标准包裹 1.9kg',45,34,26,1.9,3.48,3.95],['标准包裹 2.9kg',45,34,26,2.9,3.49,4.55],['标准包裹 3.9kg',45,34,26,3.9,3.54,5.09],['标准包裹 5.9kg',45,34,26,5.9,3.56,5.22],['标准包裹 8.9kg',45,34,26,8.9,3.57,6.03],['标准包裹 11.9kg',45,34,26,11.9,3.58,6.65]
  ];
  for (const r of euRows) { add('GB',r[0],r[1],r[2],r[3],r[4],null,r[5],0,'marginGO 欧盟-德国，英国.xlsx'); add('DE',r[0],r[1],r[2],r[3],r[4],null,r[6],0,'marginGO 欧盟-德国，英国.xlsx'); }
}

function migrateOperatingTaxV2() {
  const version = db.prepare("SELECT value FROM app_meta WHERE key = 'operating_tax_version'").get();
  if (version?.value === '2') return;
  const rules = {
    AU:[0,'none',0,'税费按 0 预估'], US:[0,'none',0,'税费按 0 预估'], CA:[0,'none',0,'税费按 0 预估'],
    SA:[15,'sale',0,'税费按售价的 15% 预估'], AE:[5,'sale',0,'税费按售价的 5% 预估'],
    JP:[6,'sale',0,'税费按售价的 6% 预估'],
    GB:[10,'cost',20,'税费按成本的 10% 预估，另计 VAT 20%'],
    DE:[10,'cost',19,'税费按成本的 10% 预估，另计 VAT 19%'],
    FR:[0,'none',0,'税费比例待确认'], IT:[0,'none',0,'税费比例待确认'], MX:[0,'none',0,'税费比例待确认']
  };
  const stmt = db.prepare('UPDATE countries SET tax_rate = ?, tax_basis = ?, vat_rate = ?, tax_note = ?, updated_at = ? WHERE code = ?');
  const now = new Date().toISOString();
  for (const [code, values] of Object.entries(rules)) stmt.run(...values,now,code);
  db.prepare("UPDATE countries SET tax_label = '进口/清关税费' WHERE code IN ('GB','DE')").run();
  db.prepare("INSERT INTO app_meta (key,value) VALUES ('operating_tax_version','2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
}

function seed() {
  const now = new Date().toISOString();
  const countries = [
    ['AU','澳洲','🇦🇺','AUD','$',4.70,0,0,'none','税费预估',1,'税费按 0 预估','运营预估口径；汇率为可编辑估算值'],
    ['US','美国','🇺🇸','USD','$',7.20,0,0,'none','税费预估',2,'税费按 0 预估','运营预估口径；汇率为可编辑估算值'],
    ['GB','英国','🇬🇧','GBP','£',9.60,20,10,'cost','进口/清关税费',3,'税费按成本的 10% 预估，另计 VAT 20%','运营预估口径；汇率为可编辑估算值'],
    ['DE','德国','🇩🇪','EUR','€',8.35,19,10,'cost','进口/清关税费',4,'税费按成本的 10% 预估，另计 VAT 19%','运营预估口径；汇率为可编辑估算值'],
    ['FR','法国','🇫🇷','EUR','€',8.35,0,0,'none','税费预估',5,'税费比例待确认','运营预估口径；汇率为可编辑估算值'],
    ['IT','意大利','🇮🇹','EUR','€',8.35,0,0,'none','税费预估',6,'税费比例待确认','运营预估口径；汇率为可编辑估算值'],
    ['JP','日本','🇯🇵','JPY','¥',0.049,0,0,'japan_import','日本进口税金',7,'申报价×关税率＋（申报价＋关税）×消费税率；申报比例默认15%，消费税默认10%','运营预估口径；汇率为可编辑估算值'],
    ['CA','加拿大','🇨🇦','CAD','$',5.25,0,0,'none','税费预估',8,'税费按 0 预估','运营预估口径；汇率为可编辑估算值'],
    ['AE','阿联酋','🇦🇪','AED','د.إ',1.96,0,5,'sale','税费预估',9,'税费按售价的 5% 预估','运营预估口径；汇率为可编辑估算值'],
    ['SA','沙特','🇸🇦','SAR','﷼',1.92,0,15,'sale','税费预估',10,'税费按售价的 15% 预估','运营预估口径；汇率为可编辑估算值'],
    ['MX','墨西哥','🇲🇽','MXN','$',0.40,0,0,'none','税费预估',11,'税费比例待确认','运营预估口径；汇率为可编辑估算值']
  ];
  const countryStmt = db.prepare(`INSERT INTO countries
    (code,name,flag,currency,symbol,cny_per_local,vat_rate,tax_rate,tax_basis,tax_label,priority,tax_note,source_note,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const item of countries) countryStmt.run(...item, now);

  const fbaDefaults = { AU:5.85, US:4.00, GB:3.10, DE:3.60, FR:3.60, IT:3.60, JP:434, CA:5.50, AE:12, SA:14, MX:80 };
  const fbaStmt = db.prepare(`INSERT INTO fba_rules
    (country_code,size_name,max_long_cm,max_mid_cm,max_short_cm,max_weight_kg,included_weight_kg,base_fee,per_kg_fee,surcharge_rate,status,source_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [code, fee] of Object.entries(fbaDefaults)) {
    const surcharge = ['US','CA'].includes(code) ? 3.5 : 0;
    fbaStmt.run(code,'标准件估算',45,34,26,2,0.5,fee,fee * 0.18,surcharge,'estimate','演示费阶；上线前请按卖家后台最新费卡替换');
    fbaStmt.run(code,'大件估算',120,60,60,15,2,fee * 2.4,fee * 0.35,surcharge,'estimate','演示费阶；上线前请按卖家后台最新费卡替换');
  }

  const freightStmt = db.prepare(`INSERT INTO freight_rules
    (country_code,channel_name,price_per_kg_cny,min_charge_cny,volume_divisor,status,source_note)
    VALUES (?,?,?,?,?,?,?)`);
  for (const code of Object.keys(fbaDefaults)) {
    freightStmt.run(code,'待填写货代渠道',0,0,6000,'missing','货代报价具有公司与时效差异，请录入实际价格表');
  }

  const categories = [
    ['家居与厨房 / Home & Kitchen','家居,厨房,home,kitchen',15],
    ['电子产品 / Electronics','电子,electronic,electronics,computer',8],
    ['美妆 / Beauty','美妆,beauty,personal care',15],
    ['服装 / Clothing','服装,clothing,apparel',15],
    ['运动户外 / Sports & Outdoors','运动,户外,sports,outdoors',15],
    ['宠物用品 / Pet Supplies','宠物,pet',15],
    ['玩具 / Toys & Games','玩具,toy,game',15],
    ['办公用品 / Office Products','办公,office',15],
    ['工具家装 / Tools & Home Improvement','工具,家装,tools,home improvement',15],
    ['食品杂货 / Grocery','食品,杂货,grocery,food',8]
  ];
  const commissionStmt = db.prepare(`INSERT INTO commission_rules
    (country_code,parent_category,keywords,rate,status,source_note) VALUES (?,?,?,?,?,?)`);
  for (const code of Object.keys(fbaDefaults)) {
    for (const item of categories) commissionStmt.run(code, ...item, 'estimate', '通用起始值；低价档和特殊品类需按站点费卡细化');
  }

}

initialize();
module.exports = db;
