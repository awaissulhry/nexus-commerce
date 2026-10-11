/**
 * Keyword Harvest page — the Sources view (lane HRULES). The page (lane TERMS) mounts
 * `<HarvestSourcesView market show? onTotals? viewSwitch? />` and draws the tiles it reports (`onTotals(t).tiles`: each
 * tile's id is the `?show=` value that filters the rows it counts).
 */
export { HarvestSourcesView } from './HarvestSourcesView'
export { SOURCES_TILE_LABEL } from './sourcesModel'
