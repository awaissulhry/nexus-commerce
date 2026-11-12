import type { PortalBank, PortalBankAccount } from './api'

/**
 * Made-up bank details of the invented tannery Conceria Prova S.p.A. for the design cases of SCR-191 (B-W2b-334): test
 * IBANs only (IT, ABI and CAB 00000), masked as the API serves them. Nothing here is a real bank, account or person.
 * Design-only (it exports no `designScreen`).
 */

const uid = (n: number) => `0190f0e2-7777-7000-8000-${String(900 + n).padStart(12, '0')}`
const account = (n: number, over: Partial<PortalBankAccount>): PortalBankAccount => ({
  id: uid(n),
  masked: 'IT** **** **** 3456',
  bankName: 'Banca Esempio',
  holder: 'Conceria Prova S.p.A.',
  currency: 'EUR',
  state: 'USABLE',
  proposedAt: '2026-03-01T09:00:00.000Z',
  activatedAt: '2026-03-03T15:00:00.000Z',
  refusedAt: null,
  reason: null,
  retiredAt: null,
  ...over,
})

export const IN_USE = account(1, {})
export const WAITING = account(2, { masked: 'IT** **** **** 5001', bankName: 'Banca Prova', state: 'WAITING', proposedAt: '2026-11-10T16:20:00.000Z', activatedAt: null })
export const REFUSED = account(3, { masked: 'IT** **** **** 8800', state: 'REFUSED', proposedAt: '2026-06-01T09:00:00.000Z', activatedAt: null, refusedAt: '2026-06-02T11:00:00.000Z', reason: 'Il numero richiamato non ha confermato il cambio.' })

export const bankOf = (accounts: readonly PortalBankAccount[], over: Partial<PortalBank> = {}): PortalBank => ({ accounts: [...accounts], mayPropose: true, live: { events: ['supplier_bank_account.activated'] }, ...over })

/** A made-up Italian test IBAN as a supplier types it (ABI and CAB 00000, right check digits). */
export const TYPED = 'IT11 X000 0000 0000 0000 0315 001'
