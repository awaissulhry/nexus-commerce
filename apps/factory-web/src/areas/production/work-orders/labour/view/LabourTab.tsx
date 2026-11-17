'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { COSTING_NAMESPACE, workOrderCostHref } from '../../../../finance/costing/model'
import { CostBridge, CostFacts, CostLabour, CostMaterials, CostScrapAndWaiting, CostSummary } from '../../../../finance/costing/view/CostParts'
import type { LabourModel } from '../model'
import type { Minutes } from '../../every-shift/model'
import { MinutesCard } from '../../every-shift/view/MinutesCard'
import { OffStandardCard } from './OffStandardCard'
// B-W2b-GB02 (G053). F-PR-06: one scrap value line (Quality is the scrap home).
import { ScrapValueLine } from '../scrap-rework/view/ScrapValueLine'
import '../../../../finance/costing/costing.css'
// B-W2b-F51: a refusal names the missing right in words, never its code.
import { rightRef } from '../../../../../lib/i18n/rights'

/**
 * Labour & cost (design production.workorders rec:labour, section wo-cost "SummaryTable: planned · actual · variance · per
 * garment"; W2a). Draws the work order's cost from the ledger with the parts Finance › Standard vs actual uses: the
 * facts, planned and actual per part, the bridge, the materials issued (a material line → its stock movements) and labour
 * per operation (standard minutes earned × the cost per minute). The whole section needs the cost grain (money.cost):
 * without it the tab says why and shows no figure; without costing.view it says which permission. Never wages, never a
 * person. Before the release a work order has no cost yet. B-W2b-59: the Minutes section above it (no money, no grain).
 * B-W2b-81: the off-standard minutes below the Minutes (no money, no grain, never per person).
 * B-W2b-424: the variance at close at the end of the cost section (`variance`, labour/variance). F-PR-06 (06-tree A.4 Tab 6): the
 * second scrap card went — one Scrap value line in the cost section, its door to Quality (`qualityHref`), the scrap home.
 */
export function LabourTab({ labour, prefix, workOrderId, draft, onRetry, minutes, labourHref = null, variance = null, qualityHref }: { labour: LabourModel | undefined; prefix: string; workOrderId: string; draft: boolean; onRetry?: () => void; minutes?: Minutes; labourHref?: string | null; variance?: ReactNode; /** F-PR-06: the work order's Quality tab (the scrap home). */ qualityHref: string }) {
  return (
    <WithMessages namespaces={[COSTING_NAMESPACE]}>
      {/* B-W2b-59 (wo-minutes): standard minutes, no money: open to whoever reads the work order, above the cost and its grain. */}
      <div className="fw-pr-stack">
        {minutes && <MinutesCard minutes={minutes} />}
        {labour?.offStandard && <OffStandardCard part={labour.offStandard} labourHref={labourHref} onRetry={onRetry} />}
        <Labour labour={labour} prefix={prefix} workOrderId={workOrderId} draft={draft} onRetry={onRetry} variance={variance} qualityHref={qualityHref} />
      </div>
    </WithMessages>
  )
}

function Labour({ labour, prefix, workOrderId, draft, onRetry, variance, qualityHref }: { labour: LabourModel | undefined; prefix: string; workOrderId: string; draft: boolean; onRetry?: () => void; variance: ReactNode; qualityHref: string }) {
  const t = useT(COSTING_NAMESPACE)
  const can = labour?.can
  if (!can?.view) {
    return (
      <Card padded>
        <EmptyState title={t('labourTab.noView.title')} description={t('labourTab.noView.body', { right: rightRef('costing.view') })} />
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
      {/* B-W2b-GB02 (G053). F-PR-06: ONE scrap value line inside the cost section; the scrap and its reasons are on Quality. */}
      {labour?.scrapRework && <ScrapValueLine model={labour.scrapRework} qualityHref={qualityHref} onRetry={onRetry} />}
      {/* B-W2b-424 (wo-cost "W2b variance at close"): inside the cost section, with its grain. */}
      {variance}
    </div>
  )
}
