/**
 * Meta step 38 — the messaging change tools as the approval gate uses them (Meta, the account and the live reads are
 * stand-ins): create-meta-message is gated exactly as send-customer-message (never weaker), never in a bulk approve; its preview
 * holds the exact words and the person's scoped id, its record never; Meta's windows (24 hours; HUMAN_AGENT 7 days; a private
 * reply 7 days) and the dead tags are enforced; labels, templates and the messaging setup put back what they changed, delete
 * only what Nexus made, and refuse what Meta cannot take back. Made-up ids.
 */
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE = '120000000000010'
const IG = '170000000000010'
const PERSON = '300000000000001'
const CONV = 't_400000000000001'
const MID = 'm_AbCdEfGhIjKlMnOp0123456789'
const HOUR = 3_600_000
const h = vi.hoisted(() => ({
  account: { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' } as Record<string, unknown> | { refusal: string },
  chosen: {} as Record<string, unknown>,
  person: null as Record<string, unknown> | null,
  target: null as Record<string, unknown> | null,
  templates: [] as Array<Record<string, unknown>>,
  labels: [] as Array<{ labelId: string; name: string | null }>,
  personas: [] as Array<{ personaId: string; name: string | null; pictureUrl: string | null }>,
  apps: [] as Array<{ appId: string; name: string | null }>,
  form: null as Record<string, unknown> | null,
  creator: null as Record<string, unknown> | null,
  waba: null as Record<string, unknown> | null,
  waTemplates: [] as Array<Record<string, unknown>>,
  group: null as Record<string, unknown> | null,
  profile: {} as Record<string, unknown>,
  userMenu: null as unknown,
  calls: {} as Record<string, unknown>,
  flows: [] as Array<Record<string, unknown>>,
  nlp: null as Record<string, unknown> | null,
  number: { pageId: '120000000000010', number: null, hasNumber: false } as Record<string, unknown>,
  refusal: null as string | null,
  send: vi.fn(),
}))
vi.mock('../../marketing/meta-ads/change-account.js', () => ({ metaChangeAccount: vi.fn(async () => h.account) }))
vi.mock('../../marketing/meta-ads/live-messaging-change.js', async () => {
  const { MetaLiveRefusal } = await import('../../marketing/meta-ads/live.js')
  const or = <T>(v: T, sentence = 'That person has no Messenger conversation with the chosen Facebook Page that Meta answers, so nothing about them is read.') => {
    if (h.refusal) throw new MetaLiveRefusal(h.refusal)
    if (!v) throw new MetaLiveRefusal(sentence)
    return structuredClone(v)
  }
  return {
    messagingAccount: vi.fn(async () => structuredClone(h.chosen)),
    livePerson: vi.fn(async (_a: unknown, id: string, platform: string) => or(h.person && h.person.personId === id ? { ...h.person, platform } : null)),
    liveMessengerPerson: vi.fn(async (_a: unknown, id: string) => or(h.person && h.person.personId === id ? { personId: id, pageId: PAGE, conversationId: CONV } : null)),
    livePrivateReplyTarget: vi.fn(async () => or(h.target, 'That comment is not on a post of the chosen Page.')),
    livePageTemplates: vi.fn(async (_a: unknown, name?: string | null) => structuredClone(h.templates.filter((t) => !name || t.name === name))),
    livePageTemplate: vi.fn(async (_a: unknown, id: string) => or(h.templates.find((t) => t.templateId === id) ?? null, 'That template is not one of the chosen Page\'s utility templates.')),
    livePageLabels: vi.fn(async () => ({ pageId: PAGE, labels: structuredClone(h.labels), more: false })),
    livePersonas: vi.fn(async () => ({ pageId: PAGE, personas: structuredClone(h.personas) })),
    livePageApps: vi.fn(async () => structuredClone(h.apps)),
    liveLeadForm: vi.fn(async () => or(h.form, 'That lead form is not a form of the Facebook Page this business chose.')),
    liveCreator: vi.fn(async () => or(h.creator, 'Meta\'s creator marketplace gives no messaging id.')),
    liveWhatsAppAccount: vi.fn(async () => or(h.waba, 'Meta lists no WhatsApp Business account owned by the chosen ad account\'s business portfolio, so there is nothing to read.')),
    liveWhatsAppTemplates: vi.fn(async () => structuredClone(h.waTemplates)),
    liveTemplateGroup: vi.fn(async () => or(h.group, 'That template group is not one of the business\'s own WhatsApp account.')),
    readMessengerProfile: vi.fn(async (_a: unknown, platform: string) => ({ pageId: PAGE, platform, body: structuredClone(h.profile), missing: [] })),
    readPersonMenu: vi.fn(async () => ({ pageId: PAGE, personId: PERSON, conversationId: CONV, body: h.userMenu === null ? {} : { user_level_persistent_menu: structuredClone(h.userMenu) } })),
    readCallSettings: vi.fn(async () => ({ pageId: PAGE, body: structuredClone(h.calls), missing: [] })),
    readWelcomeFlows: vi.fn(async (_a: unknown, flowId: string | null) => ({ pageId: PAGE, rows: structuredClone(h.flows.filter((f) => !flowId || f.id === flowId)), more: false, missing: [] })),
    lastNlpSetByNexus: vi.fn(async () => structuredClone(h.nlp)),
    livePageWhatsAppNumber: vi.fn(async () => structuredClone(h.number)),
  }
})
vi.mock('../../marketing/meta-ads/write-client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../marketing/meta-ads/write-client.js')>()),
  metaCheckChange: vi.fn(async () => { throw new Error('Meta has no check for messaging') }),
  metaSendChange: h.send,
}))

import { META_ADS_MESSAGING_CHANGE_TOOLS, WHATSAPP_CODE_KEPT } from './meta-ads-messaging-changes.tools.js'
import { isSealed, maskSecretArgs, openSecretArgs, sealSecretArgs, SECRET_MASK } from '../secret-args.js'
import { __test as cryptoTest } from '../../../lib/crypto.js'
import { META_CHANGE_RULES } from './meta-ads-kit.js'
import { getTool } from '../tool-registry.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { NEVER_IN_BULK, bulkApproveRefusal } from '../../agent-fleet/bulk-approve-policy.js'
import { __metaObjectLimitsTest } from '../../gateway/meta-object-limits.js'
import { META_INSTAGRAM_INBOX_APP, META_PAGE_INBOX_APP } from '../../gateway/meta-messaging-rules.js'
import { AD_DEFAULTS_CANNOT } from '../../marketing/meta-ads/change-messaging-setup.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

const [message, labels, templates, setup] = META_ADS_MESSAGING_CHANGE_TOOLS
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u-claude-user' }
const approved = (preview: unknown, extra: Partial<ToolContext> = {}): ToolContext => ({ can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: preview, ...extra })
type Out = ToolResult & { preview: Record<string, any>; data: Record<string, any>; error?: string; change?: { before: unknown; after: unknown } }
const previewWith = async (tool: AgentTool, args: Record<string, unknown>) => (await tool.handler(tool.input.parse(args) as Record<string, unknown>, asker)) as Out
const runWith = async (tool: AgentTool, args: Record<string, unknown>) => {
  const parsed = tool.input.parse(args) as Record<string, unknown>
  const p = (await tool.handler(parsed, asker)) as Out
  if (!p.ok) return { preview: p, ran: null as Out | null }
  return { preview: p, ran: (await tool.execute!(parsed, approved(p.preview))) as Out }
}
const sentParams = (i = 0) => (h.send.mock.calls[i][1] as { params: Record<string, string> }).params
const sentChange = (i = 0) => h.send.mock.calls[i][1] as Record<string, unknown>
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const personAt = (lastMs: number | null) => ({
  personId: PERSON, platform: 'messenger', pageId: PAGE, instagramId: IG, conversationId: CONV,
  lastMessageFromPerson: lastMs === null ? null : iso(lastMs), standardWindowEndsAt: lastMs === null ? null : new Date(Date.now() - lastMs + 24 * HOUR).toISOString(),
  messageIds: [MID],
})
const TEMPLATE = { templateId: '120000000000811', name: 'order_update', language: 'it_IT', status: 'APPROVED', category: 'UTILITY', parameterFormat: 'POSITIONAL', components: [{ type: 'BODY', text: 'Order {{1}} ships {{2}}.', example: { body_text: [['1001', 'today']] } }] }

beforeEach(() => {
  __metaObjectLimitsTest.useMemory()
  vi.unstubAllEnvs()
  h.send.mockReset()
  h.account = { target: { connectionId: 'm-1', adAccountId: '1234567890' }, accountId: 'm-1', adAccountId: '1234567890', name: 'Shop A ads', currency: 'EUR' }
  h.chosen = { connectionId: 'm-1', adAccountId: '1234567890', pageId: PAGE, instagramId: IG, businessId: '9876543210' }
  h.person = personAt(2 * HOUR)
  h.target = null; h.templates = [structuredClone(TEMPLATE)]; h.labels = []; h.personas = []; h.apps = []; h.form = null; h.creator = null
  h.waba = null; h.waTemplates = []; h.group = null; h.profile = {}; h.userMenu = null; h.calls = {}; h.flows = []; h.nlp = null
  h.number = { pageId: PAGE, number: null, hasNumber: false }
  h.refusal = null
})

describe('create-meta-message is gated exactly as send-customer-message — never weaker', () => {
  it('the same flags, the buyer-message permission and more, never in a bulk approve, its preview judged again at the run', () => {
    const buyer = getTool('send-customer-message')!
    for (const key of ['alwaysAsk', 'maxClaudeTrust', 'riskTier', 'reversibility', 'openWorld', 'readOnly'] as const) expect(message[key], key).toEqual(buyer[key])
    // Review A-N8 — and every other key that decides what may run without a person, as the buyer tool has it: it has none of
    // them, so neither may this one (a trust ceiling, limits a business could run it inside, a control or journal class, a
    // strategy bound, a narrower surface). secretArgs too: the words and the person's id stay visible to the approver.
    for (const key of ['trustCeilingFor', 'control', 'limits', 'withinLimits', 'secretArgs', 'strategyBound', 'journal', 'surfaces'] as const) {
      expect(buyer[key], `send-customer-message ${key}`).toBeUndefined()
      expect(message[key], key).toEqual(buyer[key])
    }
    expect(message.requires).toEqual(expect.arrayContaining(buyer.requires!))
    expect(message.requires).toEqual(['ads.campaigns.manage', 'orders.edit', 'customers.view'])
    expect(message.requiresApprovalDefault).toBe(true)
    expect(message.undo).toBeUndefined()
    expect(message.consequencesFor).toBeUndefined()
    expect(NEVER_IN_BULK['create-meta-message']).toMatch(/cannot be recalled/)
    expect(bulkApproveRefusal('create-meta-message')).toBe(NEVER_IN_BULK['create-meta-message'])
    expect(bulkApproveRefusal('send-customer-message')).toBe(NEVER_IN_BULK['send-customer-message'])
    expect(MATERIAL_PREVIEW_FIELDS['create-meta-message']).toEqual(['basis', 'plan', 'reach'])
    expect(message.description.endsWith(META_CHANGE_RULES)).toBe(true)
    expect(message.description).toMatch(/cannot be recalled/)
    expect(message.description).toMatch(/never a marketplace buyer/)
  })
  it('the other three: changes a person always approves, each with its undo and the #691 truth', () => {
    for (const tool of [labels, templates, setup]) {
      expect(tool).toMatchObject({ readOnly: false, alwaysAsk: true, maxClaudeTrust: 'ask', riskTier: 'high', requiresApprovalDefault: true, openWorld: true, category: 'advertising', reversibility: 'partial' })
      expect(tool.undo).toBeDefined()
      expect(tool.description.endsWith(META_CHANGE_RULES)).toBe(true)
      expect(MATERIAL_PREVIEW_FIELDS[tool.name]).toEqual(['basis', 'plan', 'reach'])
    }
    expect(labels.consequencesFor!({ action: 'delete' })).toEqual({ reversibility: 'none' })
    expect(labels.consequencesFor!({ action: 'add' })).toEqual({ reversibility: 'full' })
    expect(templates.consequencesFor!({ action: 'delete' })).toEqual({ reversibility: 'none' })
    expect(templates.consequencesFor!({ action: 'group-update' })).toEqual({ reversibility: 'full' })
    expect(setup.consequencesFor!({ section: 'whatsapp-number' })).toEqual({ reversibility: 'none' })
    expect(setup.consequencesFor!({ section: 'persona', action: 'delete' })).toEqual({ reversibility: 'none' })
  })
  it('the dead tags and AUTHENTICATION templates are not even offered; a tag is the gateway\'s judge too', () => {
    expect(() => message.input.parse({ action: 'message', platform: 'messenger', personId: PERSON, mode: 'ACCOUNT_UPDATE', text: 'x' })).toThrow()
    expect(() => templates.input.parse({ platform: 'whatsapp', action: 'create', category: 'AUTHENTICATION' })).toThrow()
  })
})

describe('create-meta-message — a message in a conversation', () => {
  it('inside the window: the exact words and the person\'s scoped id in the preview; the record keeps neither', async () => {
    h.send.mockResolvedValue({ node: { recipient_id: PERSON, message_id: 'm_SentMessage0123456789' }, readBack: 'none', waitedMs: 0 })
    const words = 'Ciao! Il tuo ordine parte oggi 😊\nGrazie.'
    const { preview: p, ran } = await runWith(message, { action: 'message', platform: 'messenger', personId: PERSON, text: words, quickReplies: [{ title: 'Grazie', payload: 'THANKS' }] })
    expect(p.ok).toBe(true)
    expect(p.preview.changes.To.to).toContain(PERSON)
    expect(p.preview.changes.Message.to).toBe(`"${words}" [quick replies: "Grazie"]`)
    expect(p.preview.spendsMoney).toBe(false)
    expect(p.preview.metaCheck.checked).toBe('none')
    expect(p.preview.warnings.join(' ')).toMatch(/cannot be recalled/)
    expect(sentParams()).toEqual({ recipient: JSON.stringify({ id: PERSON }), messaging_type: 'RESPONSE', message: JSON.stringify({ text: words, quick_replies: [{ content_type: 'text', title: 'Grazie', payload: 'THANKS' }] }) })
    expect(sentChange()).toMatchObject({ objectId: PAGE, kind: 'messengerpage', edge: 'messages', operation: 'messenger.message', skipReadBack: true })
    expect(ran!.ok).toBe(true)
    expect(ran!.data).toMatchObject({ action: 'message', messageId: 'm_SentMessage0123456789' })
    const kept = JSON.stringify(ran!.change)
    expect(kept).not.toContain(PERSON)
    expect(kept).not.toContain('Grazie')
    expect(ran!.change!.after).toMatchObject({ action: 'message', kind: 'response', conversationId: CONV, messageId: 'm_SentMessage0123456789', sent: true })
    expect(JSON.stringify(ran!.data)).not.toContain(PERSON)
  })
  it('the window: closed after 24 hours (a RESPONSE is not sent); HUMAN_AGENT only after it and within 7 days; no message from the person: refused', async () => {
    h.person = personAt(30 * HOUR)
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, text: 'x' })).error).toMatch(/standard 24-hour window for this person closed .* mode human-agent/)
    const tagged = await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'human-agent', text: 'A person answers: your refund was made.' })
    expect(tagged.ok).toBe(true)
    expect(tagged.preview.changes['Sent as'].to).toMatch(/HUMAN_AGENT/)
    expect(tagged.preview.warnings.join(' ')).toMatch(/never promotional.*Human Agent feature/)
    h.person = personAt(2 * HOUR)
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'human-agent', text: 'x' })).error).toMatch(/still open .* mode response/)
    h.person = personAt(8 * 24 * HOUR)
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'human-agent', text: 'x' })).error).toMatch(/more than 7 days ago/)
    h.person = personAt(null)
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, text: 'x' })).error).toMatch(/no message from this person/)
    h.send.mockResolvedValue({ node: { recipient_id: PERSON, message_id: 'm_x0123456789' }, readBack: 'none', waitedMs: 0 })
    h.person = personAt(30 * HOUR)
    await runWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'human-agent', text: 'A person answers.' })
    expect(sentParams()).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' })
  })
  it('the window closing between the preview and the run: nothing is sent', async () => {
    const parsed = message.input.parse({ action: 'message', platform: 'messenger', personId: PERSON, text: 'Ciao' }) as Record<string, unknown>
    const p = (await message.handler(parsed, asker)) as Out
    h.person = personAt(25 * HOUR)
    const ran = (await message.execute!(parsed, approved(p.preview))) as Out
    expect(ran.ok).toBe(false)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('never by a rule, nor without what was approved', async () => {
    const parsed = message.input.parse({ action: 'message', platform: 'messenger', personId: PERSON, text: 'Ciao' }) as Record<string, unknown>
    const p = (await message.handler(parsed, asker)) as Out
    expect(((await message.execute!(parsed, approved(p.preview, { decidedVia: 'auto' }))) as Out).ok).toBe(false)
    expect(((await message.execute!(parsed, approved({}))) as Out).ok).toBe(false)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('Instagram: 1,000 bytes, no persona, no notification setting; a reply to one message of the conversation only', async () => {
    expect((await previewWith(message, { action: 'message', platform: 'instagram', personId: PERSON, text: 'é'.repeat(501) })).error).toMatch(/1000 bytes/)
    expect((await previewWith(message, { action: 'message', platform: 'instagram', personId: PERSON, text: 'x', personaId: '120000000000901' })).error).toMatch(/Personas are Messenger/)
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, text: 'x', replyToMessageId: 'm_NotInThisConversation01' })).error).toMatch(/20 newest/)
    const ok = await previewWith(message, { action: 'message', platform: 'instagram', personId: PERSON, text: 'Ciao', replyToMessageId: MID })
    expect(ok.ok).toBe(true)
  })
  it('a persona must be the chosen Page\'s; refused arguments name what an action takes', async () => {
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, text: 'x', personaId: '120000000000901' })).error).toMatch(/not one of the chosen Page/)
    h.personas = [{ personaId: '120000000000901', name: 'Anna', pictureUrl: null }]
    h.send.mockResolvedValue({ node: { message_id: 'm_x0123456789' }, readBack: 'none', waitedMs: 0 })
    await runWith(message, { action: 'message', platform: 'messenger', personId: PERSON, text: 'x', personaId: '120000000000901', notification: 'silent' })
    expect(sentParams()).toMatchObject({ persona_id: '120000000000901', notification_type: 'SILENT_PUSH' })
    expect((await previewWith(message, { action: 'sender-action', platform: 'messenger', personId: PERSON, senderAction: 'seen', text: 'x' })).error).toMatch(/takes platform, personId, senderAction/)
    expect((await previewWith(message, { action: 'message', platform: 'messenger', text: 'x' })).error).toMatch(/Name the person/)
  })
  it('a person another business uses (the read refuses), or no conversation: nothing is sent', async () => {
    h.refusal = 'That person is a Page or Instagram account another business in Nexus uses: Nexus never messages it.'
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, text: 'x' })).error).toMatch(/another business in Nexus/)
    h.refusal = null
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: '300000000000999', text: 'x' })).error).toMatch(/no Messenger conversation/)
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('create-meta-message — utility, private reply, sender action, instant form, creator, handover', () => {
  it('utility: an APPROVED template of the chosen Page, its values in order, the words the person reads in the preview', async () => {
    h.person = personAt(5 * 24 * HOUR)
    h.send.mockResolvedValue({ node: { message_id: 'm_u0123456789' }, readBack: 'none', waitedMs: 0 })
    const { preview: p } = await runWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'utility', template: { name: 'order_update', language: 'it_IT', parameters: [{ component: 'body', text: '1001' }, { component: 'body', text: 'oggi' }] } })
    expect(p.preview.changes.Message.to).toBe('"Order 1001 ships oggi."')
    expect(sentParams()).toEqual({ recipient: JSON.stringify({ id: PERSON }), messaging_type: 'UTILITY', message: JSON.stringify({ template: { name: 'order_update', language: { code: 'it_IT' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '1001' }, { type: 'text', text: 'oggi' }] }] } }) })
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'utility', template: { name: 'order_update', language: 'it_IT', parameters: [{ component: 'body', text: '1001' }] } })).error).toMatch(/2 placeholders/)
    h.templates = [{ ...TEMPLATE, status: 'PENDING' }]
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'utility', template: { name: 'order_update', language: 'it_IT' } })).error).toMatch(/is PENDING/)
    expect((await previewWith(message, { action: 'message', platform: 'instagram', personId: PERSON, mode: 'utility', template: { name: 'order_update', language: 'it_IT' } })).error).toMatch(/Messenger/)
    expect((await previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'utility', text: 'x', template: { name: 'order_update', language: 'it_IT' } })).error).toMatch(/not text or media/)
  })
  it('a private reply: ONE message within 7 days of the comment, by its id (RESPONSE)', async () => {
    h.target = { platform: 'messenger', pageId: PAGE, instagramId: null, commentId: '500000000000001_900000000000001', postId: `${PAGE}_500000000000001`, createdAt: iso(3 * 24 * HOUR), canReplyPrivately: null }
    h.send.mockResolvedValue({ node: { recipient_id: PERSON, message_id: 'm_p0123456789' }, readBack: 'none', waitedMs: 0 })
    const { preview: p, ran } = await runWith(message, { action: 'private-reply', platform: 'messenger', postId: `${PAGE}_500000000000001`, commentId: '500000000000001_900000000000001', text: 'Ti scriviamo in privato.' })
    expect(p.preview.warnings.join(' ')).toMatch(/ONE private reply/)
    expect(sentParams()).toEqual({ recipient: JSON.stringify({ comment_id: '500000000000001_900000000000001' }), messaging_type: 'RESPONSE', message: JSON.stringify({ text: 'Ti scriviamo in privato.' }) })
    expect(ran!.change!.after).toMatchObject({ action: 'private-reply', commentId: '500000000000001_900000000000001', messageId: 'm_p0123456789' })
    h.target = { ...h.target, createdAt: iso(8 * 24 * HOUR) }
    expect((await previewWith(message, { action: 'private-reply', platform: 'messenger', postId: `${PAGE}_500000000000001`, commentId: '500000000000001_900000000000001', text: 'x' })).error).toMatch(/more than 7 days ago/)
  })
  it('a sender action: only while the window is open; a reaction names one of the 20 newest messages', async () => {
    h.send.mockResolvedValue({ node: { recipient_id: PERSON }, readBack: 'none', waitedMs: 0 })
    const { ran } = await runWith(message, { action: 'sender-action', platform: 'messenger', personId: PERSON, senderAction: 'react', messageId: MID, reaction: '👍' })
    expect(sentParams()).toEqual({ recipient: JSON.stringify({ id: PERSON }), sender_action: 'react', payload: JSON.stringify({ message_id: MID, reaction: '👍' }) })
    expect(ran!.data.steps[0].sentence).toMatch(/confirmed it/)
    expect(JSON.stringify([ran!.data, ran!.change])).not.toContain(PERSON)
    h.person = personAt(30 * HOUR)
    expect((await previewWith(message, { action: 'sender-action', platform: 'messenger', personId: PERSON, senderAction: 'typing-on' })).error).toMatch(/window is open/)
    h.person = personAt(HOUR)
    expect((await previewWith(message, { action: 'sender-action', platform: 'instagram', personId: PERSON, senderAction: 'react', messageId: MID, reaction: '👍' })).error).toMatch(/"love"/)
  })
  it('an instant form: in-thread eligible questions only, inside the window', async () => {
    h.form = { formId: '120000000000601', questionTypes: ['FULL_NAME', 'EMAIL'] }
    h.send.mockResolvedValue({ node: { message_id: 'm_f0123456789' }, readBack: 'none', waitedMs: 0 })
    await runWith(message, { action: 'instant-form', platform: 'messenger', personId: PERSON, formId: '120000000000601' })
    expect(sentParams()).toEqual({ recipient: JSON.stringify({ id: PERSON }), messaging_type: 'RESPONSE', message: JSON.stringify({ attachment: { type: 'template', payload: { template_type: 'instant_form', form_id: '120000000000601' } } }) })
    h.form = { formId: '120000000000601', questionTypes: ['FULL_NAME', 'CITY'] }
    expect((await previewWith(message, { action: 'instant-form', platform: 'messenger', personId: PERSON, formId: '120000000000601' })).error).toMatch(/asks CITY/)
    expect((await previewWith(message, { action: 'instant-form', platform: 'instagram', personId: PERSON, formId: '120000000000601' })).error).toMatch(/Messenger conversation/)
  })
  it('a creator message: the messaging id Meta answers, the Partnership folder, the creator named for the gateway\'s check', async () => {
    h.creator = { username: 'creator.a', messagingId: '942900000000001', creatorId: '178000000000001' }
    h.send.mockResolvedValue({ node: { recipient_id: '942900000000001', message_id: 'mid.$creator0123' }, readBack: 'none', waitedMs: 0 })
    await runWith(message, { action: 'creator-message', platform: 'instagram', creatorUsername: '@creator.a', text: 'Ciao! Collaboriamo?' })
    expect(sentParams()).toEqual({ recipient: JSON.stringify({ id: '942900000000001' }), message: JSON.stringify({ text: 'Ciao! Collaboriamo?' }), folder: 'partnership' })
    expect(sentChange()).toMatchObject({ kind: 'instagrampage', parent: { kind: 'creator', id: 'creator.a' }, operation: 'instagram.message' })
    expect((await previewWith(message, { action: 'creator-message', platform: 'messenger', creatorUsername: 'creator.a', text: 'x' })).error).toMatch(/platform instagram/)
  })
  it('a handover: to Meta\'s inboxes (their documented app ids), an app ON the Page only, release and take name none', async () => {
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    await runWith(message, { action: 'handover', platform: 'messenger', personId: PERSON, handover: 'pass', handoverTo: 'page-inbox', metadata: 'escalated' })
    expect(sentChange()).toMatchObject({ edge: 'pass_thread_control', operation: 'thread.pass', params: { recipient: JSON.stringify({ id: PERSON }), target_app_id: META_PAGE_INBOX_APP, metadata: 'escalated' } })
    await runWith(message, { action: 'handover', platform: 'instagram', personId: PERSON, handover: 'pass', handoverTo: 'instagram-inbox' })
    expect(sentParams(1)).toMatchObject({ target_app_id: META_INSTAGRAM_INBOX_APP })
    expect((await previewWith(message, { action: 'handover', platform: 'messenger', personId: PERSON, handover: 'pass', handoverTo: 'app', appId: '120000000000077' })).error).toMatch(/not installed on the chosen Page/)
    h.apps = [{ appId: '120000000000077', name: 'App A' }]
    expect((await previewWith(message, { action: 'handover', platform: 'messenger', personId: PERSON, handover: 'pass', handoverTo: 'app', appId: '120000000000077' })).ok).toBe(true)
    const take = await runWith(message, { action: 'handover', platform: 'messenger', personId: PERSON, handover: 'take' })
    expect(sentChange(2)).toMatchObject({ edge: 'take_thread_control', params: { recipient: JSON.stringify({ id: PERSON }) } })
    expect(take.preview.preview.warnings.join(' ')).toMatch(/select developers/)
    expect((await previewWith(message, { action: 'handover', platform: 'messenger', personId: PERSON, handover: 'release', handoverTo: 'page-inbox' })).error).toMatch(/pass only/)
  })
})

describe('set-meta-conversation-labels', () => {
  it('create: one label; its undo deletes the label Nexus made (only while it is still there)', async () => {
    h.send.mockResolvedValue({ node: { id: '120000000000801' }, readBack: 'none', waitedMs: 0 })
    const { ran } = await runWith(labels, { action: 'create', name: 'return asked' })
    expect(sentChange()).toMatchObject({ objectId: PAGE, kind: 'messagingpage', edge: 'custom_labels', params: { page_label_name: 'return asked' } })
    expect(ran!.change!.after).toMatchObject({ action: 'create', labelId: '120000000000801', exists: true })
    h.labels = [{ labelId: '120000000000801', name: 'return asked' }]
    expect(await labels.undo!.current(ran!.change! as never)).toEqual(ran!.change!.after)
    expect(labels.undo!.request(ran!.change! as never)).toEqual({ tool: 'set-meta-conversation-labels', args: { connectionId: 'm-1', action: 'delete', labelId: '120000000000801', confirmDelete: true, why: expect.stringMatching(/deletes the label Nexus made/) } })
    expect((await previewWith(labels, { action: 'create', name: 'Return Asked' })).error).toMatch(/already has the label/)
  })
  it('add / remove: the person\'s id kept for the undo; delete: explicit ask, no undo', async () => {
    h.labels = [{ labelId: '120000000000801', name: 'VIP' }]
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const { ran } = await runWith(labels, { action: 'add', labelId: '120000000000801', personId: PERSON })
    expect(sentChange()).toMatchObject({ objectId: '120000000000801', kind: 'pagelabel', edge: 'label', operation: 'pagelabel.assign', params: { user: PERSON } })
    expect(labels.undo!.request(ran!.change! as never)).toEqual({ tool: 'set-meta-conversation-labels', args: { connectionId: 'm-1', action: 'remove', labelId: '120000000000801', personId: PERSON, why: expect.any(String) } })
    await runWith(labels, { action: 'remove', labelId: '120000000000801', personId: PERSON })
    expect(sentChange(1)).toMatchObject({ method: 'DELETE', operation: 'pagelabel.unassign' })
    expect((await previewWith(labels, { action: 'delete', labelId: '120000000000801' })).error).toMatch(/confirmDelete/)
    const del = await runWith(labels, { action: 'delete', labelId: '120000000000801', confirmDelete: true })
    expect(sentChange(2)).toMatchObject({ objectId: '120000000000801', method: 'DELETE', operation: 'pagelabel.delete', params: {} })
    expect(labels.undo!.request(del.ran!.change! as never)).toEqual({ refusal: expect.stringMatching(/cannot come back/) })
    expect((await previewWith(labels, { action: 'add', labelId: '120000000000999', personId: PERSON })).error).toMatch(/not one of the chosen Page/)
  })
})

describe('set-meta-message-templates', () => {
  it('Messenger create: UTILITY, the parts as Meta takes them with their examples; the undo deletes it by id and name', async () => {
    h.templates = []
    h.send.mockResolvedValue({ node: { id: '120000000000812', status: 'PENDING', category: 'UTILITY' }, readBack: 'same-request', waitedMs: 0 })
    const { ran } = await runWith(templates, { platform: 'messenger', action: 'create', name: 'shipping_update', language: 'it_IT', category: 'UTILITY', header: { text: 'Ordine {{1}}', example: '1001' }, body: { text: 'Il tuo ordine {{1}} è in viaggio.', examples: ['1001'] }, buttons: [{ type: 'url', text: 'Segui', url: 'https://example.com/track' }] })
    expect(sentParams()).toEqual({
      name: 'shipping_update', language: 'it_IT', category: 'UTILITY',
      components: JSON.stringify([{ type: 'HEADER', format: 'TEXT', text: 'Ordine {{1}}', example: { header_text: ['1001'] } }, { type: 'BODY', text: 'Il tuo ordine {{1}} è in viaggio.', example: { body_text: [['1001']] } }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Segui', url: 'https://example.com/track' }] }]),
    })
    expect(ran!.data).toMatchObject({ templateId: '120000000000812', status: 'PENDING' })
    expect(templates.undo!.request(ran!.change! as never)).toEqual({ tool: 'set-meta-message-templates', args: { connectionId: 'm-1', platform: 'messenger', action: 'delete', templateId: '120000000000812', confirmDelete: true, why: expect.any(String) } })
    expect((await previewWith(templates, { platform: 'messenger', action: 'create', name: 'x_a', language: 'it_IT', category: 'MARKETING', body: { text: 'x' } })).error).toMatch(/UTILITY templates only/)
    expect((await previewWith(templates, { platform: 'messenger', action: 'create', name: 'x_b', language: 'it_IT', body: { text: 'Order {{1}}' } })).error).toMatch(/example/)
  })
  it('Messenger edit: the old parts kept for its undo (when Nexus can send them again); delete always names the id with the name', async () => {
    h.send.mockResolvedValue({ node: { success: true, status: 'APPROVED' }, readBack: 'same-request', waitedMs: 0 })
    const { ran } = await runWith(templates, { platform: 'messenger', action: 'edit', templateId: '120000000000811', body: { text: 'Order {{1}} leaves {{2}}.', examples: ['1001', 'today'] } })
    expect(sentChange()).toMatchObject({ objectId: '120000000000811', kind: 'messengertemplate', operation: 'pagetemplate.edit' })
    expect(templates.undo!.request(ran!.change! as never)).toEqual({ tool: 'set-meta-message-templates', args: { connectionId: 'm-1', platform: 'messenger', action: 'edit', templateId: '120000000000811', body: { text: 'Order {{1}} ships {{2}}.', examples: ['1001', 'today'] }, why: expect.any(String) } })
    expect(templates.input.safeParse((templates.undo!.request(ran!.change! as never) as { args: unknown }).args).success).toBe(true)
    await runWith(templates, { platform: 'messenger', action: 'delete', templateId: '120000000000811', confirmDelete: true })
    expect(sentChange(1)).toMatchObject({ objectId: PAGE, edge: 'message_templates', method: 'DELETE', params: { name: 'order_update', template_id: '120000000000811' } })
  })
  it('WhatsApp: only the business\'s own account (else in words); create, delete by hsm_id and name, groups with their undo', async () => {
    expect((await previewWith(templates, { platform: 'whatsapp', action: 'create', name: 'promo_a', language: 'it', category: 'MARKETING', body: { text: 'Hi' } })).error).toMatch(/no WhatsApp Business account/)
    h.waba = { wabaId: '120000000000900', name: 'WA A', currency: 'EUR', timeZoneId: '1', status: 'ACTIVE' }
    h.waTemplates = [{ templateId: '120000000000901', name: 'promo_old', language: 'it', status: 'APPROVED', category: 'MARKETING' }, { templateId: '120000000000902', name: 'promo_b', language: 'it', status: 'APPROVED', category: 'MARKETING' }]
    h.send.mockResolvedValue({ node: { id: '120000000000903', status: 'PENDING', category: 'MARKETING' }, readBack: 'same-request', waitedMs: 0 })
    await runWith(templates, { platform: 'whatsapp', action: 'create', name: 'promo_a', language: 'it', category: 'MARKETING', body: { text: 'Novità in negozio' }, footer: 'Shop A', buttons: [{ type: 'quick-reply', text: 'Stop' }] })
    expect(sentChange()).toMatchObject({ objectId: '120000000000900', kind: 'waba', edge: 'message_templates', operation: 'wabatemplate.create' })
    expect(sentChange().asPage).toBeUndefined()
    await runWith(templates, { platform: 'whatsapp', action: 'delete', templateId: '120000000000901', confirmDelete: true })
    expect(sentChange(1)).toMatchObject({ method: 'DELETE', params: { hsm_id: '120000000000901', name: 'promo_old' } })
    h.send.mockResolvedValue({ node: { id: '120000000000950' }, readBack: 'none', waitedMs: 0 })
    const made = await runWith(templates, { platform: 'whatsapp', action: 'group-create', groupName: 'Group A', templateIds: ['120000000000901'] })
    expect(sentParams(2)).toEqual({ name: 'Group A', whatsapp_business_templates: JSON.stringify(['120000000000901']) })
    expect(templates.undo!.request(made.ran!.change! as never)).toEqual({ tool: 'set-meta-message-templates', args: { connectionId: 'm-1', platform: 'whatsapp', whatsappAccountId: '120000000000900', action: 'group-delete', groupId: '120000000000950', confirmDelete: true, why: expect.any(String) } })
    h.group = { groupId: '120000000000950', name: 'Group A', description: null, templateIds: ['120000000000901'] }
    h.send.mockResolvedValue({ node: { id: '120000000000950', name: 'Group A' }, readBack: 'second-read', waitedMs: 0 })
    const changed = await runWith(templates, { platform: 'whatsapp', action: 'group-update', groupId: '120000000000950', addTemplateIds: ['120000000000902'], removeTemplateIds: ['120000000000901'] })
    expect(sentParams(3)).toEqual({ add_templates: JSON.stringify(['120000000000902']), remove_templates: JSON.stringify(['120000000000901']) })
    expect(templates.undo!.request(changed.ran!.change! as never)).toEqual({ tool: 'set-meta-message-templates', args: { connectionId: 'm-1', platform: 'whatsapp', whatsappAccountId: '120000000000900', action: 'group-update', groupId: '120000000000950', addTemplateIds: ['120000000000901'], removeTemplateIds: ['120000000000902'], why: expect.any(String) } })
    expect((await previewWith(templates, { platform: 'whatsapp', action: 'group-create', groupName: 'Group B', templateIds: ['120000000000999'] })).error).toMatch(/not a template of this WhatsApp account/)
    // Review B-F4 — never "delete and make it again": a deleted approved template's name stays blocked 30 days.
    const editWords = (await previewWith(templates, { platform: 'whatsapp', action: 'edit', templateId: '120000000000901', body: { text: 'x' } })).error
    expect(editWords).toMatch(/Nexus does not edit WhatsApp templates yet.*blocked for 30 days/)
    expect(editWords).not.toMatch(/deleting it and making it again/)
  })
})

describe('set-meta-messaging-setup', () => {
  it('profile: set and clear in one change (two requests); the old values read first are its undo', async () => {
    h.profile = { get_started: { payload: 'START' }, greeting: [{ locale: 'default', text: 'Ciao' }] }
    h.send.mockResolvedValue({ node: { result: 'success' }, readBack: 'none', waitedMs: 0 })
    const { preview: p, ran } = await runWith(setup, { section: 'profile', properties: { getStarted: { payload: 'BEGIN' } }, clear: ['greeting'] })
    expect(p.preview.requests).toHaveLength(2)
    expect(sentChange(0)).toMatchObject({ edge: 'messenger_profile', operation: 'messengerprofile.set', params: { get_started: JSON.stringify({ payload: 'BEGIN' }) } })
    expect(sentChange(1)).toMatchObject({ edge: 'messenger_profile', method: 'DELETE', params: { fields: JSON.stringify(['greeting']) } })
    const undo = setup.undo!.request(ran!.change! as never)
    expect(undo).toEqual({ tool: 'set-meta-messaging-setup', args: { connectionId: 'm-1', section: 'profile', properties: { getStarted: { payload: 'START' }, greeting: [{ locale: 'default', text: 'Ciao' }] }, why: expect.any(String) } })
    expect(setup.input.safeParse((undo as { args: unknown }).args).success).toBe(true)
    h.profile = { get_started: { payload: 'BEGIN' } }
    expect(await setup.undo!.current(ran!.change! as never)).toEqual(ran!.change!.after)
    expect((await previewWith(setup, { section: 'profile', platform: 'instagram', properties: { greeting: [{ locale: 'default', text: 'x' }] } })).error).toMatch(/iceBreakers and persistentMenu only/)
  })
  it('a person\'s own menu: set over none, its undo takes it off again', async () => {
    h.send.mockResolvedValue({ node: { result: 'success' }, readBack: 'none', waitedMs: 0 })
    const menu = [{ locale: 'default', items: [{ type: 'postback', title: 'Help', payload: 'HELP' }] }]
    const { ran } = await runWith(setup, { section: 'person-menu', personId: PERSON, menu })
    expect(sentParams()).toEqual({ psid: PERSON, persistent_menu: JSON.stringify([{ locale: 'default', call_to_actions: [{ type: 'postback', title: 'Help', payload: 'HELP' }] }]) })
    expect(setup.undo!.request(ran!.change! as never)).toEqual({ tool: 'set-meta-messaging-setup', args: { connectionId: 'm-1', section: 'person-menu', personId: PERSON, clearMenu: true, why: expect.any(String) } })
  })
  it('persona: made, its undo deletes it; a delete on explicit ask only', async () => {
    h.send.mockResolvedValue({ node: { id: '120000000000901' }, readBack: 'none', waitedMs: 0 })
    const { ran } = await runWith(setup, { section: 'persona', action: 'create', personaName: 'Anna R.', pictureUrl: 'https://example.com/anna.jpg' })
    expect(sentParams()).toEqual({ name: 'Anna R.', profile_picture_url: 'https://example.com/anna.jpg' })
    expect(setup.undo!.request(ran!.change! as never)).toEqual({ tool: 'set-meta-messaging-setup', args: { connectionId: 'm-1', section: 'persona', action: 'delete', personaId: '120000000000901', confirmDelete: true, why: expect.any(String) } })
    h.personas = [{ personaId: '120000000000901', name: 'Anna R.', pictureUrl: null }]
    expect((await previewWith(setup, { section: 'persona', action: 'delete', personaId: '120000000000901' })).error).toMatch(/confirmDelete/)
  })
  it('NLP: Meta cannot read it back — the undo sets what Nexus last set, or off when Nexus never set it', async () => {
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const first = await runWith(setup, { section: 'nlp', nlpEnabled: true, nlpModel: 'ITALIAN_STANDARD' })
    expect(sentParams()).toEqual({ nlp_enabled: 'true', model: 'ITALIAN_STANDARD' })
    expect(setup.undo!.request(first.ran!.change! as never)).toEqual({ tool: 'set-meta-messaging-setup', args: { connectionId: 'm-1', section: 'nlp', nlpEnabled: false, why: expect.stringMatching(/Nexus never set it before/) } })
    h.nlp = { nlpEnabled: true, model: 'GERMAN_STANDARD' }
    const second = await runWith(setup, { section: 'nlp', nlpEnabled: false })
    expect(setup.undo!.request(second.ran!.change! as never)).toEqual({ tool: 'set-meta-messaging-setup', args: { connectionId: 'm-1', section: 'nlp', nlpEnabled: true, nlpModel: 'GERMAN_STANDARD', why: expect.any(String) } })
  })
  it('calling: only what changes is sent, the old values are its undo', async () => {
    h.calls = { audio_enabled: true, icon_enabled: true, call_routing: { ring_target: 'META' } }
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const { ran } = await runWith(setup, { section: 'calling', calling: { icon: false, audio: true } })
    expect(sentParams()).toEqual({ icon_enabled: 'false' })
    expect(setup.undo!.request(ran!.change! as never)).toEqual({ tool: 'set-meta-messaging-setup', args: { connectionId: 'm-1', section: 'calling', calling: { icon: true }, why: expect.any(String) } })
  })
  it('welcome flows: made (undo deletes), never one an ad uses', async () => {
    h.send.mockResolvedValue({ node: { flow_id: '120000000000701' }, readBack: 'none', waitedMs: 0 })
    const { ran } = await runWith(setup, { section: 'welcome-flow', action: 'create', flowName: 'Flow A', flowPlatforms: ['messenger'], flowMessages: [{ text: 'Ciao! Come possiamo aiutarti?', quickReplies: [{ title: 'Taglie', payload: 'SIZES' }] }] })
    expect(sentParams()).toEqual({ name: 'Flow A', welcome_message_flow: JSON.stringify([{ message: { text: 'Ciao! Come possiamo aiutarti?', quick_replies: [{ content_type: 'text', title: 'Taglie', payload: 'SIZES' }] } }]), eligible_platforms: JSON.stringify(['messenger']) })
    expect(setup.undo!.request(ran!.change! as never)).toMatchObject({ args: { section: 'welcome-flow', action: 'delete', flowId: '120000000000701', confirmDelete: true } })
    h.flows = [{ id: '120000000000701', name: 'Flow A', eligible_platforms: ['messenger'], welcome_message_flow: '[]', is_used_in_ad: true }]
    expect((await previewWith(setup, { section: 'welcome-flow', action: 'update', flowId: '120000000000701', flowName: 'Flow B' })).error).toMatch(/used in an ad/)
  })
  it('a WhatsApp number: the code goes to Meta only — never in the preview, the plan\'s hash, the record or the answer; no undo', async () => {
    h.send.mockResolvedValue({ node: { verification_status: 'VERIFIED' }, readBack: 'none', waitedMs: 0 })
    const { preview: p, ran } = await runWith(setup, { section: 'whatsapp-number', whatsappNumber: '+390000000000', verificationCode: '483920' })
    expect(sentChange()).toMatchObject({ edge: 'page_whatsapp_number_verification', params: { whatsapp_number: '+390000000000', verification_code: '483920' } })
    expect(JSON.stringify(p.preview)).not.toContain('483920')
    expect(JSON.stringify([ran!.data, ran!.change])).not.toContain('483920')
    expect(ran!.data).toMatchObject({ verificationStatus: 'VERIFIED' })
    expect(setup.undo!.request(ran!.change! as never)).toEqual({ refusal: expect.stringMatching(/unlink/) })
  })
  it('the Page\'s default ice breakers and quick replies for messaging ads: Meta cannot (read-only fields), said in words', async () => {
    expect((await previewWith(setup, { section: 'messenger-ad-defaults' })).error).toBe(AD_DEFAULTS_CANNOT)
    expect(AD_DEFAULTS_CANNOT).toMatch(/read-only fields of the Page/)
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe('fix round 1 (reviews A and B)', () => {
  it('A-B1 — the WhatsApp code is a secret argument: sealed where a request is stored, masked in Claude\'s record, the Approvals list and edit form, the audit rows and a plan\'s step', async () => {
    expect(setup.secretArgs).toEqual(['verificationCode'])
    expect(getTool('set-meta-messaging-setup')!.secretArgs).toEqual(['verificationCode'])
    const args = { section: 'whatsapp-number', whatsappNumber: '+390000000000', verificationCode: '483920' }
    // Every record and view masks by the tool's name (mcp-tool-call.ts, approval-inbox.service.ts, approval-queue.service.ts,
    // approval-gate.service.ts, change-record.service.ts).
    expect(maskSecretArgs('set-meta-messaging-setup', args)).toEqual({ ...args, verificationCode: SECRET_MASK })
    expect(JSON.stringify(maskSecretArgs('submit-change-plan', { title: 'x', steps: [{ tool: 'set-meta-messaging-setup', args }] }))).not.toContain('483920')
    // A made-up key for this run only; KMS unset.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', undefined)
    cryptoTest.resetKeyCache()
    try {
      const sealed = await sealSecretArgs(setup, args, 'business-a-test')
      expect(isSealed(sealed.verificationCode)).toBe(true)
      expect(JSON.stringify(sealed)).not.toContain('483920')
      expect(await openSecretArgs(setup, sealed, 'business-a-test')).toEqual(args)
    } finally {
      vi.unstubAllEnvs(); cryptoTest.resetKeyCache(); warn.mockRestore()
    }
  })
  it('A-S3 / A-S4 / B1 — the words say what is kept and for how long, and that each tool has its own Claude rule', () => {
    expect(message.description).toMatch(/the request \(its arguments and its preview\) and Claude's record of the call keep the person's id and the words, for as long as Nexus keeps them \(nothing deletes them today/)
    expect(message.description).not.toMatch(/until it runs/)
    expect(message.description).toMatch(/turning send-customer-message Off for Claude does not turn this Off — each is set on its own/)
    expect(setup.description).toContain(WHATSAPP_CODE_KEPT)
    expect(WHATSAPP_CODE_KEPT).toMatch(/encrypted with the request for as long as Nexus keeps the request/)
    expect(setup.description).not.toMatch(/never shown or kept/)
    expect(setup.input.shape.verificationCode.description).not.toMatch(/never shown or kept/)
  })
  it('A-N5 — the person wrote again between the approval and the run: not sent, in those words', async () => {
    h.send.mockResolvedValue({ node: { message_id: 'm_x0123456789' }, readBack: 'none', waitedMs: 0 })
    const parsed = message.input.parse({ action: 'message', platform: 'messenger', personId: PERSON, text: 'Ciao' }) as Record<string, unknown>
    const p = (await message.handler(parsed, asker)) as Out
    h.person = personAt(60_000)
    const ran = (await message.execute!(parsed, approved(p.preview))) as Out
    expect(ran.error).toMatch(/the person wrote again/)
    expect(h.send).not.toHaveBeenCalled()
  })
  it('A-N1 / B-F13 / B-F8 — a utility template: its category must be UTILITY as Meta answers it; button values match its buttons; a name as Meta lists it', async () => {
    const send = (template: Record<string, unknown>) => previewWith(message, { action: 'message', platform: 'messenger', personId: PERSON, mode: 'utility', template: { name: 'order_update', language: 'it_IT', parameters: [{ component: 'body', text: '1001' }, { component: 'body', text: 'oggi' }], ...template } })
    h.templates = [{ ...TEMPLATE, category: undefined }]
    expect((await send({})).error).toMatch(/names no category/)
    h.templates = [structuredClone(TEMPLATE)]
    expect((await send({ buttons: [{ type: 'url', value: '1001' }] })).error).toMatch(/no button that takes a value/)
    const withLink = { ...TEMPLATE, components: [...TEMPLATE.components, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Segui', url: 'https://example.com/o/{{1}}' }, { type: 'PHONE_NUMBER', text: 'Chiama', phone_number: '+390000000000' }] }] }
    h.templates = [withLink]
    expect((await send({})).error).toMatch(/takes 1 button value.*url/)
    expect((await send({ buttons: [{ type: 'postback', value: 'X' }] })).error).toMatch(/takes 1 button value/)
    expect((await send({ buttons: [{ type: 'url', value: '1001' }] })).ok).toBe(true)
    h.templates = [{ ...TEMPLATE, name: 'Order_Update_US' }]
    expect((await send({ name: 'Order_Update_US' })).ok).toBe(true)
    expect(() => templates.input.parse({ platform: 'messenger', action: 'create', name: 'Order_Update_US' })).toThrow()
  })
  it('B-F1 / B-F10 / B-F11 — an Instagram profile change names platform=instagram in the query too; no webviewHeight there; Meta\'s precedence said', async () => {
    h.send.mockResolvedValue({ node: { result: 'success' }, readBack: 'none', waitedMs: 0 })
    const ice = [{ locale: 'default', questions: [{ question: 'Taglie?', payload: 'SIZES' }] }]
    await runWith(setup, { section: 'profile', platform: 'instagram', properties: { iceBreakers: ice } })
    expect(sentChange(0)).toMatchObject({ operation: 'messengerprofile.set', params: { platform: 'instagram' }, via: { query: { platform: 'instagram' } } })
    h.profile = { ice_breakers: [{ locale: 'default', call_to_actions: [{ question: 'Old?', payload: 'OLD' }] }] }
    await runWith(setup, { section: 'profile', platform: 'instagram', clear: ['iceBreakers'] })
    expect(sentChange(1)).toMatchObject({ method: 'DELETE', params: { platform: 'instagram' }, via: { query: { platform: 'instagram' } } })
    h.profile = {}
    const messenger = await runWith(setup, { section: 'profile', properties: { iceBreakers: ice, commands: [{ locale: 'default', commands: [{ name: 'help', description: 'Aiuto' }] }] } })
    expect(sentChange(2).via).toBeUndefined()
    expect(sentChange(2).params).not.toHaveProperty('platform')
    expect(messenger.preview.preview.warnings.join(' ')).toMatch(/take precedence over the Get Started button/)
    expect(messenger.preview.preview.warnings.join(' ')).toMatch(/commands take priority over it/)
    expect((await previewWith(setup, { section: 'profile', platform: 'instagram', properties: { persistentMenu: [{ locale: 'default', items: [{ type: 'web_url', title: 'Shop', url: 'https://example.com', webviewHeight: 'tall' }] }] } })).error).toMatch(/no webviewHeight/)
  })
  it('A-N3 — a group\'s new description over an empty one: the undo cannot clear it, said in the preview and in the tool\'s consequences', async () => {
    expect(templates.consequencesFor!({ action: 'group-update', description: 'x' })).toEqual({ reversibility: 'partial' })
    expect(templates.consequencesFor!({ action: 'group-update', groupName: 'x' })).toEqual({ reversibility: 'partial' })
    h.waba = { wabaId: '120000000000900', name: 'WA A', currency: 'EUR', timeZoneId: '1', status: 'ACTIVE' }
    h.waTemplates = [{ templateId: '120000000000901', name: 'promo_old', language: 'it', status: 'APPROVED', category: 'MARKETING' }]
    h.group = { groupId: '120000000000950', name: 'Group A', description: null, templateIds: ['120000000000901'] }
    const p = await previewWith(templates, { platform: 'whatsapp', action: 'group-update', groupId: '120000000000950', description: 'Ordini' })
    expect(p.preview.warnings.join(' ')).toMatch(/the description had none before, which Nexus cannot write back/)
  })
  it('A-N4 — each undo reads Meta\'s answer back in the record\'s own form: a template edit, a person\'s menu (Meta\'s defaults), calling, a flow change, a group change', async () => {
    // A template edit.
    h.send.mockResolvedValue({ node: { success: true, status: 'APPROVED' }, readBack: 'same-request', waitedMs: 0 })
    const edit = await runWith(templates, { platform: 'messenger', action: 'edit', templateId: '120000000000811', body: { text: 'Order {{1}} leaves {{2}}.', examples: ['1001', 'today'] } })
    h.templates = [{ ...TEMPLATE, components: [{ type: 'BODY', text: 'Order {{1}} leaves {{2}}.', example: { body_text: [['1001', 'today']] } }] }]
    expect(await templates.undo!.current(edit.ran!.change! as never)).toEqual(edit.ran!.change!.after)
    // A person's menu: Meta answers its defaults (the text box shown, a link opening full height) it was not sent.
    h.send.mockResolvedValue({ node: { result: 'success' }, readBack: 'none', waitedMs: 0 })
    const menu = await runWith(setup, { section: 'person-menu', personId: PERSON, menu: [{ locale: 'default', items: [{ type: 'web_url', title: 'Shop', url: 'https://example.com' }] }] })
    h.userMenu = [{ locale: 'default', composer_input_disabled: false, call_to_actions: [{ type: 'web_url', title: 'Shop', url: 'https://example.com', webview_height_ratio: 'full' }] }]
    expect(await setup.undo!.current(menu.ran!.change! as never)).toEqual(menu.ran!.change!.after)
    // Calling.
    h.calls = { audio_enabled: true, icon_enabled: true }
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const calling = await runWith(setup, { section: 'calling', calling: { icon: false } })
    h.calls = { audio_enabled: true, icon_enabled: false }
    expect(await setup.undo!.current(calling.ran!.change! as never)).toEqual(calling.ran!.change!.after)
    // A flow change.
    h.flows = [{ id: '120000000000701', name: 'Flow A', eligible_platforms: ['messenger'], welcome_message: JSON.stringify([{ message: { text: 'Ciao' } }]), is_used_in_ad: false }]
    h.send.mockResolvedValue({ node: { success: true }, readBack: 'none', waitedMs: 0 })
    const flow = await runWith(setup, { section: 'welcome-flow', action: 'update', flowId: '120000000000701', flowName: 'Flow B' })
    h.flows = [{ ...h.flows[0], name: 'Flow B' }]
    expect(await setup.undo!.current(flow.ran!.change! as never)).toEqual(flow.ran!.change!.after)
    // A group change.
    h.waba = { wabaId: '120000000000900', name: 'WA A', currency: 'EUR', timeZoneId: '1', status: 'ACTIVE' }
    h.waTemplates = [{ templateId: '120000000000901', name: 'a', language: 'it', status: 'APPROVED', category: 'MARKETING' }, { templateId: '120000000000902', name: 'b', language: 'it', status: 'APPROVED', category: 'MARKETING' }]
    h.group = { groupId: '120000000000950', name: 'Group A', description: 'Old', templateIds: ['120000000000901'] }
    h.send.mockResolvedValue({ node: { id: '120000000000950' }, readBack: 'second-read', waitedMs: 0 })
    const group = await runWith(templates, { platform: 'whatsapp', action: 'group-update', groupId: '120000000000950', groupName: 'Group B', addTemplateIds: ['120000000000902'] })
    h.group = { groupId: '120000000000950', name: 'Group B', description: 'Old', templateIds: ['120000000000902', '120000000000901'] }
    expect(await templates.undo!.current(group.ran!.change! as never)).toEqual(group.ran!.change!.after)
  })
  it('A-S2 — an instant form outside the 24-hour window, a private reply Meta names no time for, a labels undo on another Page: each refused', async () => {
    h.form = { formId: '120000000000601', questionTypes: ['FULL_NAME', 'EMAIL'] }
    h.person = personAt(25 * HOUR)
    expect((await previewWith(message, { action: 'instant-form', platform: 'messenger', personId: PERSON, formId: '120000000000601' })).error).toMatch(/24-hour window for this person closed/)
    h.target = { platform: 'messenger', pageId: PAGE, instagramId: null, commentId: '500000000000001_900000000000001', postId: `${PAGE}_500000000000001`, createdAt: null, canReplyPrivately: null }
    expect((await previewWith(message, { action: 'private-reply', platform: 'messenger', postId: `${PAGE}_500000000000001`, commentId: '500000000000001_900000000000001', text: 'x' })).error).toMatch(/names no time for that comment/)
    h.send.mockResolvedValue({ node: { id: '120000000000801' }, readBack: 'none', waitedMs: 0 })
    const made = await runWith(labels, { action: 'create', name: 'return asked' })
    h.labels = [{ labelId: '120000000000801', name: 'return asked' }]
    expect(await labels.undo!.current(made.ran!.change! as never)).toEqual(made.ran!.change!.after)
    h.chosen = { ...h.chosen, pageId: '120000000000099' }
    expect(await labels.undo!.current(made.ran!.change! as never)).toBeNull()
  })
})
