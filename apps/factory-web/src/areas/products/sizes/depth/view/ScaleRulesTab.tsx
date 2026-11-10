'use client'

import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { RuleRow } from '../api'
import { depthSearch, NO_DEPTH_FILTERS } from '../model'
import '../depth.css'

export interface ScaleRulesModel {
  /** null while it is read. */
  rules: RuleRow[] | null
  problem: string | null
}

/**
 * Size scale › Grade rules (B-W2b-240; design products.sizes rec:Size scale tab scale.graderules "Grade rules for this
 * scale", PRD-059, read-only list): the rules bound to this scale — rule, base size, points, how increments count,
 * state — each opening its Grade rule pop-up on the Sizes page; none yet: "No rules yet" and New grade rule for this
 * scale. It fetches nothing.
 */
export function ScaleRulesTab({ prefix, scaleId, model, canManage, onRetry }: { prefix: string; scaleId: string; model: ScaleRulesModel; canManage: boolean; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={['products-sizes-depth']}>
      <Body prefix={prefix} scaleId={scaleId} model={model} canManage={canManage} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ prefix, scaleId, model, canManage, onRetry }: { prefix: string; scaleId: string; model: ScaleRulesModel; canManage: boolean; onRetry?: () => void }) {
  const t = useT('products-sizes-depth')
  const base = `${prefix}/products/sizes`
  const newHref = `${base}${depthSearch('rules', { ...NO_DEPTH_FILTERS, scaleId }, { new: true })}`
  const add = canManage ? (
    <Button size="sm" variant="primary" asChild>
      <Link href={newHref}>
        <Plus size={14} aria-hidden /> {t('rules.new')}
      </Link>
    </Button>
  ) : undefined
  if (model.problem)
    return (
      <Banner
        tone="danger"
        title={t('scaleTab.failed')}
        action={
          <Button size="sm" onClick={() => onRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t(model.problem)}
      </Banner>
    )
  if (model.rules === null)
    return (
      <Card header={t('scaleTab.title')} aria-busy="true">
        <div className="fw-szd-stack">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  return (
    <Card header={t('scaleTab.title')} description={t('scaleTab.intro')} headerAction={model.rules.length > 0 ? add : undefined}>
      {model.rules.length === 0 ? (
        <EmptyState title={t('scaleTab.empty')} description={t(canManage ? 'scaleTab.emptyBody' : 'scaleTab.emptyView')} action={add} />
      ) : (
        <SummaryTable
          label={t('scaleTab.title')}
          stackOnPhone
          density="roomy"
          columns={[t('rules.col.rule'), t('rules.col.base'), t('rules.col.points'), t('rules.col.format'), t('rules.col.status')]}
          rows={model.rules.map((rule) => ({
            id: rule.id,
            cells: [
              <span key="r" className="fw-szd-cell">
                <Link className="fw-szd-rowlink" href={`${base}${depthSearch('rules', { ...NO_DEPTH_FILTERS, scaleId }, { open: rule.id })}`}>
                  {rule.code}
                </Link>
                <span className="fw-szd-sub">{rule.name}</span>
              </span>,
              rule.baseSize,
              t('rules.points', { count: rule.points }),
              t(`format.${rule.format}`),
              <Pill key="s" tone={rule.status === 'ACTIVE' ? 'success' : 'neutral'}>
                {t(`status.${rule.status}`)}
              </Pill>,
            ],
          }))}
        />
      )}
    </Card>
  )
}
