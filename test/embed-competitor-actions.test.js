'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname,'..');
const html = fs.readFileSync(path.join(root,'public','embed.html'),'utf8');
const script = fs.readFileSync(path.join(root,'public','embed.js'),'utf8');

test('飞书内嵌竞品操作使用页面内弹窗并提供保存反馈', () => {
  assert.match(html,/id="manualCompetitorModal"/);
  assert.match(html,/id="competitorClearModal"/);
  assert.match(html,/id="confirmCompetitorClear"/);
  assert.doesNotMatch(script,/\bconfirm\s*\(/);
  assert.match(script,/已添加.*手动竞品/);
  assert.match(script,/已清除.*条竞品数据/);
});
