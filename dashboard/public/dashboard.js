'use strict';

const state={ owner:'',site:'',profit:'',sort:'updated_desc',search:'',timer:null,expanded:new Set(),products:[] };
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const escapeHtml=(value)=>String(value ?? '').replace(/[&<>"]/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
const numberOrNull=(value)=>value === '' || value == null ? null : Number(value);

async function api(path,options={}) {
  const response=await fetch(path,{ headers:{ 'Content-Type':'application/json',...(options.headers || {}) },...options });
  const body=await response.json().catch(()=>({}));
  if (response.status === 401) { $('#loginLayer').classList.remove('hidden');throw new Error('请先登录'); }
  if (!response.ok) throw new Error(body.error || '读取失败');
  return body;
}

function showNotice(message,error=false) {
  const notice=$('#notice');notice.textContent=message;notice.classList.remove('hidden');notice.classList.toggle('error',error);
  clearTimeout(notice.timer);notice.timer=setTimeout(()=>notice.classList.add('hidden'),3200);
}

function money(value,symbol='¥') { return value == null ? '—' : `${symbol}${Number(value).toLocaleString('zh-CN',{ maximumFractionDigits:2 })}`; }
function valueText(value,suffix='') { return value == null ? '—' : `${Number(value).toLocaleString('zh-CN',{ maximumFractionDigits:2 })}${suffix}`; }

function renderSummary(summary) {
  const rows=[
    ['手动产品',summary.products,'个父 ASIN'],['总销售额',money(summary.total_sales),'当前筛选结果'],
    ['平均利润率',summary.average_profit_rate == null ? '—' : `${summary.average_profit_rate}%`,'站点计算结果'],
    ['盈利站点',summary.profitable_sites,`共 ${summary.sites} 个站点结果`]
  ];
  $('#summaryGrid').innerHTML=rows.map(([label,value,note])=>`<article class="summary-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('');
}

function siteResult(site) {
  const tone=site.profit_rate == null ? '' : Number(site.profit_rate)>=0 ? 'positive':'negative';
  return `<div class="manual-site-row">
    <div class="site-name"><b>${escapeHtml(site.country_code)}</b><small>${escapeHtml(site.country_name || '')}</small></div>
    <div data-label="售价"><b>${money(site.sale_price,site.symbol || '')}</b><small>${escapeHtml(site.currency || '')}</small></div>
    <div data-label="销量"><b>${valueText(site.sales_qty,' 件')}</b><small>手动记录</small></div>
    <div data-label="单件利润"><b class="${tone}">${money(site.unit_profit,site.symbol || '')}</b><small>MarginGo 结果</small></div>
    <div data-label="利润率"><strong class="${tone}">${site.profit_rate == null ? '—' : `${Number(site.profit_rate).toFixed(2)}%`}</strong><small>MarginGo 结果</small></div>
  </div>`;
}

function expandedContent(product) {
  if (!product.sites.length) return '<div class="no-sites">尚未添加站点计算结果，可点击“编辑”补充。</div>';
  return `<div class="manual-site-table"><div class="manual-site-head"><span>站点</span><span>售价</span><span>销量</span><span>单件利润</span><span>利润率</span></div>${product.sites.map(siteResult).join('')}</div>`;
}

function renderTable(products) {
  $('#tableHead').innerHTML='<tr><th>产品</th><th>长 × 宽 × 高</th><th>重量</th><th>成本</th><th>销售额</th><th>六日能力</th><th>站点</th></tr>';
  if (!products.length) {
    $('#productRows').innerHTML='<tr><td class="empty" colspan="7"><b>手动清单还是空的</b><small>点击“新增产品”、导入 Excel，或从利润计算页加入产品。</small></td></tr>';
    return;
  }
  $('#productRows').innerHTML=products.map((product)=>{
    const expanded=state.expanded.has(String(product.id));
    const image=product.image_data ? `<img class="product-image" src="${escapeHtml(product.image_data)}" alt="" loading="lazy">` : '<div class="product-image image-fallback">ASIN</div>';
    const dimensions=[product.length,product.width,product.height].every((value)=>value != null) ? `${product.length} × ${product.width} × ${product.height} ${escapeHtml(product.dimension_unit)}` : '—';
    return `<tr class="parent-row${expanded ? ' expanded':''}" data-product-id="${product.id}" tabindex="0" role="button" aria-expanded="${expanded}">
      <td><div class="product-cell">${image}<div class="product-copy"><b>${escapeHtml(product.product_name)}</b><span>${escapeHtml(product.parent_asin)}</span><small>${escapeHtml(product.owner_name)}${product.child_asin ? ` · 子 ASIN ${escapeHtml(product.child_asin)}`:''}</small></div></div></td>
      <td><span class="spec-value">${dimensions}</span></td><td><span class="spec-value">${valueText(product.weight,` ${escapeHtml(product.weight_unit)}`)}</span></td>
      <td><span class="spec-value">${money(product.cost_cny)}</span></td><td><b>${money(product.sales_amount_cny)}</b></td><td><b>${valueText(product.six_day_capacity)}</b></td>
      <td><div class="coverage"><span>${product.sites.length} 个站点</span><div class="row-actions"><button type="button" data-edit="${product.id}">编辑</button><button type="button" class="danger" data-delete="${product.id}">删除</button><button class="expand-button" type="button" tabindex="-1" aria-label="展开产品">⌄</button></div></div></td>
    </tr><tr class="detail-row${expanded ? '':' hidden'}" data-detail="${product.id}"><td colspan="7">${expandedContent(product)}</td></tr>`;
  }).join('');
}

function renderFilters(filters) {
  const owner=$('#ownerFilter').value;const site=$('#siteFilter').value;
  $('#ownerFilter').innerHTML='<option value="">全部负责人</option>'+filters.owners.map((item)=>`<option value="${escapeHtml(item.owner_name)}">${escapeHtml(item.owner_name)}（${item.product_count}）</option>`).join('');
  $('#siteFilter').innerHTML='<option value="">全部站点</option>'+filters.sites.map((item)=>`<option value="${escapeHtml(item.country_code)}">${escapeHtml(item.country_code)}（${item.product_count}）</option>`).join('');
  $('#ownerFilter').value=owner;$('#siteFilter').value=site;
}

async function load() {
  const query=new URLSearchParams();
  for (const key of ['owner','site','profit','sort','search']) if (state[key]) query.set(key,state[key]);
  try {
    const payload=await api(`/api/dashboard?${query}`);state.products=payload.products;
    $('#loginLayer').classList.add('hidden');$('#userName').textContent=state.owner || '全部负责人';$('#greeting').textContent=state.owner ? `${state.owner}，你好` : '手动产品清单';$('#avatar').textContent=(state.owner || '手').slice(0,1);
    renderSummary(payload.summary);renderFilters(payload.filters);renderTable(payload.products);
  } catch (error) { showNotice(error.message,true); }
}

function siteEditorRow(site={}) {
  return `<div class="site-editor-row">
    <input data-site="country_code" placeholder="站点代码*" maxlength="8" value="${escapeHtml(site.country_code || '')}">
    <input data-site="country_name" placeholder="站点名称" value="${escapeHtml(site.country_name || '')}">
    <input data-site="currency" placeholder="币种" maxlength="12" value="${escapeHtml(site.currency || '')}">
    <input data-site="symbol" placeholder="符号" maxlength="8" value="${escapeHtml(site.symbol || '')}">
    <input data-site="sale_price" type="number" step="0.01" min="0" placeholder="售价" value="${site.sale_price ?? ''}">
    <input data-site="sales_qty" type="number" step="0.01" min="0" placeholder="销量" value="${site.sales_qty ?? 0}">
    <input data-site="unit_profit" type="number" step="0.01" placeholder="单件利润" value="${site.unit_profit ?? ''}">
    <input data-site="profit_rate" type="number" step="0.01" placeholder="利润率%" value="${site.profit_rate ?? ''}">
    <button type="button" data-remove-site>×</button>
  </div>`;
}

function openProductModal(product=null) {
  const form=$('#productForm');form.reset();form.elements.id.value=product?.id || '';
  $('#modalTitle').textContent=product ? `编辑 · ${product.product_name}` : '新增看板产品';
  const fields=['owner_name','parent_asin','child_asin','product_name','image_data','length','width','height','dimension_unit','weight','weight_unit','cost_cny','sales_amount_cny','six_day_capacity'];
  for (const field of fields) if (product && product[field] != null) form.elements[field].value=product[field];
  $('#siteEditor').innerHTML=(product?.sites?.length ? product.sites:[{}]).map(siteEditorRow).join('');
  $('#productModal').classList.remove('hidden');document.body.classList.add('modal-open');
}

function closeProductModal() { $('#productModal').classList.add('hidden');document.body.classList.remove('modal-open'); }

function formPayload() {
  const form=$('#productForm');const payload={};
  for (const field of ['owner_name','parent_asin','child_asin','product_name','image_data','dimension_unit','weight_unit']) payload[field]=form.elements[field].value.trim();
  for (const field of ['length','width','height','weight','cost_cny','sales_amount_cny','six_day_capacity']) payload[field]=numberOrNull(form.elements[field].value);
  payload.sites=$$('.site-editor-row').map((row)=>{
    const site={};for (const input of $$('[data-site]',row)) site[input.dataset.site]=input.type === 'number' ? numberOrNull(input.value) : input.value.trim();return site;
  }).filter((site)=>site.country_code);
  return payload;
}

async function saveForm(event) {
  event.preventDefault();const id=event.currentTarget.elements.id.value;
  try {
    await api(id ? `/api/manual-products/${id}`:'/api/manual-products',{ method:id ? 'PUT':'POST',body:JSON.stringify(formPayload()) });
    closeProductModal();showNotice(id ? '产品已更新':'产品已加入手动看板');await load();
  } catch (error) { showNotice(error.message,true); }
}

async function removeProduct(id) {
  const product=state.products.find((item)=>String(item.id)===String(id));
  if (!product || !window.confirm(`确定从手动看板删除“${product.product_name}”吗？`)) return;
  try { await api(`/api/manual-products/${id}`,{ method:'DELETE' });showNotice('产品已删除');await load(); } catch (error) { showNotice(error.message,true); }
}

function toggleProduct(id) {
  const key=String(id);state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);renderTable(state.products);
}

async function importExcel(file) {
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) return showNotice('请选择 .xlsx 文件',true);
  try {
    const base64=await new Promise((resolve,reject)=>{ const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file); });
    const result=await api('/api/manual-products/import-excel',{ method:'POST',body:JSON.stringify({ file_base64:base64 }) });
    showNotice(`已导入 ${result.imported} 个产品、${result.site_rows} 条站点数据`);await load();
  } catch (error) { showNotice(error.message,true); } finally { $('#excelFile').value=''; }
}

$('#productRows').addEventListener('click',(event)=>{
  const edit=event.target.closest('[data-edit]');if (edit) { event.stopPropagation();return openProductModal(state.products.find((item)=>String(item.id)===edit.dataset.edit)); }
  const remove=event.target.closest('[data-delete]');if (remove) { event.stopPropagation();return removeProduct(remove.dataset.delete); }
  const row=event.target.closest('.parent-row');if (row) toggleProduct(row.dataset.productId);
});
$('#productRows').addEventListener('keydown',(event)=>{ const row=event.target.closest('.parent-row');if (row && (event.key==='Enter'||event.key===' ')) { event.preventDefault();toggleProduct(row.dataset.productId); } });
$('#addProductBtn').onclick=()=>openProductModal();$('#closeModal').onclick=closeProductModal;$('#cancelModal').onclick=closeProductModal;
$('#addSiteBtn').onclick=()=>$('#siteEditor').insertAdjacentHTML('beforeend',siteEditorRow());
$('#siteEditor').addEventListener('click',(event)=>{ const button=event.target.closest('[data-remove-site]');if (button) button.closest('.site-editor-row').remove(); });
$('#productForm').addEventListener('submit',saveForm);$('#importBtn').onclick=()=>$('#excelFile').click();$('#excelFile').onchange=(event)=>importExcel(event.target.files[0]);
$('#ownerFilter').onchange=(event)=>{state.owner=event.target.value;load();};$('#siteFilter').onchange=(event)=>{state.site=event.target.value;load();};
$('#profitFilter').onchange=(event)=>{state.profit=event.target.value;load();};$('#sortFilter').onchange=(event)=>{state.sort=event.target.value;load();};
$('#searchInput').oninput=(event)=>{clearTimeout(state.timer);state.timer=setTimeout(()=>{state.search=event.target.value.trim();load();},300);};
$('#logoutBtn').onclick=()=>{state.owner='';state.site='';state.profit='';state.search='';$('#searchInput').value='';$('#profitFilter').value='';load();};

load();
