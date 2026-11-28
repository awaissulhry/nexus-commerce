'use client'

import type { ReactNode } from 'react'
import { FileText, ShieldAlert, Upload } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { dayWords } from '../../../../../lib/record-thread/files-view/day' // fx5w (W-11): the app's day words
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { FILES_VIEW_NS, OrderFilesBody, ORDER_FILES_NS, type FilesViewActions } from '../../../../../lib/record-thread/files-view/view/FilesView'
import type { OrderFilesModel } from '../../../../../lib/record-thread/files-view/model'
// F-OF-101 (order FILES tab, 10-design §1–§5): the tab's one answer, the Files section's answer and its counted line, from the same read.
import { filesAnswerOf, orderChoosableOf, orderCountedOf, orderSectionsOf, tabAnswerOf, type OrderFilesRead } from '../../../../../lib/record-thread/files-view/model'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import type { Order } from '../../api'
import type { SectionId } from '../production/layout'
import type { OrderRecordModel } from '../record-model'
import { copyLinkTo } from '../shipments/view/hrefs'
import { LineMenuButton } from './LineMenu'
import { Section } from '../../../../../lib/record-sections/Kit' // F-OF-101: the Production kit, in place (Kit.tsx untouched; its Section draws the ONE ⓘ)
// F-OF-201 (order FILES tab W2): "Waiting for files" (#asks) — the band beside the files from 1200 px of the tab's room, above them below.
import { useSearchParams } from 'next/navigation'
import { ASKS_NS, AskButton, AsksBody, useAsksAnswer } from '../../../../../lib/record-thread/files-view/asks/view/AsksBody'
import type { AsksState } from '../../../../../lib/record-thread/files-view/asks/asks'

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
  const party = order.party ? { name: order.party.legalName } : null
  // F-OF-201: the band only once the read sends `asks` (S2); `?tab=files&ask=<id>` marks its row.
  const askParam = useSearchParams()?.get('ask') ?? null
  const asks = files.read && !files.problem && files.read.asks !== undefined && files.asks ? { read: files.read, state: { ...files.asks, focus: askParam } } : null
  return (
    <WithMessages namespaces={ORDER_FILES_NS}>
      <div className="fw-pt fw-of">
        {files.read && !files.problem && <FilesHead read={files.read} />}
        <div className={`fw-of-z${asks ? ' has-asks' : ''}`}>
          {asks && <AsksSection read={asks.read} state={asks.state} actions={actions?.files} customer={party?.name ?? null} />}
          <FilesSection files={files} party={party} actions={actions?.files}>
            <OrderFilesBody model={files} party={party} actions={{ ...actions?.files, onOrderMessage: showMessage }} />
          </FilesSection>
        </div>
      </div>
    </WithMessages>
  )
}

/** F-OF-201: the kit's Section for "Waiting for files" (#asks) — its answer, [Ask for a file…], ⋯ and ONE ⓘ; the rows are the band's. */
const asksKitId = (id: 'asks'): SectionId => id as string as SectionId

function AsksSection({ read, state, actions, customer }: { read: OrderFilesRead; state: AsksState; actions?: FilesViewActions | undefined; customer: string | null }) {
  const t = useT(ASKS_NS)
  const answer = useAsksAnswer(read, state) // fx5w (W-03): the one line
  const items: MenuItemDef[] = [{ id: 'copy-link', label: t('band.menu.copyLink'), onSelect: () => copyLinkTo('asks') }]
  const info = (
    <>
      <p>{t('band.info.what')}</p>
      <p>{t('band.info.who')}</p>
    </>
  )
  return (
    <Section id={asksKitId('asks')} title={t('band.title')} answer={answer} buttons={[<AskButton key="ask" state={state} onAsk={actions?.onAskNew} />]} more={<LineMenuButton label={t('band.menu.label')} items={items} />} info={info}>
      <AsksBody read={read} state={state} actions={actions} customer={customer} />
    </Section>
  )
}

/** F-OF-101: the kit's Section names the addresses of the tabs it was made for in its type; this tab's pass through it as they are. */
const filesKitId = (id: 'files'): SectionId => id as string as SectionId

/**
 * F-OF-101 (10-design §3): the tab's one answer above its sections — "3 files are asked for · 1 arrived — check it · 23 files on this
 * order." — in the case's tone, ONE full stop (fx5w W-01). fx5w (W-06): Read-only is said once, by the page's own banner (as the
 * Shipments tab), not again here.
 */
function FilesHead({ read }: { read: OrderFilesRead }) {
  const t = useT(FILES_VIEW_NS)
  const locale = useLocale()
  const answer = tabAnswerOf(read, orderCountedOf(read, orderSectionsOf(read)))
  const icon = answer.tone === 'warning' ? <ShieldAlert size={18} aria-hidden /> : <FileText size={18} aria-hidden />
  const words = answer.parts.map((part) => t(part.key, part.params?.date ? { ...part.params, date: dayWords(String(part.params.date), locale) } : part.params)).join(' · ')
  return <Banner className="fw-of-head" tone={answer.tone} icon={icon} title={`${words}.`} />
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
    if (answer.newest) words.push(t('answer.newest', { date: dayWords(answer.newest, locale) /* fx5w (W-11) */ }))
  } else if (answer) words.push(counted && counted.locked > 0 ? t('answer.noneOpen') : files.may?.upload ? t('answer.emptyAdd') : t('order.empty.title'))
  const items: MenuItemDef[] = []
  if (choosable.length > 0) items.push({ id: 'choose-all', label: t('select.all', { count: choosable.length }), onSelect: () => actions?.onOrderSelect?.(choosable) })
  if (choosable.length > 1) items.push({ id: 'download-all', label: t('menu.downloadAll', { count: choosable.length }), onSelect: () => actions?.onOrderBulk?.('download', choosable) })
  items.push({ id: 'copy-link', label: t('menu.copyLink'), onSelect: () => copyLinkTo('files') })
  // F-OF-103: "Add files…" — hidden without the right (the read's `may`, else the session's); allowed on a closed order (L2: a late paper lands).
  const buttons = files.may?.upload && actions?.onOrderAdd && !files.problem
    ? [
        <Button key="add" size="sm" onClick={() => actions?.onOrderAdd?.([])}>
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
