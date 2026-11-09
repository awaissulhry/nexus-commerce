'use client'

import { useMemo } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { SizeGridEditor } from '@nexus/ui/grid/size-grid/index'
import { Button, FilterChip, Input } from '@nexus/ui/primitives'
import { ActionConfirm, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useT } from '../../../../lib/i18n/provider'
import type { AddressDraft } from '../../account/model'
import type { CatalogueRead, StyleCard, StyleDetail } from '../../catalogue/api'
import { ppeKey, styleName, typeKey } from '../../catalogue/model'
import { StyleCardView } from '../../catalogue/view/StyleCards'
import { piecesOfCells } from '../model'
import { useOrderingWords } from '../words'
import { useSizeCopy } from './LinesSection'
import { Loading, PricesNote, ReadFailed } from './parts'

/**
 * The pop-ups of New order & reorder (design portal.customer.neworder pop:style-picker, pop:new-address, pop:discard): each a
 * DS Modal (a bottom sheet on a phone) or ActionConfirm; Esc closes and the focus goes back to the opener; Tab stays inside.
 * Every button that cannot act says why.
 */

// ── Add styles ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PickerModel {
  step: 'styles' | 'sizes'
  q: string
  category: string | null
  ppe: string | null
  catalogue: { state: 'loading' | 'error' | 'ready'; read: CatalogueRead | null }
  selected: readonly string[]
  /** Step 2: each chosen style's colours and the sizes they offer. */
  details: Readonly<Record<string, { state: 'loading' | 'error' | 'ready'; detail: StyleDetail | null }>>
  /** Step 2: style → colourway → size → pieces. */
  cells: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>>
  /** `styleId|colourwayId` already on the draft → its line number. */
  onDraft: Readonly<Record<string, number>>
  prefix: string
  busy: boolean
  /** A refusal in our words (a key), or null. */
  problem: string | null
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
}

export interface PickerActions {
  onSearch?: (q: string) => void
  onFilter?: (patch: { category?: string | null; ppe?: string | null }) => void
  onToggle?: (styleId: string) => void
  onNext?: () => void
  onBack?: () => void
  onCells?: (styleId: string, cells: Record<string, Record<string, number>>) => void
  onAdd?: () => void
  onClose?: () => void
  onRetry?: () => void
  onRetryStyle?: (styleId: string) => void
}

/** The styles the picker shows: the catalogue read, narrowed by the search and the chips (on the page, no new read). */
export function pickerStyles(read: CatalogueRead | null, q: string, category: string | null, ppe: string | null, locale: 'it' | 'en'): StyleCard[] {
  const text = q.trim().toLowerCase()
  return (read?.styles ?? []).filter(
    (style) => (!text || `${style.code} ${styleName(style, locale)} ${style.name}`.toLowerCase().includes(text)) && (!category || style.productType === category) && (!ppe || style.ppe.category === ppe),
  )
}

/** Lines step 2 would add: each colour with pieces of each chosen style, not on the draft already. */
export function pickerLineCount(model: Pick<PickerModel, 'selected' | 'cells' | 'onDraft'>): number {
  let count = 0
  for (const styleId of model.selected) {
    for (const [colourwayId, cells] of Object.entries(model.cells[styleId] ?? {})) {
      if (model.onDraft[`${styleId}|${colourwayId}`] === undefined && piecesOfCells(cells) > 0) count += 1
    }
  }
  return count
}

export function StylePickerDialog({ model, actions }: { model: PickerModel; actions?: PickerActions }) {
  const words = useOrderingWords()
  const { t, locale } = words
  const copy = useSizeCopy(t)
  const read = model.catalogue.read
  const styles = useMemo(() => pickerStyles(read, model.q, model.category, model.ppe, locale), [read, model.q, model.category, model.ppe, locale])
  const lines = pickerLineCount(model)
  const count = model.selected.length
  const footer =
    model.step === 'styles' ? (
      <>
        <Button variant="secondary" onClick={() => actions?.onClose?.()}>
          {t('dialog.cancel')}
        </Button>
        <Button variant="primary" heldReason={count === 0 ? t('picker.held.none') : null} onClick={() => actions?.onNext?.()}>
          {t('picker.next', { count })}
        </Button>
      </>
    ) : (
      <>
        <Button variant="secondary" onClick={() => actions?.onBack?.()} disabled={model.busy}>
          {t('picker.back')}
        </Button>
        <Button variant="primary" heldReason={model.writeHeld ?? (model.busy ? t('held.busy') : lines === 0 ? t('picker.held.noPieces') : null)} onClick={() => actions?.onAdd?.()} aria-keyshortcuts="Meta+Enter">
          {t('picker.add', { count: lines })}
        </Button>
      </>
    )
  return (
    <Modal open onClose={() => (model.busy ? undefined : actions?.onClose?.())} sheet size="xl" title={t('picker.title')} subtitle={model.step === 'styles' ? t('picker.subtitleStyles') : t('picker.subtitleSizes')} footer={footer}>
      <div
        className="fw-pno-dialog"
        onKeyDown={(event) => {
          const target = event.target as HTMLElement
          const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
          if (event.key === '/' && !typing && model.step === 'styles') {
            event.preventDefault()
            event.currentTarget.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
          }
          if (event.key === 'Enter' && model.step === 'styles' && !typing && target.tagName !== 'BUTTON' && target.tagName !== 'A' && count > 0) actions?.onNext?.()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && model.step === 'sizes') {
            event.preventDefault()
            actions?.onAdd?.()
          }
        }}
      >
        {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
        {model.step === 'styles' ? (
          <>
            <Input type="search" aria-label={t('picker.search')} placeholder={t('picker.searchHint')} value={model.q} onChange={(event) => actions?.onSearch?.(event.target.value)} />
            {read ? (
              <div className="fw-pno-chips" role="group" aria-label={t('filters.title')}>
                {read.facets.categories.map((entry) => (
                  <FilterChip key={`c${entry.value}`} pressed={model.category === entry.value} count={entry.count} onClick={() => actions?.onFilter?.({ category: model.category === entry.value ? null : entry.value })}>
                    {t(typeKey(entry.value))}
                  </FilterChip>
                ))}
                {read.facets.ppe.map((entry) => (
                  <FilterChip key={`p${entry.value}`} pressed={model.ppe === entry.value} count={entry.count} onClick={() => actions?.onFilter?.({ ppe: model.ppe === entry.value ? null : entry.value })}>
                    {t(ppeKey(entry.value))}
                  </FilterChip>
                ))}
              </div>
            ) : null}
            {read && !read.seesPrices ? <PricesNote /> : null}
            {model.catalogue.state === 'loading' ? (
              <Loading rows={4} height={200} cards />
            ) : model.catalogue.state === 'error' || !read ? (
              <ReadFailed title={t('catalogue.failed')} onRetry={actions?.onRetry} />
            ) : styles.length === 0 ? (
              <p className="fw-pno-quiet">{read.total === 0 ? t('catalogue.empty') : t('catalogue.noMatchFilters')}</p>
            ) : (
              <ul className="fw-pno-pickergrid" aria-label={t('picker.cardsLabel')}>
                {styles.map((style) => (
                  <li key={style.id}>
                    <StyleCardView
                      style={style}
                      currency={read.currency}
                      seesPrices={read.seesPrices}
                      select={{ selected: model.selected.includes(style.id), onToggle: () => actions?.onToggle?.(style.id) }}
                      sheetHref={`${model.prefix}/catalogue/${encodeURIComponent(style.id)}/sheet`}
                    />
                  </li>
                ))}
              </ul>
            )}
            <p className="fw-pno-quiet" role="status">
              {t('picker.chosen', { count })}
            </p>
          </>
        ) : (
          model.selected.map((styleId) => {
            const entry = model.details[styleId]
            const card = read?.styles.find((style) => style.id === styleId)
            const title = card ? `${card.code} · ${styleName(card, locale)}` : styleId
            if (!entry || entry.state === 'loading') return <Loading key={styleId} rows={1} height={120} label={title} />
            if (entry.state === 'error' || !entry.detail) return <ReadFailed key={styleId} title={t('picker.styleFailed', { style: title })} onRetry={() => actions?.onRetryStyle?.(styleId)} />
            const style = entry.detail.style
            const free = style.colourways.filter((colourway) => model.onDraft[`${styleId}|${colourway.id}`] === undefined)
            const taken = style.colourways.filter((colourway) => model.onDraft[`${styleId}|${colourway.id}`] !== undefined)
            const sizes: string[] = []
            for (const colourway of style.colourways) for (const row of colourway.sizes) if (row.offered && !sizes.includes(row.size)) sizes.push(row.size)
            return (
              <section key={styleId} className="fw-pno-section" aria-label={title}>
                <h3 className="fw-pno-h3">{title}</h3>
                {entry.detail.seesPrices ? (
                  <p className="fw-pno-quiet">
                    {style.colourways.map((colourway) => `${colourway.name}: ${words.price(colourway.price, entry.detail!.currency) ?? '—'}`).join(' · ')}
                  </p>
                ) : null}
                {taken.map((colourway) => (
                  <p key={colourway.id} className="fw-pno-quiet">
                    {t('picker.onDraft', { colour: colourway.name, seq: model.onDraft[`${styleId}|${colourway.id}`]! })}
                  </p>
                ))}
                {free.length > 0 ? (
                  <SizeGridEditor
                    layout="auto"
                    colours={free.map((colourway) => ({ key: colourway.id, label: colourway.name, offered: colourway.sizes.filter((row) => row.offered).map((row) => row.size) }))}
                    sizes={sizes.map((size) => ({ key: size, label: size }))}
                    value={model.cells[styleId] ?? {}}
                    onChange={(next) => actions?.onCells?.(styleId, next)}
                    caption={t('picker.gridCaption', { style: title })}
                    locale={INTL_LOCALE[locale]}
                    copy={copy}
                  />
                ) : null}
              </section>
            )
          })
        )}
      </div>
    </Modal>
  )
}

// ── New delivery address ────────────────────────────────────────────────────────────────────────────────────────────────
export interface AddressDialogModel {
  draft: AddressDraft
  /** Field → a `portal-account` key. */
  problems: Partial<Record<keyof AddressDraft, string>>
  showProblems: boolean
  busy: boolean
  /** A refusal in our words (a key of this catalogue), or null. */
  failed: string | null
  /** The API's refusal at a field, in our words (keys of this catalogue). */
  refused: Partial<Record<keyof AddressDraft, string>>
}

export interface AddressDialogActions {
  onField?: (field: keyof AddressDraft, value: string) => void
  onSave?: () => void
  onClose?: () => void
}

/** The account's own field words (B-W2b-196: "same words"), this page's sentence about the check of a new address. */
export function NewAddressDialog({ model, actions }: { model: AddressDialogModel; actions?: AddressDialogActions }) {
  const { t } = useOrderingWords()
  const account = useT('portal-account')
  const error = (name: keyof AddressDraft) => (model.showProblems && model.problems[name] ? account(model.problems[name]!) : model.refused[name] ? t(model.refused[name]!) : undefined)
  const input = (name: keyof AddressDraft, extra: { autoComplete?: string; maxLength?: number; autoFocus?: boolean } = {}) => (
    <Input value={model.draft[name]} autoComplete={extra.autoComplete ?? 'off'} maxLength={extra.maxLength} {...(extra.autoFocus ? { 'data-autofocus': true } : {})} onChange={(event) => actions?.onField?.(name, event.target.value)} />
  )
  return (
    <Modal
      open
      onClose={() => (model.busy ? undefined : actions?.onClose?.())}
      sheet
      size="lg"
      title={t('address.title')}
      subtitle={account('address.subtitle')}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()} disabled={model.busy}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="primary" heldReason={model.busy ? t('state.saving') : null} onClick={() => actions?.onSave?.()}>
            {account('address.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pno-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onSave?.()
        }}
      >
        <Banner tone="info">{t('address.check')}</Banner>
        {model.failed ? <Banner tone="danger" title={t(model.failed)} /> : null}
        <Field label={account('address.name')} hint={account('address.nameHint')} error={error('name')}>
          {input('name', { autoFocus: true })}
        </Field>
        <Field label={account('address.line1')} required error={error('line1')}>
          {input('line1', { autoComplete: 'address-line1' })}
        </Field>
        <Field label={account('address.line2')} error={error('line2')}>
          {input('line2', { autoComplete: 'address-line2' })}
        </Field>
        <div className="fw-pno-address-grid">
          <Field label={account('address.postalCode')} required error={error('postalCode')}>
            {input('postalCode', { autoComplete: 'postal-code', maxLength: 20 })}
          </Field>
          <Field label={account('address.city')} required error={error('city')}>
            {input('city', { autoComplete: 'address-level2' })}
          </Field>
          <Field label={account('address.province')} error={error('province')}>
            {input('province', { autoComplete: 'address-level1', maxLength: 50 })}
          </Field>
          <Field label={account('address.country')} required hint={account('address.countryHint')} error={error('country')}>
            {input('country', { autoComplete: 'country', maxLength: 2 })}
          </Field>
        </div>
        <div className="fw-pno-address-pair">
          <Field label={account('address.contactName')} error={error('contactName')}>
            {input('contactName')}
          </Field>
          <Field label={account('address.phone')} error={error('phone')}>
            {input('phone', { autoComplete: 'tel', maxLength: 50 })}
          </Field>
        </div>
        <Field label={account('address.notes')} hint={account('address.notesHint')} error={error('deliveryNotes')}>
          <Textarea value={model.draft.deliveryNotes} rows={2} maxLength={1000} onChange={(event) => actions?.onField?.('deliveryNotes', event.target.value)} />
        </Field>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  )
}

// ── Discard this draft? ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface DiscardModel {
  lines: number
  busy: boolean
  /** A refusal in our words (a key), or null. */
  failed: string | null
}

export function DiscardDialog({ model, onConfirm, onCancel }: { model: DiscardModel; onConfirm?: () => void; onCancel?: () => void }) {
  const { t } = useOrderingWords()
  return (
    <ActionConfirm
      impact={{
        level: 'confirm',
        reach: 'local',
        title: t('discard.title'),
        acknowledge: t('discard.acknowledge'),
        confirmLabel: model.busy ? t('state.saving') : t('discard.confirm'),
        consequences: [t('discard.lines', { count: model.lines }), t('discard.noNumber')],
        reversal: { verb: t('discard.back'), fidelity: 'none' },
        ...(model.failed ? { refusal: { reason: t(model.failed) } } : {}),
      }}
      onConfirm={() => (model.busy ? undefined : onConfirm?.())}
      onCancel={() => onCancel?.()}
    />
  )
}
