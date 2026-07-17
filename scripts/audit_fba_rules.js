'use strict';

const db = require('../lib/db');

const countries = db.prepare('SELECT code,name FROM countries WHERE active=1 ORDER BY priority').all();
for (const country of countries) {
  const tiers = db.prepare('SELECT tier_code,tier_name,max_item_weight_kg FROM size_tiers WHERE country_code=? ORDER BY id').all(country.code);
  const rules = db.prepare('SELECT size_tier,size_name,max_weight_kg,min_price,max_price,category_group FROM fba_rules WHERE country_code=? ORDER BY size_tier,min_price,category_group,max_weight_kg').all(country.code);
  const unmapped = rules.filter((rule) => !rule.size_tier);
  const missing = tiers.filter((tier) => !rules.some((rule) => rule.size_tier === tier.tier_code));
  console.log(`\n${country.code} ${country.name}: ${tiers.length} 个尺寸段 / ${rules.length} 条费阶`);
  if (unmapped.length) console.log(`  未映射规则: ${unmapped.map((rule) => rule.size_name).join(', ')}`);
  if (missing.length) console.log(`  无费率尺寸段: ${missing.map((tier) => tier.tier_name).join(', ')}`);
  for (const tier of tiers) {
    const tierRules = rules.filter((rule) => rule.size_tier === tier.tier_code);
    const groups = new Map();
    for (const rule of tierRules) {
      const key = `${rule.min_price ?? '-∞'}..${rule.max_price ?? '∞'} / ${rule.category_group}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(Number(rule.max_weight_kg));
    }
    const summary = [...groups.entries()].map(([key, weights]) => `${key}: ${[...new Set(weights)].join(',')}`).join(' | ');
    console.log(`  ${tier.tier_code} (${tier.tier_name}, 上限${tier.max_item_weight_kg}kg): ${summary || '无规则'}`);
  }
}

db.close();
