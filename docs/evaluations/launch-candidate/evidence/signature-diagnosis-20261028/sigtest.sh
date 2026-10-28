#!/usr/bin/env bash
# Read-only hypothesis test (no reasoning text or signatures are read): for every request of the resumed run, does the
# REPLAYED latest assistant step carry thinking AND does an image result precede it in the same tool loop (which
# onlyLatestImages then rewrites)? Predicts the provider's "Invalid signature" rejections.
A1=01M3F50SH7PNX2E3GST13J52AS; ML=/var/lib/private/automaton-founders/$A1/state/st_01M3F50SH8JVSDE1QBRN591114/mind-log.jsonl
sudo -n -u postgres psql -X -q -At -F '|' -d automaton_fleet -c "SET default_transaction_read_only=on; SELECT request_id, to_char(at,'HH24:MI:SS'), outcome, COALESCE(thinking_tokens,-1), COALESCE(error_code,'-') FROM fleet.fleet_cognition_log WHERE agent_id='$A1' AND at > '2026-10-28T13:44:01Z' ORDER BY at" > /tmp/sig-cog.txt
sudo -n cat $ML | python3 -c '
import sys,json
cog={}
for l in open("/tmp/sig-cog.txt"):
    rid,at,outc,tt,err=l.strip().split("|"); cog[rid]=(at,outc,int(tt),err)
steps=[json.loads(l) for l in sys.stdin]
steps=[s for s in steps if s.get("at","")>="2026-10-28T13:44"]
# group by turn: each logged step with a requestId is a completed call; a "stopped" entry is the rejected/ended call
turns={}
for s in steps: turns.setdefault(s.get("turn"),[]).append(s)
tp=fp=tn=fn=0; rows=[]
for t,ss in turns.items():
    done=[s for s in ss if s.get("requestId")]
    for k in range(len(done)+1):
        # request k replays assistant step k-1 (latest) whose prefix includes tool results of steps < k-1
        if k==0: continue
        latest=done[k-1]; th=cog.get(latest["requestId"],(None,None,-1,None))[2]
        imgs_before=any(any(x.get("name")=="view_image" and x.get("ok") for x in (d.get("tools") or [])) for d in done[:k-1])
        # the request made at k: rejected if it is the stop entry with PROVIDER_REJECTED
        if k<len(done): rejected=False; at=done[k]["at"][11:19]
        else:
            stop=[s for s in ss if s.get("stopped")]; rejected=bool(stop) and stop[-1]["stopped"]=="FLEET_COGNITION_PROVIDER_REJECTED"; at=stop[-1]["at"][11:19] if stop else "-"
            if stop and stop[-1]["stopped"]=="FLEET_TURN_CONTEXT_BUDGET": continue   # no request was made
        pred= th>0 and imgs_before
        if pred and rejected: tp+=1
        elif pred and not rejected: fp+=1
        elif not pred and rejected: fn+=1
        else: tn+=1
        if pred or rejected: rows.append((at,t,k,"thinking_tokens=%d"%th,"image-before=%s"%imgs_before,"REJECTED" if rejected else "accepted"))
for r in rows: print(*r)
print(f"prediction (latest step has thinking AND an earlier image result in the loop): true-pos {tp}, false-pos {fp}, false-neg {fn}, true-neg {tn}")
'
rm -f /tmp/sig-cog.txt
