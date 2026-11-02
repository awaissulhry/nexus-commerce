'use client'

import { Printer, RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { RollCall } from '../../api'
import { timeOf, type AttendanceCan } from '../../model'
import { AttendanceMessages, GateHeld, useAttendanceWords } from '../../view/parts'

/** SCR-157-rollcall — one view model, nothing fetched. */
export interface RollCallModel {
  allowed: boolean
  can: AttendanceCan
  prefix: string
  site: string
  gate: 'reading' | 'open' | 'closed' | 'pickSite' | 'failed'
  list: RollCall | null
  problem: string | null
  /** The last read failed: this is the last known list. */
  stale: boolean
  reading: boolean
}

export function RollCallView({ model, onRefresh }: { model: RollCallModel; onRefresh?: () => void }) {
  return (
    <AttendanceMessages>
      <Roll model={model} onRefresh={onRefresh} />
    </AttendanceMessages>
  )
}

function Roll({ model, onRefresh }: { model: RollCallModel; onRefresh?: (() => void) | undefined }) {
  const t = useAttendanceWords()
  const ds = useDsWords()
  const locale = useLocale()
  const { list } = model
  if (!model.allowed) return <EmptyState title={t('problem.forbidden')} description={t('roll.noRight')} />
  return (
    <article className="fw-at-tab">
      <header className="fw-pp-head">
        <div>
          <h1 className="fw-at-title">{t('roll.title', { site: model.site })}</h1>
          {list && <p className="fw-pp-hint">{t('roll.count', { count: list.people, time: timeOf(list.asOf, locale) })}</p>}
        </div>
        <span className="fw-pp-actions fw-at-noprint">
          <Button size="sm" variant="secondary" onClick={onRefresh} heldReason={model.reading ? t('held.working') : model.gate === 'open' ? null : t('held.notRead')}>
            <RefreshCw size={14} aria-hidden /> {t('roll.refresh')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => window.print()} heldReason={list ? null : t('held.notRead')}>
            <Printer size={14} aria-hidden /> {t('roll.print')}
          </Button>
        </span>
      </header>
      <PrivacyNote level="protected" recorded text={t('roll.note')} whoMore={t('roll.who')} law={<LawRef law="D.Lgs. 81/2008 art. 43" plain={t('law.evacuation')} labels={ds.lawRef} />} labels={ds.privacyNote} />
      {model.stale && list && <Banner tone="warning" title={t('roll.stale', { time: timeOf(list.asOf, locale) })} />}
      {model.gate === 'closed' || model.gate === 'pickSite' || model.gate === 'failed' ? (
        <GateHeld gate={model.gate} prefix={model.prefix} can={model.can} />
      ) : model.problem ? (
        <Banner
          tone="danger"
          title={t('roll.failed')}
          action={
            <Button size="sm" onClick={onRefresh}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem)}
        </Banner>
      ) : !list ? (
        <p className="fw-pp-hint" role="status">
          <Spinner size={14} /> {t('roll.reading')}
        </p>
      ) : list.people === 0 ? (
        <Card padded>
          <p className="fw-pp-text">{t('roll.nobody')}</p>
        </Card>
      ) : (
        <div className="fw-at-roll">
          {list.groups.map((group) => (
            <Card key={`${group.areaId ?? 'none'}:${group.lineId ?? 'none'}`} padded>
              <h2 className="fw-at-sub">
                {[group.areaName, group.lineName].filter(Boolean).join(' › ') || t('who.noLine')} · {group.people.length}
              </h2>
              <ul>
                {group.people.map((person) => (
                  <li key={person.employeeId}>
                    <span>{person.name}</span>
                    {person.onBreak && <Tag tone="info">{t('roll.onBreak')}</Tag>}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </article>
  )
}
