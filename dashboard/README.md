# MarginGo 个人利润率看板（PostgreSQL）

这是与原 SQLite 利润计算器隔离的本地前后端版本。当前默认使用手动产品清单，不自动读取公司数据库，也不启用飞书 OAuth。

## 当前功能

- 清单从空白开始，可手动填写负责人、父/子 ASIN、品名、图片、尺寸、重量、成本、销售额和六日能力。
- 一个产品可保存多个实际存在的站点结果；点击产品行展开售价、销量、单件利润和利润率。
- 支持负责人、关键词、站点和盈亏状态筛选，并可按销售额或六日能力排序。
- 支持下载 Excel 模板并批量导入。
- 利润计算器的产品行提供“加入产品看板”，按负责人和父 ASIN 写入或更新产品及站点计算结果。
- 飞书 OAuth 代码保留但默认隔离；旧公司快照通过 `/api/company-dashboard` 保留，不参与 `/api/dashboard` 的手动看板。

## 本地初始化

1. 确保本地 PostgreSQL 可用，并在 `config/datapool.local.json` 中填写本地连接信息。密钥配置文件已被 Git 忽略。
2. 执行数据库迁移：

   ```powershell
   npm.cmd run db:migrate
   ```

3. 启动看板：

   ```powershell
   npm.cmd run start:dashboard
   ```

4. 打开 <http://127.0.0.1:4180>。`AUTH_MODE=local` 时不会进入飞书授权流程。

原利润计算器默认运行在 <http://127.0.0.1:4173>。从计算器加入看板前，需要在产品资料中填写负责人和父 ASIN。

## Excel 导入规则

点击看板右上角“下载 Excel 模板”。同一负责人、同一父 ASIN 的多行会合并为一个产品；每行可填写一个站点。负责人和父 ASIN 必填，站点代码填写后，站点名称、币种、币种符号、售价、销量、单件利润及利润率会保存到展开行。

导入采用事务处理：任一行校验失败时，本次文件不会写入部分数据。重复导入相同负责人和父 ASIN时会更新该产品。

## 数据接口

- `GET /api/dashboard`：手动看板数据、汇总和筛选项。
- `POST /api/manual-products`：新增手动产品。
- `PUT /api/manual-products/:id`：修改产品。
- `DELETE /api/manual-products/:id`：删除产品。
- `POST /api/manual-products/import-excel`：导入 Excel。
- `POST /api/manual-products/from-calculator`：接收利润计算器结果。
- `GET /api/company-dashboard`：旧公司数据池快照兼容接口。

## 飞书登录

飞书 OAuth 暂时隔离，默认 `AUTH_MODE=local`。以后需要恢复时再设置 `AUTH_MODE=feishu` 并填写对应配置。
