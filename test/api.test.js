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
    const updated=await (await fetch(`${base}/api/projects/${created.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'已更新临时项目',weight:2})})).json();
    assert.equal(updated.name,'已更新临时项目');
    assert.equal(updated.weight,2);
    const listingUpdate=await (await fetch(`${base}/api/projects/${created.id}/countries/JP`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({selected:true,sale_price:7000,category_text:'Unknown Category',customs_rate:5})})).json();
    assert.equal(listingUpdate.listings.find((row)=>row.country_code==='JP').matched_referral_rate,15.4);
    const calculated=await (await fetch(`${base}/api/calculate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:created.id})})).json();
    assert.ok(calculated.results.some((row)=>row.country_code==='JP' && row.customs_rate===5));
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
