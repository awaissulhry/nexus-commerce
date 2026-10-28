/**
 * The app shell's parts: the main-sidebar rail and the area-navigation manifest type. Re-exported by the patterns
 * barrel. An app's root chrome may import this narrower barrel (`patterns/shell`) instead: it reaches only these files,
 * not every pattern (the grid, its CSS) the patterns barrel brings.
 *
 * The rail's stylesheet is `app-rail.css` in this folder; the app loads it (the rail component does not import it).
 */
export {
  AppRail,
  type AppRailProps,
  type RailLinkComponent,
  type RailLinkProps,
  type RailMarketItem,
  type RailNavItem,
  type RailSubItem,
} from './AppRail'
export { hrefMatchesPath, resolveActiveNav, type ActiveNavMatch, type ActiveNavNode } from './app-rail-active'
export {
  AREA_NAV_VIEWS,
  areaNavForPerson,
  areaRailItems,
  areaSubNavGroups,
  findAreaNavPlace,
  type AreaNav,
  type AreaNavAccess,
  type AreaNavArea,
  type AreaNavItem,
  type AreaNavPlace,
  type AreaNavSection,
  type AreaNavView,
  type AreaSubNavOptions,
} from './area-nav'
