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
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
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
        // Surface tokens — now var-backed so dark mode (class) flips
        // them automatically. Light values are pixel-identical to the
        // old static hexes, so existing bg-surface-* / border-surface-*
        // usages are unchanged in light mode and dark-ready for free.
        surface: {
          background:      'rgb(var(--surface-card) / <alpha-value>)',
          card:            'rgb(var(--surface-card) / <alpha-value>)',
          elevated:        'rgb(var(--surface-raised) / <alpha-value>)',
          overlay:         'rgb(15 23 42 / 0.4)',
          border:          'rgb(var(--border-subtle) / <alpha-value>)',
          'border-strong': 'rgb(var(--border-default) / <alpha-value>)',
        },
      },

      // ── Semantic TEXT tokens (P0) ─────────────────────────────────
      // The fix for 6,485 raw `text-slate-400` (4.2:1, fails AA). Every
      // value passes WCAG AA on both surface-card and surface-canvas,
      // light AND dark (var-backed flip). Use text-secondary, not -400.
      textColor: {
        primary:   'rgb(var(--text-primary) / <alpha-value>)',   // ~17:1
        secondary: 'rgb(var(--text-secondary) / <alpha-value>)', // ~7.5:1
        tertiary:  'rgb(var(--text-tertiary) / <alpha-value>)',  // ~4.7:1 (AA body)
        disabled:  'rgb(var(--text-disabled) / <alpha-value>)',  // decorative / disabled only
        inverse:   'rgb(var(--text-inverse) / <alpha-value>)',
        link:      'rgb(var(--text-link) / <alpha-value>)',
      },

      // ── Semantic SURFACE tokens (P0) ──────────────────────────────
      // Solid elevation hierarchy (no translucency). canvas = page,
      // card = panel, raised = elevated/hover, sunken = inset well.
      // Named to avoid colliding with the `surface` color object above.
      backgroundColor: {
        canvas:  'rgb(var(--surface-canvas) / <alpha-value>)',
        card:    'rgb(var(--surface-card) / <alpha-value>)',
        raised:  'rgb(var(--surface-raised) / <alpha-value>)',
        sunken:  'rgb(var(--surface-sunken) / <alpha-value>)',
        overlay: 'rgb(var(--surface-overlay) / <alpha-value>)',
      },

      // ── Semantic BORDER tokens (P0) ───────────────────────────────
      // Fix for 6,547 invisible borders. `default` (slate-300, ~1.9:1)
      // anchors grids; `strong` (slate-400) for section dividers;
      // `subtle` (slate-200) for nested rules. Bare `border` (DEFAULT)
      // is untouched — these are additive.
      borderColor: {
        subtle:  'rgb(var(--border-subtle) / <alpha-value>)',
        default: 'rgb(var(--border-default) / <alpha-value>)',
        strong:  'rgb(var(--border-strong) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}

export default config
