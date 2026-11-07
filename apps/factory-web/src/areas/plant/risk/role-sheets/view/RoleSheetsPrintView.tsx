'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { RoleSheet, SheetLaw } from '../../api'
import { LAW, localName, surveillanceWords } from '../../model'
import { RISK_NAMESPACES, useWords } from '../../view/parts'
import '../../risk.css'

/** SCR-209-role-sheet — "Role sheet (print)": one view model, nothing fetched. */
export interface RoleSheetsPrintModel {
  person: string
  at: string
  company: string
  canView: boolean
  sheets: RoleSheet[] | null
  law: SheetLaw | null
  problem: string | null
}

/**
 * tab:role-sheet — "Role sheet (print)" (design plant.risk new tab: "Given to the worker at induction"): one page per role —
 * what the role is, its risks and the surveillance needs behind any visits, the PPE with when to wear it, the courses and
 * their deadlines, whether the role needs health surveillance (the role's, never a person's), the law — and the lines the
 * worker signs on paper when they receive it. No list of the people in the role: the paper goes to one worker.
 */
export function RoleSheetsPrintView({ model }: { model: RoleSheetsPrintModel }) {
  return (
    <WithMessages namespaces={RISK_NAMESPACES}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: RoleSheetsPrintModel }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const waiting = model.canView && !model.sheets && !model.problem
  const law = model.law
  return (
    <PrintView title={t('sheetPrint.title')} meta={[model.company]} printedAt={formatDateTime(model.at, { locale })} printedBy={model.person} filters={null} printHeld={waiting ? t('common.stillLoading') : null} labels={ds.printView}>
      {!model.canView ? (
        <EmptyState title={t('access.title')} description={t('access.body')} />
      ) : model.problem ? (
        <Banner tone="warning" title={t('sheetPrint.failed')}>
          {t(model.problem)}
        </Banner>
      ) : !model.sheets ? (
        <p className="fw-rk-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : model.sheets.length === 0 ? (
        <p>{t('sheetPrint.none')}</p>
      ) : (
        model.sheets.map((sheet, index) => {
          const surveillance = surveillanceWords(sheet.plan)
          const risks = sheet.items.filter((item) => item.kind === 'RISK')
          const needs = sheet.items.filter((item) => item.kind === 'SURVEILLANCE')
          return (
            <PrintSection key={sheet.id} title={t('sheetPrint.role', { role: localName(sheet, locale), code: sheet.code, site: sheet.site.name })} className={index > 0 ? 'fw-rk-page-break' : undefined}>
              {sheet.description && <p>{sheet.description}</p>}
              <h3 className="fw-rk-h3">{t('sheet.risks')}</h3>
              {risks.length === 0 ? (
                <p>{t('sheet.noRisks')}</p>
              ) : (
                <ul className="fw-rk-list">
                  {risks.map((item) => (
                    <li key={item.id}>
                      {item.title}
                      {item.note ? ` — ${item.note}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="fw-rk-h3">{t('sheet.kit')}</h3>
              {sheet.kit.length === 0 ? (
                <p>{t('sheet.noKit')}</p>
              ) : (
                <SummaryTable
                  label={t('sheet.kit')}
                  columns={[t('sheetPrint.item'), t('sheet.quantity'), t('sheet.whenToWear')]}
                  widths={['40%', '12%', undefined]}
                  align={[undefined, 'right', 'left']}
                  rows={sheet.kit.map((line) => ({ id: line.id, cells: [`${localName(line.item, locale)}${line.item.standard ? ` (${line.item.standard})` : ''}`, String(line.quantity), line.whenToWear] }))}
                />
              )}
              <h3 className="fw-rk-h3">{t('sheet.courses')}</h3>
              {sheet.requirements.length === 0 ? (
                <p>{t('sheet.noCourses')}</p>
              ) : (
                <SummaryTable
                  label={t('sheet.courses')}
                  columns={[t('sheetPrint.course'), t('sheetPrint.hours'), t('sheetPrint.when')]}
                  widths={['50%', '15%', undefined]}
                  align={[undefined, 'right', 'left']}
                  rows={sheet.requirements.map((line) => ({ id: line.id, cells: [localName(line.course, locale), line.course.hours, line.withinDays === null ? t('within.before') : t('within.days', { count: line.withinDays })] }))}
                />
              )}
              <h3 className="fw-rk-h3">{t('sheet.health')}</h3>
              <p>{t(surveillance.key, surveillance.params)}</p>
              {needs.length > 0 && (
                <ul className="fw-rk-list">
                  {needs.map((item) => (
                    <li key={item.id}>{item.title}</li>
                  ))}
                </ul>
              )}
              <p className="fw-rk-print-note">{t('sheetPrint.law', { roleSheet: law?.roleSheet ?? LAW.roleSheet, kit: law?.kit ?? LAW.kit, training: law?.training ?? LAW.training, surveillance: law?.surveillance ?? LAW.surveillance })}</p>
              <div className="fw-rk-print-sign">
                <span>{t('sheetPrint.givenTo')}</span>
                <span>{t('sheetPrint.date')}</span>
                <span>{t('sheetPrint.signature')}</span>
              </div>
            </PrintSection>
          )
        })
      )}
    </PrintView>
  )
}
