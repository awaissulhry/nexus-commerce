'use client'

import { ImageOff } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, CheckboxCard, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Combobox, FileDropzone, FileRow } from '../../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { Swatch } from '../../../../../products/_shared/Swatch'
import { percent, unitPrice, type Grains } from '../../../model'
import type { ArtworkFile, BenchCheck, CheckAnswer, Choices, OptionGroupView, OptionValueView, StyleConfigurator } from '../api'
import { findingsOf, groupRules, nameIn, orderChange, priceSummary, surchargeWords, textProblem, type DraftPick, type PriceSummary, type Say, type Tone } from '../model'
import { ConfiguratorMessages, useConfiguratorWords } from '../words'
import type { LineConfigurator } from '../api'
import '../configurator.css'

type Read = { status: 'loading' } | { status: 'error'; problem: Say } | { status: 'ready' }

export interface ConfiguratorModel {
  /** QUOTE (the line drawer), ORDER (the order's line dialog) or BENCH (Products, Options & rules: Test a combination). */
  mode: 'QUOTE' | 'ORDER' | 'BENCH'
  read: Read
  /** The line's configurator (QUOTE, ORDER) or the style's (BENCH). */
  style: StyleConfigurator | null
  line: LineConfigurator | null
  draft: DraftPick[]
  /** The API's check of the draft (QUOTE, ORDER): the price it would make, the surcharges it would freeze. */
  preview: { status: 'idle' | 'checking' | 'ready' | 'error'; value: CheckAnswer | null }
  grains: Grains
  /** The draft differs from what is saved. */
  changed: boolean
  /** Why Save waits (null: it can be pressed). */
  saveHeld: Say | null
  saving: boolean
  /** ORDER: keep the accepted price although the options add more or less. */
  keepPrice: boolean
  notice: { tone: Tone; words: Say } | null
  artwork: { uploading: string[]; problem: Say | null }
  /** The picture's address (through the web's /api), or null. */
  pictureUrl: string | null
  /** BENCH: the style picker and B-W2b-229's check of the combination. */
  bench?: { styles: { value: string; label: string }[]; styleId: string; check: { status: 'idle' | 'checking' | 'ready' | 'error'; value: BenchCheck | null } }
}

export interface ConfiguratorActions {
  onToggle?: (group: OptionGroupView, valueId: string) => void
  onText?: (valueId: string, text: string) => void
  onColour?: (valueId: string, colourId: string | null) => void
  onLeather?: (valueId: string, itemId: string | null, itemColourId: string | null) => void
  onSave?: () => void
  onDiscard?: () => void
  onKeepPrice?: (keep: boolean) => void
  onArtwork?: (files: File[]) => void
  onOpenArtwork?: (file: ArtworkFile) => void
  onRemoveArtwork?: (file: ArtworkFile) => void
  onRetry?: () => void
  onDismissNotice?: () => void
  onStyle?: (styleId: string) => void
}

/**
 * The configurator (B-W2b-340; SAL-133, SAL-136, SAL-139, SAL-140, SAL-249; design pop:quotes.lineDrawer's open slot, the
 * order's Lines, products.options' "Configurator preview"): the main picture of the chosen colourway; the price and margin as
 * the API checks the draft (before → with these options, what they add, the margin by grain); the style's option groups —
 * each value a card with its surcharge in the options area's words, "Default", "Outside the certificate" — with what a group
 * asks and its rules in their words; for a chosen value its text, panel colour or leather article and colour; the check in
 * the rule's words; the customer's artwork; Save and Discard, each held with its reason. It fetches nothing.
 */
export function ConfiguratorView({ model, actions }: { model: ConfiguratorModel; actions?: ConfiguratorActions }) {
  return (
    <ConfiguratorMessages>
      <Body model={model} actions={actions} />
    </ConfiguratorMessages>
  )
}

function Body({ model, actions }: { model: ConfiguratorModel; actions?: ConfiguratorActions }) {
  const { t, say, lang } = useConfiguratorWords()
  const bench = model.mode === 'BENCH'
  const editable = bench || (model.line?.may.configure ?? false)

  return (
    <section className="fw-cfg" aria-label={t(bench ? 'bench.title' : 'section.title')}>
      {model.notice && (
        <Banner tone={model.notice.tone} onDismiss={actions?.onDismissNotice}>
          {say(model.notice.words)}
        </Banner>
      )}
      {bench && model.bench && (
        <div className="fw-cfg-bench-head">
          <p className="fw-cfg-hint">{t('bench.hint')}</p>
          <Field label={t('bench.style')}>
            <Combobox options={model.bench.styles} value={model.bench.styleId} onChange={(value) => actions?.onStyle?.(value)} placeholder={t('bench.stylePlaceholder')} />
          </Field>
        </div>
      )}
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
      {model.read.status === 'ready' && bench && !model.style && <p className="fw-cfg-hint">{t('bench.pick')}</p>}
      {model.read.status === 'ready' && model.style && (
        <>
          {!bench && model.line && !model.line.may.configure && model.line.may.held && <Banner tone="info">{say({ words: model.line.may.held })}</Banner>}
          <div className="fw-cfg-top">
            <Picture model={model} />
            {bench ? <BenchSummary model={model} /> : <PriceCard model={model} actions={actions} />}
          </div>
          <Groups model={model} actions={actions} editable={editable} />
          <CheckResult model={model} lang={lang} />
          {bench && <Making model={model} />}
          {!bench && model.line && <Artwork model={model} actions={actions} />}
          {!bench && (
            <div className="fw-cfg-actions">
              <Button variant="primary" heldReason={model.saveHeld ? say(model.saveHeld) : null} onClick={() => actions?.onSave?.()}>
                {model.saving ? <Spinner size={12} /> : null} {t(model.saving ? 'save.saving' : 'save.save')}
              </Button>
              <Button variant="ghost" heldReason={!model.changed ? t('save.held.unchanged') : model.saving ? t('save.saving') : null} onClick={() => actions?.onDiscard?.()}>
                {t('save.discard')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Picture({ model }: { model: ConfiguratorModel }) {
  const { t } = useConfiguratorWords()
  const style = model.style!
  return (
    <figure className="fw-cfg-picture">
      {model.pictureUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a picture the API serves through /api, never optimised by Next
        <img src={model.pictureUrl} alt={t('picture.label')} />
      ) : (
        <span className="fw-cfg-picture-none">
          <ImageOff size={20} aria-hidden /> {t('picture.none')}
        </span>
      )}
      <figcaption className="fw-cfg-hint">
        {style.colourway ? t('picture.colourway', { code: style.colourway.code, name: style.colourway.name }) : style.style.code}
        {style.picture?.source === 'STYLE' && style.colourway ? ` · ${t('picture.fromStyle')}` : ''}
      </figcaption>
    </figure>
  )
}

function PriceCard({ model, actions }: { model: ConfiguratorModel; actions?: ConfiguratorActions }) {
  const { t } = useConfiguratorWords()
  const locale = useLocale()
  const line = model.line
  const currency = line?.document.currency ?? 'EUR'
  const summary: PriceSummary = priceSummary(line, model.preview.value)
  const checking = model.preview.status === 'checking'
  if (!model.grains.price) {
    return (
      <Card header={t('price.title')} className="fw-cfg-price">
        <p className="fw-cfg-hint">{t('price.noPrice')}</p>
      </Card>
    )
  }
  const change = model.mode === 'ORDER' ? orderChange(model.preview.value) : null
  const items = [
    { label: t('price.now'), value: unitPrice(summary.before, currency, locale) },
    ...(model.mode === 'QUOTE' ? [{ label: t('price.after'), value: checking ? <Spinner size={12} /> : <b>{unitPrice(summary.after, currency, locale)}</b> }] : []),
    { label: t('price.optionsAdd'), value: unitPrice(summary.optionsTotal, currency, locale) },
    ...(model.grains.margin ? [{ label: t('price.margin'), value: percent(summary.marginBefore, locale) }] : []),
    ...(model.grains.margin && model.mode === 'QUOTE' ? [{ label: t('price.marginAfter'), value: checking ? <Spinner size={12} /> : percent(summary.marginAfter, locale), hint: t('price.costNote') }] : []),
  ]
  return (
    <Card header={t('price.title')} className="fw-cfg-price">
      <KeyValue items={items} dense labelCase="sentence" />
      {model.mode === 'QUOTE' && summary.held && <p className="fw-cfg-note">{t(`price.held.${summary.held}`)}</p>}
      {model.mode === 'QUOTE' && !summary.held && summary.manualKept && <p className="fw-cfg-note">{t('price.manualKept')}</p>}
      {model.mode === 'QUOTE' && summary.notHeld && !summary.held && <p className="fw-cfg-note">{t('price.notHeld')}</p>}
      {model.mode === 'ORDER' && (
        <div className="fw-cfg-order-price">
          <p className="fw-cfg-note">{t('price.order.accepted')}</p>
          {change !== null && (
            <>
              <p className="fw-cfg-note">{t(Number(change) > 0 ? 'price.order.more' : 'price.order.less', { amount: unitPrice(String(Math.abs(Number(change))), currency, locale) })}</p>
              <Checkbox label={t('price.order.keep')} checked={model.keepPrice} disabled={!line?.may.configure} onChange={(event) => actions?.onKeepPrice?.(event.currentTarget.checked)} />
              <p className="fw-cfg-hint">{t('price.order.amend')}</p>
            </>
          )}
        </div>
      )}
    </Card>
  )
}

function BenchSummary({ model }: { model: ConfiguratorModel }) {
  const { t } = useConfiguratorWords()
  const locale = useLocale()
  const check = model.bench?.check.value ?? null
  const price = check?.effects.price ?? null
  const parts = [...(price?.byCurrency ?? []).map((entry) => surchargeWords({ surcharge: { delta: entry.delta, currency: entry.currency, percent: null } }, locale)), ...(price?.percent ? [surchargeWords({ surcharge: { delta: null, currency: null, percent: price.percent } }, locale)] : [])].filter(Boolean)
  return (
    <Card header={t('bench.surcharges')} className="fw-cfg-price">
      {!model.grains.price ? <p className="fw-cfg-hint">{t('price.noPrice')}</p> : model.bench?.check.status === 'checking' ? <Spinner size={12} /> : <p>{parts.length > 0 ? parts.join(' · ') : t('bench.noSurcharge')}</p>}
      <p className="fw-cfg-hint">{t('bench.nothingSaved')}</p>
    </Card>
  )
}

function Groups({ model, actions, editable }: { model: ConfiguratorModel; actions?: ConfiguratorActions; editable: boolean }) {
  const { t } = useConfiguratorWords()
  const groups = model.style!.groups
  if (groups.length === 0) return <p className="fw-cfg-hint">{t('groups.empty')}</p>
  return (
    <div className="fw-cfg-groups">
      {groups.map((group) => (
        <Group key={group.groupId} group={group} model={model} actions={actions} editable={editable} />
      ))}
    </div>
  )
}

function Group({ group, model, actions, editable }: { group: OptionGroupView; model: ConfiguratorModel; actions?: ConfiguratorActions; editable: boolean }) {
  const { t, lang } = useConfiguratorWords()
  const locale = useLocale()
  const single = group.kind === 'SINGLE' || group.maxPicks === 1
  const rules = groupRules(group, lang)
  const chosen = model.draft.filter((pick) => pick.groupId === group.groupId)
  const blocked = new Set((model.preview.value?.blocks ?? model.bench?.check.value?.blocks ?? []).flatMap((finding) => [finding.valueId, finding.groupId]).filter(Boolean))
  return (
    <fieldset className={`fw-cfg-group${blocked.has(group.groupId) ? ' is-blocked' : ''}`}>
      <legend>
        <b>{nameIn(group, lang)}</b> <span className="fw-cfg-hint">{t('groups.picks', { words: group.picks[lang] })}</span>
      </legend>
      <div className="fw-cfg-values">
        {group.values
          .filter((value) => value.status === 'ACTIVE' || chosen.some((pick) => pick.valueId === value.id))
          .map((value) => {
            const on = chosen.some((pick) => pick.valueId === value.id)
            const Control = single ? RadioCard : CheckboxCard
            return (
              <Control
                key={value.id}
                name={`fw-cfg-${group.groupId}`}
                checked={on}
                selected={on}
                disabled={!editable}
                onChange={() => actions?.onToggle?.(group, value.id)}
                onClick={single && on ? () => actions?.onToggle?.(group, value.id) : undefined}
                title={<ValueTitle value={value} group={group} on={on} />}
                description={<ValueNote value={value} locale={locale} grains={model.grains} />}
              />
            )
          })}
      </div>
      {chosen.map((pick) => {
        const value = group.values.find((entry) => entry.id === pick.valueId)
        if (!value) return null
        return <PickExtras key={pick.valueId} value={value} pick={pick} choices={model.style!.choices} editable={editable && model.mode !== 'BENCH'} bench={model.mode === 'BENCH'} actions={actions} />
      })}
      {rules.length > 0 && (
        <ul className="fw-cfg-rules" aria-label={t('groups.rules')}>
          {rules.map((rule) => (
            <li key={rule.ruleId}>
              <Tag tone={rule.block ? 'danger' : 'warning'}>{t(rule.block ? 'groups.block' : 'groups.warn')}</Tag> {rule.text}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  )
}

function ValueTitle({ value, group, on }: { value: OptionValueView; group: OptionGroupView; on: boolean }) {
  const { t, lang } = useConfiguratorWords()
  return (
    <span className="fw-cfg-value-title">
      {nameIn(value, lang)}
      {group.defaultValueId === value.id && <Tag tone="neutral">{t('groups.default')}</Tag>}
      {value.status === 'ARCHIVED' && on && <Tag tone="warning">{t('groups.archived')}</Tag>}
      {value.outsideCertificate && <Tag tone="warning">{t('groups.outside')}</Tag>}
    </span>
  )
}

function ValueNote({ value, locale, grains }: { value: OptionValueView; locale: string; grains: Grains }) {
  const { t } = useConfiguratorWords()
  const surcharge = grains.price ? surchargeWords(value, locale) : null
  const parts = [value.code, surcharge, value.outsideCertificate && value.certificateNote ? t('groups.outsideNote', { note: value.certificateNote }) : null].filter(Boolean)
  return <span>{parts.join(' · ')}</span>
}

function PickExtras({ value, pick, choices, editable, bench, actions }: { value: OptionValueView; pick: DraftPick; choices: Choices; editable: boolean; bench: boolean; actions?: ConfiguratorActions }) {
  const { t, say, lang } = useConfiguratorWords()
  const problem = value.freeText ? textProblem(value, pick.text) : null
  const leather = choices.leathers.find((entry) => entry.id === pick.itemId) ?? null
  const colour = choices.colours.find((entry) => entry.id === pick.colourId) ?? null
  return (
    <div className="fw-cfg-extras">
      {value.freeText && (
        <Field label={t('groups.text', { value: nameIn(value, lang) })} hint={value.freeTextMaxLength ? t('groups.textHint', { max: value.freeTextMaxLength }) : undefined} error={problem ? say(problem) : undefined}>
          <Input value={pick.text} maxLength={value.freeTextMaxLength ?? undefined} disabled={!editable && !bench} onChange={(event) => actions?.onText?.(value.id, event.currentTarget.value)} />
        </Field>
      )}
      {!bench && (choices.colours.length > 0 || choices.leathers.length > 0) && (
        <div className="fw-cfg-material">
          {choices.colours.length > 0 && (
            <Field label={t('groups.colour')}>
              <span className="fw-cfg-swatch-field">
                {colour && <Swatch hex={colour.hex} name={nameIn(colour, lang)} code={colour.code} size="sm" noHex={t('groups.noHex')} />}
                <Select size="sm" value={pick.colourId ?? ''} disabled={!editable} onChange={(event) => actions?.onColour?.(value.id, event.currentTarget.value || null)}>
                  <option value="">{t('groups.none')}</option>
                  {choices.colours.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.code} · {nameIn(entry, lang)}
                    </option>
                  ))}
                </Select>
              </span>
            </Field>
          )}
          {choices.leathers.length > 0 && (
            <Field label={t('groups.leather')}>
              <Select size="sm" value={pick.itemId ?? ''} disabled={!editable} onChange={(event) => actions?.onLeather?.(value.id, event.currentTarget.value || null, null)}>
                <option value="">{t('groups.none')}</option>
                {choices.leathers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.code} · {entry.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {leather && leather.colours.length > 0 && (
            <Field label={t('groups.leatherColour')}>
              <Select size="sm" value={pick.itemColourId ?? ''} disabled={!editable} onChange={(event) => actions?.onLeather?.(value.id, leather.id, event.currentTarget.value || null)}>
                <option value="">{t('groups.none')}</option>
                {leather.colours.map((entry) => (
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

function CheckResult({ model, lang }: { model: ConfiguratorModel; lang: 'it' | 'en' }) {
  const { t, say } = useConfiguratorWords()
  const bench = model.mode === 'BENCH'
  const status = bench ? (model.bench?.check.status ?? 'idle') : model.preview.status
  const value = bench ? (model.bench?.check.value ?? null) : (model.preview.value ?? (model.line ? { ...model.line.check, problem: null } : null))
  if (status === 'checking')
    return (
      <p className="fw-cfg-hint" role="status">
        <Spinner size={12} /> {t('common.checking')}
      </p>
    )
  if (status === 'error') return <Banner tone="warning">{t('problem.check')}</Banner>
  if (!value) return null
  const problem = 'problem' in value ? value.problem : null
  const findings = findingsOf(value, lang)
  const outside = bench ? (model.bench?.check.value?.effects.outsideCertificate ?? false) : 'outsideCertificate' in value && value.outsideCertificate
  return (
    <div className="fw-cfg-check" aria-live="polite">
      {problem && <Banner tone="danger">{say({ words: problem })}</Banner>}
      {value.ok && findings.length === 0 && !outside && <Banner tone="success">{t('check.ok')}</Banner>}
      {!value.ok && (
        <Banner tone="danger" title={t('check.blocks')}>
          <ul>
            {findings.filter((entry) => entry.block).map((entry, index) => (
              <li key={index}>{entry.text}</li>
            ))}
          </ul>
        </Banner>
      )}
      {(findings.some((entry) => !entry.block) || outside) && (
        <Banner tone="warning" title={t('check.warnings')}>
          <ul>
            {findings.filter((entry) => !entry.block).map((entry, index) => (
              <li key={index}>{entry.text}</li>
            ))}
            {outside && <li>{t('check.outside')}</li>}
          </ul>
        </Banner>
      )}
    </div>
  )
}

function Making({ model }: { model: ConfiguratorModel }) {
  const { t, lang } = useConfiguratorWords()
  const check = model.bench?.check.value
  if (!check) return null
  const effects = check.effects
  const nothing = effects.bom.length === 0 && effects.operations.length === 0 && effects.minutes.length === 0
  return (
    <Card header={t('bench.making')} className="fw-cfg-making">
      {nothing ? (
        <p className="fw-cfg-hint">{t('bench.nothing')}</p>
      ) : (
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            ...(effects.bom.length > 0 ? [{ label: t('bench.bom'), value: <ul>{effects.bom.map((entry) => <li key={entry.effectId}>{entry.words[lang]}</li>)}</ul> }] : []),
            ...(effects.operations.length > 0 ? [{ label: t('bench.operations'), value: <ul>{effects.operations.map((entry) => <li key={entry.effectId}>{entry.words[lang]}</li>)}</ul> }] : []),
            ...(effects.minutesAdded !== '0' ? [{ label: t('bench.minutes', { minutes: effects.minutesAdded }), value: effects.operationsAtStandard > 0 ? t('bench.atStandard', { count: effects.operationsAtStandard }) : '' }] : []),
          ]}
        />
      )}
      {check.bom && check.bom.notes.length > 0 && (
        <div>
          <p className="fw-cfg-hint">{t('bench.notes', { revision: check.bom.revision.revision })}</p>
          <ul>
            {check.bom.notes.map((note, index) => (
              <li key={index}>{note[lang]}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

function Artwork({ model, actions }: { model: ConfiguratorModel; actions?: ConfiguratorActions }) {
  const { t, say } = useConfiguratorWords()
  const line = model.line!
  return (
    <Card header={t('artwork.title')} className="fw-cfg-artwork">
      {model.artwork.problem && <Banner tone="danger">{say(model.artwork.problem)}</Banner>}
      {line.artwork.length === 0 && model.artwork.uploading.length === 0 && <p className="fw-cfg-hint">{t('artwork.empty')}</p>}
      <div className="fw-cfg-files">
        {line.artwork.map((file) => (
          <FileRow
            key={file.fileId}
            name={file.name}
            size={file.sizeBytes}
            tone={file.status === 'QUARANTINED' ? 'danger' : 'neutral'}
            status={file.status === 'PENDING_UPLOAD' ? t('artwork.pending') : file.status === 'QUARANTINED' ? t('artwork.quarantined') : file.from === 'QUOTE_LINE' ? t('artwork.fromQuote') : undefined}
            actions={
              file.status === 'AVAILABLE' ? (
                <Button size="sm" variant="ghost" onClick={() => actions?.onOpenArtwork?.(file)}>
                  {t('artwork.open')}
                </Button>
              ) : undefined
            }
            onRemove={line.may.artwork && file.from === 'LINE' && actions?.onRemoveArtwork ? () => actions.onRemoveArtwork?.(file) : undefined}
          />
        ))}
        {model.artwork.uploading.map((name) => (
          <FileRow key={`up-${name}`} name={name} status={t('artwork.uploading', { name })} disabled />
        ))}
      </div>
      {line.may.artwork ? <FileDropzone multiple accept=".pdf,.jpg,.jpeg,.png,.webp" maxBytes={25 * 1024 * 1024} hint={t('artwork.add')} onFiles={(files) => actions?.onArtwork?.(files)} /> : <p className="fw-cfg-hint">{t('artwork.held')}</p>}
    </Card>
  )
}
