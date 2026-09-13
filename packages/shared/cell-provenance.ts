/** One cell vocabulary for backend content contracts and the Nexus design-system renderer. */
export type CellProvenance =
  | 'own' | 'inherited' | 'inheritedOverride' | 'pinned' | 'ai' | 'aiStale' | 'mapped' | 'mappedShared'
  | 'outdated' | 'formula' | 'refused'
