'use client'

import { useMemo } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { CalendarGrid } from '@nexus/ui/components/CalendarGrid/index'
import { Button, Checkbox, Input, Pill, Tag, Textarea } from '@nexus/ui/primitives'
import { useCalendarWords } from '../../../../_shared/calendar-grid/words'
import { countryName } from '../../../../parties/_shared/model'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { KINDS, TANNAGE_CODES, type SupplierProfile } from '../api'
import {
  CLOSURE_KINDS,
  changedFields,
  clearsTanneryFacts,
  closureDays,
  isTannery,
  newOrderWords,
  profileProblems,
  STATUS_TONE,
  weekKindsOf,
  type ProfileDraft,
  type Read,
  type Words,
} from '../model'
import { DepthCard, ReadOr, useSay } from './parts'

export interface ProfileCardModel {
  readonly read: Read<SupplierProfile>
  /** The draft being typed (null: as read). */
  readonly draft: ProfileDraft | null
  /** Why the card is read-only, or null. */
  readonly held: Words | null
  /** Why Change status is held, or null. */
  readonly statusHeld: Words | null
  readonly saving: boolean
  /** The last save's refusal (a `problem.*` key) and the fields it named. */
  readonly failed: string | null
  readonly refused: readonly string[]
  /** Show every field's problem (after a first Save). */
  readonly tried: boolean
  readonly today: string
}

export interface ProfileCardActions {
  onDraft?: (draft: ProfileDraft) => void
  onSave?: () => void
  onDiscard?: () => void
  onRetry?: () => void
  onStatus?: () => void
}

/**
 * Overview › the supplier in depth (design purchasing.suppliers rec:Supplier/overview/main, the W2b lines): its kinds (one
 * or more, a Checkbox each), its default lead time, where it stands with us (the status pill, since when and why, and
 * Change status), where it makes what it sells us (the country, region and words; for a tannery the raw hides' countries
 * and the tannages) and its closures (the DS CalendarGrid, a month at a time, and when an order placed today arrives).
 * One EditModeBar (⌘S) saves kinds, lead time and origin together at the party's version. A role without parties.manage
 * reads it as text, with the reason.
 */
export function ProfileCard({ model, actions }: { model: ProfileCardModel; actions?: ProfileCardActions }) {
  const { t, say } = useSay()
  const title = t('profile.title')
  return (
    <DepthCard title={title} hint={t('profile.hint')}>
      <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={title} onRetry={actions?.onRetry} rows={6}>
        {model.read.status === 'ready' ? <ProfileBody profile={model.read.value} model={model} actions={actions} /> : null}
      </ReadOr>
      {model.held && model.read.status === 'ready' ? <p className="fw-spd-hint">{say(model.held)}</p> : null}
    </DepthCard>
  )
}

function ProfileBody({ profile, model, actions }: { profile: SupplierProfile; model: ProfileCardModel; actions?: ProfileCardActions | undefined }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const draft = model.draft ?? null
  const editing = model.held === null
  const shown = draft ?? null
  const problems = shown ? profileProblems(shown) : {}
  const count = shown ? changedFields(profile, shown) : 0
  const problemCount = Object.keys(problems).length
  const field = (name: string) => (problems[name] && (model.tried || model.refused.includes(name)) ? say(problems[name]) : model.refused.includes(name) ? t('profile.refused') : undefined)
  const current = shown ?? {
    kinds: profile.kinds,
    leadTimeDays: profile.leadTimeDays === null ? '' : String(profile.leadTimeDays),
    originCountry: profile.origin.country ?? '',
    originRegion: profile.origin.region ?? '',
    originNote: profile.origin.note ?? '',
    hideCountries: profile.origin.hideCountries.join(', '),
    tannages: profile.origin.tannages,
  }
  const set = (patch: Partial<ProfileDraft>) => actions?.onDraft?.({ ...current, ...patch })
  const tannery = isTannery(current.kinds)

  const kinds = editing ? (
    <fieldset className="fw-spd-checks">
      <legend className="fw-spd-legend">{t('profile.kinds')}</legend>
      {KINDS.map((kind) => (
        <Checkbox
          key={kind}
          label={t(`kind.${kind}`)}
          checked={current.kinds.includes(kind)}
          onChange={(event) => set({ kinds: event.target.checked ? [...current.kinds, kind] : current.kinds.filter((item) => item !== kind) })}
        />
      ))}
      {field('kinds') ? <p className="fw-spd-error">{field('kinds')}</p> : null}
    </fieldset>
  ) : null

  return (
    <div className="fw-spd-stack">
      <StatusRow profile={profile} held={model.statusHeld} onStatus={actions?.onStatus} />
      {editing ? (
        <div className="fw-spd-grid">
          <div className="fw-spd-stack">
            {kinds}
            <Field label={t('profile.leadTime')} hint={t('profile.leadTimeHint')} error={field('leadTimeDays')}>
              <Input inputMode="numeric" value={current.leadTimeDays} onChange={(event) => set({ leadTimeDays: event.target.value })} />
            </Field>
          </div>
          <div className="fw-spd-stack">
            <Field label={t('profile.country')} hint={current.originCountry.length === 2 ? countryName(current.originCountry.toUpperCase(), locale) : t('profile.countryHint')} error={field('originCountry')}>
              <Input value={current.originCountry} maxLength={2} onChange={(event) => set({ originCountry: event.target.value.toUpperCase() })} />
            </Field>
            <Field label={t('profile.region')} error={field('originRegion')}>
              <Input value={current.originRegion} onChange={(event) => set({ originRegion: event.target.value })} />
            </Field>
            <Field label={t('profile.note')} error={field('originNote')}>
              <Textarea rows={2} value={current.originNote} onChange={(event) => set({ originNote: event.target.value })} />
            </Field>
            {tannery ? (
              <>
                <Field label={t('profile.hides')} hint={t('profile.hidesHint')} error={field('hideCountries')}>
                  <Input value={current.hideCountries} onChange={(event) => set({ hideCountries: event.target.value.toUpperCase() })} />
                </Field>
                <fieldset className="fw-spd-checks">
                  <legend className="fw-spd-legend">{t('profile.tannages')}</legend>
                  {TANNAGE_CODES.map((code) => (
                    <Checkbox
                      key={code}
                      label={t(`tannage.${code}`)}
                      checked={current.tannages.includes(code)}
                      onChange={(event) => set({ tannages: event.target.checked ? [...current.tannages, code] : current.tannages.filter((item) => item !== code) })}
                    />
                  ))}
                </fieldset>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('profile.kinds'), value: profile.kinds.length === 0 ? t('profile.noKinds') : <KindTags kinds={profile.kinds} /> },
            { label: t('profile.leadTime'), value: profile.leadTimeDays === null ? '—' : t('profile.days', { count: profile.leadTimeDays }) },
            { label: t('profile.country'), value: profile.origin.country ? countryName(profile.origin.country, locale) : '—' },
            { label: t('profile.region'), value: profile.origin.region ?? '—' },
            { label: t('profile.note'), value: profile.origin.note ?? '—' },
            ...(isTannery(profile.kinds)
              ? [
                  { label: t('profile.hides'), value: profile.origin.hideCountries.length === 0 ? '—' : profile.origin.hideCountries.map((code) => countryName(code, locale)).join(', ') },
                  { label: t('profile.tannages'), value: profile.origin.tannages.length === 0 ? '—' : profile.origin.tannages.map((code) => t(`tannage.${code}`)).join(', ') },
                ]
              : []),
          ]}
        />
      )}
      {shown && clearsTanneryFacts(profile, shown) ? <Banner tone="warning" title={t('profile.clearsTannery')} /> : null}
      <Closures profile={profile} today={model.today} />
      {shown && count > 0 ? (
        <div className="fw-spd-bar">
          {model.failed ? <Banner tone={model.failed === 'problem.conflict' ? 'warning' : 'danger'} title={t(model.failed)} /> : null}
          <EditModeBar
            message={t('profile.unsaved', { count })}
            count={count}
            onDiscard={() => actions?.onDiscard?.()}
            onApply={() => actions?.onSave?.()}
            applyLabel={t('profile.save')}
            busy={model.saving}
            applyHeldReason={model.tried && problemCount > 0 ? t('profile.fixFirst', { count: problemCount }) : null}
            saveShortcut
          />
        </div>
      ) : null}
    </div>
  )
}

export function KindTags({ kinds }: { kinds: readonly string[] }) {
  const { t } = useSay()
  return (
    <span className="fw-spd-tags">
      {kinds.map((kind) => (
        <Tag key={kind}>{t(`kind.${kind}`)}</Tag>
      ))}
    </span>
  )
}

/** Where it stands with us: the pill, since when, who, why; Change status (held with its reason). */
function StatusRow({ profile, held, onStatus }: { profile: SupplierProfile; held: Words | null; onStatus?: (() => void) | undefined }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const standing = profile.standing
  const since = standing.changedAt ? formatDate(standing.changedAt, { locale }) : null
  const noOrder = newOrderWords(profile)
  return (
    <div className="fw-spd-status">
      <div className="fw-spd-status-text">
        <span className="fw-spd-label">{t('status.label')}</span>
        <Pill tone={STATUS_TONE[standing.status]} dot>
          {t(`status.${standing.status}`)}
        </Pill>
        <span className="fw-spd-hint">
          {standing.supplierStatus === null ? t('status.fromParty') : since ? (standing.changedBy ? t('status.sinceBy', { date: since, name: standing.changedBy }) : t('status.sinceSystem', { date: since })) : null}
        </span>
        {standing.reason ? <span className="fw-spd-hint">{t('status.reasonIs', { reason: standing.reason })}</span> : null}
        {noOrder ? <span className="fw-spd-warn">{say(noOrder)}</span> : null}
      </div>
      <Button size="sm" onClick={() => onStatus?.()} heldReason={held ? say(held) : null}>
        {t('status.change')}
      </Button>
    </div>
  )
}

/** The supplier's closures: its week and dated closed days (CalendarGrid, a month at a time) and an order placed today. */
function Closures({ profile, today }: { profile: SupplierProfile; today: string }) {
  const { t } = useSay()
  const locale = useLocale()
  const words = useCalendarWords()
  const kinds = useMemo(() => CLOSURE_KINDS(t), [t])
  const days = useMemo(() => closureDays(profile.closures.ahead), [profile.closures.ahead])
  const ordered = profile.closures.orderedToday
  const day = (value: string) => formatDate(value, { locale })
  return (
    <div className="fw-spd-closures">
      <h3 className="fw-spd-subtitle">{t('closures.title')}</h3>
      {profile.closures.calendarId === null ? <p className="fw-spd-hint">{t('closures.noCalendar')}</p> : null}
      <div className="fw-spd-closures-grid">
        <div className="fw-spd-calendar">
          <CalendarGrid label={t('closures.label', { name: profile.name })} kinds={kinds} days={days} weekKinds={weekKindsOf(profile.closures.weeklyDaysOff)} views={['month']} defaultMonth={today.slice(0, 7)} today={today} words={words} locale={locale === 'it' ? 'it-IT' : 'en-GB'} />
        </div>
        <div className="fw-spd-stack">
          {profile.closures.ahead.length === 0 ? (
            <p className="fw-spd-hint">{t('closures.none')}</p>
          ) : (
            <ul className="fw-spd-list">
              {profile.closures.ahead.map((span) => (
                <li key={`${span.from}-${span.to}`}>{span.from === span.to ? t('closures.day', { date: day(span.from), name: span.name }) : t('closures.span', { from: day(span.from), to: day(span.to), name: span.name, count: span.days })}</li>
              ))}
            </ul>
          )}
          {ordered ? (
            <p className="fw-spd-ordered">
              {ordered.skipped.length === 0
                ? t('closures.ordered', { date: day(ordered.orderDate), arrives: day(ordered.arrives), count: ordered.leadTimeDays })
                : t('closures.orderedPast', { date: day(ordered.orderDate), arrives: day(ordered.arrives), count: ordered.leadTimeDays, closed: ordered.skipped.map((span) => span.name).join(', ') })}
            </p>
          ) : (
            <p className="fw-spd-hint">{t('closures.noLeadTime')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
