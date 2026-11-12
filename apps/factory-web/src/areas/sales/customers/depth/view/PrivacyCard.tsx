'use client'

import Link from 'next/link'
import { MoreHorizontal } from 'lucide-react'
import { Banner, Field, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { DateField, Modal, StepUpModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import type { StepUpModel } from '../../../../admin/shared/model'
import type { Privacy, PrivacyContact } from '../api'
import { BASES, basisProblems, copyCounts, keptKey, privacyHeld, valueOf, wordsProblem, type DepthCan, type PrivacyDialog, type Read } from '../model'
import { DepthCard, ReadOr, useSay } from './parts'

/**
 * Addresses & contacts › Contacts: consent, lawful basis and the personal-data actions (B-W2b-324; SAL-022; design
 * customer.contacts.grid#1 "Consent and lawful basis", #2 "Personal-data actions: access copy, erasure (keeps what law
 * requires)"): for every contact, why we may keep their details (GDPR art. 6) with its article, their consent (when and
 * how), an objection, an erasure; the acts in each row's ⋯ — record the lawful basis, record an objection, make an access
 * copy (art. 15: what we hold, counted kind by kind, downloaded as a file), erase (art. 17: the person's fields blanked for
 * good, the documents the law keeps kept and said; a fresh code; refused while a portal user still has the e-mail).
 * Personal data stays inside this record. Fetches nothing.
 */

export interface PrivacyModel {
  readonly read: Read<Privacy>
  readonly can: DepthCan
  readonly status: string
  readonly today: string
  readonly dialog: PrivacyDialog | null
  readonly stepUp: StepUpModel
  /** The record's Portal access tab (where a portal user's access ends). */
  readonly portalHref: string
}

export interface PrivacyActions {
  onOpen?: (kind: PrivacyDialog['kind'], contact: PrivacyContact) => void
  onDraft?: (dialog: PrivacyDialog) => void
  onConfirm?: () => void
  onClose?: () => void
  onRetry?: () => void
  onStepUpCode?: (code: string) => void
  onStepUpClose?: () => void
}

export function PrivacyCard({ model, actions }: { model: PrivacyModel; actions?: PrivacyActions }) {
  const { t, day } = useSay()
  const read = valueOf(model.read)
  const item = (contact: PrivacyContact, act: 'basis' | 'objection' | 'copy' | 'erase') => {
    const held = privacyHeld(contact, act, model.can, model.status)
    return { id: act, label: t(`privacy.act.${act}`), onSelect: () => actions?.onOpen?.(act, contact), disabled: held !== null, description: held ? t(held) : t(`privacy.act.${act}Hint`) }
  }
  return (
    <DepthCard title={t('privacy.title')} hint={t('privacy.hint')}>
      <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={t('privacy.title')} onRetry={actions?.onRetry}>
        {read ? (
          <div className="fw-cdp-stack">
            {read.notRecorded > 0 && <Banner tone="warning" title={t('privacy.notRecorded', { count: read.notRecorded })} />}
            {read.contacts.length === 0 ? (
              <p className="fw-cdp-hint">{t('privacy.none')}</p>
            ) : (
              <SummaryTable
                label={t('privacy.title')}
                stackOnPhone
                density="roomy"
                columns={[t('privacy.col.contact'), t('privacy.col.basis'), t('privacy.col.consent'), t('privacy.col.objection'), t('privacy.col.state'), '']}
                widths={['20%', '24%', '20%', '12%', '16%', '8%']}
                rows={read.contacts.map((contact) => ({
                  id: contact.id,
                  cells: [
                    contact.erased ? <span key="n" className="fw-cdp-hint">{t('privacy.erasedName')}</span> : <span key="n" className="fw-cdp-name">{contact.name}</span>,
                    contact.lawfulBasis ? (
                      <span key="b" className="fw-cdp-cell">
                        <span>{t(`basis.${contact.lawfulBasis}`)}</span>
                        <span className="fw-cdp-hint">{t(`basisArticle.${contact.lawfulBasis}`)}</span>
                      </span>
                    ) : (
                      <span key="b" className="fw-cdp-warn">
                        {t('privacy.basisMissing')}
                      </span>
                    ),
                    contact.consentAt ? (
                      <span key="c" className="fw-cdp-cell">
                        <span>{day(contact.consentAt)}</span>
                        <span className="fw-cdp-hint">{contact.consentSource ?? ''}</span>
                      </span>
                    ) : (
                      '—'
                    ),
                    contact.objectedAt ? <Tag key="o" tone="warning">{t('privacy.objectedOn', { date: day(contact.objectedAt) })}</Tag> : '—',
                    contact.erased ? (
                      <span key="s" className="fw-cdp-cell">
                        <Tag tone="neutral">{t('privacy.erased')}</Tag>
                        <span className="fw-cdp-hint">{contact.erasedAt ? t('privacy.erasedOn', { date: day(contact.erasedAt), by: contact.erasedBy ?? t('hold.system') }) : ''}</span>
                      </span>
                    ) : (
                      t(`contactStatus.${contact.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE'}`)
                    ),
                    <Menu
                      key="m"
                      align="right"
                      label={<MoreHorizontal size={16} aria-hidden />}
                      triggerProps={{ 'aria-label': t('privacy.menu', { name: contact.erased ? t('privacy.erasedName') : contact.name }) }}
                      items={[item(contact, 'basis'), item(contact, 'objection'), { id: 'sep', separator: true }, item(contact, 'copy'), item(contact, 'erase')]}
                    />,
                  ],
                }))}
              />
            )}
            <p className="fw-cdp-hint">{t('privacy.rule')}</p>
          </div>
        ) : null}
      </ReadOr>
      <PrivacyDialogView model={model} actions={actions} />
      <StepUpModal
        open={model.stepUp.open}
        title={t('erase.stepUpTitle')}
        sentence={t('erase.stepUp')}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t('erase.stepUpFailed') : null}
        onSubmit={(code) => actions?.onStepUpCode?.(code)}
        onClose={() => actions?.onStepUpClose?.()}
        confirmLabel={t('erase.stepUpConfirm')}
      />
    </DepthCard>
  )
}

/** The access copy as a file the office passes on (JSON, as the API made it). */
function download(raw: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function PrivacyDialogView({ model, actions }: { model: PrivacyModel; actions?: PrivacyActions | undefined }) {
  const { t, say, when } = useSay()
  const dialog = model.dialog
  if (!dialog) return null
  const name = dialog.contact.name
  const close = <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
  if (dialog.kind === 'basis') {
    const problems = dialog.tried ? basisProblems(dialog.draft, model.today) : {}
    const count = Object.keys(basisProblems(dialog.draft, model.today)).length
    const set = (next: Partial<typeof dialog.draft>) => actions?.onDraft?.({ ...dialog, draft: { ...dialog.draft, ...next } })
    return (
      <Modal
        open
        onClose={() => actions?.onClose?.()}
        title={t('basis.title', { name })}
        footer={
          <>
            {close}
            <Button variant="primary" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('dialog.saving') : dialog.tried && count > 0 ? t('dialog.fixFirst', { count }) : null}>
              {t('basis.confirm')}
            </Button>
          </>
        }
      >
        <div className="fw-cdp-stack">
          <Field label={t('basis.field')} required hint={dialog.draft.basis ? t(`basisWhy.${dialog.draft.basis}`) : t('basis.fieldHint')} error={problems.basis ? say(problems.basis) : undefined}>
            <Select value={dialog.draft.basis ?? ''} onChange={(event) => set({ basis: event.target.value === '' ? null : (event.target.value as (typeof BASES)[number]) })}>
              <option value="">{t('basis.pick')}</option>
              {BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {t(`basis.${basis}`)} — {t(`basisArticle.${basis}`)}
                </option>
              ))}
            </Select>
          </Field>
          {dialog.draft.basis === 'CONSENT' && (
            <div className="fw-cdp-two">
              <Field label={t('basis.consentDay')} required error={problems.consentDay ? say(problems.consentDay) : undefined}>
                <DateField value={dialog.draft.consentDay} max={model.today} onChange={(value) => set({ consentDay: value })} />
              </Field>
              <Field label={t('basis.consentSource')} required hint={t('basis.consentSourceHint')} error={problems.consentSource ? say(problems.consentSource) : undefined}>
                <Input value={dialog.draft.consentSource} onChange={(event) => set({ consentSource: event.target.value })} />
              </Field>
            </div>
          )}
          {dialog.failed ? <Banner tone="danger" title={t(dialog.failed)} /> : null}
        </div>
      </Modal>
    )
  }
  const problem = dialog.tried ? wordsProblem(dialog.words) : null
  const words = (label: string, hint: string) => (
    <Field label={label} required hint={hint} error={problem ? say(problem) : undefined}>
      <Textarea rows={3} value={dialog.words} onChange={(event) => actions?.onDraft?.({ ...dialog, words: event.target.value })} />
    </Field>
  )
  const failed = dialog.failed ? (
    <Banner tone="danger" title={t(dialog.failed)}>
      {dialog.portal ? (
        <Link className="fw-cdp-link" href={model.portalHref}>
          {t('privacy.openPortal')}
        </Link>
      ) : null}
    </Banner>
  ) : null
  if (dialog.kind === 'objection') {
    return (
      <Modal
        open
        onClose={() => actions?.onClose?.()}
        title={t('objection.title', { name })}
        footer={
          <>
            {close}
            <Button variant="primary" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('dialog.saving') : problem ? say(problem) : null}>
              {t('objection.confirm')}
            </Button>
          </>
        }
      >
        <div className="fw-cdp-stack">
          <p className="fw-cdp-hint">{t('objection.body')}</p>
          {words(t('objection.words'), t('objection.wordsHint'))}
          {failed}
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'copy') {
    const copy = dialog.copy
    return (
      <Modal
        open
        size="lg"
        onClose={() => actions?.onClose?.()}
        title={t('copy.title', { name })}
        footer={
          copy ? (
            <>
              <Button onClick={() => actions?.onClose?.()}>{t('dialog.close')}</Button>
              <Button variant="primary" onClick={() => download(copy.raw, t('copy.fileName', { date: copy.madeAt.slice(0, 10) }))}>
                {t('copy.download')}
              </Button>
            </>
          ) : (
            <>
              {close}
              <Button variant="primary" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('copy.making') : problem ? say(problem) : null}>
                {t('copy.confirm')}
              </Button>
            </>
          )
        }
      >
        {copy ? (
          <div className="fw-cdp-stack">
            <Banner tone="success" title={t('copy.made', { date: when(copy.madeAt) })} />
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                { label: t('copy.person'), value: copy.copy.person.name },
                { label: t('copy.email'), value: copy.copy.person.email ?? '—' },
                { label: t('copy.phone'), value: copy.copy.person.phone ?? '—' },
                { label: t('copy.basis'), value: copy.copy.processing.lawfulBasis ? t(`basis.${copy.copy.processing.lawfulBasis}`) : t('privacy.basisMissing') },
              ]}
            />
            <SummaryTable
              label={t('copy.held')}
              columns={[t('copy.col.what'), t('copy.col.count')]}
              align={['left', 'right']}
              rows={copyCounts(copy.copy).map((row) => ({ id: row.key, cells: [t(row.key), String(row.count)] }))}
            />
            {copy.copy.truncated && <Banner tone="info" title={t('copy.truncated')} />}
            <p className="fw-cdp-hint">{t('copy.passOn')}</p>
          </div>
        ) : (
          <div className="fw-cdp-stack">
            <p className="fw-cdp-hint">{t('copy.body')}</p>
            {words(t('copy.words'), t('copy.wordsHint'))}
            {failed}
          </div>
        )}
      </Modal>
    )
  }
  // erase
  const kept = dialog.kept
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('erase.title', { name: kept ? t('privacy.erasedName') : name })}
      footer={
        kept ? (
          <Button variant="primary" onClick={() => actions?.onClose?.()}>
            {t('dialog.close')}
          </Button>
        ) : (
          <>
            {close}
            <Button variant="danger" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('erase.erasing') : problem ? say(problem) : null}>
              {t('erase.confirm')}
            </Button>
          </>
        )
      }
    >
      {kept ? (
        <div className="fw-cdp-stack">
          <Banner tone="success" title={t('erase.done')} />
          {kept.length === 0 ? (
            <p className="fw-cdp-hint">{t('erase.keptNone')}</p>
          ) : (
            <ul className="fw-cdp-list">
              {kept.map((row) => (
                <li key={row.kind} className="fw-cdp-cell">
                  <span className="fw-cdp-name">{t(`${keptKey(row.kind)}.what`, { count: row.count })}</span>
                  <span className="fw-cdp-hint">{t(`${keptKey(row.kind)}.why`)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="fw-cdp-stack">
          <Banner tone="warning" title={t('erase.forGood')}>
            <p className="fw-cdp-hint">{t('erase.blanks')}</p>
          </Banner>
          <p className="fw-cdp-hint">{t('erase.keeps')}</p>
          {words(t('erase.words'), t('erase.wordsHint'))}
          <p className="fw-cdp-hint">{t('erase.code')}</p>
          {failed}
        </div>
      )}
    </Modal>
  )
}
