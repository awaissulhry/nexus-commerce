import type { CompanyEInvoicing, GoLiveProblem, Readiness, SimulatedOutcome } from './api'
import type { Phrase } from '../../_shared/model'

/**
 * Test mode in words (B-W2b-417 on B-W2b-401's API; design finance.invoices page.h "test mode banner", finance.settings
 * sec:sdi "Test mode" and pop:live): which companies show the banner, who answers their sends, what holds going live, the
 * simulated answer's words and the swap readiness — every phrase from codes and figures (`finance-invoices-depth`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** Who answers a company's sends while it is in test mode. */
export type Answerer = 'SIMULATED' | 'FAKE' | 'NONE'

export interface BannerCompany {
  companyId: string
  legalName: string
  answerer: Answerer
  outcome: SimulatedOutcome
}

/** The test-mode banner's model: the companies in test mode (none: no banner), named when the person sees several. */
export interface TestModeBannerModel {
  testing: BannerCompany[]
  /** The person sees more than one company: each one in test mode is named. */
  named: boolean
}

export const answererOf = (company: Pick<CompanyEInvoicing, 'state' | 'connection'>): Answerer => (company.state.simulated ? 'SIMULATED' : company.connection.accounts.length === 1 ? 'FAKE' : 'NONE')

/** The banner of every invoice page (null state = live): the companies the page may show that are in test mode. */
export function bannerOf(companies: readonly CompanyEInvoicing[], companyId: string | null = null): TestModeBannerModel {
  const shown = companyId ? companies.filter((company) => company.companyId === companyId) : companies
  return {
    testing: shown.filter((company) => company.state.code === 'TEST').map((company) => ({ companyId: company.companyId, legalName: company.legalName, answerer: answererOf(company), outcome: company.simulateOutcome })),
    named: shown.length > 1,
  }
}

/** The words of who answers (the banner's line under its title, the settings card). */
export function answerWords(company: Pick<BannerCompany, 'answerer' | 'outcome'>): Phrase {
  if (company.answerer === 'SIMULATED') return phrase(`testMode.answer.SIMULATED.${company.outcome}`)
  return phrase(`testMode.answer.${company.answerer}`)
}

/** Why going live is held, in words (the toggle's held reason and the pop-up), or null when it may go live. */
export function goLiveHeld(company: Pick<CompanyEInvoicing, 'goLive' | 'can'>, busy = false): Phrase | null {
  if (!company.can.manage) return phrase('held.noTestMode')
  if (busy) return phrase('held.busy')
  const first = company.goLive.problems[0]?.code
  return first ? phrase(`goLive.problem.${first}`) : null
}

/** The go-live problems (every one) as phrases, for the card. */
export const goLiveProblems = (problems: ReadonlyArray<{ code: GoLiveProblem }>): Phrase[] => problems.map((problem) => phrase(`goLive.problem.${problem.code}`))

/** What the "Leave e-invoice test mode?" pop-up lists: from now on for real, what happened to the test sends. */
export function goLiveConsequences(testSent: number): Phrase[] {
  return [phrase('live.forReal'), testSent === 0 ? phrase('live.noTestSends') : phrase('live.testSends', { count: testSent })]
}

/** The swap readiness in words: ready, or what is missing and what still waits for SDI's answer. */
export function readinessWords(readiness: Readiness): Phrase[] {
  if (readiness.ready) return [phrase('swap.ready', { count: readiness.copied })]
  const words: Phrase[] = []
  if (readiness.missing > 0) words.push(phrase('swap.missing', { count: readiness.missing }))
  if (readiness.open > 0) words.push(phrase('swap.open', { count: readiness.open }))
  if (words.length === 0) words.push(phrase('swap.nothing'))
  return words
}

/** Why "Make the copies" is held: the right, nothing missing, busy. */
export function makeCopiesHeld(readiness: Readiness | null, canIssue: boolean, busy: boolean): Phrase | null {
  if (!canIssue) return phrase('held.noIssue')
  if (busy) return phrase('held.busy')
  if (readiness && readiness.missing === 0) return phrase('held.noneMissing')
  return null
}
