'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLive } from '../../../_shared/buying/hooks'
import { runBulk } from '../../shared/bulk'
import { problemKey } from '../../shared/model'
import { listJobs, listRuns, runNow } from './api'
import { runNowReach } from './model'
import type { JobsActions, JobsModel } from './view/JobsCard'

const LIVE_TYPES = new Set(['jobs.run_requested', 'jobs.run_finished'])

/**
 * Jobs and integrations' container part (SCR-166 section `jobs`, B-W2b-415): reads `GET /admin/jobs` (security.view), again
 * on "Check again", when the tab comes back and on the live events jobs.run_requested / jobs.run_finished (a burst: one read);
 * a row opens its runs (`GET /admin/jobs/:key/runs`, 50 a page); Run now one or many after the confirm, one call each.
 */
export function useJobs(api: ApiClient, options: { readonly canView: boolean; readonly prefix: string }): { model: JobsModel | null; actions: JobsActions; reload: () => void } {
  const [list, setList] = useState<JobsModel['list']>({ answer: null, problem: null })
  const [selected, setSelected] = useState<string[]>([])
  const [confirm, setConfirm] = useState<JobsModel['confirm']>(null)
  const [history, setHistory] = useState<JobsModel['history']>(null)
  const [notice, setNotice] = useState<JobsModel['notice']>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!options.canView) return
    const mine = ++seq.current
    try {
      const answer = await listJobs(api)
      if (mine !== seq.current) return
      setList({ answer, problem: null })
      setSelected((current) => current.filter((key) => answer.jobs.some((job) => job.key === key)))
    } catch (error) {
      if (mine === seq.current) setList({ answer: null, problem: problemKey(error) })
    }
  }, [api, options.canView])

  const readRuns = useCallback(
    async (key: string, before: string | null) => {
      setHistory((current) => (current && current.key === key ? { ...current, loadingMore: before !== null, problem: null, ...(before ? {} : { runs: null }) } : { key, runs: null, nextBefore: null, problem: null, loadingMore: false }))
      try {
        const answer = await listRuns(api, key, before)
        setHistory((current) => (current && current.key === key ? { ...current, runs: before ? [...(current.runs ?? []), ...answer.runs] : answer.runs, nextBefore: answer.nextBefore, loadingMore: false } : current))
      } catch (error) {
        setHistory((current) => (current && current.key === key ? { ...current, problem: problemKey(error), loadingMore: false } : current))
      }
    },
    [api],
  )

  useEffect(() => {
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])
  const historyKey = history?.key ?? null
  useLive(
    (change) => {
      if (!LIVE_TYPES.has(change.type)) return
      void load()
      if (historyKey) void readRuns(historyKey, null)
    },
    () => void load(),
    options.canView,
  )

  const runGo = async () => {
    if (!confirm || confirm.busy || !list.answer) return
    const jobs = list.answer.jobs.filter((job) => confirm.keys.includes(job.key))
    const { applies } = runNowReach(jobs, list.answer.canRun)
    setConfirm({ ...confirm, busy: true, problem: null })
    const result = await runBulk(applies, (job) => runNow(api, job.key))
    if (result.done.length === 0 && result.refused.length > 0) return setConfirm({ ...confirm, busy: false, problem: result.refused[0]!.problem })
    setConfirm(null)
    setSelected([])
    setNotice(result.refused.length > 0 ? { key: 'aih.runNow.doneSome', tone: 'warning', params: { count: result.done.length, refused: result.refused.length } } : { key: 'aih.runNow.done', tone: 'success', params: { count: result.done.length } })
    void load()
  }

  const model = useMemo<JobsModel | null>(() => (options.canView ? { prefix: options.prefix, list, selected, confirm, history, notice } : null), [options.canView, options.prefix, list, selected, confirm, history, notice])

  return {
    model,
    reload: () => void load(),
    actions: {
      onSelect: setSelected,
      onRunNow: (keys) => setConfirm(keys ? { keys: [...keys], busy: false, problem: null } : null),
      onRunNowGo: () => void runGo(),
      onOpen: (key) => (key ? void readRuns(key, null) : setHistory(null)),
      onMoreRuns: () => (history?.nextBefore ? void readRuns(history.key, history.nextBefore) : undefined),
      onRetry: () => void load(),
      onRetryRuns: () => (history ? void readRuns(history.key, null) : undefined),
      onDismissNotice: () => setNotice(null),
    },
  }
}
