/**
 * Border-radius tokens — H10 scale, named by role (the raw px appear at several
 * values; these are the canonical steps the migration collapses onto).
 */

export const radius = {
  xs: '3px', //     heat cells, swatches, tight marks — the step below `pill`; PES.3's two surfaces
  //                rendered 1px rounder than designed until this existed (hub #633)
  // A true capsule (hub #687/P9, was 4px). `pill` now means what it says: status pills, badges
  // and tags are short, single-line boxes, so 999px renders as a stadium and any consumer that
  // wanted a subtly rounded RECTANGLE must name `sm` instead — the one that did
  // (`_studio/drawer/drawer.module.css`, a focus ring on an inline link) was changed with this.
  pill: '999px', // status pills, small badges, tags
  sm: '6px', //     dense controls, menu options
  md: '7px', //     option rows, chips
  lg: '8px', //     inputs, buttons, dropdowns
  xl: '10px', //    nav items, filter cards, larger buttons
  '2xl': '12px', // cards, grids, panels
  '3xl': '14px', // modals
  // A full capsule — toggles, progress bars, icon buttons. Since #687/P9 this is the SAME value
  // as `pill`; the two names survive because they say different things about the element
  // (`pill` a labelled status box, `full` a capsule by geometry), and a future change to one
  // should not silently move the other. The DS was writing 999px as a literal 9 times and the
  // ads console 75 more; neither could say it meant the same shape.
  full: '999px',
  round: '999px', // dots, toggles, progress tracks
} as const
