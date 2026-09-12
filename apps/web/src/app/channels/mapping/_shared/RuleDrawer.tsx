'use client'

/**
 * PES.6.8 — the rule editor.
 *
 * One field, four ways to feed it, and the SAME four the grid's icons name:
 *   Attribute      — read one path from the resolved product data
 *   Fixed value    — the same constant for every product
 *   Formula        — an expression over the attributes
 *   Business rule  — run a saved, reusable formula by name
 *
 * Two rules this drawer holds itself to:
 *  1. The live preview RUNS THE ENGINE. It saves nothing and computes nothing locally: it posts
 *     the candidate rule's shape to the resolve endpoint against the chosen preview SKU, so the
 *     number on screen is the number that would ship (reference_preview_must_run_the_engine).
 *     Without a preview SKU it says so rather than showing a plausible blank.
 *  2. The source list is READ OFF A REAL PRODUCT through the same resolver the rules use, not
 *     from a hand-kept registry — every path offered is one that will actually resolve, and each
 *     shows the value it currently holds.
 *
 * Drafts are evaluated by the shared resolver; activation uses the shared mapping writer after a durable impact review. Every activation records a MappingRevision.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2, Trash2 } from 'lucide-react'

import { Button, Input, Textarea } from '@/design-system/primitives'
import { Banner, Drawer, Field, Listbox } from '@/design-system/components'
import styles from '../mapping.module.css'
import * as api from './api'
import { ImpactReview } from './ImpactReview'
import type { SourceOption } from './api'
import {
  PRIORITY_META, RULE_KIND_META,
  type CatalogueField, type FieldMappingRule, type ResolvedCell, type RuleKind, type TransformOp,
  type ExprFunctionDoc,
} from './contracts'

type EditKind = Exclude<RuleKind, 'unmapped'>

interface Props {
  open: boolean
  channel: string
  code: string
  productType: string | null
  field: CatalogueField
  cell: ResolvedCell | undefined
  previewProductId: string | null
  channelConnectionId?: string | null
  aliasKey?: string
  mappingToken: string
  expressions: Record<string, string>
  onClose: () => void
  onSaved: () => void | Promise<void>
}

/** Read the rule back into the editor's four-way shape. */
function initialKind(field: CatalogueField): EditKind {
  return field.ruleKind === 'unmapped' ? 'attribute' : field.ruleKind
}

function constantOf(rule: FieldMappingRule | null): string {
  const def = rule?.transforms?.find((t) => t.type === 'default') as { value?: unknown } | undefined
  if (def === undefined) return ''
  return typeof def.value === 'string' ? def.value : JSON.stringify(def.value ?? '')
}

function exprOf(rule: FieldMappingRule | null): string {
  const op = rule?.transforms?.find((t) => t.type === 'expr') as { expr?: string } | undefined
  if (op?.expr) return op.expr
  const tmpl = rule?.transforms?.find((t) => t.type === 'template') as { expr?: string } | undefined
  return tmpl?.expr ?? ''
}

function refOf(rule: FieldMappingRule | null): string {
  const op = rule?.transforms?.find((t) => t.type === 'expr') as { ref?: string } | undefined
  return op?.ref ?? ''
}

export function RuleDrawer({
  open, channel, code, productType, field, cell, previewProductId, channelConnectionId, aliasKey, expressions, mappingToken, onClose, onSaved,
}: Props) {

  const [kind, setKind] = useState<EditKind>(() => initialKind(field))
  const [source, setSource] = useState(field.rule?.source ?? '')
  const [fallback, setFallback] = useState(field.rule?.fallback ?? '')
  const [constant, setConstant] = useState(() => constantOf(field.rule))
  const [expr, setExpr] = useState(() => exprOf(field.rule))
  const [ruleRef, setRuleRef] = useState(() => refOf(field.rule))
  const [notes, setNotes] = useState(field.rule?.notes ?? '')

  const [sources, setSources] = useState<SourceOption[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [sourceQuery, setSourceQuery] = useState('')
  const [functions, setFunctions] = useState<ExprFunctionDoc[]>([])
  const [exprError, setExprError] = useState<string | null>(null)
  const [exprDeps, setExprDeps] = useState<{ attributes: string[]; rules: string[] }>({ attributes: [], rules: [] })

  const [preview, setPreview] = useState<ResolvedCell | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [impactId, setImpactId] = useState<string | null>(null)
  const previewSeq = useRef(0)

  /* ── reference data ──────────────────────────────────────────── */
  useEffect(() => {
    let active = true
    setSourcesLoading(true)
    setSourcesError(null)
    api.fetchSources(channel, code, previewProductId)
      .then((r) => { if (active) setSources(r.sources) })
      .catch((e) => { if (active) { setSources([]); setSourcesError(e instanceof Error ? e.message : 'Could not load source attributes.') } })
      .finally(() => { if (active) setSourcesLoading(false) })
    return () => { active = false }
  }, [channel, code, previewProductId])

  useEffect(() => { api.fetchFunctions().then(setFunctions).catch(() => setFunctions([])) }, [])

  /* ── formula syntax check ────────────────────────────────────── */
  useEffect(() => {
    if (kind !== 'expression' || !expr.trim()) { setExprError(null); return }
    const id = setTimeout(() => {
      api.validateExpression(expr)
        .then((r) => {
          setExprError(r.ok ? null : `${r.error?.message ?? 'syntax error'} (character ${(r.error?.pos ?? 0) + 1})`)
          // null = did not parse; the error line already says so, so keep the deps list empty
          // rather than implying the formula reads nothing.
          setExprDeps(r.dependencies ?? { attributes: [], rules: [] })
        })
        .catch(() => setExprError(null))
    }, 300)
    return () => clearTimeout(id)
  }, [expr, kind])

  /* ── the candidate rule ──────────────────────────────────────── */
  const candidate = useMemo<FieldMappingRule | null>(() => {
    const existing = field.rule
    const previousKind = initialKind(field)
    const previous = existing?.transforms ?? []
    const isDriver = (t: TransformOp) => previousKind === 'constant' ? t.type === 'default' : previousKind === 'expression' || previousKind === 'businessRule' ? t.type === 'expr' || t.type === 'template' : false
    const driverIndex = previous.findIndex(isDriver)
    let driver: TransformOp | null = null
    if (kind === 'attribute' && !source.trim()) return null
    if (kind === 'constant') {
      if (!constant) return null
      // Editing another property must not turn an existing number/boolean/object into text.
      const old = previous.find(t => t.type === 'default') as { value?: unknown } | undefined
      driver = { type: 'default', value: constant === constantOf(existing) && old ? old.value : constant }
    }
    if (kind === 'expression') { if (!expr.trim() || exprError) return null; driver = { type: 'expr', expr: expr.trim() } }
    if (kind === 'businessRule') { if (!ruleRef) return null; driver = { type: 'expr', ref: ruleRef } }
    const transforms = previous.filter((_, i) => i !== driverIndex)
    if (driver) transforms.splice(driverIndex < 0 ? 0 : driverIndex, 0, driver)
    return {
      ...(existing?.required !== undefined ? { required: existing.required } : {}),
      source: kind === 'attribute' ? source.trim() : '',
      ...(fallback.trim() ? { fallback: fallback.trim() } : {}),
      ...(transforms.length ? { transforms } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    }
  }, [field, kind, source, fallback, constant, expr, ruleRef, notes, exprError])

  /* ── live preview: run the engine, never guess ───────────────── */
  const runPreview = useCallback(async () => {
    const seq = ++previewSeq.current
    setPreview(null)
    if (!previewProductId || !candidate) { setPreviewing(false); return }
    setPreviewing(true)
    try {
      const r = await api.resolvePreview(channel, code, {
        channelConnectionId, aliasKey,
        productIds: [previewProductId],
        productType,
        fieldKeys: [field.fieldKey],
        includeCatalogue: false,
        candidate: { fieldKey: field.fieldKey, rule: candidate, expectedToken: mappingToken },
      })
      if (seq !== previewSeq.current) return
      setPreview(r.products[0]?.cells[field.fieldKey] ?? null)
    } catch (e) {
      if (seq === previewSeq.current) setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === previewSeq.current) setPreviewing(false)
    }
  }, [channel, code, productType, field.fieldKey, previewProductId, candidate, mappingToken, channelConnectionId, aliasKey])

  useEffect(() => {
    const timer = setTimeout(() => { void runPreview() }, 300)
    return () => { clearTimeout(timer); previewSeq.current++ }
  }, [runPreview])

  const dirty = useMemo(() => {
    const cur = field.rule
    if (!cur && candidate) return true
    if (!candidate) return false
    return JSON.stringify(cur) !== JSON.stringify(candidate)
  }, [field.rule, candidate])

  /* ── save / clear ────────────────────────────────────────────── */
  const save = async () => {
    if (!candidate) return
    setSaving(true)
    setSaveError(null)
    try {
      const result = await api.createImpact(channel, code, productType, [{ fieldKey: field.fieldKey, rule: candidate }], mappingToken)
      setImpactId(result.jobId)
    } catch (e: any) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await api.createImpact(channel, code, productType, [{ fieldKey: field.fieldKey, rule: null }], mappingToken)
      setImpactId(result.jobId)
    } catch (e: any) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const filteredSources = useMemo(() => {
    const q = sourceQuery.trim().toLowerCase()
    const list = q ? sources.filter((s) => s.path.toLowerCase().includes(q)) : sources
    return list.slice(0, 120)
  }, [sources, sourceQuery])

  const meta = PRIORITY_META[field.priority]

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={impactId ? 'min(1100px, 96vw)' : 560}
      title={field.label}
      subtitle={`${field.shopifyField?.channelLabel ? `Shopify: ${field.shopifyField.channelLabel} · ` : ''}${field.shopifyField?.definition ? field.shopifyField.source : field.fieldKey} · ${meta.label}${field.maxLength ? ` · max ${field.maxLength} chars` : ''}${field.maxBytes ? ` / ${field.maxBytes} bytes` : ''}`}
      footer={impactId ? <Button size="sm" onClick={() => setImpactId(null)}>Back to rule</Button> :
        <>
          {field.rule && (field.ruleOrigin === 'category' || (field.ruleOrigin === 'default' && !productType)) && (
            <Button variant="ghost" size="sm" onClick={clear} disabled={saving}>
              <Trash2 size={14} /> Remove rule
            </Button>
          )}
          <span className="grow" />
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!candidate || !dirty || saving}>
            {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Review impact
          </Button>
        </>
      }
    >
      {impactId ? <ImpactReview jobId={impactId} onApplied={onSaved} /> : <div className={styles.drawerBody}>
        <Banner tone="info" title="Reusable rule">Applies to current and future products matching {productType ? `marketplace category ${productType}` : 'all marketplace categories'} on {channel} · {code}{field.fieldKey.startsWith('shopify_metafield:') ? ', in this connected store' : ', across accounts'}. Shared facts and listing overrides are preserved.</Banner>
        {field.ruleOrigin === 'master' && <Banner tone="neutral" title="Follows Master automatically">This field already reads the matching Master attribute. Save a rule here to customize that mapping for this scope.</Banner>}
        {field.ruleOrigin === 'default' && productType && <Banner tone="neutral" title="Inherited market rule">This rule applies across categories. Editing here creates a rule for this category; the market rule remains available to other categories.</Banner>}
        {field.ruleOrigin === 'category' && <p className={styles.hint}>Removing this category rule restores the market rule or automatic Master inheritance, when available. Listing overrides stay in place.</p>}
        {field.schemaKnown === false && <Banner tone="warning" title="Field outside the current schema">This saved rule is retained for review. The selected category does not declare this field.</Banner>}
        {saveError && <Banner tone="danger" title="That rule was refused">{saveError}</Banner>}

        {field.helpText && <p className={styles.hint}>{field.helpText}</p>}

        {field.selectionOnly && field.options && (
          <Banner tone="info" title={`${field.options.length} accepted values`}>
            The channel closes this list. A value that is not on it is an error, not a warning
            {field.deprecatedOptions?.length ? `; ${field.deprecatedOptions.length} of them are deprecated` : ''}.
            <div className={styles.hint} style={{ marginTop: 6 }}>
              {field.options.slice(0, 12).map((o) => field.optionLabels?.[o] ?? o).join(' · ')}
              {field.options.length > 12 ? ` … +${field.options.length - 12} more` : ''}
            </div>
          </Banner>
        )}

        {!field.editable && (
          <Banner tone="warning" title="Not editable after listing">
            The channel accepts this only when a listing is first created; changing it later is rejected.
          </Banner>
        )}

        {/* ── kind ── */}
        <div className={styles.section}>
          <span className={styles.sectionTitle}>What feeds this field</span>
          <div className={styles.kindRow}>
            {(['attribute', 'constant', 'expression', 'businessRule'] as EditKind[]).map((k) => (
              <Button
                key={k}
                size="xs"
                variant={kind === k ? 'primary' : 'ghost'}
                onClick={() => setKind(k)}
                title={RULE_KIND_META[k].hint}
              >
                {RULE_KIND_META[k].glyph} {RULE_KIND_META[k].label}
              </Button>
            ))}
          </div>
          <p className={styles.hint}>{RULE_KIND_META[kind].hint}</p>
        </div>

        {/* ── the editor for the chosen kind ── */}
        {kind === 'attribute' && (
          <>
            <Field label="Attribute path">
              <Input size="sm" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. brand" />
            </Field>
            <Field label="Fallback (optional)" hint="Used only when the attribute above is empty.">
              <Input size="sm" value={fallback} onChange={(e) => setFallback(e.target.value)} placeholder="e.g. name" />
            </Field>
            <div className={styles.section}>
              <span className={styles.sectionTitle}>Pick from this product’s data</span>
              <Input
                size="xs"
                value={sourceQuery}
                onChange={(e) => setSourceQuery(e.target.value)}
                placeholder="Filter attributes…"
                aria-label="Filter attributes"
              />
              <div className={styles.sourceList}>
                {sourcesLoading ? <p className={styles.hint} role="status">Loading source attributes…</p>
                : sourcesError ? <Banner tone="danger">{sourcesError}</Banner>
                : filteredSources.length === 0 ? (
                  <p className={styles.hint}>No attribute matches.</p>
                ) : filteredSources.map((s) => (
                  <Button
                    key={s.path}
                    variant="quiet"
                    size="xs"
                    className={`${styles.optionRowBtn} ${styles.sourceItem}`}
                    onClick={() => setSource(s.path)}
                  >
                    <span className={styles.sourcePath} title={s.path}>{s.path}</span>
                    <span className={`${styles.sourceVal} ${s.hasValue ? '' : styles.sourceEmpty}`}>
                      {s.hasValue ? s.sampleValue : 'empty on this product'}
                    </span>
                  </Button>
                ))}
              </div>
              <p className={styles.hint}>
                Master attribute definitions and paths from {previewProductId ? 'the preview SKU' : 'the most recently updated product'}.
                Samples use the rule resolver; declared attributes may be empty on this product.
              </p>
            </div>
          </>
        )}

        {kind === 'constant' && (
          <Field label="Fixed value" hint="Sent for every product in this category.">
            <Input size="sm" value={constant} onChange={(e) => setConstant(e.target.value)} placeholder='e.g. New' />
          </Field>
        )}

        {kind === 'expression' && (
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Formula</span>
            <Textarea
              className={styles.formula} aria-invalid={!!exprError}
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              spellCheck={false}
              placeholder={'if(isblank($ean), $upc, $ean)\n$brand + " " + $name\nround(margin($cost, 20), 2)'}
              aria-label="Formula"
            />
            {exprError
              ? <span className={styles.exprError}>{exprError}</span>
              : expr.trim()
                ? <span className={styles.exprOk}>
                    Valid{exprDeps.attributes.length ? ` · reads ${exprDeps.attributes.join(', ')}` : ''}
                    {exprDeps.rules.length ? ` · calls ${exprDeps.rules.join(', ')}` : ''}
                  </span>
                : null}
            <div className={styles.section}>
              <span className={styles.sectionTitle}>Functions</span>
              <div className={styles.fnList}>
                {functions.map((f) => (
                  <div key={f.name} className={styles.fnRow}>
                    <Button
                      variant="link"
                      size="xs"
                      className={styles.fnSig}
                      onClick={() => setExpr((cur) => `${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}${f.name}(`)}
                      title={`Insert ${f.name}(`}
                    >
                      {f.signature}
                    </Button>{' '}
                    <span className={styles.fnSummary}>{f.summary}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {kind === 'businessRule' && (
          <Field label="Business rule" hint="Saved formulas, authored once and reused across fields.">
            {Object.keys(expressions).length === 0 ? (
              <p className={styles.hint}>
                No business rules yet on this channel. Create one from “Business rules” in the header,
                then pick it here.
              </p>
            ) : (
              <>
                <Listbox
                  size="sm"
                  options={Object.keys(expressions).map((n) => ({ value: n, label: n }))}
                  value={ruleRef}
                  onChange={setRuleRef}
                  placeholder="Pick a business rule"
                  ariaLabel="Business rule"
                />
                {ruleRef && <div className={styles.livePreview} style={{ marginTop: 8 }}>{expressions[ruleRef]}</div>}
              </>
            )}
          </Field>
        )}

        <Field label="Note (optional)" hint="Why this rule exists — shown to whoever edits it next.">
          <Input size="sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {/* ── live preview ── */}
        <div className={styles.section}>
          <span className={styles.sectionTitle}>Preview value</span>
          {!previewProductId ? (
            <div className={`${styles.livePreview} ${styles.livePreviewMuted}`}>
              Pick a preview SKU to see what this field would resolve to.
            </div>
          ) : previewing || (!preview && candidate && !saveError) ? (
            <div className={`${styles.livePreview} ${styles.livePreviewMuted}`}>Resolving…</div>
          ) : (
            <>
              <div className={styles.livePreview}>
                {preview?.errors.length
                  ? <span className={styles.exprError}>{preview.errors.join(' · ')}</span>
                  : preview && preview.value !== null && preview.value !== ''
                    ? String(Array.isArray(preview.value) ? preview.value.join(' • ') : preview.value)
                    : <span className={styles.livePreviewMuted}>resolves empty</span>}
              </div>
              {preview?.provenance && (
                <span className={styles.hint}>
                  Source: {preview.provenance}
                  {preview.appliedTransforms.length ? ` · transforms: ${preview.appliedTransforms.join(' → ')}` : ''}
                </span>
              )}
              {preview?.warnings.length ? (
                <span className={styles.hint}>⚠ {preview.warnings.join(' · ')}</span>
              ) : null}
              {dirty && (
                <span className={styles.hint}>
                  This is the effective value with your draft rule, including any protected listing override. Nothing has been saved.
                </span>
              )}
            </>
          )}
        </div>

        {cell?.autoCorrected && (
          <Banner tone="info" title="The channel spells this differently">
            {cell.autoCorrected.from} would be sent as {cell.autoCorrected.to}.
          </Banner>
        )}
      </div>}
    </Drawer>
  )
}
