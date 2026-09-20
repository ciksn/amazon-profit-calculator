CREATE TABLE site_card_variants (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL,
  name TEXT NOT NULL DEFAULT '默认变体',
  cost_cny DOUBLE PRECISION NOT NULL DEFAULT 0,
  length DOUBLE PRECISION NOT NULL DEFAULT 0,
  width DOUBLE PRECISION NOT NULL DEFAULT 0,
  height DOUBLE PRECISION NOT NULL DEFAULT 0,
  dimension_unit TEXT NOT NULL DEFAULT 'cm',
  weight DOUBLE PRECISION NOT NULL DEFAULT 0,
  weight_unit TEXT NOT NULL DEFAULT 'kg',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_site_card_variants_scope ON site_card_variants(project_id,owner_user_id,sort_order,id);

CREATE TABLE site_card_variant_listings (
  variant_id INTEGER NOT NULL REFERENCES site_card_variants(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL,
  country_code TEXT NOT NULL REFERENCES countries(code),
  sale_price DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(variant_id,country_code)
);
CREATE INDEX idx_site_card_variant_listings_scope ON site_card_variant_listings(project_id,country_code,owner_user_id);

ALTER TABLE site_card_records ADD COLUMN IF NOT EXISTS variant_id INTEGER REFERENCES site_card_variants(id) ON DELETE SET NULL;
ALTER TABLE site_card_records ADD COLUMN IF NOT EXISTS variant_name TEXT NOT NULL DEFAULT '';
