'use client'

import { GitCompare, History } from 'lucide-react'
import { Card, ChangeReview, EmptyState } from '@nexus/ui/components'
import { Select } from '@nexus/ui/primitives'
import { Timeline } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { KpiRecord } from '../api'
import { defaultCompare, versionChanges, versionEvents, type KpiAddress } from '../model'

/**
 * SCR-470 › History (design home.kpis rec:KPI/history, "changes to the definition, so an old number can be explained"): every
 * version written, put in force, superseded or withdrawn, newest first, with who and when and what changed (a Timeline),
 * beside two versions compared field by field (ChangeReview: the words in both languages, the records, the facts, unit,
 * rights and owner). The pair compared lives in the address (`?compare=1-2`); by default the version shown and the one
 * before it.
 */
export function HistoryTab({ record, address, now, onAddress }: { record: KpiRecord; address: KpiAddress; now?: number; onAddress?: (address: KpiAddress) => void }) {
  const t = useT('home-kpis')
  const locale = useLocale()
  const events = versionEvents(record.versions)
  const numbers = record.versions.map((version) => version.kpiVersion).sort((a, b) => a - b)
  const known = (pair: readonly [number, number] | null) => (pair && numbers.includes(pair[0]) && numbers.includes(pair[1]) && pair[0] !== pair[1] ? pair : null)
  const pair = known(address.compare) ?? defaultCompare(record.versions)
  const before = pair ? record.versions.find((version) => version.kpiVersion === pair[0])! : null
  const after = pair ? record.versions.find((version) => version.kpiVersion === pair[1])! : null
  const changes = before && after ? versionChanges(before, after, t, locale) : []

  if (record.versions.length === 0) {
    return (
      <Card padded>
        <EmptyState icon={<History size={22} aria-hidden />} title={t('history.empty')} description={t('history.emptyBody')} />
      </Card>
    )
  }

  const tone = (what: (typeof events)[number]['what']) => (what === 'IN_FORCE' ? 'success' : what === 'RETIRED' ? 'warning' : what === 'WRITTEN' ? 'info' : 'neutral')
  const pick = (index: 0 | 1, value: string) => {
    if (!pair) return
    const next: [number, number] = [pair[0], pair[1]]
    next[index] = Number(value)
    onAddress?.({ ...address, compare: next })
  }

  return (
    <div className="fw-kpi-split">
      <Card padded>
        <section className="fw-kpi-card" aria-labelledby="fw-kpi-versions">
          <div className="fw-kpi-head">
            <h2 id="fw-kpi-versions" className="fw-kpi-h">
              <History size={16} aria-hidden /> {t('history.title')}
            </h2>
            <p className="fw-kpi-muted">{t('history.intro')}</p>
          </div>
          <Timeline
            label={t('history.title')}
            now={now}
            steps={events.map((event) => ({
              key: event.key,
              tone: tone(event.what),
              at: event.at,
              label: t(`history.what.${event.what}`, { version: event.kpiVersion }),
              detail: [event.by ? t('history.by', { name: event.by }) : null, event.note ? t('history.note', { note: event.note }) : null].filter(Boolean).join(' · ') || undefined,
            }))}
          />
        </section>
      </Card>

      <Card padded>
        <section className="fw-kpi-card" aria-labelledby="fw-kpi-compare">
          <div className="fw-kpi-head">
            <h2 id="fw-kpi-compare" className="fw-kpi-h">
              <GitCompare size={16} aria-hidden /> {t('history.compare')}
            </h2>
            <p className="fw-kpi-muted">{t('history.compareIntro')}</p>
          </div>
          {!pair || !before || !after ? (
            <EmptyState icon={<GitCompare size={22} aria-hidden />} title={t('history.oneVersion')} description={t('history.oneVersionBody')} />
          ) : (
            <>
              <div className="fw-kpi-row">
                <label className="fw-kpi-row">
                  <span className="fw-kpi-muted">{t('history.from')}</span>
                  <Select size="sm" value={String(pair[0])} onChange={(event) => pick(0, event.target.value)}>
                    {numbers.filter((n) => n !== pair[1]).map((n) => (
                      <option key={n} value={n}>
                        {t('history.versionOption', { version: n, state: t(`state.${record.versions.find((version) => version.kpiVersion === n)!.state}`) })}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="fw-kpi-row">
                  <span className="fw-kpi-muted">{t('history.to')}</span>
                  <Select size="sm" value={String(pair[1])} onChange={(event) => pick(1, event.target.value)}>
                    {numbers.filter((n) => n !== pair[0]).map((n) => (
                      <option key={n} value={n}>
                        {t('history.versionOption', { version: n, state: t(`state.${record.versions.find((version) => version.kpiVersion === n)!.state}`) })}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              {after.changeNote && <p className="fw-kpi-muted">{t('history.changeNote', { version: after.kpiVersion, note: after.changeNote })}</p>}
              {changes.length === 0 ? (
                <p className="fw-kpi-muted" role="status">
                  {t('history.same')}
                </p>
              ) : (
                <ChangeReview
                  label={t('history.compare')}
                  tick={false}
                  selectedIds={[]}
                  onSelectionChange={() => undefined}
                  items={changes.map((change) => ({
                    id: change.field,
                    label: t(`field.${change.field}`),
                    status: t('history.changed'),
                    note: t('history.changedNote', { from: before.kpiVersion, to: after.kpiVersion }),
                    selectable: false,
                    values: [
                      { label: t('history.versionN', { version: before.kpiVersion }), value: <span className="fw-kpi-text">{change.before}</span> },
                      { label: t('history.versionN', { version: after.kpiVersion }), value: <span className="fw-kpi-text">{change.after}</span> },
                      { label: t('history.written'), value: after.createdBy ? t('history.writtenBy', { name: after.createdBy, day: formatDate(after.createdAt, { locale }) }) : formatDate(after.createdAt, { locale }) },
                    ],
                  }))}
                />
              )}
            </>
          )}
        </section>
      </Card>
    </div>
  )
}
