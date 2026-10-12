#!/usr/bin/env python3
"""mv-package-registry — check the composite actions this repo publishes.

    python3 test/check-actions.py            # check
    python3 test/check-actions.py --update   # rewrite the interface snapshot

WHY THIS EXISTS.  actionlint does NOT lint a standalone action.yml -- measured:
a reference to a nonexistent input in mv-package-test/action.yml was reported by
nothing and exited 0 (#70).  And the consumers cannot catch it either: json and
mapfield resolve these actions at @main, and actionlint only resolves LOCAL
(./.github/actions/...) references.  So nothing in the org checks the interface
these two repos depend on, and a mistake here fails SOMEONE ELSE'S CI on a
change they did not make (#72).

Two different questions, and both matter:

  INTERNAL CONSISTENCY -- does the action make sense on its own?  An expression
  naming an input that does not exist, a composite `run` step with no `shell:`,
  a `steps.<id>.outputs` with no such step: all parse, all fail at run time.

  INTERFACE STABILITY -- has the shape consumers rely on changed?  An action can
  be perfectly self-consistent and still have had an input renamed or newly
  required, which breaks every caller.  That is the one a schema check alone
  cannot see, so the declared inputs are recorded in a snapshot and compared.
  Changing an interface is then deliberate: run --update and the diff says what
  moved.
"""
import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / ".github" / "actions-interface.yml"
# The floor is the seven that exist now.  A glob that matches nothing must not
# pass, which is the trap #67's other jobs guard against by asserting counts.
MIN_ACTIONS = 7

fail: list[str] = []


def err(where: str, msg: str) -> None:
    fail.append(f"{where}: {msg}")
    print(f"  FAIL {where}: {msg}")


def steps_of(d: dict) -> list:
    runs = d.get("runs") or {}
    return runs.get("steps") or []


def check(path: pathlib.Path, d: dict) -> dict:
    """Check one action; return its declared interface."""
    name = path.parent.name
    raw = path.read_text()

    for key in ("name", "description"):
        if not d.get(key):
            err(name, f"no `{key}`")
    using = (d.get("runs") or {}).get("using")
    if not using:
        err(name, "no `runs.using` — this parses but is not an action")

    declared = d.get("inputs") or {}
    required = sorted(k for k, v in declared.items() if (v or {}).get("required"))
    optional = sorted(k for k in declared if k not in required)

    # Every `inputs.X` the action mentions must be declared.  This is the one
    # that catches a rename done in the inputs block and not in the body.
    for ref in sorted(set(re.findall(r"inputs\.([A-Za-z0-9_-]+)", raw))):
        if ref not in declared:
            err(name, f"uses `inputs.{ref}`, which is not declared "
                      f"(declared: {', '.join(sorted(declared)) or 'none'})")

    if using == "composite":
        ids = {s.get("id") for s in steps_of(d) if s.get("id")}
        for i, s in enumerate(steps_of(d), 1):
            if "run" in s and not s.get("shell"):
                err(name, f"step {i} has `run:` and no `shell:` — composite "
                          f"actions have no default shell")
        for ref in sorted(set(re.findall(r"steps\.([A-Za-z0-9_-]+)\.", raw))):
            if ref not in ids:
                err(name, f"references `steps.{ref}`, but no step has that id "
                          f"(ids: {', '.join(sorted(ids)) or 'none'})")

    return {"required": required, "optional": optional}


def main() -> int:
    paths = sorted(ROOT.glob(".github/actions/*/action.yml"))
    if len(paths) < MIN_ACTIONS:
        print(f"::error::found {len(paths)} actions, expected at least "
              f"{MIN_ACTIONS}. Either the discovery is broken, or an action "
              f"was removed — and consumers resolve these at @main, so a "
              f"removal breaks them. Lower MIN_ACTIONS deliberately if it "
              f"really is gone.")
        return 1

    found = {}
    for p in paths:
        try:
            d = yaml.safe_load(p.read_text())
        except Exception as exc:                       # noqa: BLE001
            err(p.parent.name, f"does not parse: {exc}")
            continue
        found[p.parent.name] = check(p, d)
        if not any(f.startswith(p.parent.name + ":") for f in fail):
            iface = found[p.parent.name]
            print(f"  ok   {p.parent.name}  required="
                  f"{','.join(iface['required']) or '-'}  optional="
                  f"{','.join(iface['optional']) or '-'}")

    if "--update" in sys.argv:
        SNAPSHOT.write_text(
            "# The published interface of this repo's composite actions.\n"
            "# CHECKED, NOT DECORATIVE: json and mapfield resolve these at\n"
            "# @main, so a renamed or newly-required input breaks their CI on a\n"
            "# change they did not make.  Regenerate deliberately with\n"
            "#   python3 test/check-actions.py --update\n"
            "# and let the diff say what moved.\n"
            + yaml.safe_dump(found, default_flow_style=False, sort_keys=True))
        print(f"\nwrote {SNAPSHOT.relative_to(ROOT)}")
        return 1 if fail else 0

    # INTERFACE STABILITY.  Compared name by name so the message says what
    # changed, rather than printing two blobs and leaving the reader to diff.
    if not SNAPSHOT.exists():
        print(f"::error::{SNAPSHOT.relative_to(ROOT)} is missing — "
              f"run `python3 test/check-actions.py --update`")
        return 1
    want = yaml.safe_load(SNAPSHOT.read_text()) or {}
    for gone in sorted(set(want) - set(found)):
        err(gone, "action is in the snapshot but not in the tree — removed? "
                  "consumers resolve it at @main")
    for added in sorted(set(found) - set(want)):
        err(added, "action is not in the snapshot — run --update to record it")
    for name in sorted(set(want) & set(found)):
        for kind in ("required", "optional"):
            w, g = set(want[name].get(kind) or []), set(found[name][kind])
            for i in sorted(w - g):
                err(name, f"input `{i}` was {kind} and is gone — "
                          f"every caller passing it breaks")
            for i in sorted(g - w):
                err(name, f"input `{i}` is newly {kind}"
                          + (" — every existing caller is now missing it"
                             if kind == "required" else ""))

    print(f"\n{len(paths)} actions, {len(fail)} problem(s)")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
