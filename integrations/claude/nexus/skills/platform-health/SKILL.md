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

1. **Accounts.** `channel-connections` (`channel`; `connectionId` for one account's last 10 events): health and why, sign-in state, markets, permissions missing since the channel asked for more, last sync and last error, own or shared with this business.
2. **Calls.** `channel-health` (`channel`, `hours` up to 168): failed and slow calls against their targets, how long the oldest waiting change has waited, incoming events that gave up, the five worst operations. `traceId` (from `sync-activity`) shows every channel call one change made.
3. **Inbox.** `alerts-inbox` (`source`, `severity`): failed or given-up syncs, alerts that fired and were not acknowledged, unread notifications, failed incoming events, worst first; the first page counts them and lists the alert rules.
4. **Queues.** `sync-activity` with `kind: "queue"` (`tab`: active, dead), `"failed-calls"`, `"webhooks"`, `"error-groups"`.
5. **Jobs.** `job-history` (`kind`: import, export, bulk, transfer; `status: "FAILED"`; `jobId` for one job and its first rows).
6. When asked: `audit-trail` (who changed what), `ai-usage` (Nexus's own AI use), `business-overview`.

## 2. Report

- Accounts that need a person (sign in again, grant a missing permission), with where: Settings › Channels in Nexus.
- Channels whose calls fail or lag, the worst operations, and the oldest waiting change.
- Alerts by severity, the recurring errors, and dead queue items per channel.
- Failed jobs, with the first failing rows' reasons.
- What could not be read (a tool not allowed for this person).

## 3. Offer (only when asked)

| To | Tool |
|---|---|
| Acknowledge or resolve alerts, mark notifications read | `acknowledge-alerts` (up to 50 each, with a `note`) |
| Create an alert rule or change one's threshold, window, channel or on/off | `set-alert-rule` (a new rule notifies the Nexus log only; where alerts are sent is set by a person) |
| Undo a finished bulk job or catalog import | `rollback-bulk-operation` (`jobId` from `job-history`; refused when a value changed since) |

Put them in ONE `submit-change-plan`. A failed listing push is re-sent with `publish-listing` (see `fix-listing-issues`), not from here.
