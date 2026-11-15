#!/usr/bin/env bash
# Agent document toolchain: a pinned, hash-verified set of Python wheels (toolchain/agent-tools.lock.json) that lets
# a founder's sandboxed `exec` produce AND verify customer deliverables — XLSX (openpyxl, XlsxWriter, formulas
# recalculation), DOCX (python-docx), PDF (reportlab, pypdf, pypdfium2), images (Pillow), spelling (pyspellchecker),
# v79: slide decks (python-pptx) for courses and pitches.
# The hosts' system python3 (3.12, stdlib only, no pip / ensurepip / venv) is enough: a wheel is a zip, so it is
# unpacked with the stdlib zipfile module. Nothing is compiled, no installer runs, no package code runs at install.
#
#   scripts/fleet-agent-tools.sh install <prefix>    download every lock entry (https, files.pythonhosted.org only),
#                                                    verify its sha256 (fail closed), unpack into <prefix>/site, write
#                                                    <prefix>/bin/fleet-python, LOCK_SHA256 and TREE_SHA256
#   scripts/fleet-agent-tools.sh verify <prefix>     recompute the tree digest, compare, smoke-import every module;
#                                                    prints ONE JSON line {ok, lock, tree, modules:{name: version}}
#   scripts/fleet-agent-tools.sh prefix              print the production prefix for the current lock
#
# Production (the operator runs it; this script never calls sudo itself):
#   P=$(scripts/fleet-agent-tools.sh prefix)          # /usr/local/lib/automaton-fleet-tools/<lock sha256, first 12>
#   sudo scripts/fleet-agent-tools.sh install "$P"
#   sudo scripts/fleet-agent-tools.sh verify "$P"
#   sudo ln -sfn "$P" /usr/local/lib/automaton-fleet-tools/current
#   then FLEET_AGENT_TOOLS_DIR=/usr/local/lib/automaton-fleet-tools/current for the founder runtime (the caller passes
#   it to runSandboxed as toolsDir; the Landlock domain grants read+execute on it, never write).
# A new lock installs side by side under its own prefix; rollback = point `current` back. Old prefixes are inert.
#
# Install is atomic: everything is built in <prefix>.partial.<pid> and renamed into place only after every hash
# matched. An existing non-empty <prefix> is refused unless it already carries the same LOCK_SHA256 and its tree
# still matches (then it is a no-op). Result is world-readable: dirs 0755, files 0644, bin/fleet-python 0755.
# No .pyc is written at install (PYTHONDONTWRITEBYTECODE=1) and the wrapper keeps it that way, so TREE_SHA256
# stays a stable fingerprint of exactly what the lock pinned.
set -euo pipefail
umask 022
export PYTHONDONTWRITEBYTECODE=1
MODE="${1:?usage: install <prefix> | verify <prefix> | prefix}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="${FLEET_AGENT_TOOLS_LOCK:-$REPO/toolchain/agent-tools.lock.json}"
PY=/usr/bin/python3
PROD_ROOT=/usr/local/lib/automaton-fleet-tools

lock_sha() { sha256sum "$LOCK" | cut -d' ' -f1; }

# Deterministic digest over everything under bin/ and site/: for each regular file in sorted relative-path order,
# "<relpath>\0<sha256 of file>\n". Symlinks, sockets etc. make it fail (a wheel never produces them).
tree_sha() {
  "$PY" -I -S - "$1" <<'PYEOF'
import hashlib, os, stat, sys
root = sys.argv[1]
entries = []
for top in ("bin", "site"):
    base = os.path.join(root, top)
    for d, dirs, files in os.walk(base):
        for n in dirs + files:
            p = os.path.join(d, n)
            st = os.lstat(p)
            if stat.S_ISDIR(st.st_mode):
                continue
            if not stat.S_ISREG(st.st_mode):
                sys.exit("unexpected non-regular file " + p)
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            entries.append((os.path.relpath(p, root), h.hexdigest()))
entries.sort()
t = hashlib.sha256()
for rel, h in entries:
    t.update(rel.encode() + b"\0" + h.encode() + b"\n")
print(t.hexdigest())
PYEOF
}

case "$MODE" in
  prefix)
    echo "$PROD_ROOT/$(lock_sha | cut -c1-12)"
    ;;

  install)
    PREFIX="${2:?install <prefix>}"
    [[ "$PREFIX" = /* ]] || { echo "prefix must be absolute" >&2; exit 2; }
    PREFIX="${PREFIX%/}"
    LSHA="$(lock_sha)"
    if [[ -e "$PREFIX" || -L "$PREFIX" ]]; then
      [[ -d "$PREFIX" && ! -L "$PREFIX" ]] || { echo "refusing: $PREFIX exists and is not a plain directory" >&2; exit 3; }
      if [[ -n "$(ls -A "$PREFIX")" ]]; then
        if [[ -f "$PREFIX/LOCK_SHA256" && "$(cat "$PREFIX/LOCK_SHA256")" == "$LSHA" && -f "$PREFIX/TREE_SHA256" \
              && "$(tree_sha "$PREFIX")" == "$(cat "$PREFIX/TREE_SHA256")" ]]; then
          echo "already installed: $PREFIX (lock $LSHA, tree $(cat "$PREFIX/TREE_SHA256"))"
          exit 0
        fi
        echo "refusing: $PREFIX is not empty and is not an intact install of lock $LSHA" >&2
        exit 3
      fi
      rmdir "$PREFIX"
    fi
    mkdir -p "$(dirname "$PREFIX")"
    STAGE="$PREFIX.partial.$$"
    DL="$(mktemp -d)"
    trap 'rm -rf "$DL" "$STAGE"' EXIT
    mkdir -p "$STAGE/site" "$STAGE/bin"
    # The lock is parsed by the stdlib only; every field is validated before it reaches curl or a path.
    "$PY" -I -S - "$LOCK" > "$DL/plan.tsv" <<'PYEOF'
import json, re, sys
lock = json.load(open(sys.argv[1]))
assert lock.get("python") == "cp312", "lock is not for cp312"
seen = set()
for p in lock["packages"]:
    name, ver, fn, url, sha = p["name"], p["version"], p["filename"], p["url"], p["sha256"]
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*\.whl", fn), fn
    assert url.startswith("https://files.pythonhosted.org/packages/") and url.endswith("/" + fn), url
    assert re.fullmatch(r"[0-9a-f]{64}", sha), sha
    assert fn not in seen, fn
    seen.add(fn)
    print("\t".join((name, ver, fn, url, sha)))
PYEOF
    n=0
    while IFS=$'\t' read -r name ver fn url sha; do
      curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$DL/$fn" "$url"
      got="$(sha256sum "$DL/$fn" | cut -d' ' -f1)"
      if [[ "$got" != "$sha" ]]; then
        echo "SHA256 MISMATCH for $fn: expected $sha got $got — nothing installed" >&2
        exit 4
      fi
      n=$((n + 1))
      echo "ok  $name $ver ($fn)"
    done < "$DL/plan.tsv"
    # Unpack only after every wheel verified. Entries escaping the target (absolute, '..') abort the install.
    # <dist>.data/purelib|platlib go to site/; other .data schemes (scripts, headers, data) are not installed.
    "$PY" -I -S - "$DL/plan.tsv" "$DL" "$STAGE/site" <<'PYEOF'
import os, sys, zipfile
plan, dl, site = sys.argv[1:4]
site = os.path.realpath(site)
for line in open(plan):
    fn = line.rstrip("\n").split("\t")[2]
    with zipfile.ZipFile(os.path.join(dl, fn)) as z:
        for info in z.infolist():
            name = info.filename
            if name.startswith("/") or "\\" in name or ".." in name.split("/"):
                sys.exit("unsafe entry %r in %s" % (name, fn))
            parts = name.split("/")
            if parts[0].endswith(".data") and len(parts) > 2:
                if parts[1] not in ("purelib", "platlib"):
                    continue
                parts = parts[2:]
            if info.is_dir() or not parts[-1]:
                continue
            dest = os.path.realpath(os.path.join(site, *parts))
            if not dest.startswith(site + os.sep):
                sys.exit("entry escapes site: %r" % name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(info) as src, open(dest, "wb") as out:
                while True:
                    b = src.read(1 << 20)
                    if not b:
                        break
                    out.write(b)
PYEOF
    cat > "$STAGE/bin/fleet-python" <<EOF
#!/bin/sh
# Automaton Fleet agent toolchain (lock $LSHA). System python3 + the pinned wheels; never writes bytecode.
PYTHONPATH='$PREFIX/site' PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 exec /usr/bin/python3 "\$@"
EOF
    find "$STAGE" -type d -exec chmod 755 {} +
    find "$STAGE" -type f -exec chmod 644 {} +
    chmod 755 "$STAGE/bin/fleet-python"
    echo "$LSHA" > "$STAGE/LOCK_SHA256"
    tree_sha "$STAGE" > "$STAGE/TREE_SHA256"
    chmod 644 "$STAGE/LOCK_SHA256" "$STAGE/TREE_SHA256"
    chmod 755 "$STAGE"
    mv -T "$STAGE" "$PREFIX"
    trap 'rm -rf "$DL"' EXIT
    echo "installed $n wheels into $PREFIX"
    echo "lock $LSHA"
    echo "tree $(cat "$PREFIX/TREE_SHA256")"
    ;;

  verify)
    PREFIX="$(realpath -e "${2:?verify <prefix>}")"
    PREFIX="${PREFIX%/}"
    [[ -x "$PREFIX/bin/fleet-python" && -f "$PREFIX/TREE_SHA256" && -f "$PREFIX/LOCK_SHA256" ]] \
      || { echo '{"ok":false,"error":"not an agent-tools install"}'; exit 1; }
    TREE="$(tree_sha "$PREFIX")"
    WANT="$(cat "$PREFIX/TREE_SHA256")"
    LSHA="$(cat "$PREFIX/LOCK_SHA256")"
    # -P: no script/cwd directory on sys.path; run from / so nothing local can shadow a module.
    cd /
    "$PREFIX/bin/fleet-python" -P - "$TREE" "$WANT" "$LSHA" <<'PYEOF'
import importlib, importlib.metadata as md, json, sys
tree, want, lock = sys.argv[1:4]
mods = {"openpyxl": "openpyxl", "et_xmlfile": "et-xmlfile", "xlsxwriter": "xlsxwriter", "docx": "python-docx",
        "lxml": "lxml", "typing_extensions": "typing-extensions", "reportlab": "reportlab",
        "charset_normalizer": "charset-normalizer", "pypdf": "pypdf", "pypdfium2": "pypdfium2", "PIL": "pillow",
        "spellchecker": "pyspellchecker", "numpy": "numpy", "scipy": "scipy", "numpy_financial": "numpy-financial",
        "regex": "regex", "schedula": "schedula", "dateutil": "python-dateutil", "six": "six", "tqdm": "tqdm",
        "click": "click", "formulas": "formulas", "pptx": "python-pptx",
        # agent-tools-2 (2026-10-16): chart images, EPUB e-books, and the OCR wrapper (needs the tesseract system binary).
        "matplotlib": "matplotlib", "contourpy": "contourpy", "cycler": "cycler", "fontTools": "fonttools",
        "kiwisolver": "kiwisolver", "packaging": "packaging", "pyparsing": "pyparsing", "ebooklib": "ebooklib",
        "pytesseract": "pytesseract"}
out, ok = {}, tree == want
for m, dist in mods.items():
    try:
        importlib.import_module(m)
        out[m] = md.version(dist)
    except Exception as e:  # report, never hide
        out[m] = "ERROR %s: %s" % (type(e).__name__, e)
        ok = False
try:  # the spell checker's English dictionary is data, not code: prove it loads
    import spellchecker
    spellchecker.SpellChecker(language="en")
except Exception as e:
    out["spellchecker.en"] = "ERROR %s" % e
    ok = False
print(json.dumps({"ok": ok, "lock": lock, "tree": tree, "treeMatches": tree == want, "modules": out}))
sys.exit(0 if ok else 1)
PYEOF
    ;;

  *)
    echo "usage: install <prefix> | verify <prefix> | prefix" >&2
    exit 2
    ;;
esac
