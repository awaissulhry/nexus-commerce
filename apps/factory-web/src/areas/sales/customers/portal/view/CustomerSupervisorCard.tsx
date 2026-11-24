'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { UserCog } from 'lucide-react'
import { Eye, Palette, TriangleAlert } from 'lucide-react' // F-CP-155: the factory designer rows' marks
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { Combobox, EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { Modal } from '../../../../../lib/i18n/ds-parts' // F-CP-155: the ONE Change… window
import { applyHeldOf, changeHeldOf, choicesOf, draftProblems, personTagOf, portalLineOf, type DesignerActions, type DesignerModel, type Phrase } from '../designer/model' // F-CP-155
import type { DesignerPerson, DesignerSlot } from '../designer/api' // F-CP-155
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { SUPERVISOR_NS } from '../../../../_shared/production-supervisor/model'
import { changeCount, limitsDraftOf, limitsProblems, slotChoices, supervisorHeld, supervisorMove, type LimitsDraft, type SupervisorActions, type SupervisorModel } from '../limits/model'
import { heldWords, NoticeLine, PortalAccessMessages, usePortalT } from './parts'
import type { PortalNotice } from '../model'

/**
 * F-SA-272 (sales page plan N5, pick P10': "Supervisor + backup move to Overview", the production lane's yes; 11-customer-page §4 S2;
 * it speaks the portal-access words, so it lives beside the limits card):
 * "Who looks after <customer>" on the customer's Overview — the supervisor and backup block moved here from Portal settings ›
 * Production limits (same code), on a card of its own with its own Apply (PUT /production/brands/:id/supervisor; the limits Apply
 * no longer carries it). Office only: never in the portal or the preview, and the customer is never told who (R-41). Read with
 * partners.view (the customer's production read holds the names); changed with production.brand.manage, else held in words.
 */
// F-CP-155: + the Factory designer and its Backup under the supervisor (`designer`: null / absent — not drawn: no partners.view).
export function CustomerSupervisorCard({ model, actions, name, notice, onDismissNotice, designer, designerActions }: { model: SupervisorModel; actions?: SupervisorActions | undefined; name: string; notice?: PortalNotice | null; onDismissNotice?: () => void; designer?: DesignerModel | null; designerActions?: DesignerActions | undefined }) {
  return (
    <PortalAccessMessages>
      <WithMessages namespaces={[SUPERVISOR_NS, 'parties' /* F-CP-155 */]}>
        <SupervisorCard model={model} actions={actions} name={name} notice={notice ?? null} onDismissNotice={onDismissNotice} designer={designer ?? null} designerActions={designerActions} />
      </WithMessages>
    </PortalAccessMessages>
  )
}

function SupervisorCard({ model, actions, name, notice, onDismissNotice, designer, designerActions }: { model: SupervisorModel; actions?: SupervisorActions | undefined; name: string; notice: PortalNotice | null; onDismissNotice?: (() => void) | undefined; designer: DesignerModel | null; designerActions?: DesignerActions | undefined }) {
  const t = usePortalT()
  const read = model.read
  const [draft, setDraft] = useSupervisorDraft(model)
  // F-CP-155: the designer rows stand on their own read (a supervisor read that failed or still reads never hides them).
  const designerPart = designer ? <DesignerBlock model={designer} actions={designerActions} name={name} /> : null
  if (model.state === 'error' && !read)
    return (
      <Card padded>
        <div className="fw-pa">
          <Banner
            tone="danger"
            title={t(model.problem ?? 'failed.title')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
          {designerPart}
        </div>
      </Card>
    )
  if (!read || !draft)
    return (
      <Card padded>
        <div className="fw-pa">
          <Skeleton height={96} />
          {designerPart}
        </div>
      </Card>
    )
  return (
    <Card padded>
      <div className="fw-pa">
        {/* F-CO-201: the card's inside is the ONE supervisor form — framed: its legend and the unsaved bar (Discard · Apply). */}
        <SupervisorForm model={model} actions={actions} name={name} draft={draft} onDraft={setDraft} notice={notice} onDismissNotice={onDismissNotice} framed />
        {designerPart /* F-CP-155: under Supervisor / Backup (its own Change…, never the supervisor's Apply) */}
      </div>
    </Card>
  )
}

// ---- F-CO-201 (customer page › Overview, co-w2 W2.1; 13-backend §3.6; 10-design §4): the supervisor form, split from the card so
// that People's Change… opens ONE window holding the SAME form — the same pick lists, the same command (PUT
// /production/brands/:id/supervisor), the same right. The card keeps its export and its output.

/** The form's draft: what the reader picked, started from what is stored (a save, or someone else's change, starts it again). */
function useSupervisorDraft(model: SupervisorModel): [LimitsDraft | null, (draft: LimitsDraft | ((current: LimitsDraft | null) => LimitsDraft | null)) => void] {
  const read = model.read
  const [draft, setDraft] = useState<LimitsDraft | null>(model.draft ?? (read ? limitsDraftOf(read.production) : null))
  // A save (or someone else's change) moves the version: the form starts again from what is stored.
  useEffect(() => setDraft(model.draft ?? (read ? limitsDraftOf(read.production) : null)), [read?.production.version, read?.party.id])
  return [draft, setDraft]
}

/**
 * The supervisor's form: the receipt, a refused save, then Supervisor and Backup from the people who may take it. ONE form, two
 * hosts: the card (`framed`: its legend names who looks after; the unsaved bar holds Discard · Apply) and People's Change… window
 * (`framed` false: the window's title names it, its foot holds Cancel · Save — ./CustomerSupervisorCard.tsx SupervisorWindow).
 */
export function SupervisorForm({ model, actions, name, draft, onDraft, notice = null, onDismissNotice, framed }: { model: SupervisorModel; actions?: SupervisorActions | undefined; name: string; draft: LimitsDraft; onDraft: (draft: LimitsDraft | ((current: LimitsDraft | null) => LimitsDraft | null)) => void; notice?: PortalNotice | null; onDismissNotice?: (() => void) | undefined; framed: boolean }) {
  const t = usePortalT()
  const ts = useT(SUPERVISOR_NS)
  const saved = model.read!.production
  const heldReason = supervisorHeld(model.supervise, model.pick)
  const held = heldReason ? (heldReason.ns === 'production-supervisor' ? ts(heldReason.key) : t(heldReason.key)) : null
  const move = supervisorMove(saved, draft, model.pick)
  const count = changeCount(saved, draft)
  const problems = limitsProblems(draft)
  const apply = () => {
    if (count === 0 || Object.keys(problems).length > 0 || model.busy) return
    void actions?.onApply?.(draft)
  }
  const onPatch = (patch: Partial<LimitsDraft>) => onDraft((current) => (current ? { ...current, ...patch } : current))
  return (
    <>
      <NoticeLine notice={notice} onDismiss={onDismissNotice} />
      {model.saveProblem && (
        <Banner
          tone="danger"
          title={model.saveProblem.ns === 'production-supervisor' ? ts(model.saveProblem.key) : t(model.saveProblem.key)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissProblem?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {framed ? (
        <SupervisorBlock model={model} draft={draft} name={name} held={held} move={move} onDraft={onPatch} actions={actions} />
      ) : (
        <div className="fw-pa-stack">
          <SupervisorFields model={model} draft={draft} held={held} move={move} onDraft={onPatch} actions={actions} />
        </div>
      )}
      {framed && count > 0 && (
        <EditModeBar
          count={count}
          message={t('limits.unsaved', { count })}
          applyLabel={t('limits.apply')}
          busy={model.busy}
          applyHeldReason={Object.keys(problems).length > 0 ? t('settings.fixFirst') : null}
          onDiscard={() => onDraft(limitsDraftOf(saved))}
          onApply={apply}
        />
      )}
    </>
  )
}

/**
 * People's Change… (the supervisor): ONE centred window (560 px) around the same form. Its title names who looks after, with "Office
 * only"; its foot: Cancel · Save. Save is the card's own command; once it is saved the window closes and People reads again.
 */
export function SupervisorWindow({ model, actions, name, onClose, inside = false }: { model: SupervisorModel; actions?: SupervisorActions | undefined; name: string; onClose: () => void; /** F-CO-301: its inside on a plain card (a design case: never a Modal open on a server render). */ inside?: boolean }) {
  return (
    <PortalAccessMessages>
      <WithMessages namespaces={[SUPERVISOR_NS, 'parties']}>
        <SupervisorWindowBody model={model} actions={actions} name={name} onClose={onClose} inside={inside} />
      </WithMessages>
    </PortalAccessMessages>
  )
}

function SupervisorWindowBody({ model, actions, name, onClose, inside }: { model: SupervisorModel; actions?: SupervisorActions | undefined; name: string; onClose: () => void; inside: boolean }) {
  const t = usePortalT()
  const ts = useT(SUPERVISOR_NS)
  const p = useT('parties')
  const [draft, setDraft] = useSupervisorDraft(model)
  const read = model.read
  const heldReason = supervisorHeld(model.supervise, model.pick)
  const count = read && draft ? changeCount(read.production, draft) : 0
  const fix = draft ? Object.keys(limitsProblems(draft)).length > 0 : false
  // Save is held with words: the right or the reach it needs, a save on its way, nothing changed yet, a field to fix first.
  const saveHeld = heldReason ? (heldReason.ns === 'production-supervisor' ? ts(heldReason.key) : t(heldReason.key)) : model.busy ? t('common.saving') : count === 0 ? t('person.nothing') : fix ? t('settings.fixFirst') : null
  const save = () => {
    if (!draft || saveHeld) return
    void actions?.onApply?.(draft).then((done) => {
      if (done) onClose()
    })
  }
  return (
    <WindowFrame
      inside={inside}
      size="md"
      onClose={onClose}
      closeHeld={model.busy ? t('common.saving') : null}
      title={
        <span className="fw-pa-cell">
          {t('limits.supervisor.title', { name })} <Tag tone="info">{t('limits.supervisor.officeOnly')}</Tag>
        </span>
      }
      footer={
        <>
          <span className="grow" />
          <Button size="sm" heldReason={model.busy ? t('common.saving') : null} onClick={onClose}>
            {p('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={saveHeld} onClick={save}>
            {p('common.save')}
          </Button>
        </>
      }
    >
      {read && draft ? (
        <SupervisorForm model={model} actions={actions} name={name} draft={draft} onDraft={setDraft} framed={false} />
      ) : (
        <div role="status" aria-label={ts('dialog.reading')}>
          <Skeleton height={96} />
        </div>
      )}
    </WindowFrame>
  )
}

/**
 * F-CO-301 (customer Overview co-t T.1): ONE window body, two frames — the centred Modal the page opens, or (`inside`) the same
 * title, body and foot on a plain card: the design index draws a window's states this way (never a Modal open on a server render).
 */
function WindowFrame({ inside, size, onClose, closeHeld, title, subtitle, footer, children }: { inside: boolean; size: 'sm' | 'md'; onClose: () => void; closeHeld: string | null; title: ReactNode; subtitle?: ReactNode; footer: ReactNode; children?: ReactNode }) {
  if (!inside)
    return (
      <Modal open size={size} sheet onClose={onClose} closeHeld={closeHeld} title={title} subtitle={subtitle} footer={footer}>
        {children}
      </Modal>
    )
  return (
    <Card padded>
      <div className="fw-pa">
        <div className="fw-pa-stack">
          <h2 className="fw-pa-legend">{title}</h2>
          {subtitle ? <p className="fw-pa-hint">{subtitle}</p> : null}
        </div>
        {children}
        <div className="fw-pa-head">{footer}</div>
      </div>
    </Card>
  )
}
// ---- end F-CO-201 (the supervisor form and its window)

/** Who looks after the customer here — office only (R-41, R-53): the card's frame (its legend) around the supervisor's fields. */
function SupervisorBlock({ model, draft, name, held, move, onDraft, actions }: { model: SupervisorModel; draft: LimitsDraft; name: string; held: string | null; move: { key: string; count: number } | null; onDraft: (patch: Partial<LimitsDraft>) => void; actions?: SupervisorActions | undefined }) {
  const t = usePortalT()
  return (
    <fieldset className="fw-pa-fieldset fw-pa-lim-office">
      <legend className="fw-pa-legend">
        <span className="fw-pa-cell">
          <UserCog size={14} aria-hidden /> {t('limits.supervisor.title', { name })} <Tag tone="info">{t('limits.supervisor.officeOnly')}</Tag>
        </span>
      </legend>
      <SupervisorFields model={model} draft={draft} held={held} move={move} onDraft={onDraft} actions={actions} />
    </fieldset>
  )
}

/** F-CO-201: the supervisor and the backup, from the people who may take it — the card's and the Change… window's same fields. */
function SupervisorFields({ model, draft, held, move, onDraft, actions }: { model: SupervisorModel; draft: LimitsDraft; held: string | null; move: { key: string; count: number } | null; onDraft: (patch: Partial<LimitsDraft>) => void; actions?: SupervisorActions | undefined }) {
  const t = usePortalT()
  const ts = useT(SUPERVISOR_NS)
  const saved = model.read!.production
  const pick = model.pick
  const supervisors = slotChoices(pick, saved.supervisor, null)
  const backups = slotChoices(pick, saved.backup, draft.supervisorId)
  const problems = limitsProblems(draft)
  const label = (entry: { value: string; label: string; listed: boolean }) => (entry.listed ? entry.label : t('limits.supervisor.notListed', { name: entry.label }))
  const editable = held === null && pick.status === 'ready'
  const person = (slot: { readonly name: string; readonly active: boolean } | null) =>
    slot ? (
      <span className="fw-pa-cell">
        <span>{slot.name}</span>
        {!slot.active && <Tag tone="warning">{ts('fact.inactive')}</Tag>}
      </span>
    ) : (
      <span className="fw-pa-hint">{t('limits.supervisor.none')}</span>
    )
  return (
    <>
      <p className="fw-pa-hint">{t('limits.supervisor.intro')}</p>
      {held && <p className="fw-pa-hint">{held}</p>}
      {pick.status === 'loading' && model.supervise && (
        <div role="status" aria-label={ts('dialog.reading')}>
          <Skeleton height={40} />
        </div>
      )}
      {pick.status === 'error' && (
        <Banner
          tone="danger"
          title={t(pick.key)}
          action={
            <Button size="sm" onClick={() => actions?.onRetryPick?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {pick.status === 'ready' && pick.people.length === 0 && <p className="fw-pa-hint">{ts('dialog.nobody')}</p>}
      <div className="fw-pa-lim-two">
        <Field label={t('limits.supervisor.label')}>
          {editable ? (
            <Combobox options={[{ value: '', label: t('limits.supervisor.none') }, ...supervisors.map((entry) => ({ value: entry.value, label: label(entry) }))]} value={draft.supervisorId ?? ''} placeholder={ts('dialog.search')} onChange={(value) => onDraft({ supervisorId: value || null, ...(value ? {} : { backupId: null }) })} />
          ) : (
            person(saved.supervisor)
          )}
        </Field>
        <Field label={t('limits.supervisor.backup')} hint={t('limits.supervisor.backupHint')} error={problems.backup ? t(problems.backup) : undefined}>
          {editable && draft.supervisorId !== null ? (
            <Combobox options={[{ value: '', label: t('limits.supervisor.none') }, ...backups.map((entry) => ({ value: entry.value, label: label(entry) }))]} value={draft.backupId ?? ''} placeholder={ts('dialog.search')} onChange={(value) => onDraft({ backupId: value || null })} />
          ) : editable ? (
            <span className="fw-pa-hint">{t('limits.supervisor.backupAlone')}</span>
          ) : (
            person(saved.backup)
          )}
        </Field>
      </div>
      {move && (
        <p className="fw-pa-strong" role="status">
          {t(move.key, { count: move.count })}
        </p>
      )}
      {pick.status === 'ready' && !pick.complete && <p className="fw-pa-hint">{ts('dialog.partial')}</p>}
      <p className="fw-pa-hint">{ts('dialog.hint')}</p>
    </>
  )
}

// ── F-CP-155 (customer page plan C7, D12; design 10 §7, picture 23; lead pick: no step-up; the API's B-CP-078) ──────────────────
/**
 * The Factory designer and its Backup, under Supervisor / Backup on the same card (extend, don't add): each name with its tag —
 * "{customer} sees this name" (the one difference from the supervisor's "Office only"), or "No longer reaches {customer}" / "No
 * longer active" (a person stays named until changed) — the line of what the portal names now (the portal off: the name shows once it
 * is on), and ONE Change… (held in words without the right). Read with partners.view; changed with partners.manage over every company
 * the customer works with. The customer never learns anything else of ours: the pick list names only office people who read and
 * answer its conversations.
 */
function DesignerBlock({ model, actions, name }: { model: DesignerModel; actions?: DesignerActions | undefined; name: string }) {
  const t = usePortalT()
  const p = useT('parties')
  const say = useDesignerSay(name)
  const held = changeHeldOf(model.manage, model.read)
  return (
    <section className="fw-pa-fieldset fw-pa-lim-office" aria-labelledby="fw-pa-designer-title">
      <div className="fw-pa-head">
        <span id="fw-pa-designer-title" className="fw-pa-legend fw-pa-cell">
          <Palette size={14} aria-hidden /> {p('customers.designer.label')}
        </span>
        <Button size="sm" heldReason={held ? say(held) : null} onClick={() => actions?.onChange?.()}>
          {p('customers.designer.change')}
        </Button>
      </div>
      {model.notice && (
        <Banner
          tone="success"
          title={say(model.notice)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.read.status === 'loading' && (
        <div role="status" aria-label={p('customers.designer.reading')}>
          <Skeleton height={40} />
        </div>
      )}
      {model.read.status === 'error' && (
        <Banner
          tone="danger"
          title={p('customers.designer.readFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.read.key)}
        </Banner>
      )}
      {model.read.status === 'ready' && <DesignerRows slot={model.read.slot} say={say} />}
      {model.read.status === 'ready' && model.dialog && <DesignerChangeWindow model={model} slot={model.read.slot} name={name} say={say} actions={actions} />}
    </section>
  )
}

function DesignerRows({ slot, say }: { slot: DesignerSlot; say: (phrase: Phrase) => string }) {
  const person = (named: DesignerPerson | null) => {
    if (!named) return <span className="fw-pa-hint">{say({ key: 'customers.designer.none' })}</span>
    const tag = personTagOf(named)
    return (
      <span className="fw-pa-cell">
        <span>{named.name}</span>
        <Tag tone={tag.tone}>
          {tag.tone === 'info' ? <Eye size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />} {say(tag.words)}
        </Tag>
      </span>
    )
  }
  return (
    <>
      <div className="fw-pa-lim-two">
        <Field label={say({ key: 'customers.designer.label' })}>{person(slot.designer)}</Field>
        <Field label={say({ key: 'customers.designer.backup' })}>{person(slot.backup)}</Field>
      </div>
      <p className="fw-pa-hint">{say(portalLineOf(slot))}</p>
    </>
  )
}

/** The ONE Change… window: two pick lists (eligible office people only), Apply with the stored version; refusals at the field. */
function DesignerChangeWindow({ model, slot, name, say, actions, inside = false }: { model: DesignerModel; slot: DesignerSlot; name: string; say: (phrase: Phrase) => string; actions?: DesignerActions | undefined; inside?: boolean }) {
  const t = usePortalT()
  const dialog = model.dialog!
  const problems = { ...draftProblems(dialog.draft), ...dialog.fields }
  const held = applyHeldOf(dialog, slot)
  const label = (entry: { readonly label: Phrase | string }) => (typeof entry.label === 'string' ? entry.label : say(entry.label))
  const ready = dialog.choices.status === 'ready' ? dialog.choices.choices : null
  const designers = ready ? choicesOf(ready, slot.designer, null) : []
  const backups = ready ? choicesOf(ready, slot.backup, dialog.draft.designerId) : []
  const none = { value: '', label: say({ key: 'customers.designer.none' }) }
  return (
    <WindowFrame
      inside={inside}
      size="sm"
      onClose={() => actions?.onClose?.()}
      closeHeld={dialog.busy ? say({ key: 'customers.designer.saving' }) : null}
      title={say({ key: 'customers.designer.title', params: { customer: name } })}
      subtitle={say({ key: 'customers.designer.hint' })}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" heldReason={dialog.busy ? say({ key: 'customers.designer.saving' }) : null} onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? say(held) : null} onClick={() => actions?.onApply?.()}>
            {say({ key: 'customers.designer.apply' })}
          </Button>
        </>
      }
    >
      <div className="fw-pa-stack">
        {dialog.problem && <Banner tone="warning" title={say(dialog.problem)} />}
        {dialog.choices.status === 'loading' && (
          <div role="status" aria-label={say({ key: 'customers.designer.reading' })}>
            <Skeleton height={40} />
          </div>
        )}
        {dialog.choices.status === 'error' && (
          <Banner
            tone="danger"
            title={say({ key: 'customers.designer.choicesFailed' })}
            action={
              <Button size="sm" onClick={() => actions?.onRetryChoices?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(dialog.choices.key)}
          </Banner>
        )}
        {ready && ready.people.length === 0 && <p className="fw-pa-hint">{say({ key: 'customers.designer.nobodyEligible' })}</p>}
        {ready && (
          <>
            <Field label={say({ key: 'customers.designer.label' })} error={problems.designerId ? say(problems.designerId) : undefined}>
              <Combobox options={[none, ...designers.map((entry) => ({ value: entry.value, label: label(entry) }))]} value={dialog.draft.designerId ?? ''} placeholder={say({ key: 'customers.designer.search' })} onChange={(value) => actions?.onDraft?.({ designerId: value || null })} />
            </Field>
            <Field label={say({ key: 'customers.designer.backup' })} hint={say({ key: 'customers.designer.backupHint' })} error={problems.backupId ? say(problems.backupId) : undefined}>
              {dialog.draft.designerId !== null ? (
                <Combobox options={[none, ...backups.map((entry) => ({ value: entry.value, label: label(entry) }))]} value={dialog.draft.backupId ?? ''} placeholder={say({ key: 'customers.designer.search' })} onChange={(value) => actions?.onDraft?.({ backupId: value || null })} />
              ) : (
                <span className="fw-pa-hint">{say({ key: 'customers.designer.refusal.BACKUP_ALONE' })}</span>
              )}
            </Field>
            {!ready.complete && <p className="fw-pa-hint">{say({ key: 'customers.designer.partial' })}</p>}
          </>
        )}
      </div>
    </WindowFrame>
  )
}
// ── end F-CP-155 ──

// ---- F-CO-201 (customer page › Overview, co-w2 W2.1; 13-backend §3.6): the designer's words, and its Change… window for People ----
/** The designer's words: the partners screens' own for a right ("Needs the right: …"), else the parties catalogue, the customer named. */
function useDesignerSay(name: string): (phrase: Phrase) => string {
  const t = usePortalT()
  const p = useT('parties')
  return (phrase) => (phrase.ns === 'portal-access' ? (heldWords(t, phrase.key) ?? t(phrase.key)) : p(phrase.key, { customer: name, ...phrase.params }))
}

/** People's Change… (the factory designer): today's own window, unchanged — mounted by the page while the designer's hook holds it open. */
export function DesignerWindow({ model, actions, name, inside = false }: { model: DesignerModel; actions?: DesignerActions | undefined; name: string; /** F-CO-301: its inside on a plain card (a design case). */ inside?: boolean }) {
  return (
    <PortalAccessMessages>
      <WithMessages namespaces={['parties']}>
        <DesignerWindowHost model={model} actions={actions} name={name} inside={inside} />
      </WithMessages>
    </PortalAccessMessages>
  )
}

function DesignerWindowHost({ model, actions, name, inside }: { model: DesignerModel; actions?: DesignerActions | undefined; name: string; inside: boolean }) {
  const say = useDesignerSay(name)
  return model.read.status === 'ready' && model.dialog ? <DesignerChangeWindow model={model} slot={model.read.slot} name={name} say={say} actions={actions} inside={inside} /> : null
}
// ---- end F-CO-201
