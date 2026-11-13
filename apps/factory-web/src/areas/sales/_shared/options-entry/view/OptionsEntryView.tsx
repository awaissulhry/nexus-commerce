'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { pickersOf } from '@nexus/factory-domain/product/options/takes'
import { Swatch } from '../../../../products/_shared/Swatch'
import type { BenchCheck, Choices, OptionGroupView, OptionValueView, StyleConfigurator } from '../../../quotes/record/configurator/api'
import { findingsOf, nameIn, textProblem, type DraftPick } from '../../../quotes/record/configurator/model'
import { FollowupsMessages, useFollowupsWords, type FollowupsSay } from '../../../../../lib/options-followups/words'
import '../../../quotes/record/configurator/configurator.css'

/** The Options dialog of a typed order line (SCR-433): its view model. */
export interface OptionsEntryModel {
  /** The line it is for ("DEMO-JKT-05 · BLK"). */
  line: { style: string; colour: string }
  read: { status: 'loading' } | { status: 'error'; problem: FollowupsSay } | { status: 'ready' }
  style: StyleConfigurator | null
  draft: DraftPick[]
  /** B-W2b-229's check of the draft (the rule's words). */
  check: { status: 'idle' | 'checking' | 'ready' | 'error'; value: BenchCheck | null }
  /** Why "Use these options" waits (null: it can be pressed). */
  useHeld: FollowupsSay | null
  offline: boolean
}

export interface OptionsEntryActions {
  onToggle?: (group: OptionGroupView, valueId: string) => void
  onText?: (valueId: string, text: string) => void
  onColour?: (valueId: string, colourId: string | null) => void
  onMaterial?: (valueId: string, itemId: string | null, itemColourId: string | null) => void
  onClear?: () => void
  onUse?: () => void
  onCancel?: () => void
  onRetry?: () => void
}

/**
 * SCR-433 — the options of a typed order line (B-W2b-374; XF3:02): on a New order and on an amendment's new line, the line's
 * "Options" opens this — the style's option groups (each value a card: Default, Outside the certificate; what a group takes),
 * for a chosen value its text and, as the group takes, the panel colour or the material and its colour; the style's rules
 * checked as the person picks (B-W2b-229, the rule's words); "Use these options" held with why. Nothing is written here: the
 * line sends the picks with the order, whose preview prices them. It fetches nothing.
 */
export function OptionsEntryView({ model, actions }: { model: OptionsEntryModel; actions?: OptionsEntryActions }) {
  return (
    <FollowupsMessages>
      <Body model={model} actions={actions} />
    </FollowupsMessages>
  )
}

function Body({ model, actions }: { model: OptionsEntryModel; actions?: OptionsEntryActions }) {
  const { t, say } = useFollowupsWords()
  return (
    <section className="fw-cfg" aria-label={t('entry.title', { style: model.line.style, colour: model.line.colour })}>
      <p className="fw-cfg-hint">{t('entry.hint')}</p>
      {model.offline && <Banner tone="warning">{t('common.offline')}</Banner>}
      {model.read.status === 'loading' && (
        <p className="fw-cfg-hint" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      )}
      {model.read.status === 'error' && (
        <Banner tone="danger" action={actions?.onRetry ? <Button size="sm" onClick={actions.onRetry}>{t('common.retry')}</Button> : undefined}>
          {say(model.read.problem)}
        </Banner>
      )}
      {model.read.status === 'ready' && model.style && model.style.groups.length === 0 && <p className="fw-cfg-hint">{t('entry.empty')}</p>}
      {model.read.status === 'ready' && model.style && model.style.groups.length > 0 && (
        <>
          <div className="fw-cfg-groups">
            {model.style.groups.map((group) => (
              <Group key={group.groupId} group={group} draft={model.draft} choices={model.style!.choices} actions={actions} />
            ))}
          </div>
          <Check model={model} />
        </>
      )}
      <div className="fw-cfg-actions">
        <Button variant="primary" heldReason={model.useHeld ? say(model.useHeld) : null} onClick={() => actions?.onUse?.()}>
          {t('entry.use')}
        </Button>
        {model.draft.length > 0 && (
          <Button variant="quiet" onClick={() => actions?.onClear?.()}>
            {t('entry.clear')}
          </Button>
        )}
        <Button variant="quiet" onClick={() => actions?.onCancel?.()}>
          {t('entry.cancel')}
        </Button>
      </div>
    </section>
  )
}

function Group({ group, draft, choices, actions }: { group: OptionGroupView; draft: DraftPick[]; choices: Choices; actions?: OptionsEntryActions }) {
  const { t, lang } = useFollowupsWords()
  const single = group.kind === 'SINGLE' || group.maxPicks === 1
  const chosen = draft.filter((pick) => pick.groupId === group.groupId)
  return (
    <fieldset className="fw-cfg-group">
      <legend>
        <b>{nameIn(group, lang)}</b> <span className="fw-cfg-hint">{t('entry.picks', { picks: group.picks[lang] })}</span>
      </legend>
      <div className="fw-cfg-values">
        {group.values
          .filter((value) => value.status === 'ACTIVE' || chosen.some((pick) => pick.valueId === value.id))
          .map((value) => {
            const on = chosen.some((pick) => pick.valueId === value.id)
            const Card = single ? RadioCard : CheckboxCard
            return (
              <Card
                key={value.id}
                variant="row"
                name={`fw-entry-${group.groupId}`}
                value={value.id}
                checked={on}
                onChange={() => actions?.onToggle?.(group, value.id)}
                onClick={single && on ? () => actions?.onToggle?.(group, value.id) : undefined}
                title={
                  <span className="fw-cfg-value-title">
                    {nameIn(value, lang)}
                    {group.defaultValueId === value.id && <Tag tone="neutral">{t('entry.default')}</Tag>}
                    {value.outsideCertificate && <Tag tone="warning">{t('entry.outside')}</Tag>}
                  </span>
                }
                description={value.code}
              />
            )
          })}
      </div>
      {chosen.map((pick) => {
        const value = group.values.find((entry) => entry.id === pick.valueId)
        return value ? <Extras key={pick.valueId} value={value} pick={pick} choices={choices} takes={group.takes ?? null} actions={actions} /> : null
      })}
    </fieldset>
  )
}

function Extras({ value, pick, choices, takes, actions }: { value: OptionValueView; pick: DraftPick; choices: Choices; takes: 'COLOUR' | 'MATERIAL' | null; actions?: OptionsEntryActions }) {
  const { t, lang } = useFollowupsWords()
  const offers = pickersOf(takes)
  const colours = offers.colour ? choices.colours : []
  const materials = offers.material ? choices.leathers : []
  const material = materials.find((entry) => entry.id === pick.itemId) ?? null
  const colour = colours.find((entry) => entry.id === pick.colourId) ?? null
  const missing = value.freeText ? textProblem(value, pick.text) : null
  return (
    <div className="fw-cfg-extras">
      {value.freeText && (
        <Field label={t('entry.text', { value: nameIn(value, lang) })} hint={value.freeTextMaxLength ? t('entry.textHint', { max: value.freeTextMaxLength }) : undefined} error={missing ? t('entry.held.text') : undefined}>
          <Input value={pick.text} maxLength={value.freeTextMaxLength ?? undefined} onChange={(event) => actions?.onText?.(value.id, event.currentTarget.value)} />
        </Field>
      )}
      {(colours.length > 0 || materials.length > 0) && (
        <div className="fw-cfg-material">
          {colours.length > 0 && (
            <Field label={t('entry.colour')}>
              <span className="fw-cfg-swatch-field">
                {colour && <Swatch hex={colour.hex} name={nameIn(colour, lang)} code={colour.code} size="sm" noHex={colour.code} />}
                <Select size="sm" value={pick.colourId ?? ''} onChange={(event) => actions?.onColour?.(value.id, event.currentTarget.value || null)}>
                  <option value="">{t('entry.none')}</option>
                  {colours.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.code} · {nameIn(entry, lang)}
                    </option>
                  ))}
                </Select>
              </span>
            </Field>
          )}
          {materials.length > 0 && (
            <Field label={t('entry.material')}>
              <Select size="sm" value={pick.itemId ?? ''} onChange={(event) => actions?.onMaterial?.(value.id, event.currentTarget.value || null, null)}>
                <option value="">{t('entry.none')}</option>
                {materials.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.code} · {entry.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {material && material.colours.length > 0 && (
            <Field label={t('entry.materialColour')}>
              <Select size="sm" value={pick.itemColourId ?? ''} onChange={(event) => actions?.onMaterial?.(value.id, material.id, event.currentTarget.value || null)}>
                <option value="">{t('entry.none')}</option>
                {material.colours.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.code} · {entry.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
    </div>
  )
}

function Check({ model }: { model: OptionsEntryModel }) {
  const { t, lang } = useFollowupsWords()
  if (model.check.status === 'checking')
    return (
      <p className="fw-cfg-hint" role="status">
        <Spinner size={12} /> {t('entry.check.checking')}
      </p>
    )
  if (model.check.status === 'error') return <Banner tone="warning">{t('entry.check.failed')}</Banner>
  const value = model.check.value
  if (!value) return null
  const findings = findingsOf(value, lang)
  return (
    <div className="fw-cfg-check" aria-live="polite">
      {value.ok && findings.length === 0 && !value.effects.outsideCertificate && <Banner tone="success">{t('entry.check.ok')}</Banner>}
      {!value.ok && (
        <Banner tone="danger" title={t('entry.check.blocks')}>
          <ul>
            {findings.filter((entry) => entry.block).map((entry, index) => (
              <li key={index}>{entry.text}</li>
            ))}
          </ul>
        </Banner>
      )}
      {(findings.some((entry) => !entry.block) || value.effects.outsideCertificate) && (
        <Banner tone="warning" title={t('entry.check.warnings')}>
          <ul>
            {findings.filter((entry) => !entry.block).map((entry, index) => (
              <li key={index}>{entry.text}</li>
            ))}
            {value.effects.outsideCertificate && <li>{t('entry.outside')}</li>}
          </ul>
        </Banner>
      )}
    </div>
  )
}
