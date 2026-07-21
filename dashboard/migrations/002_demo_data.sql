-- 可选本地联调数据。生产环境不要执行本文件。
INSERT INTO dashboard_product_sites_source
  (asin,owner_name,product_name,image_url,length_cm,width_cm,height_cm,weight_kg,cost_cny,country_code,sale_price,category_text)
VALUES
  ('B0DEMO0001','测试负责人','可折叠桌面收纳架','',32,22,8,0.82,48.5,'US',29.99,'Home & Kitchen'),
  ('B0DEMO0001','测试负责人','可折叠桌面收纳架','',32,22,8,0.82,48.5,'AU',39.99,'Home & Kitchen'),
  ('B0DEMO0002','测试负责人','便携式电子配件包','',20,14,5,0.28,22,'GB',18.99,'Electronics Accessories')
ON CONFLICT (asin,country_code) DO UPDATE SET
  owner_name=excluded.owner_name,product_name=excluded.product_name,image_url=excluded.image_url,
  length_cm=excluded.length_cm,width_cm=excluded.width_cm,height_cm=excluded.height_cm,
  weight_kg=excluded.weight_kg,cost_cny=excluded.cost_cny,sale_price=excluded.sale_price,category_text=excluded.category_text;
