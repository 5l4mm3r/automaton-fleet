/**
 * Which work spot each agent takes inside the room its FleetController state puts it in. The room never changes here
 * (that is departments.ts / world.ts); only where in the room: a seat at a desk, a place at a console or table, in a
 * stable order (each agent prefers a spot derived from its id and takes the next free one). Agents at their own Agent
 * Floor workstation, the dead, and anyone beyond a room's spots keep the shared placement. Teammates of the same active
 * project (FleetController's project record) who are in the room together sit at its shared table — a meeting.
 */
import type { DepartmentId } from "../../command/departments";
import type { AgentModel } from "../../command/agents";
import { seedOf } from "../../command/portrait";
import type { Point } from "../world";
import { roomAt } from "./route";
import type { WorkSpot } from "./world-build";

export function workTargets(models: readonly AgentModel[], targets: ReadonlyMap<string, Point>, stations: ReadonlyMap<string, Point>, spots: Readonly<Record<DepartmentId, WorkSpot[]>>,
  teams: ReadonlyMap<string, string> = new Map()) {
  const out = new Map(targets), taken = new Map<string, WorkSpot>(), meetings = new Set<string>();
  const byRoom = new Map<DepartmentId, string[]>();
  for (const m of [...models].sort((a, b) => (a.agent.id < b.agent.id ? -1 : 1))) {
    const id = m.agent.id, t = targets.get(id), st = stations.get(id);
    if (!t || m.agent.status === "dead") continue;
    if (st && Math.hypot(st.x - t.x, st.z - t.z) < 0.05) continue; // at its own workstation
    const room = roomAt(t);
    if (!room || !spots[room.id]?.length) continue;
    (byRoom.get(room.id) ?? byRoom.set(room.id, []).get(room.id)!).push(id);
  }
  for (const [dep, ids] of byRoom) {
    const list = spots[dep], used = new Set<number>();
    // Members of the same active team project who are in this room together take the shared table first.
    const counts = new Map<string, number>();
    for (const id of ids) { const p = teams.get(id); if (p) counts.set(p, (counts.get(p) ?? 0) + 1); }
    const tableIdx = list.map((s, i) => (s.table ? i : -1)).filter((i) => i >= 0);
    const meeting = ids.filter((id) => (counts.get(teams.get(id) ?? "") ?? 0) >= 2);
    for (const id of meeting) {
      const i = tableIdx.find((k) => !used.has(k));
      if (i === undefined) break;
      used.add(i); out.set(id, { x: list[i].x, z: list[i].z }); taken.set(id, list[i]); meetings.add(id);
    }
    // Everyone else: their own desk or console; a shared table only when nothing else is free (so nobody appears to be
    // meeting a team they are not on).
    const own = list.map((s, i) => (s.table ? -1 : i)).filter((i) => i >= 0), order = [...own, ...tableIdx];
    for (const id of ids) {
      if (taken.has(id)) continue;
      if (used.size >= list.length) break;
      const free = own.filter((k) => !used.has(k)), pool = free.length ? free : order.filter((k) => !used.has(k));
      const i = pool[seedOf(id) % pool.length];
      used.add(i);
      out.set(id, { x: list[i].x, z: list[i].z });
      taken.set(id, list[i]);
    }
  }
  return { targets: out as ReadonlyMap<string, Point>, spots: taken as ReadonlyMap<string, WorkSpot>, meetings: meetings as ReadonlySet<string> };
}
