'use client'

import { Copy, UserPlus } from 'lucide-react'
import { Banner, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../i18n'
import type { OfficeShare } from '../api'
import { inviteHeld, SHARES_NS, shareActionHeld, stateTone, type SharesPanelActions, type SharesPanelModel } from '../model'
import { InviteDialog } from './InviteDialog'
import '../shares.css'

export type { SharesPanelModel, SharesPanelActions } from '../model'

/**
 * The record panels' Partners tab (B-W2b-200; COL-061, COL-062; design shell.panels "the record's followers and external
 * participants"; "Share with a partner"): who outside is invited to this record — the contact or address, what they may do
 * (read · write · upload), until when, whether it still lives, who invited them and when they last opened it — with Change
 * (what they may do now) and Revoke (the invitation and its link stop together). "Share with a partner" opens the invitation
 * (held with its reason: no right, a record shared by every company, a record without a partner). A link invited without
 * mail is shown ONCE with Copy. No money here. One view model, nothing fetched (use-shares.ts loads it).
 */
export function SharesPanel({ model, actions, title }: { model: SharesPanelModel; actions?: SharesPanelActions; title: string }) {
  return (
    <WithMessages namespaces={[SHARES_NS]}>
      <Panel model={model} actions={actions} title={title} />
    </WithMessages>
  )
}

function Panel({ model, actions, title }: { model: SharesPanelModel; actions?: SharesPanelActions; title: string }) {
  const t = useT(SHARES_NS)
  const held = inviteHeld(model)
  const party = model.read.status === 'ready' ? model.read.data.party : null
  return (
    <div className="fw-rsh">
      <div className="fw-rsh-head">
        <p className="fw-rsh-muted">{party ? t('intro', { partner: party.name }) : t('introNoParty')}</p>
        <Button size="sm" variant="secondary" heldReason={held ? t(held) : null} aria-haspopup="dialog" onClick={() => actions?.onInvite?.(true)}>
          <UserPlus size={14} aria-hidden /> {t('invite.open')}
        </Button>
      </div>
      {model.link && (
        <Banner
          tone="info"
          title={t('link.title', { email: model.link.email })}
          action={
            <span className="fw-rsh-actions">
              <Button size="sm" onClick={() => actions?.onCopyLink?.()}>
                <Copy size={14} aria-hidden /> {t('link.copy')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissLink?.()}>
                {t('link.dismiss')}
              </Button>
            </span>
          }
        >
          <span className="fw-rsh-url">{model.link.url}</span>
          <span className="fw-rsh-muted">{t('link.once')}</span>
        </Banner>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('dismiss')}
            </Button>
          }
        />
      )}
      {model.read.status === 'loading' ? (
        <p className="fw-rsh-muted" role="status">
          <Spinner size={14} /> {t('loading')}
        </p>
      ) : model.read.status === 'failed' ? (
        <Banner
          tone="danger"
          title={t(model.read.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('retry')}
            </Button>
          }
        />
      ) : model.read.data.shares.length === 0 ? (
        <EmptyState icon={<UserPlus size={22} aria-hidden />} title={t('empty.title')} description={model.read.data.held ? t(`held.${model.read.data.held}`) : t('empty.body')} />
      ) : (
        <ul className="fw-rsh-list" aria-label={t('listLabel', { title })}>
          {model.read.data.shares.map((share) => (
            <ShareRow key={share.id} share={share} model={model} actions={actions} />
          ))}
        </ul>
      )}
      {model.invite && <InviteDialog model={model} actions={actions} />}
      {model.change && <ChangeDialog model={model} actions={actions} />}
      {model.revoke && <RevokeDialog model={model} actions={actions} />}
    </div>
  )
}

function ShareRow({ share, model, actions }: { share: OfficeShare; model: SharesPanelModel; actions?: SharesPanelActions }) {
  const t = useT(SHARES_NS)
  const locale = useLocale()
  const at = (value: string) => formatDateTime(value, { locale, timeZone: model.timeZone })
  const day = (value: string) => formatDate(value, { locale, timeZone: model.timeZone })
  const held = shareActionHeld(share, model.can.manage, model.busy)
  const who = share.contact?.name ? `${share.contact.name} · ${share.email}` : share.email
  return (
    <li className="fw-rsh-item">
      <div className="fw-rsh-item-head">
        <strong className="fw-rsh-who">{who}</strong>
        <Tag tone={stateTone(share.state)}>{t(`state.${share.state}`)}</Tag>
        <span className="fw-rsh-spacer" />
        {share.state === 'LIVE' && (
          <span className="fw-rsh-actions">
            <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} aria-haspopup="dialog" onClick={() => actions?.onChange?.(share.id)}>
              {t('change.open')}
            </Button>
            <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} aria-haspopup="dialog" onClick={() => actions?.onRevoke?.(share.id)}>
              {t('revoke.open')}
            </Button>
          </span>
        )}
      </div>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('row.may'), value: share.permissions.map((permission) => t(`may.${permission}`)).join(' · ') },
          { label: share.state === 'EXPIRED' ? t('row.ended') : t('row.until'), value: day(share.expiresAt) },
          { label: t('row.invited'), value: share.invitedBy ? t('row.invitedBy', { name: share.invitedBy, at: at(share.invitedAt) }) : at(share.invitedAt) },
          { label: t('row.opened'), value: share.lastOpenedAt ? at(share.lastOpenedAt) : t('row.notOpened') },
          { label: t('row.mail'), value: share.notifyByEmail ? t('row.mailOn') : t('row.mailOff') },
          ...(share.revoked ? [{ label: t('row.revoked'), value: t('row.revokedBy', { name: share.revoked.byName ?? t('row.someone'), at: at(share.revoked.at) }) }] : []),
        ]}
      />
    </li>
  )
}

function ChangeDialog({ model, actions }: { model: SharesPanelModel; actions?: SharesPanelActions }) {
  const t = useT(SHARES_NS)
  const change = model.change!
  const share = model.read.status === 'ready' ? model.read.data.shares.find((item) => item.id === change.shareId) : undefined
  return (
    <Modal
      open
      onClose={() => actions?.onChange?.(null)}
      title={t('change.title')}
      subtitle={share?.email}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onChange?.(null)}>{t('change.cancel')}</Button>
          <Button variant="primary" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onChangeSave?.()}>
            {t('change.save')}
          </Button>
        </>
      }
    >
      <div className="fw-rsh-dialog">
        {change.problem && <Banner tone="danger" title={t(change.problem)} />}
        <fieldset className="fw-rsh-fieldset">
          <legend className="fw-rsh-legend">{t('invite.may')}</legend>
          <Checkbox label={t('may.VIEW')} checked disabled aria-describedby="fw-rsh-view-always" />
          <p id="fw-rsh-view-always" className="fw-rsh-muted">
            {t('invite.viewAlways')}
          </p>
          <Checkbox label={t('may.COMMENT')} checked={change.comment} onChange={(event) => actions?.onChangeDraft?.({ comment: event.currentTarget.checked })} />
          <Checkbox label={t('may.UPLOAD')} checked={change.upload} onChange={(event) => actions?.onChangeDraft?.({ upload: event.currentTarget.checked })} />
        </fieldset>
        <p className="fw-rsh-muted">{t('change.body')}</p>
      </div>
    </Modal>
  )
}

function RevokeDialog({ model, actions }: { model: SharesPanelModel; actions?: SharesPanelActions }) {
  const t = useT(SHARES_NS)
  const revoke = model.revoke!
  const share = model.read.status === 'ready' ? model.read.data.shares.find((item) => item.id === revoke.shareId) : undefined
  return (
    <Modal
      open
      onClose={() => actions?.onRevoke?.(null)}
      title={t('revoke.title')}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onRevoke?.(null)}>{t('revoke.keep')}</Button>
          <Button variant="danger" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onRevokeConfirm?.()}>
            {t('revoke.go')}
          </Button>
        </>
      }
    >
      <div className="fw-rsh-dialog">
        <p className="fw-rsh-muted">{t('revoke.body', { email: share?.email ?? '' })}</p>
        {revoke.problem && <Banner tone="danger" title={t(revoke.problem)} />}
      </div>
    </Modal>
  )
}

