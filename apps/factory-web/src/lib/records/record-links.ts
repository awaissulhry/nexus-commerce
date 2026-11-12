/**
 * Where a record opens (design 00 §2.3, "one detail rule"): the record's own page when its area has built it, else the
 * record panel route `/records/<type>/<id>` (SCR-006: its thread, files and history), which every record has. Addresses
 * are company-free; the caller adds `/w/<company>`. Every opener is a real link, so ⌘-click opens a new tab.
 *
 * A step that builds a record page (or a list page) adds ONE line here, and its page's address to OFFICE_PAGES
 * (shell/nav/office-nav.ts): the opener follows by itself. `[id]` stands for the record's id, `[companyId]` for its
 * company (a record that lives under its company's page); a `?…` part is kept. The navigation test
 * (shell/nav/navigation-map.vitest.test.ts) holds that every built record page has its line here.
 */

/**
 * Record type (the API's model name) → its own page. W1 so far: a received mail opens in Mail to sort's review; a party
 * (customer or supplier: one record) opens on the Customers record page (the type does not say which side; the Suppliers
 * record page shows the same party from the buying side); a quote opens its studio (SCR-035), a sales order its studio
 * (SCR-039).
 */
export const RECORD_PAGES: Readonly<Record<string, string>> = Object.freeze({
  InboundEmail: '/home/mail-to-sort?open=[id]',
  Party: '/sales/customers/[id]',
  // B-W2b-180: a party's portal settings (audit rows, partner events; one row per party, its id the party's) open its
  // Portal access tab (a supplier's opens on the Customers record page, as Party does).
  PortalSettings: '/sales/customers/[id]?tab=portal',
  Quote: '/sales/quotes/[id]',
  SalesOrder: '/sales/orders/[id]',
  Style: '/products/styles/[id]',
  // Products › Materials & trims (SCR-048; the API's model is Item) and the libraries (SCR-049).
  Item: '/products/materials/[id]',
  Operation: '/products/operations/[id]',
  SizeScale: '/products/sizes/[id]',
  // B-W2b-240: a point of measure opens in its dialog on Sizes › Points of measure, a grade rule in its pop-up on Grade rules.
  PointOfMeasure: '/products/sizes?view=poms&open=[id]',
  GradeRule: '/products/sizes?view=rules&open=[id]',
  // B-W2b-247: a private-label brand's branding set opens in its DetailModal on Colours & artwork (SCR-118); a library colour
  // has no page of its own (its row is edited in the list) and opens in its panels (its photo, history, thread).
  BrandingSet: '/products/colours?open=[id]',
  // B-W2b-242: an option group's record (SCR-114-record: options, rules, price and BOM effects, styles).
  OptionGroup: '/products/options/[id]',
  // B-W2b-239: a product type opens in its dialog on Products › Settings › Product settings (SCR-251).
  ProductTypeProfile: '/products/settings?type=[id]',
  WorkOrder: '/production/work-orders/[id]',
  // B-W2b-59: a bundle's record (SCR-259: progress, scans, quality, ticket).
  Bundle: '/production/bundles/[id]',
  // B-W2b-129: a cut order of several work orders (SCR-238-order: lays, pieces, yield, tickets).
  CutOrder: '/production/cutting/orders/[id]',
  // Quality › Inspections (SCR-076); a release is reviewed in its DetailModal on the list (design §2.3).
  Inspection: '/quality/inspections/[id]',
  QualityRelease: '/quality/inspections?open=[id]',
  // B-W2b-127: the incoming inspections and in-process checks listed with the final ones open their own record pages.
  IncomingInspection: '/quality/inspections/incoming/[id]',
  InProcessCheck: '/quality/inspections/inline/[id]',
  // B-W2a-67: a hold is reviewed in its DetailModal on Quality › Holds (SCR-078, design §2.3); a library code in its drawer (SCR-079).
  QualityHold: '/quality/holds?open=[id]',
  DefectCode: '/quality/defects?open=[id]',
  // B-W2a-68: Quality › Nonconformances (SCR-145): an NCR's record (problem, containment, disposition, linked, activity).
  Nonconformance: '/quality/ncr/[id]',
  // B-W2b-119: Quality › Corrective actions (SCR-146): a CAPA's or an 8D's record (problem, actions, report, activity).
  Capa: '/quality/capa/[id]',
  // Quality › Complaints (SCR-113 W2a part, B-W2a-65): a complaint's record (a new one is triaged from the list's DetailModal).
  Complaint: '/quality/complaints/[id]',
  // B-W2b-118: a quality alert rule (a test of it rings the bell) opens on Quality rules in its dialog.
  QualityAlertRule: '/quality/settings?rule=[id]',
  // B-W2b-104: an inspection plan's record (SCR-077-plan); an AQL profile and a rule of "When inspections are created" on their tabs.
  InspectionPlan: '/quality/plans/[id]',
  AqlProfile: '/quality/plans?tab=aql&profile=[id]',
  InspectionTrigger: '/quality/plans?tab=triggers&rule=[id]',
  // Warehouse › Lots & traceability (SCR-201): a lot's stock, trace and moves; its tests, documents and release stay in
  // Compliance › Tests & substances (SCR-054), which the lot record links.
  Lot: '/warehouse/lots/[id]',
  // Warehouse › Hides (SCR-200) and Settings › Locations (SCR-065).
  Hide: '/warehouse/hides/[id]',
  Location: '/warehouse/locations/[id]',
  // Warehouse › Counts (SCR-132): a cycle count or the year-end inventory.
  StockCount: '/warehouse/counts/[id]',
  // Compliance › PPE register & recalls (SCR-113).
  PpeRegisterEntry: '/compliance/register/[id]',
  // B-W2b-271: a recall or withdrawal of a register entry (SCR-328).
  RecallAction: '/compliance/register/recall/[id]',
  // Finance › Invoices (SCR-081: invoices, deposit invoices, credit notes) and Payments (SCR-082: a payment's placements).
  Invoice: '/finance/invoices/[id]',
  Payment: '/finance/payments/[id]',
  // B-W2a-81: Finance › Supplier invoices (SCR-153): a supplier invoice's record; a payment reminder opens on Receivables (SCR-151).
  SupplierInvoice: '/finance/payables/[id]',
  PaymentReminder: '/finance/receivables?reminder=[id]',
  // Compliance › Certificates (SCR-051) and Labels & marking (SCR-053).
  Certificate: '/compliance/certificates/[id]',
  LabelTemplate: '/compliance/labels/[id]',
  // Warehouse › Shipments (SCR-067): a shipment's record.
  Shipment: '/warehouse/shipments/[id]',
  // Purchasing › the PO studio (SCR-059); Warehouse › a goods receipt (SCR-063).
  PurchaseOrder: '/purchasing/orders/[id]',
  // B-W2b-332: a request asked in the office opens in Requests to buy (the queue's kind ASKED).
  PurchaseRequest: '/purchasing/requests?open=asked:[id]',
  GoodsReceipt: '/warehouse/receipts/[id]',
  // Purchasing › Subcontract orders (SCR-128, B-W2a-56): an order sent to a workshop.
  SubcontractOrder: '/purchasing/subcontracting/[id]',
  // Purchasing › Returns & claims (SCR-131, B-W2a-63): a supplier claim or a return to the supplier.
  SupplierClaim: '/purchasing/claims/[id]',
  // Admin (B-W0-27/28): a company, a site (its address names its company: `[companyId]` is the record's own company), a
  // device or printer, an office user, a floor worker, a role, a connection.
  Company: '/admin/companies/[id]',
  Site: '/admin/companies/[companyId]/sites/[id]',
  Device: '/admin/devices/[id]',
  User: '/admin/users/[id]',
  Worker: '/admin/users/floor/[id]',
  Role: '/admin/roles/[id]',
  IntegrationAccount: '/admin/connections/[id]',
  // Admin › Security & health (SCR-166, B-W2b-24): a restore drill (the reminder that the next one is due names the last one).
  RestoreDrill: '/admin/security?drill=[id]#backups',
  // Home › My tasks (SCR-233, B-W2a-40): a task opens in its DetailModal on the list.
  Task: '/home/tasks?open=[id]',
  // Home › Insights › Reports (SCR-104, B-W2a-79): a report of the standard pack by its key (`sales.late-orders`).
  Report: '/home/reports/[id]',
  // Home › Alerts (SCR-234, B-W2a-78): an exception rule's alert opens in its DetailModal on the list (Today's RULE_ALERT
  // row and the bell's `alert:` anchor follow).
  Alert: '/home/alerts?open=[id]',
  // B-W2a-53 Plant › Maintenance: a machine (SCR-150), a maintenance job (SCR-149); a request opens in its DetailModal on
  // the queue (SCR-148).
  Machine: '/plant/machines/[id]',
  MaintenanceJob: '/plant/jobs/[id]',
  MaintenanceRequest: '/plant/requests?open=[id]',
  // Sales › Price lists & contracts (SCR-106, B-W2a-49): a customer price list.
  PriceList: '/sales/price-lists/[id]',
  // Sales › Returns & repairs (SCR-112, B-W2a-77): a customer return (RMA) and a repair or alteration.
  ReturnAuthorisation: '/sales/returns/[id]',
  RepairOrder: '/sales/returns/repairs/[id]',
  // B-W2b-63 People › Payroll export (SCR-159): a file made for the labour consultant opens as Past export.
  PayrollExport: '/people/payroll/[id]',
  // Finance › Accounting export (SCR-156, B-W2a-51): a batch opens on its files tab (its checks, explanations and files).
  AccountingExport: '/finance/accounting/files?export=[id]',
  // Production › Scrap & rework (SCR-140, B-W2a-60): a rework order opens in its row's detail on the list.
  ReworkOrder: '/production/scrap?open=rework:[id]',
  // B-W2b-58: a help call opens in its DetailModal on Production › Help calls (SCR-142; the bell's call alerts).
  HelpCall: '/production/calls?open=[id]',
  // B-W2b-57: a correction request, a dispute and an off-standard block open in their DetailModal on Labour & corrections.
  ScanCorrectionRequest: '/production/labour?open=CORRECTION:[id]',
  LabourDispute: '/production/labour?open=DISPUTE:[id]',
  OffStandardEntry: '/production/labour?open=OFF_STANDARD:[id]',
  // Planning › Planning settings (SCR-124, B-W2a-59): a calendar opens on Calendars & shifts, a shift pattern in its editor.
  WorkCalendar: '/planning/settings?tab=calendars&cal=[id]',
  ShiftPattern: '/planning/settings?tab=calendars&pattern=[id]',
  // B-W2b-55 People › Employees (SCR-085): an employee's record; a team opens on the Teams view of Employees.
  Employee: '/people/employees/[id]',
  Team: '/people/employees?view=teams&team=[id]',
  // B-W2b-146 People › Skills & training: a course opens in its Course pop-up, a training record in its certificate tab.
  SafetyCourse: '/people/skills?view=courses&course=[id]',
  TrainingRecord: '/people/skills/certificate?record=[id]',
  // B-W2b-60 People › Shifts (SCR-263): an overtime request opens in its modal.
  OvertimeRequest: '/people/shifts?open=[id]',
  // B-W2b-62 People › Piece rates (SCR-158): a rate version, a pay period, a held scan and an entry open in their modals.
  PieceRateVersion: '/people/piecerates?open=[id]',
  PayPeriod: '/people/piecerates?period=[id]',
  HeldScan: '/people/piecerates?resolve=[id]',
  EarningsEntry: '/people/piecerates?entry=[id]',
  WorkerStatement: '/people/piecerates/statement/[id]',
  // B-W2b-61 People › Attendance (SCR-157): a day and an overtime entry open in their modal, a timesheet in its tab.
  AttendanceDay: '/people/attendance?open=[id]',
  OvertimeEntry: '/people/attendance?entry=[id]',
  TimesheetApproval: '/people/attendance/timesheets/[id]',
  // B-W2b-120 Plant › Safety calendar (SCR-267): a deadline typed there opens in its window, an appointment in its dialog,
  // an RLS notice to INAIL in Record RLS notice.
  SafetyDeadline: '/plant/calendar?open=DEADLINE:[id]',
  SafetyAppointment: '/plant/calendar?appoint=[id]',
  RlsNotice: '/plant/calendar?filing=[id]',
  // B-W2b-142 Plant › Preventive & statutory checks (SCR-266): a check plan opens in its Plan window, a check result in its own.
  MachineCheckPlan: '/plant/preventive?plan=[id]',
  MachineCheckResult: '/plant/preventive?result=[id]',
  // B-W2b-143 Plant › Chemicals & waste (SCR-213): a chemical opens in its window.
  Chemical: '/plant/chemicals?open=[id]',
  // B-W2b-264 Compliance › Sourcing & claims (SCR-215): a sustainability claim opens in its window.
  SustainabilityClaim: '/compliance/sourcing?open=[id]',
  // B-W2b-265 Compliance › Settings › Rules & markets (SCR-262): a register entry, a change of the watch and an operator row open in
  // their tab's window.
  RegulationOrStandard: '/compliance/settings?tab=regulations&open=[id]',
  StandardChange: '/compliance/settings?tab=regulations&change=[id]',
  EconomicOperatorRole: '/compliance/settings?tab=operators&open=[id]',
  // B-W2b-268 Compliance › Declarations & instructions (SCR-052-record): a DoC or a leaflet, signed or generated.
  ComplianceDocument: '/compliance/declarations/[id]',
  // B-W2b-267 Compliance › Tests & substances: a supplier declaration opens in its DetailModal on the Supplier declarations
  // view (SCR-054-declaration); a material's compliance profile (its id is the material's) on the material's Compliance tab.
  SupplierDeclarationRequest: '/compliance/tests?view=declarations&open=[id]',
  MaterialComplianceProfile: '/products/materials/[id]?tab=compliance',
  // B-W2b-149 Plant › Incidents (SCR-210): an incident opens its record page.
  Incident: '/plant/incidents/[id]',
  // B-W2b-148 Plant › Health surveillance (SCR-212): a visit and a judgement open in their window (each a recorded read), a plan in its dialog.
  HealthVisit: '/plant/health?visit=[id]',
  FitnessJudgement: '/plant/health?judgement=[id]',
  HealthPlan: '/plant/health?plan=[id]',
  // B-W2b-141 Plant settings (SCR-241): a routing rule and a statutory check type open in their dialog.
  RequestRoutingRule: '/plant/settings?rule=[id]',
  MachineCheckType: '/plant/settings?type=[id]',
  // B-W2b-144 Plant › Risk assessment (SCR-209): an assessment opens its page; a measure its assessment's plan tab (the page
  // finds it); a role sheet its window.
  RiskAssessment: '/plant/risk/[id]',
  RiskMeasure: '/plant/risk?measure=[id]',
  RoleSheet: '/plant/risk?sheet=[id]',
  // B-W2b-147 Plant › PPE for workers (SCR-211): a PPE issue (any line id names its receipt) opens its receipt tab, an item its dialog.
  PpeIssue: '/plant/ppe/receipt?receipt=[id]',
  PpeItem: '/plant/ppe?view=catalogue&item=[id]',
  // B-W2b-234 Production › Work instructions (SCR-285): an instruction opens its record page.
  WorkInstruction: '/production/instructions/[id]',
  // B-W2b-261 Products › Samples & prototypes (SCR-110-record): a sample round opens its record page.
  SampleRound: '/products/samples/[id]',
  // B-W2b-244 Products › Changes & versions (SCR-117-record): a change request and a change order open their record pages.
  ChangeRequest: '/products/changes/requests/[id]',
  ChangeOrder: '/products/changes/orders/[id]',
  // B-W2b-269 Compliance › Technical files (SCR-120): a technical file opens its record page, an evidence pack its PDF window (SCR-326).
  TechnicalFile: '/compliance/techfiles/[id]',
  EvidencePack: '/compliance/techfiles/pack?pack=[id]',
  // B-W2b-307 Home › Approvals (SCR-030): a request of the approval engine opens its review in the inbox (Today, the bell).
  ApprovalTask: '/home/approvals?open=[id]',
})

/**
 * A Today row whose work is done on a page other than its record's: attention kind → that page (`[id]` = the row's
 * record id). A company's open privacy duties are worked on Admin › Privacy & notices for that company, not on the
 * company's record.
 */
export const ATTENTION_PAGES: Readonly<Record<string, string>> = Object.freeze({
  PRIVACY_DUTY: '/admin/privacy?company=[id]',
  // B-W2b-307 (AW2:01, AW2:02): a change order and an SMV change waiting for my approval open Changes & versions' decide
  // pop-up (B-W2b-244's `?decide=`); the SMV row's record is the version.
  CHANGE_ORDER: '/products/changes?tile=MINE_TO_APPROVE&decide=order:[id]',
  SMV_CHANGE: '/products/changes?decide=smv:[id]',
})

/** An API list route → the web page that shows it (with the same query). */
export const LIST_PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/email/inbound': '/home/mail-to-sort',
  // B-W2a-78: the alerts (`?tile=`, `?severity=`, `?kind=`, `?q=` as the API reads them; `ruleKind` is the page's `kind`).
  '/alerts': '/home/alerts',
  '/parties': '/sales/customers',
  // The quote list (SCR-034) reads `status` and `q` as the API does; the approvals queue (SCR-030) reads `view`.
  '/sales/quotes': '/sales/quotes',
  '/sales/quote-approvals': '/home/approvals',
  // The order list (SCR-038) reads the API's own filters from the address (`?late=true`, `?deposit=OPEN`, `?status=`).
  '/sales/orders': '/sales/orders',
  // B-W2a-79: the report library (SCR-104).
  '/reports': '/home/reports',
  '/product/styles': '/products/styles',
  '/product/materials': '/products/materials',
  '/product/operations': '/products/operations',
  '/product/size-scales': '/products/sizes',
  // B-W2b-242
  '/product/option-groups': '/products/options',
  '/compliance/certificates': '/compliance/certificates',
  '/compliance/labels': '/compliance/labels',
  '/production/work-orders': '/production/work-orders',
  // B-W2b-58: the help calls (`?view=`, `?tile=`, `?kind=` as the API reads them).
  '/production/calls': '/production/calls',
  // B-W2b-57: the queue (`?kind=`, `?line=`; the API's `lineId` is the page's `line`).
  '/production/labour/inbox': '/production/labour',
  // B-W2b-59: the bundles (`?stuck=true`, `?place=LINE`, `?status=VOID` as the API reads them).
  '/production/bundles': '/production/bundles',
  // B-W2b-56: the dispatch board (`?site=`, `?line=`, `?date=`).
  '/production/dispatch': '/production/dispatch',
  // The pages read the API's own filters from the address (`?onHold=true`, `?waitingRelease=true`, `?status=OPEN`).
  '/quality/inspections': '/quality/inspections',
  // B-W2a-68: the NCR list and board (SCR-144; `?view=`, `?q=`, `?site=`, `?mode=board`, New NCR `?new=1&from=&id=`).
  '/quality/ncr': '/quality/ncr',
  // B-W2b-119: the CAPA list and board (`?view=`, `?type=`, `?priority=`, `?q=`, `?mode=board`, New CAPA `?new=1&from=&ids=`).
  '/quality/capa': '/quality/capa',
  // B-W2a-65: the complaints list reads `?view=`, `?q=` and the API's own filters (`?partyId=`, `?salesOrderId=`, …).
  '/quality/complaints': '/quality/complaints',
  '/quality/lots': '/compliance/tests',
  // B-W2a-67: the holds (the page reads the API's own filters: `?status=`, `?overdue=true`, `?system=true`, `?quarantine=`, `?ownerId=me`).
  '/quality/holds': '/quality/holds',
  '/quality/defects': '/quality/defects',
  // B-W2b-104: the plans (`?stage=`, `?status=`, `?q=` as the API reads them).
  '/quality/plans': '/quality/plans',
  '/compliance/register': '/compliance/register',
  // The invoice list reads the API's own filters from the address (`?status=REJECTED`, `?docType=TD04`).
  '/invoicing/invoices': '/finance/invoices',
  '/payments': '/finance/payments',
  // B-W2a-51: the accounting batches (`?status=`, `?year=`) and the stock valuation (`?asOf=`, `?site=`, `?category=`).
  '/accounting/exports': '/finance/accounting',
  '/costing/valuation': '/finance/reports',
  // B-W2a-72: standard vs actual (`?rows=`, `?q=`, `?site=`, `?month=`, `?open=<work order>`) and the order margins (`?from=`, `?to=`, `?party=`, `?style=`, `?q=`, `?open=<order>`).
  '/costing/work-orders': '/finance/costing',
  '/costing/margins': '/finance/margins',
  // B-W2a-81: what customers owe (`?bucket=`, `?q=`) and the supplier invoices (`?tile=`, `?q=`, the API's own filters).
  '/receivables/ageing': '/finance/receivables',
  '/payables/invoices': '/finance/payables',
  // The shipments list (SCR-066) reads `?rows=` and `?q=` from the address.
  '/shipping/shipments': '/warehouse/shipments',
  // The PO list reads `status` (one state, as the API) and `waitingOver48h`; Receipts reads `status`, `view=expected`.
  '/purchasing/orders': '/purchasing/orders',
  '/inventory/receipts': '/warehouse/receipts',
  // B-W2a-56: the subcontract orders (the page reads `?view=`, `?q=`; `?show=stock` is the stock at the workshops).
  '/purchasing/subcontracting/orders': '/purchasing/subcontracting',
  // B-W2a-69: Requests to buy (the page reads `?view=`, `?kind=`, `?site=`, `?q=`, `?group=`, `?open=`).
  '/purchasing/requests': '/purchasing/requests',
  // B-W2a-63: the claims (the page reads `?view=`, `?status=`, `?kind=`, `?receipt=`, `?lot=`, `?q=`).
  '/purchasing/claims': '/purchasing/claims',
  // B-W2b-347: the sample and development orders (the page reads `?rows=`, `?status=`, `?q=`).
  '/purchasing/sample-orders': '/purchasing/sourcing',
  // The stock screens read the API's own filters from the address.
  '/inventory/stock': '/warehouse/stock',
  // B-W2a-58: the pick lists across work orders (SCR-237).
  '/inventory/picking/pick-lists': '/warehouse/picking',
  '/inventory/hides': '/warehouse/hides',
  '/inventory/lots': '/warehouse/lots',
  '/inventory/ledger': '/warehouse/moves',
  '/inventory/locations': '/warehouse/locations',
  // Counts (SCR-132) reads `?view=`, `?q=` and `?site=`.
  '/inventory/stock-counts': '/warehouse/counts',
  '/planning/runs/latest': '/planning/mrp',
  // B-W2a-45: the schedule's board and the allocation board.
  '/planning/schedule': '/planning/board',
  '/planning/allocation': '/planning/allocation',
  // B-W2a-70: capacity per lane and bucket (SCR-123, `?site=` `?from=` `?to=` `?bucket=`) and the exception queue (SCR-125).
  '/planning/capacity': '/planning/capacity',
  '/planning/exceptions': '/planning/exceptions',
  // B-W2b-132: the leather and cut plan's three reads (SCR-252, `?site=` `?tile=` `?feas=` `?q=`).
  '/planning/leather/need': '/planning/leather',
  '/planning/leather/protectors': '/planning/leather',
  '/planning/leather/yield': '/planning/leather',
  // B-W2a-59: the planning settings of the sites (SCR-124, SCR-127).
  '/planning/settings': '/planning/settings',
  // B-W2b-263: Time & action (SCR-253, `?view=calendar|list|orders` `?tile=` `?q=` `?open=`).
  '/planning/milestones': '/planning/milestones',
  // B-W2a-53: the plant's lists (the requests queue reads `?tile=`, the jobs `?view=`, the machines `?view=` and `?q=`).
  '/plant/requests': '/plant/requests',
  '/plant/jobs': '/plant/jobs',
  '/plant/machines': '/plant/machines',
  // B-W2a-49: the price lists (SCR-106) read `?rows=`, `?kind=` and `?q=`.
  '/sales/price-lists': '/sales/price-lists',
  // B-W2a-77: returns and repairs in one grid (SCR-111) read `?view=` and `?q=`.
  '/sales/returns': '/sales/returns',
  '/sales/repairs': '/sales/returns',
  // B-W2a-60: the cuts across work orders (SCR-238, `?view=`, `?q=`) and scrap & rework (SCR-140, `?view=`, `?period=`).
  '/production/cutting/cuts': '/production/cutting',
  '/production/scrap': '/production/scrap',
  // B-W2b-55: the HR register (SCR-084) reads `?tile=`, `?rows=`, `?q=` and `?view=teams`.
  '/people/employees': '/people/employees',
  // B-W2b-60: the overtime requests are a section of Shifts (SCR-263).
  '/people/overtime-requests': '/people/shifts',
  '/people/piece-rates': '/people/piecerates',
  '/people/pay-periods': '/people/piecerates',
  // B-W2b-61: Attendance (SCR-157) reads `?month=`, `?tile=`, `?team=`, `?line=`, `?status=`.
  '/people/attendance': '/people/attendance',
  // B-W2b-120: the safety calendar (SCR-267) reads `?view=`, `?tile=`, `?from=`, `?to=`.
  '/safety/calendar': '/plant/calendar',
  // B-W2b-142: the plans (`?due=`, `?ended=`) and the check register (`?missing=`, `?outcome=`) of SCR-266.
  '/plant/checks/plans': '/plant/preventive',
  '/plant/checks/results': '/plant/preventive',
  // B-W2b-143: the chemical register (SCR-213) reads `?tile=`, `?status=`, `?use=`, `?cabinet=`, `?q=`.
  '/safety/chemicals': '/plant/chemicals',
  // B-W2b-264: the claims (SCR-215) read `?state=`, `?kind=`, `?scope=`, `?q=`.
  '/compliance/claims': '/compliance/sourcing',
  // B-W2b-268: the declarations (SCR-052) read `?kind=`, `?status=`, `?origin=`, `?language=`, `?q=`.
  '/compliance/declarations': '/compliance/declarations',
  // B-W2b-149: the incidents (SCR-210) read `?rows=`, `?status=`, `?from=`, `?to=`, `?q=`.
  '/safety/incidents': '/plant/incidents',
  // B-W2b-148: the health page's frame (the tiles) and its plans per role.
  '/safety/health': '/plant/health',
  '/safety/health/plans': '/plant/health',
  // B-W2b-141: the routing rules and the statutory check types are sections of Plant settings (SCR-241).
  '/plant/settings/routing': '/plant/settings',
  '/plant/checks/types': '/plant/settings',
  // B-W2b-144: the assessments, the improvement plan (`?view=`) and the role sheets (`?q=`) of SCR-209.
  '/safety/risk/assessments': '/plant/risk',
  '/safety/risk/measures': '/plant/risk',
  '/safety/rolesheets': '/plant/risk',
  // B-W2b-234: the work instructions (SCR-141).
  '/production/instructions': '/production/instructions',
  // B-W2b-261: the sample rounds (SCR-110) read `?tile=`, `?kind=`, `?party=`, `?internal=1`, `?style=`, `?q=`.
  '/sales/samples/rounds': '/products/samples',
  // B-W2b-244: the changes (SCR-117) read `?tile=` (B-W2b-226's request and order tiles are its saved rows), `?style=` or
  // `?styleId=`, `?q=`.
  '/product/change-requests': '/products/changes',
  '/product/change-orders': '/products/changes',
})

export interface RecordRef {
  readonly type: string
  readonly id: string
  /** Its number or code (the panel route shows it as the title). */
  readonly label?: string
  readonly companyId?: string | null
  readonly siteId?: string | null
}

const pathOf = (address: string): string => address.split('?')[0]!

/** An address with every dynamic segment written `[id]`: `/sales/customers/[partyId]` (a page folder) = `/sales/customers/[id]`. */
const shapeOf = (address: string): string => pathOf(address).replace(/\[[^\]/]+\]/g, '[id]')

/** The page is built: OFFICE_PAGES lists it, whatever its dynamic segment is called there. */
function isBuilt(page: string, built: ReadonlySet<string>): boolean {
  const shape = shapeOf(page)
  for (const address of built) if (shapeOf(address) === shape) return true
  return false
}

/** Whether a record has its own page yet (else it opens in its panels). */
export function hasRecordPage(type: string, built: ReadonlySet<string>): boolean {
  const page = RECORD_PAGES[type]
  return page !== undefined && isBuilt(page, built)
}

/** The record's own page address, or null when its page needs what the reference lacks (a site without its company). */
function ownPage(page: string, record: RecordRef): string | null {
  if (page.includes('[companyId]') && !record.companyId) return null
  return page.replace('[companyId]', encodeURIComponent(record.companyId ?? '')).replace('[id]', encodeURIComponent(record.id))
}

/**
 * The company-free address a record opens at: its own page when built, else its panels (with what the panels need to
 * show it: its label, company and site).
 */
export function recordAddress(record: RecordRef, built: ReadonlySet<string>): string {
  const page = RECORD_PAGES[record.type]
  const own = page && hasRecordPage(record.type, built) ? ownPage(page, record) : null
  if (own) return own
  const query = new URLSearchParams()
  if (record.label) query.set('label', record.label)
  if (record.companyId) query.set('company', record.companyId)
  if (record.siteId) query.set('site', record.siteId)
  const qs = query.toString()
  return `/records/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}${qs ? `?${qs}` : ''}`
}

/**
 * The web page of an API list with its query (`/sales/orders` + `{ late: 'true' }`), or null while no page shows that
 * list (a link to a page that does not exist is never drawn).
 */
export function listAddress(apiList: string | null, query: Readonly<Record<string, string>> | null, built: ReadonlySet<string>): string | null {
  if (apiList === null) return null
  const page = LIST_PAGES[apiList]
  if (!page || !isBuilt(page, built)) return null
  const qs = new URLSearchParams(query ?? {}).toString()
  return `${page}${qs ? `?${qs}` : ''}`
}

/** Where a Today row opens: its kind's own page when built (ATTENTION_PAGES), else its record (`recordAddress`). */
export function attentionAddress(kind: string, record: RecordRef, built: ReadonlySet<string>): string {
  const page = ATTENTION_PAGES[kind]
  if (page && isBuilt(page, built)) return page.replace('[id]', encodeURIComponent(record.id))
  return recordAddress(record, built)
}
