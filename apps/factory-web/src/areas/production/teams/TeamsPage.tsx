'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { createLoan, listTeams, type Team } from '../../people/_shared/api'
import { TIME_ZONE, todayIn, zonedInstant } from '../../people/_shared/model'
import { getTeamsBoard, type TeamsBoard } from './api'
import {
  BOARD_NS,
  boardModelOf,
  lendBodyOf,
  lendDraftOf,
  lendHeldOf,
  lendMaxDayOf,
  lendProblemOf,
  lendTeamsOf,
  ORDER_TEAMS_NS,
  peopleByTeamOf,
  problemKeyOf,
  teamsRightsOf,
  type LendDraft,
  type Words,
} from './model'
import { useGiveWindow } from './use-give'
import { GiveTeamsWindow } from './view/GiveTeamsWindow'
import { LendWindow } from './view/LendWindow'
import { TeamsBoardView } from './view/TeamsBoardView'

/**
 * `/w/<company>/production/teams` (owb-ss7 7.1 + 7.2; design § 5za, § 5zd; prototype teams.js teamsPage, teamModal, lendModal) — the
 * Teams page's container. Reads the board of the site (GET /production/teams/board, owb-ss5) and, with people.view, today's teams
 * (GET /people/teams: each team's people and its line, for the person chips and a loan). A card's "Give to a team… / Change…" opens the
 * window (use-give.ts, PUT …/teams); a person opens "Lend {name}" (today's POST /people/loans; a team with no line waits in words).
 * "All sites" with several sites: the page asks for the site first (a team works on one site). Nothing is counted here: every figure
 * is the API's, a team's, never a person's.
 */
export function TeamsPage() {
  return (
    <WithMessages namespaces={[BOARD_NS, ORDER_TEAMS_NS]}>
      <TeamsContainer />
    </WithMessages>
  )
}

function TeamsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const locale = useLocale()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/production\/teams\/?$/, '')
  const rights = useMemo(() => teamsRightsOf(session.permissions), [session.permissions])
  const siteId = scope.siteId ?? (scope.sites.length === 1 ? scope.sites[0]!.id : null)
  const mustChoose = siteId === null && scope.sites.length > 1

  const [board, setBoard] = useState<{ value: TeamsBoard | null; problem: string | null }>({ value: null, problem: null })
  const [teams, setTeams] = useState<readonly Team[] | null>(null)
  const [filter, setFilter] = useState('all')
  const [notice, setNotice] = useState<Words | null>(null)
  const readId = useRef(0)

  const load = useCallback(() => {
    if (mustChoose) return
    const id = ++readId.current
    setBoard((current) => ({ value: current.value, problem: null }))
    getTeamsBoard(api, siteId)
      .then((value) => id === readId.current && setBoard({ value, problem: null }))
      .catch((error: unknown) => id === readId.current && setBoard({ value: null, problem: problemKeyOf(error, false) }))
    if (rights.people)
      listTeams(api, siteId)
        .then((answer) => id === readId.current && setTeams(answer.teams.filter((team) => team.status === 'ACTIVE')))
        .catch(() => id === readId.current && setTeams(null))
  }, [api, siteId, mustChoose, rights.people])

  useEffect(() => {
    setBoard({ value: null, problem: null })
    setTeams(null)
    load()
  }, [load])

  const give = useGiveWindow(api, {
    board: board.value,
    onSaved: () => {
      setNotice({ key: 'notice.saved' })
      load()
    },
  })

  // ---- Lend a person (today's loans API) ----
  const today = todayIn(TIME_ZONE)
  const [lend, setLend] = useState<{ draft: LendDraft | null; busy: boolean; problem: string | null }>({ draft: null, busy: false, problem: null })
  const people = useMemo(() => peopleByTeamOf(teams), [teams])
  const lineOf = (teamId: string | null) => (teamId ? (people?.get(teamId)?.lineId ?? null) : null)
  const lendTeams = lend.draft ? lendTeamsOf(lend.draft, board.value) : []
  const lendHeld = lend.draft ? lendHeldOf(lend.draft, lineOf(lend.draft.toTeamId), today) : null
  const setDraft = (patch: Partial<LendDraft>) => setLend((current) => (current.draft && !current.busy ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current))
  const doLend = () => {
    const draft = lend.draft
    const lineId = draft ? lineOf(draft.toTeamId) : null
    if (!draft || !lineId || lend.busy || lendHeld) return
    const startsAt = new Date(Math.ceil(Date.now() / 900_000) * 900_000).toISOString()
    const body = lendBodyOf(draft, lineId, today, startsAt, (day) => zonedInstant(day, '23:59', TIME_ZONE))
    if (!body) return
    setLend((current) => ({ ...current, busy: true, problem: null }))
    createLoan(api, body)
      .then((loan) => {
        const team = board.value?.teams.find((each) => each.id === draft.toTeamId)
        setLend({ draft: null, busy: false, problem: null })
        setNotice({ key: 'lend.done', params: { name: draft.name, team: team?.name ?? '', date: formatDate(loan.endsAt, { locale, timeZone: TIME_ZONE }) } })
        load()
      })
      .catch((error: unknown) => setLend((current) => ({ ...current, busy: false, problem: lendProblemOf(error) })))
  }

  const model = {
    prefix,
    rights,
    state: mustChoose ? ('site' as const) : board.value ? ('ready' as const) : board.problem ? ('failed' as const) : ('reading' as const),
    problem: board.problem,
    board: board.value ? boardModelOf(board.value, people) : null,
    sites: scope.sites.map((site) => ({ id: site.id, name: site.name })),
    filter,
    notice,
    newTeamHref: `${prefix}/people/structure`,
  }

  const homeName = lend.draft?.homeTeamId ? (board.value?.teams.find((team) => team.id === lend.draft!.homeTeamId)?.name ?? null) : null

  return (
    <>
      <TeamsBoardView
        model={model}
        actions={{
          onRetry: load,
          onSite: (id) => scope.setSite(id),
          onFilter: setFilter,
          onGive: (card) => give.open(card.orderId, card.number),
          onLend: (member, teamId) => setLend({ draft: lendDraftOf(member, teamId), busy: false, problem: null }),
          onDismissNotice: () => setNotice(null),
        }}
      />
      <GiveTeamsWindow model={give.model} actions={give.actions} />
      <LendWindow
        model={{ open: lend.draft !== null, draft: lend.draft, homeName, teams: lendTeams, today, maxDay: lendMaxDayOf(today), held: lendHeld, busy: lend.busy, problem: lend.problem }}
        actions={{
          onClose: () => setLend((current) => (current.busy ? current : { draft: null, busy: false, problem: null })),
          onTeam: (teamId) => setDraft({ toTeamId: teamId }),
          onUntil: (until) => setDraft({ until }),
          onPick: (day) => setDraft({ picked: day }),
          onReason: (reason) => setDraft({ reason }),
          onLend: doLend,
        }}
      />
    </>
  )
}
