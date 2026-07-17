'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateProfit,selectFbaRule,selectSizeTier,selectStrictFbaRule } = require('../lib/profit');

const project = (overrides={}) => ({ cost_cny:0,length:10,width:10,height:10,dimension_unit:'cm',weight:1,weight_unit:'kg',...overrides });
const country = (overrides={}) => ({ code:'TEST',currency:'TST',symbol:'$',cny_per_local:1,vat_rate:0,tax_rate:0,tax_basis:'none',tax_note:'',fba_volume_divisor:5000,...overrides });
const listing = (overrides={}) => ({ sale_price:100,referral_rate_override:0,category_text:'Home',...overrides });

test('传统 FBA 选择覆盖命中、组合尺寸、超限回退和空规则', () => {
  const rules=[
    { id:1,max_long_cm:20,max_mid_cm:20,max_short_cm:20,max_total_cm:31,max_weight_kg:1 },
    { id:2,max_long_cm:20,max_mid_cm:20,max_short_cm:20,max_total_cm:60,max_weight_kg:2 },
    { id:3,max_long_cm:40,max_mid_cm:40,max_short_cm:40,max_weight_kg:10 }
  ];
  assert.equal(selectFbaRule(rules,[10,10,10],1).rule.id,1);
  assert.equal(selectFbaRule(rules,[12,10,10],1).rule.id,2);
  assert.equal(selectFbaRule([
    {id:4,max_long_cm:20,max_mid_cm:20,max_short_cm:20,max_total_cm:60,max_weight_kg:2},
    {id:5,max_long_cm:20,max_mid_cm:20,max_short_cm:20,max_total_cm:60,max_weight_kg:3}
  ],[10,10,10],1).rule.id,4);
  assert.equal(selectFbaRule(rules,[100,100,100],50).fallback,true);
  assert.deepEqual(selectFbaRule([], [1,1,1],1),{ rule:null,fallback:false });
});

test('尺寸分段覆盖实重/较大值、围长、最小实重、体积重上限和回退', () => {
  const base={ tier_name:'测试',max_long_cm:200,max_mid_cm:200,max_short_cm:200,min_item_weight_kg:0,max_item_weight_kg:20,max_volume_weight_kg:null,max_total_cm:null,dimension_mode:'none',class_weight_mode:'actual' };
  assert.equal(selectSizeTier([{...base,tier_code:'actual'}],[50,20,10],5,30).tier.tier_code,'actual');
  assert.equal(selectSizeTier([{...base,tier_code:'max',class_weight_mode:'max'}],[50,20,10],5,30).fallback,true);
  assert.equal(selectSizeTier([{...base,tier_code:'girth',dimension_mode:'length_girth',max_total_cm:109}],[50,20,10],5,5).fallback,true);
  assert.equal(selectSizeTier([{...base,tier_code:'min',min_item_weight_kg:5}],[50,20,10],5,5).fallback,true);
  assert.equal(selectSizeTier([{...base,tier_code:'volume',max_volume_weight_kg:4}],[50,20,10],3,5).fallback,true);
  assert.deepEqual(selectSizeTier([], [1,1,1],1,1),{ tier:null,fallback:false });
});

test('严格 FBA 规则覆盖售价、服装、未知组、重量命中和超重回退', () => {
  const tier={ tier_code:'standard' };
  const rules=[
    { id:1,size_tier:'standard',min_price:10,max_price:20,category_group:'apparel',max_weight_kg:1 },
    { id:2,size_tier:'standard',min_price:10,max_price:20,category_group:'non_apparel',max_weight_kg:2 },
    { id:3,size_tier:'standard',min_price:10,max_price:20,category_group:'mystery',max_weight_kg:10 },
    { id:4,size_tier:'other',min_price:null,max_price:null,category_group:'all',max_weight_kg:10 }
  ];
  assert.equal(selectStrictFbaRule(rules,tier,{sale_price:15,category_text:'Apparel'},.5).rule.id,1);
  assert.equal(selectStrictFbaRule(rules,tier,{sale_price:15,category_text:'Home'},1.5).rule.id,2);
  assert.equal(selectStrictFbaRule(rules,tier,{sale_price:15,category_text:'Home'},5).fallback,true);
  assert.equal(selectStrictFbaRule(rules,tier,{sale_price:30,category_text:'Home'},1).rule,null);
});

test('欧洲品类实重例外与普通品类体积重分支均生效', () => {
  const tier={ tier_code:'eu',tier_name:'欧洲件',max_long_cm:100,max_mid_cm:100,max_short_cm:100,min_item_weight_kg:0,max_item_weight_kg:50,max_volume_weight_kg:null,max_total_cm:null,dimension_mode:'none',class_weight_mode:'actual',fee_weight_mode:'eu_category' };
  const rules=[
    { size_tier:'eu',size_name:'≤2kg',min_price:null,max_price:null,category_group:'all',max_weight_kg:2,included_weight_kg:0,base_fee:2,per_kg_fee:0,surcharge_rate:0,status:'verified' },
    { size_tier:'eu',size_name:'≤20kg',min_price:null,max_price:null,category_group:'all',max_weight_kg:20,included_weight_kg:0,base_fee:20,per_kg_fee:0,surcharge_rate:0,status:'verified' }
  ];
  const input={ project:project({length:50,width:40,height:40,weight:1}),country:country(),fbaRules:rules,sizeTiers:[tier],freightRule:null };
  assert.equal(calculateProfit({...input,listing:listing({category_text:'Clothing'})}).fba_fee,2);
  assert.equal(calculateProfit({...input,listing:listing({category_text:'Home'})}).fba_fee,20);
});

test('续重向上取整、附加费、最低头程和手动佣金覆盖同时计算', () => {
  const tier={ tier_code:'x',tier_name:'X',max_long_cm:100,max_mid_cm:100,max_short_cm:100,min_item_weight_kg:0,max_item_weight_kg:100,max_volume_weight_kg:null,max_total_cm:null,dimension_mode:'none',class_weight_mode:'actual',fee_weight_mode:'actual' };
  const rule={ size_tier:'x',size_name:'X',min_price:null,max_price:null,category_group:'all',max_weight_kg:100,included_weight_kg:1,base_fee:10,per_kg_fee:2,weight_increment_kg:.5,surcharge_rate:10,status:'verified' };
  const result=calculateProfit({ project:project({weight:1.01}),country:country({cny_per_local:2}),listing:listing({referral_rate_override:12}),fbaRules:[rule],sizeTiers:[tier],freightRule:{pricing_mode:'kg',price_per_kg_cny:1,min_charge_cny:10,status:'verified'} });
  assert.equal(result.fba_fee,12.1);
  assert.equal(result.fba_base_fee,11);
  assert.equal(result.fba_surcharge_fee,1.1);
  assert.equal(result.freight_fee,5);
  assert.equal(result.referral_fee,12);
});

test('告警矩阵覆盖无售价、无 FBA、缺货代及税率说明', () => {
  const result=calculateProfit({ project:project(),country:country({tax_note:'税率因省份变化且待确认'}),listing:listing({sale_price:0}),fbaRules:[],sizeTiers:[],freightRule:null });
  for (const text of ['请填写售价','暂无可用 FBA','头程运费尚未维护','省份变化','待确认']) {
    assert.ok(result.warnings.some((warning)=>warning.includes(text)),text);
  }
});
