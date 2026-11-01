'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, ShieldOff } from 'lucide-react'
import { DetailPopover, EmptyState } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { CheckList as DsCheckList } from '@nexus/ui/patterns/checklist/index'
import { Modal, useDsWords } from '../../../lib/i18n/ds-parts'
import { listKeys, type ListKey } from '../../../list-frame/model'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { quantity, type Phrase } from '../../_shared/stock/model'
import type { HeldEntry, KitStatus, PickRow, ReadinessMaterial } from './api'
import { heldPhrase, KIT_TONE, materialReason, PICKING_NAMESPACES, popoverMaterials, READINESS_TONE, readinessKey } from './model'
import '../../_shared/stock/stock.css'
import './picking.css'

/**
 * View parts Warehouse › Picking & kits (SCR-237) shares between the page, the pick list dialog and the paper: the
 * catalogue wrapper and its words (`warehouse-picking`, `stock:<key>` for the shared stock words), the readiness word as
 * a button with its popover (pk-ready "Why 'Delayed'": each material's reason, Open PO, Buy), the kit pill, a quantity
 * with its unit, a held entry in words, the check list (the DS CheckList, the design's ReadinessChecklist), the page's
 * no-permission state and the keys list behind `?`.
 */

export function PickingMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={PICKING_NAMESPACES}>{children}</WithMessages>
}

export type Words = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The page's words: keys of `warehouse-picking`, and `stock:<key>` for the shared stock words (units, problems, live). */
export function useWords(): Words {
  const own = useT('warehouse-picking')
  const stock = useT('stock')
  return useMemo<Words>(() => (key, params) => (key.startsWith('stock:') ? stock(key.slice(6), params) : own(key, params)), [own, stock])
}

export const say = (t: Words, phrase: Phrase | null | undefined): string | null => (phrase ? t(phrase.key, phrase.params) : null)

/** A quantity in the person's language with its unit ("48,2 ft²"). */
export function useQty(): (value: string | number | null | undefined, uom: string) => string {
  const t = useWords()
  const locale = useLocale()
  return (value, uom) => `${quantity(value, locale)} ${t(`stock:uom.${uom}`)}`
}

/** The readiness word in words, with its date for "Expected 3 Nov". */
export function useReadinessWord(): (word: PickRow['readiness']['word'], date: string | null) => string {
  const t = useWords()
  const locale = useLocale()
  return (word, date) => {
    const key = readinessKey(word, date)
    return t(key.key, key.params?.date ? { date: formatDate(String(key.params.date), { locale }) } : undefined)
  }
}

/** One material's reason in our words (dates in the person's language). */
export function useMaterialReason(): (material: ReadinessMaterial) => string {
  const t = useWords()
  const locale = useLocale()
  const qty = useQty()
  return (material) => {
    const reason = materialReason(material)
    const params = reason.params ?? {}
    return t(reason.key, {
      material: String(params.material ?? ''),
      po: String(params.po ?? ''),
      short: qty(String(params.short ?? '0'), material.uom),
      inStock: qty(String(params.inStock ?? '0'), material.uom),
      onOrder: qty(String(params.onOrder ?? '0'), material.uom),
      date: params.date ? formatDate(String(params.date), { locale }) : '—',
    })
  }
}

export interface ReadinessLinks {
  /** "Open PO": the purchase order's page; null without purchasing.view. */
  order: ((id: string) => string) | null
  /** "Buy": What to buy & make; null without planning.view. */
  buy: string | null
}

/** The readiness word as a button: its popover says why, material by material, with Open PO and Buy (pk-ready). */
export function ReadinessButton({ row, links, open, onOpenChange }: { row: PickRow; links: ReadinessLinks; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const t = useWords()
  const word = useReadinessWord()
  const reason = useMaterialReason()
  const text = word(row.readiness.word, row.readiness.date)
  const materials = popoverMaterials(row)
  return (
    <DetailPopover
      trigger={<Pill tone={READINESS_TONE[row.readiness.word]}>{text}</Pill>}
      triggerLabel={t('ready.why', { word: text, number: row.workOrder.number })}
      triggerClassName="fw-pk-ready-trigger"
      label={t('ready.title', { word: text })}
      hoverDelay={0}
      panelClassName="nds-detailpop-scroll"
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="fw-pk-ready">
        <p className="fw-pk-ready-head">{t('ready.title', { word: text })}</p>
        {materials.length === 0 ? (
          <p className="fw-st-sub">{t('ready.noMaterials')}</p>
        ) : (
          <ul className="fw-pk-ready-list">
            {materials.map((material) => (
              <li key={`${material.itemId}|${material.itemColourId ?? '-'}`}>
                <span className="fw-pk-ready-word">
                  <Pill tone={READINESS_TONE[material.word]}>{word(material.word, material.date)}</Pill>
                </span>
                <span>{reason(material)}</span>
                {(material.purchaseOrders.length > 0 || ((material.word === 'NOT_ENOUGH' || material.word === 'DELAYED') && links.buy)) && (
                  <span className="fw-pk-ready-links">
                    {links.order &&
                      material.purchaseOrders.map((order) => (
                        <Link key={order.id} href={links.order!(order.id)}>
                          {t('ready.openPo', { po: order.number })}
                        </Link>
                      ))}
                    {(material.word === 'NOT_ENOUGH' || material.word === 'DELAYED') && links.buy && <Link href={links.buy}>{t('ready.buy')}</Link>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="fw-st-sub">{t('ready.foot')}</p>
      </div>
    </DetailPopover>
  )
}

export function KitPill({ status }: { status: KitStatus }) {
  const t = useWords()
  return <Pill tone={KIT_TONE[status]}>{t(`kit.status.${status}`)}</Pill>
}

/** A held entry in words (a lot that is not released, or a quality hold of a lot or a hide, with its reason and day). */
export function useHeldWords(): (entry: HeldEntry) => string {
  const t = useWords()
  const locale = useLocale()
  return (entry) => {
    const words = heldPhrase(entry, locale === 'it' ? 'it' : 'en')
    const params = { ...(words.params ?? {}) }
    if (typeof params.since === 'string') params.since = formatDate(params.since, { locale })
    return t(words.key, params)
  }
}

/** The check list = the DS CheckList (B-W2b-18; the design's ReadinessChecklist): Done or Open, and the words of each line. */
export function CheckList({ items, label }: { items: readonly { id: string; ok: boolean; words: string }[]; label: string }) {
  const ds = useDsWords()
  return <DsCheckList label={label} summary={false} labels={ds.checkList} checks={items.map((item) => ({ id: item.id, state: item.ok ? 'pass' : 'fail', name: item.words }))} />
}

export function NoPickingAccess() {
  const t = useWords()
  return <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('stock:problem.forbidden')} description={t('stock:problem.noPermission', { permission: 'inventory.stock.view' })} />
}

export function KeysModal({ own, onClose }: { own: readonly ListKey[]; onClose: () => void }) {
  const t = useWords()
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <ul className="fw-pk-keys">
        {listKeys(own, true).map((entry) => (
          <li key={`${entry.keys.join('+')}-${entry.does}`}>
            <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

export const NewTabIcon = () => <ExternalLink size={13} aria-hidden />
