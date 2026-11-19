'use client'

import type { ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { DetailModal } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { CatalogueActions, CatalogueModel } from '../../../../inquiries/catalogue-model'
import { NAMESPACES as INQUIRIES_NAMESPACES } from '../../../../inquiries/model'
import { CataloguePane } from '../../../../inquiries/view/pane/catalogue/CataloguePane'
import '../../../../inquiries/view/pane/pane.css'

/**
 * F-CP-107 (customer page plan D10; 10-customer-page §6; 12 §3) — a customer's portal draft in a large centred window (DS DetailModal):
 * ONE banner "Read only: <customer> is still writing it." over Incoming's own catalogue pane in draft mode (the same container and view
 * as Incoming: its lines, files, facts and conversation; Accept as order, Accept as quote and Refuse held with why). J / K walk the
 * customer's drafts in the list's order (the window's ▲ / ▼; key hints in the footer's info icon). Draws its model; fetches nothing.
 */

export interface DraftWindowModel {
  readonly customer: string
  readonly title: string
  /** The list's drafts in the order shown, and the one open. */
  readonly nav: { readonly ids: readonly string[]; readonly current: string }
  readonly pane: CatalogueModel
  readonly thread?: ReactNode
}

export interface DraftWindowActions {
  readonly pane?: CatalogueActions
  readonly onGo?: (id: string) => void
  readonly onClose?: () => void
}

export function DraftWindow(props: { model: DraftWindowModel; actions?: DraftWindowActions }) {
  return (
    <WithMessages namespaces={['parties', ...INQUIRIES_NAMESPACES]}>
      <Window {...props} />
    </WithMessages>
  )
}

function Window({ model, actions }: { model: DraftWindowModel; actions?: DraftWindowActions }) {
  const t = useT('parties')
  return (
    <DetailModal
      open
      onClose={() => actions?.onClose?.()}
      title={model.title}
      subtitle={model.customer}
      nav={{ ids: model.nav.ids, current: model.nav.current, onGo: (id) => actions?.onGo?.(id), noun: t('customers.drafts.noun') }}
    >
      <div className="fw-cwd-window">
        <Banner tone="info" title={t('customers.drafts.readOnly', { customer: model.customer })} />
        <CataloguePane model={model.pane} actions={actions?.pane} thread={model.thread} />
      </div>
    </DetailModal>
  )
}
