'use strict';

const ExcelJS=require('exceljs');

const HEADERS={
  '负责人':'owner_name','父ASIN':'parent_asin','子ASIN':'child_asin','品名':'product_name','图片':'image_data',
  '长度':'length','宽度':'width','高度':'height','尺寸单位':'dimension_unit','重量':'weight','重量单位':'weight_unit',
  '成本(CNY)':'cost_cny','销售额(CNY)':'sales_amount_cny','六日能力':'six_day_capacity','站点代码':'country_code',
  '站点名称':'country_name','币种':'currency','币种符号':'symbol','售价':'sale_price','销量':'sales_qty',
  '单件利润':'unit_profit','利润率(%)':'profit_rate'
};

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.result !== undefined) return value.result;
    if (value.text !== undefined) return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text).join('');
  }
  return value;
}

async function parseWorkbookBase64(base64) {
  if (!base64 || String(base64).length > 14_000_000) throw new Error('Excel 文件为空或超过 10MB');
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(String(base64).replace(/^data:.*;base64,/,''),'base64'));
  const sheet=workbook.worksheets[0];
  if (!sheet) throw new Error('Excel 中没有工作表');
  const columns=new Map();
  sheet.getRow(1).eachCell({ includeEmpty:false },(cell,column) => {
    const field=HEADERS[String(scalar(cell.value)).trim()];
    if (field) columns.set(column,field);
  });
  for (const required of ['owner_name','parent_asin','product_name']) {
    if (![...columns.values()].includes(required)) throw new Error(`Excel 缺少必填列：${Object.keys(HEADERS).find((key) => HEADERS[key] === required)}`);
  }
  const rows=[];
  for (let rowNumber=2;rowNumber<=sheet.rowCount;rowNumber++) {
    const source=sheet.getRow(rowNumber);const row={};let populated=false;
    for (const [column,field] of columns) {
      const value=scalar(source.getCell(column).value);
      row[field]=value;
      if (value !== '' && value !== null && value !== undefined) populated=true;
    }
    if (populated) rows.push(row);
  }
  return rows;
}

module.exports={ HEADERS,scalar,parseWorkbookBase64 };
