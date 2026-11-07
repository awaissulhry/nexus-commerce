import type { FastifyInstance } from 'fastify'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandOutcome, type CommandSpec, type CommandTools } from '../../../core/command'
import type { Clock } from '../../../core/time'
import { officeAuthOf } from '../../auth/sessions/office-auth'

/**
 * The portal routes' clock (B-W2b-167): the app's (the office sign-in object's, as the portal's sign-in and partner routes
 * use), so a request's checks and its command's time are the same instant source (tests move it).
 */
export const appClock = (app: FastifyInstance): Clock => officeAuthOf(app).clock

/** command() on the app's clock, for the request's own context (office or partner scope). */
export function commandOn<Result>(app: FastifyInstance, caller: CommandCaller, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>): Promise<CommandOutcome<Result>> {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock: appClock(app) })
}
