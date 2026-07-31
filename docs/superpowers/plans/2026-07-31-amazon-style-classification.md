# Amazon Style Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready workflow that imports H10/SellerSprite products, collects Amazon galleries, classifies each product by style with local multimodal evidence, escalates uncertain cases to Gemini and humans, and learns safely from reviewed corrections.

**Architecture:** Keep the existing Node.js/PostgreSQL application as the system of record and add a focused `lib/style-classification` module with its own routes, repository, collectors, scoring and job orchestration. Add a separate Python HTTP inference service for SigLIP2 embeddings and local OCR, while the Node service owns business rules, confidence routing, Gemini fallback, review state and versioning. Expose the workflow through a standalone `style-classification.html` page linked from each project.

**Tech Stack:** Node.js 22+, PostgreSQL/pg-mem, undici, cheerio, ExcelJS browser build, `node:test`, Python 3, FastAPI, Uvicorn, PyTorch, Transformers SigLIP2, Pillow, NumPy, RapidOCR/ONNX Runtime, Gemini API.

## Global Constraints

- Support H10 and SellerSprite Excel formats already recognized by `public/competitor-import.js`.
- Treat a product/ASIN and all its listing images as the classification unit; do not classify isolated images as final styles.
- Function is the primary style criterion; structure, shape, material and pattern follow; color has zero weight unless a category rule explicitly overrides it.
- Default evidence weights are function images 30%, structure images 25%, main/overall images 20%, title/attributes/OCR 20%, material/pattern 5%, color/background 0%.
- High confidence requires score ≥85, lead ≥15 and no critical conflict; medium is score 65–84 or lead 5–14; low is score <65, lead <5, missing critical images, conflicting evidence or changed main image.
- Main-image changes between the Excel export and the current Amazon gallery always force human review.
- Local and cloud conclusions must agree and combined confidence must be ≥80 before a medium-confidence item can auto-pass.
- Never bypass CAPTCHA. Failed acquisition falls back to the exported main image and forces human review.
- Store thumbnails and source URLs, not permanent original-resolution Amazon galleries.
- Every result records model, rule and sample-set versions and can be reproduced.
- Initial launch gates: gallery retry success ≥95%, gallery contamination ≤5%, Top-3 recall ≥92%, auto-pass accuracy ≥90%, target human review 10%–20%, post-review overall accuracy ≥96%.
- Fine-tuning is disabled until one category has 300–500 reliable corrections and a locked test set proves improvement.

---

## File Structure

### Node backend

- `lib/style-classification/contracts.js` — input validation, enums and score thresholds.
- `lib/style-classification/repository.js` — all SQL reads/writes for this feature.
- `lib/style-classification/amazon-gallery.js` — Amazon URL validation, HTML parsing, retries and gallery normalization.
- `lib/style-classification/inference-client.js` — typed HTTP client for the local Python service.
- `lib/style-classification/scoring.js` — candidate aggregation, evidence weighting and confidence banding.
- `lib/style-classification/cloud-review.js` — Gemini request construction and strict response validation.
- `lib/style-classification/service.js` — use cases, job checkpoints, fallbacks and version selection.
- `lib/style-classification/routes.js` — `/api/projects/:id/style-classification/*` HTTP surface.
- `lib/db.js` — append style-classification tables and indexes only.
- `server.js` — delegate matching requests to the new route module.

### Python inference service

- `inference/requirements.txt` — pinned runtime dependencies.
- `inference/app.py` — FastAPI health, image analysis and embedding endpoints.
- `inference/models.py` — request/response models.
- `inference/image_pipeline.py` — download limits, image normalization, SigLIP2 embeddings, lightweight image-type heuristics and OCR.
- `inference/test_image_pipeline.py` — deterministic unit tests with injected model/OCR adapters.
- `inference/test_app.py` — endpoint contract tests.

### Browser UI

- `public/style-classification.html` — standalone project-scoped screen.
- `public/style-classification.css` — import, rules, queue and review layout.
- `public/style-classification.js` — state, API calls and interactions.
- `public/app.js` — add a project-level entry link.

### Tests and deployment

- `test/style-classification-contracts.test.js`
- `test/style-classification-repository.test.js`
- `test/style-classification-gallery.test.js`
- `test/style-classification-scoring.test.js`
- `test/style-classification-cloud.test.js`
- `test/style-classification-service.test.js`
- `test/style-classification-api.test.js`
- `test/style-classification-ui.test.js`
- `test/fixtures/amazon-gallery-us.html`
- `test/fixtures/amazon-gallery-au.html`
- `scripts/benchmark-style-classification.mjs`
- `.env.example`
- `Dockerfile`
- `README.md`

---

### Task 1: Contracts, Database Schema and Repository Boundary

**Files:**
- Create: `lib/style-classification/contracts.js`
- Create: `lib/style-classification/repository.js`
- Modify: `lib/db.js`
- Test: `test/style-classification-contracts.test.js`
- Test: `test/style-classification-repository.test.js`

**Interfaces:**
- Produces: `validateCategoryInput(body)`, `validateStyleInput(body)`, `validateImportRows(body)`, `confidenceBand(result)`.
- Produces: `createStyleRepository({db})` with category, style, product, image, run, candidate and review CRUD methods.
- Consumes: existing `db.one`, `db.many`, `db.query`, `db.transaction`.

- [ ] **Step 1: Write failing contract tests**

```js
test('品类规则默认忽略颜色并使用确认权重',()=>{
  assert.deepEqual(validateCategoryInput({name:'Console Tables'}).weights,{
    function:30,structure:25,overall:20,text:20,material_pattern:5,color_background:0
  });
});

test('款式至少需要名称、定义和三个典型商品',()=>{
  assert.throws(()=>validateStyleInput({name:'带抽屉',definition:'含抽屉',sample_product_ids:[1,2]}),/至少 3 个/);
});

test('导入行拒绝非 Amazon 链接并按站点 ASIN 去重',()=>{
  const rows=validateImportRows({country_code:'US',rows:[
    {asin:'B0ABC12345',product_url:'https://www.amazon.com/dp/B0ABC12345'},
    {asin:'b0abc12345',product_url:'https://www.amazon.com/dp/B0ABC12345'}
  ]});
  assert.equal(rows.length,1);
});
```

- [ ] **Step 2: Run contracts test and verify failure**

Run: `node --test test/style-classification-contracts.test.js`
Expected: FAIL with `Cannot find module '../lib/style-classification/contracts'`.

- [ ] **Step 3: Implement contract constants and validators**

```js
const DEFAULT_WEIGHTS=Object.freeze({
  function:30,structure:25,overall:20,text:20,material_pattern:5,color_background:0
});
const THRESHOLDS=Object.freeze({highScore:85,highLead:15,mediumScore:65,mediumLead:5,cloudPass:80});

function confidenceBand({score,lead,criticalConflict=false,missingCritical=false,mainImageChanged=false}) {
  if(criticalConflict||missingCritical||mainImageChanged||score<THRESHOLDS.mediumScore||lead<THRESHOLDS.mediumLead)return 'low';
  if(score>=THRESHOLDS.highScore&&lead>=THRESHOLDS.highLead)return 'high';
  return 'medium';
}
```

Implement the remaining validation rules exactly:

```js
const STYLE_NAME_MAX=80;
const DEFINITION_MAX=500;
const FEATURE_MAX=120;
const SUPPORTED_COUNTRIES=new Set(['AU','US','GB','DE','JP','CA','AE','SA']);

function validationError(message){
  const error=new Error(message);error.statusCode=400;return error;
}
```

Trim all strings; require positive integer IDs; cap required/excluded feature arrays at 30 unique entries; require weights to contain the six known keys, each in `0..100`, totaling 100; require product URLs to use HTTPS and the hostname mapped to `country_code`; normalize ASINs to uppercase `/^[A-Z0-9]{10}$/`; deduplicate import rows by `(country_code,asin)` while keeping the last source row. Export the constants for tests.

- [ ] **Step 4: Add failing repository/schema tests**

```js
test('款式归类表随数据库初始化创建并可级联删除',async()=>{
  const project=await db.one("INSERT INTO projects(name,created_at,updated_at) VALUES('分类项目',$1,$1) RETURNING *",[now]);
  const repo=createStyleRepository({db});
  const category=await repo.createCategory(project.id,{name:'Console Tables',weights:DEFAULT_WEIGHTS});
  const style=await repo.createStyle(category.id,{name:'带抽屉',definition:'包含一个或多个抽屉'});
  assert.equal(style.category_id,category.id);
  await db.query('DELETE FROM projects WHERE id=$1',[project.id]);
  assert.equal(await repo.getCategory(category.id),null);
});
```

- [ ] **Step 5: Run repository test and verify failure**

Run: `node --test test/style-classification-repository.test.js`
Expected: FAIL because `style_categories` does not exist.

- [ ] **Step 6: Add schema and focused repository**

Add tables for:

```sql
style_categories(id,project_id,name,priority_order,weights,active,rule_version,created_at,updated_at)
style_definitions(id,category_id,name,definition,required_features,excluded_features,confusable_style_ids,active,created_at,updated_at)
style_import_batches(id,category_id,country_code,source_format,file_name,status,row_count,error_count,created_at,updated_at)
style_products(id,batch_id,country_code,asin,parent_asin,title,attributes,product_url,exported_main_image,current_main_image,main_image_changed,acquisition_status,created_at,updated_at)
style_product_images(id,product_id,source_url,thumbnail_url,image_key,perceptual_hash,image_types,ocr_text,width,height,position,created_at)
style_samples(id,style_id,product_id,sample_kind,status,created_at,approved_at)
style_versions(id,category_id,kind,version,payload,status,created_at,published_at)
style_runs(id,category_id,status,model_version,rule_version,sample_version,total_count,processed_count,checkpoint,created_at,updated_at)
style_candidates(id,run_id,product_id,style_id,rank,score,evidence,created_at)
style_reviews(id,run_id,product_id,predicted_style_id,final_style_id,status,reason,reviewed_at,created_at)
```

Use JSONB only for bounded rule/evidence payloads. Add unique indexes on `(batch_id,country_code,asin)`, `(product_id,image_key)`, `(style_id,product_id,sample_kind)` and one pending review per `(run_id,product_id)`.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/style-classification-contracts.test.js test/style-classification-repository.test.js`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/db.js lib/style-classification/contracts.js lib/style-classification/repository.js test/style-classification-contracts.test.js test/style-classification-repository.test.js
git commit -m "feat: add style classification data model"
```

---

### Task 2: Project-Scoped Import API

**Files:**
- Create: `lib/style-classification/routes.js`
- Create: `lib/style-classification/service.js`
- Modify: `server.js`
- Test: `test/style-classification-api.test.js`

**Interfaces:**
- Consumes: `validateImportRows`, `createStyleRepository`.
- Produces: `handleStyleClassificationRequest(req,res,url,context): Promise<boolean>`.
- Produces endpoints:
  - `POST /api/projects/:projectId/style-classification/categories`
  - `GET /api/projects/:projectId/style-classification/bootstrap`
  - `POST /api/projects/:projectId/style-classification/categories/:categoryId/imports`

- [ ] **Step 1: Write failing import API test**

```js
const response=await fetch(`${base}/api/projects/${project.id}/style-classification/categories/${category.id}/imports`,{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({country_code:'AU',source_format:'helium10',file_name:'sample.xlsx',rows:[
    {asin:'B0F3D843F9',title:'Console Table',product_url:'https://amazon.com.au/dp/B0F3D843F9',image_url:'https://m.media-amazon.com/images/I/example.jpg'}
  ]})
});
assert.equal(response.status,201);
assert.deepEqual((await response.json()).summary,{inserted:1,updated:0,skipped:0});
```

- [ ] **Step 2: Run and verify 404**

Run: `node --test test/style-classification-api.test.js`
Expected: FAIL because the endpoint returns 404.

- [ ] **Step 3: Implement routing and transactional import**

```js
async function handleStyleClassificationRequest(req,res,url,{db,json,readBody}) {
  const match=url.pathname.match(/^\/api\/projects\/(\d+)\/style-classification(?:\/(.*))?$/);
  if(!match)return false;
  const projectId=Number(match[1]);
  const project=await db.one('SELECT id FROM projects WHERE id=$1',[projectId]);
  if(!project){json(res,404,{error:'品类项目不存在'});return true;}
  // Dispatch exact method/path combinations; return 405 for a matched path with wrong method.
  return true;
}
```

`importProducts` must normalize ASIN casing, upsert only within the current batch, retain `source_row`, and return row-level errors without aborting valid rows. Reject a batch with zero valid rows.

- [ ] **Step 4: Add ownership and duplicate tests**

Test that a category from project A cannot be imported through project B, duplicate ASINs are updated once, and invalid rows appear in `errors` with their source row.

- [ ] **Step 5: Run API tests**

Run: `node --test test/style-classification-api.test.js test/api.test.js`
Expected: all tests PASS; existing project API behavior remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add server.js lib/style-classification/routes.js lib/style-classification/service.js test/style-classification-api.test.js
git commit -m "feat: add style product import API"
```

---

### Task 3: Amazon Gallery Parser and Safe Collector

**Files:**
- Create: `lib/style-classification/amazon-gallery.js`
- Create: `test/fixtures/amazon-gallery-us.html`
- Create: `test/fixtures/amazon-gallery-au.html`
- Test: `test/style-classification-gallery.test.js`

**Interfaces:**
- Produces: `parseAmazonGallery(html): {title,mainImage,images,videoCount}`.
- Produces: `fetchAmazonGallery(product, options): Promise<GalleryResult>`.
- `GalleryResult.status`: `complete | fallback | captcha | unavailable | failed`.

- [ ] **Step 1: Save minimal sanitized fixtures**

Fixtures must include only the product title, `#main-image-container`, `#altImages`, dynamic image attributes and a video thumbnail. Use the image IDs observed in the validated AU/US samples, but exclude full downloaded pages.

- [ ] **Step 2: Write failing parser tests**

```js
test('只提取商品图库并排除视频封面和占位图',()=>{
  const result=parseAmazonGallery(usHtml);
  assert.equal(result.images.length,8);
  assert.equal(result.mainImage,'https://m.media-amazon.com/images/I/912nHxym+9L.jpg');
  assert.ok(result.images.every(url=>!url.includes('play-button')&&!url.includes('grey-pixel')));
});

test('验证码页面返回明确状态且不尝试绕过',async()=>{
  const result=await fetchAmazonGallery(product,{fetchImpl:async()=>new Response(robotCheck,{status:200}),attempts:1});
  assert.equal(result.status,'captcha');
  assert.deepEqual(result.images,[product.exported_main_image]);
});
```

- [ ] **Step 3: Run and verify failure**

Run: `node --test test/style-classification-gallery.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement scoped parsing**

```js
function canonicalMediaUrl(value) {
  const match=String(value||'').match(/^https:\/\/(?:m\.)?media-amazon\.com\/images\/I\/([^?]+?)(?:\._[^.]+_)?\.(jpg|jpeg|png|webp)$/i);
  return match?`https://m.media-amazon.com/images/I/${match[1]}.${match[2].toLowerCase()}`:'';
}
```

Use Cheerio selectors restricted to `#main-image-container`, `#imageBlock` and `#altImages`. Deduplicate by Amazon image ID, preserve gallery order, cap at 12 images, reject non-Amazon image hosts and compare the current/exported main image IDs.

- [ ] **Step 5: Implement retry and bounded fetch**

Allow injected `fetchImpl`, `attempts`, `timeoutMs` and `delay`. Permit only the expected Amazon hostname and same-host redirects, cap HTML response bytes, use the existing browser-like headers, stop immediately on CAPTCHA, and use exponential backoff only for timeout/429/5xx.

- [ ] **Step 6: Run tests**

Run: `node --test test/style-classification-gallery.test.js test/competitor-analysis.test.js`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/style-classification/amazon-gallery.js test/fixtures/amazon-gallery-us.html test/fixtures/amazon-gallery-au.html test/style-classification-gallery.test.js
git commit -m "feat: collect amazon product galleries"
```

---

### Task 4: Acquisition Jobs, Caching and Checkpoints

**Files:**
- Modify: `lib/style-classification/repository.js`
- Modify: `lib/style-classification/service.js`
- Modify: `lib/style-classification/routes.js`
- Test: `test/style-classification-service.test.js`
- Test: `test/style-classification-api.test.js`

**Interfaces:**
- Produces: `service.acquireBatch({categoryId,batchId,limit})`.
- Produces endpoints:
  - `POST .../imports/:batchId/acquire`
  - `GET .../imports/:batchId/status`

- [ ] **Step 1: Write failing checkpoint/fallback tests**

Inject a collector that succeeds for product 1, returns CAPTCHA for product 2 and throws on product 3. Assert that product 1 stores eight images, products 2–3 retain their exported main images, the checkpoint reaches three, and all failed/fallback products are marked for review.

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/style-classification-service.test.js`
Expected: FAIL because `acquireBatch` is missing.

- [ ] **Step 3: Implement acquisition orchestration**

Process products in bounded chunks of three. Before fetching, reuse a successful snapshot newer than `STYLE_GALLERY_CACHE_HOURS` (default 168). Persist each product and checkpoint in one transaction so process interruption never loses completed work.

```js
const reviewRequired=['captcha','fallback','unavailable','failed'].includes(result.status)||result.mainImageChanged;
await repo.saveGallery({productId:product.id,result,reviewRequired});
await repo.advanceBatch(batchId,{processedDelta:1,lastProductId:product.id});
```

- [ ] **Step 4: Add API status tests**

Assert the start endpoint returns `202`, repeated starts are idempotent, status exposes counts only for the owned project/category, and a completed job is not restarted unless `{force:true}` is passed.

- [ ] **Step 5: Run focused and regression tests**

Run: `node --test test/style-classification-service.test.js test/style-classification-api.test.js test/competitor-analysis.test.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/style-classification/repository.js lib/style-classification/service.js lib/style-classification/routes.js test/style-classification-service.test.js test/style-classification-api.test.js
git commit -m "feat: add resumable gallery acquisition"
```

---

### Task 5: Category Rules, Styles and Sample Approval API

**Files:**
- Modify: `lib/style-classification/contracts.js`
- Modify: `lib/style-classification/repository.js`
- Modify: `lib/style-classification/routes.js`
- Test: `test/style-classification-api.test.js`

**Interfaces:**
- Produces CRUD endpoints under `.../categories/:categoryId/styles`.
- Produces `POST .../styles/:styleId/samples`.
- Produces `POST .../versions/:versionId/publish`.

- [ ] **Step 1: Write failing style rule tests**

Cover default weights, category overrides, required/excluded features, three approved sample products before activation, candidate samples not affecting the published sample version, and project ownership.

- [ ] **Step 2: Run and verify failure**

Run: `node --test --test-name-pattern="款式|样本|规则版本" test/style-classification-api.test.js`
Expected: FAIL with 404 or missing validation.

- [ ] **Step 3: Implement versioned rule/sample mutations**

Mutations create draft `style_versions` payloads. Publishing validates the complete category snapshot and atomically marks the previous version superseded.

```js
const snapshot={
  priority_order:category.priority_order,
  weights:category.weights,
  styles:styles.map(style=>({
    id:style.id,name:style.name,definition:style.definition,
    required_features:style.required_features,excluded_features:style.excluded_features,
    sample_product_ids:samples.filter(x=>x.style_id===style.id&&x.status==='approved').map(x=>x.product_id)
  }))
};
```

- [ ] **Step 4: Run tests**

Run: `node --test test/style-classification-contracts.test.js test/style-classification-repository.test.js test/style-classification-api.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/style-classification/contracts.js lib/style-classification/repository.js lib/style-classification/routes.js test/style-classification-api.test.js
git commit -m "feat: manage style rules and samples"
```

---

### Task 6: Local Python Inference Service

**Files:**
- Create: `inference/requirements.txt`
- Create: `inference/models.py`
- Create: `inference/image_pipeline.py`
- Create: `inference/app.py`
- Create: `inference/test_image_pipeline.py`
- Create: `inference/test_app.py`

**Interfaces:**
- Produces `GET /health`.
- Produces `POST /v1/images/analyze`.
- Response per image: `{source_url,image_types,ocr_text,embedding,width,height,error}`.

- [ ] **Step 1: Pin dependencies**

```text
fastapi==0.116.1
uvicorn[standard]==0.35.0
httpx==0.28.1
pillow==11.3.0
numpy==2.2.6
torch==2.7.1
transformers==4.53.3
rapidocr-onnxruntime==1.4.4
```

Before implementation, verify these versions install together in the target Python runtime. If a pinned package is unavailable, update this file and record the compatible replacement in the same commit; do not leave floating versions.

- [ ] **Step 2: Write failing deterministic pipeline tests**

```python
def test_analyze_returns_normalized_embedding_and_ocr():
    pipeline = ImagePipeline(embedder=FakeEmbedder([3.0, 4.0]), ocr=FakeOcr("2 DRAWERS"))
    result = pipeline.analyze_png(FIXTURE_BYTES, source_url="https://m.media-amazon.com/images/I/test.jpg")
    assert result.embedding == [0.6, 0.8]
    assert result.ocr_text == "2 DRAWERS"
    assert "function" in result.image_types
```

Also test a 12 MB response is rejected, non-image content is rejected, private/loopback URLs are rejected, download redirects remain on the Amazon media host, and a failed image returns a per-image error without failing the whole batch.

- [ ] **Step 3: Run and verify failure**

Run: `python -m unittest inference.test_image_pipeline -v`
Expected: FAIL because `ImagePipeline` does not exist.

- [ ] **Step 4: Implement injectable image pipeline**

`ImagePipeline` owns preprocessing and adapters. Production adapters lazily load `google/siglip2-base-patch16-224` and RapidOCR once per process. Normalize embeddings to unit length. Initial image-type labels use SigLIP2 zero-shot prompts plus deterministic signals: large OCR blocks raise `dimension/function`, a white background with one centered object raises `overall`, and ambiguous cases include `unknown`.

- [ ] **Step 5: Add endpoint tests**

```python
def test_analyze_contract(client):
    response=client.post("/v1/images/analyze",json={"images":[{"source_url":"https://m.media-amazon.com/images/I/test.jpg"}]})
    assert response.status_code==200
    assert len(response.json()["images"][0]["embedding"])==2
```

- [ ] **Step 6: Implement FastAPI endpoints**

Use Pydantic models with a maximum of 12 images per request and a request ID. `/health` reports readiness and model name but no filesystem paths or secrets.

- [ ] **Step 7: Run Python tests**

Run: `python -m unittest inference.test_image_pipeline inference.test_app -v`
Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add inference
git commit -m "feat: add local image inference service"
```

---

### Task 7: Node Inference Client and Candidate Scoring

**Files:**
- Create: `lib/style-classification/inference-client.js`
- Create: `lib/style-classification/scoring.js`
- Test: `test/style-classification-scoring.test.js`
- Test: `test/style-classification-service.test.js`

**Interfaces:**
- Produces `createInferenceClient({baseUrl,fetchImpl,timeoutMs}).analyze(images)`.
- Produces `rankStyles({productImages,productText,styles,weights}): Candidate[]`.
- Candidate: `{styleId,rank,score,evidence,criticalConflict}`.

- [ ] **Step 1: Write failing scoring tests**

```js
test('功能证据优先于颜色相似度',()=>{
  const ranked=rankStyles({productImages:[functionImage],productText:{title:'table with 2 drawers'},styles:[drawerStyle,colorOnlyStyle],weights:DEFAULT_WEIGHTS});
  assert.equal(ranked[0].styleId,drawerStyle.id);
  assert.equal(ranked[0].evidence.color_background.weight,0);
});

test('取每种款式最相似若干图的均值而非单张最大值',()=>{
  const ranked=rankStyles(multiImageFixture);
  assert.equal(ranked[0].styleId,consistentStyle.id);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/style-classification-scoring.test.js`
Expected: FAIL because `scoring.js` does not exist.

- [ ] **Step 3: Implement cosine similarity and evidence aggregation**

```js
function cosine(a,b){return a.reduce((sum,value,index)=>sum+value*b[index],0);}
function topMean(values,count=3){
  const top=[...values].sort((a,b)=>b-a).slice(0,count);
  return top.length?top.reduce((a,b)=>a+b,0)/top.length:0;
}
```

For each evidence family, calculate a 0–100 subscore, apply the category weight, add required-feature bonuses and excluded-feature penalties, and retain the contributing image IDs/text spans. Return at most three candidates sorted deterministically by score then style ID.

- [ ] **Step 4: Implement bounded inference client**

Validate response shape, embedding dimensions and finite numbers. Convert timeouts/5xx to a typed `InferenceUnavailableError`; do not silently call the cloud provider when the local service is down.

- [ ] **Step 5: Integrate local analysis into service**

Analyze only images without cached embeddings for the current model version. Save image types, OCR and vectors, score all published styles, and persist the top three candidates.

- [ ] **Step 6: Run tests**

Run: `node --test test/style-classification-scoring.test.js test/style-classification-service.test.js`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/style-classification/inference-client.js lib/style-classification/scoring.js lib/style-classification/service.js test/style-classification-scoring.test.js test/style-classification-service.test.js
git commit -m "feat: rank style candidates locally"
```

---

### Task 8: Confidence Routing and Gemini Review

**Files:**
- Create: `lib/style-classification/cloud-review.js`
- Modify: `lib/style-classification/service.js`
- Modify: `.env.example`
- Test: `test/style-classification-cloud.test.js`
- Test: `test/style-classification-service.test.js`

**Interfaces:**
- Produces `reviewWithGemini(input, options): Promise<CloudDecision>`.
- CloudDecision: `{styleId,confidence,supportingEvidence,conflicts,status}`.

- [ ] **Step 1: Write failing routing tests**

Cover:

- High confidence auto-passes and schedules 5% deterministic audit sampling.
- Medium confidence invokes Gemini.
- Low confidence never invokes Gemini.
- Medium confidence auto-passes only when local/cloud style IDs agree and combined confidence ≥80.
- Main-image changes always force human review.

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/style-classification-cloud.test.js test/style-classification-service.test.js`
Expected: FAIL because cloud review/routing is absent.

- [ ] **Step 3: Implement strict Gemini payload and schema**

Send at most six representative compressed images: overall, up to two function, up to two structure and one text-heavy image. Include only the title, attributes, OCR snippets, category rules and three candidates. The prompt must explicitly ignore color unless configured.

Validate:

```js
{
  selected_style_id: Number,
  confidence: Number, // 0..100
  supporting_evidence: [String],
  conflicts: [String],
  status: 'decided'|'insufficient'
}
```

Reject unknown style IDs, excessive strings, duplicate evidence and non-finite confidence.

- [ ] **Step 4: Reuse encrypted Gemini configuration**

Use `getGeminiApiKey`, `GEMINI_MODEL`, proxy and retry behavior already present in the project. Add:

```text
STYLE_INFERENCE_URL=http://127.0.0.1:4180
STYLE_INFERENCE_TIMEOUT_MS=60000
STYLE_GALLERY_CACHE_HOURS=168
STYLE_CLASSIFICATION_CLOUD_ENABLED=true
```

- [ ] **Step 5: Run tests**

Run: `node --test test/style-classification-cloud.test.js test/style-classification-service.test.js test/selection-ai-openai-provider.test.js test/competitor-analysis.test.js`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add .env.example lib/style-classification/cloud-review.js lib/style-classification/service.js test/style-classification-cloud.test.js test/style-classification-service.test.js
git commit -m "feat: route uncertain styles for cloud review"
```

---

### Task 9: Resumable Classification Runs and Review Queue API

**Files:**
- Modify: `lib/style-classification/repository.js`
- Modify: `lib/style-classification/service.js`
- Modify: `lib/style-classification/routes.js`
- Test: `test/style-classification-api.test.js`
- Test: `test/style-classification-service.test.js`

**Interfaces:**
- Produces:
  - `POST .../categories/:categoryId/runs`
  - `GET .../runs/:runId`
  - `GET .../runs/:runId/reviews`
  - `PUT .../runs/:runId/reviews/:productId`
  - `GET .../runs/:runId/export`

- [ ] **Step 1: Write failing run lifecycle tests**

Assert a run snapshots model/rule/sample versions, resumes after an injected failure without reprocessing completed products, reports counts by confidence/status, and orders reviews by revenue, conflicts, new-style flag and low confidence.

- [ ] **Step 2: Run and verify failure**

Run: `node --test --test-name-pattern="归类运行|复核队列|断点" test/style-classification-service.test.js test/style-classification-api.test.js`
Expected: FAIL because run endpoints do not exist.

- [ ] **Step 3: Implement run state machine**

Allowed transitions:

```text
pending -> acquiring -> local_classifying -> cloud_reviewing -> awaiting_human -> complete
                    \-> failed (resumable)
```

Store the last completed product ID plus processed counts after every product. A retry continues from the checkpoint with the same versions.

- [ ] **Step 4: Implement review decision validation**

Allow `confirm`, `change_style`, `new_style_candidate`, `insufficient_images`, `ignore`. `change_style` requires an active style in the same category. Write the final label, reviewer reason and a correction sample candidate in one transaction.

- [ ] **Step 5: Implement CSV export**

Return UTF-8 BOM CSV with ASIN, URL, predicted/final style, confidence, review status, reason, acquisition status and version columns. Escape formulas by prefixing cells beginning with `=`, `+`, `-` or `@`.

- [ ] **Step 6: Run tests**

Run: `node --test test/style-classification-service.test.js test/style-classification-api.test.js`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/style-classification/repository.js lib/style-classification/service.js lib/style-classification/routes.js test/style-classification-service.test.js test/style-classification-api.test.js
git commit -m "feat: add resumable style classification runs"
```

---

### Task 10: Standalone Classification and Human Review UI

**Files:**
- Create: `public/style-classification.html`
- Create: `public/style-classification.css`
- Create: `public/style-classification.js`
- Modify: `public/app.js`
- Test: `test/style-classification-ui.test.js`

**Interfaces:**
- Consumes all project-scoped APIs from Tasks 2, 5 and 9.
- Produces a project link `style-classification.html?project=<id>`.

- [ ] **Step 1: Write failing static UI tests**

```js
test('款式归类页面包含导入、规则、运行和人工复核区',()=>{
  const html=read('public/style-classification.html');
  for(const id of ['importPanel','categoryRules','runSummary','reviewQueue','reviewWorkspace'])assert.match(html,new RegExp(`id="${id}"`));
});

test('人工复核提供五种明确动作',()=>{
  const js=read('public/style-classification.js');
  for(const action of ['confirm','change_style','new_style_candidate','insufficient_images','ignore'])assert.match(js,new RegExp(action));
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test test/style-classification-ui.test.js`
Expected: FAIL because the page files do not exist.

- [ ] **Step 3: Build accessible page shell**

Create four tabs/sections:

- Import and acquisition progress.
- Category rules, styles, typical products and negative examples.
- Run summary with auto-pass/review/new-style counts.
- Review workspace with grouped images, text/OCR, top-three candidates, evidence and actions.

Use the existing visual language from `selection-document.css`; do not copy its entire file. Mobile layout stacks evidence below images. All actions have text labels, not color-only meaning.

- [ ] **Step 4: Reuse browser-side Excel parsing**

Load the existing ExcelJS browser bundle and `competitor-import.js`, call `detectFormat`/`parseRows`, then send normalized JSON to the import API. Show row-level errors before starting acquisition.

- [ ] **Step 5: Implement state and review interactions**

Keep one state object:

```js
const state={projectId:0,bootstrap:null,activeCategoryId:null,activeRunId:null,reviews:[],reviewIndex:0,busy:false};
```

Render candidate cards with score, typical images, supporting/conflicting evidence and a clear predicted/final label. Require a reason for `change_style` and `new_style_candidate`. After save, advance to the next item and update counts without full-page reload.

- [ ] **Step 6: Add project entry link**

Beside the existing “选品文档” link, add:

```html
<a class="copy-category" href="./style-classification.html?project=${project.id}">款式归类</a>
```

- [ ] **Step 7: Run UI and regression tests**

Run: `node --test test/style-classification-ui.test.js test/selection-document-ui.test.js test/api.test.js`
Expected: all tests PASS.

- [ ] **Step 8: Manually verify in browser**

Start: `npm start`
Verify at desktop and narrow widths:

- Import preview and errors are readable.
- Gallery groups do not overflow.
- Candidate evidence remains aligned.
- Every review action updates the queue and count.
- Keyboard focus is visible and dialogs close with Escape.

- [ ] **Step 9: Commit**

```bash
git add public/style-classification.html public/style-classification.css public/style-classification.js public/app.js test/style-classification-ui.test.js
git commit -m "feat: add style classification review workspace"
```

---

### Task 11: Safe Learning, Version Comparison and Rollback

**Files:**
- Modify: `lib/style-classification/repository.js`
- Modify: `lib/style-classification/service.js`
- Modify: `lib/style-classification/routes.js`
- Create: `inference/train_head.py`
- Create: `inference/test_train_head.py`
- Test: `test/style-classification-service.test.js`
- Test: `test/style-classification-api.test.js`

**Interfaces:**
- Produces correction summary and draft threshold/sample versions.
- Produces:
  - `POST .../categories/:categoryId/learning/suggest`
  - `POST .../categories/:categoryId/versions/:versionId/evaluate`
  - `POST .../categories/:categoryId/versions/:versionId/publish`
  - `POST .../categories/:categoryId/versions/:versionId/rollback`
- Produces optional `train_head.py --dataset ... --output ...`.

- [ ] **Step 1: Write failing safe-learning tests**

Cover:

- One correction never changes published rules.
- Three matching corrections create a sample suggestion.
- Five matching unknown-style corrections create a new-style suggestion.
- Fine-tune endpoint rejects fewer than 300 reliable category corrections.
- A version with worse locked-test accuracy cannot publish.
- Rollback restores the prior published version without deleting history.

- [ ] **Step 2: Run and verify failure**

Run: `node --test --test-name-pattern="学习|微调|回滚" test/style-classification-service.test.js test/style-classification-api.test.js`
Expected: FAIL because learning endpoints do not exist.

- [ ] **Step 3: Implement draft threshold/sample suggestions**

Generate suggestions only; never mutate published versions automatically. Evaluation metrics include Top-1, Top-3, auto-pass coverage, auto-pass accuracy, human-review rate and per-style recall.

- [ ] **Step 4: Implement linear-head trainer**

`train_head.py` reads frozen embeddings and labels, applies a deterministic train/validation split supplied by the Node service, trains only a small linear layer, and writes weights plus metrics. Reject datasets whose locked test IDs overlap training IDs.

- [ ] **Step 5: Add trainer tests**

Use a synthetic separable embedding dataset. Assert training improves validation accuracy, output metadata includes the base SigLIP2 model/version and seed, and overlap validation fails.

- [ ] **Step 6: Run tests**

Run: `python -m unittest inference.test_train_head -v`
Run: `node --test test/style-classification-service.test.js test/style-classification-api.test.js`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/style-classification/repository.js lib/style-classification/service.js lib/style-classification/routes.js inference/train_head.py inference/test_train_head.py test/style-classification-service.test.js test/style-classification-api.test.js
git commit -m "feat: add safe style learning and rollback"
```

---

### Task 12: Deployment, Benchmarking and Launch Gate

**Files:**
- Create: `scripts/benchmark-style-classification.mjs`
- Modify: `Dockerfile`
- Modify: `README.md`
- Modify: `.env.example`
- Test: `test/style-classification-api.test.js`

**Interfaces:**
- Benchmark consumes an audited JSON/CSV dataset with product IDs and final style IDs.
- Benchmark outputs a machine-readable JSON report and human-readable summary.

- [ ] **Step 1: Write failing benchmark calculation test**

Add pure metric helpers and test a fixed confusion fixture:

```js
assert.deepEqual(metrics(fixture),{
  top1:.9,top3:.96,autoPassCoverage:.82,autoPassAccuracy:.93,humanReviewRate:.18,postReviewAccuracy:.97
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test --test-name-pattern="归类基准指标" test/style-classification-api.test.js`
Expected: FAIL because the metric helper does not exist.

- [ ] **Step 3: Implement benchmark script**

Support:

```text
node scripts/benchmark-style-classification.mjs --input audited-results.json --output outputs/style-benchmark.json
```

Fail with a non-zero exit code when any launch gate is missed. Print per-category and per-style metrics so weak categories can be switched to high-review mode.

- [ ] **Step 4: Add inference service to deployment**

Use a multi-stage image or a documented two-service deployment. The Node container must not bundle model weights into the Git repository. Mount a model cache volume, add a health check, run as a non-root user and keep inference accessible only on the internal network.

- [ ] **Step 5: Document operations**

README must cover:

- Starting Node and inference services.
- Required secrets and non-secret environment variables.
- Import → acquisition → sample approval → run → human review → export.
- Cache cleanup and disk estimates.
- CAPTCHA/fetch failure behavior.
- Model/rule/sample version rollback.
- Benchmark command and launch gates.

- [ ] **Step 6: Run complete verification**

Run: `npm test`
Expected: all Node tests PASS.

Run: `python -m unittest discover -s inference -p "test_*.py" -v`
Expected: all Python tests PASS.

Run: `npm run build:pages`
Expected: static build completes with no missing asset.

Run the benchmark against the initial 500+ audited products. Expected gates:

```text
gallery_retry_success >= 0.95
gallery_contamination <= 0.05
top3_recall >= 0.92
auto_pass_accuracy >= 0.90
human_review_rate <= 0.20
post_review_accuracy >= 0.96
```

If a category fails, mark only that category `high_review` and do not block successful categories.

- [ ] **Step 7: Commit**

```bash
git add scripts/benchmark-style-classification.mjs Dockerfile README.md .env.example test/style-classification-api.test.js
git commit -m "build: productionize style classification"
```

---

## Execution Milestones

1. **Milestone A — Reliable data:** Tasks 1–5. Users can import products, collect galleries, define styles and approve typical products without any model dependency.
2. **Milestone B — Local prototype:** Tasks 6–7. The system generates image evidence and Top-3 candidates locally.
3. **Milestone C — Usable workflow:** Tasks 8–10. Confidence routing, Gemini fallback and human review produce final labels.
4. **Milestone D — Production learning:** Tasks 11–12. Corrections create safe suggestions, optional fine-tuning is gated, and launch metrics are enforced.

At each milestone, stop and review actual acquisition success, model accuracy, human-review rate, processing time and cost before continuing.
