import { describe, expect, it } from 'vitest'
import { markMoney } from '../../money/marked'
import { MESSAGE_TEMPLATES, sentenceOf } from '../rules'
import { cadenceIn, cellProblem, choiceFor, DECIDED_MESSAGE_KEYS, EVENT_KINDS, kindOf, madeQuiet, PREFERENCE_CHANNELS, preferenceKey, quietDefault, resolveMatrix, roleDefaultKey } from './preferences'
import { endpointProblem, fromBase64Url, keysProblem, labelProblem, pushMessageOf, pushOutcomeOf, testPushOf } from './push'
import { databaseNotificationRefusal } from './refusals'
import { viewChange, viewFingerprint, viewFollowKey } from './view-follow'

const USER = '0190f000-0000-7000-8000-000000000001'
const PLANNER = '0190f000-0000-7000-8000-0000000000a1'
const SALES = '0190f000-0000-7000-8000-0000000000a2'
const W2A_DIGEST = ['MENTION', 'ASSIGNMENT', 'APPROVAL', 'ALERT'] as const

describe('the preferences matrix (PLT-141)', () => {
  it('is 7 kinds × 3 channels; nobody chose: in the app as it happens, e-mail in the digest of the digest’s own kinds, push only for the urgent', () => {
    const cells = resolveMatrix({ person: [], roles: [], digestCategories: [...W2A_DIGEST] })
    expect(cells).toHaveLength(EVENT_KINDS.length * PREFERENCE_CHANNELS.length)
    expect(cells.every((cell) => cell.source === 'QUIET')).toBe(true)
    expect(EVENT_KINDS.every((kind) => cadenceIn(cells, kind, 'IN_APP') === 'INSTANT')).toBe(true)
    expect(cadenceIn(cells, 'MENTIONED', 'EMAIL')).toBe('DAILY_DIGEST')
    expect(cadenceIn(cells, 'FOLLOWING_CHANGED', 'EMAIL')).toBe('OFF')
    expect(EVENT_KINDS.filter((kind) => cadenceIn(cells, kind, 'PUSH') === 'INSTANT')).toEqual(['MENTIONED', 'APPROVAL_WAITING', 'AREA_ALERT'])
    // The digest's own choice (W2a) is the e-mail column's quiet default.
    expect(quietDefault('FOLLOWING_CHANGED', 'EMAIL', ['FOLLOWING'])).toBe('DAILY_DIGEST')
    expect(quietDefault('MENTIONED', 'EMAIL', ['FOLLOWING'])).toBe('OFF')
  })

  it('my own choice wins, then the loudest of my roles’ defaults (the first role on a tie), then the quiet default', () => {
    const cells = resolveMatrix({
      person: [{ event: 'MENTIONED', channel: 'EMAIL', cadence: 'OFF' }],
      roles: [
        { roleId: PLANNER, event: 'MENTIONED', channel: 'EMAIL', cadence: 'INSTANT' },
        { roleId: PLANNER, event: 'AREA_ALERT', channel: 'EMAIL', cadence: 'DAILY_DIGEST' },
        { roleId: SALES, event: 'AREA_ALERT', channel: 'EMAIL', cadence: 'INSTANT' },
        { roleId: PLANNER, event: 'ASSIGNED', channel: 'PUSH', cadence: 'OFF' },
        { roleId: SALES, event: 'ASSIGNED', channel: 'PUSH', cadence: 'OFF' },
      ],
      digestCategories: [...W2A_DIGEST],
    })
    const cell = (event: string, channel: string) => cells.find((entry) => entry.event === event && entry.channel === channel)!
    expect(cell('MENTIONED', 'EMAIL')).toMatchObject({ cadence: 'OFF', source: 'PERSON', roleId: null, quiet: 'DAILY_DIGEST' })
    expect(cell('AREA_ALERT', 'EMAIL')).toMatchObject({ cadence: 'INSTANT', source: 'ROLE', roleId: SALES })
    expect(cell('ASSIGNED', 'PUSH')).toMatchObject({ cadence: 'OFF', source: 'ROLE', roleId: PLANNER })
    expect(cell('APPROVAL_DECIDED', 'IN_APP')).toMatchObject({ cadence: 'INSTANT', source: 'QUIET' })
  })

  it('a cell is checked: only e-mail has a daily digest, and the kinds and channels are the matrix’s', () => {
    expect(cellProblem({ event: 'MENTIONED', channel: 'PUSH', cadence: 'DAILY_DIGEST' })).toEqual({ path: 'body/cadence', message: 'Only e-mail has a daily digest: choose as it happens or off here.' })
    expect(cellProblem({ event: 'MENTIONED', channel: 'IN_APP', cadence: 'DAILY_DIGEST' })?.path).toBe('body/cadence')
    expect(cellProblem({ event: 'MENTIONED', channel: 'EMAIL', cadence: 'DAILY_DIGEST' })).toBeNull()
    expect(cellProblem({ event: 'SHOUTED', channel: 'EMAIL', cadence: 'OFF' })?.path).toBe('body/event')
    expect(cellProblem({ event: 'MENTIONED', channel: 'FAX', cadence: 'OFF' })?.path).toBe('body/channel')
    expect(cellProblem({ event: 'MENTIONED', channel: 'PUSH', cadence: null })).toBeNull()
    expect(preferenceKey(USER, 'MENTIONED', 'PUSH')).toBe(`pref:${USER}:MENTIONED:PUSH`)
    expect(roleDefaultKey(PLANNER, 'AREA_ALERT', 'EMAIL')).toBe(`default:${PLANNER}:AREA_ALERT:EMAIL`)
  })

  it('names the kind of a notification; SYSTEM news is not a row (in the app only)', () => {
    expect(kindOf({ category: 'MENTION', messageKey: 'notifications.mentioned' })).toBe('MENTIONED')
    expect(kindOf({ category: 'ASSIGNMENT', messageKey: 'notifications.assigned.task' })).toBe('ASSIGNED')
    expect(kindOf({ category: 'ASSIGNMENT', messageKey: 'notifications.mail.assigned' })).toBe('MAIL_ASSIGNED')
    expect(kindOf({ category: 'APPROVAL', messageKey: 'notifications.approval.taskAsked' })).toBe('APPROVAL_WAITING')
    expect(kindOf({ category: 'APPROVAL', messageKey: 'notifications.approval.taskDecided' })).toBe('APPROVAL_DECIDED')
    expect(kindOf({ category: 'ALERT', messageKey: 'notifications.alert.raised' })).toBe('AREA_ALERT')
    expect(kindOf({ category: 'FOLLOWING', messageKey: 'notifications.following.view' })).toBe('FOLLOWING_CHANGED')
    expect(kindOf({ category: 'SYSTEM', messageKey: 'notifications.links.renewAsked' })).toBeNull()
    // Every decision sentence is a sentence the notifications know.
    for (const key of DECIDED_MESSAGE_KEYS) expect(Object.hasOwn(MESSAGE_TEMPLATES, key), key).toBe(true)
  })

  it('says what a kind brings: nothing when off everywhere, kept quiet when off in the app only; SYSTEM stays in the app', () => {
    const off = resolveMatrix({ person: (['IN_APP', 'EMAIL', 'PUSH'] as const).map((channel) => ({ event: 'ASSIGNED' as const, channel, cadence: 'OFF' as const })), roles: [], digestCategories: [] })
    expect(choiceFor(off, 'ASSIGNED')).toEqual({ made: false, inApp: false, emailNow: false, digest: false, pushNow: false })
    const mailOnly = resolveMatrix({ person: [{ event: 'ASSIGNED', channel: 'IN_APP', cadence: 'OFF' }, { event: 'ASSIGNED', channel: 'EMAIL', cadence: 'INSTANT' }], roles: [], digestCategories: [] })
    expect(choiceFor(mailOnly, 'ASSIGNED')).toEqual({ made: true, inApp: false, emailNow: true, digest: false, pushNow: false })
    expect(choiceFor(off, null)).toEqual({ made: true, inApp: true, emailNow: false, digest: false, pushNow: false })
    const at = new Date('2026-11-13T09:00:00.000Z')
    expect(madeQuiet({ createdAt: at, readAt: at, doneAt: at })).toBe(true)
    expect(madeQuiet({ createdAt: at, readAt: at, doneAt: new Date(at.getTime() + 60_000) })).toBe(false)
    expect(madeQuiet({ createdAt: at, readAt: null, doneAt: null })).toBe(false)
  })
})

describe('push to phones (PLT-140, PLT-152)', () => {
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url')
  const auth = Buffer.alloc(16, 9).toString('base64url')

  it('sends only to the browsers’ push services, over https, and checks the browser’s keys and the device name', () => {
    expect(endpointProblem('https://fcm.googleapis.com/fcm/send/abc')).toBeNull()
    expect(endpointProblem('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBeNull()
    expect(endpointProblem('https://web.push.apple.com/QGx')).toBeNull()
    expect(endpointProblem('https://wns2-par02p.notify.windows.com/w/?token=x')).toBeNull()
    expect(endpointProblem('http://fcm.googleapis.com/fcm/send/abc')).toMatch(/https address/)
    expect(endpointProblem('https://fcm.googleapis.com:8443/x')).toMatch(/https address/)
    expect(endpointProblem('https://internal.example.com/push')).toMatch(/not one the factory sends to/)
    expect(endpointProblem('https://fcm.googleapis.com.evil.example/x')).toMatch(/not one the factory sends to/)
    expect(keysProblem({ p256dh, auth })).toBeNull()
    expect(keysProblem({ p256dh: Buffer.alloc(65, 3).toString('base64url'), auth })).toMatch(/P-256/)
    expect(keysProblem({ p256dh, auth: Buffer.alloc(12).toString('base64url') })).toMatch(/16 bytes/)
    expect(keysProblem({ p256dh: 'not base64!', auth })).toMatch(/P-256/)
    expect(fromBase64Url(auth)).toEqual(Uint8Array.from(Buffer.alloc(16, 9)))
    expect(labelProblem('Phone')).toBeNull()
    expect(labelProblem('  ')).toMatch(/1 to 100/)
    expect(labelProblem('Phone\nTwo')).toMatch(/one line/)
  })

  it('writes each push for its reader now: a price only for a reader who holds the price grain, in their language', () => {
    const notification = { id: '0190f000-0000-7000-8000-0000000000f1', messageKey: 'notifications.approval.quote_requested', params: { actorId: USER, netAmount: markMoney('price', { minor: 123456, currency: 'EUR' }) }, recordType: 'Quote', recordId: '0190f000-0000-7000-8000-0000000000f2', recordLabel: 'Q-2026-0042', actorId: USER }
    const names = new Map([[USER, 'Marco']])
    const withPrice = pushMessageOf(notification, { locale: 'en', grains: new Set(['price']) }, names, '/w/A/home/notifications?open=x')
    expect(withPrice).toEqual({ v: 1, title: 'Q-2026-0042', body: 'Marco asks you to approve quote Q-2026-0042 (EUR 1234.56)', url: '/w/A/home/notifications?open=x', tag: `Quote:${notification.recordId}`, notificationId: notification.id })
    const without = pushMessageOf(notification, { locale: 'it', grains: new Set(['cost']) }, names, '/w/A/home/notifications?open=x')
    expect(without.body).toBe('Marco ti chiede di approvare il preventivo Q-2026-0042')
    expect(JSON.stringify(without)).not.toMatch(/1234|EUR/)
    expect(testPushOf('en', '/w/A/home/notifications').title).toBe('Push is on')
    expect([pushOutcomeOf(201), pushOutcomeOf(404), pushOutcomeOf(410), pushOutcomeOf(429), pushOutcomeOf(500)]).toEqual(['SENT', 'GONE', 'GONE', 'FAILED', 'FAILED'])
  })
})

describe('following a saved view (PLT-151)', () => {
  it('fingerprints the rows by id whatever their order, and says what came in and what left', () => {
    const a = '0190f000-0000-7000-8000-00000000000a'
    const b = '0190f000-0000-7000-8000-00000000000b'
    const c = '0190f000-0000-7000-8000-00000000000c'
    expect(viewFingerprint([b, a])).toBe(viewFingerprint([a, b, a]))
    expect(viewFingerprint([a, b])).toMatch(/^[0-9a-f]{64}$/)
    expect(viewFingerprint([a, b])).not.toBe(viewFingerprint([a, c]))
    expect(viewChange([a, b], [b, c])).toEqual({ entered: 1, left: 1 })
    expect(viewChange([], [a, b])).toEqual({ entered: 2, left: 0 })
    expect(viewFollowKey(a, USER)).toBe(`view:${a}:${USER}`)
  })

  it('says a followed view’s change in both languages from its counts', () => {
    const view = { messageKey: 'notifications.following.view', params: { count: 5, entered: 2, left: 1 }, recordLabel: 'Late orders', actorId: null }
    expect(sentenceOf(view, new Map(), 'en')).toBe('Late orders, a saved view you follow, changed: 2 came in, 1 left (5 now)')
    expect(sentenceOf({ ...view, messageKey: 'notifications.following.viewCount' }, new Map(), 'it')).toBe('Late orders, una vista salvata che segui, è cambiata (ora 5)')
  })
})

describe('the database’s notification refusals in words', () => {
  it('maps the rules a route can reach to a 409 in words, and nothing else', () => {
    expect(databaseNotificationRefusal('notifications: only e-mail has a daily digest (preference x, channel PUSH)')?.path).toBe('body/cadence')
    expect(databaseNotificationRefusal('notifications: push subscription x was turned off at 2026-11-13; it changes no more (only its sealed keys go)')?.path).toBe('push/TURNED_OFF')
    expect(databaseNotificationRefusal("views: view x is its owner's alone; only its owner follows it")?.path).toBe('views/ONLY_ME')
    expect(databaseNotificationRefusal('notifications: preference x is an office person')?.path).toBe('notifications/OFFICE_PERSON')
    expect(databaseNotificationRefusal('inventory: location x is blocked')).toBeNull()
  })
})
