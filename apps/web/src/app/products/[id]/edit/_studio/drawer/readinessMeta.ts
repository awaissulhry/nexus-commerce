/**
 * PES.4 → PES.2 adapter. ONE import site, as designed — and now doing the job it was written for.
 *
 * This file used to carry a placeholder table, with a header saying it would become a one-line
 * re-export the day PES.2 shipped `readinessMeta`. That day is today (ruling #11 / #27), so this
 * is that line. Nothing in the drawer changed except which module answers the question — which is
 * exactly what keeping the dependency down to one file was for.
 *
 * The two vocabularies stay separate: the drawer only ever asks the ROW one
 * (`ready|missing|errors|live|unlisted`). It never touches the scope vocabulary and never converts
 * between them — `readiness.ts` deliberately exports no converter, because a lane that writes its
 * own `errors → blocked` rule has invented a rule nobody agreed to.
 */
export {
  readinessMeta,
  ROW_READINESS_STATES,
  type ReadinessMeta,
  type ReadinessTone,
  type RowReadinessState,
} from '@/design-system/grid/renderers/readiness'
