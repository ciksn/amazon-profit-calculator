# GitHub Pages Live Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the current server-version embed card on GitHub Pages while keeping all card API traffic on `https://www.200392.xyz`.

**Architecture:** The Pages build keeps existing static behavior for normal pages and generates a separate online configuration for `embed.html`. GitHub Actions supplies the production API origin at build time and can deploy directly from the isolated branch through `workflow_dispatch`.

**Tech Stack:** Node.js 22, native Node test runner, GitHub Actions, GitHub Pages, existing Node HTTP API.

## Global Constraints

- Base all work on commit `ee2bf4a4c25204ec7178bc901028d9428fd7353f`, confirmed to match the live server assets.
- Do not merge changes from any other active development branch.
- Keep normal GitHub Pages pages in static mode; only `embed.html` uses the live backend.
- Require an HTTPS origin-only value in `MARGINGO_PAGES_API_BASE`.
- Deploy Pages from `codex/pages-live-backend` without merging it into `main`.

---

### Task 1: Generate a dedicated online embed configuration

**Files:**
- Modify: `scripts/build_github_pages.mjs`
- Modify: `test/api.test.js`
- Create: `docs/embed-config.js` (generated artifact)
- Modify: `docs/embed.html` (generated artifact)

**Interfaces:**
- Consumes: environment variable `MARGINGO_PAGES_API_BASE` containing an HTTPS origin.
- Produces: `docs/embed-config.js` defining `window.MARGINGO_API_BASE` and `window.MARGINGO_STATIC_MODE=false`.

- [ ] **Step 1: Write a failing build test**

Add a test that invokes `node scripts/build_github_pages.mjs` with `MARGINGO_PAGES_API_BASE=https://www.200392.xyz`, then asserts that `docs/embed-config.js` contains the exact origin, `docs/embed.html` loads `embed-config.js`, and `docs/embed.html` does not load `static-api.js`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/api.test.js`

Expected: FAIL because `docs/embed-config.js` does not exist and the card still receives the static adapter.

- [ ] **Step 3: Implement the minimal build split**

In `scripts/build_github_pages.mjs`, validate the environment value with `new URL()`, require protocol `https:`, require pathname `/`, and reject query/hash/userinfo. Generate the online config and replace only the card HTML script reference. Continue injecting `profit-engine.js` and `static-api.js` into normal Pages entry points.

- [ ] **Step 4: Add invalid-config test cases**

Assert that missing, HTTP, and path-bearing values exit non-zero with a message containing `MARGINGO_PAGES_API_BASE`.

- [ ] **Step 5: Run the focused test**

Run: `node --test test/api.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

Commit message: `build: connect Pages embed to live backend`

### Task 2: Make the Pages workflow produce the online card

**Files:**
- Modify: `.github/workflows/deploy-pages.yml`
- Modify: `DEPLOYMENT.md`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: repository variable `MARGINGO_PAGES_API_BASE`, with fallback `https://www.200392.xyz`.
- Produces: a Pages artifact whose embed card targets the live server.

- [ ] **Step 1: Add workflow assertions to the existing build test**

Read `.github/workflows/deploy-pages.yml` and assert the build step supplies `MARGINGO_PAGES_API_BASE` and runs `npm run build:pages`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/api.test.js`

Expected: FAIL because the workflow does not supply the required variable.

- [ ] **Step 3: Update workflow and deployment documentation**

Set `MARGINGO_PAGES_API_BASE` on the build step using `${{ vars.MARGINGO_PAGES_API_BASE || 'https://www.200392.xyz' }}`. Document the Pages URL, exact `CORS_ORIGINS=https://ciksn.github.io`, manual branch deployment command, and post-deploy checks.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/api.test.js`

Expected: PASS.

Run: `npm test`

Expected: 237 or more tests pass, zero failures.

- [ ] **Step 5: Commit**

Commit message: `ci: deploy live-backed embed to Pages`

### Task 3: Build, publish, and verify GitHub Pages

**Files:**
- Verify generated: `docs/embed-config.js`
- Verify generated: `docs/embed.html`

**Interfaces:**
- Consumes: branch `codex/pages-live-backend` and GitHub Actions workflow `deploy-pages.yml`.
- Produces: deployed GitHub Pages card at `https://ciksn.github.io/amazon-profit-calculator/embed.html`.

- [ ] **Step 1: Generate and inspect the production artifact**

Run: `$env:MARGINGO_PAGES_API_BASE='https://www.200392.xyz'; npm run build:pages`

Expected: build succeeds; `docs/embed-config.js` targets the live origin; `docs/embed.html` contains no `static-api.js`.

- [ ] **Step 2: Verify repository state and commits**

Run: `git status --short` and `git log -3 --oneline`

Expected: only intentional generated artifacts are present or committed; no files from other branches appear.

- [ ] **Step 3: Push the isolated branch**

Run: `git push -u origin codex/pages-live-backend`

Expected: push succeeds.

- [ ] **Step 4: Dispatch and monitor the Pages workflow**

Run: `gh workflow run deploy-pages.yml --ref codex/pages-live-backend`, then monitor the resulting run with `gh run watch`.

Expected: workflow completes successfully and reports the GitHub Pages deployment URL.

- [ ] **Step 5: Verify deployed assets and CORS**

Request `https://ciksn.github.io/amazon-profit-calculator/embed-config.js` and `embed.html`; confirm the former targets `https://www.200392.xyz` and the latter does not load `static-api.js`. Send an OPTIONS request to `https://www.200392.xyz/api/health` with Origin `https://ciksn.github.io` and confirm `Access-Control-Allow-Origin: https://ciksn.github.io`.

- [ ] **Step 6: Report the final Pages URL and any server CORS action still required**

If CORS is missing, the Pages artifact is deployed but interactive API calls remain blocked; report the exact server environment change and do not claim end-to-end success until the header is present.
