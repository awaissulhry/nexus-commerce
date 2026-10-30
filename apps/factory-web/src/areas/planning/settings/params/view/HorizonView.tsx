'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Input, NumberStepper, SegmentedControl } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { PlanningSite, SiteSettings } from '../../api'
import { manageHeld, type SettingsCan } from '../../model'
import { Loading, ReadFailed, SaveBar } from '../../view/parts'
import { draftPreview, horizonChanged, horizonDraftOf, horizonProblems, PARAMS_NAMESPACES, previewOfBuckets, type BucketPreview, type HorizonDraft, type HorizonField, type Notice, type Words } from '../model'
import { ElsewhereBanner, NoticeBanner, useSay } from './cells'
import '../params.css'

/** The ONE view model of Horizon & fences. It fetches nothing; the form's draft is the view's own until Save. */
export interface HorizonModel {
  site: PlanningSite
  can: SettingsCan
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  read: SiteSettings | null
  busy: boolean
  notice: Notice | null
  changedElsewhere: boolean
  /** The API's refusal at a field (400 `body/<field>`). */
  refused?: Partial<Record<HorizonField, Words>>
  /** Design cases: a draft typed. */
  draft?: HorizonDraft
}

export interface HorizonActions {
  onRetry?: () => void
  onReload?: () => void
  /** The form changed: how many fields differ from what was read. */
  onChanged?: (count: number) => void
  onSave?: (draft: HorizonDraft) => void
  onDismissNotice?: () => void
}

export function HorizonView({ model, actions }: { model: HorizonModel; actions?: HorizonActions }) {
  return (
    <WithMessages namespaces={PARAMS_NAMESPACES}>
      <Horizon model={model} actions={actions} />
    </WithMessages>
  )
}

const dayText = (date: string, locale: string) => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))

function Horizon({ model, actions }: { model: HorizonModel; actions?: HorizonActions }) {
  const t = useT('planning-params')
  const ts = useT('planning-settings')
  if (model.load.status === 'loading' || (model.load.status === 'ready' && !model.read))
    return (
      <Card padded>
        <Loading rows={6} />
      </Card>
    )
  if (model.load.status === 'error') return <ReadFailed title={t('pp.horizon.failed')} problem={model.load.problem} onRetry={actions?.onRetry} />
  return <HorizonForm model={model} read={model.read!} actions={actions} t={t} ts={ts} />
}

function HorizonForm({ model, read, actions, t, ts }: { model: HorizonModel; read: SiteSettings; actions?: HorizonActions; t: ReturnType<typeof useT>; ts: ReturnType<typeof useT> }) {
  const say = useSay()
  const locale = INTL_LOCALE[useLocale()]
  const readDraft = useMemo(() => horizonDraftOf(read.settings), [read])
  const [draft, setDraft] = useState<HorizonDraft>(model.draft ?? readDraft)
  const changed = horizonChanged(read.settings, draft)
  // A new read (saved, or Reload): the form follows it unless the person has edits waiting (kept).
  const previous = useRef(readDraft)
  useEffect(() => {
    const old = previous.current
    previous.current = readDraft
    setDraft((current) => (JSON.stringify(current) === JSON.stringify(old) ? readDraft : current))
  }, [readDraft])
  useEffect(() => actions?.onChanged?.(changed.length), [changed.length])
  const held = manageHeld('horizon', model.can)
  const can = !held
  const problems = horizonProblems(draft)
  const problemCount = Object.keys(problems).length
  const errorOf = (field: HorizonField) => (problems[field] ? say(problems[field]) : model.refused?.[field] ? say(model.refused[field]) : undefined)
  const set = (patch: Partial<HorizonDraft>) => {
    if (can) setDraft((current) => ({ ...current, ...patch }))
  }
  const preview: BucketPreview | null = changed.length === 0 ? previewOfBuckets(read.horizon.buckets, read.horizon.to) : draftPreview(draft, read.horizon.from)
  const nightly = draft.scheduledRunTime.trim() !== ''

  return (
    <section className="fw-pp" aria-label={t('pp.horizon.title')}>
      {model.changedElsewhere && <ElsewhereBanner onReload={actions?.onReload} />}
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {!can && <Banner tone="neutral" title={t('pp.readOnly.title')}>{ts(held!)}</Banner>}
      <div className="fw-pp-cards">
        <Card padded>
          <div className="fw-pp-form">
            <h2 className="fw-pp-h">{t('pp.horizon.bucketsTitle')}</h2>
            <p className="fw-ps-hint">{read.settings.isDefault ? t('pp.horizon.isDefault') : t('pp.horizon.hint')}</p>
            <div className="fw-pp-fields">
              <Field label={t('pp.field.horizonWeeks')} hint={t('pp.horizon.horizonHint')} error={errorOf('horizonWeeks')} required>
                <NumberStepper value={draft.horizonWeeks} min={1} max={104} suffix={t('pp.weeks')} readOnly={!can} onChange={(next) => set({ horizonWeeks: next })} decrementLabel={t('pp.less')} incrementLabel={t('pp.more_')} />
              </Field>
              <Field label={t('pp.field.dayBucketWeeks')} hint={t('pp.horizon.dayHint')} error={errorOf('dayBucketWeeks')} required>
                <NumberStepper value={draft.dayBucketWeeks} min={0} max={104} suffix={t('pp.weeks')} readOnly={!can} onChange={(next) => set({ dayBucketWeeks: next })} decrementLabel={t('pp.less')} incrementLabel={t('pp.more_')} />
              </Field>
              <Field label={t('pp.field.weekBucketWeeks')} hint={t('pp.horizon.weekHint')} error={errorOf('weekBucketWeeks')} required>
                <NumberStepper value={draft.weekBucketWeeks} min={0} max={104} suffix={t('pp.weeks')} readOnly={!can} onChange={(next) => set({ weekBucketWeeks: next })} decrementLabel={t('pp.less')} incrementLabel={t('pp.more_')} />
              </Field>
            </div>
            <div className="fw-pp-preview" role="status" aria-live="polite">
              {preview ? (
                <>
                  <span className="fw-pp-preview-title">{t('pp.horizon.preview')}</span>
                  <span>
                    {[
                      preview.days ? t('pp.horizon.days', { count: preview.days.count, to: dayText(preview.days.to, locale) }) : null,
                      preview.weeks ? t('pp.horizon.weeksTo', { count: preview.weeks.count, to: dayText(preview.weeks.to, locale) }) : null,
                      preview.months ? t('pp.horizon.months', { count: preview.months.count, to: dayText(preview.months.to, locale) }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </>
              ) : (
                <span className="fw-ps-hint">{t('pp.horizon.noPreview')}</span>
              )}
            </div>
          </div>
        </Card>
        <Card padded>
          <div className="fw-pp-form">
            <h2 className="fw-pp-h">{t('pp.horizon.runTitle')}</h2>
            <div className="fw-pp-fields">
              <Field label={t('pp.field.defaultEfficiencyPct')} hint={t('pp.horizon.efficiencyHint')} error={errorOf('defaultEfficiencyPct')} required>
                <Input inputMode="decimal" suffix="%" value={draft.defaultEfficiencyPct} readOnly={!can} onChange={(event) => set({ defaultEfficiencyPct: event.target.value })} />
              </Field>
              <Field label={t('pp.field.scheduledRunTime')} hint={nightly ? t('pp.horizon.runHint', { zone: read.site.timeZone }) : t('pp.horizon.onDemandHint')} error={errorOf('scheduledRunTime')}>
                <span className="fw-pp-row">
                  <SegmentedControl
                    size="sm"
                    ariaLabel={t('pp.field.scheduledRunTime')}
                    value={nightly ? 'nightly' : 'demand'}
                    disabled={!can}
                    options={[
                      { value: 'demand', label: t('pp.horizon.onDemand') },
                      { value: 'nightly', label: t('pp.horizon.nightly') },
                    ]}
                    onChange={(value) => set({ scheduledRunTime: value === 'nightly' ? (read.settings.scheduledRunTime ?? '02:00') : '' })}
                  />
                  {nightly && <Input type="time" step={60} aria-label={t('pp.horizon.runAt')} value={draft.scheduledRunTime} readOnly={!can} onChange={(event) => set({ scheduledRunTime: event.target.value })} />}
                </span>
              </Field>
            </div>
            <p className="fw-pp-later">{t('pp.horizon.fencesLater')}</p>
          </div>
        </Card>
      </div>
      {can && changed.length > 0 && (
        <SaveBar
          count={changed.length}
          busy={model.busy}
          held={problemCount > 0 ? t('pp.horizon.fixFirst', { count: problemCount }) : null}
          onDiscard={() => setDraft(readDraft)}
          onSave={() => actions?.onSave?.(draft)}
        />
      )}
    </section>
  )
}
