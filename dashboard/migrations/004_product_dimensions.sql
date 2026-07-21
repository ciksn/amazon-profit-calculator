BEGIN;

ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS listing_price numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS package_weight numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS package_weight_unit text;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS weight_kg numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS weight_lb numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS weight_g numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS package_length numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS package_width numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS package_height numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS package_dim_unit text;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS length_cm numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS width_cm numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS height_cm numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS length_in numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS width_in numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS height_in numeric;
ALTER TABLE datapool_products ADD COLUMN IF NOT EXISTS volume_cm3 numeric;
ALTER TABLE datapool_analysis_products ADD COLUMN IF NOT EXISTS total_qty numeric;
UPDATE datapool_analysis_products
SET total_qty=(raw->>'总销量')::numeric
WHERE total_qty IS NULL AND COALESCE(raw->>'总销量','') ~ '^-?[0-9]+([.][0-9]+)?$';

DROP VIEW IF EXISTS dashboard_product_sites_v;
CREATE VIEW dashboard_product_sites_v AS
WITH latest AS (
  SELECT id FROM datapool_sync_runs WHERE status='completed' ORDER BY finished_at DESC NULLS LAST,id DESC LIMIT 1
), products AS (
  SELECT DISTINCT ON (p.sid,p.asin)
    p.sid,p.asin,p.parent_asin,p.item_name,p.small_image_url,p.principal_uid,p.category,p.listing_price,p.currency,
    p.weight_kg,p.length_cm,p.width_cm,p.height_cm,p.package_weight,p.package_weight_unit,
    p.package_length,p.package_width,p.package_height,p.package_dim_unit,p.volume_cm3
  FROM datapool_products p JOIN latest l ON l.id=p.sync_id
  ORDER BY p.sid,p.asin,p.id
), analysis AS (
  SELECT DISTINCT ON (a.sid,a.asin)
    a.sid,a.asin,a.product_name,a.owner_name,a.image_url,a.country,a.gross_profit,a.gross_rate,
    a.total_sales,a.total_qty,a.purchase_unit_price,a.head_unit_price
  FROM datapool_analysis_products a JOIN latest l ON l.id=a.sync_id
  WHERE a.asin IS NOT NULL
  ORDER BY a.sid,a.asin,a.id DESC
)
SELECT
  COALESCE(a.asin,p.asin)::text AS asin,
  COALESCE(NULLIF(p.parent_asin,''),a.asin,p.asin)::text AS parent_asin,
  COALESCE(NULLIF(a.owner_name,''),pr.name,'未分配')::text AS owner_name,
  COALESCE(NULLIF(a.product_name,''),p.item_name,COALESCE(a.asin,p.asin))::text AS product_name,
  COALESCE(NULLIF(a.image_url,''),p.small_image_url)::text AS image_url,
  p.length_cm::numeric AS length_cm,p.width_cm::numeric AS width_cm,p.height_cm::numeric AS height_cm,
  p.weight_kg::numeric AS weight_kg,a.purchase_unit_price::numeric AS cost_cny,
  COALESCE(NULLIF(a.country,''),s.country,'')::text AS country_code,
  p.listing_price::numeric AS sale_price,p.category::text AS category_text,NULL::numeric AS referral_rate_override,
  NULL::numeric AS declaration_ratio,NULL::numeric AS declared_value_override,
  NULL::numeric AS customs_rate,NULL::numeric AS consumption_tax_rate,
  a.gross_rate::numeric AS source_profit_rate,a.gross_profit::numeric AS source_profit,
  a.total_sales::numeric AS source_total_sales,a.total_qty::numeric AS source_total_qty,
  a.head_unit_price::numeric AS source_head_unit_price,
  p.package_weight::numeric AS source_item_weight,p.package_weight_unit::text AS source_weight_unit,
  p.package_dim_unit::text AS source_dimension_unit,p.currency::text AS source_listing_currency,
  p.volume_cm3::numeric AS source_volume_cm3
FROM analysis a
FULL JOIN products p ON p.sid=a.sid AND p.asin=a.asin
LEFT JOIN latest l ON true
LEFT JOIN datapool_sellers s ON s.sync_id=l.id AND s.sid=COALESCE(a.sid,p.sid)
LEFT JOIN datapool_principals pr ON pr.sync_id=l.id AND pr.uid=p.principal_uid
WHERE COALESCE(a.asin,p.asin) IS NOT NULL AND COALESCE(NULLIF(a.country,''),s.country,'') <> '';

COMMIT;
