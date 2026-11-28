'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, CircleCheck, Repeat, X } from 'lucide-react'
import { Button, Textarea } from '@nexus/ui/primitives'
import { Banner, Modal } from '@nexus/ui/components'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { acceptSales, listOrderRequests, refuseRequest, type BrandRequest } from '../../../../../home/approvals/requests/api'
import type { SheetRowRead } from '../api'
import { askAnswerOf, askEntriesOf, type AskEntry } from '../asks'
import { NS } from '../map'
import { refusalWordsOf } from '../use-office-sheet'

/**
 * owb-of3 step 4 — the window "The customer asks n changes" (the chip "n to answer"): each ask with from → to, who asked and when;
 * No (with the words the customer reads) · Yes, change it — today's change-request answers. "Every ask is answered." when none is left.
 */
export function AsksWindow({ row, onClose, onDone }: { row: SheetRowRead; onClose: () => void; onDone: (words: string | null) => void }) {
  const api = useOfficeApi()
  const t = useT(NS)
  const locale = useLocale()
  const [requests, setRequests] = useState<readonly BrandRequest[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set())
  const [saying, setSaying] = useState<string | null>(null)
  const [words, setWords] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    const control = new AbortController()
    listOrderRequests(api, row.id, control.signal)
      .then(setRequests)
      .catch((error: unknown) => {
        if (!control.signal.aborted) {
          setRequests([])
          setProblem(refusalWordsOf(error, t))
        }
      })
    return () => control.abort()
  }, [api, row.id, t])

  const entries = askEntriesOf(row, requests ?? []).filter((entry) => !answered.has(entry.ask.requestId))
  const answer = async (entry: AskEntry, yes: boolean) => {
    const plan = askAnswerOf(entry, yes, words)
    if (plan.call === 'none') {
      setProblem(t(plan.why === 'noWords' ? 'office.asks.needWords' : 'office.asks.notRead'))
      return
    }
    setBusy(entry.ask.requestId)
    setProblem(null)
    try {
      if (plan.call === 'accept') await acceptSales(api, plan.requestId, plan.body)
      else await refuseRequest(api, plan.request, plan.body)
      setAnswered((current) => new Set([...current, entry.ask.requestId]))
      setSaying(null)
      setWords('')
    } catch (error) {
      setProblem(refusalWordsOf(error, t))
    } finally {
      setBusy(null)
    }
  }
  const close = () => (answered.size > 0 ? onDone(t('office.asks.done', { count: answered.size })) : onClose())
  const total = askEntriesOf(row, []).length

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('office.asks.title', { count: total })}
      subtitle={`${row.number ?? ''} · ${row.subject ?? t('part.noSubject')} · ${row.party.name}. ${t('office.asks.nothingBefore')}`}
      footer={
        <Button variant="primary" onClick={close}>
          {t('office.close')}
        </Button>
      }
    >
      {problem && <Banner tone="danger" title={problem} />}
      {requests === null ? (
        <p className="fw-osp-muted">{t('office.reading')}</p>
      ) : entries.length === 0 ? (
        <p className="fw-osp-done">
          <CircleCheck size={16} aria-hidden /> {t('office.asks.none')}
        </p>
      ) : (
        <ul className="fw-osp-asks">
          {entries.map((entry) => (
            <li key={entry.ask.requestId} className="fw-osp-ask">
              <span className="fw-osp-ask-icon" aria-hidden>
                {entry.ask.column === 'cancel' ? <X size={16} /> : <Repeat size={16} />}
              </span>
              <div className="fw-osp-ask-body">
                <p className="fw-osp-strong">{entry.ask.column === 'cancel' ? t('office.asks.cancel') : t('office.asks.what', { column: t(`office.asks.column.${entry.ask.column}`), seq: entry.seq })}</p>
                <p className="fw-osp-fromto">
                  <span className="fw-osp-from">{entry.ask.from}</span>
                  <ArrowRight size={14} aria-label={t('office.asks.to')} />
                  <span className="fw-osp-to">{entry.ask.to}</span>
                </p>
                {entry.request && <p className="fw-osp-muted">{t('office.asks.by', { who: entry.request.askedBy ?? row.party.name, when: formatDateTime(entry.request.askedAt, { locale }) })}</p>}
                {saying === entry.ask.requestId && (
                  <Textarea value={words} onChange={(event) => setWords(event.target.value)} rows={2} aria-label={t('office.asks.noWords')} placeholder={t('office.asks.noWords')} />
                )}
              </div>
              <span className="fw-osp-ask-acts">
                {saying === entry.ask.requestId ? (
                  <Button size="sm" disabled={busy !== null} onClick={() => void answer(entry, false)}>
                    {t('office.asks.sendNo')}
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy !== null} onClick={() => { setSaying(entry.ask.requestId); setWords('') }}>
                    {t('office.asks.no')}
                  </Button>
                )}
                <Button size="sm" variant="primary" disabled={busy !== null || !entry.request} onClick={() => void answer(entry, true)}>
                  {t('office.asks.yes')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
