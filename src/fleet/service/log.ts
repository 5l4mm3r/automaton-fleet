/**
 * Structured service logs: one JSON object per line on stdout (journald
 * captures it under the unit). Fields are scrubbed of credentials.
 */

import { scrubDetail } from "../postgres/store.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  service: "automaton-fleet";
  event: string;
  [k: string]: unknown;
}

export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export function createJsonLogger(write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  return (level, event, fields = {}) => {
    const rec: LogRecord = { ts: new Date().toISOString(), level, service: "automaton-fleet", event, ...scrubDetail(fields) };
    try {
      write(JSON.stringify(rec));
    } catch {
      // logging must never take the service down
    }
  };
}
