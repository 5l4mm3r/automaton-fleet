#!/usr/bin/env python3
"""Local-model demonstration metrics, from a scenario's captured evidence alone (no model call, nothing changed).

  python3 -I scripts/fleet-local-metrics.py <scenario evidence dir> [--json]

The review of 2026-10-23 asks the first GPU demonstration (one paid order through creation, inspection and delivery) to be
measured on: completion, malformed calls, repetition, latency and recovery. This reads the files the suite keeps
(result.json, mind-log.jsonl, calls.jsonl, deliveries.json, obligations.json, mind-packets.jsonl) and prints those figures.
"""
import json, os, statistics, sys
from collections import Counter
from datetime import datetime

d = sys.argv[1]
def load(name, default):
    p = os.path.join(d, name)
    try: return json.load(open(p)) if os.path.exists(p) else default
    except Exception: return default
def lines(name):
    p = os.path.join(d, name)
    out = []
    if os.path.exists(p):
        for l in open(p):
            try: out.append(json.loads(l))
            except Exception: pass
    return out
ts = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))

result, log, calls = load("result.json", {}), lines("mind-log.jsonl"), lines("calls.jsonl")
deliveries, obligations = load("deliveries.json", []), load("obligations.json", [])
steps = [e for e in log if "tools" in e]
tools = [t for e in steps for t in e["tools"]]
refused = Counter(t.get("refused") for t in tools if not t.get("ok"))
reasons = [str(t.get("reason") or "") for t in tools if not t.get("ok")]
stops = Counter(e["stopped"] for e in log if e.get("stopped"))
turns = sorted({e.get("turn") for e in log if e.get("turn") is not None})
gaps = sorted((ts(b["at"]) - ts(a["at"])).total_seconds() for a, b in zip(log, log[1:]) if a.get("turn") == b.get("turn"))
start = ts(result["startedAt"]) if result.get("startedAt") else (ts(log[0]["at"]) if log else None)
first_tool = lambda name, op=None: next((e["at"] for e in steps for t in e["tools"] if t["name"] == name and t.get("ok")), None)
delivered_at = next((x.get("sentAt") or x.get("createdAt") or x.get("at") for x in deliveries if isinstance(x, dict)), None)
q = lambda xs, f: xs[min(len(xs) - 1, int(len(xs) * f))] if xs else None

m = {
  "scenario": result.get("id"), "verdict": result.get("verdict"), "reason": result.get("reason"),
  "completion": {"delivered": len(deliveries) > 0, "deliveries": len(deliveries),
                 "stillOwed": sum(1 for o in obligations if o.get("state") == "to_deliver" or o.get("deliveryOwed")),
                 "minutesToFirstDelivery": round((ts(delivered_at) - start).total_seconds() / 60, 1) if delivered_at and start else None,
                 "firstFileWritten": first_tool("write_file") or first_tool("exec"), "firstReview": first_tool("deliverable")},
  "volume": {"minutes": (result.get("observations") or {}).get("minutes"), "modelCalls": len(calls), "turns": len(turns), "steps": len(steps),
             "toolCalls": len(tools), "promptTokens": sum((c.get("usage") or {}).get("inputTokens", 0) for c in calls),
             "outputTokens": sum((c.get("usage") or {}).get("outputTokens", 0) for c in calls),
             "maxPromptTokens": max([(c.get("usage") or {}).get("inputTokens", 0) for c in calls] or [0]), "allInMicro": (result.get("cost") or {}).get("allInMicro")},
  "malformed": {"invalidArguments": sum("_invalid_arguments" in r or "not valid JSON" in r for r in reasons), "badRequest": refused.get("FLEET_BAD_REQUEST", 0),
                "unknownOrMissing": refused.get("FLEET_NOT_FOUND", 0) + refused.get("FLEET_TOOL_NOT_AVAILABLE", 0),
                "pathRefusals": refused.get("FLEET_PATH_OUTSIDE_WORKSPACE", 0)},
  "repetition": {"duplicateBlocked": refused.get("FLEET_DUPLICATE_FAILED_ACTION", 0), "repeatedFailureBlocked": refused.get("FLEET_REPEATED_FAILURE", 0),
                 "turnsEndedRepeating": stops.get("FLEET_TURN_REPEATING", 0)},
  "latency": {"stepSecondsMedian": statistics.median(gaps) if gaps else None, "stepSecondsP90": q(gaps, 0.9), "stepSecondsMax": gaps[-1] if gaps else None,
              "providerErrors": sum(1 for c in calls if c.get("outcome") != "ok")},
  "recovery": {"stops": dict(stops), "turnsContinuingCarriedWork": sum(1 for p in lines("mind-packets.jsonl") if "CONTINUE YOUR UNFINISHED WORK" in p.get("text", ""))},
  "refusalsByCode": dict(refused.most_common()),
}
if "--json" in sys.argv: print(json.dumps(m, indent=1))
else:
    for k, v in m.items(): print(f"{k:16} {json.dumps(v)}")
