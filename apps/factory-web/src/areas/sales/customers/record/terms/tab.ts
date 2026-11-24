import type { Party, ViesCheck } from '../../../../parties/_shared/api'
import type { Loaded } from '../../../../parties/_shared/model'
import type { PriceListRow } from '../../../pricelists/api'
import type { PaymentTermsRow } from '../../terms/api'
import type { CompanyTerms, Holds, RequirementKind, Requirements } from '../../depth/api'
import type { Read } from '../../depth/model'
import type { CarrierAccount } from './api'
import { identityFactsOf, termsAnswer, type TermsAnswer, type TermsChipId } from './answer'
import { commercialSection, isBlank, isMulti, type CommercialSectionModel, type CompanyTermsReadEntry, type OwnTermsRead } from './commercial'
import { holdSection, type HoldFacts, type HoldSectionModel } from './holds'
import { companyOf, termsInForce } from './in-force'
import type { Said, TermsCan } from './model'
import { endLines, type TermsTabWindow } from './windows'
import { requirementsSection, type RequirementRow, type RequirementsSectionModel } from './requirements' // F-CT-504 (W2.1)
import { identitySection, type IdentitySectionModel } from './identity' // F-CT-515 (W2.2)

/**
 * F-CT-205 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 13-backend §6.2 `termsTabModel`) — the tab's ONE model, pure: the reads
 * the container holds (the party, the customer's own terms R1, its carrier block R19, the depth provider's holds, company terms and
 * requirements, the windows' choices) and the tab's own state (the chip pressed, the folds, the window open) become what the view draws.
 * The container builds it on the page; a design case builds it from made-up reads — one rule for both.
 */

export interface TermsTabReads {
  readonly party: Party
  readonly prefix: string
  readonly can: TermsCan
  readonly locale: 'en' | 'it'
  /** ISO now (VIES's days left). */
  readonly now: string
  /** The company the reader works in (the session's). */
  readonly companyId: string | null
  /** Our companies' names by id (the session's), for the holds and the waiting quotes. */
  readonly companyNames: Readonly<Record<string, string>>
  /** R1, the customer's own terms; null: not asked yet. */
  readonly commercial: Read<OwnTermsRead> | null
  /** R19, the carrier block. */
  readonly carrier: Read<CarrierAccount> | null
  /** The depth provider's ONE reads (held for Money and the Overview too). */
  readonly holds: Read<Holds> | null
  readonly companies: Read<CompanyTerms> | null
  readonly requirements: Read<Requirements> | null
  /** The windows' choices: the payment-terms library (paymentterms.view), the price lists (pricelists.view); null: not read. */
  readonly library: Read<readonly PaymentTermsRow[]> | null
  readonly lists: Read<readonly PriceListRow[]> | null
  // F-CT-515 (ct-w2 W2.2): the record's VIES checks (the 50 newest, then each next page) and whether a check runs.
  readonly history: Loaded<ViesCheck>
  readonly viesRunning: boolean
}

export interface TermsTabState {
  readonly chip: TermsChipId | null
  readonly releasedOpen: boolean
  readonly endedOpen: boolean
  readonly window: TermsTabWindow | null
  // F-CT-504 (ct-w2 W2.1): Requirements — the kind chip pressed, "Show n more", the ended and replaced rules folded.
  readonly kind: RequirementKind | null
  readonly moreRequirements: boolean
  readonly requirementsEndedOpen: boolean
  // F-CT-515 (ct-w2 W2.2): Tax identity & e-invoice — the earlier and the later identities, every VIES check, folded.
  readonly earlierOpen: boolean
  readonly laterOpen: boolean
  readonly checksOpen: boolean
}
export const TERMS_TAB_START: TermsTabState = { chip: null, releasedOpen: false, endedOpen: false, window: null, kind: null, moreRequirements: false, requirementsEndedOpen: false, earlierOpen: false, laterOpen: false, checksOpen: false }

/** What the four NEW windows draw (the one open; its reads). */
export interface TermsWindowsModel {
  readonly window: TermsTabWindow | null
  readonly customer: string
  readonly can: TermsCan
  readonly own: OwnTermsRead | null
  readonly carrier: CarrierAccount | null
  /** The company the company window or Back… is for. */
  readonly entry: CompanyTermsReadEntry | null
  /** The companies whose own payment terms or deposit stay when the customer's change (Change terms…'s note). */
  readonly ownTermsWith: readonly string[]
  /** Back to the customer's terms…: what it changes. */
  readonly endLines: ReadonlyArray<{ readonly tone: 'info' | 'warning'; readonly words: Said }>
  readonly library: Read<readonly PaymentTermsRow[]> | null
  readonly lists: Read<readonly PriceListRow[]> | null
}

export interface TermsTabModel {
  readonly partyId: string
  readonly name: string
  readonly prefix: string
  readonly can: TermsCan
  /** An archived customer: every act is held with its words. */
  readonly archived: boolean
  /** "You can view, not change" is the record's ONE notice (never said here). */
  readonly editable: boolean
  readonly answer: TermsAnswer
  /** The answer line is still read (its skeleton). */
  readonly answerReading: boolean
  readonly chip: TermsChipId | null
  /** The rows the pressed chip marks (their addresses). */
  readonly marked: readonly string[]
  readonly hold: HoldSectionModel
  readonly commercial: CommercialSectionModel
  readonly requirements: RequirementsSectionModel // F-CT-504 (W2.1)
  readonly identity: IdentitySectionModel // F-CT-515 (W2.2)
  readonly windows: TermsWindowsModel
}

const value = <T>(read: Read<T> | null): T | null => (read?.status === 'ready' ? read.value : null)

/** The tab's model from its reads and its state. */
export function termsTabModel(reads: TermsTabReads, state: TermsTabState): TermsTabModel {
  const { party, can, prefix, locale } = reads
  const archived = party.status === 'ARCHIVED'
  const name = party.tradeName ?? party.legalName
  const own = value(reads.commercial)
  const companies = value(reads.companies)
  const carrier = value(reads.carrier)
  const hasIdentity = party.taxIdentities.some((row) => row.current)
  const names: Record<string, string> = { ...reads.companyNames }
  for (const entry of companies?.companies ?? []) names[entry.company.id] = entry.company.name
  const hold = holdSection({ read: reads.holds, can, archived, hasIdentity, customer: name, companyNames: names, prefix, partyId: party.id, releasedOpen: state.releasedOpen })
  const commercial = commercialSection({
    commercial: reads.commercial,
    companies: reads.companies,
    carrier: reads.carrier,
    companyId: reads.companyId,
    typed: party.paymentTerms,
    can,
    archived,
    prefix,
    partyId: party.id,
    poWaiting: hold.waiting.po,
    poWaitingCount: hold.waiting.counts?.po ?? 0,
    endedOpen: state.endedOpen,
    locale,
  })
  const multi = isMulti(companies)
  const current = companyOf(companies, reads.companyId)
  const requirements = value(reads.requirements)
  const answer = termsAnswer({
    multi,
    company: current?.company.name ?? (reads.companyId ? (names[reads.companyId] ?? null) : null),
    inForce: own ? termsInForce({ commercial: own, companies, companyId: reads.companyId, typed: party.paymentTerms }, locale) : null,
    companiesFailed: reads.companies?.status === 'error',
    blank: isBlank(own, companies, carrier, party.paymentTerms),
    holds: hold.inForce,
    waiting: hold.waiting,
    requirements: requirements ? requirements.inForce.length : null,
    identity: identityFactsOf(party),
    now: reads.now,
  })
  const pressed = state.chip ? (answer.chips.find((chip) => chip.id === state.chip) ?? null) : null
  const window = state.window
  const windowEntry = window && (window.kind === 'company' || window.kind === 'end') ? ((companies?.companies.find((entry) => entry.company.id === window.companyId) as CompanyTermsReadEntry | undefined) ?? null) : null
  return {
    partyId: party.id,
    name,
    prefix,
    can,
    archived,
    editable: can.manage && !archived,
    answer,
    // ct-fx3 G-W01 (walk W-01; P0-B4, Z32): the terms per company in flight are reading too — never the customer's own as if in force.
    answerReading: reads.commercial === null || reads.commercial.status === 'loading' || reads.companies === null || reads.companies.status === 'loading',
    chip: pressed ? pressed.id : null,
    marked: pressed ? pressed.rows : [],
    hold,
    commercial,
    requirements: requirementsSection({ read: reads.requirements, can, archived, companyNames: names, kind: state.kind, more: state.moreRequirements, endedOpen: state.requirementsEndedOpen }), // F-CT-504
    identity: identitySection({ party, can, history: reads.history, viesRunning: reads.viesRunning, now: reads.now, earlierOpen: state.earlierOpen, laterOpen: state.laterOpen, checksOpen: state.checksOpen }), // F-CT-515
    windows: {
      window,
      customer: name,
      can,
      own,
      carrier,
      entry: windowEntry,
      ownTermsWith: multi ? (companies?.companies ?? []).filter((entry) => entry.terms !== null && (entry.terms.paymentTermsId !== null || entry.terms.paymentTermsText !== null || entry.terms.depositPct !== null)).map((entry) => entry.company.name) : [],
      endLines: window?.kind === 'end' && windowEntry ? endLines(windowEntry, own, locale) : [],
      library: reads.library,
      lists: reads.lists,
    },
  }
}

/** A result of the tab's own acts (a window saved, a copy), for the record's ONE notice area. */
export interface TermsNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly words: Said
}

/** What the view asks of its container (each act through its owner's window or command; the hold acts through the depth's window). */
export interface TermsTabActions {
  /** A chip pressed (null: pressed again, the mark leaves); a door chip leaves the tab. */
  readonly onChip?: (chip: TermsChipId | null) => void
  readonly onFold?: (fold: 'released' | 'ended' | 'requirementsEnded' | 'earlier' | 'later' | 'checks', open: boolean) => void
  /** Put on hold… / Put on hold for another reason… — the depth provider's own window (HoldDialogView). */
  readonly onPlaceHold?: () => void
  readonly onReleaseHold?: (hold: HoldFacts) => void
  readonly onRetryHolds?: () => void
  readonly onRetryTerms?: () => void
  readonly onRetryCompanies?: () => void
  readonly onRetryCarrier?: () => void
  /** The four NEW windows. */
  readonly onChangeTerms?: () => void
  readonly onChangeDelivery?: () => void
  /** Set terms for {company}… (two or more of our companies) / Customer PO number… (one: the PO switch only). */
  readonly onCompanyTerms?: (companyId: string) => void
  readonly onBackToCustomer?: (companyId: string) => void
  readonly onWindowDraft?: (window: TermsTabWindow) => void
  readonly onWindowConfirm?: () => void
  readonly onWindowClose?: () => void
  readonly onRetryChoices?: () => void
  /** Copy a link to a section or a row (its address). */
  readonly onCopyLink?: (anchor: string) => void
  // ---- F-CT-504 (ct-w2 W2.1): Requirements — the depth provider's own windows (RequirementWindows), the kind chips, a file's door
  readonly onAddRequirement?: () => void
  readonly onReplaceRequirement?: (row: RequirementRow) => void
  readonly onEndRequirement?: (row: RequirementRow) => void
  readonly onKind?: (kind: RequirementKind | null) => void
  readonly onMoreRequirements?: (more: boolean) => void
  readonly onRetryRequirements?: () => void
  /** Open a requirement's file (files.read: its preview link, read on the click). */
  readonly onOpenFile?: (fileId: string) => void
  /** Copy a rule's words. */
  readonly onCopyWords?: (words: string) => void
  // ---- F-CT-515 (ct-w2 W2.2): Tax identity & e-invoice — the record's own identity window and its VIES act, the checks' next page
  readonly onCorrectIdentity?: () => void
  readonly onNewIdentity?: () => void
  readonly onCheckVies?: () => void
  readonly onMoreChecks?: () => void
  /** ct-fx3 G-W08 (walk W-08): the VIES checks read again after it failed. */
  readonly onRetryChecks?: () => void
}
