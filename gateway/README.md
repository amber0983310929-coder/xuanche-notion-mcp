# Xuanche Engine Gateway v0.5.3 Hotfix

This package fixes `ResponseTooLargeError` from GPT Actions without changing the
Notion world, Worker secrets, GitHub memory, or KV data.

## Root cause

`depth=0` disables recursive descent, but `/tree` still returned full Notion block
objects. The live v0.5.2 OpenAPI also defaulted `maxNodes` to 5000. GPT Actions
requires each request and response payload to contain fewer than 100,000
characters.

## What changes

- Proxies every request through the existing `XUANCHE_ENGINE` Service binding.
- Compacts `/home`, `/tree`, `/page`, `/world/load`, and `/load` JSON responses.
- Removes redundant Notion metadata and converts rich text objects to plain text.
- Adds `offset`, `limit`, and `maxChars` pagination controls to `/tree`.
- Clamps `/tree` and `/home` upstream `maxNodes` to 250.
- Clamps `/page` to 50 blocks by default and 100 maximum, while preserving the
  existing Notion `cursor` for the next batch.
- Tells GPT Actions to use `getNotionPage` once per 12–29 module instead of using
  `/world/load` to combine all rule modules.
- Enforces an 85,000-character hard response cap (72,000 by default).
- Dynamically patches `/openapi.json` to version 0.5.3 while keeping the existing
  `getNotionTree` operation ID and authentication scheme.

## Cloudflare Pages settings

- Project: `xuanche-engine-gateway`
- Root directory: this folder
- Build command: leave blank
- Build output directory: `public`
- Required Service binding: `XUANCHE_ENGINE -> plain-dew-5810xuanche-api`

After deployment, re-import this URL into the GPT Action editor:

`https://xuanche-engine-gateway.pages.dev/openapi.json`

Test with:

- `depth=0`
- `maxNodes=60`
- `offset=0`
- `limit=30`
- `maxChars=72000`

If `_gateway.pagination.hasMore` is true, repeat with the returned `nextOffset`.

For module pages 12–29, call `getNotionPage` with `depth=0` and `maxNodes=50`.
When the response reports `has_more=true`, repeat the same page ID with the
returned `cursor` until `has_more=false`.

## Local verification

```bash
npm test
```
