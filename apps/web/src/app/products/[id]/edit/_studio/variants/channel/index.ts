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
