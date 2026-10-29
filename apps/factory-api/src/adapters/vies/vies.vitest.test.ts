import { describe, expect, it } from 'vitest'
import type { IntegrationMode } from '@nexus/factory-domain/ports/provider'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { FakeVies } from './fake'
import { ViesFault } from './port'
import { checkVatApproxEnvelope, parseCheckVatApprox, viesSoapAdapter, VIES_ENDPOINTS } from './soap'

/**
 * The VIES adapters without a network: the SOAP adapter on a scripted transport (answers shaped like the Commission's
 * checkVatApprox ones, with made-up numbers and traders) and the FAKE. The gateway around them is tested in
 * modules/parties/parties.pg.vitest.test.ts.
 */

function callFor(mode: IntegrationMode): GatewayCall & { answers: unknown[] } {
  const answers: unknown[] = []
  return {
    account: { id: '00000000-0000-7000-8000-000000000001', tenantId: '00000000-0000-7000-8000-000000000002', companyId: null, provider: 'VIES', mode, settings: null },
    attempt: 1,
    signal: new AbortController().signal,
    idempotencyKey: null,
    credentials: async () => null,
    answer: (details) => answers.push(details),
    answers,
  }
}

const REQUEST = { countryCode: 'DE', vatNumber: '100000000', requester: { countryCode: 'IT', vatNumber: '12345670009' } } as const

const answer = (valid: boolean, extra = '') =>
  `<?xml version="1.0"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><ns2:checkVatApproxResponse xmlns:ns2="urn:ec.europa.eu:taxud:vies:services:checkVat:types">` +
  `<ns2:countryCode>DE</ns2:countryCode><ns2:vatNumber>100000000</ns2:vatNumber><ns2:requestDate>2026-10-29+01:00</ns2:requestDate><ns2:valid>${valid}</ns2:valid>${extra}</ns2:checkVatApproxResponse></env:Body></env:Envelope>`
const fault = (code: string) => `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><env:Fault><faultcode>env:Server</faultcode><faultstring>${code}</faultstring></env:Fault></env:Body></env:Envelope>`

describe('the SOAP VIES adapter (checkVatApprox)', () => {
  it('sends an identified request and escapes what it sends', () => {
    const envelope = checkVatApproxEnvelope({ countryCode: 'DE', vatNumber: '1<2', requester: REQUEST.requester })
    expect(envelope).toContain('<urn:countryCode>DE</urn:countryCode><urn:vatNumber>1&lt;2</urn:vatNumber>')
    expect(envelope).toContain('<urn:requesterCountryCode>IT</urn:requesterCountryCode><urn:requesterVatNumber>12345670009</urn:requesterVatNumber>')
    expect(checkVatApproxEnvelope({ ...REQUEST, requester: null })).not.toContain('requester')
  })

  it('reads a valid answer with its consultation number, and "---" as nothing', () => {
    const parsed = parseCheckVatApprox(answer(true, '<ns2:traderName>FAKE GMBH &amp; CO</ns2:traderName><ns2:traderAddress>EXAMPLESTR. 1\n10115 TOWN</ns2:traderAddress><ns2:traderCompanyType>---</ns2:traderCompanyType><ns2:requestIdentifier>WAPIAAAAX1</ns2:requestIdentifier>'))
    expect(parsed).toEqual({ kind: 'answer', answer: { result: 'VALID', requestDate: '2026-10-29+01:00', consultationNumber: 'WAPIAAAAX1', traderName: 'FAKE GMBH & CO', traderAddress: 'EXAMPLESTR. 1 10115 TOWN' } })
    expect(parseCheckVatApprox(answer(false, '<ns2:traderName>---</ns2:traderName>'))).toMatchObject({ kind: 'answer', answer: { result: 'INVALID', traderName: null, consultationNumber: null } })
    expect(parseCheckVatApprox(fault('MS_UNAVAILABLE'))).toEqual({ kind: 'fault', code: 'MS_UNAVAILABLE' })
    expect(parseCheckVatApprox('<html>busy</html>')).toEqual({ kind: 'unreadable' })
  })

  it('posts to the live or test service by the account mode and keeps the body hash', async () => {
    const sent: { url: string; body: string }[] = []
    const adapter = viesSoapAdapter({
      fetch: async (url, init) => {
        sent.push({ url: String(url), body: String(init?.body) })
        return new Response(answer(true, '<ns2:requestIdentifier>WAPIAAAAX2</ns2:requestIdentifier>'), { status: 200 })
      },
    })
    const live = callFor('LIVE')
    const result = await adapter.check(live, REQUEST)
    expect(result).toMatchObject({ result: 'VALID', consultationNumber: 'WAPIAAAAX2', responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(live.answers).toEqual([{ httpStatus: 200, response: { valid: true, identified: true } }])
    await adapter.check(callFor('SANDBOX'), REQUEST)
    expect(sent.map((entry) => entry.url)).toEqual([VIES_ENDPOINTS.LIVE, VIES_ENDPOINTS.SANDBOX])
    await expect(adapter.check(callFor('FAKE'), REQUEST)).rejects.toBeInstanceOf(ProviderError)
  })

  it('turns a fault into a ViesFault the gateway retries only when it may pass later', async () => {
    const adapter = (code: string) => viesSoapAdapter({ fetch: async () => new Response(fault(code), { status: 500 }) })
    const unavailable = await adapter('MS_UNAVAILABLE').check(callFor('LIVE'), REQUEST).catch((error: unknown) => error)
    expect(unavailable).toBeInstanceOf(ViesFault)
    expect(unavailable).toMatchObject({ code: 'MS_UNAVAILABLE', retryable: true, httpStatus: 500, responseSha256: expect.any(String) })
    expect(await adapter('INVALID_INPUT').check(callFor('LIVE'), REQUEST).catch((error: unknown) => error)).toMatchObject({ code: 'INVALID_INPUT', retryable: false })
    const busy = await viesSoapAdapter({ fetch: async () => new Response('<html/>', { status: 503 }) }).check(callFor('LIVE'), REQUEST).catch((error: unknown) => error)
    expect(busy).toMatchObject({ name: 'ProviderError', retryable: true, httpStatus: 503 })
  })
})

describe('the FAKE VIES', () => {
  it('answers by the last digit: 8 invalid, 9 unavailable, else valid with a consultation number when identified', async () => {
    const fake = new FakeVies()
    expect(await fake.check(callFor('FAKE'), REQUEST)).toMatchObject({ result: 'VALID', consultationNumber: expect.stringMatching(/^FAKE[0-9A-F]{12}$/), traderName: 'FAKE TRADER DE100000000' })
    expect(await fake.check(callFor('FAKE'), { ...REQUEST, requester: null })).toMatchObject({ result: 'VALID', consultationNumber: null })
    expect(await fake.check(callFor('FAKE'), { ...REQUEST, vatNumber: '100000008' })).toMatchObject({ result: 'INVALID', consultationNumber: null, traderName: null })
    await expect(fake.check(callFor('FAKE'), { ...REQUEST, vatNumber: '100000009' })).rejects.toMatchObject({ code: 'MS_UNAVAILABLE', retryable: true })
    fake.failNext(1, 'INVALID_REQUESTER_INFO')
    await expect(fake.check(callFor('FAKE'), REQUEST)).rejects.toMatchObject({ code: 'INVALID_REQUESTER_INFO', retryable: false })
    expect(fake.requests).toHaveLength(5)
    await expect(fake.check(callFor('LIVE'), REQUEST)).rejects.toBeInstanceOf(ProviderError)
  })
})
