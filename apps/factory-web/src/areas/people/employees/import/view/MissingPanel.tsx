'use client'

import { useId } from 'react'
import Link from 'next/link'
import { Banner, Card, DateField, Field } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { useDsLabels } from '../../../../../lib/i18n/ds-labels'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { WizardActions } from '../../../../admin/import/view/ImportWizard'
import type { SheetImport } from '../../../../products/styles/import/sheet-import'
import { SheetImportDialog } from '../../../../products/styles/import/view/SheetImportDialog'
import type { MissingEmployee } from '../../../_shared/api'
import type { PeopleCan, Words } from '../../../_shared/model'
import { PeopleMessages, say, useWords } from '../../../_shared/parts'

export interface MissingModel {
  jobId: string
  /** Active people of the job's company with an employee code the file does not have. */
  people: MissingEmployee[]
  lastWorkingDay: string
  busy: boolean
  /** How many were given their leaver steps so far. */
  done: number
  refused: Array<{ person: MissingEmployee; words: Words }>
}

/**
 * The import's two parts on the page: the wizard (the shared sheet import's dialog) and, once its dry run is read, "In
 * Nexus but not in the file" — the people the payroll file left out, offered their leaver steps with one last working
 * day (each one its own command; the steps follow in Leavers in progress). It fetches nothing.
 */
export function MissingPanel({
  sheet,
  sheetActions,
  missing,
  can,
  inline,
  prefix = '',
  onDay,
  onStart,
  onDismiss,
}: {
  sheet: SheetImport | null
  sheetActions?: WizardActions
  missing: MissingModel | null
  can: PeopleCan
  inline?: boolean
  prefix?: string
  onDay?: (day: string) => void
  onStart?: () => void
  onDismiss?: () => void
}) {
  return (
    <PeopleMessages>
      {sheet && <SheetImportDialog model={sheet} actions={sheetActions} inline={inline} />}
      {missing && missing.people.length > 0 && <Missing missing={missing} can={can} prefix={prefix} onDay={onDay} onStart={onStart} onDismiss={onDismiss} />}
    </PeopleMessages>
  )
}

function Missing({ missing, can, prefix, onDay, onStart, onDismiss }: { missing: MissingModel; can: PeopleCan; prefix: string; onDay?: (day: string) => void; onStart?: () => void; onDismiss?: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsLabels()
  const id = useId()
  const waiting = missing.people.filter((person) => !person.leaving)
  const held = !can.manageLeavers ? t('held.noManageLeavers') : waiting.length === 0 ? t('held.allLeaving') : !missing.lastWorkingDay ? t('held.lastDay') : missing.busy ? t('held.busy') : null
  return (
    <Card padded header={t('missing.title', { count: missing.people.length })} headingLevel={2} headerAction={<Button size="sm" variant="quiet" onClick={onDismiss}>{t('common.close')}</Button>}>
      <div className="fw-pp-card-body">
        <p className="fw-pp-hint">{t('missing.body')}</p>
        <ul className="fw-pp-plain">
          {missing.people.map((person) => (
            <li key={person.id} className="fw-pp-row">
              <Link className="fw-pp-link" href={`${prefix}/people/employees/${encodeURIComponent(person.id)}`}>
                {person.name}
              </Link>
              <span className="fw-pp-code">{person.employeeCode}</span>
              <Tag tone="neutral">{person.site.code}</Tag>
              {person.leaving && <Tag tone="warning">{t('missing.leaving')}</Tag>}
            </li>
          ))}
        </ul>
        {missing.refused.length > 0 && (
          <Banner tone="danger" title={t('missing.refused', { count: missing.refused.length })}>
            <ul className="fw-pp-list">
              {missing.refused.map((entry) => (
                <li key={entry.person.id}>{`${entry.person.name}: ${say(t, entry.words)}`}</li>
              ))}
            </ul>
          </Banner>
        )}
        {missing.done > 0 && <Banner tone="success" title={t('missing.done', { count: missing.done })} />}
        <div className="fw-pp-row">
          <Field label={t('leaver.lastDay')} htmlFor={`${id}-day`}>
            <DateField id={`${id}-day`} value={missing.lastWorkingDay} locale={INTL_LOCALE[locale]} onChange={(value) => onDay?.(value)} labels={ds.dateField} />
          </Field>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => !held && onStart?.()}>
            {missing.busy ? <Spinner size={12} /> : null} {t('missing.start', { count: waiting.length })}
          </Button>
        </div>
      </div>
    </Card>
  )
}
