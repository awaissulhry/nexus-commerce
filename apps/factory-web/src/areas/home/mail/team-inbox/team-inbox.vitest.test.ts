import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QUEUE_VIEWS as DOMAIN_VIEWS, WORK_STATES } from '@nexus/factory-domain/mail-depth/rules'
import type { ApiClient } from '../../../../lib/api/client'
import { ApiError } from '../../../../lib/api/errors'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as captureScreen } from '../../../admin/connections/mail-domain/capture/fixtures'
import { changeHeld, makeHeld, captureWriteProblem } from '../../../admin/connections/mail-domain/capture/model'
import { captureSetupHref, copyHeld } from '../capture/model'
import { inquiryHeld, inquiryHref } from '../create-inquiry/model'
import { listQueue, workOn } from './api'
import { designScreen } from './fixtures'
import { bulkReach, moveTargets, queueAddressOf, QUEUE_VIEWS, stateWords, untilHeld, verbHeld, viewCount, workProblem, type QueueMail, type TeamInbox } from './model'

/**
 * Home › Mail's team inboxes, "Create an inquiry", "Copy capture address" (SCR-438) and Admin › Connections' capture address
 * (SCR-439) — B-W2b-397: their calls, their rules, their words in it and en, and every design case drawn with no key on screen.
 */

const NOW = Date.parse('2026-11-14T09:00:00.000Z')
const inbox = (id: string, extra: Partial<TeamInbox> = {}): TeamInbox => ({ id, companyId: 'c', name: id, localPart: id, address: null, active: true, members: [], member: true, counts: { open: 3, unassigned: 1, mine: 1, snoozed: 0, followUp: 2 }, version: 1, ...extra })
const row = (id: string, extra: Partial<QueueMail> = {}): QueueMail => ({
  id,
  status: 'MATCHED',
  receivedAt: '2026-11-14T08:00:00.000Z',
  from: { address: 'a@x.example.invalid', name: null },
  subject: 'S',
  verdicts: { dmarc: 'PASS', spam: 'PASS' },
  attachmentCount: 0,
  thread: { id: 't', recordType: 'SalesOrder', recordId: 'o' },
  teamInboxId: 'orders',
  state: 'OPEN',
  assignee: null,
  mine: false,
  assignedAt: null,
  closedAt: null,
  snoozedUntil: null,
  followUpUntil: null,
  inquiry: null,
  version: 3,
  ...extra,
})

describe('the calls', () => {
  it('read a view of the queue and write each change with the mail’s version and its own key', async () => {
    const calls: Array<{ method: string; path: string; options: Record<string, unknown> }> = []
    const answer = { mail: row('m1') }
    const api = {
      get: async (path: string, options: Record<string, unknown>) => (calls.push({ method: 'GET', path, options }), { mails: [], nextCursor: null }),
      post: async (path: string, options: Record<string, unknown>) => (calls.push({ method: 'POST', path, options }), answer),
    } as unknown as ApiClient
    await listQueue(api, 'inbox 1', 'FOLLOW_UP')
    expect(calls[0]).toMatchObject({ path: '/email/team-inboxes/inbox%201/mail', options: { query: { view: 'FOLLOW_UP', limit: 50 } } })
    await workOn(api, { id: 'm1', version: 3 }, { kind: 'followUp', until: '2026-11-15T08:00:00.000Z' })
    await workOn(api, { id: 'm1', version: 3 }, { kind: 'move', teamInboxId: 'quotes' })
    await workOn(api, { id: 'm1', version: 3 }, { kind: 'assignee', assigneeId: null })
    expect(calls.slice(1).map((call) => [call.path, call.options.body])).toEqual([
      ['/email/inbound/m1/follow-up', { version: 3, until: '2026-11-15T08:00:00.000Z' }],
      ['/email/inbound/m1/team-inbox', { version: 3, teamInboxId: 'quotes' }],
      ['/email/inbound/m1/assignee', { version: 3, assigneeId: null }],
    ])
    expect(new Set(calls.slice(1).map((call) => call.options.idempotencyKey)).size).toBe(3)
  })
})

describe('the queue’s rules', () => {
  it('mirror the API’s views and states', () => {
    expect([...QUEUE_VIEWS]).toEqual([...DOMAIN_VIEWS])
    expect(WORK_STATES).toEqual(['OPEN', 'SNOOZED', 'CLOSED'])
  })

  it('hold each verb with the API’s own refusal, said first', () => {
    const context = { busy: false, targets: 1 }
    expect(verbHeld('take', row('a', { mine: true }), context)).toBe('inbox.held.yoursAlready')
    expect(verbHeld('take', row('a'), context)).toBeNull()
    expect(verbHeld('giveBack', row('a'), context)).toBe('inbox.held.nobody')
    expect(verbHeld('close', row('a', { closedAt: '2026-11-13T10:00:00.000Z' }), context)).toBe('inbox.held.closedAlready')
    expect(verbHeld('reopen', row('a'), context)).toBe('inbox.held.openAlready')
    expect(verbHeld('snooze', row('a', { closedAt: '2026-11-13T10:00:00.000Z' }), context)).toBe('inbox.held.reopenFirst')
    expect(verbHeld('wake', row('a'), context)).toBe('inbox.held.notSnoozed')
    expect(verbHeld('followUp', row('a', { thread: null }), context)).toBe('inbox.held.noThread')
    expect(verbHeld('clearFollowUp', row('a'), context)).toBe('inbox.held.noFollowUp')
    expect(verbHeld('move', row('a'), { busy: false, targets: 0 })).toBe('inbox.held.noOtherInbox')
    expect(verbHeld('assign', row('a', { status: 'REJECTED' }), context)).toBe('inbox.held.rejected')
    expect(verbHeld('assign', row('a'), { busy: true, targets: 1 })).toBe('inbox.held.busy')
  })

  it('reach only what a bulk changes, move only to an inbox the person works, count the views the API counts', () => {
    const rows = [row('a', { mine: true }), row('b'), row('c', { closedAt: '2026-11-13T10:00:00.000Z' })]
    expect(bulkReach(rows, ['a', 'b', 'c'], 'take').map((entry) => entry.id)).toEqual(['b', 'c'])
    expect(bulkReach(rows, ['a', 'b', 'c'], 'close').map((entry) => entry.id)).toEqual(['a', 'b'])
    const inboxes = [inbox('orders'), inbox('quotes'), inbox('repairs', { member: false }), inbox('old', { active: false })]
    expect(moveTargets(inboxes, { teamInboxId: 'orders' }, false).map((entry) => entry.id)).toEqual(['quotes'])
    expect(moveTargets(inboxes, { teamInboxId: 'orders' }, true).map((entry) => entry.id)).toEqual(['quotes', 'repairs'])
    expect(viewCount(inboxes[0], 'FOLLOW_UP')).toBe(2)
    expect(viewCount(inboxes[0], 'CLOSED')).toBeNull()
    expect(stateWords(row('s', { state: 'SNOOZED', snoozedUntil: '2026-11-15T08:00:00.000Z' }))).toEqual({ key: 'inbox.state.SNOOZED', time: '2026-11-15T08:00:00.000Z', tone: 'info' })
  })

  it('a time 5 minutes to 90 days ahead; the address terms; a refusal in words', () => {
    expect(untilHeld('', NOW)).toBe('inbox.followUp.pickFirst')
    expect(untilHeld(new Date(NOW + 60_000).toISOString(), NOW)).toBe('inbox.followUp.tooSoon')
    expect(untilHeld(new Date(NOW + 91 * 86_400_000).toISOString(), NOW)).toBe('inbox.followUp.tooFar')
    expect(untilHeld(new Date(NOW + 86_400_000).toISOString(), NOW)).toBeNull()
    const params = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? null })
    expect(queueAddressOf(params({ inbox: '0190f0e2-4380-7000-8000-000000000001', view: 'MINE' }))).toEqual({ inboxId: '0190f0e2-4380-7000-8000-000000000001', view: 'MINE' })
    expect(queueAddressOf(params({ inbox: 'x', view: 'NOPE' }))).toEqual({ inboxId: null, view: 'OPEN' })
    expect(workProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version' }]))).toEqual({ key: 'inbox.notice.moved', tone: 'warning', reload: true })
    expect(workProblem(new ApiError('conflict', 409, 'conflict', 'This mail is closed already.')).key).toBe('inbox.notice.cannot')
    expect(workProblem(new Error('x')).key).toBe('inbox.notice.failed')
  })
})

describe('Create an inquiry and the capture address', () => {
  it('Create an inquiry links to Sales › Inquiries with the mail, held without the right, once made, or for a mail not read', () => {
    expect(inquiryHref('/w/DEMO', 'm 1')).toBe('/w/DEMO/sales/inquiries?mail=m%201')
    expect(inquiryHeld({ status: 'TRIAGE' }, true)).toBeNull()
    expect(inquiryHeld({ status: 'MATCHED' }, true)).toBeNull()
    expect(inquiryHeld({ status: 'TRIAGE' }, false)).toBe('inquiry.held.noRight')
    expect(inquiryHeld({ status: 'MATCHED', inquiry: { number: 'INQ-1' } }, true)).toBe('inquiry.held.made')
    expect(inquiryHeld({ status: 'FAILED' }, true)).toBe('inquiry.held.failed')
    expect(inquiryHeld({ status: 'REJECTED' }, true)).toBe('inquiry.held.notWaiting')
  })

  it('Copy waits while read, without a domain or an address; the card’s writes need the right and the domain', () => {
    expect(copyHeld({ status: 'loading' })).toBe('capture.held.reading')
    expect(copyHeld({ status: 'ready', address: null, receivingDomain: null, mayManage: true })).toBe('capture.held.noDomain')
    expect(copyHeld({ status: 'ready', address: null, receivingDomain: 'd', mayManage: true })).toBe('capture.held.none')
    expect(copyHeld({ status: 'ready', address: 'c-x@d', receivingDomain: 'd', mayManage: false })).toBeNull()
    expect(captureSetupHref('/w/DEMO')).toBe('/w/DEMO/admin/connections#capture')
    expect(makeHeld({ capture: null, receivingDomain: null, mayManage: true }, false)).toBe('captureAdmin.held.noDomain')
    expect(makeHeld({ capture: null, receivingDomain: 'd', mayManage: false }, false)).toBe('captureAdmin.held.noRight')
    expect(changeHeld({ capture: null, receivingDomain: 'd', mayManage: true }, true)).toBe('captureAdmin.held.busy')
    expect(captureWriteProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toEqual({ key: 'captureAdmin.notice.changed', reload: true })
  })
})

const LEFT_KEY = /\b(?:misSend|tiles|inbox|verb|col|keys|bulk|assign|move|followUp|dialog|inquiry|capture|captureAdmin|mailToSort)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*/
const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) =>
  renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as ComponentType<{ model: unknown }>, { model })))

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [designScreen, captureScreen] as unknown as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the states the design names, made-up data only', () => {
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const wanted of ['tiles', 'inbox-open', 'inbox-selected', 'assign', 'move', 'snooze', 'follow-up', 'updates', 'inbox-empty', 'inbox-loading', 'inbox-error', 'inboxes-error', 'capture-none', 'create-inquiry', 'create-inquiry-held', 'no-permission']) expect(ids).toContain(wanted)
    const captureIds = captureScreen.cases.map((entry) => entry.id)
    for (const wanted of ['live', 'read-only', 'none', 'no-domain', 'replace', 'turn-off', 'loading', 'error']) expect(captureIds).toContain(wanted)
    expect(JSON.stringify([designScreen.cases, captureScreen.cases])).not.toMatch(/@[a-z0-9-]+\.(com|it|net)\b/i)
  })

  it('it and en hold the same keys', () => {
    const flat = (tree: Record<string, unknown>, prefix = ''): string[] => Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : flat(value as Record<string, unknown>, `${prefix}${key}.`)))
    const keys = (locale: string) => flat(JSON.parse(readFileSync(new URL(`../../../../../messages/${locale}/mail-depth.json`, import.meta.url), 'utf8')) as Record<string, unknown>).sort()
    expect(keys('it')).toEqual(keys('en'))
    for (const view of QUEUE_VIEWS) expect(keys('en')).toEqual(expect.arrayContaining([`inbox.view.${view}`, `inbox.empty.${view}.title`, `inbox.empty.${view}.body`]))
  })
})
