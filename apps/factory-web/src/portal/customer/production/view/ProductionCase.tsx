'use client'

import { useMemo, useState } from 'react'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PortalBand } from '../../../shell/frame'
import { PortalShellView, type PortalShellViewModel } from '../../../shell/view/PortalShellView'
import { NS as ORDERS_NS } from '../../orders/model'
import { WAITING_NS, type BulkApproveDialogModel } from '../../waiting/view/BulkApproveDialog'
import type { BulkActionId, BulkBar } from '../bulk/model'
import { NS } from '../model'
import type { ReportProblemModel } from '../problem/view/ReportProblemDialog'
import type { AskManyReviewModel } from './AskManyReview'
import type { BulkReviewModel } from './BulkReview'
import { ProductionListView, type ProductionListModel } from './ProductionListView'
import type { UrgentOrderDialogModel } from './UrgentOrderDialog'

/**
 * F-PR-16 (the browser walk) — My production as one case of the design review: the portal frame (its band as the live page fills
 * it) around the customer's list, with made-up data. The live page (ProductionPage) composes the same view. A case opens with the
 * keyboard what the live page opens — the bulk bar on a pick, its review, Approve N, Ask N, Report a problem and the Urgent order
 * dialog — and closes it again (Esc, Cancel), so the review walks Tab order, Esc and the focus going back to the opener. Nothing is
 * sent from here.
 */
export interface ProductionCaseModel {
  shell: PortalShellViewModel
  list: ProductionListModel
  /** The bar of the picked rows, as the page makes it (null: nothing picked). */
  barOf?: (selected: readonly string[]) => BulkBar | null
  /** What each act opens here. */
  opens?: {
    readonly review?: BulkReviewModel
    readonly top?: BulkReviewModel
    readonly approve?: BulkApproveDialogModel
    readonly ask?: AskManyReviewModel
    readonly problem?: ReportProblemModel
    readonly dialog?: UrgentOrderDialogModel
  }
}

/** A case is drawn in the page's language: its made-up words come in both. */
export type ProductionCaseBuilder = (locale: Locale) => ProductionCaseModel

export function ProductionCase({ model: build }: { model: ProductionCaseBuilder }) {
  const locale = useLocale()
  const built = useMemo(() => build(locale), [build, locale])
  return (
    <WithMessages namespaces={[NS, ORDERS_NS, WAITING_NS, 'ds-words', 'portal', 'shell', 'lists']}>
      <CaseState key={locale} built={built} />
    </WithMessages>
  )
}

type Opened = Pick<ProductionListModel, 'selected' | 'bulk' | 'review' | 'approve' | 'ask' | 'problem' | 'dialog'>

function CaseState({ built }: { built: ProductionCaseModel }) {
  const [opened, setOpened] = useState<Partial<Opened>>({})
  const set = (patch: Partial<Opened>) => setOpened((current) => ({ ...current, ...patch }))
  const list: ProductionListModel = { ...built.list, ...opened }
  const rows = built.list.read?.items ?? []
  const opens = built.opens ?? {}
  const pick = (ids: readonly string[]) => set({ selected: [...ids], bulk: built.barOf ? built.barOf(ids) : null })
  const onAction = (id: BulkActionId) => {
    if ((id === 'URGENT' || id === 'REGULAR') && opens.review) set({ review: opens.review })
    else if (id === 'TOP' && (opens.top ?? opens.review)) set({ review: opens.top ?? opens.review ?? null })
    else if (id === 'APPROVE' && opens.approve) set({ approve: opens.approve })
    else if (id.startsWith('ASK_') && opens.ask) set({ ask: opens.ask })
    else if (id === 'REPORT' && opens.problem) set({ problem: opens.problem })
  }
  const shellBand = built.shell.band
  const band: PortalBand | null = shellBand
    ? { ...shellBand, actions: (shellBand.actions ?? []).map((action) => (action.id === 'urgent-order' && opens.dialog ? { ...action, onClick: () => set({ dialog: opens.dialog ?? null }) } : action)) }
    : null
  return (
    <PortalShellView model={{ ...built.shell, band }}>
      <ProductionListView
        model={list}
        actions={{
          ...(built.barOf ? { onSelect: pick } : {}),
          bulk: { onSelectAll: () => pick(rows.map((row) => row.id)), onAction },
          ...(opens.problem ? { onReport: () => set({ problem: opens.problem ?? null }) } : {}),
          review: { onClose: () => set({ review: null }) },
          approve: { onClose: () => set({ approve: null }) },
          ask: { onClose: () => set({ ask: null }) },
          problem: { onClose: () => set({ problem: null }) },
          dialog: { onClose: () => set({ dialog: null }) },
        }}
      />
    </PortalShellView>
  )
}
