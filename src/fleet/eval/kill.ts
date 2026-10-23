/**
 * The scenario suite's hard kill (S2), 2026-10-23. Run scen-89d7c21-b1: systemd SIGKILLed the founder's main process, then
 * exited non-zero because it could not signal an auxiliary process of the unit ("Failed to send signal SIGKILL to auxiliary
 * processes … Invalid argument"), and the harness took the whole scenario as a harness failure. Now the kill is judged by
 * its purpose: the founder's MAIN process (the unit's MainPID, read first) must be gone; systemctl's own error is recorded
 * with the kill. Only a main process that survives — or a unit with none to kill — is a failure.
 */
import fs from "fs";
import type { KillRecord } from "./scenario-suite.js";

export interface KillPorts {
  /** systemctl with these arguments: its stdout; throws on a non-zero exit (the error carries stderr when there is any). */
  systemctl(args: string[]): string;
  /** Whether the process still exists and is not a zombie. */
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

export function procAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

const errText = (e: unknown) => {
  const x = e as { stderr?: Buffer | string; message?: string };
  const t = (x.stderr ? String(x.stderr) : "") || x.message || String(e);
  return t.replace(/\s+/g, " ").trim().slice(0, 300);
};

export async function killMainProcess(unit: string, p: KillPorts, waitMs = 10_000): Promise<KillRecord> {
  const pid = Number(p.systemctl(["show", "-p", "MainPID", "--value", unit]).trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`${unit} has no main process to kill`);
  let signalNote: string | undefined;
  try { p.systemctl(["kill", "-s", "SIGKILL", unit]); } catch (e) { signalNote = `systemctl kill exited non-zero: ${errText(e)}`; }
  for (let waited = 0; p.alive(pid); waited += 200) {
    if (waited >= waitMs) throw new Error(`the founder's main process ${pid} survived SIGKILL${signalNote ? ` (${signalNote})` : ""}`);
    await p.sleep(200);
  }
  // Leave the unit stopped (systemd would otherwise apply its restart policy); the scenario restarts it itself.
  try { p.systemctl(["stop", unit]); } catch (e) { signalNote = `${signalNote ? `${signalNote}; ` : ""}systemctl stop: ${errText(e)}`; }
  return { pid, ...(signalNote ? { signalNote } : {}) };
}
