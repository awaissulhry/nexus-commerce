'use client'

import { Banner, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Select, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Checklist } from '../../api'
import { PlansMessages } from '../../view/parts'

/** SCR-077-print — the plans' checklists on paper (design tab:pl-print): one view model, nothing fetched. */
export interface PlanPrintModel {
  readonly prefix: string
  readonly person: string
  readonly at: string
  readonly company: string
  /** quality.plans.view. */
  readonly can: boolean
  /** One checklist per plan asked; null while it is read; a problem in this page's words. */
  readonly sheets: readonly { readonly planId: string; readonly checklist: Checklist | null; readonly problem: string | null }[]
  /** The language asked (the bench's), and those the plans may be printed in. */
  readonly language: string
  readonly languages: readonly string[]
  /** No plan asked in the address. */
  readonly nothing: boolean
}

export interface PlanPrintActions {
  onLanguage?: (language: string) => void
}

/**
 * The printable checklist (design tab:pl-print, "a paper fallback for a bench without a tablet"): per plan the version's
 * checks in the bench's language (Italian, English or a floor language; a check without its words in that language says
 * so), the lines to fill (lot, sample), the answer to tick per check, sample columns for a fixed sample, the signature
 * lines and the legend — the domain's printable checklist as the API writes it. A version not in force says so on top.
 */
export function PlanPrintView({ model, actions }: { model: PlanPrintModel; actions?: PlanPrintActions }) {
  return (
    <PlansMessages>
      <Sheets model={model} actions={actions} />
    </PlansMessages>
  )
}

function Sheets({ model, actions }: { model: PlanPrintModel; actions?: PlanPrintActions }) {
  const t = useT('quality-plans')
  const ds = useDsWords()
  const locale = useLocale()
  const back = { href: `${model.prefix}/quality/plans`, label: t('print.back') }
  if (!model.can) {
    return (
      <PrintView title={t('print.title')} back={back} labels={ds.printView} printHeld={t('noAccess.plans')}>
        <EmptyState title={t('noAccess.title')} description={t('noAccess.plans')} />
      </PrintView>
    )
  }
  const reading = model.sheets.some((sheet) => sheet.checklist === null && sheet.problem === null)
  const failed = model.sheets.filter((sheet) => sheet.problem).length
  const title = model.sheets.length === 1 && model.sheets[0]!.checklist ? model.sheets[0]!.checklist.title : t('print.titleMany', { count: model.sheets.length })
  return (
    <PrintView
      title={title}
      meta={[model.company, t('print.languageLine', { language: t(`language.${model.language}`) === `language.${model.language}` ? model.language : t(`language.${model.language}`) })]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={null}
      printHeld={model.nothing ? t('print.nothing') : reading ? t('print.reading') : null}
      back={back}
      labels={ds.printView}
      tools={
        <Select size="sm" aria-label={t('print.language')} value={model.language} onChange={(event) => actions?.onLanguage?.(event.target.value)}>
          {model.languages.map((language) => (
            <option key={language} value={language}>
              {t(`language.${language}`) === `language.${language}` ? language : t(`language.${language}`)}
            </option>
          ))}
        </Select>
      }
    >
      {model.nothing && <EmptyState title={t('print.nothing')} description={t('print.nothingBody')} />}
      {failed > 0 && <Banner tone="danger" title={t('print.failed', { count: failed })} />}
      {model.sheets.map((sheet) =>
        sheet.problem ? null : !sheet.checklist ? (
          <p key={sheet.planId} className="fw-qp-muted" role="status">
            <Spinner size={14} /> {t('print.reading')}
          </p>
        ) : (
          <Sheet key={sheet.planId} checklist={sheet.checklist} titled={model.sheets.length > 1} />
        ),
      )}
    </PrintView>
  )
}

function Sheet({ checklist, titled }: { checklist: Checklist; titled: boolean }) {
  const t = useT('quality-plans')
  const samples = Array.from({ length: checklist.sampleColumns }, (_, index) => String(index + 1))
  return (
    <PrintSection title={titled ? checklist.title : undefined}>
      <div className="fw-qp-sheet">
        <p className="fw-qp-sheet-sub">{checklist.subtitle}</p>
        {checklist.notInForce && <Banner tone="warning" title={checklist.notInForce} />}
        <KeyValue columns={2} dense items={checklist.lines.map((line) => ({ label: line.label, value: line.value }))} />
        <SummaryTable
          label={checklist.subtitle}
          columns={['#', t('print.col.check'), t('print.col.kind'), t('print.col.spec'), t('print.col.answer'), ...samples]}
          align={['right', 'left', 'left', 'left', 'left', ...samples.map(() => 'left' as const)]}
          rows={checklist.rows.map((row) => ({
            id: row.code,
            cells: [
              row.n,
              <span key="label" className="fw-qp-sheet-check">
                <strong>{row.label}</strong>
                {row.missing && <em> ({t('print.missing')})</em>}
                <span className="fw-q-code"> {row.code}</span>
                {row.choices.length > 0 && <span className="fw-qp-sheet-choices">{row.choices.join('   ')}</span>}
              </span>,
              [row.type, row.klass, row.critical ? '!' : null, row.mandatory ? '*' : null, row.photoRequired ? t('print.photo') : null].filter(Boolean).join(' · '),
              row.spec ?? '',
              row.answer,
              ...samples.map((sample) => <span key={sample} className="fw-qp-sheet-box" aria-label={t('print.sampleN', { n: sample })} />),
            ],
          }))}
        />
        <div className="fw-qp-sheet-sign">
          {checklist.signatures.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <p className="fw-qp-muted">{checklist.legend}</p>
      </div>
    </PrintSection>
  )
}
