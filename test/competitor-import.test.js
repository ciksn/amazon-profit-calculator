'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {detectFormat,parseRows}=require('../public/competitor-import');

test('H10 英寸和磅换算后按表单精度保存',()=>{
  const headers=['图片 URL','URL','月销售额','ASIN','标题','价格','长度','宽度','高度','重量'];
  const rows=[['https://example.com/a.jpg','https://amazon.com.au/dp/B0ROUND001','1000','B0ROUND001','测试商品','99',15.7988,24.790399999999,33.401,3.92]];
  const [item]=parseRows(headers,rows,{countryCode:'AU',countryCnyPerLocal:4.7,usdCnyPerLocal:7.2});
  assert.equal(item.length,40.13);assert.equal(item.width,62.97);assert.equal(item.height,84.84);assert.equal(item.weight,1.778);
});

test('H10 新版父级和 ASIN 指标表头可识别并优先使用 ASIN 数据',()=>{
  const headers=['URL','图片 URL','ASIN','标题','价格','父级销量','ASIN 销量','父级收入','ASIN 收入','评论评分'];
  const rows=[['https://amazon.ca/dp/B0NEWHEADER','https://example.com/new.jpg','B0NEWHEADER','新版表头商品',49.99,8583,406,358493.5,17490.61,4.2]];
  assert.equal(detectFormat(headers),'helium10');
  const [item]=parseRows(headers,rows,{countryCode:'CA',countryCnyPerLocal:5.2,usdCnyPerLocal:7.2});
  assert.equal(item.monthly_sales,406);
  assert.equal(item.monthly_revenue_local,17490.61);
  assert.equal(item.monthly_revenue_usd,17490.61*5.2/7.2);
});

test('H10 只有父级指标时仍可兼容导入',()=>{
  const headers=['URL','图片 URL','ASIN','标题','价格','父级销量','父级收入'];
  const rows=[['https://amazon.de/dp/B0PARENTONLY','https://example.com/parent.jpg','B0PARENTONLY','父级指标商品',39.99,120,4798.8]];
  assert.equal(detectFormat(headers),'helium10');
  const [item]=parseRows(headers,rows,{countryCode:'DE',countryCnyPerLocal:8,usdCnyPerLocal:7.2});
  assert.equal(item.monthly_sales,120);
  assert.equal(item.monthly_revenue_local,4798.8);
});
