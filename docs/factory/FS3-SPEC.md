# FS3 — UI truthful at volume (binding spec)

Kills the three UI cliffs (S-4 ThreadPane un-windowed · S-5 DataGrid renders every row · S-16 whole-list pickers) plus the two DOM-accumulation leaks FS1's cursoring introduced (inbox Load-more and kanban lanes append forever). Grounded in the 2026-07-11 exhaustive inventory (19 DataGrid call sites, 8 growing lists, 5 scale-growing pickers, DS constraint verified). No time estimates.

## DS constraint (settled by inventory)

The design-system tree is a byte-identical guarded copy; neither it nor apps/web has any virtualized/async component. Therefore every FS3 component is **factory-local in `src/components/`** (PROVENANCE rule 2), styled with the existing `h10-*` tokens for visual parity; proven patterns may be offered upstream to apps/web later as a separate commerce-side decision. One new dependency: **`@tanstack/react-virtual`** (headless, tiny) rather than hand-rolled windowing.

## New components (the FS3 toolkit)

| Component | Replaces/serves | Notes |
|---|---|---|
| `VirtualDataGrid` | the 9 heavy DataGrid call sites | same column/row API + visual parity with DS DataGrid (same class names); windowed rows; sort stays but memoized; screenshot-diffed against the DS grid |
| `WindowedList` | ConversationList accumulation · kanban lane cards · notifications later | generic virtualizer wrapper for non-tabular lists |
| `AsyncCombobox` | the 5 scale-growing Listbox/Menu pickers | server-search (`?q=&cursor=`), paged, keyboard-complete, DS Combobox look |
| `MentionTextarea` | inbox composer (and FC composers later) | textarea + `@` popover fed by the users search endpoint |
| `PaneHandle` + `useResizablePanes` | extracted from InboxClient (2026-07-10 fix) | generalized (N panes, per-pane min/max, storage key); InboxClient swaps to it — coordinate with the EPI session before touching that file (registry) |

## Server-side companions

- **Windowed thread API** (S-4's server half): `/api/inbox/[id]` gains `?before=<messageId>&take=100` — newest window by default, "Load earlier" pages back; response carries `hasEarlier` + totals. ThreadPane renders the window virtualized; the 5,000-message thread stops shipping 2 MB.
- **Search endpoints**: `/api/users-lite?q=&cursor=` and `/api/parties-lite?q=&cursor=` gain paged search (existing unpaged behavior kept until every consumer is swapped, then removed with the `// bounded:` annotations updated).
- **Team grid take** (inventory found it unbounded at 500 users) + grid Load-more affordances wherever a `nextCursor` already exists but no UI exposes it (orders grid, financials by-order).

## Rollout (one gated unit each, treatment table order)

1. **FS3.a ThreadPane**: windowed API + virtualized timeline + "Load earlier". Exit: 5k-msg thread ≤ 300 DOM rows, window payload ≤ ~150 KB, open feels instant on the harness monster thread.
2. **FS3.b VirtualDataGrid** adopted on: orders, quotes, contacts, financials (by-customer, by-order, deposits), shipping ×2, team (+take), POs, CSV-import previews ×2. Exit: 10k-row feed scrolls at 60 fps, DOM bounded, zero visual diffs.
3. **FS3.c AsyncCombobox**: assignee (inbox), worker assign (production), party pickers (quotes/orders/price-lists) + the two search endpoints. Exit: 500-user / 5k-party picks are type-to-find, no whole-table fetch anywhere (annotations updated).
4. **FS3.d Windowed accumulators**: ConversationList + kanban lanes on `WindowedList`. Exit: 50 Load-mores leave DOM bounded.
5. **FS3.e Mention + panes**: `MentionTextarea` in the inbox composer (server resolve already exists; S-10's indexed lookup lands in FS4 as planned); `PaneHandle` extraction. Exit: @-popover selects any of 500 users; inbox behavior unchanged after the swap (EPI-session coordination noted in the registry).

Config-sized pickers (templates/price-lists/materials) explicitly stay plain Listboxes — recorded so no EP session "upgrades" them unnecessarily.

## Test plan
Unit: windowing math, combobox paging/keyboard, mention parser boundaries. Harness: monster-thread + 10k-grid scenarios re-measured (payload + DOM counts in the gate report). Visual: screenshot parity for every swapped grid. Gates: full suite + query-bounds + ds-parity (must stay 97/97 — proof nothing touched the DS tree). Click-through on :3199 at scale volumes.

## Rollback
Per-unit reverts; old components remain until their unit's gate passes (adoption is per-call-site, not big-bang).
