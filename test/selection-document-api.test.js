'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {server}=require('../server');
const db=require('../lib/db');

test('选品文档接口支持聚合读取、冲突检测、站点评估和供应商 CRUD',async(t)=>{
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  let projectId;
  t.after(async()=>{
    if(projectId)await fetch(`${base}/api/projects/${projectId}`,{method:'DELETE'}).catch(()=>{});
    await new Promise((resolve)=>server.close(resolve));
    await db.close();
  });

  const createdResponse=await fetch(`${base}/api/projects`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({name:'选品文档接口测试',cost_cny:69,length:30,width:20,height:10,weight:1})
  });
  assert.equal(createdResponse.status,201);
  const created=await createdResponse.json();
  projectId=created.id;

  await fetch(`${base}/api/projects/${projectId}/countries/US`,{
    method:'PUT',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({selected:true,sale_price:49.99,category_text:'Home & Kitchen'})
  });

  const initialResponse=await fetch(`${base}/api/projects/${projectId}/selection-document`);
  assert.equal(initialResponse.status,200);
  const initial=await initialResponse.json();
  assert.equal(initial.project.id,projectId);
  assert.equal(initial.document.version,0);
  assert.equal(initial.document.decision_status,'观察中');
  assert.ok(initial.sites.some((row)=>row.country_code==='US'));
  assert.deepEqual(Object.keys(initial.competitors).sort(),['similar','standard']);
  assert.ok(Array.isArray(initial.profits));

  const savedResponse=await fetch(`${base}/api/projects/${projectId}/selection-document`,{
    method:'PUT',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({version:0,decision_status:'通过',decision_reason:'利润与风险均满足要求',positioning:'中高端便携产品'})
  });
  assert.equal(savedResponse.status,200);
  const saved=await savedResponse.json();
  assert.equal(saved.version,1);
  assert.equal(saved.decision_status,'通过');

  const conflict=await fetch(`${base}/api/projects/${projectId}/selection-document`,{
    method:'PUT',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({version:0,decision_status:'淘汰'})
  });
  assert.equal(conflict.status,409);
  assert.match((await conflict.json()).error,/他人更新/);

  const siteResponse=await fetch(`${base}/api/projects/${projectId}/selection-document/sites/US`,{
    method:'PUT',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({market_average_revenue:123456,market_average_sales:800,opportunity_status:'优先',certification_required:'FCC',certification_gap_cost:3000})
  });
  assert.equal(siteResponse.status,200);
  assert.equal((await siteResponse.json()).opportunity_status,'优先');

  const invalidSupplier=await fetch(`${base}/api/projects/${projectId}/selection-document/suppliers`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({product_url:'file:///tmp/a',cost_cny:-1})
  });
  assert.equal(invalidSupplier.status,400);

  const supplierResponse=await fetch(`${base}/api/projects/${projectId}/selection-document/suppliers`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({
      name:'供应商 A',
      product_url:'https://detail.1688.com/offer/1.html',
      image_url:'https://example.com/a.jpg',
      cost_cny:88,
      moq:200,
      specifications:'宽电压，快速加热',
      certifications:'FCC',
      pre_sample_score:82,
      target_country_code:'US',
      target_sale_price:59.99
    })
  });
  assert.equal(supplierResponse.status,201);
  const supplier=await supplierResponse.json();
  assert.equal(supplier.name,'供应商 A');
  assert.equal(typeof supplier.calculation.profit_rate,'number');
  assert.equal(typeof supplier.calculation.roi,'number');

  const updatedSupplierResponse=await fetch(`${base}/api/selection-suppliers/${supplier.id}`,{
    method:'PUT',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({post_sample_score:91,cons:'噪音略大'})
  });
  assert.equal(updatedSupplierResponse.status,200);
  assert.equal((await updatedSupplierResponse.json()).post_sample_score,91);

  assert.equal((await fetch(`${base}/api/selection-suppliers/${supplier.id}`,{method:'DELETE'})).status,200);
  assert.equal((await fetch(`${base}/api/projects/${projectId}/selection-document`)).status,200);

  await fetch(`${base}/api/projects/${projectId}`,{method:'DELETE'});
  projectId=null;
  assert.equal((await fetch(`${base}/api/projects/${created.id}/selection-document`)).status,404);
});
