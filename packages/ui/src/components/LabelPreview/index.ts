/**
 * The label preview (gap G11) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load, and this part brings the floor kit's `FloorButton` and its stylesheet). Import
 * this folder (`@/design-system/components/LabelPreview` in the web, `@nexus/ui/components/LabelPreview/index` by
 * package path).
 */
export { LabelPreview, type LabelPreviewProps } from './LabelPreview'
export { Code128, type Code128Props } from './Code128'
export {
  CODE128_PATTERNS,
  CODE128_QUIET_MODULES,
  code128Bars,
  code128Check,
  code128ModuleString,
  encodeCode128,
  isCode128Text,
  type Code128Encoding,
} from './code128Model'
export {
  LABEL_PRINT_STATUSES,
  LABEL_PRINT_TONE,
  LABEL_TEXT_MM,
  labelBlocks,
  labelCanRetry,
  labelInvalidCodes,
  type LabelBlock,
  type LabelField,
  type LabelLayout,
  type LabelPrintState,
  type LabelPrintStatus,
  type LabelTextSize,
} from './labelLayout'
