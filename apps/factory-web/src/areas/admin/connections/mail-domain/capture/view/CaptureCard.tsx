'use client'

import Link from 'next/link'
import { Forward, MailPlus, Power, RefreshCw } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { CopyField } from '../../../view/parts'
import type { Capture } from '../api'
import { changeHeld, makeHeld, type CaptureCardModel, type CaptureConfirm } from '../model'
import '../capture.css'

export type { CaptureCardModel } from '../model'

/** What the card asks of its container (use-capture-admin.ts). Absent in the design index: the card still draws. */
export interface CaptureCardActions {
  onMake?: () => void
  onConfirm?: (confirm: CaptureConfirm | null) => void
  onReplace?: () => void
  onTurnOff?: () => void
  onDefault?: (inboxId: string | null) => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

const TO_SORT = '__to_sort__'

/**
 * SCR-439 — Admin › Connections › Your mail domain › Capture address (design admin.connections sec:mail-domain "Capture
 * address (W2b): forward or BCC any mail to it"; COL-021; B-W2b-397): the company's address with Copy, when it was made,
 * where mail it cannot place lands (a team inbox, or Mail to sort), Replace (a leaked address: the old one stops in the same
 * step) and Turn off — each behind a confirm that says what happens. Without the company's mail domain the address cannot
 * be made, and says so. `#capture` lands here. Fetches nothing.
 */
export function CaptureCard({ model, actions }: { model: CaptureCardModel; actions?: CaptureCardActions }) {
  return (
    <WithMessages namespaces={['mail-depth', 'admin-connections']}>
      <Inner model={model} actions={actions} />
    </WithMessages>
  )
}

function Inner({ model, actions }: { model: CaptureCardModel; actions?: CaptureCardActions }) {
  const t = useT('mail-depth')
  const read = model.read
  return (
    <div id="capture" className="fw-capa">
      <Card header={t('captureAdmin.title')} headingLevel={3} padded>
        <div className="fw-capa-stack">
          <p className="fw-capa-intro">{t('captureAdmin.intro')}</p>
          {model.notice && (
            <Banner
              tone={model.notice.tone}
              title={t(model.notice.key)}
              action={
                actions?.onDismissNotice ? (
                  <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                    {t('inbox.dismiss')}
                  </Button>
                ) : undefined
              }
            />
          )}
          {read.status === 'loading' ? (
            <div aria-busy="true">
              <p className="fw-capa-hint" role="status">
                <Spinner size={14} /> {t('captureAdmin.reading')}
              </p>
              <Skeleton height={20} />
            </div>
          ) : read.status === 'error' ? (
            <EmptyState title={t('captureAdmin.failed')} description={t(read.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('inbox.retry')}</Button>} />
          ) : !read.data.capture ? (
            <EmptyState
              icon={<Forward size={22} aria-hidden />}
              title={t(read.data.receivingDomain === null ? 'captureAdmin.noDomain.title' : 'captureAdmin.none.title')}
              description={t(read.data.receivingDomain === null ? 'captureAdmin.noDomain.body' : 'captureAdmin.none.body')}
              action={
                <Button variant="primary" heldReason={makeHeld(read.data, model.busy) ? t(makeHeld(read.data, model.busy)!) : null} onClick={() => actions?.onMake?.()}>
                  <MailPlus size={14} aria-hidden /> {t('captureAdmin.make')}
                </Button>
              }
            />
          ) : (
            <Live model={model} actions={actions} capture={read.data.capture} mayManage={read.data.mayManage} />
          )}
          <p className="fw-capa-hint">
            <Link href={`${model.prefix}/home/mail-to-sort`}>{t('captureAdmin.toMail')}</Link>
          </p>
        </div>
      </Card>
      {model.confirm && read.status === 'ready' && read.data.capture && <ConfirmDialog kind={model.confirm} busy={model.busy} actions={actions} />}
    </div>
  )
}

function Live({ model, actions, capture, mayManage }: { model: CaptureCardModel; actions?: CaptureCardActions; capture: Capture; mayManage: boolean }) {
  const t = useT('mail-depth')
  const locale = useLocale()
  const held = changeHeld({ capture, receivingDomain: null, mayManage }, model.busy)
  const heldText = held ? t(held) : null
  const inboxes = model.inboxes ?? (capture.defaultTeamInbox ? [{ id: capture.defaultTeamInbox.id, name: capture.defaultTeamInbox.name }] : [])
  return (
    <>
      {capture.address ? <CopyField value={capture.address} label={t('captureAdmin.title')} /> : <p className="fw-capa-hint">{t('captureAdmin.noAddress')}</p>}
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('captureAdmin.made'), value: formatDateTime(capture.createdAt, { locale }) },
          { label: t('captureAdmin.lands'), value: capture.defaultTeamInbox ? capture.defaultTeamInbox.name : t('captureAdmin.landsToSort') },
        ]}
      />
      <Field label={t('captureAdmin.defaultLabel')} hint={heldText ?? t('captureAdmin.defaultHint')}>
        <Select value={capture.defaultTeamInbox?.id ?? TO_SORT} disabled={held !== null} onChange={(event) => actions?.onDefault?.(event.target.value === TO_SORT ? null : event.target.value)}>
          <option value={TO_SORT}>{t('captureAdmin.landsToSort')}</option>
          {inboxes.map((inbox) => (
            <option key={inbox.id} value={inbox.id}>
              {inbox.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="fw-capa-actions">
        <Button size="sm" heldReason={heldText} onClick={() => actions?.onConfirm?.('replace')}>
          <RefreshCw size={14} aria-hidden /> {t('captureAdmin.replace')}
        </Button>
        <Button size="sm" variant="danger-outline" heldReason={heldText} onClick={() => actions?.onConfirm?.('turnOff')}>
          <Power size={14} aria-hidden /> {t('captureAdmin.turnOff')}
        </Button>
      </div>
    </>
  )
}

function ConfirmDialog({ kind, busy, actions }: { kind: CaptureConfirm; busy: boolean; actions?: CaptureCardActions }) {
  const t = useT('mail-depth')
  const close = () => actions?.onConfirm?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t(`captureAdmin.confirm.${kind}.title`)}
      footer={
        <>
          <Button onClick={close}>{t('dialog.cancel')}</Button>
          <Button variant={kind === 'turnOff' ? 'danger' : 'primary'} heldReason={busy ? t('captureAdmin.held.busy') : null} onClick={() => (kind === 'replace' ? actions?.onReplace?.() : actions?.onTurnOff?.())}>
            {t(`captureAdmin.confirm.${kind}.go`)}
          </Button>
        </>
      }
    >
      <p className="fw-capa-intro">{t(`captureAdmin.confirm.${kind}.body`)}</p>
    </Modal>
  )
}
