'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../../../../shell/nav/office-nav'
import { normaliseLanguage, TEXT_LIMITS } from '@nexus/factory-domain/product/style-texts/rules'
import type { PrivateLabelView, StyleTypeView, TextsView, TypeView } from '../api'
import {
  attributeKey,
  COMMON_LANGUAGES,
  differsKey,
  languageName,
  languageRows,
  sameText,
  soldHeld,
  textDraftOf,
  textProblems,
  textsHeld,
  typeHeld,
  typeHref,
  valueOf,
  type StyleDepthActions,
  type StyleDepthModel,
  type TextDraft,
} from '../model'
import { DepthNotice, DialogProblem, PartBody, useDepthT } from './parts'

/**
 * SCR-342 — the Overview's identity in depth (design products.styles rec:Style style.ov.identity "Name (and per language,
 * W2b)", "A private-label style limits who can see it (W2b)"), under W1's identity card: the product type (what it asks
 * before release, where the style differs from its defaults; the type itself lives in Products › Settings), the names per
 * language with the reader's fallback, and the private-label mark — who sees it, under whose name it is sold, who sends its
 * declaration. Draws one model; fetches nothing.
 */
export function IdentityDepth({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  return (
    <>
      <DepthNotice model={model} actions={actions} />
      <TypeCard model={model} actions={actions} />
      <NamesCard model={model} actions={actions} />
      <PrivateLabelCard model={model} actions={actions} />
    </>
  )
}

// ---- the product type ---------------------------------------------------------------------------------------------------

function TypeCard({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const held = typeHeld(model)
  const view = valueOf(model.type)
  return (
    <Card
      header={t('type.title')}
      description={t('type.intro')}
      headerAction={
        <Button size="sm" heldReason={held ? t(held) : view ? null : t('hold.loading')} onClick={() => actions?.onDialog?.({ kind: 'type' })}>
          {t('type.change')}
        </Button>
      }
    >
      <PartBody part={model.type} actions={actions} lines={2}>
        {(value) => <TypeBody model={model} view={value} />}
      </PartBody>
      {model.dialog?.kind === 'type' && view && <TypeDialog model={model} view={view} actions={actions} />}
    </Card>
  )
}

function TypeBody({ model, view }: { model: StyleDepthModel; view: StyleTypeView }) {
  const t = useDepthT()
  if (!view.type) return <p className="fw-st-hint">{t('type.none')}</p>
  const type = view.type
  return (
    <div className="fw-st-stack">
      <span className="fw-st-inline fw-sdp-wrap">
        <Link className="fw-st-link" href={typeHref(model.prefix, type.id, OFFICE_PAGES)}>
          <b>{type.code}</b> · {type.name}
        </Link>
        {type.parent && <span className="fw-st-hint">{t('type.under', { code: type.parent.code })}</span>}
        <Tag tone="neutral">{t(type.companyId === null ? 'type.everyCompany' : 'type.ownCompany')}</Tag>
        {type.status === 'ARCHIVED' && <Tag tone="warning">{t('type.archived')}</Tag>}
      </span>
      {view.missing.length > 0 ? (
        <div className="fw-st-stack">
          <span className="fw-st-inline">
            <Tag tone="warning">{t('type.missing', { count: view.missing.length })}</Tag>
            <span className="fw-st-hint">{t('type.missingHint')}</span>
          </span>
          <ul className="fw-st-list">
            {view.missing.map((name) => (
              <li key={name}>{t(attributeKey(name))}</li>
            ))}
          </ul>
        </div>
      ) : (
        <span className="fw-st-inline">
          <Tag tone="success">{t(type.effective.requiredAttributes.length > 0 ? 'type.allFilled' : 'type.noneRequired')}</Tag>
        </span>
      )}
      {view.differs.length > 0 && <p className="fw-st-hint">{t('type.differs', { fields: view.differs.map((entry) => t(differsKey(entry.field))).join(', ') })}</p>}
    </div>
  )
}

function TypeDialog({ model, view, actions }: { model: StyleDepthModel; view: StyleTypeView; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const [picked, setPicked] = useState<string>(view.type?.id ?? '')
  const types: TypeView[] = valueOf(model.types) ?? []
  const same = picked === (view.type?.id ?? '')
  const held = typeHeld(model) ?? (model.types.status === 'loading' ? 'hold.loading' : same ? 'type.held.same' : null)
  const save = () => {
    if (!held) void actions?.onSetType?.(picked || null)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('type.dialogTitle', { code: model.styleCode })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('base.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('type.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        <p className="fw-st-hint">{t('type.dialogIntro')}</p>
        {model.types.status === 'error' ? (
          <Banner tone="danger" title={t(model.types.problem)} />
        ) : (
          <Field label={t('type.field')} hint={t('type.fieldHint')}>
            <Select value={picked} onChange={(event) => setPicked(event.target.value)} disabled={model.types.status === 'loading'}>
              <option value="">{t('type.noType')}</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.code} · {type.name}
                </option>
              ))}
              {view.type && !types.some((type) => type.id === view.type?.id) && (
                <option value={view.type.id}>
                  {view.type.code} · {view.type.name}
                </option>
              )}
            </Select>
          </Field>
        )}
        <p className="fw-st-hint">{t('type.rule')}</p>
        <DialogProblem problem={model.problem} />
      </div>
    </Modal>
  )
}

// ---- names per language -------------------------------------------------------------------------------------------------

function NamesCard({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const locale = useLocale()
  const texts = valueOf(model.texts)
  const held = textsHeld(model, texts)
  return (
    <Card
      header={t('names.title')}
      description={texts ? t('names.intro', { language: languageName(texts.companyLanguage, locale) }) : t('names.introShort')}
      headerAction={
        <Button size="sm" heldReason={held ? t(held) : texts ? null : t('hold.loading')} onClick={() => actions?.onDialog?.({ kind: 'text', language: null })}>
          <Plus size={13} aria-hidden /> {t('names.add')}
        </Button>
      }
    >
      <PartBody part={model.texts} actions={actions}>
        {(value) => <NamesBody texts={value} held={held} actions={actions} />}
      </PartBody>
      {texts && model.dialog?.kind === 'text' && <TextDialog model={model} texts={texts} language={model.dialog.language} actions={actions} />}
      {texts && model.dialog?.kind === 'removeText' && <RemoveTextDialog model={model} texts={texts} language={model.dialog.language} actions={actions} />}
    </Card>
  )
}

function NamesBody({ texts, held, actions }: { texts: TextsView; held: string | null; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const locale = useLocale()
  const rows = languageRows(texts)
  return (
    <div className="fw-st-stack">
      {texts.editRefusal && <Banner tone="info" title={t('names.refused', { why: t(held ?? 'refusal.other') })} />}
      {rows.length === 0 ? (
        <EmptyState title={t('names.empty.title')} description={t('names.empty.body', { name: texts.style.name })} />
      ) : (
        <SummaryTable
          label={t('names.title')}
          density="roomy"
          stackOnPhone
          columns={[t('names.col.language'), t('names.col.name'), t('names.col.short'), t('names.col.actions')]}
          widths={['20%', '32%', undefined, '120px']}
          rows={rows.map(({ language, row, styleName }) => ({
            id: language,
            cells: [
              <span key="l" className="fw-st-cellstack">
                <b>{languageName(language, locale)}</b>
                <span className="nds-summary-sub">
                  {language}
                  {language === texts.companyLanguage ? ` · ${t('names.companyLanguage')}` : ''}
                </span>
              </span>,
              row ? (
                <span key="n">{row.name}</span>
              ) : (
                <span key="n" className="fw-st-cellstack">
                  <span>{styleName}</span>
                  <span className="nds-summary-sub">{t('names.fromStyle')}</span>
                </span>
              ),
              row?.shortDescription ?? <span key="s" className="fw-st-hint">—</span>,
              row ? (
                <span key="a" className="fw-st-inline fw-st-nowrap">
                  <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} aria-label={t('names.editOne', { language })} onClick={() => actions?.onDialog?.({ kind: 'text', language })}>
                    <Pencil size={13} aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} aria-label={t('names.removeOne', { language })} onClick={() => actions?.onDialog?.({ kind: 'removeText', language })}>
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </span>
              ) : (
                <Button key="a" size="sm" variant="quiet" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.({ kind: 'text', language: `new:${language}` })}>
                  {t('names.write')}
                </Button>
              ),
            ],
          }))}
        />
      )}
    </div>
  )
}

/** Add or change a language's names. `language` null: a new one; `new:<tag>`: a new one started from W1's name in it. */
function TextDialog({ model, texts, language, actions }: { model: StyleDepthModel; texts: TextsView; language: string | null; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const locale = useLocale()
  const preset = language?.startsWith('new:') ? language.slice(4) : null
  const isNew = language === null || preset !== null
  const row = isNew ? null : (texts.texts.find((entry) => entry.language === language) ?? null)
  const [draft, setDraft] = useState<TextDraft>(() => model.textDraft ?? (preset ? { ...textDraftOf(null, null), language: preset, name: texts.styleNames[preset] ?? '' } : textDraftOf(texts, language)))
  const [other, setOther] = useState(() => isNew && draft.language !== '' && !(COMMON_LANGUAGES as readonly string[]).includes(draft.language))
  const problems = textProblems(draft, texts, isNew)
  const first = Object.values(problems)[0] ?? null
  const unchanged = !isNew && sameText(draft, texts)
  const held = textsHeld(model, texts) ?? first ?? (unchanged ? 'text.held.same' : null)
  const set = (patch: Partial<TextDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const save = () => {
    if (held) return
    const tag = isNew ? (normaliseLanguage(draft.language) ?? draft.language) : draft.language
    void actions?.onSaveText?.({ ...draft, language: tag }, row ? row.version : null)
  }
  const free = COMMON_LANGUAGES.filter((tag) => !texts.texts.some((entry) => entry.language === tag))
  const shown = (field: keyof typeof problems) => (problems[field] && (draft[field as keyof TextDraft] !== '' || field === 'language') ? t(problems[field]!, { max: field === 'name' ? TEXT_LIMITS.name : field === 'shortDescription' ? TEXT_LIMITS.shortDescription : TEXT_LIMITS.longDescription }) : undefined)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={isNew ? t('text.titleNew') : t('text.titleEdit', { language: languageName(draft.language, locale) })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('base.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held, { max: TEXT_LIMITS.name }) : null} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('text.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        {isNew && (
          <div className="fw-st-form-grid">
            <Field label={t('text.language')} required hint={t('text.languageHint')} error={draft.language !== '' || other ? shown('language') : undefined}>
              <Select
                value={other ? 'other' : draft.language}
                onChange={(event) => {
                  if (event.target.value === 'other') {
                    setOther(true)
                    set({ language: '' })
                  } else {
                    setOther(false)
                    set({ language: event.target.value, name: draft.name || (texts.styleNames[event.target.value] ?? '') })
                  }
                }}
              >
                <option value="">{t('text.pickLanguage')}</option>
                {free.map((tag) => (
                  <option key={tag} value={tag}>
                    {languageName(tag, locale)} ({tag})
                  </option>
                ))}
                <option value="other">{t('text.otherLanguage')}</option>
              </Select>
            </Field>
            {other && (
              <Field label={t('text.tag')} hint={t('text.tagHint')}>
                <Input value={draft.language} maxLength={TEXT_LIMITS.language} onChange={(event) => set({ language: event.target.value })} autoFocus />
              </Field>
            )}
          </div>
        )}
        <Field label={t('text.name')} required error={shown('name')}>
          <Input value={draft.name} maxLength={TEXT_LIMITS.name} onChange={(event) => set({ name: event.target.value })} autoFocus={!isNew} />
        </Field>
        <Field label={t('text.short')} hint={t('text.shortHint')} error={shown('shortDescription')}>
          <Input value={draft.shortDescription} maxLength={TEXT_LIMITS.shortDescription} onChange={(event) => set({ shortDescription: event.target.value })} />
        </Field>
        <Field label={t('text.long')} hint={t('text.longHint')} error={shown('longDescription')}>
          <Textarea value={draft.longDescription} rows={5} maxLength={TEXT_LIMITS.longDescription} onChange={(event) => set({ longDescription: event.target.value })} />
        </Field>
        <p className="fw-st-hint">{t('text.readers')}</p>
        <DialogProblem problem={model.problem} />
      </div>
    </Modal>
  )
}

function RemoveTextDialog({ model, texts, language, actions }: { model: StyleDepthModel; texts: TextsView; language: string; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const locale = useLocale()
  const row = texts.texts.find((entry) => entry.language === language)
  const held = textsHeld(model, texts) ?? (row ? null : 'text.held.gone')
  const fallback = texts.styleNames[language] ? 'text.remove.toStyleName' : language === texts.companyLanguage ? 'text.remove.toStyle' : 'text.remove.toCompany'
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('text.remove.title', { language: languageName(language, locale) })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('base.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : null} onClick={() => row && void actions?.onRemoveText?.(language, row.version)}>
            {t('text.remove.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <p>{t(fallback, { language: languageName(texts.companyLanguage, locale), name: texts.styleNames[language] ?? texts.style.name })}</p>
        <DialogProblem problem={model.problem} />
      </div>
    </Modal>
  )
}

// ---- the private label --------------------------------------------------------------------------------------------------

function PrivateLabelCard({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const view = valueOf(model.privateLabel)
  return (
    <Card header={t('label.title')} description={t('label.intro')}>
      <PartBody part={model.privateLabel} actions={actions} lines={2}>
        {(value) => <LabelBody model={model} view={value} actions={actions} />}
      </PartBody>
      {view && model.dialog?.kind === 'soldUnderOurName' && <SoldDialog model={model} view={view} value={model.dialog.value} actions={actions} />}
    </Card>
  )
}

function LabelBody({ model, view, actions }: { model: StyleDepthModel; view: PrivateLabelView; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const held = soldHeld(model, view)
  const others = view.otherCustomers
  return (
    <div className="fw-st-stack">
      <span className="fw-st-inline fw-sdp-wrap">
        {view.brand ? <Pill tone="info">{t('label.mark', { brand: view.brand.name })}</Pill> : <Pill tone="neutral">{t('label.own')}</Pill>}
        {view.brand && <span className="fw-st-hint">{view.brand.code}</span>}
      </span>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('label.shownToLabel'), value: view.shownTo === 'BRAND_ONLY' && view.brand ? t('label.shown.BRAND_ONLY', { brand: view.brand.name }) : t('label.shown.EVERY_CUSTOMER') },
          {
            label: t('label.soldUnder'),
            value: (
              <span className="fw-st-inline">
                <Toggle
                  checked={view.soldUnderOurName}
                  disabled={!!held}
                  onChange={(next) => actions?.onDialog?.({ kind: 'soldUnderOurName', value: next })}
                  aria-label={t('label.soldToggle')}
                  title={held ? t(held) : undefined}
                />
                {t(view.soldUnderOurName ? 'label.sold.ours' : view.brand ? 'label.sold.theirs' : 'label.sold.ownCollection')}
              </span>
            ),
            hint: held && held !== 'label.held.noBrand' ? t(held) : undefined,
          },
          { label: t('label.declarationLabel'), value: view.declarationSender === 'BRAND' && view.brand ? t('label.declares.BRAND', { brand: view.brand.name }) : t('label.declares.COMPANY') },
        ]}
      />
      {others.openQuotes + others.openOrders > 0 && (
        <Banner tone="warning" title={t('label.others', { quotes: others.openQuotes, orders: others.openOrders })}>
          <p className="fw-st-hint">{others.parties.map((party) => `${party.name} (${party.code})`).join(', ')}</p>
        </Banner>
      )}
      <p className="fw-st-hint">{t(view.brand ? 'label.brandInIdentity' : 'label.makeForBrand')}</p>
    </div>
  )
}

function SoldDialog({ model, view, value, actions }: { model: StyleDepthModel; view: PrivateLabelView; value: boolean; actions?: StyleDepthActions }) {
  const t = useDepthT()
  const [reason, setReason] = useState('')
  const held = soldHeld(model, view) ?? (value === view.soldUnderOurName ? 'label.held.same' : reason.length > 500 ? 'hold.long' : null)
  useEffect(() => setReason(''), [value])
  const brand = view.brand?.name ?? ''
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(value ? 'label.dialog.oursTitle' : 'label.dialog.theirsTitle', { code: model.styleCode })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('base.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => void actions?.onSoldUnderOurName?.(value, reason)}>
            {t(value ? 'label.dialog.ours' : 'label.dialog.theirs')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <ul className="fw-st-list">
          <li>{t(value ? 'label.dialog.oursLabel' : 'label.dialog.theirsLabel', { brand })}</li>
          <li>{t(value ? 'label.dialog.oursDoc' : 'label.dialog.theirsDoc', { brand })}</li>
          <li>{t('label.dialog.portal', { brand })}</li>
        </ul>
        <Field label={t('base.reason')} hint={t('base.reasonHint')}>
          <Textarea value={reason} rows={2} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <DialogProblem problem={model.problem} />
      </div>
    </Modal>
  )
}
