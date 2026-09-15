/** A drawer's latest edit can be saved immediately or explicitly abandoned. */
export function createIdleCommit(delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: (() => void) | undefined
  const cancel = () => { clearTimeout(timer); timer = undefined; pending = undefined }
  const flush = () => { const commit = pending; cancel(); commit?.() }
  return { cancel, flush, schedule(commit: () => void) { cancel(); pending = commit; timer = setTimeout(flush, delayMs) } }
}
