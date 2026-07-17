(function exposeDimensionParser(root,factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DimensionParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this,() => {
  'use strict';

  const unitPattern = /millimeters?|centimeters?|centimetres?|met(?:er|re)s?|feet|foot|ft|inches?|inch|in|mm|cm|毫米|厘米|英尺|英寸|米/gi;

  function detectUnit(text,fallbackUnit) {
    const value = String(text).toLowerCase();
    if (/millimeters?|\bmm\b|毫米/i.test(value)) return { unit:'cm',factor:0.1 };
    if (/centimeters?|centimetres?|\bcm\b|厘米/i.test(value)) return { unit:'cm',factor:1 };
    if (/\bmet(?:er|re)s?\b|(?<!厘|毫)米/i.test(value)) return { unit:'cm',factor:100 };
    if (/\b(?:feet|foot|ft)\b|英尺/i.test(value)) return { unit:'ft',factor:1 };
    if (/\b(?:inches?|inch|in)\b|英寸/i.test(value)) return { unit:'cm',factor:2.54 };
    return { unit:fallbackUnit === 'ft' ? 'ft' : 'cm',factor:1 };
  }

  function round(value) {
    return Math.round((value + Number.EPSILON) * 10000) / 10000;
  }

  function parseDimensions(input,fallbackUnit='cm') {
    const source = String(input ?? '').trim();
    if (!source) return null;
    const detected = detectUnit(source,fallbackUnit);
    const normalized = source
      .replace(/(\d),(\d)/g,'$1.$2')
      .replace(unitPattern,' ')
      .replace(/(\d+(?:\.\d+)?)\s*[dwhl](?=\s*(?:[×xX＊*]|$))/gi,'$1')
      .replace(/[×xX＊]/g,'*')
      .replace(/\\?\*+/g,'*');
    const chains = normalized.match(/\d+(?:\.\d+)?(?:\s*\*\s*\d+(?:\.\d+)?){2,}/g) || [];
    const numbers = chains.map((chain) => chain.match(/\d+(?:\.\d+)?/g)).find((items) => items.length === 3);
    if (!numbers) return null;
    const values = numbers.map((value) => round(Number(value) * detected.factor));
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) return null;
    return { length:values[0],width:values[1],height:values[2],unit:detected.unit };
  }

  return { parseDimensions };
});
