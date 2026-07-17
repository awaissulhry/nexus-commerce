# FC4 — Gate report: reactions, read receipts, typing & presence

Built to FS-FC-PROPOSAL §3 FC4 by a worktree agent (merged post-`60f334500`); migration-free; live on `:3100` via HMR.

## Plain English
Chat feels alive now: hover a message to react (quick emoji or the fuller grid), see exactly who has read up to where (the little initial-avatars sitting under each person's last-read message — never your own to yourself), watch "X is typing…" appear and fade, and see green presence dots for whoever's online. Each space has a bell menu — All / @mentions only / Off — and the notification engine already respects it. None of the typing/presence traffic touches the database: it rides the live wire only, by design.

## Shipped
Reaction picker (8 quick + 24-grid) with optimistic toggle + name tooltips · read receipts from the existing per-member cursors (placement math handles cursors on thread replies; stack 5 + "+N") · **ephemeral event path** (`publishEphemeral`, id 0, never persisted, resume undisturbed — documented as single-process-correct with FS6's pub/sub as the named successor) · typing throttled ≤1/2s through a membership-checked no-DB-write route · presence from the SSE hub's own connection registry (server-computed, ids never shipped to non-members) with self-healing broadcast · per-space notify-level bell (audited; `pages.chat`-guarded so read-only roles can still be mentioned properly).

## Substrate amendments (flagged + accepted)
`events.ts`: 2 union types + ephemeral publisher + `connectedUserIds` + presence emission on register/unregister. `use-factory-events.ts`: subscribers now receive the parsed event and a new `useFactoryEventData` hook exists — required because ephemeral events have no DB row to refetch; the existing refetch-style hook is unchanged and zero call sites moved.

## Deviations (accepted)
Receipts render in the main stream only (cursor is per-space); typing is space-level, not per-thread; read-cursor publish went scoped→broadcast so receipts live-update space-wide; the agent smoked on :3197 because a leftover :3199 verify server was possibly another session's (right call — never kill a possibly-shared process).

## Verified
633 tests in-worktree (27 new) → 648 on main post-merge · rbac 158 routes · query-bounds 160 files · no-touch · ds-parity 97/97 · build · runtime SSE smoke: presence flip `[] → [me] → []` on a real connection, `id:0` frames confirmed absent from the resume stream, reaction idempotence, notify dial. Remaining: your two-browser click-through (reactions/receipts/typing between you and a Worker), and FC6 (DMs + search) closes the chat arc.
