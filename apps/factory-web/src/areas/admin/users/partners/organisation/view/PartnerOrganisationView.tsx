'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { UserMinus } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { DateField } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../../lib/i18n/provider'
import type { StepUpModel } from '../../../../shared/model'
import { ConfirmBox } from '../../../../../sales/customers/portal/view/ConfirmBox'
import { heldWords, NoticeLine, PortalAccessMessages, PortalStepUp, usePortalT } from '../../../../../sales/customers/portal/view/parts'
import type { PortalNotice } from '../../../../../sales/customers/portal/model'
import type { PortalAccess } from '../../api'
import { accessEnded, addDays, adminsOf, dayOf, endsSoon, organisationHref, STATUS_TONE, type PartnerCan } from '../../model'

export interface PartnerOrganisationModel {
  /** `/w/<company>` */
  prefix: string
  userId: string
  /** The person's organisation's portal access (GET /partners/:partyId); null while read. */
  access: PortalAccess | null
  problem: string | null
  can: PartnerCan
  today: string
  now: string
  /** The end-date form's day ('' = none) as it starts (design cases). */
  until?: string
  confirm?: boolean
  busy: boolean
  dialogProblem: string | null
  notice: PortalNotice | null
  stepUp: StepUpModel
}

export interface PartnerOrganisationActions {
  onRetry?: () => void
  /** Resolves true when the end of access was saved ('' = no end). */
  onUntil?: (day: string) => Promise<boolean>
  onConfirm?: (open: boolean) => void
  /** "Remove from organisation": deactivate through the partner route. */
  onRemove?: (reason: string) => Promise<boolean>
  onStepUp?: (code: string) => void
  onStepUpClose?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-011 User › Partner organisation › Organisation (B-W2b-180; design admin.users rec:User/partner/org, PLT-006): which
 * customer or supplier the person belongs to (→ its Portal access tab), its admin, the person's user type (a fixed,
 * limited role template: partners see prices at most, never costs or margins), the end of access; change the end date,
 * remove them from the organisation (deactivate: sessions end, the invitation stops, the roles end). Fetches nothing.
 */
export function PartnerOrganisationView({ model, actions }: { model: PartnerOrganisationModel; actions?: PartnerOrganisationActions }) {
  return (
    <PortalAccessMessages>
      <Organisation model={model} actions={actions} />
    </PortalAccessMessages>
  )
}

function Organisation({ model, actions }: { model: PartnerOrganisationModel; actions?: PartnerOrganisationActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const person = model.access?.people.find((entry) => entry.id === model.userId) ?? null
  const start = model.until ?? (person?.accessUntil ? dayOf(person.accessUntil) : '')
  const [until, setUntil] = useState(start)
  useEffect(() => setUntil(start), [start, person?.version])
  if (model.problem && !model.access)
    return (
      <Card padded>
        <EmptyState
          title={t('org.failed')}
          description={t(model.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  if (!model.access)
    return (
      <Card padded aria-busy="true">
        <Skeleton height={24} width="40%" />
        <Skeleton height={120} />
      </Card>
    )
  const access = model.access
  if (!person) return <EmptyState title={t('org.notFound')} description={t('org.notFoundHint')} />
  const now = new Date(model.now)
  const admins = adminsOf(access.people, person.kind).filter((entry) => entry.id !== person.id)
  const left = person.status === 'DEACTIVATED'
  const manageHeld = !model.can.manage ? heldWords(t, 'right.manage') : left ? t('held.left') : null
  const changed = until !== start
  const untilProblem = until !== '' && until <= model.today && changed ? t('invite.untilFuture') : person.kind === 'GUEST' && until === '' ? t('invite.guestNeedsEnd') : null
  // An invited person is removed by revoking the invitation (partners.invite); anyone else by deactivating (partners.manage).
  const removeHeld = left ? t('held.left') : person.status === 'INVITED' ? heldWords(t, model.can.invite ? null : 'right.invite') : manageHeld
  return (
    <div className="fw-pa">
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <Card padded>
        <div className="fw-pa-head">
          <div className="fw-pa-head-text">
            <h2 className="fw-pa-h2">{t('org.title')}</h2>
            <p className="fw-pa-hint">{t('org.intro')}</p>
          </div>
          <Tag tone={STATUS_TONE[person.status] === 'success' ? 'success' : STATUS_TONE[person.status] === 'warning' ? 'warning' : 'neutral'}>{t(`status.${person.status}`)}</Tag>
        </div>
        <KeyValue
          columns={3}
          labelCase="sentence"
          items={[
            { label: t('org.organisation'), value: <Link href={organisationHref(model.prefix, access)}>{access.party.name}</Link>, hint: `${access.party.code}${person.kind ? ` · ${t(`kind.${person.kind}`)}` : ''}` },
            { label: t('org.admin'), value: admins.length > 0 ? admins.map((entry) => entry.displayName).join(', ') : t('org.noAdmin'), ...(admins.length === 0 ? { hint: t('org.noAdminHint') } : {}) },
            {
              label: t('org.userType'),
              value: person.roleKey ? t(`role.${person.roleKey}`) : person.status === 'INVITED' ? t('partners.roleOnAccept') : t('people.noRole'),
              hint: person.roleKey ? `${t(`roleLine.${person.roleKey}`)} ${t(person.seesPrices ? 'invite.seesPrices' : 'invite.noPrices')}` : undefined,
            },
            { label: t('org.also'), value: person.capabilities.length > 0 ? person.capabilities.map((capability) => t(`capability.${capability}`)).join(', ') : t('org.alsoNone') },
            {
              label: t('org.until'),
              value: person.accessUntil ? (
                <span className="fw-pa-cell">
                  {formatDate(person.accessUntil, { locale })}
                  {accessEnded(person.accessUntil, now) ? <Tag tone="danger">{t('people.ended')}</Tag> : endsSoon(person.accessUntil, now) && !left ? <Tag tone="warning">{t('people.endsSoon')}</Tag> : null}
                </span>
              ) : (
                t('people.noEnd')
              ),
            },
            { label: t('org.lastSignIn'), value: person.lastSignInAt ? formatDateTime(person.lastSignInAt, { locale }) : t('people.never'), ...(person.invitation ? { hint: t('people.invitationEnds', { date: formatDate(person.invitation.expiresAt, { locale }) }) } : {}) },
          ]}
        />
        <p className="fw-pa-hint">{t('org.pricesAtMost')}</p>
      </Card>
      <Card padded>
        <div className="fw-pa-head">
          <div className="fw-pa-head-text">
            <h2 className="fw-pa-h2">{t('org.changeTitle')}</h2>
            <p className="fw-pa-hint">{t(person.status === 'INVITED' ? 'org.changeInvited' : 'org.changeHint')}</p>
          </div>
        </div>
        {manageHeld && <Banner tone="info" title={manageHeld} />}
        <div className="fw-pa-row">
          <Field label={t('invite.until')} hint={person.kind === 'GUEST' ? t('invite.untilGuest') : t('person.untilHint')} error={untilProblem ?? undefined}>
            <DateField value={until} onChange={setUntil} locale={INTL_LOCALE[locale]} min={addDays(model.today, 1)} clearable={person.kind !== 'GUEST'} clearLabel={t('invite.untilClear')} ariaLabel={t('invite.until')} disabled={manageHeld !== null} />
          </Field>
          <Button size="sm" variant="primary" heldReason={manageHeld ?? (model.busy ? t('common.saving') : !changed ? t('person.nothing') : untilProblem)} onClick={() => void actions?.onUntil?.(until)}>
            {t('org.saveUntil')}
          </Button>
          <Button size="sm" variant="danger-outline" heldReason={removeHeld} onClick={() => actions?.onConfirm?.(true)}>
            <UserMinus size={14} aria-hidden /> {t('org.remove')}
          </Button>
        </div>
      </Card>
      <ConfirmBox
        open={!!model.confirm}
        title={t('org.removeTitle', { name: person.displayName, organisation: access.party.name })}
        lines={[t(person.status === 'INVITED' ? 'confirm.revoke.body' : 'org.removeBody'), person.displayName]}
        confirmLabel={t('org.remove')}
        reason
        busy={model.busy}
        problem={model.dialogProblem}
        onClose={() => actions?.onConfirm?.(false)}
        onConfirm={(reason) => void actions?.onRemove?.(reason)}
      />
      <PortalStepUp model={model.stepUp} onSubmit={actions?.onStepUp} onClose={actions?.onStepUpClose} />
    </div>
  )
}
