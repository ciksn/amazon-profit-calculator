BEGIN;

CREATE TABLE IF NOT EXISTS manual_dashboard_products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_name text NOT NULL,
  parent_asin text NOT NULL,
  child_asin text,
  product_name text NOT NULL,
  image_data text,
  length numeric,
  width numeric,
  height numeric,
  dimension_unit text NOT NULL DEFAULT 'cm',
  weight numeric,
  weight_unit text NOT NULL DEFAULT 'kg',
  cost_cny numeric,
  sales_amount_cny numeric NOT NULL DEFAULT 0,
  six_day_capacity numeric NOT NULL DEFAULT 0,
  source_project_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_name,parent_asin)
);

CREATE TABLE IF NOT EXISTS manual_dashboard_sites (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES manual_dashboard_products(id) ON DELETE CASCADE,
  country_code text NOT NULL,
  country_name text,
  currency text,
  symbol text,
  sale_price numeric,
  sales_qty numeric NOT NULL DEFAULT 0,
  unit_profit numeric,
  profit_rate numeric,
  calculation_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id,country_code)
);

CREATE INDEX IF NOT EXISTS idx_manual_products_owner ON manual_dashboard_products(owner_name);
CREATE INDEX IF NOT EXISTS idx_manual_products_sort ON manual_dashboard_products(sales_amount_cny,six_day_capacity);
CREATE INDEX IF NOT EXISTS idx_manual_sites_product ON manual_dashboard_sites(product_id);
CREATE INDEX IF NOT EXISTS idx_manual_sites_country ON manual_dashboard_sites(country_code);

COMMIT;
