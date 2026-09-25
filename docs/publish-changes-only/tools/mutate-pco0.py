#!/usr/bin/env python3
"""PCO-0 behavioral mutations. Run only after the lane's source files are stable.

API controls and service mutations include the disposable database fixture;
reader mutations use the reader and service integration suites. Every mutant
must fail its named assertion test.
Backups, test reports and logs stay in a unique /private/tmp directory. JSON lines
on stdout record predictions, outcomes and original/restored SHA-256 values.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass


ROOT = Path(__file__).resolve().parents[3]
API = "apps/api/src/services/pim/"
WEB = "apps/web/src/app/products/[id]/edit/_studio/publication/"
READER = API + "studio-publication-overwrite.ts"
SERVICE = API + "studio-publication.service.ts"
MODEL = WEB + "model.ts"
COMPONENT = WEB + "PublicationOverwrite.tsx"
API_TESTS = [API + "studio-publication-overwrite.vitest.test.ts", API + "studio-publication.vitest.test.ts"]
DATABASE_TEST = API + "studio-publication-database.vitest.test.ts"
DATABASE_ASSERTION = "binds a real stored content read to the selected listing and persists its explicit overwrite acknowledgement"
WEB_TESTS = [WEB + "model.vitest.test.ts", WEB + "PublicationOverwrite.vitest.test.ts"]
PUSH_PATTERN = r"^ *[0-9]+ (/[^ ]*/)?git push|^ *[0-9]+ /bin/bash \.githooks/pre-push"
TIMEOUT_SECONDS = 600


@dataclass(frozen=True)
class Mutation:
    name: str
    path: str
    old: str
    new: str
    test: str

    @property
    def group(self):
        return "api" if self.path.startswith(API) else "web"


MUTATIONS = [
    Mutation("reader-mixes-stock-evidence", READER,
             ".filter(entry => entry.source === source)", ".filter(() => true)",
             "does not count eBay stock reads"),
    Mutation("reader-loses-uncapped-count", READER,
             "const differing = Math.max(entries.length, status === 'not_read' ? 0 : count(clock.differing) ?? 0)",
             "const differing = fields.length",
             "reports source differences missing from capped or partial stored entries"),
    Mutation("reader-calls-unknown-coverage-zero", READER,
             "status === 'not_read' ? null : clock.notCompared",
             "status === 'not_read' ? 0 : clock.notCompared",
             "does not count eBay stock reads"),
    Mutation("reader-substitutes-current-nexus", READER,
             "nexusAtRead: entry.ours", "nexusAtRead: product.name",
             "shows stored Nexus/channel values and each observation date"),
    Mutation("reader-includes-excluded-listing", READER,
             "included.has(listing.productId) && listing.externalListingId", "listing.externalListingId",
             "keeps every included product visible and reads only existing listing IDs"),
    Mutation("submit-removes-confirmation", SERVICE,
             "if (plan.review.overwrite?.requiresConfirmation && input.confirmOverwrite !== true)", "if (false)",
             "refuses an existing listing overwrite without explicit true confirmation"),
    Mutation("submit-accepts-truthy-confirmation", SERVICE,
             "input.confirmOverwrite !== true", "!input.confirmOverwrite",
             "refuses an existing listing overwrite without explicit true confirmation"),
    Mutation("submit-does-not-bind-evidence", SERVICE,
             "publicationDigest([facts.revision, prepared, mode, overwrite])",
             "publicationDigest([facts.revision, prepared, mode])",
             "invalidates overwrite confirmation when the observed channel differences change"),
    Mutation("submit-loses-persisted-confirmation", SERVICE,
             "data.confirmOverwrite = plan.review.overwrite?.requiresConfirmation === true && input.confirmOverwrite === true",
             "data.confirmOverwrite = false",
             "records explicit overwrite confirmation with the submitted review"),
    Mutation("model-accepts-another-review", MODEL,
             "confirmedReviewId === review.id", "!!confirmedReviewId",
             "requires overwrite confirmation for the exact current review"),
    Mutation("model-accepts-missing-warning", MODEL,
             "if (!review.rows.some(row => row.existing) && !review.overwrite?.requiresConfirmation) return true",
             "if (!review.overwrite?.requiresConfirmation) return true",
             "requires overwrite confirmation for the exact current review"),
    Mutation("view-calls-history-current", COMPONENT,
             "<dt>Nexus at read</dt>", "<dt>Nexus now</dt>",
             "labels observed values as historical and names incomplete/capped coverage"),
    Mutation("view-hides-unread-status", COMPONENT,
             "product.status === 'not_read'", "false",
             "names unread and uncomparable products instead of presenting them as unchanged"),
    Mutation("view-hides-capped-details", COMPONENT,
             "product.omittedDifferences > 0", "false",
             "labels observed values as historical and names incomplete/capped coverage"),
]


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def wait_for_push():
    """The exact prescribed ps/grep check, with no shell or fail-open fallback."""
    while True:
        ps = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True, check=True)
        matches = subprocess.run(["/usr/bin/grep", "-E", PUSH_PATTERN], input=ps.stdout,
                                 capture_output=True, text=True)
        if matches.returncode == 1:
            return
        if matches.returncode != 0:
            raise RuntimeError("Push check failed; no mutation or restoration was written.")
        emit("waiting_for_push", processes=matches.stdout.strip(), retry_seconds=30)
        time.sleep(30)


def check_files(expected, backup_dir):
    changed = [path for path, content in expected.items()
               if not (ROOT / path).is_file() or (ROOT / path).read_bytes() != content]
    if changed:
        raise RuntimeError(f"Concurrent edit detected; refusing to overwrite {changed}. Backups: {backup_dir}")


def stop_child(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def is_assertion_failure(message):
    if re.search(r"\bAssertionError\b", message):
        return True
    # Vitest replaces a rejects AssertionError's stack with the Error captured
    # by its property getter. Require both its exact mismatch and that frame.
    return bool(re.search(
        r'\AError: promise resolved "[^\n]*" instead of rejecting\n'
        r'\s+at _Assertion\.__VITEST_REJECTS__ '
        r'\(file:///[^\n]*/node_modules/@vitest/expect/dist/index\.js:\d+:\d+\)',
        message,
    ))


def run_tests(label, group, tests, run_dir, env):
    cwd = ROOT / "apps" / group
    report_path = run_dir / f"{label}.json"
    log_path = run_dir / f"{label}.log"
    command = [str(ROOT / "node_modules/.bin/vitest"), "run",
               *(str(Path(path).relative_to(Path("apps") / group)) for path in tests),
               "--maxWorkers=1", "--reporter=default", "--reporter=json", f"--outputFile={report_path}"]
    emit("test_start", label=label, cwd=str(cwd), command=command, log=str(log_path))
    started = time.monotonic()
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while True:
                try:
                    code = process.wait(timeout=30)
                    break
                except subprocess.TimeoutExpired:
                    elapsed = time.monotonic() - started
                    emit("test_running", label=label, seconds=round(elapsed))
                    if elapsed >= TIMEOUT_SECONDS:
                        raise RuntimeError(f"{label}: infrastructure timeout; not an assertion kill. Log: {log_path}")
        finally:
            stop_child(process)
    output = log_path.read_text(errors="replace")
    if not report_path.is_file():
        raise RuntimeError(f"{label}: missing Vitest JSON; infrastructure failure, not a kill. Log: {log_path}")
    report = json.loads(report_path.read_text())
    suites = report.get("testResults", [])
    assertions = [a for suite in suites for a in suite.get("assertionResults", [])]
    failures = [a for a in assertions if a["status"] == "failed"]
    # Suite/import failures and unhandled errors never count as mutation detection.
    infrastructure = [suite.get("message") for suite in suites if suite.get("message")]
    unexpected = [a for a in assertions if a["status"] not in ("passed", "failed")]
    if (len(suites) != len(tests) or not assertions or infrastructure or unexpected
            or report.get("numFailedTests", 0) != len(failures)
            or re.search(r"Unhandled (?:Errors?|Rejections?|Exceptions?)|Worker exited unexpectedly|Failed to load|Transform failed|Test timed out|Hook timed out", output, re.I)):
        raise RuntimeError(f"{label}: incomplete/skipped tests or infrastructure failure; not a kill. Log: {log_path}")
    for assertion in failures:
        messages = assertion.get("failureMessages", [])
        if not messages or any(not is_assertion_failure(message) for message in messages):
            raise RuntimeError(f"{label}: non-assertion failure in {assertion['fullName']}; not a kill. Log: {log_path}")
    return {"exit_code": code, "passed": report["numPassedTests"], "failed": len(failures),
            "failures": [a["fullName"] for a in failures], "seconds": round(time.monotonic() - started, 2),
            "success": report.get("success") is True, "log": str(log_path), "report": str(report_path)}


def main():
    if os.environ.get("ALLOW_PROD_DB_TESTS") == "1":
        raise RuntimeError("Refusing ALLOW_PROD_DB_TESTS=1. API tests must retain the local database guard.")
    run_dir = Path(tempfile.mkdtemp(prefix="nexus-pco0-mutations-", dir="/private/tmp"))
    backup_dir = run_dir / "backups"
    paths = sorted({m.path for m in MUTATIONS} | set(API_TESTS + WEB_TESTS + [DATABASE_TEST,
                   "packages/shared/src/studio-publication.ts", API + "studio-publication-plan.ts"]))
    originals = {path: (ROOT / path).read_bytes() for path in paths}
    for path, content in originals.items():
        backup = backup_dir / path
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_bytes(content)
        if sha(backup.read_bytes()) != sha(content):
            raise RuntimeError(f"Backup verification failed: {backup}")
    emit("backups", directory=str(backup_dir), sha256={path: sha(value) for path, value in originals.items()})
    # Assert ALL anchors before even the first control; tests may not run against a stale plan.
    for mutant in MUTATIONS:
        found = originals[mutant.path].decode().count(mutant.old)
        if found != 1:
            raise RuntimeError(f"{mutant.name}: expected one original anchor, found {found}; no source touched.")
    emit("anchors_validated", count=len(MUTATIONS), mutants=[m.name for m in MUTATIONS])
    env = {**os.environ, "NEXUS_DISABLE_BACKGROUND_JOBS": "1", "NO_COLOR": "1"}
    env.pop("FORCE_COLOR", None)
    results = []
    active = None
    outcome = "failed"
    error = None

    def restore():
        nonlocal active
        if active is None:
            return
        path, mutated = active
        emit("prediction", action="restore", path=path, expected_sha256=sha(originals[path]))
        wait_for_push()
        current = (ROOT / path).read_bytes()
        if current not in (mutated, originals[path]):
            raise RuntimeError(f"Concurrent edit to mutated file {path}; refusing restoration. Original backup: {backup_dir / path}")
        if current != originals[path]:
            (ROOT / path).write_bytes(originals[path])
        if sha((ROOT / path).read_bytes()) != sha(originals[path]):
            raise RuntimeError(f"SHA-256 restoration failed: {path}; backup: {backup_dir / path}")
        active = None
        emit("restored", path=path, sha256=sha(originals[path]))

    try:
        for group, control_tests, mutant_tests in [("api", API_TESTS + [DATABASE_TEST], API_TESTS),
                                                  ("web", WEB_TESTS, WEB_TESTS)]:
            check_files(originals, backup_dir)
            emit("prediction", action="green_control", group=group, expected="all tests pass")
            control = run_tests(f"{group}-control", group, control_tests, run_dir, env)
            results.append({"name": f"{group}-control", **control})
            emit("control", group=group, **control)
            if control["exit_code"] != 0 or control["failed"] or not control["success"]:
                raise RuntimeError(f"{group} control is not green; its mutations were not attempted.")
            for mutant in [m for m in MUTATIONS if m.group == group]:
                emit("prediction", action="mutate", mutant=mutant.name, expected_assertion=mutant.test)
                wait_for_push()
                check_files(originals, backup_dir)
                mutated = originals[mutant.path].decode().replace(mutant.old, mutant.new, 1).encode()
                active = (mutant.path, mutated)
                try:
                    (ROOT / mutant.path).write_bytes(mutated)
                    expected = {**originals, mutant.path: mutated}
                    check_files(expected, backup_dir)
                    tests = mutant_tests + [DATABASE_TEST] if mutant.path == SERVICE else mutant_tests
                    result = run_tests(mutant.name, group, tests, run_dir, env)
                    check_files(expected, backup_dir)
                    requires_database_kill = mutant.path == SERVICE and mutant.name != "submit-accepts-truthy-confirmation"
                    database_killed = any(DATABASE_ASSERTION in name for name in result["failures"])
                    killed = (result["exit_code"] == 1 and result["failed"] > 0 and not result["success"]
                              and any(mutant.test in name for name in result["failures"])
                              and (not requires_database_kill or database_killed))
                    results.append({"name": mutant.name, "killed": killed, "database_killed": database_killed, **result})
                    emit("mutation", name=mutant.name, killed=killed, database_killed=database_killed, **result)
                    if not killed:
                        raise RuntimeError(f"{mutant.name}: survived or failed outside its named behavioral assertion.")
                finally:
                    restore()
        check_files(originals, backup_dir)
        outcome = "passed"
    except (Exception, KeyboardInterrupt) as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        # Interrupted tests are terminated by run_tests before any restoration starts.
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
             originals_sha256={path: sha(value) for path, value in originals.items()},
             restored=restored, results=results)
    return 0 if outcome == "passed" else 1


def interrupted(_signum, _frame):
    raise KeyboardInterrupt("Termination requested; restoring the current mutant.")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    try:
        sys.exit(main())
    except Exception as exc:
        emit("fatal", error=f"{type(exc).__name__}: {exc}")
        sys.exit(1)
