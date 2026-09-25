#!/usr/bin/env python3
"""PCO-1 capture/receipt proof. Uses PCO-0's unchanged push and assertion guards.

All controls run before the first mutation. Source changes are temporary, one at
a time, and restored from verified per-file backups. Run with stable PCO files.
"""

import os
from pathlib import Path
import runpy
import signal
import sys
import tempfile


helpers = runpy.run_path(str(Path(__file__).with_name("mutate-pco0.py")), run_name="pco0_helpers")
ROOT = helpers["ROOT"]
Mutation = helpers["Mutation"]
emit, sha = helpers["emit"], helpers["sha"]
wait_for_push, check_files, run_tests = helpers["wait_for_push"], helpers["check_files"], helpers["run_tests"]
API = "apps/api/src/services/pim/"
AMAZON = API + "studio-publication-amazon.ts"
EBAY = API + "studio-publication-ebay.ts"
SERVICE = API + "studio-publication.service.ts"
SHOPIFY = "apps/api/src/services/shopify/content-sync.service.ts"
RESTORE = API + "listing-snapshot.service.ts"
RECORDS = API + "studio-publication-records.ts"

GROUPS = {
    "transports": [API + "studio-publication-transports.vitest.test.ts"],
    "shopify": ["apps/api/src/services/shopify/content-sync-journal.vitest.test.ts"],
    "service": [API + "studio-publication.vitest.test.ts", API + "studio-publication-database.vitest.test.ts"],
    "restore": [API + "workspace-snapshot.vitest.test.ts"],
    "records": [API + "studio-publication-records.vitest.test.ts"],
}

# The nonblocking-journal mutants consume rejection intentionally, as a
# fire-and-forget implementation would. Tests must kill the lost durability/order;
# an unhandled rejection would instead be rejected by PCO-0's infrastructure guard.
MUTATIONS = [
    ("transports", Mutation("amazon-capture-not-awaited", AMAZON,
        "await beforeSend?.(request)", "void beforeSend?.(request)?.catch(() => {})",
        "awaits the Amazon journal after every validation")),
    ("transports", Mutation("ebay-capture-omitted", EBAY,
        "try { await beforeSend?.({ operation, xml }) } catch (error) { markNotSent(error) }",
        "try { await Promise.resolve() } catch (error) { markNotSent(error) }",
        "does not send an eBay listing when the journal rejects")),
    ("transports", Mutation("ebay-captures-before-request-identity", EBAY,
        "await beforeSend?.({ operation, xml })", "await beforeSend?.({ operation, xml: plan.xml })",
        "awaits the eBay journal with final request identity")),
    ("shopify", Mutation("shopify-journal-omitted", SHOPIFY,
        "if (graphqlRootField(query).mutation) await beforeMutation?.({ query, variables })",
        "if (graphqlRootField(query).mutation) await Promise.resolve()",
        "does not issue a mutation if its durable journal fails")),
    ("shopify", Mutation("shopify-journal-not-awaited", SHOPIFY,
        "if (graphqlRootField(query).mutation) await beforeMutation?.({ query, variables })",
        "if (graphqlRootField(query).mutation) void beforeMutation?.({ query, variables })?.catch(() => {})",
        "awaits an exact query and variables journal before each Shopify mutation")),
    ("service", Mutation("service-capture-version-lost", SERVICE,
        "data.captureVersion = 1", "data.captureVersion = 0",
        "attributes Amazon messages by seller SKU and advances only the accepted SKU")),
    ("service", Mutation("service-final-settler-omitted", SERVICE,
        "if (stored.count && data.captureVersion === 1) await settlePublicationRecords(tx, recordContext(id, data, userId), result)",
        "if (false) await settlePublicationRecords(tx, recordContext(id, data, userId), result)",
        "journals the exact eBay request before dispatch and accepts it only after active read-back")),
    ("service", Mutation("service-amazon-callback-omitted", SERVICE,
        """const reference = await sendAmazonPublication(amazon, scope.accountId, request => recordPublicationRequests(context, request.feed.messages.map(message => {
          const products = amazon.products.filter(product => product.sku === message.sku)
          if (products.length !== 1) throw new Error(`The exact product for Amazon seller SKU ${message.sku} could not be recorded.`)
          return { productId: products[0].productId, sku: message.sku, request: { feedType: request.feedType, marketplaceIds: request.marketplaceIds, header: request.feed.header, message } }
        })))""",
        "const reference = await sendAmazonPublication(amazon, scope.accountId)",
        "attributes Amazon messages by seller SKU and advances only the accepted SKU")),
    ("service", Mutation("service-shopify-uses-nexus-sku", SERVICE,
        "sku: variants[0]?.sku ?? product.sku", "sku: product.sku",
        "records Shopify mutations against the effective variant SKU")),
    ("service", Mutation("service-shopify-starts-before-journal", SERVICE,
        "const shopify = plan.prepared", "providerStarted = true\n      const shopify = plan.prepared",
        "keeps a Shopify first-journal failure retryable without claiming a remote send")),
    ("service", Mutation("service-shopify-forgets-first-send", SERVICE,
        "await recordPublicationRequests(context, shopify.products.map(p => ({ ...p, request })), index)\n            providerStarted = true",
        "await recordPublicationRequests(context, shopify.products.map(p => ({ ...p, request })), index)\n            providerStarted = false",
        "keeps a Shopify later-journal failure unverified after one mutation attempt")),
    ("restore", Mutation("restore-allows-provider-journal", RESTORE,
        "if (payload?.kind === 'studio-publication') throw new WorkspaceScopeError(",
        "if (false) throw new WorkspaceScopeError(",
        "refuses provider request journals as restorable listing state")),
    ("records", Mutation("records-accepts-ebay-ack", RECORDS,
        "&& (result.status === 'ACCEPTED' || result.status === 'VERIFIED' || (context.channel === 'AMAZON' && result.status === 'PARTIAL' && receipt.status === 'ACCEPTED'))",
        "&& true",
        "never promotes an eBay ACK until the overall result confirms an active listing")),
    ("records", Mutation("records-ignores-account-coordinate", RECORDS,
        "marketplace: context.marketplace, channelConnectionId: context.accountId, aliasKey: context.aliasKey }, select:",
        "marketplace: context.marketplace, aliasKey: context.aliasKey }, select:",
        "refuses a missing exact coordinate without recording any intent")),
    ("records", Mutation("records-regresses-accepted-state", RECORDS,
        "if (row.outcome === 'ACCEPTED' || row.acceptedAt) continue", "if (false) continue",
        "keeps acceptance timestamps and audit success stable under repeated or stale status polling")),
    ("records", Mutation("records-allows-changed-ordinal", RECORDS,
        "if (digestPayload(journal.requests[requestIndex]) !== digestPayload(item.request)) throw new Error(",
        "if (false) throw new Error(",
        "reuses the same ordinal only for the same exact request")),
    ("records", Mutation("records-swallows-audit-failure", RECORDS,
        "update: { payloadDigest: digestPayload(journal.requests) } })",
        "update: { payloadDigest: digestPayload(journal.requests) } }).catch(() => undefined)",
        "rolls back the entire family journal if any awaited audit insert fails")),
    ("records", Mutation("records-loses-request-values", RECORDS,
        "request: exactRequest(item.request)", "request: exactRequest({})",
        "durably records the exact per-listing intent and awaited audit before the caller can send")),
    ("records", Mutation("records-matches-wrong-provider-sku", RECORDS,
        "result.results.filter(item => item.sku === journal.sku)",
        "result.results.filter(item => item.sku === journal.productId)",
        "keeps Amazon feed acknowledgement unaccepted and accepts only successful provider SKUs")),
    ("records", Mutation("records-extends-accepted-journal", RECORDS,
        "if (previous.outcome === 'ACCEPTED' || previous.acceptedAt) throw new Error(",
        "if (false) throw new Error(",
        "keeps acceptance timestamps and audit success stable under repeated or stale status polling")),
]


def main():
    if os.environ.get("ALLOW_PROD_DB_TESTS") == "1":
        raise RuntimeError("Refusing ALLOW_PROD_DB_TESTS=1; API tests keep their local database guard.")
    run_dir = Path(tempfile.mkdtemp(prefix="nexus-pco1-mutations-", dir="/private/tmp"))
    backup_dir = run_dir / "backups"
    paths = sorted({m.path for _, m in MUTATIONS} | {p for tests in GROUPS.values() for p in tests}
                   | {API + "studio-publication-records.ts", API + "studio-publication-overwrite.ts",
                      "packages/database/prisma/schema.prisma", "packages/database/prisma/baseline.sql",
                      "docs/publish-changes-only/tools/mutate-pco0.py"})
    originals = {path: (ROOT / path).read_bytes() for path in paths}
    for path, content in originals.items():
        backup = backup_dir / path
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_bytes(content)
        if sha(backup.read_bytes()) != sha(content):
            raise RuntimeError(f"Backup verification failed: {backup}")
    emit("backups", directory=str(backup_dir), sha256={path: sha(value) for path, value in originals.items()})
    for _, mutant in MUTATIONS:
        found = originals[mutant.path].decode().count(mutant.old)
        if found != 1:
            raise RuntimeError(f"{mutant.name}: expected one original anchor, found {found}; no source touched.")
    emit("anchors_validated", count=len(MUTATIONS), mutants=[m.name for _, m in MUTATIONS])
    env = {**os.environ, "NEXUS_DISABLE_BACKGROUND_JOBS": "1", "NO_COLOR": "1"}
    env.pop("FORCE_COLOR", None)
    results, active, error, outcome = [], None, None, "failed"

    def restore():
        nonlocal active
        if active is None:
            return
        path, mutated = active
        emit("prediction", action="restore", path=path, expected_sha256=sha(originals[path]))
        wait_for_push()
        current = (ROOT / path).read_bytes()
        if current not in (mutated, originals[path]):
            raise RuntimeError(f"Concurrent edit to {path}; refusing restoration. Original backup: {backup_dir / path}")
        if current != originals[path]:
            (ROOT / path).write_bytes(originals[path])
        if sha((ROOT / path).read_bytes()) != sha(originals[path]):
            raise RuntimeError(f"SHA-256 restoration failed for {path}; backup: {backup_dir / path}")
        active = None
        emit("restored", path=path, sha256=sha(originals[path]))

    try:
        for group, tests in GROUPS.items():
            check_files(originals, backup_dir)
            emit("prediction", action="green_control", group=group, expected="all tests pass")
            control = run_tests(f"{group}-control", "api", tests, run_dir, env)
            results.append({"name": f"{group}-control", **control})
            emit("control", group=group, **control)
            if control["exit_code"] != 0 or control["failed"] or not control["success"]:
                raise RuntimeError(f"{group} control is not green; no mutations attempted.")
        emit("all_controls_green", groups=list(GROUPS), next="temporary source mutations")
        for group, mutant in MUTATIONS:
            emit("prediction", action="mutate", mutant=mutant.name, expected_assertion=mutant.test)
            wait_for_push()
            check_files(originals, backup_dir)
            mutated = originals[mutant.path].decode().replace(mutant.old, mutant.new, 1).encode()
            active = (mutant.path, mutated)
            try:
                (ROOT / mutant.path).write_bytes(mutated)
                expected = {**originals, mutant.path: mutated}
                check_files(expected, backup_dir)
                result = run_tests(mutant.name, "api", GROUPS[group], run_dir, env)
                check_files(expected, backup_dir)
                killed = (result["exit_code"] == 1 and result["failed"] > 0 and not result["success"]
                          and any(mutant.test in name for name in result["failures"]))
                results.append({"name": mutant.name, "killed": killed, **result})
                emit("mutation", name=mutant.name, killed=killed, **result)
                if not killed:
                    raise RuntimeError(f"{mutant.name}: survived or failed outside its named behavioral assertion.")
            finally:
                restore()
        check_files(originals, backup_dir)
        outcome = "passed"
    except (Exception, KeyboardInterrupt) as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            restore()
        except (Exception, KeyboardInterrupt) as exc:
            error = f"{error or ''}; restoration blocked: {exc}"
            outcome = "failed"
        restored = {path: (ROOT / path).is_file() and sha((ROOT / path).read_bytes()) == sha(content)
                    for path, content in originals.items()}
        if not all(restored.values()):
            outcome = "failed"
        emit("summary", outcome=outcome, error=error, backups=str(backup_dir),
             killed=sum(r.get("killed", False) for r in results), planned=len(MUTATIONS),
             originals_sha256={path: sha(value) for path, value in originals.items()}, restored=restored, results=results)
    return 0 if outcome == "passed" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, helpers["interrupted"])
    try:
        sys.exit(main())
    except Exception as exc:
        emit("fatal", error=f"{type(exc).__name__}: {exc}")
        sys.exit(1)
