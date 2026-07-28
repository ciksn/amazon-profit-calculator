'use strict';

(() => {
  const nativeFetch = window.fetch.bind(window);
  const storageKey = 'margingo-github-pages-v1';
  const selectionStorageKey = 'margingo-selection-documents-v1';
  const cache = { rules:null,tariff:new Map() };
  const emptyState = () => ({ version:1,nextProjectId:1,nextCompetitorId:1,projects:[],listings:{},competitors:[],overrides:{} });
  const loadState = () => {
    try { const value = JSON.parse(localStorage.getItem(storageKey)); return value?.version === 1 ? { ...emptyState(),...value } : emptyState(); }
    catch { return emptyState(); }
  };
  let local = loadState();
  const save = () => localStorage.setItem(storageKey,JSON.stringify(local));
  const emptySelectionState = () => ({ version:1,nextSupplierId:1,documents:{},sites:{},suppliers:[] });
  const loadSelectionState = () => {
    try { const value=JSON.parse(localStorage.getItem(selectionStorageKey));return value?.version===1?{...emptySelectionState(),...value}:emptySelectionState(); }
    catch { return emptySelectionState(); }
  };
  let selectionLocal=loadSelectionState();
  const saveSelection=()=>localStorage.setItem(selectionStorageKey,JSON.stringify(selectionLocal));
  window.addEventListener('storage',(event) => {
    if (event.key === storageKey) local = loadState();
    if (event.key === selectionStorageKey) selectionLocal=loadSelectionState();
  });
  const json = (status,body) => new Response(JSON.stringify(body),{ status,headers:{ 'Content-Type':'application/json; charset=utf-8' } });
  const readBody = (options) => options?.body ? JSON.parse(options.body) : {};
  const tableName = (type) => ({ countries:'countries',sizes:'size_tiers',fba:'fba_rules',freight:'freight_rules',commission:'commission_rules' })[type] || type;

  async function baseRules() {
    if (!cache.rules) {
      const result = await nativeFetch('./data/rules.json',{ cache:'no-cache' });
      if (!result.ok) throw new Error('基础规则文件加载失败');
      cache.rules = await result.json();
    }
    return cache.rules;
  }

  async function rowsFor(type) {
    const rows = (await baseRules())[tableName(type)] || [];
    return rows.map((row) => ({ ...row,...(local.overrides[`${type}:${row.id ?? row.code}`] || {}) }));
  }

  async function countries() {
    return (await rowsFor('countries')).filter((row) => Number(row.active) === 1).sort((a,b) => Number(a.priority) - Number(b.priority));
  }

  function blankListing(projectId,country) {
    return {
      project_id:projectId,country_code:country.code,selected:country.code === 'AU' ? 1 : 0,sale_price:0,category_text:'',
      referral_rate_override:null,matched_category:'',matched_referral_rate:null,matched_referral_threshold:null,
      matched_referral_rate_above:null,matched_referral_minimum:0,declaration_ratio:.15,declared_value_override:null,
      customs_rate:0,consumption_tax_rate:10,customs_hs_code:'',customs_origin_country:'CN',customs_preference:'unknown',
      customs_rate_type:'',customs_schedule_date:'',customs_source_url:'',screenshot_name:''
    };
  }

  async function matchCommission(countryCode,text,salePrice = 0) {
    const rules = (await rowsFor('commission')).filter((row) => row.country_code === countryCode);
    const normalized = String(text || '').toLowerCase().replace(/[&/，、|]/g,' ');
    let best = null; let bestScore = 0; let fallback = null;
    for (const rule of rules) {
      const price = Number(salePrice) || 0;
      if (rule.min_price != null && price < Number(rule.min_price)) continue;
      if (rule.max_price != null && price > Number(rule.max_price)) continue;
      const name = String(rule.parent_category || '').toLowerCase();
      if (name.includes('other') || name.includes('其他') || name.includes('其它')) { fallback ||= rule; continue; }
      const terms = `${rule.parent_category},${rule.keywords}`.toLowerCase().split(/[,/]/).map((item) => item.trim()).filter(Boolean);
      const score = terms.reduce((sum,term) => sum + (normalized.includes(term) ? Math.max(1,term.length) : 0),0);
      if (score > bestScore) { best = rule; bestScore = score; }
    }
    if (bestScore) return { matched:true,fallback:false,score:bestScore,rule:best };
    if (fallback) return { matched:true,fallback:true,score:0,rule:fallback };
    return { matched:false,fallback:false,rule:null };
  }

  async function getProject(id) {
    const project = local.projects.find((item) => Number(item.id) === Number(id));
    if (!project) return null;
    const activeCountries = await countries();
    const freight = await rowsFor('freight');
    const listings = [];
    for (const country of activeCountries) {
      const listing = { ...blankListing(Number(id),country),...(local.listings[`${id}:${country.code}`] || {}) };
      const freightRule = freight.find((row) => row.country_code === country.code) || {};
      Object.assign(listing,{ country_name:country.name,flag:country.flag,currency:country.currency,symbol:country.symbol,
        freight_rule_id:freightRule.id,freight_pricing_mode:freightRule.pricing_mode,
        freight_price_per_kg_cny:freightRule.price_per_kg_cny,freight_price_per_cbm_cny:freightRule.price_per_cbm_cny });
      if (listing.referral_rate_override == null && listing.category_text) {
        const matched = await matchCommission(country.code,listing.category_text,listing.sale_price);
        if (matched.matched) Object.assign(listing,{ matched_category:matched.rule.parent_category,matched_referral_rate:matched.rule.rate,
          matched_referral_threshold:matched.rule.threshold_price,matched_referral_rate_above:matched.rule.rate_above,
          matched_referral_minimum:matched.rule.minimum_fee || 0,commission_fallback:Boolean(matched.fallback) });
      }
      listings.push(listing);
    }
    return { ...project,listings };
  }

  async function calculateCompetitor(row) {
    const project = await getProject(row.project_id); if (!project) return null;
    const listing = project.listings.find((item) => item.country_code === row.country_code);
    const country = (await countries()).find((item) => item.code === row.country_code);
    if (!listing || !country) return { ...row,profit_rate:null,profit:null };
    const follows = Boolean(row.uses_project_defaults);
    const competitorProject = { ...project,
      cost_cny:follows ? project.cost_cny : row.cost_cny,length:follows ? project.length : row.length,
      width:follows ? project.width : row.width,height:follows ? project.height : row.height,
      dimension_unit:follows ? project.dimension_unit : row.dimension_unit,
      weight:follows ? project.weight : row.weight,weight_unit:follows ? project.weight_unit : row.weight_unit };
    const categoryText = follows ? listing.category_text : row.category_text;
    const competitorListing = { ...listing,sale_price:row.sale_price,category_text:categoryText };
    if (competitorListing.referral_rate_override == null && categoryText) {
      const matched = await matchCommission(row.country_code,categoryText,row.sale_price);
      if (matched.matched) Object.assign(competitorListing,{ matched_category:matched.rule.parent_category,
        matched_referral_rate:matched.rule.rate,matched_referral_threshold:matched.rule.threshold_price,
        matched_referral_rate_above:matched.rule.rate_above,matched_referral_minimum:matched.rule.minimum_fee || 0 });
    }
    const fba = await rowsFor('fba'); const sizes = await rowsFor('sizes'); const freight = await rowsFor('freight');
    const calculated = window.MarginGoProfit.calculateProfit({ project:competitorProject,country,listing:competitorListing,
      fbaRules:fba.filter((item) => item.country_code === country.code),sizeTiers:sizes.filter((item) => item.country_code === country.code),
      freightRule:freight.find((item) => item.country_code === country.code) || null });
    const filled = Boolean(String(row.name || '').trim()) && Number(row.sale_price) > 0;
    return { ...row,cost_cny:competitorProject.cost_cny,length:competitorProject.length,width:competitorProject.width,
      height:competitorProject.height,dimension_unit:competitorProject.dimension_unit,weight:competitorProject.weight,
      weight_unit:competitorProject.weight_unit,category_text:categoryText,symbol:country.symbol,country_name:country.name,flag:country.flag,
      profit_rate:filled ? calculated.profit_rate : null,profit:filled ? calculated.profit : null,
      calculation:filled ? calculated : null };
  }

  async function listCompetitors(projectId) {
    return Promise.all(local.competitors.filter((item) => Number(item.project_id) === Number(projectId))
      .sort((a,b) => String(a.country_code).localeCompare(String(b.country_code)) || Number(a.id) - Number(b.id)).map(calculateCompetitor));
  }

  const defaultChecklist=()=>[
    {id:'compliance',label:'产品没有未解决的合规性风险',checked:false},
    {id:'plug',label:'插头规格与目标站点一致',checked:false},
    {id:'package',label:'已确认包装及全部配件',checked:false},
    {id:'sample',label:'样品测试结果满足销售要求',checked:false},
    {id:'labels',label:'警告标签、英代或欧代标签已确认',checked:false},
    {id:'weee',label:'德国 WEEE 与电池法要求已确认',checked:false},
    {id:'satisfaction',label:'对最终交付给顾客的产品满意',checked:false}
  ];
  function selectionDocument(projectId) {
    const key=String(projectId);
    return selectionLocal.documents[key] ||= {
      project_id:Number(projectId),decision_status:'观察中',decision_reason:'',positioning:'',
      use_scenarios:'',competitive_points:'',differentiation_items:[],review_issues:[],
      overview_summary:'',competitor_summary:'',supplier_summary:'',patent_notes:'',
      checklist:defaultChecklist(),version:0,updated_at:''
    };
  }
  function validHttpUrl(value,label='链接') {
    const text=String(value||'').trim();if(!text)return '';
    try{const parsed=new URL(text);if(!['http:','https:'].includes(parsed.protocol))throw new Error();return parsed.toString()}
    catch{throw new Error(`${label}只支持 HTTP 或 HTTPS 链接`)}
  }
  function selectionNumber(value,label,{nullable=false,max=Infinity}={}) {
    if((value==null||value==='')&&nullable)return null;
    const number=Number(value);
    if(!Number.isFinite(number))throw new Error(`${label}必须是数字`);
    if(number<0)throw new Error(`${label}不能为负数`);
    if(number>max)throw new Error(`${label}超出允许范围`);
    return number;
  }
  function validateSelectionSite(body) {
    const output={};
    for(const key of ['market_average_revenue','market_average_sales','certification_gap_cost']){
      if(Object.hasOwn(body,key))output[key]=selectionNumber(body[key],key);
    }
    for(const key of ['new_product_friendliness','same_product_performance','opportunity_notes','certification_required','certification_actual','supplier_certifications','certification_gap','payback_period']){
      if(Object.hasOwn(body,key))output[key]=String(body[key]??'').trim().slice(0,4000);
    }
    if(Object.hasOwn(body,'opportunity_status')){
      if(!['','优先','观察','放弃'].includes(body.opportunity_status))throw new Error('机会判断不正确');
      output.opportunity_status=body.opportunity_status;
    }
    return output;
  }
  function validateSelectionDocument(body) {
    const version=Number(body.version);
    if(!Number.isInteger(version)||version<0)throw new Error('版本号不正确');
    const output={version};
    for(const key of ['decision_status','decision_reason','positioning','use_scenarios','competitive_points','differentiation_items','review_issues','overview_summary','competitor_summary','supplier_summary','patent_notes','checklist']){
      if(!Object.hasOwn(body,key))continue;
      if(key==='decision_status'){
        if(!['观察中','通过','淘汰'].includes(body[key]))throw new Error('决策状态不正确');
        output[key]=body[key];
      }else if(['differentiation_items','review_issues','checklist'].includes(key)){
        if(!Array.isArray(body[key]))throw new Error(`${key}格式不正确`);
        output[key]=body[key].slice(0,100);
      }else output[key]=String(body[key]??'').trim().slice(0,10000);
    }
    return output;
  }
  function validateSelectionSupplier(body,partial=false) {
    const output={};
    const fields=['name','product_url','image_url','cost_cny','moq','specifications','certifications','sample_reason','pre_sample_score','post_sample_score','pros','cons','target_country_code','target_sale_price'];
    for(const key of fields){
      if(!Object.hasOwn(body,key))continue;
      if(key==='product_url')output[key]=validHttpUrl(body[key],'商品链接');
      else if(key==='image_url')output[key]=validHttpUrl(body[key],'图片链接');
      else if(['cost_cny','moq','target_sale_price'].includes(key))output[key]=selectionNumber(body[key],key);
      else if(['pre_sample_score','post_sample_score'].includes(key))output[key]=selectionNumber(body[key],key,{nullable:true,max:100});
      else if(key==='target_country_code')output[key]=String(body[key]??'').trim().slice(0,8).toUpperCase();
      else output[key]=String(body[key]??'').trim().slice(0,4000);
    }
    if(!partial)Object.assign(output,{
      name:output.name??'',product_url:output.product_url??'',image_url:output.image_url??'',
      cost_cny:output.cost_cny??0,moq:output.moq??0,specifications:output.specifications??'',
      certifications:output.certifications??'',sample_reason:output.sample_reason??'',
      pre_sample_score:output.pre_sample_score??null,post_sample_score:output.post_sample_score??null,
      pros:output.pros??'',cons:output.cons??'',target_country_code:output.target_country_code??'',
      target_sale_price:output.target_sale_price??0
    });
    return output;
  }
  function selectionRevenue(row,activeCountries) {
    if(row.country_code==='AU')return {monthly_sales:Number(row.monthly_sales)||0,revenue:Number(row.monthly_revenue_local)||0,currency:'AUD',symbol:'A$'};
    let revenue=Number(row.monthly_revenue_usd)||0;
    if(!revenue){
      const localRate=Number(activeCountries.find((item)=>item.code===row.country_code)?.cny_per_local)||0;
      const usdRate=Number(activeCountries.find((item)=>item.code==='US')?.cny_per_local)||0;
      if(localRate&&usdRate)revenue=(Number(row.monthly_revenue_local)||0)*localRate/usdRate;
    }
    return {monthly_sales:Number(row.monthly_sales)||0,revenue,currency:'USD',symbol:'$'};
  }
  async function selectionCalculation(project,listing,cost,salePrice) {
    const activeCountries=await countries();const country=activeCountries.find((item)=>item.code===listing.country_code);
    const fba=await rowsFor('fba');const sizes=await rowsFor('sizes');const freight=await rowsFor('freight');
    return window.MarginGoProfit.calculateProfit({
      project:{...project,cost_cny:Number(cost??project.cost_cny)||0},
      country,listing:{...listing,sale_price:Number(salePrice??listing.sale_price)||0},
      fbaRules:fba.filter((row)=>row.country_code===country.code),
      sizeTiers:sizes.filter((row)=>row.country_code===country.code),
      freightRule:freight.find((row)=>row.country_code===country.code)||null
    });
  }
  async function selectionSupplier(row,project) {
    const listing=project.listings.find((item)=>item.country_code===row.target_country_code);
    if(!listing||Number(row.target_sale_price)<=0)return {...row,calculation:null};
    const result=await selectionCalculation(project,listing,row.cost_cny,row.target_sale_price);
    const invested=Number(result.product_cost||0)+Number(result.freight_fee||0);
    return {...row,calculation:{...result,roi:invested?Number((Number(result.profit||0)/invested*100).toFixed(2)):0}};
  }
  async function selectionPayload(projectId) {
    const project=await getProject(projectId);if(!project)return null;
    const activeCountries=await countries();
    const siteRows=activeCountries.map((country)=>({
      project_id:Number(projectId),country_code:country.code,country_name:country.name,flag:country.flag,currency:country.currency,
      market_average_revenue:0,market_average_sales:0,new_product_friendliness:'',same_product_performance:'',
      opportunity_status:'',opportunity_notes:'',certification_required:'',certification_actual:'',
      supplier_certifications:'',certification_gap:'',certification_gap_cost:0,payback_period:'',
      ...(selectionLocal.sites[`${projectId}:${country.code}`]||{})
    }));
    const profits=[];
    for(const listing of project.listings)profits.push({
      country_code:listing.country_code,country_name:listing.country_name,flag:listing.flag,currency:listing.currency,
      symbol:listing.symbol,sale_price:Number(listing.sale_price)||0,
      calculation:Number(listing.sale_price)>0?await selectionCalculation(project,listing):null
    });
    const competitors=(await listCompetitors(projectId)).filter(Boolean);
    const decorate=(row)=>({...row,selection_revenue:selectionRevenue(row,activeCountries)});
    const suppliers=await Promise.all(selectionLocal.suppliers.filter((row)=>Number(row.project_id)===Number(projectId)).map((row)=>selectionSupplier(row,project)));
    saveSelection();
    return {project,document:selectionDocument(projectId),sites:siteRows,suppliers,profits,competitors:{
      standard:competitors.filter((row)=>row.competitor_kind!=='similar').map(decorate),
      similar:competitors.filter((row)=>row.competitor_kind==='similar').map(decorate)
    }};
  }

  function normalizeHs(value) {
    const digits = String(value || '').replace(/\D/g,'');
    if (![6,9,10].includes(digits.length)) throw new Error('请输入国内 10 位 HS 编码');
    const chapter = Number(digits.slice(0,2));
    if (chapter < 1 || chapter > 97 || chapter === 77) throw new Error('HS 编码章节无效');
    return digits;
  }

  function chooseTariff(row,preference) {
    if (preference === 'rcep') {
      if (row.chinaRcep?.percent != null) return { ...row.chinaRcep,type:'中国 RCEP' };
      return { text:row.chinaRcep?.text || '',percent:null,type:'中国 RCEP',warning:'该税目没有可直接换算的中国 RCEP 百分比税率' };
    }
    const selected = [['WTO/MFN',row.wto],['临时税率',row.temporary],['一般税率',row.general]].find(([,rate]) => rate?.percent != null);
    return selected ? { ...selected[1],type:selected[0] }
      : { text:row.wto?.text || row.temporary?.text || row.general?.text || '',percent:null,type:'普通适用税率',warning:'该税目不是单一百分比税率，请人工确认' };
  }

  async function lookupTariff(body) {
    const normalized = normalizeHs(body.hs_code);
    if ((body.origin_country || 'CN') !== 'CN') throw new Error('第一版暂时仅支持中国原产商品');
    const preference = body.preference || 'unknown'; const chapter = normalized.slice(0,2);
    let manifest = cache.tariff.get('manifest');
    if (!manifest) {
      const result = await nativeFetch('./data/japan-tariff/manifest.json',{ cache:'no-cache' });
      if (!result.ok) throw new Error('日本税则数据尚未生成，请等待 GitHub Pages 更新任务完成');
      manifest = await result.json(); cache.tariff.set('manifest',manifest);
    }
    let rows = cache.tariff.get(chapter);
    if (!rows) {
      const result = await nativeFetch(`./data/japan-tariff/${chapter}.json`,{ cache:'no-cache' });
      if (!result.ok) throw new Error(`日本税则第 ${chapter} 章尚未同步`);
      rows = await result.json(); cache.tariff.set(chapter,rows);
    }
    const matchingHs6 = normalized.slice(0,6);
    let matches = rows.filter((row) => normalized.length === 9 ? row.code === normalized : row.hs6 === matchingHs6);
    if (normalized.length !== 9 && matches.some((row) => row.statisticalCode)) matches = matches.filter((row) => row.statisticalCode);
    matches = matches.filter((row,index,array) => array.findIndex((item) => item.code === row.code) === index);
    if (!matches.length) throw new Error('日本官方税则中未找到该国内编码前 6 位对应的税目');
    const candidates = matches.map((row) => {
      const rate = chooseTariff(row,preference === 'unknown' ? 'none' : preference);
      return { code:row.code,description:row.description,rate:rate.percent,rateText:rate.text,rateType:rate.type,
        warning:rate.warning || (preference === 'unknown' ? '优惠资格未知，暂按非优惠税率建议' : '') };
    });
    const candidate = candidates.length === 1 && candidates[0].rate != null ? candidates[0] : null;
    return { status:candidate ? 'matched':'needs_confirmation',inputCode:normalized,matchingHs6,originCountry:'CN',preference,
      scheduleDate:manifest.scheduleDate,sourceUrl:`${manifest.sourceRoot}/data/e_${chapter}.htm`,referenceOnly:true,candidate,candidates };
  }

  async function route(url,options = {}) {
    const pathname = new URL(url,location.href).pathname;
    const path = pathname.slice(pathname.indexOf('/api/')); const method = String(options.method || 'GET').toUpperCase();
    if (method === 'GET' && path === '/api/bootstrap') {
      return json(200,{ countries:await countries(),projects:[...local.projects].sort((a,b) => String(b.updated_at).localeCompare(String(a.updated_at))),ruleCounts:{
        fba:(await rowsFor('fba')).length,freightMissing:(await rowsFor('freight')).filter((row) => row.status === 'missing').length,commission:(await rowsFor('commission')).length } });
    }
    if (method === 'POST' && path === '/api/projects') {
      const body = readBody(options); const now = new Date().toISOString(); const id = local.nextProjectId++;
      const project = { id,name:body.name || '未命名品类',cost_cny:0,length:0,width:0,height:0,dimension_unit:'cm',weight:0,weight_unit:'kg',image_data:'',created_at:now,updated_at:now };
      local.projects.push(project); for (const country of await countries()) local.listings[`${id}:${country.code}`] = blankListing(id,country);
      save(); return json(201,await getProject(id));
    }
    const projectMatch = path.match(/^\/api\/projects\/(\d+)$/);
    if (projectMatch && method === 'GET') { const project = await getProject(projectMatch[1]); return project ? json(200,project):json(404,{ error:'品类不存在' }); }
    if (projectMatch && method === 'PUT') {
      const project = local.projects.find((item) => Number(item.id) === Number(projectMatch[1]));
      if (!project) return json(404,{ error:'品类不存在' });
      Object.assign(project,readBody(options),{ updated_at:new Date().toISOString() }); save(); return json(200,await getProject(project.id));
    }
    if (projectMatch && method === 'DELETE') {
      const id = Number(projectMatch[1]); const before = local.projects.length; local.projects = local.projects.filter((item) => Number(item.id) !== id);
      for (const key of Object.keys(local.listings)) if (key.startsWith(`${id}:`)) delete local.listings[key];
      local.competitors = local.competitors.filter((item) => Number(item.project_id) !== id);
      delete selectionLocal.documents[String(id)];
      for(const key of Object.keys(selectionLocal.sites))if(key.startsWith(`${id}:`))delete selectionLocal.sites[key];
      selectionLocal.suppliers=selectionLocal.suppliers.filter((item)=>Number(item.project_id)!==id);
      save();saveSelection(); return before === local.projects.length ? json(404,{ error:'品类不存在' }):json(200,{ ok:true });
    }
    const listingMatch = path.match(/^\/api\/projects\/(\d+)\/countries\/([A-Z]{2})$/);
    if (listingMatch && method === 'PUT') {
      const key = `${Number(listingMatch[1])}:${listingMatch[2]}`; local.listings[key] = { ...(local.listings[key] || {}),...readBody(options) };
      const project = local.projects.find((item) => Number(item.id) === Number(listingMatch[1])); if (project) project.updated_at = new Date().toISOString();
      save(); return json(200,await getProject(listingMatch[1]));
    }
    const competitorListMatch = path.match(/^\/api\/projects\/(\d+)\/competitors$/);
    if (competitorListMatch && method === 'GET') return json(200,{ competitors:await listCompetitors(competitorListMatch[1]) });
    if (competitorListMatch && method === 'POST') {
      const project = await getProject(competitorListMatch[1]); if (!project) return json(404,{ error:'品类不存在' });
      const body = readBody(options); const listing = project.listings.find((item) => item.country_code === body.country_code);
      if (!listing) return json(400,{ error:'站点不存在' });
      const now = new Date().toISOString(); const row = { id:local.nextCompetitorId++,project_id:project.id,country_code:body.country_code,
        name:String(body.name || ''),sale_price:Number(body.sale_price) || 0,cost_cny:project.cost_cny,length:project.length,width:project.width,
        height:project.height,dimension_unit:project.dimension_unit,weight:project.weight,weight_unit:project.weight_unit,
        category_text:listing.category_text,uses_project_defaults:1,created_at:now,updated_at:now };
      local.competitors.push(row); save(); return json(201,await calculateCompetitor(row));
    }
    const competitorMatch = path.match(/^\/api\/competitors\/(\d+)$/);
    if (competitorMatch && method === 'PUT') {
      const row = local.competitors.find((item) => Number(item.id) === Number(competitorMatch[1])); if (!row) return json(404,{ error:'竞品不存在' });
      const body = readBody(options); const parameterFields = ['cost_cny','length','width','height','dimension_unit','weight','weight_unit','category_text'];
      if (parameterFields.some((key) => Object.hasOwn(body,key)) && !Object.hasOwn(body,'uses_project_defaults')) body.uses_project_defaults = 0;
      Object.assign(row,body,{ uses_project_defaults:Number(Boolean(body.uses_project_defaults ?? row.uses_project_defaults)),updated_at:new Date().toISOString() });
      save(); return json(200,await calculateCompetitor(row));
    }
    if (competitorMatch && method === 'DELETE') {
      const id = Number(competitorMatch[1]); const before = local.competitors.length; local.competitors = local.competitors.filter((item) => Number(item.id) !== id);
      save(); return before === local.competitors.length ? json(404,{ error:'竞品不存在' }):json(200,{ ok:true });
    }
    const selectionDocumentMatch=path.match(/^\/api\/projects\/(\d+)\/selection-document$/);
    if(selectionDocumentMatch&&method==='GET'){
      const payload=await selectionPayload(selectionDocumentMatch[1]);
      return payload?json(200,payload):json(404,{error:'品类不存在'});
    }
    if(selectionDocumentMatch&&method==='PUT'){
      const project=await getProject(selectionDocumentMatch[1]);if(!project)return json(404,{error:'品类不存在'});
      let body;try{body=validateSelectionDocument(readBody(options))}catch(error){return json(400,{error:error.message})}
      const current=selectionDocument(selectionDocumentMatch[1]);
      if(Number(body.version)!==Number(current.version))return json(409,{error:'数据已被他人更新，请刷新后再编辑'});
      for(const key of ['decision_status','decision_reason','positioning','use_scenarios','competitive_points','differentiation_items','review_issues','overview_summary','competitor_summary','supplier_summary','patent_notes','checklist']){
        if(Object.hasOwn(body,key))current[key]=body[key];
      }
      current.version+=1;current.updated_at=new Date().toISOString();saveSelection();return json(200,current);
    }
    const selectionSiteMatch=path.match(/^\/api\/projects\/(\d+)\/selection-document\/sites\/([A-Z]{2})$/);
    if(selectionSiteMatch&&method==='PUT'){
      const project=await getProject(selectionSiteMatch[1]);if(!project)return json(404,{error:'品类不存在'});
      if(!project.listings.some((item)=>item.country_code===selectionSiteMatch[2]))return json(400,{error:'站点不存在'});
      let body;try{body=validateSelectionSite(readBody(options))}catch(error){return json(400,{error:error.message})}
      const key=`${selectionSiteMatch[1]}:${selectionSiteMatch[2]}`;
      selectionLocal.sites[key]={...(selectionLocal.sites[key]||{}),...body,project_id:Number(selectionSiteMatch[1]),country_code:selectionSiteMatch[2],updated_at:new Date().toISOString()};
      saveSelection();return json(200,selectionLocal.sites[key]);
    }
    const selectionSupplierCollection=path.match(/^\/api\/projects\/(\d+)\/selection-document\/suppliers$/);
    if(selectionSupplierCollection&&method==='POST'){
      const project=await getProject(selectionSupplierCollection[1]);if(!project)return json(404,{error:'品类不存在'});
      let body;try{body=validateSelectionSupplier(readBody(options))}catch(error){return json(400,{error:error.message})}
      if(body.target_country_code&&!project.listings.some((item)=>item.country_code===body.target_country_code))return json(400,{error:'站点不存在'});
      const now=new Date().toISOString();const row={id:selectionLocal.nextSupplierId++,project_id:Number(project.id),
        ...body,created_at:now,updated_at:now};
      selectionLocal.suppliers.push(row);saveSelection();return json(201,await selectionSupplier(row,project));
    }
    const selectionSupplierMatch=path.match(/^\/api\/selection-suppliers\/(\d+)$/);
    if(selectionSupplierMatch&&method==='PUT'){
      const row=selectionLocal.suppliers.find((item)=>Number(item.id)===Number(selectionSupplierMatch[1]));if(!row)return json(404,{error:'供应商不存在'});
      let body;try{body=validateSelectionSupplier(readBody(options),true)}catch(error){return json(400,{error:error.message})}
      const project=await getProject(row.project_id);
      if(body.target_country_code&&!project.listings.some((item)=>item.country_code===body.target_country_code))return json(400,{error:'站点不存在'});
      Object.assign(row,body,{updated_at:new Date().toISOString()});saveSelection();return json(200,await selectionSupplier(row,await getProject(row.project_id)));
    }
    if(selectionSupplierMatch&&method==='DELETE'){
      const id=Number(selectionSupplierMatch[1]);const before=selectionLocal.suppliers.length;
      selectionLocal.suppliers=selectionLocal.suppliers.filter((item)=>Number(item.id)!==id);saveSelection();
      return before===selectionLocal.suppliers.length?json(404,{error:'供应商不存在'}):json(200,{ok:true});
    }
    if (method === 'POST' && path === '/api/commission/match') { const body = readBody(options); return json(200,await matchCommission(body.country_code,body.text,body.sale_price)); }
    if (method === 'POST' && path === '/api/tariffs/japan/lookup') return json(200,await lookupTariff(readBody(options)));
    if (method === 'POST' && path === '/api/calculate') {
      const body = readBody(options); const project = await getProject(body.project_id); if (!project) return json(404,{ error:'品类不存在' });
      const activeCountries = await countries(); const fba = await rowsFor('fba'); const sizes = await rowsFor('sizes'); const freight = await rowsFor('freight');
      const listings = body.country_code ? project.listings.filter((item) => item.country_code === body.country_code) : project.listings.filter((item) => item.selected);
      const results = listings.map((listing) => {
        const country = activeCountries.find((item) => item.code === listing.country_code);
        const calculationArgs={ project,country,listing,fbaRules:fba.filter((row) => row.country_code === country.code),
          sizeTiers:sizes.filter((row) => row.country_code === country.code),freightRule:freight.find((row) => row.country_code === country.code) || null };
        const result=window.MarginGoProfit.calculateProfit(calculationArgs);
        if(body.include_target_prices)result.target_prices=Object.fromEntries([0,10,20,30].map((targetRate)=>[
          targetRate,window.MarginGoProfit.findSalePriceForProfitRate({ ...calculationArgs,targetRate })
        ]));
        return result;
      });
      return json(200,{ project_id:project.id,results });
    }
    const listMatch = path.match(/^\/api\/rules\/(countries|sizes|fba|freight|commission)$/);
    if (listMatch && method === 'GET') return json(200,await rowsFor(listMatch[1]));
    const itemMatch = path.match(/^\/api\/rules\/(countries|sizes|fba|freight|commission)\/([^/]+)$/);
    if (itemMatch && method === 'PUT') {
      const key = `${itemMatch[1]}:${decodeURIComponent(itemMatch[2])}`; local.overrides[key] = { ...(local.overrides[key] || {}),...readBody(options) }; save(); return json(200,{ ok:true });
    }
    return json(404,{ error:'接口不存在' });
  }

  window.fetch = async (url,options) => {
    const target = typeof url === 'string' ? url:url.url;
    if (!new URL(target,location.href).pathname.includes('/api/')) return nativeFetch(url,options);
    try { return await route(target,options); } catch (error) { return json(500,{ error:error.message || '浏览器本地计算异常' }); }
  };

  window.addEventListener('DOMContentLoaded',() => {
    const foot = document.querySelector('.sidebar-foot'); if (!foot) return;
    const tools = document.createElement('div'); tools.className = 'static-data-tools';
    tools.innerHTML = '<button type="button" id="exportLocalData">导出备份</button><button type="button" id="importLocalData">导入数据</button><input id="importLocalFile" type="file" accept="application/json" hidden>';
    foot.before(tools);
    const style = document.createElement('style'); style.textContent = '.static-data-tools{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px 8px}.static-data-tools button{padding:7px 5px;border:1px solid #e2e2e5;border-radius:8px;background:#fff;color:#777;font-size:10px}.static-data-tools button:hover{border-color:#ff9b54;color:#e86509}'; document.head.append(style);
    document.querySelector('#exportLocalData').onclick = () => { const blob = new Blob([JSON.stringify(local,null,2)],{ type:'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `MarginGo备份-${new Date().toISOString().slice(0,10)}.json`; link.click(); URL.revokeObjectURL(link.href); };
    const input = document.querySelector('#importLocalFile'); document.querySelector('#importLocalData').onclick = () => input.click();
    input.onchange = async () => { try { const imported = JSON.parse(await input.files[0].text());
      if (imported?.version !== 1 || !Array.isArray(imported.projects)) throw new Error('备份格式不正确');
      local = { ...emptyState(),...imported }; save(); location.reload(); } catch (error) { alert(error.message); } };
  });
})();
