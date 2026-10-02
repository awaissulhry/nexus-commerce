'use client'
/**
 * MCP full control C9 — Settings › AI › Claude › Activity: what Claude did in this business (GET /api/claude/activity).
 *
 * One row per call Claude made: when, who, over which connection, which tool, what became of it, and whether the
 * change can still be put back. Undo asks first (ActionConfirm: what it changes, where it lands), then the click is
 * the approval: the inverse change waits out the same undo window and is re-checked when it runs
 * (POST /api/claude/changes/:id/undo). Filters: outcome and tool; "Show older" follows the API's cursor.
 *
 * A list (ActivityRows), not a grid: each Undo is a Tab stop in the order shown, and at phone width each row stacks
 * with its Undo on the row's first line (the 2026-10-02 browser check found the grid's Undo column off-screen at 390 px).
 */
import { useCallback, useEffect, useId, useState } from 'react'
import { Banner, Card, EmptyState, Field, useActionConfirm } from '@/design-system/components'
import { Button, Input, Pill, Select } from '@/design-system/primitives'
import { claudeApi } from './claudeApi'
import { changeWords, connectionWords, OUTCOME_LABEL, OUTCOME_TONE, OUTCOMES, when, type ActivityRow, type Outcome } from './claudeWords'

/** Which tool: the one Claude called, and the change it asked for when that is another tool. */
const toolOf = (row: ActivityRow) => (row.approval && row.approval.tool !== row.tool ? `${row.tool} → ${row.approval.tool}` : row.tool)

/**
 * The calls, one row each: when, who, over which connection, which tool, its outcome, what became of it, and Undo for
 * a change that can still be put back. Each Undo is a Tab stop in the order shown; at phone width a row stacks with
 * its Undo on the first line (claude.css).
 */
export function ActivityRows({ rows, busy, onUndo }: { rows: ActivityRow[]; busy: boolean; onUndo: (row: ActivityRow) => void }) {
  return (
    <div className="claude-activity">
      <div className="claude-activity-head" aria-hidden="true">
        <span>When</span><span>Who</span><span>Connection</span><span>Tool</span><span>Outcome</span><span>What became of it</span><span />
      </div>
      <ul className="claude-activity-list" aria-label="What Claude did, newest first">
        {rows.map((row) => (
          <li key={row.runId} className="claude-activity-row">
            <span className="claude-activity-when" title={row.at}>{when(row.at)}</span>
            <span className="claude-activity-who">{row.who.name ?? '—'}</span>
            <span className="claude-activity-connection">{connectionWords(row)}</span>
            <span className="claude-activity-tool">{toolOf(row)}</span>
            <span className="claude-activity-outcome"><Pill tone={OUTCOME_TONE[row.outcome]} size="sm">{OUTCOME_LABEL[row.outcome]}</Pill></span>
            <span className="claude-activity-what">{changeWords(row)}</span>
            <span className="claude-activity-undo">
              {row.change?.undo === 'possible' && (
                <Button size="xs" variant="secondary" disabled={busy} onClick={() => onUndo(row)} aria-label={`Undo the ${row.approval?.tool ?? row.tool} change from ${when(row.at)}`}>
                  Undo
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ActivityPanel() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | ''>('')
  const [toolTyped, setToolTyped] = useState('')
  const [tool, setTool] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const confirm = useActionConfirm()
  const outcomeId = useId()
  const toolId = useId()

  const load = useCallback(async (more: string | null) => {
    setBusy(true)
    setError(null)
    try {
      const page = await claudeApi.activity({ outcome: outcome || undefined, tool, cursor: more })
      setRows((now) => (more && now ? [...now, ...page.rows] : page.rows))
      setCursor(page.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The activity could not be loaded.')
    } finally {
      setBusy(false)
    }
  }, [outcome, tool])
  useEffect(() => { void load(null) }, [load])

  const undo = (row: ActivityRow) => {
    if (!row.change) return
    const tool = row.approval?.tool ?? row.tool
    void Promise.resolve(confirm.ask({
      level: 'confirm',
      title: `Undo this ${tool} change?`,
      reach: row.change.outbound ? 'channel' : 'local',
      reversal: { verb: 'Undo', fidelity: 'exact' },
      consequences: [
        `Asks for the opposite ${tool} change, approved by this click: it puts back what the change replaced.`,
        'It waits out the same short undo window, and is refused when it runs if the value moved again meanwhile.',
        ...(row.change.outbound ? ['The old value is sent to the marketplace again.'] : []),
      ],
    })).then(async (ok: boolean) => {
      if (!ok) return
      setBusy(true)
      setError(null)
      try {
        const out = await claudeApi.undo(row.change!.id)
        setNotice(`Undo approved: it runs at ${new Date(out.executeAfter).toLocaleTimeString()}, unless someone stops it in Approvals.`)
        await load(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The undo could not be asked for.')
      } finally {
        setBusy(false)
      }
    })
  }

  return (
    <div className="claude-panel">
      {error && <Banner tone="danger" onDismiss={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      <Card header="What Claude did" description="Every call through a Claude connection in this business, newest first. Previews and values you may not see stay hidden.">
        <div className="claude-card-body">
          <form className="claude-filters" onSubmit={(event) => { event.preventDefault(); setTool(toolTyped) }}>
            <Field label="Outcome" htmlFor={outcomeId}>
              <Select id={outcomeId} size="sm" value={outcome} onChange={(event) => setOutcome(event.target.value as Outcome | '')}>
                <option value="">Every outcome</option>
                {OUTCOMES.map((value) => <option key={value} value={value}>{OUTCOME_LABEL[value]}</option>)}
              </Select>
            </Field>
            <Field label="Tool" htmlFor={toolId} hint="Its name, e.g. set-price.">
              <Input id={toolId} size="sm" value={toolTyped} onChange={(event) => setToolTyped(event.target.value)} />
            </Field>
            <Button size="sm" variant="secondary" type="submit" disabled={busy}>Apply</Button>
          </form>
          {rows === null ? (
            <p className="claude-note" role="status">Loading…</p>
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing yet" description="Claude has made no call here that matches." />
          ) : (
            <ActivityRows rows={rows} busy={busy} onUndo={undo} />
          )}
          {cursor && (
            <div className="claude-row">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void load(cursor)}>Show older</Button>
            </div>
          )}
        </div>
      </Card>
      {confirm.element}
    </div>
  )
}
