import { describe, expect, it } from 'vitest'
import { masterValueOrder } from './masterWrite'

/* Sheet pop-up rebuild P2: only a MASTER cell sends a value order, and only when one was dragged. */
describe('masterValueOrder', () => {
  const master = { write: { coordinate: { channel: null } } }
  it('sends the dragged order of a master cell', () => {
    expect(masterValueOrder({ ...master, valueOrder: { color: ['yellow', 'black'] } })).toEqual({ color: ['yellow', 'black'] })
  })
  it('sends nothing when nothing was dragged', () => {
    expect(masterValueOrder({ ...master })).toBeNull()
    expect(masterValueOrder({ ...master, valueOrder: {} })).toBeNull()
    expect(masterValueOrder(null)).toBeNull()
  })
  it('never sends a channel cell’s order: a channel’s own order is the channel’s', () => {
    expect(masterValueOrder({ write: { coordinate: { channel: 'EBAY' } }, valueOrder: { color: ['black'] } })).toBeNull()
  })
})
