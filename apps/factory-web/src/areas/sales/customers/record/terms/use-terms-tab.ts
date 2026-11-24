'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import type { Party } from '../../../../parties/_shared/api'
import type { PartyRecordModel } from '../../../../parties/_shared/model'
import type { PartyRecordActions } from '../../../../parties/_shared/view/PartyRecordView' // F-CT-516 (W2.2): the record's own identity window and VIES act
import { readProblem } from '../../../orders/model'
import { copyLinkTo } from '../../../orders/record/shipments/view/hrefs'
import { storeUrl } from '../../../../../record-panels/store' // ct-fx3 G-W03: the file door's address, as Work and the order page open it
import { listPriceLists, type PriceListRow } from '../../../pricelists/api'
import type { CompanyTerms, Holds, Requirements } from '../../depth/api'
import { failedRead, LOADING, ready, type Notice, type Read } from '../../depth/model'
import type { HoldCardActions, HoldCardModel } from '../../depth/view/HoldCard'
import type { RequirementsActions, RequirementsModel } from '../../depth/view/RequirementsTab' // F-CT-505 (W2.1)
import { getCommercialTerms, listPaymentTerms, updateCommercialTerms, type CommercialTerms, type PaymentTermsRow } from '../../terms/api'
import { termsAbilitiesOf } from '../../terms/model'
import { endCompanyTerms, fileDoor, readCarrierAccount, setCarrierAccount, setCompanyTerms, type CarrierAccount } from './api'
import { TERMS_SECTIONS, said, termsCan, type TermsSectionId } from './model'
import { TERMS_TAB_START, termsTabModel, type TermsNotice, type TermsTabActions, type TermsTabModel, type TermsTabState } from './tab'
import {
  companyBody,
  companyEndWindowOf,
  companyProblems,
  companyRefusal,
  companyWindowOf,
  deliveryBody,
  deliveryProblems,
  deliveryRefusal,
  deliverySaved,
  deliveryWindowOf,
  endRefusal,
  termsRefusal,
  termsWindowOf,
  termsWindowPatch,
  termsWindowProblems,
  type TermsTabWindow,
} from './windows'

/**
 * F-CT-206 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 13-backend §1.2, §1.3, §3, §6.1; 18-lead-settles Z2, Z5, Z8, Z24–Z27) —
 * the tab's container. Built by the record on every tab (like Work, Quotes and People), it reads ONLY while Terms & requirements is
 * shown (`enabled`): the customer's own terms (R1, moved here from cu/terms/CommercialTerms.tsx — read again only when the party's
 * version moved past the one it answered: never after its own PATCH, whose answer IS the new version) and its carrier block (R19, the
 * same rule). The holds, the terms per company and the requirements are the depth provider's ONE reads (handed in: Money and the
 * Overview read them too); the hold window is the provider's own (HoldDialogView, the one Money opens), mounted as it is.
 * The four NEW windows (Change terms… · Change delivery… · Set terms for {company}… / Customer PO number… · Back to the customer's
 * terms…) keep their drafts here; each Save is ONE command at the version read, with the Idempotency-Key of its attempt; a 409 reads
 * again and says someone else changed it. The arrival: `#<section>` (or the record's old-address anchor) comes into view once the
 * reads above it have answered. Every result lands in the record's ONE notice area (`notices`).
 */

/** What the depth provider hands the tab (W1.4's `useCustomerTerms()`): its ONE reads, its hold window, the notice of its acts here. */
export interface TermsDepth {
  readonly holds: Read<Holds>
  readonly companyTerms: Read<CompanyTerms>
  readonly requirements: Read<Requirements>
  /** The hold window — the provider's ONE state, shared with Money: mounted as it is. */
  readonly hold: { readonly model: HoldCardModel; readonly actions: HoldCardActions }
  /** F-CT-505 (W2.1): the requirement windows (Add · Replace with a new version… · End…) — the provider's ONE state, mounted as they are. */
  readonly requirementsWindow: { readonly model: RequirementsModel; readonly actions: RequirementsActions }
  /** A company-terms write answered (R5, R6): the provider keeps the fresh read (no second read). */
  readonly onCompanyTerms: (answer: CompanyTerms) => void
  readonly onRetryHolds: () => void
  readonly onRetryCompanyTerms: () => void
  readonly onRetryRequirements: () => void
  /** Z5: the notice of the hold and requirement acts made on THIS tab (`termsNotice`; People's notice is privacy's only). */
  readonly notice: Notice
  readonly onDismissNotice: () => void
}

export interface TermsTabInput {
  readonly partyId: string
  readonly party: Party | null | undefined
  readonly model: PartyRecordModel
  /** Read the party again (after a terms or carrier save: their version moved; on a 409). */
  readonly reload: () => void
  /** F-CT-516 (W2.2): the record's own acts — Correct… / New identity from a date… (its identity window), Check VIES. */
  readonly actions?: PartyRecordActions | undefined
  /** F-CT-516 (W2.2; Z7): the record's VIES checks, the next page by the server's cursor. */
  readonly moreHistory?: (() => void) | undefined
  /** The depth provider's part; null: not handed (the sections then read). */
  readonly depth: TermsDepth | null
  /** Terms & requirements is the tab shown: only then does the tab read. */
  readonly enabled: boolean
}

/** The tab's notices for the record's ONE notice area. */
export interface TermsNotices {
  readonly own: TermsNotice | null
  readonly onDismissOwn?: () => void
  readonly depth: Notice
  readonly onDismissDepth?: () => void
}

export interface TermsTabContainer {
  /** What the view draws; null until the party is read (or while another tab shows). */
  readonly model: TermsTabModel | null
  readonly actions: TermsTabActions
  /** The depth provider's hold window (HoldDialogView), mounted by the view as it is; null: not handed. */
  readonly hold: TermsDepth['hold'] | null
  /** F-CT-505: the provider's requirement windows (RequirementWindows), mounted by the view as they are; null: not handed. */
  readonly requirementsWindow: TermsDepth['requirementsWindow'] | null
  readonly notices: TermsNotices
}

/** The reads each section waits for before an address below it lands (13-backend §6.1: the arrival after the reads above answered). */
const ABOVE: Readonly<Record<TermsSectionId, number>> = { 'party-hold': 1, 'party-commercial': 2, 'party-requirements': 4, 'party-identity': 5 }

export function useTermsTab(input: TermsTabInput): TermsTabContainer {
  const { partyId, party, reload, depth, enabled } = input
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const locale = useLocale()
  const can = useMemo(() => termsCan(session.permissions), [session.permissions])
  const abilities = useMemo(() => termsAbilitiesOf(session.permissions), [session.permissions])
  const on = enabled && !!party
  const [now] = useState(() => new Date().toISOString())
  const [state, setState] = useState<TermsTabState>(TERMS_TAB_START)
  const [notice, setNotice] = useState<TermsNotice | null>(null)
  const patch = (next: Partial<TermsTabState>) => setState((current) => ({ ...current, ...next }))
  const setWindow = (window: TermsTabWindow | null) => setState((current) => ({ ...current, window }))

  // ---- R1, the customer's own terms, and R19, its carrier block: read on Terms only; again only when the party's version moved past
  // the one they answered (a write here answers the new version itself: no second read)
  const [terms, setTerms] = useState<Read<CommercialTerms> | null>(null)
  const [carrier, setCarrier] = useState<Read<CarrierAccount> | null>(null)
  const loadTerms = useCallback(async () => {
    try {
      setTerms(ready(await getCommercialTerms(api, partyId)))
    } catch (error) {
      setTerms(failedRead(readProblem(error)))
    }
  }, [api, partyId])
  const loadCarrier = useCallback(async () => {
    try {
      setCarrier(ready(await readCarrierAccount(api, partyId)))
    } catch (error) {
      setCarrier(failedRead(readProblem(error)))
    }
  }, [api, partyId])
  const version = party?.version ?? null
  const termsVersion = terms?.status === 'ready' ? terms.value.version : null
  const carrierVersion = carrier?.status === 'ready' ? carrier.value.version : null
  useEffect(() => {
    if (!on || version === null) return
    if (termsVersion === null || termsVersion < version) {
      setTerms((current) => current ?? LOADING)
      void loadTerms()
    }
    if (carrierVersion === null || carrierVersion < version) {
      setCarrier((current) => current ?? LOADING)
      void loadCarrier()
    }
    // Read on arrival and when the party's version moves; never because its own answer arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, version, loadTerms, loadCarrier])

  // ---- the windows' choices: the payment-terms library of the company (paymentterms.view) and the price lists (pricelists.view),
  // read when a window that offers them opens, kept for the next one
  const [library, setLibrary] = useState<{ readonly companyId: string | null; readonly read: Read<readonly PaymentTermsRow[]> } | null>(null)
  const [lists, setLists] = useState<Read<readonly PriceListRow[]> | null>(null)
  const loadChoices = useCallback(
    (companyId: string | null, again = false) => {
      if (can.paymentTerms && (again || library === null || library.companyId !== companyId || library.read.status === 'error')) {
        setLibrary({ companyId, read: LOADING })
        listPaymentTerms(api, companyId)
          .then((rows) => setLibrary({ companyId, read: ready(rows) }))
          .catch((error: unknown) => setLibrary({ companyId, read: failedRead(readProblem(error)) }))
      }
      if (can.lists && (again || lists === null || lists.status === 'error')) {
        setLists(LOADING)
        listPriceLists(api, { companyId })
          .then((answer) => setLists(ready(answer.lists)))
          .catch((error: unknown) => setLists(failedRead(readProblem(error))))
      }
    },
    [api, can.lists, can.paymentTerms, library, lists],
  )

  const companiesRead = depth?.companyTerms ?? null
  const companies = companiesRead?.status === 'ready' ? companiesRead.value : null
  const entryOf = (companyId: string) => companies?.companies.find((entry) => entry.company.id === companyId) ?? null
  const customerCompany = party?.companyId ?? session.company?.id ?? null

  // ---- the windows' acts: ONE command each, at the version read, the Idempotency-Key of the attempt
  const confirm = async () => {
    const window = state.window
    if (!window || window.busy || !party) return
    const busy = <W extends TermsTabWindow>(open: W) => setWindow({ ...open, busy: true, tried: true, problem: null })
    if (window.kind === 'terms') {
      const own = terms?.status === 'ready' ? terms.value : null
      if (!own) return
      if (Object.keys(termsWindowProblems(window)).length > 0) return setWindow({ ...window, tried: true })
      const changes = termsWindowPatch(window, own, abilities)
      if (Object.keys(changes).length === 0) return setWindow(null)
      busy(window)
      try {
        // The party's version: the terms are its columns (a party changed meanwhile is a 409, never overwritten).
        setTerms(ready(await updateCommercialTerms(api, { partyId, version: party.version }, changes)))
        setWindow(null)
        setNotice({ tone: 'success', words: said('terms.saved') })
        reload()
      } catch (error) {
        setWindow({ ...window, busy: false, tried: true, problem: termsRefusal(error) })
        if (isApiError(error) && error.kind === 'conflict') {
          reload()
          void loadTerms()
        }
      }
      return
    }
    if (window.kind === 'delivery') {
      const account = carrier?.status === 'ready' ? carrier.value : null
      if (!account) return
      if (Object.keys(deliveryProblems(window, account)).length > 0) return setWindow({ ...window, tried: true })
      const body = deliveryBody(window, account)
      if (!body) return setWindow(null)
      busy(window)
      try {
        const answer = await setCarrierAccount(api, partyId, body, newIdempotencyKey())
        setCarrier(ready(answer.account))
        setWindow(null)
        setNotice({ tone: 'success', words: deliverySaved(answer.account, answer.endsIn) })
        reload() // the carrier columns are the party's: its version moved
      } catch (error) {
        const refused = deliveryRefusal(error)
        setWindow({ ...window, busy: false, tried: true, problem: refused.key, field: refused.field })
        if (isApiError(error) && error.kind === 'conflict') {
          reload()
          void loadCarrier()
        }
      }
      return
    }
    const entry = entryOf(window.companyId)
    if (!entry || !depth) return
    if (window.kind === 'company') {
      if (Object.keys(companyProblems(window, abilities)).length > 0) return setWindow({ ...window, tried: true })
      const body = companyBody(window, entry, abilities)
      if (!body) return setWindow(null)
      busy(window)
      try {
        depth.onCompanyTerms(await setCompanyTerms(api, partyId, window.companyId, body, newIdempotencyKey()))
        setWindow(null)
        // T1-B16: one PUT, one result — said for that company only.
        setNotice({ tone: 'success', words: said(window.poOnly ? 'ct.co.poSaved' : 'ct.co.saved', { params: { company: entry.company.name } }) })
      } catch (error) {
        setWindow({ ...window, busy: false, tried: true, problem: companyRefusal(error) })
        if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'not_found')) depth.onRetryCompanyTerms()
      }
      return
    }
    if (!entry.terms) return setWindow(null)
    busy(window)
    try {
      depth.onCompanyTerms(await endCompanyTerms(api, partyId, window.companyId, { version: entry.terms.version }, newIdempotencyKey()))
      setWindow(null)
      setNotice({ tone: 'success', words: said('ct.end.done', { params: { company: entry.company.name } }) })
    } catch (error) {
      setWindow({ ...window, busy: false, tried: true, problem: endRefusal(error) })
      if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'not_found')) depth.onRetryCompanyTerms()
    }
  }

  // ---- the arrival: `#<section or row>` (or the record's old-address anchor) comes into view once the reads above it answered
  const arrived = useRef(false)
  const target = useRef<string | null>(null)
  const answered = [depth?.holds ?? null, terms, companiesRead, carrier, depth?.requirements ?? null].map((read) => read !== null && read.status !== 'loading')
  const landing = answered.map((done) => (done ? '1' : '0')).join('')
  useEffect(() => {
    if (!on) {
      arrived.current = false
      target.current = null
      return
    }
    if (arrived.current) return
    if (target.current === null) {
      const hash = typeof window === 'undefined' ? '' : decodeURIComponent(window.location.hash.slice(1))
      target.current = hash || input.model.anchorOnArrival || ''
    }
    const id = target.current
    if (!id) {
      arrived.current = true
      return
    }
    const section = (TERMS_SECTIONS as readonly string[]).includes(id) ? (id as TermsSectionId) : 'party-identity'
    const needed = ABOVE[section]
    if (typeof document !== 'undefined') document.getElementById(id)?.scrollIntoView({ block: 'start' })
    if (answered.slice(0, needed).every(Boolean)) arrived.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, landing])

  const model: TermsTabModel | null =
    on && party
      ? termsTabModel(
          {
            party,
            prefix: input.model.prefix,
            can,
            locale,
            now,
            companyId: session.company?.id ?? null,
            companyNames: Object.fromEntries(session.companies.map((company) => [company.id, company.name])),
            commercial: terms,
            carrier,
            holds: depth?.holds ?? null,
            companies: companiesRead,
            requirements: depth?.requirements ?? null,
            library: library?.read ?? null,
            lists,
            history: input.model.history, // F-CT-516
            viesRunning: input.model.viesRunning === true,
          },
          state,
        )
      : null

  const actions: TermsTabActions = {
    onChip: (chip) => {
      const found = chip ? model?.answer.chips.find((entry) => entry.id === chip) : null
      if (found?.door) {
        router.push(found.door)
        return
      }
      patch({ chip })
    },
    onFold: (fold, open) =>
      patch(fold === 'released' ? { releasedOpen: open } : fold === 'requirementsEnded' ? { requirementsEndedOpen: open } : fold === 'earlier' ? { earlierOpen: open } : fold === 'later' ? { laterOpen: open } : fold === 'checks' ? { checksOpen: open } : { endedOpen: open }),
    onPlaceHold: () => depth?.hold.actions.onPlace?.(),
    onReleaseHold: (hold) => {
      const row = depth?.holds.status === 'ready' ? depth.holds.value.holds.find((entry) => entry.id === hold.id) : undefined
      if (row) depth?.hold.actions.onRelease?.(row)
    },
    onRetryHolds: () => depth?.onRetryHolds(),
    onRetryTerms: () => {
      setTerms(LOADING)
      void loadTerms()
    },
    onRetryCompanies: () => depth?.onRetryCompanyTerms(),
    onRetryCarrier: () => {
      setCarrier(LOADING)
      void loadCarrier()
    },
    onChangeTerms: () => {
      if (terms?.status !== 'ready') return
      setWindow(termsWindowOf(terms.value))
      loadChoices(customerCompany)
    },
    onChangeDelivery: () => {
      if (carrier?.status === 'ready') setWindow(deliveryWindowOf(carrier.value))
    },
    onCompanyTerms: (companyId) => {
      const entry = entryOf(companyId)
      if (!entry || !companies) return
      const poOnly = !(companies.tenantWide && companies.companies.length > 1)
      setWindow(companyWindowOf(entry, poOnly))
      if (!poOnly) loadChoices(companyId)
    },
    onBackToCustomer: (companyId) => {
      const entry = entryOf(companyId)
      // Held by state while a credit limit is set: the window never opens to be refused (R6 answers 409).
      if (entry?.terms && !entry.terms.creditLimitCurrency) setWindow(companyEndWindowOf(companyId))
    },
    onWindowDraft: (window) => setWindow(window),
    onWindowConfirm: () => void confirm(),
    onWindowClose: () => setWindow(null),
    onRetryChoices: () => loadChoices(state.window?.kind === 'company' ? state.window.companyId : customerCompany, true),
    onCopyLink: (anchor) => {
      copyLinkTo(anchor)
      setNotice({ tone: 'info', words: said('ct.copied') })
    },
    // ---- F-CT-505 (ct-w2 W2.1): Requirements — the provider's own windows; a file's door is ONE preview read on the click.
    onAddRequirement: () => depth?.requirementsWindow.actions.onAdd?.(),
    onReplaceRequirement: (row) => depth?.requirementsWindow.actions.onReplace?.(row.requirement),
    onEndRequirement: (row) => depth?.requirementsWindow.actions.onEnd?.(row.requirement),
    onKind: (kind) => patch({ kind, moreRequirements: false }),
    onMoreRequirements: (more) => patch({ moreRequirements: more }),
    onRetryRequirements: () => depth?.onRetryRequirements(),
    onOpenFile: (fileId) => {
      fileDoor(api, fileId)
        .then((url) => {
          // ct-fx3 G-W03 (walk W-03): the address as this browser reaches it (a local store's path goes through /api), as Work does.
          if (typeof window !== 'undefined') window.open(storeUrl(url), '_blank', 'noopener')
        })
        .catch(() => setNotice({ tone: 'danger', words: said('ct.req.fileFailed') }))
    },
    onCopyWords: (words) => {
      void navigator.clipboard?.writeText(words).catch(() => undefined)
      setNotice({ tone: 'info', words: said('ct.req.wordsCopied') })
    },
    // ---- F-CT-516 (ct-w2 W2.2): the record's own identity window and VIES act (their results land in the record's notice area)
    onCorrectIdentity: () => input.actions?.onDialog?.({ kind: 'identity', mode: 'correct' }),
    onNewIdentity: () => input.actions?.onDialog?.({ kind: 'identity', mode: 'new' }),
    onCheckVies: () => input.actions?.onCheckVies?.(),
    onMoreChecks: () => input.moreHistory?.(),
  }

  return {
    model,
    actions,
    hold: on ? (depth?.hold ?? null) : null,
    requirementsWindow: on ? (depth?.requirementsWindow ?? null) : null, // F-CT-505
    notices: {
      own: on ? notice : null,
      onDismissOwn: () => setNotice(null),
      depth: on ? (depth?.notice ?? null) : null,
      onDismissDepth: () => depth?.onDismissNotice(),
    },
  }
}
