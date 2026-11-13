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
 *  - LINKS: the W1 link pages with their task (links/_nav/link-types.ts); LINKS_NO_TOKEN the ones a QR or a typed code opens.
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
          // W2b: B-W2b-322 Inquiries (SCR-105).
          { id: 'sales.inquiries', title: 'Inquiries', titleIt: 'Richieste', wave: 'W2b', href: '/sales/inquiries' },
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
        pages: [
          { id: 'sales.returns', title: 'Returns & repairs', titleIt: 'Resi e riparazioni', wave: 'W2a', href: '/sales/returns' },
          // W2b: B-W2b-353 Warranty & service (SCR-217, SCR-413).
          { id: 'sales.service', title: 'Warranty & service', titleIt: 'Garanzia e assistenza', wave: 'W2b', href: '/sales/service' },
        ],
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
      // W2b: B-W2b-261 Development › Samples & prototypes (SCR-110), then Changes & versions (B-W2b-244).
      {
        label: 'Development',
        labelIt: 'Sviluppo',
        hideLabel: false,
        pages: [
          { id: 'products.samples', title: 'Samples & prototypes', titleIt: 'Campionature e prototipi', wave: 'W2b', href: '/products/samples' },
          // W2b: B-W2b-244 Changes & versions (SCR-117).
          { id: 'products.changes', title: 'Changes & versions', titleIt: 'Modifiche e versioni', wave: 'W2b', href: '/products/changes' },
        ],
      },
      {
        label: 'Libraries',
        labelIt: 'Librerie',
        hideLabel: false,
        pages: [
          { id: 'products.operations', title: 'Operations', titleIt: 'Operazioni', wave: 'W1', href: '/products/operations' },
          { id: 'products.sizes', title: 'Sizes & measurements', titleIt: 'Taglie e misure', wave: 'W1', href: '/products/sizes' },
          // W2b: B-W2b-247 Colours & artwork (SCR-118), after Sizes (the design's order).
          { id: 'products.colours', title: 'Colours & artwork', titleIt: 'Colori e grafiche', wave: 'W2b', href: '/products/colours' },
          // W2b: B-W2b-242 Options & rules (SCR-114), after Colours & artwork (the design's order).
          { id: 'products.options', title: 'Options & rules', titleIt: 'Opzioni e regole', wave: 'W2b', href: '/products/options' },
        ],
      },
      // W2b: B-W2b-239 Product settings (SCR-251), the tree's Settings group (last).
      { label: 'Settings', labelIt: 'Impostazioni', hideLabel: false, pages: [{ id: 'products.settings', title: 'Product settings', titleIt: 'Impostazioni prodotto', wave: 'W2b', href: '/products/settings' }] },
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
          // W2b: B-W2b-132 Leather & cut plan (SCR-252), after What to buy & make (the design's order).
          { id: 'planning.leather', title: 'Leather & cut plan', titleIt: 'Piano pelle e taglio', wave: 'W2b', href: '/planning/leather' },
          // W2a: B-W2a-45 Planning board (SCR-122) and Lines & subcontractors (SCR-126). Capacity & load and Exceptions join between and after with their steps.
          { id: 'planning.board', title: 'Planning board', titleIt: 'Tabellone di pianificazione', wave: 'W2a', href: '/planning/board' },
          // B-W2a-70: Capacity & load (SCR-123) between the board and the allocation; Exceptions (SCR-125) after it.
          { id: 'planning.capacity', title: 'Capacity & load', titleIt: 'Capacità e carico', wave: 'W2a', href: '/planning/capacity' },
          { id: 'planning.allocation', title: 'Lines & subcontractors', titleIt: 'Linee e terzisti', wave: 'W2a', href: '/planning/allocation' },
          { id: 'planning.exceptions', title: 'Exceptions', titleIt: 'Eccezioni', wave: 'W2a', href: '/planning/exceptions' },
        ],
      },
      // W2b: B-W2b-263 Time & action (SCR-253), the design's group "Dates".
      {
        label: 'Dates',
        labelIt: 'Date',
        hideLabel: false,
        pages: [
          // W2b: B-W2b-336 Promise dates (SCR-109), first in the group (the design's order).
          { id: 'planning.promise', title: 'Promise dates', titleIt: 'Date promesse', wave: 'W2b', href: '/planning/promise' },
          { id: 'planning.milestones', title: 'Time & action', titleIt: 'Calendario T&A', wave: 'W2b', href: '/planning/milestones' },
        ],
      },
      // W2b: B-W2b-339 Demand & forecast (SCR-374) and Master schedule & S&OP (SCR-202), the design's group "Long range".
      {
        label: 'Long range',
        labelIt: 'Lungo periodo',
        hideLabel: false,
        pages: [
          { id: 'planning.demand', title: 'Demand & forecast', titleIt: 'Domanda e previsioni', wave: 'W2b', href: '/planning/demand' },
          { id: 'planning.mps', title: 'Master schedule & S&OP', titleIt: 'Piano principale e S&OP', wave: 'W2b', href: '/planning/mps' },
        ],
      },
      // W2b: B-W2b-349 Planning reports (SCR-254), the design's group "Reports", before Settings.
      { label: 'Reports', labelIt: 'Report', hideLabel: false, pages: [{ id: 'planning.reports', title: 'Planning reports', titleIt: 'Report pianificazione', wave: 'W2b', href: '/planning/reports' }] },
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
      // W2a: B-W2a-63 Returns & claims (SCR-131); W2b: B-W2b-347 RFQs & sourcing (SCR-222) before it.
      {
        label: 'Sourcing & claims',
        labelIt: 'Offerte e reclami',
        hideLabel: false,
        pages: [
          { id: 'purchasing.sourcing', title: 'RFQs & sourcing', titleIt: 'Richieste di offerta', wave: 'W2b', href: '/purchasing/sourcing' },
          { id: 'purchasing.claims', title: 'Returns & claims', titleIt: 'Resi e reclami ai fornitori', wave: 'W2a', href: '/purchasing/claims' },
        ],
      },
      // W2b: B-W2b-350 Purchasing reports (SCR-255).
      { label: 'Reports', labelIt: 'Report', hideLabel: false, pages: [{ id: 'purchasing.reports', title: 'Purchasing reports', titleIt: 'Report acquisti', wave: 'W2b', href: '/purchasing/reports' }] },
      // W2b: B-W2b-354 Purchasing settings (SCR-256), the tree's Settings group (last).
      { label: 'Settings', labelIt: 'Impostazioni', hideLabel: false, pages: [{ id: 'purchasing.settings', title: 'Purchasing settings', titleIt: 'Impostazioni acquisti', wave: 'W2b', href: '/purchasing/settings' }] },
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
        // W2a: B-W2a-58 Picking & kits (SCR-237), B-W2a-28 Counts (SCR-132); W2b: B-W2b-326 Transfers (SCR-360).
        pages: [
          { id: 'warehouse.picking', title: 'Picking & kits', titleIt: 'Prelievi e kit', wave: 'W2a', href: '/warehouse/picking' },
          { id: 'warehouse.counts', title: 'Counts', titleIt: 'Inventari', wave: 'W2a', href: '/warehouse/counts' },
          // B-W2b-326: Transfers (SCR-360; the design's SCR-133).
          { id: 'warehouse.transfers', title: 'Transfers', titleIt: 'Trasferimenti', wave: 'W2b', href: '/warehouse/transfers' },
        ],
      },
      {
        label: 'Outbound',
        labelIt: 'In uscita',
        hideLabel: false,
        pages: [{ id: 'warehouse.shipments', title: 'Shipments', titleIt: 'Spedizioni', wave: 'W1', href: '/warehouse/shipments' }],
      },
      // W2b: B-W2b-356 Warehouse reports (SCR-257). The tree's Reports group, after Outbound and before Settings.
      { label: 'Reports', labelIt: 'Report', hideLabel: false, pages: [{ id: 'warehouse.reports', title: 'Warehouse reports', titleIt: 'Report magazzino', wave: 'W2b', href: '/warehouse/reports' }] },
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [
          { id: 'warehouse.locations', title: 'Locations', titleIt: 'Ubicazioni', wave: 'W1', href: '/warehouse/locations' },
          { id: 'warehouse.shipping', title: 'Carriers & shipping', titleIt: 'Corrieri e spedizioni', wave: 'W1', href: '/warehouse/shipping' },
          // W2b: B-W2b-355 Warehouse rules (SCR-258), last in Settings.
          { id: 'warehouse.settings', title: 'Warehouse rules', titleIt: 'Regole di magazzino', wave: 'W2b', href: '/warehouse/settings' },
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
          // W2b: B-W2b-56 Dispatch (SCR-138).
          { id: 'production.dispatch', title: 'Dispatch', titleIt: 'Assegnazione lavoro', wave: 'W2b', href: '/production/dispatch' },
        ],
      },
      // W2a: B-W2a-60 Cutting (SCR-238) and Scrap & rework (SCR-140).
      {
        label: 'Cutting room',
        labelIt: 'Sala taglio',
        hideLabel: false,
        pages: [
          { id: 'production.cutting', title: 'Cutting', titleIt: 'Taglio', wave: 'W2a', href: '/production/cutting' },
          // W2b: B-W2b-59 Bundles (SCR-259).
          { id: 'production.bundles', title: 'Bundles', titleIt: 'Fasci', wave: 'W2b', href: '/production/bundles' },
        ],
      },
      {
        label: 'Floor control',
        labelIt: 'Controllo reparto',
        hideLabel: false,
        pages: [
          // W2b: B-W2b-57 Labour & corrections (SCR-139, SCR-143); B-W2b-151: first of Floor control, the tree's order.
          { id: 'production.labour', title: 'Labour & corrections', titleIt: 'Manodopera e rettifiche', wave: 'W2b', href: '/production/labour' },
          { id: 'production.scrap', title: 'Scrap & rework', titleIt: 'Scarti e rilavorazioni', wave: 'W2a', href: '/production/scrap' },
          // W2b: B-W2b-58 Help calls (SCR-142).
          { id: 'production.calls', title: 'Help calls', titleIt: 'Chiamate di aiuto', wave: 'W2b', href: '/production/calls' },
          // W2b: B-W2b-234 Work instructions (SCR-141).
          { id: 'production.instructions', title: 'Work instructions', titleIt: 'Istruzioni di lavoro', wave: 'W2b', href: '/production/instructions' },
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
          // W2b: B-W2b-119 Corrective actions (SCR-146), between Nonconformances and Complaints (the tree's order).
          { id: 'quality.capa', title: 'Corrective actions', titleIt: 'Azioni correttive', wave: 'W2b', href: '/quality/capa' },
          { id: 'quality.complaints', title: 'Complaints', titleIt: 'Reclami', wave: 'W2a', href: '/quality/complaints' },
        ],
      },
      // W2b: B-W2b-138 Quality reports (SCR-147). The tree's Reports group, after Problems and before Settings.
      { label: 'Reports', labelIt: 'Report', hideLabel: false, pages: [{ id: 'quality.reports', title: 'Quality reports', titleIt: 'Report qualità', wave: 'W2b', href: '/quality/reports' }] },
      // W2a: B-W2a-67 Defects & dispositions (SCR-079). After Problems (the tree's order).
      {
        label: 'Settings',
        labelIt: 'Impostazioni',
        hideLabel: false,
        pages: [
          // W2b: B-W2b-104 Inspection plans & AQL (SCR-077), first in Settings (the tree's order).
          { id: 'quality.plans', title: 'Inspection plans & AQL', titleIt: 'Piani di controllo e AQL', wave: 'W2b', href: '/quality/plans' },
          { id: 'quality.defects', title: 'Defects & dispositions', titleIt: 'Difetti e destinazioni', wave: 'W2a', href: '/quality/defects' },
          // W2b: B-W2b-118 Quality rules (SCR-260).
          { id: 'quality.settings', title: 'Quality rules', titleIt: 'Regole qualità', wave: 'W2b', href: '/quality/settings' },
        ],
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
          // W2b: B-W2b-266 Status board (SCR-119), first of Main (design compliance.status group "Pages: Status board · Certificates · …").
          { id: 'compliance.status', title: 'Status board', titleIt: 'Stato conformità', wave: 'W2b', href: '/compliance/status' },
          { id: 'compliance.certificates', title: 'Certificates', titleIt: 'Certificati', wave: 'W1', href: '/compliance/certificates' },
          // W2b: B-W2b-268 Declarations & instructions (SCR-052), after Certificates (design compliance group Main).
          { id: 'compliance.declarations', title: 'Declarations & instructions', titleIt: 'Dichiarazioni e istruzioni', wave: 'W2b', href: '/compliance/declarations' },
          // W2b: B-W2b-269 Technical files (SCR-120), after Declarations & instructions (design compliance group Main).
          { id: 'compliance.techfiles', title: 'Technical files', titleIt: 'Fascicoli tecnici', wave: 'W2b', href: '/compliance/techfiles' },
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
      // W2b: B-W2b-264 Sourcing & claims (SCR-215), the design's group "Sustainability" (the product passport comes later).
      {
        label: 'Sustainability',
        labelIt: 'Sostenibilità',
        hideLabel: false,
        pages: [{ id: 'compliance.sourcing', title: 'Sourcing & claims', titleIt: 'Filiera e dichiarazioni ambientali', wave: 'W2b', href: '/compliance/sourcing' }],
      },
      // W2b: B-W2b-272 Compliance reports (SCR-261). The tree's Reports group, after Sustainability.
      { label: 'Reports', labelIt: 'Report', hideLabel: false, pages: [{ id: 'compliance.reports', title: 'Compliance reports', titleIt: 'Report conformità', wave: 'W2b', href: '/compliance/reports' }] },
      // W2b: B-W2b-265 Rules & markets (SCR-262), the tree's Settings group (last).
      { label: 'Settings', labelIt: 'Impostazioni', hideLabel: false, pages: [{ id: 'compliance.settings', title: 'Rules & markets', titleIt: 'Norme e mercati', wave: 'W2b', href: '/compliance/settings' }] },
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
        pages: [
          { id: 'people.employees', title: 'Employees', titleIt: 'Dipendenti', wave: 'W2b', href: '/people/employees' },
          { id: 'people.attendance', title: 'Attendance', titleIt: 'Presenze', wave: 'W2b', href: '/people/attendance' },
          { id: 'people.shifts', title: 'Shifts', titleIt: 'Turni', wave: 'W2b', href: '/people/shifts' },
        ],
      },
      // B-W2b-65: Skills & training (SCR-160) and People settings (SCR-265).
      { label: 'Skills & pay', labelIt: 'Competenze e paghe', hideLabel: false, pages: [{ id: 'people.skills', title: 'Skills & training', titleIt: 'Competenze e formazione', wave: 'W2b', href: '/people/skills' }, /* B-W2b-62 */ { id: 'people.piecerates', title: 'Piece rates', titleIt: 'Cottimi', wave: 'W2b', href: '/people/piecerates' }, /* B-W2b-63 */ { id: 'people.payroll', title: 'Payroll export', titleIt: 'Esportazione paghe', wave: 'W2b', href: '/people/payroll' }, /* B-W2b-64 */ { id: 'people.efficiency', title: 'Efficiency', titleIt: 'Efficienza', wave: 'W2b', href: '/people/efficiency' }] },
      // B-W2b-64: People reports (SCR-264).
      { label: 'Reports', labelIt: 'Report', hideLabel: false, pages: [{ id: 'people.reports', title: 'People reports', titleIt: 'Report persone', wave: 'W2b', href: '/people/reports' }] },
      { label: 'Settings', labelIt: 'Impostazioni', hideLabel: false, pages: [{ id: 'people.settings', title: 'People settings', titleIt: 'Impostazioni persone', wave: 'W2b', href: '/people/settings' }] },
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
          // B-W2b-142: Preventive & statutory checks (SCR-266); B-W2b-151: before Machines & tools, the tree's order.
          { id: 'plant.preventive', title: 'Preventive & statutory checks', titleIt: 'Manutenzione programmata e verifiche', wave: 'W2b', href: '/plant/preventive' },
          { id: 'plant.machines', title: 'Machines & tools', titleIt: 'Macchine e attrezzature', wave: 'W2a', href: '/plant/machines' },
        ],
      },
      // B-W2b-120: Health & safety ships its Safety calendar (SCR-267); the other Health & safety pages join with their steps.
      {
        label: 'Health & safety',
        labelIt: 'Salute e sicurezza',
        hideLabel: false,
        pages: [
          // B-W2b-144: Risk assessment (SCR-209), first of Health & safety as the design orders them.
          { id: 'plant.risk', title: 'Risk assessment', titleIt: 'Valutazione dei rischi (DVR)', wave: 'W2b', href: '/plant/risk' },
          // B-W2b-149: Incidents (SCR-210).
          { id: 'plant.incidents', title: 'Incidents', titleIt: 'Infortuni e quasi incidenti', wave: 'W2b', href: '/plant/incidents' },
          // B-W2b-147: PPE for workers (SCR-211), before chemicals as the design orders them.
          { id: 'plant.ppe', title: 'PPE for workers', titleIt: 'DPI ai lavoratori', wave: 'W2b', href: '/plant/ppe' },
          // B-W2b-148: Health surveillance (SCR-212), after PPE for workers and before Chemicals & waste (the design's order).
          { id: 'plant.health', title: 'Health surveillance', titleIt: 'Sorveglianza sanitaria', wave: 'W2b', href: '/plant/health' },
          // B-W2b-143: Chemicals & waste (SCR-213), before the calendar as the design orders them.
          { id: 'plant.chemicals', title: 'Chemicals & waste', titleIt: 'Sostanze e rifiuti', wave: 'W2b', href: '/plant/chemicals' },
          { id: 'plant.calendar', title: 'Safety calendar', titleIt: 'Scadenzario sicurezza', wave: 'W2b', href: '/plant/calendar' },
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
  // B-W2b-308: the warehouse too, where My work is the task inbox (SCM-274).
  { id: 'floor.mywork', title: 'My work', titleIt: 'Il mio lavoro', tile: 'mywork', modes: ['sewing', 'cutting', 'warehouse', 'inspection', 'phone'] },
  { id: 'floor.operation', title: 'Operation', titleIt: 'Operazione', tile: 'operation', modes: ['sewing', 'cutting', 'packing'] },
  { id: 'floor.hidecut', title: 'Hide check & cut log', titleIt: 'Controllo pelle e taglio', tile: 'cut', modes: ['cutting'] },
  // B-W2b-121: Fabric cutting (SCR-182), after Cut a hide (tile family Cutting).
  { id: 'floor.fabriccut', title: 'Fabric cutting', titleIt: 'Taglio tessuto', tile: 'fabriccut', modes: ['cutting'] },
  { id: 'floor.bundles', title: 'Bundles & tickets', titleIt: 'Fasci e cartellini', tile: 'bundles', modes: ['cutting'] },
  { id: 'floor.receive', title: 'Receive goods', titleIt: 'Ricevi merce', tile: 'receive', modes: ['warehouse'] },
  // B-W2b-308: Move & put away (SCR-177), after Receive.
  { id: 'floor.move', title: 'Move & put away', titleIt: 'Sposta e ubica', tile: 'move', modes: ['warehouse'] },
  { id: 'floor.pick', title: 'Pick & issue', titleIt: 'Preleva e consegna', tile: 'pick', modes: ['warehouse'] },
  // B-W2b-310: Count (SCR-178), after Pick & issue (tile family Warehouse).
  { id: 'floor.count', title: 'Count', titleIt: 'Conta', tile: 'count', modes: ['warehouse'] },
  // W2a: B-W2a-76 Receive a return (SCR-180) and Subcontract kits (SCR-181).
  { id: 'floor.returnsin', title: 'Receive a return', titleIt: 'Ricevi un reso', tile: 'returnsin', modes: ['warehouse'] },
  { id: 'floor.kits', title: 'Subcontract kits', titleIt: 'Kit per terzisti', tile: 'kits', modes: ['warehouse'] },
  { id: 'floor.labels', title: 'Garment labels', titleIt: 'Etichette capo', tile: 'labels', modes: ['packing'] },
  { id: 'floor.pack', title: 'Pack', titleIt: 'Imballa', tile: 'pack', modes: ['packing'] },
  // W2b: B-W2b-115 Incoming inspection (SCR-175), tile family Quality, before Final inspection (it stays on an inspection tablet's first page).
  { id: 'floor.incoming', title: 'Incoming inspection', titleIt: 'Controllo in accettazione', tile: 'incoming', modes: ['inspection'] },
  { id: 'floor.final', title: 'Final inspection & release', titleIt: 'Collaudo finale e rilascio', tile: 'final', modes: ['inspection'] },
  // W2b: B-W2b-105 In-line inspection (SCR-176), tile family Quality; supervisor = a team leader's line tablet.
  { id: 'floor.inline', title: 'In-line inspection', titleIt: 'Controllo in linea', tile: 'inline', modes: ['inspection', 'supervisor'] },
  // W2a: B-W2a-73 the floor area Maintenance & safety, its machine problem (SCR-179); Report an incident is W2b.
  { id: 'floor.machine', title: 'Machine problem & jobs', titleIt: 'Guasto e interventi', tile: 'machine', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection', 'maintenance'] },
  // W2b: B-W2b-70 Call for help (SCR-172) and the team leader's Line view (SCR-168).
  { id: 'floor.clock', title: 'Clock in & out', titleIt: 'Timbratura', tile: 'clock', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection', 'phone'] },
  // W2b: B-W2b-68 My day (SCR-171).
  { id: 'floor.myday', title: 'My day', titleIt: 'La mia giornata', tile: 'myday', modes: ['sewing', 'phone'] },
  // W2b: B-W2b-145 Training & PPE sign-off (SCR-231), tile family Me; supervisor = a team leader's line tablet.
  { id: 'floor.training', title: 'Training & PPE sign-off', titleIt: 'Firma formazione e DPI', tile: 'training', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection', 'supervisor'] },
  // W2b: B-W2b-232 Spec & instructions (SCR-174), tile family Work, before Call for help.
  { id: 'floor.instructions', title: 'Spec & instructions', titleIt: 'Scheda e istruzioni', tile: 'instructions', modes: ['sewing', 'cutting', 'packing', 'inspection'] },
  { id: 'floor.help', title: 'Call for help', titleIt: 'Chiama aiuto', tile: 'help', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection'] },
  // W2b: B-W2b-137 Report an incident (SCR-230), tile family Maintenance & safety; kept on the first page of every Home.
  { id: 'floor.incident', title: 'Report an incident', titleIt: 'Segnala un incidente', tile: 'incident', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection', 'supervisor', 'maintenance', 'phone'] },
  { id: 'floor.supervisor', title: 'Line view', titleIt: 'Vista linea', tile: 'lineview', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection', 'supervisor'] },
]

/** B-W2b-66: the line TV has no tile: a DISPLAY device goes straight to it, nobody signs in (design floor.display, mode display). */
export const FLOOR_NO_TILE: ReadonlyArray<{ readonly id: string; readonly title: string; readonly titleIt: string; readonly href: string }> = [
  { id: 'floor.display', title: 'Line TV board', titleIt: 'Tabellone di linea', href: '/floor/display' },
]

export const LINKS: ReadonlyArray<{ readonly id: string; readonly title: string; readonly scr: readonly string[]; readonly task: string }> = [
  { id: 'links.quote', title: 'Accept a quote', scr: ['SCR-099'], task: 'quote-accept' },
  { id: 'links.document', title: 'Download a document', scr: ['SCR-101'], task: 'shipment-documents' },
  { id: 'links.po', title: 'Confirm a PO', scr: ['SCR-100'], task: 'po-confirm' },
  // W2b: B-W2b-188 Approve (an APPROVAL link's request).
  { id: 'links.approve', title: 'Approve', scr: ['SCR-198'], task: 'approve' },
  // W2b: B-W2b-181 Accept a job (a JOB_ACCEPT link's job).
  { id: 'links.job', title: 'Accept a job', scr: ['SCR-196'], task: 'job' },
  // W2b: B-W2b-198 Report a problem (a CLAIM link of a shipment or an order).
  { id: 'links.claim', title: 'Report a problem', scr: ['SCR-197'], task: 'report-problem' },
  // W2b: B-W2b-170 Track an order (a SHIPMENT_TRACK link's tracking page; the public search /t is its section).
  { id: 'links.tracking', title: 'Track an order', scr: ['SCR-194'], task: 'track-order' },
  // W2b: B-W2b-199 Pay online (a PAYMENT link's invoice or deposit; DEPOSIT_INFO opens it too as 'deposit-pay').
  { id: 'links.pay', title: 'Pay online', scr: ['SCR-199'], task: 'pay' },
  // W2b: B-W2b-171 Send measurements (a MEASUREMENTS link of a rider's measurement profile).
  { id: 'links.measure', title: 'Send measurements', scr: ['SCR-195'], task: 'measure' },
  // B-W2b-172: the supplier questionnaire (a SUPPLIER_ONBOARD link of the supplier).
  { id: 'links.onboard', title: 'Supplier questionnaire', scr: ['SCR-269'], task: 'onboard' },
  // W2b: B-W2b-169 Secure file (SECURE_FILE; the plan's SCR-200 is W1's Hides: SCR-272) and links.document's set of files.
  { id: 'links.file', title: 'Secure file', scr: ['SCR-272', 'SCR-101-set'], task: 'files' },
  // W2b: B-W2b-169 the payroll file by link (DOCUMENT_VIEW of a payroll export, hours only).
  { id: 'links.file.payroll', title: 'Payroll file', scr: ['SCR-272'], task: 'payroll-file' },
  // W2b: B-W2b-200 Join a record (a RECORD_INVITE link's shared record).
  { id: 'links.invite', title: 'Join a record', scr: ['SCR-270'], task: 'invite' },
]

/**
 * B-W2b-203: the tree's link pages that open with no token, so no link task (the label's QR, a typed code): their own
 * addresses in the Links view. B-W2b-166 the public DoC (`/doc` Type the code, `/doc/<code>` the declaration).
 */
export const LINKS_NO_TOKEN: ReadonlyArray<{ readonly id: string; readonly title: string; readonly titleIt: string; readonly scr: readonly string[]; readonly hrefs: readonly string[] }> = [
  { id: 'links.doc', title: 'Public DoC', titleIt: 'DoC pubblica', scr: ['SCR-102'], hrefs: ['/doc', '/doc/[code]'] },
]

export const FRAME: ReadonlyArray<{ readonly id: string; readonly title: string; readonly titleIt: string; readonly href: string }> = [
  { id: 'shell.profile', title: 'My profile', titleIt: 'Il mio profilo', href: '/me' },
]
