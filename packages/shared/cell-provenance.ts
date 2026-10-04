/** One cell vocabulary for backend content contracts and the Nexus design-system renderer. */
export type CellProvenance =
  | 'own' | 'inherited' | 'inheritedOverride' | 'pinned' | 'ai' | 'aiStale' | 'mapped' | 'mappedShared'
  | 'outdated' | 'formula' | 'refused'
  /* 2026-10-04 (channel cell marks) — channel-sheet members. `pending`: saved in Nexus, reaches the channel only on
     Publish. `attention`: the channel or the mapping disagrees with what Nexus would send (saved but not sent, a
     reported FBA listing, a mapping error). `listingValue`: the listing still holds its own older text, not the Shared
     product's. `listingLevel`: one value for the whole listing (eBay item specific on a variation row). */
  | 'pending' | 'attention' | 'listingValue' | 'listingLevel'
