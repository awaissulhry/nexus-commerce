/**
 * The floor's icon reason grid (gap D20) — an entry point of its own, NOT re-exported by the floor barrel (`floor/`):
 * the brief of B-W2a-24 keeps every new part out of the barrels the web imports, so no Commerce page and no existing
 * floor screen carries it until it imports this folder (`@/design-system/floor/ReasonGrid` in the web,
 * `@nexus/ui/floor/ReasonGrid/index` by package path). Its stylesheet (`reasonGrid.css`, with the floor kit's
 * `floor.css`) comes with the component.
 */
export { ReasonGrid, type ReasonGridCountProps, type ReasonGridPickProps, type ReasonGridProps } from './ReasonGrid'
export {
  REASON_GRID_WORDS,
  REASON_PAGE_SIZE,
  countPress,
  countTotal,
  fillWords,
  isReasonNavKey,
  pageCount,
  pageOf,
  pageOfReason,
  reasonCanPick,
  reasonKeyTarget,
  reasonPress,
  reasonTabStop,
  type CountChange,
  type ReasonGridWords,
  type ReasonMode,
  type ReasonNavKey,
  type ReasonTile,
  type ReasonTone,
} from './reasonGridModel'
