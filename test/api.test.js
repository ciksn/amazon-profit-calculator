'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server,matchCommission } = require('../server');
const db = require('../lib/db');
const competitorAnalysis = require('../lib/competitor-analysis');

test('未命中具体品类时按站点使用其他类别佣金', async () => {
  assert.equal((await matchCommission('US','Health & Household',30)).rule.rate,15);
  assert.equal((await matchCommission('AU','Health & Household',30)).rule.rate,15);
  assert.equal((await matchCommission('AE','Health & Household',100)).rule.rate,10);
  assert.equal((await matchCommission('SA','Health & Household',100)).rule.rate,11);
  assert.equal((await matchCommission('SA','Unknown Category',100)).rule.rate,10);
  assert.equal((await matchCommission('JP','Health & Household',700)).rule.rate,5);
  assert.equal((await matchCommission('JP','Health & Household',7000)).rule.rate,15.4);
  assert.equal((await matchCommission('US','Home & Kitchen',30)).fallback,false);
  assert.equal((await matchCommission('US','Health & Household',30)).fallback,true);
  assert.equal((await matchCommission('ZZ','Unknown Category',30)).matched,false);
});

test('接口返回各国尺寸分段、严格 FBA 和新增沙特佣金', async (t) => {
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  const base=`http://127.0.0.1:${address.port}`;
  let fallbackProjectId=null;
  t.after(async () => {
    if (fallbackProjectId) await fetch(`${base}/api/projects/${fallbackProjectId}`,{method:'DELETE'}).catch(()=>{});
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });
  const bootstrap=await (await fetch(`${base}/api/bootstrap`)).json();
  const health=await (await fetch(`${base}/api/health`)).json();
  assert.deepEqual(health,{ok:true,database:'postgresql'});
  assert.equal((await fetch(`${base}/`)).status,200);
  process.env.CORS_ORIGINS='https://front.example';
  const cors=await fetch(`${base}/api/health`,{headers:{origin:'https://front.example'}});
  assert.equal(cors.headers.get('access-control-allow-origin'),'https://front.example');
  assert.equal((await fetch(`${base}/api/health`,{method:'OPTIONS',headers:{origin:'https://front.example'}})).status,204);
  delete process.env.CORS_ORIGINS;
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
    assert.match(created.share_key,/^[A-Za-z0-9_-]{8,120}$/);
    const sharedProject=await (await fetch(`${base}/api/projects/by-share-key/${created.share_key}`)).json();
    assert.equal(sharedProject.id,created.id);
    assert.equal((await fetch(`${base}/api/projects/by-share-key/not-found-key`)).status,404);
    assert.equal((await fetch(`${base}/api/projects/99999999/site-card-records`)).status,404);
    assert.equal((await fetch(`${base}/api/projects/99999999/site-card-records`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country_code:'US'})})).status,404);
    assert.equal((await fetch(`${base}/api/projects/${created.id}/site-card-records`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country_code:'ZZ'})})).status,400);
    const recordResponse=await fetch(`${base}/api/projects/${created.id}/site-card-records`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'legacy-record-1',country_code:'US',name:'小站点方案 A',cost_cny:88,sale_price:39.99,snapshot:{detail_version:1,profit_rate:31.5}})});
    assert.equal(recordResponse.status,201);
    const record=await recordResponse.json();
    assert.equal(record.snapshot.profit_rate,31.5);
    const keyedProject=await (await fetch(`${base}/api/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'固定分享标识项目',share_key:'fixed-share-key-123'})})).json();
    assert.equal(keyedProject.share_key,'fixed-share-key-123');
    const conflictingRecord=await fetch(`${base}/api/projects/${keyedProject.id}/site-card-records`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'legacy-record-1',country_code:'US'})});
    assert.equal(conflictingRecord.status,409);
    assert.equal((await fetch(`${base}/api/projects/${keyedProject.id}`,{method:'DELETE'})).status,200);
    const duplicateRecord=await fetch(`${base}/api/projects/${created.id}/site-card-records`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'legacy-record-1',country_code:'US',name:'重复迁移'})});
    assert.equal(duplicateRecord.status,200);
    const savedRecords=await (await fetch(`${base}/api/projects/${created.id}/site-card-records?country_code=US`)).json();
    assert.equal(savedRecords.records.length,1);
    assert.equal(savedRecords.records[0].name,'小站点方案 A');
    assert.equal((await (await fetch(`${base}/api/projects/${created.id}/site-card-records`)).json()).records.length,1);
    const updatedRecord=await (await fetch(`${base}/api/site-card-records/${record.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'数据库方案 B',cost_cny:90,sale_price:42,snapshot:null})})).json();
    assert.equal(updatedRecord.name,'数据库方案 B');
    assert.equal(updatedRecord.cost_cny,90);
    assert.deepEqual(updatedRecord.snapshot,{});
    assert.equal((await fetch(`${base}/api/site-card-records/missing-record`,{method:'PUT',headers:{'content-type':'application/json'},body:'{}'})).status,404);
    assert.equal((await fetch(`${base}/api/site-card-records/${record.id}`,{method:'DELETE'})).status,200);
    assert.equal((await fetch(`${base}/api/site-card-records/${record.id}`,{method:'DELETE'})).status,404);
    assert.equal((await (await fetch(`${base}/api/projects/${created.id}/site-card-records?country_code=US`)).json()).records.length,0);
    const updated=await (await fetch(`${base}/api/projects/${created.id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'已更新临时项目',cost_cny:115,weight:2,image_data:'data:image/png;base64,dGVzdA=='})})).json();
    assert.equal(updated.name,'已更新临时项目');
    assert.equal(updated.weight,2);
    assert.equal(updated.image_data,'data:image/png;base64,dGVzdA==');
    const listingUpdate=await (await fetch(`${base}/api/projects/${created.id}/countries/JP`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({selected:true,sale_price:7000,category_text:'Unknown Category',customs_rate:5})})).json();
    assert.equal(listingUpdate.listings.find((row)=>row.country_code==='JP').matched_referral_rate,15.4);
    const calculated=await (await fetch(`${base}/api/calculate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project_id:created.id})})).json();
    assert.ok(calculated.results.some((row)=>row.country_code==='JP' && row.customs_rate===5));
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
    const importPayload={country_code:'JP',rows:[{asin:'B0IMPORT01',name:'导入竞品',sale_price:6200,
      image_url:'https://example.com/a.jpg',product_url:'https://amazon.co.jp/dp/B0IMPORT01',is_fba:true,
      monthly_sales:320,monthly_revenue_local:1984000,rating:4.5,category_text:'Consumer Electronics',
      length:30.123456,width:20.987654,height:10.555555,dimension_unit:'cm',weight:.8123456,weight_unit:'kg',source_format:'seller_sprite'}]};
    const imported=await (await fetch(`${base}/api/projects/${created.id}/competitors/import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(importPayload)})).json();
    assert.deepEqual(imported,{imported:1,created:1,updated:0,discarded:0});
    const importedList=await (await fetch(`${base}/api/projects/${created.id}/competitors`)).json();
    assert.equal(importedList.competitor_counts.JP,1);
    assert.equal(importedList.competitors[0].asin,'B0IMPORT01');
    assert.equal(importedList.competitors[0].length,30.12);
    assert.equal(importedList.competitors[0].width,20.99);
    assert.equal(importedList.competitors[0].height,10.56);
    assert.equal(importedList.competitors[0].weight,.812);
    assert.equal(typeof importedList.competitors[0].calculation.profit_rate,'number');
    importPayload.rows[0].sale_price=6400;
    const reimported=await (await fetch(`${base}/api/projects/${created.id}/competitors/import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(importPayload)})).json();
    assert.deepEqual(reimported,{imported:1,created:0,updated:1,discarded:0});
    const moreRows=Array.from({length:5},(_,index)=>({...importPayload.rows[0],asin:`B0MORE000${index}`,name:`分析竞品 ${index+1}`,product_url:`https://amazon.co.jp/dp/B0MORE000${index}`,monthly_revenue_local:2_000_000+index}));
    await fetch(`${base}/api/projects/${created.id}/competitors/import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country_code:'JP',rows:moreRows})});
    const originalAnalyze=competitorAnalysis.analyzeCompetitorBatch;let analyzedIds=[],analysisCalls=0;
    competitorAnalysis.analyzeCompetitorBatch=async(rows)=>{analysisCalls+=1;analyzedIds=rows.map((row)=>row.id);return {model:'gemini-test',rows:rows.map((row)=>({id:row.id,featureBullets:['五点一','五点二'],sellingPoints:['便携设计','电压自适应','快速预热'],differentiation:['全球电压'],status:'complete',warning:''}))}};
    try {
      const analysisResponse=await fetch(`${base}/api/projects/${created.id}/competitors/analyze`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country_code:'JP'})});
      assert.equal(analysisResponse.status,200);const analysisPayload=await analysisResponse.json();assert.equal(analysisPayload.total,5);assert.equal(analysisPayload.attempted,5);assert.equal(analysisPayload.skipped,0);assert.equal(analyzedIds.length,5);
      const analyzedList=await (await fetch(`${base}/api/projects/${created.id}/competitors`)).json();
      assert.ok(analyzedList.competitors.every((row)=>row.analysis_status==='complete'&&row.selling_points.includes('便携设计')));
      const repeatedAnalysis=await (await fetch(`${base}/api/projects/${created.id}/competitors/analyze`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country_code:'JP'})})).json();
      assert.equal(repeatedAnalysis.attempted,0);assert.equal(repeatedAnalysis.skipped,5);assert.equal(analysisCalls,1);
    } finally { competitorAnalysis.analyzeCompetitorBatch=originalAnalyze; }
    const cleared=await (await fetch(`${base}/api/projects/${created.id}/competitors?country_code=JP`,{method:'DELETE'})).json();
    assert.equal(cleared.deleted,6);
    const match=await (await fetch(`${base}/api/commission/match`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country_code:'US',text:'Unknown Category',sale_price:20})})).json();
    assert.equal(match.fallback,true);
    assert.equal((await fetch(`${base}/api/tariffs/japan/lookup`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hs_code:'8543709999'})})).status,200);
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
