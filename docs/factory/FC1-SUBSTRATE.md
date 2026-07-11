# FC1 substrate notes (pre-spec working doc · audited 2026-07-11)

Feeds the FC1 spec (written after FS2 ships, per the approved FS-FC ordering). Facts verified at commit `b80b4ab0`; re-verify anything load-bearing at spec time.

## Reusable as-is
- **Comment** is polymorphic (`entityType/entityId`), append-only in practice (`editedAt` column exists, nothing writes it; no PATCH/DELETE routes). Service `src/lib/comments.ts`: mention-resolve → notify fan-out → `comment.created` publish. Only consumer: inbox ThreadPane (`entityType:"conversation"`).
- **Notification + notify() + bell**: single write path, durable publish, worker-visible (`PAGES.production` gate on the bell routes is deliberate). Deep-link convention is query-param (`/inbox?focus=`, `/quotes?q=`) — **no order deep-link exists yet; FC1 invents it**.
- **Attachment** already carries an UNUSED generic `entityType/entityId` host + `@@index` — chat file attachments need no schema change. Local-disk (`data/attachments/`) + save-to-Drive patterns exist.
- **Service doctrine** (`team-service.ts`): guardrails → mutate; tokens = raw-once + sha256; NOTE divergence — team audits at ROUTE layer, comments audit INSIDE the service; chat-service should audit inside (single-mutation-path doctrine).
- **Permission mechanics**: add `pages.chat` + `chat.*` FEATURES to `permissions.ts` (auto-flows to catalog/validation); WORKER role needs EXPLICIT grants in `SYSTEM_ROLES` or Workers are silently denied; every route must satisfy `check:rbac` (export permission + guarded()).
- **Nav**: `FACTORY_PAGES` (nav.ts) + `ICONS` map (FactoryShell) = the two edit sites. **Navigation law satisfied: the Owner-approved FS-FC proposal (2026-07-11) explicitly scoped the `/chat` page — recorded in ENTERPRISE-PROGRAM.md.**

## Missing (FC1 builds)
Space/message/thread entities (Comment lacks read-state/reply-to/edit/delete/ordering guarantees); order deep-link convention; system-authored message primitive (closest analog: `poll-tracking.ts` audit rows with `actorId:null`); OrderDetail has NO tab host (single scroll + Timeline) — the "Space" button/tab needs scaffolding; the ThreadPane Reply/Comment SegmentedControl is the proven in-page UI archetype.

## The traps (spec MUST answer)
1. **Cost-blind money in system messages**: `stripFinancials` DELETES keys by name (`*Cents` deny-by-default); money interpolated into free-text `title`/`body` is unstrippable and would leak to Workers (the timeline.ts:4-6 rule). FC5 system messages carry money ONLY in structured `*Cents` fields, client-formatted post-strip.
2. **Reuse-or-extend Comment**: recommendation at spec time — new Chat entities, leave Comment as the lightweight per-entity note it is (inbox amber notes keep working; no risky migration); revisit only if the spec finds real overlap.
3. **FC5 sourcing**: subscribe to the FS2 bus (payload-thin) vs tap ~15 emission routes (ordered, 15 edit sites). Post-FS2 the bus becomes gap-free + durable with ids — bus-subscription becomes the right answer; confirm at spec time.
4. Worker grants: decide which `chat.*` features WORKER gets (write in own order-spaces: yes; create CUSTOM spaces: Owner-only default).
5. Deep-link: adopt `/orders?o=<id>&tab=space` (matches existing `?o=` pattern in OrdersClient) + `/chat?space=<id>`; bell links are plain `<a>` — both resolve via existing prefix matching.
