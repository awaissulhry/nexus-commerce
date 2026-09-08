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

Account names (2026-09-08): `accountDisplayName` / `channelDisplayName` are exported from `design-system/lib`. Verify the switcher and AccountsPanel with real names, legacy `sellerId` placeholders, numeric profile IDs, and missing marketplace names. No technical keys should appear as text, tooltips, dialog copy, or accessible labels. Names can be supplied with Rename; IDs remain internal routing keys.

Amazon Seller migration (2026-09-08): verify an ENV-managed Amazon row, its primary **Replace environment credentials** action, the application-role permission copy, and the preserved ENV fallback note. Exercise both website authorization and private-app self-authorization import. Repeat after conversion to confirm the row reads as connected and no longer offers ENV replacement. Check narrow and desktop layouts in light and dark themes.
