# FC3 — Gate report: in-line threads, thread-scoped notifications, @all

Built to FS-FC-PROPOSAL §3 FC3 by a worktree agent (merged `74974c25d`), migration `fc3_followed_threads` applied live + harness, runtime restarted.

## Plain English
Chat now threads the way Google Chat does: hover any message → "Reply in thread" opens a right-side panel (a third resizable pane that remembers its width) with the original pinned on top and replies below. The main stream stays clean — it shows reply counts and small participant faces on the root message instead of the replies themselves. Replying or being mentioned in a thread auto-follows it; followed threads with new activity surface in a "Threads" section at the top of the rail. A thread reply notifies only the people in that thread — never the whole space — and `@all` exists for when you DO want everyone. @mentions render as chips in message text.

## Shipped
ThreadPanel (windowed, own persisted width) · thread bars with reply count + facepiles · auto-follow on reply/mention + follow/unfollow toggle · thread-scoped notification audience (participants+followers+mentioned−author, notify-level respected: OFF mutes all, MENTIONS mutes non-mention pings) · @all (explicit, audited, MENTION-kind) · mention chips via ONE shared grammar (`MENTION_RE_SOURCE` — comments.ts now consumes it, so inbox and chat can never drift) · rail "Threads" section (followed + unread only, bounded 20) · deep-link `/chat?space=<id>&thread=<rootId>` · space unread badge is now main-stream-only (the Google rule: thread activity notifies its audience, it doesn't bold the whole space).

## Deviations (accepted)
- Thread-reply pings use NotificationKind **SYSTEM** (deliberate: MENTION must stay trustworthy for the MENTIONS notify-level filter; a dedicated THREAD_REPLY enum value is a named later addition, isolated to one constant).
- Fully-read followed threads hide from the rail section (own replies never mark a thread unread).
- Merge resolution with FS4: comments.ts keeps FC3's shared mention grammar AND FS4's bounded legacy-scan fallback.

## Verified
512 tests in-worktree (26 new) → 592 on main post-merge · rbac 143 · query-bounds 145 · no-touch · ds-parity 97/97 · build · agent's :3199 runtime smoke on the harness: thread window paging (100+30), one-level rule 400s, scoped notifications delivered (SYSTEM reply-ping + MENTION @all), Worker payload carried **zero** moneyCents keys, 36 DOM rows windowed over 131 replies, panel width persisted across reload. Remaining anatomy: FC4 (reactions, read receipts, typing/presence) then FC6 (DMs, search).
