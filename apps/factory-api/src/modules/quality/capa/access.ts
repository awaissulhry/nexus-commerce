import { DomainError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import { isFinal, STATUS_WORDS, typeWords, type CapaStatus, type CapaType } from '@nexus/factory-domain/quality/capa/rules'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { readCapa, scopeOf, type CapaRow } from './store'

/**
 * Who works on CAPAs (plan A1 §2.2, §3.11): the office over the companies AND customers its grants reach (an 8D written
 * for a customer is that customer's; an internal CAPA is its company's). A CAPA the caller may not see is not found; one
 * it sees but may not act on is forbidden. The floor and the portal read none.
 */

/** The held codes of a step the record's state refuses (409 invalid_state, `held/<CODE>`; the screens' words by the code). */
export const HELD_CODES = [
  'FINAL',
  'NOT_LAST_STAGE',
  'NO_ACTION_DONE',
  'ACTIONS_OPEN',
  'ACTION_ENDED',
  'ESCALATED_ELSEWHERE',
  'ALREADY_SOURCE',
  'NCR_CANCELLED',
  'NCR_KEEPS_CAPA',
  'OTHER_COMPANY',
  'TOO_MANY_REMINDERS',
] as const
export type HeldCode = (typeof HELD_CODES)[number]

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function contextOf(tools: Pick<CommandTools, 'context'>): OfficeContext {
  if (tools.context.audience !== 'office') throw new ForbiddenError()
  return tools.context
}

export const mayOn = (context: OfficeContext, permission: Permission, row: Pick<CapaRow, 'companyId' | 'customerId'>): boolean => can(actorOf(context), permission, scopeOf(row))

/** The CAPA the office caller sees (quality.capa.view, else not found) and acts on with `permission` (else forbidden). */
export async function officeCapa(caller: CommandCaller, capaId: string, permission: Permission = QUALITY_CAPA_VIEW): Promise<{ context: OfficeContext; capa: CapaRow }> {
  const context = officeOf(caller)
  const capa = await caller.withClient((client) => readCapa(client, capaId))
  if (!capa || !mayOn(context, QUALITY_CAPA_VIEW, capa)) throw new NotFoundError('CAPA not found.')
  if (!mayOn(context, permission, capa)) throw new ForbiddenError(`This needs ${permission} over the CAPA's company${capa.customerId ? ' and customer' : ''}.`)
  return { context, capa }
}

/** A step its state holds: 409 invalid_state, the code in `held/<CODE>`, the words here. */
export function held(code: HeldCode, words: string, more: readonly Issue[] = []): DomainError {
  return new DomainError('invalid_state', words, [{ path: `held/${code}`, message: words }, ...more])
}

/** A CLOSED or CANCELLED CAPA never changes (refused in words before the database says the same). */
export function assertOpen(row: Pick<CapaRow, 'status' | 'type'>): void {
  const status = row.status as CapaStatus
  if (isFinal(status)) throw held('FINAL', `The ${typeWords(row.type as CapaType)} is ${STATUS_WORDS[status]}: it never changes.`)
}

/** A 400 with the problems at their fields (`body/<field>`). */
export function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body/') || problem.path.startsWith('query/') ? problem.path : `body/${problem.path}` })))
}
