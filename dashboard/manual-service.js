'use strict';

function text(value,max = 500) {
  const result=String(value ?? '').trim();
  return result ? result.slice(0,max) : '';
}

function number(value,{ min=null,max=null,nullable=true } = {}) {
  if (value === '' || value === null || value === undefined) return nullable ? null : 0;
  const result=Number(value);
  if (!Number.isFinite(result)) throw new Error('数值字段格式不正确');
  if (min != null && result < min) throw new Error(`数值不能小于 ${min}`);
  if (max != null && result > max) throw new Error(`数值不能大于 ${max}`);
  return result;
}

function normalizeSite(input,index) {
  const countryCode=text(input.country_code,8).toUpperCase();
  if (!countryCode) throw new Error(`第 ${index + 1} 个站点缺少站点代码`);
  return {
    country_code:countryCode,country_name:text(input.country_name,80),currency:text(input.currency,12).toUpperCase(),
    symbol:text(input.symbol,8),sale_price:number(input.sale_price,{ min:0 }),sales_qty:number(input.sales_qty,{ min:0,nullable:false }),
    unit_profit:number(input.unit_profit),profit_rate:number(input.profit_rate),calculation_json:input.calculation_json || null
  };
}

function normalizeProduct(input) {
  const ownerName=text(input.owner_name,80);
  const parentAsin=text(input.parent_asin,32).toUpperCase();
  const productName=text(input.product_name,300);
  if (!ownerName) throw new Error('请填写负责人');
  if (!parentAsin) throw new Error('请填写父 ASIN；没有父 ASIN 时填写子 ASIN');
  if (!productName) throw new Error('请填写品名');
  const sites=Array.isArray(input.sites) ? input.sites.map(normalizeSite) : [];
  const seen=new Set();
  for (const site of sites) {
    if (seen.has(site.country_code)) throw new Error(`站点 ${site.country_code} 重复`);
    seen.add(site.country_code);
  }
  return {
    owner_name:ownerName,parent_asin:parentAsin,child_asin:text(input.child_asin,32).toUpperCase() || null,
    product_name:productName,image_data:text(input.image_data,2_000_000) || null,
    length:number(input.length,{ min:0 }),width:number(input.width,{ min:0 }),height:number(input.height,{ min:0 }),
    dimension_unit:['cm','ft'].includes(text(input.dimension_unit,4).toLowerCase()) ? text(input.dimension_unit,4).toLowerCase() : 'cm',
    weight:number(input.weight,{ min:0 }),weight_unit:['kg','lb'].includes(text(input.weight_unit,4).toLowerCase()) ? text(input.weight_unit,4).toLowerCase() : 'kg',
    cost_cny:number(input.cost_cny,{ min:0 }),sales_amount_cny:number(input.sales_amount_cny,{ min:0,nullable:false }),
    six_day_capacity:number(input.six_day_capacity,{ min:0,nullable:false }),source_project_id:number(input.source_project_id,{ min:0 }),sites
  };
}

async function writeNormalized(client,product,{ upsert=false,id=null } = {}) {
  const values=[product.owner_name,product.parent_asin,product.child_asin,product.product_name,product.image_data,
    product.length,product.width,product.height,product.dimension_unit,product.weight,product.weight_unit,
    product.cost_cny,product.sales_amount_cny,product.six_day_capacity,product.source_project_id];
  let row;
  if (id != null) {
    row=(await client.query(`UPDATE manual_dashboard_products SET owner_name=$1,parent_asin=$2,child_asin=$3,
      product_name=$4,image_data=$5,length=$6,width=$7,height=$8,dimension_unit=$9,weight=$10,weight_unit=$11,
      cost_cny=$12,sales_amount_cny=$13,six_day_capacity=$14,source_project_id=$15,updated_at=now()
      WHERE id=$16 RETURNING *`,[...values,id])).rows[0];
    if (!row) return null;
  } else if (upsert) {
    row=(await client.query(`INSERT INTO manual_dashboard_products
      (owner_name,parent_asin,child_asin,product_name,image_data,length,width,height,dimension_unit,weight,weight_unit,
       cost_cny,sales_amount_cny,six_day_capacity,source_project_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(owner_name,parent_asin) DO UPDATE SET child_asin=excluded.child_asin,product_name=excluded.product_name,
        image_data=excluded.image_data,length=excluded.length,width=excluded.width,height=excluded.height,
        dimension_unit=excluded.dimension_unit,weight=excluded.weight,weight_unit=excluded.weight_unit,
        cost_cny=excluded.cost_cny,sales_amount_cny=excluded.sales_amount_cny,six_day_capacity=excluded.six_day_capacity,
        source_project_id=excluded.source_project_id,updated_at=now() RETURNING *`,values)).rows[0];
  } else {
    row=(await client.query(`INSERT INTO manual_dashboard_products
      (owner_name,parent_asin,child_asin,product_name,image_data,length,width,height,dimension_unit,weight,weight_unit,
       cost_cny,sales_amount_cny,six_day_capacity,source_project_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,values)).rows[0];
  }
  await client.query('DELETE FROM manual_dashboard_sites WHERE product_id=$1',[row.id]);
  for (const site of product.sites) await client.query(`INSERT INTO manual_dashboard_sites
    (product_id,country_code,country_name,currency,symbol,sale_price,sales_qty,unit_profit,profit_rate,calculation_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[row.id,site.country_code,site.country_name,site.currency,site.symbol,
    site.sale_price,site.sales_qty,site.unit_profit,site.profit_rate,site.calculation_json ? JSON.stringify(site.calculation_json) : null]);
  return { ...row,sites:product.sites };
}

async function saveProduct(pool,input,{ upsert=false } = {}) {
  const product=normalizeProduct(input);const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const row=await writeNormalized(client,product,{ upsert });
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    if (error.code === '23505') throw new Error('该负责人名下已存在相同父 ASIN');
    throw error;
  } finally { client.release(); }
}

async function updateProduct(pool,id,input) {
  const current=await getProduct(pool,id);
  if (!current) return null;
  const product=normalizeProduct({ ...current,...input,sites:Object.hasOwn(input,'sites') ? input.sites : current.sites });
  const client=await pool.connect();
  try { await client.query('BEGIN');const result=await writeNormalized(client,product,{ id });await client.query('COMMIT');return result; }
  catch (error) { await client.query('ROLLBACK').catch(()=>{});if (error.code==='23505') throw new Error('该负责人名下已存在相同父 ASIN');throw error; }
  finally { client.release(); }
}

async function getProduct(pool,id) {
  const product=(await pool.query('SELECT * FROM manual_dashboard_products WHERE id=$1',[id])).rows[0];
  if (!product) return null;
  product.sites=(await pool.query('SELECT * FROM manual_dashboard_sites WHERE product_id=$1 ORDER BY country_code',[id])).rows;
  return product;
}

async function deleteProduct(pool,id) {
  return (await pool.query('DELETE FROM manual_dashboard_products WHERE id=$1',[id])).rowCount > 0;
}

const SORTS={
  sales_desc:'p.sales_amount_cny DESC,p.updated_at DESC',sales_asc:'p.sales_amount_cny ASC,p.updated_at DESC',
  capacity_desc:'p.six_day_capacity DESC,p.updated_at DESC',capacity_asc:'p.six_day_capacity ASC,p.updated_at DESC',
  updated_desc:'p.updated_at DESC,p.id DESC'
};

async function getDashboard(pool,params = {}) {
  const values=[];const where=[];
  if (params.owner) { values.push(params.owner);where.push(`p.owner_name=$${values.length}`); }
  if (params.site) { values.push(String(params.site).toUpperCase());where.push(`EXISTS(SELECT 1 FROM manual_dashboard_sites f WHERE f.product_id=p.id AND f.country_code=$${values.length})`); }
  if (params.search) { values.push(`%${params.search}%`);where.push(`(p.parent_asin ILIKE $${values.length} OR p.child_asin ILIKE $${values.length} OR p.product_name ILIKE $${values.length})`); }
  if (params.profit === 'positive') where.push('EXISTS(SELECT 1 FROM manual_dashboard_sites f WHERE f.product_id=p.id AND f.profit_rate>0)');
  if (params.profit === 'negative') where.push('EXISTS(SELECT 1 FROM manual_dashboard_sites f WHERE f.product_id=p.id AND f.profit_rate<0)');
  const whereSql=where.join(' AND ');
  const order=SORTS[params.sort] || SORTS.updated_desc;
  const products=(await pool.query(`SELECT p.* FROM manual_dashboard_products p${whereSql ? ` WHERE ${whereSql}` : ''} ORDER BY ${order}`,values)).rows;
  if (!products.length) return { summary:{ products:0,sites:0,profitable_sites:0,average_profit_rate:null,total_sales:0 },filters:await filters(pool),products:[] };
  const sites=(await pool.query('SELECT * FROM manual_dashboard_sites WHERE product_id=ANY($1::bigint[]) ORDER BY country_code',[products.map((item) => item.id)])).rows;
  const byProduct=new Map();
  for (const site of sites) { if (!byProduct.has(String(site.product_id))) byProduct.set(String(site.product_id),[]);byProduct.get(String(site.product_id)).push(site); }
  for (const product of products) product.sites=byProduct.get(String(product.id)) || [];
  const rates=sites
    .filter((site) => site.profit_rate !== null && site.profit_rate !== undefined && site.profit_rate !== '')
    .map((site) => Number(site.profit_rate))
    .filter(Number.isFinite);
  return { summary:{ products:products.length,sites:sites.length,profitable_sites:sites.filter((site) => Number(site.profit_rate)>0).length,
    average_profit_rate:rates.length ? Math.round(rates.reduce((a,b)=>a+b,0)/rates.length*100)/100 : null,
    total_sales:products.reduce((sum,item)=>sum+Number(item.sales_amount_cny || 0),0) },filters:await filters(pool),products };
}

async function filters(pool) {
  const [owners,sites]=await Promise.all([
    pool.query('SELECT owner_name,COUNT(*)::int AS product_count FROM manual_dashboard_products GROUP BY owner_name ORDER BY owner_name'),
    pool.query('SELECT country_code,COUNT(DISTINCT product_id)::int AS product_count FROM manual_dashboard_sites GROUP BY country_code ORDER BY country_code')
  ]);
  return { owners:owners.rows,sites:sites.rows };
}

async function importProducts(pool,rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Excel 中没有可导入的数据');
  const grouped=new Map();
  for (const [index,row] of rows.entries()) {
    try {
      const key=`${text(row.owner_name,80)}\u0000${text(row.parent_asin,32).toUpperCase()}`;
      if (!grouped.has(key)) grouped.set(key,{ ...row,sites:[] });
      if (text(row.country_code,8)) grouped.get(key).sites.push(row);
    } catch (error) { throw new Error(`Excel 第 ${index + 2} 行：${error.message}`); }
  }
  const normalized=[...grouped.values()].map((row,index) => {
    try { return normalizeProduct(row); } catch (error) { throw new Error(`Excel 产品 ${index + 1}：${error.message}`); }
  });
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    for (const product of normalized) await writeNormalized(client,product,{ upsert:true });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw new Error(`Excel 导入失败，未写入任何数据：${error.message}`);
  } finally { client.release(); }
  return { imported:normalized.length,site_rows:normalized.reduce((sum,item)=>sum+item.sites.length,0) };
}

module.exports={ text,number,normalizeSite,normalizeProduct,saveProduct,updateProduct,getProduct,deleteProduct,getDashboard,filters,importProducts };
