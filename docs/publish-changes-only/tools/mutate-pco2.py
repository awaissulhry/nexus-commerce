#!/usr/bin/env python3
"""PCO-2 planning/baseline mutations. AUTHOR ONLY until the main session runs it.

Both controls must pass before a source mutation. PCO-0's push, assertion-only
failure and foreign-edit guards are reused unchanged. Backups, reports and logs
remain in a unique /private/tmp directory; stdout is the JSON-lines evidence.
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
ENGINE = API + "studio-publication-changes.ts"
BASELINE = API + "studio-publication-baseline.ts"
GROUPS = {
    "engine": [API + "studio-publication-changes.vitest.test.ts"],
    "baseline": [API + "studio-publication-baseline.vitest.test.ts"],
}

MUTATIONS = [
    ("engine", Mutation("engine-conflates-null-and-absence", ENGINE,
        "if (left.state !== right.state) return false",
        "if (left.state !== right.state) return true",
        "distinguishes an explicit null value from absence and unknown")),
    ("engine", Mutation("engine-calls-unknown-equal", ENGINE,
        "if (left.state === 'unknown' || right.state === 'unknown') return null",
        "if (left.state === 'unknown' || right.state === 'unknown') return true",
        "unknown local with known baseline")),
    ("engine", Mutation("engine-auto-selects-first-publish-differences", ENGINE,
        "selectable = channel.state !== 'unknown'",
        "selectable = selectedByDefault = channel.state !== 'unknown'",
        "first publish differs")),
    ("engine", Mutation("engine-provider-verdict-overrides-unknown", ENGINE,
        "left.state === 'value' && right.state === 'value' && verdict !== undefined ? verdict : equal(left, right)",
        "verdict !== undefined ? verdict : equal(left, right)",
        "never lets a provider comparison verdict manufacture knowledge of an unread value")),
    ("engine", Mutation("engine-sends-unchanged-accepted-only-verdict", ENGINE,
        "} else if (localChanged === true) {", "} else if (true) {",
        "never automatically sends unchanged Nexus values when only accepted-channel equality is supplied")),
    ("engine", Mutation("engine-ignores-refusal", ENGINE,
        "if (input.refusal !== undefined)", "if (false)",
        "a refusal disables selection without hiding the comparison status")),
    ("engine", Mutation("selection-ignores-unknown-id", ENGINE,
        "if (!change) throw new Error('A selected field does not belong to this publication review.')",
        "if (!change) continue",
        "rejects unknown, duplicate, case-changed and nonselectable selection IDs")),
    ("engine", Mutation("selection-allows-unchanged-or-refused-field", ENGINE,
        "if (!change.selectable)", "if (false)",
        "rejects unknown, duplicate, case-changed and nonselectable selection IDs")),
    ("engine", Mutation("engine-sorts-array-values", ENGINE,
        "? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)",
        "? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : Array.isArray(entry) ? [...entry].sort() : entry)",
        "canonicalizes nested object keys while keeping array order and raw scalar values")),
    ("baseline", Mutation("baseline-replaces-history-instead-of-folding-fields", BASELINE,
        "for (const row of rows) {", "for (const row of rows) {\n        values.clear()",
        "folds sparse accepted publishes per field and applies later request ordinals last")),
    ("baseline", Mutation("baseline-adopts-unaccepted-records", BASELINE,
        "reason: 'publish', outcome: 'ACCEPTED', acceptedAt: { not: null }",
        "reason: 'publish'",
        "uses only the accepted sibling of a partial publication and excludes every non-baseline state")),
    ("baseline", Mutation("baseline-ignores-provider-sku", BASELINE,
        "journal.productId !== target.productId || journal.channelConnectionId !== scope.accountId || journal.sku !== target.sku",
        "journal.productId !== target.productId || journal.channelConnectionId !== scope.accountId",
        "does not adopt a journal with another identity")),
    ("baseline", Mutation("baseline-ignores-journal-account", BASELINE,
        "journal.productId !== target.productId || journal.channelConnectionId !== scope.accountId || journal.sku !== target.sku",
        "journal.productId !== target.productId || journal.sku !== target.sku",
        "does not adopt a journal with another identity")),
    ("baseline", Mutation("baseline-stops-after-full-page", BASELINE,
        "if (rows.length < PAGE_SIZE) break", "if (rows.length <= PAGE_SIZE) break",
        "continues past a full 250-row page without losing older untouched fields")),
    ("baseline", Mutation("baseline-keeps-old-values-across-legacy-write", BASELINE,
        "for (const field of known) values.set(publicationChangeId(target.productId, field), { state: 'unknown', reason: 'An accepted request has no versioned field intent; its effects are unknown.' })",
        "for (const field of []) values.set(publicationChangeId(target.productId, field), { state: 'unknown', reason: 'An accepted request has no versioned field intent; its effects are unknown.' })",
        "marks previously known fields unknown after a later accepted request-only journal, preserving cleared keys")),
    ("baseline", Mutation("baseline-turns-deletion-into-null-value", BASELINE,
        "value = { state: 'absent' }", "value = { state: 'value', value: null }",
        "keeps explicit deletion tombstones and replaces them on a later recreate")),
    ("baseline", Mutation("baseline-ignores-malformed-intent", BASELINE,
        "if (intent.intentVersion !== 1 || !Array.isArray(intent.writes)) throw new Error('An accepted publication request has unsupported or malformed field intent.')",
        "if (intent.intentVersion !== 1 || !Array.isArray(intent.writes)) continue",
        "refuses malformed latest intent instead of reusing an older clean baseline")),
]


def main():
    if os.environ.get("ALLOW_PROD_DB_TESTS") == "1":
        raise RuntimeError("Refusing ALLOW_PROD_DB_TESTS=1; API tests keep their local database guard.")
    run_dir = Path(tempfile.mkdtemp(prefix="nexus-pco2-mutations-", dir="/private/tmp"))
    backup_dir = run_dir / "backups"
    paths = sorted({m.path for _, m in MUTATIONS} | {p for tests in GROUPS.values() for p in tests}
                   | {"packages/shared/src/studio-publication.ts", "packages/database/prisma/schema.prisma",
                      "packages/database/prisma/baseline.sql", "docs/publish-changes-only/tools/mutate-pco0.py"})
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
