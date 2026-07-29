'use strict';

const MAX_RAW_BYTES = 1024 * 1024;

function createStructuredAnswerStream() {
  let raw = '';
  let rawBytes = 0;
  let depth = 0;
  let rootState = 'start';
  let rootKey = null;
  let stringKind = null;
  let stringRaw = '';
  let escapeState = null;
  let unicodeDigits = '';

  function finishRootValue() {
    if (depth === 1) rootState = 'commaOrEnd';
  }

  function closeString() {
    if (stringKind === 'rootKey') {
      try {
        rootKey = JSON.parse(`"${stringRaw}"`);
        rootState = 'colon';
      } catch {
        rootState = 'invalid';
      }
    } else if (stringKind === 'answer') {
      finishRootValue();
    } else if (stringKind === 'rootValue') {
      finishRootValue();
    }
    stringKind = null;
    stringRaw = '';
    escapeState = null;
    unicodeDigits = '';
  }

  function readStringCharacter(character, output) {
    if (escapeState === 'unicode') {
      stringRaw += character;
      unicodeDigits += character;
      if (unicodeDigits.length === 4) {
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits) && stringKind === 'answer') {
          output.push(String.fromCharCode(Number.parseInt(unicodeDigits, 16)));
        }
        escapeState = null;
        unicodeDigits = '';
      }
      return;
    }

    if (escapeState === 'escape') {
      stringRaw += character;
      if (character === 'u') {
        escapeState = 'unicode';
        return;
      }
      const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/' };
      if (stringKind === 'answer' && Object.hasOwn(escapes, character)) output.push(escapes[character]);
      escapeState = null;
      return;
    }

    if (character === '\\') {
      stringRaw += character;
      escapeState = 'escape';
      return;
    }
    if (character === '"') {
      closeString();
      return;
    }
    stringRaw += character;
    if (stringKind === 'answer') output.push(character);
  }

  function push(delta) {
    if (typeof delta !== 'string') throw new TypeError('Structured output delta must be a string');
    const deltaBytes = Buffer.byteLength(delta);
    if (rawBytes + deltaBytes > MAX_RAW_BYTES) throw new Error('结构化输出超过 1 MB');
    raw += delta;
    rawBytes += deltaBytes;

    const output = [];
    for (const character of delta) {
      if (stringKind) {
        readStringCharacter(character, output);
        continue;
      }
      if (/\s/.test(character)) continue;

      if (character === '"') {
        if (depth === 1 && rootState === 'keyOrEnd') stringKind = 'rootKey';
        else if (depth === 1 && rootState === 'value' && rootKey === 'answer') stringKind = 'answer';
        else stringKind = depth === 1 && rootState === 'value' ? 'rootValue' : 'other';
        continue;
      }

      if (character === '{' || character === '[') {
        depth += 1;
        if (depth === 1 && character === '{') rootState = 'keyOrEnd';
        continue;
      }
      if (character === '}' || character === ']') {
        depth -= 1;
        if (depth === 0) rootState = 'done';
        else if (depth === 1 && rootState === 'value') finishRootValue();
        continue;
      }
      if (depth !== 1) continue;
      if (character === ':' && rootState === 'colon') {
        rootState = 'value';
      } else if (character === ',' && (rootState === 'commaOrEnd' || rootState === 'primitive')) {
        rootState = 'keyOrEnd';
        rootKey = null;
      } else if (rootState === 'value') {
        rootState = 'primitive';
      }
    }
    return output.join('');
  }

  function finish() {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('结构化输出不完整或无效');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.answer !== 'string'
      || !parsed.proposal || typeof parsed.proposal !== 'object' || Array.isArray(parsed.proposal)) {
      throw new Error('结构化输出格式无效');
    }
    return { answer: parsed.answer, proposal: parsed.proposal };
  }

  return { push, finish };
}

module.exports = { createStructuredAnswerStream };
