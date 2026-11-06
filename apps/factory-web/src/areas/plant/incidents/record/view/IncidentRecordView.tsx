'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Ban, CheckCheck, FileSignature, MoreHorizontal, RotateCcw } from 'lucide-react'
import { Banner, Menu, type TabItem } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { WithMessages } from '../../../../../record-panels/i18n'
import { LiveLine, RecordFrame } from '../../../_shared/parts'
import { actionsOpen, cancelHeld, closeHeld, filingHeld, filingsWaiting, INCIDENTS_PATH, reopenHeld } from '../../model'
import { RECORD_TABS, type IncidentRecordActions, type IncidentRecordModel } from '../../view-model'
import '../../incidents.css'
import { INCIDENT_NAMESPACES, KeysModal, KindTag, RECORD_KEYS, SeverityTag, StatusTag, useWhen, useWords } from '../../view/parts'
import { ActionsTab } from './ActionsTab'
import { AuthorityTab } from './AuthorityTab'
import { RecordDialogs } from './RecordDialogs'
import { ReportTab } from './ReportTab'

export type { IncidentRecordActions, IncidentRecordModel } from '../../view-model'

/**
 * SCR-210-record — an incident (design plant.incidents "Record: Incident", a record page; tab:record — ⌘-click a number opens
 * it in a new tab): the band (‹ Incidents, "<number> · kind", its status, severity, "seen by safety", the live line; the
 * primary Record INAIL filing, `f`, held with its reason; ⋯ Close incident (held while an action is open or a filing waits),
 * Reopen, Cancel the report, the print) and the tabs Report (what happened, edited by the safety roles with the EditModeBar;
 * the photos; the people involved — protected: the count for everyone, the names and injuries only after the recorded open),
 * Actions (each made into a maintenance job or a measure of the improvement plan in one step) and Authority notice (what the
 * law asks, the deadlines with their countdown, the filings after the recorded open, the INAIL portal). Investigation and
 * lost days stay W3 / Later. One view model, nothing fetched.
 */
export function IncidentRecordView({ model, actions }: { model: IncidentRecordModel; actions?: IncidentRecordActions }) {
  return (
    <WithMessages namespaces={INCIDENT_NAMESPACES}>
      <RecordBody model={model} actions={actions} />
    </WithMessages>
  )
}

function RecordBody({ model, actions }: { model: IncidentRecordModel; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const when = useWhen()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const listHref = `${model.prefix}${INCIDENTS_PATH}`
  const value = model.loaded.status === 'ready' ? model.loaded.value : null
  const incident = value?.incident ?? null
  const base = incident ? `${listHref}/${encodeURIComponent(incident.id)}` : listHref
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: tab === 'report' ? base : `${base}?tab=${tab}`,
    label: t(`tab.${tab}`),
    count: incident ? (tab === 'actions' ? actionsOpen(incident) || null : tab === 'authority' ? filingsWaiting(incident) || null : null) : null,
  }))
  const fHeld = incident ? filingHeld(incident) : 'held.reading'

  // f: Record INAIL filing; 1 2 3: the tabs; ?: the keys — never while typing, in a menu or a dialog.
  const latest = useRef({ actions, fHeld, base })
  latest.current = { actions, fHeld, base }
  const quiet = model.dialog !== null || keysOpen || model.edit !== null
  useEffect(() => {
    if (quiet || !incident) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      const now = latest.current
      if (event.key === 'f' && !now.fHeld) {
        event.preventDefault()
        now.actions?.onDialog?.({ kind: 'peopleNote', then: 'filings' })
      } else if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quiet, incident])

  let title: ReactNode = null
  let meta: ReactNode = null
  let bandActions: ReactNode = null
  if (incident) {
    const close = closeHeld(incident)
    const reopen = reopenHeld(incident)
    const cancel = cancelHeld(incident)
    title = `${incident.number} · ${t(`kind.${incident.kind}`)}`
    meta = (
      <>
        <StatusTag status={incident.status} />
        <KindTag kind={incident.kind} />
        <SeverityTag severity={incident.severity} />
        <Tag tone="neutral">{incident.site.name}</Tag>
        {incident.seen ? <Tag tone="success">{t('record.seenAt', { at: when.at(incident.seen.at) })}</Tag> : incident.status === 'OPEN' ? <Tag tone="warning">{t('record.notSeen')}</Tag> : null}
      </>
    )
    bandActions = (
      <span className="fw-inc-actions">
        {incident.status === 'CLOSED' ? (
          <Button size="sm" heldReason={reopen ? t(reopen) : null} onClick={() => actions?.onDialog?.({ kind: 'reopen', busy: false, problem: null })}>
            <RotateCcw size={14} aria-hidden /> {t('record.reopen')}
          </Button>
        ) : (
          <Button size="sm" heldReason={close ? t(close) : null} onClick={() => actions?.onDialog?.({ kind: 'close', busy: false, problem: null })}>
            <CheckCheck size={14} aria-hidden /> {t('record.close')}
          </Button>
        )}
        <Button size="sm" variant="primary" aria-keyshortcuts="f" heldReason={fHeld ? t(fHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'peopleNote', then: 'filings' })}>
          <FileSignature size={14} aria-hidden /> {t('record.filing')}
        </Button>
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('record.more') }}
          items={[
            { id: 'cancel', label: t('record.cancel'), icon: <Ban size={14} aria-hidden />, disabled: cancel !== null, description: cancel ? t(cancel) : t('record.cancelHint'), onSelect: () => actions?.onDialog?.({ kind: 'cancel', reason: '', busy: false, problem: null }) },
            ...(incident.machine ? [{ id: 'machine', label: t('record.machine', { asset: incident.machine.assetNumber }), href: `${model.prefix}/plant/machines/${encodeURIComponent(incident.machine.id)}`, target: '_blank' as const }] : []),
            ...(incident.maintenanceRequest ? [{ id: 'request', label: t('record.request'), href: `${model.prefix}/plant/requests?open=${encodeURIComponent(incident.maintenanceRequest.id)}` }] : []),
            { id: 'print', label: t('band.print'), description: t('band.printHint'), href: `${listHref}/print`, target: '_blank' as const },
            { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
          ]}
        />
      </span>
    )
  }

  return (
    <RecordFrame
      backHref={listHref}
      backLabel={t('record.back')}
      loaded={model.loaded}
      noun={t('record.noun')}
      title={title}
      meta={meta}
      actions={bandActions}
      status={<LiveLine asOf={model.asOf} live={model.live} />}
      tabs={tabs}
      tab={model.tab}
      permission="safety.incidents.view"
      onRetry={actions?.onRetry}
    >
      {model.notice && (
        <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={() => actions?.onDismissNotice?.()}>
          {model.notice.refused && model.notice.refused.length > 0 ? (
            <ul className="fw-inc-list">
              {model.notice.refused.map((entry, index) => (
                <li key={`${index}-${entry.label}`}>{t('notice.refusedRow', { label: entry.label, why: t(entry.key) })}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}
      {incident && incident.status === 'CANCELLED' && incident.cancelled && <Banner tone="info" title={t('record.cancelledAt', { at: when.at(incident.cancelled.at), by: incident.cancelled.by ?? t('record.someone') })}>{incident.cancelled.reason}</Banner>}
      {value && model.tab === 'report' && <ReportTab model={model} incident={value.incident} actions={actions} />}
      {value && model.tab === 'actions' && <ActionsTab model={model} incident={value.incident} actions={actions} onHelp={() => setKeysOpen(true)} />}
      {value && model.tab === 'authority' && <AuthorityTab model={model} incident={value.incident} actions={actions} />}
      {value && model.dialog && <RecordDialogs model={model} incident={value.incident} actions={actions} />}
      {keysOpen && <KeysModal keys={RECORD_KEYS(t)} withList={false} onClose={() => setKeysOpen(false)} />}
    </RecordFrame>
  )
}
