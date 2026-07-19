# Xuanche Engine Gateway v0.5.14

This Cloudflare Pages gateway keeps GPT Action responses below the payload limit and publishes a safety-scoped OpenAPI contract.

## Public GPT Action operations

- getNotionTree
- getNotionPage
- loadWorldProfile
- initializeWorld
- archiveAndResetWorld
- getArchiveAndResetStatus
- updateWorldState

Health diagnostics, broad administrative profiles, GitHub mirrors, arbitrary Notion page creation, raw block append, and page metadata mutation are excluded from the gameplay manifest. The compact `turn_core` and optional differential profiles remain available through `loadWorldProfile`.

The compact contract declares exact archive/reset status fields. `archiveAndResetWorld` returns HTTP 202 and must be followed only with `getArchiveAndResetStatus` using the original `operationKey`; `archiveId` and `workflowId` are never accepted as substitutes.

Character initialization explicitly preserves the defining motto, core desire, important bonds, weakness or fear, starting style, destiny talents, structured relationships, and director-only opening facts.

## Bounded reads

- Page reads always send depth 0 upstream.
- Page maxNodes defaults to 10 and is clamped to 20.
- maxChars defaults to 72,000 and is capped at 85,000.
- Continue the same page with data.cursor until data.has_more is false.
- The gateway reports any size reduction through data.truncated and _gateway.truncated.

Directory reads are shallow and only discover child-page links. Normal gameplay uses one cached `turn_core` profile load; `/page` batches remain a fallback for one exact page.

## Cloudflare Pages settings

- Project: xuanche-engine-gateway
- Root directory: gateway
- Build command: blank
- Build output directory: public
- Service binding: XUANCHE_ENGINE to the Xuanche Worker

After deployment, re-import `https://xuanche-engine-gateway.pages.dev/gpt-action-openapi.json` into GPT Actions and use `/privacy` as the privacy-policy URL. Confirm that the compact document reports version 0.5.14, contains exactly seven operations, declares archive HTTP 202, and exposes the structured status response.

## Verification

Run npm test in this directory, or run the root test suite.
