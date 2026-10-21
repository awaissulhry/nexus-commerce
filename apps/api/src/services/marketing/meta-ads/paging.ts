/**
 * Meta ads — the read helpers every live read shares, in a LEAF module (step 12 fix A4: it imports only the read client,
 * the errors and live.ts's refusal, so the catalog rule — catalog-rule.ts, which lane C4's write path imports — never
 * reaches live-objects.ts or live-media.ts and no import cycle forms). Moved here unchanged from step 6 (listPaged,
 * fieldRefused: live-objects.ts re-exports them) and step 10 (refusedFields, oneWithFallback, listWithFallback, part:
 * live-media.ts re-exports them); listWithFallback also takes Meta's total (step 12 fix B5).
 */
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal } from './live.js'

type Row = Record<string, unknown>

const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
/** A Graph list field: an array, or an edge `{ data: [...] }`. */
const rowsOf = (v: unknown): Row[] => {
  const list = Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]) : []
  return list.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r))
}

/**
 * Review fix A5 (step 6) — Meta refused a FIELD it was asked: only then does asking for less help. Either a #100
 * ("nonexisting field" and the like), or (re-review) a permission refusal FROM META (#3, #10, #200–#299) — a gated field (the
 * WhatsApp identity, learning stage, Instagram branded content) may be refused that way. Never on a lost token, a throttle,
 * the gateway, an object that is not there, a blocked account (#368), an account-wide insights refusal (100/3191001) or
 * Meta failing on its side (transient: no answer, a 5xx, a timeout). A refused core group still ends the read.
 */
export function fieldRefused(err: unknown): err is MetaReadError {
  if (!(err instanceof MetaReadError)) return false
  const f = err.failure
  if (f.origin !== 'meta' || f.authLost || f.throttled || f.notFound || f.transient || !f.code) return false
  if (f.permissionDenied) return /^(3|10|2\d\d)(\/|$)/.test(f.code)
  return /^100(\/|$)/.test(f.code)
}

export const MAX_ROWS = 500

/**
 * A list, page by page (cursor `after`; Meta's next link carries the token and is never followed), with Meta's total.
 * `pageSize`: at most this many per call (step 14: Instagram answers at most 50 comments per call).
 */
export async function listPaged(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number, withTotal = false, pageSize = 100): Promise<{ rows: Row[]; more: boolean; totalCount: number | null }> {
  const max = Math.min(MAX_ROWS, Math.max(1, Math.trunc(maxRows)))
  const limit = Math.min(Math.max(1, Math.trunc(pageSize)), 100, max)
  const rows: Row[] = []
  let after: string | null = null
  let totalCount: number | null = null
  for (let page = 0; page < 50; page++) {
    const read = await metaReadOne<{ data?: unknown[]; paging?: { cursors?: { after?: unknown }; next?: unknown }; summary?: { total_count?: unknown } }>({ connectionId }, {
      operation, path, query: { ...query, limit, ...(withTotal && !after ? { summary: 'total_count' } : {}), ...(after ? { after } : {}) },
    })
    if (page === 0) totalCount = num(read.body.summary?.total_count)
    rows.push(...rowsOf(read.body.data))
    const next = typeof read.body.paging?.cursors?.after === 'string' && read.body.paging?.next ? read.body.paging.cursors.after : null
    if (rows.length >= max || !next) return { rows: rows.slice(0, max), more: rows.length > max || (!!next && rows.length >= max), totalCount }
    after = next
  }
  return { rows: rows.slice(0, max), more: true, totalCount }
}

/**
 * The SDK-only fields Meta refused: the ones its words name ("nonexisting field (x)"), else all of them. Only those are
 * dropped, so one refused field never takes the others with it.
 */
export function refusedFields(more: string[], err: MetaReadError): string[] {
  const named = [...err.failure.sentence.matchAll(/\(([a-z_]+)\)/g)].map((m) => m[1]).filter((f) => more.includes(f))
  return named.length ? named : more
}

/** Read with the documented fields plus the SDK-only ones; each refused SDK-only field is dropped (at most 4 tries). */
async function withFallback<T>(core: string, more: string, read: (fields: string) => Promise<T>): Promise<{ value: T; note: string | null }> {
  let asked = more ? more.split(',') : []
  const dropped: string[] = []
  let last = ''
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await read(asked.length ? `${core},${asked.join(',')}` : core)
      return { value, note: dropped.length ? `Meta refused ${dropped.join(', ')} here, so ${dropped.length === 1 ? 'it is' : 'they are'} missing: ${last}` : null }
    } catch (err) {
      if (!asked.length || !fieldRefused(err) || attempt >= 3) throw err
      const refused = attempt === 2 ? asked : refusedFields(asked, err)
      dropped.push(...refused)
      asked = asked.filter((f) => !refused.includes(f))
      last = err.failure.sentence
    }
  }
}

export async function oneWithFallback(connectionId: string, operation: string, path: string, core: string, more: string, query: Record<string, MetaQueryValue> = {}) {
  const read = await withFallback(core, more, async (fields) => (await metaReadOne({ connectionId }, { operation, path, query: { ...query, fields } })).body as Row)
  return { body: read.value, note: read.note }
}

export async function listWithFallback(connectionId: string, operation: string, path: string, core: string, more: string, query: Record<string, MetaQueryValue>, maxRows: number, withTotal = false) {
  const read = await withFallback(core, more, (fields) => listPaged(connectionId, operation, path, { ...query, fields }, maxRows, withTotal))
  return { ...read.value, note: read.note }
}

/**
 * One part of an answer that may fail on its own (an edge Meta may refuse): its rows, or Meta's sentence. By default a
 * lost token or a throttle stops the whole read (the catalog reads: more calls would only fail). `stopOnLost: false`
 * (step 16's reads, as merged in #706) makes them "not read" for this part too and keeps the parts already read; the
 * gateway holds Meta calls after a throttle, so later parts are refused locally without another Meta call.
 */
export async function part<T>(work: () => Promise<T>, options: { stopOnLost?: boolean } = {}): Promise<{ value: T | null; notRead: string | null }> {
  try {
    return { value: await work(), notRead: null }
  } catch (err) {
    if (err instanceof MetaReadError && (options.stopOnLost === false || (!err.failure.authLost && !err.failure.throttled))) return { value: null, notRead: err.failure.sentence }
    if (err instanceof MetaLiveRefusal) return { value: null, notRead: err.message }
    throw err
  }
}
