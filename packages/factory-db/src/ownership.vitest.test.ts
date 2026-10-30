import { describe, expect, it } from 'vitest'
import { FISCAL_KINDS, FLOOR_DOCUMENT_KINDS } from '@nexus/factory-domain/numbering/kinds'
import { checkOwnership, OwnershipError, partnerWalledColumns, policyInputs, type OwnershipFile } from './ownership'
import { TENANT_ID_DEFAULT } from './roles'
import { parseSchema } from './schema-models'
import { loadOwnership, loadSchema } from './tools'

/** The real classification, deep-copied so a test can plant a mistake in it. */
const copy = (): { file: string; data: { models: Record<string, Record<string, any>> } }[] =>
  structuredClone(loadOwnership()) as never
const problems = (files: readonly OwnershipFile[], models = loadSchema()) => checkOwnership(models, files)
const core = (files: ReturnType<typeof copy>) => files.find((file) => file.file === '_core.json')!.data.models

describe('model ownership', () => {
  it('classifies every model of the schema, consistently', () => {
    expect(problems(loadOwnership())).toEqual([])
    const inputs = policyInputs(loadSchema(), loadOwnership())
    expect(inputs.model.tables.map((table) => table.table).sort()).toEqual([
      'Alert',
      'AlertEvent',
      'AlertRule',
      'AttentionAction',
      'AttentionActionLog',
      'AuditLog',
      'Badge',
      'BomLine',
      'BomLineColour',
      'BomLineSize',
      'Bundle',
      'BundleReprint',
      'CalendarDay',
      'Certificate',
      'CertificateCoverage',
      'Colour',
      'Colourway',
      'Company',
      'ComplianceDocument',
      'CostingSettings',
      'CutLog',
      'CutLogPiece',
      'Ddt',
      'DdtCancellation',
      'DepositRequest',
      'Device',
      'DeviceEnrolment',
      'DueTimer',
      'EmailIdentity',
      'EmailOutbound',
      'ExportJob',
      'FloorRefusedAction',
      'FloorScanRefusal',
      'FloorSession',
      'FloorSettings',
      'FloorSyncEvent',
      'GarmentLabelPrint',
      'GarmentSerial',
      'GoodsReceipt',
      'GoodsReceiptLine',
      'Hide',
      'IdempotencyReceipt',
      'ImportJob',
      'ImportRow',
      'InboundEmail',
      'InboundWebhook',
      'Inspection',
      'InspectionDefect',
      'IntegrationAccount',
      'IntegrationCall',
      'Invitation',
      'Invoice',
      'InvoiceLine',
      'Item',
      'ItemColour',
      'LabResult',
      'LabelTemplate',
      'LabourRate',
      'Line',
      'LinkEvidence',
      'Location',
      'Lot',
      'LotDocument',
      'MaterialRequirement',
      'MeasurementPoint',
      'MeasurementProfile',
      'MeasurementTemplate',
      'Message',
      'MessageMention',
      'Notification',
      'NotificationDelivery',
      'NumberAllocation',
      'NumberBlock',
      'NumberBlockUse',
      'NumberSeries',
      'OneOffLink',
      'Operation',
      'OperationScan',
      'OperationScanDefect',
      'OutboxEvent',
      'Parcel',
      'Party',
      'PartyAddress',
      'PartyContact',
      'PartyTaxIdentity',
      'PasswordReset',
      'Payment',
      'PaymentAllocation',
      'PlanningRun',
      'PpeRegisterEntry',
      'PrintJob',
      'Printer',
      'PrivacyDpia',
      'PrivacyNotice',
      'PrivacyNoticeText',
      'ProcessingActivity',
      'ProductionSettings',
      'PurchaseOrder',
      'PurchaseOrderLine',
      'QualityRelease',
      'QualityReleaseReversal',
      'QualitySettings',
      'Quote',
      'QuoteAcceptance',
      'QuoteApproval',
      'QuoteLine',
      'QuoteLineSize',
      'QuoteVersion',
      'ReasonCode',
      'RecordFollower',
      'ReportSubscription',
      'RestoreDrill',
      'Role',
      'RoleAssignment',
      'RoutingOperation',
      'SalesOrder',
      'SalesOrderLine',
      'SalesOrderLineSize',
      'SalesSettings',
      'SavedView',
      'ScanCorrectionRequest',
      'ScrapReason',
      'SdiNotification',
      'SdiSubmission',
      'SearchEntry',
      'SecretValue',
      'Session',
      'ShiftPattern',
      'ShiftSegment',
      'Shipment',
      'ShipmentLine',
      'ShippingSettings',
      'Site',
      'Size',
      'SizeScale',
      'StaffNoticeAck',
      'Station',
      'StockMove',
      'StockValuation',
      'StoredFile',
      'Style',
      'StyleRevision',
      'Suppression',
      'Task',
      'Tenant',
      'Thread',
      'TodayLayout',
      'TrackingEvent',
      'User',
      'Variant',
      'ViesCheck',
      'WorkCalendar',
      'WorkCentre',
      'WorkOrder',
      'WorkOrderMaterial',
      'WorkOrderOperation',
      'WorkOrderSize',
      'Worker',
      'WorkerNoticeAck',
      'WorkerRole',
    ])
    expect(inputs.platformTables).toEqual([{ table: 'Tenant', privileges: ['select', 'insert', 'update'], walled: true }])
  })

  it('fails on an unclassified model and names the file to classify it in', () => {
    const schema = [
      ...loadSchema(),
      ...parseSchema([{ file: 'example.prisma', text: 'model Example { id String @id @db.Uuid\n tenantId String @db.Uuid }' }]),
    ]
    expect(problems(loadOwnership(), schema)).toEqual([
      expect.stringMatching(/^prisma\/schema\/example\.prisma: model Example is not classified; add it to ownership\/example\.json/),
    ])
  })

  it('fails on a classification without a model, or in the wrong file', () => {
    const files = copy()
    core(files).Ghost = { kind: 'tenant', keyColumns: { tenant: 'tenantId' }, access: { factory_runtime: { privileges: ['select'] } } }
    files.push({ file: 'example.json', data: { models: { Company: core(files).Company! } } })
    expect(problems(files)).toEqual(
      expect.arrayContaining([
        'ownership/_core.json: Ghost is not a model of prisma/schema/*.prisma',
        'ownership/example.json: Company is classified twice (also in ownership/_core.json)',
      ]),
    )
  })

  type Plant = [label: string, plant: (models: Record<string, Record<string, any>>) => void, expected: RegExp]
  it.each<Plant>([
    ['an unknown kind', (m) => (m.Line!.kind = 'shared'), /Line: kind must be "tenant" or "platform"/],
    ['an unknown key in a model', (m) => (m.Line!.owner = 'x'), /Line: unknown key "owner"/],
    ['an unknown role', (m) => (m.Line!.access.factory_admin = { privileges: ['select'] }), /factory_admin is not a runtime role/],
    ['an unknown privilege', (m) => (m.Line!.access.factory_runtime.privileges = ['select', 'truncate']), /privileges must list some of/],
    ['a hidden column that does not exist', (m) => (m.Company!.access.factory_floor_runtime.hiddenColumns = ['noSuchColumn']), /hidden column noSuchColumn is not a column/],
    ['a key column that does not exist', (m) => (m.Line!.keyColumns.site = 'plantId'), /key column plantId is not a column/],
    ['a site column without the site key', (m) => delete m.Line!.keyColumns.site, /it has a siteId column, so keyColumns.site must be "siteId"/],
    ['the floor role unscoped on a site table', (m) => delete m.Station!.access.factory_floor_runtime.scopedBy, /the floor role must be scopedBy site/],
    ['the partner role without a party scope', (m) => (m.Company!.access.factory_partner_runtime = { privileges: ['select'] }), /the partner role must be scopedBy party/],
    ['a scope key the role does not set', (m) => (m.Line!.access.factory_runtime.scopedBy = ['site']), /scopedBy site, which factory_runtime's scope does not set/],
    ['the platform role on a tenant table', (m) => (m.Company!.access.factory_platform = { privileges: ['select'] }), /factory_platform reaches only platform models/],
    ['a tenant table keyed on another column', (m) => (m.Company!.keyColumns.tenant = 'id'), /a tenant model needs keyColumns.tenant = "tenantId"/],
    ['a platform table without the platform role', (m) => delete m.Tenant!.access.factory_platform, /a platform model is for factory_platform/],
    ['a runtime role on a platform table without the wall', (m) => delete m.Tenant!.keyColumns.tenant, /no column for the tenant wall/],
    ['a role with no privileges', (m) => (m.Site!.access.factory_runtime.privileges = []), /privileges must list some of/],
    ['a value filter on a column it lacks', (m) => (m.Line!.access.factory_floor_runtime.onlyValues = { kind: ['A'] }), /onlyValues names kind, which is not a column of Line/],
    ['a value filter with no value', (m) => (m.Line!.access.factory_floor_runtime.onlyValues = { code: [] }), /onlyValues.code must list at least one value/],
    ['a value filter on the platform role', (m) => (m.Tenant!.access.factory_platform.onlyValues = { slug: ['a'] }), /factory_platform takes no onlyValues/],
  ])('fails on %s', (_label, plant, expected) => {
    const files = copy()
    plant(core(files))
    expect(problems(files)).toEqual(expect.arrayContaining([expect.stringMatching(expected)]))
  })

  it('fails on a tenant model whose tenantId is not the standard walled column', () => {
    const schema = loadSchema().map((model) =>
      model.name !== 'Line'
        ? model
        : { ...model, fields: model.fields.map((field) => (field.name === 'tenantId' ? { ...field, defaultValue: undefined } : field)) },
    )
    expect(problems(loadOwnership(), schema)).toEqual([expect.stringMatching(/Line: tenantId must have @default\(dbgenerated\(/)])
  })

  it('fails on a platform model with a tenantId column', () => {
    const files = copy()
    core(files).Line!.kind = 'platform'
    core(files).Line!.access.factory_platform = { privileges: ['select'] }
    expect(problems(files)).toEqual(expect.arrayContaining([expect.stringMatching(/Line: a platform model has no tenantId column/)]))
  })

  it('passes on what db-kit refuses only after the generator ran, and reports it', () => {
    const files = copy()
    // Hiding the floor role's own policy column passes the factory rules, but the generator refuses it.
    core(files).Line!.access.factory_floor_runtime.hiddenColumns = ['siteId']
    expect(problems(files)).toEqual([expect.stringMatching(/^the policy generator refuses the classification: .*cannot hide siteId/)])
  })

  it("keeps the floor to the series and numbers of the floor's document kinds, none of them fiscal", () => {
    const numbering = loadOwnership().find((file) => file.file === 'numbering.json')!.data as { models: Record<string, { access: Record<string, { onlyValues?: Record<string, string[]> }> }> }
    for (const model of ['NumberSeries', 'NumberAllocation']) {
      const kinds = numbering.models[model]!.access.factory_floor_runtime!.onlyValues!.kind!
      expect([...kinds].sort(), model).toEqual([...FLOOR_DOCUMENT_KINDS].sort())
      expect(kinds.filter((kind) => (FISCAL_KINDS as readonly string[]).includes(kind)), model).toEqual([])
      expect(numbering.models[model]!.access.factory_runtime!.onlyValues, model).toBeUndefined()
    }
    const table = policyInputs(loadSchema(), loadOwnership()).model.tables.find((entry) => entry.table === 'NumberSeries')!
    expect(table.access.factory_floor_runtime).toEqual({ privileges: ['select', 'insert', 'update'], onlyValues: { kind: [...FLOOR_DOCUMENT_KINDS] } })
  })

  it('policyInputs throws every problem at once', () => {
    const files = copy()
    core(files).Line!.kind = 'shared'
    core(files).Site!.access.factory_admin = { privileges: ['select'] }
    expect(() => policyInputs(loadSchema(), files)).toThrow(OwnershipError)
    try {
      policyInputs(loadSchema(), files)
    } catch (error) {
      expect((error as OwnershipError).violations).toHaveLength(2)
    }
  })

  describe('the partner wall (A1 §2.2)', () => {
    const quotes = parseSchema([
      {
        file: 'example-quotes.prisma',
        text: [
          'model ExampleQuote {',
          '  id           String @id @db.Uuid',
          `  tenantId     String @default(dbgenerated(${JSON.stringify(TENANT_ID_DEFAULT)})) @db.Uuid`,
          '  partyId      String @db.Uuid',
          '  /// The total the customer pays.',
          '  /// @grain price',
          '  totalMinor   Int',
          '  /// @grain cost',
          '  costMinor    Int',
          '  /// @grain margin',
          '  marginMinor  Int',
          '  /// For the office only.',
          '  /// @internal',
          '  internalNote String?',
          '}',
        ].join('\n'),
      },
    ])
    const classify = (hiddenColumns: string[]): OwnershipFile => ({
      file: 'example-quotes.json',
      data: {
        models: {
          ExampleQuote: {
            kind: 'tenant',
            keyColumns: { tenant: 'tenantId', party: 'partyId' },
            access: {
              factory_runtime: { privileges: ['select'] },
              factory_partner_runtime: { privileges: ['select'], scopedBy: ['party'], hiddenColumns },
            },
          },
        },
      },
    })

    it('finds the cost, margin, wages and internal-note columns from the schema markers; prices stay readable', () => {
      expect(partnerWalledColumns(quotes[0]!)).toEqual([
        { column: 'costMinor', why: 'a cost (@grain cost)' },
        { column: 'marginMinor', why: 'a margin (@grain margin)' },
        { column: 'internalNote', why: 'an internal note (@internal)' },
      ])
    })

    it('fails on a partner access that does not hide them, naming each column', () => {
      expect(problems([...loadOwnership(), classify([])], [...loadSchema(), ...quotes])).toEqual([
        'ownership/example-quotes.json: ExampleQuote: factory_partner_runtime: column costMinor is a cost (@grain cost), behind the partner wall; add it to hiddenColumns',
        'ownership/example-quotes.json: ExampleQuote: factory_partner_runtime: column marginMinor is a margin (@grain margin), behind the partner wall; add it to hiddenColumns',
        'ownership/example-quotes.json: ExampleQuote: factory_partner_runtime: column internalNote is an internal note (@internal), behind the partner wall; add it to hiddenColumns',
      ])
      expect(problems([...loadOwnership(), classify(['costMinor', 'marginMinor', 'internalNote'])], [...loadSchema(), ...quotes])).toEqual([])
    })

    it('holds on the real schema: the link note is hidden from the partner role', () => {
      const files = copy()
      const links = files.find((file) => file.file === 'links.json')!.data.models
      links.OneOffLink!.access.factory_partner_runtime.hiddenColumns = ['createdById', 'revokedById']
      expect(problems(files)).toEqual([expect.stringMatching(/OneOffLink: factory_partner_runtime: column note is an internal note \(@internal\)/)])
      const oneOffLink = loadSchema().find((model) => model.name === 'OneOffLink')!
      expect(partnerWalledColumns(oneOffLink)).toEqual([{ column: 'note', why: 'an internal note (@internal)' }])
    })
  })
})
