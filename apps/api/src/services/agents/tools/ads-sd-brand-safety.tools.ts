/**
 * Sponsored Display extras (P3c) — the advertiser's brand-safety deny list (the websites and apps where none of its
 * Sponsored Display ads may show), read and changed live at Amazon through advertising/sd/sd-brand-safety.client.ts.
 *
 *   sd-brand-safety       read: the list (paged), the changes asked in the last 90 days, or one change with its results.
 *   set-sd-brand-safety   add    websites and apps to the list;
 *                         clear  EVERY website and app off the list: Amazon has no way to remove one ("delete the list
 *                                and re-upload the list"). To remove some, clear the list, and once Amazon says the clear
 *                                is COMPLETED, add back the rest.
 *
 * ACCOUNT-WIDE: there is ONE list per Amazon Ads profile, and every Sponsored Display campaign of the account in that market
 * follows it; every preview says so. Amazon works through a change asynchronously (an add shows within ~15 minutes, a
 * clear can take hours) and answers with a request id, which the read follows. Brand safety is for sellers in Amazon Brand
 * Registry (US, CA, UK, DE, ES, FR, IT, NL, BR, MX, UAE); Amazon's refusal otherwise reaches the person in its words.
 *
 * Like every ad change tool: a request a person approves (alwaysAsk, ask at most), the preview names every site and app
 * from → to and where it lands (in sandbox mode it is not queued), `execute` reads the list again and refuses when it moved,
 * and the change is recorded so undo asks for the opposite one where Amazon can do it: an add to an empty list is undone
 * by a clear, a clear by adding the list back. A clear can let the ads serve on more sites: listed in raises (ADDS SPEND).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import {
  addSdDenyDomains, clearSdDenyList, listSdDenyList, SD_DENY_PAGE, sdBrandSafetyRequest, sdBrandSafetyRequests, sdBrandSafetyResults,
  type SdBrandSafetyRequest, type SdDenyDomain,
} from '../../advertising/sd/sd-brand-safety.client.js'
import { ADDS_NO_SPEND, addsSpendWords, DAY_TO_DAY_NO_CODE } from './ads-code-rule.js'
import { approvedRun, notRun, recheck, type StoredReach } from './ads-change-kit.js'
import {
  basisOf, NOTHING_CHANGED, NOTHING_QUEUED, plural, sandboxRead, sdAnswered, sdIdArg, sdMarketArg, sdMarketOf, sdReach, sdReachNote, sdWhyArg,
  type SdMarket,
} from './ads-sd-kit.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'set-sd-brand-safety'
/** Pages of the list read for a change (Amazon's pages hold 1,000). */
const PAGES_READ = 10
/** Websites and apps one request adds (Amazon takes 10,000; Nexus's tools take lists of at most 250). */
const MAX_DOMAINS = 250
/** Names a clear's record keeps, to add back on undo. */
const KEPT = 1000

const ACCOUNT_WIDE = (m: SdMarket) =>
  `ACCOUNT-WIDE: the deny list is one list for the whole advertiser (Amazon Ads profile ${m.profileId}, ${m.market}): every Sponsored Display campaign there follows it, not one campaign.`

const WEBSITE = /^(?=.{1,250}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const ANDROID_APP = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i
const IOS_APP = /^\d{5,15}$/

/** The ENABLED entries of the list (an archived one blocks nothing), the first PAGES_READ pages; `complete` when all read. */
async function enabledList(m: SdMarket): Promise<{ domains: SdDenyDomain[]; complete: boolean }> {
  const out: SdDenyDomain[] = []
  for (let page = 0; page < PAGES_READ; page++) {
    const { total, domains } = await listSdDenyList(m.ctx, { startIndex: page * SD_DENY_PAGE, count: SD_DENY_PAGE })
    out.push(...domains.filter((d) => (d.state ?? 'ENABLED').toUpperCase() === 'ENABLED'))
    const read = (page + 1) * SD_DENY_PAGE
    if (domains.length < SD_DENY_PAGE || (total != null && read >= total)) return { domains: out, complete: true }
  }
  return { domains: out, complete: false }
}

const key = (name: string) => name.trim().toLowerCase()
const typeWord = (t: string | null) => (t === 'APP' ? 'app' : 'website')

// ── sd-brand-safety (read) ────────────────────────────────────────────────────────────────────────────────────────

const readInput = z.object({
  market: sdMarketArg.describe('the Amazon market as business-overview lists it (IT, DE, FR, ES, UK, …): its advertiser\'s list'),
  view: z.enum(['list', 'requests', 'request']).default('list')
    .describe('list: the websites and apps on the deny list; requests: the changes asked in the last 90 days and their status; request: one change (requestId), with what it did to each site once COMPLETED'),
  requestId: sdIdArg.optional().describe('view request: the id a change answered with (set-sd-brand-safety, or view requests)'),
  startIndex: z.coerce.number().int().min(0).max(1_000_000).default(0).describe('view list: from this position (1,000 a page)'),
})

const sdBrandSafety: AgentTool = {
  name: 'sd-brand-safety',
  title: 'Sponsored Display brand safety',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: readInput,
  description:
    "The advertiser's Sponsored Display brand-safety deny list, read live from Amazon: the websites and apps where none of "
    + 'its Sponsored Display ads may show. ONE list per Amazon Ads profile (market), for every Sponsored Display campaign '
    + 'there. view list: the entries (name, website or app, state, added), 1,000 a page; view requests: the changes asked in '
    + 'the last 90 days (IN_PROGRESS, COMPLETED or FAILURE); view request: one change (requestId) and, once COMPLETED, what '
    + 'an add did to each entry. An add shows within ~15 minutes, a clear can take hours. For sellers in Amazon Brand '
    + 'Registry. Nothing is asked in sandbox mode. Change it with set-sd-brand-safety.',
  async handler(args) {
    const a = args as z.infer<typeof readInput>
    const m = await sdMarketOf(a.market)
    if ('refusal' in m) return { ok: false, error: m.refusal }
    if (a.view === 'request' && !a.requestId) return { ok: false, error: 'view request needs requestId (view requests lists them).' }
    const sandbox = sandboxRead()
    if (sandbox) return sandbox
    return sdAnswered('', async () => {
      const scope = { market: m.market, profileId: m.profileId, accountWide: ACCOUNT_WIDE(m) }
      if (a.view === 'requests') {
        const requests = await sdBrandSafetyRequests(m.ctx)
        return { ok: true, data: { ...scope, requests, ...(requests.length ? {} : { empty: 'No change of the deny list was asked in the last 90 days.' }) } }
      }
      if (a.view === 'request') {
        const request: SdBrandSafetyRequest = await sdBrandSafetyRequest(m.ctx, a.requestId!)
        const results = (request.status ?? '').toUpperCase() === 'COMPLETED' ? await sdBrandSafetyResults(m.ctx, a.requestId!).catch(() => null) : null
        return {
          ok: true,
          data: {
            ...scope, request,
            ...(results ? { results, failed: results.filter((r) => (r.status ?? '').toUpperCase() === 'FAILURE').length } : {}),
            ...(results === null && (request.status ?? '').toUpperCase() === 'COMPLETED' ? { note: 'Amazon gives results for an add only; a clear is checked on the list itself (view list).' } : {}),
          },
        }
      }
      const page = await listSdDenyList(m.ctx, { startIndex: a.startIndex, count: SD_DENY_PAGE })
      const next = a.startIndex + page.domains.length
      return {
        ok: true,
        data: {
          ...scope, total: page.total, startIndex: a.startIndex,
          domains: page.domains.map((d) => ({ name: d.name, type: typeWord(d.type), state: d.state, addedAt: d.createdAt })),
          ...(page.total != null && next < page.total ? { more: `There are more: ask again with startIndex ${next}.` } : {}),
          ...(page.domains.length ? {} : { empty: `The deny list of ${m.market}'s advertiser is empty${a.startIndex ? ' from that position' : ''}: its Sponsored Display ads may show on any site Amazon's own brand-safety rules allow.` }),
        },
      }
    })
  },
}

// ── set-sd-brand-safety (change) ──────────────────────────────────────────────────────────────────────────────────

const input = z.object({
  op: z.enum(['add', 'clear']).describe('add: websites and apps onto the deny list; clear: EVERY entry off it (Amazon cannot remove one)'),
  market: sdMarketArg.describe("the Amazon market (IT, DE, …): its advertiser's one list"),
  domains: z.array(z.object({
    name: z.string().trim().min(1).max(250).describe('a website as a domain (example.com — it also blocks its sub-domains; no http:// and no path), or an app: an Android package id (com.example.app) or an iOS id (digits)'),
    type: z.enum(['website', 'app']).describe('website or app'),
  })).min(1).max(MAX_DOMAINS).optional().describe(`add: up to ${MAX_DOMAINS} websites and apps`),
  why: sdWhyArg,
})
type Args = z.infer<typeof input>

interface Plan {
  op: 'add' | 'clear'
  market: SdMarket
  /** The enabled entries now (names as Amazon holds them). */
  now: SdDenyDomain[]
  complete: boolean
  /** add: the new entries (those already on it left out). */
  adding: Array<{ name: string; type: 'WEBSITE' | 'APP' }>
  busy: SdBrandSafetyRequest[]
}

const refuse = (error: string): { result: ToolResult; plan: null } => ({ result: { ok: false, error }, plan: null })

/** A website or app as Amazon takes it; or why not. */
function domainOf(d: { name: string; type: 'website' | 'app' }): { name: string; type: 'WEBSITE' | 'APP' } | { refusal: string } {
  const name = d.name.trim()
  if (/[^\x20-\x7e]/.test(name)) return { refusal: `"${name}": Amazon takes ASCII characters only (write an international domain in its xn-- form).` }
  if (d.type === 'website') {
    const domain = name.toLowerCase()
    if (/[/:?#@\s]/.test(domain)) return { refusal: `"${name}": a website is a domain such as example.com — no http://, no path, no single page.` }
    if (!WEBSITE.test(domain)) return { refusal: `"${name}" is not a domain Amazon takes (example.com, or a sub-domain such as news.example.com).` }
    return { name: domain, type: 'WEBSITE' }
  }
  if (!ANDROID_APP.test(name) && !IOS_APP.test(name)) return { refusal: `"${name}" is not an app id: an Android package id (com.example.app) or an iOS id (digits).` }
  return { name, type: 'APP' }
}

async function decide(raw: Record<string, unknown>): Promise<{ result: ToolResult; plan: Plan | null }> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a = parsed.data
  if (a.op === 'add' && !a.domains?.length) return refuse(`Not queued: op add needs domains. ${NOTHING_QUEUED}`)
  if (a.op === 'clear' && a.domains?.length) {
    return refuse(`Not queued: op clear removes every entry and takes no domains (Amazon cannot remove one; to keep some, add them back once the clear is COMPLETED). ${NOTHING_QUEUED}`)
  }
  const m = await sdMarketOf(a.market)
  if ('refusal' in m) return refuse(`Not queued: ${m.refusal} ${NOTHING_QUEUED}`)
  const adding: Plan['adding'] = []
  for (const d of a.domains ?? []) {
    const ok = domainOf(d)
    if ('refusal' in ok) return refuse(`Not queued: ${ok.refusal} ${NOTHING_QUEUED}`)
    if (!adding.some((x) => key(x.name) === key(ok.name))) adding.push(ok)
  }
  const landed = await sdReach(m.market)
  if ('refusal' in landed) return refuse(landed.refusal.startsWith('Not queued') ? landed.refusal : `Not queued: ${landed.refusal}`)
  const { domains: now, complete } = await enabledList(m)
  const busy = (await sdBrandSafetyRequests(m.ctx)).filter((r) => (r.status ?? '').toUpperCase() === 'IN_PROGRESS')
  const on = new Set(now.map((d) => key(d.name)))
  const plan: Plan = { op: a.op, market: m, now, complete, adding: adding.filter((d) => !on.has(key(d.name))), busy }
  if (a.op === 'add' && !plan.adding.length) return refuse(`Nothing would change: ${plural(adding.length, 'entry', 'entries')} ${adding.length === 1 ? 'is' : 'are'} on the deny list already. ${NOTHING_QUEUED}`)
  if (a.op === 'clear' && !now.length) return refuse(`Nothing would change: the deny list of ${m.market}'s advertiser is empty. ${NOTHING_QUEUED}`)
  return { plan, result: previewOf(plan, landed.reach, adding.length - plan.adding.length) }
}

function previewOf(plan: Plan, reach: StoredReach, already: number): ToolResult {
  const m = plan.market
  const count = `${plan.complete ? '' : 'at least '}${plan.now.length}`
  const raises: string[] = []
  const warnings: string[] = [ACCOUNT_WIDE(m)]
  let summary: string
  let changes: Record<string, { from: unknown; to: unknown }>
  const names = (list: ReadonlyArray<{ name: string }>) => `${list.slice(0, 10).map((d) => d.name).join(', ')}${list.length > 10 ? ` and ${list.length - 10} more` : ''}`
  if (plan.op === 'add') {
    changes = { 'deny list': { from: `${count} entries`, to: `${count} + ${plan.adding.length}: ${names(plan.adding)}` } }
    summary = `Adds ${plural(plan.adding.length, 'website or app', 'websites and apps')} to the Sponsored Display deny list of ${m.market}'s advertiser: ${names(plan.adding)}. None of its Sponsored Display ads will show there (within ~15 minutes).`
    if (already) warnings.push(`${plural(already, 'entry', 'entries')} asked ${already === 1 ? 'is' : 'are'} on the list already and left out.`)
  } else {
    changes = { 'deny list': { from: `${count} entries: ${names(plan.now)}`, to: 'empty' } }
    raises.push(`its Sponsored Display ads may show again on ${count} websites and apps`)
    summary = `Clears the Sponsored Display deny list of ${m.market}'s advertiser: all ${count} websites and apps come off it (Amazon cannot remove one; it can take several hours).`
    warnings.push('To remove only some: once this clear is COMPLETED (sd-brand-safety view requests), add back the ones to keep with op add.')
  }
  if (!plan.complete) warnings.push(`Nexus read the first ${PAGES_READ * SD_DENY_PAGE} entries of the list.`)
  if (plan.busy.length) warnings.push(`Amazon is still working through ${plural(plan.busy.length, 'earlier change')} of the list (${plan.busy.map((r) => r.requestId).join(', ')}): a clear still running can also take off what is added now. Wait until ${plan.busy.length === 1 ? 'it is' : 'they are'} COMPLETED if in doubt.`)
  return {
    ok: true,
    preview: {
      action: TOOL,
      op: plan.op,
      market: m.market,
      profileId: m.profileId,
      accountWide: true,
      summary,
      changes,
      totals: { onListNow: plan.now.length, adding: plan.adding.length, removing: plan.op === 'clear' ? plan.now.length : 0 },
      ...(plan.op === 'add' ? { adding: plan.adding } : {}),
      raises,
      noCode: raises.length ? DAY_TO_DAY_NO_CODE : ADDS_NO_SPEND,
      warnings,
      basis: basisOf({ op: plan.op, now: plan.now.map((d) => key(d.name)).sort(), adding: plan.adding.map((d) => key(d.name)).sort() }),
      reach,
      reachNote: sdReachNote(reach),
      effect: `${summary}${addsSpendWords(raises, false)}`,
      undoNote: plan.op === 'add'
        ? plan.now.length ? 'Undo cannot take only these off: Amazon removes the whole list (op clear) — the record names what was there.' : 'Undo clears the list again (op clear): it was empty before.'
        : `Undo adds back the entries it removed (op add)${plan.now.length > MAX_DOMAINS ? `, ${MAX_DOMAINS} a request` : ''}.`,
    },
  }
}

/** What a change of this tool records: the market, how many entries the list held, and what it added or removed. */
interface ListRecord { op: 'add' | 'clear'; market: string; count: number | null; added?: string[]; domains?: Array<{ name: string; type: string }> }

/** C2 — undo: an add to an empty list is cleared again; a clear adds back what it removed (up to 250 a request). */
export const SET_SD_BRAND_SAFETY_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as ListRecord
    if (!after.market) return change.after
    try {
      const m = await sdMarketOf(after.market)
      if ('refusal' in m) return { ...after, unreadable: m.refusal }
      const { domains } = await enabledList(m)
      if (after.op === 'add') {
        const on = new Set(domains.map((d) => key(d.name)))
        return { ...after, added: (after.added ?? []).filter((n) => on.has(key(n))) }
      }
      return { ...after, count: domains.length }
    } catch (error) {
      return { ...after, unreadable: error instanceof Error ? error.message : String(error) }
    }
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<ListRecord>
    const after = (change.after ?? {}) as Partial<ListRecord>
    if (!after.market) return { refusal: 'This change does not name the market of the list.' }
    const why = `undo of an earlier change of the Sponsored Display deny list (${after.op ?? '?'})`
    if (after.op === 'add') {
      if (before.count === 0) return { tool: TOOL, args: { op: 'clear', market: after.market, why } }
      return { refusal: `Amazon removes only the whole deny list, and it held ${before.count ?? 'some'} entries before this add: clear it (op clear) and add back what should stay, if that is meant.` }
    }
    const was = before.domains ?? []
    if (!was.length) return { refusal: 'This change does not record what was on the list.' }
    if ((before.count ?? was.length) > was.length) return { refusal: `The list held ${before.count} entries; Nexus kept the first ${was.length}. Add them back with op add, ${MAX_DOMAINS} a request.` }
    if (was.length > MAX_DOMAINS) return { refusal: `The list held ${was.length} entries: add them back with op add, ${MAX_DOMAINS} a request (this change's record names them).` }
    return { tool: TOOL, args: { op: 'add', market: after.market, domains: was.map((d) => ({ name: d.name, type: d.type === 'APP' ? 'app' : 'website' })), why } }
  },
}

async function run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const { result: fresh, plan } = await decide(args)
  const refusal = recheck(ctx, fresh, ['basis'])
  if (refusal || !plan) return notRun(refusal ?? `Not run: it is no longer a valid change. ${NOTHING_CHANGED}`)
  const p = fresh.preview as { effect: string; reach: StoredReach }
  const approved = approvedRun(ctx, String((args as Args).why ?? '') || p.effect)
  if ('refusal' in approved) return notRun(`Not run: ${approved.refusal}. ${NOTHING_CHANGED}`)
  const m = plan.market
  const follow = 'Amazon works through it in the background: sd-brand-safety view request follows it.'
  if (plan.op === 'add') {
    const { requestId } = await addSdDenyDomains(m.ctx, plan.adding)
    return {
      ok: true,
      data: { op: 'add', market: m.market, requestId, added: plan.adding.length, reach: p.reach, changeSetId: approved.changeSetId, note: follow },
      change: {
        before: { op: 'add', market: m.market, count: plan.complete ? plan.now.length : null, added: [] },
        after: { op: 'add', market: m.market, count: null, added: plan.adding.map((d) => d.name).sort() },
      },
    }
  }
  const { requestId } = await clearSdDenyList(m.ctx)
  return {
    ok: true,
    data: { op: 'clear', market: m.market, requestId, removed: plan.now.length, reach: p.reach, changeSetId: approved.changeSetId, note: `${follow} A clear can take several hours.` },
    change: {
      before: { op: 'clear', market: m.market, count: plan.complete ? plan.now.length : null, domains: plan.now.slice(0, KEPT).map((d) => ({ name: d.name, type: d.type ?? 'WEBSITE' })) },
      after: { op: 'clear', market: m.market, count: 0 },
    },
  }
}

const setSdBrandSafety: AgentTool = {
  name: TOOL,
  title: 'Change the Sponsored Display deny list',
  input,
  requires: [F.adsCampaignsManage],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Amazon removes only the whole list: an add to a list that held entries cannot be taken back alone.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: SET_SD_BRAND_SAFETY_UNDO,
  description:
    "Add websites and apps to the advertiser's Sponsored Display brand-safety deny list, or clear the whole list, live at "
    + 'Amazon. ACCOUNT-WIDE: one list per Amazon Ads profile (market), followed by every Sponsored Display campaign there. '
    + `op add: up to ${MAX_DOMAINS} websites (a domain such as example.com, which also blocks its sub-domains) and apps (an `
    + 'Android package id or an iOS id); ones already on it are left out. op clear: EVERY entry comes off — Amazon has no '
    + 'way to remove one; to remove some, clear it and add back the rest once the clear is COMPLETED. A clear can let the '
    + 'ads serve on more sites: listed in raises (ADDS SPEND). A person approves it in Nexus; the preview names the entries '
    + 'from → to and where it lands (live at Amazon on which profile; in sandbox mode it is not queued). Amazon works '
    + 'through it in the background (an add ~15 minutes, a clear hours) and answers with a request id that sd-brand-safety '
    + "follows. For sellers in Amazon Brand Registry; Amazon's refusal is passed on in its own words. Undo: a clear adds the "
    + 'entries back; an add to an empty list clears it again.',
  async handler(args) {
    return sdAnswered(NOTHING_QUEUED, async () => (await decide(args)).result)
  },
  async execute(args, ctx) {
    return sdAnswered(NOTHING_CHANGED, () => run(args, ctx))
  },
}

export const ADS_SD_BRAND_SAFETY_TOOLS: AgentTool[] = [sdBrandSafety, setSdBrandSafety]
