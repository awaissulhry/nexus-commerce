import { defineMachine } from '../../state/machine'

/**
 * The lives of the floor's identity records (plan A1 §2.5; features PLT-056, PLT-226, PLT-018, PLT-019), checked by
 * command() before every status change:
 *
 *   device   PENDING ──enrol (the one-time code)──► ACTIVE ──revoke──► REVOKED
 *               └──────────────revoke───────────────────────────────────┘     (final: enrol a new device)
 *   worker   ACTIVE ◄──reactivate── INACTIVE ◄──deactivate── ACTIVE
 *   badge    ACTIVE ──lost / revoke / reprint──► LOST | REVOKED                (final: issue a new badge)
 */

export type DeviceStatus = 'PENDING' | 'ACTIVE' | 'REVOKED'
export type WorkerStatus = 'ACTIVE' | 'INACTIVE'
export type BadgeStatus = 'ACTIVE' | 'LOST' | 'REVOKED'

export const deviceStatus = defineMachine<DeviceStatus>({
  name: 'device',
  states: ['PENDING', 'ACTIVE', 'REVOKED'],
  transitions: { PENDING: ['ACTIVE', 'REVOKED'], ACTIVE: ['REVOKED'] },
})

export const workerStatus = defineMachine<WorkerStatus>({
  name: 'worker',
  states: ['ACTIVE', 'INACTIVE'],
  transitions: { ACTIVE: ['INACTIVE'], INACTIVE: ['ACTIVE'] },
})

export const badgeStatus = defineMachine<BadgeStatus>({
  name: 'badge',
  states: ['ACTIVE', 'LOST', 'REVOKED'],
  transitions: { ACTIVE: ['LOST', 'REVOKED'] },
})
