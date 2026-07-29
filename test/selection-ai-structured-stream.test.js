'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStructuredAnswerStream } = require('../lib/selection-ai/structured-stream');

test('streams only the answer string while decoding escapes across fragments', () => {
  const parser = createStructuredAnswerStream();
  const deltas = [
    parser.push('{"answer":"美国站利润\\'),
    parser.push('n较好","proposal":{"summary":"建议"'),
    parser.push(',"changes":[]}}')
  ].join('');

  assert.equal(deltas, '美国站利润\n较好');
  assert.deepEqual(parser.finish(), {
    answer: '美国站利润\n较好',
    proposal: { summary: '建议', changes: [] }
  });
});

test('withholds incomplete unicode escapes until all four hex digits arrive', () => {
  const parser = createStructuredAnswerStream();

  assert.equal(parser.push('{"answer":"A\\u4'), 'A');
  assert.equal(parser.push('F60","proposal":'), '你');
  assert.equal(parser.push('{}}'), '');
  assert.deepEqual(parser.finish(), { answer: 'A你', proposal: {} });
});

test('does not stream nested answer fields or proposal content', () => {
  const parser = createStructuredAnswerStream();

  assert.equal(parser.push('{"meta":{"answer":"ignore"},"answer":"keep"'), 'keep');
  assert.equal(parser.push(',"proposal":{"answer":"also ignore","summary":"hidden"}}'), '');
  assert.deepEqual(parser.finish(), {
    answer: 'keep',
    proposal: { answer: 'also ignore', summary: 'hidden' }
  });
});

test('finds an answer after top-level primitive fields', () => {
  const parser = createStructuredAnswerStream();

  assert.equal(parser.push('{"version":1,"answer":"found"'), 'found');
  assert.equal(parser.push(',"proposal":{}}'), '');
  assert.deepEqual(parser.finish(), { answer: 'found', proposal: {} });
});

test('rejects incomplete or invalid JSON without exposing raw structure', () => {
  const parser = createStructuredAnswerStream();

  assert.equal(parser.push('{"answer":"半截'), '半截');
  assert.throws(() => parser.finish(), /结构化输出不完整/);
});

test('rejects a final object without a string answer and object proposal', () => {
  for (const raw of [
    '{"answer":3,"proposal":{}}',
    '{"answer":"ok","proposal":null}',
    '{"answer":"ok","proposal":[]}'
  ]) {
    const parser = createStructuredAnswerStream();
    parser.push(raw);
    assert.throws(() => parser.finish(), /结构化输出/);
  }
});

test('rejects structured output larger than one megabyte', () => {
  const parser = createStructuredAnswerStream();

  assert.throws(() => parser.push('x'.repeat(1024 * 1024 + 1)), /超过 1 MB/);
});
