/**
 * 2.4 — the Variants page's writes go ONE AT A TIME, in the order they were asked (the Matrix's `writeChain`, #592).
 *
 * Two quick ticks used to be sent together, both on the version they were made on: the first moved the listing, the
 * second answered 409 and was dropped. In line, each write starts once the one before it has settled, so it is sent at
 * the version that write left. A task that fails or throws never stops the line.
 */
export type WriteQueue = <T>(task: () => Promise<T>) => Promise<T>

export function writeQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}
