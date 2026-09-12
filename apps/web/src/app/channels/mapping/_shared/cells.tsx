'use client'

/**
 * PES.6 — the mapping grid's cells.
 *
 * Four renderers, each answering one question an operator asks of a row:
 *   Priority   — how badly does the channel want this field?
 *   Mapping    — what feeds it, and of what kind?
 *   Preview    — what would actually ship for the chosen SKU?
 *   Status     — is it mapped?
 *
 * Status and Preview are DELIBERATELY independent. Rithum shows a field that is `Mapped` and
 * simultaneously carrying `Field 'Bullet Point 1' is required.`, and that pair is the truth: a
 * rule exists, and it resolves to nothing. Collapsing them into one column would hide exactly
 * the case the operator is here to fix.
 */

import { memo } from 'react'
import Link from '@/lib/workspaces/Link'
import type { ICellRendererParams } from '@/design-system/grid'
import { Button, Pill } from '@/design-system/primitives'
import { isCategoryField, mappingOriginLabel, PRIORITY_META, RULE_KIND_META, emptyReason, type CatalogueField, type ResolvedCell } from './contracts'
import styles from '../mapping.module.css'

export interface MappingRow {
  field: CatalogueField
  cell: ResolvedCell | undefined
  /**
   * Whether a preview SKU is chosen. It rides the ROW, not the grid `context`, because AG Grid
   * does not re-render cells when `context` changes — the column showed a resolved-nothing dash
   * for every field while the API was returning real values. Row data is rebuilt whenever the
   * resolve result changes, so the flag arrives with it.
   */
  hasPreview: boolean
  /** Group header rows are AG group rows; this is a leaf marker for clarity. */
  groupKey: string
  groupLabel: string
}

/* ── Channel Field ────────────────────────────────────────────────────────────────────────── */

export const FieldNameCell = memo(function FieldNameCell(p: ICellRendererParams<MappingRow>) {
  const f = p.data?.field
  if (!f) return null
  return (
    <span className={styles.fieldName}>
      <Button
        variant="link"
        inline size="xs"
        className={`${styles.inCellBtn} ${styles.fieldNameBtn}`}
        onClick={() => (p.context as any)?.onEditField?.(f.fieldKey)}
        title={isCategoryField(f.fieldKey, p.context?.channel) ? 'Edit category assignments' : `Edit how ${f.label} is mapped`}
      >
        {/* The ellipsis lives on this span, not the Button: a DS Button is inline-flex, and
            `text-overflow` does not apply to a flex container. */}
        <span className={styles.ellipsisText}>{f.label}</span>
      </Button>
      {f.helpText && (
        <span className={styles.infoDot} title={f.helpText} role="img" aria-label="Field help">
          i
        </span>
      )}
      {(f.readOnlyReason || !f.editable) && (
        <span className={styles.lockDot} title={f.readOnlyReason ?? 'The channel does not allow this to change on an existing listing.'} role="img" aria-label={f.readOnlyReason ? 'Read-only in this editor' : 'Not editable after listing'}>
          🔒
        </span>
      )}
      {f.schemaKnown === false && <Pill tone="warning" title="Saved rule outside the current category schema">Review field</Pill>}
      {f.overlay && (
        <span className={styles.overlayDot} title="This rule comes from this category's overlay, not the default set.">
          ov
        </span>
      )}
      <span className={styles.fieldKey} title={f.sheetKey ? `Sheet field: ${f.sheetKey}${f.shape === 'list' ? ' (list; may use numbered columns)' : ''}` : undefined}>
        {f.shopifyField?.definition ? `${f.shopifyField.owner === 'PRODUCT' ? 'Product' : 'Variant'} · ${f.shopifyField.source}` : <>{f.shopifyField?.channelLabel ? `Shopify: ${f.shopifyField.channelLabel} · ` : ''}{f.fieldKey}{f.sheetKey && f.sheetKey !== f.fieldKey ? ` · Sheet: ${f.sheetKey}` : ''}</>}
      </span>
    </span>
  )
})

/* ── Priority ─────────────────────────────────────────────────────────────────────────────── */

export const PriorityCell = memo(function PriorityCell(p: ICellRendererParams<MappingRow>) {
  const f = p.data?.field
  if (!f) return null
  const activeRequirement = f.priority === 'requiredIfRelevant' && p.data?.cell?.required
  const meta = PRIORITY_META[activeRequirement ? 'required' : f.priority]
  // Say where the level came from. "Required" derived from Amazon's own schema and "required"
  // because a rule flagged it are different claims, and the second is much weaker.
  const provenance =
    f.prioritySource === 'amazonSchema' ? "From the channel's own schema."
    : f.prioritySource === 'channelSchema' ? 'From the stored field definition.'
    : f.prioritySource === 'ruleFlag' ? 'Only the mapping rule claims this — the channel schema does not say.'
    : 'Unknown — no schema defines this field.'
  return (
    <span className={styles.priorityCell} title={p.data?.cell?.requirementReasons?.map(r => r.message).join(' ') || provenance}>
      <span className={`${styles.priorityDot} ${styles[`prio_${f.priority}`]}`} aria-hidden />
      <span>{activeRequirement ? 'Required for this product' : meta.label}</span>
      {f.prioritySource === 'ruleFlag' || f.prioritySource === 'unknown' ? (
        <span className={styles.weakMark} title={provenance}>?</span>
      ) : null}
    </span>
  )
})

/* ── Mapping from your data ───────────────────────────────────────────────────────────────── */

export const MappingCell = memo(function MappingCell(p: ICellRendererParams<MappingRow>) {
  const f = p.data?.field
  if (!f) return null
  if (isCategoryField(f.fieldKey, p.context?.channel)) return <Button variant="link" inline size="xs" onClick={() => (p.context as any)?.onEditField?.(f.fieldKey)}>Category assignments</Button>
  if (!f.rule && f.sourceOwner) return <Button variant="quiet" inline size="xs" title={`Supplied by ${f.sourceOwner.label.toLowerCase()}. ${f.sourceOwner.path}. Open to add a shared rule.`} onClick={() => (p.context as any)?.onEditField?.(f.fieldKey)}>{f.sourceOwner.label}</Button>
  if (f.ruleKind === 'unmapped') {
    return (
      <Button
        variant="link"
        inline size="xs"
        className={`${styles.inCellBtn} ${styles.mapBtn}`}
        onClick={() => (p.context as any)?.onEditField?.(f.fieldKey)}
      >
        + Map this field
      </Button>
    )
  }
  const meta = RULE_KIND_META[f.ruleKind]
  const full =
    f.ruleKind === 'businessRule'
      ? `Business rule: ${f.ruleRef}\n${(p.context as any)?.expressions?.[f.ruleRef ?? ''] ?? ''}`
      : f.ruleSummary ?? ''
  return (
    <Button
      variant="quiet"
      inline size="xs"
      className={`${styles.inCellBtn} ${styles.mappingCellBtn}`}
      title={`${meta.label} — ${meta.hint}\n\n${full}`}
      onClick={() => (p.context as any)?.onEditField?.(f.fieldKey)}
    >
      <span className={`${styles.kindGlyph} ${styles[`kind_${f.ruleKind}`]}`} aria-hidden>{meta.glyph}</span>
      <span className={styles.mappingText}>{f.ruleSummary}</span>
      {f.rule?.fallback ? <span className={styles.fallbackHint} title={`Falls back to ${f.rule.fallback}`}>↳</span> : null}
    </Button>
  )
})

/* ── Preview value ────────────────────────────────────────────────────────────────────────── */

function display(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.map((x) => String(x)).join(' • ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export const PreviewCell = memo(function PreviewCell(p: ICellRendererParams<MappingRow>) {
  const row = p.data
  if (!row) return null
  const { field, cell } = row
  const hasSku = row.hasPreview

  if (!hasSku) {
    return <span className={styles.previewIdle} title="Choose a preview SKU to resolve this field.">—</span>
  }
  if (!cell) return <span className={styles.previewIdle}>—</span>

  if (cell.errors.length > 0) {
    return (
      <span className={styles.previewError} title={cell.errors.join('\n')}>
        <span aria-hidden>⊙</span> {cell.errors[0]}
      </span>
    )
  }

  const text = display(cell.value)
  if (!text) {
    return (
      <span className={styles.previewEmpty} title={field.sourceOwner && !field.rule ? `No saved value from ${field.sourceOwner.label.toLowerCase()} for this listing.` : emptyReason(cell)}>
        {field.sourceOwner && !field.rule ? 'not set' : cell.status === 'unmapped' ? 'not mapped' : 'empty'}
      </span>
    )
  }

  const over = cell.overLimit
  return (
    <span className={styles.previewWrap}>
      {cell.autoCorrected && (
        <span
          className={styles.autoCorrected}
          title={`The channel's list spells this differently. ${cell.autoCorrected.from} would be sent as ${cell.autoCorrected.to}.`}
        >
          Auto corrected
        </span>
      )}
      <span className={styles.previewText} title={text}>{text}</span>
      {cell.provenance === 'override' && <Pill tone="neutral">Listing override</Pill>}
      {cell.supplyingRule && <Button asChild variant="link" size="xs"><Link href={cell.supplyingRule.href} title={`Shared rule v${cell.supplyingRule.version}; changes affect other matching products`}>{cell.supplyingRule.name}</Link></Button>}
      {over && (
        <span
          className={styles.overLimit}
          title={
            over.chars
              ? `${over.chars} characters, over the ${field.maxLength} the channel allows.`
              : `${over.bytes} UTF-8 bytes, over the ${field.maxBytes} the channel allows.`
          }
        >
          {over.chars ? `${over.chars}/${field.maxLength}` : `${over.bytes}B/${field.maxBytes}B`}
        </span>
      )}
      {cell.warnings.length > 0 && (
        <span className={styles.warnMark} title={cell.warnings.join('\n')}>⚠</span>
      )}
    </span>
  )
})

/* ── Status ───────────────────────────────────────────────────────────────────────────────── */

export const StatusCell = memo(function StatusCell(p: ICellRendererParams<MappingRow>) {
  const f = p.data?.field
  if (!f) return null
  if (isCategoryField(f.fieldKey, p.context?.channel) && !f.rule) return <Pill tone="neutral" size="sm">Category routing</Pill>
  if (!f.rule && f.sourceOwner) return <Pill tone="neutral" size="sm">Listing source</Pill>
  return f.status === 'mapped'
    ? <Pill tone={f.ruleOrigin === 'master' ? 'info' : 'success'} size="sm">{mappingOriginLabel(f)}</Pill>
    : <Pill tone="neutral" size="sm">Unmapped</Pill>
})
