/**
 * The board (kanban) view of a list (gap D19) — an entry point of its own, NOT re-exported by the grid barrel: the web
 * pulls that barrel into its list pages, so a part in it would reach pages that never draw a board (and bring
 * `@dnd-kit/core` and this folder's stylesheet with it). Import this folder (`@/design-system/grid/views/board` in the
 * web, `@nexus/ui/grid/views/board/index` by package path). Its stylesheet (`board-view.css`) comes with the component.
 * It is not an AG Grid view: it draws the list's rows as cards itself, so it needs no AG Grid module.
 */
export { BoardView, type BoardViewProps } from './BoardView'
export {
  BOARD_VIEW_WORDS,
  boardTabStop,
  cardName,
  cardsByLane,
  countWords,
  fillWords,
  isBoardArrow,
  laneCount,
  laneStep,
  moveHeldReason,
  moveMenu,
  nextCardFocus,
  pickHeldReason,
  targetWords,
  type BoardArrow,
  type BoardCard,
  type BoardCardField,
  type BoardLane,
  type BoardMark,
  type BoardMove,
  type BoardTone,
  type BoardVia,
  type BoardViewWords,
  type MoveCheck,
} from './boardViewModel'
