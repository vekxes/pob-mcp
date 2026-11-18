import { appendFileSync, writeSync } from 'node:fs';

type LogFields = Record<string, string | number | boolean | undefined>;
let logPath: string | undefined;

export function setTradeLogPath(path: string): void {
  logPath = path;
}

// Callers supply fixed event names and safe metadata, never request or error contents.
export function tradeLogLine(component: string, event: string, fields?: LogFields): string {
  return JSON.stringify({ ...fields, timestamp: new Date().toISOString(), component, event, pid: process.pid }) + '\n';
}

export function tradeLog(component: string, event: string, fields?: LogFields): void {
  try {
    const line = tradeLogLine(component, event, fields);
    if (logPath) appendFileSync(logPath, line, { mode: 0o600 });
    // Write before returning so shutdown records survive process.exit and stdout stays available to MCP.
    else writeSync(2, line);
  } catch {
    // Diagnostic output must not interrupt the service or MCP transport.
  }
}
