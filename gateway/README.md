# Xuanche Engine Gateway v0.5.11

This Cloudflare Pages gateway keeps GPT Action responses below the payload limit and publishes a safety-scoped OpenAPI contract.

## Public GPT Action operations

- getEngineHealth
- getNotionTree
- getNotionPage
- initializeWorld
- archiveAndResetWorld (only when the Worker is v0.5.13 or later)
- loadWorldProfile
- updateWorldState
- listGitHubWorldTree
- getGitHubWorldFile

Arbitrary Notion page creation, raw block append, and page metadata mutation are excluded. The advertised write paths are the confirmed-character initializer and the SAVE_V3.2 update operation. Both enforce fixed page IDs and SAVE_KEY idempotency in the Worker.

## Bounded reads

- Page reads always send depth 0 upstream.
- Page maxNodes defaults to 10 and is clamped to 20.
- maxChars defaults to 72,000 and is capped at 85,000.
- Continue the same page with data.cursor until data.has_more is false.
- The gateway reports any size reduction through data.truncated and _gateway.truncated.

World profile loads are compacted to the same response budget. Use turn_core plus one action-specific TURN_PRELOAD_V1 profile after each player response.

## Cloudflare Pages settings

- Project: xuanche-engine-gateway
- Root directory: gateway
- Build command: blank
- Build output directory: public
- Service binding: XUANCHE_ENGINE to the Xuanche Worker

After deployment, re-import the Pages /openapi.json URL into GPT Actions and use /privacy as the privacy-policy URL. Confirm that the document reports version 0.5.11 and exposes archiveAndResetWorld only when the bound Worker is v0.5.13 or later.

## Verification

Run npm test in this directory, or run the root test suite.
