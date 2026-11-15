'use client'

import { Banner, Field, KeyValue, Stepper, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Pill, Select, Spinner } from '@nexus/ui/primitives'
import { FileDropzone, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { dayInstant, money } from '../../_shared/model'
import { BANK_FORMATS, FORMAT_EXTENSIONS, MAX_STATEMENT_BYTES, NUMBER_FORMATS, STATEMENT_COLUMNS, type BankAccount, type BankFormat, type ImportPlan, type Imported, type NumberFormat, type StatementColumn } from '../api'
import { importHeld, isSheet, maskIban, mappingMissing, type BankCan, type ImportStep, type Phrase } from '../model'

/** Import a bank statement (design pop:import "ImportFlow"): the container keeps it. */
export interface ImportModel {
  readonly step: ImportStep
  readonly fileName: string | null
  /** The format the file's name says, or the one chosen. */
  readonly format: BankFormat | null
  readonly accounts: readonly BankAccount[] | null
  readonly accountsProblem: string | null
  /** The account chosen (a CSV or Excel sheet names none). */
  readonly accountId: string | null
  readonly plan: ImportPlan | null
  readonly mapping: Readonly<Record<string, StatementColumn | null>>
  readonly numberFormat: NumberFormat
  readonly sheetName: string | null
  readonly skipErrors: boolean
  readonly busy: boolean
  readonly problems: readonly Phrase[] | null
  readonly imported: Imported | null
}

export interface ImportActions {
  onFile?: (file: File | null) => void
  onFormat?: (format: BankFormat) => void
  onAccount?: (accountId: string | null) => void
  /** Upload the file (once) and run the dry run with the mapping as it stands. */
  onRead?: () => void
  onMapping?: (header: string, column: StatementColumn | null) => void
  onNumberFormat?: (format: NumberFormat) => void
  onSheet?: (name: string) => void
  onSkipErrors?: (skip: boolean) => void
  onImport?: () => void
  onBack?: () => void
  onClose?: () => void
}

const STEPS: ImportStep[] = ['file', 'mapping', 'review', 'done']
const stepIndex = (step: ImportStep): number => (step === 'reading' ? 0 : step === 'importing' ? 2 : STEPS.indexOf(step))

/**
 * Import a bank statement (design finance.bank pop:import: "ImportFlow: file (CAMT.053, CSV, XLSX, OFX) → column mapping →
 * dry run (new, duplicate refused) → Apply", primary "Import n lines"; Esc closes and the focus goes back to the band's
 * button): 1 · the file (its format from its name, or chosen), and for a sheet the company's account it is for; 2 · for a
 * CSV or Excel sheet, each header → a statement column (the API's Italian and English aliases map most by themselves), the
 * number format and the sheet; 3 · the dry run: the account, the period, new / already imported (never imported twice) /
 * unreadable lines with their problems in words, money in and out (price grain); "Import n lines" (lines that cannot be
 * read only when the person leaves them out); 4 · done: the lines imported and the suggestions found.
 */
export function ImportDialog({ model, can, actions }: { model: ImportModel; can: BankCan; actions?: ImportActions }) {
  const t = useT('finance-bank')
  const locale = useLocale()
  const phrase = (entry: Phrase) => t(entry.key, entry.params)
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const plan = model.plan
  const sheet = isSheet(model.format)
  const missing = mappingMissing(model.mapping)
  const readHeld = model.busy
    ? t('held.busy')
    : !can.import
      ? t('held.import')
      : !can.upload
        ? t('held.upload')
        : !model.fileName
          ? t('import.held.file')
          : !model.format
            ? t('import.held.format')
            : sheet && !model.accountId
              ? t('import.held.account')
              : model.step === 'mapping' && missing.length > 0
                ? phrase(missing[0]!)
                : null
  const importWords = importHeld(plan, model.skipErrors, can, model.busy)
  const account = model.accounts?.find((entry) => entry.id === (plan?.account.id ?? model.accountId)) ?? null
  const footer =
    model.step === 'done' ? (
      <>
        <span className="grow" />
        <Button size="sm" variant="primary" onClick={() => actions?.onClose?.()}>
          {t('import.done.open')}
        </Button>
      </>
    ) : model.step === 'review' || model.step === 'importing' ? (
      <>
        <Button size="sm" variant="quiet" onClick={() => actions?.onBack?.()}>
          {t('import.back')}
        </Button>
        <span className="grow" />
        <Button size="sm" onClick={() => actions?.onClose?.()}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" heldReason={importWords ? phrase(importWords) : null} onClick={() => actions?.onImport?.()}>
          {model.step === 'importing' ? t('common.working') : t('import.go', { count: plan?.counts.new ?? 0 })}
        </Button>
      </>
    ) : (
      <>
        <span className="grow" />
        <Button size="sm" onClick={() => actions?.onClose?.()}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" heldReason={readHeld} onClick={() => actions?.onRead?.()}>
          {model.step === 'reading' ? t('common.working') : t('import.read')}
        </Button>
      </>
    )

  return (
    <Modal open onClose={() => actions?.onClose?.()} title={t('import.title')} size="lg" footer={footer}>
      <div className="fw-bank-dialog">
        <Stepper steps={STEPS.map((step) => ({ key: step, label: t(`import.step.${step}`) }))} current={stepIndex(model.step)} />
        {model.problems && model.problems.length > 0 && <Banner tone="danger" title={model.problems.map(phrase).join(' ')} />}

        {(model.step === 'file' || model.step === 'reading') && (
          <>
            <p className="fw-bank-muted">{t('import.fileBody')}</p>
            <FileDropzone
              onFiles={(files) => actions?.onFile?.(files[0] ?? null)}
              accept={BANK_FORMATS.flatMap((format) => FORMAT_EXTENSIONS[format]).join(',')}
              maxBytes={MAX_STATEMENT_BYTES}
              hint={t('import.fileHint')}
            />
            {model.fileName && (
              <KeyValue dense labelCase="sentence" items={[{ label: t('import.fileLabel'), value: model.fileName }]} />
            )}
            {model.fileName && (
              <div className="fw-bank-two">
                <Field label={t('import.format')} hint={model.format ? t('import.formatFound') : t('import.formatPick')}>
                  <Select value={model.format ?? ''} onChange={(event) => actions?.onFormat?.(event.target.value as BankFormat)}>
                    <option value="" disabled>
                      {t('import.formatChoose')}
                    </option>
                    {BANK_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {t(`format.${format}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('import.account')} hint={sheet ? t('import.accountSheet') : t('import.accountFile')}>
                  {model.accountsProblem ? (
                    <span className="fw-bank-muted">{t(model.accountsProblem)}</span>
                  ) : !model.accounts ? (
                    <span className="fw-bank-muted">
                      <Spinner size={12} /> {t('import.accountsReading')}
                    </span>
                  ) : (
                    <Select value={model.accountId ?? ''} onChange={(event) => actions?.onAccount?.(event.target.value || null)}>
                      <option value="">{sheet ? t('import.accountChoose') : t('import.accountByFile')}</option>
                      {model.accounts.map((entry) => (
                        <option key={entry.id} value={entry.id} disabled={!entry.active}>
                          {`${entry.bankName ?? entry.holder} · ${maskIban(entry.iban)}${entry.active ? '' : ` · ${t('import.accountOff')}`}`}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            )}
          </>
        )}

        {model.step === 'mapping' && plan?.mapping && (
          <>
            <p className="fw-bank-muted">{t('import.mappingBody')}</p>
            <div className="fw-bank-two">
              <Field label={t('import.numberFormat')}>
                <Select value={model.numberFormat} onChange={(event) => actions?.onNumberFormat?.(event.target.value as NumberFormat)}>
                  {NUMBER_FORMATS.map((format) => (
                    <option key={format} value={format}>
                      {t(`import.numbers.${format}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              {plan.sheet && plan.sheet.names.length > 1 && (
                <Field label={t('import.sheet')}>
                  <Select value={model.sheetName ?? plan.sheet.name ?? ''} onChange={(event) => actions?.onSheet?.(event.target.value)}>
                    {plan.sheet.names.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <ul className="fw-bank-rows" aria-label={t('import.mappingLabel')}>
              {plan.mapping.headers.map((header) => (
                <li key={header} className="fw-bank-row">
                  <span className="fw-bank-code">{header || t('import.noHeader')}</span>
                  <Select size="sm" aria-label={t('import.mapTo', { header })} value={model.mapping[header] ?? ''} onChange={(event) => actions?.onMapping?.(header, (event.target.value || null) as StatementColumn | null)}>
                    <option value="">{t('import.column.none')}</option>
                    {STATEMENT_COLUMNS.map((column) => (
                      <option key={column} value={column}>
                        {t(`import.column.${column}`)}
                      </option>
                    ))}
                  </Select>
                </li>
              ))}
            </ul>
            {missing.length > 0 && <p className="fw-bank-muted">{missing.map(phrase).join(' ')}</p>}
          </>
        )}

        {(model.step === 'review' || model.step === 'importing') && plan && (
          <>
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('import.account'), value: `${account?.bankName ?? account?.holder ?? ''} ${maskIban(plan.account.iban)}`.trim() },
                { label: t('import.period'), value: plan.period ? t('import.periodValue', { from: day(plan.period.start), to: day(plan.period.end) }) : '—' },
                { label: t('import.moneyIn'), value: can.price ? money(plan.totals.moneyIn ?? null, plan.account.currency, locale) : '—' },
                { label: t('import.moneyOut'), value: can.price ? money(plan.totals.moneyOut ?? null, plan.account.currency, locale) : '—' },
              ]}
            />
            <span className="fw-bank-inline" role="status">
              <Pill tone="success">{t('import.counts.new', { count: plan.counts.new })}</Pill>
              <Pill tone="neutral">{t('import.counts.duplicate', { count: plan.counts.duplicate })}</Pill>
              <Pill tone={plan.counts.error > 0 ? 'danger' : 'neutral'}>{t('import.counts.error', { count: plan.counts.error })}</Pill>
            </span>
            {plan.counts.duplicate > 0 && <p className="fw-bank-muted">{t('import.duplicates')}</p>}
            {plan.counts.error > 0 && (
              <div className="fw-bank-stack">
                <Checkbox checked={model.skipErrors} onChange={(event) => actions?.onSkipErrors?.(event.target.checked)} label={t('import.skipErrors', { count: plan.counts.error })} />
                {sheet && (
                  <Button size="sm" variant="link" onClick={() => actions?.onBack?.()}>
                    {t('import.fixMapping')}
                  </Button>
                )}
              </div>
            )}
            <SummaryTable
              label={t('import.linesLabel')}
              stackOnPhone
              columns={[t('import.col.row'), t('import.col.verdict'), t('import.col.booked'), ...(can.price ? [t('import.col.amount')] : []), t('import.col.text')]}
              align={['left', 'left', 'left', ...(can.price ? (['right'] as const) : []), 'left']}
              widths={['8%', '22%', '14%', ...(can.price ? ['14%'] : []), undefined]}
              rows={plan.lines.slice(0, 200).map((line) => ({
                id: String(line.row),
                cells: [
                  String(line.row),
                  <span key="verdict" className="fw-bank-stack">
                    <Pill tone={line.verdict === 'NEW' ? 'success' : line.verdict === 'ERROR' ? 'danger' : 'neutral'}>{t(`import.verdict.${line.verdict}`)}</Pill>
                    {line.problems.map((problem) => (
                      <span key={problem.code} className="nds-summary-sub">
                        {t(`import.problem.${problem.code}`)}
                      </span>
                    ))}
                  </span>,
                  day(line.bookedOn),
                  ...(can.price ? [line.amount === null || line.amount === undefined ? '—' : money(line.amount, line.currency ?? plan.account.currency, locale)] : []),
                  [line.counterpartyName, line.referenceText].filter(Boolean).join(' · ') || '—',
                ],
              }))}
            />
            {plan.lines.length > 200 && <p className="fw-bank-muted">{t('import.first200', { count: plan.lines.length })}</p>}
          </>
        )}

        {model.step === 'done' && model.imported && (
          <Banner tone="success" title={t('import.done.title', { count: model.imported.lineIds.length })}>
            <p className="fw-bank-muted">{t('import.done.body', { suggested: model.imported.suggested, duplicate: model.imported.counts.duplicate })}</p>
          </Banner>
        )}
      </div>
    </Modal>
  )
}
