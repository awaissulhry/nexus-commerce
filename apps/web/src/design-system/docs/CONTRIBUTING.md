# Contributing

How to add to the design system without creating drift.

## Golden rules

1. **Never hardcode a value.** Color, size, radius, shadow, duration, z-index →
   a token. If the token doesn't exist, add it to `tokens/` first.
2. **Reuse before you build.** Check `primitives/` and `components/` (and the
   inventory in `studies/00-ads-inventory.md`) before writing anything new.
3. **One concept, one home.** Don't add a second button/modal/select. Extend the
   existing one or reconcile.
4. **Match the surrounding code.** Comment density, naming, and idiom should read
   like the file next to it.
5. **Keep it portable.** No hard dependency that breaks if the folder is copied
   out; relative imports inside the system.

## Adding a **token**

1. Add the value to the right tier in `tokens/` (primitive → semantic →
   component). Reuse an existing semantic name if the role already exists.
2. Wire it into `styles/tokens.css` (CSS var) and `tailwind.config.ts` if it
   needs a utility class.
3. Record the mapping in `docs/TOKEN-RECONCILIATION.md` if it comes from an H10
   hardcoded value.
4. Surface it in the catalog token section.

## Adding a **primitive / component / pattern**

1. Find its source in `/marketing/ads` via the inventory; note its current
   `.h10-*` classes and props.
2. Lift it into the right folder; replace hardcoded values with tokens.
3. **Generalize**: strip ads-specific assumptions (campaign fields, hardcoded
   labels) so it's reusable platform-wide.
4. Keep `/marketing/ads` working — have it import the new home (or a thin shim).
5. Add a catalog example covering every state (default/hover/focus/disabled/
   loading/empty/error as applicable).
6. Run the Definition of Done checklist in `GOVERNANCE.md`.

## Adding a **study**

Copy `studies/_TEMPLATE.md` to `studies/NN-<feature>.md`, fill it in, and add it
to the index in `studies/README.md`.

## Verifying

```bash
# from repo root
npx tsc -p apps/web --noEmit         # types
npm run build --workspace apps/web   # structural (or next build)
```

Then the visual gate: render in the catalog, screenshot-diff at native res vs
the H10 reference, measure alignment/borders/spacing numerically, and confirm
`/marketing/ads` is unchanged. Verify on the live deploy (Vercel/Railway), not a
local scratch DB.

## Committing

Commit + push after each verified unit of work. On a shared tree with concurrent
sessions, stage explicitly and use `git commit --only <paths>` to avoid index
collisions. Don't bundle unrelated changes.
