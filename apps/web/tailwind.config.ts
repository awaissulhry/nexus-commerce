/**
 * U.1 — App-wide design tokens.
 *
 * The whole catalog management workflow (/products, /products/drafts,
 * /products/list-wizard, /catalog/organize, /bulk-operations) renders
 * data-dense operator UIs where Tailwind's default scale (12-72px)
 * doesn't fit. This config overrides the defaults with a 10-32px
 * scale tuned for the codebase's actual usage patterns.
 *
 * See DEVELOPMENT.md "Design tokens" for usage guide. JS-side
 * constants (CHANNEL_TONE class triples, STATUS_PALETTE, Z_INDEX,
 * DURATION_MS) live in apps/web/src/lib/theme/index.ts.
 */

import type { Config } from 'tailwindcss'
import colors from 'tailwindcss/colors'

/**
 * A design-system token as a Tailwind colour, with opacity modifiers kept (`text-primary/60`,
 * `placeholder:text-tertiary`, `bg-opacity-50`): Tailwind substitutes `<alpha-value>` wherever it
 * appears in the string, so `color-mix` carries it.
 *
 * Why not `rgb(var(--text-primary) / <alpha-value>)`: that needs `--text-primary` as RGB numbers,
 * and the design system's `tokens.css` (imported by ~195 files, the top bar among them) redefines
 * the same eleven names at `:root` as whole colours. On almost every route the whole colour won, so
 * Tailwind built `rgb(#1c2530 / 1)` — invalid. The text colour was inherited (black on the dark
 * page, 1.04:1), backgrounds went transparent and borders took the text colour. The `--nds-*` tokens
 * have one form, are defined on every route (`tokens-global.css`), flip under `.dark`, and the
 * light-pinned surfaces (the ads console, the fleet) pin them.
 *
 * 🔴 Only `--nds-*` tokens go through here, never `--text-*`, `--surface-*` or `--border-*`
 * (`tailwind-token-form.vitest.test.ts` and `scripts/check-alias-form.mjs` hold this).
 */
const ds = (token: `--nds-${string}`) => `color-mix(in srgb, var(${token}) calc(<alpha-value> * 100%), transparent)`

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  // U.14 prep — class-based dark mode. Adding `dark:` utilities
  // already, the toggle wires up later.
  darkMode: 'class',
  theme: {
    extend: {
      // ── Font family (P0) ──────────────────────────────────────────
      // Inter (variable) wired via next/font in app/layout.tsx, exposed
      // as --font-sans. Bare `font-sans` + the body default now render
      // Inter with a hardened system fallback chain. Replaces the old
      // implicit system stack — the root cause of the "thin" rendering.
      fontFamily: {
        sans: [
          'var(--font-sans)',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        // P0-FC — Space Grotesk display for headings/hero numerals.
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // JetBrains Mono for tabular data/metrics (upgrades existing
        // font-mono call sites too — a strict rendering improvement).
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },

      // ── Font weight (P0) ──────────────────────────────────────────
      // Semantic weights for deliberate hierarchy. `font-body` is a
      // touch heavier than 400 so Inter body text reads solid (not
      // thin) at the dense sizes; label/heading step up from there.
      // Tailwind's numeric weights (font-normal/medium/semibold/bold)
      // are preserved — these are additive.
      fontWeight: {
        body:    '450',
        label:   '550',
        heading: '650',
      },

      // ── Typography ────────────────────────────────────────────────
      // HYBRID scale. The 10-18 "compact" hot zone stays for dense
      // tables/grids (operator work surfaces). `body`/`body-lg` are the
      // new COMFORTABLE sizes (≥14px) for dashboards, forms, and prose
      // where 12px read too thin. 24/32 reserved for hero surfaces.
      // Pair each with an explicit lineHeight so leading-tight is the
      // table-row default without per-cell overrides.
      fontSize: {
        xs:    ['10px', { lineHeight: '14px' }],
        sm:    ['11px', { lineHeight: '15px' }],
        base:  ['12px', { lineHeight: '16px' }],
        md:    ['13px', { lineHeight: '18px' }],
        lg:    ['14px', { lineHeight: '20px' }],
        xl:    ['16px', { lineHeight: '22px' }],
        '2xl': ['18px', { lineHeight: '24px' }],
        '3xl': ['24px', { lineHeight: '30px' }],
        '4xl': ['32px', { lineHeight: '38px' }],
        // Comfortable (dashboards / prose) — P0 hybrid additions.
        'body':    ['14px', { lineHeight: '21px' }],
        'body-lg': ['16px', { lineHeight: '24px' }],
      },

      // ── Border radius ─────────────────────────────────────────────
      // Bare `rounded` (1095 uses today) maps to 4px — same as
      // Tailwind default — but giving it the explicit `md` name
      // unblocks deliberate `sm` (chips) vs `lg` (cards) vs `xl`
      // (modals) decisions. `rounded-full` preserved (Tailwind default
      // 9999px). Migration of `rounded-*` deferred to U.17 sweep.
      borderRadius: {
        sm:   '2px',
        md:   '4px',
        lg:   '6px',
        xl:   '8px',
        '2xl': '12px',
      },

      // ── Shadows ──────────────────────────────────────────────────
      // Semantic naming. Subtle for chips/inline elements; default
      // for cards; elevated for hovered/raised; modal for centered
      // dialogs; drawer for slide-in panels (asymmetric — heavier on
      // the leading edge). Migration of shadow-* deferred to U.17.
      boxShadow: {
        subtle:   '0 1px 2px 0 rgb(15 23 42 / 0.04)',
        default:  '0 1px 3px 0 rgb(15 23 42 / 0.06), 0 1px 2px -1px rgb(15 23 42 / 0.04)',
        elevated: '0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 4px -2px rgb(15 23 42 / 0.04)',
        modal:    '0 12px 32px -4px rgb(15 23 42 / 0.18), 0 4px 8px -4px rgb(15 23 42 / 0.08)',
        drawer:   '-8px 0 24px -8px rgb(15 23 42 / 0.12)',
        // P0-FC — accent glow (the futuristic tell). Uses --accent so it
        // tracks the chosen signature colour. For focus/active/primary
        // + luminous data. `glow-card` is a soft ambient lift for glass.
        'glow-sm':   '0 0 12px -2px rgb(var(--accent) / 0.40)',
        'glow':      '0 0 22px -2px rgb(var(--accent) / 0.45)',
        'glow-lg':   '0 0 44px -4px rgb(var(--accent) / 0.50)',
        'glow-card': '0 8px 32px -8px rgb(2 6 23 / 0.60), 0 0 0 1px rgb(255 255 255 / 0.04)',
      },

      // ── Animation ────────────────────────────────────────────────
      // Intent-driven naming vs Tailwind's numeric (duration-150).
      // fast = hover/press; base = cell/menu transitions; slow =
      // drawer/modal slide-ins.
      transitionDuration: {
        fast: '150ms',
        base: '200ms',
        slow: '300ms',
      },
      transitionTimingFunction: {
        // App-wide default. Smoother than ease-out at 200ms.
        // Use as `transition-all duration-base ease-out`.
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },

      // ── Animation (U.16) ──────────────────────────────────────────
      // Named keyframes + animations for entrance polish on overlays.
      // Modal/Drawer/Toast use these; consumer UI keeps using the
      // standard `transition-colors` / `transition-all` for hover/
      // interactive states.
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-from-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-from-right': 'slide-from-right 240ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1)',
      },

      // ── Z-index ──────────────────────────────────────────────────
      // Semantic, not magic numbers. Migration mapping (U.17 sweep):
      //   z-10  → z-dropdown
      //   z-20  → z-sticky
      //   z-30  → z-drawer
      //   z-40  → z-modal
      //   z-50  → z-toast    (current 43 uses)
      //   z-[60], z-[100] → z-popover
      zIndex: {
        dropdown: '10',
        sticky:   '20',
        drawer:   '30',
        modal:    '40',
        toast:    '50',
        popover:  '60',
      },

      // ── Colors ───────────────────────────────────────────────────
      // Semantic palette aliases. Each maps to a Tailwind family
      // chosen by the codebase's actual usage:
      //   success → emerald (433 uses, conventional)
      //   warning → amber   (518 uses, conventional)
      //   danger  → rose    (554 uses; preferred over red for tone)
      //   info    → blue    (1434 uses, primary action color)
      //   neutral → slate   (5213 uses, dominant)
      //
      // Color migration (slate→neutral, blue→info, etc.) deferred to
      // U.17 sweep where component adoption gates them anyway.
      // Tokens land now so U.2 primitives + U.14 dark mode can use
      // them out of the box.
      colors: {
        // Each semantic family spreads its Tailwind scale (50-950
        // preserved) + adds var-backed soft/line/strong that FLIP in
        // dark mode. `*-soft` is a SOLID surface (no opacity) — the
        // replacement for the washed-out `bg-*-950/40` tints. Use:
        //   bg-danger-soft  text-danger-strong  border-danger-line
        success: { ...colors.emerald, soft: 'rgb(var(--success-soft) / <alpha-value>)', line: 'rgb(var(--success-line) / <alpha-value>)', strong: 'rgb(var(--success-strong) / <alpha-value>)' },
        warning: { ...colors.amber,   soft: 'rgb(var(--warning-soft) / <alpha-value>)', line: 'rgb(var(--warning-line) / <alpha-value>)', strong: 'rgb(var(--warning-strong) / <alpha-value>)' },
        danger:  { ...colors.rose,    soft: 'rgb(var(--danger-soft) / <alpha-value>)',  line: 'rgb(var(--danger-line) / <alpha-value>)',  strong: 'rgb(var(--danger-strong) / <alpha-value>)' },
        info:    { ...colors.blue,    soft: 'rgb(var(--info-soft) / <alpha-value>)',    line: 'rgb(var(--info-line) / <alpha-value>)',    strong: 'rgb(var(--info-strong) / <alpha-value>)' },
        neutral: colors.slate,
        // P0-FC — Quantum signature accent (indigo→cyan), var-backed so
        // the gradient/glow can be re-themed in one place. `accent` =
        // primary solid; from/to = the gradient stops; bright = cyan end
        // for highlights. Enables text-accent, bg-accent, ring-accent,
        // from-accent-from, to-accent-to, border-accent.
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          from:    'rgb(var(--accent-from) / <alpha-value>)',
          to:      'rgb(var(--accent-to) / <alpha-value>)',
          bright:  'rgb(var(--accent-bright) / <alpha-value>)',
        },
        // Surface tokens — var-backed so dark mode (class) flips them.
        // background/card/border/border-strong read the design-system
        // tokens (see `ds` above); elevated keeps the globals.css channel.
        surface: {
          background:      ds('--nds-surface'),
          card:            ds('--nds-surface'),
          elevated:        'rgb(var(--surface-raised) / <alpha-value>)',
          overlay:         'rgb(15 23 42 / 0.4)',
          border:          ds('--nds-border-subtle'),
          'border-strong': ds('--nds-border'),
        },
      },

      // ── Semantic TEXT tokens (P0) ─────────────────────────────────
      // The fix for 6,485 raw `text-slate-400` (4.2:1, fails AA). Use
      // text-secondary, not -400. Contrast of the --nds-* text tokens
      // on --nds-bg/--nds-surface, light and dark, is held by
      // `scripts/check-nds-contrast.mjs` (light, on white: primary
      // 15.5:1, secondary 9.9:1, tertiary 8.2:1, link 8.0:1).
      textColor: {
        primary:   ds('--nds-text'),
        secondary: ds('--nds-text-2'),
        tertiary:  ds('--nds-text-3'),
        disabled:  ds('--nds-text-disabled'), // decorative / disabled only
        inverse:   'rgb(var(--text-inverse) / <alpha-value>)',
        link:      ds('--nds-text-link'),
        // Placeholder-style hints that are not a real <input> placeholder — the legacy flat-file
        // grid's empty-cell "e.g. …" and "Click to search …" prompts. The DS field placeholder token,
        // 5.9:1 light and dark (check-nds-contrast). Not for disabled text: that is `text-disabled`.
        placeholder: ds('--nds-placeholder'),
      },

      // ── Semantic SURFACE tokens (P0) ──────────────────────────────
      // Solid elevation hierarchy (no translucency). canvas = page,
      // card = panel, raised = elevated/hover, sunken = inset well.
      // Named to avoid colliding with the `surface` color object above.
      backgroundColor: {
        canvas:  ds('--nds-bg'),
        card:    ds('--nds-surface'),
        raised:  'rgb(var(--surface-raised) / <alpha-value>)',
        sunken:  ds('--nds-surface-sunken'),
        overlay: 'rgb(var(--surface-overlay) / <alpha-value>)',
      },

      // ── Semantic BORDER tokens (P0) ───────────────────────────────
      // `default` anchors grids; `strong` for section dividers;
      // `subtle` for nested rules. Bare `border` (DEFAULT) is
      // untouched — these are additive.
      borderColor: {
        subtle:  ds('--nds-border-subtle'),
        default: ds('--nds-border'),
        strong:  ds('--nds-border-strong'),
      },
    },
  },
  plugins: [],
}

export default config
