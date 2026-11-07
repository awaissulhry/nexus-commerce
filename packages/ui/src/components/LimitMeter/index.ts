/**
 * LimitMeter and ToleranceCell (B-W2b-78) — an entry point of its own, NOT re-exported by the components barrel (the web
 * pulls that barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/LimitMeter` in the web, `@nexus/ui/components/LimitMeter/index` by package path). It
 * imports no AG Grid module: `LimitMeterCellRenderer` reads the grid's params structurally.
 */
export {
  LimitMeter,
  LimitMeterCellRenderer,
  ToleranceCell,
  limitMeterView,
  type LimitMeterCellRendererParams,
  type LimitMeterProps,
  type LimitMeterView,
} from './LimitMeter'
export { LIMIT_METER_LABELS, type LimitMeterLabels } from './LimitMeterLabels'
export {
  LIMIT_TONE,
  isBelowDetection,
  isMaximum,
  limitVerdict,
  passesLimit,
  positionOn,
  scaleMax,
  toleranceBand,
  toleranceResult,
  toleranceScale,
  verdictPasses,
  type LimitInput,
  type LimitRule,
  type LimitTone,
  type LimitVerdict,
  type ToleranceInput,
  type ToleranceResult,
  type ToleranceVerdict,
} from './limitMeterModel'
