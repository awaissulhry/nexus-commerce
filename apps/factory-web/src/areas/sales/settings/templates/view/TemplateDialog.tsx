'use client'

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { QuoteListRow, StyleDetail, StyleRow } from '../../../quotes/api'
import { unitPrice } from '../../../quotes/model'
import type { Words } from '../../../quotes/record/lines-depth/model'
import { useDepthWords } from '../../../quotes/record/lines-depth/words'
import { headerPatch, INCOTERMS, linesChanged, newLineKey, templateProblems, type LineDraft, type TemplateDraft } from '../model'

export interface TemplateComposer {
  query: string
  results: StyleRow[] | null
  style: StyleDetail | null
  colourwayId: string
  sizes: Record<string, string>
  section: string
  unitPrice: string
}

export interface TemplateDialogModel {
  mode: 'new' | 'edit'
  /** New: an empty template, or one made from a quote ("a quote in template mode"). */
  start: 'empty' | 'quote'
  /** Edit: the template is read first. */
  reading: boolean
  readProblem: string | null
  archived: boolean
  draft: TemplateDraft
  before: TemplateDraft
  companies: ReadonlyArray<{ id: string; code: string; name: string }>
  /** The person keeps it (quotes.templates.manage over its company; an archived one is restored first). */
  mayKeep: boolean
  grains: { price: boolean }
  currency: string
  saving: boolean
  problem: Words | null
  composer: TemplateComposer
  fromQuote: { query: string; results: QuoteListRow[] | null; chosenId: string; name: string; everyCompany: boolean }
}

export interface TemplateDialogActions {
  onClose?: () => void
  onStart?: (start: 'empty' | 'quote') => void
  onDraft?: (patch: Partial<TemplateDraft>) => void
  onComposer?: (patch: Partial<TemplateComposer>) => void
  onComposerSearch?: (query: string) => void
  onComposerPick?: (styleId: string) => void
  onFromQuote?: (patch: Partial<TemplateDialogModel['fromQuote']>) => void
  onFromQuoteSearch?: (query: string) => void
  onSave?: () => void
}

/**
 * A quote template's dialog (SCR-235 › Quote templates): New (empty, or from a quote's current version — its lines,
 * sections and terms), or a template opened from the list. The header (name, company, language, validity, firm offer,
 * acceptance mode, deposit, Incoterm and place, ship complete, terms version) and the lines in their sections — each a
 * style with its colourway and pieces per size, or left to choose when the quote is made, and an optional price (price
 * grain). Save writes the header and the lines with the template's version; read-only without the right or archived.
 */
export function TemplateDialog({ model, actions }: { model: TemplateDialogModel; actions?: TemplateDialogActions }) {
  const { t, sales, say } = useDepthWords()
  const locale = useLocale()
  const { draft } = model
  const readOnly = !model.mayKeep || model.archived
  const set = (patch: Partial<TemplateDraft>) => actions?.onDraft?.(patch)
  const problems = templateProblems(draft, model.grains)
  const changed = model.mode === 'new' || Object.keys(headerPatch(model.before, draft)).length > 0 || linesChanged(model.before.lines, draft.lines, model.grains)
  const fromQuote = model.mode === 'new' && model.start === 'quote'
  const chosenQuote = model.fromQuote.results?.find((row) => row.id === model.fromQuote.chosenId) ?? null
  const saveHeld = readOnly
    ? t(model.archived ? 'tpl.held.archived' : 'tpl.held.right')
    : fromQuote
      ? !chosenQuote
        ? t('tpl.held.pickQuote')
        : model.fromQuote.name.trim() === ''
          ? t('tpl.problem.name')
          : null
      : problems.length > 0
        ? say(problems[0]!)
        : !changed
          ? t('tpl.held.noChange')
          : model.saving
            ? t('common.working')
            : null
  const moveLine = (index: number, step: -1 | 1) => {
    const lines = [...draft.lines]
    const [line] = lines.splice(index, 1)
    if (!line) return
    lines.splice(index + step, 0, line)
    set({ lines })
  }
  const composer = model.composer
  const addHeld = !composer.style ? t('tpl.held.pickStyle') : null
  const addLine = () => {
    const style = composer.style
    if (!style) return
    const colour = style.colourways.find((entry) => entry.id === composer.colourwayId)
    const line: LineDraft = { key: newLineKey(), section: composer.section, styleId: style.id, styleCode: style.code, styleName: style.name, colourwayId: composer.colourwayId, colourwayCode: colour?.code ?? '', sizes: composer.sizes, unitPrice: composer.unitPrice }
    set({ lines: [...draft.lines, line] })
    actions?.onComposer?.({ style: null, query: '', results: null, colourwayId: '', sizes: {}, unitPrice: '' })
  }

  return (
    <Modal
      open
      size="xl"
      onClose={() => actions?.onClose?.()}
      title={model.mode === 'new' ? t('tpl.dialog.new') : t('tpl.dialog.edit', { name: model.before.name })}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{sales('common.close')}</Button>
          {!readOnly && (
            <Button variant="primary" heldReason={saveHeld} onClick={() => actions?.onSave?.()}>
              {model.saving ? <Spinner size={12} /> : null} {t(fromQuote ? 'tpl.saveFromQuote' : model.mode === 'new' ? 'tpl.create' : 'tpl.save')}
            </Button>
          )}
        </>
      }
    >
      {model.reading ? (
        <p className="fw-q-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : model.readProblem ? (
        <Banner tone="danger" title={sales(model.readProblem)} />
      ) : (
        <div className="fw-q-stack">
          {readOnly && <Banner tone="info" title={t(model.archived ? 'tpl.held.archived' : 'tpl.readOnly')} />}
          {model.mode === 'new' && (
            <fieldset className="fw-q-radios">
              <legend className="fw-q-legend">{t('tpl.startFrom')}</legend>
              {(['empty', 'quote'] as const).map((start) => (
                <RadioCard key={start} name="fw-qd-tpl-start" value={start} checked={model.start === start} selected={model.start === start} onChange={() => actions?.onStart?.(start)} title={t(`tpl.start.${start}`)} description={t(`tpl.startBody.${start}`)} />
              ))}
            </fieldset>
          )}
          {fromQuote ? (
            <div className="fw-q-stack">
              <Field label={t('tpl.fromQuote.search')} hint={t('tpl.fromQuote.hint')}>
                <Input type="search" autoComplete="off" value={model.fromQuote.query} onChange={(event) => actions?.onFromQuoteSearch?.(event.target.value)} />
              </Field>
              <fieldset className="fw-q-choices">
                <legend className="fw-q-legend" aria-live="polite">
                  {model.fromQuote.results === null ? t('tpl.fromQuote.type') : model.fromQuote.results.length === 0 ? t('tpl.fromQuote.none') : t('tpl.fromQuote.found', { count: model.fromQuote.results.length })}
                </legend>
                {(model.fromQuote.results ?? []).map((row) => (
                  <RadioCard key={row.id} variant="row" name="fw-qd-tpl-quote" value={row.id} checked={model.fromQuote.chosenId === row.id} selected={model.fromQuote.chosenId === row.id} onChange={() => actions?.onFromQuote?.({ chosenId: row.id })} title={`${row.number} · ${row.partyName}`} description={t('tpl.fromQuote.line', { revision: row.revision, lines: row.lineCount, units: row.units })} />
                ))}
              </fieldset>
              <Field label={t('tpl.name')}>
                <Input value={model.fromQuote.name} maxLength={120} onChange={(event) => actions?.onFromQuote?.({ name: event.target.value })} />
              </Field>
              <Checkbox checked={model.fromQuote.everyCompany} onChange={() => actions?.onFromQuote?.({ everyCompany: !model.fromQuote.everyCompany })} label={t('tpl.fromQuote.every')} />
            </div>
          ) : (
            <>
              <div className="fw-q-fields">
                <Field label={t('tpl.name')}>
                  <Input value={draft.name} maxLength={120} disabled={readOnly} onChange={(event) => set({ name: event.target.value })} />
                </Field>
                <Field label={t('tpl.company')} hint={t('tpl.companyHint')}>
                  <Select value={draft.companyId} disabled={readOnly || model.mode === 'edit'} onChange={(event) => set({ companyId: event.target.value })}>
                    <option value="">{t('tpl.everyCompany')}</option>
                    {model.companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.code} · {company.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('tpl.description')}>
                  <Input value={draft.description} maxLength={2000} disabled={readOnly} onChange={(event) => set({ description: event.target.value })} />
                </Field>
                <Field label={t('tpl.language')}>
                  <Select value={draft.language} disabled={readOnly} onChange={(event) => set({ language: event.target.value === 'en' ? 'en' : 'it' })}>
                    <option value="it">{sales('languageName.it')}</option>
                    <option value="en">{sales('languageName.en')}</option>
                  </Select>
                </Field>
                <Field label={t('tpl.validity')} hint={t('tpl.validityHint')}>
                  <Input inputMode="numeric" value={draft.validityDays} disabled={readOnly} onChange={(event) => set({ validityDays: event.target.value })} />
                </Field>
                <Field label={t('tpl.firmOffer')}>
                  <span className="fw-q-inline">
                    <Toggle checked={draft.firmOffer} disabled={readOnly} onChange={(next: boolean) => set({ firmOffer: next })} aria-label={t('tpl.firmOffer')} />
                    {sales(draft.firmOffer ? 'terms.firmOn' : 'terms.firmOff')}
                  </span>
                </Field>
                <Field label={t('terms.acceptance.label')}>
                  <Select value={draft.acceptanceMode} disabled={readOnly} onChange={(event) => set({ acceptanceMode: event.target.value === 'SIGN_AND_PAY' ? 'SIGN_AND_PAY' : 'SIGN' })}>
                    <option value="SIGN">{t('terms.acceptance.SIGN')}</option>
                    <option value="SIGN_AND_PAY">{t('terms.acceptance.SIGN_AND_PAY')}</option>
                  </Select>
                </Field>
                <Field label={t('tpl.deposit')} hint={t('tpl.depositHint')}>
                  <span className="fw-q-inline">
                    <Input inputMode="decimal" value={draft.depositPct} disabled={readOnly} onChange={(event) => set({ depositPct: event.target.value })} />
                    <Select value={draft.depositKind} disabled={readOnly} aria-label={sales('terms.depositKind')} onChange={(event) => set({ depositKind: event.target.value === 'CAPARRA' ? 'CAPARRA' : 'ACCONTO' })}>
                      <option value="ACCONTO">{sales('depositKind.ACCONTO')}</option>
                      <option value="CAPARRA">{sales('depositKind.CAPARRA')}</option>
                    </Select>
                  </span>
                </Field>
                <Field label={t('terms.incoterm')}>
                  <Select value={draft.incoterm} disabled={readOnly} onChange={(event) => set({ incoterm: event.target.value, ...(event.target.value === '' ? { incotermPlace: '' } : {}) })}>
                    <option value="">{t('terms.noIncoterm')}</option>
                    {INCOTERMS.map((code) => (
                      <option key={code} value={code}>
                        {t(`incoterm.${code}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('terms.place')}>
                  <Input value={draft.incotermPlace} maxLength={120} disabled={readOnly || draft.incoterm === ''} onChange={(event) => set({ incotermPlace: event.target.value })} />
                </Field>
                <Field label={t('terms.ship')}>
                  <Select value={draft.shipComplete ? 'complete' : 'ready'} disabled={readOnly} onChange={(event) => set({ shipComplete: event.target.value === 'complete' })}>
                    <option value="complete">{t('terms.shipComplete')}</option>
                    <option value="ready">{t('terms.shipAsReady')}</option>
                  </Select>
                </Field>
                <Field label={t('tpl.termsVersion')}>
                  <Input value={draft.termsVersion} maxLength={40} disabled={readOnly} onChange={(event) => set({ termsVersion: event.target.value })} />
                </Field>
              </div>

              <h3 className="fw-q-h3">{t('tpl.lines')}</h3>
              {draft.lines.length === 0 ? (
                <p className="fw-q-hint">{t('tpl.noLines')}</p>
              ) : (
                <SummaryTable
                  label={t('tpl.lines')}
                  density="compact"
                  stackOnPhone
                  columns={[t('tpl.lineCol.section'), t('tpl.lineCol.style'), t('tpl.lineCol.colourway'), t('tpl.lineCol.sizes'), ...(model.grains.price ? [t('tpl.lineCol.price')] : []), t('tpl.lineCol.actions')]}
                  rows={draft.lines.map((line, index) => ({
                    id: line.key,
                    cells: [
                      line.section || '—',
                      <span key="s">
                        <strong>{line.styleCode}</strong> {line.styleName}
                      </span>,
                      line.colourwayId ? line.colourwayCode || '—' : <Tag key="c">{t('from.colourAtUse')}</Tag>,
                      Object.values(line.sizes).some((value) => value.trim() !== '') ? Object.entries(line.sizes).filter(([, value]) => value.trim() !== '' && value.trim() !== '0').map(([size, value]) => `${size} ${value}`).join(' · ') : <Tag key="z">{t('tpl.sizesAtUse')}</Tag>,
                      ...(model.grains.price ? [line.unitPrice ? unitPrice(line.unitPrice, model.currency, locale) : t('tpl.priceFromList')] : []),
                      readOnly ? (
                        '—'
                      ) : (
                        <span key="a" className="fw-q-inline">
                          <Button size="sm" variant="quiet" heldReason={index === 0 ? t('tpl.held.first') : null} onClick={() => moveLine(index, -1)} aria-label={t('tpl.up', { n: index + 1 })}>
                            <ArrowUp size={14} aria-hidden />
                          </Button>
                          <Button size="sm" variant="quiet" heldReason={index === draft.lines.length - 1 ? t('tpl.held.last') : null} onClick={() => moveLine(index, 1)} aria-label={t('tpl.down', { n: index + 1 })}>
                            <ArrowDown size={14} aria-hidden />
                          </Button>
                          <Button size="sm" variant="quiet" onClick={() => set({ lines: draft.lines.filter((entry) => entry.key !== line.key) })} aria-label={t('tpl.remove', { n: index + 1 })}>
                            <Trash2 size={14} aria-hidden />
                          </Button>
                        </span>
                      ),
                    ],
                  }))}
                />
              )}
              {!readOnly && (
                <div className="fw-qd-delivery">
                  <strong>{t('tpl.addLine')}</strong>
                  <div className="fw-q-fields">
                    <Field label={t('tpl.style')} hint={t('tpl.styleHint')}>
                      <Input type="search" autoComplete="off" value={composer.query} onChange={(event) => actions?.onComposerSearch?.(event.target.value)} />
                    </Field>
                    {composer.results && !composer.style && (
                      <Field label={t('tpl.pickStyle')}>
                        <Select value="" onChange={(event) => event.target.value && actions?.onComposerPick?.(event.target.value)}>
                          <option value="">{composer.results.length === 0 ? t('tpl.noStyles') : t('tpl.stylesFound', { count: composer.results.length })}</option>
                          {composer.results.map((style) => (
                            <option key={style.id} value={style.id}>
                              {style.code} · {style.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    {composer.style && (
                      <>
                        <Field label={t('from.colourway')}>
                          <Select value={composer.colourwayId} onChange={(event) => actions?.onComposer?.({ colourwayId: event.target.value })}>
                            <option value="">{t('from.colourAtUse')}</option>
                            {composer.style.colourways
                              .filter((entry) => entry.status === 'ACTIVE')
                              .map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                  {entry.code} · {entry.name}
                                </option>
                              ))}
                          </Select>
                        </Field>
                        <Field label={t('tpl.section')} hint={t('tpl.sectionHint')}>
                          <Input value={composer.section} maxLength={120} onChange={(event) => actions?.onComposer?.({ section: event.target.value })} />
                        </Field>
                        {model.grains.price && (
                          <Field label={t('tpl.price')} hint={t('tpl.priceHint')}>
                            <Input inputMode="decimal" value={composer.unitPrice} onChange={(event) => actions?.onComposer?.({ unitPrice: event.target.value })} />
                          </Field>
                        )}
                      </>
                    )}
                  </div>
                  {composer.style && (
                    <div className="fw-qd-delivery-sizes" role="group" aria-label={t('tpl.piecesHint')}>
                      {composer.style.sizes.map((size) => (
                        <Field key={size} label={size}>
                          <Input size="sm" inputMode="numeric" placeholder="0" value={composer.sizes[size] ?? ''} onChange={(event) => actions?.onComposer?.({ sizes: { ...composer.sizes, [size]: event.target.value } })} />
                        </Field>
                      ))}
                    </div>
                  )}
                  {composer.style && <p className="fw-q-hint">{t('tpl.piecesHint')}</p>}
                  <div className="fw-qd-actions">
                    <Button size="sm" heldReason={addHeld} onClick={addLine}>
                      <Plus size={14} aria-hidden /> {t('tpl.add')}
                    </Button>
                    {composer.style && (
                      <Button size="sm" variant="quiet" onClick={() => actions?.onComposer?.({ style: null, colourwayId: '', sizes: {} })}>
                        {t('tpl.otherStyle')}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        </div>
      )}
    </Modal>
  )
}
