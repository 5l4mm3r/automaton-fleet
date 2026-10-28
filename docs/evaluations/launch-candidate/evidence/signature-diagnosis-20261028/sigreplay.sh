#!/usr/bin/env bash
# Read-only replay of Agent-1's RECORDED step structure (thinking yes/no per call, image results per step; no content,
# no signatures) through the OLD and the NEW image rule: how many requests would replay signed thinking after a prefix
# that differs from the one it was generated with?
A1=01M3F50SH7PNX2E3GST13J52AS; ML=/var/lib/private/automaton-founders/$A1/state/st_01M3F50SH8JVSDE1QBRN591114/mind-log.jsonl
sudo -n -u postgres psql -X -q -At -F '|' -d automaton_fleet -c "SET default_transaction_read_only=on; SELECT request_id, COALESCE(thinking_tokens,0) FROM fleet.fleet_cognition_log WHERE agent_id='$A1' AND at > '2026-10-28T13:44:01Z'" > /tmp/sr.txt
sudo -n cat $ML | python3 -c '
import sys,json
th={l.split("|")[0]: int(l.strip().split("|")[1]) for l in open("/tmp/sr.txt")}
steps=[json.loads(l) for l in sys.stdin if l.strip()]
allsteps=[s for s in steps if s.get("at","")>="2026-10-28T13:44"]
stops={s["turn"]: s.get("stopped") for s in allsteps if s.get("stopped")}
steps=[s for s in allsteps if s.get("requestId")]
turns={}
for s in steps: turns.setdefault(s["turn"],[]).append(s)
def prep(msgs, rule):
    # msgs: list of ("A", thinking) / ("T", has_images); returns the representation of each tool message (images kept?)
    if rule=="old": b=max([i for i,m in enumerate(msgs) if m[0]=="A"], default=-1)
    else: b=max([i for i,m in enumerate(msgs) if m[0]=="A" and not m[1]], default=-1)
    return tuple((m[0], (m[1] if m[0]=="T" and i>=b else False) if m[0]=="T" else None) for i,m in enumerate(msgs))
bad={"old":0,"new":0}; reqs=0
for t,ss in turns.items():
    msgs=[("U",None)]; gen={}
    for k,s in enumerate(ss):
        for rule in ("old","new"):
            # request k: replays the latest assistant (if it has thinking) — compare its prefix now vs at its generation
            last=max([i for i,m in enumerate(msgs) if m[0]=="A"], default=-1)
            if last>=0 and msgs[last][1]:
                if prep(msgs,rule)[:last]!=gen[(rule,last)]: bad[rule]+=1
            gen[(rule,len(msgs))]=prep(msgs,rule)   # the prefix the new assistant message is generated with
        reqs+=1
        msgs.append(("A", th.get(s["requestId"],0)>0))
        imgs=any(x.get("name")=="view_image" and x.get("ok") for x in (s.get("tools") or []))
        msgs.append(("T", imgs))
    # the request after the last completed step was made unless the turn ended at its size budget (no request) or slept
    if stops.get(t) not in (None, "FLEET_TURN_CONTEXT_BUDGET"):
        reqs+=1
        last=max([i for i,m in enumerate(msgs) if m[0]=="A"], default=-1)
        for rule in ("old","new"):
            if last>=0 and msgs[last][1] and prep(msgs,rule)[:last]!=gen[(rule,last)]:
                bad[rule]+=1; print("  turn",t,"final request: replayed thinking after a changed prefix under rule",rule,"| production outcome:",stops.get(t))
print("requests replayed:",reqs,"| replays of signed thinking after a CHANGED prefix — old rule:",bad["old"],"new rule:",bad["new"])
'
rm -f /tmp/sr.txt
