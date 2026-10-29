import { createHash } from 'node:crypto'
import type { ViesAnswer, ViesRequest } from '@nexus/factory-domain/ports/vies'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { ViesFault, type ViesAdapter } from './port'

/**
 * The real VIES (LIVE and SANDBOX accounts): the European Commission's SOAP service `checkVatApprox` (WSDL
 * https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl). A check that names the requester (our company's VAT
 * number) gets a `requestIdentifier`, the consultation number that proves it; the answer and the raw body's SHA-256 are
 * kept. SANDBOX calls the Commission's documented test service (checkVatTestService), which answers by number
 * (100 valid, 200 invalid, 201 INVALID_INPUT, 300 SERVICE_UNAVAILABLE, 301 MS_UNAVAILABLE …), never a real register.
 *
 * Runs only inside a gateway call (modules/parties/vies.ts): `call.signal` ends it at the account's timeout, and every
 * fault is a ViesFault the gateway retries when VIES says it may pass later. No credentials (VIES has none). The
 * transport is `fetch`, replaceable for tests (./soap.vitest.test.ts).
 */

export const VIES_ENDPOINTS = Object.freeze({
  LIVE: 'https://ec.europa.eu/taxation_customs/vies/services/checkVatService',
  SANDBOX: 'https://ec.europa.eu/taxation_customs/vies/services/checkVatTestService',
})

/** At most this much of an answer is read (a VIES answer is about 1 KB). */
const MAX_BODY = 64 * 1024

const escapeXml = (value: string): string => value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]!)
const unescapeXml = (value: string): string =>
  value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))).replace(/&amp;/g, '&')

export function checkVatApproxEnvelope(request: ViesRequest): string {
  const requester = request.requester
    ? `<urn:requesterCountryCode>${escapeXml(request.requester.countryCode)}</urn:requesterCountryCode><urn:requesterVatNumber>${escapeXml(request.requester.vatNumber)}</urn:requesterVatNumber>`
    : ''
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">' +
    '<soapenv:Header/><soapenv:Body><urn:checkVatApprox>' +
    `<urn:countryCode>${escapeXml(request.countryCode)}</urn:countryCode><urn:vatNumber>${escapeXml(request.vatNumber)}</urn:vatNumber>${requester}` +
    '</urn:checkVatApprox></soapenv:Body></soapenv:Envelope>'
  )
}

const tag = (xml: string, name: string): string | null => {
  const match = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml)
  return match ? unescapeXml(match[1]!.trim()) : null
}
/** VIES writes "---" for a field the member state does not give. */
const field = (xml: string, name: string): string | null => {
  const value = tag(xml, name)?.replace(/\s+/g, ' ').trim() ?? null
  return value === null || value === '' || value === '---' ? null : value
}

export type ParsedViesBody = { readonly kind: 'answer'; readonly answer: Omit<ViesAnswer, 'responseSha256'> } | { readonly kind: 'fault'; readonly code: string } | { readonly kind: 'unreadable' }

/** Reads a checkVatApprox answer or a SOAP fault. */
export function parseCheckVatApprox(xml: string): ParsedViesBody {
  const fault = tag(xml, 'faultstring')
  if (fault !== null) return { kind: 'fault', code: fault.trim() }
  const valid = tag(xml, 'valid')?.toLowerCase()
  if (valid !== 'true' && valid !== 'false') return { kind: 'unreadable' }
  const street = field(xml, 'traderStreet')
  const place = [field(xml, 'traderPostcode'), field(xml, 'traderCity')].filter((part) => part !== null).join(' ')
  const address = field(xml, 'traderAddress') ?? ([street, place].filter((part) => part !== null && part !== '').join(', ') || null)
  return {
    kind: 'answer',
    answer: {
      result: valid === 'true' ? 'VALID' : 'INVALID',
      requestDate: field(xml, 'requestDate'),
      consultationNumber: field(xml, 'requestIdentifier'),
      traderName: field(xml, 'traderName'),
      traderAddress: address,
    },
  }
}

export interface ViesSoapOptions {
  /** The HTTP transport; default the global fetch. */
  readonly fetch?: typeof fetch
  readonly endpoints?: { readonly LIVE: string; readonly SANDBOX: string }
}

export function viesSoapAdapter(options: ViesSoapOptions = {}): ViesAdapter {
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const endpoints = options.endpoints ?? VIES_ENDPOINTS
  return Object.freeze({
    async check(call: GatewayCall, request: ViesRequest): Promise<ViesAnswer> {
      if (call.account.mode === 'FAKE') throw new ProviderError('A FAKE account uses the fake VIES, never the real one.', { retryable: false })
      const endpoint = call.account.mode === 'LIVE' ? endpoints.LIVE : endpoints.SANDBOX
      const response = await send(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: '' },
        body: checkVatApproxEnvelope(request),
        signal: call.signal,
      })
      const body = (await response.text()).slice(0, MAX_BODY)
      const responseSha256 = createHash('sha256').update(body).digest('hex')
      const parsed = parseCheckVatApprox(body)
      if (parsed.kind === 'fault') {
        call.answer({ httpStatus: response.status, response: { fault: parsed.code } })
        throw new ViesFault(parsed.code, { httpStatus: response.status, responseSha256 })
      }
      if (parsed.kind === 'unreadable') {
        call.answer({ httpStatus: response.status })
        throw new ProviderError(`VIES answered HTTP ${response.status} without a result.`, { httpStatus: response.status, retryable: response.status >= 500 || response.status === 429 })
      }
      call.answer({ httpStatus: response.status, response: { valid: parsed.answer.result === 'VALID', identified: parsed.answer.consultationNumber !== null } })
      return { ...parsed.answer, responseSha256 }
    },
  } satisfies ViesAdapter)
}
