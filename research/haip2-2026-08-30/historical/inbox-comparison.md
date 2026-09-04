# Inbox candidate comparison — static inspection, 30 August 2026

Method: static source inspection at pinned revisions. **Neither candidate was
deployed or integrated; no runtime spike was performed and no runtime spike report
exists.** Conclusion adopted in the HAIP 2 plan: neither provides the required
external-review integration without changing its review or lifecycle behaviour;
neither becomes a runtime dependency; HAIP builds its native inbox.

## awaithumans

Revision `bc05b8e7121be50f59cadf18a86b9e626e79c6b3` (Apache-2.0; Python server with
Python/TypeScript SDKs; Slack/email/dashboard channels).

- [Task contract](https://github.com/awaithumans/awaithumans-human-in-the-loop-ai-agents/blob/bc05b8e7121be50f59cadf18a86b9e626e79c6b3/packages/python/awaithumans/server/schemas/task.py)
- [Task lifecycle](https://github.com/awaithumans/awaithumans-human-in-the-loop-ai-agents/blob/bc05b8e7121be50f59cadf18a86b9e626e79c6b3/packages/python/awaithumans/server/routes/tasks.py)

Notes: library-first (`await_human()`) model; machine credentials can complete
decisions; its AI-verifier feature is incompatible with HAIP's human-only
authorisation lane.

## Impri

Revision `a665dbcb263272a87d350032f1810a17f7821893` (MIT; TypeScript/Fastify/SQLite
server, Vue inbox, MCP server, CLI).

- [Notifications](https://gitlab.com/sekera.radim/impri/-/blob/a665dbcb263272a87d350032f1810a17f7821893/server/src/notify.ts)
- [Inbox controls](https://gitlab.com/sekera.radim/impri/-/blob/a665dbcb263272a87d350032f1810a17f7821893/ui/src/components/ActionDetail.vue)

Notes: API-key bearer authentication rather than individual reviewer identity;
per-field `editable` payloads conflict with immutable-review requirements; v0.1
pre-release, single maintainer.

## Link verification

All four pinned links confirmed resolvable on 2026-08-30 (GitHub contents API for
awaithumans; HTTP 200 on GitLab raw for Impri).
