'use client'

/**
 * PES.6 — business rules: the formulas authored once and reused by many fields.
 *
 * Rithum's `SE_AS_Price - 20% Margin` appears in the mapping cell as a NAME, with the body on
 * hover, and the same body drives Minimum Price on one field and Maximum Price on another. That
 * is the whole value: change the margin once, every field that references it moves.
 *
 * Two guards worth naming:
 *  - Deleting a rule something still references is REFUSED (409) with the exact fields listed.
 *    An orphaned reference resolves to nothing, and a field that silently stops producing a
 *    value is the failure this editor exists to prevent.
 *  - Renaming rewrites every `ref` and every `rule("…")` call across the default bucket and
 *    every category overlay, so a rename cannot orphan anything either.
 */

import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, Plus, Trash2 } from 'lucide-react'

import { Button, Input, Textarea } from '@/design-system/primitives'
import { Banner, Drawer, EmptyState, Field } from '@/design-system/components'
import styles from '../mapping.module.css'
import * as api from './api'
import { ImpactReview } from './ImpactReview'
import type { ExpressionRow, ExprFunctionDoc } from './contracts'

interface Props {
  open: boolean
  channel: string
  code: string
  previewProductId: string | null
  onClose: () => void
  onChanged: () => void | Promise<void>
}

export function BusinessRulesDrawer({ open, channel, code, onClose, onChanged }: Props) {
  const [token, setToken] = useState('')
  const [review, setReview] = useState<string | null>(null)
  const [rules, setRules] = useState<ExpressionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftExpr, setDraftExpr] = useState('')
  const [exprError, setExprError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [functions, setFunctions] = useState<ExprFunctionDoc[]>([])
  const [discard, setDiscard] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.fetchExpressions(channel, code)
      setRules(result.expressions); setToken(result.token)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [channel, code])

  useEffect(() => { void load() }, [load])
  useEffect(() => { api.fetchFunctions().then(setFunctions).catch(() => setFunctions([])) }, [])

  useEffect(() => {
    if (!draftExpr.trim()) { setExprError(null); return }
    let active = true
    const id = setTimeout(() => {
      api.validateExpression(draftExpr)
        .then((r) => { if (active) setExprError(r.ok ? null : `${r.error?.message ?? 'syntax error'} (character ${(r.error?.pos ?? 0) + 1})`) })
        .catch(() => { if (active) setExprError(null) })
    }, 300)
    return () => { active = false; clearTimeout(id) }
  }, [draftExpr])

  const startNew = () => { setReview(null); setEditing(''); setDraftName(''); setDraftExpr('') }
  const startEdit = (r: ExpressionRow) => { setReview(null); setEditing(r.name); setDraftName(r.name); setDraftExpr(r.expr) }

  const save = async () => {
    const name = draftName.trim()
    if (!name || !draftExpr.trim() || exprError) return
    setSaving(true)
    try {
      const result = await api.createConfigurationImpact(channel, code, token, { expression: { name, expr: draftExpr.trim(), previousName: editing || undefined } })
      setReview(result.jobId)
      setEditing(null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (name: string) => {
    setSaving(true)
    try {
      const result = await api.createConfigurationImpact(channel, code, token, { expression: { name, expr: null } })
      setReview(result.jobId)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { if (saving) return; if (discard) setDiscard(false); else if (editing !== null) setDiscard(true); else onClose() }}
      width={560}
      title={discard ? 'Discard business-rule draft?' : 'Business rules'}
      subtitle={`${channel} · ${code} — formulas authored once, reused across fields`}
      footer={!discard && (
        editing !== null ? (
          <>
            <span className="grow" />
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={saving}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={saving || !draftName.trim() || !draftExpr.trim() || !!exprError}
            >
              {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Review affected listings
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={startNew}><Plus size={14} /> New rule</Button>
            <span className="grow" />
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </>
        )
      )}
    >
      <div className={styles.drawerBody}>
        {discard ? <>
          <Banner tone="warning">Your draft has not been saved or activated.</Banner>
          <Button autoFocus onClick={() => setDiscard(false)}>Keep editing</Button>
          <Button variant="danger" onClick={() => { setDiscard(false); setEditing(null); onClose() }}>Discard draft</Button>
        </> : <>
        {error && <Banner tone="danger" title="Something went wrong">{error}</Banner>}

        {review ? <ImpactReview key={review} jobId={review} onApplied={async () => { await load(); await onChanged() }} /> : editing !== null ? (
          <>
            <Field label="Name" hint="What the mapping cell will show — e.g. “Amazon price − 20% margin”.">
              <Input size="sm" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Rule name" />
            </Field>
            <div className={styles.section}>
              <span className={styles.sectionTitle}>Formula</span>
              <Textarea
                className={styles.formula} aria-invalid={!!exprError}
                value={draftExpr}
                onChange={(e) => setDraftExpr(e.target.value)}
                spellCheck={false}
                placeholder={'round(margin($basePrice, 20), 2)'}
                aria-label="Formula"
              />
              {exprError
                ? <span className={styles.exprError}>{exprError}</span>
                : draftExpr.trim() ? <span className={styles.exprOk}>Valid</span> : null}
            </div>
            <div className={styles.section}>
              <span className={styles.sectionTitle}>Functions</span>
              <div className={styles.fnList}>
                {functions.map((f) => (
                  <div key={f.name} className={styles.fnRow}>
                    <Button
                      variant="link"
                      size="xs"
                      className={styles.fnSig}
                      onClick={() => setDraftExpr((c) => `${c}${c && !c.endsWith(' ') ? ' ' : ''}${f.name}(`)}
                    >
                      {f.signature}
                    </Button>{' '}
                    <span className={styles.fnSummary}>{f.summary}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : loading ? (
          <p className={styles.hint}>Loading…</p>
        ) : rules.length === 0 ? (
          <EmptyState
            title="No business rules yet"
            description="A business rule is a formula you write once and point many fields at — a margin, a title pattern, an identifier fallback. Change it here and every field that uses it moves."
            action={<Button size="sm" variant="primary" onClick={startNew}><Plus size={14} /> New rule</Button>}
          />
        ) : (
          rules.map((r) => (
            <div key={r.name} className={styles.ruleRow}>
              <div style={{ minWidth: 0 }}>
                <div className={styles.ruleName}>{r.name}</div>
                <div className={styles.ruleBody} title={r.expr}>{r.expr}</div>
                {r.parseError && (
                  // A stored rule that no longer parses resolves to nothing on EVERY field that
                  // points at it, so it is called out rather than listed as dependency-free.
                  <div className={styles.exprError}>
                    ⊙ This rule no longer parses — {r.parseError.message} (character {r.parseError.pos + 1}).
                    {r.usedBy.length > 0 && ` ${r.usedBy.length} field${r.usedBy.length === 1 ? '' : 's'} using it resolve to nothing.`}
                  </div>
                )}
                <div className={styles.usageList}>
                  {r.usedBy.length === 0
                    ? 'Not used by any field yet'
                    : `Used by ${r.usedBy.length} field${r.usedBy.length === 1 ? '' : 's'}: ${r.usedBy.slice(0, 4).map((u) => u.fieldKey).join(', ')}${r.usedBy.length > 4 ? '…' : ''}`}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                <Button size="xs" variant="ghost" onClick={() => startEdit(r)}>Edit</Button>
                <Button size="xs" variant="ghost" onClick={() => remove(r.name)} aria-label={`Delete ${r.name}`}>
                  <Trash2 size={13} />
                </Button>
              </div>
            </div>
          ))
        )}
        </>}
      </div>
    </Drawer>
  )
}
