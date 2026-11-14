'use client'

import { LogOut } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { ActionConfirm } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { LiveSession } from '../api'
import { deviceWords, othersOf, placeWords, sessionRows, type SessionsRead } from '../model'
import { DeviceCell, SessionsLoading } from './parts'
import '../sessions.css'

export interface MySessionsModel {
  read: SessionsRead
  /** "Sign out everywhere else?" is open (null: closed). */
  confirm: { busy: boolean; problem: string | null } | null
  /** The session being ended now. */
  ending: string | null
  notice: { key: string; tone: 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
}

export interface MySessionsActions {
  onRetry?: () => void
  onEnd?: (sessionId: string) => void
  onEndOthers?: () => void
  onConfirm?: () => void
  onCancel?: () => void
  onDismissNotice?: () => void
}

/**
 * My profile › Where I'm signed in (SCR-007 section `sessions`, B-W2b-413; PLT-064): every browser where I am signed in —
 * device and browser, place (country and city, when known), last used, "This browser" — End one, and "Sign out everywhere
 * else" (the DS ActionConfirm with how many end). Fetches nothing (MySessions.tsx reads the API).
 */
export function MySessionsCard({ model, actions }: { model: MySessionsModel; actions?: MySessionsActions }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <SessionsCard model={model} actions={actions} />
    </WithMessages>
  )
}

function SessionsCard({ model, actions }: { model: MySessionsModel; actions?: MySessionsActions }) {
  const t = useT('admin-security-depth')
  const locale = useLocale()
  const rows = model.read.state === 'ok' ? sessionRows(model.read.sessions) : []
  const others = model.read.state === 'ok' ? othersOf(model.read.sessions) : 0
  const held = model.read.state !== 'ok' ? t('me.held.reading') : others === 0 ? t('me.held.onlyThis') : null
  return (
    <Card
      id="signed-in"
      header={t('me.title')}
      description={t('me.description')}
      headingLevel={2}
      headerAction={
        <Button size="sm" heldReason={held} onClick={() => actions?.onEndOthers?.()}>
          <LogOut size={14} aria-hidden /> {t('me.endOthers.button')}
        </Button>
      }
    >
      <div className="fw-ses-stack">
        {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={actions?.onDismissNotice} />}
        {model.read.state === 'loading' ? (
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
        ) : (
          <>
            <SummaryTable
              label={t('me.title')}
              density="roomy"
              stackOnPhone
              columns={[t('session.col.device'), t('session.col.place'), t('session.col.lastUsed'), t('session.col.do')]}
              widths={['40%', '24%', '22%', '14%']}
              align={['left', 'left', 'left', 'right']}
              rows={rows.map((session) => ({ id: session.id, cells: cellsOf(session) }))}
            />
            {others === 0 && <p className="fw-ses-hint">{t('me.empty')}</p>}
          </>
        )}
      </div>
      {model.confirm && (
        <ActionConfirm
          impact={{
            level: 'confirm',
            reach: 'local',
            title: t('me.endOthers.title'),
            confirmLabel: model.confirm.busy ? t('me.endOthers.busy') : t('me.endOthers.confirm', { count: others }),
            consequences: [t('me.endOthers.what', { count: others }), t('me.endOthers.stay')],
            reversal: { verb: t('me.endOthers.back'), fidelity: 'exact' },
            ...(model.confirm.problem ? { refusal: { reason: t(model.confirm.problem) } } : {}),
          }}
          onConfirm={() => actions?.onConfirm?.()}
          onCancel={() => actions?.onCancel?.()}
        />
      )}
    </Card>
  )

  function cellsOf(session: LiveSession) {
    return [
      <DeviceCell key="device" session={session} />,
      <span key="place">{placeWords(session.place, locale, t)}</span>,
      <span key="used" title={t('session.startedAt', { time: formatDateTime(session.startedAt, { locale }) })}>
        {formatDateTime(session.lastUsedAt, { locale })}
      </span>,
      session.current ? (
        <span key="do" className="fw-ses-hint">
          {t('me.here')}
        </span>
      ) : (
        <Button key="do" size="sm" variant="quiet" heldReason={model.ending === session.id ? t('me.held.ending') : null} onClick={() => actions?.onEnd?.(session.id)} aria-label={t('me.endOne', { device: deviceWords(session, t) })}>
          {t('me.end')}
        </Button>
      ),
    ]
  }
}
