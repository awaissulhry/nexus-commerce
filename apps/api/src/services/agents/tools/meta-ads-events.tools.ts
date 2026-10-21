/**
 * Meta ads changes, step 33 (lane C3, 2026-10-21; Owner decision D2) — upload-meta-events: purchases from Nexus orders to
 * a pixel of the business's chosen Meta ad account through Meta's Conversions API (master rows SG-057–SG-067, SG-069–SG-071,
 * SG-073, SG-074). OFF by default per business (events-switch.ts: a person turns it on in Nexus). It sends only sales the
 * shop never saw (orders taken in by hand in Nexus): the shop platform's Meta integration sends the website's purchases
 * with an event_id Nexus cannot rebuild, so a copy from Nexus would count twice (change-events.ts says why). A hand-typed
 * sale cannot have been sent by the shop's pixel or server, so it skips step 11's website gap check (lane C3 decision,
 * review F3 / B6); the shop's own orders stay refused until the Nexus shop pixel step. Nexus today has no route that
 * creates such an order, so until one exists the tool sends nothing.
 *
 * A change like every Meta change (meta-ads-kit.ts): a preview from Nexus's orders and Meta's live state, an approvalId, a
 * person approves it, it runs as that person, re-checked first. It does not go through runMetaChange: an event is not an
 * object Nexus reads back (no status, no read-after-write), Meta keeps the valid events of a request it refuses, and what
 * may have reached Meta must be remembered even when Meta did not confirm it (so it is never sent again after Meta's 48-hour
 * merge window). Meta has no check for events (test_event_code is not a dry run) and no way to take one back:
 * reversibility 'none'. The buyers' e-mail and phone exist only hashed in the request body: never in the preview, the
 * answer, the record, the ledger (gateway `personal`) or a log.
 *
 * Rows answered in words, not by a part of this tool:
 *   - SG-063 limited data use: `data_processing_options` concerns US states only (DPO); Nexus sells in the EU and omits it.
 *   - SG-065 original_event_data links a delayed event (a renewal) to an earlier acquisition (parameters/server-event.md):
 *     a Nexus order is its own purchase, so Nexus has nothing to link.
 *   - SG-067 CRM lead stages (Conversion Leads): Nexus keeps no lead stages (step 14 reads leads; no CRM stage is held).
 *   - SG-070 business-messaging events need page_events / instagram_manage_events (App Review, Full access tier), and
 *     Nexus holds no messaging conversions: not sent.
 *   - SG-071 AppendAttribution needs a Custom Attribution Source Meta grants (Events Manager, SG-072 UI only): not sent.
 *   - SG-074 predicted_ltv: Nexus predicts no lifetime value, so it sends none.
 *   - SG-057 / SG-060 website events: refused for every order of the shop's website (the dedup rule above).
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { factHash, type AgentTool, type ToolContext, type ToolResult } from '../tool-types.js'
import { approvedRun, canonical, notRun } from './ads-change-kit.js'
import { metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, type MetaReach } from './meta-ads-kit.js'
import { metaChangeAccount, type MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import { eventsDraft, eventsWindowProblem, MAX_EVENTS_PER_CHANGE, type EventsDraft, type EventsRequest, type EventSource, type SentSale } from '../../marketing/meta-ads/change-events.js'
import { closeSendLog, eventsUploadDoubt, firstOrderTimes, MAX_EVENT_ORDERS_READ, nexusSentEvents, ordersForEvents, startSendLog } from '../../marketing/meta-ads/events-orders.js'
import { metaSendEvents } from '../../marketing/meta-ads/events-client.js'
import { META_EVENTS_OFF, metaEventsSwitch } from '../../marketing/meta-ads/events-switch.js'
import { MetaLiveRefusal, metaChosenAccount } from '../../marketing/meta-ads/live.js'
import { ownPixel } from '../../marketing/meta-ads/live-audiences.js'
import { metaReadOne } from '../../marketing/meta-ads/read-client.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { metaAdsWritesMode } from '../../gateway/channels.js'
import { META_EVENT_SOURCES, META_TEST_EVENT_CODE, NEXUS_PARTNER_AGENT } from '../../gateway/meta-events-rules.js'

export const UPLOAD_META_EVENTS = 'upload-meta-events'
const REVENUE = FIELDS.financialsRevenueView

const requestOf = (args: Record<string, unknown>, pixelId: string): EventsRequest => ({
  pixelId,
  from: args.from as string | undefined,
  to: args.to as string | undefined,
  orderIds: args.orderIds as string[] | undefined,
  manualAs: args.manualAs as EventSource | undefined,
  testEventCode: typeof args.testEventCode === 'string' && args.testEventCode ? args.testEventCode : undefined,
  customerSegment: args.customerSegment === true,
  contents: args.contents === true,
})

interface Built { account: MetaChangeAccount; pixelId: string; draft: EventsDraft }

/** The change from Nexus's orders and Meta's live state; reads only (Meta and Nexus), never sends. */
async function build(args: Record<string, unknown>): Promise<Built | { refusal: string }> {
  try {
    if (!(await metaEventsSwitch()).on) return { refusal: META_EVENTS_OFF }
    const now = new Date()
    const window = eventsWindowProblem({ from: args.from as string | undefined, to: args.to as string | undefined, orderIds: args.orderIds as string[] | undefined }, now)
    if (window) return { refusal: window }
    const connectionId = typeof args.connectionId === 'string' ? args.connectionId : null
    const account = await metaChangeAccount(connectionId)
    if ('refusal' in account) return account
    const asked = requestOf(args, typeof args.pixelId === 'string' ? args.pixelId : 'the pixel')
    const { orders, tooMany } = await ordersForEvents(asked)
    if (tooMany) return { refusal: `Nexus has more than ${MAX_EVENT_ORDERS_READ} orders in these days: send fewer days at a time.` }
    const sent = await nexusSentEvents(now)
    const buyers = [...new Set(orders.filter((o) => o.channel === 'MANUAL' && o.customerKey).map((o) => o.customerKey!))]
    const firstOrderAt = asked.customerSegment ? await firstOrderTimes(buyers) : new Map<string, Date>()
    // Nothing Nexus may send among these orders (website or marketplace sales, too old, sent): said before Meta is read.
    const first = eventsDraft(asked, { pixel: { pixelId: asked.pixelId, consolidated: true }, orders, sent, firstOrderAt, now })
    if ('refusal' in first) return first
    const chosen = await metaChosenAccount(account.accountId)
    // The chosen ad account's own pixel that no other business in Nexus uses (checked now), else refused in words.
    const pixelId = await ownPixel(chosen, typeof args.pixelId === 'string' ? args.pixelId : null)
    const pixel = await metaReadOne({ connectionId: chosen.connectionId }, { operation: 'events.pixel', path: pixelId, query: { fields: 'id,is_consolidated_container' } })
    const consolidated = (pixel.body as { is_consolidated_container?: unknown } | null)?.is_consolidated_container
    const request = { ...asked, pixelId }
    const draft = eventsDraft(request, {
      pixel: { pixelId, consolidated: typeof consolidated === 'boolean' ? consolidated : null },
      orders,
      sent,
      firstOrderAt,
      now,
    })
    return 'refusal' in draft ? draft : { account, pixelId, draft }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    if (err instanceof MetaReadError) return { refusal: `Nexus could not read the Meta ad account: ${err.message}` }
    throw err
  }
}

export interface EventsPreview {
  summary: string
  changes: EventsDraft['changes']
  totals: EventsDraft['totals']
  warnings: string[]
  spendsMoney: boolean
  spendsMoneyBecause?: string[]
  skipped?: string[]
  account: { accountId: string; adAccountId: string; name: string | null; currency: string | null }
  pixelId: string
  reach: MetaReach
  metaCheck: { checked: 'none'; sentence: string }
  requests: Array<{ step: number; label: string; metaCheck: 'no-check' }>
  basis: string
  plan: string
}

const NO_CHECK = 'Meta has no check for Conversions API events (a test_event_code is not a dry run: Meta counts test events too). The preview is built from Nexus\'s orders and Meta\'s live check of the pixel; when the approved change runs, Nexus reads both again and sends only if nothing it stands on moved.'

function previewOf(built: Built): EventsPreview {
  const { account, pixelId, draft } = built
  const mode = metaAdsWritesMode() === 'live' ? 'live' : 'off'
  const off = mode === 'off' ? ['Meta ads writes are switched off in Nexus (NEXUS_META_ADS_WRITES=off): after approval this change is NOT sent to Meta.'] : []
  return {
    summary: draft.summary,
    changes: draft.changes,
    totals: draft.totals,
    warnings: [...draft.spendsMoney.map((s) => `SPENDS MONEY (your decision): ${s}`), ...off, ...draft.warnings],
    spendsMoney: draft.spendsMoney.length > 0,
    ...(draft.spendsMoney.length ? { spendsMoneyBecause: draft.spendsMoney } : {}),
    ...(draft.skipped.length ? { skipped: draft.skipped } : {}),
    account: { accountId: account.accountId, adAccountId: account.adAccountId, name: account.name, currency: account.currency },
    pixelId,
    reach: { mode, accountId: account.accountId, adAccountId: account.adAccountId },
    metaCheck: { checked: 'none', sentence: NO_CHECK },
    requests: draft.requests.map((r) => ({ step: r.step, label: r.label, metaCheck: 'no-check' as const })),
    basis: factHash(draft.stands),
    // The exact plan: the requests' sales, ids, times, values and which match keys — never a buyer's hash.
    plan: factHash({ pixelId, requests: draft.requests.map((r) => ({ test: r.params.test_event_code ?? null, sales: r.planView })) }),
  }
}

/** One request of a run, as the answer reports it (no buyer's data, only Meta's words scrubbed of hashes). */
interface RunStep { step: number; label: string; outcome: 'done' | 'maybe' | 'none' | 'not_sent'; received: number | null; sentence: string }
/** A sale as the record keeps it: when it went and whether Meta confirmed it. */
interface RecordedSale extends SentSale { sentAt: string; confirmed: boolean }
/** `sendId`: the run's send log (events-orders.ts): a log with no record carrying its id stops every upload for 9 days. */
export interface EventsRecord { pixelId: string; test: boolean; sendId: string; sent: RecordedSale[] }

async function run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const approval = approvedRun(ctx, String(args.why ?? ''))
  if ('refusal' in approval) return notRun(`Not run: ${approval.refusal}.`)
  if (ctx.decidedVia === 'auto' || ctx.approvedByPerson !== true) {
    return notRun('Not run: sales go to Meta only when a person approved it (in Nexus, or by this business\'s "Claude\'s changes need no approval" switch in the name of the person who asked), never by a rule.')
  }
  const approved = (ctx.approvedPreview ?? {}) as Partial<EventsPreview>
  if (!approved.reach || !approved.basis || !approved.plan) return notRun('Not run: this request does not record what was approved. Ask for it again.')
  // Re-review N2 — anything that fails BEFORE the send (a database blip, a Meta read) sent nothing: not run, in words.
  let built: Built | { refusal: string }
  try {
    // Review F1 / N1 — never while an earlier upload may have reached Meta without its record (events-orders.ts).
    const doubt = await eventsUploadDoubt()
    if (doubt) return notRun(`Not run: ${doubt} Nothing was sent.`)
    built = await build(args)
  } catch (err) {
    return notRun(`Not run: Nexus could not prepare the upload (${err instanceof Error ? err.message : String(err)}). Nothing was sent.`)
  }
  if ('refusal' in built) return notRun(`Not run: ${built.refusal}`)
  const now = previewOf(built)
  if (canonical(now.reach) !== canonical(approved.reach)) {
    return notRun(`Not run: it was approved for ${approved.reach.mode === 'live' ? 'Meta' : 'nothing (writes off)'} on ad account ${approved.reach.adAccountId}, and it would now go ${now.reach.mode === 'live' ? 'to Meta' : 'nowhere (writes off)'} on ${now.reach.adAccountId}.`)
  }
  if (now.reach.mode !== 'live') return notRun('Not run: Meta ads writes are switched off in Nexus (NEXUS_META_ADS_WRITES=off). Nothing was sent.')
  if (now.basis !== approved.basis || now.plan !== approved.plan) {
    return notRun('Not run: what this upload stands on changed since it was approved (Meta\'s check of the pixel, the orders, or what Nexus sent meanwhile). Nothing was sent. Ask for it again as things are now.')
  }

  const { account, pixelId, draft } = built
  // Re-review N1 — the send log, BEFORE the first request: what may reach Meta is on record whatever happens next.
  const sendId = randomUUID()
  try {
    const sales = draft.requests.flatMap((r) => r.sales.map((s) => ({ orderId: s.orderId, eventId: s.eventId, eventTime: s.eventTime })))
    const busy = await startSendLog({ sendId, pixelId, approvalId: ctx.approvalId ?? null, userId: ctx.userId ?? null, sales })
    if (busy) return notRun(`Not run: ${busy} Nothing was sent.`)
  } catch (err) {
    await closeSendLog(sendId, pixelId, ctx.userId ?? null).catch(() => undefined)
    return notRun(`Not run: Nexus could not record the sales before sending them (${err instanceof Error ? err.message : String(err)}). Nothing was sent.`)
  }
  const steps: RunStep[] = []
  const recorded: RecordedSale[] = []
  let stoppedAt: number | null = null
  for (const request of draft.requests) {
    if (stoppedAt !== null) {
      steps.push({ step: request.step, label: request.label, outcome: 'not_sent', received: null, sentence: `${request.label}: not sent — Nexus stopped after step ${stoppedAt}.` })
      continue
    }
    const sentAt = new Date().toISOString()
    const result = await metaSendEvents(account.target, pixelId, request.params, request.sales.length)
    steps.push({ step: request.step, label: request.label, outcome: result.outcome, received: result.received, sentence: `${request.label}: ${result.sentence}` })
    // What reached Meta, or may have, is remembered: confirmed is never sent again, not confirmed only within 46 hours.
    if (result.outcome === 'done' || result.outcome === 'maybe') recorded.push(...request.sales.map((s) => ({ ...s, sentAt, confirmed: result.outcome === 'done' })))
    if (result.outcome !== 'done') stoppedAt = request.step
  }
  const report = steps.map((s) => `${s.step}. ${s.sentence}`).join(' ')
  if (!recorded.length) {
    // Nothing reached Meta: the send log is closed, so it stops no later upload (a failed close leaves it open: safe side).
    await closeSendLog(sendId, pixelId, ctx.userId ?? null).catch(() => undefined)
    return notRun(`Not run: Meta took none of these sales. ${report}`)
  }
  const confirmed = recorded.filter((s) => s.confirmed).length
  const test = draft.requests.some((r) => !!r.params.test_event_code)
  const after: EventsRecord = { pixelId, test, sendId, sent: recorded }
  return {
    ok: true,
    data: {
      summary: draft.summary,
      account: { accountId: account.accountId, adAccountId: account.adAccountId },
      pixelId,
      sentence: confirmed === recorded.length
        ? `Meta received all ${confirmed} purchase${confirmed === 1 ? '' : 's'}; they cannot be taken back. meta-datasets (view sources or quality, agentName ${NEXUS_PARTNER_AGENT}) shows them within about 20 minutes.`
        : `Meta confirmed ${confirmed} of the ${recorded.length} purchases that reached it or may have; the steps say what happened to each request. Nothing sent can be taken back.`,
      sent: recorded.length,
      confirmed,
      steps,
      changeSetId: approval.changeSetId,
    },
    // No undo (Meta keeps every event it took); the record says what went, so Nexus never sends it again.
    change: { before: { pixelId, sent: [], accountId: account.accountId, adAccountId: account.adAccountId }, after: { ...after, accountId: account.accountId, adAccountId: account.adAccountId } },
  }
}

const uploadMetaEvents: AgentTool = {
  name: UPLOAD_META_EVENTS,
  title: 'Send sales to Meta (Conversions API)',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Meta has no call to withdraw an event it took.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage, F.ordersView, REVENUE],
  input: z.object({
    connectionId: metaConnectionArg,
    pixelId: metaIdArg('the pixel (dataset) the sales go to; default: the chosen ad account\'s only pixel (meta-datasets view list)').optional(),
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('the first day whose sales are sent (YYYY-MM-DD, UTC; at most 6 days ago: Meta refuses a whole request with one event older than 7 days)'),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('the last day (YYYY-MM-DD, UTC; before today)'),
    orderIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_EVENTS_PER_CHANGE).optional().describe('or: the Nexus (or channel) order ids to send, instead of days'),
    manualAs: z.enum(META_EVENT_SOURCES).optional().describe('how the orders taken in by hand in Nexus were made (Meta\'s action_source: physical_store = in person, phone_call, email, chat, other) — required to send one; Meta asks that it be accurate'),
    testEventCode: z.string().trim().regex(META_TEST_EVENT_CODE).optional().describe('a code from Events Manager › Test events, to watch the events arrive there. NOT a dry run: Meta counts test events like real ones, and the sales count as sent'),
    customerSegment: z.boolean().optional().describe('true: tell Meta whether each buyer is new or returning (judged from the orders Nexus holds)'),
    contents: z.boolean().optional().describe('true: also send each order\'s lines (SKU, quantity, price)'),
    why: metaWhyArg,
  }),
  description:
    'Send purchases from Nexus orders to a pixel (dataset) of the business\'s chosen Meta ad account through Meta\'s '
    + 'Conversions API. OFF by default: it works only after a person turned "Send sales to Meta" on for this business in '
    + 'Nexus (Settings › Channels › Meta) — Claude cannot. It never sends a sale of the shop\'s website: the shop platform\'s own Meta pixel and '
    + 'Conversions API send those with an event_id Nexus cannot rebuild (Shopify uses the checkout\'s customer-event id, '
    + 'not the order\'s), and Meta merges two copies only by the same event_id, so a copy from Nexus would count twice. '
    + 'Marketplace sales (Amazon, eBay, Etsy) are never sent either. So it sends orders taken in by hand in Nexus, as the '
    + 'person says they were made (manualAs), each with event_id nexus.<order id>, to a consolidated dataset only (no '
    + 'pixel or server of the shop can have sent them, so they need no website check). Nexus today has no route that '
    + 'creates such an order, so until one exists nothing is sent. Every '
    + 'buyer\'s e-mail and phone (with country code) and country go HASHED (SHA-256, normalised as Meta asks), never plain, '
    + 'never shown or kept; value and currency come from the order. Orders older than 7 days, cancelled, refunded or '
    + 'already confirmed by Meta are left out and named. At most 250 sales per change, in one request (Meta takes up to '
    + '1,000); the answer says what Meta received. test_event_code is not a dry run: Meta counts test events. Sent '
    + 'purchases cannot be taken back (no undo); a request Meta did not confirm may be asked again within 46 hours with the '
    + 'same event_id and sale time (Meta drops the repeat), never later, and while an earlier upload may have reached Meta '
    + 'without its record nothing is sent for 9 days. Purchases count for ads that optimise on the pixel: marked SPENDS MONEY.'
    + META_CHANGE_RULES,
  handler: async (args) => {
    // Review F1 — said at the preview too (nothing is queued while an earlier upload may have reached Meta unrecorded).
    const doubt = await eventsUploadDoubt()
    if (doubt) return { ok: false, error: `Not queued: ${doubt}` }
    const built = await build(args)
    if ('refusal' in built) return { ok: false, error: built.refusal }
    return { ok: true, preview: previewOf(built) }
  },
  execute: (args, ctx) => run(args, ctx),
}

export const META_ADS_EVENTS_TOOLS: AgentTool[] = [uploadMetaEvents]
