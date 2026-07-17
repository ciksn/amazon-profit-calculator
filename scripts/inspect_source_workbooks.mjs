import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const files = [
  'C:/Users/30449/Desktop/marginGO/各国FBA计算规则表/欧盟-德国，英国.xlsx',
  'C:/Users/30449/Desktop/marginGO/品类佣金表/欧盟德国.xlsx',
];

for (const file of files) {
  const input = await FileBlob.load(file);
  const workbook = await SpreadsheetFile.importXlsx(input);
  const summary = await workbook.inspect({
    kind: 'workbook,sheet,table,region',
    maxChars: 50000,
    tableMaxRows: 200,
    tableMaxCols: 20,
    tableMaxCellChars: 200,
  });
  console.log(`\n===== ${file} =====`);
  console.log(summary.ndjson);
}
