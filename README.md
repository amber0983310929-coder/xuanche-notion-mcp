# Xuanche Engine v0.5.8

Xuanche Engine is the Cloudflare Worker bridge for the Notion-based cultivation world. Version 0.5.8 makes SAVE_V3.2 initialization rate-limit safe and recoverable after a completed commit.

## Safety model

- Notion pages 02–09, 11, and 31 are the only world-state pages accepted by the safe update endpoint.
- Every update requires WORLD_ID, WORLD_STATE, and a unique SAVE_KEY. Retrying the same SAVE_KEY is idempotent.
- Optional block updates verify that every block belongs to the declared fixed page and support optimistic expected-text checks.
- Public raw page creation, arbitrary block append, and page metadata mutation are disabled by default. They exist only behind ALLOW_RAW_NOTION_WRITES=true and are never advertised by OpenAPI.
- World loads reject archived pages and mixed save identities.
- Character confirmation uses one dedicated initializer: it rate-paces Notion, preflights every fixed page, stages all state, activates the canonical save marker last, validates readback, and reconciles compensation before declaring a conflict.
- A failed GitHub mirror is reported as pending after the authoritative Notion write; it does not make a completed Notion write look rolled back.

## Main API

- GET /health
- GET /home
- GET /tree
- GET /page and GET /page/:id
- POST /world/initialize
- POST /world/load
- POST /world/update
- GET /github/tree
- GET /github/file
- GET /openapi.json

All mutations and GitHub reads require X-API-Key. Production should also set PROTECT_READS=true.

## Dynamic turn preload

After the player replies, load turn_core and exactly one relevant profile:

- turn_combat
- turn_dialogue
- turn_exploration
- turn_cultivation
- turn_trade
- turn_travel

Resolve due public events from page 09 and private actor actions from page 11 before resolving the player action. Do not prewrite a player choice.

## Safe world update fields

Required:

- pageId
- saveKey
- expectedWorldId
- expectedWorldState
- at least one of children or blockUpdates

Optional:

- expectedRevision
- memoryEvent
- cachePatch
- commitMessage

The service appends the SAVE_KEY marker automatically and invalidates all cached world profiles.

## Confirmed-character initialization

Call POST /world/initialize exactly once after explicit character confirmation. It requires a unique saveKey and a character object containing name; opening context is optional. EMPTY/PENDING is the required starting state, not a reason to postpone initialization. A retry with the same SAVE_KEY returns the existing ACTIVE world without staging another copy.

## Deployment

Store NOTION_TOKEN, GITHUB_TOKEN, and XUANCHE_API_KEY as Cloudflare secrets. Keep compatibility_date current, keep observability enabled, and bind XUANCHE_CACHE when durable low-latency snapshots are needed.

NOTION_MIN_REQUEST_INTERVAL_MS defaults to 400 so one Worker instance stays below Notion's documented average of three requests per second. The client also honors Retry-After for HTTP 429 and 529 responses.

The Pages gateway lives in gateway/. Bind XUANCHE_ENGINE to the Worker and import the gateway /openapi.json into GPT Actions. The gateway exposes bounded reads, confirmed-character initialization, safe profile loads, safe world updates, and read-only GitHub inspection.

## Verification

Run npm test at the repository root. The same test suite includes the gateway tests.

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
