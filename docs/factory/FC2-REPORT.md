# FC2 — Gate report: the /chat shell

Built to FS-FC-PROPOSAL §3 FC2 by a worktree agent (merged `bcdbe4acd`); no migration; live on `:3100` (nav → Chat).

## Plain English
Chat is now visible: a Chat entry in the nav opens the two-pane Google-Chat-style workspace — spaces on the left (search, unread badges, bold-when-unread, activity-sorted; order spaces marked with a package icon), the conversation on the right with author-grouped messages, day dividers, system messages as grey chips that deep-link to their order or quote, editing and deleting with tombstones, and a composer with @-mention autocomplete (Enter sends, Shift+Enter for a new line). Panes resize and remember your widths; everything is windowed so a 5,000-message space renders ~25 rows. Money in chat stays owner-only by construction — verified in the rendered page, not just the API.

## Proven at scale (agent's in-worktree click-through on the seeded harness)
Rail: 20 DOM rows over 100 spaces · monster space (5,000 msgs): 23–25 DOM rows, 15–24 ms windows, "Load earlier" scroll-anchored (no yank) · optimistic send→reconcile without dupes · live SSE cross-user delivery · Worker DOM contains zero `€` where the Owner sees `Shipping label bought: €1,270.64`. New gated seeder `scripts/scale/seed-chat.ts` keeps this repeatable.

## Deviations (accepted at merge)
Two substrate amendments the rail anatomy required (spaces list now carries lastMessage/member-count on the same bounded query; posting bumps space activity) — FC2-tagged inside FC1 files; Chat placed 2nd in nav after Inbox (communication cluster — say the word to move it); reactions/threads data deliberately unrendered (FC3/FC4); rail bounded to the 100 most-active spaces (FC1 contract).

## Verified
397 tests on main post-merge (24 new UI-core tests) · rbac 135 · ds-parity 97/97 · query-bounds · no-touch · `.next-verify` build · `/chat` 200 on your live runtime. Your click-through: open Chat in the nav — the first real order space appears when an order is next created (FC1's auto-hook); FC3 (threads + mentions surfacing) and FC4 (reactions/receipts/typing) complete the anatomy.
