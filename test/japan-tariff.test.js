'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHsCode,parseRate,parseRows,chooseRate } = require('../lib/japan-tariff');

test('日本 HS 编码仅接受 6 位或 9 位有效章节', () => {
  assert.equal(normalizeHsCode('8543.70-000'),'854370000');
  assert.equal(normalizeHsCode('854370'),'854370');
  assert.throws(() => normalizeHsCode('8543'));
  assert.throws(() => normalizeHsCode('770000'));
});

test('税率文本解析 Free 和百分比，复杂从量税交给人工确认', () => {
  assert.equal(parseRate('(Free)').percent,0);
  assert.equal(parseRate('3.9%').percent,3.9);
  assert.equal(parseRate('2.5% or 3 yen/kg').percent,null);
});

test('税则行解析并按优惠资格选择中国 RCEP 或 WTO 税率', () => {
  const empty = Array(27).fill('<td></td>').join('');
  const rates = ['<td>5%</td>','<td></td>','<td>3.9%</td>',...Array(21).fill('<td></td>'),'<td>Free</td>',...Array(2).fill('<td></td>')].join('');
  const html = `<table id="datatable"><tr><td>header</td></tr><tr><td>header</td></tr><tr><td>8543.70</td><td>000</td><td>Other apparatus</td>${rates}</tr><tr><td></td><td></td><td></td>${empty}</tr></table>`;
  const row = parseRows(html)[0];
  assert.equal(row.code,'854370000');
  assert.equal(chooseRate(row,'none').percent,3.9);
  assert.equal(chooseRate(row,'rcep').percent,0);
});
