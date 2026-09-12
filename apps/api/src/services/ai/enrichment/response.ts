/**
 * PES.8 — turning one model response into drafts.
 *
 * Extracted from `runEnrichment`'s loop so it can be tested without a vendor call. That is not a
 * convenience: under hub ruling #13 the Owner has held live generation indefinitely, so this path
 * would otherwise sit unexercised until the first real run — and it is the path that decides
 * whether a value the model wrote becomes something an operator is offered.
 *
 * Every rule here is a refusal, and each one has a reason it is a refusal rather than a repair:
 *  - a field nobody asked for is dropped, because the model volunteering a cell outside the
 *    operator's selection is the scope creep the review flow exists to prevent;
 *  - a `low` confidence answer is dropped, because the prompt promises it will be;
 *  - a value over a HARD cap is kept but marked `failed`, never trimmed to fit — a trimmed value is
 *    copy the model did not write and nobody reviewed;
 *  - a value identical to what the cell already holds is dropped, because asking an operator to
 *    approve a no-op is review work for no change.
 */
import { createHash } from 'node:crypto'

import { encodeCellKey, type CellAddress } from './cell-key.js'
import type { CellConstraint } from './constraints.js'
import { sameStoredValue, type DraftInput } from './draft.service.js'
import { isOfferable, validateDraftValue, type Violation } from './validate.js'

export interface ParseDraftsInput {
  /** Raw model output, already JSON-extracted by `parseAiJson`. */
  fields: Record<string, unknown>
  /** ONLY the constraints this call showed the model. */
  constraints: CellConstraint[]
  productId: string
  /** The market the run's column set came from — persisted so approval can resolve `attr_*`. */
  market: string
  /** Builds the cell address for a write field, from the run's scope. */
  addressFor(writeField: string): CellAddress
  /** What the cell holds now — the diff's base and the staleness baseline. */
  currentValue(address: CellAddress): { found: boolean; value: unknown }
  /** Stable per-(prompt, field) hash so a re-run can tell a re-draft from a repeat. */
  promptHash(writeField: string): string
}

export function hashPromptField(prompt: string, field: string): string {
  return createHash('sha256').update(`${field} ${prompt}`).digest('hex').slice(0, 32)
}

/** The model's per-field answer, as the prompt asks for it. */
interface FieldEntry {
  value?: unknown
  confidence?: unknown
  reason?: unknown
}

export function draftsFromResponse(input: ParseDraftsInput): DraftInput[] {
  const { fields, constraints, productId, market, addressFor, currentValue, promptHash } = input
  const out: DraftInput[] = []
  if (!fields || typeof fields !== 'object') return out

  const byKey = new Map(constraints.map((c) => [c.columnKey, c]))
  const byWriteField = new Map(constraints.map((c) => [c.writeField, c]))

  for (const [key, rawEntry] of Object.entries(fields)) {
    const constraint = byKey.get(key) ?? byWriteField.get(key)
    if (!constraint) continue

    const entry = (rawEntry ?? {}) as FieldEntry
    // The prompt asks for `{ value, confidence, reason }`, but a model that answers with the bare
    // value is answering the question — take it rather than discard a usable draft on form.
    const value = entry.value !== undefined ? entry.value : rawEntry
    if (value == null || value === '') continue
    if (entry.confidence === 'low') continue

    const violations: Violation[] = validateDraftValue(value, constraint)
    const offerable = isOfferable(violations)
    const address = addressFor(constraint.writeField)
    const base = currentValue(address)

    if (offerable && base.found && sameStoredValue(value, base.value)) continue

    out.push({
      productId,
      market,
      cellKey: encodeCellKey(address),
      address,
      columnKey: constraint.columnKey,
      draftValue: value,
      baseValue: base.value ?? null,
      baseSource: base.found ? 'stored' : null,
      status: offerable ? 'pending' : 'failed',
      confidence: entry.confidence === 'high' ? 'high' : 'medium',
      rationale: typeof entry.reason === 'string' ? entry.reason.slice(0, 400) : null,
      promptHash: promptHash(constraint.writeField),
      capsUsed: {
        maxLength: constraint.maxLength,
        maxBytes: constraint.maxBytes,
        capFrom: constraint.capFrom,
        mode: constraint.mode,
        requiredBy: constraint.requiredBy,
        optionCount: constraint.options?.length,
      },
      violations: violations.length > 0 ? violations : null,
    })
  }
  return out
}
