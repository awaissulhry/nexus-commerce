/**
 * Meta step 33 — upload-meta-events as the approval gate uses it (the switch, the account, Meta's reads, the orders and
 * the sender are stand-ins): off by default, refused in words; the preview stands on the pixel and Nexus's orders (a
 * hand-typed sale needs no website gap check) and carries no buyer's data; a run happens only as a request a person
 * approved, never while another upload may have reached Meta unrecorded, only when nothing it stands on moved; what
 * reached Meta (or may have) is recorded so it is never sent twice; no undo. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  on: true,
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown>,
  consolidated: true as unknown,
  orders: [] as unknown[],
  sent: new Map<string, unknown>(),
  doubt: null as string | null,
  send: vi.fn(),
  changeAccount: vi.fn(),
  startLog: vi.fn(),
  closeLog: vi.fn(),
  order: [] as string[],
}))
vi.mock('../../marketing/meta-ads/events-switch.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/events-switch.js')>()),
  metaEventsSwitch: vi.fn(async () => ({ on: h.on, since: h.on ? '2026-10-21T08:00:00.000Z' : null, by: h.on ? 'Owner' : null })),
}))
vi.mock('../../marketing/meta-ads/change-account.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/change-account.js')>()),
  metaChangeAccount: h.changeAccount,
}))
vi.mock('../../marketing/meta-ads/live.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connectionId: 'm-1', adAccountId: '1234567890', businessId: '900000000000001' })),
}))
vi.mock('../../marketing/meta-ads/live-audiences.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/live-audiences.js')>()),
  ownPixel: vi.fn(async () => '120000000000050'),
}))
vi.mock('../../marketing/meta-ads/read-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/read-client.js')>()),
  metaReadOne: vi.fn(async () => ({ body: { id: '120000000000050', is_consolidated_container: h.consolidated } })),
}))
vi.mock('../../marketing/meta-ads/events-orders.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/events-orders.js')>()),
  ordersForEvents: vi.fn(async () => ({ orders: h.orders, tooMany: false })),
  nexusSentEvents: vi.fn(async () => h.sent),
  firstOrderTimes: vi.fn(async () => new Map()),
  eventsUploadDoubt: vi.fn(async () => h.doubt),
  startSendLog: h.startLog,
  closeSendLog: h.closeLog,
}))
vi.mock('../../marketing/meta-ads/events-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/events-client.js')>()),
  metaSendEvents: h.send,
}))

import { META_ADS_EVENTS_TOOLS } from './meta-ads-events.tools.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { META_EVENTS_OFF } from '../../marketing/meta-ads/events-switch.js'
import type { ToolContext, ToolResult } from '../tool-types.js'
import { ownPixel } from '../../marketing/meta-ads/live-audiences.js'

const tool = META_ADS_EVENTS_TOOLS.find((t) => t.name === 'upload-meta-events')!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
const ARGS = { from: '2026-10-15', to: '2026-10-20', manualAs: 'phone_call' }
const ask = (args: Record<string, unknown> = ARGS) => tool.input.parse(args) as Record<string, unknown>
const preview = async (args?: Record<string, unknown>) => (await tool.handler(ask(args), asker)) as ToolResult & { preview: Record<string, any> }
const day = (d: number) => new Date(Date.now() - d * 86_400_000)
const MANUAL = { orderId: 'ord-1', channel: 'MANUAL', channelOrderId: 'M-1001', status: 'DELIVERED', at: day(2), cancelled: false, totalCents: 4990, currency: 'EUR', email: 'buyer@example.com', phone: '+393331234567', country: 'IT', customerKey: 'cust-1', items: [] }
const SHOPIFY = { ...MANUAL, orderId: 'ord-2', channel: 'SHOPIFY', channelOrderId: '5001' }
const HEX = /[a-f0-9]{64}/

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-21T12:00:00Z'))
  h.on = true; h.consolidated = true; h.doubt = null; h.sent = new Map()
  h.orders = [{ ...MANUAL, at: new Date('2026-10-19T10:00:00Z') }, { ...SHOPIFY, at: new Date('2026-10-19T11:00:00Z') }]
  h.changeAccount.mockReset(); h.changeAccount.mockImplementation(async () => h.account)
  h.order = []
  h.startLog.mockReset(); h.startLog.mockImplementation(async () => { h.order.push('log'); return null })
  h.closeLog.mockReset(); h.closeLog.mockImplementation(async () => { h.order.push('close') })
  h.send.mockReset(); h.send.mockImplementation(async () => { h.order.push('send'); return { outcome: 'done', received: 1, sentence: 'Meta received all 1 event.' } })
})

describe('the tool', () => {
  it('is a change a person always approves, with no undo (Meta keeps every event), the #691 truth and its MATERIAL fields', () => {
    expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, reversibility: 'none', category: 'advertising' })
    expect(tool.requires).toEqual(['ads.campaigns.manage', 'orders.view', 'financials.revenue.view'])
    expect(tool.undo).toBeUndefined()
    expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
    expect(tool.description).toMatch(/OFF by default/)
    expect(tool.description).toMatch(/never sends a sale of the shop's website/)
    expect(tool.description).toMatch(/Nexus today has no route that creates such an order, so until one exists nothing is sent/)
    expect(tool.description).toMatch(/SPENDS MONEY/)
    expect(MATERIAL_PREVIEW_FIELDS['upload-meta-events']).toEqual(['basis', 'plan', 'reach'])
    expect(() => tool.input.parse({ ...ARGS, testEventCode: 'TEST 1' })).toThrow()
    expect(() => tool.input.parse({ orderIds: Array.from({ length: 251 }, (_, i) => `o-${i}`) })).toThrow()
    expect(() => tool.input.parse({ ...ARGS, manualAs: 'website' })).toThrow()
  })
  it('switched off (the default): refused in words, nothing read', async () => {
    h.on = false
    expect(await tool.handler(ask(), asker)).toEqual({ ok: false, error: META_EVENTS_OFF })
    expect(h.changeAccount).not.toHaveBeenCalled()
  })
  it('only website or marketplace sales in the days: refused in words before Meta is read', async () => {
    vi.mocked(ownPixel).mockClear()
    h.orders = [{ ...SHOPIFY, at: new Date('2026-10-19T11:00:00Z') }, { ...MANUAL, orderId: 'ord-3', channel: 'AMAZON', at: new Date('2026-10-19T12:00:00Z') }]
    expect((await preview()).error).toMatch(/^No sale to send\. 1 order not sent — sold on the shop's website.*1 order not sent — sold on a marketplace/s)
    expect(ownPixel).not.toHaveBeenCalled()
  })
  it('refuses a dataset that is not consolidated', async () => {
    h.consolidated = false
    expect((await preview()).error).toMatch(/not a consolidated dataset/)
  })
  it('review F1 — while an earlier upload may have reached Meta without its record, nothing is queued', async () => {
    h.doubt = 'approval ap-2 sent sales and its record is missing; an earlier upload of sales to Meta may have reached Meta'
    expect((await preview()).error).toMatch(/^Not queued: approval ap-2 sent sales and its record is missing/)
    expect(h.changeAccount).not.toHaveBeenCalled()
  })
})

describe('the preview', () => {
  it('sends the manual sale only, says why the website sale stays out, and carries no buyer\'s data', async () => {
    const result = await preview()
    expect(result.ok).toBe(true)
    expect(result.preview).toMatchObject({ pixelId: '120000000000050', spendsMoney: true, reach: { mode: 'live', accountId: 'm-1', adAccountId: '1234567890' }, metaCheck: { checked: 'none' }, totals: { purchases: 1, withHashedEmail: 1, withHashedPhone: 1, notSent: 1 } })
    expect(result.preview.skipped.join(' ')).toMatch(/sold on the shop's website/)
    expect(result.preview.basis).toMatch(/\w/)
    expect(result.preview.plan).toMatch(/\w/)
    const text = JSON.stringify(result)
    expect(text).not.toMatch(/buyer@example\.com|393331234567/)
    expect(text.replace(new RegExp(`"(basis|plan)":"[^"]*"`, 'g'), '')).not.toMatch(HEX)
  })
  it('with Meta writes switched off it says nothing goes', async () => {
    vi.stubEnv('NEXUS_META_ADS_WRITES', 'off')
    const result = await preview()
    expect(result.preview.reach.mode).toBe('off')
    expect(result.preview.warnings.join(' ')).toMatch(/NOT sent to Meta/)
  })
})

describe('the run', () => {
  it('only as a request a person approved, never by a rule, never without what was approved', async () => {
    const { preview: p } = await preview()
    expect((await tool.execute!(ask(), approved(p, { approvedByPerson: false }))).error).toMatch(/only when a person approved it/)
    expect((await tool.execute!(ask(), approved(p, { decidedVia: 'auto' }))).error).toMatch(/never by a rule/)
    expect((await tool.execute!(ask(), approved({}))).error).toMatch(/does not record what was approved/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('review F1 — never two uploads at once, never while an earlier one may have reached Meta unrecorded', async () => {
    const { preview: p } = await preview()
    h.doubt = 'approval ap-2 is sending sales now or stopped while it did; an earlier upload of sales to Meta may have reached Meta'
    expect((await tool.execute!(ask(), approved(p))).error).toMatch(/^Not run: approval ap-2 is sending sales now.*Nothing was sent\.$/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('not when what it stands on moved (the dataset, or an order sent meanwhile)', async () => {
    const { preview: p } = await preview()
    h.consolidated = null
    expect((await tool.execute!(ask(), approved(p))).error).toMatch(/not shown to be a consolidated dataset/)
    h.consolidated = true
    h.sent = new Map([['ord-1', { orderId: 'ord-1', eventId: 'nexus.ord-1', pixelId: '120000000000050', eventTime: new Date('2026-10-19T10:00:00Z'), sentAt: new Date(), confirmed: false }]])
    expect((await tool.execute!(ask(), approved(p))).error).toMatch(/changed since it was approved/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('sends the approved request and records each sale it sent (order, event id, time, confirmed) — no buyer\'s data', async () => {
    const { preview: p } = await preview()
    const result = await tool.execute!(ask(), approved(p))
    expect(result.ok).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    const [target, pixelId, params, expected] = h.send.mock.calls[0]
    expect([target, pixelId, expected]).toEqual([{ connectionId: 'm-1', adAccountId: '1234567890' }, '120000000000050', 1])
    expect(params.partner_agent).toBe('nexus')
    expect(JSON.parse(params.data)[0].event_id).toBe('nexus.ord-1')
    const after = result.change!.after as Record<string, any>
    expect(after).toMatchObject({ pixelId: '120000000000050', test: false, accountId: 'm-1', adAccountId: '1234567890' })
    // Re-review N1 — the send log goes BEFORE the first request, with the sales (no buyer's data) and the record's sendId.
    expect(h.order).toEqual(['log', 'send'])
    expect(h.startLog.mock.calls[0][0]).toEqual({ sendId: after.sendId, pixelId: '120000000000050', approvalId: 'ap-1', userId: 'u-owner', sales: [{ orderId: 'ord-1', eventId: 'nexus.ord-1', eventTime: '2026-10-19T10:00:00.000Z' }] })
    expect(after.sent).toEqual([{ orderId: 'ord-1', name: 'Order M-1001', eventId: 'nexus.ord-1', eventTime: '2026-10-19T10:00:00.000Z', actionSource: 'phone_call', sentAt: '2026-10-21T12:00:00.000Z', confirmed: true }])
    expect((result.data as Record<string, any>).sentence).toMatch(/cannot be taken back/)
    expect(JSON.stringify({ data: result.data, change: result.change })).not.toMatch(/buyer@example\.com|393331234567|[a-f0-9]{64}/)
  })
  it('what Meta did not confirm is recorded as not confirmed; what Meta took none of is not run', async () => {
    const { preview: p } = await preview()
    h.send.mockImplementationOnce(async () => ({ outcome: 'maybe', received: null, sentence: 'Meta refused the request (100).' }))
    const maybe = await tool.execute!(ask(), approved(p))
    expect((maybe.change!.after as Record<string, any>).sent[0].confirmed).toBe(false)
    expect((maybe.data as Record<string, any>).sentence).toMatch(/confirmed 0 of the 1/)
    h.send.mockImplementationOnce(async () => ({ outcome: 'none', received: null, sentence: 'Meta asked Nexus to slow down (4). Meta took none of these events.' }))
    const none = await tool.execute!(ask(), approved(p))
    expect(none).toEqual({ ok: false, error: expect.stringMatching(/^Not run: Meta took none of these sales/) })
    // Nothing reached Meta: its send log is closed, so it stops no later upload.
    expect(h.closeLog).toHaveBeenCalledTimes(1)
  })
  it('re-review N1 — another open send log found right after writing its own: closed, nothing sent', async () => {
    const { preview: p } = await preview()
    h.startLog.mockImplementationOnce(async () => 'an upload of 1 sale to pixel 120000000000050 began at 2026-10-21 11:59 UTC and left no record')
    expect((await tool.execute!(ask(), approved(p))).error).toMatch(/^Not run: an upload of 1 sale .*left no record Nothing was sent\.$/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('re-review N2 — a failure before the send (a database blip, a Meta read) is "not run", never "maybe sent"', async () => {
    const { preview: p } = await preview()
    h.changeAccount.mockRejectedValueOnce(new Error('connection to the database lost'))
    expect(await tool.execute!(ask(), approved(p))).toEqual({ ok: false, error: 'Not run: Nexus could not prepare the upload (connection to the database lost). Nothing was sent.' })
    expect(h.startLog).not.toHaveBeenCalled()
    h.startLog.mockRejectedValueOnce(new Error('audit table locked'))
    expect((await tool.execute!(ask(), approved(p))).error).toMatch(/could not record the sales before sending them \(audit table locked\)\. Nothing was sent\./)
    expect(h.send).not.toHaveBeenCalled()
  })
})
