/**
 * Amazon A+ content (2026-10-19) — what the three A+ change tools share (aplus-change.tools.ts): their arguments, a
 * failure as the sentence the tool answers (a handler never throws), the run's own refusals (no approved preview, Amazon
 * publishing not live in Nexus), what Amazon publishes on an ASIN now, and the entity keys a change plan chains on.
 *
 * Every Amazon call goes through aplus-client.ts (the channel gateway). Nothing here writes to Nexus's A+ rows: Amazon's
 * document is the record, and the AgentChange keeps before and after.
 */
import { z } from 'zod'
import { normalizeLanguage } from '@nexus/shared/content-language'
import type { PlanEntityKey, ToolContext, ToolResult } from '../tool-types.js'
import { getAmazonPublishMode } from '../../amazon-publish-gate.service.js'
import { logger } from '../../../utils/logger.js'
import {
  AplusError, aplusErrorSentence, getContentDocument, searchContentPublishRecords,
  type AplusAsin, type AplusContentType, type AplusDocument, type AplusMessage, type AplusMetadata, type AplusTarget,
} from '../../aplus/aplus-client.js'
import { AplusImageError } from '../../aplus/aplus-images.js'

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

export const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
export const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)

export const aplusMarketArg = z.string().trim().toUpperCase().min(2).max(8)
  .describe('the Amazon market code as business-overview lists it, e.g. IT or DE')
export const aplusAccountArg = z.string().trim().min(1).max(64).optional()
  .describe('the Amazon account (an id from business-overview accounts), when the business has more than one')
export const aplusKeyArg = z.string().trim().min(1).max(200)
export const asinArg = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 capital letters and digits')

// ── sentences ───────────────────────────────────────────────────────────────────────────────────────────────────

export const NOTHING_QUEUED = 'Nothing was queued.'
export const NOTHING_CHANGED = 'Nothing was changed.'

export const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`
export const listed = (items: readonly string[], cap = 5) =>
  items.length > cap ? `${items.slice(0, cap).join(', ')} and ${items.length - cap} more` : items.join(', ')

/** An Amazon message (an error or a warning of its check) in words, without its full stop: its message, and its details when they add something. */
export const amazonSaid = (m: AplusMessage) => {
  const message = (m.message?.trim() || m.code).replace(/[.\s]+$/, '')
  const details = m.details?.trim()
  return details && details !== message ? `${message} (${details})` : message
}

/** A message's text with no link in it (an upload address carries a signature), short. */
const plainMessage = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, '(a link)').replace(/[.\s]+$/, '').slice(0, 300)

/**
 * A failure as the sentence the tool answers. `wrote`: it came from a write whose outcome Amazon did not tell (no
 * answer): then it must not say nothing changed — Amazon's own sentence says to read the document first.
 */
export function failureSentence(error: unknown, nothing: string, wrote = false): string {
  if (error instanceof AplusError) {
    const sentence = aplusErrorSentence(error)
    return wrote && error.code === 'no_answer' ? sentence : `${sentence} ${nothing}`
  }
  if (error instanceof AplusImageError) return `${error.message} ${nothing}`
  logger.warn('[aplus-tools] unexpected failure', { error: plainMessage(error) })
  return `Nexus could not do this: ${plainMessage(error)}. ${nothing}`
}

/** A handler or an execute that never throws: whatever fails is answered as a sentence. */
export async function answered(nothing: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    return { ok: false, error: failureSentence(error, nothing) }
  }
}

// ── where it lands ──────────────────────────────────────────────────────────────────────────────────────────────

/** The preview's warning when Amazon publishing is not live in Nexus (NEXUS_ENABLE_AMAZON_PUBLISH, AMAZON_PUBLISH_MODE). */
export function publishModeWarning(mode: string): string | null {
  return mode === 'live' ? null : `Amazon publishing is not live in Nexus (mode ${mode}): after approval this is NOT sent to Amazon.`
}

/**
 * The run's own refusals, before anything is read: it runs only as a request a person approved, only while Amazon
 * publishing is live in Nexus (A+ writes follow the Amazon publish mode; the image upload is outside the gateway's own
 * check), and never a request whose preview told the person it would not be sent.
 */
export function runRefusal(ctx: ToolContext): string | null {
  const approved = ctx.approvedPreview as { publishMode?: unknown } | null | undefined
  if (!approved || typeof approved !== 'object') return `A+ content changes only as a request a person approved in Nexus. ${NOTHING_CHANGED}`
  const mode = getAmazonPublishMode()
  if (mode !== 'live') return `Not sent: Amazon publishing is not live in Nexus (mode ${mode}), so nothing goes to Amazon. ${NOTHING_CHANGED}`
  if (approved.publishMode !== 'live') {
    return `Not sent: it was approved while Amazon publishing was not live in Nexus (its preview said it would not be sent). Ask for it again. ${NOTHING_CHANGED}`
  }
  return null
}

export const targetOf = (m: { accountId: string; marketplaceId: string }): AplusTarget => ({ accountId: m.accountId, marketplaceId: m.marketplaceId })

/** What every A+ change record names: the market, Amazon's marketplace, the account and the document. */
export interface AplusRecordKey { market: string; marketplaceId: string; accountId: string; contentReferenceKey: string }

/** The document a recorded change names, or null when it does not name one. */
export function recordKeyOf(record: unknown): AplusRecordKey | null {
  const r = (record ?? {}) as Partial<Record<keyof AplusRecordKey, unknown>>
  const ok = [r.market, r.marketplaceId, r.accountId, r.contentReferenceKey].every((v) => typeof v === 'string' && v.length > 0)
  return ok ? { market: r.market as string, marketplaceId: r.marketplaceId as string, accountId: r.accountId as string, contentReferenceKey: r.contentReferenceKey as string } : null
}

/** C6 — the document (its name, modules and status) and its ASIN set, as a change plan's steps name them. */
export const aplusEntity = (market: unknown, key: unknown): PlanEntityKey => `aplus:${String(market ?? '').trim().toUpperCase()}:${String(key ?? '').trim()}`
export const aplusAsinsEntity = (market: unknown, key: unknown): PlanEntityKey => `aplus-asins:${String(market ?? '').trim().toUpperCase()}:${String(key ?? '').trim()}`

// ── documents and ASINs ─────────────────────────────────────────────────────────────────────────────────────────

/** A language as Nexus names it (it, de, en), or null for a tag that is none. */
export function languageOf(tag: string | null | undefined): string | null {
  try {
    return tag ? normalizeLanguage(tag) : null
  } catch {
    return null
  }
}

/** The document as Amazon keeps it now: its modules and its metadata (status, badges, last update). */
export async function readDocument(t: AplusTarget, key: string): Promise<{ document: AplusDocument | null; metadata: AplusMetadata | null }> {
  const { record } = await getContentDocument(t, key, 'CONTENTS,METADATA')
  return { document: record.contentDocument, metadata: record.contentMetadata }
}

/** The kind a person reads: Premium A+, A+ or Brand Story. */
export function kindWord(contentType: string | null | undefined, badges: readonly string[] = []): string {
  if (contentType === 'BrandStory') return 'Brand Story'
  return badges.includes('PREMIUM') ? 'Premium A+' : 'A+'
}

export const sortedAsins = (asins: Iterable<string>) => [...new Set(asins)].sort()
/** The ASINs on which this document is what buyers see now. */
export const publishedOf = (rows: readonly AplusAsin[]) => sortedAsins(rows.filter((r) => r.badgeSet.includes('CONTENT_PUBLISHED')).map((r) => r.asin))
/** Badges with which Amazon shows no A+ on an ASIN: outside the brand, or not in the catalogue. */
export const INELIGIBLE_BADGES = ['BRAND_NOT_ELIGIBLE', 'CATALOG_NOT_FOUND'] as const
export const ineligibleOf = (rows: readonly AplusAsin[]) =>
  rows.flatMap((r) => {
    const bad = r.badgeSet.filter((b) => (INELIGIBLE_BADGES as readonly string[]).includes(b))
    return bad.length ? [`${r.asin} (${bad.join(', ')})`] : []
  })

/** Amazon's warning code for an ASIN it would not show A+ on (outside the brand, an invalid ASIN). */
export const ASIN_FAILED = 'ASIN_FAILED_VALIDATION'
/** The ASINs of `among` a message of Amazon names (its details carry the ASIN). */
export function asinsNamed(m: AplusMessage, among: Iterable<string>): string[] {
  const text = `${m.details ?? ''} ${m.message ?? ''}`.toUpperCase()
  return [...among].filter((asin) => text.includes(asin))
}

/** Amazon's check of a document (validateContentDocumentAsinRelations), as a preview keeps it. */
export interface AmazonCheck { ran: boolean; errors: string[]; warnings: string[] }
export const NOT_CHECKED: AmazonCheck = { ran: false, errors: [], warnings: [] }

const familyOf = (contentType: string) => (contentType === 'BrandStory' ? 'Brand Story' : 'A+')
const PUBLISH_RECORD_ASINS = 20
const REPLACED_LINES = 3

/**
 * What approving this document replaces: the other document of the same family (A+, or Brand Story) that Amazon publishes
 * on each of these ASINs now (its publish records, for the first 20 ASINs), the first 3 by name. Amazon keeps one per ASIN
 * and family and replaces it silently, so the preview names each. Never fails the preview: a read that fails says so.
 */
export async function replacedOn(t: AplusTarget, key: string, contentType: AplusContentType, asins: readonly string[]): Promise<string[]> {
  if (!asins.length) return []
  const family = familyOf(contentType)
  const byKey = new Map<string, string[]>()
  try {
    for (const asin of asins.slice(0, PUBLISH_RECORD_ASINS)) {
      const { records } = await searchContentPublishRecords(t, asin)
      for (const record of records) {
        if (record.contentReferenceKey === key || familyOf(record.contentType) !== family) continue
        byKey.set(record.contentReferenceKey, sortedAsins([...(byKey.get(record.contentReferenceKey) ?? []), asin]))
      }
    }
  } catch (error) {
    return [`Nexus could not read what Amazon publishes on these ASINs now (${failureSentence(error, '').trim()}); approving it replaces the ${family} published there.`]
  }
  const lines: string[] = []
  for (const [other, on] of [...byKey].slice(0, REPLACED_LINES)) {
    let name: string | null = null
    try {
      name = (await getContentDocument(t, other, 'METADATA')).record.contentMetadata?.name ?? null
    } catch { /* named by its key */ }
    lines.push(`Once approved it replaces ${name ? `"${name}" (${other})` : `the ${family} document ${other}`} on ${listed(on)}: Amazon shows one ${family} per ASIN.`)
  }
  if (byKey.size > REPLACED_LINES) lines.push(`It replaces ${plural(byKey.size - REPLACED_LINES, 'more document')} on other ASINs (aplus-content view asin names them).`)
  if (asins.length > PUBLISH_RECORD_ASINS) lines.push(`Nexus read what is published on the first ${PUBLISH_RECORD_ASINS} of its ${asins.length} ASINs.`)
  return lines
}
