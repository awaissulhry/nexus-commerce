/**
 * FloorElapsed (B-W2b-28) — an entry point of its own, NOT re-exported by the floor barrel (`floor/`): no Commerce page
 * and no existing floor screen carries it until it imports this folder (`@/design-system/floor/FloorElapsed` in the
 * web, `@nexus/ui/floor/FloorElapsed/index` by package path). Its stylesheet comes with the component.
 */
export { FloorElapsed, type FloorElapsedProps } from './FloorElapsed'
export { FLOOR_ELAPSED_LABELS, type FloorElapsedLabels } from './FloorElapsedLabels'
export {
  elapsedClock,
  elapsedHoursMinutes,
  elapsedIsoDuration,
  elapsedMinute,
  elapsedMoment,
  elapsedParts,
  elapsedReading,
  elapsedTone,
  elapsedWords,
  type ElapsedInput,
  type ElapsedPrecision,
  type ElapsedReading,
  type ElapsedThresholds,
  type ElapsedTone,
  type ElapsedWords,
} from './floorElapsedModel'
export { createElapsedTicker, elapsedTicker, type ElapsedClock, type ElapsedTicker } from './elapsedTicker'
