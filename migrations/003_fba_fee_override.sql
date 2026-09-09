ALTER TABLE project_countries
  ADD COLUMN IF NOT EXISTS fba_fee_override DOUBLE PRECISION;

