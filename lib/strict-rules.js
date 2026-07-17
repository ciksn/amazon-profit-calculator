'use strict';

function migrateStrictRules(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare("SELECT value FROM app_meta WHERE key = 'strict_fba_version'").get();
    if (version?.value === '5') {
      db.exec('COMMIT');
      return;
    }

  db.exec(`
    CREATE TABLE IF NOT EXISTS size_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country_code TEXT NOT NULL REFERENCES countries(code),
      tier_code TEXT NOT NULL,
      tier_name TEXT NOT NULL,
      max_long_cm REAL NOT NULL,
      max_mid_cm REAL NOT NULL,
      max_short_cm REAL NOT NULL,
      min_item_weight_kg REAL NOT NULL DEFAULT 0,
      max_item_weight_kg REAL NOT NULL,
      max_volume_weight_kg REAL,
      max_total_cm REAL,
      dimension_mode TEXT NOT NULL DEFAULT 'none',
      class_weight_mode TEXT NOT NULL DEFAULT 'actual',
      fee_weight_mode TEXT NOT NULL DEFAULT 'max',
      status TEXT NOT NULL DEFAULT 'verified',
      source_note TEXT NOT NULL DEFAULT '',
      UNIQUE(country_code,tier_code)
    );
  `);
  const fbaColumns = new Set(db.prepare('PRAGMA table_info(fba_rules)').all().map((item) => item.name));
  if (!fbaColumns.has('size_tier')) db.exec("ALTER TABLE fba_rules ADD COLUMN size_tier TEXT NOT NULL DEFAULT ''");
  if (!fbaColumns.has('min_price')) db.exec('ALTER TABLE fba_rules ADD COLUMN min_price REAL');
  if (!fbaColumns.has('max_price')) db.exec('ALTER TABLE fba_rules ADD COLUMN max_price REAL');
  if (!fbaColumns.has('category_group')) db.exec("ALTER TABLE fba_rules ADD COLUMN category_group TEXT NOT NULL DEFAULT 'all'");
  if (!fbaColumns.has('weight_increment_kg')) db.exec('ALTER TABLE fba_rules ADD COLUMN weight_increment_kg REAL NOT NULL DEFAULT 0');
  const sizeColumns = new Set(db.prepare('PRAGMA table_info(size_tiers)').all().map((item) => item.name));
  if (!sizeColumns.has('min_item_weight_kg')) db.exec('ALTER TABLE size_tiers ADD COLUMN min_item_weight_kg REAL NOT NULL DEFAULT 0');
  if (!sizeColumns.has('max_volume_weight_kg')) db.exec('ALTER TABLE size_tiers ADD COLUMN max_volume_weight_kg REAL');

  seedSizeTiers(db);
  mapExistingSizeTiers(db);
  seedAustraliaFba(db);
  seedUnitedStatesFba(db);
  seedUnitedArabEmiratesFba(db);
  seedSaudiFba(db);
  seedCanadaFba(db);
  seedJapanFba(db);
  seedEuropeFba(db);
  seedSaudiCommission(db);
  db.prepare("UPDATE countries SET fba_volume_divisor = CASE WHEN code='AU' THEN 4000 WHEN code IN ('US','CA','GB','DE') THEN 5000 ELSE fba_volume_divisor END").run();
    db.prepare("INSERT INTO app_meta (key,value) VALUES ('strict_fba_version','5') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function seedSizeTiers(db) {
  db.prepare("DELETE FROM size_tiers WHERE country_code IN ('AU','US','SA','AE','CA','JP','GB','DE')").run();
  const stmt = db.prepare(`INSERT INTO size_tiers
    (country_code,tier_code,tier_name,max_long_cm,max_mid_cm,max_short_cm,min_item_weight_kg,max_item_weight_kg,max_volume_weight_kg,max_total_cm,dimension_mode,class_weight_mode,fee_weight_mode,status,source_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const add = (c,code,name,l,m,s,w,total=null,dimension='none',classWeight='actual',feeWeight='max',source='marginGO FBA资料',constraints={}) =>
    stmt.run(c,code,name,l,m,s,constraints.minItem || 0,w,constraints.maxVolume ?? null,total,dimension,classWeight,feeWeight,'verified',source);

  add('AU','small_envelope','小号信封',20,15,1,.075,null,'none','actual','actual','AU.png');
  add('AU','standard_envelope','标准信封',33,23,2.5,.475,null,'none','actual','actual','AU.png');
  add('AU','large_envelope','大号信封',33,23,5,.975,null,'none','actual','actual','AU.png');
  add('AU','parcel','包裹',45,34,20,12,null,'none','actual','max','AU.png');
  add('AU','small_bulky','小号大件',61,46,46,2,null,'none','actual','max','AU.png');
  add('AU','standard_bulky','标准大件',105,60,60,22,null,'none','actual','max','AU.png');
  add('AU','large_bulky','大号大件',193,122,102,35,null,'none','actual','max','AU.png');
  add('AU','extra_large','超大件',250,250,250,250,null,'none','actual','max','AU.png');

  const inch=2.54, lb=.45359237;
  add('US','small_standard','小号标准尺寸',15*inch,12*inch,.75*inch,1*lb,null,'none','actual','actual','美国2.png');
  add('US','large_standard','大号标准尺寸',18*inch,14*inch,8*inch,20*lb,null,'none','actual','max','美国2.png');
  add('US','small_bulky','小号大件',37*inch,28*inch,20*inch,50*lb,130*inch,'length_girth','max','max','美国2.png');
  add('US','large_bulky','大号大件',59*inch,33*inch,33*inch,50*lb,130*inch,'length_girth','max','max','美国2.png');
  add('US','extra_large_0_50','超大件（0–50磅）',244,244,244,50*lb,330.2,'oversize','max','max','美国2.png');
  add('US','extra_large_50_70','超大件（50–70磅）',244,244,244,70*lb,330.2,'oversize','max','max','美国2.png');
  add('US','extra_large_70_150','超大件（70–150磅）',244,244,244,150*lb,330.2,'oversize','max','max','美国2.png');
  add('US','extra_large_150_plus','超大件（150磅以上）',400,400,400,500,null,'none','max','actual','美国2.png');

  for (const code of ['SA','AE']) {
    const src=code==='SA'?'沙特.png':'ae.png';
    add(code,'small_envelope','小号信封',20,15,1,.1,null,'none','actual','actual',src);
    add(code,'standard_envelope','标准信封',33,23,2.5,.5,null,'none','actual','actual',src);
    add(code,'large_envelope','大号信封',33,23,5,1,null,'none','actual','actual',src);
    add(code,'standard_parcel','标准包裹',45,34,26,12,null,'none','actual','actual',src);
    add(code,'bulky','大件',300,300,300,30,null,'none','actual','actual',src);
  }

  add('CA','envelope','信封',38,27,2,.5,null,'none','actual','max','CA1/CA2.png');
  add('CA','standard','标准件',45,35,20,9,null,'none','actual','max','CA1/CA2.png');
  add('CA','small_oversize','小号超大件',152,76,76,32,330,'length_girth','actual','max','CA1/CA2.png');
  add('CA','medium_oversize','中号超大件',270,270,270,68,330,'length_girth','actual','max','CA1/CA2.png');
  add('CA','large_oversize','大号超大件',270,270,270,68,419,'length_girth','actual','max','CA1/CA2.png');
  add('CA','special_oversize','特殊大件',500,500,500,500,null,'none','actual','max','CA1/CA2.png');

  const jp=[['small','小型',25,18,2,.25,45],['standard1','标准1',35,30,3.3,1,68.3],['standard2a','标准2a',20,20,20,2,20],['standard2b','标准2b',30,30,30,2,30],['standard2c','标准2c',40,40,40,2,40],['standard2d','标准2d',50,50,50,2,50],['standard2e','标准2e',60,60,60,2,60],['standard3','标准3',80,80,80,5,80],['standard4','标准4',100,100,100,9,100],['bulky1','大件1',60,60,60,2,60],['bulky2','大件2',80,80,80,5,80],['bulky3','大件3',100,100,100,10,100],['bulky4','大件4',120,120,120,15,120],['bulky5','大件5',140,140,140,20,140],['bulky6','大件6',160,160,160,25,160],['bulky7','大件7',180,180,180,30,180],['bulky8','大件8',200,200,200,40,200],['xl1','超大件1',200,200,200,50,200],['xl2','超大件2',220,220,220,50,220],['xl3','超大件3',240,240,240,50,240],['xl4a','超大件4a',260,260,260,50,260],['xl4b','超大件4b',400,400,400,50,400]];
  for (const r of jp) add('JP',r[0],r[1],r[2],r[3],r[4],r[5],r[6],'sum','actual','actual','JP.png');

  for (const code of ['GB','DE']) {
    add(code,'light_envelope','轻小信封',33,23,2.5,.1,null,'none','actual','actual','欧盟-德国，英国.xlsx');
    add(code,'standard_envelope','标准信封',33,23,2.5,.46,null,'none','actual','actual','欧盟-德国，英国.xlsx');
    add(code,'large_envelope','大信封',33,23,4,.96,null,'none','actual','actual','欧盟-德国，英国.xlsx');
    add(code,'xl_envelope','超大信封',33,23,6,.96,null,'none','actual','actual','欧盟-德国，英国.xlsx');
    add(code,'small_parcel','小包裹',35,25,12,3.9,null,'none','max','eu_category','欧盟-德国，英国.xlsx');
    add(code,'standard_parcel','标准包裹',45,34,26,11.9,null,'none','max','eu_category','欧盟-德国，英国.xlsx');
    add(code,'small_oversize','小号大件',61,46,46,1.76,null,'none','actual','eu_category','欧盟-德国，英国.xlsx',{maxVolume:25.82});
    add(code,'standard_oversize_light','标准大件轻型',101,60,60,15,null,'none','actual','eu_category','欧盟-德国，英国.xlsx',{maxVolume:72.72});
    add(code,'standard_oversize_heavy','标准大件重型',101,60,60,23,null,'none','actual','eu_category','欧盟-德国，英国.xlsx',{minItem:15,maxVolume:72.72});
    add(code,'standard_oversize_large','标准大件大型',120,60,60,23,null,'none','actual','eu_category','欧盟-德国，英国.xlsx',{maxVolume:86.4});
    add(code,'bulky_oversize','大宗大件',175,175,175,23,360,'length_girth','actual','eu_category','欧盟-德国，英国.xlsx',{maxVolume:126});
    add(code,'heavy_oversize','重型大件',175,175,175,31.5,360,'length_girth','actual','eu_category','欧盟-德国，英国.xlsx',{minItem:23,maxVolume:126});
    add(code,'special_oversize','特殊大件',500,500,500,500,null,'none','actual','actual','欧盟-德国，英国.xlsx');
  }
}

function mapExistingSizeTiers(db) {
  const mappings={
    AE:[['小信封','small_envelope'],['标准信封','standard_envelope'],['大信封','large_envelope'],['标准箱','standard_parcel'],['大件','bulky']],
    CA:[['信封','envelope'],['标准件','standard'],['小号超大件','small_oversize'],['中号超大件','medium_oversize'],['大号超大件','large_oversize']],
    GB:[['轻小信封','light_envelope'],['标准信封','standard_envelope'],['大信封','large_envelope'],['超大信封','xl_envelope'],['小包裹','small_parcel'],['标准包裹','standard_parcel']],
    DE:[['轻小信封','light_envelope'],['标准信封','standard_envelope'],['大信封','large_envelope'],['超大信封','xl_envelope'],['小包裹','small_parcel'],['标准包裹','standard_parcel']]
  };
  const stmt=db.prepare('UPDATE fba_rules SET size_tier=? WHERE country_code=? AND size_name LIKE ?');
  for(const [code,rows] of Object.entries(mappings)) for(const [prefix,tier] of rows) stmt.run(tier,code,`${prefix}%`);
  const jp=db.prepare("SELECT id,size_name FROM fba_rules WHERE country_code='JP'").all();
  const jpMap={'小型':'small','标准1':'standard1','标准2a':'standard2a','标准2b':'standard2b','标准2c':'standard2c','标准2d':'standard2d','标准2e':'standard2e','标准3':'standard3','标准4':'standard4','大件1':'bulky1','大件2':'bulky2','大件3':'bulky3','大件4':'bulky4','大件5':'bulky5','大件6':'bulky6','大件7':'bulky7','大件8':'bulky8','超大件1':'xl1','超大件2':'xl2','超大件3':'xl3','超大件4a':'xl4a','超大件4b':'xl4b'};
  const update=db.prepare('UPDATE fba_rules SET size_tier=? WHERE id=?');
  for(const row of jp){ const key=Object.keys(jpMap).find(k=>row.size_name.startsWith(k)); if(key) update.run(jpMap[key],row.id); }
}

function fbaInserter(db) {
  const stmt=db.prepare(`INSERT INTO fba_rules
    (country_code,size_name,size_tier,max_long_cm,max_mid_cm,max_short_cm,max_weight_kg,max_total_cm,included_weight_kg,base_fee,per_kg_fee,weight_increment_kg,surcharge_rate,min_price,max_price,category_group,status,source_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return (country,tier,label,maxWeight,fee,{included=0,perKg=0,increment=0,surcharge=0,min=null,max=null,group='all',note='marginGO FBA资料'}={}) =>
    stmt.run(country,label,tier,999,999,999,maxWeight,null,included,fee,perKg,increment,surcharge,min,max,group,'verified',note);
}

function seedAustraliaFba(db) {
  db.prepare("DELETE FROM fba_rules WHERE country_code='AU'").run();
  const add=fbaInserter(db), note='AU.png；2025-10-31后费率';
  const bands=[{min:null,max:12.999999,group:'all',idx:1},{min:null,max:12.999999,group:'au_low_special',idx:0},{min:13,max:19.999999,group:'all',idx:3},{min:13,max:19.999999,group:'au_mid_special',idx:2},{min:20,max:null,group:'all',idx:3}];
  const rows=[
    ['small_envelope','小号信封 ≤75g',.075,[3.20,3.64,4.55,4.55]],
    ['standard_envelope','标准信封 ≤75g',.075,[3.30,3.67,4.58,4.58]],['standard_envelope','标准信封 ≤225g',.225,[3.44,4.35,4.60,5.26]],['standard_envelope','标准信封 ≤475g',.475,[3.72,4.70,5.06,5.61]],
    ['large_envelope','大号信封 ≤225g',.225,[3.72,5.87,5.06,6.78]],['large_envelope','大号信封 ≤475g',.475,[3.98,6.11,5.06,7.02]],['large_envelope','大号信封 ≤975g',.975,[3.98,6.33,5.06,7.24]],
    ['parcel','包裹 ≤250g',.25,[3.98,6.14,5.48,7.05]],['parcel','包裹 ≤500g',.5,[4.18,6.14,5.48,7.05]],['parcel','包裹 ≤1kg',1,[4.36,6.33,5.48,7.24]],['parcel','包裹 ≤1.5kg',1.5,[6.19,7.97,6.19,8.88]],['parcel','包裹 ≤2kg',2,[6.64,8.90,6.64,9.81]],['parcel','包裹 ≤3kg',3,[8.95,8.95,9.86,9.86]],['parcel','包裹 ≤4kg',4,[9.27,9.27,10.18,10.18]],['parcel','包裹 ≤5kg',5,[9.28,9.28,10.19,10.19]],['parcel','包裹 ≤6kg',6,[10.19,10.19,11.10,11.10]],['parcel','包裹 ≤7kg',7,[10.35,10.35,11.26,11.26]],['parcel','包裹 ≤8kg',8,[10.35,10.35,11.26,11.26]],['parcel','包裹 ≤9kg',9,[10.36,10.36,11.27,11.27]],['parcel','包裹 ≤10kg',10,[10.36,10.36,11.27,11.27]],['parcel','包裹 ≤11kg',11,[12.89,12.89,13.80,13.80]],['parcel','包裹 ≤12kg',12,[13.02,13.02,13.93,13.93]],
    ['small_bulky','小号大件 ≤1kg',1,[5.33,9.03,7.48,9.94]],['small_bulky','小号大件 ≤1.25kg',1.25,[6.27,9.50,8.41,10.41]],['small_bulky','小号大件 ≤1.5kg',1.5,[9.74,9.74,10.65,10.65]],['small_bulky','小号大件 ≤1.75kg',1.75,[9.75,9.75,10.66,10.66]],['small_bulky','小号大件 ≤2kg',2,[9.75,9.75,10.66,10.66]],
    ['standard_bulky','标准大件 ≤1kg',1,[11.39,11.39,12.30,12.30]],['standard_bulky','标准大件 ≤2kg',2,[12.04,12.04,12.95,12.95]],['standard_bulky','标准大件 ≤3kg',3,[12.13,12.13,13.04,13.04]],['standard_bulky','标准大件 ≤4kg',4,[12.27,12.27,13.18,13.18]],['standard_bulky','标准大件 ≤5kg',5,[12.50,12.50,13.41,13.41]],['standard_bulky','标准大件 ≤6kg',6,[13.40,13.40,14.31,14.31]],['standard_bulky','标准大件 ≤7kg',7,[13.55,13.55,14.46,14.46]],['standard_bulky','标准大件 ≤8kg',8,[13.57,13.57,14.48,14.48]],['standard_bulky','标准大件 ≤9kg',9,[13.61,13.61,14.52,14.52]],['standard_bulky','标准大件 ≤10kg',10,[13.61,13.61,14.52,14.52]],['standard_bulky','标准大件 ≤15kg',15,[14.95,14.95,15.86,15.86]],['standard_bulky','标准大件 ≤20kg',20,[15.51,15.51,16.42,16.42]],['standard_bulky','标准大件 ≤22kg',22,[15.51,15.51,16.42,16.42]],
    ['large_bulky','大号大件 ≤5kg',5,[16.89,16.89,17.80,17.80]],['large_bulky','大号大件 ≤10kg',10,[18.44,18.44,19.35,19.35]],['large_bulky','大号大件 ≤15kg',15,[20.24,20.24,21.15,21.15]],['large_bulky','大号大件 ≤20kg',20,[20.57,20.57,21.48,21.48]],['large_bulky','大号大件 ≤25kg',25,[21.61,21.61,22.52,22.52]],['large_bulky','大号大件 ≤30kg',30,[25.97,25.97,26.88,26.88]],['large_bulky','大号大件 ≤35kg',35,[26.00,26.00,26.91,26.91]],
    ['extra_large','超大件 ≤35kg',35,[89.09,89.09,90.00,90.00]]
  ];
  for(const row of rows) for(const band of bands) add('AU',row[0],row[1],row[2],row[3][band.idx],{min:band.min,max:band.max,group:band.group,note});
  const progressive=[['small_bulky','小号大件 >2kg',20,[10.52,10.52,11.43,11.43],2,.1],['standard_bulky','标准大件 >22kg',35,[18.48,18.48,19.39,19.39],22,.1],['large_bulky','大号大件 >35kg',250,[37.68,37.68,38.59,38.59],35,.1],['extra_large','超大件 >35kg',250,[89.09,89.09,90,90],35,.1]];
  for(const row of progressive) for(const band of bands) add('AU',row[0],row[1],row[2],row[3][band.idx],{included:row[4],perKg:row[5],min:band.min,max:band.max,group:band.group,note});
}

function seedUnitedStatesFba(db) {
  db.prepare("DELETE FROM fba_rules WHERE country_code='US'").run();
  const add=fbaInserter(db), oz=.028349523125, lb=.45359237, note='美国1/美国2.png；2026-01-15至2026-10-14费率（未含燃油/节假日附加费）';
  const bands=[{min:null,max:9.999999,idx:0},{min:10,max:50,idx:1},{min:50.000001,max:null,idx:2}];
  const seed=(group,rows)=>{ for(const r of rows) for(const b of bands) add('US',r[0],r[1],r[2],r[3][b.idx],{surcharge:3.5,min:b.min,max:b.max,group,note}); };
  const non=[
    ['small_standard','小号标准 ≤2oz',2*oz,[2.43,3.32,3.58]],['small_standard','小号标准 ≤4oz',4*oz,[2.49,3.42,3.68]],['small_standard','小号标准 ≤6oz',6*oz,[2.56,3.45,3.71]],['small_standard','小号标准 ≤8oz',8*oz,[2.66,3.54,3.80]],['small_standard','小号标准 ≤10oz',10*oz,[2.77,3.68,3.94]],['small_standard','小号标准 ≤12oz',12*oz,[2.82,3.78,4.04]],['small_standard','小号标准 ≤14oz',14*oz,[2.92,3.91,4.17]],['small_standard','小号标准 ≤16oz',16*oz,[2.95,3.96,4.22]],
    ['large_standard','大号标准 ≤4oz',4*oz,[2.91,3.73,3.99]],['large_standard','大号标准 ≤8oz',8*oz,[3.13,3.95,4.21]],['large_standard','大号标准 ≤12oz',12*oz,[3.38,4.20,4.46]],['large_standard','大号标准 ≤16oz',16*oz,[3.78,4.60,4.86]],['large_standard','大号标准 ≤1.25lb',1.25*lb,[4.22,5.04,5.30]],['large_standard','大号标准 ≤1.5lb',1.5*lb,[4.60,5.42,5.68]],['large_standard','大号标准 ≤1.75lb',1.75*lb,[4.75,5.57,5.83]],['large_standard','大号标准 ≤2lb',2*lb,[5.00,5.82,6.08]],['large_standard','大号标准 ≤2.25lb',2.25*lb,[5.10,5.92,6.18]],['large_standard','大号标准 ≤2.5lb',2.5*lb,[5.28,6.10,6.36]],['large_standard','大号标准 ≤2.75lb',2.75*lb,[5.44,6.26,6.52]],['large_standard','大号标准 ≤3lb',3*lb,[5.85,6.67,6.93]]
  ];
  const apparel=[
    ['small_standard','小号标准 ≤2oz',2*oz,[2.62,3.51,3.77]],['small_standard','小号标准 ≤4oz',4*oz,[2.64,3.54,3.80]],['small_standard','小号标准 ≤6oz',6*oz,[2.68,3.59,3.85]],['small_standard','小号标准 ≤8oz',8*oz,[2.81,3.69,3.95]],['small_standard','小号标准 ≤10oz',10*oz,[3.00,3.91,4.17]],['small_standard','小号标准 ≤12oz',12*oz,[3.10,4.09,4.35]],['small_standard','小号标准 ≤14oz',14*oz,[3.20,4.20,4.46]],['small_standard','小号标准 ≤16oz',16*oz,[3.30,4.25,4.51]],
    ['large_standard','大号标准 ≤4oz',4*oz,[3.48,4.30,4.56]],['large_standard','大号标准 ≤8oz',8*oz,[3.68,4.50,4.76]],['large_standard','大号标准 ≤12oz',12*oz,[3.90,4.72,4.98]],['large_standard','大号标准 ≤16oz',16*oz,[4.35,5.17,5.43]],['large_standard','大号标准 ≤1.25lb',1.25*lb,[5.05,5.87,6.13]],['large_standard','大号标准 ≤1.5lb',1.5*lb,[5.22,6.04,6.30]],['large_standard','大号标准 ≤1.75lb',1.75*lb,[5.32,6.14,6.40]],['large_standard','大号标准 ≤2lb',2*lb,[5.43,6.25,6.51]],['large_standard','大号标准 ≤2.25lb',2.25*lb,[5.78,6.60,6.86]],['large_standard','大号标准 ≤2.5lb',2.5*lb,[5.90,6.72,6.98]],['large_standard','大号标准 ≤2.75lb',2.75*lb,[5.95,6.77,7.03]],['large_standard','大号标准 ≤3lb',3*lb,[6.08,6.90,7.16]]
  ];
  seed('non_apparel',non); seed('apparel',apparel);
  for(const b of bands){
    add('US','large_standard','大号标准 3–20lb',20*lb,[6.15,6.97,7.23][b.idx],{included:3*lb,perKg:.08/(4*oz),increment:4*oz,surcharge:3.5,min:b.min,max:b.max,group:'non_apparel',note});
    add('US','large_standard','大号标准服装 3–20lb',20*lb,[6.15,6.97,7.23][b.idx],{included:3*lb,perKg:.16/(4*oz),increment:4*oz,surcharge:3.5,min:b.min,max:b.max,group:'apparel',note});
  }
  const bulky=[['small_bulky','小号大件',50*lb,[6.78,7.55,7.55],1*lb,.38/lb],['large_bulky','大号大件',50*lb,[8.58,9.35,9.35],1*lb,.38/lb],['extra_large_0_50','超大件 0–50lb',50*lb,[25.56,26.33,26.33],1*lb,.38/lb],['extra_large_50_70','超大件 50–70lb',70*lb,[36.55,37.32,37.32],51*lb,.75/lb],['extra_large_70_150','超大件 70–150lb',150*lb,[50.55,51.32,51.32],71*lb,.75/lb],['extra_large_150_plus','超大件 150lb以上',500*lb,[194.18,194.95,194.95],151*lb,.19/lb]];
  for(const r of bulky) for(const b of bands) add('US',r[0],r[1],r[2],r[3][b.idx],{included:r[4],perKg:r[5],increment:lb,surcharge:3.5,min:b.min,max:b.max,group:'all',note});
}

function seedUnitedArabEmiratesFba(db) {
  db.prepare("DELETE FROM fba_rules WHERE country_code='AE'").run();
  const add=fbaInserter(db), note='ae.png；2025-08-01生效';
  const bands=[{min:null,max:25,idx:0},{min:25.000001,max:null,idx:1}];
  const rows=[
    ['small_envelope','小号信封 ≤0.1kg',.1,[5.5,7.5]],
    ['standard_envelope','标准信封 ≤0.1kg',.1,[6,8]],['standard_envelope','标准信封 ≤0.2kg',.2,[6.2,8.2]],['standard_envelope','标准信封 ≤0.5kg',.5,[6.5,8.5]],
    ['large_envelope','大号信封 ≤1kg',1,[7,7.5]],
    ['standard_parcel','标准箱 ≤0.25kg',.25,[7.2,9.2]],['standard_parcel','标准箱 ≤0.5kg',.5,[7.5,9.5]],['standard_parcel','标准箱 ≤1kg',1,[8.5,10.5]],['standard_parcel','标准箱 ≤1.5kg',1.5,[9,11]],['standard_parcel','标准箱 ≤2kg',2,[9.5,11.5]],['standard_parcel','标准箱 ≤3kg',3,[10.5,12.5]],['standard_parcel','标准箱 ≤4kg',4,[11.5,13.5]],['standard_parcel','标准箱 ≤5kg',5,[12.5,14.5]],['standard_parcel','标准箱 ≤6kg',6,[13.5,15.5]],['standard_parcel','标准箱 ≤7kg',7,[14.5,16.5]],['standard_parcel','标准箱 ≤8kg',8,[15.5,17.5]],['standard_parcel','标准箱 ≤9kg',9,[16.5,18.5]],['standard_parcel','标准箱 ≤10kg',10,[17.5,19.5]],['standard_parcel','标准箱 ≤11kg',11,[18.5,20.5]],['standard_parcel','标准箱 ≤12kg',12,[19.5,21.5]],
    ['bulky','大件 ≤1kg',1,[10.5,12.5]],['bulky','大件 ≤2kg',2,[11.5,13.5]],['bulky','大件 ≤3kg',3,[12.5,14.5]],['bulky','大件 ≤4kg',4,[13.5,15.5]],['bulky','大件 ≤5kg',5,[14.5,16.5]],['bulky','大件 ≤6kg',6,[15.5,17.5]],['bulky','大件 ≤7kg',7,[16.5,18.5]],['bulky','大件 ≤8kg',8,[17.5,19.5]],['bulky','大件 ≤9kg',9,[18.5,20.5]],['bulky','大件 ≤10kg',10,[19.5,21.5]],['bulky','大件 ≤15kg',15,[24.5,26.5]],['bulky','大件 ≤20kg',20,[29.5,31.5]],['bulky','大件 ≤25kg',25,[34.5,36.5]],['bulky','大件 ≤30kg',30,[39.5,41.5]]
  ];
  for(const row of rows) for(const band of bands) add('AE',row[0],row[1],row[2],row[3][band.idx],{min:band.min,max:band.max,note});
  for(const band of bands) add('AE','bulky','大件 >30kg',100,band.idx===0?39.5:41.5,{included:30,perKg:1,min:band.min,max:band.max,note});
}

function seedSaudiFba(db) {
  db.prepare("DELETE FROM fba_rules WHERE country_code='SA'").run();
  const add=fbaInserter(db), note='沙特.png；2025-08-01生效';
  const bands=[{min:null,max:24.999999,idx:0},{min:25,max:null,idx:1}];
  const rows=[['small_envelope','小号信封 ≤0.1kg',.1,[5.5,7.5]],['standard_envelope','标准信封 ≤0.1kg',.1,[6,8]],['standard_envelope','标准信封 ≤0.2kg',.2,[6.2,8.2]],['standard_envelope','标准信封 ≤0.5kg',.5,[6.5,8.5]],['large_envelope','大号信封 ≤1kg',1,[7,9]],['standard_parcel','标准包裹 ≤0.25kg',.25,[7.2,9.2]],['standard_parcel','标准包裹 ≤0.5kg',.5,[7.5,9.5]],['standard_parcel','标准包裹 ≤1kg',1,[8,10]],['standard_parcel','标准包裹 ≤1.5kg',1.5,[8.5,11.5]],['standard_parcel','标准包裹 ≤2kg',2,[9,12]],['standard_parcel','标准包裹 ≤3kg',3,[10,13]],['standard_parcel','标准包裹 ≤4kg',4,[11,14]],['standard_parcel','标准包裹 ≤5kg',5,[12,15]],['standard_parcel','标准包裹 ≤6kg',6,[13,16]],['standard_parcel','标准包裹 ≤7kg',7,[14,17]],['standard_parcel','标准包裹 ≤8kg',8,[15,18]],['standard_parcel','标准包裹 ≤9kg',9,[16,19]],['standard_parcel','标准包裹 ≤10kg',10,[17,20]],['standard_parcel','标准包裹 ≤11kg',11,[18,21]],['standard_parcel','标准包裹 ≤12kg',12,[19,22]],['bulky','大件 ≤1kg',1,[10,14]],['bulky','大件 ≤2kg',2,[11,15]],['bulky','大件 ≤3kg',3,[12,16]],['bulky','大件 ≤4kg',4,[13,17]],['bulky','大件 ≤5kg',5,[14,18]],['bulky','大件 ≤6kg',6,[15,19]],['bulky','大件 ≤7kg',7,[16,20]],['bulky','大件 ≤8kg',8,[17,21]],['bulky','大件 ≤9kg',9,[18,22]],['bulky','大件 ≤10kg',10,[19,23]],['bulky','大件 ≤15kg',15,[24,28]],['bulky','大件 ≤20kg',20,[29,33]],['bulky','大件 ≤25kg',25,[34,38]],['bulky','大件 ≤30kg',30,[39,43]]];
  for(const r of rows) for(const b of bands) add('SA',r[0],r[1],r[2],r[3][b.idx],{min:b.min,max:b.max,note});
  for(const b of bands) add('SA','bulky','大件 >30kg',100, b.idx===0?39:43,{included:30,perKg:1,min:b.min,max:b.max,note});
}

function seedCanadaFba(db) {
  db.prepare("DELETE FROM fba_rules WHERE country_code='CA'").run();
  const add=fbaInserter(db), note='CA1/CA2.png；2026-01-15非旺季费率；2026-04-17起含3.5%燃油和物流附加费';
  const bands=[{min:null,max:13.999999,discount:.8},{min:14,max:null,discount:0}];
  const envelope=[[.1,4.46],[.2,4.71],[.3,5.01],[.4,5.28],[.5,5.62]];
  const standard=[[.1,5.92],[.2,6.12],[.3,6.36],[.4,6.73],[.5,7.23],[.6,7.40],[.7,7.71],[.8,7.95],[.9,8.25],[1,8.49],[1.1,8.58],[1.2,8.84],[1.3,9.04],[1.4,9.29],[1.5,9.60]];
  for(const band of bands) {
    for(const [weight,fee] of envelope) add('CA','envelope',`信封 ≤${weight}kg`,weight,fee-band.discount,{surcharge:3.5,min:band.min,max:band.max,note});
    for(const [weight,fee] of standard) add('CA','standard',`标准件 ≤${weight}kg`,weight,fee-band.discount,{surcharge:3.5,min:band.min,max:band.max,note});
    add('CA','standard','标准件 1.5–9kg',9,10.32-band.discount,{included:1.5,perKg:.9,increment:.1,surcharge:3.5,min:band.min,max:band.max,note});
    add('CA','small_oversize','小号超大件',32,15.43-band.discount,{included:.5,perKg:.92,increment:.5,surcharge:3.5,min:band.min,max:band.max,note});
    add('CA','medium_oversize','中号超大件',68,37.78-band.discount,{included:.5,perKg:1.04,increment:.5,surcharge:3.5,min:band.min,max:band.max,note});
    add('CA','large_oversize','大号超大件',68,82.20-band.discount,{included:.5,perKg:1.16,increment:.5,surcharge:3.5,min:band.min,max:band.max,note});
    add('CA','special_oversize','特殊大件',500,150.78-band.discount,{included:.5,perKg:1.16,increment:.5,surcharge:3.5,min:band.min,max:band.max,note});
  }
}

function seedJapanFba(db) {
  db.prepare("DELETE FROM fba_rules WHERE country_code='JP'").run();
  const add=fbaInserter(db), note='JP.png；2026-04-01费率';
  const rows=[
    ['small','小型 ≤250g',.25,288,222],['standard1','标准1 ≤1kg',1,318,252],
    ['standard2a','标准2a',2,410,344],['standard2b','标准2b',2,415,368],['standard2c','标准2c',2,420,371],['standard2d','标准2d',2,425,379],['standard2e','标准2e',2,430,391],
    ['standard3','标准3',5,472,427],['standard4','标准4',9,532,466],
    ['bulky1','大件1',2,589,523],['bulky2','大件2',5,624,558],['bulky3','大件3',10,675,609],['bulky4','大件4',15,781,715],['bulky5','大件5',20,1020,954],['bulky6','大件6',25,1100,1034],['bulky7','大件7',30,1532,1466],['bulky8','大件8',40,1756,1690],
    ['xl1','超大件1',50,2755,2689],['xl2','超大件2',50,3573,3507],['xl3','超大件3',50,4496,4430],['xl4a','超大件4a',50,5625,5559],['xl4b','超大件4b',50,13950,13884]
  ];
  for(const [tier,label,weight,regular,low] of rows) {
    add('JP',tier,label,weight,low,{max:999.999999,note});
    add('JP',tier,label,weight,regular,{min:1000,note});
  }
}

function seedEuropeFba(db) {
  db.prepare("DELETE FROM fba_rules WHERE country_code IN ('GB','DE')").run();
  const add=fbaInserter(db), note='欧盟-德国，英国.xlsx；2026费率';
  const rows=[
    ['light_envelope','轻小信封 ≤20g',.02,1.8326236271977339,2.3309329757408817],['light_envelope','轻小信封 ≤40g',.04,1.869408465749766,2.371042655746023],['light_envelope','轻小信封 ≤60g',.06,1.8929724380071162,2.3891631935635846],['light_envelope','轻小信封 ≤80g',.08,2.0684122426386233,2.516006958286522],['light_envelope','轻小信封 ≤100g',.1,2.07780671073204,2.5420591394633014],
    ['standard_envelope','标准信封 ≤210g',.21,2.097571285720336,2.5664230863973536],['standard_envelope','标准信封 ≤460g',.46,2.1568627450980395,2.68107],
    ['large_envelope','大信封 ≤960g',.96,2.7218231458692155,3.03562],['xl_envelope','超大信封 ≤960g',.96,2.940902812015795,3.42056],
    ['small_parcel','小包裹 ≤150g',.15,2.91,3.38],['small_parcel','小包裹 ≤400g',.4,3,3.39],['small_parcel','小包裹 ≤900g',.9,3.04,3.4],['small_parcel','小包裹 ≤1.4kg',1.4,3.05,3.41],['small_parcel','小包裹 ≤1.9kg',1.9,3.25,3.43],['small_parcel','小包裹 ≤3.9kg',3.9,3.27,4.54],
    ['standard_parcel','标准包裹 ≤150g',.15,2.94,3.39],['standard_parcel','标准包裹 ≤400g',.4,3.01,3.42],['standard_parcel','标准包裹 ≤900g',.9,3.06,3.44],['standard_parcel','标准包裹 ≤1.4kg',1.4,3.26,3.93],['standard_parcel','标准包裹 ≤1.9kg',1.9,3.48,3.95],['standard_parcel','标准包裹 ≤2.9kg',2.9,3.49,4.55],['standard_parcel','标准包裹 ≤3.9kg',3.9,3.54,5.09],['standard_parcel','标准包裹 ≤5.9kg',5.9,3.56,5.22],['standard_parcel','标准包裹 ≤8.9kg',8.9,3.57,6.03],['standard_parcel','标准包裹 ≤11.9kg',11.9,3.58,6.65]
  ];
  for(const row of rows) { add('GB',row[0],row[1],row[2],row[3],{note}); add('DE',row[0],row[1],row[2],row[4],{note}); }
  const progressive=[
    ['small_oversize','小号大件',25.82,.76,3.4899923360713867,.22,4.559770860073252,.18],
    ['standard_oversize_light','标准大件轻型',72.72,.76,4.347515968391351,.15,4.590887916457136,.18],
    ['standard_oversize_heavy','标准大件重型',72.72,15.76,6.577515968391356,.08,7.250887916457132,.07],
    ['standard_oversize_large','标准大件大型',86.4,.76,5.669861679195396,.07,6.063181614134084,.08],
    ['bulky_oversize','大宗大件',126,.76,10.198002549438236,.24,8.236868646328174,.27],
    ['heavy_oversize','重型大件',126,31.5,13.038731315733665,.09,13.00148588410104,.15]
  ];
  for(const row of progressive) {
    add('GB',row[0],row[1],row[2],row[4],{included:row[3],perKg:row[5],note});
    add('DE',row[0],row[1],row[2],row[6],{included:row[3],perKg:row[7],note});
  }
  const special=[[29.999999,16.22307951599776,21.299383665468294],[39.999999,17.24359366286239,24.190561646069654],[49.999999,34.3831897763779,47.975130649077656],[59.999999,42.03650942951622,51.99355783169644]];
  for(const [weight,gb,de] of special) { add('GB','special_oversize',`特殊大件 <${Math.ceil(weight)}kg`,weight,gb,{note}); add('DE','special_oversize',`特殊大件 <${Math.ceil(weight)}kg`,weight,de,{note}); }
  add('GB','special_oversize','特殊大件 ≥60kg',500,42.03650942951622,{included:60,perKg:.35,note});
  add('DE','special_oversize','特殊大件 ≥60kg',500,51.99355783169644,{included:60,perKg:.36,note});
}

function seedSaudiCommission(db) {
  db.prepare("DELETE FROM commission_rules WHERE country_code='SA'").run();
  const stmt=db.prepare(`INSERT INTO commission_rules
    (country_code,parent_category,keywords,rate,min_price,max_price,threshold_price,rate_above,minimum_fee,status,source_note)
    VALUES ('SA',?,?,?,?,?,?,?,?,?,?)`);
  const add=(name,keywords,rate,min=null,max=null,{threshold=null,above=null,minimum=1}={})=>
    stmt.run(name,keywords,rate,min,max,threshold,above,minimum,'verified','沙特.png；2025-08-01生效');
  const fixed=[['Apparel','apparel,clothing,服装',15],['Automotive','automotive,汽车',12],['Books','books,图书',15],['Camera','camera,相机',8],['Consumer Electronics','consumer electronics,消费电子',5.5],['Gift Cards','gift card,礼品卡',10],['Headphones & Portable Audio','headphones,portable audio,耳机,音频',10],['Home','home,家居',14],['Home Entertainment','home entertainment,家庭娱乐',6.5],['Kitchen','kitchen,厨房',14],['Luggage','luggage,箱包',15],['Major Appliances','major appliances,大型家电',6],['Mobiles & Tablets','mobile,tablet,手机,平板',5.5],['Office Products','office,办公',15],['Outdoor','outdoor,户外',14],['Personal Computers','computer,电脑',6],['Perfumes','perfume,香水',15],['Pet Products','pet,宠物',15],['Shoes','shoes,鞋',15],['Small Appliances','small appliances,小家电',12],['Software','software,软件',10],['Sports','sports,运动',13],['Tools & Home Improvement','tools,home improvement,工具,家装',14],['Toys','toys,玩具',14],['Video & DVD','video,dvd',13],['Video Game Consoles','game console,游戏机',6],['Video Games','video game,游戏',14],['All Other Categories','other,其他',10]];
  for(const r of fixed) add(...r);
  for(const r of [['Baby','baby,婴儿',8,15],['Beauty','beauty,美妆',8.5,11],['Health & Personal Care','health,personal care,健康,个护',8.5,11],['Personal Care Appliances','personal care appliances,个护电器',8,13]]){ add(r[0],r[1],r[2],null,50); add(r[0],r[1],r[3],50.000001,null); }
  add('Grocery','grocery,food,食品,杂货',3,null,25,{minimum:0}); add('Grocery','grocery,food,食品,杂货',9,25.000001,null,{minimum:0});
  add('Electronics Accessories','electronics accessories,电子配件',15,null,null,{threshold:250,above:8});
  add('Furniture','furniture,家具',15,null,null,{threshold:750,above:10});
  add('Jewelry','jewelry,珠宝',16,null,null,{threshold:1000,above:5});
  add('Watches','watches,手表',15,null,null,{threshold:5000,above:5});
  add('Wireless','wireless,无线',15,null,null,{threshold:250,above:8});
}

module.exports={migrateStrictRules};
