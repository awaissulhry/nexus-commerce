'use client'

/**
 * Reviews › Requests › "Preview email" — our email to Shopify buyers, as the buyer sees it
 * (`GET /api/review-emails/preview`: nothing is sent, nothing is written). Pickers: rule, market, language, and which
 * email (the review request, or the "How was it?" check). "Send a test to me" sends ONE real email to the signed-in
 * person (asks first; no order is touched). "Dry run" lists what the next run would send now (nothing is sent).
 * Amazon buyers never get this email: Amazon sends its own. eBay buyers get no email from Nexus (Owner, 2026-10-27):
 * an eBay rule or order shows that note instead of an email.
 *
 * N3 — a rule with its own text shows that text for the language picked ("Text": whose words they are). From the rule
 * editor (`draft`) it shows the editor's unsaved text: `reviewsSend('POST', '/review-emails/preview', { draft, text })`
 * (checked by the API as a save is; nothing is sent), and "Send a test to me" sends those words to you.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuleEmailText } from '@nexus/shared/review-request-text'
import { Mail, Play } from 'lucide-react'
import { Banner, Field, KeyValue, Listbox, Modal, SummaryTable, useActionConfirm, useToast } from '@/design-system/components'
import { Button, SegmentedControl, Skeleton } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { reviewsGet, reviewsSend } from '../../_lib/reviewsFetch'
import { EBAY_NOT_EMAILED, channelMarketWords } from '../../_lib/reviewWords'
import { rulePath } from '../requestsPaths'
import { readQueuePage, type QueueRow, type SendingState } from './queueDatasource'
import { marketName } from './queueTiles'
import s from './queue.module.css'

/** Amazon's own request, in the Owner's words (ruling 5). */
export const AMAZON_EMAIL_WORDS =
  'Amazon sends one standard email, translated into the buyer’s language, asking for a product review and seller feedback. Allowed once per order, 5–30 days after delivery. After that, no review request may go by Buyer-Seller Messaging.'

type Kind = 'request' | 'check'
const KIND_OPTIONS = [
  { value: 'request', label: 'Review request' },
  { value: 'check', label: '“How was it?” check' },
]
const LANGUAGES: Record<Kind, { value: string; label: string }[]> = {
  request: [{ value: 'it', label: 'Italian' }, { value: 'en', label: 'English' }],
  check: [{ value: 'it', label: 'Italian' }, { value: 'de', label: 'German' }, { value: 'fr', label: 'French' }, { value: 'es', label: 'Spanish' }, { value: 'en', label: 'English' }],
}
const MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK']
const NO_RULE_EBAY = 'channel:EBAY'
const NO_RULE_SHOPIFY = 'channel:SHOPIFY'

interface RuleItem { id: string; name: string; scope: string; marketplace: string | null; isActive: boolean }
interface Preview {
  from: string
  subject: string
  html: string
  /** Null when the e-mail is a rule's own words (they have no English copy). */
  englishSubject: string | null
  englishSummary: string | null
  channel: string
  market: string | null
  locale: string
  note: string | null
  /** N3 — "This rule’s own text in Italian" / "The standard text …". */
  textWords?: string | null
}
interface TestAnswer { sentTo: string; ok: boolean; dryRun: boolean; words: string }

export interface EmailPreviewModalProps {
  onClose: () => void
  canManage: boolean
  sending: SendingState | null
  /**
   * N3 — opened from the rule editor: that rule (id null while it is new) with the editor's unsaved text per language
   * (null = the standard text everywhere). The rule picker shows only it.
   */
  draft?: { ruleId: string | null; name: string; text: RuleEmailText | null }
}

const DRAFT_RULE = 'draft'

export function EmailPreviewModal({ onClose, canManage, sending, draft }: EmailPreviewModalProps) {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const [rules, setRules] = useState<RuleItem[] | null>(draft ? [] : null)
  const [pickRule, setPickRule] = useState<string>(draft ? DRAFT_RULE : NO_RULE_SHOPIFY)
  const [market, setMarket] = useState('IT')
  const [kind, setKind] = useState<Kind>('request')
  const [locale, setLocale] = useState('it')
  const [preview, setPreview] = useState<{ key: string; data: Preview | null; error: string | null } | null>(null)
  const [dry, setDry] = useState<{ rows: QueueRow[]; total: number; error: string | null } | null>(null)
  const [busy, setBusy] = useState<'test' | 'dry' | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (draft) return
    let alive = true
    void reviewsGet<{ items: RuleItem[] }>('/review-rules').then((res) => {
      if (!alive) return
      const email = (res.data?.items ?? []).filter((r) => r.scope === 'EBAY' || r.scope === 'SHOPIFY')
      setRules(email)
      // Start on a Shopify rule: eBay buyers get no email from Nexus.
      const shopify = email.filter((r) => r.scope === 'SHOPIFY')
      if (shopify.length) setPickRule(shopify.find((r) => r.isActive)?.id ?? shopify[0].id)
    })
    return () => { alive = false }
  }, [draft])

  const rule = rules?.find((r) => r.id === pickRule) ?? null
  const channel = draft ? 'SHOPIFY' : rule ? rule.scope : pickRule === NO_RULE_EBAY ? 'EBAY' : 'SHOPIFY'
  /** Nexus e-mails no eBay buyer: nothing to preview, test or dry-run for eBay. */
  const ebay = channel === 'EBAY'
  const languages = LANGUAGES[kind]
  const lang = languages.some((l) => l.value === locale) ? locale : languages[0].value
  // The editor's unsaved words for the language shown (null = the standard text), as a stable key.
  const draftText = draft && kind === 'request' ? draft.text?.[lang as 'it' | 'en'] ?? null : null
  const draftKey = draft ? JSON.stringify(draftText) : ''
  const key = `${kind}|${draft ? `draft:${draft.ruleId ?? 'new'}` : rule?.id ?? channel}|${market}|${lang}|${draftKey}`
  /** What the API needs to show or test this e-mail. */
  const pickBody = useMemo(() => (draft
    ? { kind, ruleId: draft.ruleId, channel: 'SHOPIFY', market, locale: lang, ...(kind === 'request' ? { draft: true, text: draftKey ? JSON.parse(draftKey) : null } : {}) }
    : { kind, ruleId: rule?.id ?? null, channel: rule ? null : channel, market, locale: lang }), [draft, kind, rule, channel, market, lang, draftKey])
  const asked = useRef(0)

  const load = useCallback(async () => {
    abort.current?.abort()
    if (ebay) return
    const turn = ++asked.current
    if (draft) {
      // POST (the unsaved text is too long for a link); the last answer asked for wins.
      const res = await reviewsSend<Preview>('POST', '/review-emails/preview', pickBody)
      if (turn === asked.current) setPreview({ key, data: res.data, error: res.error })
      return
    }
    const controller = new AbortController()
    abort.current = controller
    try {
      const res = await reviewsGet<Preview>('/review-emails/preview', pickBody, { signal: controller.signal })
      if (!controller.signal.aborted) setPreview({ key, data: res.data, error: res.error })
    } catch {
      // aborted
    }
  }, [pickBody, key, ebay, draft])
  useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])

  const ruleOptions = useMemo(() => (draft
    ? [{ value: DRAFT_RULE, label: `${draft.name || 'New rule'} (your changes)` }]
    : [
        ...(rules ?? []).map((r) => ({ value: r.id, label: `${r.name}${r.isActive ? '' : ' (off)'}` })),
        { value: NO_RULE_SHOPIFY, label: 'No rule — a Shopify order' },
        { value: NO_RULE_EBAY, label: 'No rule — an eBay order (no email)' },
      ]), [rules, draft])

  const sendTest = useCallback(async () => {
    const ok = await confirm.ask({
      level: 'confirm',
      title: 'Send a test email to yourself?',
      confirmLabel: 'Send test',
      consequences: ['Sends one real email to the address of your Nexus account', 'No order, request or buyer is touched'],
    })
    if (!ok) return
    setBusy('test')
    const res = await reviewsSend<TestAnswer>('POST', '/review-emails/test', pickBody, { idempotent: true, what: 'test email' })
    setBusy(null)
    if (res.error || !res.data) toast(res.error ?? 'The test was not sent.', 'danger')
    else toast(res.data.words, res.data.ok && !res.data.dryRun ? 'success' : 'warning')
  }, [confirm, pickBody, toast])

  const dryRun = useCallback(async () => {
    setBusy('dry')
    const res = await readQueuePage({ status: 'DUE', channel, page: 1, pageSize: 5, period: '30d' })
    setBusy(null)
    setDry({ rows: res.data?.rows ?? [], total: res.data?.total ?? 0, error: res.error })
  }, [channel])

  const current = preview && preview.key === key ? preview : null
  const p = current?.data ?? null
  const testHeld = ebay ? EBAY_NOT_EMAILED : !canManage ? "You need 'Manage reviews' to send a test email." : busy === 'test' ? 'Sending…' : !p ? 'The preview is still loading.' : null

  return (
    <>
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Preview email"
      subtitle="Our email to Shopify buyers, as the buyer sees it"
      footer={(
        <>
          {rule && !draft && (
            <Button asChild size="md">
              <Link href={rulePath(rule.id)}>Open this rule</Link>
            </Button>
          )}
          <span className="grow" />
          <Button onClick={onClose}>Close</Button>
        </>
      )}
    >
      <div className={s.preview}>
        <div className={s.previewPickers}>
          <Field label="Rule">
            {rules ? <Listbox options={ruleOptions} value={pickRule} onChange={setPickRule} ariaLabel="Rule" /> : <Skeleton height={32} />}
          </Field>
          <Field label="Market">
            <Listbox options={MARKETS.map((m) => ({ value: m, label: marketName(m) }))} value={market} onChange={setMarket} ariaLabel="Market" />
          </Field>
          <Field label="Language" hint={kind === 'check' ? 'Italian, German, French or Spanish for those markets, English for the UK and Ireland, Italian for any other.' : 'Italian for Italy, English for every other market.'}>
            <Listbox options={languages} value={lang} onChange={setLocale} ariaLabel="Language" />
          </Field>
          <Field label="Email">
            <SegmentedControl size="sm" ariaLabel="Which email" options={KIND_OPTIONS} value={kind} onChange={(v) => setKind(v as Kind)} />
          </Field>
        </div>

        <Banner tone="info" title="Amazon buyers do not get this email">
          {AMAZON_EMAIL_WORDS} Its text cannot be changed or previewed here.
        </Banner>

        {ebay ? (
          <Banner tone="info" title="eBay buyers get no email from Nexus">{EBAY_NOT_EMAILED}</Banner>
        ) : current?.error ? (
          <Banner tone="danger" title="Could not show this email" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>
            {current.error}
          </Banner>
        ) : !p ? (
          <Skeleton height={320} />
        ) : (
          <div className={s.email}>
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: 'From', value: p.from },
                { label: 'To', value: 'A sample buyer', hint: channelMarketWords(p.channel, p.market) },
                { label: 'Subject', value: p.subject },
                ...(p.textWords ? [{ label: 'Text', value: p.textWords }] : []),
              ]}
            />
            {/* The server's own note (a Shopify e-mail with no review button: the business has no shop). */}
            {p.note && p.channel !== 'AMAZON' && <Banner tone="info" title="No review button">{p.note}</Banner>}
            <iframe className={s.emailFrame} sandbox="" srcDoc={p.html} title="The email as the buyer sees it" />
            {lang !== 'en' && p.englishSubject && (
              <p className={s.muted}>In English: {p.englishSubject} — {p.englishSummary}</p>
            )}
          </div>
        )}

        <div className={s.previewTools}>
          <section className={s.tool} aria-label="Send a test to me">
            <h3 className={s.sectionHead}>Send a test to me</h3>
            <p className={s.muted}>A real email to you; no order is touched.</p>
            <Button size="sm" onClick={() => void sendTest()} heldReason={testHeld}>
              <Mail size={13} aria-hidden /> Send test
            </Button>
          </section>
          <section className={s.tool} aria-label="Dry run">
            <h3 className={s.sectionHead}>Dry run</h3>
            <p className={s.muted}>What the next run would send now on {channelMarketWords(channel)} — nothing is sent.</p>
            <Button size="sm" onClick={() => void dryRun()} heldReason={ebay ? EBAY_NOT_EMAILED : busy === 'dry' ? 'Reading…' : null}>
              <Play size={13} aria-hidden /> Run
            </Button>
            {dry && !ebay && (dry.error ? (
              <p className={s.errorText}>{dry.error}</p>
            ) : (
              <>
                <p>{dry.total === 0 ? 'Nothing is due now.' : `${dry.total} ${dry.total === 1 ? 'request is' : 'requests are'} due now: each gets an email at the next run — the review email, or “How was it?” first where its rule asks that.`}</p>
                {dry.rows.length > 0 && (
                  <SummaryTable label="Due now" columns={['Order', 'Buyer', 'Market']} rows={dry.rows.map((r) => ({ id: r.id, cells: [r.orderLabel, r.buyer, r.market ? marketName(r.market) : '—'] }))} />
                )}
                {dry.total > dry.rows.length && <p className={s.muted}>+ {dry.total - dry.rows.length} more.</p>}
                {sending && <p className={s.muted}>{sending.paused ? 'Sending is paused: nothing goes out until it is resumed.' : 'Sending is on.'}</p>}
              </>
            ))}
          </section>
        </div>
      </div>
    </Modal>
    {confirm.element}
    </>
  )
}
