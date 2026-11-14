import { describe, expect, it } from 'vitest'
import { copyKeyOf, copyStateOf, providerNameOf, receiptDocument, receiptFileName, swapReadiness } from '../archive-copy/archive-copy'
import { goLiveProblems, goLiveWords, isTestRef, simulatedMessages, testModeState, testRefOf, testRefParts } from './test-mode'

// B-W2b-401 (FIN-096, FIN-097): test mode's rules and our own copies' rules. Every id is made up.

const SEND = '0193a0c0-0000-7000-8000-000000000001'

describe('e-invoice test mode (FIN-096)', () => {
  it('marks a simulated send for good by its provider id, with the outcome chosen then', () => {
    const ref = testRefOf(SEND, 'REJECTED')
    expect(isTestRef(ref)).toBe(true)
    expect(testRefParts(ref)).toEqual({ outcome: 'REJECTED', submissionId: SEND })
    expect(isTestRef('A-CUBE-123')).toBe(false)
    expect(isTestRef(null)).toBe(false)
    expect(testRefParts('TEST-MODE:LOST:x')).toBeNull()
  })

  it('answers each outcome with one notification, stable ids, and a rejection only on the first send', () => {
    const at = '2026-11-14T09:00:00.000Z'
    const [delivered] = simulatedMessages({ providerRef: testRefOf(SEND, 'DELIVERED'), fileName: 'IT12345670009_0A001.xml', attempt: 1, acceptedAt: at })
    expect(delivered).toMatchObject({ type: 'RC', messageId: `TEST-MODE-RC-${SEND}`, issuedAt: '2026-11-14T09:00:01.000Z', errors: [] })
    const [rejected] = simulatedMessages({ providerRef: testRefOf(SEND, 'REJECTED'), fileName: 'f.xml', attempt: 1, acceptedAt: at })
    expect(rejected).toMatchObject({ type: 'NS', errors: [{ code: '00423' }] })
    expect(rejected!.errors[0]!.description).toMatch(/^\[TEST\]/)
    expect(simulatedMessages({ providerRef: testRefOf(SEND, 'REJECTED'), fileName: 'f.xml', attempt: 2, acceptedAt: at })[0]!.type).toBe('RC')
    expect(simulatedMessages({ providerRef: testRefOf(SEND, 'NOT_DELIVERABLE'), fileName: 'f.xml', attempt: 1, acceptedAt: at })[0]!.type).toBe('MC')
    expect(simulatedMessages({ providerRef: 'A-CUBE-1', fileName: 'f.xml', attempt: 1, acceptedAt: at })).toEqual([])
  })

  it('says where a company stands: the banner in test mode, who answers its sends, live since when', () => {
    const live = { mode: 'LIVE', status: 'ACTIVE' }
    expect(testModeState({ testMode: true, liveSince: null, simulateOutcome: 'DELIVERED', connection: live })).toMatchObject({ code: 'TEST', banner: 'E-invoice test mode — nothing goes to SDI', simulated: true })
    expect(testModeState({ testMode: true, liveSince: null, simulateOutcome: 'DELIVERED', connection: { mode: 'FAKE', status: 'ACTIVE' } })).toMatchObject({ code: 'TEST', simulated: false })
    expect(testModeState({ testMode: true, liveSince: null, simulateOutcome: 'DELIVERED', connection: null }).words).toContain('No single SDI connection')
    expect(testModeState({ testMode: false, liveSince: '2026-11-09T08:00:00.000Z', simulateOutcome: 'DELIVERED', connection: live })).toMatchObject({ code: 'LIVE', banner: null, simulated: false })
  })

  it('lets a company go live only with one working connection whose intermediary exists (Q21)', () => {
    const codes = (input: Parameters<typeof goLiveProblems>[0]) => goLiveProblems(input).map((problem) => problem.code)
    expect(codes({ testMode: false, connections: [], liveProviderReady: true })).toEqual(['ALREADY_LIVE'])
    expect(codes({ testMode: true, connections: [], liveProviderReady: true })).toEqual(['NO_CONNECTION'])
    expect(codes({ testMode: true, connections: [{ mode: 'FAKE', status: 'ACTIVE' }, { mode: 'LIVE', status: 'ACTIVE' }], liveProviderReady: true })).toEqual(['SEVERAL_CONNECTIONS'])
    expect(codes({ testMode: true, connections: [{ mode: 'LIVE', status: 'PAUSED' }], liveProviderReady: true })).toEqual(['CONNECTION_PAUSED'])
    expect(codes({ testMode: true, connections: [{ mode: 'LIVE', status: 'ACTIVE' }], liveProviderReady: false })).toEqual(['PROVIDER_NOT_CHOSEN'])
    expect(codes({ testMode: true, connections: [{ mode: 'FAKE', status: 'ACTIVE' }], liveProviderReady: false })).toEqual([])
    expect(goLiveWords(3)).toContain('3 invoice(s) were sent in test mode')
    expect(goLiveWords(0)).toContain('No invoice was sent in test mode.')
  })
})

describe('our own copy of every send (FIN-097)', () => {
  it('keys a copy by its send, names the intermediary and the receipt file', () => {
    expect(copyKeyOf(SEND)).toBe(`sdi:${SEND}`)
    expect(providerNameOf({ label: 'SDI (fake)', mode: 'FAKE' })).toBe('FAKE')
    expect(providerNameOf({ label: '  Openapi\n SDI ', mode: 'LIVE' })).toBe('Openapi SDI')
    expect(receiptFileName('IT12345670009_0A001.xml', 'RC', 1)).toBe('IT12345670009_0A001_RC_001.xml')
  })

  it('records a notification as deterministic XML, its text escaped', () => {
    const facts = { type: 'NS' as const, sdiMessageId: 'MSG-1', receivedAt: '2026-11-14T09:00:01.000Z', payload: { sdiIdentifier: '123', fileName: 'f.xml', errors: [{ code: '00423', description: 'Totale <errato> & altro', hint: null }], outcome: null, note: null } }
    const xml = receiptDocument(facts, 'FAKE')
    expect(xml).toBe(receiptDocument(facts, 'FAKE'))
    expect(xml).toContain('<NotificaSdiRegistrata tipo="NS" fonte="FAKE">')
    expect(xml).toContain('<Descrizione>Totale &lt;errato&gt; &amp; altro</Descrizione>')
    expect(xml).toContain('<IdentificativoSdI>123</IdentificativoSdI>')
  })

  it('tells how complete a copy is, and whether the company may swap its intermediary', () => {
    expect(copyStateOf({ status: 'FAILED', providerRef: null }, null, 0).state).toBe('NOT_SENT')
    expect(copyStateOf({ status: 'DELIVERED', providerRef: testRefOf(SEND, 'DELIVERED') }, null, 1).state).toBe('SIMULATED')
    expect(copyStateOf({ status: 'SENT', providerRef: 'P-1' }, null, 0).state).toBe('MISSING')
    expect(copyStateOf({ status: 'DELIVERED', providerRef: 'P-1' }, { notificationsKept: 0 }, 1).state).toBe('RECEIPTS_MISSING')
    expect(copyStateOf({ status: 'DELIVERED', providerRef: 'P-1' }, { notificationsKept: 1 }, 1).state).toBe('COMPLETE')
    expect(swapReadiness([{ status: 'DELIVERED', copy: 'COMPLETE' }, { status: 'SENT', copy: 'SIMULATED' }, { status: 'FAILED', copy: 'NOT_SENT' }])).toMatchObject({ ready: true, open: 0, missing: 0, copied: 1 })
    const waiting = swapReadiness([{ status: 'SENT', copy: 'COMPLETE' }, { status: 'DELIVERED', copy: 'RECEIPTS_MISSING' }])
    expect(waiting).toMatchObject({ ready: false, open: 1, missing: 1 })
    expect(waiting.words).toContain('still wait for SDI')
  })
})
