'use client'

import { AlertTriangle, FileSpreadsheet, History, Inbox, Lock, RotateCcw, ShieldAlert, Shirt } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { RequestCompose, type RequestComposeActions, type RequestComposeModel } from '../../../../lib/request-compose/view/RequestCompose'
import { useOrderingWords } from '../words'
// B-TH-304: the catalogue door in the side column.
import type { CatalogueDoor } from '../request-model'
import type { Way } from '../model'
import '../neworder.css'

/**
 * SCR-185 › New order, the request like an e-mail (B-TH-220, B-TH-303; threads plan P-CUS-NEW head, message, files, details,
 * send, receipt — pictures 18 and 19, drawn to the approved look): held BEFORE typing when the company takes no request yet
 * (the API's own words, B-TH-012) or the person may not order (who can give the right); else the compose (lib/request-compose)
 * with, from 1280 px, "Your open requests" (the last five, true states, the customer's own numbers) and the pointer to
 * returns, complaints, repairs and safety reports beside it (B-TH-304: and "Order from the catalogue", the door's three ways);
 * after Send the receipt: "Received — your request 7." (the customer's own count, never the office's INQ-… series), what was
 * sent, Open the request, New order, no answer-time promise.
 */

export interface OpenRequestItem {
  id: string
  href: string
  /** "Your request 7" or null. */
  yours: string | null
  subject: string
  state: { words: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
  /** When it last moved, written. */
  when: string
}

export interface RequestReceipt {
  /** The customer's own number of the request (7 in "your request 7"), or null. */
  seq: number | null
  subject: string
  message: string
  customerRef: string | null
  wantedDate: string | null
  shipTo: string | null
  at: string
  requestHref: string
}

export interface RequestPageModel {
  phase: 'loading' | 'compose' | 'closed' | 'noRight' | 'sent'
  prefix: string
  /** The API's words for a company that takes no request yet (B-TH-012), in the page's language. */
  closedWords: string | null
  /** Who can give the right to order (their admins). */
  admins: readonly string[]
  /** GET /portal/inquiries/open could not be read: the compose stays, Send tells. */
  openCheckFailed: boolean
  compose: RequestComposeModel | null
  aside: {
    open: { state: 'loading' | 'error' | 'ready' | 'none'; items: readonly OpenRequestItem[] }
    allHref: string | null
    returnsHref: string | null
    /** B-TH-304: "Order from the catalogue" — the door's three ways (null: closed). */
    catalogue?: CatalogueDoor | null
  }
  receipt: RequestReceipt | null
  discardOpen: boolean
}

export interface RequestPageActions {
  compose?: RequestComposeActions
  onRetryOpen?: () => void
  onRetryList?: () => void
  onAsk?: () => void
  onNewOrder?: () => void
  onDiscardConfirm?: () => void
  onDiscardCancel?: () => void
}

export function RequestPageView({ model, actions, day }: { model: RequestPageModel; actions?: RequestPageActions; day: (iso: string) => string }) {
  const { t } = useOrderingWords()
  const ds = useDsWords()

  if (model.phase === 'loading') {
    return (
      <div className="fw-pno" role="status" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton height={56} />
        <Skeleton height={320} />
      </div>
    )
  }

  if (model.phase === 'closed') {
    return (
      <div className="fw-pno">
        <EmptyState
          icon={<Lock size={24} aria-hidden />}
          title={t('request.closedTitle')}
          description={model.closedWords ?? t('request.closedBody')}
          action={
            <Button variant="primary" onClick={() => actions?.onAsk?.()}>
              {t('request.ask')}
            </Button>
          }
        />
      </div>
    )
  }

  if (model.phase === 'noRight') {
    return (
      <div className="fw-pno">
        <EmptyState
          icon={<Lock size={24} aria-hidden />}
          title={t('request.noRightTitle')}
          description={model.admins.length > 0 ? t('request.noRightAsk', { names: model.admins.join(', ') }) : t('request.noRightAskUs')}
          action={
            <span className="fw-pno-actions">
              {model.admins.length === 0 ? (
                <Button variant="primary" onClick={() => actions?.onAsk?.()}>
                  {t('request.ask')}
                </Button>
              ) : null}
              <Button asChild>
                <a href={model.prefix}>{t('request.home')}</a>
              </Button>
            </span>
          }
        />
      </div>
    )
  }

  if (model.phase === 'sent' && model.receipt) {
    const receipt = model.receipt
    const facts = [
      { label: t('receipt.subject'), value: receipt.subject },
      ...(receipt.customerRef ? [{ label: t('receipt.ref'), value: receipt.customerRef }] : []),
      ...(receipt.wantedDate ? [{ label: t('receipt.date'), value: day(receipt.wantedDate) }] : []),
      ...(receipt.shipTo ? [{ label: t('receipt.shipTo'), value: receipt.shipTo }] : []),
      { label: t('receipt.at'), value: receipt.at },
    ]
    return (
      <div className="fw-pno">
        <EndState
          title={receipt.seq !== null ? t('receipt.title', { seq: receipt.seq }) : t('receipt.titleNone')}
          body={t('receipt.body', { subject: receipt.subject })}
          next={[t('receipt.next'), t('receipt.copy')]}
          facts={facts}
          actions={[
            { label: t('receipt.open'), href: receipt.requestHref, variant: 'primary' },
            { label: t('receipt.newOrder'), onClick: () => actions?.onNewOrder?.() },
          ]}
          labels={ds.endState}
        >
          <section className="fw-pno-sent" aria-labelledby="fw-pno-sent-title">
            <h3 id="fw-pno-sent-title" className="fw-pno-h3">
              {t('receipt.sent')}
            </h3>
            <p className="fw-pno-message">{receipt.message}</p>
          </section>
          <p className="fw-pno-quiet">
            <RotateCcw size={14} aria-hidden /> {model.aside.returnsHref ? <a href={model.aside.returnsHref}>{t('receipt.returns')}</a> : t('receipt.returns')}
          </p>
        </EndState>
      </div>
    )
  }

  if (!model.compose) return null
  return (
    <div className="fw-pno">
      {model.openCheckFailed ? (
        <Banner
          tone="warning"
          icon={<AlertTriangle size={16} aria-hidden />}
          title={t('request.openFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetryOpen?.()}>
              {t('request.retry')}
            </Button>
          }
        />
      ) : null}
      <RequestCompose model={model.compose} actions={actions?.compose} words={{ day }} aside={<Aside model={model} onRetry={actions?.onRetryList} />} />
      <Modal
        open={model.discardOpen}
        onClose={() => actions?.onDiscardCancel?.()}
        title={t('request.discardTitle')}
        size="sm"
        footer={
          <>
            <span className="grow" />
            <Button onClick={() => actions?.onDiscardCancel?.()}>{t('request.discardCancel')}</Button>
            <Button variant="primary" tone="danger" onClick={() => actions?.onDiscardConfirm?.()}>
              {t('request.discardConfirm')}
            </Button>
          </>
        }
      >
        <p className="fw-pno-dialog-text">{t('request.discardBody')}</p>
      </Modal>
    </div>
  )
}

function Aside({ model, onRetry }: { model: RequestPageModel; onRetry?: () => void }) {
  const { t } = useOrderingWords()
  const open = model.aside.open
  return (
    <>
      {open.state !== 'none' ? (
        <Card padded className="fw-pno-aside">
          <h2 className="fw-pno-h3">{t('request.openTitle')}</h2>
          {open.state === 'loading' ? (
            <div className="fw-pno-stack" role="status" aria-label={t('state.loading')}>
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          ) : open.state === 'error' ? (
            <p className="fw-pno-failed" role="alert">
              <AlertTriangle size={16} aria-hidden />
              <span>{t('request.openFailed')}</span>
              {onRetry ? (
                <Button size="sm" onClick={onRetry}>
                  {t('request.retry')}
                </Button>
              ) : null}
            </p>
          ) : open.items.length === 0 ? (
            <p className="fw-pno-quiet">
              <Inbox size={14} aria-hidden /> {t('request.openEmpty')}
            </p>
          ) : (
            <ul className="fw-pno-openlist" aria-label={t('request.openTitle')}>
              {open.items.map((item) => (
                <li key={item.id}>
                  <a className="fw-pno-openrow" href={item.href}>
                    <span className="fw-pno-openhead">
                      {item.yours ? <span className="fw-pno-yours">{item.yours}</span> : null}
                      <Pill tone={item.state.tone} truncate>
                        {item.state.words}
                      </Pill>
                    </span>
                    <span className="fw-pno-opensubject">{item.subject}</span>
                    <span className="fw-pno-quiet">{item.when}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {model.aside.allHref && open.state === 'ready' && open.items.length > 0 ? <a href={model.aside.allHref}>{t('request.openAll')}</a> : null}
        </Card>
      ) : null}
      {model.aside.catalogue ? <CatalogueDoorCard door={model.aside.catalogue} /> : null}
      <Card padded className="fw-pno-aside">
        <h2 className="fw-pno-h3">{t('request.returnsTitle')}</h2>
        <p className="fw-pno-quiet">{t('request.returnsBody')}</p>
        <p className="fw-pno-quiet">
          <ShieldAlert size={14} aria-hidden /> {t('request.returnsSafety')}
        </p>
        {model.aside.returnsHref ? <a href={model.aside.returnsHref}>{t('request.returnsLink')}</a> : null}
      </Card>
    </>
  )
}

// ── B-TH-304: "Order from the catalogue" (the catalogue door, open again now that catalogue orders land in Incoming) ──────
const WAY_ICON: Readonly<Record<Way, typeof Shirt>> = { pick: Shirt, reorder: History, upload: FileSpreadsheet }

/** The door's three ways, each a real link to its page; one honest line on where it goes, never an answer-time promise. */
function CatalogueDoorCard({ door }: { door: CatalogueDoor }) {
  const { t } = useOrderingWords()
  return (
    <Card padded className="fw-pno-aside">
      <h2 className="fw-pno-h3">{t('request.catalogueTitle')}</h2>
      <p className="fw-pno-quiet">{t('request.catalogueBody')}</p>
      <ul className="fw-pno-openlist" aria-label={t('request.catalogueTitle')}>
        {door.ways.map(({ way, href }) => {
          const Icon = WAY_ICON[way]
          return (
            <li key={way}>
              <a className="fw-pno-openrow" href={href}>
                <span className="fw-pno-openhead">
                  <Icon size={16} aria-hidden /> <span className="fw-pno-opensubject">{t(`start.way.${way}`)}</span>
                </span>
                <span className="fw-pno-quiet">{t(`start.wayHint.${way}`)}</span>
              </a>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
