/**
 * The phone bottom bar and its More sheet — an entry point of its own, NOT re-exported by the components barrel: the web
 * pulls that barrel into every page, so a part in it reaches every page's first load. Import this folder
 * (`@/design-system/components/BottomBar` in the web, `@nexus/ui/components/BottomBar/index` by package path). Its
 * stylesheet (`bottom-bar.css`) comes with the component.
 */
export {
  BottomBar,
  MoreSheet,
  MoreSheetList,
  BOTTOM_BAR_LABELS,
  type BottomBarProps,
  type MoreSheetProps,
  type BottomBarLabels,
  type BottomBarLinkProps,
  type BottomBarLinkComponent,
} from './BottomBar'
export { bottomBarLayout, badgeText, BOTTOM_BAR_MAX_SLOTS, BOTTOM_BAR_TABS, type BottomBarEntry, type BottomBarLayout, type BottomBarOptions } from './bottomBarModel'
