'use client'

import { ShieldOff } from 'lucide-react'
import { Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { INCIDENT_KINDS } from '../depth-api'
import type { DepthActions, DepthModel } from '../depth-view-model'
import { CardHead, SectionState, useSettingsWords } from './parts'

/**
 * Incidents (design plant.settings sec:incidents, QHS-268): the kinds of report and the INAIL rule's parameters shown
 * with their law, read from the API (`GET /safety/incidents/rules`) — never a number of this screen's own. The law sets
 * them, so nothing here changes them (the design's "a change needs step-up" has nothing to act on: no setting holds
 * them; B-W2b-125). The reminder hours are Nexus's own, said apart from the law's. Needs safety.incidents.view.
 */
export function IncidentsCard({ depth, actions }: { depth: DepthModel; actions?: DepthActions }) {
  const t = useSettingsWords()
  const ds = useDsWords()
  const locale = useLocale()
  const read = depth.incidents
  return (
    <Card padded>
      <section className="fw-pls-stack" aria-labelledby="fw-pls-incidents" data-pls-section="incidents">
        <CardHead id="fw-pls-incidents" title={t('incidents.title')} purpose={t('incidents.purpose')} />
        {read.status === 'forbidden' ? (
          <EmptyState icon={<ShieldOff size={20} aria-hidden />} title={t('incidents.noRight')} description={t('incidents.noRightBody')} />
        ) : (
          <SectionState read={read} title={t('incidents.title')} onRetry={() => actions?.onIncidentsRetry?.()}>
            {(value) => {
              const plain = (locale === 'it' ? value.rule.words.it : value.rule.words.en).join(' ')
              const hours = value.reminders.hoursBefore.filter((entry) => entry > 0).sort((a, b) => b - a)
              return (
                <>
                  <div className="fw-pls-kinds" role="group" aria-label={t('incidents.kinds')}>
                    <span className="fw-pls-label">{t('incidents.kinds')}</span>
                    {INCIDENT_KINDS.map((kind) => (
                      <Tag key={kind} tone={kind === 'INJURY' ? 'danger' : kind === 'NEAR_MISS' ? 'warning' : 'info'}>
                        {t(`incidents.kind.${kind}`)}
                      </Tag>
                    ))}
                  </div>
                  <div className="fw-pls-lawline">
                    <LawRef law={value.rule.law} plain={plain} labels={ds.lawRef} />
                    <span className="fw-pls-hint">{t('incidents.lawSays')}</span>
                  </div>
                  <KeyValue
                    columns={1}
                    items={[
                      { label: t('incidents.statistical'), value: t('incidents.statisticalValue', { count: value.rule.statisticalFromDays }) },
                      { label: t('incidents.insurance'), value: t('incidents.insuranceValue', { count: value.rule.insuranceAboveDays }) },
                      { label: t('incidents.window'), value: t('incidents.windowValue', { count: value.rule.hoursAfterCertificate }) },
                    ]}
                  />
                  <p className="fw-pls-hint">{t('incidents.fixed')}</p>
                  <KeyValue
                    columns={1}
                    items={[
                      { label: t('incidents.reminders'), value: hours.length > 0 ? t('incidents.remindersValue', { hours: hours.join(' · ') }) : t('incidents.remindersDeadline'), hint: t('incidents.remindersHint') },
                      {
                        label: t('incidents.anonymous'),
                        value: value.floor.anonymousKinds.length > 0 ? value.floor.anonymousKinds.map((kind) => t(`incidents.kind.${kind}`)).join(' · ') : t('incidents.anonymousNone'),
                        hint: t('incidents.anonymousHint'),
                      },
                      { label: t('incidents.photos'), value: t('incidents.photosValue', { count: value.floor.photos, minutes: value.floor.photoMinutes }) },
                      { label: t('incidents.emergency'), value: value.floor.emergencyNumber },
                    ]}
                  />
                  <div className="fw-pls-lawline">
                    <LawRef law={value.law.people} plain={t('incidents.peoplePlain')} labels={ds.lawRef} />
                    <span className="fw-pls-hint">{t('incidents.people')}</span>
                  </div>
                </>
              )
            }}
          </SectionState>
        )}
      </section>
    </Card>
  )
}
