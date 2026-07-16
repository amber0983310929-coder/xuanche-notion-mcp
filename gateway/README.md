# Xuanche Engine Gateway v0.5.5

This Cloudflare Pages gateway keeps GPT Action responses below the payload
limit and publishes a safety-scoped OpenAPI contract. Deploying this package
does not by itself migrate or rewrite the Notion world, Worker secrets, GitHub
memory, or KV data.

## Public GPT Action contract

`/openapi.json` exposes only these operations:

- `getEngineHealth`
- `getNotionTree`
- `getNotionPage`
- `createNotionPage`
- `appendNotionBlocks`
- `updateNotionPage`
- `listGitHubWorldTree`
- `getGitHubWorldFile`

High-risk batch operations are not present in the GPT Action schema:

- `getWorldHome`
- `getNotionPageTreeById`
- `loadWorldProfile`
- `updateWorldState`

The gateway still proxies their existing routes for backward compatibility;
removing them from the public schema does not remove or rename backend routes.

## Safe page-by-page reads

- `/page` always sends `depth=0` upstream.
- `maxNodes` defaults to 10 and is clamped to 20.
- `maxChars` defaults to 72,000 and is capped at 85,000.
- Each call reads exactly one page. This includes pages and modules 00–31,
  individual 30-x narrative submodules, and selected 31 experience cards.
- Continue the same page with `data.cursor` until `data.has_more` is false.
- The stable page payload uses `data.items`, `data.has_more`, `data.cursor`, and
  `data.truncated`; `_gateway.truncated` reports gateway budget reduction.

`getNotionTree` is limited to a lightweight direct-child index. The gateway
forces `depth=0`; module bodies must be read with `getNotionPage`, one page at a
time.

The gateway compacts raw Notion block metadata and enforces the response budget.
It preserves the native Notion cursor and aligns local pagination with the
clamped `maxNodes` value so no blocks are skipped between batches.

## Cloudflare Pages settings

- Project: `xuanche-engine-gateway`
- Root directory: this folder
- Build command: leave blank
- Build output directory: `public`
- Required Service binding: `XUANCHE_ENGINE -> plain-dew-5810xuanche-api`

After deployment, re-import this URL into the GPT Action editor:

`https://xuanche-engine-gateway.pages.dev/openapi.json`

Set the GPT Action privacy policy URL to:

`https://xuanche-engine-gateway.pages.dev/privacy`

Confirm that the OpenAPI document reports version `0.5.5` and lists exactly the
eight operations above.

## Local verification

```bash
npm test
```
