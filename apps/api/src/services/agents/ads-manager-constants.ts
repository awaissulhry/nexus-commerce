/**
 * ADS AUTONOMY W4 — the daily Claude ads run's constants that modules read WHILE LOADING. No imports, on purpose: the
 * run record, its tools, Claude's trust rules and the tool registry import one another, and a constant read at load
 * time inside such a cycle must come from a module that has nothing to wait for. runtime/module-load-order.vitest.test.ts
 * loads the cluster in every order a process can, in real Node ESM.
 */

/** The run record's agent key (AgentRun.agentKey): no charter, no agent definition, no fleet reader takes it. */
export const ADS_MANAGER_AGENT_KEY = 'claude-ads-manager'
/** The report's bell notice (Notification.type); `meta.runId` names the run, so a withdraw can take it back. */
export const ADS_RUN_NOTICE_TYPE = 'claude-ads-run'
/** The operator's clock for "one e-mail a day" and the daily caps — the Monday digest's (Europe/Rome). */
export const ADS_RUN_DAY_ZONE = 'Europe/Rome'
/** The most runs one business may record in one operator day (a start, or a report without one). */
export const RUNS_PER_DAY = 3
/** The most danger notices the daily reports of one business may raise in one operator day. */
export const DANGER_NOTICES_PER_DAY = 2
/** A start is refused while a run that started within this time is still open. */
export const OPEN_RUN_MS = 2 * 3600_000
