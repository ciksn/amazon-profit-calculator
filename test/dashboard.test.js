'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResult,getDashboard,matchCommission,normalizeSourceRate,groupDashboardProducts } = require('../dashboard/service');
const auth = require('../dashboard/auth');
const { normalizeProduct } = require('../dashboard/manual-service');
const { HEADERS,scalar,parseWorkbookBase64 } = require('../dashboard/excel-import');
const ExcelJS = require('exceljs');

function ruleSet() {
  const country = { code:'US',name:'美国',flag:'🇺🇸',currency:'USD',symbol:'$',cny_per_local:7,
    vat_rate:0,tax_rate:0,tax_basis:'none',tax_label:'税费',fba_volume_divisor:5000,tax_note:'' };
  return {
    countries:new Map([['US',country]]),sizes:new Map([['US',[]]]),fba:new Map([['US',[{
      size_name:'标准件',max_long_cm:100,max_mid_cm:100,max_short_cm:100,max_weight_kg:20,
      included_weight_kg:0,base_fee:3,per_kg_fee:0,surcharge_rate:0,status:'verified'
    }]]]),freight:new Map([['US',{ pricing_mode:'kg',price_per_kg_cny:7,min_charge_cny:0 }]]),
    commissions:new Map([['US',[{ parent_category:'Other / 其他类别',keywords:'other',rate:15,minimum_fee:.3 }]]])
  };
}

test('看板缺字段时不伪造利润率，并只声明可用产品字段', () => {
  const row = { asin:'B001',owner_name:'张三',product_name:'测试产品',country_code:'US',sale_price:20,cost_cny:null,
    length_cm:null,width_cm:null,height_cm:null,weight_kg:null,image_url:null };
  const result = buildResult(row,ruleSet());
  assert.equal(result.profit_rate,null);
  assert.deepEqual(result.available_fields,['product_name']);
  assert.ok(result.missing_fields.includes('成本'));
});

test('完整公司数据复用现有利润引擎计算站点利润率', () => {
  const result = buildResult({ asin:'B002',owner_name:'张三',product_name:'产品',country_code:'US',sale_price:30,cost_cny:35,
    length_cm:20,width_cm:10,height_cm:5,weight_kg:.5,image_url:'https://example.com/a.jpg',category_text:'Unknown' },ruleSet());
  assert.equal(typeof result.profit_rate,'number');
  assert.ok(result.profit_rate > 0);
  assert.deepEqual(result.missing_fields,[]);
  assert.equal(matchCommission(ruleSet().commissions.get('US'),'Unknown',30).rate,15);
});

test('数据池已有毛利率时直接使用公司口径，不要求尺寸字段', () => {
  const result=buildResult({ asin:'B009',owner_name:'张三',product_name:'产品',country_code:'US',
    source_profit_rate:.1865,source_profit:1200,source_total_sales:6434,cost_cny:20 },ruleSet());
  assert.equal(result.profit_rate,18.65);
  assert.equal(result.profit,1200);
  assert.equal(result.calculation_source,'company_datapool');
  assert.deepEqual(result.missing_fields,[]);
  assert.equal(normalizeSourceRate(15.5),15.5);
});

test('数据池没有毛利率时只标记暂无利润，不暴露计算器缺失字段', () => {
  const result=buildResult({ asin:'B010',owner_name:'张三',product_name:'产品',country_code:'US',source_profit_rate:null },ruleSet());
  assert.equal(result.profit_rate,null);
  assert.equal(result.calculation_source,'company_datapool_missing');
  assert.deepEqual(result.missing_fields,[]);
});

test('个人看板查询始终将飞书姓名作为 SQL 参数', async () => {
  const calls = [];
  const source = { asin:'B003',owner_name:'李四',product_name:'产品',country_code:'US',sale_price:30,cost_cny:35,
    length_cm:20,width_cm:10,height_cm:5,weight_kg:.5,category_text:'Unknown' };
  const rules = ruleSet();
  const pool = { query:async (sql,values = []) => {
    calls.push({ sql,values });
    if (sql.includes('SELECT DISTINCT v.country_code')) return { rows:[{ country_code:'US',priority:2 }] };
    if (sql.includes('dashboard_product_sites_v WHERE')) return { rows:[source] };
    if (sql.includes('FROM countries')) return { rows:[...rules.countries.values()] };
    if (sql.includes('FROM size_tiers')) return { rows:[] };
    if (sql.includes('FROM fba_rules')) return { rows:rules.fba.get('US').map((row) => ({ ...row,country_code:'US' })) };
    if (sql.includes('FROM freight_rules')) return { rows:[{ ...rules.freight.get('US'),country_code:'US' }] };
    if (sql.includes('FROM commission_rules')) return { rows:rules.commissions.get('US').map((row) => ({ ...row,country_code:'US' })) };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const dashboard = await getDashboard(pool,{ name:'李四',avatar_url:'' },{});
  assert.equal(dashboard.products.length,1);
  assert.ok(calls.filter((call) => call.sql.includes('dashboard_product_sites_v')).every((call) => call.values[0] === '李四'));
  assert.ok(calls.every((call) => !/^\s*(INSERT|UPDATE|DELETE)/i.test(call.sql)));
});

test('应用登录态可验签且过期后失效', () => {
  const original = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET='test-secret-that-is-at-least-thirty-two-characters';
  try {
    const token = auth.seal({ name:'王五',exp:Date.now() + 10_000 });
    assert.equal(auth.unseal(token).name,'王五');
    assert.equal(auth.unseal(`${token}x`),null);
    assert.equal(auth.unseal(auth.seal({ name:'王五',exp:Date.now() - 1 })),null);
  } finally {
    if (original == null) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET=original;
  }
});

test('父 ASIN 聚合产品并按站点保留各子 ASIN 明细', () => {
  const rows=[
    { parent_asin:'P001',asin:'C001',country_code:'US',site_name:'美国',product_name:'红色',image_url:'a.jpg',weight_kg:1 },
    { parent_asin:'P001',asin:'C002',country_code:'US',site_name:'美国',product_name:'蓝色',length_cm:20,width_cm:10,height_cm:5,weight_kg:1 },
    { parent_asin:'P001',asin:'C001',country_code:'CA',site_name:'加拿大',product_name:'红色',weight_kg:1 }
  ];
  const products=groupDashboardProducts(rows);
  assert.equal(products.length,1);
  assert.equal(products[0].parent_asin,'P001');
  assert.equal(products[0].child_count,2);
  assert.equal(products[0].site_count,2);
  assert.equal(products[0].sites.find((site) => site.country_code === 'US').children.length,2);
  assert.equal(products[0].representative_asin,'C002');
});

test('手动看板产品校验负责人、父 ASIN 并保留计算器站点结果', () => {
  const product=normalizeProduct({ owner_name:' 张三 ',parent_asin:'b0parent',product_name:'测试产品',sales_amount_cny:'1200',six_day_capacity:'8',
    sites:[{ country_code:'us',sale_price:'19.99',sales_qty:'12',unit_profit:'3.2',profit_rate:'16.01' }] });
  assert.equal(product.owner_name,'张三');
  assert.equal(product.parent_asin,'B0PARENT');
  assert.equal(product.sales_amount_cny,1200);
  assert.equal(product.sites[0].country_code,'US');
  assert.equal(product.sites[0].profit_rate,16.01);
  assert.throws(() => normalizeProduct({ parent_asin:'B1',product_name:'产品' }),/负责人/);
});

test('Excel 导入模板表头映射完整并兼容公式结果值', () => {
  for (const field of ['owner_name','parent_asin','product_name','country_code','sale_price','profit_rate']) {
    assert.ok(Object.values(HEADERS).includes(field));
  }
  assert.equal(scalar({ result:18.5,formula:'=A1' }),18.5);
  assert.equal(scalar({ richText:[{ text:'B0'},{ text:'TEST' }] }),'B0TEST');
});

test('Excel 文件可解析为手动产品与站点字段', async () => {
  const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('产品导入');
  sheet.addRow(['负责人','父ASIN','品名','站点代码','售价','利润率(%)']);
  sheet.addRow(['李四','B0EXCEL','导入产品','AU',29.99,12.5]);
  const buffer=await workbook.xlsx.writeBuffer();
  const rows=await parseWorkbookBase64(Buffer.from(buffer).toString('base64'));
  assert.equal(rows.length,1);assert.equal(rows[0].owner_name,'李四');assert.equal(rows[0].country_code,'AU');assert.equal(rows[0].profit_rate,12.5);
});
