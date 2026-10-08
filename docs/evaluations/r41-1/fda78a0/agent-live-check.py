#!/usr/bin/env python3
"""R41.1 live check of one founder (READ-ONLY). Prints structure and counts only:
never a credential, never fact values, never journal prose. Run: sudo python3 agent-live-check.py <agentId> [since]"""
import json, os, re, subprocess, sys

aid = sys.argv[1]
since = sys.argv[2] if len(sys.argv) > 2 else "2026-10-08 11:30:28"
assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{26}", aid), "agent id"
root = f"/var/lib/private/automaton-founders/{aid}"
unit = f"automaton-fleet-founder@{aid}.service"

def sh(*a):
    return subprocess.run(a, capture_output=True, text=True).stdout

print("== process")
print(sh("systemctl", "show", unit, "-p", "ActiveState", "-p", "MainPID", "-p", "NRestarts", "-p", "WorkingDirectory").strip())

print(f"\n== founder log since {since}")
log = sh("journalctl", "-u", unit, "--since", since, "--no-pager", "-q", "-o", "cat").splitlines()
turns = [json.loads(l) for l in log if '"founder_turn"' in l and l.startswith("{")]
print(f"lines {len(log)}; turns {len(turns)}; routed {sum(1 for t in turns if t.get('routed'))}; "
      f"tool calls {sum(t.get('tools', 0) for t in turns)}; refusals {sum(t.get('refusals', 0) for t in turns)}; "
      f"charged cents {sum(t.get('chargedCents', 0) for t in turns)}")
# the upgrade's own stop of the OLD process (mode active, before the new pid started) is planned, not an error
bad = [l for l in log if re.search(r"DOCTRINE_INCOMPATIBLE|\b409\b|founder_failed|founder_stopped|error", l, re.I)
       and not ('"founder_stopped"' in l and json.loads(l).get("ts", "") < since.replace(" ", "T") + "Z~")]
print(f"doctrine refusals / errors: {len(bad)}")
for l in bad[:5]:
    print("  ", l[:200])
ctl = sh("journalctl", "-u", "automaton-fleet", "--since", since, "--no-pager", "-q", "-o", "cat")
print(f"controller log FLEET_DOCTRINE_INCOMPATIBLE: {ctl.count('FLEET_DOCTRINE_INCOMPATIBLE')}")

print("\n== state files (name, bytes, mtime)")
for dp, _, fs in os.walk(root):
    for f in sorted(fs):
        p = os.path.join(dp, f)
        st = os.stat(p)
        if "credential" in f:
            print(f"  {os.path.relpath(p, root)}  (credential; not read)")
            continue
        print(f"  {os.path.relpath(p, root)}  {st.st_size}  {subprocess.run(['date','-u','-d','@'+str(int(st.st_mtime)),'+%FT%TZ'],capture_output=True,text=True).stdout.strip()}")

def find(name):
    for dp, _, fs in os.walk(root):
        if name in fs:
            return os.path.join(dp, name)
    return None

print("\n== field journal")
j = find("field-journal.jsonl")
if j:
    rows = [l for l in open(j) if l.strip()]
    keys = sorted({k for l in rows for k in json.loads(l).keys()})
    print(f"entries {len(rows)}; fields {keys}")
else:
    print("no field-journal.jsonl yet")
idx = find("field-journal-index.json")
if idx:
    d = json.load(open(idx))
    print(f"index: lessons {len(d.get('lessons', []) or [])}; open triggers {len(d.get('triggers', d.get('openTriggers', [])) or [])}")
print(f"archive present: {bool(find('field-journal-archive.jsonl'))}")

print("\n== mind log since the upgrade (tool names and stop codes only)")
ml = find("mind-log.jsonl")
iso = since.replace(" ", "T")
if ml:
    from collections import Counter
    tools, stops, steps = Counter(), Counter(), 0
    for l in open(ml):
        try: e = json.loads(l)
        except Exception: continue
        if str(e.get("at", "")) < iso: continue
        steps += 1
        for t in e.get("tools") or []:
            tools[f"{t.get('name')}{'' if t.get('ok') else ' REFUSED ' + str(t.get('refused'))}"] += 1
        if e.get("stopped"): stops[str(e["stopped"])] += 1
    print(f"steps {steps}; tools {dict(tools)}; stops {dict(stops)}")

print("\n== continuity (hibernation / wake)")
c = find("mind-continuity.json")
if c:
    d = json.load(open(c))
    idle = d.get("idle") or {}
    print(f"last turn at {d.get('at')}; outcome {str(d.get('outcome'))[:40]!r}; tools {d.get('tools')}")
    print(f"wakeOn declared: {bool(d.get('wakeOn'))}; reviewAt: {d.get('reviewAt')}; "
          f"idle slim {idle.get('slim')} after {idle.get('after')}")
else:
    print("no mind-continuity.json")
