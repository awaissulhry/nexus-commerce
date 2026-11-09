import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Work instructions (apps/factory-api modules/production/instructions; B-W2b-214; PRD-117, PRD-258, MES-110, MES-119; design
 * production.instructions SCR-141, floor.instructions SCR-174). An instruction is a company's: every office read and write is
 * checked with can() over its company.
 *
 *   production.instructions.view      the list and the record: steps, media, versions, the PDF sheet, and how many saw a
 *                                     version (counts per site, never a name or a figure per worker)
 *   production.instructions.manage    make an instruction of an operation (for every style or one style revision), write a
 *                                     draft version (steps per language, critical points, safety notes, icons, the tick the
 *                                     tablet asks, photos and videos), discard a draft, archive and restore, bring the typed
 *                                     `[ ] CODE words` lines of the routings into first versions
 *   production.instructions.approve   approve another person's draft: it is published to the floor (never one's own: the
 *                                     database refuses the author too)
 *   production.instructions.people    a training record (D.Lgs. 81/2008 art. 37): who saw which version, by name, where the
 *                                     site's legal gate lets an office read name a worker, and record a paper
 *                                     acknowledgement. A write risk on purpose: the read-only role never holds it (Owner
 *                                     answers F2, H3, W1: per person only to HR and the person).
 *
 * The floor reads the instruction of the operation in hand and the frozen spec of its work order, and says Seen, with the
 * scans' right (production.scan) at the device's own site. Nothing here carries money.
 */
export const PRODUCTION_INSTRUCTIONS_DEFINITIONS = definePermissions('production', {
  'instructions.view': {
    risk: 'read',
    description: 'See the work instructions of the operations: their steps, photos and videos, versions, the printed sheet, and how many workers saw a version (counts, never a name).',
  },
  'instructions.manage': {
    risk: 'write',
    description:
      'Write work instructions: make one for an operation (every style or one style revision), write a draft version with steps per language, critical points, safety notes, icons, the ticks the tablet asks, photos and videos; discard a draft, archive or restore an instruction, bring the typed step lines of the routings into first versions.',
  },
  'instructions.approve': {
    risk: 'write',
    description: "Approve another person's draft of a work instruction: it is published to the floor tablets from then on, and the workers of the operation are asked to look at it at their next Start. Never one's own draft.",
  },
  'instructions.people': {
    risk: 'write',
    description:
      "A training record: see by name who saw which version of a work instruction (where the site's legal gate allows a name), and record an acknowledgement signed on paper. Never a count, a ranking or a filter per worker.",
  },
})

export const PRODUCTION_INSTRUCTIONS_VIEW = 'production.instructions.view' satisfies Permission
export const PRODUCTION_INSTRUCTIONS_MANAGE = 'production.instructions.manage' satisfies Permission
export const PRODUCTION_INSTRUCTIONS_APPROVE = 'production.instructions.approve' satisfies Permission
export const PRODUCTION_INSTRUCTIONS_PEOPLE = 'production.instructions.people' satisfies Permission

export const PRODUCTION_INSTRUCTIONS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_INSTRUCTIONS_VIEW, PRODUCTION_INSTRUCTIONS_MANAGE, PRODUCTION_INSTRUCTIONS_APPROVE, PRODUCTION_INSTRUCTIONS_PEOPLE])

/**
 * Who holds them (one line per template; the role templates' merge point reads it). The production office writes and
 * approves (a second person approves: the methods office writes, the production manager or quality approves); the floor
 * supervisor writes the hands-on words; HR keeps the training record. Owner from every(); read-only takes view only (the
 * people right is a write risk on purpose).
 */
export const INSTRUCTIONS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCTION_INSTRUCTIONS_VIEW, PRODUCTION_INSTRUCTIONS_MANAGE, PRODUCTION_INSTRUCTIONS_APPROVE],
  floor_supervisor: [PRODUCTION_INSTRUCTIONS_VIEW, PRODUCTION_INSTRUCTIONS_MANAGE],
  quality_inspector: [PRODUCTION_INSTRUCTIONS_VIEW, PRODUCTION_INSTRUCTIONS_APPROVE],
  safety_officer: [PRODUCTION_INSTRUCTIONS_VIEW],
  hr: [PRODUCTION_INSTRUCTIONS_VIEW, PRODUCTION_INSTRUCTIONS_PEOPLE],
})
