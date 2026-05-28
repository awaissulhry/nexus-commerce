// UC.1 — Shared cockpit-shell primitives barrel.
//
// The Lego the per-channel cockpits compose. Nothing here imports from a
// specific channel; channels import from here (UC.3 / UC.4). Created with
// ZERO changes to either cockpit — migration is a separate phase.

export * from './tokens'
export { useCockpitModeBase } from './useCockpitModeBase'
export type { CockpitMode, CockpitModeConfig } from './useCockpitModeBase'
export { useCockpitFlag, readCockpitFlag, setCockpitFlag } from './useCockpitFlag'
export { default as CockpitHeader } from './CockpitHeader'
export type { CockpitHeaderProps } from './CockpitHeader'
export { default as CockpitPreviewBand } from './CockpitPreviewBand'
export type { CockpitPreviewBandProps } from './CockpitPreviewBand'
export { default as CockpitCardGrid } from './CockpitCardGrid'
export type { CockpitCardGridProps } from './CockpitCardGrid'
export { default as CockpitClassicPassthrough } from './CockpitClassicPassthrough'
export type { CockpitClassicPassthroughProps } from './CockpitClassicPassthrough'

// AF.1 — slide-over drawer
export { default as CockpitDrawer } from './CockpitDrawer'
export type { CockpitDrawerProps } from './CockpitDrawer'

// T3.3 — cross-channel comparison matrix
export { default as CrossChannelMatrix } from './CrossChannelMatrix'
export type { CrossChannelMatrixProps } from './CrossChannelMatrix'

// UC.2 — contracts + shared cards
export * from './contracts'
// FL.2 — provenance badge
export { default as FieldSourceBadge } from './FieldSourceBadge'
export type { FieldSourceBadgeProps } from './FieldSourceBadge'
// FL.3 — per-field scope control
export { default as FieldScopePopover } from './FieldScopePopover'
export type {
  FieldScopePopoverProps,
  FieldScope,
  ScopeMember,
  FieldScopeResult,
} from './FieldScopePopover'
// FL.3b — link-group persistence client
export { useFieldLinks } from './useFieldLinks'
export type {
  FieldLinkGroupDto,
  FieldLinkMember,
  SetScopeOptions,
  PropagationEntryDto,
  PropagatePreview,
  PropagationSource,
} from './useFieldLinks'
// FL.4 — propagation diff modal
export { default as PropagationDiffModal } from './PropagationDiffModal'
export type { PropagationDiffModalProps } from './PropagationDiffModal'
// FL.6 — smart link suggestions
export { default as LinkSuggestionsBanner } from './LinkSuggestionsBanner'
export type { LinkSuggestionsBannerProps } from './LinkSuggestionsBanner'
export type { LinkSuggestion } from './useFieldLinks'
// UC.6 — Variant Cube data service
export { useVariantCube } from './useVariantCube'
export type { CubeVariant, VariantMarketCell } from './useVariantCube'
export { default as IdentifiersCard } from './cards/IdentifiersCard'
export type { IdentifiersCardProps, IdentifierRow } from './cards/IdentifiersCard'
export { default as ImagesSummaryCard } from './cards/ImagesSummaryCard'
export type { ImagesSummaryCardProps } from './cards/ImagesSummaryCard'
