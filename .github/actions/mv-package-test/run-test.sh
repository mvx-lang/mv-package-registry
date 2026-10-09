#!/bin/sh
# mv-package-registry — run an MV package's own BASIC test in a real account.
# Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only (see LICENSE).
#
#   sh run-test.sh <udt|uv|jbase> "<sources>" <test> <cases>
#
# Runs INSIDE the licensed container, where the consumer's checkout is mounted
# at /pkg.  The action copies this script into that checkout and invokes it
# there, because $GITHUB_ACTION_PATH is a host path the container cannot see.
#
# It can be run by hand exactly as CI runs it:
#
#   uv-run 'sh /pkg/.mv-package-test/run-test.sh uv \
#             ".deps/mapfield/BP/MAPFIELD BP/JSONENCODE BP/JSONDECODE" \
#             tests/JSON.ESCAPES 5'
#
# A package's test needs an ACCOUNT, because its functions have to be compiled
# and CATALOGed before a program can DEFFUN them.  That is the whole reason
# these tests were run by hand for as long as they were (json#40).
#
# ONE SCRIPT FOR THREE PLATFORMS AND EVERY PACKAGE, because almost none of it
# varies.  Making an account and starting a session is per-platform; copying
# sources in, compiling them and reading the answer is neither per-platform nor
# per-package.  The assertions are the part that must not drift -- between arms
# or between packages -- or a green run says less than it appears to, so they
# live here once.  Everything below was measured on the real systems, and the
# comments say which failure each line is there for.
set -eu

PLATFORM="${1:?usage: run-test.sh <udt|uv|jbase> \"<sources>\" <test> <cases>}"
SOURCES="${2:?no sources: the BASIC items to compile and catalog}"
TESTITEM="${3:?no test: the PROGRAM to run}"
CASES="${4:?no case count: how many ok=1 lines the test must print}"

SRC="${MVPKGTEST_SRC:-/pkg}"
ACCT="${MVPKGTEST_ACCT:-/tmp/mvpkgtest}"
LOG="${MVPKGTEST_LOG:-/tmp/mvpkgtest.log}"
TESTNAME=$(basename "$TESTITEM")

die() { echo "::error::$*" >&2; exit 1; }

# EVERY SOURCE IS CHECKED BEFORE ANYTHING IS BUILT.  A package's own items come
# from its checkout and a dependency's from wherever the consumer put it, so a
# missing one is a workflow mistake, not a compile error -- and left to the
# compiler it surfaces as an unresolved function in a program nobody changed.
# Say which path was looked at.
for _s in $SOURCES "$TESTITEM"; do
    [ -f "$SRC/$_s" ] || die "no such source: $SRC/$_s"
done

# AND NO TWO MAY SHARE A BASENAME.  BP holds items, and the item name is the
# basename -- so two sources with the same one silently become a single item,
# the second overwriting the first, and the test exercises whichever won.
_dups=$(for _s in $SOURCES "$TESTITEM"; do basename "$_s"; done | sort | uniq -d)
[ -z "$_dups" ] || die "two sources share an item name: $(echo "$_dups" | tr '\n' ' ')"

# A non-interactive shell has no TERM, and an MV session with no TERM can
# produce EMPTY output -- which reads as a code regression, with nothing in the
# failure saying "TERM" (mv_git#199).
export TERM="${TERM:-vt100}"

# ---------------------------------------------------------------------------
# Make an account.  Not a directory: on every one of these platforms a bare
# directory compiles nothing and catalogs nowhere, and the run then goes green
# about something no user would ever have.  mv_git had 48 assertions passing
# that way on jBASE (mv_git#114), so each arm below PROVES what it built.
# ---------------------------------------------------------------------------
rm -rf "$ACCT"

case "$PLATFORM" in
udt)
    MV="${UDTHOME:-/usr/ud83}/bin/udt"
    NEWACCT="${UDT_NEWACCT:-${UDTHOME:-/usr/ud83}/bin/newacct}"
    [ -x "$NEWACCT" ] || die "no newacct at $NEWACCT"
    mkdir -p "$ACCT"
    # newacct makes an account out of a bare directory, prompting for
    # confirmation and then owner and group; the answers are piped in.
    ( cd "$ACCT" && printf 'y\n%s\n%s\n' "$(id -un)" "$(id -gn)" | "$NEWACCT" ) \
        >/dev/null 2>&1 || true
    ;;
uv)
    MV="${UVHOME:-/usr/uv}/bin/uv"
    mkdir -p "$ACCT"
    # A UniVerse account is BORN by running uv in an empty directory, which
    # asks to update RELLEVEL and then for a flavour -- Y and 3 (Pick), the
    # flavour these packages target.
    ( cd "$ACCT" && printf 'Y\n3\nQUIT\n' | "$MV" ) >/dev/null 2>&1 || true
    # THE LICENCE IS A HANDFUL OF SEATS AND A SESSION THAT HAS JUST QUIT DOES
    # NOT GIVE ITS SEAT BACK INSTANTLY.  What that looks like is never an
    # error: the next command simply does not happen, and `BASIC BP *` then
    # reports "compiled 0 program(s)" (mv_git#187).  Everything after this
    # runs in ONE session for the same reason.
    sleep 2
    ;;
jbase)
    MV=jsh
    # THE NAME IS REGISTERED, NOT THE PATH.  CREATE-ACCOUNT records the
    # basename in jBASE's SYSTEM file and REFUSES one already there, and
    # removing the directory does not remove the registration.  CI gets a fresh
    # container every run so this only bites when running it by hand -- which
    # is exactly when a silent refusal would mislead.  DELETE-ACCOUNT -f also
    # deletes the directory its registration points at, so it runs BEFORE the
    # directory exists and never after.
    DELETE-ACCOUNT -f "$(basename "$ACCT")" >/dev/null 2>&1 || true
    CREATE-ACCOUNT "$ACCT" >/dev/null 2>&1 || die "CREATE-ACCOUNT $ACCT was refused"
    # The session finds the account's MD through this, and nothing has set it:
    # these tests drive jsh directly rather than logging in.
    export JEDIFILENAME_MD="$ACCT"
    ;;
*)
    die "unknown platform '$PLATFORM' (want udt, uv or jbase)"
    ;;
esac

# AND PROVE IT IS AN ACCOUNT.  Measured: UniData's newacct and UniVerse's
# account birth both leave a VOC; jBASE has no VOC at all and leaves MD]D, a
# bin and a lib.  Trusting the exit status instead is what the arms above
# deliberately do not do -- two of the three creation commands here exit 0
# whatever happened.
case "$PLATFORM" in
udt|uv)
    [ -e "$ACCT/VOC" ] || die "$ACCT has no VOC -- that is a directory, not an account"
    ;;
jbase)
    for part in "MD]D" bin lib; do
        [ -e "$ACCT/$part" ] || \
            die "$ACCT has no $part -- that is a directory, not an account"
    done
    ;;
esac

cd "$ACCT"

# BP HAS TO BE A DIRECTORY FILE, or copying OS files into it produces no
# records at all, and the failure is silent: `BASIC BP X` reports a missing
# record, or on UniVerse "compiled 0 program(s)", and neither says anything
# about files.  So each arm makes one and then it is ASSERTED.
#
# ONLY udt IS BORN WITH ONE.  That was measured, not assumed, and the
# assumption cost a CI run: newacct builds a standard account with BP in it,
# while a UniVerse account arrives with a VOC, VOCLIB and &SAVEDLISTS& and no
# BP whatever, and jBASE has no such notion at all.
MKFILE_OUT=""
case "$PLATFORM" in
udt)
    : ;;
uv)
    # CREATE.FILE ASKS SEVEN QUESTIONS, not six: modulo, separation and type
    # for the DICTionary, the same three for the DATA part, and then a FILE
    # DESCRIPTION.
    #   dict: modulo 1, separation 2, type 3  (hashed)
    #   data: modulo 1, separation 2, type 19 (directory -- it holds sources)
    #
    # THE DESCRIPTION IS THE TRAP, and it is answered with an EMPTY line on
    # purpose: UniVerse stores it in VOC attribute 1 as "F <description>", and
    # anything that compares attribute 1 to "F" then cannot see the file at
    # all.  An empty answer leaves a clean "F".
    #
    # IT RUNS BEFORE THE DIRECTORY EXISTS.  CREATE.FILE is what makes the VOC
    # pointer, the dictionary and the directory together, and it refuses once
    # the directory is there -- and the VOC pointer, not the dictionary on
    # disk, is what makes BP usable.
    #
    # AND ITS REFUSAL IS THE ONLY THING THAT SAYS WHY, so it is captured and
    # printed below rather than thrown away.  Throwing it away cost mv_git four
    # CI runs on a message that named neither the reason nor the remedy
    # (mv_git#226).
    MKFILE_OUT=$(printf 'CREATE.FILE BP\n1\n2\n3\n1\n2\n19\n\nQUIT\n' \
                   | "$MV" 2>&1) || true
    # Another session gone, and its seat may not be back yet (mv_git#187).
    sleep 2
    ;;
jbase)
    MKFILE_OUT=$(printf 'CREATE-FILE BP 1 11 TYPE=UD\nQUIT\n' | "$MV" 2>&1) || true
    ;;
esac

if [ ! -d "$ACCT/BP" ]; then
    echo "::error::$ACCT/BP is not a directory file -- nothing can be compiled" >&2
    if [ -n "$MKFILE_OUT" ]; then
        echo "---- what the file creation said ----" >&2
        printf '%s\n' "$MKFILE_OUT" >&2
    fi
    echo "---- $ACCT ----" >&2
    ls -la "$ACCT" >&2 || true
    exit 1
fi

# The package's items, any dependency's, and the test itself -- flattened into
# BP under their basenames, which is what `BASIC BP X` names.
for _s in $SOURCES "$TESTITEM"; do
    cp "$SRC/$_s" "$ACCT/BP/$(basename "$_s")"
done

# EVERY SOURCE GETS A TRAILING NEWLINE.  UniVerse's compiler rejects a source
# whose last line is unterminated -- "End of File unexpected, Was expecting:
# ';', End of Line" -- which is why build-pkg.sh does this for the shipped
# artifact (json#20, mapfield#11).  Doing it here as well means a source that
# loses one does not take the uv arm down with a message about syntax.
# Appending only when it is missing keeps this idempotent.
for f in "$ACCT"/BP/*; do
    [ -f "$f" ] || continue
    [ -n "$(tail -c 1 "$f")" ] && printf '\n' >> "$f"
done

# ---------------------------------------------------------------------------
# ONE SESSION.  Not tidiness: on UniVerse a rapid sequence of short sessions
# runs the licence out of seats and the symptom is a command that silently does
# not happen (mv_git#187).  One session cannot hit that, and it costs nothing
# on the other two.
#
# CATALOG each source so DEFFUN can resolve it.  The test itself is a PROGRAM
# and is RUN from its object, so it needs no catalog of its own.
#
# A FAILED COMPILE GOES TO STDOUT AND THE SESSION CARRIES ON, leaving the old
# object or none in place, and a piped session's exit status is the status of
# its last command only.  So neither the status nor the absence of a message
# says this worked: the log is the evidence, and it is read below.
# ---------------------------------------------------------------------------
# LOCAL catalogs into the account's own space rather than the system's.  On
# UniData a system catalog would need to run as the operator, and a root-owned
# CTLG then breaks later MVPKG upgrades on that install -- CI must not leave
# that behind, and the account is the right scope for a test anyway.
CAT_SUFFIX=" LOCAL"
[ "$PLATFORM" = jbase ] && CAT_SUFFIX=""

{
    for _s in $SOURCES; do
        _i=$(basename "$_s")
        printf 'BASIC BP %s\n' "$_i"
        printf 'CATALOG BP %s%s\n' "$_i" "$CAT_SUFFIX"
    done
    printf 'BASIC BP %s\n' "$TESTNAME"
    printf 'RUN BP %s\n' "$TESTNAME"
    printf 'QUIT\n'
} | "$MV" >"$LOG" 2>&1 || true

echo "---- $PLATFORM session ----"
cat "$LOG"
echo "---------------------------"

# ---------------------------------------------------------------------------
# ASSERT A POSITIVE FACT, NOT THE ABSENCE OF A BAD ONE.  The test prints one
# `ok=` line per case and then FAILURES=0, so requiring exactly <cases> `ok=1`
# and no `ok=0` fails a session that compiled nothing and ran nothing -- which
# is what a bare `grep FAILURES=0` would call a pass on an empty log.
#
# THE COUNT IS THE CONSUMER'S TO DECLARE, and it is exact rather than a minimum
# on purpose: a test that quietly loses a case still prints FAILURES=0 and
# still prints no ok=0, so "at least one passed" would go green on a shrinking
# suite.
#
# Unanchored: a piped session puts a login banner and TCL prompts around this
# output, and on two of these platforms some of it lands on the same line.
# ---------------------------------------------------------------------------
fail=0
oks=$(grep -c 'ok=1' "$LOG" || true)
bad=$(grep -c 'ok=0' "$LOG" || true)
[ "$oks" -eq "$CASES" ] || \
    { echo "::error::$PLATFORM: expected $CASES passing cases, saw $oks"; fail=1; }
[ "$bad" -eq 0 ] || { echo "::error::$PLATFORM: $bad case(s) failed"; fail=1; }
grep -q 'FAILURES=0' "$LOG" || { echo "::error::$PLATFORM: no FAILURES=0 reported"; fail=1; }

if [ "$fail" -ne 0 ]; then
    # WHAT THE ACCOUNT ACTUALLY ENDED UP WITH.  A compile that failed leaves no
    # object, and that distinguishes "did not build" from "built and gave the
    # wrong answer" -- without an assertion having to guess each platform's
    # catalog layout, which is the kind of guess that produces a red run about
    # the wrong thing.
    echo "---- $ACCT ----"
    ls -la "$ACCT" 2>/dev/null | sed 's/^/  /' || true
    for d in BP.O CTLG cat lib bin; do
        [ -e "$ACCT/$d" ] || continue
        echo "  -- $d:"
        find "$ACCT/$d" -type f 2>/dev/null | sed 's/^/    /' || true
    done
    echo "---------------"
    exit 1
fi

echo "mv-package-test($PLATFORM): $TESTNAME passed all $CASES cases in $ACCT"
