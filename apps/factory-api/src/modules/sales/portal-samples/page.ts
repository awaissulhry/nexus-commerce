import type { FastifyInstance, FastifyRequest } from 'fastify'
import { KIND_RULES, type ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { PORTAL_APPROVALS_VIEW } from '@nexus/factory-domain/approvals-out/permissions'
import { PORTAL_APPROVE } from '@nexus/factory-domain/auth/partners/permissions'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import {
  brandRoundStatus,
  brandTechPacks,
  inDevelopment,
  isWaitingRecord,
  latestRoundOf,
  nextDateOf,
  outboundOf,
  safeTrackingUrl,
  styleStageOf,
  techPackToOffer,
  waitingOrder,
  type BrandTechPack,
  type PortalLocale,
  type WaitingRecordType,
} from '@nexus/factory-domain/sales/portal-samples/rules'
import { cellsOf, piecesOf, roundLabel, type SampleKind } from '@nexus/factory-domain/sales/samples/rules'
import { localeOf } from '../../../platform/approvals-out/store'
import { portalReader } from '../portal-orders/access'
import { nameIn, readBrandStyles, readRevisions, readRounds, readShipments, readStyles, readSwatches, readTechPackVersions, readWaitingRequests, type RoundRow, type ShipmentRow, type StyleRow } from './store'

/**
 * GET /portal/samples (B-W2b-262; PRD-245; design portal.customer.samples, SCR-225): the brand's page in one answer.
 *
 *   waiting   its OPEN approval requests of a product kind (sample, colour, leather, artwork) on a round, a swatch or a
 *             style — overdue first; answered through B-W2b-184's GET /portal/approvals/:id and POST …/answer (the
 *             decision lands on the round by B-W2b-252's settle). Null for a role without portal.approvals.view.
 *   styles    its own private-label styles (Style.brandPartyId = the party) still in development or with a round open:
 *             stage, latest round, next date, what waits, the BRAND tech pack versions it may open (never INTERNAL or
 *             SUBCONTRACTOR, never another brand's or a tenant-wide style's)
 *   rounds    every round of the party in the portal's company: status in the brand's words, the outbound shipment with
 *             its tracking, the request waiting for it
 *
 * The partner's rows are read in its own scope (row-level security); the styles and tech pack versions in the tenant's
 * scope as the person, only for what the partner read names or for the party's own styles. No money and no office person
 * is read at all.
 */

const day = (value: Date | null): string | null => (value ? toUtcIso(value).slice(0, 10) : null)
const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

const roundWords = (round: Pick<RoundRow, 'number' | 'kind' | 'roundNo'>) => ({
  it: `${round.number} · ${roundLabel(round.kind as SampleKind, round.roundNo, 'it')}`,
  en: `${round.number} · ${roundLabel(round.kind as SampleKind, round.roundNo, 'en')}`,
})

type Words = { it: string; en: string }
interface WaitingRow {
  requestId: string
  kind: ApprovalKind
  recordType: WaitingRecordType
  recordId: string
  label: Words
  style: { id: string; code: string; name: string } | null
  round: { id: string; number: string; kind: SampleKind; roundNo: number; label: Words } | null
  swatch: { id: string; kind: 'COLOUR' | 'LEATHER' } | null
  question: string
  askedAt: string
  dueAt: string
  receivedAt: string | null
  version: number
}

const techPackView = (pack: BrandTechPack) => ({ id: pack.id, revision: pack.revision, revisionStatus: pack.revisionStatus, version: pack.version, language: pack.language, printed: pack.printed, createdAt: pack.createdAt, state: pack.state })

export async function samplesPage(app: FastifyInstance, request: FastifyRequest, now: Date) {
  const reader = portalReader(app, request)
  const { session, actor } = reader
  const companyId = session.company.id
  const partyId = session.partyId
  const scope = { companyId, partyId }
  const locale: PortalLocale = localeOf(session.person.locale)
  const seesApprovals = can(actor, PORTAL_APPROVALS_VIEW, scope)
  const mayApprove = !session.preview && can(actor, PORTAL_APPROVE, scope)

  // The partner's own rows (one connection, one query at a time).
  const { rounds, shipments, requests, swatches } = await request.withClient(async (client) => {
    const rounds = await readRounds(client, companyId)
    const shipments = await readShipments(client, rounds.map((round) => round.id))
    const requests = seesApprovals ? await readWaitingRequests(client, companyId) : []
    const swatches = await readSwatches(client, requests.filter((row) => row.recordType === 'SampleSwatch').map((row) => row.recordId))
    return { rounds, shipments, requests, swatches }
  })

  // The tenant's: the styles named and the party's own, their revisions and tech pack versions.
  const named = new Set<string>([...rounds.map((round) => round.styleId), ...swatches.map((swatch) => swatch.styleId), ...requests.filter((row) => row.recordType === 'Style').map((row) => row.recordId)])
  const { styles, own, revisions, versions } = await reader.inTenant(async (client) => {
    const own = await readBrandStyles(client, partyId, companyId)
    const styles = await readStyles(client, [...named].filter((id) => !own.some((style) => style.id === id)))
    const revisions = await readRevisions(client, own.map((style) => style.id))
    const versions = await readTechPackVersions(client, revisions.map((revision) => revision.id))
    return { styles: [...own, ...styles], own, revisions, versions }
  })
  const styleOf = new Map<string, StyleRow>(styles.map((style) => [style.id, style]))
  const styleRef = (styleId: string) => {
    const style = styleOf.get(styleId)
    return style ? { id: style.id, code: style.code, name: nameIn(style, locale) } : null
  }

  // Each round's outbound shipment and its waiting request.
  const shipmentsOf = new Map<string, ShipmentRow[]>()
  for (const shipment of shipments) shipmentsOf.set(shipment.roundId, [...(shipmentsOf.get(shipment.roundId) ?? []), shipment])
  const outbound = (roundId: string) =>
    outboundOf((shipmentsOf.get(roundId) ?? []).map((shipment) => ({ ...shipment, sentAt: iso(shipment.sentAt), createdAt: toUtcIso(shipment.createdAt) })))
  const openRequestOf = new Map<string, string>()
  for (const row of requests) if (row.recordType === 'SampleRound' && row.kind === 'SAMPLE') openRequestOf.set(row.recordId, row.id)

  const roundRows = rounds.map((round) => {
    const ship = outbound(round.id)
    const waitingRequestId = openRequestOf.get(round.id) ?? null
    return {
      id: round.id,
      number: round.number,
      kind: round.kind,
      roundNo: round.roundNo,
      label: roundWords(round),
      style: styleRef(round.styleId) ?? { id: round.styleId, code: '—', name: '—' },
      status: brandRoundStatus({ stage: round.stage, decision: round.decision, waiting: waitingRequestId !== null }),
      stage: round.stage,
      decision: round.decision,
      decidedAt: iso(round.decidedAt),
      dueDate: day(round.dueDate),
      pieces: piecesOf(cellsOf(round.cells)),
      shipment: ship ? { carrierName: ship.carrierName, trackingNumber: ship.trackingNumber, trackingUrl: safeTrackingUrl(ship.trackingUrl), sentAt: ship.sentAt, receivedAt: iso(ship.receivedAt) } : null,
      waitingRequestId,
      createdAt: toUtcIso(round.createdAt),
    }
  })
  const roundById = new Map(rounds.map((round) => [round.id, round]))

  // What waits for the brand.
  const swatchOf = new Map(swatches.map((swatch) => [swatch.id, swatch]))
  const waiting = requests.flatMap((row): WaitingRow[] => {
    if (!isWaitingRecord(row.recordType)) return []
    const kindName = KIND_RULES[row.kind].name
    const base = { requestId: row.id, kind: row.kind, recordType: row.recordType as WaitingRecordType, recordId: row.recordId, question: row.question, askedAt: toUtcIso(row.createdAt), dueAt: toUtcIso(row.dueAt), version: row.version }
    if (row.recordType === 'SampleRound') {
      const round = roundById.get(row.recordId)
      if (!round) return []
      const words = roundWords(round)
      return [{ ...base, label: { it: `${kindName.it} · ${words.it}`, en: `${kindName.en} · ${words.en}` }, style: styleRef(round.styleId), round: { id: round.id, number: round.number, kind: round.kind, roundNo: round.roundNo, label: words }, swatch: null, receivedAt: iso(outbound(round.id)?.receivedAt ?? null) }]
    }
    if (row.recordType === 'SampleSwatch') {
      const swatch = swatchOf.get(row.recordId)
      if (!swatch) return []
      const style = styleRef(swatch.styleId)
      const round = swatch.roundId ? roundById.get(swatch.roundId) : undefined
      const of = style ? style.code : ''
      return [
        {
          ...base,
          label: { it: `${kindName.it} · ${of}`, en: `${kindName.en} · ${of}` },
          style,
          round: round ? { id: round.id, number: round.number, kind: round.kind, roundNo: round.roundNo, label: roundWords(round) } : null,
          swatch: { id: swatch.id, kind: swatch.kind },
          receivedAt: null,
        },
      ]
    }
    const style = styleRef(row.recordId)
    if (!style) return []
    return [{ ...base, label: { it: `${kindName.it} · ${style.code}`, en: `${kindName.en} · ${style.code}` }, style, round: null, swatch: null, receivedAt: null }]
  })
  const waitingRows = waitingOrder(waiting, now)

  // The brand's own styles in development.
  const roundsOf = (styleId: string) => rounds.filter((round) => round.styleId === styleId).map((round) => ({ ...round, createdAt: toUtcIso(round.createdAt) }))
  const revisionsOf = (styleId: string) => revisions.filter((revision) => revision.styleId === styleId).map((revision) => ({ id: revision.id, revision: revision.revision, status: revision.status }))
  const versionFacts = versions.map((version) => ({ id: version.id, revisionId: version.recordId, version: version.version, layout: version.layout, language: version.language, fingerprint: version.fingerprint, createdAt: toUtcIso(version.createdAt), companyId: version.companyId }))
  const styleRows = own
    .filter((style) => inDevelopment(style, roundsOf(style.id)))
    .map((style) => {
      const mine = roundsOf(style.id)
      const latest = latestRoundOf(mine)
      const packs = brandTechPacks(style, partyId, companyId, versionFacts, revisionsOf(style.id))
      const offer = techPackToOffer(packs, locale)
      const waitingHere = waitingRows.filter((row) => row.style?.id === style.id)
      const open = mine.filter((round) => round.stage !== 'DECIDED' && round.stage !== 'CANCELLED')
      return {
        id: style.id,
        code: style.code,
        name: nameIn(style, locale),
        season: style.season,
        stage: styleStageOf(style, mine),
        latestRound: latest ? { id: latest.id, number: latest.number, kind: latest.kind, roundNo: latest.roundNo, status: roundRows.find((row) => row.id === latest.id)!.status } : null,
        nextDate: nextDateOf([...open.map((round) => day(round.dueDate)), ...waitingHere.map((row) => row.dueAt)]),
        waiting: waitingHere.length,
        openRounds: open.length,
        techPack: offer ? techPackView(offer) : null,
        techPacks: packs.map(techPackView),
      }
    })

  return {
    asOf: toUtcIso(now),
    mayApprove,
    waiting: seesApprovals ? waitingRows : null,
    styles: styleRows,
    rounds: roundRows,
    counts: { waiting: seesApprovals ? waitingRows.length : null, styles: styleRows.length, rounds: roundRows.length, open: roundRows.filter((row) => row.stage !== 'DECIDED' && row.stage !== 'CANCELLED').length },
  }
}
