/**
 * Border-radius tokens — H10 scale, named by role (the raw px appear at several
 * values; these are the canonical steps the migration collapses onto).
 */

export const radius = {
  pill: '4px', //   status pills, small badges
  sm: '6px', //     dense controls, menu options
  md: '7px', //     option rows, chips
  lg: '8px', //     inputs, buttons, dropdowns
  xl: '10px', //    nav items, filter cards, larger buttons
  '2xl': '12px', // cards, grids, panels
  '3xl': '14px', // modals
  round: '999px', // dots, toggles, progress tracks
} as const
