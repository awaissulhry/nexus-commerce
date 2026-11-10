import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Sample decisions (B-W2b-252; SAL-312, SAL-314, PRD-070, PRD-158; design products.samples › Fit & comments, Approval), in
 * the sales area beside B-W2b-246's sales.samples.view | manage. Office only; each round is checked with can() against its
 * company and, when it is for a customer, that customer (a swatch: its round's or style's company and its brand).
 *
 *   sales.samples.decide    record a round's decision (approved, approved with comments, rejected) or a swatch's in the office,
 *                           and ask the brand to decide by an approval request on the round (SAMPLE) or the swatch (COLOUR,
 *                           LEATHER) — asking also needs partners.approvals.ask, withdrawing it too
 *   sales.samples.measure   measure the fit against the spec (per point of measure and size) and keep the fit comments
 *                           (write, resolve, remove) while the round is open
 *
 * Unchanged: sales.samples.view reads all of it (the fit, the approval, the swatches); sales.samples.manage keeps the
 * swatches (record, send, remove) and makes the next round after a rejection. The notified body's result of a CE test sample
 * and the certificate it led to are recorded by whoever keeps certificates (compliance.certificates.manage) on a round they
 * can see.
 */
export const SALES_SAMPLE_DECISIONS_DEFINITIONS = definePermissions('sales', {
  'samples.decide': {
    risk: 'write',
    description: "Record a sample round's or a leather or colour swatch's decision (approved, approved with comments, rejected) in the office, and ask the brand to decide by link or portal (with partners.approvals.ask).",
  },
  'samples.measure': {
    risk: 'write',
    description: "Measure a sample round's fit against the measurement spec, per point of measure and size, and keep its fit comments while the round is open.",
  },
})

export const SALES_SAMPLES_DECIDE = 'sales.samples.decide' satisfies Permission
export const SALES_SAMPLES_MEASURE = 'sales.samples.measure' satisfies Permission

export const SALES_SAMPLE_DECISIONS_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_SAMPLES_DECIDE, SALES_SAMPLES_MEASURE])

/**
 * Who holds them (auth/roles/templates; the owner from every()): sales records the brand's word and asks it (it keeps the
 * rounds); the production manager runs the sample room (decides internal rounds, measures the fit); the quality inspector
 * measures the fit (the final inspection's own skill).
 */
export const SALES_SAMPLE_DECISIONS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: [SALES_SAMPLES_DECIDE],
  production_manager: [SALES_SAMPLES_DECIDE, SALES_SAMPLES_MEASURE],
  quality_inspector: [SALES_SAMPLES_MEASURE],
})
