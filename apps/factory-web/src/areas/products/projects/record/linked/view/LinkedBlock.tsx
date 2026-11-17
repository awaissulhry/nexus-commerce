'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Link2, MoreHorizontal } from 'lucide-react'
import { Card, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { NoticeLine, ProjectsMessages, useWords } from '../../../parts'
import { FOLD_AT, groupKey, LINKED_ALSO, LINKED_NS, shownRows, typeKey, type LinkedBlockActions, type LinkedBlockModel, type LinkedRow } from '../model'
import { LinkDialog } from './LinkDialog'
import '../linked.css'

/**
 * B-TH-251 — the Linked block of a project's side column (design PROJ.linked-F01, F04, F05, F09, F10; picture 35 never drawn, built to
 * the design kit): the records grouped by kind in the domain's order, each group folded past five rows; a row is its number as a real
 * link (⌘-click opens a new tab), its status in words (never an amount), why it was linked, who linked it and when; a record the
 * reader may not open shows only its kind and "you cannot open it" (no link, no status). Link… and Unlink… with projects.manage, held
 * with the reason otherwise; the Link dialog and "Unlink …?" are this block's. Draws one model, fetches nothing.
 */
export function LinkedBlock({ model, actions }: { model: LinkedBlockModel; actions?: LinkedBlockActions }) {
  return (
    <ProjectsMessages also={LINKED_ALSO}>
      <Block model={model} actions={actions} />
    </ProjectsMessages>
  )
}

function Block({ model, actions }: { model: LinkedBlockModel; actions?: LinkedBlockActions | undefined }) {
  const { t, say, shared, day } = useWords(LINKED_NS)
  const search = useT('search')
  const [opened, setOpened] = useState<readonly string[]>(model.opened ?? [])
  useEffect(() => setOpened(model.opened ?? []), [model.opened])
  const held = say(model.held)

  const row = (entry: LinkedRow) => {
    const busy = model.busy === entry.linkId
    const label = entry.label ?? t(typeKey(entry.recordType))
    const items: MenuItemDef[] = [
      ...(entry.href
        ? [
            { id: 'open', label: t('block.open'), href: entry.href },
            { id: 'tab', label: t('block.openNewTab'), href: entry.href, target: '_blank' },
          ]
        : []),
      ...(model.manage ? [{ id: 'unlink', label: t('block.unlink'), tone: 'danger' as const, disabled: held !== null || busy, ...(held ? { description: held } : {}), onSelect: () => actions?.onUnlink?.(entry) }] : []),
    ]
    return (
      <li key={entry.linkId} className="fw-prjl-row" aria-busy={busy || undefined}>
        <span className="fw-prjl-main">
          {entry.href && entry.label ? (
            <Link className="fw-prjl-label" href={entry.href}>
              {entry.label}
            </Link>
          ) : (
            <span className="fw-prjl-hidden">{t('block.cannotOpen', { type: t(typeKey(entry.recordType)) })}</span>
          )}
          {entry.statusKey && <Tag tone={entry.statusTone}>{search(entry.statusKey)}</Tag>}
        </span>
        {entry.note && <span className="fw-prjl-note">{t('block.note', { note: entry.note })}</span>}
        <span className="fw-prjl-meta">{entry.linkedBy ? t('block.linkedBy', { name: entry.linkedBy, date: day(entry.linkedAt) }) : t('block.linkedOn', { date: day(entry.linkedAt) })}</span>
        {items.length > 0 && (
          <Menu className="fw-prjl-menu" align="right" label={<MoreHorizontal size={16} aria-hidden />} items={items} triggerProps={{ className: 'nds-btn sm icon', 'aria-label': t('block.rowMenu', { label }) }} />
        )}
      </li>
    )
  }

  const linkButton = model.manage ? (
    <Button size="sm" heldReason={held} aria-label={t('block.linkLabel')} onClick={() => actions?.onLink?.()}>
      <Link2 size={14} aria-hidden /> {t('block.link')}
    </Button>
  ) : undefined

  return (
    <Card
      className="fw-prjl"
      header={model.count > 0 ? t('block.heading', { count: model.count }) : t('block.headingNone')}
      headingLevel={2}
      description={say(model.scope)}
      headerAction={linkButton}
    >
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} ns={LINKED_NS} />
      {model.groups.length === 0 ? (
        <p className="fw-prjl-empty">{t(model.manage ? 'block.none' : 'block.noneRead')}</p>
      ) : (
        model.groups.map((group) => {
          const isOpen = opened.includes(group.group)
          const rows = shownRows(group, isOpen)
          return (
            <section key={group.group} className="fw-prjl-group" aria-label={t('block.group', { group: shared(groupKey(group.group)), count: group.rows.length })}>
              <h3 className="fw-prjl-group-title">{t('block.group', { group: shared(groupKey(group.group)), count: group.rows.length })}</h3>
              <ul className="fw-prjl-rows">{rows.map(row)}</ul>
              {group.rows.length > FOLD_AT && (
                <Button
                  size="sm"
                  variant="quiet"
                  aria-expanded={isOpen}
                  onClick={() => setOpened((current) => (isOpen ? current.filter((id) => id !== group.group) : [...current, group.group]))}
                >
                  {isOpen ? t('block.showFewer') : t('block.showAll', { count: group.rows.length })}
                </Button>
              )}
            </section>
          )
        })
      )}
      {model.link && <LinkDialog model={model.link} actions={actions?.link} />}
      {model.unlinking && (
        <Modal
          open
          size="sm"
          title={t('unlink.title', { label: model.unlinking.label ?? t(typeKey(model.unlinking.recordType)) })}
          onClose={() => actions?.onCancelUnlink?.()}
          footer={
            <>
              <Button onClick={() => actions?.onCancelUnlink?.()}>{t('unlink.cancel')}</Button>
              <Button variant="danger" heldReason={held} disabled={model.busy !== null} onClick={() => actions?.onConfirmUnlink?.()}>
                {t('unlink.confirm')}
              </Button>
            </>
          }
        >
          <p className="fw-prjl-text">{t('unlink.body')}</p>
        </Modal>
      )}
    </Card>
  )
}
