'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Checkbox, Pill } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../../lib/i18n/ds-parts'
import { RECEIVES, type Receives, type SupplierProfile } from '../api'
import { activeContacts, nobodyForPos, receivesHeld, routingWords, type DepthCan, type Read, type Words } from '../model'
import { DepthCard, ReadOr, useSay } from './parts'

export type CellMark = { readonly state: 'saving' | 'saved' | 'refused'; readonly words?: Words }

export interface ReceivesCardModel {
  readonly read: Read<SupplierProfile>
  readonly can: DepthCan
  /** Per `<contactId>:<kind>`: saving, saved, or refused with why. */
  readonly cells: Readonly<Record<string, CellMark>>
  /** A refusal of the last change (a 409: someone else changed the contact; read again). */
  readonly notice: Words | null
}

export interface ReceivesCardActions {
  onToggle?: (contactId: string, kind: Receives, on: boolean) => void
  onRetry?: () => void
}

/**
 * Contacts › what they receive (design rec:Supplier/contacts/contacts, the W2b routing): a Checkbox per contact and kind
 * of mail — purchase orders (the PO e-mail goes to these), claims, remittances, quality and document requests — saved
 * as it is ticked (the contact's whole list, at its version), and who gets each kind and why (ticked, by the contact's
 * role, or nobody). With nobody for POs: "POs cannot be e-mailed until one receives POs".
 */
export function ReceivesCard({ model, actions }: { model: ReceivesCardModel; actions?: ReceivesCardActions }) {
  const { t } = useSay()
  const title = t('receives.title')
  return (
    <DepthCard title={title} hint={t('receives.hint')}>
      <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={title} onRetry={actions?.onRetry}>
        {model.read.status === 'ready' ? <ReceivesBody profile={model.read.value} model={model} actions={actions} /> : null}
      </ReadOr>
    </DepthCard>
  )
}

function ReceivesBody({ profile, model, actions }: { profile: SupplierProfile; model: ReceivesCardModel; actions?: ReceivesCardActions | undefined }) {
  const { t, say } = useSay()
  const contacts = activeContacts(profile)
  const routes = routingWords(profile)
  return (
    <div className="fw-spd-stack">
      {model.notice ? <Banner tone="warning" title={say(model.notice)} /> : null}
      {contacts.length === 0 ? (
        <EmptyState title={t('receives.empty')} description={t('receives.emptyBody')} />
      ) : (
        <SummaryTable
          label={t('receives.title')}
          columns={[t('receives.contact'), ...RECEIVES.map((kind) => t(`receives.kind.${kind}`))]}
          stackOnPhone
          rows={contacts.map((contact) => ({
            id: contact.id,
            cells: [
              <span key="who" className="fw-spd-who">
                <span>{contact.name}</span>
                <span className="fw-spd-hint">{contact.email ?? t('receives.noEmail')}</span>
              </span>,
              ...RECEIVES.map((kind) => {
                const mark = model.cells[`${contact.id}:${kind}`]
                const held = receivesHeld(model.can, contact, kind, profile.partyStatus)
                const on = contact.receives.includes(kind)
                return (
                  <span key={kind} className="fw-spd-cell">
                    <Checkbox
                      aria-label={t('receives.box', { kind: t(`receives.kind.${kind}`), name: contact.name })}
                      checked={on}
                      disabled={held !== null || mark?.state === 'saving'}
                      title={held ? say(held) : undefined}
                      onChange={(event) => actions?.onToggle?.(contact.id, kind, event.target.checked)}
                    />
                    {mark?.state === 'saving' ? <CellSaveMark state="saving" /> : null}
                    {mark?.state === 'saved' ? <span className="fw-spd-saved">{t('receives.saved')}</span> : null}
                    {mark?.state === 'refused' ? <span className="fw-spd-error">{say(mark.words) || t('receives.refused')}</span> : null}
                  </span>
                )
              }),
            ],
          }))}
        />
      )}
      {nobodyForPos(profile) ? <Banner tone="warning" title={t('receives.nobodyPo')} /> : null}
      <ul className="fw-spd-routes" aria-label={t('receives.routes')}>
        {routes.map((route) => (
          <li key={route.kind}>
            <Pill tone={route.tone}>{t(`receives.kind.${route.kind}`)}</Pill> <span>{say(route.words)}</span>
          </li>
        ))}
      </ul>
      {!model.can.manage ? <p className="fw-spd-hint">{t('held.manage')}</p> : null}
    </div>
  )
}
