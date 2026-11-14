'use client'

import Link from 'next/link'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, NumberStepper, Skeleton } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { adminHref } from '../../../shared/model'
import type { Read } from '../../model'
import type { SecuritySettings } from '../api'
import { durationWords, lengthChanges, lengthErrors, lengthsOf, lengthsWider, type LengthField, type LengthsDraft } from '../model'
import type { CardState } from '../use-security-settings'
import '../security-depth.css'

export interface SessionLengthsModel {
  prefix: string
  read: Read<SecuritySettings>
  card: CardState<LengthsDraft>
}

export interface SessionLengthsActions {
  onRetry?: () => void
  onChange?: (patch: Partial<LengthsDraft>) => void
  onDiscard?: () => void
  onSave?: () => void
  onDismiss?: () => void
}

/** Each number's control: its unit, the step a click moves, and how the value reads in minutes. */
const FIELDS: ReadonlyArray<{ field: LengthField; audience: 'office' | 'portal'; unit: 'minutes' | 'hours'; step: number }> = [
  { field: 'officeIdleMinutes', audience: 'office', unit: 'minutes', step: 15 },
  { field: 'officeLongestHours', audience: 'office', unit: 'hours', step: 1 },
  { field: 'portalIdleMinutes', audience: 'portal', unit: 'minutes', step: 5 },
  { field: 'portalLongestHours', audience: 'portal', unit: 'hours', step: 1 },
]

/**
 * Admin › Security › Session lengths (SCR-166 section `sessions`, B-W2b-413; PLT-068): the office's and the portal's idle time
 * and longest session as NumberSteppers within the API's bounds, each said in words; the floor's per site read-only (its home
 * is Admin › Devices); EditModeBar to save. Longer = wider: a fresh code first. A viewer without security.settings.manage
 * reads them as text. Words `admin-security-depth` (in the page's provider). Fetches nothing.
 */
export function SessionLengthsCard({ model, actions }: { model: SessionLengthsModel; actions?: SessionLengthsActions }) {
  const t = useT('admin-security-depth')
  const read = model.read
  return (
    <section id="sessions" aria-labelledby="sec-sessions" className="fw-sec-section">
      <Card header={<span id="sec-sessions">{t('lengths.title')}</span>} description={t('lengths.hint')} headingLevel={2} padded>
        {read.state === 'ok' ? (
          <Lengths settings={read.value} model={model} actions={actions} />
        ) : read.state === 'failed' ? (
          <EmptyState title={t('settings.failed.title')} description={t('settings.failed.body')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('session.retry')}</Button>} />
        ) : (
          <div className="fw-sec-depth-stack" aria-busy="true">
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        )}
      </Card>
    </section>
  )
}

function Lengths({ settings, model, actions }: { settings: SecuritySettings; model: SessionLengthsModel; actions?: SessionLengthsActions }) {
  const t = useT('admin-security-depth')
  const card = model.card
  const draft = card.draft ?? lengthsOf(settings)
  const errors = lengthErrors(draft)
  const changes = lengthChanges(settings, draft)
  const wider = lengthsWider(settings, draft)
  const minutesOf = (field: LengthField, value: number) => (field.endsWith('Hours') ? value * 60 : value)
  const errorOf = (field: LengthField) => (errors[field] ? t(errors[field]!) : card.fields[field] ? t(`lengths.error.${card.fields[field]}`) : undefined)
  const block = (audience: 'office' | 'portal') => (
    <div className="fw-sec-depth-block">
      <h3 className="fw-sec-sub">{t(`lengths.audience.${audience}`)}</h3>
      {settings.canChange ? (
        FIELDS.filter((item) => item.audience === audience).map(({ field, unit, step }) => {
          const bound = settings.bounds[field]
          return (
            <Field
              key={field}
              label={t(`lengths.field.${field}`)}
              hint={t('lengths.fieldHint', { now: durationWords(minutesOf(field, draft[field]), t), min: durationWords(minutesOf(field, bound.min), t), max: durationWords(minutesOf(field, bound.max), t) })}
              error={errorOf(field)}
            >
              <NumberStepper
                size="sm"
                value={draft[field]}
                min={bound.min}
                max={bound.max}
                step={step}
                suffix={t(`lengths.unit.${unit}`)}
                decrementLabel={t('lengths.less')}
                incrementLabel={t('lengths.more')}
                onChange={(next) => actions?.onChange?.({ [field]: next })}
              />
            </Field>
          )
        })
      ) : (
        <KeyValue
          labelCase="sentence"
          items={FIELDS.filter((item) => item.audience === audience).map(({ field }) => ({ label: t(`lengths.field.${field}`), value: durationWords(minutesOf(field, draft[field]), t) }))}
        />
      )}
    </div>
  )
  return (
    <div className="fw-sec-depth-stack">
      {card.notice && <Banner tone={card.notice.tone} title={t(card.notice.key)} onDismiss={actions?.onDismiss} />}
      {card.problem && <Banner tone={card.problem === 'settings.problem.stale' ? 'warning' : 'danger'} title={t(card.problem)} onDismiss={actions?.onDismiss} />}
      <div className="fw-sec-depth-pair">
        {block('office')}
        {block('portal')}
      </div>
      <div className="fw-sec-depth-block">
        <h3 className="fw-sec-sub">{t('lengths.audience.floor')}</h3>
        {settings.sessions.floor.length === 0 ? (
          <p className="fw-adm-hint">{t('lengths.floor.none')}</p>
        ) : (
          <SummaryTable
            label={t('lengths.audience.floor')}
            density="roomy"
            stackOnPhone
            columns={[t('lengths.floor.site'), t('lengths.floor.idle'), t('lengths.floor.ends')]}
            widths={['40%', '25%', '35%']}
            align={['left', 'left', 'left']}
            rows={settings.sessions.floor.map((site) => ({
              id: site.siteId,
              cells: [
                <span key="site">{`${site.code} · ${site.name}`}</span>,
                <span key="idle">{durationWords(site.idleMinutes, t)}</span>,
                <span key="ends">{site.shiftEnds.length > 0 ? t('lengths.floor.shiftEnds', { times: site.shiftEnds.join(', ') }) : t('lengths.floor.noShiftEnd')}</span>,
              ],
            }))}
          />
        )}
        <p className="fw-adm-hint">
          {t('lengths.floor.where')}{' '}
          <Link href={adminHref(model.prefix, '/devices')}>{t('lengths.floor.toDevices')}</Link>
        </p>
      </div>
      {settings.canChange ? (
        changes > 0 ? (
          <>
            {wider && <Banner tone="info" title={t('lengths.wider')} />}
            <EditModeBar
              count={changes}
              onDiscard={() => actions?.onDiscard?.()}
              onApply={() => actions?.onSave?.()}
              applyLabel={t(wider ? 'lengths.saveWider' : 'lengths.save')}
              applyHeldReason={Object.keys(errors).length > 0 ? t('lengths.held.fix') : null}
              busy={card.busy}
              saveShortcut
            />
          </>
        ) : (
          <p className="fw-adm-hint">{t('lengths.rule')}</p>
        )
      ) : (
        <p className="fw-adm-hint">{t('lengths.viewOnly')}</p>
      )}
    </div>
  )
}
