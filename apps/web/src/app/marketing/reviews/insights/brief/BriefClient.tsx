'use client'

/**
 * Reviews › Insights › Brief (`/marketing/reviews/insights/brief`, build spec §3.4, the Brief board): what buyers tell
 * you, written as a short brief for one scope.
 *
 *   Header   "Brief for" = the channel-and-market picker, each choice saying whether a brief exists; the period
 *   Brief    the newest brief of exactly that scope (`GET /api/reviews/spotlight`), or an earlier one read-only
 *            (`?brief=<id>`): headline, numbered findings with their trend and evidence links, a before / now table,
 *            when and from what it was made. "Copy as text".
 *   Generate `POST …/reviews/spotlight/generate` (keyed; about 30 seconds, a small AI cost, 10 a day per business): held
 *            without "Manage reviews", at 10 a day and under 20 reviews and Amazon topic mentions — each says why. While
 *            it writes, the old brief dims under a progress bar; Cancel stops waiting here.
 *   Aside    earlier briefs (Open), and what a brief takes, costs and needs
 * The brief never sees Amazon review text: only Amazon's English topics and reviews a person imported (ruling 5).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, FileText, Sparkles } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, ProgressBar, SummaryTable, ToastProvider, useToast } from '@/design-system/components'
import { Button, Pill } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { InsightsHeader } from '../_shared/InsightsHeader'
import { periodWords, scopeLabel } from '../_shared/insightsScope'
import { useAddressSync, useInsightsRead, useInsightsScope, useScopeChoices } from '../_shared/useInsights'
import {
  TREND_WORDS,
  briefEyebrow,
  briefMeta,
  briefText,
  changeDelta,
  changeValue,
  costWords,
  emptyBrief,
  evidenceLinks,
  generateHeld,
  generateLabel,
  generatedWords,
  historyWords,
  type HistoryRow,
  type ScopesAnswer,
  type Spotlight,
} from './briefModel'
import shared from '../_shared/insights.module.css'
import s from './brief.module.css'

export function BriefClient() {
  return (
    <ToastProvider>
      <Brief />
    </ToastProvider>
  )
}

function Brief() {
  const { status: authStatus, has } = useAuth()
  const canManage = authStatus !== 'authed' || has('reviews.manage')
  const { toast } = useToast()
  const { scope, initial, setScope } = useInsightsScope()

  // ── The address: an earlier brief (read-only) ──
  const [reading, setReading] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!initial) return
    setReading((initial.get('brief') ?? '').trim() || null)
  }, [initial])
  useAddressSync(reading !== undefined ? scope : null, { brief: reading ?? null })
  // A new scope shows that scope's newest brief.
  const scopeKey = scope ? `${scope.channel}|${scope.market}` : ''
  const lastScope = useRef(scopeKey)
  useEffect(() => {
    if (lastScope.current === scopeKey) return
    const first = lastScope.current === ''
    lastScope.current = scopeKey
    if (!first) setReading(null)
  }, [scopeKey])

  const ready = !!scope && reading !== undefined
  const read = useInsightsRead<{ spotlight: Spotlight | null }>(
    ready ? '/reviews/spotlight' : null,
    reading ? { id: reading } : { channel: scope?.channel, marketplace: scope?.market },
    ['review.brief.generated'],
  )
  const scopesRead = useScopeChoices(scope?.period ?? null)
  const scopes = scopesRead.data as ScopesAnswer | null
  const history = useInsightsRead<{ items: HistoryRow[] }>(ready ? '/reviews/spotlight/history' : null, { limit: 10 }, ['review.brief.generated'])
  const brief = read.data?.spotlight ?? null

  // ── Generate ──
  const [writing, setWriting] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const attempt = useRef(0)
  const generate = useCallback(async () => {
    if (!scope) return
    const mine = ++attempt.current
    setWriting(true)
    setGenError(null)
    const res = await reviewsSend<{ ok: boolean; spotlight: Spotlight }>(
      'POST',
      '/reviews/spotlight/generate',
      { channel: scope.channel, marketplace: scope.market, period: scope.period },
      { idempotent: true, what: 'brief' },
    )
    if (mine !== attempt.current) return
    setWriting(false)
    if (res.error || !res.data) return setGenError(res.error ?? 'Nexus could not write the brief.')
    emitInvalidation({ type: 'review.brief.generated', id: res.data.spotlight.id })
    setReading(null)
    toast(generatedWords(res.data.spotlight), 'success')
  }, [scope, toast])
  const cancel = useCallback(() => {
    attempt.current += 1
    setWriting(false)
    toast('Stopped waiting. If Nexus had already started, the brief may still appear here and counts toward today’s 10.', 'info')
  }, [toast])

  const copy = useCallback(async () => {
    if (!brief || !scope) return
    try {
      await navigator.clipboard.writeText(briefText(brief, scope))
      toast('The brief is copied as text.', 'success')
    } catch {
      toast('The browser did not allow copying. Select the text and copy it instead.', 'warning')
    }
  }, [brief, scope, toast])

  const held = scope ? generateHeld({ canManage, writing, scopes, scope }) : 'Wait until the page has loaded.'
  const empty = scope ? emptyBrief(scopes, scope) : null
  const subtitle = !scope ? 'Loading…' : `What buyers tell you, written as a brief · ${scopeLabel(scope)} · ${periodWords(scope.period).label}`

  return (
    <div className={shared.page}>
      <InsightsHeader
        scope={scope}
        onScope={setScope}
        subtitle={subtitle}
        choices={scopes?.options ?? []}
        notes
        pickerLabel="Brief for which channel and market"
      />

      {reading && (
        <Banner tone="info" title="You are reading an earlier brief" action={<Button size="sm" onClick={() => setReading(null)}><ArrowLeft size={13} aria-hidden /> Back to the newest</Button>}>
          Earlier briefs are read-only: they show what was true when they were written.
        </Banner>
      )}

      <div className={shared.split}>
        <div className={shared.column}>
          <Card padded>
            <article className={s.brief} aria-labelledby="insights-brief-headline" aria-busy={writing}>
              <div className={s.briefHead}>
                <div className={shared.stack}>
                  <span className={shared.sub}>{scope ? briefEyebrow(brief, scope) : 'Voice of the customer'}</span>
                  <h2 id="insights-brief-headline" className={s.headline}>
                    {read.loading ? 'Reading…' : brief ? brief.headline ?? 'Brief' : empty?.headline ?? 'No brief yet'}
                  </h2>
                  {brief && <p className={shared.muted}>{briefMeta(brief)}</p>}
                </div>
                <div className={s.briefActions}>
                  <span className={shared.actions}>
                    {brief && <Button size="sm" onClick={() => void copy()}><Copy size={13} aria-hidden /> Copy as text</Button>}
                    <Button size="sm" variant="primary" heldReason={held} onClick={() => void generate()} aria-describedby="insights-brief-cost">
                      <Sparkles size={13} aria-hidden /> {writing ? 'Writing…' : generateLabel(brief)}
                    </Button>
                  </span>
                  <span id="insights-brief-cost" className={shared.sub}>{costWords(scopes)}</span>
                </div>
              </div>

              {writing && (
                <div className={s.writing} role="status">
                  <ProgressBar indeterminate ariaLabel="Writing a new brief" />
                  <span className={shared.line}>
                    <span>Writing a new brief from the period’s reviews and Amazon topics. You can leave this page; it appears here when it is ready.</span>
                    <Button size="sm" onClick={cancel}>Cancel</Button>
                  </span>
                </div>
              )}
              {genError && <Banner tone="warning" title="No new brief">{genError}</Banner>}
              {read.error && !brief && (
                <Banner tone="danger" title="Couldn’t read the brief" action={<Button size="sm" onClick={read.reload}>Try again</Button>}>{read.error}</Banner>
              )}

              {brief && scope ? (
                <div className={writing ? s.dim : undefined}>
                  <section aria-labelledby="insights-brief-findings" className={s.section}>
                    <h3 id="insights-brief-findings" className={s.sectionHead}>What buyers tell you</h3>
                    {(brief.content.findings ?? []).length === 0 ? (
                      <p className={shared.muted}>This brief has no numbered findings (it was written before they were added). Generate it again for them.</p>
                    ) : (
                      <ol className={s.findings}>
                        {(brief.content.findings ?? []).map((f) => (
                          <li key={f.n} className={s.finding}>
                            <span className={s.findingN} aria-hidden>{f.n}</span>
                            <div className={shared.stack}>
                              <span className={shared.line}><b>{f.title}</b><Pill tone={TREND_WORDS[f.trend].tone}>{TREND_WORDS[f.trend].word}</Pill></span>
                              <p>{f.text}</p>
                              {f.evidence.length > 0 && (
                                <span className={shared.line}>
                                  <span className={shared.sub}>Evidence:</span>
                                  {evidenceLinks(f, scope).map((l) => <Button key={l.label} asChild size="sm" variant="link"><Link href={l.href}>{l.label}</Link></Button>)}
                                </span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                  {(brief.content.changes ?? []).length > 0 && (
                    <section aria-labelledby="insights-brief-changes" className={s.section}>
                      <h3 id="insights-brief-changes" className={s.sectionHead}>What changed since {periodWords(scope.period).before}</h3>
                      <SummaryTable
                        label="What changed"
                        columns={['Measure', 'Before', 'Now', 'Change']}
                        rows={(brief.content.changes ?? []).map((c) => {
                          const d = changeDelta(c)
                          return {
                            id: c.key,
                            cells: [c.what, changeValue(c.before, c.unit), changeValue(c.now, c.unit), <span key="d" className={d.tone === 'bad' ? shared.bad : d.tone === 'good' ? shared.good : undefined}>{d.text}</span>],
                          }
                        })}
                      />
                    </section>
                  )}
                  <p className={shared.footnote}>
                    Written from the review text of eBay, Shopify and imported reviews, and from Amazon’s English topics. It never sees Amazon
                    review text. Check a finding through its evidence before you act on it.
                  </p>
                </div>
              ) : !read.loading && empty && !read.error ? (
                <EmptyState icon={<FileText size={20} aria-hidden />} title={empty.title} description={empty.text} />
              ) : null}
            </article>
          </Card>
        </div>

        <aside className={shared.aside} aria-label="About the brief">
          <Card header="Earlier briefs">
            {history.error && !history.data ? (
              <p className={shared.muted}>{history.error}</p>
            ) : !history.data ? (
              <p className={shared.muted}>Reading…</p>
            ) : history.data.items.length === 0 ? (
              <p className={shared.muted}>No brief written yet.</p>
            ) : (
              <ul className={s.history}>
                {history.data.items.map((h) => {
                  const w = historyWords(h)
                  return (
                    <li key={h.id}>
                      <span className={shared.stack}><b>{w.date}</b><span className={shared.sub}>{w.scope}</span></span>
                      {brief?.id === h.id
                        ? <Pill tone="info">Shown</Pill>
                        : <Button size="sm" variant="link" onClick={() => setReading(h.id)}>Open</Button>}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
          <Card header="About a brief">
            <KeyValue
              dense
              items={[
                { label: 'Takes', value: 'About 30 seconds' },
                { label: 'Costs', value: 'A small AI cost each time' },
                { label: 'Limit', value: scopes ? `${scopes.limit.perDay} a day for this business · ${scopes.limit.usedToday} used today` : '10 a day for this business' },
                { label: 'Needs', value: `At least ${scopes?.minReviews ?? 20} reviews and Amazon topic mentions in the period` },
                { label: 'Who can make one', value: 'People who may manage reviews' },
              ]}
            />
          </Card>
        </aside>
      </div>
    </div>
  )
}
