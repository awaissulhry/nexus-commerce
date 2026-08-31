/**
 * TB — app chrome tokens (tier 3, `--nds-chrome-*`).
 *
 * The top bar and the nav rail are ONE surface: a deliberately dark frame around a light
 * workspace. This file is that surface's single palette.
 *
 * ── Why these are LITERALS, and why that is the point ─────────────────────────────────────────
 *
 * Chrome is **theme-independent**. It is dark in light mode and dark in dark mode, the way the
 * frame of an application is not part of the document it displays. Every value below is therefore
 * a literal, not a `var()` alias — which removes three whole classes of bug that the first cut of
 * the top bar hit in a single afternoon:
 *
 *   1. **The alias scope trap.** `--nds-topbar-bg: var(--nds-rail-bg)` declared on `:root`
 *      resolves the ROOT rail colour there and inherits that literal downward, so redefining
 *      `--nds-rail-bg` on an ancestor of the bar never reached it. Measured: a #f1f3f5 bar
 *      against a #f1f4f8 rail. A literal has no scope to resolve in, so it cannot drift.
 *   2. **The per-shell pin.** `.app-rail-host`, `.h10-shell` and `body:has(.h10-shell)` each
 *      re-declared the rail palette to a DIFFERENT light value, so "the rail colour" was never
 *      one colour — the bar could only match it on some routes. Chrome ends that: one palette,
 *      every shell.
 *   3. **The `.dark` re-declaration.** An alias must be restated inside `.dark` or it silently
 *      keeps its light value (`scripts/check-dark-alias-scope.mjs` enforces this). Literals are
 *      exempt by construction, so there is no dark block to forget.
 *
 * ── Where the values come from ───────────────────────────────────────────────────────────────
 *
 * These are NOT new colours. They are the dark rail palette that already existed in the `.dark`
 * block of `tokens/css-vars.ts`, promoted from theme-conditional to always-on. Adopting dark
 * chrome therefore introduces zero new hues — it makes an existing, already-designed palette
 * unconditional.
 *
 * Contrast measured on the rendered bar (2026-08-31), against `field-bg` / `bg` as appropriate:
 * input text 11.81:1 · placeholder 5.51:1 · lead icon 5.51:1 · icon buttons 7.38:1. The light
 * chrome this replaced put its own placeholder — the bar's most prominent label — at 2.04:1.
 */

export interface ChromeCssVar {
  section?: string
  name: string
  value: string
}

export const chromeVars: ReadonlyArray<ChromeCssVar> = [
  {
    section:
      'Tier 3: app chrome (tokens/chrome.ts — top bar + rail, ONE dark surface, theme-independent by design; literals so there is no .dark block and no alias scope to resolve)',
    name: '--nds-chrome-bg',
    value: '#18263b',
  },
  { name: '--nds-chrome-border', value: '#26323f' },

  // Type + icons
  { name: '--nds-chrome-fg', value: '#aab6c2' },
  { name: '--nds-chrome-fg-2', value: '#97a3b1' },
  { name: '--nds-chrome-fg-strong', value: '#e7ebf1' },
  { name: '--nds-chrome-icon', value: '#8a94a6' },
  { name: '--nds-chrome-chev', value: '#6f7b8b' },
  { name: '--nds-chrome-ft', value: '#6f7b8b' },

  // Item states (rail rows, icon buttons)
  { name: '--nds-chrome-item-hover', value: '#223247' },
  { name: '--nds-chrome-item-hover-2', value: '#1d2a3c' },

  // Chips (the rail's channel/count chips)
  { name: '--nds-chrome-chip-bg', value: '#243345' },
  { name: '--nds-chrome-chip-active-bg', value: '#1d3a5f' },
  { name: '--nds-chrome-chip-active-fg', value: '#cfe1fb' },

  /*
   * Controls sitting ON the chrome — the search field, the account trigger, the bell button.
   *
   * These exist because the DS's own field/button surfaces are light: dropped onto dark chrome
   * unchanged, `AccountSwitcher` rendered a white pill and `NotificationsBell` a white circle,
   * both reading as bright blobs rather than controls. A DS component placed on chrome reads
   * these instead of its default surface.
   */
  { name: '--nds-chrome-control-bg', value: '#1f2c3d' },
  { name: '--nds-chrome-control-border', value: '#2f3a4a' },
  { name: '--nds-chrome-control-fg', value: '#e7ebf1' },
  /* 5.51:1 on --nds-chrome-control-bg. In the bar this text is the control's LABEL, not a hint,
     so it is held to body-text contrast rather than the DS's --nds-text-disabled (2.04:1). */
  { name: '--nds-chrome-control-placeholder', value: '#97a3b1' },
  { name: '--nds-chrome-control-hover', value: '#26364a' },

  /* The rail's hover-expand shadow. On a dark ground the light-shell value (a soft slate) is
     invisible; this is the only geometry-bearing chrome value, and it lives here so the shell
     stylesheet holds no literals at all. */
  { name: '--nds-chrome-shadow-rail', value: '8px 0 30px rgba(0, 0, 0, 0.35)' },

  // Keycap on chrome (the ⌘K hint)
  { name: '--nds-chrome-kbd-bg', value: '#2f3a4a' },
  { name: '--nds-chrome-kbd-border', value: '#46505f' },
  { name: '--nds-chrome-kbd-fg', value: '#aab6c2' },
]

/** Every emitted name — used by the TB conformance probe. */
export const CHROME_TOKEN_NAMES: ReadonlyArray<string> = chromeVars.map((v) => v.name)
