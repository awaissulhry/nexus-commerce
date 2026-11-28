import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { recordSchema, type DraftRecord } from '../../../../lib/order-draft/schema'
import type { PortalBand } from '../../../shell/frame'
import { shellOf } from '../design-data'
import { ORDER_PAGE_NS } from '../page-words'
import { requestFilesOf, requestFrameOf, type RequestTab } from '../request-record'
import { CustomerCase, type CustomerCaseBuilder } from '../view/CustomerCase'

/**
 * SCR-184-request — owb-po5.2 (lead settle 2: ONE order page for both records): a Draft and a Sent order (a portal order request) in the
 * order's frame, with MADE-UP data only: the band (picture button, "Your order · <subject>" — no number before Confirm —, their PO, the
 * life chip, ONE primary: Draft "Review and send…", Sent "Take it back"), the five tabs, Money and Shipments as one quiet line, the
 * files by kind, a refusal of Take it back in our words, a Designer (no Money tab, Send held with who sends).
 */

const PREFIX = '/p/BRAND-ALPHA'
const ID = '00000000-0000-7000-8000-000000000701'
const words = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][ORDER_PAGE_NS] ?? {})
const file = (n: number, name: string, kind: string, contentType: string) => ({ id: `00000000-0000-7000-8000-0000000007${String(n).padStart(2, '0')}`, lineId: null, originalName: name, kind, contentType, sizeBytes: 20_480, status: 'READY', version: 1, createdAt: '2026-11-20T09:00:00.000Z' })

/** A made-up draft record (the ONE schema of lib/order-draft parses it, as the live read). */
export function draftOf(over: { status?: 'DRAFT' | 'SENT'; seesPrices?: boolean; takeBack?: boolean; send?: boolean } = {}): DraftRecord {
  const status = over.status ?? 'DRAFT'
  return recordSchema.parse({
    request: {
      id: ID,
      number: status === 'SENT' ? 'RQ-2026-0042' : null,
      status,
      source: 'PICKER',
      customerRef: 'PO-ALPHA-118',
      shipToAddressId: null,
      requestedDate: '2027-02-15',
      note: null,
      currency: 'EUR',
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-21T10:00:00.000Z',
      sentAt: status === 'SENT' ? '2026-11-21T10:00:00.000Z' : null,
      decidedAt: null,
      salesOrder: null,
      quote: null,
      version: 4,
      lines: [],
      summary: { lines: 0, pieces: 0 },
      problems: [],
      pricesChanged: 0,
      may: { send: over.send ?? true, withdraw: status === 'SENT', discard: status === 'DRAFT', takeBack: over.takeBack ?? status === 'SENT' },
      subject: 'Race suits for the spring team',
      files: {
        logos: [file(1, 'mockup-front.png', 'LOGO', 'image/png')],
        references: [file(2, 'reference.pdf', 'REFERENCE', 'application/pdf')],
        sheets: [file(3, 'sizes-team.xlsx', 'SHEET', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')],
      },
      picture: { fileId: null, setAt: null, contentType: null },
    },
    addresses: [],
    seesPrices: over.seesPrices ?? true,
  })
}

function requestCase(input: { status?: 'DRAFT' | 'SENT'; tab?: RequestTab; seesPrices?: boolean; designer?: boolean; refused?: boolean } = {}): CustomerCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const record = draftOf({ status: input.status, seesPrices: input.seesPrices, send: !input.designer })
    const frame = requestFrameOf(record, { orderName: t('request.name') }, { mayOrder: !input.designer, mayDraft: true, preview: false })
    const primary =
      frame.primary === 'send'
        ? { id: 'send', label: t('band.send'), variant: 'primary' as const, heldReason: frame.may.send ? null : t('held.mayOrder') }
        : frame.primary === 'takeBack'
          ? { id: 'take-back', label: t('band.takeBack'), variant: 'primary' as const, heldReason: frame.may.takeBack ? null : t('held.takeBack') }
          : null
    const band: PortalBand = {
      title: frame.title,
      back: { href: `${PREFIX}/orders`, label: t('band.back') },
      refs: frame.customerRef ? { theirs: frame.customerRef, ours: null } : null,
      status: { label: '', tone: 'neutral', life: frame.life, note: frame.note },
      picture: { recordId: ID, number: frame.title, onOpen: frame.may.picture ? () => undefined : null },
      actions: primary ? [primary] : [],
    }
    return {
      shell: shellOf(locale, band, { path: `/orders/requests/${ID}` }),
      body: {
        kind: 'request',
        model: {
          state: 'ready',
          frame,
          tab: input.tab ?? 'overview',
          href: `${PREFIX}/orders/requests/${ID}`,
          files: requestFilesOf(record),
          notice: input.refused ? { tone: 'warning', text: t('takeBack.started') } : null,
          draftHref: frame.status === 'DRAFT' ? `${PREFIX}/orders/new?draft=${ID}` : null,
        },
      },
    }
  }
}

export const designScreen = defineDesignScreen<CustomerCaseBuilder>({
  screen: 'SCR-184-request',
  title: 'Your order — a draft or a sent order in the order’s frame (customer portal)',
  view: CustomerCase,
  cases: [
    { id: 'draft', label: 'Draft · Overview: "Your order · <subject>", Review and send…', model: requestCase(), note: 'No number before the factory confirms (settle 3). The picture is a button (camera).' },
    { id: 'draft-lines', label: 'Draft · Lines (round 1: the order window opens it)', model: requestCase({ tab: 'lines' }) },
    { id: 'draft-money', label: 'Draft · Money: one quiet line', model: requestCase({ tab: 'money' }) },
    { id: 'draft-shipments', label: 'Draft · Shipments: one quiet line', model: requestCase({ tab: 'shipments' }) },
    { id: 'draft-files', label: 'Draft · Files by kind (mockups, size files, other)', model: requestCase({ tab: 'files' }) },
    { id: 'sent', label: 'Sent · Take it back', model: requestCase({ status: 'SENT' }), note: 'Until the factory confirms it, the customer can take it back (the number stays).' },
    { id: 'sent-refused', label: 'Sent · Take it back refused in our words (work started)', model: requestCase({ status: 'SENT', refused: true }) },
    { id: 'designer', label: 'The brand’s Designer: no Money tab, Send held with who sends', model: requestCase({ seesPrices: false, designer: true }) },
  ],
})
