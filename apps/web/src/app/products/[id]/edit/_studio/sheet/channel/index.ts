/**
 * PES.3 — channel scopes + alias groups. The lane's public surface.
 *
 * `docs/2026-09-01-product-edit-studio-layout.md` §1 "Channel scope (e.g. eBay · IT) — alias groups".
 * PES.1's frame mounts `ChannelSheet` when the scope bar selects a channel; everything else here is
 * internal to the lane.
 *
 * Provenance RENDERING, readiness tone/label and the cell WRITE PATH are PES.2's substrate
 * (`classifyProvenance` / `ProvenanceMark` / `readinessMeta` / `SheetWriter`) and are deliberately
 * NOT re-exported from here — hub ruling #11: one definition, zero copies. What this lane owns and
 * exports is the alias cascade's write ROUTING: which layer a value came from, and therefore where
 * pinning and resetting land.
 */
export { ChannelSheet, type ChannelSheetProps } from './ChannelSheet'
// The mount seam: PES.2's sheet tab renders this for a channel scope, master stays theirs.
export { ChannelScopeTab, type ChannelScopeTabProps } from './ChannelScopeTab'
export { useChannelSheet, commitChannelRow, addListingAlias, updateListingAlias, channelScopeUrl } from './useChannelSheet'
export {
  cascadeOf,
  cascadeIntent,
  describeCascade,
  foldSource,
  narrowLayer,
  hasValue,
  aliasMark,
  type CascadeIntent,
  type CascadeContext,
  type CascadeMeta,
} from './provenance'
export {
  withRowIdentity,
  dataPathFor,
  rowIdOf,
  orderRows,
  variantRowsOf,
  bandRowOf,
  distinctVariantCount,
  summariseAlias,
  aliasReadinessPct,
  type AliasSummary,
} from './rows'
export {
  aliasKeyOf,
  studioRowId,
  type AliasGroup,
  type AliasReadiness,
  type CascadeLayer,
  type ChannelReadiness,
  type ChannelReadinessIssue,
  type ChannelScope,
  type ChannelScopeChannel,
  type ChannelScopePage,
  type ChannelSheetRow,
  type ChannelValueSource,
  type ReadinessState,
  type SheetColumn,
  type StudioCellValue,
  type StudioFamily,
  type StudioLayer,
  type StudioRow,
  type StudioRowKind,
  type StudioWriteTarget,
} from './types'
