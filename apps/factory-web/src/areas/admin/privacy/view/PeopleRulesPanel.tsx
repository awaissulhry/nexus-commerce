'use client'

import Link from 'next/link'
import { Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { PeopleRules } from '../api'
import type { Read } from '../model'

/**
 * Admin › Privacy & notices › People data rules (design sec:people-rules; PLT-207, PLT-209, MES-281): what the rules are, in our
 * words, read-only: the switches and the group size live in People › People settings, one owner. No automated decision on
 * a worker, so no information pack; if one ever exists, this panel says it is due.
 */
export function PeopleRulesPanel({ prefix, read, onRetry }: { prefix: string; read: Read<PeopleRules>; onRetry?: () => void }) {
  const t = useT('privacy')
  const ds = useDsWords()
  const rules = read.value
  const body = () => {
    if (read.problem) {
      return (
        <EmptyState
          title={t(read.problem)}
          action={
            <Button size="sm" onClick={onRetry}>
              {t('pv.rules.retry')}
            </Button>
          }
        />
      )
    }
    if (!rules) return <Skeleton height={96} />
    return (
      <>
        <KeyValue
          columns={1}
          dense
          items={[
            ...rules.facts.map((fact) => ({ label: t(`pv.rules.factTitle.${fact.key}`), value: t(`pv.rules.fact.${fact.key}`), hint: <LawRef law={t(`pv.rules.law.${fact.key}`)} plain={t('pv.rules.lawPlain')} labels={ds.lawRef} /> })),
            { label: t('pv.rules.pack'), value: t(rules.informationPackDue ? 'pv.rules.packDue' : 'pv.rules.packNone') },
          ]}
        />
        <SummaryTable
          label={t('pv.rules.purposes')}
          columns={[t('pv.rules.purpose'), t('pv.rules.floor'), t('pv.rules.gate')]}
          align={['left', 'left', 'left']}
          stackOnPhone
          rows={rules.purposes.map((entry) => ({ id: entry.purpose, cells: [t(`pv.rules.purposeName.${entry.purpose}`), t(entry.floor ? 'pv.rules.floorYes' : 'pv.rules.floorNo'), entry.gate ? t('pv.rules.gated') : t('pv.rules.notGated')] }))}
        />
        <SummaryTable
          label={t('pv.rules.sites')}
          columns={[t('pv.rules.site'), t('pv.rules.ATTENDANCE'), t('pv.rules.PERFORMANCE')]}
          align={['left', 'left', 'left']}
          stackOnPhone
          rows={rules.sites.map((entry) => ({
            id: entry.site.id,
            cells: [
              entry.site.name,
              ...(['ATTENDANCE', 'PERFORMANCE'] as const).map((purpose) => (
                <Pill key={purpose} tone={entry.open.includes(purpose) ? 'success' : 'neutral'} dot>
                  {t(entry.open.includes(purpose) ? 'pv.rules.on' : 'pv.rules.off')}
                </Pill>
              )),
            ],
          }))}
        />
        <p className="fw-pv-muted">
          <Link href={`${prefix}/people/settings`}>{t('pv.rules.settingsLink')}</Link>
        </p>
      </>
    )
  }
  return (
    <Card header={t('pv.rules.title')} headingLevel={2} description={t('pv.rules.intro')} className="fw-pv-card">
      {body()}
    </Card>
  )
}
