'use client'

import Link from 'next/link'
import { CircleStop } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { placeWords, sessionRows, type SessionsRead } from '../../../../../me/sessions/model'
import { DeviceCell, SessionsLoading } from '../../../../../me/sessions/view/parts'
import { BulkConfirm } from '../../../../shared/view/BulkConfirm'
import '../../../../../me/sessions/sessions.css'

export interface UserSessionsModel {
  /** `/w/<company>` (My profile's address). */
  prefix: string
  /** The person's name (the confirm says whose sessions end). */
  name: string
  /** The person is the one signed in: their own sessions end on My profile (the API refuses them here). */
  self: boolean
  read: SessionsRead
  /** "End all sessions?" is open (null: closed); its problem is a message key of `admin`. */
  confirm: { busy: boolean; problem: string | null } | null
  notice: { key: string; tone: 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
}

export interface UserSessionsActions {
  onRetry?: () => void
  onEndAll?: () => void
  onConfirm?: (reason: string) => void
  onCancel?: () => void
  onDismissNotice?: () => void
}

/**
 * Admin › Users › a person › Sessions & sign-ins (SCR-011 tab `sessions`, B-W2b-413; design admin.users rec:User/sessions/live
 * "Signed in now"): device, place, started, last used; "End all sessions" with an optional reason (ENDED_BY_ADMIN). Rows only:
 * never a figure about the person. The tab exists only for users.sessions.manage. Fetches nothing (UserSessions.tsx reads).
 */
export function UserSessionsTab({ model, actions }: { model: UserSessionsModel; actions?: UserSessionsActions }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <Sessions model={model} actions={actions} />
    </WithMessages>
  )
}

function Sessions({ model, actions }: { model: UserSessionsModel; actions?: UserSessionsActions }) {
  const t = useT('admin-security-depth')
  const locale = useLocale()
  const rows = model.read.state === 'ok' ? sessionRows(model.read.sessions) : []
  const held = model.self ? t('person.held.self') : model.read.state !== 'ok' ? t('person.held.reading') : rows.length === 0 ? t('person.held.none') : null
  return (
    <div className="fw-ses-stack">
      {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={actions?.onDismissNotice} />}
      <Card
        header={t('person.title')}
        description={t('person.description')}
        headingLevel={2}
        headerAction={
          <Button size="sm" variant="danger-outline" heldReason={held} onClick={() => actions?.onEndAll?.()}>
            <CircleStop size={13} aria-hidden /> {t('person.endAll')}
          </Button>
        }
      >
        {model.self ? (
          <EmptyState title={t('person.selfTitle')} description={t('person.held.self')} action={<Button size="sm" asChild><Link href={`${model.prefix}/me#signed-in`}>{t('person.toProfile')}</Link></Button>} />
        ) : model.read.state === 'loading' ? (
          <SessionsLoading />
        ) : model.read.state === 'failed' ? (
          <EmptyState
            title={t('session.failed.title')}
            description={t(model.read.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('session.retry')}
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState title={t('person.empty')} description={t('person.emptyHint')} />
        ) : (
          <SummaryTable
            label={t('person.title')}
            density="roomy"
            stackOnPhone
            columns={[t('session.col.device'), t('session.col.place'), t('session.col.started'), t('session.col.lastUsed')]}
            widths={['38%', '22%', '20%', '20%']}
            align={['left', 'left', 'left', 'left']}
            rows={rows.map((session) => ({
              id: session.id,
              cells: [
                <DeviceCell key="device" session={{ ...session, current: false }} />,
                <span key="place">{placeWords(session.place, locale, t)}</span>,
                <span key="started">{formatDateTime(session.startedAt, { locale })}</span>,
                <span key="used">{formatDateTime(session.lastUsedAt, { locale })}</span>,
              ],
            }))}
          />
        )}
      </Card>
      <p className="fw-ses-hint">{t('person.historyLater')}</p>
      <BulkConfirm
        open={!!model.confirm}
        title={t('person.confirm.title', { name: model.name })}
        lines={[t('person.confirm.what', { count: rows.length, name: model.name }), t('person.confirm.again')]}
        confirmLabel={t('person.confirm.button', { count: rows.length })}
        reason
        busy={model.confirm?.busy}
        problem={model.confirm?.problem}
        onConfirm={(reason) => actions?.onConfirm?.(reason)}
        onClose={() => actions?.onCancel?.()}
      />
    </div>
  )
}
