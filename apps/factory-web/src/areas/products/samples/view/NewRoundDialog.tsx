'use client'

import { useEffect, useMemo, useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { SizeGridEditor, type SizeGridColour } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Kbd, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { PartyOption, StyleDetail, StyleOption } from '../api'
import { ANY_COLOUR, latestRevision, newDraftHeld, piecesOfGrid, SAMPLE_KINDS, type NewDraft, type Notice, type Phrase, type SamplesCan, type SampleKind } from '../model'
import { NoticeLine, useWords } from '../parts'
import { useGridCopy } from './grid-copy'

/** New sample request (design pop:samples.new): style, revision (latest by default), type and round, sizes and colours, due day, customer. */
export interface NewRoundModel {
  draft: NewDraft
  styles: { q: string; items: StyleOption[] | null; problem: string | null }
  style: { item: StyleDetail | null; reading: boolean; problem: string | null }
  /** The customers and brands (null without parties.view: the round is internal or the style's brand). */
  customers: { items: PartyOption[] | null; problem: string | null } | null
  busy: boolean
  notice: Notice | null
  lines: readonly Phrase[]
  offline: boolean
}

export interface NewRoundActions {
  onDraft?: (patch: Partial<NewDraft>) => void
  onFindStyles?: (q: string) => void
  onPickStyle?: (styleId: string | null) => void
  onSubmit?: () => void
  onClose?: () => void
}

const CURRENCIES = ['EUR', 'GBP', 'USD', 'CHF'] as const

export function NewRoundDialog({ model, can, actions }: { model: NewRoundModel; can: SamplesCan; actions?: NewRoundActions }) {
  const { t, say, locale } = useWords()
  const copy = useGridCopy()
  const [q, setQ] = useState(model.styles.q)
  useEffect(() => setQ(model.styles.q), [model.styles.q])
  const style = model.style.item
  const draft = model.draft
  const held = newDraftHeld(draft, style, can, model.offline)
  const heldText = model.busy ? t('common.working') : say(held)
  const latest = latestRevision(style)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held && !model.busy) {
        event.preventDefault()
        actions?.onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, model.busy, actions])

  const colours = useMemo<SizeGridColour[]>(() => {
    if (!style) return []
    const active = style.colourways.filter((colourway) => colourway.status !== 'ARCHIVED')
    return [{ key: ANY_COLOUR, label: t('grid.anyColour') }, ...active.map((colourway) => ({ key: colourway.id, label: `${colourway.code} · ${colourway.name}`, offered: colourway.offeredSizes.length > 0 ? colourway.offeredSizes : null }))]
  }, [style, t])
  const sizes = useMemo(() => (style ? style.sizes.map((size) => ({ key: size, label: size })) : []), [style])
  const pieces = piecesOfGrid(draft.grid)
  const customerOptions = model.customers?.items ?? []

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('new.title')}
      size="xl"
      footer={
        <>
          <span className="fw-smp-hint">{t('new.pieces', { count: pieces })}</span>
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {t('new.submit')}
            <span className="fw-smp-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
          </Button>
        </>
      }
    >
      <div className="fw-smp-form">
        <div className="fw-smp-form-grid">
          <Field label={t('new.style')} required hint={t('new.styleHint')}>
            <div className="fw-smp-pick">
              <Input
                size="sm"
                type="search"
                aria-label={t('new.styleSearch')}
                placeholder={t('new.styleSearch')}
                value={q}
                onChange={(event) => setQ(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    actions?.onFindStyles?.(q)
                  }
                }}
                onBlur={() => q !== model.styles.q && actions?.onFindStyles?.(q)}
              />
              {model.styles.items === null && !model.styles.problem ? (
                <Skeleton height={32} />
              ) : (
                <Select size="sm" aria-label={t('new.style')} value={draft.styleId ?? ''} onChange={(event) => actions?.onPickStyle?.(event.target.value || null)}>
                  <option value="">{model.styles.items && model.styles.items.length === 0 ? t('new.noStyles') : t('new.pickStyle')}</option>
                  {(model.styles.items ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} · {item.name}
                    </option>
                  ))}
                  {style && !(model.styles.items ?? []).some((item) => item.id === style.id) && (
                    <option value={style.id}>
                      {style.code} · {style.name}
                    </option>
                  )}
                </Select>
              )}
            </div>
          </Field>
          <Field label={t('new.revision')} hint={t('new.revisionHint')}>
            <Select size="sm" value={draft.revisionId ?? ''} disabled={!style} onChange={(event) => actions?.onDraft?.({ revisionId: event.target.value || null })}>
              <option value="">{latest ? t('new.latest', { revision: latest.revision, status: t(`revision.${latest.status}`) }) : t('new.noRevision')}</option>
              {(style?.revisions ?? [])
                .filter((revision) => revision.status !== 'OBSOLETE')
                .sort((a, b) => b.revision - a.revision)
                .map((revision) => (
                  <option key={revision.id} value={revision.id}>
                    {t('new.revisionOption', { revision: revision.revision, status: t(`revision.${revision.status}`) })}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('new.kind')} required>
            <Select size="sm" value={draft.kind} onChange={(event) => actions?.onDraft?.({ kind: event.target.value as SampleKind })}>
              {SAMPLE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.roundNo')} hint={t('new.roundNoHint')}>
            <Input size="sm" inputMode="numeric" value={draft.roundNo} placeholder={t('new.roundNoNext')} onChange={(event) => actions?.onDraft?.({ roundNo: event.target.value })} />
          </Field>
          <Field label={t('new.customer')} hint={model.customers ? t('new.customerHint') : t('new.customerNoRight')}>
            <Select size="sm" value={draft.partyId ?? ''} disabled={!model.customers} onChange={(event) => actions?.onDraft?.({ partyId: event.target.value || null })}>
              <option value="">{t('new.internal')}</option>
              {customerOptions.map((party) => (
                <option key={party.id} value={party.id}>
                  {party.code} · {party.tradeName ?? party.legalName}
                </option>
              ))}
              {style?.brand && !customerOptions.some((party) => party.id === style.brand!.id) && (
                <option value={style.brand.id}>
                  {style.brand.code} · {style.brand.name}
                </option>
              )}
            </Select>
          </Field>
          <Field label={t('new.due')}>
            <DateField value={draft.dueDate} clearable onChange={(value) => actions?.onDraft?.({ dueDate: value })} />
          </Field>
          {can.price && (
            <Field label={t('new.charge')} hint={draft.partyId ? t('new.chargeHint') : t('refusal.CHARGE_INTERNAL')}>
              <div className="fw-smp-pick fw-smp-pick-row">
                <Input size="sm" inputMode="decimal" value={draft.charge} disabled={!draft.partyId} aria-label={t('new.charge')} onChange={(event) => actions?.onDraft?.({ charge: event.target.value })} />
                <Select size="sm" aria-label={t('new.currency')} value={draft.currency} disabled={!draft.partyId} onChange={(event) => actions?.onDraft?.({ currency: event.target.value })}>
                  {CURRENCIES.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
          )}
        </div>
        {model.style.problem && <Banner tone="danger" title={t('new.styleFailed')}>{t(model.style.problem)}</Banner>}
        {model.styles.problem && <Banner tone="danger" title={t('new.stylesFailed')}>{t(model.styles.problem)}</Banner>}
        {model.customers?.problem && <Banner tone="warning" title={t('new.customersFailed')}>{t(model.customers.problem)}</Banner>}
        <section className="fw-smp-section" aria-label={t('new.cells')}>
          <h3 className="fw-smp-h3">{t('new.cells')}</h3>
          {model.style.reading ? (
            <Skeleton height={120} />
          ) : style ? (
            style.sizes.length === 0 ? (
              <p className="fw-smp-hint">{t('new.noSizes')}</p>
            ) : (
              <div className="fw-smp-bleed">
                <SizeGridEditor colours={colours} sizes={sizes} value={draft.grid} onChange={(grid) => actions?.onDraft?.({ grid })} max={1000} layout="auto" locale={INTL_LOCALE[locale]} copy={copy} caption={t('new.cells')} />
              </div>
            )
          ) : (
            <p className="fw-smp-hint">{t('new.pickStyleFirst')}</p>
          )}
        </section>
        {draft.kind === 'CERTIFICATION' && (
          <Field label={t('new.testZones')} hint={t('new.testZonesHint')}>
            <Textarea value={draft.testZones} rows={2} honourRows maxLength={1000} onChange={(event) => actions?.onDraft?.({ testZones: event.target.value })} />
          </Field>
        )}
        <Field label={t('new.instructions')}>
          <Textarea value={draft.instructions} rows={3} honourRows maxLength={4000} onChange={(event) => actions?.onDraft?.({ instructions: event.target.value })} />
        </Field>
        <NoticeLine notice={model.notice} lines={model.lines} />
      </div>
    </Modal>
  )
}
