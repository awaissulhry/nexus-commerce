/**
 * The planning board and the load bar (gap D18) — an entry point of its own, NOT re-exported by the patterns barrel: the
 * web pulls that barrel into its pages, so a part in it would reach pages that never draw a board (and bring
 * `@dnd-kit/core` and this folder's stylesheet with it). Import this folder (`@/design-system/patterns/planning-board` in
 * the web, `@nexus/ui/patterns/planning-board/index` by package path). Its stylesheet (`planning-board.css`) comes with
 * the components.
 */
export { PlanningBoard, type PlanningBoardProps } from './PlanningBoard'
export { LoadBar, type LoadBarProps } from './LoadBar'
export {
  LOAD_BAR_WORDS,
  fillWords,
  loadAfterSentence,
  loadFigures,
  loadView,
  minutesFormatter,
  type LoadBarWords,
  type LoadFigures,
  type LoadInput,
  type LoadState,
  type LoadView,
} from './loadBarModel'
export {
  EMPTY_HISTORY,
  PLANNING_BOARD_WORDS,
  TRAY_PLACE,
  bookedByCell,
  cardName,
  cellKey,
  dropHeldReason,
  historyStep,
  isOver,
  landingLoads,
  laneCapacity,
  minutesByBucket,
  moveStart,
  moveStep,
  nextFocus,
  packTracks,
  placeOf,
  placeWords,
  recordMove,
  samePlace,
  withMove,
  type PlanningBoardWords,
  type PlanningBucket,
  type PlanningCard,
  type PlanningCellLoad,
  type PlanningHistory,
  type PlanningLane,
  type PlanningLayout,
  type PlanningMark,
  type PlanningMove,
  type PlanningPlace,
  type PlanningTone,
  type PlanningVia,
} from './planningBoardModel'
