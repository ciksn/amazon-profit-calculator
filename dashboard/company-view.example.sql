-- 请由 DBA 按公司真实表名改写。后端只读此视图，不会更新公司产品数据。
-- 每行代表一个 ASIN 在一个亚马逊站点的当前数据。
CREATE OR REPLACE VIEW dashboard_product_sites_v AS
SELECT
  p.asin::text                                      AS asin,
  e.name::text                                      AS owner_name,
  p.product_name::text                              AS product_name,
  p.image_url::text                                 AS image_url,
  p.length_cm::numeric                              AS length_cm,
  p.width_cm::numeric                               AS width_cm,
  p.height_cm::numeric                              AS height_cm,
  p.weight_kg::numeric                              AS weight_kg,
  p.cost_cny::numeric                               AS cost_cny,
  s.country_code::text                              AS country_code,
  s.sale_price::numeric                             AS sale_price,
  s.category_text::text                             AS category_text,
  s.referral_rate_override::numeric                 AS referral_rate_override,
  s.declaration_ratio::numeric                      AS declaration_ratio,
  s.declared_value_override::numeric                AS declared_value_override,
  s.customs_rate::numeric                           AS customs_rate,
  s.consumption_tax_rate::numeric                   AS consumption_tax_rate
FROM company_products p
JOIN company_employees e ON e.id = p.owner_id
JOIN company_product_sites s ON s.product_id = p.id
WHERE p.asin IS NOT NULL;

-- 若某个可选字段在公司库不存在，请用 NULL::numeric / NULL::text 占位。
-- 页面不会展示 NULL 字段；利润计算必需字段缺失时，该站点显示“数据不完整”。
