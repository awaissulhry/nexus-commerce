'use client'

import Link from 'next/link'
import { BarChart3, BellRing, Globe, LayoutDashboard, Share2 } from 'lucide-react'
import { Card, EmptyState, PressableRow } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { KpiRecord, KpiUseKind } from '../api'
import { useOf } from '../model'

/**
 * SCR-470 › Where used (design home.kpis rec:KPI/used-in): every dashboard, report and alert that reads this KPI, with since
 * when. A use whose page is built opens it (a PressableRow); one whose page comes later is said without a door. The uses
 * are kept by the metric layer (POST /insights/kpis/sync keeps them in step with what reads the KPI in force).
 */

const ICON: Record<KpiUseKind, typeof LayoutDashboard> = { DASHBOARD: LayoutDashboard, REPORT: BarChart3, ALERT: BellRing, PORTAL: Globe }

export function UsesTab({ record, built, ruleKinds, prefix, onOpen }: { record: KpiRecord; built: ReadonlySet<string>; ruleKinds: readonly string[]; prefix: string; onOpen?: (href: string) => void }) {
  const t = useT('home-kpis')
  const reports = useT('home-reports')
  const locale = useLocale()

  if (record.usedIn.length === 0) {
    return (
      <Card padded>
        <EmptyState
          icon={<Share2 size={22} aria-hidden />}
          title={t('uses.empty')}
          description={t('uses.emptyBody')}
          action={
            built.has('/home/reports') ? (
              <Button size="sm" asChild>
                <Link href={`${prefix}/home/reports`}>{t('uses.toReports')}</Link>
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  }

  return (
    <Card padded>
      <section className="fw-kpi-card" aria-labelledby="fw-kpi-uses">
        <div className="fw-kpi-head">
          <h2 id="fw-kpi-uses" className="fw-kpi-h">
            <Share2 size={16} aria-hidden /> {t('uses.title')}
          </h2>
          <p className="fw-kpi-muted">{t('uses.intro')}</p>
        </div>
        <div className="fw-kpi-uses" role="list" aria-label={t('uses.title')}>
          {record.usedIn.map((use) => {
            const said = useOf(use, built, ruleKinds)
            const Icon = ICON[use.usedIn]
            const name = said.word ? (said.word.namespace === 'home-reports' ? reports(said.word.key) : t(said.word.key)) : t(`use.unnamed.${use.usedIn}`)
            const known = said.word !== null && name !== said.word.key
            const named = known ? name : t(`use.unnamed.${use.usedIn}`)
            // A use this app cannot name opens nothing (its page would not know it either).
            const href = known ? said.href : null
            const details = (
              <span className="fw-kpi-tags">
                <Tag tone="neutral">{t(`useKind.${use.usedIn}`)}</Tag>
                <span className="fw-kpi-muted">{t('uses.since', { day: formatDate(use.since, { locale }) })}</span>
                {!href && <span className="fw-kpi-muted">{t(`uses.noPage.${use.usedIn}`)}</span>}
              </span>
            )
            return (
              <div role="listitem" key={`${use.usedIn}:${use.useKey}`}>
                {href ? (
                  <PressableRow
                    leading={<Icon size={16} aria-hidden />}
                    label={named}
                    description={t('uses.open')}
                    onClick={() => onOpen?.(href)}
                  >
                    {details}
                  </PressableRow>
                ) : (
                  <div className="fw-kpi-use-label">
                    <Icon size={16} aria-hidden />
                    <span className="fw-kpi-head">
                      <strong>{named}</strong>
                      {details}
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </Card>
  )
}
