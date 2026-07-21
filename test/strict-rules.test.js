'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../docs/data/rules.json');
const { calculateProfit } = require('../lib/profit');

function calculate(countryCode, project, listing) {
  return calculateProfit({
    project,
    listing,
    country:rules.countries.find((row)=>row.code===countryCode),
    fbaRules:rules.fba_rules.filter((row)=>row.country_code===countryCode),
    sizeTiers:rules.size_tiers.filter((row)=>row.country_code===countryCode),
    freightRule:rules.freight_rules.find((row)=>row.country_code===countryCode)
  });
}

test('澳洲 FBA 严格按售价和特殊品类费率列匹配', () => {
  const project={cost_cny:0,length:30,width:20,height:10,dimension_unit:'cm',weight:.8,weight_unit:'kg'};
  const lowSpecial=calculate('AU',project,{sale_price:12,category_text:'Home & Kitchen',referral_rate_override:0});
  const lowNormal=calculate('AU',project,{sale_price:12,category_text:'Electronics',referral_rate_override:0});
  const midNormal=calculate('AU',project,{sale_price:15,category_text:'Electronics',referral_rate_override:0});
  const high=calculate('AU',project,{sale_price:25,category_text:'Home & Kitchen',referral_rate_override:0});
  assert.equal(lowSpecial.size_tier_name,'包裹');
  assert.equal(lowSpecial.fba_fee,6.19);
  assert.equal(lowNormal.fba_fee,7.97);
  assert.equal(midNormal.fba_fee,8.88);
  assert.equal(high.fba_fee,8.88);
});

test('澳洲标准大件按实重和体积重较大值选择重量费阶', () => {
  const project={cost_cny:115,length:54,width:27.2,height:12.5,dimension_unit:'cm',weight:3.8,weight_unit:'kg'};
  const result=calculate('AU',project,{sale_price:72.24,category_text:'Home & Kitchen',referral_rate_override:13});
  assert.equal(result.size_tier_name,'标准大件');
  assert.equal(result.fba_volume_weight_kg,4.59);
  assert.equal(result.fba_billable_weight_kg,4.59);
  assert.equal(result.fba_rule_name,'标准大件 ≤5kg');
  assert.equal(result.fba_fee,13.41);
});

test('阿联酋超过标准箱尺寸后仍按实际重量匹配大件费阶', () => {
  const project={cost_cny:115,length:54,width:27.2,height:12.5,dimension_unit:'cm',weight:3.8,weight_unit:'kg'};
  const result=calculate('AE',project,{sale_price:359,category_text:'Home & Kitchen',referral_rate_override:15});
  assert.equal(result.size_tier_name,'大件');
  assert.equal(result.fba_billable_weight_kg,3.8);
  assert.equal(result.fba_rule_name,'大件 ≤4kg');
  assert.equal(result.fba_fee,15.5);
});

test('美国同一尺寸按售价档和服装类别选择不同 FBA 费', () => {
  const project={cost_cny:0,length:30,width:20,height:1,dimension_unit:'cm',weight:.1,weight_unit:'kg'};
  const low=calculate('US',project,{sale_price:8,category_text:'Home & Kitchen',referral_rate_override:0});
  const mid=calculate('US',project,{sale_price:30,category_text:'Home & Kitchen',referral_rate_override:0});
  const apparel=calculate('US',project,{sale_price:30,category_text:'Apparel',referral_rate_override:0});
  assert.equal(low.size_tier_name,'小号标准尺寸');
  assert.equal(low.fba_fee,2.58);
  assert.equal(mid.fba_fee,3.54);
  assert.equal(apparel.fba_fee,3.66);
});

test('美国续重按完整 4oz 档向上计费并包含 3.5% 附加费', () => {
  const project={cost_cny:0,length:43,width:25,height:2,dimension_unit:'cm',weight:3.01,weight_unit:'lb'};
  const result=calculate('US',project,{sale_price:30,category_text:'Home & Kitchen',referral_rate_override:0});
  assert.equal(result.size_tier_name,'大号标准尺寸');
  assert.equal(result.fba_rule_name,'大号标准 3–20lb');
  assert.equal(result.fba_fee,7.3);
});

test('美国 150lb 以上超大件按实重而不是体积重计费', () => {
  const project={cost_cny:0,length:250,width:100,height:100,dimension_unit:'cm',weight:70,weight_unit:'kg'};
  const result=calculate('US',project,{sale_price:30,category_text:'Home & Kitchen',referral_rate_override:0});
  assert.equal(result.size_tier_code,'extra_large_150_plus');
  assert.equal(result.fba_billable_weight_kg,70);
  assert.equal(result.fba_fee,202.56);
});

test('美国 FBA 返回基础配送费、3.5%附加费和合计明细', () => {
  const project={cost_cny:115,length:54,width:27.2,height:12.5,dimension_unit:'cm',weight:3.8,weight_unit:'kg'};
  const result=calculate('US',project,{sale_price:65.99,category_text:'Health & Household',referral_rate_override:15});
  assert.equal(result.size_tier_name,'小号大件');
  assert.equal(result.fba_base_fee,10.59);
  assert.equal(result.fba_surcharge_rate,3.5);
  assert.equal(result.fba_surcharge_fee,.37);
  assert.equal(result.fba_fee,10.96);
});

test('加拿大标准件补齐 100g 档、低价优惠、5000 除数和 3.5% 附加费', () => {
  const project={cost_cny:0,length:30,width:20,height:3,dimension_unit:'cm',weight:.25,weight_unit:'kg'};
  const regular=calculate('CA',project,{sale_price:20,category_text:'Home',referral_rate_override:0});
  const low=calculate('CA',project,{sale_price:12,category_text:'Home',referral_rate_override:0});
  assert.equal(regular.size_tier_name,'标准件');
  assert.equal(regular.fba_volume_divisor,5000);
  assert.equal(regular.fba_rule_name,'标准件 ≤0.4kg');
  assert.equal(regular.fba_fee,6.97);
  assert.equal(low.fba_fee,6.14);
});

test('加拿大特殊大件和 500g 续重档完整生效', () => {
  const project={cost_cny:0,length:280,width:50,height:50,dimension_unit:'cm',weight:10,weight_unit:'kg'};
  const result=calculate('CA',project,{sale_price:100,category_text:'Home',referral_rate_override:0});
  assert.equal(result.size_tier_name,'特殊大件');
  assert.equal(result.fba_rule_name,'特殊大件');
  assert.equal(result.fba_fee,323.54);
});

test('日本按 1000 日元售价边界匹配高低两列费率', () => {
  const project={cost_cny:0,length:20,width:15,height:15,dimension_unit:'cm',weight:1,weight_unit:'kg'};
  const low=calculate('JP',project,{sale_price:900,category_text:'Home',referral_rate_override:0});
  const regular=calculate('JP',project,{sale_price:1000,category_text:'Home',referral_rate_override:0});
  assert.equal(low.size_tier_code,'standard2d');
  assert.equal(low.fba_fee,379);
  assert.equal(regular.fba_fee,425);
});

test('英国和德国补齐标准大件并使用 5000 体积除数', () => {
  const project={cost_cny:0,length:54,width:27.2,height:12.5,dimension_unit:'cm',weight:3.8,weight_unit:'kg'};
  const gb=calculate('GB',project,{sale_price:50,category_text:'Home & Kitchen',referral_rate_override:0});
  const de=calculate('DE',project,{sale_price:50,category_text:'Home & Kitchen',referral_rate_override:0});
  assert.equal(gb.size_tier_name,'标准大件轻型');
  assert.equal(gb.fba_volume_divisor,5000);
  assert.equal(gb.fba_fee,4.8);
  assert.equal(de.size_tier_name,'标准大件轻型');
  assert.equal(de.fba_volume_divisor,5000);
  assert.equal(de.fba_fee,5.14);
});

test('沙特使用独立尺寸分段并按 25 SAR 售价边界计费', () => {
  const project={cost_cny:0,length:35,width:22,height:2,dimension_unit:'cm',weight:.15,weight_unit:'kg'};
  const low=calculate('SA',project,{sale_price:20,category_text:'Home',referral_rate_override:0});
  const high=calculate('SA',project,{sale_price:30,category_text:'Home',referral_rate_override:0});
  assert.equal(low.size_tier_name,'标准包裹');
  assert.equal(low.fba_fee,7.2);
  assert.equal(high.fba_fee,9.2);
});

test('相同商品在不同国家返回各自的尺寸分段', () => {
  const project={cost_cny:0,length:40,width:30,height:10,dimension_unit:'cm',weight:1,weight_unit:'kg'};
  const au=calculate('AU',project,{sale_price:30,category_text:'Home',referral_rate_override:0});
  const us=calculate('US',project,{sale_price:30,category_text:'Home',referral_rate_override:0});
  assert.equal(au.size_tier_name,'包裹');
  assert.equal(us.size_tier_name,'大号标准尺寸');
});

test('沙特阶梯佣金和最低佣金按资料规则计算', () => {
  const project={cost_cny:0,length:10,width:10,height:1,dimension_unit:'cm',weight:.05,weight_unit:'kg'};
  const progressive=calculate('SA',project,{sale_price:300,category_text:'Electronics Accessories',matched_referral_rate:15,matched_referral_threshold:250,matched_referral_rate_above:8,matched_referral_minimum:1});
  const minimum=calculate('SA',project,{sale_price:5,category_text:'Consumer Electronics',matched_referral_rate:5.5,matched_referral_minimum:1});
  assert.equal(progressive.referral_fee,41.5);
  assert.equal(minimum.referral_fee,1);
});
