'use client'

import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useWords } from '../../../_shared/parts'
import type { HistoryEntry } from '../../api'
import { SETTINGS_NAMESPACES, TIME_ZONE } from '../../model'
import type { Section } from '../../view/SettingsView'
import '../../settings.css'

export interface HistoryModel {
  read: Section<HistoryEntry[]>
}

export const HISTORY_ACTIONS = [
  'changeAttendanceSettings',
  'changePrivacySettings',
  'switchOnPurpose',
  'switchOffPurpose',
  'changePurposeLeads',
  'createAbsenceCode',
  'editAbsenceCode',
  'archiveAbsenceCode',
  'restoreAbsenceCode',
  'saveWorkingTimeLimit',
  'archiveWorkingTimeLimit',
] as const

export const historyWords = (action: string): string => {
  const name = action.replace(/^people\./, '')
  return (HISTORY_ACTIONS as readonly string[]).includes(name) ? `history.action.${name}` : 'history.action.other'
}

/** SCR-265-audit — the settings' audit log in a window of its own: when, who, what, why. Never who saw whom. */
export function HistoryView({ model }: { model: HistoryModel }) {
  return (
    <WithMessages namespaces={SETTINGS_NAMESPACES}>
      <Log model={model} />
    </WithMessages>
  )
}

function Log({ model }: { model: HistoryModel }) {
  const t = useT('people-settings')
  const people = useWords()
  const locale = useLocale()
  const { read } = model
  return (
    <div className="fw-pp fw-ps-window">
      <h1>{t('history.title')}</h1>
      <Card padded>
        {read.status === 'loading' ? (
          <p className="fw-ps-hint" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : read.status === 'error' ? (
          <EmptyState title={t('history.failed')} description={people(read.problem)} />
        ) : read.value.length === 0 ? (
          <EmptyState title={t('history.empty')} />
        ) : (
          <SummaryTable
            label={t('history.title')}
            columns={[t('history.when'), t('history.who'), t('history.what'), t('common.reason')]}
            align={['left', 'left', 'left', 'left']}
            stackOnPhone
            rows={read.value.map((entry) => ({ id: entry.id, cells: [formatDateTime(entry.at, { locale, timeZone: TIME_ZONE }), entry.actorName ?? t('history.system'), t(historyWords(entry.action)), entry.reason ?? '—'] }))}
          />
        )}
      </Card>
    </div>
  )
}
