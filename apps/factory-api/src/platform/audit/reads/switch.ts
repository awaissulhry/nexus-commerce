import { readFactoryVariables } from '../../../env'

/**
 * THE SWITCH of the read log (B-W2b-399; PLT-074; GATE-PRIVACY): the views, downloads and exports of sensitive records are
 * logged only once the staff privacy notice carries its line about it (plan §2: "live read logging until the notice line is
 * published"; the suggested line is in the step's notes). FACTORY_READ_LOG=on|off in apps/factory-api's environment (Railway:
 * the Owner's), read once through the env loader's variables; unset: on in local and test runs (the tests and the golden
 * flows check it), OFF on staging and production until the Owner switches it on. The security events are not behind it.
 */

let forced: boolean | undefined
let read: boolean | undefined

/** Tests: the switch on or off; undefined goes back to the environment's. */
export function useReadLog(on: boolean | undefined): void {
  forced = on
}

export function readLogOn(): boolean {
  if (forced !== undefined) return forced
  if (read === undefined) {
    const variables = readFactoryVariables()
    const value = variables.FACTORY_READ_LOG
    read = value === 'on' ? true : value === 'off' ? false : variables.FACTORY_ENV === 'local' || variables.FACTORY_ENV === 'test'
  }
  return read
}
