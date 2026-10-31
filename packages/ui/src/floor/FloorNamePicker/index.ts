/**
 * FloorNamePicker (B-W2b-28) — an entry point of its own, NOT re-exported by the floor barrel (`floor/`): no Commerce
 * page and no existing floor screen carries it until it imports this folder (`@/design-system/floor/FloorNamePicker` in
 * the web, `@nexus/ui/floor/FloorNamePicker/index` by package path). Its stylesheet comes with the component.
 */
export { FloorNamePicker, type FloorNamePickerProps } from './FloorNamePicker'
export { FLOOR_NAME_PICKER_LABELS, type FloorNamePickerLabels } from './FloorNamePickerLabels'
export {
  LATIN_LETTERS,
  gridMove,
  isGridKey,
  letterStrip,
  nameGroups,
  nameLetter,
  type FloorPerson,
  type GridKey,
  type NameGroups,
  type TileRect,
} from './floorNamePickerModel'
