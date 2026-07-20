# Xuanche PWA and Gateway v0.6.0

This Cloudflare Pages project serves two compatible surfaces:

- an installable private game at `/`;
- the existing safety-scoped GPT Action gateway at `/gpt-action-openapi.json`.

The PWA loads the authoritative `turn_core` state through the XUANCHE_ENGINE service binding, calls the OpenAI Responses API only from a Pages Function, streams the `narrative` function argument to the browser, and then sends one fixed-shape payload to `/world/turn/commit`. API keys are never bundled into `public/`.

## Required Pages configuration

| Binding or secret | Purpose |
| --- | --- |
| `XUANCHE_ENGINE` | Service binding to the Xuanche Worker |
| `XUANCHE_API_KEY` | Same private key configured on the Worker |
| `OPENAI_API_KEY` | Server-side Responses API credential |
| `PWA_ACCESS_KEY` | Owner passphrase used only to create a signed session |
| `PWA_SESSION_SECRET` | Independent HMAC secret for the HttpOnly session cookie |

Optional settings:

- `OPENAI_MODEL` defaults to `gpt-5.6-terra`.
- `OPENAI_REASONING_EFFORT` defaults to `low`.
- Cloudflare Access can additionally protect the complete Pages project at the platform edge; the in-app passphrase remains required.

Configure secrets separately for Preview and Production when using Pages preview deployments.

## PWA routes

- `GET|POST|DELETE /api/session`
- `GET /api/game/state`
- `POST /api/game/turn` (SSE narrative stream followed by authoritative commit)
- `POST /api/game/commit` (replay a locally retained pending-save checkpoint)

All state-changing browser requests require same-origin requests and an authenticated HttpOnly/SameSite session. The browser stores only display preferences, recent prose for offline reading, and a pending fixed-shape checkpoint when a generated turn needs a save retry.

## GPT Action compatibility

The compact manifest still publishes seven operations: bounded Notion reads, profile load, world initialization, archive/reset start and status, and the legacy safe world update. It does not expose the PWA commit endpoint, raw Notion writes, secrets, or broad administrative routes.

## Pages project settings

- Project: `xuanche-engine-gateway`
- Root directory: `gateway`
- Build command: blank
- Build output directory: `public`
- Service binding: `XUANCHE_ENGINE`

Run `npm test` in this directory, or run the root test suite.
