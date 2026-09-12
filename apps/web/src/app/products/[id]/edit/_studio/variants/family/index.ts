/**
 * VP.3 — what VP.1's tab switch mounts for `scope=master&tab=variants`.
 *
 * `FamilyVariants` takes NO props, like every other studio surface: it reads the product from the
 * route and the coordinate from `useStudioScope()`, so the switch stays one line and the frame owns
 * nothing inside the tab.
 *
 * The pure rules are exported too — VP.4 shares the projection vocabulary's channel list and the
 * coverage tuple logic, and a second copy of either is the drift the programme's §2.10 forbids.
 */
export { FamilyVariants } from './FamilyVariants'
export {
  axisCellValue,
  axisCode,
  axisSummary,
  cartesian,
  combinationCoverage,
  isAxisValueEmpty,
  orderByAxisValues,
  variantCoverage,
  type AxisColumnLike,
  type AxisSummary,
  type AxisValue,
  type CombinationCoverage,
  type VariantRowLike,
} from './coverage'
export {
  excludedSomewhere,
  parentIdentityNote,
  projectionIncluded,
  projectionState,
  EMPTY_PROJECTIONS,
  type FamilyProjections,
  type ProjectionChannel,
  type RowProjection,
} from './projections'
export { useFamilyProjections } from './useFamilyProjections'
export {
  axisHint,
  buildPlan,
  codeFor,
  codeLines,
  defaultCode,
  deriveSkuPattern,
  nearestSibling,
  renderSku,
  type AxisChoice,
  type GeneratePlan,
  type PlanFamily,
  type SkuPattern,
} from './generatePlan'
