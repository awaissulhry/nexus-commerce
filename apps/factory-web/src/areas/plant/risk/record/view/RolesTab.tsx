'use client'

import { Printer, Users } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { AssessmentRecord } from '../../api'
import { localName, roleSheetsHref, surveillanceWords } from '../../model'
import type { RiskRecordActions, RiskRecordModel } from '../../view-model'
import { Law, SectionFailed, SectionHead, SectionLoading, useWords } from '../../view/parts'
import { SheetCard } from '../../view/SheetCard'

/**
 * The Role sheets tab (design rec tab roles; QHS-236; Owner answer H2): one sheet per role (mansione) at the assessment's
 * site — role, people, risks, PPE items, courses, surveillance (the DS SummaryTable: a short read-only table inside a
 * record) — a role chosen shows its sheet below (the form card: read, then Edit under the EditModeBar, "What this changes"
 * before Apply). Empty: "Add the first role" (usually 6 to 10 in a small factory).
 */
export function RolesTab({ model, record, actions }: { model: RiskRecordModel; record: AssessmentRecord; actions?: RiskRecordActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const answer = model.sheets.status === 'ready' ? model.sheets.value : null
  const canAdd = model.can.sheets && (answer?.canAdd ?? true)
  const head = (
    <SectionHead id="fw-rk-record-roles" title={t('roles.tabTitle', { site: record.assessment.site.name })} note={<Law law={answer?.law.roleSheet ?? 'D.Lgs. 81/2008 art. 28'} plain={t('law.roleSheet')} />}>
      {answer && answer.roleSheets.length > 0 && (
        <Button size="sm" asChild>
          <a href={roleSheetsHref(model.prefix, answer.roleSheets.map((row) => row.id))} target="_blank" rel="noopener">
            <Printer size={13} aria-hidden /> {t('band.printSheets')}
          </a>
        </Button>
      )}
      <Button size="sm" heldReason={canAdd ? null : t('held.sheets')} onClick={() => actions?.onAddress?.({ add: 'role' })}>
        <Users size={13} aria-hidden /> {t('roles.add')}
      </Button>
    </SectionHead>
  )
  if (model.sheets.status === 'error') {
    return (
      <div className="fw-rk-stack">
        {head}
        <SectionFailed title={t('roles.failed')} problem={model.sheets.problem} onRetry={actions?.onRetrySheets} />
      </div>
    )
  }
  if (!answer) {
    return (
      <div className="fw-rk-stack">
        {head}
        <SectionLoading rows={4} />
      </div>
    )
  }
  if (answer.roleSheets.length === 0) {
    return (
      <div className="fw-rk-stack">
        {head}
        <Card padded>
          <EmptyState
            icon={<Users size={22} aria-hidden />}
            title={t('roles.emptyTitle')}
            description={t('roles.empty')}
            action={
              <Button size="sm" variant="primary" heldReason={canAdd ? null : t('held.sheets')} onClick={() => actions?.onAddress?.({ add: 'role' })}>
                {t('roles.addFirst')}
              </Button>
            }
          />
        </Card>
      </div>
    )
  }
  return (
    <div className="fw-rk-stack">
      {head}
      <Card padded>
        <SummaryTable
          label={t('roles.label')}
          columns={[t('roles.col.role'), t('roles.col.people'), t('roles.col.risks'), t('roles.col.ppe'), t('roles.col.courses'), t('roles.col.surveillance')]}
          widths={['30%', '10%', '10%', '12%', '12%', undefined]}
          align={[undefined, 'right', 'right', 'right', 'right', 'left']}
          density="roomy"
          stackOnPhone
          rows={answer.roleSheets.map((row) => {
            const words = surveillanceWords(row.surveillance)
            const chosen = model.address.sheet === row.id
            return {
              id: row.id,
              cells: [
                <Button key="role" size="sm" variant={chosen ? 'primary' : 'quiet'} aria-pressed={chosen} onClick={() => actions?.onAddress?.({ sheet: chosen ? null : row.id })}>
                  {`${localName(row, locale)} · ${row.code}`}
                </Button>,
                String(row.people),
                String(row.risks),
                row.ppeItems === 0 ? t('roles.noKit') : String(row.ppeItems),
                row.courses === 0 ? t('roles.noCourses') : String(row.courses),
                t(words.key, words.params),
              ],
            }
          })}
        />
      </Card>
      {model.sheet ? <SheetCard frame={model} state={model.sheet} actions={actions} /> : <p className="fw-rk-muted">{t('roles.choose')}</p>}
    </div>
  )
}
