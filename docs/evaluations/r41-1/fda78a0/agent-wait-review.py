#!/usr/bin/env python3
"""R41.1 wait/blocker review of the living founders (READ-ONLY).
Agent-written text is shown truncated, as data. Never prints a credential or a fact value.
Database reads run in a READ ONLY transaction as postgres. Run: sudo python3 agent-wait-review.py"""
import glob, json, os, subprocess

ROOT = "/var/lib/private/automaton-founders"
AGENTS = ["01M3F50SH7PNX2E3GST13J52AS", "01M4C4NXT786Q4E9725N5A15KV"]
T = lambda v, n=140: (str(v)[:n] + ("…" if len(str(v)) > n else "")) if v is not None else None

def sql(q):
    r = subprocess.run(["runuser", "-u", "postgres", "--", "psql", "-X", "-q", "-At", "-d", "automaton_fleet",
                        "-v", "ON_ERROR_STOP=1", "-c", "BEGIN READ ONLY", "-c", "SET LOCAL search_path TO fleet, public", "-c", q, "-c", "ROLLBACK"],
                       capture_output=True, text=True)
    if r.returncode: return f"ERROR {r.stderr.strip()[:300]}"
    return r.stdout.strip()

def one(pattern):
    m = glob.glob(pattern)
    return m[0] if m else None

print("== payment rails (fleet-wide)")
print(sql("SELECT coalesce(json_agg(json_build_object('provider',provider,'kind',rail_kind,'mode',mode,'status',status,'capabilities',capabilities) ORDER BY provider),'[]') FROM fleet_payment_rails"))

for aid in AGENTS:
    low = aid.lower()
    print(f"\n================ {aid}")
    st = one(f"{ROOT}/{aid}/state/*/")
    mem = os.path.join(st, "memory") if st else None

    c = json.load(open(os.path.join(st, "mind-continuity.json"))) if st and os.path.exists(os.path.join(st, "mind-continuity.json")) else {}
    print("-- declared wait (mind-continuity.json, persisted on disk; re-read at every turn and after restart)")
    print(f"  last turn {c.get('at')}; wakeOn {T(c.get('wakeOn'), 300)!r}; reviewAt {c.get('reviewAt')}; idle {c.get('idle') and {k: c['idle'].get(k) for k in ('slim','after','assessed')}}")
    print(f"  last outcome {T(c.get('outcome'), 300)!r}")

    print("-- goals (goals.json)")
    try:
        goals = json.load(open(os.path.join(mem, "goals.json")))
    except Exception as e:
        goals = []; print(f"  unreadable: {e}")
    for g in goals:
        print(f"  {g.get('id')} [{g.get('status')}] {T(g.get('title'), 110)!r}"
              + (f" blockedBy={g.get('blockedBy')}" if g.get('blockedBy') else "")
              + (f" awaiting={T(g.get('awaiting'), 120)!r}" if g.get('awaiting') else "")
              + (f" reviewAt={g.get('reviewAt')}" if g.get('reviewAt') else ""))

    dpath = os.path.join(mem, "decisions.json") if mem else None
    if dpath and os.path.exists(dpath):
        try:
            d = json.load(open(dpath)); d = d if isinstance(d, list) else d.get("decisions", [])
            openD = [x for x in d if x.get("status") in (None, "open")]
            print(f"-- decisions: {len(d)} total, {len(openD)} open")
            for x in openD[:5]:
                print(f"  {x.get('id')} {T(x.get('question') or x.get('title'), 110)!r} review={x.get('reviewAt') or x.get('reviewBy')}")
        except Exception as e:
            print(f"-- decisions unreadable: {e}")

    print("-- external dependencies / owner requests (fleet_owner_requests)")
    print(sql(f"""SELECT coalesce(json_agg(json_build_object('id',left(request_id::text,8),'kind',kind,'status',status,'goal',goal_ref,
      'blocks',blocks_action,'created',created_at,'decided',decided_at,'action',left(action,140),'title',left(title,120)) ORDER BY created_at),'[]')
      FROM fleet_owner_requests WHERE upper(agent_id)='{aid}'"""))
    print("-- ventures")
    print(sql(f"""SELECT coalesce(json_agg(json_build_object('key',venture_key,'state',state,'reason',left(state_reason,120),'channels',channels) ORDER BY created_at),'[]')
      FROM fleet_ventures WHERE upper(agent_id)='{aid}'"""))
    print("-- rail requirements")
    print(sql(f"""SELECT coalesce(json_agg(json_build_object('capability',capability,'provider',provider,'status',status,'dependency',left(dependency_id::text,8),
      'created',created_at,'resolved',resolved_at) ORDER BY created_at),'[]') FROM fleet_rail_requirements WHERE upper(agent_id)='{aid}'"""))
    print("-- capability demands")
    print(sql(f"""SELECT coalesce(json_agg(json_build_object('capability',capability,'op',last_op,'status',status,'attempts',attempts,'last',last_at,
      'satisfied',satisfied_at) ORDER BY last_at),'[]') FROM fleet_capability_demands WHERE upper(agent_id)='{aid}'"""))
    print("-- payment orders (status counts)")
    print(sql(f"SELECT coalesce(json_object_agg(status,n),'{{}}') FROM (SELECT status,count(*) n FROM fleet_payment_orders WHERE upper(agent_id)='{aid}' GROUP BY status) s"))
