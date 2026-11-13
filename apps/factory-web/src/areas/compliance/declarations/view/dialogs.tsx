'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Select, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import type { Preview } from '../api'
import { KINDS, languageCheck, mayGenerate, packHref, recordHref } from '../model'
import type { DeclarationsPageActions, DeclarationsPageModel, NewState, TranslateState, UnrecordedState } from '../view-model'
import { LanguageTag, PartFailed, PartLoading, ProblemList, SourceTag, useDay, useLanguage, useWords } from './parts'
import { MultiSelect } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/** The languages a new draft may be made in: the markets' languages and the factory's two (a prefill keeps its own). */
export function languageOptions(coverage: readonly string[], extra: readonly (string | null)[] = []): string[] {
  return [...new Set([...coverage, 'it', 'en', ...extra.filter((tag): tag is string => !!tag)])].sort()
}

/** The market codes the coverage names (each language's markets). */
export function marketOptions(model: DeclarationsPageModel): string[] {
  const coverage = model.coverage.status === 'ready' ? model.coverage.value : null
  return [...new Set((coverage?.rows ?? []).flatMap((row) => row.cells.flatMap((cell) => cell.markets)))].sort()
}

/** Why Create is held (a key), or null. */
export function createHeld(model: DeclarationsPageModel, state: NewState): string | null {
  if (state.busy) return 'held.busy'
  if (!model.online) return 'held.offline'
  if (!mayGenerate(model.can, state.kind)) return state.kind === 'USER_INFORMATION' ? 'held.uiGenerate' : 'held.generate'
  if (!state.styleId) return 'held.chooseStyle'
  if (state.languages.length === 0) return 'held.chooseLanguage'
  if (!state.preview || state.preview.status === 'loading') return 'held.previewing'
  if (state.preview.status === 'error') return 'held.previewFailed'
  const preview = state.preview.value
  if (preview.existing) return preview.existing.status === 'WITHDRAWN' ? 'refusal.WITHDRAWN' : 'refusal.EXISTS'
  if (preview.blocking.length > 0) return 'held.blocking'
  return null
}

/**
 * New declaration (design pop:dc-new): the style (the PPE styles the coverage lists), the kind, the original's language and
 * its translations, the market it is made for (its operators: the importer line) and — user information — the markets whose
 * language packs start with it; below, the preview of what each point or section will hold and where it comes from
 * (SourceIndicator), what refuses it and what to check. Create makes a DRAFT (GATE-PPE-TEXTS) in one command.
 */
export function NewDeclarationDialog({ model, state, actions }: { model: DeclarationsPageModel; state: NewState; actions?: DeclarationsPageActions | undefined }) {
  const t = useWords()
  const language = useLanguage()
  const coverage = model.coverage.status === 'ready' ? model.coverage.value : null
  const styles = useMemo(() => {
    const seen = new Map<string, { id: string; code: string; name: string; revision: number | null }>()
    for (const row of coverage?.rows ?? []) seen.set(row.style.id, row.style)
    return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code))
  }, [coverage])
  const options = languageOptions(coverage?.languages ?? [], state.languages)
  const markets = marketOptions(model)
  const original = state.languages[0] ?? ''
  const translations = state.languages.slice(1)
  const held = createHeld(model, state)
  const preview = state.preview?.status === 'ready' ? state.preview.value : null
  const close = () => actions?.onAddress?.({ add: false })

  return (
    <Modal
      open
      onClose={close}
      title={t('new.title')}
      size="xl"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onCreate?.()}>
            {state.busy ? <Spinner size={12} /> : null} {t('new.create', { count: state.languages.length })}
          </Button>
        </>
      }
    >
      <div className="fw-dc-form">
        <Banner tone="info" title={t('new.draftNote')} />
        <div className="fw-dc-formgrid">
          <Field label={t('new.style')} required hint={styles.length === 0 ? t('new.noStyles') : t('new.styleHint')}>
            <Select value={state.styleId ?? ''} onChange={(event) => actions?.onNew?.({ styleId: event.target.value || null })}>
              <option value="">{t('new.chooseStyle')}</option>
              {styles.map((style) => (
                <option key={style.id} value={style.id}>
                  {`${style.code} · ${style.name}${style.revision !== null ? ` · ${t('common.rev', { revision: style.revision })}` : ''}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.kind')}>
            <SegmentedControl
              ariaLabel={t('new.kind')}
              value={state.kind}
              onChange={(value) => actions?.onNew?.({ kind: value as NewState['kind'] })}
              options={KINDS.map((kind) => ({ value: kind, label: t(`kindShort.${kind}`), disabled: !mayGenerate(model.can, kind) }))}
            />
          </Field>
          <Field label={t('new.original')} required hint={t('new.originalHint')}>
            <Select value={original} onChange={(event) => actions?.onNew?.({ languages: event.target.value ? [event.target.value, ...translations.filter((tag) => tag !== event.target.value)] : translations })}>
              <option value="">{t('new.chooseLanguage')}</option>
              {options.map((tag) => (
                <option key={tag} value={tag}>
                  {language(tag)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('new.translations')} hint={t('new.translationsHint')}>
            <MultiSelect
              ariaLabel={t('new.translations')}
              options={options.filter((tag) => tag !== original).map((tag) => ({ value: tag, label: language(tag) }))}
              value={translations}
              onChange={(next) => actions?.onNew?.({ languages: original ? [original, ...next] : next })}
              placeholder={t('new.none')}
              formatLabel={(value) => value.map((tag) => tag.toUpperCase()).join(', ')}
              heldReason={original ? null : t('held.originalFirst')}
            />
          </Field>
          <Field label={t('new.market')} hint={t('new.marketHint')}>
            <Select value={state.marketCode ?? ''} onChange={(event) => actions?.onNew?.({ marketCode: event.target.value || null })}>
              <option value="">{t('new.everyMarket')}</option>
              {markets.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          {state.kind === 'USER_INFORMATION' && (
            <Field label={t('new.packs')} hint={t('new.packsHint')}>
              <MultiSelect ariaLabel={t('new.packs')} options={markets.map((code) => ({ value: code, label: code }))} value={[...state.packs]} onChange={(next) => actions?.onNew?.({ packs: next })} placeholder={t('new.none')} />
            </Field>
          )}
          {model.companies.length > 1 && preview && preview.companyId === null && (
            <Field label={t('new.company')} hint={t('new.companyHint')}>
              <Select value={state.companyId ?? ''} onChange={(event) => actions?.onNew?.({ companyId: event.target.value || null })}>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {`${company.code} · ${company.name}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {state.problem && <Banner tone="danger" title={t(state.problem.key)} />}
        <PreviewPart model={model} state={state} />
      </div>
    </Modal>
  )
}

/** The New declaration preview: what will be filled from the records, point by point, with each value's source. */
function PreviewPart({ model, state }: { model: DeclarationsPageModel; state: NewState }) {
  const t = useWords()
  if (!state.styleId || state.languages.length === 0) return <p className="fw-dc-muted">{t('new.previewWaits')}</p>
  if (!state.preview || state.preview.status === 'loading') return <PartLoading rows={5} height={22} />
  if (state.preview.status === 'error') return <PartFailed title={t('new.previewFailed')} problem={state.preview.problem} />
  const preview: Preview = state.preview.value
  const parts = preview.kind === 'USER_INFORMATION' ? preview.sections.map((section) => ({ id: section.key, text: section.text, source: section.source, values: section.values })) : preview.points.map((point) => ({ id: point.point, text: point.text, source: point.source, values: point.values }))
  return (
    <section className="fw-dc-stack" aria-labelledby="fw-dc-preview">
      <h3 id="fw-dc-preview" className="fw-dc-h3">
        {t('new.previewTitle', { language: preview.language.toUpperCase(), revision: preview.revision?.revision ?? '—' })}
      </h3>
      {preview.existing && (
        <Banner tone="warning" title={t(preview.existing.status === 'WITHDRAWN' ? 'refusal.WITHDRAWN' : 'refusal.EXISTS')}>
          <Link className="fw-dc-link" href={recordHref(model.prefix, preview.existing.id)}>
            {t('new.openExisting')}
          </Link>
        </Banner>
      )}
      <ProblemList problems={[...preview.blocking, ...preview.warnings]} kind={preview.kind} />
      <dl className="fw-dc-facts">
        <div>
          <dt>{t('new.fact.maker')}</dt>
          <dd>{preview.maker ? `${preview.maker.name} · ${preview.maker.address}` : t('new.fact.noMaker')}</dd>
        </div>
        <div>
          <dt>{t('new.fact.certificate')}</dt>
          <dd>{preview.certificate ? t('new.fact.certificateIs', { number: preview.certificate.number, body: preview.certificate.body, bodyNumber: preview.certificate.bodyNumber }) : t('new.fact.noCertificate')}</dd>
        </div>
        <div>
          <dt>{t('new.fact.standards')}</dt>
          <dd>{preview.standards.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>{t('new.fact.number')}</dt>
          <dd>{preview.number ?? '—'}</dd>
        </div>
      </dl>
      {preview.missingPhrases.length > 0 && <p className="fw-dc-muted">{t('new.missingPhrases', { count: preview.missingPhrases.length })}</p>}
      <ol className="fw-dc-points">
        {parts.map((part) => (
          <li key={part.id} className="fw-dc-point">
            <span className="fw-dc-pointhead">
              <b>{preview.kind === 'USER_INFORMATION' ? t(`section.${part.id}`) : t('part.point', { id: part.id })}</b>
              <SourceTag source={part.source} prefix={model.prefix} showLabel />
            </span>
            <span className="fw-dc-pointtext">{part.text}</span>
            {part.values.length > 0 && (
              <span className="fw-dc-values">
                {part.values.map((value, index) => (
                  <span key={`${value.field}-${index}`} className="fw-dc-value">
                    <SourceTag source={value.source} value={value.value} prefix={model.prefix} />
                    <span>{value.value}</span>
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Translate (design pop:dc-translate): the languages to add to an original; words the phrase library lacks stay to type. */
export function TranslateDialog({ state, actions }: { state: TranslateState; actions?: DeclarationsPageActions | undefined }) {
  const t = useWords()
  const language = useLanguage()
  const held = state.busy ? 'held.busy' : state.languages.length === 0 ? 'held.chooseLanguage' : null
  return (
    <Modal
      open
      onClose={() => actions?.onTranslate?.(null)}
      title={t('translate.title', { label: state.label })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onTranslate?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onStartTranslate?.()}>
            {t('translate.start', { count: state.languages.length })}
          </Button>
        </>
      }
    >
      <div className="fw-dc-form">
        <p className="fw-dc-p">{t('translate.body')}</p>
        <Field label={t('translate.languages')}>
          <MultiSelect ariaLabel={t('translate.languages')} options={state.options.map((tag) => ({ value: tag, label: language(tag) }))} value={[...state.languages]} onChange={(next) => actions?.onTranslate?.({ languages: next })} placeholder={t('new.none')} formatLabel={(value) => value.map((tag) => tag.toUpperCase()).join(', ')} />
        </Field>
        <p className="fw-dc-muted">{t('translate.check')}</p>
        {state.problem && <Banner tone="danger" title={t(state.problem.key)} />}
      </div>
    </Modal>
  )
}

/**
 * Language check (design pop:dc-langcheck): per style and kind, the languages the markets sold need (and which markets ask for
 * each gap) against what is issued, gaps first; "Translate the gaps" adds every missing language to the generated original of
 * each row that has one (one call per row). A row without an original is said, with New declaration.
 */
export function LanguageCheckDialog({ model, actions }: { model: DeclarationsPageModel; actions?: DeclarationsPageActions | undefined }) {
  const t = useWords()
  const coverage = model.coverage.status === 'ready' ? model.coverage.value : null
  const rows = useMemo(() => (coverage && model.list.status === 'ready' ? languageCheck(coverage, model.list.value.declarations, model.can) : null), [coverage, model.list, model.can])
  const ready = (rows ?? []).filter((row) => row.held === null)
  const busy = model.check?.busy ?? false
  const close = () => actions?.onAddress?.({ check: false })
  const held = busy ? 'held.busy' : !model.online ? 'held.offline' : ready.length === 0 ? 'held.noneTranslatable' : null
  return (
    <Modal
      open
      onClose={close}
      title={t('check.title')}
      size="xl"
      footer={
        <>
          <Button onClick={close}>{t('common.close')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onTranslateGaps?.(ready.map((row) => row.key))}>
            {t('check.translate', { count: ready.length })}
          </Button>
        </>
      }
    >
      <div className="fw-dc-form">
        <p className="fw-dc-p">{t('check.body')}</p>
        {model.coverage.status === 'error' ? (
          <PartFailed title={t('coverage.failed')} problem={model.coverage.problem} onRetry={() => actions?.onRetry?.('coverage')} />
        ) : !rows ? (
          <PartLoading rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState title={t('coverage.emptyTitle')} description={t('coverage.empty')} />
        ) : (
          <SummaryTable
            label={t('check.title')}
            stackOnPhone
            columns={[t('check.col.style'), t('check.col.kind'), t('check.col.needed'), t('check.col.issued'), t('check.col.gaps'), t('check.col.next')]}
            rows={rows.map((row) => ({
              id: row.key,
              cells: [
                `${row.row.style.code} · ${row.row.style.name}`,
                t(`kindShort.${row.row.kind}`),
                row.needed.map((tag) => tag.toUpperCase()).join(', ') || '—',
                row.issued.map((tag) => tag.toUpperCase()).join(', ') || t('check.noneIssued'),
                row.gaps.length === 0 ? (
                  t('check.noGaps')
                ) : (
                  <span key="g" className="fw-dc-cell">
                    {row.gaps.map((tag) => {
                      const cell = row.row.cells.find((entry) => entry.language === tag)
                      return (
                        <span key={tag}>
                          <LanguageTag tag={tag} /> <span className="fw-dc-muted">{cell && cell.markets.length > 0 ? t('check.forMarkets', { markets: cell.markets.join(', ') }) : ''}</span>
                        </span>
                      )
                    })}
                  </span>
                ),
                row.held === 'held.noOriginal' ? (
                  <Link key="n" className="fw-dc-link" href={`${model.prefix}/compliance/declarations?new=1&style=${encodeURIComponent(row.row.style.id)}&newKind=${row.row.kind}`} onClick={close}>
                    {t('check.makeOne')}
                  </Link>
                ) : row.held ? (
                  t(row.held)
                ) : (
                  t('check.willTranslate', { count: row.gaps.length })
                ),
              ],
            }))}
          />
        )}
      </div>
    </Modal>
  )
}

/** The batches that left without a recorded version (the fifth tile, PRD-295): record what travelled, per shipment. */
export function UnrecordedDialog({ model, state, actions }: { model: DeclarationsPageModel; state: UnrecordedState; actions?: DeclarationsPageActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const close = () => actions?.onAddress?.({ unrecorded: false })
  const recordHeld = !model.can.manage ? t('held.manage') : !model.online ? t('held.offline') : null
  return (
    <Modal open onClose={close} title={t('unrecorded.title')} size="lg" footer={<Button onClick={close}>{t('common.close')}</Button>}>
      <div className="fw-dc-form">
        <p className="fw-dc-p">{t('unrecorded.body')}</p>
        {state.problem && <Banner tone="danger" title={t(state.problem.key)} />}
        {state.read.status === 'loading' ? (
          <PartLoading rows={3} />
        ) : state.read.status === 'error' ? (
          <PartFailed title={t('unrecorded.failed')} problem={state.read.problem} onRetry={() => actions?.onRetryUnrecorded?.()} />
        ) : state.read.value.length === 0 ? (
          <EmptyState title={t('unrecorded.noneTitle')} description={t('unrecorded.none')} />
        ) : (
          <SummaryTable
            label={t('unrecorded.title')}
            stackOnPhone
            columns={[t('unrecorded.col.shipment'), t('unrecorded.col.shipped'), t('unrecorded.col.batch'), t('unrecorded.col.style'), t('unrecorded.col.next')]}
            rows={state.read.value.map((entry) => ({
              id: `${entry.shipmentId}|${entry.batchNumber}`,
              cells: [
                entry.shipmentNumber,
                day(entry.shippedAt),
                `${entry.batchNumber} · ${entry.workOrderNumber}`,
                entry.styleCode,
                <span key="a" className="fw-dc-row">
                  <Button size="sm" heldReason={recordHeld ?? (state.busy ? t('held.busy') : null)} onClick={() => actions?.onRecordShipment?.(entry.shipmentId)}>
                    {state.busy === entry.shipmentId ? <Spinner size={12} /> : null} {t('unrecorded.record')}
                  </Button>
                  {model.can.shipping && (
                    <Link className="fw-dc-link" href={packHref(model.prefix, entry.shipmentId)} target="_blank" rel="noopener">
                      {t('unrecorded.pack')}
                    </Link>
                  )}
                </span>,
              ],
            }))}
          />
        )}
      </div>
    </Modal>
  )
}
