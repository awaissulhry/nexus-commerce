import type { SdiMessage } from '../../ports/sdi'

/**
 * E-invoice test mode per company (B-W2b-401; FIN-096; design finance.settings "E-invoicing (SDI)": "Test mode: simulated SDI
 * answers before going live; banner on every invoice page while on", pop-up "Leave e-invoice test mode?"; factory-db tax.prisma
 * CompanyEInvoiceSettings, no row: test mode). SDI has no sandbox, so while a company is in test mode nothing it sends leaves
 * the process: a send through its real intermediary's connection (LIVE or SANDBOX) is answered in-process with the outcome
 * the company chose to practise (`simulateOutcome`), through the same recording path as SDI's own answers. A FAKE connection
 * (local and test only) is a simulation already: its fake intermediary answers, test mode or not.
 *
 * A simulated send is marked for good by its provider id (`TEST-MODE:<outcome>:<send id>`): its status, its answer and its
 * archive are always the simulation's, even after the company goes live, and no courtesy copy is e-mailed for it. Pure: the
 * API's simulator (modules/invoicing/test-mode) and the SDI runtime read these rules.
 */

export const SIMULATED_OUTCOMES = ['DELIVERED', 'REJECTED', 'NOT_DELIVERABLE'] as const
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number]

export const TEST_REF_PREFIX = 'TEST-MODE:'

/** The provider id of a simulated send: its outcome and the send's id (never a real intermediary's). */
export const testRefOf = (submissionId: string, outcome: SimulatedOutcome): string => `${TEST_REF_PREFIX}${outcome}:${submissionId}`

/** Whether a send's provider id is a simulated one (test mode). */
export const isTestRef = (providerRef: string | null | undefined): providerRef is string => typeof providerRef === 'string' && providerRef.startsWith(TEST_REF_PREFIX)

/** The outcome and the send of a simulated provider id, or null. */
export function testRefParts(providerRef: string | null | undefined): { readonly outcome: SimulatedOutcome; readonly submissionId: string } | null {
  if (!isTestRef(providerRef)) return null
  const [outcome, submissionId] = providerRef.slice(TEST_REF_PREFIX.length).split(':')
  if (!outcome || !submissionId || !(SIMULATED_OUTCOMES as readonly string[]).includes(outcome)) return null
  return { outcome: outcome as SimulatedOutcome, submissionId }
}

/** The error a simulated rejection carries (SDI's code 00423, a total not computed by the rules), marked as simulated. */
export const SIMULATED_ERROR = Object.freeze({ code: '00423', description: '[TEST] 2.2.1.11 <PrezzoTotale> non calcolato secondo le regole definite nelle specifiche tecniche (scarto simulato)', hint: null })

/** What each outcome practises, in words. A simulated rejection is for the first send only: the corrected resend is delivered. */
export const SIMULATED_OUTCOME_WORDS: Readonly<Record<SimulatedOutcome, string>> = Object.freeze({
  DELIVERED: 'Delivered: every send is answered as delivered to the customer (RC).',
  REJECTED: 'Rejected: the first send of each invoice is answered as rejected (NS 00423), so the office practises the correction under the same number and date; the corrected resend is delivered.',
  NOT_DELIVERABLE: "Not deliverable: every send is answered as not deliverable (MC): the invoice is issued and waits in the customer's tax drawer. In test mode no courtesy copy is e-mailed.",
})

/**
 * SDI's simulated answer to a simulated send: one notification, one second after the provider took the file, with a stable
 * message id (the answer is recorded once whichever path brings it: the worker's handler right away, or the status poll).
 */
export function simulatedMessages(input: { readonly providerRef: string; readonly fileName: string; readonly attempt: number; readonly acceptedAt: string }): SdiMessage[] {
  const parts = testRefParts(input.providerRef)
  if (!parts) return []
  const type = parts.outcome === 'NOT_DELIVERABLE' ? 'MC' : parts.outcome === 'REJECTED' && input.attempt === 1 ? 'NS' : 'RC'
  const issuedAt = new Date(Date.parse(input.acceptedAt) + 1000).toISOString()
  return [
    {
      type,
      messageId: `TEST-MODE-${type}-${parts.submissionId}`,
      sdiIdentifier: `TEST-${parts.submissionId.replace(/-/g, '').slice(0, 12).toUpperCase()}`,
      providerRef: input.providerRef,
      fileName: input.fileName,
      issuedAt,
      errors: type === 'NS' ? [SIMULATED_ERROR] : [],
      outcome: null,
      note: 'Simulated in test mode: this file never reached SDI.',
    },
  ]
}

/** The connection modes test mode answers in-process (a FAKE connection answers by itself). */
export const SIMULATED_MODES = ['LIVE', 'SANDBOX'] as const

export interface TestModeFacts {
  readonly testMode: boolean
  readonly liveSince: string | null
  readonly simulateOutcome: SimulatedOutcome
  /** The company's one SDI connection, or null (none, or several). */
  readonly connection: { readonly mode: string; readonly status: string } | null
}

export interface TestModeState {
  readonly code: 'TEST' | 'LIVE'
  /** The banner every invoice page shows while the company is in test mode (null when live). */
  readonly banner: string | null
  readonly words: string
  /** True when its sends are answered in-process (test mode on a LIVE or SANDBOX connection). */
  readonly simulated: boolean
}

/** Where a company stands: test mode (the banner, who answers its sends) or live since when. */
export function testModeState(facts: TestModeFacts): TestModeState {
  if (!facts.testMode) {
    const fake = facts.connection?.mode === 'FAKE'
    return {
      code: 'LIVE',
      banner: null,
      words: `Live since ${facts.liveSince ?? 'an unknown time'}: invoices go to SDI through the intermediary and cannot be taken back.${fake ? ' This connection is FAKE (local and test only): the fake intermediary answers.' : ''}`,
      simulated: false,
    }
  }
  const simulated = facts.connection !== null && (SIMULATED_MODES as readonly string[]).includes(facts.connection.mode)
  const who =
    facts.connection === null
      ? 'No single SDI connection is set up yet: sends wait for one.'
      : simulated
        ? `Sends are answered here, never by the intermediary. ${SIMULATED_OUTCOME_WORDS[facts.simulateOutcome]}`
        : 'This connection is FAKE (local and test only): the fake intermediary answers, and nothing leaves the system.'
  return { code: 'TEST', banner: 'E-invoice test mode — nothing goes to SDI', words: `Test mode: nothing goes to SDI. ${who}`, simulated }
}

export const GO_LIVE_PROBLEMS = ['ALREADY_LIVE', 'NO_CONNECTION', 'SEVERAL_CONNECTIONS', 'CONNECTION_PAUSED', 'PROVIDER_NOT_CHOSEN'] as const
export type GoLiveProblem = (typeof GO_LIVE_PROBLEMS)[number]

const GO_LIVE_WORDS: Readonly<Record<GoLiveProblem, string>> = Object.freeze({
  ALREADY_LIVE: 'The company is live already.',
  NO_CONNECTION: 'The company has no SDI connection: an admin connects the intermediary first (Admin › Connections).',
  SEVERAL_CONNECTIONS: 'The company has more than one SDI connection: disable the ones not in use first.',
  CONNECTION_PAUSED: 'The SDI connection is paused: switch it on again first.',
  PROVIDER_NOT_CHOSEN: 'No SDI intermediary is chosen yet (Owner question Q21): live sending waits for it, so the company stays in test mode.',
})

/** What stops a company from leaving test mode, in words (empty: it may go live). */
export function goLiveProblems(input: { readonly testMode: boolean; readonly connections: readonly { readonly mode: string; readonly status: string }[]; readonly liveProviderReady: boolean }): { readonly code: GoLiveProblem; readonly message: string }[] {
  const problem = (code: GoLiveProblem) => ({ code, message: GO_LIVE_WORDS[code] })
  if (!input.testMode) return [problem('ALREADY_LIVE')]
  if (input.connections.length === 0) return [problem('NO_CONNECTION')]
  if (input.connections.length > 1) return [problem('SEVERAL_CONNECTIONS')]
  const [connection] = input.connections
  if (connection!.status === 'PAUSED') return [problem('CONNECTION_PAUSED')]
  if (connection!.mode !== 'FAKE' && !input.liveProviderReady) return [problem('PROVIDER_NOT_CHOSEN')]
  return []
}

/**
 * What the office must know before it goes live (shown in the "Leave e-invoice test mode?" pop-up). UNVERIFIED (GATE-ACCOUNTANT):
 * what happens to the numbers that invoices issued in test mode took.
 */
export function goLiveWords(testIssued: number): string {
  const issued =
    testIssued === 0
      ? 'No invoice was sent in test mode.'
      : `${testIssued} invoice(s) were sent in test mode: they never reached SDI and keep their numbers; ask your accountant what to do with them before going live (UNVERIFIED).`
  return `From now on invoices go to SDI for real and cannot be taken back. ${issued}`
}
