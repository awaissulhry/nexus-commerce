---
name: platform-health
description: Check the health of a Nexus business's platform side - channel accounts (sign-in state, missing permissions, last sync and error), how each channel's calls are doing, the alerts inbox, failed or stuck syncs, failed imports, exports and bulk jobs - explain what needs a person, and offer to acknowledge alerts, adjust alert rules or roll back a bulk job as requests a person approves. Use when the person asks whether the connections are healthy, why a sync failed, about alerts or notifications, or about failed jobs or imports.
---

# Platform health

Reads first. Connecting, reconnecting or disconnecting a channel account, retrying or purging queues, triggering schedules and anything about keys, tokens or webhooks stay with a person in Nexus: Claude never does them, and no tool shows a token or secret.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read

0. **Nexus's own checks.** `platform-health-checks` (`status: "problems"` for only what is not ok): the daily watchdog's verdict on scheduled jobs and process restarts, each data feed per market, whether ad writes reached Amazon, approved plan steps, automation that cannot progress and the queue path — each in plain words with its likely cause, next step and evidence. A stale run means the watchdog itself did not run; `live: true` measures now.
1. **Accounts.** `channel-connections` (`channel`; `connectionId` for one account's last 10 events): health and why, sign-in state, markets, permissions missing since the channel asked for more, last sync and last error, own or shared with this business. The channel accounts include Google (`channel: "GOOGLE"`): its sign-in reaches Google Ads, Merchant Center and Google Analytics, and a missing permission or a Google Ads account not yet chosen is fixed by a person in Settings › Channels › Google.
2. **Calls.** `channel-health` (`channel`, `hours` up to 168): failed and slow calls against their targets, how long the oldest waiting change has waited, incoming events that gave up, the five worst operations. `traceId` (from `sync-activity`) shows every channel call one change made.
3. **Inbox.** `alerts-inbox` (`source`, `severity`): failed or given-up syncs, alerts that fired and were not acknowledged, unread notifications, failed incoming events, worst first; the first page counts them and lists the alert rules.
4. **Queues.** `sync-activity` with `kind: "queue"` (`tab`: active, dead), `"failed-calls"`, `"webhooks"`, `"error-groups"`.
5. **Jobs.** `job-history` (`kind`: import, export, bulk, transfer; `status: "FAILED"`; `jobId` for one job and its first rows).
6. **Google Ads.** When the business has a Google Ads account: `google-ad-details` with `view: "alerts"` — spend pace (yesterday, or the month so far, ahead of the budget), no conversions (a campaign that spends and gets clicks but no conversion, or conversion tracking that stopped), disapproved ads and products that are not eligible, auto-apply on (Google applies its recommendations by itself), changes Google made on its own, settings changed and campaigns moved to AI Max. `notChecked` names the checks that could not run, and why (a part not read yet). `view: "disapprovals"` lists each ad and product with Google's reasons. A fix is a Google Ads change tool (a person approves it in Nexus) or a change in Google Ads; propose, never change unasked.
7. When asked: `audit-trail` (who changed what), `ai-usage` (Nexus's own AI use), `business-overview`.

## 2. Report

- Every check of `platform-health-checks` that is not ok, worst first, with its next step; then
- Accounts that need a person (sign in again, grant a missing permission), with where: Settings › Channels in Nexus.
- Channels whose calls fail or lag, the worst operations, and the oldest waiting change.
- Alerts by severity, the recurring errors, and dead queue items per channel.
- Failed jobs, with the first failing rows' reasons.
- Google Ads alerts, worst first (danger, then warn, then info), and the checks that could not run; the fix is a Google Ads change a person approves in Nexus (the `google-ads` skill), or a change in Google Ads.
- What could not be read (a tool not allowed for this person).

## 3. Offer (only when asked)

| To | Tool |
|---|---|
| Acknowledge or resolve alerts, mark notifications read | `acknowledge-alerts` (up to 50 each, with a `note`) |
| Create an alert rule or change one's threshold, window, channel or on/off | `set-alert-rule` (a new rule notifies the Nexus log only; where alerts are sent is set by a person) |
| Undo a finished bulk job or catalog import | `rollback-bulk-operation` (`jobId` from `job-history`; refused when a value changed since) |

Put them in ONE `submit-change-plan`. A failed listing push is re-sent with `publish-listing` (see `fix-listing-issues`), not from here.
