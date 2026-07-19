# Xuanche Engine v0.5.17

Xuanche Engine is the Cloudflare Worker bridge for the Notion-based cultivation world. Version 0.5.17 adds FAST_TURN_V1 page-level caching, compact profile loads, batched world updates, and per-stage latency telemetry.

## Safety model

- Notion pages 02–09, 11, and 31 are the only world-state pages accepted by the safe update endpoint.
- Every update requires WORLD_ID, WORLD_STATE, and a unique SAVE_KEY. Retrying the same SAVE_KEY is idempotent.
- Optional block updates verify that every block belongs to the declared fixed page and support optimistic expected-text checks.
- Public raw page creation, arbitrary block append, and page metadata mutation are disabled by default. They exist only behind ALLOW_RAW_NOTION_WRITES=true and are never advertised by OpenAPI.
- World loads reject archived pages and mixed save identities.
- Archive-and-reset first verifies a checksummed Notion archive and then holds a durable reset lock until every fixed page is EMPTY/PENDING; it never presents a partially cleared world as playable.
- Character confirmation uses one dedicated initializer: it rate-paces Notion, preflights every fixed page, stages all state, activates the canonical save marker last, validates readback, and reconciles compensation before declaring a conflict.
- A failed GitHub mirror is reported as pending after the authoritative Notion write; it does not make a completed Notion write look rolled back.

## Main API

- GET /health
- GET /home
- GET /tree
- GET /page and GET /page/:id
- POST /world/initialize
- POST /world/archive-reset
- GET /world/archive-reset/status
- POST /world/load
- POST /world/update
- GET /github/tree
- GET /github/file
- GET /openapi.json

All mutations and GitHub reads require X-API-Key. Production should also set PROTECT_READS=true.

## Dynamic turn preload

After the player replies, load `turn_core` once with `refresh: false`. Load at most one relevant differential profile only when the current action requires it:

- turn_combat
- turn_dialogue
- turn_exploration
- turn_cultivation
- turn_trade
- turn_travel

Resolve due public events from page 09 and private actor actions from page 11 before resolving the player action. Do not prewrite a player choice.

For dialogue, call `turn_core` first and add `turn_dialogue` only when relationship or NPC voice detail is required. The dialogue profile contains only relationships, obligations, and NPC rules; page 11 already comes from `turn_core` and is not duplicated.

## Safe world update fields

Required for every update:

- saveKey
- expectedWorldId
- expectedWorldState
- either one pageId with children/blockUpdates, or a mutations array containing up to nine changed fixed pages

Optional:

- expectedRevision
- memoryEvent
- cachePatch
- commitMessage

The service verifies the canonical save once, appends the SAVE_KEY marker to every mutation, and invalidates only changed page caches plus legacy profile entries.

## Archive and reset

`POST /world/archive-reset` is deliberately separate from initialization. It requires `confirmation: "ARCHIVE_AND_RESET"`, the exact current `expectedWorldId`, and an idempotent `operationKey`. It returns quickly with `ARCHIVING`; the durable Workflow then copies pages 02–09 and 11 into a `世界封存庫` child page in Notion, checks the SHA-256 digest of every source snapshot, and only then clears the fixed pages to `EMPTY/PENDING`. Read `GET /world/archive-reset/status` with the same world ID and operation key until it reports both `archiveVerified: true` and `reset: true`. The endpoint deliberately refuses to fall back to an unsafe synchronous reset when the Workflow binding is absent.

## Confirmed-character initialization

Call POST /world/initialize exactly once after explicit character confirmation. It requires a unique saveKey and a character object containing name; opening context is optional. EMPTY/PENDING is the required starting state, not a reason to postpone initialization. A retry with the same SAVE_KEY returns the existing ACTIVE world without staging another copy.

## Deployment

Store NOTION_TOKEN, GITHUB_TOKEN, and XUANCHE_API_KEY as Cloudflare secrets. Keep compatibility_date current, keep observability enabled, and bind XUANCHE_CACHE when durable low-latency snapshots are needed.

NOTION_MIN_REQUEST_INTERVAL_MS defaults to 400 so one Worker instance stays below Notion's documented average of three requests per second. The client also honors Retry-After for HTTP 429 and 529 responses.

The Pages gateway lives in gateway/. Bind XUANCHE_ENGINE to the Worker and import the gateway /openapi.json into GPT Actions. The gateway exposes bounded reads, confirmed-character initialization, verified archive/reset, safe profile loads, safe world updates, and read-only GitHub inspection.

## Verification

Run npm test at the repository root. The same test suite includes the gateway tests.

## Version 0.5.17

- Added page-granular KV caching: a normal turn reloads only pages changed by the previous save while unchanged rules and state remain warm.
- Changed normal profile loads to `refresh: false` and exposed compact `loadWorldProfile` in the gameplay Action manifest.
- Added batched page mutations to `updateWorldState`, so one major event verifies 02 only once before updating all affected fixed pages.
- Reduced every action-specific turn profile to a true differential and removed the duplicated director page from dialogue loads.
- Added cache hit/miss, page timing, canonical-read, mutation, GitHub, and invalidation timings to Worker logs and responses.

## Version 0.5.14

- Moved archive-and-reset into a bound Cloudflare Workflow so a long Notion snapshot cannot exceed a GPT Action response window.
- Added `getArchiveAndResetStatus`, which reports the durable job's real queued, running, complete, or failed state rather than returning an ambiguous timeout result.
- Removed the synchronous reset fallback: a deployment with a missing Workflow binding fails closed before it can modify a world.

## Version 0.5.13

- Added `archiveAndResetWorld`: an explicit, exact-WORLD_ID operation that creates a full Notion archive before any fixed world page is cleared.
- A durable KV reset lock blocks world reads and writes during the non-atomic Notion clearing phase; interrupted resets resume only with the same operation key.
- Archives preserve each fixed page as a checksummed JSON snapshot, then GitHub active memory/cache are reset to EMPTY/PENDING to prevent cross-world bleed.

## Version 0.5.12

- Removed duplicate live-state and broad narrative pages from `turn_dialogue`; it now adds only the four active-cast modules after `turn_core`.
- Raised the per-page dialogue safety ceiling to 200 nodes so a growing NPC rules page cannot halt the entire interaction before any scene is generated.

## Version 0.5.11

- Added a bounded, compact `turn_dialogue` profile for active-cast scenes instead of loading broad intelligence, faction, and unrelated narrative pages.
- Enforced a 60-node per-page cap for dialogue preloads, protecting the character context inside the GPT Action response budget.
- Added `NPC_LIVE_PRELOAD_V1` capability reporting for deployment verification.

## Version 0.5.10

- Aligned the `continue` profile with the fixed ACTIVE-world core route instead of preloading nineteen pages.
- Forced world profile loads to depth 0 so tables, toggles, and child pages cannot recursively multiply Notion requests.
- Made KV snapshot writes best-effort so a cache size or transient failure cannot turn a valid Notion read into HTTP 500.

## Version 0.5.8

- Paced Notion requests below the documented average connection limit and added HTTP 529 retry handling.
- Prevented a transient post-commit readback failure from rolling back an already ACTIVE world.
- Reconciled authoritative markers after rollback errors before declaring WORLD_CONFLICT.
- Synchronized the Notion home and route status as non-authoritative display mirrors.

## Version 0.5.7

- Added initializeWorld for same-turn confirmed-character initialization across pages 02–09 and 11.
- Added staged writes, canonical-save-last activation, readback validation, compensation, and idempotent retries.
- Fixed full-width `｜` world-marker parsing, which could misread an EMPTY page as an unknown state.
- Added gateway backend gating so initializeWorld is never advertised against a pre-0.5.7 Worker.
- Synced Notion CHARACTER_CONFIRM_AUTORUN_V1 rules so explicit confirmation invokes initialization in the same assistant turn.

## Version 0.5.6

- Added SAVE_V3.2 world identity validation and TURN_PRELOAD_V1 profiles.
- Added fixed-page write allowlisting, SAVE_KEY idempotency, block ancestry checks, and optimistic block updates.
- Removed arbitrary Notion writes from the public OpenAPI and GPT Action contract.
- Reset GitHub memory and cache metadata to PURGE-2026-07-17-FULL-SAVE-RESET without retaining gameplay history.
- Added CI and Cloudflare observability configuration.
## Version 0.5.14

- Moved `archiveAndResetWorld` into a durable Workflow and added `getArchiveAndResetStatus` for explicit, inspectable progress and errors.
- The action now returns quickly with `ARCHIVING`; the workflow retains its result and retries independently of the ChatGPT Action request lifetime.
