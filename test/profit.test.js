'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateProfit, normalizeDimensions, normalizeWeight } = require('../lib/profit');

test('厘米和 KG 输入保持原值并按最长边排序', () => {
  assert.deepEqual(normalizeDimensions({ length:10,width:30,height:20,dimension_unit:'cm' }),[30,20,10]);
  assert.equal(normalizeWeight({ weight:1.25,weight_unit:'kg' }),1.25);
});

test('英尺和磅会转换为厘米和 KG', () => {
  assert.deepEqual(normalizeDimensions({ length:1,width:2,height:.5,dimension_unit:'ft' }),[60.96,30.48,15.24]);
  assert.ok(Math.abs(normalizeWeight({ weight:2.20462262,weight_unit:'lb' }) - 1) < 1e-8);
});

test('美国站利润逐项扣除且不重复扣销售税', () => {
  const result = calculateProfit({
    project:{ cost_cny:72,length:20,width:10,height:5,dimension_unit:'cm',weight:.5,weight_unit:'kg' },
    country:{ code:'US',currency:'USD',symbol:'$',cny_per_local:7.2,vat_rate:0,tax_note:'' },
    listing:{ sale_price:30,matched_referral_rate:15 },
    fbaRules:[{ size_name:'标准件',max_long_cm:45,max_mid_cm:34,max_short_cm:26,max_weight_kg:2,included_weight_kg:.5,base_fee:4,per_kg_fee:1,surcharge_rate:0,status:'verified' }],
    freightRule:{ price_per_kg_cny:10,min_charge_cny:0,volume_divisor:6000,status:'verified' }
  });
  assert.equal(result.product_cost,10);
  assert.equal(result.referral_fee,4.5);
  assert.equal(result.fba_fee,4);
  assert.equal(result.freight_fee,.69);
  assert.equal(result.profit,10.81);
  assert.equal(result.profit_rate,36.02);
});

test('通用含税价公式可正确拆出 10% 税额', () => {
  const result = calculateProfit({
    project:{ cost_cny:47,length:20,width:10,height:5,dimension_unit:'cm',weight:.5,weight_unit:'kg' },
    country:{ code:'TEST',currency:'TST',symbol:'$',cny_per_local:4.7,vat_rate:10,tax_rate:0,tax_basis:'none',tax_note:'' },
    listing:{ sale_price:110,matched_referral_rate:15 },
    fbaRules:[{ size_name:'标准件',max_long_cm:45,max_mid_cm:34,max_short_cm:26,max_weight_kg:2,included_weight_kg:.5,base_fee:5.85,per_kg_fee:1,surcharge_rate:0,status:'verified' }],
    freightRule:{ price_per_kg_cny:0,min_charge_cny:0,volume_divisor:6000,status:'verified' }
  });
  assert.equal(result.vat_amount,10);
  assert.equal(result.net_revenue,100);
  assert.equal(result.profit,67.65);
  assert.equal(result.profit_rate,61.5);
});

test('超出尺寸时使用最大费阶并给出提醒', () => {
  const result = calculateProfit({
    project:{ cost_cny:0,length:200,width:80,height:80,dimension_unit:'cm',weight:20,weight_unit:'kg' },
    country:{ code:'AU',currency:'AUD',symbol:'$',cny_per_local:5,vat_rate:10,tax_note:'' },
    listing:{ sale_price:300,matched_referral_rate:15 },
    fbaRules:[{ size_name:'大件',max_long_cm:120,max_mid_cm:60,max_short_cm:60,max_weight_kg:15,included_weight_kg:2,base_fee:15,per_kg_fee:2,status:'estimate' }],
    freightRule:{ price_per_kg_cny:0,volume_divisor:6000 }
  });
  assert.ok(result.warnings.some((warning) => warning.includes('最大费阶')));
  assert.equal(result.fba_rule_name,'大件');
});

test('英国同时扣除成本百分比税费和含税售价中的 VAT', () => {
  const result = calculateProfit({
    project:{ cost_cny:100,length:10,width:10,height:10,dimension_unit:'cm',weight:.2,weight_unit:'kg' },
    country:{ code:'GB',currency:'GBP',symbol:'£',cny_per_local:10,vat_rate:20,tax_rate:10,tax_basis:'cost',tax_label:'进口/清关税费',tax_note:'' },
    listing:{ sale_price:120,referral_rate_override:0 },
    fbaRules:[], freightRule:{ price_per_kg_cny:0,volume_divisor:6000,status:'verified' }
  });
  assert.equal(result.vat_amount,20);
  assert.equal(result.tax_fee,1);
  assert.equal(result.product_cost,10);
  assert.equal(result.profit,89);
  assert.equal(result.profit_rate,74.17);
});

test('沙特按售价的 15% 计算税费且不再拆 VAT', () => {
  const result = calculateProfit({
    project:{ cost_cny:0,length:1,width:1,height:1,dimension_unit:'cm',weight:0,weight_unit:'kg' },
    country:{ code:'SA',currency:'SAR',symbol:'﷼',cny_per_local:2,vat_rate:0,tax_rate:15,tax_basis:'sale',tax_label:'税费预估',tax_note:'' },
    listing:{ sale_price:100,referral_rate_override:0 }, fbaRules:[], freightRule:null
  });
  assert.equal(result.tax_fee,15);
  assert.equal(result.vat_amount,0);
  assert.equal(result.profit,85);
});

test('日本按申报价依次计算关税和消费税', () => {
  const result = calculateProfit({
    project:{ cost_cny:0,length:1,width:1,height:1,dimension_unit:'cm',weight:0,weight_unit:'kg' },
    country:{ code:'JP',currency:'JPY',symbol:'¥',cny_per_local:.05,vat_rate:0,tax_rate:0,tax_basis:'japan_import',tax_label:'日本进口税金',tax_note:'' },
    listing:{ sale_price:10000,referral_rate_override:0,declaration_ratio:.15,declared_value_override:null,customs_rate:5,consumption_tax_rate:10 },
    fbaRules:[], freightRule:null
  });
  assert.equal(result.declared_value,1500);
  assert.equal(result.customs_duty,75);
  assert.equal(result.consumption_tax,157.5);
  assert.equal(result.tax_fee,232.5);
  assert.equal(result.profit,9767.5);
});

test('日本手填申报价优先于售价乘申报比例', () => {
  const result = calculateProfit({
    project:{ cost_cny:0,length:1,width:1,height:1,dimension_unit:'cm',weight:0,weight_unit:'kg' },
    country:{ code:'JP',currency:'JPY',symbol:'¥',cny_per_local:.05,vat_rate:0,tax_rate:0,tax_basis:'japan_import',tax_label:'日本进口税金',tax_note:'' },
    listing:{ sale_price:10000,referral_rate_override:0,declaration_ratio:.15,declared_value_override:1200,customs_rate:5,consumption_tax_rate:10 },
    fbaRules:[], freightRule:null
  });
  assert.equal(result.declared_value,1200);
  assert.equal(result.declared_value_overridden,true);
  assert.equal(result.customs_duty,60);
  assert.equal(result.consumption_tax,126);
  assert.equal(result.tax_fee,186);
});

test('美澳加拿大税费为 0 时不产生税费或 VAT', () => {
  for (const code of ['US','AU','CA']) {
    const result = calculateProfit({
      project:{ cost_cny:0,length:1,width:1,height:1,dimension_unit:'cm',weight:0,weight_unit:'kg' },
      country:{ code,currency:'USD',symbol:'$',cny_per_local:1,vat_rate:0,tax_rate:0,tax_basis:'none',tax_label:'税费预估',tax_note:'' },
      listing:{ sale_price:100,referral_rate_override:0 }, fbaRules:[], freightRule:null
    });
    assert.equal(result.tax_fee,0);
    assert.equal(result.vat_amount,0);
  }
});

test('按方报价的头程直接按立方米计算，不套用计费重', () => {
  const result = calculateProfit({
    project:{ cost_cny:0,length:100,width:50,height:40,dimension_unit:'cm',weight:80,weight_unit:'kg' },
    country:{ code:'GB',currency:'GBP',symbol:'£',cny_per_local:10,vat_rate:0,tax_rate:0,tax_basis:'none',tax_note:'',fba_volume_divisor:6000 },
    listing:{ sale_price:100,referral_rate_override:0 },
    fbaRules:[], freightRule:{ pricing_mode:'cbm',price_per_cbm_cny:700,price_per_kg_cny:0,min_charge_cny:0,volume_divisor:6000,status:'estimate' }
  });
  assert.equal(result.volume_cbm,.2);
  assert.equal(result.freight_fee,14);
  assert.equal(result.freight_pricing_mode,'cbm');
});

test('头程所有站点固定使用除数 6000，FBA 仍使用站点除数', () => {
  const result = calculateProfit({
    project:{ cost_cny:0,length:60,width:50,height:40,dimension_unit:'cm',weight:10,weight_unit:'kg' },
    country:{ code:'AU',currency:'AUD',symbol:'$',cny_per_local:5,vat_rate:0,tax_rate:0,tax_basis:'none',tax_note:'',fba_volume_divisor:4000 },
    listing:{ sale_price:100,referral_rate_override:0 },
    fbaRules:[], freightRule:{ pricing_mode:'kg',price_per_cbm_cny:0,price_per_kg_cny:4.8,min_charge_cny:0,volume_divisor:4000,status:'estimate' }
  });
  assert.equal(result.volume_weight_kg,20);
  assert.equal(result.billable_weight_kg,20);
  assert.equal(result.freight_volume_divisor,6000);
  assert.equal(result.freight_fee,19.2);
  assert.equal(result.fba_billable_weight_kg,30);
  assert.equal(result.fba_volume_divisor,4000);
});
