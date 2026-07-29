'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {
  validateProvider,normalizeProposal,DOCUMENT_AI_FIELDS,SITE_AI_FIELDS
}=require('../lib/selection-ai/contracts');

test('Provider 只接受 codex 和 openai',()=>{
  assert.equal(validateProvider('codex'),'codex');
  assert.equal(validateProvider('openai'),'openai');
  assert.throws(()=>validateProvider('auto'),/Provider/);
});

test('提案删除数字和未授权字段并读取数据库原值',()=>{
  const payload={
    document:{version:7,positioning:'旧定位',decision_status:'观察中'},
    sites:[{country_code:'US',opportunity_notes:'旧备注',certification_gap_cost:3000}]
  };
  const proposal=normalizeProposal({summary:'建议',changes:[
    {scope:'document',country_code:'',field:'positioning',value:'新定位',reason:'更清晰'},
    {scope:'document',country_code:'',field:'decision_status',value:'通过',reason:'越权'},
    {scope:'site',country_code:'US',field:'opportunity_notes',value:'优先测试',reason:'利润较好'},
    {scope:'site',country_code:'US',field:'certification_gap_cost',value:'0',reason:'越权'}
  ]},payload);
  assert.deepEqual(proposal.changes.map(({field,before,after})=>({field,before,after})),[
    {field:'positioning',before:'旧定位',after:'新定位'},
    {field:'opportunity_notes',before:'旧备注',after:'优先测试'}
  ]);
  assert.ok(DOCUMENT_AI_FIELDS.includes('checklist'));
  assert.ok(SITE_AI_FIELDS.includes('opportunity_status'));
});

test('提案解析允许的数组 JSON，限制文本和无效结果',()=>{
  const payload={document:{version:2,differentiation_items:[]},sites:[]};
  const proposal=normalizeProposal({summary:'x'.repeat(10001),changes:[
    {scope:'document',country_code:'',field:'differentiation_items',value:'["更轻","更耐用"]',reason:'测试'}
  ]},payload);
  assert.deepEqual(proposal.changes[0].after,['更轻','更耐用']);
  assert.equal(proposal.summary.length,10000);
  assert.equal(normalizeProposal({summary:'建议',changes:[
    {scope:'site',country_code:'US',field:'certification_gap_cost',value:'0',reason:'越权'}
  ]},payload),null);
});

test('提案沿用站点评估的机会状态校验语义',()=>{
  const payload={document:{version:2},sites:[{country_code:'US',opportunity_status:''}]};
  assert.equal(normalizeProposal({summary:'建议',changes:[
    {scope:'site',country_code:'US',field:'opportunity_status',value:' 优先 ',reason:'测试'}
  ]},payload),null);
});

test('提案先过滤无效项再限制为 30 个合法修改',()=>{
  const payload={document:{version:2,positioning:'旧定位'},sites:[]};
  const invalid=Array.from({length:30},()=>({
    scope:'document',country_code:'',field:'decision_status',value:'通过',reason:'越权'
  }));
  const proposal=normalizeProposal({summary:'建议',changes:[...invalid,
    {scope:'document',country_code:'',field:'positioning',value:'新定位',reason:'有效'}
  ]},payload);
  assert.deepEqual(proposal.changes.map((change)=>change.field),['positioning']);
});
