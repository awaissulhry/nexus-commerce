'use client'

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import type { Party } from '../../../parties/_shared/api'
import type { SupplierDepth } from '../../../parties/_shared/view/PartyRecordView'
import { WithMessages } from '../../../../record-panels/i18n'
import { CALENDAR_KIT_NAMESPACE } from '../../../_shared/calendar-grid/words'
import { NS, profileHeld, statusHeld, valueOf } from './model'
import { useSupplierDepth, type SupplierDepthState } from './use-depth'
import { BankTab } from './view/BankTab'
import { DocumentsTab } from './view/DocumentsTab'
import { NowDepth } from './view/NowDepth'
import { ProfileCard } from './view/ProfileCard'
import { QualityTab } from './view/QualityTab'
import { ReceivesCard } from './view/ReceivesCard'
import { StatusDialog } from './view/StatusDialog'
import './depth.css'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useDocType } from './doc-type/use-doc-type'

/** The catalogues every part of the supplier's depth reads. */
export const DEPTH_NAMESPACES = [NS, CALENDAR_KIT_NAMESPACE]

const Depth = createContext<SupplierDepthState | null>(null)

/** Holds the supplier's W2b reads and writes for the record (one hook, above the shared party record). */
export function SupplierDepthProvider({ partyId, children }: { partyId: string; children?: ReactNode }) {
  const state = useSupplierDepth(partyId)
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Depth.Provider value={state}>{children}</Depth.Provider>
    </WithMessages>
  )
}

const useDepth = () => {
  const state = useContext(Depth)
  if (!state) throw new Error('SupplierDepthProvider is missing')
  return state
}

/** The slot of the shared party record (areas/parties/_shared PartyRecord `depth`): each part a connector to the state above. */
export function supplierDepthSlot(party: Party, reload: () => void): SupplierDepth {
  return {
    overview: <OverviewPart party={party} reload={reload} />,
    now: <NowPart party={party} />,
    contacts: <ContactsPart party={party} reload={reload} />,
    documents: <DocumentsPart party={party} />,
    quality: <QualityPart />,
    bank: <BankPart />,
  }
}

/** The record's reload goes to the state (a save of ours moves the party's version); a version moved by W1's form reads the profile again. */
function useSync(party: Party, reload?: () => void) {
  const state = useDepth()
  const latest = useRef(state)
  latest.current = state
  useEffect(() => {
    if (reload) latest.current.setReloadParty(reload)
  }, [reload])
  useEffect(() => {
    latest.current.syncVersion(party.version)
  }, [party.version])
  return state
}

function OverviewPart({ party, reload }: { party: Party; reload: () => void }) {
  const state = useSync(party, reload)
  const profile = valueOf(state.profile.read)
  return (
    <>
      <ProfileCard
        model={{
          read: state.profile.read,
          draft: state.profile.draft,
          held: profileHeld(state.can, party.status),
          statusHeld: profile ? statusHeld(state.can, profile) : null,
          saving: state.profile.saving,
          failed: state.profile.failed,
          refused: state.profile.refused,
          tried: state.profile.tried,
          today: state.today,
        }}
        actions={{ onDraft: state.profile.onDraft, onSave: state.profile.onSave, onDiscard: state.profile.onDiscard, onRetry: state.profile.onRetry, onStatus: state.status.onOpen }}
      />
      <StatusDialog model={state.status.dialog} actions={state.status} />
    </>
  )
}

function NowPart({ party }: { party: Party }) {
  const state = useDepth()
  const pathname = usePathname() ?? ''
  return <NowDepth model={{ profile: state.profile.read, vault: state.documents.vault, today: state.today, documentsHref: `${pathname.replace(/\?.*$/, '')}?tab=documents` }} key={party.id} />
}

function ContactsPart({ party, reload }: { party: Party; reload: () => void }) {
  const state = useSync(party, reload)
  return <ReceivesCard model={{ read: state.profile.read, can: state.can, cells: state.receives.cells, notice: state.receives.notice }} actions={{ onToggle: state.receives.onToggle, onRetry: state.profile.onRetry }} />
}

function DocumentsPart({ party }: { party: Party }) {
  const state = useDepth()
  const pathname = usePathname() ?? ''
  // B-W2b-382: what each document is (files.upload); a type saved reads the vault again.
  const api = useOfficeApi()
  const session = useOfficeSession()
  const docType = useDocType({ api, partyId: party.id, mayType: session.permissions.includes('files.upload'), offline: state.live === 'offline', onTyped: state.documents.onRetry })
  return (
    <DocumentsTab
      model={{
        vault: state.documents.vault,
        changes: state.documents.changes,
        qualifications: state.documents.qualifications,
        can: state.can,
        today: state.today,
        questionnaireHref: state.can.questionnaire ? `${pathname}?tab=questionnaire` : null,
        notice: state.documents.notice,
        dialog: state.documents.dialog,
        companies: state.companies,
        docType: docType.model,
      }}
      actions={{ ...state.documents, docType: docType.actions }}
    />
  )
}

function QualityPart() {
  const state = useDepth()
  const pathname = usePathname() ?? ''
  const prefix = pathname.replace(/\/purchasing\/suppliers\/.*$/, '')
  return <QualityTab model={{ receipts: state.quality.receipts, claims: state.quality.claims, prefix }} />
}

function BankPart() {
  const state = useDepth()
  return <BankTab model={{ read: state.bank.read, can: state.can, me: state.me, notice: state.bank.notice, dialog: state.bank.dialog, stepUp: state.bank.stepUp }} actions={state.bank} />
}
