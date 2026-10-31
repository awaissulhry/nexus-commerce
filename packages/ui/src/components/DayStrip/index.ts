/**
 * DayStrip (B-W2b-28) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that barrel
 * into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/DayStrip` in the web, `@nexus/ui/components/DayStrip/index` by package path).
 */
export { DayStrip, type DayStripProps } from './DayStrip'
export { DAY_STRIP_LABELS, type DayStripLabels } from './DayStripLabels'
export {
  dayMs,
  dayPct,
  daySpan,
  dayStripLines,
  dayTicks,
  type DayAnomaly,
  type DayDay,
  type DayEvent,
  type DayEventKind,
  type DayMoment,
  type DayOverlay,
  type DayOverlaySpan,
  type DaySegment,
  type DaySegmentKind,
  type DayTone,
  type DayWindow,
  type DayWords,
} from './dayStripModel'
