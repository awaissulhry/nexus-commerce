/**
 * GarmentZoneMap (B-W2b-207) — an entry point of its own, NOT re-exported by the components barrel (the web pulls that
 * barrel into every page's first load; this part brings its own stylesheet). Import this folder
 * (`@/design-system/components/GarmentZoneMap` in the web, `@nexus/ui/components/GarmentZoneMap/index` by package path).
 */
export { GarmentZoneMap, type GarmentZoneMapProps } from './GarmentZoneMap'
export { GARMENT_ZONE_MAP_LABELS, type GarmentZoneMapLabels } from './GarmentZoneMapLabels'
export {
  centreOf,
  figureOf,
  offSketch,
  primaryShapes,
  RIDER_GARMENT_FIGURES,
  RIDER_GARMENT_SHAPES,
  stepZone,
  zoneLabel,
  zoneMarkViews,
  type GarmentFigure,
  type GarmentZoneMark,
  type GarmentZoneMarkView,
  type GarmentZoneOption,
  type GarmentZoneShape,
} from './garmentZoneMapModel'
