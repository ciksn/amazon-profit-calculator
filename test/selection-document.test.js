'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {
  competitorRevenue,
  validateDocumentPatch,
  validateSupplierInput
}=require('../lib/selection-document');

test('澳洲竞品销售额显示 AUD，且保留月销量',()=>{
  const row={country_code:'AU',monthly_sales:321,monthly_revenue_local:4567.89,monthly_revenue_usd:3000};
  assert.deepEqual(competitorRevenue(row,[]),{
    monthly_sales:321,
    revenue:4567.89,
    currency:'AUD',
    symbol:'A$'
  });
});

test('非澳洲竞品优先显示已保存的美元销售额',()=>{
  const row={country_code:'JP',monthly_sales:98,monthly_revenue_local:720000,monthly_revenue_usd:4800};
  assert.deepEqual(competitorRevenue(row,[]),{
    monthly_sales:98,
    revenue:4800,
    currency:'USD',
    symbol:'$'
  });
});

test('非澳洲缺少美元销售额时按人民币汇率比值补算',()=>{
  const countries=[
    {code:'US',cny_per_local:7.2},
    {code:'JP',cny_per_local:.048}
  ];
  const row={country_code:'JP',monthly_sales:55,monthly_revenue_local:720000,monthly_revenue_usd:0};
  assert.equal(competitorRevenue(row,countries).revenue,4800);
});

test('主文档只接受合法决策状态和版本',()=>{
  assert.deepEqual(validateDocumentPatch({version:0,decision_status:'通过'}),{
    version:0,
    decision_status:'通过'
  });
  assert.throws(()=>validateDocumentPatch({version:-1}),/版本号/);
  assert.throws(()=>validateDocumentPatch({version:0,decision_status:'自动通过'}),/决策状态/);
});

test('供应商输入校验 URL、非负数与评分范围',()=>{
  const valid=validateSupplierInput({
    name:'供应商 A',
    product_url:'https://detail.1688.com/offer/1.html',
    image_url:'https://example.com/a.jpg',
    cost_cny:88,
    moq:200,
    pre_sample_score:80,
    post_sample_score:90,
    target_country_code:'US',
    target_sale_price:49.99
  });
  assert.equal(valid.cost_cny,88);
  assert.throws(()=>validateSupplierInput({product_url:'javascript:alert(1)'}),/链接/);
  assert.throws(()=>validateSupplierInput({cost_cny:-1}),/不能为负数/);
  assert.throws(()=>validateSupplierInput({pre_sample_score:101}),/评分/);
});
