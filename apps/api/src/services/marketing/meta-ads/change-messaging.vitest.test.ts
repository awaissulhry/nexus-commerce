/**
 * Meta step 38 — the messaging drafts, pure: Meta's windows, the utility text a person reads, the template parts both ways
 * (Nexus's shape ⇄ Meta's components, never an undo of what Nexus cannot send again), the profile, menu, calling and flow
 * read-backs, and the WhatsApp code kept out of the plan's hash. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import { planOf } from '../../agents/tools/meta-ads-kit.js'
import { conversationMessageDraft, labelCreateDraft, utilityText, windowNow, wordsProblem } from './change-messaging.js'
import {
  callingFromMeta, componentsOf, flowFromMeta, groupUpdateDraft, menuFromMeta, partsFromMeta, profileDraft, profileValueFromMeta, templateEditDraft, whatsappNumberDraft,
} from './change-messaging-setup.js'
import type { PersonState } from './live-messaging-change.js'

const PAGE = '120000000000010'
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-26T12:00:00Z')
const person = (lastAgoMs: number | null): PersonState => ({
  personId: '300000000000001', platform: 'messenger', pageId: PAGE, instagramId: null, conversationId: 't_400000000000001',
  lastMessageFromPerson: lastAgoMs === null ? null : new Date(NOW - lastAgoMs).toISOString(), standardWindowEndsAt: null, messageIds: [],
})

describe('Meta\'s windows', () => {
  it('24 hours for a response; 7 days for HUMAN_AGENT; no message from the person: closed', () => {
    expect(windowNow(person(23 * HOUR), NOW)).toMatchObject({ open: true, humanAgent: true })
    expect(windowNow(person(25 * HOUR), NOW)).toMatchObject({ open: false, humanAgent: true })
    expect(windowNow(person(7 * 24 * HOUR + 1), NOW)).toMatchObject({ open: false, humanAgent: false })
    expect(windowNow(person(null), NOW)).toMatchObject({ open: false, humanAgent: false, last: null })
    expect('refusal' in conversationMessageDraft(person(25 * HOUR), { mode: 'update', words: { text: 'x' } }, NOW)).toBe(true)
    expect('refusal' in conversationMessageDraft(person(25 * HOUR), { mode: 'human-agent', words: { text: 'x' } }, NOW)).toBe(false)
  })
  it('the words: text or one media link, Instagram\'s bytes, quick replies within Meta\'s limits', () => {
    expect(wordsProblem({ text: 'x', mediaUrl: 'https://example.com/a.jpg', mediaType: 'image' }, 'messenger')).toMatch(/text or one media/)
    expect(wordsProblem({ mediaUrl: 'https://example.com/a.pdf', mediaType: 'file' }, 'instagram')).toMatch(/image, a video or audio/)
    expect(wordsProblem({ text: '😊'.repeat(251) }, 'instagram')).toMatch(/1000 bytes/)
    expect(wordsProblem({ text: 'x', quickReplies: [{ title: 'Un titolo troppo lungo per Meta', payload: 'P' }] }, 'messenger')).toMatch(/1–20/)
    expect(wordsProblem({ text: 'Ciao\r\n' }, 'messenger')).toMatch(/printable/)
  })
})

describe('the utility text the person reads', () => {
  const template = (components: unknown, parameterFormat = 'NAMED') => ({ templateId: '1', name: 't', language: 'it_IT', status: 'APPROVED', category: 'UTILITY', parameterFormat, components })
  it('named parameters fill their own placeholders, each once; positional in order', () => {
    const named = template([{ type: 'HEADER', format: 'TEXT', text: 'Ordine {{order}}' }, { type: 'BODY', text: 'Ciao {{name}}, l\'ordine {{order}} parte oggi.' }])
    expect(utilityText({ template: named, parameters: [{ component: 'header', name: 'order', text: '1001' }, { component: 'body', name: 'name', text: 'Anna' }, { component: 'body', name: 'order', text: '1001' }], buttons: [] }))
      .toEqual({ header: 'Ordine 1001', body: 'Ciao Anna, l\'ordine 1001 parte oggi.' })
    expect(utilityText({ template: named, parameters: [{ component: 'body', name: 'name', text: 'Anna' }], buttons: [] })).toMatchObject({ problem: expect.stringMatching(/header takes the named parameters order/) })
    const positional = template([{ type: 'BODY', text: 'Order {{1}}' }], 'POSITIONAL')
    expect(utilityText({ template: positional, parameters: [{ component: 'body', name: 'x', text: '1' }], buttons: [] })).toMatchObject({ problem: expect.stringMatching(/without names/) })
  })
})

describe('template parts both ways', () => {
  it('Nexus\'s shape → Meta\'s components → Nexus\'s shape again; an image header or a placeholder link: no undo', () => {
    const parts = { header: { text: 'Ordine {{1}}', example: '1001' }, body: { text: 'Il tuo ordine {{1}} parte {{2}}.', examples: ['1001', 'oggi'] }, buttons: [{ type: 'phone' as const, text: 'Chiama', phone: '+390000000000' }] }
    const components = componentsOf(parts, 'POSITIONAL', 'messenger')
    expect(partsFromMeta(components, 'POSITIONAL', 'messenger')).toEqual(parts)
    expect(partsFromMeta([{ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['x'] } }, { type: 'BODY', text: 'x' }], 'POSITIONAL', 'messenger')).toBeNull()
    expect(partsFromMeta([{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Go', url: 'https://example.com/{{1}}' }] }], 'POSITIONAL', 'messenger')).toBeNull()
    const draft = templateEditDraft(PAGE, { templateId: '120000000000811', name: 'order_update', language: 'it_IT', status: 'APPROVED', category: 'UTILITY', parameterFormat: 'POSITIONAL', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }] }, { body: { text: 'y' } })
    expect('refusal' in draft).toBe(false)
    if (!('refusal' in draft)) {
      expect(draft.warnings.join(' ')).toMatch(/NO undo/)
      expect(draft.requests[0].undoable).toBe(false)
      expect(draft.before).toMatchObject({ parts: null })
    }
  })
  it('a group change that takes every template off is a delete; one that changes nothing is said', () => {
    const group = { groupId: '120000000000950', name: 'Group A', description: null, templateIds: ['120000000000901'] }
    expect(groupUpdateDraft('120000000000900', group, { name: null, description: null, add: [], remove: ['120000000000901'] }, [])).toMatchObject({ refusal: expect.stringMatching(/delete the group instead/) })
    const same = groupUpdateDraft('120000000000900', group, { name: 'Group A', description: null, add: ['120000000000901'], remove: [] }, [{ templateId: '120000000000901', name: 'a', language: 'it', status: 'APPROVED', category: 'UTILITY' }])
    expect(same).toMatchObject({ requests: [], skipped: [expect.stringMatching(/in the group already/)] })
  })
})

describe('the setup read back', () => {
  it('a profile property Nexus cannot send again has no undo, said in the preview; legacy ice breakers are the default locale', () => {
    expect(profileValueFromMeta('iceBreakers', [{ question: 'Taglie?', payload: 'SIZES' }], false)).toEqual([{ locale: 'default', questions: [{ question: 'Taglie?', payload: 'SIZES' }] }])
    expect(profileValueFromMeta('persistentMenu', [{ locale: 'default', call_to_actions: [{ type: 'nested', title: 'x' }] }], false)).toBeUndefined()
    expect(profileValueFromMeta('greeting', undefined, false)).toBeNull()
    const draft = profileDraft(PAGE, 'messenger', { persistent_menu: [{ locale: 'default', disabled_surfaces: ['CUSTOMER_CHAT_PLUGIN'], call_to_actions: [] }] }, { persistentMenu: [{ locale: 'default', items: [{ type: 'postback', title: 'Aiuto', payload: 'HELP' }] }] }, [])
    expect('refusal' in draft).toBe(false)
    if (!('refusal' in draft)) {
      expect(draft.warnings.join(' ')).toMatch(/No undo for persistentMenu/)
      expect(draft.before).toMatchObject({ properties: { persistentMenu: 'unknown' } })
    }
  })
  it('a menu, calling and a flow as Meta answers them, in Nexus\'s shape', () => {
    expect(menuFromMeta([{ locale: 'default', composer_input_disabled: false, call_to_actions: [{ type: 'web_url', title: 'Shop', url: 'https://example.com', webview_height_ratio: 'full' }] }], false))
      .toEqual([{ locale: 'default', composerInputDisabled: false, items: [{ type: 'web_url', title: 'Shop', url: 'https://example.com', webviewHeight: 'full' }] }])
    expect(callingFromMeta({ audio_enabled: true, call_hours: { timezone_id: 'Europe/Rome', weekly_operating_hours: [{ day_of_week: 'MONDAY', open_time: '0900', close_time: '1800' }] }, call_routing: { ring_target: 'META' } }))
      .toEqual({ audio: true, hours: { timeZone: 'Europe/Rome', days: [{ day: 'MONDAY', open: '0900', close: '1800' }] }, routing: 'META' })
    expect(flowFromMeta({ id: '1', name: 'Flow A', eligible_platforms: ['MESSENGER'], welcome_message: JSON.stringify([{ message: { text: 'Ciao' } }]) })).toEqual({ name: 'Flow A', platforms: ['messenger'], messages: [{ text: 'Ciao' }] })
    expect(flowFromMeta({ id: '1', name: 'Flow A', eligible_platforms: ['messenger'], welcome_message: JSON.stringify([{ message: { attachment: { type: 'image' } } }]) })).toBeNull()
  })
  it('the WhatsApp code: sent, never in the plan\'s hash or the record', () => {
    const one = whatsappNumberDraft({ pageId: PAGE, number: null, hasNumber: false }, '+39 000 000 0000', '123456')
    const two = whatsappNumberDraft({ pageId: PAGE, number: null, hasNumber: false }, '+39 000 000 0000', '654321')
    if ('refusal' in one || 'refusal' in two) throw new Error('refused')
    expect(one.requests[0].params).toEqual({ whatsapp_number: '+390000000000', verification_code: '123456' })
    expect(planOf(one)).toBe(planOf(two))
    expect(JSON.stringify([one.before, one.after, one.changes, one.summary, one.requests[0].label])).not.toContain('123456')
  })
  it('a label of the same name is said, never made twice', () => {
    expect(labelCreateDraft(PAGE, [{ labelId: '120000000000801', name: 'VIP' }], 'vip')).toMatchObject({ requests: [], skipped: [expect.stringMatching(/already has the label "VIP"/)] })
  })
})
