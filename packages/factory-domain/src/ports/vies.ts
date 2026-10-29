/**
 * The VIES port (plan A1 §4; PLAN R-16: B-W1-07 owns this file; features SAL-006, SCM-003): one check of an EU VAT
 * number against the European Commission's VIES, the proof a zero-rated intra-EU sale needs (art. 41 DL 331/1993: a
 * valid VAT number of the buyer is a substantive condition). The adapters live in apps/factory-api/src/adapters/vies/
 * (the SOAP service checkVatApprox for LIVE and SANDBOX accounts, the FAKE for local and test); every call runs inside
 * ONE gateway call (operation `vies.check_vat`, idempotent: a check is a read), so it is rate limited, circuit broken
 * and recorded as one IntegrationCall row. The parties module writes the answer as a ViesCheck row (append-only).
 *
 * A check is identified when it names the requester (our company's VAT number): only then does VIES give the
 * consultation number (requestIdentifier) that proves the answer. Pure types and constants: no I/O.
 */

export const VIES_CHECK_OPERATION = Object.freeze({ name: 'vies.check_vat', idempotent: true })

export interface ViesRequest {
  /** The member-state code VIES uses: the VAT prefix (EL for Greece). */
  readonly countryCode: string
  /** The number without the member-state code. */
  readonly vatNumber: string
  /** Our company, for an identified check (a consultation number); null for an anonymous one. */
  readonly requester: { readonly countryCode: string; readonly vatNumber: string } | null
}

/** VIES answered: the number is registered for intra-EU trade (VALID) or it is not (INVALID). */
export interface ViesAnswer {
  readonly result: 'VALID' | 'INVALID'
  /** The day VIES answered for, as it wrote it (YYYY-MM-DD…); null when absent. */
  readonly requestDate: string | null
  /** requestIdentifier: the consultation number, the proof. Null when VIES gave none (an anonymous check). */
  readonly consultationNumber: string | null
  /** The name and address VIES returned; null when the member state does not give them ("---"). */
  readonly traderName: string | null
  readonly traderAddress: string | null
  /** SHA-256 (hex) of the raw response body as received. */
  readonly responseSha256: string | null
}

/**
 * The faults VIES answers instead of a result (its WSDL's documented faultstrings). `retryable`: a later try may pass
 * (the gateway retries those, then the check is recorded as ERROR: neither proof nor refusal).
 */
export const VIES_FAULTS = Object.freeze({
  INVALID_INPUT: { retryable: false, meaning: 'VIES refused the number or the country code as not well formed.' },
  INVALID_REQUESTER_INFO: { retryable: false, meaning: "VIES refused our company's VAT number as the requester." },
  SERVICE_UNAVAILABLE: { retryable: true, meaning: 'VIES is not available.' },
  MS_UNAVAILABLE: { retryable: true, meaning: "The member state's register does not answer VIES right now." },
  TIMEOUT: { retryable: true, meaning: "The member state's register did not answer VIES in time." },
  VAT_BLOCKED: { retryable: false, meaning: 'VIES blocks checks of this number.' },
  IP_BLOCKED: { retryable: false, meaning: 'VIES blocks checks from our address.' },
  GLOBAL_MAX_CONCURRENT_REQ: { retryable: true, meaning: 'VIES is busy (too many requests at once).' },
  GLOBAL_MAX_CONCURRENT_REQ_TIME: { retryable: true, meaning: 'VIES is busy (too many requests).' },
  MS_MAX_CONCURRENT_REQ: { retryable: true, meaning: "The member state's register is busy." },
  MS_MAX_CONCURRENT_REQ_TIME: { retryable: true, meaning: "The member state's register is busy." },
} as const)
export type ViesFaultCode = keyof typeof VIES_FAULTS

export const isViesFaultCode = (value: string): value is ViesFaultCode => Object.hasOwn(VIES_FAULTS, value)

/**
 * Why a check gave no answer, as a ViesCheck row's `errorCode`: a VIES fault (above), or the gateway's: a refusal before
 * anything was sent (GATEWAY_<reason>: account paused, circuit open, rate limited …), a timeout or a network failure.
 */
export function viesErrorMeaning(code: string): string {
  if (isViesFaultCode(code)) return VIES_FAULTS[code].meaning
  if (code === 'NETWORK_ERROR') return 'VIES could not be reached.'
  if (code === 'CALL_TIMEOUT') return 'VIES did not answer in time.'
  if (code.startsWith('GATEWAY_')) return 'The check was not sent: the VIES connection is paused, busy or failing (Connections page).'
  return 'VIES gave no answer.'
}
