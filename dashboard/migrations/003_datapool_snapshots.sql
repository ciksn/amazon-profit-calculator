BEGIN;

CREATE TABLE IF NOT EXISTS datapool_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',analysis_start_date date,analysis_end_date date,
  principal_count integer NOT NULL DEFAULT 0,seller_count integer NOT NULL DEFAULT 0,
  product_count integer NOT NULL DEFAULT 0,analysis_count integer NOT NULL DEFAULT 0,
  error_message text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS datapool_principals (
  sync_id bigint NOT NULL REFERENCES datapool_sync_runs(id),uid text NOT NULL,name text NOT NULL,raw jsonb NOT NULL,
  PRIMARY KEY(sync_id,uid)
);

CREATE TABLE IF NOT EXISTS datapool_sellers (
  sync_id bigint NOT NULL REFERENCES datapool_sync_runs(id),sid bigint NOT NULL,name text,country text,
  marketplace_id text,region text,status integer,raw jsonb NOT NULL,PRIMARY KEY(sync_id,sid)
);

CREATE TABLE IF NOT EXISTS datapool_products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,sync_id bigint NOT NULL REFERENCES datapool_sync_runs(id),
  sid bigint NOT NULL,asin text NOT NULL,parent_asin text,seller_sku text,fnsku text,item_name text,
  small_image_url text,principal_uid text,status integer,item_weight numeric,raw jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_datapool_products_sync_asin ON datapool_products(sync_id,asin);
CREATE INDEX IF NOT EXISTS idx_datapool_products_sync_owner ON datapool_products(sync_id,principal_uid);

CREATE TABLE IF NOT EXISTS datapool_analysis_products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,sync_id bigint NOT NULL REFERENCES datapool_sync_runs(id),
  sid bigint,asin text,product_name text,owner_name text,image_url text,country text,
  gross_profit numeric,gross_rate numeric,total_sales numeric,purchase_unit_price numeric,
  head_unit_price numeric,raw jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_datapool_analysis_sync_asin ON datapool_analysis_products(sync_id,asin);
CREATE INDEX IF NOT EXISTS idx_datapool_analysis_sync_owner ON datapool_analysis_products(sync_id,owner_name);

CREATE TABLE IF NOT EXISTS datapool_raw_snapshots (
  sync_id bigint NOT NULL REFERENCES datapool_sync_runs(id),endpoint text NOT NULL,request_key text NOT NULL,
  response jsonb NOT NULL,fetched_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(sync_id,endpoint,request_key)
);

DROP VIEW IF EXISTS dashboard_product_sites_v;
CREATE VIEW dashboard_product_sites_v AS
WITH latest AS (
  SELECT id FROM datapool_sync_runs WHERE status='completed' ORDER BY finished_at DESC NULLS LAST,id DESC LIMIT 1
), products AS (
  SELECT DISTINCT ON (p.sid,p.asin)
    p.sid,p.asin,p.item_name,p.small_image_url,p.principal_uid,p.item_weight
  FROM datapool_products p JOIN latest l ON l.id=p.sync_id
  ORDER BY p.sid,p.asin,p.id
), analysis AS (
  SELECT DISTINCT ON (a.sid,a.asin)
    a.sid,a.asin,a.product_name,a.owner_name,a.image_url,a.country,a.gross_profit,a.gross_rate,
    a.total_sales,a.purchase_unit_price,a.head_unit_price
  FROM datapool_analysis_products a JOIN latest l ON l.id=a.sync_id
  WHERE a.asin IS NOT NULL
  ORDER BY a.sid,a.asin,a.id DESC
)
SELECT
  COALESCE(a.asin,p.asin)::text AS asin,
  COALESCE(NULLIF(a.owner_name,''),pr.name,'未分配')::text AS owner_name,
  COALESCE(NULLIF(a.product_name,''),p.item_name,COALESCE(a.asin,p.asin))::text AS product_name,
  COALESCE(NULLIF(a.image_url,''),p.small_image_url)::text AS image_url,
  NULL::numeric AS length_cm,NULL::numeric AS width_cm,NULL::numeric AS height_cm,
  NULL::numeric AS weight_kg,a.purchase_unit_price::numeric AS cost_cny,
  COALESCE(NULLIF(a.country,''),s.country,'')::text AS country_code,
  NULL::numeric AS sale_price,NULL::text AS category_text,NULL::numeric AS referral_rate_override,
  NULL::numeric AS declaration_ratio,NULL::numeric AS declared_value_override,
  NULL::numeric AS customs_rate,NULL::numeric AS consumption_tax_rate,
  a.gross_rate::numeric AS source_profit_rate,a.gross_profit::numeric AS source_profit,
  a.total_sales::numeric AS source_total_sales,a.head_unit_price::numeric AS source_head_unit_price,
  p.item_weight::numeric AS source_item_weight
FROM analysis a
FULL JOIN products p ON p.sid=a.sid AND p.asin=a.asin
LEFT JOIN latest l ON true
LEFT JOIN datapool_sellers s ON s.sync_id=l.id AND s.sid=COALESCE(a.sid,p.sid)
LEFT JOIN datapool_principals pr ON pr.sync_id=l.id AND pr.uid=p.principal_uid
WHERE COALESCE(a.asin,p.asin) IS NOT NULL AND COALESCE(NULLIF(a.country,''),s.country,'') <> '';

COMMIT;
