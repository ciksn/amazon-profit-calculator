# 选品文档双通道 AI 助手设计

## 目标

在现有“选品文档”工作台右侧增加 AI 对话助手。助手默认通过本机 Codex App Server 对话，也支持用户主动切换到 OpenAI Responses API。AI 能读取当前品类的全部数据并优先分析当前章节，但只能提出对文本结论、差异化方案、自查项和站点评估的修改建议。任何建议都必须先显示修改预览，由用户确认后才能写入数据库。

每个品类保存独立且可恢复的对话历史。Provider 切换不改变页面中的业务会话，也不会导致历史丢失。

## 范围

### 包含

- 选品工作台右侧 AI 对话框及窄屏抽屉布局。
- 本机 Codex App Server Provider。
- OpenAI Responses API Provider。
- 按品类保存的会话、消息和修改提案。
- 流式回复、停止生成、失败重试和 Provider 状态。
- 修改前后对比、逐项选择、确认应用和拒绝提案。
- 服务端字段白名单、版本冲突检测和输入数据隔离。
- 服务端版与 GitHub Pages 静态版的兼容行为。

### 不包含

- AI 自动修改成本、售价、MOQ、评分、销量、销售额、利润结果或其他数字业务字段。
- AI 未经用户确认直接保存内容。
- App Server 直接暴露给浏览器。
- 浏览器保存 OpenAI API Key。
- 自动从 Codex App Server 静默切换到 OpenAI API。
- 图片文件上传、语音对话、多用户权限系统或自动部署。

## 架构决策

采用“统一 AI 网关 + 双 Provider 适配器”。浏览器只调用本软件的 AI API，不感知两种上游协议的细节。

```text
选品文档右侧 AI 对话框
          |
          v
本软件 Node AI 网关
  |-- 默认：本机 Codex App Server（stdio JSONL）
  `-- 手动：OpenAI Responses API
          |
          v
统一回答与修改提案结构
          |
     用户确认应用
          v
现有选品文档校验与保存逻辑
```

统一网关负责读取业务上下文、选择 Provider、规范化流式事件、校验结构化结果、持久化对话及应用修改提案。Provider 只负责模型通信，不能直接访问数据库写接口。

## 前端交互

### 布局

桌面端将现有工作区扩展为三栏：左侧章节导航、中间编辑区、右侧 AI 助手。右侧栏可折叠。窄屏下 AI 助手显示为从右侧打开的全高抽屉，避免挤压现有表格和表单。

助手顶部显示：

- 当前 Provider：本机 Codex 或 OpenAI API。
- 连接状态：连接中、可用、不可用、生成中。
- 手动切换入口。
- 清空当前品类对话入口；操作前二次确认。

助手主体显示当前品类的完整业务对话历史。消息标注角色、时间、Provider 和发送状态。刷新页面后从数据库恢复。

输入区提供多行文本框、发送按钮和生成中的停止按钮，并提供四个快捷操作：

- 分析当前章节。
- 总结当前品类。
- 检查风险。
- 生成差异化建议。

快捷操作只填充并发送标准提示，不绕过正常上下文和权限规则。

### Provider 切换

页面默认选择本机 Codex。App Server 未安装、未登录、启动失败、进程退出或响应超时时，页面保留用户输入并显示失败原因以及“重试”“切换到 OpenAI API”按钮。

系统不会自动调用 OpenAI API。只有用户明确点击切换并再次发送后才会产生 API 请求。API 不可用时也保留消息，并允许重试或切回本机 Codex。

### 修改预览

AI 回复可包含零个或多个修改提案。提案以差异卡片显示：字段或站点、原内容、建议内容和修改理由。用户可以逐项勾选，并选择：

- 应用已选修改。
- 拒绝整份提案。
- 继续追问并要求重新生成。

生成提案时不会修改表单或触发现有自动保存。应用成功后刷新受影响的本地状态和完成度摘要。

## 业务上下文

每次发送前，服务端重新聚合当前品类数据，保证模型读取的是数据库中的最新版本：

- 品类基础资料与各站点刊登数据。
- 选品主文档及当前版本号。
- 全部站点评估。
- 供应商候选及其利润计算结果。
- 普通竞品与同款竞品。
- 评论和卖点分析的现有结果。
- 当前利润结果。
- 当前选中的章节。

成本、售价、MOQ、评分、销量、销售额、利润率、ROI 等数字仅作为证据提供。系统提示明确标记这些数据为只读。竞品标题、评论、供应商说明和用户录入文本都放入不可信数据区，不能覆盖系统权限或输出规则。

模型上下文使用近期消息加历史摘要，而数据库保留完整历史。摘要只用于控制上下文长度，不替代原始消息记录。

## 允许修改的字段

服务端使用明确白名单，不接受 Provider 自行扩展字段。

### 选品主文档

- `positioning`
- `use_scenarios`
- `competitive_points`
- `differentiation_items`
- `review_issues`
- `overview_summary`
- `competitor_summary`
- `supplier_summary`
- `patent_notes`
- `decision_reason`
- `checklist`

`decision_status` 不由 AI 修改，仍由用户手动选择。

### 站点评估

- `new_product_friendliness`
- `same_product_performance`
- `opportunity_status`
- `opportunity_notes`
- `certification_required`
- `certification_actual`
- `supplier_certifications`
- `certification_gap`
- `payback_period`

站点评估中的金额和市场数字字段不允许 AI 修改，包括 `market_average_revenue`、`market_average_sales` 和 `certification_gap_cost`。

### 明确禁止

供应商候选、品类基础资料、刊登价格、竞品原始数据、利润计算输入和任何未列入白名单的字段一律不能通过 AI 提案修改。Provider 返回此类字段时，服务端删除越权内容并记录校验错误；如果提案没有剩余合法项，则只保留普通回答。

## 统一 Provider 接口

两个 Provider 实现相同的服务端接口：

- `health()`：检查 Provider 是否可用，不触发模型生成。
- `startOrResumeConversation()`：创建或恢复 Provider 会话状态。
- `streamTurn()`：发送一次用户输入并产生统一流式事件。
- `interruptTurn()`：停止当前生成。
- `dispose()`：释放进程或连接资源。

统一流式事件包括：

- `status`：连接、恢复线程、生成或停止状态。
- `text_delta`：AI 文本增量。
- `proposal`：已通过基础结构校验的修改提案。
- `completed`：最终消息及 Provider 状态标识。
- `error`：可安全展示给用户的错误码与消息。

## Codex App Server Provider

Node 服务按需启动一个长期 `codex app-server --listen stdio://` 子进程，使用 JSONL 传输 JSON-RPC 消息。连接建立后执行一次 `initialize`/`initialized` 握手。

每个品类保存一个 Codex thread ID。首次使用调用 `thread/start`，后续调用 `thread/resume`，每条用户消息通过 `turn/start` 发送。服务端监听 agent message delta、turn completed 和错误通知，并映射成统一流式事件。停止生成调用 `turn/interrupt`。

Codex 会话不覆盖用户本机的默认 Codex 模型配置，并使用以下边界：

- `approvalPolicy` 为 `never`。
- `sandboxPolicy` 为只读。
- 网络访问关闭。
- 不调用实验性的 `process/*` 或独立命令执行接口。
- 不向 Codex 提供数据库写工具。
- 输出使用严格 JSON Schema，包含普通回答和可选修改提案。网关使用增量 JSON 解析器只把 `answer` 字符串的新增部分转成 `text_delta`；提案在完整对象校验通过后才发送给浏览器。

子进程异常退出时，当前 turn 标记失败。下一次重试可重启 App Server 并使用已保存 thread ID 恢复；恢复失败则创建新 thread，并通过本软件保存的近期消息和摘要恢复业务语境。失败不会自动切换到 OpenAI API。

## OpenAI Responses API Provider

OpenAI Provider 只在用户主动切换后启用。API Key 从服务端环境变量读取，绝不写入 HTML、JavaScript、浏览器存储、日志或 API 响应。

模型由 `OPENAI_MODEL` 环境变量配置，未配置时默认使用 `chat-latest`。模型名称集中在 Provider 配置中，不散落在前端或业务代码里。

Responses API 请求使用流式输出和严格结构化输出。网关同样只流出结构化结果中 `answer` 的文本增量，提案在完整校验后再发送。Provider 保存可用于继续会话的上游标识；若上游状态不可恢复，则使用本软件数据库中的近期消息和摘要重建上下文。

## 数据模型

### `selection_ai_conversations`

每个品类最多一条记录：

- `project_id`：主键并关联品类，品类删除时级联删除。
- `active_provider`：`codex` 或 `openai`，默认 `codex`。
- `codex_thread_id`：可空。
- `openai_state_id`：可空。
- `summary`：历史摘要。
- `created_at`、`updated_at`。

### `selection_ai_messages`

- `id`。
- `project_id`。
- `role`：`user` 或 `assistant`。
- `provider`：`codex` 或 `openai`。
- `content`。
- `status`：`pending`、`streaming`、`completed`、`interrupted` 或 `failed`。
- `error_code`、`error_message`。
- `created_at`、`updated_at`。

消息按 `project_id`、创建时间和 ID 排序。品类删除时级联删除。

### `selection_ai_proposals`

- `id`。
- `project_id`。
- `message_id`：关联生成该提案的 AI 消息。
- `base_document_version`：生成时的选品主文档版本。
- `changes`：结构化修改数组。
- `status`：`pending`、`applied`、`rejected`、`conflicted` 或 `invalid`。
- `applied_changes`：实际应用的修改项。
- `created_at`、`resolved_at`。

品类或消息删除时级联清理关联提案。

## 服务端接口

- `GET /api/projects/:id/selection-ai`：读取 Provider 状态、会话、消息和未处理提案。
- `GET /api/projects/:id/selection-ai/health`：检查 Codex 和 OpenAI 配置状态，不产生模型调用。
- `PUT /api/projects/:id/selection-ai/provider`：显式切换 Provider。
- `POST /api/projects/:id/selection-ai/turns`：创建用户消息并以 SSE 返回生成事件。
- `POST /api/projects/:id/selection-ai/turns/:turnId/interrupt`：停止生成。
- `POST /api/projects/:id/selection-ai/proposals/:proposalId/apply`：应用用户勾选的合法修改项。
- `POST /api/projects/:id/selection-ai/proposals/:proposalId/reject`：拒绝提案。
- `DELETE /api/projects/:id/selection-ai/messages`：二次确认后清空当前品类业务历史及 Provider 状态。

同一品类同一时间只允许一个活动 turn。重复提交返回冲突错误，不创建第二条生成任务。

## 应用提案与并发控制

应用提案时服务端重新加载当前文档和站点评估，并执行以下检查：

1. 提案属于当前品类且状态为 `pending`。
2. 用户选择的修改项存在于已校验提案中。
3. 所有字段仍在允许白名单中。
4. 选品主文档版本等于 `base_document_version`。
5. 站点评估目标站点属于当前品类可用站点。
6. 修改后的值通过现有文档和站点评估校验器。

版本不一致时不应用任何修改，提案标记 `conflicted`，页面提示用户重新生成或刷新比较。合法修改在数据库事务中一次性写入，避免只应用部分字段。应用完成后记录实际修改项和解决时间。

## 错误处理

- `CODEX_NOT_INSTALLED`：找不到 Codex 可执行文件。
- `CODEX_AUTH_REQUIRED`：App Server 无可用登录状态。
- `CODEX_START_FAILED`：子进程启动或初始化失败。
- `CODEX_TURN_FAILED`：生成过程中失败。
- `CODEX_TIMEOUT`：初始化或 turn 超时。
- `OPENAI_NOT_CONFIGURED`：API Key 未配置。
- `OPENAI_REQUEST_FAILED`：API 请求失败。
- `TURN_ALREADY_ACTIVE`：当前品类已有生成任务。
- `PROPOSAL_CONFLICT`：文档版本已变化。
- `PROPOSAL_INVALID`：提案越权或结构不合法。

错误响应不包含 API Key、上游认证信息、完整系统提示或数据库连接信息。失败的用户消息和已产生的回复文本继续保留，便于重试和审计。

## 静态版行为

GitHub Pages 继续构建 AI 对话框资源，并使用独立版本化浏览器存储保存 UI 偏好和可展示的本地历史。静态页面不直接启动 Codex、不直接调用 OpenAI，也不接受浏览器输入 API Key。

只有配置 `MARGINGO_API_BASE` 指向运行中的 Node 服务时，静态页面才能进行真实 AI 对话。未连接后端时，按钮保持可见但显示“AI 服务不可用，需要连接本地或远程服务”，其他选品文档功能不受影响。

## 测试设计

### 单元测试

- 上下文构建包含当前品类全部数据并标记当前章节。
- 数字数据只能进入只读证据区。
- Provider 输出规范化为统一事件。
- 提案白名单删除越权字段。
- Prompt injection 文本不能改变系统权限。
- 历史裁剪保留完整数据库记录并生成可用摘要输入。

### API 测试

- 每个品类只有一份独立会话，消息互不串用。
- 默认 Provider 为 Codex，只有显式请求才切换 OpenAI。
- 同品类并发 turn 被拒绝，不同品类可以独立生成。
- 消息在完成、中断和失败时保存正确状态。
- 提案逐项应用、整份拒绝、越权拒绝和版本冲突。
- 品类删除后会话、消息和提案级联删除。
- API Key 和内部提示不出现在任何响应中。

### Provider 测试

- App Server 初始化握手、thread 创建、恢复、流式增量和中断。
- App Server 缺失、退出、超时及恢复失败。
- OpenAI 流式响应、结构化输出、缺少 Key、限流和网络失败。
- 使用可控的假进程与假 HTTP 传输测试协议，不依赖真实费用或登录状态。

### UI 测试

- 三栏与窄屏抽屉布局。
- 当前章节随消息一起发送。
- 流式回复、停止、重试和错误提示。
- App Server 失败后只显示手动切换，不自动请求 OpenAI。
- 修改预览、逐项勾选、确认应用、拒绝和冲突提示。
- 刷新后恢复当前品类历史，切换品类后展示对应历史。

### 集成与回归

- 在已登录的本机环境执行一次真实 Codex App Server 连接测试。
- 在显式配置测试 API Key 时执行一次 OpenAI 冒烟测试；默认自动测试不调用付费 API。
- 执行完整 `npm test`。
- 执行 `npm run build:pages` 并检查静态资源完整。
- 验证现有利润、竞品、供应商和选品自动保存行为不回归。

## 配置与运行约束

- App Server 默认由 Node 服务管理，不要求用户手动在浏览器连接端口。
- Codex 可执行文件路径允许通过环境变量覆盖，默认从 `PATH` 查找。
- OpenAI API Key 仅使用服务端环境变量。
- OpenAI 模型使用 `OPENAI_MODEL` 配置。
- Provider 超时使用服务端配置并设置安全默认值。
- 不部署、不合并 `main`、不创建 PR；实现完成后只提交并推送 `codex/selection-document`。
- `.superpowers/` 等现有未跟踪内容不纳入提交。

## 验收标准

- 打开任意品类的选品文档时，右侧出现独立 AI 对话框并默认显示本机 Codex。
- 本机 Codex 可用时能够流式回答，并在刷新后继续该品类上次对话。
- 本机 Codex 不可用时不会自动调用 OpenAI；用户主动切换后 OpenAI 才被调用。
- AI 能使用当前品类全部数据并优先回答当前章节问题。
- AI 无法修改任何禁止字段。
- 所有修改先展示差异预览，只有确认选中项后才保存。
- 版本冲突不会覆盖用户新内容。
- 每个品类的历史互相隔离。
- 完整自动测试与静态构建通过，真实 App Server 冒烟测试通过。
