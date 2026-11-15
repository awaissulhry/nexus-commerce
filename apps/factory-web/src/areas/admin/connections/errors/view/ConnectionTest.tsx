'use client'

import { Plug, Activity } from 'lucide-react'
import { Banner, KeyValue } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { TestAnswer } from '../api'
import { testHeldKey, testWords } from '../model'
import { ErrorQueueMessages } from './ErrorQueueSection'

export interface ConnectionTestModel {
  account: { id: string; status: 'ACTIVE' | 'PAUSED' | 'DISABLED'; mode: 'LIVE' | 'SANDBOX' | 'FAKE'; provider: string }
  /** integrations.manage. */
  canManage: boolean
  /** The answer panel is open. */
  open: boolean
  running: 'test' | 'reconnect' | null
  answer: TestAnswer | null
  /** A refusal of the request itself (a key of `admin`). */
  problem: string | null
}

export interface ConnectionTestActions {
  onTest?: () => void
  onReconnect?: () => void
  onClose?: () => void
}

/**
 * A connection's Test and Reconnect (B-W2b-415; PLT-196; design admin.connections pop:test; SCR-602): Test makes one harmless
 * call through the gateway and opens the answer in words (a small dialog: Esc or Close — the DS toggletip's trigger is an inline
 * icon, not a button); Reconnect first closes the account's circuit (forgets its failures in a row), then tests. Held in words
 * where it cannot run (no right, disabled, paused for Reconnect, a live service without a harmless test call yet). `place`:
 * the record's header (both buttons and the answer) or the Overview's "Test the connection" card (Test only). Fetches nothing
 * (use-connection-test.ts).
 */
export function ConnectionTest({ model, actions, place = 'header' }: { model: ConnectionTestModel; actions?: ConnectionTestActions; place?: 'header' | 'card' }) {
  return (
    <ErrorQueueMessages>
      <Test model={model} actions={actions} place={place} />
    </ErrorQueueMessages>
  )
}

function Test({ model, actions, place }: { model: ConnectionTestModel; actions?: ConnectionTestActions; place: 'header' | 'card' }) {
  const t = useT('admin-integration-health')
  const running = model.running ? 'aih.test.held.running' : null
  const testHeld = running ?? testHeldKey(model.account, false, model.canManage)
  const reconnectHeld = running ?? testHeldKey(model.account, true, model.canManage)
  const test = (
    <Button size="sm" heldReason={testHeld ? t(testHeld) : null} onClick={() => actions?.onTest?.()}>
      <Activity size={13} aria-hidden /> {t('aih.test.action')}
    </Button>
  )
  if (place === 'card') return test
  return (
    <span className="fw-aih-test">
      {test}
      <Button size="sm" heldReason={reconnectHeld ? t(reconnectHeld) : null} onClick={() => actions?.onReconnect?.()}>
        <Plug size={13} aria-hidden /> {t('aih.reconnect.action')}
      </Button>
      <Modal open={model.open} onClose={() => actions?.onClose?.()} title={t('aih.test.title')} size="sm">
        <TestPanel model={model} onClose={() => actions?.onClose?.()} />
      </Modal>
    </span>
  )
}

/** The answer in words. */
function TestPanel({ model, onClose }: { model: Pick<ConnectionTestModel, 'running' | 'answer' | 'problem'>; onClose?: () => void }) {
  const t = useT('admin-integration-health')
  const ta = useT('admin')
  const locale = useLocale()
  const answer = model.answer
  return (
    <div className="fw-aih-panel">
      {model.running ? (
        <p className="fw-adm-loading" role="status">
          <Spinner size={14} /> {t(model.running === 'reconnect' ? 'aih.reconnect.running' : 'aih.test.running')}
        </p>
      ) : model.problem ? (
        <Banner tone="danger" title={ta(model.problem)} />
      ) : answer ? (
        <>
          <Banner tone={testWords(answer).tone} title={t(testWords(answer).key, testWords(answer).params)} />
          <KeyValue
            columns={1}
            labelCase="sentence"
            items={[
              { label: t('aih.test.at'), value: formatDateTime(answer.testedAt, { locale }) },
              ...(answer.reconnected ? [{ label: t('aih.test.circuit'), value: answer.circuitBefore && (answer.circuitBefore.failures > 0 || answer.circuitBefore.openUntil) ? t('aih.test.circuitClosed', { count: answer.circuitBefore.failures }) : t('aih.test.circuitWasClosed') }] : []),
              ...(answer.message ? [{ label: t('aih.test.theirWords'), value: <q className="fw-aih-quote">{answer.message}</q> }] : []),
              { label: t('aih.test.ledger'), value: t('aih.test.ledgerHint') },
            ]}
          />
        </>
      ) : (
        <p className="fw-adm-hint">{t('aih.test.what')}</p>
      )}
      <div className="fw-aih-actions">
        <Button size="sm" onClick={onClose}>
          {t('aih.test.close')}
        </Button>
      </div>
    </div>
  )
}
