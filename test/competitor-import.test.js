'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { detectFormat,parseRows }=require('../public/competitor-import');

test('识别并映射卖家精灵竞品字段',()=>{
  const headers=['ASIN','商品标题','商品详情页链接','商品主图','月销量','月销售额($)','价格($)','评分','上架时间','配送方式','A+页面','视频介绍'];
  assert.equal(detectFormat(headers),'seller_sprite');
  const [row]=parseRows(headers,[['B001','产品 A','https://amazon.com/dp/B001','https://img/a.jpg',123,4567,29.99,4.6,'2024-05-06','FBA','Y','N']],{countryCode:'US',countryCnyPerLocal:7,usdCnyPerLocal:7});
  const {source_row,...fields}=row;
  assert.equal(source_row,2);assert.deepEqual(fields,{asin:'B001',name:'产品 A',product_url:'https://amazon.com/dp/B001',image_url:'https://img/a.jpg',sale_price:29.99,is_fba:true,has_aplus:true,has_video:false,listing_date:'2024-05-06',monthly_sales:123,monthly_revenue_local:4567,monthly_revenue_usd:4567,rating:4.6,source_format:'seller_sprite'});
});

test('识别 H10 字段并把当地销售额换算为美元',()=>{
  const headers=['URL','图片 URL','ASIN','标题','配送方式','价格','月销量','月销售额','评论评分','年龄（月）'];
  assert.equal(detectFormat(headers),'helium10');
  const [row]=parseRows(headers,[['https://amazon.com.au/dp/B002','https://img/b.jpg','B002','产品 B','Amazon',109.99,536,58954.64,'4.5',20]],{countryCode:'AU',countryCnyPerLocal:4.5,usdCnyPerLocal:7});
  assert.equal(row.is_fba,false);assert.equal(row.has_aplus,null);assert.equal(row.has_video,null);assert.equal(row.listing_date,'约 20 个月');
  assert.ok(Math.abs(row.monthly_revenue_usd-37899.4114)<0.01);
});
