'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CalendarRange, History, Printer } from 'lucide-react'
import { Card, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import { Button, Select, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PlanningSite } from '../api'
import { auditHref, PLANNING_SETTINGS_NAMESPACES, settingsHref, SETTINGS_TABS, type SaveStatus, type SettingsCan, type SettingsTab } from '../model'
import { NoAccess, ReadFailed, SaveWords } from './parts'
import '../planning-settings.css'

export interface PlanningSettingsModel {
  /** `/w/<company>`. */
  prefix: string
  can: SettingsCan
  tab: SettingsTab
  sites: { status: 'loading' } | { status: 'ready'; items: readonly PlanningSite[] } | { status: 'error'; problem: string }
  /** The site shown (the address's, else the first). */
  siteId: string | null
  status: SaveStatus | null
  /** The record the band's "Changed by …" opens in the audit log (the tab's). */
  audit?: { type: string; id: string | null } | null
}

export interface PlanningSettingsActions {
  onSite?: (siteId: string) => void
  onRetry?: () => void
}

const TAB_AUDIT: Record<SettingsTab, string> = {
  calendars: 'WorkCalendar',
  items: 'ItemPlanning',
  reorder: 'ItemPlanning',
  horizon: 'PlanningSettings',
  efficiency: 'LineCapacity',
}

/**
 * Planning › Planning settings (design planning.settings, settings-form; SCR-124 + SCR-127): one site at a time (a
 * picker when the person plans at several), the save status in words, "Changed by …" (the audit log), "Plant calendar
 * (print)" on the calendars tab (a new tab), and the five link tabs of the design — Calendars & shifts · Item
 * parameters · Reorder rules · Horizon & fences · Line efficiency (← / → move between them). The tab's body is passed
 * in (`children`): each tab has its own container and view. Fetches nothing.
 */
export function PlanningSettingsView({ model, actions, children }: { model: PlanningSettingsModel; actions?: PlanningSettingsActions; children?: ReactNode }) {
  return (
    <WithMessages namespaces={PLANNING_SETTINGS_NAMESPACES}>
      <Frame model={model} actions={actions}>
        {children}
      </Frame>
    </WithMessages>
  )
}

function Frame({ model, actions, children }: { model: PlanningSettingsModel; actions?: PlanningSettingsActions; children?: ReactNode }) {
  const t = useT('planning-settings')
  if (!model.can.view) return <div className="fw-ps">{<NoAccess title={t('ps.noAccess.title')} body={t('ps.noAccess.body')} />}</div>
  if (model.sites.status === 'loading')
    return (
      <div className="fw-ps" aria-busy="true">
        <Skeleton height={32} width="40%" />
        <Skeleton height={36} />
        <Skeleton height={420} />
      </div>
    )
  if (model.sites.status === 'error')
    return (
      <div className="fw-ps">
        <ReadFailed title={t('ps.sitesFailed')} problem={model.sites.problem} onRetry={actions?.onRetry} />
      </div>
    )
  const sites = model.sites.items
  if (sites.length === 0)
    return (
      <div className="fw-ps">
        <Card padded>
          <EmptyState
            icon={<CalendarRange size={22} aria-hidden />}
            title={t('ps.noSites.title')}
            description={t('ps.noSites.body')}
            action={
              <Button size="sm" asChild>
                <Link href={`${model.prefix}/admin/companies`}>{t('ps.noSites.action')}</Link>
              </Button>
            }
          />
        </Card>
      </div>
    )

  const site = sites.find((entry) => entry.id === model.siteId) ?? sites[0]!
  const tabs: TabItem[] = SETTINGS_TABS.map((tab) => ({ id: tab, label: t(`ps.tab.${tab}`), href: settingsHref(model.prefix, site.id, tab) }))
  const audit = model.audit ?? { type: TAB_AUDIT[model.tab], id: model.tab === 'horizon' ? site.id : null }

  return (
    <div className="fw-ps">
      <div className="fw-ps-head">
        <span className="fw-ps-head-left">
          {sites.length > 1 ? (
            <Select size="sm" aria-label={t('ps.site')} value={site.id} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {t('ps.siteOption', { code: entry.code, name: entry.name })}
                </option>
              ))}
            </Select>
          ) : (
            <span className="fw-ps-site">{t('ps.siteOption', { code: site.code, name: site.name })}</span>
          )}
          <SaveWords status={model.status} timeZone={site.timeZone} />
        </span>
        <span className="fw-ps-actions">
          {model.tab === 'calendars' && model.can.calendars && (
            <Button size="sm" variant="quiet" asChild>
              <a href={`${model.prefix}/planning/settings/calendar-print?site=${encodeURIComponent(site.id)}`} target="_blank" rel="noopener">
                <Printer size={14} aria-hidden /> {t('ps.print')}
              </a>
            </Button>
          )}
          {model.can.audit && (
            <Button size="sm" variant="quiet" asChild>
              <Link href={auditHref(model.prefix, audit.type, audit.id)}>
                <History size={14} aria-hidden /> {t('ps.changedBy')}
              </Link>
            </Button>
          )}
        </span>
      </div>
      <Tabs ariaLabel={t('ps.tabs')} tabs={tabs} active={model.tab} overflow="scroll" />
      <div className="fw-ps-body">{children}</div>
    </div>
  )
}
