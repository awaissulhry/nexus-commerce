'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import { addPerson, createProject, listProjects, moveProject, peopleChoices, similarProjects, type ProjectRow, type ShortProject } from './api'
import { listOutsideCompanies, listSeasons, type PartyOption, type SeasonOption } from './list-api'
import { addressOf, addressText, asksSimilar, bulkReceipt, bulkStatusPlan, emptyNewDraft, HOME_ADDRESS, newBodyOf, newDraftHeld, queryOf, type BulkStatus, type ListAddress, type ListNotice, type NewDraft } from './list-model'
import { fieldOfPath, projectHref, projectsCan, readProblem, todayOf, writeProblem, type Notice } from './model'
import { ProjectsMessages } from './parts'
import type { BulkColleagueModel } from './view/BulkColleagueDialog'
import type { NewProjectModel } from './view/NewProjectDialog'
import { ProjectsView } from './view/ProjectsView'

/**
 * `/w/<company>/products/projects` (SCR-700, B-TH-248): the projects on the ONE list frame. The address holds the view and the
 * filters (list-model.ts); the rows are read in pages of 50 (Show more), again on `project.*` live changes ("N updates · Show") and
 * after every write. New project (`n`, `?new=1`, `&party=`, `&link=`) makes the project and opens its page. The bulk bar puts on
 * hold, resumes and adds a colleague, one call per project with its own version and key (what is skipped is counted in words).
 */
export function ProjectsPage() {
  return (
    <ProjectsMessages>
      <Container />
    </ProjectsMessages>
  )
}

const SIMILAR_DELAY = 400

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = session.user.id
  const can = useMemo(() => projectsCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])
  const [opened] = useState(() => new Date().toISOString())
  const today = todayOf(opened)

  // ---- the rows (pages of 50) ----------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const [count, setCount] = useState<number | null>(null)
  const [complete, setComplete] = useState(true)
  const [next, setNext] = useState<string | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<ListNotice | null>(null)
  const readId = useRef(0)
  const queryKey = JSON.stringify(queryOf(address))

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    setProblem(null)
    try {
      const answer = await listProjects(api, queryOf(address))
      if (id !== readId.current) return
      setRows(answer.rows)
      setCount(answer.count)
      setComplete(answer.complete)
      setNext(answer.next)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id === readId.current) setProblem(readProblem(error))
    }
    // The query's text stands for the address's terms the read uses.
  }, [api, can.view, queryKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRows(null)
    setCount(null)
    void load()
  }, [load])

  const loadMore = useCallback(async () => {
    if (!next || moreBusy) return
    const id = readId.current
    setMoreBusy(true)
    try {
      const answer = await listProjects(api, queryOf(address, next))
      if (id !== readId.current) return
      setRows((current) => {
        const known = new Set((current ?? []).map((row) => row.id))
        return [...(current ?? []), ...answer.rows.filter((row) => !known.has(row.id))]
      })
      setCount(answer.count)
      setComplete(answer.complete)
      setNext(answer.next)
    } catch (error) {
      setNotice({ tone: 'danger', lines: [{ key: readProblem(error) }] })
    } finally {
      setMoreBusy(false)
    }
  }, [api, address, next, moreBusy])

  // ---- the filter's outside companies and seasons -------------------------------------------------------------------------
  const [parties, setParties] = useState<PartyOption[] | null>(null)
  const [partiesProblem, setPartiesProblem] = useState<string | null>(null)
  const [seasons, setSeasons] = useState<SeasonOption[] | null>(null)
  const [seasonsProblem, setSeasonsProblem] = useState<string | null>(null)
  useEffect(() => {
    if (!can.view || !can.parties) return
    const controller = new AbortController()
    listOutsideCompanies(api, companyId, controller.signal)
      .then((items) => {
        setParties(items)
        setPartiesProblem(null)
      })
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        setParties(null)
        setPartiesProblem(readProblem(error))
      })
    return () => controller.abort()
  }, [api, can.view, can.parties, companyId])
  useEffect(() => {
    if (!can.view || !companyId) return
    const controller = new AbortController()
    listSeasons(api, companyId, controller.signal)
      .then((items) => {
        setSeasons(items)
        setSeasonsProblem(null)
      })
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        setSeasons(null)
        setSeasonsProblem(readProblem(error))
      })
    return () => controller.abort()
  }, [api, can.view, companyId])

  // ---- live ----------------------------------------------------------------------------------------------------------------
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (change.type.startsWith('project.')) setUpdates((value) => value + 1)
      },
      onReconnect: () => void load(),
    },
    can.view,
  )
  const offline = live === 'offline'

  // ---- New project ---------------------------------------------------------------------------------------------------------
  const [draft, setDraft] = useState<NewDraft | null>(null)
  const [newBusy, setNewBusy] = useState(false)
  const [newNotice, setNewNotice] = useState<Notice | null>(null)
  const [newLines, setNewLines] = useState<NewProjectModel['lines']>([])
  const [similar, setSimilar] = useState<ShortProject[]>([])
  const newKey = useRef<string | null>(null)
  const partyTerm = address.party
  useEffect(() => {
    if (!address.isNew || !can.view) {
      setDraft(null)
      return
    }
    newKey.current = null
    setNewNotice(null)
    setNewLines([])
    setSimilar([])
    setDraft(emptyNewDraft(partyTerm))
    // The dialog opens once per `?new=1` (with the company's party when asked from a company).
  }, [address.isNew, can.view, partyTerm])

  // The duplicate warning: asked while typing, after a pause, no spinner (nothing shown while it is asked or when none).
  const similarName = draft?.name ?? ''
  const similarParty = draft?.partyId ?? null
  useEffect(() => {
    if (!draft || !companyId || !asksSimilar(similarName, can)) {
      setSimilar([])
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      similarProjects(api, { companyId, partyId: similarParty, name: similarName }, controller.signal)
        .then(setSimilar)
        .catch(() => setSimilar([]))
    }, SIMILAR_DELAY)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // Only the name and the outside company ask again.
  }, [api, companyId, similarName, similarParty, can, draft === null]) // eslint-disable-line react-hooks/exhaustive-deps

  const submitNew = useCallback(async () => {
    if (!draft || newBusy || !companyId) return
    if (newDraftHeld(draft, { can, offline, leadId: me, companyId })) return
    setNewBusy(true)
    setNewNotice(null)
    setNewLines([])
    newKey.current ??= newIdempotencyKey()
    try {
      const project = await createProject(api, newBodyOf(draft, { companyId, leadId: me, link: address.link }), newKey.current)
      newKey.current = null
      setDraft(null)
      router.push(projectHref(prefix, project.id))
    } catch (error) {
      const refused = writeProblem(error)
      // A new attempt after a refusal is a new write (the same key again only after a lost answer).
      if (!refused.stale) newKey.current = null
      setNewNotice({ key: refused.key, ...(refused.params ? { params: refused.params } : {}), tone: 'danger' })
      setNewLines([...new Set(refused.paths.map(fieldOfPath))].map((key) => ({ key })))
    } finally {
      setNewBusy(false)
    }
  }, [draft, newBusy, companyId, can, offline, me, api, address.link, router, prefix])

  const newProject: NewProjectModel | null = draft
    ? {
        draft,
        can,
        prefix,
        companyId,
        lead: { id: me, name: session.user.displayName },
        parties: can.parties ? { items: parties, problem: partiesProblem } : null,
        seasons: { items: seasons, problem: seasonsProblem },
        similar,
        link: address.link,
        busy: newBusy,
        notice: newNotice,
        lines: newLines,
        offline,
      }
    : null

  // ---- bulk: Put on hold / Resume ---------------------------------------------------------------------------------------------
  const [bulkBusy, setBulkBusy] = useState(false)
  const bulkStatus = useCallback(
    async (ids: readonly string[], to: BulkStatus) => {
      if (bulkBusy || !rows) return
      const plan = bulkStatusPlan(
        rows.filter((row) => ids.includes(row.id)),
        to,
      )
      setBulkBusy(true)
      let done = 0
      let refused = 0
      for (const { row, move } of plan.moves) {
        try {
          await moveProject(api, row.id, move, row.version, newIdempotencyKey())
          done += 1
        } catch {
          refused += 1
        }
      }
      setBulkBusy(false)
      setNotice(bulkReceipt(to === 'ON_HOLD' ? 'hold' : 'resume', { done, already: plan.already, closed: plan.closed, refused }))
      void load()
    },
    [bulkBusy, rows, api, load],
  )

  // ---- bulk: Add a colleague -------------------------------------------------------------------------------------------------------
  const [colleague, setColleague] = useState<(BulkColleagueModel & { ids: readonly string[] }) | null>(null)
  const readChoices = useCallback(
    (ids: readonly string[], q: string) => {
      const first = ids[0]
      if (!first) return
      setColleague((now) => (now ? { ...now, q, choices: { items: null, problem: null } } : now))
      peopleChoices(api, first, q)
        .then((answer) => setColleague((now) => (now ? { ...now, choices: { items: answer.office, problem: null } } : now)))
        .catch((error: unknown) => setColleague((now) => (now ? { ...now, choices: { items: [], problem: readProblem(error) } } : now)))
    },
    [api],
  )
  const openColleague = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return
      setColleague({ ids, count: ids.length, choices: { items: null, problem: null }, q: '', picked: null, busy: false, notice: null })
      readChoices(ids, '')
    },
    [readChoices],
  )
  const submitColleague = useCallback(async () => {
    if (!colleague || colleague.busy || !colleague.picked) return
    const userId = colleague.picked
    setColleague({ ...colleague, busy: true, notice: null })
    let done = 0
    let refused = 0
    for (const projectId of colleague.ids) {
      try {
        await addPerson(api, projectId, userId, newIdempotencyKey())
        done += 1
      } catch {
        refused += 1
      }
    }
    setColleague(null)
    setNotice(bulkReceipt('colleague', { done, already: 0, closed: 0, refused }))
    void load()
  }, [colleague, api, load])

  return (
    <ProjectsView
      model={{
        prefix,
        me,
        today,
        can,
        address,
        rows,
        count,
        complete,
        hasMore: next !== null,
        moreBusy,
        problem,
        parties: can.parties ? parties : null,
        seasons,
        asOf,
        live,
        updates,
        notice,
        bulkBusy,
        newProject,
        colleague,
      }}
      actions={{
        onAddress: (patch) => go(patch),
        onClearFilters: () => go({ ...HOME_ADDRESS, view: address.view }),
        onRetry: () => void load(),
        onMore: () => void loadMore(),
        onShowUpdates: () => void load(),
        onOpen: (projectId, newTab) => {
          const target = projectHref(prefix, projectId)
          if (newTab) window.open(target, '_blank', 'noopener')
          else router.push(target)
        },
        onNew: () => go({ isNew: true }),
        newProject: {
          onDraft: (patch) => setDraft((now) => (now ? { ...now, ...patch } : now)),
          onSubmit: () => void submitNew(),
          onClose: () => {
            setDraft(null)
            go({ isNew: false, link: null })
          },
        },
        onBulkStatus: (ids, to) => void bulkStatus(ids, to),
        onBulkColleague: openColleague,
        colleague: {
          onQuery: (q) => colleague && readChoices(colleague.ids, q),
          onPick: (userId) => setColleague((now) => (now ? { ...now, picked: userId } : now)),
          onSubmit: () => void submitColleague(),
          onClose: () => setColleague(null),
        },
        onCopy: (numbers) => {
          void navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ tone: 'success', lines: [{ key: 'list.copied', params: { count: numbers.length } }] }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
