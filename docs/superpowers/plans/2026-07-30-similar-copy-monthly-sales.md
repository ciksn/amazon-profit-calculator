# Similar Competitor Copy Monthly Sales Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add imported monthly sales between sale price and monthly revenue in copied similar-competitor rows.

**Architecture:** Reuse the existing `monthly_sales` value already returned by the API. Change only the clipboard row projection in `copySimilarTable`, with a source-contract test that fixes the order and column count.

**Tech Stack:** Browser JavaScript, Node.js native test runner, Docker Compose, GitHub Actions Pages.

## Global Constraints

- Do not alter the visible similar-competitor table.
- Output monthly sales as `number(item.monthly_sales,0)`.
- Preserve every existing copied column and increase the row from 13 to 14 columns.
- Deploy the same change to the live server and GitHub Pages.

---

### Task 1: Add monthly sales to copied similar competitors

**Files:**
- Modify: `test/embed-review-ui.test.js`
- Modify: `public/embed.js`
- Generated: `docs/embed.js`

**Interfaces:**
- Consumes: `item.monthly_sales` from each similar competitor.
- Produces: a 14-cell clipboard row ordered with sale price, monthly sales, then local monthly revenue.

- [ ] **Step 1: Add a failing test**

Assert that the `copySimilarTable` row projection contains:

```js
`${country.symbol}${number(item.sale_price,2)}`,
number(item.monthly_sales,0),
`${country.symbol}${number(item.monthly_revenue_local,2)}`
```

Also update the existing test name from 13 columns to 14 columns.

- [ ] **Step 2: Verify the focused test fails**

Run: `node --test test/embed-review-ui.test.js`

Expected: FAIL because monthly sales is absent between price and revenue.

- [ ] **Step 3: Implement the minimal projection change**

Insert `number(item.monthly_sales,0)` immediately after the sale-price cell in `copySimilarTable`; make no other UI or data changes.

- [ ] **Step 4: Verify focused and full tests**

Run: `node --test test/embed-review-ui.test.js`

Expected: PASS.

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 5: Build Pages and commit**

Run: `$env:MARGINGO_PAGES_API_BASE='https://www.200392.xyz'; npm run build:pages`

Commit message: `feat: copy monthly sales for similar competitors`

### Task 2: Deploy and verify both surfaces

**Files:**
- Deploy source: `public/embed.js`
- Pages source: `docs/embed.js`

**Interfaces:**
- Produces: matching copy behavior on `https://www.200392.xyz/embed.html` and GitHub Pages.

- [ ] **Step 1: Deploy the isolated worktree to `/opt/margingo` and rebuild only the app container**

Preserve `/opt/margingo/deploy/.env.production`, PostgreSQL data, and the existing CORS value.

- [ ] **Step 2: Verify server health and deployed asset**

Request `/api/health` and compare the deployed `embed.js` content hash with the built source.

- [ ] **Step 3: Update the isolated remote branch and run `deploy-pages.yml`**

Expected: the Pages deployment run completes successfully from the isolated branch.

- [ ] **Step 4: Verify the Pages artifact**

Download the workflow artifact and confirm its `embed.js` contains the ordered monthly-sales projection.
