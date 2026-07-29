'use strict';

const DECISION_STATUSES=['观察中','通过','淘汰'];
const OPPORTUNITY_STATUSES=['','优先','观察','放弃'];
const DEFAULT_CHECKLIST=[
  {id:'compliance',label:'产品没有未解决的合规性风险',checked:false},
  {id:'plug',label:'插头规格与目标站点一致',checked:false},
  {id:'package',label:'已确认包装及全部配件',checked:false},
  {id:'sample',label:'样品测试结果满足销售要求',checked:false},
  {id:'labels',label:'警告标签、英代或欧代标签已确认',checked:false},
  {id:'weee',label:'德国 WEEE 与电池法要求已确认',checked:false},
  {id:'satisfaction',label:'对最终交付给顾客的产品满意',checked:false}
];

const DOCUMENT_FIELDS=[
  'decision_status','decision_reason','positioning','use_scenarios','competitive_points',
  'differentiation_items','review_issues','overview_summary','competitor_summary',
  'supplier_summary','patent_notes','checklist'
];
const SUPPLIER_FIELDS=[
  'name','product_url','image_url','cost_cny','moq','specifications','certifications',
  'sample_reason','pre_sample_score','post_sample_score','pros','cons',
  'target_country_code','target_sale_price'
];

function finiteNumber(value,label,{min=0,max=Infinity,nullable=false}={}) {
  if ((value==null || value==='') && nullable) return null;
  const number=Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}必须是数字`);
  if (number<min) throw new Error(`${label}不能为负数`);
  if (number>max) throw new Error(`${label}超出允许范围`);
  return number;
}

function safeUrl(value,label='链接') {
  const text=String(value??'').trim();
  if (!text) return '';
  try {
    const parsed=new URL(text);
    if (!['http:','https:'].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch {
    throw new Error(`${label}只支持 HTTP 或 HTTPS 链接`);
  }
}

function safeText(value,max=10000) {
  return String(value??'').trim().slice(0,max);
}

function jsonArray(value,label) {
  if (!Array.isArray(value)) throw new Error(`${label}格式不正确`);
  return value.slice(0,100);
}

function defaultDocument(projectId) {
  return {
    project_id:Number(projectId),
    decision_status:'观察中',
    decision_reason:'',
    positioning:'',
    use_scenarios:'',
    competitive_points:'',
    differentiation_items:[],
    review_issues:[],
    overview_summary:'',
    competitor_summary:'',
    supplier_summary:'',
    patent_notes:'',
    checklist:DEFAULT_CHECKLIST.map((item)=>({...item})),
    version:0,
    updated_at:''
  };
}

function validateDocumentPatch(body={}) {
  const version=Number(body.version);
  if (!Number.isInteger(version) || version<0) throw new Error('版本号不正确');
  const output={version};
  for (const field of DOCUMENT_FIELDS) {
    if (!Object.hasOwn(body,field)) continue;
    if (field==='decision_status') {
      if (!DECISION_STATUSES.includes(body[field])) throw new Error('决策状态不正确');
      output[field]=body[field];
    } else if (['differentiation_items','review_issues','checklist'].includes(field)) {
      output[field]=jsonArray(body[field],field);
    } else {
      output[field]=safeText(body[field]);
    }
  }
  return output;
}

function validateDifferentiationItems(value) {
  return jsonArray(value,'differentiation_items').map((item)=>({
    direction:safeText(item?.direction,1000),
    level:safeText(item?.level,100),
    difficulty:safeText(item?.difficulty,1000)
  }));
}

function validateChecklist(value) {
  return jsonArray(value,'checklist').map((item,index)=>({
    id:safeText(item?.id||`ai-${index}`,120),
    label:safeText(item?.label,1000),
    checked:Boolean(item?.checked)
  }));
}

function validateSiteInput(body={}) {
  const output={};
  const numericFields=['market_average_revenue','market_average_sales','certification_gap_cost'];
  const textFields=[
    'new_product_friendliness','same_product_performance','opportunity_notes',
    'certification_required','certification_actual','supplier_certifications',
    'certification_gap','payback_period'
  ];
  for (const field of numericFields) {
    if (Object.hasOwn(body,field)) output[field]=finiteNumber(body[field],field);
  }
  for (const field of textFields) {
    if (Object.hasOwn(body,field)) output[field]=safeText(body[field],4000);
  }
  if (Object.hasOwn(body,'opportunity_status')) {
    if (!OPPORTUNITY_STATUSES.includes(body.opportunity_status)) throw new Error('机会判断不正确');
    output.opportunity_status=body.opportunity_status;
  }
  return output;
}

function validateSupplierInput(body={},partial=false) {
  const output={};
  for (const field of SUPPLIER_FIELDS) {
    if (!Object.hasOwn(body,field)) continue;
    if (field==='product_url') output[field]=safeUrl(body[field],'商品链接');
    else if (field==='image_url') output[field]=safeUrl(body[field],'图片链接');
    else if (['cost_cny','moq','target_sale_price'].includes(field)) output[field]=finiteNumber(body[field],field);
    else if (['pre_sample_score','post_sample_score'].includes(field)) {
      output[field]=finiteNumber(body[field],field==='pre_sample_score'?'拿样前评分':'拿样后评分',{min:0,max:100,nullable:true});
    } else if (field==='target_country_code') {
      output[field]=safeText(body[field],8).toUpperCase();
    } else output[field]=safeText(body[field],4000);
  }
  if (!partial) {
    output.name??='';
    output.product_url??='';
    output.image_url??='';
    output.cost_cny??=0;
    output.moq??=0;
    output.specifications??='';
    output.certifications??='';
    output.sample_reason??='';
    output.pre_sample_score??=null;
    output.post_sample_score??=null;
    output.pros??='';
    output.cons??='';
    output.target_country_code??='';
    output.target_sale_price??=0;
  }
  return output;
}

function competitorRevenue(row,countries=[]) {
  const monthlySales=Number(row.monthly_sales)||0;
  if (row.country_code==='AU') {
    return {monthly_sales:monthlySales,revenue:Number(row.monthly_revenue_local)||0,currency:'AUD',symbol:'A$'};
  }
  let revenue=Number(row.monthly_revenue_usd)||0;
  if (!revenue) {
    const country=countries.find((item)=>item.code===row.country_code);
    const usd=countries.find((item)=>item.code==='US');
    const localRate=Number(country?.cny_per_local)||0;
    const usdRate=Number(usd?.cny_per_local)||0;
    if (localRate>0 && usdRate>0) revenue=(Number(row.monthly_revenue_local)||0)*localRate/usdRate;
  }
  return {monthly_sales:monthlySales,revenue,currency:'USD',symbol:'$'};
}

module.exports={
  DECISION_STATUSES,
  DEFAULT_CHECKLIST,
  DOCUMENT_FIELDS,
  SUPPLIER_FIELDS,
  defaultDocument,
  validateDocumentPatch,
  validateDifferentiationItems,
  validateChecklist,
  validateSiteInput,
  validateSupplierInput,
  competitorRevenue
};
