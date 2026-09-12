/**
 * PES.4 — the full-record drawer.
 *
 * The host renders `<RecordDrawer>` as a SIBLING of the sheet in one flex row (see the dock slot
 * requested from PES.1 in docs/pes-claims.md) and drives it from `useRecordDrawer()`, which keeps
 * the open record in `?rec=` / `?cell=`.
 */
export { RecordDrawer, type RecordDrawerProps } from './RecordDrawer'
/** The host mounts THIS — it portals into PES.1's `<aside data-studio-dock>` and owns the width. */
export { StudioDock, STUDIO_PANEL_SELECTOR, type StudioDockProps } from './StudioDock'
export { useRecordDrawer, useDrawerWidth, MIN_WIDTH, MAX_WIDTH, type RecordDrawerState } from './useRecordDrawer'
export { useDrawerConfirm, type DrawerConfirmApi, type DrawerConfirmRequest } from './DrawerConfirm'
export { sanitize } from './fields/HtmlField'
/** §5.4 — the shared covered-cell rule. Hosts use this rather than re-deriving the threshold. */
export {
  isCellCovered,
  panelReadiness, type PanelReadiness,
  revealStash, type RevealRequest, type RevealStashEvent,
  revealDistance,
  revealScroll,
  isRevealAnchor,
  type RevealIntent,
  type RevealGeometryWithLeft,
  REVEAL_MARGIN,
  type RevealGeometry,
  type RevealScroll,
} from './revealCell'
/**
 * §5.4 — the shared HOST half: the one function that reads a real grid and moves it. Both sheets
 * import this; neither writes its own (#752).
 */
export { revealColumn, traceRevealSkip, type RevealGridApi, type RevealTrace, type RevealWhy } from './revealHost'
/**
 * #307 — the one read path. Exported so the sheet hooks can adopt it rather than grow a fourth
 * copy of the same state machine.
 */
export {
  useStudioRead,
  studioFetch,
  NotShipped,
  STUDIO_READ_DEADLINE_MS,
  type StudioRead,
  type StudioReadRun,
  type StudioReadStatus,
} from './useStudioRead'
export * from './types'
