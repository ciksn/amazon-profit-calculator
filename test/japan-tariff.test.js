'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHsCode,parseRate,parseRows,chooseRate } = require('../lib/japan-tariff');

test('关税查询接受国内 10 位编码，并兼容内部使用的日本 6/9 位编码', () => {
  assert.equal(normalizeHsCode('8543.70-000'),'854370000');
  assert.equal(normalizeHsCode('854370'),'854370');
  assert.equal(normalizeHsCode('8543709999'),'8543709999');
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
