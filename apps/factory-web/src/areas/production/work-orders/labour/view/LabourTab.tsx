'use client'

import Link from 'next/link'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { COSTING_NAMESPACE, workOrderCostHref } from '../../../../finance/costing/model'
import { CostBridge, CostFacts, CostLabour, CostMaterials, CostScrapAndWaiting, CostSummary } from '../../../../finance/costing/view/CostParts'
import type { LabourModel } from '../model'
import '../../../../finance/costing/costing.css'

/**
 * Labour & cost (design production.workorders rec:labour, section wo-cost "SummaryTable: planned · actual · variance · per
 * garment"; W2a). Draws the work order's cost from the ledger with the parts Finance › Standard vs actual uses: the
 * facts, planned and actual per part, the bridge, the materials issued (a material line → its stock movements) and labour
 * per operation (standard minutes earned × the cost per minute). The whole section needs the cost grain (money.cost):
 * without it the tab says why and shows no figure; without costing.view it says which permission. Never wages, never a
 * person. Before the release a work order has no cost yet.
 */
export function LabourTab({ labour, prefix, workOrderId, draft, onRetry }: { labour: LabourModel | undefined; prefix: string; workOrderId: string; draft: boolean; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[COSTING_NAMESPACE]}>
      <Labour labour={labour} prefix={prefix} workOrderId={workOrderId} draft={draft} onRetry={onRetry} />
    </WithMessages>
  )
}

function Labour({ labour, prefix, workOrderId, draft, onRetry }: { labour: LabourModel | undefined; prefix: string; workOrderId: string; draft: boolean; onRetry?: () => void }) {
  const t = useT(COSTING_NAMESPACE)
  const can = labour?.can
  if (!can?.view) {
    return (
      <Card padded>
        <EmptyState title={t('labourTab.noView.title')} description={t('labourTab.noView.body', { permission: 'costing.view' })} />
      </Card>
    )
  }
  if (!can.cost) {
    return (
      <Card padded>
        <EmptyState title={t('labourTab.noCost.title')} description={t('labourTab.noCost.body')} />
      </Card>
    )
  }
  if (draft) {
    return (
      <Card padded>
        <EmptyState title={t('labourTab.draft.title')} description={t('labourTab.draft.body')} />
      </Card>
    )
  }
  const part = labour?.part ?? null
  if (!part || (!part.value && !part.problem)) {
    return (
      <Card padded aria-busy="true">
        <p className="fw-fco-muted" role="status">
          <Spinner size={14} /> {t('labourTab.loading')}
        </p>
      </Card>
    )
  }
  if (!part.value) {
    return (
      <Card padded>
        <EmptyState
          title={t('labourTab.failed')}
          description={t(part.problem ?? 'problem.internal')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const detail = part.value
  return (
    <div className="fw-fco-detail">
      <Card padded className="fw-fco-card">
        <div className="fw-fco-section-head">
          <h2 className="fw-fco-h2">{t('labourTab.title')}</h2>
          <Link className="fw-fco-link" href={workOrderCostHref(prefix, workOrderId)}>
            {t('labourTab.inFinance')}
          </Link>
        </div>
        <CostFacts detail={detail} can={can} />
      </Card>
      <div className="fw-fco-pair">
        <Card padded className="fw-fco-card">
          <CostBridge detail={detail} can={can} />
        </Card>
        <Card padded className="fw-fco-card">
          <CostSummary detail={detail} can={can} />
        </Card>
      </div>
      <Card padded className="fw-fco-card">
        <CostMaterials detail={detail} can={can} prefix={prefix} />
      </Card>
      <Card padded className="fw-fco-card">
        <CostLabour detail={detail} can={can} />
        <p className="fw-fco-muted">{t('labourTab.wagesNever')}</p>
      </Card>
      <CostScrapAndWaiting detail={detail} can={can} />
    </div>
  )
}
