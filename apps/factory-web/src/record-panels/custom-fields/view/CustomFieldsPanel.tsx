'use client'

import { Pencil, RefreshCw, Search, X, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Field as DsField, KeyValue } from '@nexus/ui/components'
import { Button, Input, RadioCard, SegmentedControl, Skeleton, Tag } from '@nexus/ui/primitives'
import { DateField, EditModeBar, Listbox, MultiSelect } from '../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../i18n'
import type { Field } from '../../../areas/admin/fields/api'
import { FIELDS_NS, labelIn, previewSections, sectionText } from '../../../areas/admin/fields/model'
import type { RecordValue } from '../api'
import { changedCount, DEFAULT_CURRENCY, valueWords, type Draft, type DraftValue, type RefDraft } from '../model'
import '../custom-fields.css'

/** The ONE view model of a record's custom-fields section (use-custom-fields.ts maps the API to it). */
export interface CustomFieldsModel {
  /** The record's name as its page shows it (SO-0042). */
  recordLabel: string
  state: 'loading' | 'ready' | 'error'
  /** A failed read, a `cf.fault.*` key. */
  fault: string | null
  fields: readonly Field[]
  values: readonly RecordValue[]
  canEdit: boolean
  editing: boolean
  draft: Draft
  /** What is wrong with a field's value, by code (`cf.check.*` / `cf.fault.*`). */
  problems: Readonly<Record<string, string>>
  saving: boolean
  saveFault: string | null
  /** Someone else changed the values while this person edits. */
  changedElsewhere: boolean
  /** Who a person field may name. */
  people: readonly { id: string; name: string }[]
  /** The record's files a file field may name (null: the person may not read its files). */
  files: readonly { id: string; name: string }[] | null
  /** The link picker open on one field: what is typed and what global search found. */
  link: { code: string; query: string; options: { value: string; label: string }[]; loading: boolean; error: string | null } | null
}

export interface CustomFieldsActions {
  onEdit?: () => void
  onDiscard?: () => void
  onDraft?: (code: string, value: DraftValue) => void
  onSave?: () => void
  onRetry?: () => void
  onReload?: () => void
  /** Open (a code and what is typed) or close (null) the link picker. */
  onLinkQuery?: (code: string | null, query: string) => void
  onLinkPick?: (code: string, ref: RefDraft) => void
}

/**
 * The custom-fields section of every record that takes them (B-W2b-431; design admin.fields "The record panels show a
 * custom-fields section", the fields added in Admin › Fields & lists): the fields the reader may see, by section, with
 * their values in the reader's language — a money field only with its grain, a personal one only with the right (the API
 * leaves the others out) — and, for a person who may change the record, Edit: one control per type, ⌘S saves every change
 * at once, each refusal said at its field. A value the list no longer offers stays, marked.
 */
export function CustomFieldsPanel({ model, actions }: { model: CustomFieldsModel; actions?: CustomFieldsActions }) {
  return (
    <WithMessages namespaces={[FIELDS_NS]}>
      <Card padded className="fw-cf-card">
        <Panel model={model} actions={actions} />
      </Card>
    </WithMessages>
  )
}

function Panel({ model, actions }: { model: CustomFieldsModel; actions?: CustomFieldsActions }) {
  const t = useT(FIELDS_NS)
  const locale = useLocale()
  const recordLabel = model.recordLabel
  if (model.state === 'loading') {
    return (
      <section className="fw-cf" aria-busy="true" aria-label={t('cf.title')}>
        <Skeleton height={20} width="40%" />
        <Skeleton height={64} />
        <span className="fw-cf-muted">{t('cf.loading')}</span>
      </section>
    )
  }
  if (model.state === 'error') {
    return (
      <section className="fw-cf" aria-label={t('cf.title')}>
        <EmptyState icon={<XCircle size={20} aria-hidden />} title={t('cf.errorTitle')} description={t(model.fault ?? 'cf.fault.read')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('error.retry')}</Button>} />
      </section>
    )
  }
  const sections = previewSections(model.fields)
  const byCode = new Map(model.values.map((value) => [value.code, value]))
  const count = model.editing ? changedCount(model.fields, model.values, model.draft) : 0
  const problems = Object.keys(model.problems).length

  return (
    <section className="fw-cf" aria-label={t('cf.title')}>
      <div className="fw-cf-head">
        <div>
          <h3 className="fw-cf-title">{t('cf.title')}</h3>
          <p className="fw-cf-muted">{t('cf.hint', { record: recordLabel })}</p>
        </div>
        {!model.editing && (
          <Button size="sm" heldReason={model.canEdit ? null : t('cf.noEdit', { record: recordLabel })} onClick={() => actions?.onEdit?.()}>
            <Pencil size={13} aria-hidden /> {t('cf.edit')}
          </Button>
        )}
      </div>
      {model.changedElsewhere && (
        <Banner tone="info" title={t('cf.changedTitle')} action={<Button size="sm" onClick={() => actions?.onReload?.()}><RefreshCw size={13} aria-hidden /> {t('cf.reload')}</Button>}>
          {t('cf.changedBody')}
        </Banner>
      )}
      {model.editing && (
        <EditModeBar
          message={t('cf.editing')}
          count={count}
          busy={model.saving}
          saveShortcut
          applyLabel={t('cf.save')}
          applyHeldReason={problems > 0 ? t('cf.fixFirst', { count: problems }) : count === 0 ? t('cf.nothingChanged') : null}
          onApply={() => actions?.onSave?.()}
          onDiscard={() => actions?.onDiscard?.()}
        />
      )}
      {model.saveFault && <Banner tone="danger" title={t(model.saveFault)} />}
      {sections.map((section) => (
        <div key={section.section} className="fw-cf-section">
          {(sections.length > 1 || section.section !== 'custom') && <h4 className="fw-cf-section-title">{sectionText(section.section) ?? t('section.custom')}</h4>}
          {model.editing ? (
            <div className="fw-cf-grid">
              {section.fields.map((field) => (
                <EditControl key={field.code} field={field} model={model} actions={actions} />
              ))}
            </div>
          ) : (
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={section.fields.map((field) => {
                const words = valueWords(field, byCode.get(field.code), locale)
                const value =
                  words.text === null ? (
                    <span className="fw-cf-muted">{t(words.hidden ? (field.type === 'LINK' ? 'cf.hiddenRecord' : 'cf.hiddenValue') : 'cf.notFilled')}</span>
                  ) : (
                    <span className="fw-cf-value">
                      <span>{field.type === 'YES_NO' ? t(`cf.${words.text}`) : words.text}</span>
                      {words.inactive && <Tag tone="neutral">{t('cf.inactive')}</Tag>}
                    </span>
                  )
                return { label: <FieldLabel field={field} />, value }
              })}
            />
          )}
        </div>
      ))}
    </section>
  )
}

function FieldLabel({ field }: { field: Field }) {
  const t = useT(FIELDS_NS)
  const locale = useLocale()
  return (
    <span className="fw-cf-label">
      <span>{labelIn(field, locale)}</span>
      {field.audience === 'MONEY' && field.grain && <Tag tone="info">{t(`grain.${field.grain}`)}</Tag>}
      {field.audience === 'PERSONAL' && <Tag tone="warning">{t('cf.personal')}</Tag>}
    </span>
  )
}

function EditControl({ field, model, actions }: { field: Field; model: CustomFieldsModel; actions?: CustomFieldsActions }) {
  const t = useT(FIELDS_NS)
  const locale = useLocale()
  const draft = model.draft[field.code]
  const problem = model.problems[field.code]
  const set = (value: DraftValue) => actions?.onDraft?.(field.code, value)
  const label = labelIn(field, locale)
  const held = new Set(model.values.find((value) => value.code === field.code) ? [model.values.find((value) => value.code === field.code)!.value].flat().map(String) : [])
  const options = (field.picklist?.values ?? [])
    .filter((value) => value.active || held.has(value.code))
    .map((value) => ({ value: value.code, label: value.active ? labelIn(value, locale) : t('cf.inactiveOption', { value: labelIn(value, locale) }) }))
  const hint = field.type === 'NUMBER' && field.unit ? t('preview.unit', { unit: field.unit }) : field.type === 'SELECT' || field.type === 'MULTI_SELECT' ? (options.length < (field.picklist?.values.length ?? 0) ? t('cf.someOff') : undefined) : undefined

  let control
  switch (field.type) {
    case 'NUMBER':
      control = <Input inputMode="decimal" value={typeof draft === 'string' ? draft : ''} suffix={field.unit ?? undefined} onChange={(event) => set(event.target.value)} />
      break
    case 'MONEY': {
      const money = draft && typeof draft === 'object' && 'amount' in draft ? draft : { amount: '', currency: DEFAULT_CURRENCY }
      control = (
        <span className="fw-cf-money">
          <Input inputMode="decimal" value={money.amount} aria-label={label} onChange={(event) => set({ ...money, amount: event.target.value })} />
          <Input value={money.currency} maxLength={3} aria-label={t('cf.currency')} className="fw-cf-currency" onChange={(event) => set({ ...money, currency: event.target.value.toUpperCase() })} />
        </span>
      )
      break
    }
    case 'DATE':
      control = <DateField value={typeof draft === 'string' ? draft : ''} clearable onChange={(value) => set(value)} />
      break
    case 'SELECT':
      control = <Listbox options={options} value={typeof draft === 'string' ? draft : ''} emptyLabel={t('cf.notFilled')} onChange={(value) => set(value)} ariaLabel={label} />
      break
    case 'MULTI_SELECT':
      control = <MultiSelect options={options} value={Array.isArray(draft) ? [...(draft as string[])] : []} placeholder={t('cf.notFilled')} onChange={(value) => set(value)} ariaLabel={label} />
      break
    case 'PERSON': {
      const ref = refOf(draft)
      const known = model.people.some((person) => person.id === ref.id)
      control = (
        <Listbox
          options={[...model.people.map((person) => ({ value: person.id, label: person.name })), ...(ref.id && !known ? [{ value: ref.id, label: ref.words ?? t('cf.hiddenValue') }] : [])]}
          value={ref.id ?? ''}
          emptyLabel={t('cf.notFilled')}
          searchable={model.people.length > 8}
          onChange={(value) => set({ id: value || null, words: model.people.find((person) => person.id === value)?.name ?? null })}
          ariaLabel={label}
        />
      )
      break
    }
    case 'FILE': {
      const ref = refOf(draft)
      control =
        model.files === null ? (
          <span className="fw-cf-muted">{ref.words ?? t('cf.notFilled')} · {t('cf.noFiles')}</span>
        ) : (
          <Listbox
            options={[...model.files.map((file) => ({ value: file.id, label: file.name })), ...(ref.id && !model.files.some((file) => file.id === ref.id) ? [{ value: ref.id, label: ref.words ?? t('cf.hiddenValue') }] : [])]}
            value={ref.id ?? ''}
            emptyLabel={t('cf.notFilled')}
            onChange={(value) => set({ id: value || null, words: model.files?.find((file) => file.id === value)?.name ?? null })}
            ariaLabel={label}
          />
        )
      break
    }
    case 'LINK': {
      const ref = refOf(draft)
      const open = model.link?.code === field.code ? model.link : null
      control = (
        <span className="fw-cf-link">
          <span className="fw-cf-value">
            {ref.id ? <span>{ref.words ?? t('cf.hiddenRecord')}</span> : <span className="fw-cf-muted">{t('cf.notFilled')}</span>}
            {!open && (
              <Button size="sm" onClick={() => actions?.onLinkQuery?.(field.code, '')}>
                <Search size={13} aria-hidden /> {t(ref.id ? 'cf.linkChange' : 'cf.linkPick')}
              </Button>
            )}
            {ref.id && !field.required && (
              <Button size="sm" variant="quiet" onClick={() => set({ id: null, words: null })}>
                <X size={13} aria-hidden /> {t('cf.clear')}
              </Button>
            )}
          </span>
          {open && (
            <span className="fw-cf-picker">
              <Input
                type="search"
                size="sm"
                autoFocus
                leadingIcon={<Search size={13} aria-hidden />}
                aria-label={t('cf.linkSearch', { record: field.linkRecordType ? t(`recordType.${field.linkRecordType}`) : t('cf.record') })}
                placeholder={t('cf.linkPlaceholder')}
                value={open.query}
                onChange={(event) => actions?.onLinkQuery?.(field.code, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    actions?.onLinkQuery?.(null, '')
                  }
                }}
              />
              <span className="fw-cf-muted" role="status" aria-live="polite">
                {open.query.trim().length < 2 ? t('cf.linkType') : open.loading ? t('cf.linkLoading') : open.error ? t(open.error) : open.options.length === 0 ? t('cf.linkNone') : t('cf.linkFound', { count: open.options.length })}
              </span>
              {!open.loading && open.options.length > 0 && (
                <span className="fw-cf-results" role="radiogroup" aria-label={t('cf.linkResults')}>
                  {open.options.map((option) => (
                    <RadioCard
                      key={option.value}
                      variant="row"
                      name={`fw-cf-link-${field.code}`}
                      value={option.value}
                      checked={ref.id === option.value}
                      selected={ref.id === option.value}
                      onChange={() => actions?.onLinkPick?.(field.code, { id: option.value, words: option.label })}
                      title={option.label}
                    />
                  ))}
                </span>
              )}
              <span>
                <Button size="sm" variant="quiet" onClick={() => actions?.onLinkQuery?.(null, '')}>
                  {t('cf.linkCancel')}
                </Button>
              </span>
            </span>
          )}
        </span>
      )
      break
    }
    case 'YES_NO':
      control = (
        <SegmentedControl
          ariaLabel={label}
          size="sm"
          value={typeof draft === 'string' ? draft || 'none' : 'none'}
          options={[
            { value: 'yes', label: t('cf.yes') },
            { value: 'no', label: t('cf.no') },
            { value: 'none', label: t('cf.notFilled') },
          ]}
          onChange={(value) => set(value === 'none' ? '' : value)}
        />
      )
      break
    default:
      control = <Input value={typeof draft === 'string' ? draft : ''} maxLength={4000} onChange={(event) => set(event.target.value)} />
  }
  return (
    <DsField label={<FieldLabel field={field} />} required={field.required} hint={hint} error={problem ? t(problem, { field: label }) : undefined}>
      {control}
    </DsField>
  )
}

const refOf = (draft: DraftValue | undefined): RefDraft => (draft && typeof draft === 'object' && 'id' in draft ? draft : { id: null, words: null })
