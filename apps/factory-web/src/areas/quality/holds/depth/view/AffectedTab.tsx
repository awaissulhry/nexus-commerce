'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { GitBranch } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { Read } from '../../../_shared/model'
import { kindKey, nounKey } from '../../model'
import type { Affected } from '../api'
import { impactTree, type GenealogyStart } from '../model'
import { States } from './GenealogyDialog'
import { ImpactTree } from './ImpactTree'

/**
 * Hold › Affected (design quality.holds/rec:Hold/affected "What it touches": the TraceTree of the held records and what
 * descends from them, counts by state — in stock · in work · packed · shipped, with customers; "Extend hold" adds branches).
 * Read only: Extend opens the hold by genealogy from the group's suspect record (or the hold's lot or hide), held with the
 * reason otherwise. The group the hold is part of, with its other holds.
 */
export function AffectedTab({ affected, prefix, reasons, onExtend, onRetry, onOpenHold }: {
  affected: Read<Affected> | null
  prefix: string
  reasons: ReadonlyMap<string, { labelIt: string; labelEn: string }>
  onExtend?: (start: GenealogyStart) => void
  onRetry?: () => void
  onOpenHold?: (holdId: string) => void
}) {
  const t = useT('holds')
  const q = useT('quality')
  const [affectedOnly, setAffectedOnly] = useState(false)
  const value = affected?.value ?? null
  const items = useMemo(() => (value ? impactTree(value) : []), [value])
  if (affected === null || (value === null && !affected.problem))
    return (
      <div className="fw-q-stack" role="status" aria-label={t('affected.reading')}>
        <Skeleton height={28} />
        <Skeleton height={120} />
      </div>
    )
  if (affected.problem || !value)
    return (
      <Banner
        tone="danger"
        title={t('affected.failed')}
        action={
          <Button size="sm" onClick={() => onRetry?.()}>
            {q('common.retry')}
          </Button>
        }
      >
        {q(affected.problem ?? 'problem.unavailable')}
      </Banner>
    )
  const extendHeld = value.extend.held ? t(`affected.extendHeld.${value.extend.held}`) : null
  return (
    <>
      <div className="fw-q-section-title">
        <strong>{t('affected.title')}</strong>
        <p className="fw-q-hint">{value.traceable ? (value.traced < value.of ? t('affected.tracedSome', { traced: value.traced, of: value.of }) : t('affected.intro')) : t('affected.notTraceable')}</p>
      </div>
      <dl className="fw-hd-states" aria-label={t('affected.states')}>
        <States states={value.states} />
      </dl>
      {value.group && (
        <div className="fw-q-section">
          <div className="fw-q-section-title">
            <strong>{t('affected.group', { code: value.group.sourceCode ?? '—' })}</strong>
            <p className="fw-q-hint">{t('affected.groupHint', { count: value.group.holds.length })}</p>
          </div>
          <SummaryTable
            label={t('affected.groupHolds')}
            stackOnPhone
            columns={[t('col.number'), t('col.subject'), t('col.status'), t('col.site')]}
            rows={value.group.holds.map((hold) => ({
              id: hold.id,
              cells: [
                hold.id === value.holdId ? (
                  <span key="n" className="fw-q-code">
                    {hold.number ?? '—'} {t('affected.thisHold')}
                  </span>
                ) : (
                  <Link
                    key="n"
                    className="fw-q-link fw-q-code"
                    href={`${prefix}/quality/holds?open=${encodeURIComponent(hold.id)}&tab=affected`}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                      event.preventDefault()
                      onOpenHold?.(hold.id)
                    }}
                  >
                    {hold.number ?? '—'}
                  </Link>
                ),
                `${hold.count} ${t(nounKey(hold.subjectType), { count: hold.count })}`,
                t(`status.${hold.status}`),
                hold.siteCode ?? '—',
              ],
            }))}
          />
        </div>
      )}
      <div className="fw-q-actions">
        <Button size="sm" variant="primary" heldReason={extendHeld} onClick={() => value.extend.start && onExtend?.(value.extend.start)}>
          <GitBranch size={14} aria-hidden /> {value.extend.start ? t('affected.extendFrom', { kind: t(kindKey(value.extend.start.type)), code: value.extend.start.code }) : t('affected.extend')}
        </Button>
      </div>
      {value.traceable && (
        <ImpactTree
          impact={value}
          items={items}
          label={t('affected.treeLabel')}
          prefix={prefix}
          reasons={reasons}
          affectedOnly={affectedOnly}
          onAffectedOnly={setAffectedOnly}
          empty={t('affected.empty')}
        />
      )}
    </>
  )
}
