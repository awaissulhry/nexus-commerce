# F21 - Chat & Order Spaces (FC)

> **Route:** `/chat` (the Owner-approved 12th nav item) · **Codes:** FC1–FC6 · **Status:** ⚪ approved, builds after FS2 (✅ shipped) — **FC1 spec is the next substrate step.**
> Canonical docs: `FS-FC-PROPOSAL.md` · `FC1-SUBSTRATE.md`

Part of [[F00 - Factory OS MOC]] · closes the "no communication gap" invariant's *internal* half

## Purpose

**Order Spaces** — Google Chat's structure and interface built natively (Google Chat itself is un-embeddable: Chat API needs Workspace; the factory account is consumer Gmail). One internal team channel per order (Owner + assigned workers); the **customer stays in Gmail** ([[F10 - Inbox (EPI)]]) — mirroring Google's own email/Chat split. FD5's pluggable `Conversation.channel` anticipated this.

## Phases

| Phase | Delivers |
|---|---|
| FC1 | Substrate (no UI): `ChatSpace`/`ChatMessage`/`ChatMember`/`ChatReaction` (additive), one sanctioned `chat-service.ts`, auto-create space per order, auto-membership |
| FC2 | `/chat` shell + order-detail "Space" tab |
| FC3 | Threads + smart-chip @mentions + `@all` + bell |
| FC4 | Reactions, edit/delete own, read receipts, typing/presence (rides FS2) |
| FC5 | **Order feed** — lifecycle system messages as deep-link chips + file sharing |
| FC6 | Home/DMs/search (FTS via FS5), CUSTOM spaces |

## The traps (from FC1-SUBSTRATE — binding)

1. **Money in system messages** only via structured `*Cents` fields, client-formatted post-strip — free-text money is unstrippable and leaks to Workers ([[F04 - Domain Model & Money Invariants]]).
2. New entities, don't overload `Comment` (it stays the lightweight note for non-order entities).
3. FC5 sources from the now-gap-free FS2 durable bus — not by tapping 15 emission routes.
4. Worker `chat.*` grants must be EXPLICIT in `SYSTEM_ROLES` or silently denied; CUSTOM spaces Owner-only by default.

## Seams other pages must leave (already coordinated)

- [[F12 - Orders (EPO)]] EPO.6 scaffolds the OrderDetail **tab host** FC2 mounts into; deep-link law `/orders?o=<id>&tab=space` + `/chat?space=<id>`.
- [[F10 - Inbox (EPI)]] EPI.6 defines the email-event card contract (`?focus=&msg=` anchors) FC5 renders.
- [[F11 - Quotes (EPQ)]] quote-feed integration deferred to FC5.
- FS3's `MentionTextarea`/`AsyncCombobox` feed FC composers ([[F22 - Substrate FS Series]]).

## FC1 spec status (2026-07-16)

`docs/factory/FC1-SPEC.md` drafted — **awaiting Owner gate**. Answers all five substrate questions: new Chat* entities (Comment untouched), audits inside chat-service, money via strippable `moneyCents` field (never in body — enforced by test), FC5 sources from the FS2 bus, WORKER gets `pages.chat`+`chat.post` explicitly. Windowed message API ready for FS3's WindowedList in FC2.
