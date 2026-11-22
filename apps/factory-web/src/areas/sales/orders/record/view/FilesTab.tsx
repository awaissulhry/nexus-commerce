'use client'

import type { ReactNode } from 'react'
import { Eye, FileText, ShieldAlert, Upload } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { FILES_VIEW_NS, OrderFilesBody, ORDER_FILES_NS, type FilesViewActions } from '../../../../../lib/record-thread/files-view/view/FilesView'
import type { OrderFilesModel } from '../../../../../lib/record-thread/files-view/model'
// F-OF-101 (order FILES tab, 10-design §1–§5): the tab's one answer, the Files section's answer and its counted line, from the same read.
import { filesAnswerOf, orderChoosableOf, orderCountedOf, orderSectionsOf, tabAnswerOf, type OrderFilesRead } from '../../../../../lib/record-thread/files-view/model'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import type { Order } from '../../api'
import { readOnlyOnPage } from '../../model'
import type { SectionId } from '../production/layout'
import type { OrderRecordModel } from '../record-model'
import { copyLinkTo } from '../shipments/view/hrefs'
import { LineMenuButton } from './LineMenu'
import { InfoTip, Section } from './production/Kit' // F-OF-101: the Production kit, in place (Kit.tsx untouched)

/**
 * F-SA-237 (sales page plan N9, picks P14, R7; 10-order-page §2.7) — Files: every file of the order by where it comes from, the SAME
 * body as the thread's Files window on this order, from the SAME walled read (`GET /sales/orders/:orderId/files`): who can see each
 * file, where it sits, "also on …" as the read names it, Open through the order's own route, Open in the conversation (the dock shows
 * and scrolls to the message), Download N · Share N own; "N files you cannot open", counted, never named. F-OP-125–127: the files are
 * cards with lazy previews, and Open shows them in the ONE viewer the body draws from the page's container (← / → every file in display
 * order; body data only when asked, its opening recorded; Esc gives the focus back to the card; "Go to message" shows it in the dock).
 *
 * F-OF-101 (order FILES tab, 10-design §1–§5; plan D1): the tab's LAYOUT — its root is the Production kit's size container (`fw-pt`, the
 * sections choose by the room the tab has, never the screen: the thread dock opening or closing re-lays it at once). Under the tab's one
 * answer (a DS Banner, no card), the Files section (#files): h2 · its answer ("23 files · 13 shared with <customer> · newest 21 Nov") ·
 * [Add files…] (F-OF-103; hidden without the right) · ⋯ (Choose all · Download all · Copy link to Files) · ONE ⓘ (what it means and its
 * keys, nowhere else); the counted line, the groups and the upload window are the body's (the same in the order's thread window).
 * Draws its model; reads nothing.
 */
export function FilesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: { readonly files?: FilesViewActions } }) {
  const frame = useRecordFrame()
  const files: OrderFilesModel = model.files ?? { read: null, problem: null, selected: [], canShare: false }
  const showMessage = (messageId: string) => {
    frame?.showThread?.()
    // The docked thread draws the message; scroll to it once it is there.
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
      target?.scrollIntoView({ block: 'center' })
      target?.focus()
    }, 120)
  }
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const party = order.party ? { name: order.party.legalName } : null
  return (
    <WithMessages namespaces={ORDER_FILES_NS}>
      <div className="fw-pt fw-of">
        {files.read && !files.problem && <FilesHead read={files.read} readOnly={readOnly} />}
        <FilesSection files={files} party={party} actions={actions?.files}>
          <OrderFilesBody model={files} party={party} actions={{ ...actions?.files, onOrderMessage: showMessage }} />
        </FilesSection>
      </div>
    </WithMessages>
  )
}

/** F-OF-101: the kit's Section names the addresses of the tabs it was made for in its type; this tab's pass through it as they are. */
const filesKitId = (id: 'files'): SectionId => id as string as SectionId

/**
 * F-OF-101 (10-design §3): the tab's one answer above its sections — "23 files on this order · 1 file is being checked for viruses." —
 * in the case's tone; and once for the whole tab, for a reader who changes nothing on the page, "Read-only: …".
 */
function FilesHead({ read, readOnly }: { read: OrderFilesRead; readOnly: boolean }) {
  const t = useT(FILES_VIEW_NS)
  const answer = tabAnswerOf(read, orderCountedOf(read, orderSectionsOf(read)))
  const icon = answer.tone === 'warning' ? <ShieldAlert size={18} aria-hidden /> : <FileText size={18} aria-hidden />
  return (
    <Banner className="fw-of-head" tone={answer.tone} icon={icon} title={`${answer.parts.map((part) => t(part.key, part.params)).join(' · ')}.`}>
      {readOnly ? (
        <span className="fw-of-head-wall">
          <Eye size={13} aria-hidden /> {t('tab.readOnly')}
        </span>
      ) : null}
    </Banner>
  )
}

/**
 * F-OF-101 (10-design §5): the Files section (#files) — its answer in the reader's own numbers, its ⋯ and its ⓘ; the body below. The
 * menu's acts are the body's own (choose, download): one path per job.
 */
function FilesSection({ files, party, actions, children }: { files: OrderFilesModel; party: { readonly name: string } | null; actions?: FilesViewActions | undefined; children: ReactNode }) {
  const t = useT(FILES_VIEW_NS)
  const o = useT('orders')
  const locale = useLocale()
  const read = files.problem ? null : files.read
  const sections = read ? orderSectionsOf(read) : []
  const counted = read ? orderCountedOf(read, sections) : null
  const choosable = orderChoosableOf(sections).map((file) => file.id)
  const answer = read ? filesAnswerOf(sections) : null
  const words: string[] = []
  if (answer && answer.count > 0) {
    words.push(t('answer.count', { count: answer.count }))
    if (party) words.push(answer.shared > 0 ? t('answer.shared', { count: answer.shared, party: party.name }) : t('answer.noneShared', { party: party.name }))
    if (answer.newest) words.push(t('answer.newest', { date: formatDate(answer.newest, { locale }) }))
  } else if (answer) words.push(counted && counted.locked > 0 ? t('answer.noneOpen') : files.may?.upload ? t('answer.emptyAdd') : t('order.empty.title'))
  const items: MenuItemDef[] = []
  if (choosable.length > 0) items.push({ id: 'choose-all', label: t('select.all', { count: choosable.length }), onSelect: () => actions?.onOrderSelect?.(choosable) })
  if (choosable.length > 1) items.push({ id: 'download-all', label: t('menu.downloadAll', { count: choosable.length }), onSelect: () => actions?.onOrderBulk?.('download', choosable) })
  items.push({ id: 'copy-link', label: t('menu.copyLink'), onSelect: () => copyLinkTo('files') })
  // F-OF-103: "Add files…" — hidden without the right (the read's `may`, else the session's); allowed on a closed order (L2: a late paper lands).
  const buttons = files.may?.upload && actions?.onOrderAdd && !files.problem
    ? [
        <Button key="add" size="sm" onClick={() => actions.onOrderAdd?.([])}>
          <Upload size={14} aria-hidden /> {t('files.add')}
        </Button>,
      ]
    : []
  const info = (
    <>
      <p>{t('info.files')}</p>
      <p>{t('info.doors')}</p>
      <p>{t('info.keys')}</p>
    </>
  )
  return (
    <Section id={filesKitId('files')} title={o('files.title')} answer={words.length > 0 ? words.join(' · ') : null} buttons={buttons} more={<LineMenuButton label={t('menu.label')} items={items} />} info={info}>
      {children}
    </Section>
  )
}
