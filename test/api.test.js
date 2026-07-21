'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server,matchCommission } = require('../server');

test('未命中具体品类时按站点使用其他类别佣金', () => {
  assert.equal(matchCommission('US','Health & Household',30).rule.rate,15);
  assert.equal(matchCommission('AU','Health & Household',30).rule.rate,15);
  assert.equal(matchCommission('AE','Health & Household',100).rule.rate,10);
  assert.equal(matchCommission('SA','Health & Household',100).rule.rate,11);
  assert.equal(matchCommission('SA','Unknown Category',100).rule.rate,10);
  assert.equal(matchCommission('JP','Health & Household',700).rule.rate,5);
  assert.equal(matchCommission('JP','Health & Household',7000).rule.rate,15.4);
  assert.equal(matchCommission('US','Home & Kitchen',30).fallback,false);
  assert.equal(matchCommission('US','Health & Household',30).fallback,true);
  assert.equal(matchCommission('ZZ','Unknown Category',30).matched,false);
});

test('接口返回各国尺寸分段、严格 FBA 和新增沙特佣金', async (t) => {
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  const base=`http://127.0.0.1:${address.port}`;
  let fallbackProjectId=null;
  t.after(async () => {
    if (fallbackProjectId) await fetch(`${base}/api/projects/${fallbackProjectId}`,{method:'DELETE'}).catch(()=>{});
    await new Promise((resolve) => server.close(resolve));
  });
  const bootstrap=await (await fetch(`${base}/api/bootstrap`)).json();
  const sizes=await (await fetch(`${base}/api/rules/sizes`)).json();
  const commissions=await (await fetch(`${base}/api/rules/commission`)).json();
  let projectId=bootstrap.projects[0]?.id;
  if (!projectId) {
    const fallbackResponse=await fetch(`${base}/api/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'接口测试基础项目'})});
    assert.equal(fallbackResponse.status,201);
    const fallbackProject=await fallbackResponse.json();
    projectId=fallbackProject.id;
    fallbackProjectId=fallbackProject.id;
  }
  const project=await (await fetch(`${base}/api/projects/${projectId}`)).json();
  const freight=await (await fetch(`${base}/api/rules/freight`)).json();
  assert.deepEqual(bootstrap.countries.map((country)=>country.code),['AU','US','GB','DE','JP','CA','AE','SA']);
  assert.ok(sizes.some((row)=>row.country_code==='US' && row.tier_code==='small_standard'));
  assert.ok(sizes.some((row)=>row.country_code==='SA' && row.tier_code==='standard_parcel'));
  assert.ok(commissions.some((row)=>row.country_code==='SA' && row.parent_category==='Electronics Accessories' && row.threshold_price===250));
  assert.ok(project.listings.every((row)=>row.freight_rule_id && row.freight_pricing_mode));
  const jp=project.listings.find((row)=>row.country_code==='JP');
  assert.equal(jp.declaration_ratio,.15);
  assert.equal(jp.consumption_tax_rate,10);
  const auFreight=freight.find((row)=>row.country_code==='AU');
  const originalRate=auFreight.price_per_kg_cny;
  try {
    const update=await fetch(`${base}/api/rules/freight/${auFreight.id}`,{ method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({ price_per_kg_cny:originalRate+1 }) });
    assert.equal(update.status,200);
    const updatedProject=await (await fetch(`${base}/api/projects/${projectId}`)).json();
    assert.equal(updatedProject.listings.find((row)=>row.country_code==='AU').freight_price_per_kg_cny,originalRate+1);
  } finally {
    await fetch(`${base}/api/rules/freight/${auFreight.id}`,{ method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({ price_per_kg_cny:originalRate }) });
  }

  const missing=await fetch(`${base}/api/projects/99999999`);
  assert.equal(missing.status,404);
  const createdResponse=await fetch(`${base}/api/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'自动测试临时项目'})});
  assert.equal(createdResponse.status,201);
  const created=await createdResponse.json();
  try {
    const updated=await (await fetch(`${base}/api/projects/${created.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'已更新临时项目',cost_cny:115,weight:2,image_data:'data:image/png;base64,dGVzdA=='})})).json();
    assert.equal(updated.name,'已更新临时项目');
    assert.equal(updated.weight,2);
    assert.equal(updated.image_data,'data:image/png;base64,dGVzdA==');
    const listingUpdate=await (await fetch(`${base}/api/projects/${created.id}/countries/JP`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({selected:true,sale_price:7000,category_text:'Unknown Category',customs_rate:5})})).json();
    assert.equal(listingUpdate.listings.find((row)=>row.country_code==='JP').matched_referral_rate,15.4);
    const calculated=await (await fetch(`${base}/api/calculate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:created.id})})).json();
    assert.ok(calculated.results.some((row)=>row.country_code==='JP' && row.customs_rate===5));
    const variant=await (await fetch(`${base}/api/calculate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:created.id,country_code:'JP',cost_cny_override:140,sale_price_override:8000,include_target_prices:true})})).json();
    assert.equal(variant.results[0].sale_price,8000);
    assert.equal(Object.keys(variant.results[0].target_prices).length,4);
    assert.equal(typeof variant.results[0].fba_rule_base_fee,'number');
    assert.equal(typeof variant.results[0].freight_rate_cny,'number');
    assert.equal(typeof variant.results[0].tax_note,'string');
    const unchanged=await (await fetch(`${base}/api/projects/${created.id}`)).json();
    assert.equal(unchanged.cost_cny,115);
    assert.equal(unchanged.listings.find((row)=>row.country_code==='JP').sale_price,7000);
    const competitorResponse=await fetch(`${base}/api/projects/${created.id}/competitors`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country_code:'JP'})});
    assert.equal(competitorResponse.status,201);
    const competitor=await competitorResponse.json();
    assert.equal(competitor.weight,2);
    assert.equal(competitor.cost_cny,115);
    assert.equal(competitor.uses_project_defaults,1);
    assert.equal(competitor.profit_rate,null);
    const savedCompetitor=await (await fetch(`${base}/api/competitors/${competitor.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'竞品 A',sale_price:6500,cost_cny:88})})).json();
    assert.equal(savedCompetitor.name,'竞品 A');
    assert.equal(savedCompetitor.cost_cny,88);
    assert.equal(savedCompetitor.uses_project_defaults,0);
    assert.equal(typeof savedCompetitor.profit_rate,'number');
    await fetch(`${base}/api/projects/${created.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({cost_cny:120})});
    const independentCompetitor=(await (await fetch(`${base}/api/projects/${created.id}/competitors`)).json()).competitors[0];
    assert.equal(independentCompetitor.cost_cny,88);
    const followingCompetitor=await (await fetch(`${base}/api/competitors/${competitor.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({uses_project_defaults:true})})).json();
    assert.equal(followingCompetitor.uses_project_defaults,1);
    assert.equal(followingCompetitor.cost_cny,120);
    const competitorList=await (await fetch(`${base}/api/projects/${created.id}/competitors`)).json();
    assert.equal(competitorList.competitors.length,1);
    assert.equal(competitorList.competitors[0].id,competitor.id);
    assert.equal((await fetch(`${base}/api/competitors/${competitor.id}`,{method:'DELETE'})).status,200);
    assert.equal((await (await fetch(`${base}/api/projects/${created.id}/competitors`)).json()).competitors.length,0);
    const importPayload={country_code:'JP',rows:[{asin:'B0IMPORT01',name:'导入竞品',sale_price:6200,image_url:'https://example.com/a.jpg',product_url:'https://amazon.co.jp/dp/B0IMPORT01',is_fba:true,has_aplus:false,has_video:true,listing_date:'2025-01-01',monthly_sales:320,monthly_revenue_local:1984000,monthly_revenue_usd:13300,rating:4.5,source_format:'seller_sprite',source_row:2}]};
    const imported=await (await fetch(`${base}/api/projects/${created.id}/competitors/import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(importPayload)})).json();
    assert.deepEqual(imported,{imported:1,created:1,updated:0});
    let importedRow=(await (await fetch(`${base}/api/projects/${created.id}/competitors`)).json()).competitors[0];
    assert.equal(importedRow.asin,'B0IMPORT01');assert.equal(importedRow.has_video,1);assert.equal(importedRow.monthly_sales,320);
    importedRow=await (await fetch(`${base}/api/competitors/${importedRow.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({cost_cny:77})})).json();
    importPayload.rows[0].sale_price=6400;const reimported=await (await fetch(`${base}/api/projects/${created.id}/competitors/import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(importPayload)})).json();
    assert.deepEqual(reimported,{imported:1,created:0,updated:1});
    importedRow=(await (await fetch(`${base}/api/projects/${created.id}/competitors`)).json()).competitors[0];
    assert.equal(importedRow.cost_cny,77);assert.equal(importedRow.sale_price,6400);assert.equal(importedRow.uses_project_defaults,0);
    assert.equal((await fetch(`${base}/api/competitors/${importedRow.id}`,{method:'DELETE'})).status,200);
    const match=await (await fetch(`${base}/api/commission/match`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country_code:'US',text:'Unknown Category',sale_price:20})})).json();
    assert.equal(match.fallback,true);
    for (const type of ['countries','sizes','fba','freight','commission']) assert.equal((await fetch(`${base}/api/rules/${type}`)).status,200);
    assert.equal((await fetch(`${base}/api/rules/freight/${auFreight.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:'{}'})).status,400);
    assert.equal((await fetch(`${base}/api/not-found`)).status,404);
    assert.equal((await fetch(`${base}/missing-file`)).status,404);
    const originalConsoleError=console.error;
    console.error=()=>{};
    try {
      assert.equal((await fetch(`${base}/api/commission/match`,{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,500);
    } finally {
      console.error=originalConsoleError;
    }
  } finally {
    assert.equal((await fetch(`${base}/api/projects/${created.id}`,{method:'DELETE'})).status,200);
  }
  if (fallbackProjectId) {
    assert.equal((await fetch(`${base}/api/projects/${fallbackProjectId}`,{method:'DELETE'})).status,200);
    fallbackProjectId=null;
    const emptyBootstrap=await (await fetch(`${base}/api/bootstrap`)).json();
    assert.equal(emptyBootstrap.projects.length,0);
  }
});
