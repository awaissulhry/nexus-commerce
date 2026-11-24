'use client'

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import type { Party } from '../../../parties/_shared/api'
import type { SupplierDepth } from '../../../parties/_shared/view/PartyRecordView'
import { WithMessages } from '../../../../record-panels/i18n'
import { NS } from './model'
import { useCustomerDepth, type CustomerDepthState } from './use-depth'
import { HoldDialogView } from './view/HoldCard' // F-CM-301: Money's Credit & terms opens the same window
import { RequirementsTab } from './view/RequirementsTab'
import type { TermsDepth } from '../record/terms/use-terms-tab' // F-CT-402: the Terms & requirements tab's part of the provider
import './depth.css'

/** The catalogues every part of the customer's depth reads. */
export const DEPTH_NAMESPACES = [NS]

const Depth = createContext<CustomerDepthState | null>(null)

/** Holds the customer's W2b reads and writes for the record (one hook, above the shared party record). */
export function CustomerDepthProvider({ partyId, children }: { partyId: string; children?: ReactNode }) {
  const state = useCustomerDepth(partyId)
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Depth.Provider value={state}>{children}</Depth.Provider>
    </WithMessages>
  )
}

const useDepth = () => {
  const state = useContext(Depth)
  if (!state) throw new Error('CustomerDepthProvider is missing')
  return state
}

// ---- F-CO-102 (customer page › Overview, 13-backend §3.2): the glance for the Overview's container — the provider's ONE read
// (holds, credit, samples, repairs, riders, requirements, a rider's team) and its retry; no second read of any of it.
export function useCustomerGlance(): CustomerDepthState['glance'] {
  return useDepth().glance
}
// ---- end F-CO-102

// F-CA-115 (customer People & addresses, lane ca-; 13-backend §3, §5.5): the contacts' personal data for the People tab's container —
// the provider's ONE privacy read (read on People), no second read of it.
// F-CA-223 (ca-w2 W2.4; Z14): + its windows' rights, today and their notice (the acts moved onto each person's ⋯); `reload` reads the
// party again after an erase (the old card's connector did it).
export function useCustomerPrivacy(reload?: () => void): { readonly state: CustomerDepthState['privacy']; readonly can: CustomerDepthState['can']; readonly today: string; readonly notice: CustomerDepthState['notice']; readonly onDismissNotice: () => void } {
  const depth = useSync(reload)
  return { state: depth.privacy, can: depth.can, today: depth.today, notice: depth.notice, onDismissNotice: depth.onDismissNotice }
}
// F-CA-115: end

// ---- F-CM-301 (customer MONEY tab, cm-w3 W3.1; 13-backend §4.2): the hold for Money's Credit & terms — the provider's ONE hold state,
// shared with Terms & requirements: Put on hold… and Release… (the one hold in force, with its version) open the Terms tab's own window,
// drawn where Money asks for it. `release` is null while the holds are read, or when several are in force (Terms lists each one).
export function useCustomerHold(party: Party): { readonly place: () => void; readonly release: (() => void) | null; readonly window: ReactNode } {
  const state = useDepth()
  const { prefix } = useAddresses()
  const holds = state.holds.read.status === 'ready' ? state.holds.read.value.holds.filter((hold) => hold.inForce) : null
  const single = holds && holds.length === 1 ? holds[0]! : null
  return {
    place: () => state.holds.onPlace(),
    release: single ? () => state.holds.onRelease(single) : null,
    window: <HoldDialogView model={{ read: state.holds.read, can: state.can, status: party.status, prefix, dialog: state.holds.dialog, companies: state.companies }} actions={state.holds} />,
  }
}
// ---- end F-CM-301

// ---- F-CT-402 (customer Terms & requirements, ct-w1 W1.4; 13-backend §6.5; Z5): the tab's part of the provider — its ONE holds,
// company-terms and requirements reads (Money and the Overview read them too), the hold window (HoldDialogView, the one Money opens:
// one state), a company-terms write's answer kept here, and the notice of the acts made on Terms. No second read of any of it.
export function useCustomerTerms(party: Party | null | undefined): TermsDepth | null {
  const state = useDepth()
  const { prefix } = useAddresses()
  if (!party) return null
  return {
    holds: state.holds.read,
    companyTerms: state.terms.read,
    requirements: state.requirements.read,
    hold: { model: { read: state.holds.read, can: state.can, status: party.status, prefix, dialog: state.holds.dialog, companies: state.companies }, actions: state.holds },
    onCompanyTerms: state.terms.onAnswer,
    onRetryHolds: state.holds.onRetry,
    onRetryCompanyTerms: state.terms.onRetry,
    onRetryRequirements: state.requirements.onRetry,
    notice: state.termsNotice,
    onDismissNotice: state.onDismissTermsNotice,
  }
}
// ---- end F-CT-402

/** `/w/<company>` of the office addresses, from the page's path. */
function useAddresses(): { prefix: string } {
  const pathname = usePathname() ?? ''
  return { prefix: pathname.replace(/\/sales\/customers\/.*$/, '') }
}

/**
 * The slot of the shared party record (areas/parties/_shared PartyRecord `depth`, B-W2b-334's) for a customer: each part a
 * connector to the state above. F-CO-203 (co-w2 W2.3): the Overview's old parts (the key-number tiles, Now's samples and repairs,
 * the status card, the side panel) went — the Overview's own rules read the glance (`useCustomerGlance` above).
 */
export function customerDepthSlot(party: Party): SupplierDepth {
  // F-CA-229 (customer People & addresses ca-w2 W2.5): People's riders / profiles card and its personal-data card went — the tab's own
  // Riders & measurements and Personal data sections draw them (cu/record/view/people), the personal-data windows through
  // useCustomerPrivacy. Terms & requirements keeps its two parts.
  // F-CT-402 (ct-w1 W1.4): the hold and PO-number cards went — the tab's Hold and Commercial terms sections draw them; Requirements
  // stays until ct-w2. The record's reload reaches the state through useCustomerPrivacy (the page calls it on every tab).
  return {
    requirements: <RequirementsPart party={party} />,
  }
}

/** The record's reload goes to the state (a contact erased moves the party's contacts). */
function useSync(reload?: () => void) {
  const state = useDepth()
  const latest = useRef(state)
  latest.current = state
  useEffect(() => {
    if (reload) latest.current.setReloadParty(reload)
  }, [reload])
  return state
}

function RequirementsPart({ party }: { party: Party }) {
  const state = useDepth()
  return (
    // F-CT-402 (Z5): the requirement acts' notice is the record's ONE notice area's on Terms (TermsNotices), no second line here.
    <div className="fw-cdp-stack">
      <RequirementsTab
        model={{ read: state.requirements.read, can: state.can, status: party.status, dialog: state.requirements.dialog, styles: state.requirements.styles, files: state.requirements.files, companies: state.companies }}
        actions={state.requirements}
      />
    </div>
  )
}
