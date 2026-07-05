# styles/

Global CSS for the system.

- `tokens.css` — the CSS-variable layer derived from `../tokens/` (`:root` +
  `.dark`). Imported once near the app root.
- The H10 stylesheet (`ads.css`, ~1.8k lines) **migrates here** in Phase 1,
  rewritten to reference `var(--token)` instead of hardcoded hex — with a
  screenshot-diff proving `/marketing/ads` is unchanged.

Keep the `.h10-*` prefix until the Phase 9 rename (see `../docs/NAMING.md`).

> Empty until **Phase 1**.
