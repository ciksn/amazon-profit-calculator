'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDimensions } = require('../public/dimensions');

test('识别星号、乘号和尺寸单位', () => {
  assert.deepEqual(parseDimensions('27.2*12.5*54 cm'),{ length:27.2,width:12.5,height:54,unit:'cm' });
  assert.deepEqual(parseDimensions('27.2*12.5\\**54 cm'),{ length:27.2,width:12.5,height:54,unit:'cm' });
  assert.deepEqual(parseDimensions('尺寸：27.2 × 12.5 × 54 厘米'),{ length:27.2,width:12.5,height:54,unit:'cm' });
  assert.deepEqual(parseDimensions('27,2 x 12,5 x 54 centimeters'),{ length:27.2,width:12.5,height:54,unit:'cm' });
  assert.deepEqual(parseDimensions('**15.2D x 22.8W x 17.8H centimetres**'),{ length:15.2,width:22.8,height:17.8,unit:'cm' });
});

test('单位自动换算为计算器支持的厘米或英尺', () => {
  assert.deepEqual(parseDimensions('272*125*540 mm'),{ length:27.2,width:12.5,height:54,unit:'cm' });
  assert.deepEqual(parseDimensions('10*5*2 in'),{ length:25.4,width:12.7,height:5.08,unit:'cm' });
  assert.deepEqual(parseDimensions('2*1.5*4 ft'),{ length:2,width:1.5,height:4,unit:'ft' });
});

test('无单位时沿用当前单位且拒绝不完整尺寸', () => {
  assert.deepEqual(parseDimensions('2*1.5*4','ft'),{ length:2,width:1.5,height:4,unit:'ft' });
  assert.equal(parseDimensions('27.2*12.5 cm'),null);
  assert.equal(parseDimensions('27*2*1.5*54 cm'),null);
  assert.equal(parseDimensions(''),null);
});
