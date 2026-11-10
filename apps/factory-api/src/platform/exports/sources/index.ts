import type { AnyExportSource } from '../source'
import { purchaseOrders } from './purchase-orders'
import { salesOrders } from './sales-orders'
import { workOrders } from './work-orders'
// B-W2b-11: every W1 and W2a list (one file per list; a page's second frame is `<key>.2`).
import { materials } from './materials'
import { operations } from './operations'
import { sizes } from './sizes'
import { styles } from './styles'
import { quotes } from './quotes'
import { customers, suppliers } from './parties'
import { mrp } from './mrp'
import { capacityLoad } from './capacity'
import { invoicesShipped } from './invoices-shipped'
import { invoices } from './invoices'
import { payments } from './payments'
import { inspections } from './inspections'
import { ncrs } from './ncrs'
import { complaints } from './complaints'
import { certificates } from './certificates'
import { labels } from './labels'
import { register } from './register'
import { claims } from './claims'
import { counts } from './counts'
import { hides } from './hides'
import { locations } from './locations'
import { lots } from './lots'
import { moves } from './moves'
import { receipts } from './receipts'
import { shipments } from './shipments'
import { stock } from './stock'
// B-W2b-62: People › Piece rates › Earnings ledger.
import { earningsLedger } from './earnings-ledger'
// B-W2b-120: Plant › Health & safety › Safety calendar.
import { safetyCalendar } from './safety-calendar'
// B-W2b-142: Plant › Maintenance › Preventive & statutory checks › Check register.
import { checkRegister } from './check-register'
// B-W2b-143: Plant › Health & safety › Chemicals & waste.
import { safetyChemicals } from './safety-chemicals'
// B-W2b-149: Plant › Health & safety › Incidents (anonymised).
import { incidents } from './incidents'
// B-W2b-104: Quality › Settings › Inspection plans & AQL › Plans (the source is B-W2b-92's; its page is this step's).
import { inspectionPlans } from './inspection-plans'
// B-W2b-119: Quality › Problems › Corrective actions (B-W2b-108's source, registered with its page).
import { capas } from './capas'
// B-W2b-264: Compliance › Sustainability › Sourcing & claims.
import { complianceClaims } from './compliance-claims'
// B-W2b-261: Products › Development › Samples & prototypes (B-W2b-246's read, registered with its page).
import { sampleRounds } from './sample-rounds'
// B-W2b-247: Products › Libraries › Colours & artwork (the colour library).
import { colours } from './colours'
// B-W2b-268: Compliance › Declarations & instructions.
import { complianceDeclarations } from './compliance-declarations'
// B-W2b-242: Products › Libraries › Options & rules (the option groups).
import { optionGroups } from './option-groups'
// B-W2b-244: Products › Development › Changes & versions (B-W2b-226's and B-W2b-215's reads as one list).
import { productChanges } from './product-changes'
// B-W2b-240: Products › Libraries › Sizes & measurements › Points of measure and Grade rules (B-W2b-224's reads).
import { pointsOfMeasure } from './points-of-measure'
import { gradeRules } from './grade-rules'

/**
 * Every list with an export (B-W2a-23; PLT-179), one file per list beside this one. A step that gives its list an export
 * adds its file and one line here (a merge point: keep both sides). Reports are not listed: each report of the pack is
 * a dynamic source (./reports.ts, found by the registry).
 */
export const EXPORT_SOURCES: readonly AnyExportSource[] = Object.freeze([
  salesOrders,
  purchaseOrders,
  workOrders,
  // B-W2b-11: products and parties.
  materials,
  operations,
  sizes,
  styles,
  quotes,
  customers,
  suppliers,
  // B-W2b-11: planning and money.
  mrp,
  capacityLoad,
  invoicesShipped,
  invoices,
  payments,
  // B-W2b-11: quality, compliance and claims.
  inspections,
  ncrs,
  complaints,
  certificates,
  labels,
  register,
  claims,
  // B-W2b-11: the warehouse.
  counts,
  hides,
  locations,
  lots,
  moves,
  receipts,
  shipments,
  stock,
  // B-W2b-62: People.
  earningsLedger,
  // B-W2b-120: Plant › Health & safety.
  safetyCalendar,
  // B-W2b-142: Plant › Maintenance.
  checkRegister,
  // B-W2b-143: Plant › Health & safety › Chemicals & waste.
  safetyChemicals,
  // B-W2b-149: Plant › Health & safety › Incidents (anonymised).
  incidents,
  // B-W2b-104: Quality › Settings › Inspection plans & AQL › Plans.
  inspectionPlans,
  // B-W2b-119: Quality › Problems › Corrective actions.
  capas,
  // B-W2b-264: Compliance › Sustainability › Sourcing & claims.
  complianceClaims,
  // B-W2b-261: Products › Development › Samples & prototypes.
  sampleRounds,
  // B-W2b-247: Products › Libraries › Colours & artwork.
  colours,
  // B-W2b-268: Compliance › Declarations & instructions.
  complianceDeclarations,
  // B-W2b-242: Products › Libraries › Options & rules.
  optionGroups,
  // B-W2b-244: Products › Development › Changes & versions.
  productChanges,
  // B-W2b-240: Products › Libraries › Sizes & measurements › Points of measure and Grade rules.
  pointsOfMeasure,
  gradeRules,
])
