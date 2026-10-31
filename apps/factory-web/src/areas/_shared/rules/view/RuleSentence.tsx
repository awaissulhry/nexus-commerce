'use client'

import { Fragment, type ReactNode } from 'react'
import { Input, Select } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { cooldownOptions, draftProblems, howOften, THRESHOLD_FIELDS, wholeOf, type PlaceOption, type RuleDraft } from '../model'
import '../rules.css'

export interface RuleSentenceProps {
  readonly draft: RuleDraft
  /** `edit`: the numbers, place, recipient, channels and cooldown are fields inside the sentence; `read`: words in bold. */
  readonly mode: 'read' | 'edit'
  /** The place's and the recipient's names when read (as the rule names them). */
  readonly names: { readonly place: string | null; readonly recipient: string | null }
  /** Edit: what may be chosen (GET /alerts/rules/choices, the rule's own kept). */
  readonly places?: readonly PlaceOption[]
  readonly roles?: readonly { readonly id: string; readonly name: string }[]
  /** Edit: a held change (offline, busy): the fields say why and do not move. */
  readonly held?: string | null
  readonly onChange?: (next: RuleDraft) => void
}

/**
 * RuleSentence — NEW part (design part "RuleSentence (new)", area `_shared`; composed here because packages/ui is
 * frozen): a rule said as ONE sentence, in the reader's language, with its parts in place — "When goods are on hold longer
 * than [24 h] at [Plant 1], tell [Quality inspector] by [the bell] [at most once a day]." In `edit` each bracket is a field
 * of the sentence (a number with its unit, days or working days where the kind allows them, the place, the role, the
 * bell with or without e-mail, how often); in `read` the same words with the values in bold. The words per kind are the
 * catalogue's `rules:when.<KIND>` with `{number}` slots, the same as factory-domain `ruleSentence` (the API's sentence).
 */
export function RuleSentence({ draft, mode, names, places = [], roles = [], held = null, onChange }: RuleSentenceProps) {
  const t = useT('rules')
  const locale = useLocale()
  const editing = mode === 'edit' && onChange !== undefined
  const fields = THRESHOLD_FIELDS[draft.ruleKind]
  const set = (patch: Partial<RuleDraft>) => onChange?.({ ...draft, ...patch })
  const disabled = held !== null
  const problems = editing ? draftProblems(draft) : []

  const numberSlot = (key: string): ReactNode => {
    const field = fields.numbers.find((entry) => entry.key === key)
    if (!field) return `{${key}}`
    const text = draft.numbers[key] ?? ''
    const count = wholeOf(text) ?? 0
    const unitKey = field.unit === 'hours' ? 'unitWord.hours' : fields.workingDays && draft.workingDays ? 'unitWord.workingDays' : 'unitWord.days'
    if (!editing) {
      const words = field.unit === 'hours' ? t('unit.hoursShort', { count }) : t(fields.workingDays && draft.workingDays ? 'unit.workingDays' : 'unit.days', { count })
      return <b className="fw-rule-value">{words}</b>
    }
    const problem = problems.find((entry) => entry.key === key)
    return (
      <span className="fw-rule-slot">
        <Input
          size="sm"
          type="number"
          inputMode="numeric"
          className="fw-rule-number"
          min={field.min}
          max={field.max}
          value={text}
          disabled={disabled}
          title={held ?? undefined}
          aria-label={t(`field.${key}`)}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `fw-rule-problem-${key}` : undefined}
          onChange={(event) => set({ numbers: { ...draft.numbers, [key]: event.target.value } })}
        />
        {fields.workingDays ? (
          <Select size="sm" value={draft.workingDays ? 'working' : 'calendar'} disabled={disabled} title={held ?? undefined} aria-label={t('field.dayKind')} onChange={(event) => set({ workingDays: event.target.value === 'working' })}>
            <option value="calendar">{t('unitWord.days', { count })}</option>
            <option value="working">{t('unitWord.workingDays', { count })}</option>
          </Select>
        ) : (
          <span>{t(unitKey, { count })}</span>
        )}
        {problem && (
          <span id={`fw-rule-problem-${key}`} className="fw-rule-problem" role="alert">
            {t('problem.range', { min: problem.min, max: problem.max })}
          </span>
        )}
      </span>
    )
  }

  // "When goods are on hold longer than {hours}": the kind's words with its number fields in place.
  const when = renderSlots(t(`when.${draft.ruleKind}`), numberSlot)

  const placeSlot: ReactNode = editing ? (
    <Select size="sm" className="fw-rule-select" value={draft.place} disabled={disabled} title={held ?? undefined} aria-label={t('field.place')} onChange={(event) => set({ place: event.target.value })}>
      {places.map((option) => (
        <option key={option.value} value={option.value}>
          {option.kind === 'everywhere' || option.name === null
            ? t('place.everywhere')
            : option.kind === 'company'
              ? t('place.atCompany', { name: option.name })
              : option.company
                ? t('place.atSite', { site: option.name, company: option.company })
                : t('place.atPlace', { name: option.name })}
        </option>
      ))}
    </Select>
  ) : names.place ? (
    <>
      {t('place.at')} <b className="fw-rule-value">{names.place}</b>
    </>
  ) : null

  const recipientSlot: ReactNode = editing ? (
    <Select
      size="sm"
      className="fw-rule-select"
      value={draft.recipientRoleId ?? ''}
      disabled={disabled}
      title={held ?? undefined}
      aria-label={t('field.recipient')}
      onChange={(event) => set({ recipientRoleId: event.target.value === '' ? null : event.target.value })}
    >
      {draft.recipientRoleId !== null && !roles.some((role) => role.id === draft.recipientRoleId) && <option value={draft.recipientRoleId}>{names.recipient ?? '…'}</option>}
      {roles.map((role) => (
        <option key={role.id} value={role.id}>
          {role.name}
        </option>
      ))}
      <option value="">{t('recipient.none')}</option>
    </Select>
  ) : (
    <b className="fw-rule-value">{names.recipient ?? t('recipient.none')}</b>
  )

  const channelsSlot: ReactNode = editing ? (
    <Select size="sm" className="fw-rule-select" value={draft.email ? 'both' : 'bell'} disabled={disabled} title={held ?? undefined} aria-label={t('field.channels')} onChange={(event) => set({ email: event.target.value === 'both' })}>
      <option value="bell">{t('channels.bell')}</option>
      <option value="both">{t('channels.both')}</option>
    </Select>
  ) : (
    <b className="fw-rule-value">{t(draft.email ? 'channels.both' : 'channels.bell')}</b>
  )

  const cooldownSlot: ReactNode = editing ? (
    <Select size="sm" className="fw-rule-select" value={String(draft.cooldownMinutes)} disabled={disabled} title={held ?? undefined} aria-label={t('field.cooldown')} onChange={(event) => set({ cooldownMinutes: Number(event.target.value) })}>
      {cooldownOptions(draft.cooldownMinutes).map((minutes) => (
        <option key={minutes} value={minutes}>
          {howOften(minutes, locale)}
        </option>
      ))}
    </Select>
  ) : (
    <b className="fw-rule-value">{howOften(draft.cooldownMinutes, locale)}</b>
  )

  const slots: Record<string, ReactNode> = { when, place: placeSlot, recipient: recipientSlot, channels: channelsSlot, cooldown: cooldownSlot }
  return (
    <p className={editing ? 'fw-rule-sentence is-editing' : 'fw-rule-sentence'} aria-label={editing ? t('sentence.label') : undefined}>
      {renderSlots(t(placeSlot === null ? 'sentence.nowhere' : 'sentence.full'), (key) => slots[key] ?? `{${key}}`)}
    </p>
  )
}

/** A catalogue text with `{slot}` places, each drawn by `slot` (text between them kept as written). */
export function renderSlots(text: string, slot: (key: string) => ReactNode): ReactNode {
  const parts = text.split(/(\{\w+\})/g)
  return parts.map((part, index) => {
    const match = /^\{(\w+)\}$/.exec(part)
    return <Fragment key={index}>{match ? slot(match[1]!) : part}</Fragment>
  })
}
