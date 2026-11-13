import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { fromMinorUnits, minorPlaces, type MinorUnits } from '@nexus/factory-domain/core/money'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { changeNoteOf, compareQuoteVersions, differsOf, differsWords, type CompareSection, type QuoteLineFacts, type QuoteVersionFacts } from '@nexus/factory-domain/sales/quote-compare/rules'
import { quoteDocumentNumber } from '@nexus/factory-domain/sales/quotes/document'
import { discountOf, STATUS_WORDS, type QuoteVersionStatus } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller } from '../../../core/command'
import { dayOf } from '../quotes/frozen'
import { day, decimal, grainsOf, officeContextOf, officeQuote, readLineRecords, VERSION_COLUMNS, type Reader } from '../quotes/store'

/**
 * Two versions of a quote compared (B-W2b-302; SAL-158; design sales.quotes quote.versions.compare "Compare two versions",
 * VersionCompare): GET /sales/quotes/:quoteId/versions/compare?from&to — quotes.view over the quote's company and customer.
 * `from` and `to` are revision numbers of the quote (default: the current one against the one before it); the same one twice is
 * a 400, a revision the quote does not have a 404. The answer: the two heads (VersionHead's label "Version 2" and note: the
 * status and when it was sent), the sections in VersionCompare's shape (terms and lines for every reader; prices only with the
 * price grain, margins only with the margin grain: the fields are left out for the others), what differs in words and a plain
 * change note from what the reader may see ("Use as change note").
 */

const EXTRA_VERSION = { incoterm: true, incotermPlace: true, shipComplete: true, acceptanceMode: true, sentAt: true } as const

/** A section as the contract writes it (mutable arrays). */
const plain = (section: CompareSection) => ({ ...section, fields: [...section.fields], sizes: [...section.sizes], lines: [...section.lines], totals: [...section.totals] })

const written = (amount: MinorUnits | null, currency: string): string | null => (amount === null ? null : fromMinorUnits(amount, currency).toFixed(minorPlaces(currency)))

/** One version as the compare reads it: its terms, totals and lines with their names, schedules and options. */
async function versionFacts(db: Reader, versionId: string): Promise<{ facts: QuoteVersionFacts; note: string; ranges: Map<string, readonly string[]> }> {
  const row = await db.quoteVersion.findUniqueOrThrow({ where: { id: versionId }, select: { ...VERSION_COLUMNS, ...EXTRA_VERSION } })
  const lines = await readLineRecords(db, versionId)
  const lineIds = lines.map((line) => line.id)
  const extras = new Map((await db.quoteLine.findMany({ where: { versionId }, select: { id: true, section: true, feeKind: true, adjustmentReason: true } })).map((line) => [line.id, line]))
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true, name: true, sizes: true } })).map((style) => [style.id, style]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true, name: true } })).map((colourway) => [colourway.id, colourway]))
  const revisionIds = [...new Set(lines.flatMap((line) => (line.styleRevisionId ? [line.styleRevisionId] : [])))]
  const revisions = new Map((await db.styleRevision.findMany({ where: { id: { in: revisionIds } }, select: { id: true, revision: true } })).map((revision) => [revision.id, revision]))
  const deliveries = lineIds.length === 0 ? [] : await db.quoteLineDelivery.findMany({ where: { lineId: { in: lineIds } }, select: { lineId: true, deliveryDate: true, sizeQuantities: true, quantity: true }, orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }] })
  const options = lineIds.length === 0 ? [] : await db.quoteLineOption.findMany({ where: { lineId: { in: lineIds } }, select: { lineId: true, freeText: true, value: { select: { name: true } }, group: { select: { name: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

  const schedule = (lineId: string): string | null => {
    const own = deliveries.filter((delivery) => delivery.lineId === lineId)
    if (own.length === 0) return null
    return own
      .map((delivery) => {
        const sizes = delivery.sizeQuantities && typeof delivery.sizeQuantities === 'object' && !Array.isArray(delivery.sizeQuantities) ? Object.entries(delivery.sizeQuantities as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number') : []
        return `${day(delivery.deliveryDate)}: ${sizes.length > 0 ? sizes.map(([size, pieces]) => `${size} ×${pieces}`).join(', ') : `×${delivery.quantity}`}`
      })
      .join(' · ')
  }
  const optionsOf = (lineId: string): string | null => {
    const own = options.filter((option) => option.lineId === lineId)
    return own.length === 0 ? null : own.map((option) => `${option.value?.name ?? option.group?.name ?? 'Option'}${option.freeText ? ` "${option.freeText}"` : ''}`).join(' · ')
  }

  const factsOfLine = (line: (typeof lines)[number]): QuoteLineFacts => {
    const style = styles.get(line.styleId)
    const colourway = colourways.get(line.colourwayId)
    const extra = extras.get(line.id)
    const unitPrice = decimal(line.unitPrice)!
    const range = style?.sizes ?? []
    const ordered = [...line.sizes].sort((a, b) => range.indexOf(a.size) - range.indexOf(b.size))
    return {
      id: line.id,
      seq: line.seq,
      kind: line.kind,
      feeKind: extra?.feeKind ?? null,
      section: extra?.section ?? null,
      styleId: line.styleId,
      style: style ? `${style.code} ${style.name}` : line.styleId,
      colourwayId: line.colourwayId,
      colourway: colourway ? `${colourway.code} ${colourway.name}` : line.colourwayId,
      revision: line.styleRevisionId && revisions.get(line.styleRevisionId) ? `Rev ${revisions.get(line.styleRevisionId)!.revision}` : null,
      description: line.description,
      note: line.note,
      quantity: line.quantity,
      sizes: Object.fromEntries(ordered.map((row) => [row.size, row.quantity])),
      deliveries: schedule(line.id),
      options: optionsOf(line.id),
      unitPrice,
      listUnitPrice: decimal(line.listUnitPrice),
      discountPct: discountOf({ unitPrice, listUnitPrice: decimal(line.listUnitPrice), sizes: line.sizes }),
      sizePrices: Object.fromEntries(ordered.filter((row) => row.unitPrice !== null && row.unitPrice !== unitPrice).map((row) => [row.size, row.unitPrice!])),
      net: written(line.netAmount, row.currency)!,
      adjustmentReason: extra?.adjustmentReason ?? null,
      marginPct: line.marginPct === null ? null : decimal(line.marginPct),
    }
  }

  const facts: QuoteVersionFacts = {
    revision: row.revision,
    status: row.status,
    validUntil: dayOf(row.validUntil),
    firmOffer: row.firmOffer,
    promiseDate: dayOf(row.promiseDate),
    paymentTerms: row.paymentTerms,
    depositPct: decimal(row.depositPct),
    depositKind: row.depositKind,
    acceptanceMode: row.acceptanceMode,
    incoterm: row.incoterm,
    incotermPlace: row.incotermPlace,
    shipComplete: row.shipComplete,
    language: row.language,
    currency: row.currency,
    termsVersion: row.termsVersion,
    net: written(row.netAmount, row.currency)!,
    vat: written(row.vatAmount, row.currency)!,
    gross: written(row.grossAmount, row.currency)!,
    deposit: written(row.depositAmount, row.currency),
    marginPct: row.marginPct === null ? null : decimal(row.marginPct),
    lines: lines.map(factsOfLine),
  }
  const sent = row.sentAt ? `sent ${day(row.sentAt)}` : null
  const note = [STATUS_WORDS[row.status as QuoteVersionStatus] ?? row.status, sent].filter(Boolean).join(' · ')
  return { facts, note, ranges: new Map([...styles.values()].map((style) => [style.id, style.sizes])) }
}

/** GET /sales/quotes/:quoteId/versions/compare (quotes.view): see the module comment. */
export async function compareVersions(caller: CommandCaller, quoteId: string, query: { from?: number | undefined; to?: number | undefined }) {
  const grains: ReadonlySet<Grain> = grainsOf(officeContextOf(caller))
  const quote = await officeQuote(caller, quoteId)
  const to = query.to ?? quote.currentRevision
  const from = query.from ?? to - 1
  if (from === to) throw new ValidationError('Pick two different versions to compare.', [{ path: 'querystring/from', message: 'The same version twice.' }])
  return caller.withClient(async (client) => {
    const versions = await client.quoteVersion.findMany({ where: { quoteId: quote.id, revision: { in: [from, to] } }, select: { id: true, revision: true } })
    const before = versions.find((version) => version.revision === from)
    const after = versions.find((version) => version.revision === to)
    if (!before || !after) throw new NotFoundError(`The quote has no version ${!before ? from : to}${quote.currentRevision === 1 ? ': only version 1 exists' : ` (versions 1 to ${quote.currentRevision})`}.`)
    const a = await versionFacts(client, before.id)
    const b = await versionFacts(client, after.id)
    const ranges = new Map([...a.ranges, ...b.ranges])
    const [terms, lines, prices, margin] = compareQuoteVersions(a.facts, b.facts, (styleId) => ranges.get(styleId) ?? [])
    const visible = [terms!, lines!, ...(grains.has('price') ? [prices!] : []), ...(grains.has('margin') ? [margin!] : [])]
    const differs = differsOf(visible)
    return {
      quote: { id: quote.id, number: quote.number, currentRevision: quote.currentRevision },
      before: { id: before.id, revision: from, label: `Version ${from}`, note: a.note, documentNumber: quoteDocumentNumber(quote.number, from) },
      after: { id: after.id, revision: to, label: `Version ${to}`, note: b.note, documentNumber: quoteDocumentNumber(quote.number, to) },
      currency: b.facts.currency,
      sections: [plain(terms!), plain(lines!)],
      prices: asMoney('price', { ...plain(prices!), totals: asMoney('price', [...prices!.totals]) }),
      margin: asMoney('margin', { ...plain(margin!), totals: asMoney('margin', [...margin!.totals]) }),
      differs,
      words: differsWords(differs),
      changeNote: changeNoteOf(visible),
    }
  })
}
