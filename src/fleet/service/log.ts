/**
 * Structured service logs: one JSON object per line on stdout (journald
 * captures it under the unit). Every line goes through the canonical
 * redactor (src/fleet/redact.ts); the envelope keys cannot be overridden by
 * fields, and lines are size-bounded.
 */

import fs from "fs";
import { redactAuditRecord, redactLogLine } from "../redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export function createJsonLogger(
  write: (line: string) => void = (l) => process.stdout.write(l + "\n"),
  service = "automaton-fleet",
): Logger {
  return (level, event, fields = {}) => {
    try {
      write(redactLogLine({ ts: new Date().toISOString(), level, service, event }, fields));
    } catch {
      // logging must never take the service down
    }
  };
}

export interface AuditSinkEntry {
  ts: string;
  event: string;
  agentId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * The service's audit sink. The entry is redacted once into the canonical
 * record; the JSONL file gets that record's line and stdout gets the same
 * redacted fields, so the two copies cannot diverge.
 */
export function createAuditSink(log: Logger, auditFile?: string): (entry: AuditSinkEntry) => void {
  if (auditFile) fs.closeSync(fs.openSync(auditFile, "a", 0o600));
  return (entry) => {
    const { record, line } = redactAuditRecord(entry);
    log("info", record.event, { agentId: record.agentId, ...record.detail, audit: true });
    if (auditFile) fs.appendFileSync(auditFile, line + "\n", { mode: 0o600 });
  };
}
