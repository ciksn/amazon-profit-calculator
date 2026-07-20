'use strict';
(() => {
const FREIGHT_VOLUME_DIVISOR = 6000;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function normalizeDimensions(project) {
  const factor = project.dimension_unit === 'ft' ? 30.48 : 1;
  return [project.length * factor, project.width * factor, project.height * factor]
    .map((value) => Number(value) || 0)
    .sort((a, b) => b - a);
}

function normalizeWeight(project) {
  const weight = Number(project.weight) || 0;
  return project.weight_unit === 'lb' ? weight * 0.45359237 : weight;
}

function selectFbaRule(rules, dimensions, billableWeight) {
  const [longest, middle, shortest] = dimensions;
  const total = longest + middle + shortest;
  const sorted = [...rules].sort((a, b) =>
    Number(a.max_long_cm) * Number(a.max_mid_cm) * Number(a.max_short_cm) - Number(b.max_long_cm) * Number(b.max_mid_cm) * Number(b.max_short_cm) ||
    Number(a.max_total_cm || Infinity) - Number(b.max_total_cm || Infinity) ||
    Number(a.max_weight_kg) - Number(b.max_weight_kg)
  );
  const matched = sorted.find((rule) =>
    longest <= Number(rule.max_long_cm) &&
    middle <= Number(rule.max_mid_cm) &&
    shortest <= Number(rule.max_short_cm) &&
    (!Number(rule.max_total_cm) || total <= Number(rule.max_total_cm)) &&
    billableWeight <= Number(rule.max_weight_kg)
  );
  return { rule: matched || sorted.at(-1) || null, fallback: Boolean(!matched && sorted.length) };
}

function dimensionMetric(tier, dimensions) {
  const [longest,middle,shortest] = dimensions;
  if (tier.dimension_mode === 'length_girth' || tier.dimension_mode === 'oversize') return longest + 2 * (middle + shortest);
  return longest + middle + shortest;
}

function selectSizeTier(tiers, dimensions, actualWeightKg, volumeWeightKg) {
  const [longest,middle,shortest] = dimensions;
  const sorted=[...tiers].sort((a,b) =>
    Number(a.max_long_cm)*Number(a.max_mid_cm)*Number(a.max_short_cm)-Number(b.max_long_cm)*Number(b.max_mid_cm)*Number(b.max_short_cm) ||
    Number(a.max_item_weight_kg)-Number(b.max_item_weight_kg)
  );
  const matched=sorted.find((tier) => {
    const classWeight=tier.class_weight_mode === 'max' ? Math.max(actualWeightKg,volumeWeightKg) : actualWeightKg;
    const totalOk=!Number(tier.max_total_cm) || dimensionMetric(tier,dimensions) <= Number(tier.max_total_cm);
    const minActualOk=!Number(tier.min_item_weight_kg) || actualWeightKg>Number(tier.min_item_weight_kg);
    const volumeOk=!Number(tier.max_volume_weight_kg) || volumeWeightKg<=Number(tier.max_volume_weight_kg);
    return longest<=Number(tier.max_long_cm) && middle<=Number(tier.max_mid_cm) && shortest<=Number(tier.max_short_cm) && classWeight<=Number(tier.max_item_weight_kg) && minActualOk && volumeOk && totalOk;
  });
  return { tier:matched || sorted.at(-1) || null, fallback:Boolean(!matched && sorted.length) };
}

function isEuActualWeightCategory(categoryText) {
  return /(apparel|clothing|accessories|footwear|shoes|backpack|handbag|luggage accessories|grocery|gourmet|mattress|rug|linen|pet clothing|pet food|stroller|pushchair|safety equipment|door accessories|window accessories|shower accessories|eyewear|adhesive|cable tie|packaging material|printer accessories|scanner accessories|work gloves|safety gloves|服装|配饰|鞋|背包|手提包|箱包配件|杂货|美食|床垫|地毯|家用亚麻布|宠物服装|宠物食品|婴儿推车|安全设备|门窗|淋浴配件|眼镜防护|粘合剂|扎带|包装材料|打印机配件|扫描仪配件|工作手套|安全手套)/i.test(String(categoryText || ''));
}

function resolveFeeWeight(tier, listing, actualWeightKg, maxWeightKg) {
  if (!tier || tier.fee_weight_mode === 'actual') return actualWeightKg;
  if (tier.fee_weight_mode === 'eu_category') {
    return isEuActualWeightCategory(listing.category_text || listing.matched_category) ? actualWeightKg : maxWeightKg;
  }
  return maxWeightKg;
}

function categoryScore(group, categoryText) {
  const text=String(categoryText || '').toLowerCase();
  const apparel=/(apparel|clothing|服装|衣服|鞋服)/.test(text);
  if (!group || group === 'all') return 0;
  if (group === 'apparel') return apparel ? 3 : -1;
  if (group === 'non_apparel') return apparel ? -1 : 1;
  const low=/(home|kitchen|家居|厨房|pet|宠物)/.test(text);
  const mid=low || /(furniture|家具|grocery|food|食品|杂货|sports|outdoor|运动|户外)/.test(text);
  if (group === 'au_low_special') return low ? 4 : -1;
  if (group === 'au_mid_special') return mid ? 4 : -1;
  return -1;
}

function selectStrictFbaRule(rules, tier, listing, billableWeight) {
  const price=Number(listing.sale_price) || 0;
  const candidates=rules.filter((rule) => {
    if (rule.size_tier !== tier.tier_code) return false;
    if (rule.min_price != null && price < Number(rule.min_price)) return false;
    if (rule.max_price != null && price > Number(rule.max_price)) return false;
    return categoryScore(rule.category_group, listing.category_text || listing.matched_category) >= 0;
  }).sort((a,b) =>
    categoryScore(b.category_group,listing.category_text || listing.matched_category)-categoryScore(a.category_group,listing.category_text || listing.matched_category) ||
    Number(a.max_weight_kg)-Number(b.max_weight_kg)
  );
  const matched=candidates.find((rule)=>billableWeight<=Number(rule.max_weight_kg));
  return { rule:matched || candidates.at(-1) || null, fallback:Boolean(!matched && candidates.length) };
}

function calculateProfit({ project, country, listing, fbaRules = [], sizeTiers = [], freightRule = null }) {
  const price = Number(listing.sale_price) || 0;
  const cnyPerLocal = Number(country.cny_per_local) || 1;
  const vatRate = Number(country.vat_rate) || 0;
  const taxRate = Number(country.tax_rate) || 0;
  const taxBasis = country.tax_basis || 'none';
  const hasReferralOverride = listing.referral_rate_override !== null && listing.referral_rate_override !== undefined;
  const referralBaseRate = Number(hasReferralOverride ? listing.referral_rate_override : (listing.matched_referral_rate ?? 15)) || 0;
  const dimensions = normalizeDimensions(project);
  const actualWeightKg = normalizeWeight(project);
  const volumeCm3 = dimensions.reduce((acc, value) => acc * value, 1);
  const volumeCbm = volumeCm3 / 1_000_000;
  const freightDivisor = FREIGHT_VOLUME_DIVISOR;
  const volumeWeightKg = volumeCm3 / freightDivisor;
  const billableWeightKg = Math.max(actualWeightKg, volumeWeightKg);
  const fbaVolumeDivisor = Number(country.fba_volume_divisor) || 6000;
  const fbaVolumeWeightKg = volumeCm3 / fbaVolumeDivisor;
  const fbaBillableWeightKg = Math.max(actualWeightKg, fbaVolumeWeightKg);

  const tierResult=sizeTiers.length ? selectSizeTier(sizeTiers,dimensions,actualWeightKg,fbaVolumeWeightKg) : {tier:null,fallback:false};
  const strictBillableWeight=resolveFeeWeight(tierResult.tier,listing,actualWeightKg,fbaBillableWeightKg);
  const feeResult=tierResult.tier
    ? selectStrictFbaRule(fbaRules,tierResult.tier,listing,strictBillableWeight)
    : selectFbaRule(fbaRules, dimensions, fbaBillableWeightKg);
  const fbaRule=feeResult.rule;
  const fallback=tierResult.fallback || feeResult.fallback;
  const appliedFbaWeight=tierResult.tier ? strictBillableWeight : fbaBillableWeightKg;
  let fbaFee = 0;
  let fbaBaseFee = 0;
  let fbaSurchargeFee = 0;
  if (fbaRule) {
    let extraWeight = Math.max(0, appliedFbaWeight - Number(fbaRule.included_weight_kg || 0));
    const increment=Number(fbaRule.weight_increment_kg || 0);
    if (increment && extraWeight) extraWeight=Math.ceil((extraWeight-1e-12)/increment)*increment;
    fbaBaseFee = Number(fbaRule.base_fee || 0) + extraWeight * Number(fbaRule.per_kg_fee || 0);
    fbaSurchargeFee = fbaBaseFee * Number(fbaRule.surcharge_rate || 0) / 100;
    fbaFee = fbaBaseFee + fbaSurchargeFee;
  }

  const freightMode = freightRule?.pricing_mode || 'kg';
  const freightCny = freightRule
    ? Math.max(
      Number(freightRule.min_charge_cny || 0),
      freightMode === 'cbm'
        ? volumeCbm * Number(freightRule.price_per_cbm_cny || 0)
        : billableWeightKg * Number(freightRule.price_per_kg_cny || 0)
    ) : 0;
  const productCostLocal = Number(project.cost_cny || 0) / cnyPerLocal;
  const freightLocal = freightCny / cnyPerLocal;
  const vatAmount = vatRate > 0 ? price - price / (1 + vatRate / 100) : 0;
  const declarationRatio = Number(listing.declaration_ratio ?? 0.15);
  const hasDeclaredValueOverride = listing.declared_value_override !== null && listing.declared_value_override !== undefined && listing.declared_value_override !== '';
  const declaredValue = hasDeclaredValueOverride ? Math.max(0,Number(listing.declared_value_override) || 0) : price * declarationRatio;
  const customsRate = Number(listing.customs_rate ?? 0);
  const consumptionTaxRate = Number(listing.consumption_tax_rate ?? 10);
  const customsDuty = taxBasis === 'japan_import' ? declaredValue * customsRate / 100 : 0;
  const consumptionTax = taxBasis === 'japan_import' ? (declaredValue + customsDuty) * consumptionTaxRate / 100 : 0;
  const taxFee = taxBasis === 'japan_import'
    ? customsDuty + consumptionTax
    : taxBasis === 'sale'
      ? price * taxRate / 100
      : taxBasis === 'cost'
        ? productCostLocal * taxRate / 100
        : 0;
  const netRevenue = price - vatAmount;
  const threshold = hasReferralOverride ? null : Number(listing.matched_referral_threshold) || null;
  const rateAbove = hasReferralOverride ? null : Number(listing.matched_referral_rate_above) || null;
  const referralMinimum = hasReferralOverride ? 0 : Number(listing.matched_referral_minimum) || 0;
  const calculatedReferral = threshold && rateAbove != null
    ? Math.min(price,threshold) * referralBaseRate / 100 + Math.max(0,price-threshold) * rateAbove / 100
    : price * referralBaseRate / 100;
  const referralFee = price > 0 ? Math.max(calculatedReferral,referralMinimum) : 0;
  const referralRate = price > 0 ? referralFee / price * 100 : referralBaseRate;
  const profit = netRevenue - taxFee - referralFee - fbaFee - freightLocal - productCostLocal;
  const profitRate = price > 0 ? profit / price * 100 : 0;

  const warnings = [];
  if (!price) warnings.push('请填写售价');
  if (!fbaRule) warnings.push('暂无可用 FBA 规则');
  if (fallback) warnings.push('尺寸或重量超出已维护费阶，暂按最大费阶估算');
  if (fbaRule?.status !== 'verified') warnings.push('FBA 费阶为待核验估算值');
  const freightRate = freightMode === 'cbm' ? Number(freightRule?.price_per_cbm_cny) : Number(freightRule?.price_per_kg_cny);
  if (!freightRule || !freightRate) warnings.push('头程运费尚未维护，当前按 0 计算');
  if (taxBasis === 'japan_import' && customsRate === 0) warnings.push('日本关税比例当前为 0%，请确认该品类是否免税');
  if (country.tax_note?.includes('省份')) warnings.push('税率会因省份变化，请在后台按销售目的地调整');
  if (country.tax_note?.includes('待确认')) warnings.push('该站点税费比例待确认，当前按 0 计算');

  return {
    country_code: country.code,
    currency: country.currency,
    symbol: country.symbol,
    sale_price: round(price),
    net_revenue: round(netRevenue),
    vat_amount: round(vatAmount),
    vat_rate: round(vatRate),
    tax_rate: round(taxRate),
    tax_basis: taxBasis,
    tax_label: country.tax_label || '税费',
    tax_fee: round(taxFee),
    declaration_ratio: round(declarationRatio * 100),
    declared_value: round(declaredValue),
    declared_value_overridden: hasDeclaredValueOverride,
    customs_rate: round(customsRate),
    customs_duty: round(customsDuty),
    consumption_tax_rate: round(consumptionTaxRate),
    consumption_tax: round(consumptionTax),
    referral_rate: round(referralRate),
    referral_base_rate: round(referralBaseRate),
    referral_rate_above: rateAbove == null ? null : round(rateAbove),
    referral_threshold: threshold == null ? null : round(threshold),
    referral_minimum: round(referralMinimum),
    referral_fee: round(referralFee),
    fba_fee: round(fbaFee),
    fba_base_fee: round(fbaBaseFee),
    fba_surcharge_rate: round(Number(fbaRule?.surcharge_rate || 0)),
    fba_surcharge_fee: round(fbaSurchargeFee),
    freight_fee: round(freightLocal),
    product_cost: round(productCostLocal),
    profit: round(profit),
    profit_rate: round(profitRate),
    actual_weight_kg: round(actualWeightKg, 3),
    volume_weight_kg: round(volumeWeightKg, 3),
    volume_cbm: round(volumeCbm, 6),
    billable_weight_kg: round(billableWeightKg, 3),
    freight_volume_divisor: freightDivisor,
    fba_volume_weight_kg: round(fbaVolumeWeightKg, 3),
    fba_billable_weight_kg: round(appliedFbaWeight, 3),
    fba_volume_divisor: fbaVolumeDivisor,
    freight_pricing_mode: freightMode,
    fba_rule_name: fbaRule?.size_name || '未匹配',
    size_tier_code: tierResult.tier?.tier_code || fbaRule?.size_tier || '',
    size_tier_name: tierResult.tier?.tier_name || fbaRule?.size_name?.replace(/\s*[≤>].*$/,'') || '未匹配',
    dimensions_cm: dimensions.map((value)=>round(value,2)),
    warnings
  };
}

function findSalePriceForProfitRate({ project, country, listing, fbaRules = [], sizeTiers = [], freightRule = null, targetRate = 0 }) {
  const target = Number(targetRate) || 0;
  const calculateAt = (salePrice) => calculateProfit({
    project,country,listing:{ ...listing,sale_price:salePrice },fbaRules,sizeTiers,freightRule
  });
  let low = 0.01;
  let high = Math.max(1,Number(listing.sale_price) || 1);
  let highResult = calculateAt(high);
  while (highResult.profit_rate < target && high < 10_000_000) {
    low = high;
    high *= 2;
    highResult = calculateAt(high);
  }
  if (highResult.profit_rate < target) return null;
  for (let index = 0;index < 60;index += 1) {
    const middle = (low + high) / 2;
    if (calculateAt(middle).profit_rate >= target) high = middle;
    else low = middle;
  }
  return round(Math.ceil((high - 1e-9) * 100) / 100,2);
}

window.MarginGoProfit = { calculateProfit, findSalePriceForProfitRate, normalizeDimensions, normalizeWeight, selectFbaRule, selectSizeTier, selectStrictFbaRule };
})();
