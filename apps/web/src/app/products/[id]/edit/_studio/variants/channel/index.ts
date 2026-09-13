export { ChannelProjection } from './ChannelProjection'

/** The wire contract this surface consumes — VP.2 codes the server half against it (§5.4). */
export type {
  ProjectionPage,
  ProjectionChild,
  ProjectionParent,
  ProjectionCoordinate,
  ProjectionMapping,
  ProjectionTargetOption,
  ProjectionSplit,
  ProjectionLock,
  ProjectionListingState,
  ProjectionValue,
  ProjectionWriteRouting,
  ProjectionVocabulary,
  ProjectionDraft,
  ProjectionSaveResult,
  ProjectionSource,
} from './types'

/** The parse boundary and the live client, so a test can exercise the wire without the surface. */
export { parseProjection, projectionUrl, liveSource, ProjectionBackendMissing } from './source'

/** Pure rules — row order, chip counts, search — exported so they are unit-testable. */
export { projectionRows, projectionCounts, chipRowIds, matchesSearch, axisRank, type ProjectionRow, type ProjectionCounts } from './rows'

/** §9's copy, one source (§9: "verbatim; one source for every lane"). */
export * from './copy'

/** §2's measured dock width, so a gate can assert it without reading the component. */
export { MAPPING_DOCK_W } from './MappingDock'

/**
 * VT.4 — the dry-run theme-change plan modal, and the one client call that fetches it.
 *
 * VT.2's `AxesPanelEditor` imports these for its locked-commit path (design §3.5: a SET change on a live
 * coordinate opens the plan and writes nothing). ONE import, agreed in `docs/pes-claims.md`.
 */
export {
  ThemeChangePlanModal,
  fetchThemeChangePlan,
  planAsText,
  ThemeChangePlanError,
  type ThemeChangePlan,
  type ThemeChangeStep,
  type ThemeChangeRequest,
  type ThemeChangePlanModalProps,
} from './ThemeChangePlanModal'

/** VT.4 — the coordinate's collision report, as the dock's Collisions section reads it. */
export type { ProjectionCollisions } from './types'
