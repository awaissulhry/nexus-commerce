/**
 * The approved navigation tree's W0, W1 and W2a part (design 01-navigation-tree, 2026-10-29, with the Owner's answers of
 * the same day): what the build must show, in this order and with these words. Copied from the tree's JSON (outside this
 * repository) by B-W1-08, the W2a pages added by each W2a screen step and checked whole against the tree by B-W2a-83 (rail,
 * groups, pages, words, floor tiles and modes); held here so the navigation test (navigation-map.vitest.test.ts) can walk
 * it. A later wave that ships a page adds it here from the tree, with its address.
 *
 *  - OFFICE: the rail areas (the tree's `order`: People 11 — W2b, from B-W2b-55 —, Plant 12 right above Admin 13), their groups
 *    and pages. `href` is the page's built address; `early` and `deferred` name a page the build ships outside its tree
 *    wave and why.
 *  - FLOOR: the W0–W2a floor tasks with their tile (floor/model.ts TILE_KEYS) and the station modes the tree gives them
 *    (My work: see its line).
 *  - LINKS: the W1 link pages with their task (links/_nav/link-types.ts).
 *  - FRAME: the top bar's own pages the palette finds (design 01 "Frame & me").
 */

export interface TreePage {
  readonly id: string
  readonly title: string
  readonly titleIt: string
  readonly wave: string
  /** The built address; null while the page is deferred. */
  readonly href: string | null
  readonly early?: string
  readonly deferred?: string
}

export interface TreeGroup {
  readonly label: string
  readonly labelIt: string
  readonly hideLabel: boolean
  readonly pages: readonly TreePage[]
}

export interface TreeArea {
  readonly id: string
  readonly order: number
  readonly title: string
  readonly titleIt: string
  readonly groups: readonly TreeGroup[]
}

export const OFFICE: readonly TreeArea[] = [
  {
    id: 'home',
    order: 1,
    title: 'Home',
    titleIt: 'Home',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'home.today', title: 'Today', titleIt: 'Oggi', wave: 'W1', href: '/home/today' },
          { id: 'home.approvals', title: 'Approvals', titleIt: 'Approvazioni', wave: 'W1', href: '/home/approvals' },
          // W2a: B-W2a-40 My tasks (SCR-233) and Notifications (SCR-005).
          { id: 'home.tasks', title: 'My tasks', titleIt: 'Le mie attività', wave: 'W2a', href: '/home/tasks' },
          { id: 'home.notifications', title: 'Notifications', titleIt: 'Notifiche', wave: 'W2a', href: '/home/notifications' },
          { id: 'home.mail', title: 'Mail to sort', titleIt: 'Posta da smistare', wave: 'W0', href: '/home/mail-to-sort' },
        ],
      },
      // W2a: B-W2a-79 Reports (SCR-104) and B-W2a-78 Alerts (SCR-234). Dashboards and the KPI library (W2b) join with their steps.
      {
        label: 'Insights',
        labelIt: 'Analisi',
        hideLabel: false,
        pages: [
          { id: 'home.reports', title: 'Reports', titleIt: 'Report', wave: 'W2a', href: '/home/reports' },
          { id: 'home.alerts', title: 'Alerts', titleIt: 'Avvisi', wave: 'W2a', href: '/home/alerts' },
        ],
      },
    ],
  },
  {
    id: 'sales',
    order: 2,
    title: 'Sales',
    titleIt: 'Vendite',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'sales.customers', title: 'Customers', titleIt: 'Clienti', wave: 'W1', href: '/sales/customers' },
          { id: 'sales.quotes', title: 'Quotes', titleIt: 'Preventivi', wave: 'W1', href: '/sales/quotes' },
          { id: 'sales.orders', title: 'Orders', titleIt: 'Ordini', wave: 'W1', href: '/sales/orders' },
        ],
      },
      {
        label: 'Special orders',
        labelIt: 'Ordini speciali',
        hideLabel: false,
        pages: [
          {
            id: 'sales.mtm',
            title: 'Made-to-measure',
            titleIt: 'Su misura',
            wave: 'W1',
            href: null,
            deferred: 'GATE-MTM not passed (Owner answer Q9 = a, 2026-10-28): made-to-measure moves out of W1.',
          },
        ],
      },
      // W2a: B-W2a-77 Returns & repairs (SCR-111, SCR-112).
      {
        label: 'After-sales',
        labelIt: 'Post-vendita',
        hideLabel: false,
        pages: [{ id: 'sales.returns', title: 'Returns & repairs', titleIt: 'Resi e riparazioni', wave: 'W2a', href: '/sales/returns' }],
      },
      // W2a: B-W2a-49 Price lists & contracts (SCR-106).
      {
        label: 'Pricing',
        labelIt: 'Prezzi',
        hideLabel: false,
        pages: [{ id: 'sales.pricelists', title: 'Price lists & contracts', titleIt: 'Listini e contratti', wave: 'W2a', href: '/sales/price-lists' }],
      },
      // W2a: B-W2a-77 Sales settings (SCR-235).
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [{ id: 'sales.settings', title: 'Sales settings', titleIt: 'Impostazioni vendite', wave: 'W2a', href: '/sales/settings' }],
      },
    ],
  },
  {
    id: 'products',
    order: 3,
    title: 'Products',
    titleIt: 'Prodotti',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'products.styles', title: 'Styles', titleIt: 'Modelli', wave: 'W1', href: '/products/styles' },
          { id: 'products.materials', title: 'Materials & trims', titleIt: 'Materiali e accessori', wave: 'W1', href: '/products/materials' },
        ],
      },
      {
        label: 'Libraries',
        labelIt: 'Librerie',
        hideLabel: false,
        pages: [
          { id: 'products.operations', title: 'Operations', titleIt: 'Operazioni', wave: 'W1', href: '/products/operations' },
          { id: 'products.sizes', title: 'Sizes & measurements', titleIt: 'Taglie e misure', wave: 'W1', href: '/products/sizes' },
        ],
      },
    ],
  },
  {
    id: 'planning',
    order: 4,
    title: 'Planning',
    titleIt: 'Pianificazione',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'planning.mrp', title: 'What to buy & make', titleIt: 'Cosa comprare e produrre', wave: 'W1', href: '/planning/mrp' },
          // W2a: B-W2a-45 Planning board (SCR-122) and Lines & subcontractors (SCR-126). Capacity & load and Exceptions join between and after with their steps.
          { id: 'planning.board', title: 'Planning board', titleIt: 'Tabellone di pianificazione', wave: 'W2a', href: '/planning/board' },
          // B-W2a-70: Capacity & load (SCR-123) between the board and the allocation; Exceptions (SCR-125) after it.
          { id: 'planning.capacity', title: 'Capacity & load', titleIt: 'Capacità e carico', wave: 'W2a', href: '/planning/capacity' },
          { id: 'planning.allocation', title: 'Lines & subcontractors', titleIt: 'Linee e terzisti', wave: 'W2a', href: '/planning/allocation' },
          { id: 'planning.exceptions', title: 'Exceptions', titleIt: 'Eccezioni', wave: 'W2a', href: '/planning/exceptions' },
        ],
      },
      // W2a: B-W2a-59 Planning settings (SCR-124, SCR-127).
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [{ id: 'planning.settings', title: 'Planning settings', titleIt: 'Impostazioni pianificazione', wave: 'W2a', href: '/planning/settings' }],
      },
    ],
  },
  {
    id: 'purchasing',
    order: 5,
    title: 'Purchasing',
    titleIt: 'Acquisti',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'purchasing.suppliers', title: 'Suppliers', titleIt: 'Fornitori', wave: 'W1', href: '/purchasing/suppliers' },
          // W2a: B-W2a-69 Requests to buy (SCR-236).
          { id: 'purchasing.requests', title: 'Requests to buy', titleIt: "Richieste d'acquisto", wave: 'W2a', href: '/purchasing/requests' },
          { id: 'purchasing.orders', title: 'Purchase orders', titleIt: "Ordini d'acquisto", wave: 'W1', href: '/purchasing/orders' },
        ],
      },
      // W2a: B-W2a-56 Subcontract orders (SCR-128, SCR-129).
      {
        label: 'Outside work',
        labelIt: 'Lavorazioni esterne',
        hideLabel: false,
        pages: [{ id: 'purchasing.subcontracting', title: 'Subcontract orders', titleIt: 'Ordini ai terzisti', wave: 'W2a', href: '/purchasing/subcontracting' }],
      },
      // W2a: B-W2a-63 Returns & claims (SCR-131). RFQs & sourcing (W2b) joins before it with its step.
      {
        label: 'Sourcing & claims',
        labelIt: 'Offerte e reclami',
        hideLabel: false,
        pages: [{ id: 'purchasing.claims', title: 'Returns & claims', titleIt: 'Resi e reclami ai fornitori', wave: 'W2a', href: '/purchasing/claims' }],
      },
    ],
  },
  {
    id: 'warehouse',
    order: 6,
    title: 'Warehouse',
    titleIt: 'Magazzino',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'warehouse.stock', title: 'Stock', titleIt: 'Giacenze', wave: 'W1', href: '/warehouse/stock' },
          { id: 'warehouse.hides', title: 'Hides', titleIt: 'Pelli', wave: 'W1', href: '/warehouse/hides' },
          { id: 'warehouse.lots', title: 'Lots & traceability', titleIt: 'Lotti e tracciabilità', wave: 'W1', href: '/warehouse/lots' },
          { id: 'warehouse.moves', title: 'Movements', titleIt: 'Movimenti', wave: 'W1', href: '/warehouse/moves' },
        ],
      },
      {
        label: 'Inbound',
        labelIt: 'In entrata',
        hideLabel: false,
        pages: [{ id: 'warehouse.receipts', title: 'Receipts', titleIt: 'Ricevimenti', wave: 'W1', href: '/warehouse/receipts' }],
      },
      {
        label: 'In the warehouse',
        labelIt: 'In magazzino',
        hideLabel: false,
        // W2a: B-W2a-58 Picking & kits (SCR-237), B-W2a-28 Counts (SCR-132); Transfers is W2b.
        pages: [
          { id: 'warehouse.picking', title: 'Picking & kits', titleIt: 'Prelievi e kit', wave: 'W2a', href: '/warehouse/picking' },
          { id: 'warehouse.counts', title: 'Counts', titleIt: 'Inventari', wave: 'W2a', href: '/warehouse/counts' },
        ],
      },
      {
        label: 'Outbound',
        labelIt: 'In uscita',
        hideLabel: false,
        pages: [{ id: 'warehouse.shipments', title: 'Shipments', titleIt: 'Spedizioni', wave: 'W1', href: '/warehouse/shipments' }],
      },
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [
          { id: 'warehouse.locations', title: 'Locations', titleIt: 'Ubicazioni', wave: 'W1', href: '/warehouse/locations' },
          { id: 'warehouse.shipping', title: 'Carriers & shipping', titleIt: 'Corrieri e spedizioni', wave: 'W1', href: '/warehouse/shipping' },
        ],
      },
    ],
  },
  {
    id: 'production',
    order: 7,
    title: 'Production',
    titleIt: 'Produzione',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'production.floor', title: 'Floor now', titleIt: 'Reparto ora', wave: 'W1', href: '/production/floor' },
          { id: 'production.workorders', title: 'Work orders', titleIt: 'Ordini di produzione', wave: 'W1', href: '/production/work-orders' },
        ],
      },
      // W2a: B-W2a-60 Cutting (SCR-238) and Scrap & rework (SCR-140).
      {
        label: 'Cutting room',
        labelIt: 'Sala taglio',
        hideLabel: false,
        pages: [{ id: 'production.cutting', title: 'Cutting', titleIt: 'Taglio', wave: 'W2a', href: '/production/cutting' }],
      },
      {
        label: 'Floor control',
        labelIt: 'Controllo reparto',
        hideLabel: false,
        pages: [
          { id: 'production.scrap', title: 'Scrap & rework', titleIt: 'Scarti e rilavorazioni', wave: 'W2a', href: '/production/scrap' },
          // W2b: B-W2b-58 Help calls (SCR-142).
          { id: 'production.calls', title: 'Help calls', titleIt: 'Chiamate di aiuto', wave: 'W2b', href: '/production/calls' },
        ],
      },
      {
        label: 'Reports',
        labelIt: 'Report',
        hideLabel: false,
        // W2a: B-W2a-38 Production reports (SCR-240).
        pages: [{ id: 'production.reports', title: 'Production reports', titleIt: 'Report produzione', wave: 'W2a', href: '/production/reports' }],
      },
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [{ id: 'production.settings', title: 'Floor rules & codes', titleIt: 'Regole di reparto', wave: 'W1', href: '/production/settings' }],
      },
    ],
  },
  {
    id: 'quality',
    order: 8,
    title: 'Quality',
    titleIt: 'Qualità',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'quality.inspections', title: 'Inspections', titleIt: 'Ispezioni', wave: 'W1', href: '/quality/inspections' },
          // W2a: B-W2a-67 Holds (SCR-078).
          { id: 'quality.holds', title: 'Holds', titleIt: 'Blocchi', wave: 'W2a', href: '/quality/holds' },
        ],
      },
      // W2a: B-W2a-68 Nonconformances (SCR-144, SCR-145) and B-W2a-65 Complaints (SCR-113 W2a part).
      {
        label: 'Problems',
        labelIt: 'Problemi',
        hideLabel: false,
        pages: [
          { id: 'quality.ncr', title: 'Nonconformances', titleIt: 'Non conformità', wave: 'W2a', href: '/quality/ncr' },
          { id: 'quality.complaints', title: 'Complaints', titleIt: 'Reclami', wave: 'W2a', href: '/quality/complaints' },
        ],
      },
      // W2a: B-W2a-67 Defects & dispositions (SCR-079). After Problems (the tree's order).
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [{ id: 'quality.defects', title: 'Defects & dispositions', titleIt: 'Difetti e destinazioni', wave: 'W2a', href: '/quality/defects' }],
      },
    ],
  },
  {
    id: 'compliance',
    order: 9,
    title: 'Compliance',
    titleIt: 'Conformità',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'compliance.certificates', title: 'Certificates', titleIt: 'Certificati', wave: 'W1', href: '/compliance/certificates' },
          { id: 'compliance.labels', title: 'Labels & marking', titleIt: 'Etichette e marcature', wave: 'W1', href: '/compliance/labels' },
          { id: 'compliance.tests', title: 'Tests & substances', titleIt: 'Test e sostanze', wave: 'W1', href: '/compliance/tests' },
        ],
      },
      {
        label: 'Product safety',
        labelIt: 'Sicurezza prodotto',
        hideLabel: false,
        pages: [{ id: 'compliance.register', title: 'PPE register & recalls', titleIt: 'Registro DPI e richiami', wave: 'W1', href: '/compliance/register' }],
      },
    ],
  },
  {
    id: 'finance',
    order: 10,
    title: 'Finance',
    titleIt: 'Amministrazione',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          { id: 'finance.invoices', title: 'Invoices', titleIt: 'Fatture', wave: 'W1', href: '/finance/invoices' },
          { id: 'finance.payments', title: 'Payments', titleIt: 'Incassi', wave: 'W1', href: '/finance/payments' },
          // W2a: B-W2a-81 Receivables & credit (SCR-151).
          { id: 'finance.receivables', title: 'Receivables & credit', titleIt: 'Crediti e fidi', wave: 'W2a', href: '/finance/receivables' },
        ],
      },
      // W2a: B-W2a-81 Payables & bank › Supplier invoices (SCR-153); Bank is W2b.
      {
        label: 'Payables & bank',
        labelIt: 'Fornitori e banca',
        hideLabel: false,
        pages: [{ id: 'finance.payables', title: 'Supplier invoices', titleIt: 'Fatture fornitori', wave: 'W2a', href: '/finance/payables' }],
      },
      // W2a: B-W2a-72 Costing: Standard vs actual (SCR-154) and Margins (SCR-155).
      {
        label: 'Costing',
        labelIt: 'Costi',
        hideLabel: false,
        pages: [
          { id: 'finance.costing', title: 'Standard vs actual', titleIt: 'Costi standard ed effettivi', wave: 'W2a', href: '/finance/costing' },
          { id: 'finance.margins', title: 'Margins', titleIt: 'Margini', wave: 'W2a', href: '/finance/margins' },
        ],
      },
      // W2a: B-W2a-51 Accounting export (SCR-156) and Finance reports (SCR-239: the stock valuation).
      {
        label: 'Close',
        labelIt: 'Chiusura',
        hideLabel: false,
        pages: [{ id: 'finance.accounting', title: 'Accounting export', titleIt: 'Esportazione contabile', wave: 'W2a', href: '/finance/accounting' }],
      },
      {
        label: 'Reports',
        labelIt: 'Report',
        hideLabel: false,
        pages: [{ id: 'finance.reports', title: 'Finance reports', titleIt: 'Report amministrazione', wave: 'W2a', href: '/finance/reports' }],
      },
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [{ id: 'finance.settings', title: 'Finance settings', titleIt: 'Impostazioni amministrazione', wave: 'W1', href: '/finance/settings' }],
      },
    ],
  },
  // W2b: B-W2b-55 the People area (the tree's 11) with its first page, Employees (SCR-084, SCR-085). Its other pages join
  // here with their steps (Attendance, Shifts, Skills & training, Piece rates, Payroll export, Efficiency, People reports,
  // People settings): their rows are declared in areas/people/nav.ts and show once their page is built.
  {
    id: 'people',
    order: 11,
    title: 'People',
    titleIt: 'Persone',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [{ id: 'people.employees', title: 'Employees', titleIt: 'Dipendenti', wave: 'W2b', href: '/people/employees' }],
      },
    ],
  },
  // W2a: B-W2a-53 the Plant area (Owner answer T2), its Maintenance pages: Machine requests (SCR-148), Maintenance jobs
  // (SCR-149), Machines & tools (SCR-150). Preventive checks, spare parts, downtime and Health & safety join later.
  {
    id: 'plant',
    order: 12,
    title: 'Plant',
    titleIt: 'Stabilimento',
    groups: [
      {
        label: 'Maintenance',
        labelIt: 'Manutenzione',
        hideLabel: false,
        pages: [
          { id: 'plant.requests', title: 'Machine requests', titleIt: 'Richieste di intervento', wave: 'W2a', href: '/plant/requests' },
          { id: 'plant.jobs', title: 'Maintenance jobs', titleIt: 'Interventi', wave: 'W2a', href: '/plant/jobs' },
          { id: 'plant.machines', title: 'Machines & tools', titleIt: 'Macchine e attrezzature', wave: 'W2a', href: '/plant/machines' },
        ],
      },
      // B-W2a-73: Plant settings (a W2b page) ships with its W2a section only, Symptoms on the floor (SCR-241).
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [
          {
            id: 'plant.settings',
            title: 'Plant settings',
            titleIt: 'Impostazioni stabilimento',
            wave: 'W2b',
            href: '/plant/settings',
            early: 'W2A-PLAN §10: its W2a section "Symptoms on the floor" (SCR-241, B-W2a-73) ships on the W2b page.',
          },
        ],
      },
    ],
  },
  {
    id: 'admin',
    order: 13,
    title: 'Admin',
    titleIt: 'Sistema',
    groups: [
      {
        label: 'Main',
        labelIt: 'Principali',
        hideLabel: true,
        pages: [
          {
            id: 'admin.overview',
            title: 'All settings',
            titleIt: 'Tutte le impostazioni',
            wave: 'W3',
            href: '/admin',
            early: 'Owner answer O2 (2026-10-29): the "Get the factory ready" checklist ships now; search, switches and history stay W3.',
          },
        ],
      },
      {
        label: 'Organisation',
        labelIt: 'Organizzazione',
        hideLabel: false,
        pages: [
          { id: 'admin.org', title: 'Companies & sites', titleIt: 'Società e stabilimenti', wave: 'W0', href: '/admin/companies' },
          { id: 'admin.devices', title: 'Devices & printers', titleIt: 'Dispositivi e stampanti', wave: 'W0', href: '/admin/devices' },
        ],
      },
      {
        label: 'Access',
        labelIt: 'Accessi',
        hideLabel: false,
        pages: [
          { id: 'admin.users', title: 'Users', titleIt: 'Utenti', wave: 'W0', href: '/admin/users' },
          { id: 'admin.roles', title: 'Roles & permissions', titleIt: 'Ruoli e permessi', wave: 'W0', href: '/admin/roles' },
          // W2a: B-W2a-36 Security & health (SCR-166).
          { id: 'admin.security', title: 'Security & health', titleIt: 'Sicurezza e stato del sistema', wave: 'W2a', href: '/admin/security' },
        ],
      },
      {
        label: 'Platform',
        labelIt: 'Piattaforma',
        hideLabel: false,
        pages: [
          { id: 'admin.documents', title: 'Documents & numbering', titleIt: 'Documenti e numerazioni', wave: 'W0', href: '/admin/documents' },
          { id: 'admin.languages', title: 'Languages & formats', titleIt: 'Lingue e formati', wave: 'W0', href: '/admin/languages' },
          // W2a: B-W2a-78 Approvals, automation & AI (SCR-167, the Reminders & timers part). Fields & lists (W2b) joins before it.
          { id: 'admin.automation', title: 'Approvals, automation & AI', titleIt: 'Approvazioni, automazioni e IA', wave: 'W2a', href: '/admin/automation' },
          { id: 'admin.connections', title: 'Connections & API', titleIt: 'Connessioni e API', wave: 'W0', href: '/admin/connections' },
        ],
      },
      {
        label: 'Data',
        labelIt: 'Dati',
        hideLabel: false,
        pages: [
          { id: 'admin.import', title: 'Import & export', titleIt: 'Importa ed esporta', wave: 'W0', href: '/admin/import' },
          { id: 'admin.audit', title: 'Audit log', titleIt: 'Registro attività', wave: 'W0', href: '/admin/audit' },
          { id: 'admin.privacy', title: 'Privacy & notices', titleIt: 'Privacy e informative', wave: 'W0', href: '/admin/privacy' },
        ],
      },
    ],
  },
]

export const FLOOR: ReadonlyArray<{
  readonly id: string
  readonly title: string
  readonly titleIt: string
  readonly tile: string
  readonly modes: readonly string[]
}> = [
  {
    id: 'floor.scan',
    title: 'Scan anything',
    titleIt: 'Scansiona',
    tile: 'scan',
    modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection', 'supervisor', 'maintenance', 'phone'],
  },
  // W2a: B-W2a-74 My work (SCR-089), the station's queue, in the tree's modes. The build differs, named in the navigation
  // test: the warehouse's task inbox (SCM-274) and the phone's personal list are W2b, so W2a gives it every station with
  // a queue — the packing bench too (the dispatch list is per station, whatever its work centre), not the warehouse.
  { id: 'floor.mywork', title: 'My work', titleIt: 'Il mio lavoro', tile: 'mywork', modes: ['sewing', 'cutting', 'warehouse', 'inspection', 'phone'] },
  { id: 'floor.operation', title: 'Operation', titleIt: 'Operazione', tile: 'operation', modes: ['sewing', 'cutting', 'packing'] },
  { id: 'floor.hidecut', title: 'Hide check & cut log', titleIt: 'Controllo pelle e taglio', tile: 'cut', modes: ['cutting'] },
  { id: 'floor.bundles', title: 'Bundles & tickets', titleIt: 'Fasci e cartellini', tile: 'bundles', modes: ['cutting'] },
  { id: 'floor.receive', title: 'Receive goods', titleIt: 'Ricevi merce', tile: 'receive', modes: ['warehouse'] },
  { id: 'floor.pick', title: 'Pick & issue', titleIt: 'Preleva e consegna', tile: 'pick', modes: ['warehouse'] },
  // W2a: B-W2a-76 Receive a return (SCR-180) and Subcontract kits (SCR-181).
  { id: 'floor.returnsin', title: 'Receive a return', titleIt: 'Ricevi un reso', tile: 'returnsin', modes: ['warehouse'] },
  { id: 'floor.kits', title: 'Subcontract kits', titleIt: 'Kit per terzisti', tile: 'kits', modes: ['warehouse'] },
  { id: 'floor.labels', title: 'Garment labels', titleIt: 'Etichette capo', tile: 'labels', modes: ['packing'] },
  { id: 'floor.pack', title: 'Pack', titleIt: 'Imballa', tile: 'pack', modes: ['packing'] },
  { id: 'floor.final', title: 'Final inspection & release', titleIt: 'Collaudo finale e rilascio', tile: 'final', modes: ['inspection'] },
  // W2a: B-W2a-73 the floor area Maintenance & safety, its machine problem (SCR-179); Report an incident is W2b.
  { id: 'floor.machine', title: 'Machine problem & jobs', titleIt: 'Guasto e interventi', tile: 'machine', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection', 'maintenance'] },
]

export const LINKS: ReadonlyArray<{ readonly id: string; readonly title: string; readonly scr: readonly string[]; readonly task: string }> = [
  { id: 'links.quote', title: 'Accept a quote', scr: ['SCR-099'], task: 'quote-accept' },
  { id: 'links.document', title: 'Download a document', scr: ['SCR-101'], task: 'shipment-documents' },
  { id: 'links.po', title: 'Confirm a PO', scr: ['SCR-100'], task: 'po-confirm' },
]

export const FRAME: ReadonlyArray<{ readonly id: string; readonly title: string; readonly titleIt: string; readonly href: string }> = [
  { id: 'shell.profile', title: 'My profile', titleIt: 'Il mio profilo', href: '/me' },
]
