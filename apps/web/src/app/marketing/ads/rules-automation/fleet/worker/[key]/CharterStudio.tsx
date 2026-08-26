'use client'

/**
 * NAF.AC — Charter Studio: the operator's control surface for how a worker
 * thinks. Edit the prompt, diff it against what is running, try it against
 * today's real evidence (writing nothing), measure it against the charter
 * it would replace, then activate — or roll back to any earlier revision,
 * or all the way to the charter that ships in the code.
 *
 * Everything here obeys the FX design contract: plain sentences first,
 * effects named on the buttons, and honesty about what a control does.
 */

import { useCallback, useEffect, useState } from 'react'
import { DataGrid } from '@/design-system/components'
import { AlertTriangle, Check, FlaskConical, History, PlayCircle, RotateCcw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, Input, Textarea } from '@/design-system/primitives'
import { Term } from '../../glossary'

interface Revision {
  id: string
  revision: number
  systemPrompt: string
  note: string
  author: string | null
  createdAt: string
  activatedAt: string | null
  supersededAt: string | null
}
interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}
interface RevisionsPayload {
  codePrompt: string
  runningPrompt: string
  source: 'code' | 'revision'
  activeRevisionId: string | null
  revisions: Revision[]
  diffFromCode: DiffLine[]
}
interface PreviewResult {
  ok: boolean
  costUSD?: number
  inputTokens?: number
  outputTokens?: number
  validationError?: string
  previewFindings?: Array<Record<string, unknown>>
}
interface EvalMeasure {
  measure: string
  baseline: number | null
  candidate: number | null
  better: boolean | null
}
interface EvalResult {
  verdict: 'better' | 'worse' | 'inconclusive'
  measures: EvalMeasure[]
  costUSD: number
  baseline: { cases: number }
}

const fmt = (n: number | null): string =>
  n == null ? 'unknown' : n < 1 && n > 0 ? n.toFixed(2) : String(Math.round(n * 100) / 100)

export function CharterStudio({
  workerKey,
  onChanged,
}: {
  workerKey: string
  onChanged: () => void
}) {
  const backend = getBackendUrl()
  const [data, setData] = useState<RevisionsPayload | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [evaluation, setEvaluation] = useState<EvalResult | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const load = useCallback(async () => {
    const r = await fetch(`${backend}/api/agent/fleet/charters/${workerKey}/revisions`, {
      cache: 'no-store',
    })
    if (r.ok) {
      const d = (await r.json()) as RevisionsPayload
      setData(d)
      setDraft((prev) => (prev ? prev : d.runningPrompt))
    }
  }, [backend, workerKey])

  useEffect(() => {
    void load()
  }, [load])

  const call = useCallback(
    async (path: string, body: unknown, label: string): Promise<unknown | null> => {
      setBusy(label)
      setErr(null)
      try {
        const r = await fetch(`${backend}/api/agent/fleet/charters/${workerKey}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = (await r.json().catch(() => null)) as Record<string, unknown> | null
        if (!r.ok) {
          setErr((j?.error as string) ?? `${label}: ${r.status}`)
          return null
        }
        return j
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        return null
      } finally {
        setBusy(null)
      }
    },
    [backend, workerKey],
  )

  if (!data) return <p className="acr-fl-empty">Loading the charter…</p>

  const dirty = draft.trim() !== data.runningPrompt.trim()
  const diff: DiffLine[] = dirty ? lineDiff(data.runningPrompt, draft) : []

  return (
    <div className="acr-cs">
      {err ? (
        <div className="acr-banner err" role="alert">
          <AlertTriangle size={14} /> {err}
        </div>
      ) : null}

      <p className="acr-fl-sub">
        This is the instruction the worker receives on every run. Editing it here writes a new{' '}
        <strong>revision</strong> — nothing changes until you activate it, and you can always go
        back. Right now it is running{' '}
        <strong>
          {data.source === 'code'
            ? 'the charter that ships in the code'
            : `revision ${data.revisions.find((r) => r.id === data.activeRevisionId)?.revision ?? '?'}`}
        </strong>
        .
      </p>

      <Textarea
        className="acr-cs-editor"
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Charter prompt"
      />

      {dirty ? (
        <div className="acr-cs-diff">
          <span className="acr-cs-difftitle">What you changed</span>
          {diff
            .filter((l) => l.kind !== 'same')
            .slice(0, 40)
            .map((l, i) => (
              <div key={i} className={`acr-cs-line ${l.kind}`}>
                <span>{l.kind === 'added' ? '+' : '−'}</span>
                {l.text || <em>(blank line)</em>}
              </div>
            ))}
          {diff.filter((l) => l.kind !== 'same').length > 40 ? (
            <div className="acr-fl-sub">…and more</div>
          ) : null}
        </div>
      ) : null}

      <div className="acr-cs-actions">
        <Button
          variant="quiet" size="sm"
          disabled={!!busy}
          onClick={async () => {
            const r = (await call('/preview', { systemPrompt: draft }, 'preview')) as PreviewResult | null
            if (r) setPreview(r)
          }}
        >
          <PlayCircle size={13} /> {busy === 'preview' ? 'Trying it…' : 'Try it on real data'}
        </Button>
        <Button
          variant="quiet" size="sm"
          disabled={!!busy || !dirty}
          onClick={async () => {
            const r = (await call('/evaluate', { systemPrompt: draft, cases: 2 }, 'evaluate')) as EvalResult | null
            if (r) setEvaluation(r)
          }}
        >
          <FlaskConical size={13} /> {busy === 'evaluate' ? 'Measuring…' : 'Measure against the current charter'}
        </Button>
        <span className="acr-cs-notewrap">
          <Input
            fieldClassName="acr-cs-note"
            placeholder="one line: what did you change and why?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            variant="success" size="sm"
            disabled={!!busy || !dirty || !note.trim()}
            onClick={async () => {
              const saved = (await call(
                '/revisions',
                { systemPrompt: draft, note: note.trim() },
                'save',
              )) as { revision?: Revision } | null
              if (saved?.revision) {
                setNote('')
                await load()
                onChanged()
              }
            }}
          >
            Save as a new revision
          </Button>
        </span>
      </div>

      {preview ? (
        <div className={`acr-cs-result ${preview.ok ? '' : 'bad'}`}>
          <strong>
            {preview.ok
              ? `It would have reported ${preview.previewFindings?.length ?? 0} finding(s).`
              : 'It broke its output contract.'}
          </strong>{' '}
          <span className="acr-fl-sub">
            Nothing was written. Cost ${(preview.costUSD ?? 0).toFixed(4)} ·{' '}
            {(preview.inputTokens ?? 0).toLocaleString()} tokens in.
          </span>
          {preview.validationError ? (
            <pre className="acr-fl-raw">{preview.validationError}</pre>
          ) : null}
          {preview.ok && preview.previewFindings?.length ? (
            <ul className="acr-cs-findings">
              {preview.previewFindings.slice(0, 8).map((f, i) => (
                <li key={i}>
                  <strong>{String(f.kind ?? 'finding')}</strong> · {String(f.entityId ?? '')} —{' '}
                  {String(f.rationale ?? '').slice(0, 160)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {evaluation ? (
        <div className={`acr-cs-result verdict-${evaluation.verdict}`}>
          <strong>
            {evaluation.verdict === 'worse'
              ? 'This draft measured WORSE than what is running.'
              : evaluation.verdict === 'better'
                ? 'This draft measured better than what is running.'
                : 'Too close to call — no measured improvement either way.'}
          </strong>
          {/* Three columns and static — the kind this round is allowed to leave alone. It is
              converted anyway because `acr-fl-table` has three call sites: leaving one raw would
              mean one class rendering two different tables in the same console. */}
          <DataGrid
            className="acr-fl-table"
            rows={evaluation.measures}
            rowKey={(m) => m.measure}
            columns={[
              { key: 'measure', label: 'Measure', render: (m) => <>{m.measure}</> },
              { key: 'baseline', label: 'Running now', align: 'right', render: (m) => <>{fmt(m.baseline)}</> },
              {
                key: 'candidate', label: 'Your draft', align: 'right',
                render: (m) => <span className={m.better === true ? 'good' : m.better === false ? 'bad' : undefined}>{fmt(m.candidate)}</span>,
              },
            ]}
          />
          <span className="acr-fl-sub">
            {evaluation.baseline.cases} run(s) each, on the same evidence · cost $
            {evaluation.costUSD.toFixed(4)}
          </span>
        </div>
      ) : null}

      <div className="acr-cs-history">
        <Button variant="quiet" size="xs" inline className="acr-fl-checkstoggle" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
          <History size={13} /> {data.revisions.length} saved revision
          {data.revisions.length === 1 ? '' : 's'}
        </Button>
        {showHistory ? (
          <ul className="acr-cs-revlist">
            {data.source === 'revision' ? (
              <li>
                <Button
                  variant="quiet" size="sm"
                  disabled={!!busy}
                  onClick={async () => {
                    if (await call('/revert-to-code', {}, 'revert')) {
                      await load()
                      onChanged()
                    }
                  }}
                >
                  <RotateCcw size={13} /> Go back to the code charter
                </Button>
                <span className="acr-fl-sub">
                  The version in the repository — always available, never fails.
                </span>
              </li>
            ) : null}
            {data.revisions.map((r) => (
              <li key={r.id}>
                <span className="acr-cs-revhead">
                  <strong>#{r.revision}</strong>
                  {r.id === data.activeRevisionId ? (
                    <span className="acr-fl-pill acr-fl-pill-ok">running</span>
                  ) : null}
                  <span className="acr-fl-sub">
                    {new Date(r.createdAt).toLocaleString()} · {r.author ?? 'operator'}
                  </span>
                </span>
                <span className="acr-cs-revnote">{r.note}</span>
                <span className="acr-cs-revactions">
                  <Button variant="quiet" size="sm" onClick={() => setDraft(r.systemPrompt)}>
                    Load into the editor
                  </Button>
                  {r.id !== data.activeRevisionId ? (
                    <Button
                      variant="quiet" size="sm"
                      disabled={!!busy}
                      onClick={async () => {
                        const res = await call(`/revisions/${r.id}/activate`, {}, 'activate')
                        if (!res) {
                          // the eval gate refused — offer the recorded override
                          const reason = window.prompt(
                            'This revision measured worse than what is running. Activate anyway? Give a reason (recorded):',
                          )
                          if (reason?.trim()) {
                            if (
                              await call(
                                `/revisions/${r.id}/activate`,
                                { overrideReason: reason.trim() },
                                'activate',
                              )
                            ) {
                              await load()
                              onChanged()
                            }
                          }
                          return
                        }
                        await load()
                        onChanged()
                      }}
                    >
                      <Check size={13} /> Make this the live charter
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="acr-fl-sub">
        A saved revision is never activated by itself. Activation is blocked when a{' '}
        <Term k="grade">measurement</Term> says the draft is worse — you can override it, and the
        override is recorded with your reason.
      </p>
    </div>
  )
}

/** Client-side line diff for the live editor (the server sends its own for
 *  code-vs-running; this one is for draft-vs-running as you type). */
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i]! })
      i++
    } else {
      out.push({ kind: 'added', text: b[j]! })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! })
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! })
  return out
}
