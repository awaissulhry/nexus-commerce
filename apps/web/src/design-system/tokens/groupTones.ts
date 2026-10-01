/**
 * Column-group colours (tier 3, `--nds-grid-tone-<tone>-*`) — the product sheet's attribute groups.
 *
 * The Owner, 2026-10-01: group the sheet's attributes like the old flat file, "and maybe the same colors as well",
 * with "the header [going] with a slight tint". These are the old flat file's group-band colours EXACTLY — Tailwind v3
 * values, measured on the old eBay flat file (`apps/web/src/components/flat-file/FlatFileGrid.tsx` `GROUP_COLORS`):
 *   light — background colour-100, text colour-800 (slate: 700);
 *   dark  — background colour-900 at 50 % (slate: 800 at 60 %), text colour-200 (slate: 300).
 * `rule` is the left edge that marks where a group starts on the header: colour-300 / colour-700.
 *
 * Literal colours, not aliases: a group tone is the same hue in every theme, so the dark block restates each one with
 * its dark value and nothing here can be stranded on `:root` (`scripts/check-dark-alias-scope.mjs`).
 * The tone NAMES are `SHEET_TONES` in `@nexus/shared/sheet-groups`; `groupTones.vitest.test.ts` holds the two equal.
 * Web only (not in apps/factory's design-system copy): only the product sheet and its Customise dialog use them.
 */
import type { CssVar } from './css-vars'

interface Tone { bg: string; fg: string; rule: string; darkBg: string; darkFg: string; darkRule: string }

/** colour-100 / colour-800 / colour-300, and colour-900 at 50 % / colour-200 / colour-700 (Tailwind v3). */
const tone = (c100: string, c800: string, c300: string, c900: string, c200: string, c700: string): Tone => ({
  bg: c100, fg: c800, rule: c300, darkBg: `color-mix(in srgb, ${c900} 50%, transparent)`, darkFg: c200, darkRule: c700,
})

export const GROUP_TONES = {
  // The old page's one exception: slate's band text is 700, and its dark band is 800 at 60 %.
  slate: { bg: '#f1f5f9', fg: '#334155', rule: '#cbd5e1', darkBg: 'color-mix(in srgb, #1e293b 60%, transparent)', darkFg: '#cbd5e1', darkRule: '#334155' },
  blue: tone('#dbeafe', '#1e40af', '#93c5fd', '#1e3a8a', '#bfdbfe', '#1d4ed8'),
  purple: tone('#f3e8ff', '#6b21a8', '#d8b4fe', '#581c87', '#e9d5ff', '#7e22ce'),
  emerald: tone('#d1fae5', '#065f46', '#6ee7b7', '#064e3b', '#a7f3d0', '#047857'),
  orange: tone('#ffedd5', '#9a3412', '#fdba74', '#7c2d12', '#fed7aa', '#c2410c'),
  cyan: tone('#cffafe', '#155e75', '#67e8f9', '#164e63', '#a5f3fc', '#0e7490'),
  teal: tone('#ccfbf1', '#115e59', '#5eead4', '#134e4a', '#99f6e4', '#0f766e'),
  sky: tone('#e0f2fe', '#075985', '#7dd3fc', '#0c4a6e', '#bae6fd', '#0369a1'),
  amber: tone('#fef3c7', '#92400e', '#fcd34d', '#78350f', '#fde68a', '#b45309'),
  yellow: tone('#fef9c3', '#854d0e', '#fde047', '#713f12', '#fef08a', '#a16207'),
  red: tone('#fee2e2', '#991b1b', '#fca5a5', '#7f1d1d', '#fecaca', '#b91c1c'),
  violet: tone('#ede9fe', '#5b21b6', '#c4b5fd', '#4c1d95', '#ddd6fe', '#6d28d9'),
} as const satisfies Record<string, Tone>

export type GroupToneName = keyof typeof GROUP_TONES

/** The header text's slight indent under a group (the Owner: "use a slight indent"). */
export const GROUP_HEADER_INDENT_PX = 8

const entries = Object.entries(GROUP_TONES) as Array<[GroupToneName, Tone]>

export const groupToneVars: ReadonlyArray<CssVar> = [
  { section: 'Tier 3: column-group tones (tokens/groupTones.ts — the old flat file\'s group colours)', name: '--nds-grid-group-indent', value: `${GROUP_HEADER_INDENT_PX}px` },
  ...entries.flatMap(([name, t]) => [
    { name: `--nds-grid-tone-${name}-bg`, value: t.bg },
    { name: `--nds-grid-tone-${name}-fg`, value: t.fg },
    { name: `--nds-grid-tone-${name}-rule`, value: t.rule },
  ]),
]

export const groupToneVarsDark: ReadonlyArray<CssVar> = entries.flatMap(([name, t], i) => [
  { ...(i === 0 ? { section: 'Dark: column-group tones (tokens/groupTones.ts)' } : {}), name: `--nds-grid-tone-${name}-bg`, value: t.darkBg },
  { name: `--nds-grid-tone-${name}-fg`, value: t.darkFg },
  { name: `--nds-grid-tone-${name}-rule`, value: t.darkRule },
])
