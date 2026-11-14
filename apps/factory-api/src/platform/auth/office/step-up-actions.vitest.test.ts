import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_AREA } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ACTION_KEY } from '@nexus/factory-domain/auth/sessions/lengths'
import { STEP_UP_ACTIONS } from './step-up-actions'
import { stepUpActionsView, STEP_UP_ACTION_BY_KEY } from './step-up-policy'

/**
 * The actions that ask for a fresh code (B-W2b-404; PLT-063) hold every risky office permission once: a step that adds a
 * permission with the stepUp risk adds it to one action line, or this test names it.
 */
describe('the step-up actions', () => {
  const listed = STEP_UP_ACTIONS.flatMap((action) => action.permissions)

  it('hold every office permission with the stepUp risk exactly once', () => {
    const risky = FACTORY_PERMISSIONS.all.filter((definition) => definition.risk === 'stepUp' && definition.partner !== true && definition.link !== true && definition.area !== FLOOR_AREA).map((definition) => definition.name)
    expect(risky.filter((name) => !listed.includes(name))).toEqual([])
    expect(listed.filter((name, index) => listed.indexOf(name) !== index)).toEqual([])
  })

  it('name declared office permissions; one that is not stepUp only in an action that asks on its own rule', () => {
    for (const action of STEP_UP_ACTIONS) {
      for (const name of action.permissions) {
        const definition = FACTORY_PERMISSIONS.get(name)
        expect(definition, `${action.key}: ${name}`).toBeDefined()
        expect(definition!.partner ?? definition!.link, `${action.key}: ${name}`).toBeUndefined()
        if (definition!.risk !== 'stepUp') expect(['RULE', 'SECURITY'], `${action.key}: ${name}`).toContain(action.fixed)
      }
    }
  })

  it('have keys the settings can keep, each once', () => {
    const keys = STEP_UP_ACTIONS.map((action) => action.key)
    for (const key of keys) expect(ACTION_KEY.test(key) && key.length <= 80, key).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    expect(STEP_UP_ACTION_BY_KEY.get('bankDetails.change')?.canSwitchOff).toBe(true)
    expect(STEP_UP_ACTION_BY_KEY.get('access.change')?.canSwitchOff).toBe(false)
  })

  it('list on and off for the Security page: a fixed action always asks', () => {
    const view = stepUpActionsView(['bankDetails.change', 'access.change'])
    expect(view.find((entry) => entry.key === 'bankDetails.change')).toMatchObject({ on: false, canSwitchOff: true, fixed: null })
    expect(view.find((entry) => entry.key === 'access.change')).toMatchObject({ on: true, canSwitchOff: false, fixed: 'ACCESS' })
    expect(view.find((entry) => entry.key === 'workers.credentials')).toMatchObject({ on: true, permissions: ['workers.credentials'] })
  })
})
