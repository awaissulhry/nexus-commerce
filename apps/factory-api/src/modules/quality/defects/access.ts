import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { QUALITY_DEFECTS_MANAGE } from '@nexus/factory-domain/quality/defects/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'

/**
 * Who keeps the library (B-W2a-26): it is the whole group's (tenant-wide, companyId null on the audit rows), so a
 * change needs quality.defects.manage over every company; reading it needs quality.defects.view anywhere (the
 * manifest), and the pickers any office or floor session.
 */

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function officeOrFloorOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext | FloorContext {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'office' && context.audience !== 'floor')) throw new ForbiddenError()
  return context
}

export const mayManage = (context: OfficeContext): boolean => mayWrite(actorOf(context), QUALITY_DEFECTS_MANAGE, null)

export function assertManage(context: OfficeContext): void {
  if (!mayManage(context)) throw new ForbiddenError('The defect library and the disposition codes are the whole group\'s: they are kept with quality.defects.manage over every company.')
}
