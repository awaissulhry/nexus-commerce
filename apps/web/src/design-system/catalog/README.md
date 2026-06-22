# catalog/

The living style guide — one screen that renders every token (and, as Phases 3–5
land, every component) at native resolution. It is both the **documentation**
surface and the **verification harness** target.

- `TokenCatalog.tsx` — the catalog component, driven by `@/design-system/tokens`
  so it can never drift from the source of truth. Light + a dark toggle (which
  exercises the `.dark` CSS layer). Mounted at the route `/design-system`
  (`apps/web/src/app/design-system/page.tsx`).
- `verify.mjs` — the screenshot harness. Captures the catalog @2x (light + dark,
  full page) to `.analysis/dsshot/` for self-review and as the baseline that the
  component + `ads.css`-migration phases screenshot-diff against. Reuses the H10
  Playwright pattern. Run from repo root with the dev server up (see the file
  header). Ignored by the Next build + tsc.

This is the screen used to judge the whole system at once, and the surface where
"screenshot-diff before showing" is enforced for every later visual phase.
