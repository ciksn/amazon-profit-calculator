'use strict';

((root,factory)=>{
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.MarginGoCompetitorImport=api;
})(typeof globalThis!=='undefined'?globalThis:this,()=>{
  const text=(value)=>{
    if(value==null)return '';
    if(value instanceof Date)return value.toISOString().slice(0,10);
    if(typeof value==='object'){
      if(value.result!=null)return text(value.result);
      if(value.text!=null)return text(value.text);
      if(value.hyperlink)return text(value.text||value.hyperlink);
      if(Array.isArray(value.richText))return value.richText.map((item)=>item.text||'').join('');
    }
    return String(value).trim();
  };
  const number=(value)=>{
    if(typeof value==='number')return Number.isFinite(value)?value:0;
    const normalized=text(value).replace(/,/g,'').replace(/[^\d.+-]/g,'');
    const parsed=Number(normalized);return Number.isFinite(parsed)?parsed:0;
  };
  const headerKey=(value)=>text(value).toLowerCase().replace(/[\s_（）()\-—:/：]/g,'');
  const headerIndex=(headers)=>new Map(headers.map((header,index)=>[headerKey(header),index]));
  const findColumn=(headers,names=[],pattern=null)=>{
    const lookup=headerIndex(headers);
    for(const name of names){const index=lookup.get(headerKey(name));if(index!=null)return index}
    if(pattern){const index=headers.findIndex((header)=>pattern.test(text(header)));if(index>=0)return index}
    return -1;
  };
  const valueAt=(row,index)=>index<0?'':row[index];
  const yesNo=(value)=>{
    const normalized=text(value).toLowerCase();
    if(['y','yes','是','有','true','1'].includes(normalized))return true;
    if(['n','no','否','无','false','0'].includes(normalized))return false;
    return null;
  };
  const isFba=(value)=>/\b(?:fba|amz|amazon)\b/i.test(text(value));
  const h10SalesHeaders=['ASIN 销量','月销量','父级销量'];
  const h10RevenueHeaders=['ASIN 收入','月销售额','父级收入'];
  const detectFormat=(headers)=>{
    const keys=new Set(headers.map(headerKey));
    if(keys.has(headerKey('商品主图'))&&keys.has(headerKey('商品详情页链接')))return 'seller_sprite';
    const hasH10Identity=keys.has(headerKey('图片 URL'))&&keys.has(headerKey('URL'))&&keys.has(headerKey('ASIN'))&&keys.has(headerKey('标题'));
    const hasH10Metric=[...h10SalesHeaders,...h10RevenueHeaders].some((name)=>keys.has(headerKey(name)));
    if(hasH10Identity&&hasH10Metric)return 'helium10';
    return '';
  };
  const compact=(value,max=4000)=>text(value).slice(0,max);
  const rounded=(value,digits)=>Number((Number(value)||0).toFixed(digits));
  const webUrl=(value)=>{const url=compact(value);return /^https?:\/\//i.test(url)?url:''};
  const measurement=(value,targetUnit)=>{
    const raw=text(value).toLowerCase();const amount=Number((raw.match(/-?\d+(?:\.\d+)?/)||[])[0]);
    if(!Number.isFinite(amount))return 0;
    if(targetUnit==='kg'){
      if(/\b(?:lb|lbs|pound|pounds)\b/.test(raw))return amount*0.45359237;
      if(/\b(?:oz|ounce|ounces)\b/.test(raw))return amount*0.028349523125;
      if(/(?:^|\s)g(?:$|\s)/.test(raw)&&!/\bkg\b/.test(raw))return amount/1000;
      return amount;
    }
    if(/\b(?:in|inch|inches)\b/.test(raw))return amount*2.54;
    if(/\b(?:ft|foot|feet)\b/.test(raw))return amount*30.48;
    if(/\bmm\b/.test(raw))return amount/10;
    if(/\bm\b/.test(raw)&&!/\bcm\b/.test(raw))return amount*100;
    return amount;
  };
  const dimensionsCm=(value)=>{
    const raw=text(value);const values=(raw.match(/\d+(?:\.\d+)?/g)||[]).slice(0,3).map(Number);
    if(values.length<3)return [];
    const lower=raw.toLowerCase();const factor=/\b(?:in|inch|inches)\b/.test(lower)?2.54:/\b(?:ft|foot|feet)\b/.test(lower)?30.48:/\bmm\b/.test(lower)?.1:/\bm\b/.test(lower)&&!/\bcm\b/.test(lower)?100:1;
    return values.map((item)=>rounded(item*factor,2));
  };
  const usdAmount=(localAmount,headers,revenueIndex,context)=>{
    const header=text(headers[revenueIndex]);
    const isUsd=context.countryCode==='US'||/usd/i.test(header)||/^月销售额\(\$\)$/i.test(header.replace(/\s/g,''));
    if(isUsd)return localAmount;
    const localRate=Number(context.countryCnyPerLocal)||0;const usdRate=Number(context.usdCnyPerLocal)||0;
    return localRate>0&&usdRate>0?localAmount*localRate/usdRate:0;
  };
  function parseRows(headers,rows,context={}){
    const format=detectFormat(headers);
    if(!format)throw new Error('未识别 Excel 格式，请使用卖家精灵或 H10 产品导出文件');
    const column=(names,pattern)=>findColumn(headers,names,pattern);
    const indexes=format==='seller_sprite'?{
      asin:column(['ASIN']),name:column(['商品标题']),url:column(['商品详情页链接']),image:column(['商品主图']),
      price:column(['价格($)','价格'],/^价格/),fulfillment:column(['配送方式']),aplus:column(['A+页面']),video:column(['视频介绍']),
      listed:column(['上架时间']),sales:column(['月销量']),revenue:column([],/^月销售额/),rating:column(['评分']),
      category:column(['类目路径','大类目']),weight:column(['包装重量（单位换算）','商品重量（单位换算）','包装重量','商品重量']),
      dimensions:column(['包装尺寸（单位换算）','商品尺寸（单位换算）','包装尺寸','商品尺寸'])
    }:{
      asin:column(['ASIN']),name:column(['标题']),url:column(['URL']),image:column(['图片 URL']),price:column(['价格'],/^价格/),
      fulfillment:column(['配送方式']),aplus:column(['A+页面']),video:column(['视频介绍']),listed:column(['上架时间']),
      age:column(['年龄（月）']),sales:column(h10SalesHeaders),revenue:column(h10RevenueHeaders),rating:column(['评论评分']),
      category:column(['类目','子类目']),length:column(['长度']),width:column(['宽度']),height:column(['高度']),weight:column(['重量'])
    };
    return rows.map((row,rowOffset)=>{
      const localRevenue=number(valueAt(row,indexes.revenue));
      const age=number(valueAt(row,indexes.age));
      const listed=compact(valueAt(row,indexes.listed),80)||(age?`约 ${number(valueAt(row,indexes.age))} 个月`:'');
      const importedDimensions=format==='seller_sprite'?dimensionsCm(valueAt(row,indexes.dimensions)):[
        rounded(number(valueAt(row,indexes.length))*2.54,2),rounded(number(valueAt(row,indexes.width))*2.54,2),rounded(number(valueAt(row,indexes.height))*2.54,2)
      ];
      return {
        asin:compact(valueAt(row,indexes.asin),32),name:compact(valueAt(row,indexes.name),1000),
        product_url:webUrl(valueAt(row,indexes.url)),image_url:webUrl(valueAt(row,indexes.image)),
        sale_price:number(valueAt(row,indexes.price)),is_fba:isFba(valueAt(row,indexes.fulfillment)),
        has_aplus:yesNo(valueAt(row,indexes.aplus)),has_video:yesNo(valueAt(row,indexes.video)),
        listing_date:listed,monthly_sales:number(valueAt(row,indexes.sales)),monthly_revenue_local:localRevenue,
        monthly_revenue_usd:usdAmount(localRevenue,headers,indexes.revenue,context),rating:number(valueAt(row,indexes.rating))||null,
        category_text:compact(valueAt(row,indexes.category),500),length:importedDimensions[0]||0,width:importedDimensions[1]||0,
        height:importedDimensions[2]||0,dimension_unit:'cm',weight:rounded(format==='seller_sprite'?measurement(valueAt(row,indexes.weight),'kg'):number(valueAt(row,indexes.weight))*0.45359237,3),weight_unit:'kg',
        source_format:format,source_row:rowOffset+2
      };
    }).filter((row)=>row.asin||row.name||row.product_url).filter((row)=>row.sale_price||row.monthly_sales||row.monthly_revenue_local);
  }
  async function parseWorkbook(buffer,ExcelJS,context={}){
    if(!ExcelJS?.Workbook)throw new Error('Excel 解析组件未加载，请刷新页面后重试');
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);
    for(const worksheet of workbook.worksheets){
      const maxHeaderRow=Math.min(20,worksheet.actualRowCount||20);
      for(let rowNumber=1;rowNumber<=maxHeaderRow;rowNumber+=1){
        const headers=worksheet.getRow(rowNumber).values.slice(1).map(text);
        if(!detectFormat(headers))continue;
        const rows=[];
        for(let dataRow=rowNumber+1;dataRow<=worksheet.actualRowCount;dataRow+=1)rows.push(worksheet.getRow(dataRow).values.slice(1));
        return {format:detectFormat(headers),rows:parseRows(headers,rows,context),sheetName:worksheet.name};
      }
    }
    throw new Error('未识别 Excel 格式，请使用卖家精灵或 H10 产品导出文件');
  }
  return {detectFormat,parseRows,parseWorkbook};
});
