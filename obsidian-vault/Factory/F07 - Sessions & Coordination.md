# F07 - Sessions & Coordination

> How multiple Claude sessions build Factory OS in parallel without collisions. The binding contract is `docs/factory/ENTERPRISE-PROGRAM.md` ([[F06 - Enterprise Program (EP)]]); this note explains the working model.

## The model

Several sessions work **concurrently on `main`** in the same repo checkout. Coordination is file-based:
- **Claim registry** — a session claims a page by editing its row in the control tower and committing `--only` that file. Claimed = exclusively owned.
- **Scoped commits only** — `git commit --only <files>`; never `git add -A` (another session's WIP is always in the tree).
- **Known races (all benign, all seen):** push rejected with "remote is at *your* sha" = someone pushed your commit for you — fetch and verify. The shared registry file gets swept into whichever session commits next — content is always the intended state. Pre-push hook builds can flake on `.next` races — retry once.
- **Memory** — each session maintains its project file in the shared memory index; the vault ([[F00 - Factory OS MOC]]) is the visual layer over the same truth.

## Active sessions (2026-07-16)

| Session | Owns | State |
|---|---|---|
| EPQ session | [[F11 - Quotes (EPQ)]] + shipped FS2/FS3 substrate along the way | EPQ.1 shipped, EPQ.2 next |
| EPI session | [[F10 - Inbox (EPI)]] | awaiting Owner gate |
| EPO session | [[F12 - Orders (EPO)]] | awaiting Owner gate |
| EPF session | [[F18 - Financials (EPF)]] | awaiting Owner gate |

Unclaimed pages (⚪ in [[F06 - Enterprise Program (EP)]]) are open for the next session — which must read `PLAYBOOK.md` then `ENTERPRISE-PROGRAM.md` **first**, claim, then follow the research standard.

## Cross-session handshakes currently in flight

- **EPO D-1 five-way split** (needs Owner sign-off): search-route fix + production reader = EPO · `/financials?o=` reader = EPF · ConvertBar backlink = EPQ · inbox order card = EPI phase 6.
- **FS3 adoption handoffs** (components shipped, call-sites owned by page sessions): EPI list/thread windowing + panes · EPO orders grid · EPQ matrix pickers · EPF financials grids ×3.
- **EPF D-8/D-9** (if approved): price-list effective-dating needs an EPD-territory registry grant; Order fields (clientRef/URGENT/remakeOf) need an EPO grant.
- **FC seams:** EPO.6 scaffolds the order-space tab host; EPI.6 defines the email-event card contract; EPF money system-messages must use structured `*Cents` fields only.

## Rules every session inherits (Owner's standing directives)

Approval before any code (research/docs are free) · additive migrations pre-approved, destructive asks · commit+push after each verified unit · no time estimates · honest gate reports · verify on `:3199`, never the Owner's `:3100` · no fake data presented as real · never print secrets.
