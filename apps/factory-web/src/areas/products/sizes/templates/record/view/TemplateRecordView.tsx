'use client'

import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Archive, MoreHorizontal, RotateCcw } from 'lucide-react'
import { Banner, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Input, Kbd, Pill } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { RecordFrame, RecordState } from '../../../../library/parts'
import type { TemplateRules, TemplateView } from '../../api'
import { archiveHeld, listHref, nameIn, recordHref, RECORD_TABS, renameHeld, restoreHeld, ridersHref, switchHeld, type Notice, type Phrase, type PointDraft, type RecordTab, type TemplateCan } from '../../model'
import { NoticeLine, OnOffTag, TemplatesMessages, useWords } from '../../parts'
import { MtmTab } from './MtmTab'
import { PointsTab } from './PointsTab'
import { PreviewDialog } from './PreviewDialog'
import { WhereUsedTab } from './WhereUsedTab'
// B-W2b-371: the rule editor (XF2:05), the styles and open orders a template serves (XF2:04).
import type { WhereUsedView } from '@nexus/factory-domain/sales/mtm/where-used'
import type { RulesEditActions, RulesEditModel } from '../../rules/use-rules'

export type TemplateLoad = { status: 'loading' } | { status: 'ready'; value: TemplateView } | { status: 'error'; problem: string } | { status: 'notFound' } | { status: 'forbidden' }

export type RecordDialog =
  | { kind: 'switch'; on: boolean; reason: string; problem: string | null }
  | { kind: 'archive' | 'restore'; problem: string | null }
  | { kind: 'rename'; name: string; problem: string | null }

export interface TemplateRecordModel {
  readonly prefix: string
  readonly can: TemplateCan
  readonly tab: RecordTab
  readonly template: TemplateLoad
  /** The made-to-measure rules (read while their tab is open). */
  readonly rules: { readonly value: TemplateRules | null; readonly problem: string | null }
  /** The points' editor while open: the list as typed, a write running, the fields a refused save named (by point key). */
  readonly edit: { readonly drafts: readonly PointDraft[]; readonly busy: boolean; readonly refused: Readonly<Record<string, Readonly<Record<string, Phrase>>>> } | null
  readonly dialog: RecordDialog | null
  readonly notice: Notice | null
  /** Someone else changed the template meanwhile ("Changed meanwhile · Reload"). */
  readonly changed: { readonly at: string } | null
  readonly busy: boolean
  /** Design only: the preview open with these values. */
  readonly preview?: { readonly values: Record<string, string>; readonly confirmed: string[] } | null
  /** B-W2b-371 (XF2:05): the rule editor (its draft while open). */
  readonly rulesEdit?: RulesEditModel | null
  /** B-W2b-371 (XF2:04): the styles and open orders the template serves (read while Where used is open). */
  readonly whereUsed?: { readonly value: WhereUsedView | null; readonly problem: string | null } | null
}

export interface TemplateRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onRetryRules?: () => void
  onEdit?: (open: boolean) => void
  onDrafts?: (drafts: readonly PointDraft[]) => void
  onSave?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onSwitch?: () => void
  onMove?: (to: 'archive' | 'restore') => void
  onRename?: () => void
  onDismissNotice?: () => void
  /** B-W2b-371 (XF2:05). */
  rulesEdit?: RulesEditActions
  /** B-W2b-371 (XF2:04): read Where used again. */
  onRetryWhereUsed?: () => void
}

/**
 * SCR-049-template — a measurement template (design products.sizes, record "Measurement template"; B-W1-17 on B-W2b-358/-248): the
 * band (‹ Measurement templates, "<code> · <name>", its product type and who keeps it, its status and Made-to-measure On / Off,
 * ⋯ Rename, Archive / Restore (held with why: its rules on, styles measured with it), the riders measured for it, Copy code) and
 * its tabs: Points (`?tab=points`), Made-to-measure (`?tab=mtm`: built OFF per template, the Owner's switch) and Where used
 * (`?tab=whereused`). Fetches nothing.
 */
export function TemplateRecordView({ model, actions }: { model: TemplateRecordModel; actions?: TemplateRecordActions }) {
  return (
    <TemplatesMessages>
      <Body model={model} actions={actions} />
    </TemplatesMessages>
  )
}

function Body({ model, actions }: { model: TemplateRecordModel; actions?: TemplateRecordActions }) {
  const { t, say, locale } = useWords()
  const [preview, setPreview] = useState<boolean>(!!model.preview)
  const back = { href: listHref(model.prefix), label: t('record.back') }
  if (!model.can.view || model.template.status === 'forbidden') return <RecordState back={back} state="forbidden" />
  if (model.template.status === 'loading') return <RecordState back={back} state="loading" />
  if (model.template.status === 'notFound') return <RecordState back={back} state="notFound" />
  if (model.template.status === 'error') return <RecordState back={back} state="error" problem={null} onRetry={() => actions?.onRetry?.()} />
  const template = model.template.value
  const archived = template.status === 'ARCHIVED'
  const heldItem = (id: string, label: string, held: Phrase | null, onSelect: () => void, tone?: 'danger'): MenuItemDef => ({ id, label, disabled: !!held, description: say(held) ?? undefined, onSelect, ...(tone ? { tone } : {}) })
  const menu: MenuItemDef[] = [
    heldItem('rename', t('record.rename'), !model.can.manage ? { key: 'held.noManage' } : archived ? { key: 'held.archived' } : null, () => actions?.onDialog?.({ kind: 'rename', name: template.name, problem: null })),
    archived ? heldItem('restore', t('record.restore'), restoreHeld(template, model.can), () => actions?.onDialog?.({ kind: 'restore', problem: null })) : heldItem('archive', t('record.archive'), archiveHeld(template, model.can), () => actions?.onDialog?.({ kind: 'archive', problem: null }), 'danger'),
    { id: 'riders', label: t('list.openRiders'), href: ridersHref(model.prefix, template.code) },
    { id: 'copy', label: t('list.copyCode'), onSelect: () => void navigator.clipboard?.writeText(template.code).catch(() => undefined) },
  ]
  const tabs = RECORD_TABS.map((tab) => ({ id: tab, label: t(`tab.${tab}`), count: tab === 'points' ? template.points.filter((point) => point.status === 'ACTIVE').length : null }))
  return (
    <>
      <RecordFrame
        back={back}
        title={`${template.code} · ${nameIn(template, locale)}`}
        meta={
          <span className="fw-lib-inline">
            <span>{t(`type.${template.productType}`)}</span>
            <span>{template.companyId ? t('record.ownCompany') : t('record.everyCompany')}</span>
          </span>
        }
        status={
          <span className="fw-lib-inline">
            <Pill tone={archived ? 'neutral' : 'success'}>{t(`status.${template.status}`)}</Pill>
            <OnOffTag on={template.rulesOn} />
          </span>
        }
        actions={<Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('record.more') }} items={menu} />}
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => recordHref(model.prefix, template.id, tab as RecordTab)}
      >
        {model.changed && (
          <Banner
            tone="warning"
            title={t('record.changed')}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>
                {t('record.reload')}
              </Button>
            }
          />
        )}
        {archived && <Banner tone="info" title={t('record.archivedBanner')} />}
        <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {model.tab === 'points' && <PointsTab model={model} template={template} actions={actions} onPreview={() => setPreview(true)} />}
        {model.tab === 'mtm' && <MtmTab model={model} template={template} actions={actions} />}
        {model.tab === 'whereused' && <WhereUsedTab prefix={model.prefix} template={template} whereUsed={model.whereUsed ?? null} onRetry={actions?.onRetryWhereUsed} />}
      </RecordFrame>
      {preview && <PreviewDialog template={template} initial={model.preview ?? null} onClose={() => setPreview(false)} />}
      <Dialogs model={model} template={template} actions={actions} />
    </>
  )
}

function Dialogs({ model, template, actions }: { model: TemplateRecordModel; template: TemplateView; actions?: TemplateRecordActions }) {
  const { t, say } = useWords()
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onDialog?.(null)
  const submitOn = (held: Phrase | null, run: () => void) => (event: ReactKeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
      event.preventDefault()
      run()
    }
  }
  if (dialog.kind === 'switch') {
    const rules = model.rules.value
    const held = rules ? switchHeld(rules, dialog.on, model.can, model.busy) : { key: 'held.busy' }
    const run = () => !held && actions?.onSwitch?.()
    return (
      <Modal
        open
        onClose={close}
        size="md"
        title={t(dialog.on ? 'switch.titleOn' : 'switch.titleOff', { code: template.code })}
        footer={
          <>
            <Button onClick={close}>{t('common.back')}</Button>
            <Button variant={dialog.on ? 'primary' : 'danger'} heldReason={say(held)} onClick={run}>
              {t(dialog.on ? 'mtm.start' : 'mtm.stop')} <Kbd>⌘↵</Kbd>
            </Button>
          </>
        }
      >
        <div className="fw-lib-dialog" onKeyDown={submitOn(held, run)}>
          <ul className="fw-lib-list">
            {(dialog.on ? ['switch.on1', 'switch.on2', 'switch.on3'] : ['switch.off1', 'switch.off2', 'switch.off3']).map((key) => (
              <li key={key}>{t(key, { code: template.code })}</li>
            ))}
          </ul>
          <Field label={t('switch.reason')} hint={t('switch.reasonHint')}>
            <Textarea rows={2} maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
          </Field>
          {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        </div>
      </Modal>
    )
  }
  if (dialog.kind === 'rename') {
    const held = renameHeld(template, dialog.name, model.can, model.busy)
    const run = () => !held && actions?.onRename?.()
    return (
      <Modal
        open
        onClose={close}
        size="sm"
        title={t('rename.title', { code: template.code })}
        footer={
          <>
            <Button onClick={close}>{t('common.back')}</Button>
            <Button variant="primary" heldReason={say(held)} onClick={run}>
              {t('rename.save')} <Kbd>⌘↵</Kbd>
            </Button>
          </>
        }
      >
        <div className="fw-lib-dialog" onKeyDown={submitOn(held, run)}>
          <Field label={t('new.name')} required hint={t('rename.hint')}>
            <Input value={dialog.name} maxLength={200} autoFocus onChange={(event) => actions?.onDialog?.({ ...dialog, name: event.target.value })} />
          </Field>
          {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        </div>
      </Modal>
    )
  }
  const archive = dialog.kind === 'archive'
  const held = archive ? archiveHeld(template, model.can) : restoreHeld(template, model.can)
  const busyHeld = held ?? (model.busy ? { key: 'held.busy' } : null)
  const run = () => !busyHeld && actions?.onMove?.(dialog.kind as 'archive' | 'restore')
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t(archive ? 'move.archiveTitle' : 'move.restoreTitle', { code: template.code })}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant={archive ? 'danger' : 'primary'} heldReason={say(busyHeld)} onClick={run}>
            {archive ? <Archive size={13} aria-hidden /> : <RotateCcw size={13} aria-hidden />} {t(archive ? 'record.archive' : 'record.restore')} <Kbd>⌘↵</Kbd>
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog" onKeyDown={submitOn(busyHeld, run)}>
        <ul className="fw-lib-list">
          {(archive ? ['move.archive1', 'move.archive2'] : ['move.restore1']).map((key) => (
            <li key={key}>{t(key, { code: template.code, profiles: template.profiles })}</li>
          ))}
        </ul>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
      </div>
    </Modal>
  )
}
