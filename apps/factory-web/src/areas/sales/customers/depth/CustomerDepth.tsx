'use client'

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import type { Metric } from '@nexus/ui/components'
import type { Party } from '../../../parties/_shared/api'
import type { SupplierDepth } from '../../../parties/_shared/view/PartyRecordView'
import { WithMessages } from '../../../../record-panels/i18n'
import { NS } from './model'
import { useCustomerDepth, type CustomerDepthState } from './use-depth'
import { GlanceAside, GlanceNow, GlanceStatus, GlanceTileText, type GlanceModel } from './view/GlanceParts'
import { HoldCard } from './view/HoldCard'
import { NoticeLine } from './view/parts'
import { PoNumberCard } from './view/PoNumberCard'
import { PrivacyCard } from './view/PrivacyCard'
import { RequirementsTab } from './view/RequirementsTab'
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

/** `/w/<company>` and the record's own address, from the page's path. */
function useAddresses(party: Party): { prefix: string; recordHref: string } {
  const pathname = usePathname() ?? ''
  const prefix = pathname.replace(/\/sales\/customers\/.*$/, '')
  return { prefix, recordHref: `${prefix}/sales/customers/${encodeURIComponent(party.id)}` }
}

/** A key-number tile's words, read from the state (the slot is built outside a component: the words are components). */
function TileText({ part, field }: { part: 'credit' | 'promises'; field: 'label' | 'value' | 'hint' }) {
  return <GlanceTileText read={useDepth().glance.read} part={part} field={field} />
}

/**
 * The slot of the shared party record (areas/parties/_shared PartyRecord `depth`, B-W2b-334's) for a customer: each part a
 * connector to the state above. `prefix`: `/w/<company>` (the Promises tile opens the record's Quotes & orders).
 */
export function customerDepthSlot(party: Party, reload: () => void, prefix: string): SupplierDepth {
  const tile = (part: 'credit' | 'promises'): Metric => ({ label: <TileText part={part} field="label" />, value: <TileText part={part} field="value" />, hint: <TileText part={part} field="hint" /> })
  return {
    numbers: [tile('credit'), { ...tile('promises'), href: `${prefix}/sales/customers/${encodeURIComponent(party.id)}?tab=orders` }],
    now: <NowPart party={party} />,
    status: <StatusPart party={party} />,
    aside: <AsidePart party={party} />,
    tax: <TaxPart party={party} reload={reload} />,
    requirements: <RequirementsPart party={party} />,
    contacts: <ContactsPart party={party} reload={reload} />,
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

function useGlanceModel(party: Party): GlanceModel {
  const state = useDepth()
  return { read: state.glance.read, ...useAddresses(party) }
}

function NowPart({ party }: { party: Party }) {
  return <GlanceNow model={useGlanceModel(party)} />
}

function StatusPart({ party }: { party: Party }) {
  return <GlanceStatus model={useGlanceModel(party)} />
}

function AsidePart({ party }: { party: Party }) {
  return <GlanceAside model={useGlanceModel(party)} />
}

function TaxPart({ party, reload }: { party: Party; reload: () => void }) {
  const state = useSync(reload)
  const { prefix } = useAddresses(party)
  return (
    <div className="fw-cdp-stack">
      <NoticeLine notice={state.notice} onDismiss={state.onDismissNotice} />
      <div className="fw-cdp-two-wide">
        <HoldCard model={{ read: state.holds.read, can: state.can, status: party.status, prefix, dialog: state.holds.dialog, companies: state.companies }} actions={state.holds} />
        <PoNumberCard model={{ read: state.po.read, can: state.can, status: party.status, draft: state.po.draft, saving: state.po.saving, failed: state.po.failed }} actions={state.po} />
      </div>
    </div>
  )
}

function RequirementsPart({ party }: { party: Party }) {
  const state = useDepth()
  return (
    <div className="fw-cdp-stack">
      <NoticeLine notice={state.notice} onDismiss={state.onDismissNotice} />
      <RequirementsTab
        model={{ read: state.requirements.read, can: state.can, status: party.status, dialog: state.requirements.dialog, styles: state.requirements.styles, files: state.requirements.files, companies: state.companies }}
        actions={state.requirements}
      />
    </div>
  )
}

function ContactsPart({ party, reload }: { party: Party; reload: () => void }) {
  const state = useSync(reload)
  const { recordHref } = useAddresses(party)
  return (
    <div className="fw-cdp-stack">
      <NoticeLine notice={state.notice} onDismiss={state.onDismissNotice} />
      <PrivacyCard
        model={{ read: state.privacy.read, can: state.can, status: party.status, today: state.today, dialog: state.privacy.dialog, stepUp: state.privacy.stepUp, portalHref: `${recordHref}?tab=portal` }}
        actions={state.privacy}
      />
    </div>
  )
}
