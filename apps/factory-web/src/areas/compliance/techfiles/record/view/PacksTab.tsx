'use client'

import { Copy, Eye, FileDown, Link2Off, PackagePlus, Send, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, SegmentedControl } from '@nexus/ui/primitives'
import { PACK_LINK_DAYS_MAX } from '@nexus/factory-domain/compliance/techfiles/rules'
import { Combobox, DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Pack } from '../../api'
import { addDays, buildHeld, LINK_PASSWORD_MIN, linkLive, PACK_TONE, packsInOrder, reasonProblem, removePackHeld, shareHeld, shareProblems, shortHash, valueOf } from '../../model'
import { PackProgress } from '../../view/PackDialog'
import { languageName, NoticeBanner, SectionFailed, SectionHead, SectionLoading, StatePill, useDay, useWhen, useWords } from '../../view/parts'
import type { RecordActions, RecordModel, ShareState, WithdrawState } from '../view-model'

/**
 * Technical file › Evidence pack (design rec tab "pack", sec tf-packs; PRD-299): every pack built from this file — when, the
 * scope, the language, for whom, the documents and the fingerprint, how long it is kept — with its PDF (a new tab), its ZIP,
 * what the authority sees on the link (a new tab), Send by link (a fresh code) and each link's end, opens and downloads with
 * Withdraw. A pack being built shows JobProgress; a failed one says why and can be removed.
 */
export function PacksTab({ model, actions }: { model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const held = buildHeld(model.can, model.online)
  const head = (
    <SectionHead id="fw-tf-packs" title={t('packs.title')} note={t('packs.note')}>
      <Button size="sm" variant="primary" aria-keyshortcuts="p" heldReason={held ? t(held) : null} onClick={() => actions?.onPack?.()}>
        <PackagePlus size={13} aria-hidden /> {t('packs.build')}
      </Button>
    </SectionHead>
  )
  if (model.packs === null || model.packs.status === 'loading')
    return (
      <div className="fw-tf-tab">
        {head}
        <SectionLoading rows={3} height={60} />
      </div>
    )
  if (model.packs.status === 'error')
    return (
      <div className="fw-tf-tab">
        {head}
        <SectionFailed title={t('packs.failed')} problem={model.packs.problem} onRetry={() => actions?.onRetry?.('packs')} />
      </div>
    )
  const packs = packsInOrder(model.packs.value.packs)
  return (
    <div className="fw-tf-tab">
      {head}
      <p className="fw-tf-never">{t('pack.never')}</p>
      {packs.length === 0 ? (
        <Card padded>
          <EmptyState
            icon={<PackagePlus size={22} aria-hidden />}
            title={t('packs.emptyTitle')}
            description={t('packs.empty')}
            action={
              held ? undefined : (
                <Button size="sm" variant="primary" onClick={() => actions?.onPack?.()}>
                  {t('packs.build')}
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <ul className="fw-tf-packs" aria-label={t('packs.title')}>
          {packs.map((pack) => (
            <PackCard key={pack.id} pack={pack} model={model} actions={actions} />
          ))}
        </ul>
      )}
    </div>
  )
}

function PackCard({ pack, model, actions }: { pack: Pack; model: RecordModel; actions?: RecordActions | undefined }) {
  const t = useWords()
  const day = useDay()
  const when = useWhen()
  const locale = useLocale()
  const share = shareHeld(pack, model.can, model.online)
  const remove = removePackHeld(pack, model.online)
  const now = new Date(model.asOf ?? Date.now())
  const scope =
    pack.scope.kind === 'BATCHES'
      ? t('packScope.BATCHES', { list: (pack.scope.batchNumbers ?? []).join(', ') })
      : pack.scope.kind === 'SERIALS'
        ? t('packScope.SERIALS', { from: pack.scope.serialFrom ?? '—', to: pack.scope.serialTo ?? '—' })
        : t(`packScope.${pack.scope.kind}`)
  return (
    <li>
      <Card padded>
        <div className="fw-tf-pack">
          <div className="fw-tf-pack-head">
            <span className="fw-tf-row">
              <span className="fw-tf-code">{pack.number}</span>
              <StatePill group="packStatus" state={pack.status} tone={PACK_TONE[pack.status]} />
              <Pill tone="neutral">{t(`purpose.${pack.purpose}`)}</Pill>
              <span className="fw-tf-muted">{pack.builtAt ? t('packs.builtOn', { date: when(pack.builtAt), name: pack.builtBy?.name ?? '—' }) : t('packs.askedOn', { date: when(pack.createdAt) })}</span>
            </span>
            <span className="fw-tf-row">
              {pack.status === 'BUILT' && (
                <>
                  <Button size="sm" onClick={() => actions?.onOpenPdf?.(pack.id)} heldReason={pack.pdf ? null : t('held.notBuilt')}>
                    <FileDown size={13} aria-hidden /> {t('packs.pdf')}
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => actions?.onAuthority?.(pack.id)}>
                    <Eye size={13} aria-hidden /> {t('packs.preview')}
                  </Button>
                  <Button size="sm" variant="primary" heldReason={share ? t(share) : null} onClick={() => actions?.onShare?.(pack.id)}>
                    <Send size={13} aria-hidden /> {t('packs.share')}
                  </Button>
                </>
              )}
              {pack.status !== 'BUILT' && (
                <Button size="sm" variant="quiet" heldReason={remove ? t(remove) : null} onClick={() => actions?.onRemovePack?.(pack.id)}>
                  <Trash2 size={13} aria-hidden /> {t('packs.remove')}
                </Button>
              )}
            </span>
          </div>
          <dl className="fw-tf-facts">
            <div>
              <dt>{t('packs.scope')}</dt>
              <dd>{scope}</dd>
            </div>
            <div>
              <dt>{t('packs.language')}</dt>
              <dd>{languageName(pack.language, locale)}</dd>
            </div>
            <div>
              <dt>{t('packs.recipient')}</dt>
              <dd>{pack.recipientParty ? `${pack.recipient} · ${pack.recipientParty.name}` : pack.recipient}</dd>
            </div>
            <div>
              <dt>{t('packs.documents')}</dt>
              <dd>{pack.documents === null ? '—' : t('packs.documentsCount', { count: pack.documents })}</dd>
            </div>
            <div>
              <dt>{t('packs.fingerprint')}</dt>
              <dd className="fw-tf-hash" title={pack.fingerprint ?? undefined}>
                {shortHash(pack.fingerprint)}
              </dd>
            </div>
            <div>
              <dt>{t('packs.kept')}</dt>
              <dd>{pack.retainUntil ? day(pack.retainUntil) : '—'}</dd>
            </div>
          </dl>
          <PackProgress pack={pack} />
          {pack.status === 'FAILED' && (
            <Banner tone="danger" title={t('pack.failed')}>
              {pack.failureReason ? <p className="fw-tf-muted">{pack.failureReason}</p> : null}
            </Banner>
          )}
          {pack.links.length > 0 && (
            <SummaryTable
              label={t('packs.links', { number: pack.number })}
              density="roomy"
              stackOnPhone
              columns={[t('packs.col.sentTo'), t('packs.col.expires'), t('packs.col.state'), t('packs.col.views'), '']}
              rows={pack.links.map((link) => {
                const live = linkLive(link, now)
                return {
                  id: link.id,
                  cells: [
                    link.email ?? pack.recipientParty?.name ?? '—',
                    day(link.expiresAt),
                    <Pill key="state" tone={live ? 'success' : 'neutral'} dot>
                      {link.revokedAt ? t('linkState.REVOKED') : live ? t('linkState.LIVE') : t('linkState.ENDED')}
                    </Pill>,
                    t('packs.views', { opens: link.opens, downloads: link.downloads }),
                    live ? (
                      <Button key="withdraw" size="sm" variant="quiet" heldReason={!model.can.share || !pack.may.share ? t('held.share') : !model.online ? t('held.offline') : null} onClick={() => actions?.onWithdraw?.(pack.id, link.id)}>
                        <Link2Off size={13} aria-hidden /> {t('packs.withdraw')}
                      </Button>
                    ) : (
                      <span key="ended" className="fw-tf-muted">
                        {link.revokedAt ? t('packs.withdrawnOn', { date: day(link.revokedAt) }) : '—'}
                      </span>
                    ),
                  ],
                }
              })}
            />
          )}
          {pack.note && <p className="fw-tf-muted">{t('packs.noteLine', { note: pack.note })}</p>}
        </div>
      </Card>
    </li>
  )
}

/** Send by link (a fresh code): to whom, the password (said to them another way), the last day, e-mail or the address once. */
export function ShareDialog({ model, state, actions }: { model: RecordModel; state: ShareState; actions?: RecordActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const pack = valueOf(model.packs)?.packs.find((entry) => entry.id === state.packId) ?? null
  const close = () => actions?.onShare?.(null)
  const { draft } = state
  const set = (patch: Partial<typeof draft>) => actions?.onShareDraft?.({ ...draft, ...patch })
  const problems = shareProblems(draft, model.today)
  const parties = valueOf(state.parties)
  if (state.done) {
    return (
      <Modal
        open
        onClose={close}
        title={t('share.doneTitle', { number: pack?.number ?? '' })}
        size="md"
        footer={
          <Button variant="primary" onClick={close}>
            {t('common.close')}
          </Button>
        }
      >
        <div className="fw-tf-form">
          <Banner tone={state.done.delivery === 'FAILED' ? 'warning' : 'success'} title={t(state.done.delivery ? `share.delivery.${state.done.delivery}` : 'share.made')} />
          {state.done.url && (
            <Field label={t('share.url')} hint={t('share.urlOnce')}>
              <span className="fw-tf-row">
                <Input size="sm" readOnly value={state.done.url} />
                <Button size="sm" onClick={() => actions?.onCopyUrl?.(state.done!.url!)}>
                  <Copy size={13} aria-hidden /> {t('share.copy')}
                </Button>
              </span>
            </Field>
          )}
          <p className="fw-tf-muted">{t('share.password')}</p>
        </div>
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={close}
      title={t('share.title', { number: pack?.number ?? '' })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={state.writing.busy} heldReason={!model.online ? t('held.offline') : problems[0] ? t(problems[0], { min: LINK_PASSWORD_MIN, days: PACK_LINK_DAYS_MAX }) : null} onClick={() => actions?.onShareSave?.()}>
            <Send size={13} aria-hidden /> {t('share.do')}
          </Button>
        </>
      }
    >
      <div className="fw-tf-form">
        <NoticeBanner notice={state.writing.problem} />
        <p className="fw-tf-muted">{t('share.lead')}</p>
        <Field label={t('share.party')} required hint={state.parties === null ? t('pack.partyNoRight') : t('share.partyHint')}>
          {state.parties === null ? (
            <span className={draft.partyId ? undefined : 'fw-tf-danger-text'}>{pack?.recipientParty?.name ?? t('share.noParty')}</span>
          ) : (
            <Combobox
              options={[...(pack?.recipientParty && !(parties ?? []).some((party) => party.id === pack.recipientParty!.id) ? [{ value: pack.recipientParty.id, label: pack.recipientParty.name }] : []), ...(parties ?? []).map((party) => ({ value: party.id, label: `${party.name} · ${party.code}` }))]}
              value={draft.partyId ?? ''}
              placeholder={state.parties.status === 'loading' ? t('common.reading') : t('pack.partyPick')}
              onChange={(value) => set({ partyId: value || null })}
            />
          )}
        </Field>
        <Field label={t('share.passwordLabel')} required hint={t('share.passwordHint', { min: LINK_PASSWORD_MIN })}>
          <Input size="sm" type="text" autoComplete="off" value={draft.password} maxLength={128} onChange={(event) => set({ password: event.target.value })} />
        </Field>
        <Field label={t('share.expiresOn')} required hint={t('share.expiresHint', { days: PACK_LINK_DAYS_MAX })}>
          <DateField value={draft.expiresOn} min={model.today} max={addDays(model.today, PACK_LINK_DAYS_MAX)} onChange={(value) => set({ expiresOn: value })} />
        </Field>
        <Checkbox label={t('share.send')} checked={draft.send} onChange={(event) => set({ send: event.target.checked })} />
        {draft.send && (
          <>
            <Field label={t('share.email')} required>
              <Input size="sm" type="email" value={draft.email} maxLength={320} onChange={(event) => set({ email: event.target.value })} />
            </Field>
            <Field label={t('share.mailLanguage')}>
              <SegmentedControl ariaLabel={t('share.mailLanguage')} size="sm" value={draft.language} onChange={(value) => set({ language: value as 'it' | 'en' })} options={[{ value: 'it', label: languageName('it', locale) }, { value: 'en', label: languageName('en', locale) }]} />
            </Field>
            <Field label={t('share.message')}>
              <Textarea rows={2} value={draft.message} maxLength={2000} onChange={(event) => set({ message: event.target.value })} />
            </Field>
          </>
        )}
        <p className="fw-tf-muted">{t('share.code')}</p>
      </div>
    </Modal>
  )
}

/** Withdraw a link: it stops opening at once (an optional reason for the record). */
export function WithdrawDialog({ model, state, actions }: { model: RecordModel; state: WithdrawState; actions?: RecordActions | undefined }) {
  const t = useWords()
  const pack = valueOf(model.packs)?.packs.find((entry) => entry.id === state.packId) ?? null
  const link = pack?.links.find((entry) => entry.id === state.linkId) ?? null
  const close = () => actions?.onWithdraw?.(state.packId, null)
  const problem = state.reason.trim() ? reasonProblem(state.reason) : null
  return (
    <Modal
      open
      onClose={close}
      title={t('withdraw.title', { number: pack?.number ?? '' })}
      size="sm"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={state.writing.busy} heldReason={!model.online ? t('held.offline') : problem ? t(problem) : null} onClick={() => actions?.onWithdrawSave?.()}>
            {t('withdraw.do')}
          </Button>
        </>
      }
    >
      <div className="fw-tf-form">
        <NoticeBanner notice={state.writing.problem} />
        <p>{t('withdraw.lead', { to: link?.email ?? pack?.recipient ?? '—' })}</p>
        <Field label={t('withdraw.reason')} hint={t('withdraw.reasonHint')}>
          <Textarea rows={2} value={state.reason} maxLength={500} onChange={(event) => actions?.onWithdrawReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
