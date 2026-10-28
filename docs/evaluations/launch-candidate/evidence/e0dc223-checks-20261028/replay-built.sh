#!/usr/bin/env bash
# Recorded-sequence replay through the BUILT code (dd29a53 = before, e0dc223 = candidate): Agent-1's recorded structure
# (per step: thinking yes/no, tool calls, image results) with placeholder content; each request prepared by the build's own
# onlyLatestImages/onlyLatestThinking and mapped by its own toAnthropicMessages; a replayed thinking block whose prefix CONTENT
# differs from its generation-time prefix is counted (what the provider refuses). No reasoning text or signatures are used.
A1=01M3F50SH7PNX2E3GST13J52AS; ML=/var/lib/private/automaton-founders/$A1/state/st_01M3F50SH8JVSDE1QBRN591114/mind-log.jsonl
T=$(mktemp -d); chmod 700 $T
sudo -n -u postgres psql -X -q -At -F '|' -d automaton_fleet -c "SET default_transaction_read_only=on; SELECT request_id, COALESCE(thinking_tokens,0) FROM fleet.fleet_cognition_log WHERE agent_id='$A1' AND at > '2026-10-28T13:44:01Z'" > $T/th.txt
sudo -n cat $ML | python3 -c '
import sys,json
rows=[json.loads(l) for l in sys.stdin if l.strip()]
rows=[r for r in rows if r.get("at","")>="2026-10-28T13:44"]
out=[{"turn":r["turn"],"requestId":r.get("requestId"),"stopped":r.get("stopped"),"tools":[{"name":x.get("name"),"ok":x.get("ok")} for x in (r.get("tools") or [])]} for r in rows]
print(json.dumps(out))' > $T/steps.json
cat > $T/r.mjs <<'JS'
import fs from "fs"; import crypto from "crypto";
const [,, dir] = process.argv;
const th = Object.fromEntries(fs.readFileSync(`${dir}/th.txt`, "utf8").trim().split("\n").map((l) => { const [r, t] = l.split("|"); return [r, Number(t)]; }));
const steps = JSON.parse(fs.readFileSync(`${dir}/steps.json`, "utf8"));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const h = (v) => crypto.createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 16);
const key = (msgs) => JSON.stringify(msgs.map((m) => [m.role, m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking").map((b) => `${b.type}:${h(b)}`)]));
for (const [label, rel] of [["dd29a53 (before)", "dd29a53ee724657748a93c018734003466ff35fb"], ["e0dc223 (candidate)", "e0dc22321c0a6633ae74aadef0279074011a5b0a"]]) {
  const mind = await import(`/opt/automaton-fleet/releases/${rel}/dist/fleet/founder/mind.js`);
  const { toAnthropicMessages } = await import(`/opt/automaton-fleet/releases/${rel}/dist/fleet/cognition/anthropic.js`);
  // dd29a53 did not export its preparation: the same two functions in their dd29a53 form (applied as it applied them).
  const prep = mind.onlyLatestImages && rel.startsWith("e0dc")
    ? (m) => mind.onlyLatestThinking(mind.onlyLatestImages(m))
    : (m) => { const t = m.map((x, i, a) => { const last = a.map((y) => y.role === "assistant").lastIndexOf(true); return (x.thinking || x.blockOrder) && i !== last ? { ...x, thinking: undefined, blockOrder: undefined } : x; });
               const last = t.map((x) => x.role === "assistant").lastIndexOf(true); return t.map((x, i) => (x.images && i < last ? { ...x, images: undefined, content: `${x.content}\n[1 image(s) were shown in that step; view_image again to look again]` } : x)); };
  let bad = 0, reqs = 0; const where = [];
  const turns = {}; for (const s of steps) (turns[s.turn] ??= []).push(s);
  for (const [t, ss] of Object.entries(turns)) {
    const msgs = [{ role: "user", content: `packet turn ${t}` }]; const gen = new Map(); let n = 0;
    const request = (final) => {
      const sent = toAnthropicMessages(prep(msgs));
      // the latest assistant (the one whose thinking is replayed) is the last assistant in the sent request
      const li = sent.map((m) => m.role === "assistant").lastIndexOf(true);
      if (li >= 0 && sent[li].content.some((b) => b.type === "thinking") && gen.get(msgs.filter((m) => m.role === "assistant").length - 1) !== key(sent.slice(0, li))) { bad++; where.push(`turn ${t}${final ? " (final request)" : ""}`); }
      reqs++;
      return key(sent);   // the prefix the next assistant message is generated with
    };
    for (const s of ss.filter((x) => x.requestId)) {
      const g = request(false);
      const a = msgs.filter((m) => m.role === "assistant").length;
      gen.set(a, g);
      const calls = s.tools.length ? s.tools : [{ name: "sleep", ok: true }];
      const thinking = th[s.requestId] > 0 ? [{ type: "thinking", thinking: "x", signature: `sig-${s.requestId}` }] : undefined;
      msgs.push({ role: "assistant", content: "", toolCalls: calls.map((c, i) => ({ id: `toolu_${s.requestId.slice(0, 8)}${i}`, name: c.name, arguments: {} })), ...(thinking ? { thinking, blockOrder: ["thinking:0", ...calls.map((c, i) => `tool:toolu_${s.requestId.slice(0, 8)}${i}`)] } : {}) });
      calls.forEach((c, i) => msgs.push({ role: "tool", toolCallId: `toolu_${s.requestId.slice(0, 8)}${i}`, content: `result ${n++}`, ...(c.name === "view_image" && c.ok ? { images: [{ mediaType: "image/png", dataB64: PNG }] } : {}) }));
    }
    const stop = ss.find((x) => x.stopped)?.stopped;
    if (stop && stop !== "FLEET_TURN_CONTEXT_BUDGET") request(true);
  }
  console.log(`${label}: ${reqs} requests; replayed thinking after a changed prefix: ${bad}${where.length ? ` (${where.join(", ")})` : ""}`);
}
JS
(cd /tmp && /opt/automaton-fleet/node/bin/node $T/r.mjs $T); rm -rf $T
