import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { useAbuseGuard } from '../../platform/abuse/guard'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../platform/auth/portal/testing/portal'
import { fakeScanner } from '../../platform/files/scan/fake'
import { useScanner } from '../../platform/files/scan/service'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { Browser } from '../../platform/auth/sessions/testing/harness'
import { admin, announce, call, floorWorker, linkTokenSentTo, ok, pdf, person, putBytes, QUIET, sha256, signOn, startWorld, stepped, tablet, type FloorWorker, type Person, type World } from '../testing/world'
import { assertEveryHandler, everyHandler, searchIndexers, settler } from '../daily/testing/day'

/**
 * The W2b-4 golden flow (B-W2b-273; design check I9): a style from concept to release with a change order, a sample round
 * decided by the brand, a DoC and a label checked for a market, a recall, THROUGH THE HTTP ROUTES, each act by the person who
 * does it, on the seeded factory; product and compliance records cross styles, production, sales, purchasing, quality and the
 * portal, and the flow proves they agree:
 *
 *   S  the style: made from a product type, names in two languages, a graded measurement spec, a BOM with a sub-assembly, an
 *      alternate and an option, a routing whose SMV change is approved by a second person (the proposer cannot), a packing
 *      instruction published by a second person (its author cannot).
 *   R  the release gate's checklist; the revision released for the two colourways a certificate covers (the third waits).
 *   O  the brand's order, delivered to its German warehouse.
 *   M  a pre-production round: its sample work order from the order line, the sample sent and received, its fit measured
 *      against the approved spec, the brand's decision by link.
 *   G  the pre-production gate: the production work order waits for it on the board, the sample work order never does (F22);
 *      its maker may not start before it; the brand's decision passes it.
 *   L  markets and phrases: Germany's languages, a care phrase translated (approved by a second inspector), Germany's
 *      user-information and label-language requirements; the label check refuses print for the missing German.
 *   C  a change request becomes a change order (the German label, more wastage), the work in progress decided (the sample
 *      finishes on the old revision, the production work order held), approved by another person, released.
 *   P  the brand's next order on revision 2: the label check passes; the release refused on a missing requirement (no German
 *      user information) until the inspector files it.
 *   F  the floor: hides of two dye lots received and released; site A1 cuts without the shade rule (B1 keeps it); the packing
 *      instruction opens before Start and is seen once, its required step ticked; the packing rule opens the final inspection
 *      with no inspector; the label artwork approved by a second person; labels printed, a torn one logged and reprinted.
 *   D  the DoC generated and translated (a draft while GATE-PPE-TEXTS is closed; the German words checked by a third person);
 *      the signed DoC and the batch recorded: the public page of the batch shows them.
 *   U  the tannery's portal: the leather's AZO rule asks a declaration, answered in the supplier portal and accepted.
 *   T  the technical file and an evidence pack of the batch sent to the brand by a link with a password.
 *   K  a recall of the batch from the register's trace: held, started, its notice first on the public page.
 *   X  the brand's tech pack copy has no cost; another customer finds neither the private-label style nor the copy; no cost,
 *      margin or pay key in any answer a partner, a link holder or the public got.
 *
 * World: the W1 golden world (../testing/world.ts: a throwaway PostgreSQL 17 database from the migrations, EVERY base seed plus
 * the W1 golden scenario, the real app with the real sign-in, every outside provider FAKE: mail, carrier, SDI, the virus
 * scanner) and the W2a day's worker (../daily/testing/day.ts: EVERY handler list of background.ts, run in-process by the real
 * outbox relay); the public routes' abuse guard on an in-memory store of the harness clock, each partner on a network of its
 * own. SQL only reads ids and asserts: no step is made by SQL. GATE-PPE-TEXTS stays closed and no switched-off rule is switched
 * on (Owner, answers B and Q5 A). Every name, address and figure is made up. Run with `node scripts/factory/golden-flow.mjs
 * product`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
type Role = 'owner' | 'admin' | 'manager' | 'manager2' | 'inspector' | 'inspector2' | 'sales' | 'planner' | 'supervisor' | 'warehouse' | 'buyer'
const P = {} as Record<Role, Person>
/** What the flow made, step by step. */
const G = {} as Record<string, any>
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
/** Every record the flow made: the end checks look for their audit rows. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((recordId) => recordId && made.add(recordId))
const id = (key: string) => w.id(key)
/** A seed row written with the seeds' firstId (ids that start with eight zeros) or lastId (eight f's). */
const first = (key: string) => `00000000${w.id(key).slice(8)}`
const last = (key: string) => `ffffffff${w.id(key).slice(8)}`
const companyA = () => id('company:A')
const today = () => businessDate(new Date())
const pathsOf = (error: Json): string[] => ((error?.error?.issues ?? []) as Json[]).map((issue) => String(issue.path))
const refusalOf = (error: Json): string | undefined => pathsOf(error).find((path) => path.startsWith('refusal/'))

/** The style's draft revision URL. */
const revisionUrl = (revisionId: string = G.revision.id) => `/product/styles/${G.style.id}/revisions/${revisionId}`
/** The newest version of the draft revision (a revision's BOM and routing are one versioned record). */
async function revisionVersion(revisionId: string = G.revision.id): Promise<number> {
  return (await ok(P.manager, 'GET', `${revisionUrl(revisionId)}/bom`)).bom.revision.version as number
}

/** A link holder's call (the token in `x-factory-link`, never a cookie): the answer kept for the scan. */
async function linkCall(token: string, method: 'GET' | 'POST', url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const answer = await call(new Browser(w.h.app), method, url, body, { 'x-factory-link': token, ...headers })
  expect(answer.status, `link ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  seen.push({ who: 'link', url, body: answer.body })
  return answer.body
}

/** The planner releases a work order: its checklist read first; a material short of stock is released over with a reason. */
async function release(who: Person, workOrderId: string): Promise<Json> {
  const { workOrder } = await ok(who, 'GET', `/production/work-orders/${workOrderId}`)
  const check = await ok(who, 'GET', `/production/work-orders/${workOrderId}/release-check`)
  const blockers = (check.blockers ?? []) as Json[]
  expect(blockers.filter((entry) => !String(entry.path).startsWith('materials/')), JSON.stringify(blockers)).toEqual([])
  const short = blockers.length > 0
  return (await ok(who, 'POST', `/production/work-orders/${workOrderId}/release`, { version: workOrder.version, ...(short ? { materialOverride: { reason: 'The leather is promised to older orders; the next lot comes first (made up).' } } : {}) })).workOrder
}

// ---- partners, links and the public: every answer kept for the key scan ---------------------------------------------------------

interface Partner {
  readonly key: string
  readonly partyId: string
  readonly email: string
  readonly browser: Browser
}
const R = {} as Record<'tannery' | 'brand' | 'other', Partner>
/** Every answer a partner, a link holder or the public got: no cost, margin or pay key in any of them (X01). */
const seen: { readonly who: string; readonly url: string; readonly body: unknown }[] = []
let network = 40

/** A partner's call (its portal cookie and the office CSRF): the answer kept for the scan. */
async function as(partner: Partner, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(partner.browser, method, url, body)
  expect(answer.status, `${partner.key} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  seen.push({ who: partner.key, url, body: answer.body })
  return answer.body
}

/** A public call (no cookie, no token) from a network of its own: the answer kept for the scan. */
async function anyone(method: 'GET' | 'POST', url: string, payload?: Json, status = 200): Promise<Json> {
  const response = await w.h.app.inject({ method, url, remoteAddress: '198.51.100.9', ...(payload === undefined ? {} : { payload }) })
  const body = response.json()
  expect(response.statusCode, `public ${method} ${url}: ${response.body.slice(0, 400)}`).toBe(status)
  seen.push({ who: 'public', url, body })
  return body
}

async function partnerOf(key: string, partyId: string, email: string): Promise<Partner> {
  return { key, partyId, email, browser: await portalBrowser(w.h, `203.0.113.${++network}`) }
}

/** The portal sign-in by the mailed code, then the first visit: the portal terms in force acknowledged. */
async function signIn(partner: Partner): Promise<void> {
  expect((await call(partner.browser, 'POST', '/portal/signin/start', { tenant: w.tenant.slug, company: 'SCA', email: partner.email })).status).toBe(200)
  await w.h.auth.settled()
  await as(partner, 'POST', '/portal/signin/code', { tenant: w.tenant.slug, company: 'SCA', email: partner.email, code: mailedCode(w.h, partner.email)!.code })
  const terms = await as(partner, 'GET', '/portal/terms?locale=en')
  await as(partner, 'POST', '/portal/first-visit', { noticeId: terms.notice.id, noticeLocale: terms.notice.locale, sha256: terms.notice.sha256 })
  const me = await as(partner, 'GET', '/portal/me')
  expect(me).toMatchObject({ termsDue: false, party: { id: partner.partyId } })
  keep(me.user.id)
}

/** The office opens a party's portal (step-up; version 0 when it has no settings yet). */
async function openPortal(who: Person, partyId: string, change: Json = {}): Promise<void> {
  const tab = await ok(who, 'GET', `/partners/${partyId}`)
  await stepped(w, who)
  await ok(who, 'POST', `/partners/${partyId}/settings`, { portalOn: true, version: tab.settings?.version ?? 0, ...change })
}
async function invite(who: Person, partner: Partner, body: Json): Promise<void> {
  await stepped(w, who)
  const invited = await ok(who, 'POST', `/partners/${partner.partyId}/people`, { email: partner.email, displayName: body.displayName, locale: 'en', companyId: companyA(), ...body })
  expect(invited).toMatchObject({ delivery: 'sent', invitation: { email: partner.email } })
}

/** Every key of an answer, at any depth. */
function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, into)
  else if (value && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      into.push(key)
      keysOf(entry, into)
    }
  return into
}
/** A cost, margin or pay key: never in a partner, link or public answer, nor in a partner's copy of the tech pack. */
const NEVER = (key: string) => /cost|margin|wage|salary|earning|pieceRate|payroll|payslip/i.test(key) || /^pay([A-Z_]|$)/.test(key)

/** A made-up PNG (the local store keeps bytes; nothing decodes them). */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('made-up golden photo')])

/** A file of a record through the real routes: announced, its bytes sent to the presigned URL, completed. */
async function upload(who: Person, owner: Json, name: string, body: Buffer = pdf(name), kind = 'DOCUMENT', contentType = 'application/pdf'): Promise<string> {
  const announced = await ok(who, 'POST', '/files', { companyId: companyA(), kind, ...owner, originalName: name, contentType, sizeBytes: body.length, sha256: sha256(body) }, 201)
  await putBytes(w, announced, body)
  expect((await ok(who, 'POST', `/files/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
  return announced.file.id as string
}

const SIZES = ['50', '52', '54'] as const
const POINT = { CHEST_W: () => first('sizes:pom:CHEST_W'), BACK_LEN: () => id('sizes:pom:BACK_LEN'), SLEEVE_LEN: () => id('sizes:pom:SLEEVE_LEN') }

// ---- the event types the flow must leave behind (Z1) --------------------------------------------------------------------------

const EVENTS = [
  // S: the style
  'style.created',
  'style.texts_changed',
  'style.lifecycle_changed',
  'style.measurement_spec_changed',
  'smv_version.changed',
  'operation.smv_changed',
  'production.instruction_changed',
  'production.instruction_published',
  // R: the release
  'style.revision_released',
  // O, M, G: the order, the sample round, the gate
  'sales_order.created',
  'sample_round.requested',
  'sample_round.changed',
  'sample_shipment.changed',
  'sample_round.fit_changed',
  'sample_round.asked',
  'sample_round.decided',
  'order_gate.changed',
  // L, C, P: markets and phrases, the change order, the production work order
  'compliance_gates.requirement_changed',
  'compliance_gates.refused',
  'change_request.raised',
  'change_request.changed',
  'change_order.changed',
  // F: the floor
  'production.cutting_rules_changed',
  'production.instruction_acknowledged',
  'inspection_trigger.inspection_opened',
  'label_reconciliation.logged',
  'production.checklist_step_ticked',
  // D, U, T, K: the DoC, the declaration asked, the technical file, the recall
  'compliance_declarations.draft_changed',
  'compliance_declarations.translation_changed',
  'compliance_declarations.batches_recorded',
  'compliance_material_tests.declaration_asked',
  'compliance_material_tests.declaration_decided',
  'supplier_document.uploaded',
  'technical_file.pack_requested',
  'technical_file.pack_changed',
  'recall.changed',
]

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  // The portal's codes are refused by the database once past their end in REAL time (factory_portal_code_guard reads now()):
  // the harness clock starts at now (no month-end check here), as the portal suite's.
  w.h.clock.set(new Date())
  freshGuard(w.h)
  usePortalOptions({ answerFloorMs: 0 })
  useScanner(fakeScanner())
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['manager', 'production_manager'],
    ['manager2', 'production_manager'],
    ['inspector', 'quality_inspector'],
    ['inspector2', 'quality_inspector'],
    ['sales', 'sales'],
    ['planner', 'planner'],
    ['supervisor', 'floor_supervisor'],
    ['warehouse', 'warehouse'],
    ['buyer', 'buyer'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  useScanner(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

// One step may take a while on a loaded machine (a step renders PDFs, runs the worker).
describe('the W2b-4 golden flow: a style from concept to release with a change order, a sample round decided by the brand, a DoC and a label checked for a market, a recall, through the HTTP routes', { timeout: 180_000 }, () => {
  it('00 the world: the worker runs every handler list of background.ts; the seeds drain', async () => {
    assertEveryHandler()
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  // ---- S: the style ----------------------------------------------------------------------------------------------------------

  it('S01 the production manager makes a style from the jacket product type (its scale, label, PPE defaults), names it in Italian and English, and moves it into development', async () => {
    const types = (await ok(P.manager, 'GET', '/product/types')).types as Json[]
    const jacket = types.find((row) => row.code === 'SEED-PT-JKT')!
    expect((jacket.effective.requiredAttributes as Json[]).map((entry) => entry.name)).toEqual(['gender', 'hsCode', 'originCountry'])
    const { style } = await ok(
      P.manager,
      'POST',
      '/product/styles',
      {
        companyId: companyA(),
        code: 'GF4-JKT-01',
        name: 'Golden W2b-4 touring jacket',
        productType: 'JACKET',
        productTypeProfileId: jacket.id,
        season: 'FW27',
        brandPartyId: id('party:P1'),
        sizes: [...SIZES],
        baseSize: '52',
        hsCode: '42031000',
        originCountry: 'IT',
        colourways: [
          { code: 'BLK', name: 'Nero', colourId: id('product:colour:BLK') },
          { code: 'RED', name: 'Rosso', colourId: id('product:colour:RED') },
          { code: 'GRY', name: 'Grigio', colourId: id('product:colour:GRY') },
        ],
        generateSkus: true,
      },
      201,
    )
    G.style = style
    G.colourways = Object.fromEntries((style.colourways as Json[]).map((colourway) => [colourway.code, colourway]))
    keep(style.id)
    // The type's defaults fill what the body left out: its size scale and its PPE category, standard and class.
    expect(style).toMatchObject({ ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-4:2020', ppeClass: 'A' })
    expect(JSON.stringify(style)).toContain(id('product:size-scale:EU-JKT'))
    // The type requires gender, HS code and origin: gender is still missing (a warning on the release checklist, never a refusal).
    const typed = await ok(P.manager, 'GET', `/product/styles/${style.id}/type`)
    expect(typed.styleType.missing).toEqual(['gender'])

    // Names in two languages, through the texts (they win over W1's names for every reader).
    for (const [language, name, short] of [
      ['it', 'Giacca touring Golden W2b-4', 'Giacca in pelle con imbottitura removibile.'],
      ['en', 'Golden W2b-4 touring jacket', 'Leather jacket with a removable liner.'],
    ] as const) {
      const written = await ok(P.manager, 'PUT', `/product/styles/${style.id}/texts/${language}`, { name, shortDescription: short })
      expect(written).toBeDefined()
    }
    const { texts } = await ok(P.manager, 'GET', `/product/styles/${style.id}/texts?language=it`)
    expect(texts.resolved).toMatchObject({ language: 'it', name: 'Giacca touring Golden W2b-4' })
    // A second write of a language without its version is refused (409), never a silent overwrite.
    await ok(P.manager, 'PUT', `/product/styles/${style.id}/texts/en`, { name: 'Overwritten?' }, 409)

    // The private label: the brand's only.
    const { privateLabel } = await ok(P.manager, 'GET', `/product/styles/${style.id}/private-label`)
    expect(privateLabel).toMatchObject({ shownTo: 'BRAND_ONLY', declarationSender: 'BRAND', brand: { id: id('party:P1') } })

    const { revision } = await ok(P.manager, 'POST', `/product/styles/${style.id}/revisions`, { changeNote: 'First revision of the W2b-4 golden jacket' }, 201)
    G.revision = revision
    keep(revision.id)
    const { lifecycle } = await ok(P.manager, 'GET', `/product/styles/${style.id}/lifecycle`)
    expect(lifecycle.style.lifecycle).toBe('CONCEPT')
    // Not into production before a released revision (never offered, or refused in words).
    expect(lifecycle.moves.find((move: Json) => move.to === 'IN_PRODUCTION')?.allowed ?? false).toBe(false)
    const moved = (await ok(P.manager, 'POST', `/product/styles/${style.id}/lifecycle`, { version: lifecycle.style.version, to: 'DEVELOPMENT' })).lifecycle
    expect(moved.style.lifecycle).toBe('DEVELOPMENT')
  })

  it('S02 the graded measurement spec: three points typed at the base size, graded by the jacket rule, approved complete by the person who releases', async () => {
    const url = `${revisionUrl()}/measurement-spec`
    let spec = (await ok(P.manager, 'POST', url, { baseSize: '52' }, 201)).spec
    spec = (
      await ok(P.manager, 'POST', `${url}/points`, {
        version: spec.spec.version,
        points: [
          { pointOfMeasureId: POINT.CHEST_W(), nominal: '58' },
          { pointOfMeasureId: POINT.BACK_LEN(), nominal: '72' },
          { pointOfMeasureId: POINT.SLEEVE_LEN(), nominal: '64' },
        ],
      })
    ).spec
    expect(spec.missing.map((entry: Json) => entry.code).sort()).toEqual(['BACK_LEN', 'CHEST_W', 'SLEEVE_LEN'])
    // REFUSAL: an incomplete spec is not approved.
    const gap = await ok(P.manager, 'POST', `${url}/approve`, { version: spec.spec.version }, 400)
    expect(gap.error.message).toMatch(/^The measurement spec is not complete/)
    const preview = (await ok(P.manager, 'POST', `${url}/grade/preview`, { ruleId: first('sizes:grade-rule:JKT') })).preview
    expect(preview.counts.ADD).toBeGreaterThan(0)
    spec = (await ok(P.manager, 'POST', `${url}/grade`, { version: spec.spec.version, ruleId: first('sizes:grade-rule:JKT') })).spec
    expect(spec.missing).toEqual([])
    const graded = (spec.points as Json[]).flatMap((point) => (point.cells as Json[]).filter((cell) => cell.size !== '52').map((cell) => cell.value?.source ?? cell.source))
    expect(graded.every((source) => source === 'GRADED')).toBe(true)
    spec = (await ok(P.manager, 'POST', `${url}/approve`, { version: spec.spec.version })).spec
    expect(spec.spec).toMatchObject({ status: 'APPROVED', approvedById: P.manager.id })
    G.spec = spec.spec
    keep(spec.spec.id)
  })

  it('S03 the BOM: leather by colourway and size, a lining with an alternate for when it is short, the protectors, and the removable liner as a sub-assembly offered as an option', async () => {
    let version = await revisionVersion()
    const line = async (body: Json) => {
      const { bom } = await ok(P.manager, 'POST', `${revisionUrl()}/bom/lines`, { version, ...body }, 201)
      version = bom.revision.version
      return bom
    }
    await line({
      itemId: id('product:item:leather'),
      placement: 'Outer shell',
      uom: 'FT2',
      wastagePct: '5',
      sizeDependent: true,
      sizes: SIZES.map((size, index) => ({ size, qty: String(20 + index) })),
      colourDependent: true,
      colours: [
        { colourwayId: G.colourways.BLK.id, itemColourId: id('product:item-colour:leather:BLK') },
        { colourwayId: G.colourways.RED.id, itemColourId: id('product:item-colour:leather:RED') },
        // The grey jacket takes the black hide (its panels are grey textile).
        { colourwayId: G.colourways.GRY.id, itemColourId: id('product:item-colour:leather:BLK') },
      ],
    })
    await line({ itemId: id('product:item:lining'), placement: 'Body lining', qty: '1.8', uom: 'M', wastagePct: '5', itemColourId: id('product:item-colour:lining:GRY') })
    await line({ itemId: id('product:item:protector'), placement: 'Shoulder pockets', qty: '2', uom: 'PCS' })
    const bom = await line({ itemId: id('options:item:CMP-500'), placement: 'Zipped-in thermal liner', qty: '1', uom: 'PCS' })
    const lines = Object.fromEntries((bom.lines as Json[]).map((entry) => [entry.item.code, entry]))
    G.lines = lines
    version = (await ok(P.manager, 'PATCH', revisionUrl(), { version, plannedHideYieldPct: '75' })).bom.revision.version

    // The alternate: the airflow mesh, only when the grey mesh is short.
    const alternate = await ok(P.manager, 'POST', `${revisionUrl()}/bom/lines/${lines['SEED-LIN-200'].id}/alternates`, { version, itemId: id('options:item:LIN-210'), allowedWhen: 'WHEN_SHORT' }, 201)
    version = await revisionVersion()
    expect(alternate).toBeDefined()
    // REFUSAL: a sub-assembly line takes the component we make, never a bought material.
    const wrong = await ok(P.manager, 'PUT', `${revisionUrl()}/bom/lines/${lines['SEED-LIN-200'].id}/structure`, { version, subAssembly: { styleId: id('options:style:LNR-01'), revisionId: last('options:revision:LNR-01:1') } }, 400)
    expect(pathsOf(wrong)).toEqual(['body/subAssembly/styleId'])
    // The sub-assembly: the liner made here, its released revision 1.
    const structure = (await ok(P.manager, 'PUT', `${revisionUrl()}/bom/lines/${lines['SEED-CMP-500'].id}/structure`, { version, section: 'INSULATION', subAssembly: { styleId: id('options:style:LNR-01'), revisionId: last('options:revision:LNR-01:1') } })).structure
    expect(structure.tree).toEqual([expect.objectContaining({ level: 1, lineId: lines['SEED-CMP-500'].id })])
    version = structure.revision.version
    // The option: the style offers the thermal liner; the liner line is taken only when the customer picks it.
    await ok(P.manager, 'PUT', `/product/styles/${G.style.id}/options/${first('options:group:LINER')}`, { version: null })
    await ok(P.manager, 'PUT', `${revisionUrl()}/bom/lines/${lines['SEED-CMP-500'].id}/option`, { version, optionValueId: first('options:value:LINER:YES') })
    const options = await ok(P.manager, 'GET', `/product/styles/${G.style.id}/options`)
    expect(JSON.stringify(options)).toContain('SEED-OG-LINER')
    const depth = (await ok(P.manager, 'GET', `${revisionUrl()}/bom/depth`)).depth
    const lining = (depth.lines as Json[]).find((entry) => entry.id === lines['SEED-LIN-200'].id || entry.lineId === lines['SEED-LIN-200'].id)!
    expect(lining.alternates).toEqual([expect.objectContaining({ priority: 1, allowedWhen: 'WHEN_SHORT' })])
    // The BOM check: the materials hold together; only the routing is missing yet.
    const check = (await ok(P.manager, 'GET', `${revisionUrl()}/bom/check`)).check
    expect(check.blockers.map((entry: Json) => entry.code)).toEqual(['NO_STEPS'])
  })

  it('S04 the routing; the SMV of sewing changed by a time study: the proposer may not approve it, a second production manager does, and the step takes the approved version', async () => {
    const sew = id('product:operation:SEW')
    const proposal = { basicMinutes: '85', personalPct: '5', fatiguePct: '4', delayPct: '3', source: 'TIME_STUDY', effectiveFrom: today(), reason: 'Time study of twenty W2b-4 golden jackets (made up).' }
    const proposed = await ok(P.manager, 'POST', `/product/operations/${sew}/minutes/proposals`, proposal, 201)
    G.smv = proposed.versionId
    keep(G.smv)
    // REFUSAL: four eyes: the proposer never approves their own SMV.
    await ok(P.manager, 'POST', `/product/operations/${sew}/minutes/versions/${G.smv}/approve`, { version: 1 }, 403)
    const decided = await ok(P.manager2, 'POST', `/product/operations/${sew}/minutes/versions/${G.smv}/approve`, { version: 1, note: 'Matches the study.' })
    expect(decided.minutes.inForce).toMatchObject({ standardMinutes: '95.2', versionId: G.smv })

    let version = await revisionVersion()
    const { routing } = await ok(P.manager, 'POST', `${revisionUrl()}/routing/steps`, { version, operations: ['CUT', 'SEW', 'QC', 'PACK'].map((code) => ({ operationId: id(`product:operation:${code}`) })) }, 201)
    version = routing.revision.version
    const step = (routing.steps as Json[]).find((entry) => entry.operation.id === sew)!
    const minutes = await ok(P.manager, 'PUT', `${revisionUrl()}/routing/steps/${step.id}/minutes`, { version, run: { from: 'VERSION', timeVersionId: G.smv } })
    expect(minutes).toBeDefined()
    const times = await ok(P.manager, 'GET', `${revisionUrl()}/routing/times`)
    expect(JSON.stringify(times)).toContain('95.2')
  })

  it('S05 the packing instruction: written by one production manager, published by the other (the author may not), the floor’s acknowledgement asked', async () => {
    const pack = id('product:operation:PACK')
    const created = await ok(P.manager, 'POST', '/production/instructions', { companyId: companyA(), operationId: pack }, 201)
    G.instruction = created.instruction
    keep(created.instruction.id)
    const draft = created.versions[0]
    const steps = [
      { code: 'FOLD', text: { it: 'Piega la giacca con la fodera verso l’esterno.', en: 'Fold the jacket lining out.' }, icon: 'layers' },
      { code: 'LABEL_CHECK', text: { it: 'Controlla l’etichetta: taglia e lotto.', en: 'Check the label: size and batch.' }, critical: true, requiredTick: true, icon: 'check' },
    ]
    const saved = await ok(P.manager, 'PUT', `/production/instructions/${G.instruction.id}/versions/${draft.id}`, { version: draft.version, changeNote: null, acknowledgementRequired: true, steps })
    const savedVersion = saved.version.version as number
    // REFUSAL: the author does not publish their own draft.
    const own = await ok(P.manager, 'POST', `/production/instructions/${G.instruction.id}/versions/${draft.id}/publish`, { version: savedVersion }, 409)
    expect(refusalOf(own)).toBe('refusal/OWN_DRAFT')
    const published = await ok(P.manager2, 'POST', `/production/instructions/${G.instruction.id}/versions/${draft.id}/publish`, { version: savedVersion })
    expect(published.version).toMatchObject({ status: 'PUBLISHED' })
    G.instructionVersion = draft.id
  })

  // ---- R: the release --------------------------------------------------------------------------------------------------------

  it('R01 the inspector makes the garment label (Italian and English) and registers the certificate: it covers black and red, not grey', async () => {
    const { template } = await ok(
      P.inspector,
      'POST',
      '/compliance/labels',
      {
        styleId: G.style.id,
        languages: ['it', 'en'],
        composition: [
          { part: 'shell', fibres: [{ fibre: 'leather (not a textile)', percent: '100' }] },
          { part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] },
        ],
        animalOriginPhrase: true,
        care: [{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-professional' }],
        layout: { fields: ['ceMark', 'pictogram', 'standard', 'model', 'size', 'bodyMeasures', 'batchOrSerial', 'maker'] },
      },
      201,
    )
    const active = (await ok(P.inspector, 'POST', `/compliance/labels/${template.id}/activate`, { version: template.version })).template
    G.label = active
    keep(template.id)
    await ok(P.inspector, 'PUT', `${revisionUrl()}/label`, { labelTemplateId: template.id, version: await revisionVersion() })

    const certificate = (
      await ok(
        P.inspector,
        'POST',
        '/compliance/certificates',
        {
          holderPartyId: id('party:P1'),
          standard: 'EN 17092-4:2020',
          ppeClass: 'A',
          number: 'GF4-CERT-0001',
          notifiedBodyName: 'Golden Notified Body (made up)',
          notifiedBodyNumber: '0000',
          modelReference: 'GF4-JKT-01',
          validFrom: '2026-01-15',
          validTo: '2030-12-31',
        },
        201,
      )
    ).certificate
    const body = pdf('EU type-examination certificate GF4-CERT-0001')
    const announced = await ok(P.inspector, 'POST', `/compliance/certificates/${certificate.id}/pdf`, announce('certificate.pdf', body), 201)
    await putBytes(w, announced, body)
    const attached = await ok(P.inspector, 'POST', `/compliance/certificates/${certificate.id}/pdf/${announced.file.id}/complete`)
    const issued = (await ok(P.inspector, 'POST', `/compliance/certificates/${certificate.id}/issue`, { version: attached.certificate.version })).certificate
    const covered = await ok(P.inspector, 'POST', `/compliance/certificates/${certificate.id}/coverage`, { version: issued.version, styleId: G.style.id, colourwayIds: [G.colourways.BLK.id, G.colourways.RED.id] }, 201)
    G.certificate = covered.certificate
    keep(certificate.id)
  })

  it('R02 the release gate: a checklist with warnings and no blocker, grey not covered by a certificate; the release planned for black and red and released: grey waits', async () => {
    const gate = (await ok(P.manager, 'GET', `${revisionUrl()}/release-gate`)).gate
    const items = Object.fromEntries((gate.items as Json[]).map((item) => [item.code, item]))
    expect(items.CERTIFICATE).toMatchObject({ state: 'WARNING' })
    expect((items.CERTIFICATE.findings as Json[]).every((finding) => finding.code === 'CELL_NOT_COVERED' && finding.cell.colourwayId === G.colourways.GRY.id)).toBe(true)
    expect(items.ATTRIBUTES).toMatchObject({ state: 'WARNING' })
    expect(items.MEASUREMENTS).toMatchObject({ state: 'OK' })
    // Sewing takes its approved SMV; the only SMV word is the seed's cutting change that still waits for its approval.
    expect(items.SMV.state).toBe('WARNING')
    expect((items.SMV.findings as Json[]).map((finding) => [finding.code, finding.cell.recordId])).toEqual([['SMV_CHANGE_WAITING', id('product:operation:CUT')]])
    expect(gate.releasable).toBe(true)
    expect(gate.scope.suggested.colourwayIds.sort()).toEqual([G.colourways.BLK.id, G.colourways.RED.id].sort())
    const planned = await ok(P.manager, 'PUT', `${revisionUrl()}/release-scope`, { version: await revisionVersion(), colourwayIds: [G.colourways.BLK.id, G.colourways.RED.id], sizes: [] })
    expect(planned).toBeDefined()
    const released = (await ok(P.manager, 'POST', `${revisionUrl()}/release`, { version: await revisionVersion(), changeNote: 'W2b-4 golden jacket, black and red' })).bom
    expect(released.revision.status).toBe('RELEASED')
    G.revision = released.revision
    const scope = await ok(P.manager, 'GET', `/product/styles/${G.style.id}/release-scope`)
    expect(JSON.stringify(scope)).toContain('GRY')
    await settle()
    const [event] = await admin<{ payload: Json }>(w, `SELECT payload FROM "OutboxEvent" WHERE type = 'style.revision_released' AND payload->>'styleId' = $1`, [G.style.id])
    expect((event!.payload.releasedColourwayIds as string[]).sort()).toEqual([G.colourways.BLK.id, G.colourways.RED.id].sort())
  })

  // ---- O: the order ----------------------------------------------------------------------------------------------------------

  it('O01 sales adds the brand’s German warehouse and types its order: black in three sizes and red, delivered to Germany', async () => {
    const { party } = await ok(P.sales, 'POST', `/parties/${id('party:P1')}/addresses`, { kinds: ['SHIP_TO'], name: 'Seed Customer One — Lager Deutschland', line1: 'Musterweg 4', postalCode: '00000', city: 'Musterstadt', country: 'DE' }, 201)
    G.deAddress = (party.addresses as Json[]).find((entry) => entry.city === 'Musterstadt')!
    keep(G.deAddress.id)
    const { order } = await ok(
      P.sales,
      'POST',
      '/sales/orders/manual',
      {
        companyId: companyA(),
        partyId: id('party:P1'),
        customerRef: 'PO-GF4-DE-01',
        promiseDate: addDays(today(), 56),
        paymentTermsId: id('pricing:terms:BB30FM'),
        depositPct: null,
        shipToAddressId: G.deAddress.id,
        lines: [
          { styleId: G.style.id, colourwayId: G.colourways.BLK.id, unitPrice: '450', sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }, { size: '54', quantity: 1 }] },
          { styleId: G.style.id, colourwayId: G.colourways.RED.id, unitPrice: '450', sizes: [{ size: '52', quantity: 1 }] },
        ],
      },
      201,
    )
    expect(order).toMatchObject({ status: 'CONFIRMED', partyId: id('party:P1'), shipTo: { country: 'DE' } })
    G.order = order
    keep(order.id)
  })

  // ---- M: the sample round ---------------------------------------------------------------------------------------------------

  it('M01 the pre-production round for the brand: one black 52 from the order line, its sample work order made and released', async () => {
    const { round } = await ok(P.manager, 'POST', '/sales/samples/rounds', { styleId: G.style.id, companyId: companyA(), kind: 'PRE_PRODUCTION', partyId: id('party:P1'), cells: [{ colourwayId: G.colourways.BLK.id, size: '52', quantity: 1 }], dueDate: addDays(today(), 14), instructions: 'Pre-production sample in black, size 52 (made up).' }, 201)
    expect(round).toMatchObject({ stage: 'REQUESTED', kind: 'PRE_PRODUCTION', roundNo: 1 })
    G.round = round
    keep(round.id)
    const options = await ok(P.manager, 'GET', `/sales/samples/rounds/${round.id}/work-order-options`)
    const blackLine = (G.order.lines as Json[]).find((line) => line.colourwayId === G.colourways.BLK.id || line.colourway?.id === G.colourways.BLK.id)!
    expect((options.lines as Json[]).map((line) => line.id)).toContain(blackLine.id)
    const { workOrder } = await ok(P.manager, 'POST', `/sales/samples/rounds/${round.id}/work-orders`, { lines: [{ salesOrderLineId: blackLine.id }] }, 201)
    G.sampleWo = await release(P.planner, workOrder.id)
    keep(workOrder.id)
    expect(G.sampleWo).toMatchObject({ status: 'RELEASED', kind: 'SAMPLE' })
  })

  // ---- G: the pre-production gate --------------------------------------------------------------------------------------------

  it('G01 the pre-production gate on the order names the round; the production work order waits for it on the board, the sample work order never does; its maker may not start before it', async () => {
    const { gate } = await ok(P.manager, 'POST', '/planning/milestones/gates', { salesOrderId: G.order.id, kind: 'PP_SAMPLE', sampleRoundId: G.round.id, targetDate: addDays(today(), 21) }, 201)
    G.gate = gate
    keep(gate.id)
    expect(gate.state).toBe('WAITING')
    // REFUSAL: the gate's maker never lets the order start before it.
    expect(refusalOf(await ok(P.manager, 'POST', `/planning/milestones/gates/${gate.id}/start-before`, { version: gate.version, reason: 'My own gate (made up).' }, 409))).toBe('refusal/OWN_GATE')
    const { workOrder } = await ok(P.planner, 'POST', '/production/work-orders', { lines: (G.order.lines as Json[]).map((line) => ({ salesOrderLineId: line.id })) }, 201)
    G.wo = workOrder
    keep(workOrder.id)
    expect(workOrder).toMatchObject({ status: 'DRAFT', kind: 'SIZE_GRID' })
    const world = await ok(P.planner, 'GET', `/planning/milestones?companyId=${companyA()}`)
    const ours = (world.orders as Json[]).find((order) => order.id === G.order.id)!
    expect((ours.gates as Json[]).find((entry) => entry.id === gate.id)).toMatchObject({ state: 'WAITING', holds: 1 })
    // The board: the sample is placed while the gate waits; the production work order is refused with the gate.
    const [line] = await admin<{ id: string }>(w, 'SELECT id FROM "Line" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY code, id LIMIT 1', [w.tenant.id, G.sampleWo.siteId])
    const startAt = new Date(Date.now() + 86_400_000).toISOString()
    const placed = await ok(P.planner, 'POST', '/planning/schedule/slots', { workOrderId: G.sampleWo.id, operationId: null, lane: { kind: 'LINE', id: line!.id }, startAt, overloadReason: 'The pre-production sample goes first (made up).' }, 201)
    G.sampleSlot = placed.slot
    keep(placed.slot.id)
    const held = await ok(P.planner, 'POST', '/planning/schedule/slots', { workOrderId: G.wo.id, operationId: null, lane: { kind: 'LINE', id: line!.id }, startAt }, 409)
    expect(refusalOf(held)).toBe('refusal/GATE_NOT_PASSED')
    G.lineId = line!.id
  })

  it('M02 the sample is sent and received, its fit measured against the approved spec, and the brand approves it by link: the round is decided and the gate passes', async () => {
    const sent = await ok(P.sales, 'POST', `/sales/samples/rounds/${G.round.id}/shipments`, { carrierName: 'Made-up Express', trackingNumber: 'GF4-123456789', trackingUrl: 'https://tracking.example.test/GF4-123456789' }, 201)
    let shipment = sent.shipment
    keep(shipment.id)
    shipment = (await ok(P.sales, 'PATCH', `/sales/samples/shipments/${shipment.id}`, { version: shipment.version, sentAt: new Date(Date.now() - 3 * 3_600_000).toISOString() })).shipment
    // REFUSAL: a sample is sent once.
    expect(refusalOf(await ok(P.sales, 'PATCH', `/sales/samples/shipments/${shipment.id}`, { version: shipment.version, sentAt: new Date(Date.now() - 3_600_000).toISOString() }, 409))).toBe('refusal/SENT_ONCE')
    shipment = (await ok(P.sales, 'PATCH', `/sales/samples/shipments/${shipment.id}`, { version: shipment.version, receivedAt: new Date(Date.now() - 1_800_000).toISOString() })).shipment
    expect(shipment.receivedAt).toEqual(expect.any(String))

    const fit = await ok(P.manager, 'GET', `/sales/samples/rounds/${G.round.id}/fit`)
    expect(fit.spec).toMatchObject({ status: 'APPROVED' })
    const measured = await ok(P.manager, 'PUT', `/sales/samples/rounds/${G.round.id}/fit`, {
      cells: [
        { pointOfMeasureId: POINT.CHEST_W(), size: '52', measured: '58.4' },
        { pointOfMeasureId: POINT.BACK_LEN(), size: '52', measured: '72' },
        { pointOfMeasureId: POINT.SLEEVE_LEN(), size: '52', measured: '64.5' },
      ],
    })
    expect(JSON.stringify(measured)).toContain('58.4')
    // REFUSAL: the round measures its own sizes only.
    expect(refusalOf(await ok(P.manager, 'PUT', `/sales/samples/rounds/${G.round.id}/fit`, { cells: [{ pointOfMeasureId: POINT.CHEST_W(), size: '54', measured: '60' }] }, 409))).toBe('refusal/SIZE_NOT_IN_ROUND')

    // The brand decides by link: sales asks, the brand's phone answers with a typed name.
    const photo = await upload(P.sales, { recordType: 'SampleRound', recordId: G.round.id }, 'pp-sample-front.png', PNG, 'PHOTO', 'image/png')
    const asked = await ok(P.sales, 'POST', '/approvals-out', { kind: 'SAMPLE', recordType: 'SampleRound', recordId: G.round.id, question: 'Approve the pre-production sample, black 52.', fileIds: [photo], send: false }, 201)
    keep(asked.request.id)
    const token = decodeURIComponent(/#token=(\S+)/.exec(asked.url)![1]!)
    const page = await linkCall(token, 'GET', '/link/approval?language=en')
    expect(page.may).toMatchObject({ answer: true })
    const answered = await linkCall(token, 'POST', '/link/approval/approve?language=en', { decision: 'APPROVED_WITH_CHANGES', answer: 'Darker thread on the collar for production (made up).', typedName: 'Anna Golden' })
    expect(answered.request.decided).toMatch(/^Approved with changes — signed by Anna Golden/)
    await settle()
    const approval = await ok(P.sales, 'GET', `/sales/samples/rounds/${G.round.id}/approval`)
    expect(approval.decision).toMatchObject({ decision: 'APPROVED_WITH_COMMENTS', via: 'LINK', signedAs: 'Anna Golden' })
    const world = await ok(P.planner, 'GET', `/planning/milestones?companyId=${companyA()}`)
    const gate = ((world.orders as Json[]).find((order) => order.id === G.order.id)!.gates as Json[]).find((entry) => entry.id === G.gate.id)
    expect(gate).toMatchObject({ state: 'PASSED' })
  })


  // ---- L: markets and phrases; the label checked for Germany ---------------------------------------------------------------

  it('L01 the inspector reads Germany’s market, translates the care phrase into German (approved by a second inspector, not its translator) and adds Germany’s user-information and label-language requirements: the label check refuses print for German', async () => {
    const { market } = await ok(P.inspector, 'GET', '/compliance/rules/markets/DE')
    expect(market).toMatchObject({ code: 'DE', labelLanguages: ['de'], userInfoLanguages: ['de'] })
    let { phrase } = await ok(P.inspector, 'POST', '/compliance/rules/phrases/care.wash-not/translations', { language: 'de', text: 'Nicht waschen' })
    const draft = (phrase.cells as Json[]).find((cell) => cell.language === 'de')!.draft
    expect(draft).toMatchObject({ text: 'Nicht waschen' })
    // REFUSAL: the translator does not approve their own words.
    const own = await call(P.inspector.browser, 'POST', `/compliance/rules/phrases/care.wash-not/translations/${draft.id}/approve`, { version: draft.version })
    expect([403, 409]).toContain(own.status)
    phrase = (await ok(P.inspector2, 'POST', `/compliance/rules/phrases/care.wash-not/translations/${draft.id}/approve`, { version: draft.version })).phrase
    expect((phrase.cells as Json[]).find((cell) => cell.language === 'de')!.approved).toMatchObject({ text: 'Nicht waschen' })

    for (const body of [
      { code: 'GF4-DE-USER-INFO', kind: 'USER_INFO_LANGUAGE', name: 'The user information is in German for goods going to Germany', legalReference: 'Reg. (EU) 2016/425 art. 8(7), Annex II 1.4', marketCode: 'DE', ppeCategories: ['CATEGORY_II', 'CATEGORY_III'], blocks: ['WORK_ORDER_RELEASE'] },
      { code: 'GF4-DE-LABEL', kind: 'LABEL', checkKey: 'label.languages', name: 'The label prints German for goods going to Germany', legalReference: 'Reg. (EU) 2016/425 art. 8(7)', marketCode: 'DE', blocks: ['LABEL_PRINT'] },
    ]) {
      const { requirement } = await ok(P.inspector, 'POST', '/compliance/requirements', body, 201)
      keep(requirement.id)
    }
    // The label check of the production work order (going to Germany): refused, German missing.
    const label = await ok(P.inspector, 'GET', `/compliance/gates/check?gate=LABEL_PRINT&subjectType=WorkOrder&subjectId=${G.wo.id}`)
    expect(label.allowed, JSON.stringify(label)).toBe(false)
    expect(label.decisions[0].refusal).toMatchObject({ requirementCode: 'GF4-DE-LABEL' })
    expect(label.decisions[0].refusal.words).toMatch(/Germany needs de/)
  })

  // ---- C: the change order -----------------------------------------------------------------------------------------------------

  it('C01 a change request for German on the label becomes a change order: a new draft with the German label and more leather wastage, the work in progress decided (the sample finishes on the old revision, the production work order is held), black and red planned again', async () => {
    const { changeRequest } = await ok(P.inspector, 'POST', '/product/change-requests', { styleId: G.style.id, companyId: companyA(), source: 'OFFICE', title: 'German on the garment label', reason: 'The order goes to Germany: the label must print German (made up).' }, 201)
    G.changeRequest = changeRequest
    keep(changeRequest.id)
    let order = (await ok(P.manager, 'POST', '/product/change-orders', { styleId: G.style.id, companyId: companyA(), title: 'German label and leather wastage', reason: 'Germany needs its language on the label; the cutting room asks 1 % more wastage (made up).', requestIds: [changeRequest.id] }, 201)).changeOrder
    keep(order.id)
    expect(order).toMatchObject({ status: 'DRAFT', fromRevision: { revision: 1, status: 'RELEASED' }, toRevision: null })
    order = (await ok(P.manager, 'POST', `/product/change-orders/${order.id}/draft-revision`, { version: order.version })).changeOrder
    expect(order.toRevision).toMatchObject({ revision: 2, status: 'DRAFT' })
    G.revision2 = order.toRevision
    keep(order.toRevision.id)

    // The label's next revision prints German too; named on the draft.
    const next = (await ok(P.inspector, 'POST', `/compliance/labels/${G.label.id}/revisions`, {}, 201)).template
    const languages = (await ok(P.inspector, 'PATCH', `/compliance/labels/${next.id}`, { version: next.version, languages: ['it', 'en', 'de'] })).template
    G.label2 = (await ok(P.inspector, 'POST', `/compliance/labels/${next.id}/activate`, { version: languages.version })).template
    keep(next.id)
    await ok(P.inspector, 'PUT', `${revisionUrl(G.revision2.id)}/label`, { labelTemplateId: next.id, version: await revisionVersion(G.revision2.id) })
    // The redline in W1's BOM: more wastage on the leather.
    const bom = (await ok(P.manager, 'GET', `${revisionUrl(G.revision2.id)}/bom`)).bom
    const leather = (bom.lines as Json[]).find((line) => line.item.code === 'SEED-LEA-100')!
    await ok(P.manager, 'PATCH', `${revisionUrl(G.revision2.id)}/bom/lines/${leather.id}`, { version: bom.revision.version, wastagePct: '6' })
    order = (await ok(P.manager, 'POST', `/product/change-orders/${order.id}/lines`, { version: order.version, recordType: 'BomLine', recordId: leather.id, field: 'wastagePct', before: '5', after: '6', note: 'One percent more leather (made up).' })).changeOrder
    // Grey still waits for its certificate: the new revision is planned for black and red.
    await ok(P.manager, 'PUT', `${revisionUrl(G.revision2.id)}/release-scope`, { version: await revisionVersion(G.revision2.id), colourwayIds: [G.colourways.BLK.id, G.colourways.RED.id], sizes: [] })
    order = (
      await ok(P.manager, 'PUT', `/product/change-orders/${order.id}/work-in-progress`, {
        version: order.version,
        lines: [
          { workOrderId: G.sampleWo.id, disposition: 'FINISH_OLD' },
          { workOrderId: G.wo.id, disposition: 'HOLD' },
        ],
      })
    ).changeOrder
    expect((order.workInProgress as Json[]).map((line) => [line.workOrder.id, line.disposition]).sort()).toEqual(
      [
        [G.sampleWo.id, 'FINISH_OLD'],
        [G.wo.id, 'HOLD'],
      ].sort(),
    )
    G.changeOrder = order
  })

  it('C02 approved by another production manager (the author may neither approve nor be named), then released: revision 2 for black and red, revision 1 obsolete, the request done; the first order stays on revision 1 (its lines fix it)', async () => {
    let order = G.changeOrder
    expect(refusalOf(await ok(P.manager, 'PUT', `/product/change-orders/${order.id}/approvers`, { version: order.version, approvers: [{ userId: P.manager.id }] }, 409))).toBe('refusal/OWN_APPROVAL')
    order = (await ok(P.manager, 'PUT', `/product/change-orders/${order.id}/approvers`, { version: order.version, approvers: [{ userId: P.manager2.id, required: true }] })).changeOrder
    order = (await ok(P.manager, 'POST', `/product/change-orders/${order.id}/submit`, { version: order.version })).changeOrder
    expect(order).toMatchObject({ status: 'SUBMITTED', approvals: { approved: 0, required: 1 } })
    // REFUSAL: the draft is frozen while it waits; the author does not approve.
    expect(refusalOf(await ok(P.manager, 'POST', `/product/change-orders/${order.id}/decide`, { version: order.version, decision: 'APPROVED' }, 409))).toBe('refusal/OWN_APPROVAL')
    order = (await ok(P.manager2, 'POST', `/product/change-orders/${order.id}/decide`, { version: order.version, decision: 'APPROVED' })).changeOrder
    expect(order).toMatchObject({ status: 'APPROVED', approvals: { approved: 1, required: 1 } })
    order = (await ok(P.manager, 'POST', `/product/change-orders/${order.id}/release`, { version: order.version })).changeOrder
    expect(order).toMatchObject({ status: 'RELEASED', releasedById: P.manager.id, toRevision: { revision: 2, status: 'RELEASED' }, fromRevision: { status: 'OBSOLETE' } })
    expect(order.requestsList.map((row: Json) => row.status)).toEqual(['DONE'])
    G.changeOrder = order
    G.revision = order.toRevision
    await settle()
    const released = await ok(P.manager, 'GET', `/product/styles/${G.style.id}/release-scope`)
    expect(JSON.stringify(released)).toContain('GRY')
    // The sample's work order (still on revision 1) reads the decision on its newer-spec banner.
    const newer = await ok(P.manager, 'GET', `/production/work-orders/${G.sampleWo.id}/spec/newer`)
    expect(newer.spec.newer).toMatchObject({ decision: { disposition: 'FINISH_OLD', changeOrder: order.number } })
    // The first order's lines keep revision 1 (a per-order choice of version is later): its held work order cannot move.
    const { workOrder } = await ok(P.planner, 'GET', `/production/work-orders/${G.wo.id}`)
    const pinned = await ok(P.planner, 'PATCH', `/production/work-orders/${G.wo.id}`, { version: workOrder.version, styleRevisionId: G.revision.id }, 400)
    expect(pathsOf(pinned)).toEqual(['body/styleRevisionId'])
  })

  // ---- P: the production work order ------------------------------------------------------------------------------------------------

  it('P01 the brand orders again for Germany, now on revision 2: the label check passes with German; the release is refused on a missing requirement (no German user information), then passes once the inspector files it', async () => {
    const { order } = await ok(
      P.sales,
      'POST',
      '/sales/orders/manual',
      {
        companyId: companyA(),
        partyId: id('party:P1'),
        customerRef: 'PO-GF4-DE-02',
        promiseDate: addDays(today(), 56),
        paymentTermsId: id('pricing:terms:BB30FM'),
        depositPct: null,
        shipToAddressId: G.deAddress.id,
        lines: [{ styleId: G.style.id, colourwayId: G.colourways.BLK.id, unitPrice: '450', sizes: [{ size: '50', quantity: 1 }, { size: '52', quantity: 1 }, { size: '54', quantity: 1 }] }],
      },
      201,
    )
    G.order2 = order
    keep(order.id)
    expect((order.lines as Json[]).every((line) => line.styleRevisionId === G.revision.id)).toBe(true)
    const { workOrder } = await ok(P.planner, 'POST', '/production/work-orders', { lines: (order.lines as Json[]).map((line) => ({ salesOrderLineId: line.id })) }, 201)
    G.wo2 = workOrder
    keep(workOrder.id)
    const label = await ok(P.inspector, 'GET', `/compliance/gates/check?gate=LABEL_PRINT&subjectType=WorkOrder&subjectId=${workOrder.id}`)
    expect(label.decisions[0].refusal, JSON.stringify(label.decisions[0])).toBeNull()
    // REFUSAL: the release stops at the first missing requirement (Germany's user information).
    const check = await ok(P.inspector, 'GET', `/compliance/gates/check?gate=WORK_ORDER_RELEASE&subjectType=WorkOrder&subjectId=${workOrder.id}`)
    expect(check.decisions[0].refusal, JSON.stringify(check)).toMatchObject({ requirementCode: 'GF4-DE-USER-INFO' })
    const refused = await ok(P.planner, 'POST', `/production/work-orders/${workOrder.id}/release`, { version: workOrder.version, materialOverride: { reason: 'The leather is promised to older orders; the next lot comes first (made up).' } }, 409)
    expect(refused.error.message).toMatch(/German|de\b/)
    const events = await ok(P.inspector, 'GET', `/compliance/gates/events?subjectType=WorkOrder&subjectId=${workOrder.id}`)
    expect(events.events).toEqual([expect.objectContaining({ gate: 'WORK_ORDER_RELEASE', outcome: 'REFUSED', state: 'BLOCKED', requirement: expect.objectContaining({ code: 'GF4-DE-USER-INFO' }) })])
    // The consultant's German user information, signed, filed for revision 2.
    const body = pdf('USER_INFORMATION de GF4-JKT-01 rev 2')
    const announced = await ok(P.inspector, 'POST', `/product/styles/${G.style.id}/compliance/documents`, { revisionId: G.revision.id, kind: 'USER_INFORMATION', language: 'de', ...announce('user-information-de.pdf', body) }, 201)
    await putBytes(w, announced, body)
    const confirmed = await ok(P.inspector, 'POST', `/product/styles/${G.style.id}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
    expect(confirmed.document.status).toBe('ISSUED')
    keep(announced.document.id)
    G.wo2 = await release(P.planner, workOrder.id)
    expect(G.wo2).toMatchObject({ status: 'RELEASED', batchNumber: expect.any(String) })
    expect(JSON.stringify(G.wo2)).toContain(G.label2.id)
    const after = await ok(P.inspector, 'GET', `/compliance/gates/events?subjectType=WorkOrder&subjectId=${workOrder.id}`)
    expect(after.events[0]).toMatchObject({ state: 'CLEARED' })
  })


  // ---- F: on the floor ----------------------------------------------------------------------------------------------------------

  it('F01 four black hides of two dye lots arrive on the open rest of the seeded leather order; the inspector (not the receiver) releases both lots on their Cr VI results', async () => {
    const received = await ok(
      P.warehouse,
      'POST',
      '/inventory/receipts',
      {
        purchaseOrderId: id('link:P2:record'),
        supplierDdtNumber: 'DDT-GF4-1',
        supplierDdtDate: today(),
        lines: [
          {
            purchaseOrderLineId: id('supply:PO1:10'),
            lots: [
              { supplierLotRef: 'TAN-GF4-1', dyeBatch: 'DB-GF4-1', shade: 'Nero 1', hides: ['T4-1', 'T4-2'].map((supplierCode) => ({ supplierCode, area: '52.0', grade: 'A', thicknessMm: '1.20' })) },
              { supplierLotRef: 'TAN-GF4-2', dyeBatch: 'DB-GF4-2', shade: 'Nero 2', hides: ['T4-3', 'T4-4'].map((supplierCode) => ({ supplierCode, area: '52.0', grade: 'A', thicknessMm: '1.20' })) },
            ],
          },
        ],
      },
      201,
    )
    const lots = (received.receipt.lines as Json[]).flatMap((line) => line.lots as Json[])
    expect(lots).toHaveLength(2)
    const withHides = (await ok(P.warehouse, 'GET', `/inventory/receipts/${received.receipt.id}/lots`)).lots as Json[]
    // One hide of each lot goes to the order (the other two stay on the shelf).
    G.hides = lots.map((lot) => ({ lot, hide: (withHides.find((entry) => entry.id === lot.id)!.hides as Json[])[0]! }))
    keep(received.receipt.id, ...lots.map((lot) => lot.id), ...withHides.flatMap((lot) => (lot.hides as Json[]).map((hide) => hide.id)))
    for (const [n, { lot: received }] of (G.hides as Json[]).entries()) {
      const base = `/quality/lots/${received.id}`
      const lot = (await ok(P.inspector, 'GET', base)).lot
      expect(lot.receivedById).toBe(P.warehouse.id)
      const report = pdf(`Cr VI test report TL-GF4-${n + 1}`)
      const announced = await ok(P.inspector, 'POST', `${base}/results/report`, announce(`cr6-gf4-${n + 1}.pdf`, report), 201)
      await putBytes(w, announced, report)
      const recorded = await ok(P.inspector, 'POST', `${base}/results`, { version: lot.version, test: 'CR_VI', method: 'EN ISO 17075-1', valueMgKg: '1.0', lab: 'Test Lab One (made up)', reportNumber: `TL-GF4-${n + 1}`, testedOn: today(), evidence: 'LOT_REPORT', fileId: announced.file.id }, 201)
      expect((await ok(P.inspector, 'POST', `${base}/release`, { version: recorded.lot.version, confirmCode: recorded.lot.code })).lot.qualityStatus).toBe('RELEASED')
    }
    await settle()
  })

  it('F02 site A1 cuts without the shade rule (OFF, with the reason); the inspector makes the packing rule (a final inspection of every lot, nobody named); the tablets, their workers and the garment label printer', async () => {
    const url = `/production/settings/${id('site:A1')}/cutting-rules`
    const before = await ok(P.manager, 'GET', url)
    const changed = await ok(P.manager, 'POST', url, { shadeRule: 'OFF', reason: 'One-colour jackets: the shade lots are sorted at the tannery (made up).', version: before.version })
    expect(JSON.stringify(changed)).toMatch(/"shadeRule":"OFF"/)
    // At one site only: B1 keeps one shade lot per order.
    expect(JSON.stringify(await ok(P.manager, 'GET', `/production/settings/${id('site:B1')}/cutting-rules`))).toMatch(/"shadeRule":"ORDER"/)
    const { rule } = await ok(P.inspector, 'POST', '/quality/inspection-triggers', { companyId: companyA(), event: 'PACKING', planId: first('inspection-plans:plan:FIN-JACKET'), frequency: 'EVERY_LOT', dueHours: 8 }, 201)
    expect(rule).toMatchObject({ event: 'PACKING', recordKind: 'FINAL', dueHours: 8 })
    G.packingRule = rule
    keep(rule.id)

    G.tablets = {} as Record<string, Browser>
    G.workers = {} as Record<string, FloorWorker>
    G.pins = { CUTTING: '481537', SEWING: '592648', INSPECTION: '603759', PACKING: '714860' }
    for (const [kind, station] of [
      ['CUTTING', 'CUT-01'],
      ['SEWING', 'SEW-01'],
      ['INSPECTION', 'QC-01'],
      ['PACKING', 'PACK-01'],
    ] as const) {
      const device = await tablet(w, P.supervisor, id('site:A1'), id(`site:A1:station:${station}`), `GF4 tablet ${station}`)
      const worker = await floorWorker(w, P.supervisor, id('site:A1'), `GF4 ${kind.toLowerCase()} worker`, id('role:operator'))
      await signOn(device, worker, G.pins[kind])
      G.tablets[kind] = device
      G.workers[kind] = worker
      keep(worker.id)
    }
    const { printer } = await ok(P.admin, 'POST', '/print/printers', { siteId: id('site:A1'), code: 'LBL-GF4', name: 'GF4 garment label printer', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'golden-label:9100', dpi: 203, labelWidthMm: 100, labelHeightMm: 100 }, 201)
    G.garmentPrinter = printer.id
  })

  it('F03 pick and cut: sizes 50 and 52 from the first lot’s hide, 54 from the second lot’s: two shade lots in one order, and no shade warning at A1', async () => {
    const cutting = G.tablets.CUTTING as Browser
    for (const { hide } of G.hides as Json[]) await ok(cutting, 'POST', `/inventory/picking/work-orders/${G.wo2.id}/issue`, { code: hide.code }, 201)
    const cells = Object.fromEntries((G.wo2.cells as Json[]).map((cell) => [cell.size, cell]))
    for (const [n, sizes] of [['50', '52'], ['54']].entries()) {
      const { hide } = (G.hides as Json[])[n]!
      const cut = await ok(cutting, 'POST', `/production/cutting/work-orders/${G.wo2.id}/cuts`, { clientEventId: `gf4-cut-${hide.code}`, code: hide.code, lines: sizes.map((size) => ({ workOrderSizeId: cells[size].id, sets: 1 })), done: { remnant: null } }, 201)
      expect(cut.warnings ?? []).toEqual([])
    }
    const made = await ok(cutting, 'POST', `/production/bundles/work-orders/${G.wo2.id}/bundles`, { bundleSize: 10, printerId: id('print:printer:A1:LBL') }, 201)
    G.bundles = made.bundles
    keep(...made.bundles.map((bundle: Json) => bundle.id))
    await settle()
  })

  it('F04 every bundle through every operation; at packing the instruction opens before Start (seen once), then the report: the packing rule opens the final inspection with no inspector', async () => {
    const operations = (G.wo2.spec.operations as Json[]).filter((op) => op.scanRequired).sort((a, b) => a.seq - b.seq)
    expect(operations.map((op) => op.workCentreKind)).toEqual(['CUTTING', 'SEWING', 'INSPECTION', 'PACKING'])
    let n = 0
    let acknowledged = false
    for (const bundle of G.bundles as Json[]) {
      for (const op of operations) {
        const device = G.tablets[op.workCentreKind] as Browser
        if (op.workCentreKind === 'PACKING') {
          const before = await ok(device, 'GET', `/production/instructions/floor/operation?code=${encodeURIComponent(bundle.code)}&workOrderOperationId=${op.id}`)
          expect(before.instruction).toMatchObject({ id: G.instruction.id, version: { id: G.instructionVersion } })
          if (!acknowledged) {
            acknowledged = true
            // Before Start: the new instruction opens (FIRST), is read and seen once; after Seen it no longer waits.
            expect(before.acknowledgement).toEqual({ due: 'FIRST', seenAt: null })
            const clientEventId = `gf4-seen-${bundle.code}`
            await ok(device, 'POST', '/production/instructions/floor/seen', { clientEventId, versionId: G.instructionVersion }, 201, { 'idempotency-key': clientEventId })
            const after = await ok(device, 'GET', `/production/instructions/floor/operation?code=${encodeURIComponent(bundle.code)}&workOrderOperationId=${op.id}`)
            expect(after.acknowledgement).toMatchObject({ due: null })
            // REFUSAL: the instruction's required step holds Finish until it is ticked.
            const early = `gf4-early-${bundle.code}`
            expect(refusalOf(await ok(device, 'POST', '/production/scans', { clientScanId: early, code: bundle.code, workOrderOperationId: op.id, good: bundle.quantity }, 409, { 'idempotency-key': early }))).toBe('refusal/CHECKLIST_OPEN')
          } else {
            expect(before.acknowledgement).toMatchObject({ due: null })
          }
          const tick = `gf4-tick-${bundle.code}`
          await ok(device, 'POST', '/production/checklists/tick', { clientEventId: tick, bundleId: bundle.id, workOrderOperationId: op.id, stepCode: 'LABEL_CHECK' }, 201, { 'idempotency-key': tick })
        }
        const clientScanId = `gf4-scan-${++n}-${bundle.code}`
        const scan = await ok(device, 'POST', '/production/scans', { clientScanId, code: bundle.code, workOrderOperationId: op.id, good: bundle.quantity }, 201, { 'idempotency-key': clientScanId })
        expect(scan.scan.goodQuantity).toBe(bundle.quantity)
      }
    }
    await settle()
    const opened = await admin<{ id: string; inspectorUserId: string | null; inspectorWorkerId: string | null; openedByTriggerId: string | null; status: string }>(w, `SELECT id, "inspectorUserId", "inspectorWorkerId", "openedByTriggerId", status::text FROM "Inspection" WHERE "workOrderId" = $1`, [G.wo2.id])
    expect(opened).toEqual([expect.objectContaining({ openedByTriggerId: G.packingRule.id, inspectorUserId: null, inspectorWorkerId: null, status: 'OPEN' })])
    G.finalInspection = opened[0]!.id
    keep(G.finalInspection)
    const acks = await ok(P.manager, 'GET', `/production/instructions/${G.instruction.id}/acknowledgements`)
    expect(JSON.stringify(acks)).toMatch(/"seen":1/)
  })

  it('F05 the label artwork approved by a second inspector (not its author); the garment labels printed; a torn one logged and reprinted: the labels reconcile', async () => {
    const proof = await upload(P.inspector, { recordType: 'LabelTemplate', recordId: G.label2.id }, 'label-proof-gf4.pdf')
    const { artwork } = await ok(P.inspector, 'POST', `/compliance/label-artwork/templates/${G.label2.id}/versions`, { fileId: proof, note: 'Proof of the German label (made up).' }, 201)
    const draft = (artwork.versions as Json[])[0]!
    expect(draft).toMatchObject({ status: 'DRAFT' })
    keep(draft.id)
    // REFUSAL: four eyes: the author never approves their own artwork.
    await ok(P.inspector, 'POST', `/compliance/label-artwork/versions/${draft.id}/approve`, { version: draft.version }, 409)
    const approved = (await ok(P.inspector2, 'POST', `/compliance/label-artwork/versions/${draft.id}/approve`, { version: draft.version })).artwork
    expect(approved.approvedId).toBe(draft.id)

    const packing = G.tablets.PACKING as Browser
    const printed = await ok(packing, 'POST', `/production/serials/work-orders/${G.wo2.id}/labels`, { printerId: G.garmentPrinter }, 201)
    expect(printed).toMatchObject({ tracking: 'BATCH', refused: [] })
    expect(printed.printed.reduce((sum: number, entry: Json) => sum + entry.count, 0)).toBe(3)
    const cell52 = (G.wo2.cells as Json[]).find((cell) => cell.size === '52')!
    const logged = await ok(packing, 'POST', `/production/serials/work-orders/${G.wo2.id}/spoiled`, { workOrderSizeId: cell52.id, kind: 'SPOILED', quantity: 1, reason: 'Label damaged or torn' }, 201)
    expect(logged.reconciliation.balanced).toBe(false)
    await ok(packing, 'POST', `/production/serials/work-orders/${G.wo2.id}/reprint`, { workOrderSizeId: cell52.id, count: 1, reason: 'The first one tore (made up).', printerId: G.garmentPrinter }, 201)
    const { reconciliation } = await ok(P.inspector, 'GET', `/production/serials/work-orders/${G.wo2.id}/reconciliation`)
    expect(reconciliation).toMatchObject({ balanced: true, total: expect.objectContaining({ printed: 4, used: 3, spoiled: 1, difference: 0 }) })
    await settle()
  })


  // ---- D: the declaration of conformity -------------------------------------------------------------------------------------

  it('D02 the DoC generated from the records in Italian with English and German translations: a draft while the PPE consultant has not said yes; the German words typed by a second inspector and checked by a third person (never the typist or the author)', async () => {
    const { declaration } = await ok(P.inspector, 'POST', '/compliance/declarations', { styleId: G.style.id, revisionId: G.revision.id, languages: ['it', 'en', 'de'], marketCode: 'DE' }, 201)
    keep(declaration.id)
    expect(declaration).toMatchObject({ kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 2, status: 'DRAFT', origin: 'GENERATED', draftUntilChecked: true })
    // GATE-PPE-TEXTS (Owner, answer B): generated texts stay drafts until a PPE consultant says yes; the flow never opens it.
    expect(declaration.gate).toMatchObject({ name: 'GATE-PPE-TEXTS', open: true })
    expect(declaration.maker).toMatchObject({ partyId: id('party:P1'), role: 'BRAND' })
    expect(JSON.stringify(declaration.points)).toContain('GF4-CERT-0001')
    let german = (await ok(P.inspector, 'GET', `/compliance/declarations/${(declaration.languages as Json[]).find((entry) => entry.language === 'de')!.id}`)).declaration
    keep(german.id)
    const typed = (await ok(P.inspector2, 'PATCH', `/compliance/declarations/${german.id}`, { version: german.version, points: (german.pointsToType as string[]).map((point) => ({ point, text: `Deutscher Text für Punkt ${point} (erfunden).` })) })).declaration
    expect(typed.pointsToType).toEqual([])
    // REFUSAL: the typist and the author never check their own translation.
    expect(refusalOf(await ok(P.inspector2, 'POST', `/compliance/declarations/${german.id}/check`, { version: typed.version }, 409))).toBe('refusal/OWN_WORDS')
    expect(refusalOf(await ok(P.inspector, 'POST', `/compliance/declarations/${german.id}/check`, { version: typed.version }, 409))).toBe('refusal/OWN_TRANSLATION')
    german = (await ok(P.owner, 'POST', `/compliance/declarations/${german.id}/check`, { version: typed.version })).declaration
    expect(german).toMatchObject({ translationStatus: 'CHECKED', status: 'DRAFT' })
    G.declaration = declaration
  })

  it('D03 the consultant-signed German DoC is filed for revision 2 and the work order’s batch recorded to it: the public page of the batch shows that declaration and its batches', async () => {
    const body = pdf('DECLARATION_OF_CONFORMITY de GF4-JKT-01 rev 2 (signed)')
    const announced = await ok(P.inspector, 'POST', `/product/styles/${G.style.id}/compliance/documents`, { revisionId: G.revision.id, kind: 'DECLARATION_OF_CONFORMITY', language: 'de', ...announce('declaration-de.pdf', body) }, 201)
    await putBytes(w, announced, body)
    const confirmed = await ok(P.inspector, 'POST', `/product/styles/${G.style.id}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
    expect(confirmed.document.status).toBe('ISSUED')
    G.signedDoc = announced.document.id
    keep(G.signedDoc)
    const recorded = await ok(P.inspector, 'POST', '/compliance/declarations/batches', { documentId: G.signedDoc, workOrderId: G.wo2.id, note: 'Recorded at release (made up).' }, 201)
    expect(JSON.stringify(recorded)).toContain(G.wo2.batchNumber)
    const timeline = await ok(P.inspector, 'GET', `/compliance/declarations/batches?styleId=${G.style.id}`)
    expect(JSON.stringify(timeline)).toContain(G.wo2.batchNumber)
    const page = (await anyone('POST', '/public/doc/lookup', { code: publicDocCodeOf(G.wo2.id) })).page
    expect(page).toMatchObject({ kind: 'BATCH', product: { style: { code: 'GF4-JKT-01' }, batch: { number: G.wo2.batchNumber } }, declaration: { revision: 2, standing: 'CURRENT' }, notices: [] })
    expect((page.declaration.files as Json[]).map((file) => file.language)).toContain('de')
    expect(page.declaration.batches).toEqual({ first: today(), last: today() })
    expect(JSON.stringify(page)).not.toMatch(/price|cost|amount|wage|createdById|releasedById/i)
  })

  // ---- U: a substance rule asks the tannery for a declaration, answered in the portal ---------------------------------------

  it('U01 the partner roles synced; the buyer opens the tannery’s portal and invites its desk; the brand’s buyer and another customer’s admin are invited too; each signs in by code', async () => {
    await stepped(w, P.admin)
    await ok(P.admin, 'POST', '/auth/roles/sync-templates')
    R.tannery = await partnerOf('tannery', id('party:P2'), 'marta.gf4@tannery-p2.example')
    await openPortal(P.buyer, id('party:P2'))
    await invite(P.buyer, R.tannery, { displayName: 'Marta Golden', kind: 'SUPPLIER', roleKey: 'supplier-orders' })
    R.brand = await partnerOf('brand', id('party:P1'), 'giulia.gf4@brand-p1.example')
    await openPortal(P.sales, id('party:P1'))
    await invite(P.sales, R.brand, { displayName: 'Giulia Golden', roleKey: 'customer-buyer' })
    R.other = await partnerOf('other', id('party:P3'), 'kai.gf4@kunde-p3.example')
    await openPortal(P.sales, id('party:P3'))
    await invite(P.sales, R.other, { displayName: 'Kai Golden', roleKey: 'customer-admin' })
    for (const partner of [R.tannery, R.brand, R.other]) await signIn(partner)
    await settle()
  })

  it('U02 the leather’s AZO rule (a test or a declaration) waits; the inspector asks the tannery for an RSL declaration in the portal; the desk uploads it against the task; the inspector records the answer and accepts it: the rule is met by the declaration', async () => {
    const leather = id('product:item:leather')
    const azo = async () => ((await ok(P.inspector, 'GET', `/compliance/substances/materials/${leather}/evaluation`)).rules as Json[]).find((rule) => rule.key === 'REACH-XVII-43')!
    const before = await azo()
    expect(before).toMatchObject({ evidence: 'EITHER', needs: { declaration: 'RSL' } })
    expect(before.metBy).not.toBe('DECLARATION')
    const body = { materials: [{ itemId: leather, partyId: id('party:P2') }], kinds: ['RSL'], dueOn: addDays(today(), 14), message: 'Please confirm the leather meets the AZO limits of our RSL (made up).' }
    const plan = await ok(P.inspector, 'POST', '/compliance/declarations-asked', { ...body, dryRun: true })
    expect(plan.groups[0]).toMatchObject({ kind: 'RSL', channel: 'PORTAL', outcome: 'SEND' })
    const sent = await ok(P.inspector, 'POST', '/compliance/declarations-asked', body)
    const requestId = sent.groups[0].request.requestId as string
    keep(requestId)
    let asked = (await ok(P.inspector, 'GET', `/compliance/declarations-asked/${requestId}`)).request
    expect(asked).toMatchObject({ status: 'SENT', channel: 'PORTAL', partnerTask: { status: 'OPEN' } })
    // The tannery's desk sees what we ask for, and uploads its declaration against the task.
    expect(JSON.stringify(await as(R.tannery, 'GET', '/portal/supplier-documents'))).toContain(asked.number)
    const declaration = pdf('RSL declaration of the tannery for SEED-LEA-100 (made up)')
    const announced = await as(R.tannery, 'POST', '/portal/supplier-documents', { category: 'DECLARATION', taskId: asked.partnerTask.id, issuer: 'Seed tannery (made up)', number: 'RSL-2026-07', issuedOn: today(), originalName: 'rsl-declaration.pdf', contentType: 'application/pdf', sizeBytes: declaration.length, sha256: sha256(declaration) }, 201)
    await putBytes(w, announced, declaration)
    expect(await as(R.tannery, 'POST', `/portal/supplier-documents/${announced.file.id}/complete`)).toMatchObject({ file: { status: 'AVAILABLE' } })
    keep(announced.file.id)
    await settle()
    asked = (await ok(P.inspector, 'GET', `/compliance/declarations-asked/${requestId}`)).request
    expect(asked).toMatchObject({ status: 'ANSWERED', file: { source: 'UPLOAD' } })
    // REFUSAL: accepted only once every material's answer is recorded.
    await ok(P.inspector, 'POST', `/compliance/declarations-asked/${requestId}/accept`, { version: asked.version }, 409)
    // The portal dates the answer by the harness clock, which runs ahead of the server's (each two-factor act moves it 30 s on);
    // the office's decision is dated by the server's: Date follows the harness clock for the decision only, so it is not dated
    // before the answer (in production both are one clock).
    vi.setSystemTime(w.h.clock.now())
    try {
      const lines = await ok(P.inspector, 'PUT', `/compliance/declarations-asked/${requestId}/lines`, { version: asked.version, lines: [{ lineId: asked.lineRows[0].id, contains: false }] })
      const accepted = await ok(P.inspector, 'POST', `/compliance/declarations-asked/${requestId}/accept`, { version: lines.request.version, validTo: addDays(today(), 365) })
      expect(accepted.request).toMatchObject({ status: 'ACCEPTED' })
    } finally {
      vi.useRealTimers()
    }
    await settle()
    expect(await azo()).toMatchObject({ status: 'MET', metBy: 'DECLARATION', proof: { kind: 'DECLARATION', number: asked.number } })
  })

  // ---- T: the technical file and its evidence pack by link --------------------------------------------------------------------

  it('T01 the technical file of the style; an evidence pack of the batch for the brand, built by the worker and sent by a link with a password; the brand opens it', async () => {
    const created = await ok(P.inspector, 'POST', '/compliance/techfiles', { styleId: G.style.id, certificateId: G.certificate.id, suggest: true })
    G.techfile = created.file
    keep(created.file.id)
    const asked = await ok(P.inspector, 'POST', `/compliance/techfiles/${G.techfile.id}/packs`, { purpose: 'CUSTOMER', language: 'en', recipient: 'Seed Customer One (made up)', recipientPartyId: id('party:P1'), scope: { kind: 'BATCHES', batchNumbers: [G.wo2.batchNumber] } })
    keep(asked.pack.id)
    expect(asked.pack).toMatchObject({ status: 'BUILDING' })
    await settle()
    const { pack } = await ok(P.inspector, 'GET', `/compliance/evidence-packs/${asked.pack.id}`)
    expect(pack).toMatchObject({ status: 'BUILT' })
    const expiresOn = addDays(today(), 30)
    // REFUSAL: sharing speaks outward: a fresh second factor first.
    await ok(P.inspector, 'POST', `/compliance/evidence-packs/${pack.id}/link`, { partyId: id('party:P1'), email: 'quality.gf4@brand-p1.example', password: 'made-up pack pass 4', expiresOn, send: true }, 403)
    await stepped(w, P.inspector)
    const shared = await ok(P.inspector, 'POST', `/compliance/evidence-packs/${pack.id}/link`, { partyId: id('party:P1'), email: 'quality.gf4@brand-p1.example', password: 'made-up pack pass 4', expiresOn, send: true })
    keep(shared.linkId)
    await settle()
    const token = linkTokenSentTo(w, 'quality.gf4@brand-p1.example')
    const locked = await linkCall(token, 'GET', '/link/files')
    expect(locked).toMatchObject({ count: 2, files: [], link: { password: { asked: true, unlocked: false } } })
    const { unlock } = await linkCall(token, 'POST', '/link/password', { password: 'made-up pack pass 4' })
    const files = (await linkCall(token, 'GET', '/link/files', undefined, 200, { 'x-factory-link-unlock': unlock })).files as Json[]
    expect(files).toHaveLength(2)
    expect(JSON.stringify(files)).not.toMatch(/cost|price|wage/i)
    await linkCall(token, 'POST', `/link/files/${files[0]!.id ?? files[0]!.fileId}/download`, {}, 200, { 'x-factory-link-unlock': unlock })
  })

  // ---- K: a recall from the trace, its notice first on the public page -----------------------------------------------------------

  it('K01 a recall of the batch from the register’s trace: the work order held, the recall started, its notice published with a fresh second factor: first on the public page of the batch', async () => {
    const { entry } = await ok(P.inspector, 'POST', '/compliance/register', { companyId: companyA(), kind: 'RECALL', styleId: G.style.id, batchNumbers: [G.wo2.batchNumber], description: 'A zip slider of the batch may come off (made up).' }, 201)
    keep(entry.id)
    expect(entry.trace.workOrders.map((workOrder: Json) => workOrder.number)).toEqual([G.wo2.number])
    let recall = (await ok(P.inspector, 'POST', `/compliance/register/${entry.id}/recalls`, {
      kind: 'RECALL',
      batchNumbers: [G.wo2.batchNumber],
      noticeLanguages: ['it', 'en', 'de'],
      publicNotice: {
        it: { title: 'Richiamo giacca GF4-JKT-01', problem: 'Il cursore della zip può staccarsi (inventato).', action: 'Non usare la giacca e contattateci.', contact: 'qualita@golden.example.com' },
        en: { title: 'Recall of jacket GF4-JKT-01', problem: 'The zip slider may come off (made up).', action: 'Stop using the jacket and contact us.', contact: 'quality@golden.example.com' },
        de: { title: 'Rückruf Jacke GF4-JKT-01', problem: 'Der Reißverschluss-Schieber kann sich lösen (erfunden).', action: 'Jacke nicht benutzen, bitte melden.', contact: 'quality@golden.example.com' },
      },
    }, 201)).recall
    keep(recall.id)
    const held = await ok(P.inspector, 'POST', `/compliance/recalls/${recall.id}/holds`, { version: recall.version, reasonCode: 'QUALITY_CHECK' })
    recall = held.recall
    expect(recall.holds).toEqual([expect.objectContaining({ status: 'ACTIVE', subjectType: 'WorkOrder', subjects: 1 })])
    keep(recall.holds[0].id)
    recall = (await ok(P.inspector, 'POST', `/compliance/recalls/${recall.id}/start`, { version: recall.version })).recall
    expect(recall.status).toBe('ACTIVE')
    // REFUSAL: publishing speaks to the public: only a person with recall.send (the production manager has none), with a fresh second factor.
    await stepped(w, P.manager)
    await ok(P.manager, 'POST', `/compliance/recalls/${recall.id}/notice/publish`, { version: recall.version }, 403)
    await stepped(w, P.inspector)
    recall = (await ok(P.inspector, 'POST', `/compliance/recalls/${recall.id}/notice/publish`, { version: recall.version })).recall
    expect(recall.notice.live).toBe(true)
    G.recall = recall
    const page = (await anyone('POST', '/public/doc/lookup', { code: publicDocCodeOf(G.wo2.id) })).page
    expect(page.notices.map((notice: Json) => notice.number)).toEqual([recall.number])
    expect(Object.keys(page).indexOf('notices')).toBeGreaterThanOrEqual(0)
    expect(page.notices[0]).toMatchObject({ kind: 'RECALL', reach: 'BATCH', batches: [G.wo2.batchNumber] })
    await settle()
  })

  // ---- X: the private label and the partner copy of the tech pack ---------------------------------------------------------------

  it('X01 the brand’s tech pack copy: no cost anywhere, made for the brand only; the brand reads its round and downloads it in the portal, another customer finds neither the style nor the copy', async () => {
    const live = (await ok(P.manager, 'GET', `${revisionUrl()}/tech-pack?audience=BRAND&language=en`)).techPack
    expect(keysOf(live).filter(NEVER)).toEqual([])
    // REFUSAL: a brand copy of a private-label style is for its brand only.
    const wrong = await call(P.manager.browser, 'POST', `${revisionUrl()}/tech-pack/pdf`, { audience: 'BRAND', language: 'en', partyId: id('party:P3') })
    expect([400, 409]).toContain(wrong.status)
    const { pdf: copy } = await ok(P.manager, 'POST', `${revisionUrl()}/tech-pack/pdf`, { audience: 'BRAND', language: 'en', partyId: id('party:P1') }, 201)
    const documentId = copy.version.id ?? copy.version.documentId
    const samples = await as(R.brand, 'GET', '/portal/samples')
    expect(JSON.stringify(samples)).toContain('GF4-JKT-01')
    expect(JSON.stringify(samples)).toContain(G.round.number)
    const download = await as(R.brand, 'POST', `/portal/samples/tech-packs/${documentId}/download`, { mode: 'preview' })
    expect(JSON.stringify(download)).toMatch(/url/)
    // Another customer: neither the style in the catalogue (nor by its id), nor its round, nor the brand's copy.
    expect(JSON.stringify(await as(R.other, 'GET', '/portal/catalogue?q=GF4'))).not.toContain('GF4-JKT-01')
    await as(R.other, 'GET', `/portal/catalogue/${G.style.id}`, undefined, 404)
    expect(JSON.stringify(await as(R.other, 'GET', '/portal/samples'))).not.toContain('GF4-JKT-01')
    await as(R.other, 'POST', `/portal/samples/tech-packs/${documentId}/download`, { mode: 'preview' }, 404)
    // No cost, margin or pay key in any answer a partner, a link holder or the public got in the whole flow.
    const never = seen.flatMap((entry) => [...new Set(keysOf(entry.body).filter(NEVER))].map((key) => `${entry.who} ${entry.url}: ${key}`))
    expect(never).toEqual([])
  })

  // ---- Z: the end checks ---------------------------------------------------------------------------------------------------------

  it('Z1 every record the flow made has its audit rows; the W2b-4 events fired; the worker never retried; no route answered 500; the outbox is empty', async () => {
    await settle()
    const ids = [...made]
    const audited = new Set((await admin<{ recordId: string }>(w, 'SELECT DISTINCT "recordId"::text AS "recordId" FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.recordId))
    const named = (recordId: string) => `${recordId} (${Object.entries(G).filter(([, value]) => JSON.stringify(value ?? null).includes(recordId)).map(([key]) => `G.${key}`).join(', ')})`
    expect(ids.filter((recordId) => !audited.has(recordId)).map(named)).toEqual([])
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE "tenantId" = $1', [w.tenant.id])).map((row) => row.type))
    expect(EVENTS.filter((type) => !events.has(type)), `seen: ${[...events].sort().join(' ')}`).toEqual([])
    expect(w.retried).toEqual([])
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(await admin(w, `SELECT type, status::text AS status FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })

})
