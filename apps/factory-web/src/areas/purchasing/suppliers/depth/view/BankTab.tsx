'use client'

import { Banner, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { StepUpModal, Timeline } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { BankAccount, BankView } from '../api'
import { callBackHeld, newestFirst, openChanges, PILL_TONE, verifyHeld, type DepthCan, type Read, type Words } from '../model'
import { BankDialogs, type BankDialog, type BankDialogActions } from './BankDialogs'
import { DepthCard, ReadOr, useSay } from './parts'

export interface StepUpState {
  readonly open: boolean
  readonly busy: boolean
  /** A `bank.stepUp.*` key: what the code allows. */
  readonly sentence: string
  readonly problem: string | null
}

export interface BankTabModel {
  readonly read: Read<BankView>
  readonly can: DepthCan
  /** The person's own id (they never call back or check their own change). */
  readonly me: string
  readonly notice: { readonly tone: 'success' | 'warning' | 'danger' | 'info'; readonly words: Words } | null
  readonly dialog: BankDialog | null
  readonly stepUp: StepUpState
}

export interface BankTabActions {
  onRetry?: () => void
  onPropose?: () => void
  onCallBack?: (accountId: string) => void
  onVerify?: (accountId: string) => void
  onRefuse?: (accountId: string) => void
  onRetire?: (accountId: string) => void
  onReveal?: (accountId: string) => void
  onOpenFile?: (fileId: string) => void
  onDismissNotice?: () => void
  onStepUpCode?: (code: string) => void
  onStepUpClose?: () => void
  dialogs?: BankDialogActions
}

/**
 * Bank details (design rec:Supplier/bank › Bank account, SCM-007): the account payments use, per currency, masked (the
 * last four only; the whole IBAN once, after a fresh code, recorded); a change of IBAN made here or sent by the supplier
 * from its portal waits for a call-back on a number we had before the change (who called, which number, when) and then a
 * second person's check — never the one who proposed it —, then payments use it and the old one retires. The history of
 * changes as a timeline. Hidden for roles without the bank's read right (the tab is not offered).
 */
export function BankTab({ model, actions }: { model: BankTabModel; actions?: BankTabActions }) {
  const { t, say } = useSay()
  const title = t('bank.title')
  const view = model.read.status === 'ready' ? model.read.value : null
  const waiting = view ? openChanges(view.accounts) : []
  const proposeHeld = !model.can.bankPropose ? t('held.bankPropose') : waiting.length > 0 ? t('bank.held.oneAtATime') : null
  return (
    <div className="fw-spd-stack">
      {model.notice ? (
        <div role="status">
          <Banner
            tone={model.notice.tone}
            title={say(model.notice.words)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('notice.hide')}
              </Button>
            }
          />
        </div>
      ) : null}
      <DepthCard
        title={title}
        hint={t('bank.hint')}
        action={
          <Button size="sm" variant="primary" onClick={() => actions?.onPropose?.()} heldReason={view ? proposeHeld : t('read.loading')}>
            {t('bank.change')}
          </Button>
        }
      >
        <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={title} onRetry={actions?.onRetry} rows={4}>
          {view ? <BankBody view={view} model={model} actions={actions} /> : null}
        </ReadOr>
      </DepthCard>
      {view && view.accounts.length > 0 ? <History accounts={view.accounts} /> : null}
      <BankDialogs dialog={model.dialog} active={view?.accounts.filter((account) => account.status === 'ACTIVE') ?? []} actions={actions?.dialogs} />
      <StepUpModal
        open={model.stepUp.open}
        title={t('bank.stepUp.title')}
        sentence={t(model.stepUp.sentence)}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpCode?.(code)}
        onClose={() => actions?.onStepUpClose?.()}
        confirmLabel={t('bank.stepUp.confirm')}
      />
    </div>
  )
}

function BankBody({ view, model, actions }: { view: BankView; model: BankTabModel; actions?: BankTabActions | undefined }) {
  const { t } = useSay()
  const active = view.accounts.filter((account) => account.status === 'ACTIVE')
  const waiting = openChanges(view.accounts)
  return (
    <div className="fw-spd-stack">
      {active.length === 0 ? <EmptyState title={t('bank.empty')} description={t('bank.emptyBody')} /> : active.map((account) => <ActiveAccount key={account.id} account={account} model={model} actions={actions} />)}
      {waiting.map((account) => (
        <WaitingChange key={account.id} account={account} replaces={view.accounts.find((other) => other.id === account.replacesId) ?? null} model={model} actions={actions} />
      ))}
    </div>
  )
}

function ActiveAccount({ account, model, actions }: { account: BankAccount; model: BankTabModel; actions?: BankTabActions | undefined }) {
  const { t } = useSay()
  const locale = useLocale()
  return (
    <div className="fw-spd-account">
      <div className="fw-spd-account-head">
        <span className="fw-spd-tags">
          <span className="fw-spd-iban">{account.masked}</span>
          <Pill tone={PILL_TONE[account.pill]} dot>
            {t(`bank.pill.${account.pill}`)}
          </Pill>
          <Tag>{account.currency}</Tag>
        </span>
        <span className="fw-spd-actions">
          <Button size="sm" onClick={() => actions?.onReveal?.(account.id)} heldReason={model.can.bankReveal ? null : t('held.bankReveal')}>
            {t('bank.reveal')}
          </Button>
          <Button size="sm" variant="danger-outline" onClick={() => actions?.onRetire?.(account.id)} heldReason={model.can.bankVerify ? null : t('held.bankVerify')}>
            {t('bank.retire')}
          </Button>
        </span>
      </div>
      <KeyValue
        columns={3}
        dense
        labelCase="sentence"
        items={[
          { label: t('bank.bankName'), value: account.bankName ?? '—' },
          { label: t('bank.holder'), value: account.holder },
          { label: t('bank.bic'), value: account.bic ?? '—' },
          { label: t('bank.inUseSince'), value: account.activatedAt ? formatDate(account.activatedAt, { locale }) : '—' },
          { label: t('bank.source'), value: t(`bank.sourceOf.${account.source}`) },
          { label: t('bank.letter'), value: <Files account={account} can={model.can} onOpen={actions?.onOpenFile} /> },
        ]}
      />
    </div>
  )
}

function WaitingChange({ account, replaces, model, actions }: { account: BankAccount; replaces: BankAccount | null; model: BankTabModel; actions?: BankTabActions | undefined }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const callHeld = callBackHeld(model.can, account, model.me)
  const checkHeld = verifyHeld(model.can, account, model.me)
  const refuseHeld = model.can.bankVerify ? null : t('held.bankVerify')
  return (
    <div className="fw-spd-account fw-spd-account-waiting">
      <div className="fw-spd-account-head">
        <span className="fw-spd-tags">
          <strong>{t('bank.waitingTitle')}</strong>
          <span className="fw-spd-iban">{replaces ? t('bank.oldNew', { old: replaces.masked, next: account.masked }) : account.masked}</span>
          <Pill tone={PILL_TONE[account.pill]} dot>
            {t(`bank.pill.${account.pill}`)}
          </Pill>
          <Tag>{account.currency}</Tag>
        </span>
        <span className="fw-spd-actions">
          {!account.callBack ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onCallBack?.(account.id)} heldReason={callHeld ? say(callHeld) : null}>
              {t('bank.callBack')}
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => actions?.onVerify?.(account.id)} heldReason={checkHeld ? say(checkHeld) : null}>
              {t('bank.verify')}
            </Button>
          )}
          <Button size="sm" variant="danger-outline" onClick={() => actions?.onRefuse?.(account.id)} heldReason={refuseHeld}>
            {t('bank.refuse')}
          </Button>
        </span>
      </div>
      <KeyValue
        columns={3}
        dense
        labelCase="sentence"
        items={[
          { label: t('bank.bankName'), value: account.bankName ?? '—' },
          { label: t('bank.holder'), value: account.holder },
          { label: t('bank.bic'), value: account.bic ?? '—' },
          { label: t('bank.proposed'), value: t('bank.proposedBy', { date: formatDateTime(account.proposedAt, { locale }), name: account.proposedBy?.name ?? t(`bank.sourceOf.${account.source}`) }) },
          {
            label: t('bank.callBackLabel'),
            value: account.callBack ? t('bank.calledBy', { name: account.callBack.by?.name ?? '—', date: formatDateTime(account.callBack.at, { locale }), number: account.callBack.phone ?? '—', who: account.callBack.label ?? '—' }) : t('bank.notCalled'),
          },
          { label: t('bank.letter'), value: <Files account={account} can={model.can} onOpen={actions?.onOpenFile} /> },
        ]}
      />
      {account.approval && account.approval.status === 'PENDING' ? <Banner tone="info" title={t('bank.waitingYes', { date: account.approval.dueAt ? formatDate(account.approval.dueAt, { locale }) : '—' })} /> : null}
      <p className="fw-spd-hint">{t(account.callBack ? 'bank.nextCheck' : 'bank.nextCall')}</p>
    </div>
  )
}

function Files({ account, can, onOpen }: { account: BankAccount; can: DepthCan; onOpen?: ((fileId: string) => void) | undefined }) {
  const { t } = useSay()
  if (account.files.length === 0) return <span className="fw-spd-hint">{t('bank.noLetter')}</span>
  return (
    <span className="fw-spd-tags">
      {account.files.map((file) => (
        <Button key={file.id} size="sm" variant="link" inline wrap onClick={() => onOpen?.(file.id)} heldReason={can.files ? null : t('held.files')}>
          {file.name}
        </Button>
      ))}
    </span>
  )
}

/** Every account newest first: proposed, called back, checked, in use, refused or retired. */
function History({ accounts }: { accounts: readonly BankAccount[] }) {
  const { t } = useSay()
  const steps = newestFirst(accounts).flatMap((account) => {
    const name = (person: { name: string | null } | null | undefined) => person?.name ?? '—'
    const rows = [
      { key: `${account.id}:p`, label: t('bank.history.proposed', { iban: account.masked, source: t(`bank.sourceOf.${account.source}`) }), tone: 'info' as const, at: account.proposedAt, detail: name(account.proposedBy) },
      ...(account.callBack ? [{ key: `${account.id}:c`, label: t('bank.history.calledBack', { iban: account.masked }), tone: 'info' as const, at: account.callBack.at, detail: `${name(account.callBack.by)} · ${account.callBack.phone ?? '—'}` }] : []),
      ...(account.verified ? [{ key: `${account.id}:v`, label: t('bank.history.checked', { iban: account.masked }), tone: 'success' as const, at: account.verified.at, detail: name(account.verified.by) }] : []),
      ...(account.activatedAt ? [{ key: `${account.id}:a`, label: t('bank.history.inUse', { iban: account.masked }), tone: 'success' as const, at: account.activatedAt }] : []),
      ...(account.refused ? [{ key: `${account.id}:r`, label: t('bank.history.refused', { iban: account.masked }), tone: 'danger' as const, at: account.refused.at, detail: account.refused.reason ?? undefined }] : []),
      ...(account.retired ? [{ key: `${account.id}:x`, label: t('bank.history.retired', { iban: account.masked }), tone: 'neutral' as const, at: account.retired.at, detail: account.retired.reason ?? undefined }] : []),
    ]
    return rows
  })
  const sorted = [...steps].sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1))
  return (
    <DepthCard title={t('bank.history.title')}>
      <Timeline label={t('bank.history.title')} steps={sorted} />
    </DepthCard>
  )
}
