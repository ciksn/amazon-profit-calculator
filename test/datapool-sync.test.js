'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { value,number,stringValue,items,countryCode,resolveDateRange }=require('../scripts/sync-datapool-to-postgres');

test('数据池响应兼容英文键、中文键和常见列表包裹', () => {
  assert.equal(value({ '负责人':'张三' },'owner_name','负责人'),'张三');
  assert.equal(number('18.65%'),18.65);
  assert.deepEqual(items({ data:{ items:[{ asin:'B001' }] } }),[{ asin:'B001' }]);
  assert.equal(countryCode('美国'),'US');
  assert.equal(countryCode('uk'),'GB');
  assert.equal(countryCode('法国'),'FR');
  assert.equal(stringValue(['Electronics','Home']),'Electronics, Home');
});

test('分析日期优先用配置，其次使用接口数据范围', () => {
  assert.deepEqual(resolveDateRange({},{ start_date:'2026-01-01',end_date:'2026-07-01' }),{ start:'2026-01-01',end:'2026-07-01' });
  assert.deepEqual(resolveDateRange({ analysis_start_date:'2026-06-01',analysis_end_date:'2026-06-30' },{}),{ start:'2026-06-01',end:'2026-06-30' });
});
