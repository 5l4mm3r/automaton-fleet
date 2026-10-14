/**
 * Deliverable QA inspector (fleet-qa-1): a Python program that runs INSIDE the founder's exec sandbox, under the
 * agent toolchain (scripts/fleet-agent-tools.sh; runSandboxed with `toolsDir`), and checks customer deliverables
 * before they ship — XLSX, DOCX, PDF, images, SVG, ZIP bundles, EPUB, CSV/TXT/MD.
 *
 * Usage inside the sandbox: `python3 <script> <spec.json>`, spec = {"files": ["rel/path", ...], "cases": [...],
 * "renderDir": ".tmp/qa-render"}. It prints ONE JSON line on stdout (library noise is swallowed):
 *   {"inspector":"fleet-qa-1","files":[{path, sha256, sizeBytes, detectedType, extensionMatches, ok,
 *     checks:[{id, status: pass|warn|fail, detail}], facts:{...}}], "ok": bool, "error"?: string}
 *
 * What it checks:
 *   - every file: non-empty, sha256, content sniffed from magic bytes vs the extension (a PNG named .pdf fails),
 *     placeholder text (lorem ipsum, TODO, TBD, FIXME, [INSERT, {{, XXX, "your name here") → fail;
 *   - xlsx: macros / external links / data connections → fail; sheets, dimensions, formula / chart / validation
 *     counts, defined names; recalculation with `formulas`: error cells (#REF!, #DIV/0!, …) → fail, functions the
 *     engine lacks → warn (their #NAME? is not counted as a failure), saved values that differ from (or are
 *     missing for) the recalculated ones → warn (previewers show saved values); spec "cases" ({file?, name?,
 *     sheet, inputs, expect, tolerance}) set inputs, recalculate and compare — each a pass/fail check "case:<name>";
 *   - docx: outline, counts, empty headings, consecutive duplicates, hyperlinks, spelling (advisory warn);
 *   - pdf: encrypted → fail, pages without text → warn, non-embedded fonts other than the standard 14 → warn,
 *     first ≤3 pages rendered (pypdfium2, 72 dpi) into renderDir, a visually blank page → fail;
 *   - images: Pillow verify, format/size/mode/dpi/alpha, blank or near-uniform → fail; svg: DOCTYPE/ENTITY → fail
 *     (parsed only after that guard), script → warn;
 *   - zip: zip-slip / absolute members → fail, CRC test, size; supported members (one level, ≤200 MB extracted
 *     under renderDir) are inspected and summarised, any failing member fails the bundle;
 *   - csv/txt/md: UTF-8 → fail otherwise; csv column consistency / header → warn; spelling for txt/md;
 *   - epub: mimetype first (stored), META-INF/container.xml.
 * A library that is not importable yields a "tool_unavailable" warn — a check that did not run never passes.
 * Limits: workspace-relative paths only (absolute, '..' and symlinks out are refused), 20 files per run, 100 MB
 * per file, ~100 s internal budget (the caller gives ~120 s); xlsx recalculation is interrupted at 60 s.
 *
 * The program is stdlib-only at the top level and imports each library lazily. It ships inside the pinned
 * release as this string, like LANDLOCK_HELPER. Its source must never contain a backtick or a template
 * placeholder opener; Python spells the backtick as chr(96).
 */

export const QA_INSPECTOR_VERSION = "fleet-qa-1";

export const QA_INSPECTOR_PY = String.raw`
import csv, hashlib, io, json, os, re, signal, stat, sys, time, traceback, warnings, zipfile
import xml.etree.ElementTree as ET

VERSION = "fleet-qa-1"
MAX_FILES, MAX_BYTES, ZIP_EXTRACT_CAP, NESTED_MAX = 20, 100 * 1024 * 1024, 200 * 1024 * 1024, 20
BUDGET_S = 100.0
T0 = time.monotonic()
OUT = sys.stdout
NOISE = io.StringIO()
sys.stdout = NOISE  # libraries print; only the final report reaches stdout
sys.stderr = NOISE  # warnings, progress bars
warnings.filterwarnings("ignore")
os.environ.setdefault("TQDM_DISABLE", "1")
ROOT = os.path.realpath(os.getcwd())
ERRORS = ("#REF!", "#DIV/0!", "#NAME?", "#VALUE!", "#N/A", "#NUM!", "#NULL!")
PLACEHOLDER = re.compile(r"lorem ipsum|\bTODO\b|\bTBD\b|\bFIXME\b|\[INSERT|\{\{|\bXXX\b|your name here", re.I)
EXT_TYPE = {".pdf": "pdf", ".xlsx": "xlsx", ".xlsm": "xlsx", ".docx": "docx", ".docm": "docx", ".pptx": "pptx",
            ".epub": "epub", ".zip": "zip", ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif",
            ".webp": "webp", ".svg": "svg", ".csv": "text", ".txt": "text", ".md": "text", ".markdown": "text"}
_SPELL = []


class Budget(Exception):
    pass


def left():
    return BUDGET_S - (time.monotonic() - T0)


def lib(name):
    try:
        return __import__(name, fromlist=["_"])
    except Exception:
        return None


class Report:
    def __init__(self, path):
        self.d = {"path": path, "sha256": "", "sizeBytes": 0, "detectedType": "unknown", "extensionMatches": False,
                  "ok": False, "checks": [], "facts": {}}

    def check(self, cid, status, detail=""):
        self.d["checks"].append({"id": cid, "status": status, "detail": str(detail)[:2000]})

    def unavailable(self, what):
        self.check("tool_unavailable", "warn", what + " is not importable; its checks did not run")

    @property
    def facts(self):
        return self.d["facts"]

    def done(self):
        self.d["ok"] = not any(c["status"] == "fail" for c in self.d["checks"])
        return self.d


def safe_rel(p):
    """Workspace-relative paths only: no absolute path, no '..', and the real path (symlinks followed) stays inside."""
    if not isinstance(p, str) or not p or p.startswith("/") or "\0" in p or ".." in re.split(r"[\\/]", p):
        return None
    real = os.path.realpath(os.path.join(ROOT, p))
    return real if real.startswith(ROOT + os.sep) else None


def sniff(head, path):
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        try:
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
                if names and names[0] == "mimetype" and z.read("mimetype").strip() == b"application/epub+zip":
                    return "epub"
                if "[Content_Types].xml" in names:
                    if "xl/workbook.xml" in names:
                        return "xlsx"
                    if "word/document.xml" in names:
                        return "docx"
                    if "ppt/presentation.xml" in names:
                        return "pptx"
        except Exception:
            pass
        return "zip"
    if b"\0" in head:
        return "binary"
    text = head.decode("utf-8", "replace")  # encoding itself is judged by the text checks (utf8)
    t = text.lstrip("﻿ \t\r\n")
    if t.startswith("<") and "<svg" in t[:4096].lower():
        return "svg"
    return "text"


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_placeholders(r, text):
    hits = []
    for m in PLACEHOLDER.finditer(text):
        s = text[max(0, m.start() - 30):m.end() + 30].replace("\n", " ")
        hits.append(s.strip())
        if len(hits) >= 10:
            break
    if hits:
        r.check("placeholders", "fail", "placeholder text: " + " | ".join(hits))
    else:
        r.check("placeholders", "pass", "no placeholder text in %d extracted characters" % len(text))


WORD = re.compile(r"[A-Za-z][A-Za-z'’]*[A-Za-z]|[A-Za-z]")
URLISH = re.compile(r"\S*(://|www\.|@)\S*")
BT = chr(96)  # backtick, spelled out: this source lives inside a JS template literal
CODE = re.compile(BT * 3 + ".*?" + BT * 3 + "|" + BT + "[^" + BT + "\n]*" + BT, re.S)


def spelling(r, text):
    sc = lib("spellchecker")
    if sc is None:
        r.unavailable("pyspellchecker (spelling)")
        return
    if not _SPELL:
        _SPELL.append(sc.SpellChecker(language="en"))
    sp = _SPELL[0]
    words = set()
    for para in text.split("\n"):
        para = URLISH.sub(" ", para)
        prev_end = None
        for m in WORD.finditer(para):
            w = m.group(0).replace("’", "'")
            sentence_start = prev_end is None or re.search(r"[.!?:]\s*$", para[prev_end:m.start()]) is not None
            prev_end = m.end()
            if len(w) < 3 or w.isupper() or re.search(r"\d", para[max(0, m.start() - 1):m.end() + 1]):
                continue
            if w[0].isupper() and not sentence_start:
                continue  # proper nouns mid-sentence: names, brands, places
            words.add(w.lower().strip("'"))
            if len(words) > 20000:
                break
    unknown = sorted(sp.unknown(list(words)))
    r.facts["spellingUnknown"] = unknown[:40]
    if unknown:
        r.check("spelling", "warn", "%d word(s) not in the English dictionary (advisory): %s" % (len(unknown), ", ".join(unknown[:40])))
    else:
        r.check("spelling", "pass", "%d distinct words checked" % len(words))


def zip_safety(r, z):
    bad = [n for n in z.namelist() if n.startswith("/") or "\\" in n or ".." in n.split("/") or re.match(r"^[A-Za-z]:", n)]
    if bad:
        r.check("zip_paths", "fail", "unsafe member paths (zip-slip): " + ", ".join(bad[:10]))
    try:
        broken = z.testzip()
    except Exception as e:
        broken = "%s: %s" % (type(e).__name__, e)
    if broken:
        r.check("zip_integrity", "fail", "corrupt member: %s" % broken)
    else:
        r.check("zip_integrity", "pass", "%d members, CRCs verified" % len(z.infolist()))
    return not bad and not broken


def active_content(r, z, kind):
    names = z.namelist()
    macros = [n for n in names if n.lower().endswith("vbaproject.bin") or n.lower().endswith(".bin") and "activex" in n.lower()]
    r.check("macros", "fail" if macros else "pass", ("macro / ActiveX parts: " + ", ".join(macros[:5])) if macros else "no macros")
    if kind == "xlsx":
        net = [n for n in names if n.startswith("xl/externalLinks/") or n == "xl/connections.xml" or n.startswith("xl/queryTables/")]
        r.check("external_links", "fail" if net else "pass", ("external links / data connections: " + ", ".join(net[:5])) if net else "no external links or data connections")


# ---------------------------------------------------------------- xlsx

def cell_value(v):
    try:
        import numpy as np
        if isinstance(v, np.ndarray):
            v = v.ravel()[0] if v.size else None
        if isinstance(v, np.generic):
            v = v.item()
    except Exception:
        pass
    if v is None:
        return None
    if isinstance(v, str):  # formulas' XlError / tokens are str subclasses with identity equality
        return str(v)
    if isinstance(v, (bool, int, float)):
        return v
    s = str(v)
    return s if s else None


def as_num(v):
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def alarm(seconds):
    def h(*_):
        raise Budget()
    signal.signal(signal.SIGALRM, h)
    signal.alarm(max(1, int(seconds)))


def cases_not_run(r, cases, status, why):
    for i, cs in enumerate(cases):
        r.check("case:%s" % (cs.get("name") or i + 1), status, "not run: " + why)


HARDCODED = re.compile(r"(?<![A-Za-z$:!])[*/]\s*\d+(?:\.\d+)?(?![\d:A-Za-z(])")


def presentation(r, wb, formulas_at):
    """Advisory only (warn): what a buyer sees before any number is checked. Never blocks a review on its own."""
    notes = []
    nums = general = 0
    plain_headers = []
    for ws in wb.worksheets:
        if ws.sheet_state != "visible":
            continue
        for row in ws.iter_rows():
            for c in row:
                if isinstance(c.value, (int, float)) and not isinstance(c.value, bool) or c.data_type == "f":
                    nums += 1
                    if c.number_format == "General":
                        general += 1
        first = [c for c in next(ws.iter_rows(min_row=1, max_row=1), []) if isinstance(c.value, str) and c.value.strip()]
        if len(first) >= 2 and not any(c.font is not None and c.font.b for c in first):
            plain_headers.append(ws.title)
    if nums >= 4 and general == nums:
        notes.append("every number and formula cell is in General format (no currency, percentage or date formats)")
    if plain_headers:
        notes.append("header row not bold on: " + ", ".join(plain_headers[:10]))
    hard = ["%s!%s %s" % (k[0], k[1], f[:40]) for k, f in formulas_at.items() if HARDCODED.search(f)]
    if hard:
        notes.append("%d formula(s) multiply/divide by a typed constant (put rates in a labelled input cell): %s" % (len(hard), "; ".join(hard[:10])))
    r.check("presentation", "warn" if notes else "pass", " | ".join(notes) if notes else "number formats, headers and formula inputs look deliberate")


def inspect_xlsx(r, path, cases):
    with zipfile.ZipFile(path) as z:
        if not zip_safety(r, z):
            cases_not_run(r, cases, "fail", "workbook container is unsafe or corrupt")
            return
        active_content(r, z, "xlsx")
    if os.path.splitext(path)[1].lower() == ".xlsm":
        r.check("macros", "fail", "macro-enabled workbook extension (.xlsm)")
    opx = lib("openpyxl")
    if opx is None:
        r.unavailable("openpyxl")
        cases_not_run(r, cases, "warn", "openpyxl unavailable")
        return
    try:
        wb = opx.load_workbook(path)  # formulas as written
        wbv = opx.load_workbook(path, data_only=True)  # cached values as last saved
    except Exception as e:
        r.check("xlsx_load", "fail", "openpyxl could not open the workbook: %s: %s" % (type(e).__name__, e))
        cases_not_run(r, cases, "fail", "workbook does not open")
        return
    r.check("xlsx_load", "pass", "%d sheet(s)" % len(wb.sheetnames))
    sheets, formulas_at, text = [], {}, []
    cached_err = []
    for ws in wb.worksheets:
        wsv = wbv[ws.title]
        n_f = 0
        for row in ws.iter_rows():
            for c in row:
                v = c.value
                if v is None:
                    continue
                ftext = None
                if c.data_type == "f":
                    ftext = v if isinstance(v, str) else getattr(v, "text", None) or str(v)
                if ftext is not None:
                    n_f += 1
                    formulas_at[(ws.title, c.coordinate)] = ftext
                    cv = wsv[c.coordinate].value
                    if isinstance(cv, str) and cv in ERRORS:
                        cached_err.append("%s!%s=%s" % (ws.title, c.coordinate, cv))
                elif isinstance(v, str):
                    text.append(v)
                    if v.strip() in ERRORS:
                        cached_err.append("%s!%s=%s (typed as text)" % (ws.title, c.coordinate, v.strip()))
        names = []
        try:
            names = list(ws.defined_names.keys())
        except Exception:
            pass
        sheets.append({"name": ws.title, "dimensions": ws.dimensions, "maxRow": ws.max_row, "maxColumn": ws.max_column,
                       "formulas": n_f, "charts": len(getattr(ws, "_charts", [])), "images": len(getattr(ws, "_images", [])),
                       "dataValidations": len(ws.data_validations.dataValidation) if ws.data_validations else 0,
                       "localNames": names, "state": ws.sheet_state})
    try:
        dn = list(wb.defined_names.keys())
    except Exception:
        dn = [d.name for d in getattr(wb.defined_names, "definedName", [])]
    r.facts.update({"sheets": sheets, "formulaCount": len(formulas_at), "definedNames": dn[:100],
                    "chartCount": sum(s["charts"] for s in sheets), "dataValidationCount": sum(s["dataValidations"] for s in sheets)})
    presentation(r, wb, formulas_at)
    scan_placeholders(r, "\n".join(text))
    if not formulas_at:
        r.check("formula_errors", "fail" if cached_err else "pass", ("error values: " + ", ".join(cached_err[:50])) if cached_err else "no formulas")
        cases_not_run(r, cases, "fail", "workbook has no formulas to drive")
        return
    fx = lib("formulas")
    if fx is None:
        r.unavailable("formulas (recalculation)")
        r.check("formula_errors", "fail" if cached_err else "warn",
                ("cached error values: " + ", ".join(cached_err[:50])) if cached_err else "cached values only; not recalculated")
        cases_not_run(r, cases, "warn", "recalculation engine unavailable")
        return
    if len(formulas_at) > 50000 or left() < 15:
        r.check("recalc", "warn", "recalculation skipped (%d formulas, %.0fs budget left)" % (len(formulas_at), left()))
        cases_not_run(r, cases, "warn", "recalculation skipped")
        return
    supported = fx.get_functions()
    unsupported = {}
    for (sh, addr), ft in formulas_at.items():
        for fn in re.findall(r"([A-Za-z_][A-Za-z0-9_.]*)\s*\(", re.sub(r'"[^"]*"', '""', ft)):
            if fn.upper() not in supported and "_XLFN." + fn.upper() not in supported:
                unsupported.setdefault(fn.upper(), []).append("%s!%s" % (sh, addr))
    if unsupported:
        r.check("formula_unsupported", "warn", "functions the recalculation engine does not implement (results unverified): " +
                "; ".join("%s at %s" % (k, ", ".join(v[:5])) for k, v in sorted(unsupported.items())))
    try:
        alarm(min(60, left() - 5))
        model = fx.ExcelModel().loads(path).finish()
        sol = model.calculate()
        signal.alarm(0)
    except Budget:
        r.check("recalc", "warn", "recalculation did not finish within the time budget")
        cases_not_run(r, cases, "warn", "recalculation timed out")
        return
    except Exception as e:
        signal.alarm(0)
        r.check("recalc", "warn", "recalculation engine failed: %s: %s" % (type(e).__name__, str(e)[:300]))
        cases_not_run(r, cases, "warn", "recalculation engine failed")
        return
    keyre = re.compile(r"^'\[(.*)\](.*)'!\$?([A-Z]+)\$?(\d+)$")
    index = {}
    for k in sol.keys():
        m = keyre.match(str(k))
        if m:
            index[(m.group(2).upper(), m.group(3) + m.group(4))] = k
    errors, not_eval, mismatch, missing_cache = [], [], [], []
    for (sh, addr), ft in formulas_at.items():
        k = index.get((sh.upper(), addr))
        where = "%s!%s" % (sh, addr)
        if k is None:
            not_eval.append(where)
            continue
        v = cell_value(sol[k].value)
        if isinstance(v, str) and v in ERRORS:
            errors.append((where, v))
            continue
        cv = wbv[sh][addr].value
        if cv is None:
            missing_cache.append(where)
            continue
        a, b = as_num(v), as_num(cv)
        if a is not None and b is not None:
            if abs(a - b) > 1e-6 * max(1.0, abs(a), abs(b)):
                mismatch.append("%s cached %r, recalculated %r" % (where, cv, v))
        elif v is not None and str(v) != str(cv) and not (v == "" and cv in (0, "")):
            mismatch.append("%s cached %r, recalculated %r" % (where, cv, v))
    soft = bool(unsupported)
    hard = [(w, e) for w, e in errors if not (soft and e == "#NAME?")]
    softe = [(w, e) for w, e in errors if soft and e == "#NAME?"]
    r.facts["errorCells"] = [{"cell": w, "error": e} for w, e in errors[:50]]
    r.check("recalc", "pass", "%d formulas recalculated" % (len(formulas_at) - len(not_eval)))
    if hard:
        r.check("formula_errors", "fail", "%d error cell(s): %s" % (len(hard), ", ".join("%s=%s" % x for x in hard[:50])))
    elif softe:
        r.check("formula_errors", "warn", "#NAME? only where unsupported functions are involved: " + ", ".join(w for w, _ in softe[:50]))
    else:
        r.check("formula_errors", "pass", "no error values after recalculation")
    if not_eval:
        r.check("formula_not_evaluated", "warn", "%d formula cell(s) the engine did not evaluate: %s" % (len(not_eval), ", ".join(not_eval[:50])))
    if mismatch:
        r.check("cached_values", "warn", "%d cell(s) whose saved value differs from the recalculated one (viewers that do not recalculate show the saved value): %s" % (len(mismatch), "; ".join(mismatch[:50])))
    elif missing_cache:
        r.check("cached_values", "warn", "%d formula cell(s) saved without a value (previewers show them blank): %s" % (len(missing_cache), ", ".join(missing_cache[:50])))
    else:
        r.check("cached_values", "pass", "saved values match the recalculation")
    for i, cs in enumerate(cases):
        cid = "case:%s" % (cs.get("name") or i + 1)
        try:
            sheet = str(cs["sheet"]).upper()
            tol = float(cs.get("tolerance", 0.01))
            inputs = {}
            for a, v in (cs.get("inputs") or {}).items():
                k = index.get((sheet, a.replace("$", "").upper()))
                if k is None:
                    raise ValueError("input %s!%s is not a cell any formula depends on" % (cs["sheet"], a))
                inputs[k] = v
            alarm(min(30, max(1, left() - 5)))
            out = model.calculate(inputs=inputs)
            signal.alarm(0)
            bad, seen = [], []
            for a, want in (cs.get("expect") or {}).items():
                ref = a.replace("$", "").upper()
                sh2, ref2 = (ref.split("!", 1) if "!" in ref else (sheet, ref))
                k = index.get((sh2.strip("'"), ref2))
                if k is None:
                    bad.append("%s: not a formula/referenced cell" % a)
                    continue
                got = cell_value(out[k].value)
                gn, wn = as_num(got), as_num(want)
                ok = (abs(gn - wn) <= tol) if gn is not None and wn is not None and not isinstance(want, str) else str(got) == str(want)
                (seen if ok else bad).append("%s=%r (want %r)" % (a, got, want))
            if bad:
                r.check(cid, "fail", "; ".join(bad + seen)[:2000])
            else:
                r.check(cid, "pass", "; ".join(seen)[:2000] or "no expectations")
        except Budget:
            r.check(cid, "fail", "case did not finish within the time budget")
        except Exception as e:
            signal.alarm(0)
            r.check(cid, "fail", "%s: %s" % (type(e).__name__, str(e)[:300]))


# ---------------------------------------------------------------- docx

def inspect_docx(r, path):
    with zipfile.ZipFile(path) as z:
        if not zip_safety(r, z):
            return
        active_content(r, z, "docx")
    dx = lib("docx")
    if dx is None:
        r.unavailable("python-docx")
        return
    try:
        doc = dx.Document(path)
    except Exception as e:
        r.check("docx_load", "fail", "python-docx could not open it: %s: %s" % (type(e).__name__, e))
        return
    r.check("docx_load", "pass", "opened")
    paras = [p for p in doc.paragraphs]
    texts = [p.text for p in paras]
    table_text = []
    for t in doc.tables:
        for row in t.rows:
            for c in row.cells:
                table_text.append(c.text)
    outline, empty_h = [], 0
    for p in paras:
        sn = (p.style.name if p.style is not None else "") or ""
        lvl = 0 if sn == "Title" else int(sn.split()[-1]) if re.fullmatch(r"Heading \d", sn) else None
        if lvl is None:
            continue
        if not p.text.strip():
            empty_h += 1
        elif len(outline) < 60:
            outline.append({"level": lvl, "text": p.text.strip()[:200]})
    dups = []
    prev = None
    for t in texts:
        s = t.strip()
        if s and s == prev:
            dups.append(s[:80])
        prev = s if s else prev
    links = []
    images = 0
    for rel in doc.part.rels.values():
        if rel.reltype.endswith("/hyperlink") and rel.is_external and len(links) < 40:
            links.append(rel.target_ref)
        elif rel.reltype.endswith("/image"):
            images += 1
    alltext = "\n".join(texts + table_text)
    r.facts.update({"paragraphs": sum(1 for t in texts if t.strip()), "words": len(alltext.split()), "headings": outline,
                    "tables": len(doc.tables), "images": max(images, len(doc.inline_shapes)), "hyperlinks": links})
    r.check("empty_headings", "warn" if empty_h else "pass", "%d empty heading paragraph(s)" % empty_h)
    r.check("duplicate_paragraphs", "warn" if dups else "pass", ("consecutive duplicates: " + " | ".join(dups[:10])) if dups else "none")
    scan_placeholders(r, alltext)
    spelling(r, alltext)


# ---------------------------------------------------------------- pdf

STD14 = {"Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique", "Helvetica", "Helvetica-Bold",
         "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
         "Symbol", "ZapfDingbats"}


def inspect_pdf(r, path, render_dir, tag):
    pp = lib("pypdf")
    if pp is None:
        r.unavailable("pypdf")
    else:
        try:
            rd = pp.PdfReader(path)
            enc = rd.is_encrypted
        except Exception as e:
            r.check("pdf_load", "fail", "pypdf could not parse it: %s: %s" % (type(e).__name__, e))
            return
        if enc:
            r.check("encrypted", "fail", "the PDF is encrypted; customers may not be able to open or print it")
            return
        r.check("pdf_load", "pass", "%d page(s)" % len(rd.pages))
        chars, empty, fonts, text = [], [], {}, []
        for i, page in enumerate(rd.pages):
            if i >= 200 or left() < 20:
                break
            try:
                t = page.extract_text() or ""
            except Exception:
                t = ""
            chars.append(len(t.strip()))
            text.append(t)
            if not t.strip():
                empty.append(i + 1)
            try:
                res = page.get("/Resources")
                res = res.get_object() if res is not None else {}
                fd = res.get("/Font")
                fd = fd.get_object() if fd is not None else {}
                for f in fd.values():
                    f = f.get_object()
                    base = str(f.get("/BaseFont", "?")).lstrip("/")
                    desc = f.get("/FontDescriptor")
                    if desc is None and f.get("/DescendantFonts"):
                        desc = f["/DescendantFonts"][0].get_object().get("/FontDescriptor")
                    desc = desc.get_object() if desc is not None else {}
                    emb = any(k in desc for k in ("/FontFile", "/FontFile2", "/FontFile3"))
                    if f.get("/Subtype") == "/Type3":
                        emb = True
                    fonts[base] = fonts.get(base, False) or emb
            except Exception:
                pass
        meta = None
        try:
            meta = rd.metadata.title if rd.metadata else None
        except Exception:
            pass
        r.facts.update({"pages": len(rd.pages), "charsPerPage": chars[:200], "fonts": [{"name": k, "embedded": v} for k, v in sorted(fonts.items())][:50], "title": meta})
        r.check("pages_without_text", "warn" if empty else "pass", ("no extractable text on page(s) %s (scanned image? needs OCR to be searchable)" % empty[:30]) if empty else "every page has text")
        notemb = [k for k, v in fonts.items() if not v]
        odd = [k for k in notemb if k.split("+")[-1] not in STD14]
        if odd:
            r.check("fonts_embedded", "warn", "fonts not embedded (may render differently elsewhere): " + ", ".join(odd[:20]))
        else:
            r.check("fonts_embedded", "pass", ("all fonts embedded" if not notemb else "only standard-14 fonts are not embedded: " + ", ".join(notemb[:14])))
        scan_placeholders(r, "\n".join(text))
    pdfium = lib("pypdfium2")
    if pdfium is None:
        r.unavailable("pypdfium2 (rendering)")
        return
    try:
        doc = pdfium.PdfDocument(path)
        n = min(3, len(doc))
        blank, rendered, sparse = [], [], []
        os.makedirs(render_dir, exist_ok=True)
        for i in range(n):
            img = doc[i].render(scale=1).to_pil()
            out = os.path.join(render_dir, "%s-p%d.png" % (tag, i + 1))
            img.save(out)
            rendered.append(os.path.relpath(out, ROOT))
            g = img.convert("L")
            lo, hi = g.getextrema()
            if lo >= 250:
                blank.append(i + 1)
            else:
                box = g.point(lambda v: 255 if v < 250 else 0).getbbox()
                if box and (box[3] - box[1]) < 0.25 * g.size[1]:
                    sparse.append("p%d %d%%" % (i + 1, round(100.0 * (box[3] - box[1]) / g.size[1])))
        doc.close()
        r.facts["renders"] = rendered
        r.check("blank_pages", "fail" if blank else "pass", ("visually blank page(s): %s" % blank) if blank else "%d page(s) rendered, none blank" % n)
        # Advisory: content filling under a quarter of the page height reads as a stub, not a finished page.
        r.check("sparse_pages", "warn" if sparse else "pass", ("content fills under a quarter of the page height: " + ", ".join(sparse)) if sparse else "pages carry substantial content")
    except Exception as e:
        r.check("render", "warn", "rendering failed: %s: %s" % (type(e).__name__, e))


# ---------------------------------------------------------------- images

def inspect_image(r, path):
    pil = lib("PIL.Image")
    if pil is None:
        r.unavailable("Pillow")
        return
    try:
        with pil.open(path) as im:
            im.verify()
        with pil.open(path) as im:
            im.load()
            alpha = "A" in im.getbands() or im.info.get("transparency") is not None
            r.facts.update({"format": im.format, "width": im.width, "height": im.height, "mode": im.mode,
                            "dpi": list(im.info["dpi"]) if "dpi" in im.info else None, "hasAlpha": bool(alpha),
                            "frames": getattr(im, "n_frames", 1)})
            r.check("image_verify", "pass", "%s %dx%d %s" % (im.format, im.width, im.height, im.mode))
            small = im.convert("RGBA")
            small.thumbnail((256, 256))
            if small.getchannel("A").getextrema()[1] == 0:
                r.check("blank_image", "fail", "fully transparent")
                return
            rgb = pil.new("RGB", small.size, (255, 255, 255))
            rgb.paste(small, mask=small.getchannel("A"))
            st = lib("PIL.ImageStat").Stat(rgb.convert("L"))
            if st.stddev[0] < 2.0:
                r.check("blank_image", "fail", "near-uniform image (luminance stddev %.2f)" % st.stddev[0])
            else:
                r.check("blank_image", "pass", "luminance stddev %.1f" % st.stddev[0])
    except Exception as e:
        r.check("image_verify", "fail", "%s: %s" % (type(e).__name__, e))


def inspect_svg(r, path, raw):
    if re.search(rb"<!(DOCTYPE|ENTITY)", raw, re.I):
        r.check("svg_xml", "fail", "DOCTYPE/ENTITY declarations are refused (entity expansion / external entities)")
        return
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        r.check("svg_xml", "fail", "not well-formed XML: %s" % e)
        return
    if not root.tag.endswith("svg"):
        r.check("svg_xml", "fail", "root element is %s, not svg" % root.tag)
        return
    r.check("svg_xml", "pass", "well-formed SVG")
    r.facts.update({"width": root.get("width"), "height": root.get("height"), "viewBox": root.get("viewBox")})
    scripts = re.search(rb"<script|\son[a-z]+\s*=|javascript:", raw, re.I)
    r.check("svg_script", "warn" if scripts else "pass", "contains script or event handlers" if scripts else "no script")
    scan_placeholders(r, " ".join(t for t in root.itertext()))


# ---------------------------------------------------------------- text, zip, epub

def inspect_text(r, path, raw):
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        r.check("utf8", "fail", "not valid UTF-8 at byte %d" % e.start)
        return
    r.check("utf8", "pass", "valid UTF-8")
    lines = text.splitlines()
    r.facts["lines"] = len(lines)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".csv":
        try:
            rows = list(csv.reader(io.StringIO(text)))
        except csv.Error as e:
            r.check("csv_columns", "fail", "csv parse error: %s" % e)
            rows = []
        rows = [row for row in rows if row]
        if rows:
            widths = {}
            for i, row in enumerate(rows):
                widths.setdefault(len(row), []).append(i + 1)
            r.facts.update({"rows": len(rows), "columns": len(rows[0]), "header": rows[0][:50]})
            if len(widths) > 1:
                common = max(widths, key=lambda k: len(widths[k]))
                odd = sorted(i for k, v in widths.items() if k != common for i in v)
                r.check("csv_columns", "warn", "%d row(s) do not have %d columns, e.g. rows %s" % (len(odd), common, odd[:10]))
            else:
                r.check("csv_columns", "pass", "%d rows x %d columns" % (len(rows), len(rows[0])))
            hdr = all(c.strip() and as_num(c) is None for c in rows[0])
            r.check("csv_header", "pass" if hdr else "warn", "header row present" if hdr else "first row does not look like a header")
    scan_placeholders(r, text)
    if ext in (".txt", ".md", ".markdown"):
        spelling(r, CODE.sub(" ", text) if ext != ".txt" else text)


def inspect_epub(r, path):
    with zipfile.ZipFile(path) as z:
        zip_safety(r, z)
        infos = z.infolist()
        first = infos[0] if infos else None
        ok = first is not None and first.filename == "mimetype" and z.read("mimetype").strip() == b"application/epub+zip"
        r.check("epub_mimetype", "pass" if ok and first.compress_type == zipfile.ZIP_STORED else "warn" if ok else "fail",
                "mimetype first and stored" if ok and first.compress_type == zipfile.ZIP_STORED else "mimetype must be the first, uncompressed member")
        has = "META-INF/container.xml" in z.namelist()
        r.check("epub_container", "pass" if has else "fail", "META-INF/container.xml present" if has else "META-INF/container.xml missing")


def inspect_zip(r, path, render_dir, tag, depth):
    with zipfile.ZipFile(path) as z:
        safe = zip_safety(r, z)
        infos = [i for i in z.infolist() if not i.is_dir()]
        total = sum(i.file_size for i in infos)
        r.facts.update({"entries": len(infos), "uncompressedBytes": total, "names": [i.filename for i in infos[:100]]})
        if total > ZIP_EXTRACT_CAP:
            r.check("zip_size", "warn", "uncompressed size %d bytes exceeds the %d cap; members not inspected" % (total, ZIP_EXTRACT_CAP))
            return
        r.check("zip_size", "pass", "%d bytes uncompressed" % total)
        if depth > 0 or not safe:
            return
        nested, used = [], 0
        dest = os.path.join(render_dir, "zip-%s" % tag)
        for n, info in enumerate(infos):
            ext = os.path.splitext(info.filename)[1].lower()
            if ext not in EXT_TYPE or len(nested) >= NESTED_MAX or left() < 15:
                continue
            if info.file_size > MAX_BYTES or used + info.file_size > ZIP_EXTRACT_CAP:
                continue
            os.makedirs(dest, exist_ok=True)
            out = os.path.join(dest, "%d-%s" % (n, re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(info.filename))[-80:]))
            with z.open(info) as src, open(out, "wb") as f:
                while True:
                    b = src.read(1 << 20)
                    if not b:
                        break
                    used += len(b)
                    if used > ZIP_EXTRACT_CAP:
                        raise ValueError("extraction cap exceeded")
                    f.write(b)
            sub = inspect_file(os.path.relpath(out, ROOT), render_dir, [], depth + 1, label=info.filename)
            nested.append({"name": info.filename, "detectedType": sub["detectedType"], "ok": sub["ok"],
                           "failed": [c["id"] for c in sub["checks"] if c["status"] == "fail"],
                           "failDetails": ["%s: %s" % (c["id"], c["detail"]) for c in sub["checks"] if c["status"] == "fail"],
                           "warned": [c["id"] for c in sub["checks"] if c["status"] == "warn"], "facts": sub["facts"]})
        r.facts["nested"] = nested
        if nested:
            badn = [x["name"] for x in nested if not x["ok"]]
            # Each failing member with its failures' details (bounded), so the fix does not need a re-inspection of the member.
            why = ["%s (%s)" % (x["name"], "; ".join(d[:200] for d in x["failDetails"])[:400]) for x in nested if not x["ok"]]
            r.check("nested_files", "fail" if badn else "pass", ("failing members: " + " | ".join(why)) if badn else "%d member(s) inspected, all ok" % len(nested))
        for x in nested:
            x.pop("failDetails", None)


# ---------------------------------------------------------------- driver

def inspect_file(rel, render_dir, cases, depth=0, label=None):
    r = Report(label or rel)
    real = safe_rel(rel)
    if real is None:
        r.check("path", "fail", "refused: path must be relative and stay inside the workspace")
        return r.done()
    try:
        st = os.stat(real)
    except OSError as e:
        r.check("path", "fail", "cannot stat: %s" % e.strerror)
        return r.done()
    if not stat.S_ISREG(st.st_mode):
        r.check("path", "fail", "not a regular file")
        return r.done()
    r.d["sizeBytes"] = st.st_size
    if st.st_size == 0:
        r.check("size", "fail", "empty file")
        return r.done()
    if st.st_size > MAX_BYTES:
        r.check("size", "fail", "larger than the %d-byte inspection cap" % MAX_BYTES)
        r.d["sha256"] = sha_file(real)
        return r.done()
    r.check("size", "pass", "%d bytes" % st.st_size)
    r.d["sha256"] = sha_file(real)
    with open(real, "rb") as f:
        head = f.read(65536)
    kind = sniff(head, real)
    ext = os.path.splitext(rel)[1].lower()
    want = EXT_TYPE.get(ext)
    r.d["detectedType"] = kind
    r.d["extensionMatches"] = want is not None and want == kind
    if want is None:
        r.check("extension_matches", "warn", "unrecognised extension %r; detected %s" % (ext, kind))
    elif want != kind:
        r.check("extension_matches", "fail", "extension %s but the content is %s" % (ext, kind))
    else:
        r.check("extension_matches", "pass", kind)
    if left() < 10:
        r.check("time_budget", "warn", "inspection time budget exhausted; content checks skipped")
        return r.done()
    tag = re.sub(r"[^A-Za-z0-9]", "_", rel)[-60:] or "f"
    try:
        if kind == "xlsx":
            inspect_xlsx(r, real, cases)
        elif kind == "docx":
            inspect_docx(r, real)
        elif kind == "pdf":
            inspect_pdf(r, real, render_dir, tag)
        elif kind in ("png", "jpeg", "gif", "webp"):
            inspect_image(r, real)
        elif kind == "svg":
            with open(real, "rb") as f:
                inspect_svg(r, real, f.read())
        elif kind == "epub":
            inspect_epub(r, real)
        elif kind in ("zip", "pptx"):
            if kind == "pptx":
                with zipfile.ZipFile(real) as z:
                    active_content(r, z, "pptx")
            inspect_zip(r, real, render_dir, tag, depth)
        elif kind == "text":
            with open(real, "rb") as f:
                inspect_text(r, real, f.read())
        else:
            r.check("content", "warn", "no content checks for %s" % kind)
    except Budget:
        r.check("time_budget", "warn", "inspection time budget exhausted mid-file")
    except Exception as e:
        signal.alarm(0)
        r.check("inspector_error", "fail", "%s: %s" % (type(e).__name__, str(e)[:300]))
    return r.done()


def main():
    report = {"inspector": VERSION, "files": [], "ok": False}
    try:
        if len(sys.argv) != 2:
            raise ValueError("usage: inspector <spec.json>")
        sp = safe_rel(sys.argv[1])
        if sp is None:
            raise ValueError("spec path must be relative and inside the workspace")
        with open(sp) as f:
            spec = json.load(f)
        files = spec.get("files")
        if not isinstance(files, list) or not all(isinstance(x, str) for x in files):
            raise ValueError("spec.files must be a list of relative paths")
        cases = spec.get("cases") or []
        if not isinstance(cases, list) or not all(isinstance(c, dict) for c in cases):
            raise ValueError("spec.cases must be a list of objects")
        rd = spec.get("renderDir") or ".tmp/qa-render"
        render_dir = safe_rel(rd) if isinstance(rd, str) else None
        if render_dir is None:
            raise ValueError("renderDir must be relative and inside the workspace")
        for i, rel in enumerate(files):
            if i >= MAX_FILES:
                r = Report(rel)
                r.check("file_limit", "fail", "only %d files are inspected per run" % MAX_FILES)
                report["files"].append(r.done())
                continue
            mine = [c for c in cases if c.get("file") in (None, rel)]
            report["files"].append(inspect_file(rel, render_dir, mine))
        report["ok"] = bool(report["files"]) and all(x["ok"] for x in report["files"])
    except Exception as e:
        report["error"] = "%s: %s" % (type(e).__name__, str(e)[:500])
        report["ok"] = False
    OUT.write(json.dumps(report, default=str) + "\n")
    OUT.flush()


main()
`;

export type QaCheckStatus = "pass" | "warn" | "fail";

export interface QaCheck {
  id: string;
  status: QaCheckStatus;
  detail: string;
}

export const QA_DETECTED_TYPES = ["pdf", "xlsx", "docx", "pptx", "epub", "zip", "png", "jpeg", "gif", "webp", "svg", "text", "binary", "unknown"] as const;
export type QaDetectedType = (typeof QA_DETECTED_TYPES)[number];

export interface QaFileReport {
  path: string;
  sha256: string;
  sizeBytes: number;
  detectedType: QaDetectedType;
  extensionMatches: boolean;
  ok: boolean;
  checks: QaCheck[];
  facts: Record<string, unknown>;
}

export interface QaInspectorReport {
  inspector: typeof QA_INSPECTOR_VERSION;
  files: QaFileReport[];
  ok: boolean;
  error?: string;
}

function fail(msg: string): never {
  throw new Error(`QA inspector report invalid: ${msg}`);
}

function exactKeys(o: unknown, required: string[], optional: string[], where: string): Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) fail(`${where} is not an object`);
  const rec = o as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!required.includes(k) && !optional.includes(k)) fail(`${where} has unknown key ${k}`);
  for (const k of required) if (!(k in rec)) fail(`${where} lacks ${k}`);
  return rec;
}

/**
 * Parse the inspector's stdout strictly. The report is the last line that starts with {"inspector" (the sandbox
 * merges stderr into the same stream, so anything else on other lines is ignored); every object must have exactly
 * the documented keys and types, and each `ok` must agree with its checks — an inconsistent report throws.
 */
export function parseInspectorReport(stdout: string): QaInspectorReport {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{"inspector"'))
    .pop();
  if (!line) fail("no report line");
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    fail("report line is not JSON");
  }
  const top = exactKeys(raw, ["inspector", "files", "ok"], ["error"], "report");
  if (top.inspector !== QA_INSPECTOR_VERSION) fail(`inspector ${String(top.inspector)} is not ${QA_INSPECTOR_VERSION}`);
  if (typeof top.ok !== "boolean") fail("report.ok is not boolean");
  if ("error" in top && typeof top.error !== "string") fail("report.error is not a string");
  if (!Array.isArray(top.files)) fail("report.files is not an array");
  const files: QaFileReport[] = top.files.map((f, i) => {
    const where = `files[${i}]`;
    const r = exactKeys(f, ["path", "sha256", "sizeBytes", "detectedType", "extensionMatches", "ok", "checks", "facts"], [], where);
    if (typeof r.path !== "string") fail(`${where}.path`);
    if (typeof r.sha256 !== "string" || !/^([0-9a-f]{64})?$/.test(r.sha256)) fail(`${where}.sha256`);
    if (typeof r.sizeBytes !== "number" || !Number.isSafeInteger(r.sizeBytes) || r.sizeBytes < 0) fail(`${where}.sizeBytes`);
    if (typeof r.detectedType !== "string" || !(QA_DETECTED_TYPES as readonly string[]).includes(r.detectedType)) fail(`${where}.detectedType`);
    if (typeof r.extensionMatches !== "boolean" || typeof r.ok !== "boolean") fail(`${where} flags`);
    if (typeof r.facts !== "object" || r.facts === null || Array.isArray(r.facts)) fail(`${where}.facts`);
    if (!Array.isArray(r.checks)) fail(`${where}.checks`);
    const checks: QaCheck[] = r.checks.map((c, j) => {
      const cw = `${where}.checks[${j}]`;
      const k = exactKeys(c, ["id", "status", "detail"], [], cw);
      if (typeof k.id !== "string" || !k.id) fail(`${cw}.id`);
      if (k.status !== "pass" && k.status !== "warn" && k.status !== "fail") fail(`${cw}.status`);
      if (typeof k.detail !== "string") fail(`${cw}.detail`);
      return { id: k.id, status: k.status, detail: k.detail };
    });
    if (r.ok !== !checks.some((c) => c.status === "fail")) fail(`${where}.ok disagrees with its checks`);
    return {
      path: r.path,
      sha256: r.sha256,
      sizeBytes: r.sizeBytes,
      detectedType: r.detectedType as QaDetectedType,
      extensionMatches: r.extensionMatches,
      ok: r.ok,
      checks,
      facts: r.facts as Record<string, unknown>,
    };
  });
  const allOk = files.length > 0 && files.every((f) => f.ok) && !("error" in top);
  if (top.ok !== allOk) fail("report.ok disagrees with its files");
  return { inspector: QA_INSPECTOR_VERSION, files, ok: top.ok, ...("error" in top ? { error: top.error as string } : {}) };
}
