# Xuanche Engine storage rules

- Notion is the authority for live world rules, saves, databases, timelines, and the AI loading route.
- GitHub is the authority for source code, configuration, version history, cached snapshots, and append-only long-term memory.
- Cloudflare Worker is the authenticated bridge. It must not embed Notion, GitHub, or API tokens in source code.
- Read operations may use short-lived KV cache. Durable world changes must be written to Notion first and recorded in GitHub only after the Notion write succeeds.
- A failed GitHub follow-up must be reported; it must never be presented as a fully synchronized update.
- `world/memory.json` keeps at most the latest 1,000 structured events. Older history belongs in Git commits or an archive workflow.
