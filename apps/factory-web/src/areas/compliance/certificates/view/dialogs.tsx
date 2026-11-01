'use client'

import { useEffect, useRef } from 'react'
import { Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { BrandOption, StyleOption } from '../api'
import { checkHeld, draftProblems, draftSpan, firstProblem, grantedClass, kindOf, STANDARD_SUGGESTIONS, type AddModel, type CertCan, type CertificateDraft, type CheckModel, type DraftField } from '../model'
import { dateLocale, GateAnswer, PdfChooser, useDay, useProblemWords } from './parts'

// ---- the certificate's fields (Add certificate and a draft's Details) ------------------------------------------------

export interface FieldsModel {
  draft: CertificateDraft
  touched: readonly DraftField[]
  refused?: readonly DraftField[]
  companies: ReadonlyArray<{ id: string; name: string }>
  brands: readonly BrandOption[] | null
}

/**
 * The fields a person types from the notified body's certificate, each checked as they leave it with the domain's own
 * rules (the class an EN 17092 part grants, an EN 1621 level, the 4-digit notified body number, five years at most).
 */
export function CertificateFields({ model, onDraft, onTouch, autoFocus }: { model: FieldsModel; onDraft?: (draft: CertificateDraft) => void; onTouch?: (field: DraftField) => void; autoFocus?: boolean }) {
  const t = useT('certificates')
  const locale = useLocale()
  const day = useDay()
  const words = useProblemWords()
  const draft = model.draft
  const problems = draftProblems(draft)
  const set = (patch: Partial<CertificateDraft>) => onDraft?.({ ...draft, ...patch })
  const error = (field: DraftField): string | undefined => {
    if (model.refused?.includes(field)) return t('add.problem.refused')
    const problem = problems[field]
    return problem && model.touched.includes(field) ? words(problem) : undefined
  }
  const leave = (field: DraftField) => () => onTouch?.(field)
  const suggested = (STANDARD_SUGGESTIONS as readonly string[]).includes(draft.standard)
  const granted = grantedClass(draft.standard)
  const kind = kindOf(draft.standard)
  const span = draftSpan(draft)
  return (
    <div className="fw-q-form-two">
      <Field label={t('field.standard')} required hint={t('field.standardHint')} error={suggested ? error('standard') : undefined}>
        <Select
          autoFocus={autoFocus}
          value={suggested ? draft.standard : 'other'}
          onChange={(event) => set({ standard: event.target.value === 'other' ? '' : event.target.value, ppeClass: '' })}
          onBlur={leave('standard')}
        >
          {STANDARD_SUGGESTIONS.map((standard) => (
            <option key={standard} value={standard}>
              {standard}
            </option>
          ))}
          <option value="other">{t('field.standardOther')}</option>
        </Select>
      </Field>
      {!suggested && (
        <Field label={t('field.standardTyped')} required hint={t('field.standardTypedHint')} error={error('standard')}>
          <Input value={draft.standard} maxLength={60} onChange={(event) => set({ standard: event.target.value })} onBlur={leave('standard')} />
        </Field>
      )}
      {granted ? (
        <Field label={t('field.class')} hint={t('field.classGranted')}>
          <Input value={granted} readOnly aria-readonly="true" />
        </Field>
      ) : kind === 'PROTECTOR' ? (
        <Field label={t('field.level')} required error={error('ppeClass')}>
          <Select value={draft.ppeClass} onChange={(event) => set({ ppeClass: event.target.value })} onBlur={leave('ppeClass')}>
            <option value="">{t('field.levelPick')}</option>
            <option value="1">{t('field.levelValue', { level: '1' })}</option>
            <option value="2">{t('field.levelValue', { level: '2' })}</option>
          </Select>
        </Field>
      ) : (
        <Field label={t('field.classOther')} hint={t('field.classOtherHint')} error={error('ppeClass')}>
          <Input value={draft.ppeClass} maxLength={10} onChange={(event) => set({ ppeClass: event.target.value.toUpperCase() })} onBlur={leave('ppeClass')} />
        </Field>
      )}
      <Field label={t('field.number')} required hint={t('field.numberHint')} error={error('number')}>
        <Input value={draft.number} maxLength={80} onChange={(event) => set({ number: event.target.value })} onBlur={leave('number')} />
      </Field>
      <Field label={t('field.holder')} required hint={t('field.holderHint')} error={error('holder')}>
        <Select value={draft.holder} onChange={(event) => set({ holder: event.target.value })} onBlur={leave('holder')}>
          <option value="">{t('field.holderPick')}</option>
          {model.companies.map((company) => (
            <option key={company.id} value={`company:${company.id}`}>
              {t('field.holderCompany', { name: company.name })}
            </option>
          ))}
          {(model.brands ?? []).map((brand) => (
            <option key={brand.id} value={`brand:${brand.id}`}>
              {t('field.holderBrand', { name: brand.tradeName ?? brand.legalName })}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('field.bodyName')} required error={error('notifiedBodyName')}>
        <Input value={draft.notifiedBodyName} maxLength={200} onChange={(event) => set({ notifiedBodyName: event.target.value })} onBlur={leave('notifiedBodyName')} />
      </Field>
      <Field label={t('field.bodyNumber')} required hint={t('field.bodyNumberHint')} error={error('notifiedBodyNumber')}>
        <Input value={draft.notifiedBodyNumber} inputMode="numeric" maxLength={4} onChange={(event) => set({ notifiedBodyNumber: event.target.value.replace(/\D/g, '') })} onBlur={leave('notifiedBodyNumber')} />
      </Field>
      <Field label={t('field.model')} hint={t('field.modelHint')} error={error('modelReference')}>
        <Input value={draft.modelReference} maxLength={120} onChange={(event) => set({ modelReference: event.target.value })} onBlur={leave('modelReference')} />
      </Field>
      <Field label={t('field.validFrom')} required error={error('validFrom')}>
        <DateField
          value={draft.validFrom}
          onChange={(value) => {
            set({ validFrom: value })
            onTouch?.('validFrom')
          }}
          locale={dateLocale(locale)}
          placeholder={t('date.notSet')}
          clearLabel={t('date.clear')}
        />
      </Field>
      <Field label={t('field.validTo')} required hint={span ? t('field.span', { span: [span.years > 0 ? t('left.years', { count: span.years }) : '', span.months > 0 ? t('left.months', { count: span.months }) : ''].filter(Boolean).join(' ') || t('left.months', { count: 0 }) }) : t('field.validToHint')} error={error('validTo')}>
        <DateField
          value={draft.validTo}
          onChange={(value) => {
            set({ validTo: value })
            onTouch?.('validTo')
          }}
          locale={dateLocale(locale)}
          min={draft.validFrom || undefined}
          placeholder={t('date.notSet')}
          clearLabel={t('date.clear')}
        />
      </Field>
      {problems.validTo?.key === 'add.problem.fiveYears' && model.touched.includes('validTo') && (
        <p className="fw-q-hint fw-ce-wide">{t('add.fiveYearsLaw', { latest: day(String(problems.validTo.params?.latest ?? '')) })}</p>
      )}
      <Field label={t('field.note')} hint={t('field.noteHint')}>
        <Textarea value={draft.note} maxLength={2000} rows={2} onChange={(event) => set({ note: event.target.value })} />
      </Field>
    </div>
  )
}

// ---- Add certificate (SCR-050 ce-new) ----------------------------------------------------------------------------------

export interface AddActions {
  onDraft?: (draft: CertificateDraft) => void
  onTouch?: (field: DraftField) => void
  onFile?: (file: File) => void
  onCreate?: () => void
  onClose?: () => void
}

/**
 * Add certificate: the fields from the notified body's certificate (checked as you leave each one) and, optionally, its
 * PDF; Create makes a DRAFT and opens its Coverage. The draft is registered later, once it has its PDF and coverage.
 */
export function AddCertificateDialog({ model, can, companies, brands, actions }: { model: AddModel; can: CertCan; companies: ReadonlyArray<{ id: string; name: string }>; brands: readonly BrandOption[] | null; actions?: AddActions }) {
  const t = useT('certificates')
  const words = useProblemWords()
  const problems = draftProblems(model.draft)
  const first = firstProblem(problems)
  const held = !can.manage ? t('held.manage') : first ? words(first) : model.busy ? t('held.busy') : null
  const create = () => {
    if (held) {
      for (const field of Object.keys(problems) as DraftField[]) actions?.onTouch?.(field)
      return
    }
    actions?.onCreate?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('add.title')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('add.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-ce-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-q-hint">{t('add.intro')}</p>
        <CertificateFields model={{ draft: model.draft, touched: model.touched, refused: model.refused, companies, brands }} onDraft={actions?.onDraft} onTouch={actions?.onTouch} autoFocus />
        <PdfChooser name={model.fileName} onFile={actions?.onFile} label={t('add.pdf')} hint={t('add.pdfHint')} held={can.upload ? null : t('held.upload')} />
        <p className="fw-q-hint">{t('add.after')}</p>
        {model.problem && (
          <Banner tone="danger" title={t(model.problem)}>
            {model.lines.length > 0 && (
              <ul className="fw-q-lines">
                {model.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
      </div>
    </Modal>
  )
}

// ---- Check a garment (ce-check) -----------------------------------------------------------------------------------------

export interface CheckActions {
  onQuery?: (query: string) => void
  onPickStyle?: (style: StyleOption) => void
  onClearStyle?: () => void
  onCheck?: (patch: Partial<Pick<CheckModel, 'colourwayId' | 'size' | 'date'>>) => void
  onRun?: () => void
  onClose?: () => void
}

/**
 * Check a garment: a style, one of its colourways and sizes, and a day (today, or any day for an audit or a complaint) →
 * the certificate gate's answer in one sentence, announced: covered by which certificate, or not covered with each
 * reason and how to fix it.
 */
export function CheckGarmentDialog({ model, can, today, actions }: { model: CheckModel; can: CertCan; today: string; actions?: CheckActions }) {
  const t = useT('certificates')
  const q = useT('quality')
  const locale = useLocale()
  const held = checkHeld(model, can)
  const style = model.style?.value ?? null
  const colourway = style?.colourways.find((entry) => entry.id === model.colourwayId) ?? null
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!style) searchRef.current?.focus()
  }, [style])
  const run = () => {
    if (!held) actions?.onRun?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('check.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{q('common.close')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('check.run')}
          </Button>
        </>
      }
    >
      <div
        className="fw-ce-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            run()
          }
        }}
      >
        <p className="fw-q-hint">{t('check.intro')}</p>
        {!can.styles ? (
          <Banner tone="info" title={t('check.held.styles')} />
        ) : style ? (
          <div className="fw-q-cell-row">
            <span className="fw-q-code">{style.code}</span>
            <span>{style.name}</span>
            <Button size="sm" variant="link" onClick={() => actions?.onClearStyle?.()}>
              {t('check.changeStyle')}
            </Button>
          </div>
        ) : (
          <div className="fw-ce-pick">
            <Field label={t('check.style')}>
              <Input
                ref={searchRef}
                type="search"
                leadingIcon={<Search size={14} aria-hidden />}
                value={model.query}
                placeholder={t('check.styleSearch')}
                onChange={(event) => actions?.onQuery?.(event.target.value)}
              />
            </Field>
            {model.styles?.problem ? (
              <p className="fw-q-hint">{q(model.styles.problem)}</p>
            ) : model.styles?.value ? (
              model.styles.value.length === 0 ? (
                <p className="fw-q-hint">{t('check.noStyles')}</p>
              ) : (
                <ul className="fw-ce-options" aria-label={t('check.styles')}>
                  {model.styles.value.map((option) => (
                    <li key={option.id}>
                      <Button size="sm" variant="quiet" onClick={() => actions?.onPickStyle?.(option)}>
                        <span className="fw-q-code">{option.code}</span> {option.name}
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            ) : model.styles ? (
              <p className="fw-q-loading">
                <Spinner size={12} /> {q('common.loading')}
              </p>
            ) : null}
          </div>
        )}
        {model.style?.problem && <Banner tone="danger" title={q(model.style.problem)} />}
        {model.style && !model.style.value && !model.style.problem && (
          <p className="fw-q-loading">
            <Spinner size={12} /> {q('common.loading')}
          </p>
        )}
        {style && (
          <div className="fw-q-form-three">
            <Field label={t('check.colourway')} required>
              <Select value={model.colourwayId} onChange={(event) => actions?.onCheck?.({ colourwayId: event.target.value })}>
                <option value="">{t('check.pick')}</option>
                {style.colourways
                  .filter((entry) => entry.status === 'ACTIVE')
                  .map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.code} · {entry.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('check.size')} required>
              <Select value={model.size} onChange={(event) => actions?.onCheck?.({ size: event.target.value })}>
                <option value="">{t('check.pick')}</option>
                {style.sizes.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('check.date')} hint={model.date === today ? t('check.today') : t('check.otherDay')}>
              <DateField value={model.date} onChange={(value) => actions?.onCheck?.({ date: value })} locale={dateLocale(locale)} placeholder={t('date.notSet')} clearLabel={t('date.clear')} clearable={false} />
            </Field>
          </div>
        )}
        <div aria-live="polite" role="status" className="fw-ce-answer">
          {model.result && style && <GateAnswer result={model.result} styleCode={style.code} colourwayCode={colourway?.code ?? '—'} />}
          {model.problem && <Banner tone="danger" title={q(model.problem)} />}
        </div>
      </div>
    </Modal>
  )
}
