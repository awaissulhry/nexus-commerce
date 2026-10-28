/**
 * Z-index tokens — the stacking layers H10 actually uses. Kept compatible with
 * the app's lib/theme/index.ts Z_INDEX where the roles line up; the full-screen
 * builder + portal tooltip sit above everything (rendered into <body>).
 */

export const zIndex = {
  base: 1,
  dropdown: 40, // dd / ms / combo popovers
  libpop: 45, // saved-filter library
  backdropBtn: 49, // invisible click-away layer behind a menu
  rail: 50, // left rail, header menus, date picker
  modalBackdrop: 60, // modal scrim + panel
  toast: 70, // toasts
  builder: 120, // full-screen rule/goal builders (fixed inset:0)
  tooltip: 1000, // portal InfoTip / HoverCard (above the rail)
} as const
