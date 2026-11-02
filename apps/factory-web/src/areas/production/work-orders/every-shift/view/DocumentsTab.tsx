'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { FileRow } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { WorkOrder } from '../../../_shared/api'
import { SHIFT_NAMESPACE, travellersHref } from '../model'

/**
 * Documents (design wo-docs): the files that travel with the work order — the traveller PDF with its QR (MES-014, a new
 * tab, made on request and stored nowhere), the bundle tickets (the Bundles tab) and the frozen style revision.
 */
export function DocumentsTab({ workOrder, prefix, bundles }: { workOrder: WorkOrder; prefix: string; bundles: number | null }) {
  return (
    <WithMessages namespaces={[SHIFT_NAMESPACE]}>
      <Body workOrder={workOrder} prefix={prefix} bundles={bundles} />
    </WithMessages>
  )
}

function Open({ href, label, tab }: { href: string; label: string; tab?: boolean }) {
  return (
    <Button size="sm" asChild>
      <Link href={href} aria-label={label} {...(tab ? { target: '_blank' } : {})}>
        <ExternalLink size={13} aria-hidden /> {label}
      </Link>
    </Button>
  )
}

function Body({ workOrder, prefix, bundles }: { workOrder: WorkOrder; prefix: string; bundles: number | null }) {
  const t = useT(SHIFT_NAMESPACE)
  return (
    <Card padded className="fw-pr-card">
      <h2 className="fw-pr-h2">{t('docs.title')}</h2>
      <div className="fw-pr-stack">
        <FileRow name={t('docs.traveller', { number: workOrder.number })} status={t(workOrder.status === 'DRAFT' ? 'docs.travellerDraft' : 'docs.travellerHint')} actions={<Open href={travellersHref(prefix, [workOrder.id])} label={t('docs.openTraveller')} tab />} />
        <FileRow name={t('docs.tickets')} status={bundles === null ? t('docs.ticketsNone') : t('docs.ticketsCount', { count: bundles })} actions={<Open href={`${prefix}/production/work-orders/${workOrder.id}?tab=bundles`} label={t('docs.openTickets')} />} />
        {workOrder.revision && <FileRow name={t('docs.spec', { revision: workOrder.revision.revision })} status={workOrder.spec.frozen ? t('docs.specFrozen') : t('docs.specDraft')} actions={<Open href={`${prefix}/products/styles/${workOrder.style.id}`} label={t('docs.openSpec')} tab />} />}
      </div>
    </Card>
  )
}
