'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CircleAlert, CircleCheck, Copy, Search } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, Pill, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { StyleRow } from '../../api'
import { STATUS_TONE, type StyleAbilities } from '../../model'
import { duplicateHeld, noteWords, orderedParts, partWords, refusedAt, togglePart, type DuplicateDraft, type DuplicateModel } from '../duplicate-model'

export interface DuplicateActions {
  onClose?: () => void
  /** The picker's search (New style › Start from: Copy of a style). */
  onPickQuery?: (query: string) => void
  onPickSource?: (row: StyleRow) => void
  /** Back to the picker (another source). */
  onRepick?: () => void
  onDraft?: (draft: DuplicateDraft) => void
  onRetryOffer?: () => void
  onDuplicate?: () => void
}

/**
 * Duplicate style (W2a; design products.styles pop:styles.duplicate, opened from a row's ⋯, the studio's ⋯, and New
 * style › Start from: Copy of a style): the source (picked first when the dialog starts from New style), the new code
 * and name, the parts to copy — BOM · measurements · routing · labels, each saying what it holds or why it cannot be
 * picked; pictures and options are held with their W2b reason — and what the copy always takes. "The copy starts as a
 * draft linked to its source": its first revision and its history say where it came from. After the copy: what it took,
 * what it left out (in our words) and Open the copy. ⌘↵ duplicates. It fetches nothing.
 */
export function DuplicateDialog({ model, can, prefix, actions }: { model: DuplicateModel; can: Pick<StyleAbilities, 'manage'>; prefix: string; actions?: DuplicateActions }) {
  const t = useT('products')
  const held = duplicateHeld(model, can)
  const go = () => {
    if (!held && !model.done) actions?.onDuplicate?.()
  }
  const title = model.done ? t('duplicate.doneTitle', { code: model.done.style.code }) : model.source ? t('duplicate.title', { code: model.source.code }) : t('duplicate.pickTitle')
  const copyHref = model.done ? `${prefix}/products/styles/${model.done.style.id}?tab=overview` : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={title}
      subtitle={model.done ? undefined : t('duplicate.subtitle')}
      size="lg"
      busy={model.busy}
      footer={
        model.done ? (
          <>
            <Button onClick={() => actions?.onClose?.()}>{t('common.close')}</Button>
            {copyHref && (
              <Button variant="primary" asChild>
                <Link href={copyHref}>{t('duplicate.openCopy', { code: model.done.style.code })}</Link>
              </Button>
            )}
          </>
        ) : (
          <>
            <Button onClick={() => actions?.onClose?.()}>{t('common.back')}</Button>
            <Button variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
              <Copy size={13} aria-hidden /> {t('duplicate.go')}
            </Button>
          </>
        )
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        {model.done ? <Done model={model} /> : model.source ? <Form model={model} actions={actions} /> : <Picker model={model} actions={actions} />}
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}

/** The source style, picked from a search (Start from: Copy of a style). */
function Picker({ model, actions }: { model: DuplicateModel; actions?: DuplicateActions }) {
  const t = useT('products')
  const [query, setQuery] = useState(model.pick?.query ?? '')
  const search = useRef(actions?.onPickQuery)
  search.current = actions?.onPickQuery
  const first = useRef(true)
  useEffect(() => {
    if (first.current && model.pick?.results) {
      first.current = false
      return
    }
    first.current = false
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const results = model.pick?.results ?? null
  return (
    <>
      <p className="fw-st-hint">{t('duplicate.pickIntro')}</p>
      <Field label={t('duplicate.pickSearch')}>
        <Input type="search" autoFocus leadingIcon={<Search size={13} aria-hidden />} value={query} onChange={(event) => setQuery(event.target.value)} />
      </Field>
      {model.pick?.problem ? (
        <Banner tone="danger" title={t(model.pick.problem)} />
      ) : results === null ? (
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('duplicate.pickSearching')}
        </p>
      ) : results.length === 0 ? (
        <p className="fw-st-hint">{t('duplicate.pickNone')}</p>
      ) : (
        <ul className="fw-st-pick" aria-label={t('duplicate.pickList')}>
          {results.map((row) => (
            <li key={row.id}>
              <button type="button" className="fw-st-pick-row fw-st-pick-button" onClick={() => actions?.onPickSource?.(row)}>
                <span className="fw-st-cellstack">
                  <span className="fw-st-inline">
                    <b>{row.code}</b> {row.name} <Pill tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Pill>
                  </span>
                  <span className="fw-st-hint">
                    {[t(`productType.${row.productType}`), row.season, row.releasedRevision !== null ? t('list.rev.released', { revision: row.releasedRevision }) : row.draftRevision !== null ? t('list.rev.draft', { revision: row.draftRevision }) : t('list.noRevision')]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="fw-st-hint">{t('duplicate.after')}</p>
    </>
  )
}

function Form({ model, actions }: { model: DuplicateModel; actions?: DuplicateActions }) {
  const t = useT('products')
  const draft = model.draft
  const set = (patch: Partial<DuplicateDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const offer = model.offer?.status === 'ready' ? model.offer.value : null
  const source = model.source!
  return (
    <>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          {
            label: t('duplicate.source'),
            value: (
              <span className="fw-st-inline">
                <b>{source.code}</b> {source.name}
                {actions?.onRepick && (
                  <Button size="sm" variant="link" onClick={() => actions.onRepick?.()}>
                    {t('duplicate.repick')}
                  </Button>
                )}
              </span>
            ),
          },
          {
            label: t('duplicate.partsFrom'),
            value: !offer ? '—' : offer.revision ? t('duplicate.revision', { revision: offer.revision.revision, status: t(`revisionStatus.${offer.revision.status}`) }) : t('duplicate.noRevision'),
          },
        ]}
      />
      <div className="fw-st-form-grid">
        <Field label={t('duplicate.code')} required hint={t('identity.codeHint')} error={refusedAt(model.refused, 'code') ? t('duplicate.refusedCode') : undefined}>
          <Input value={draft.code} maxLength={24} autoFocus onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
        </Field>
        <Field label={t('duplicate.name')} required error={refusedAt(model.refused, 'name') ? t('newStyle.refused') : undefined}>
          <Input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label={t('identity.season')} hint={t('duplicate.seasonHint')}>
          <Input value={draft.season} maxLength={20} onChange={(event) => set({ season: event.target.value })} />
        </Field>
      </div>

      <h3 className="fw-st-h3">{t('duplicate.parts')}</h3>
      {!model.offer || model.offer.status === 'loading' ? (
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('duplicate.reading')}
        </p>
      ) : model.offer.status === 'error' ? (
        <Banner
          tone="danger"
          title={t('duplicate.offerFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetryOffer?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.offer.problem)}
        </Banner>
      ) : (
        <div className="fw-st-parts" role="group" aria-label={t('duplicate.parts')}>
          {orderedParts(model.offer.value).map((part) => {
            const words = partWords(part, model.offer?.status === 'ready' ? model.offer.value : { source: { ...source, status: 'DRAFT' }, revision: null })
            const on = draft.parts.includes(part.part as never)
            const refused = refusedAt(model.refused, 'parts') && !part.available
            return (
              <CheckboxCard
                key={part.part}
                title={
                  <span className="fw-st-inline">
                    {t(`duplicate.part.${part.part}`)}
                    {!part.available && <Tag tone={part.part === 'PICTURES' || part.part === 'OPTIONS' ? 'neutral' : 'warning'}>{t(part.part === 'PICTURES' || part.part === 'OPTIONS' ? 'duplicate.later' : 'duplicate.notNow')}</Tag>}
                    {refused && <Tag tone="danger">{t('duplicate.refusedPart')}</Tag>}
                  </span>
                }
                description={t(words.key, words.params)}
                checked={on}
                selected={on}
                disabled={!part.available || model.busy}
                onChange={() => {
                  if (offer) set(togglePart(draft, offer, part.part))
                }}
              />
            )
          })}
        </div>
      )}
      <ul className="fw-st-list">
        <li>{t('duplicate.always')}</li>
        <li>{t('duplicate.linked')}</li>
        {offer && offer.droppedSizes.length > 0 && (
          <li className="fw-st-inline">
            <CircleAlert size={13} aria-hidden /> {t('duplicate.note.sizes', { sizes: offer.droppedSizes.join(', ') })}
          </li>
        )}
      </ul>
      <Field label={t('duplicate.skus')} hint={t('duplicate.skusHint', { count: offer?.colourways ?? 0 })}>
        <span className="fw-st-inline">
          <Toggle checked={draft.generateSkus} onChange={(next) => set({ generateSkus: next })} aria-label={t('duplicate.skus')} />
          {t(draft.generateSkus ? 'common.yes' : 'common.no')}
        </span>
      </Field>
    </>
  )
}

function Done({ model }: { model: DuplicateModel }) {
  const t = useT('products')
  const done = model.done!
  const copied = done.copied
  return (
    <>
      <Banner tone="success" title={<span className="fw-st-inline"><CircleCheck size={14} aria-hidden /> {t('duplicate.done', { code: done.style.code, from: copied.from.code })}</span>}>
        <p>{copied.from.revision !== null ? t('duplicate.doneRevision', { revision: copied.from.revision }) : t('duplicate.doneNoRevision')}</p>
      </Banner>
      <KeyValue
        columns={2}
        dense
        labelCase="sentence"
        items={[
          { label: t('duplicate.copied.parts'), value: copied.parts.length ? copied.parts.map((part) => t(`duplicate.part.${part}`)).join(' · ') : t('duplicate.copied.identityOnly') },
          { label: t('duplicate.copied.colourways'), value: String(copied.colourways) },
          { label: t('duplicate.copied.bomLines'), value: String(copied.bomLines) },
          { label: t('duplicate.copied.routingSteps'), value: String(copied.routingSteps) },
          { label: t('duplicate.copied.label'), value: t(copied.label ? 'common.yes' : 'common.no') },
          { label: t('duplicate.copied.skus'), value: String(copied.skus) },
        ]}
      />
      {done.notes.length > 0 && (
        <Banner tone="warning" title={t('duplicate.notesTitle', { count: done.notes.length })}>
          <ul className="fw-st-list">
            {done.notes.map((note, index) => {
              const words = noteWords(note)
              return <li key={index}>{t(words.key, words.params)}</li>
            })}
          </ul>
        </Banner>
      )}
      <p className="fw-st-hint">{t('duplicate.doneNext')}</p>
    </>
  )
}
