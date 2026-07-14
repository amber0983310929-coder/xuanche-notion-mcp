# Xuanche Engine v0.5.1

Xuanche Engine is a Cloudflare Worker that connects GPT-facing HTTP endpoints to Notion world data and GitHub-backed code, memory, configuration, and cached snapshots.

## Implemented API

- `GET /health` — configuration status; add `?deep=1` with an API key to verify upstream services.
- `GET /home` — fetch the configured Notion home page; `?depth=N` includes recursive blocks.
- `GET /tree?pageId=...&depth=6&maxNodes=5000` — paginated, bounded recursive Notion reader.
- `GET /page/:id` and `GET /page?id=...` — compatibility page routes.
- `POST /world/load` (alias `/load`) — load a task profile from the configured world pages; `persist: true` commits `world/cache.json`.
- `POST /notion/pages` — create a child page.
- `POST /notion/blocks/:id/children` — append up to 100 Notion blocks; strings become paragraph blocks.
- `PATCH /notion/pages/:id` — update properties, icon, cover, archive, or trash state.
- `POST /world/update` — write Notion first, then append long-term memory and/or merge cache in GitHub.
- `GET /github/tree` and `GET /github/file?path=world/config.json` — inspect GitHub storage.
- `GET /openapi.json` — runtime API description.

All mutation and GitHub read routes require `X-API-Key` or `Authorization: Bearer ...`. When `PROTECT_READS=true`, `/home`, `/tree`, and both `/page` routes require the same key. The repository configuration enables this protection by default.

## Secrets and variables

```bash
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put XUANCHE_API_KEY
npx wrangler deploy
```

Configure `GITHUB_OWNER` and `GITHUB_REPO` in Cloudflare Worker variables. The GitHub token needs repository content read/write permission only for the Xuanche Engine repository.

`PROTECT_READS` is a non-secret Worker variable. Keep it set to `true` in production so world content is never exposed by a keyless browser request.

The Notion integration must be connected to the home page and all child pages the engine reads or updates.

For durable low-latency caching, create a Workers KV namespace and bind it as `XUANCHE_CACHE`. Without KV the Worker uses a best-effort isolate memory cache.

## Local verification

```bash
npm install
npm test
npm run dev
```

Do not place tokens in `.dev.vars` unless that file remains untracked. The repository should keep only placeholders and public page IDs.

## GPT Action setup

1. Deploy the Worker, then open `https://YOUR-WORKER.workers.dev/openapi.json` and confirm that its version is `0.5.1`.
2. In the GPT editor, open **Actions**, choose **Create new action**, and import that `/openapi.json` URL.
3. Set authentication to **API key**, choose **Custom header**, enter header name `X-API-Key`, then save the same value stored in the Cloudflare `XUANCHE_API_KEY` secret.
4. In Preview, first call `getEngineHealth`, then call `loadWorldProfile` with `profile: "continue"` and `refresh: false`.

The runtime OpenAPI document uses the current Worker origin automatically and provides a unique `operationId` plus request schema for every action.

## Example recursive load

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/world/load" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{"profile":"continue","refresh":true,"persist":true,"maxDepth":6,"maxNodes":5000}'
```

Available profiles are `base`, `continue`, `cultivation`, `combat`, `npc`, `exploration`, and `full`. Add extra modules without changing the profile using `pageKeys`, for example `{"profile":"continue","pageKeys":["equipment","economy"]}`.

## Example atomic world update

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/world/update" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "pageId":"NOTION_SAVE_PAGE_ID",
    "children":["最新續存檔內容"],
    "memoryEvent":{"type":"save","summary":"完成重大事件同步"},
    "cachePatch":{"latestSave":"完成重大事件同步"},
    "commitMessage":"chore(world): sync latest save"
  }'
```

The Notion write is performed first. If the later GitHub commit fails, the endpoint returns the failure so callers can retry synchronization without pretending the whole operation succeeded.

## v0.4 cache behavior

- The home page is loaded at `homeMaxDepth` (default `0`) so profile loads do not recursively duplicate all 00-29 modules.
- A KV cache hit can be persisted to `world/cache.json` without re-reading Notion.
- Every `/world/update` invalidates all cached `world:*` profiles, rather than one obsolete fixed cache key.

## v0.5 security and actions

- Configurable API-key protection covers every endpoint that exposes Notion world content.
- Basic `/health` and `/openapi.json` remain public; `/health?deep=1` remains protected.
- The OpenAPI 3.1 schema now includes all read, load, update, Notion, and GitHub operations with validation metadata suitable for GPT Actions.
- Cloudflare `nodejs_compat` is enabled for compatibility with current Worker tooling and libraries.
- v0.5.1 adds explicit `properties` declarations to every object schema for compatibility with the stricter GPT Actions validator.
