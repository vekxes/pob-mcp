import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { tradeLogLine } from './log.js';

export const dataHome = process.env.POE_TRADE_HOME || join(process.env.LOCALAPPDATA || homedir(), 'PoELocalTrade');
export const port = Number(process.env.POE_TRADE_PORT || 48217);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid POE_TRADE_PORT.');
export const localOrigin = `http://127.0.0.1:${port}`;
export const descriptor = join(dataHome, 'connection.json');
type Connection = { token: string; browserAvailable: boolean };

async function currentConnection(): Promise<Connection | undefined> {
  try {
    const connection = JSON.parse(readFileSync(descriptor, 'utf8')) as Connection;
    if (!/^[a-f0-9]{64}$/.test(connection.token)) return undefined;
    const result = await fetch(localOrigin + '/health', {
      headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(600),
    });
    if (!result.ok) return undefined;
    const state = await result.json() as { service?: string; browserAvailable?: boolean };
    if (state.service === 'poe-local-trade') return { token: connection.token, browserAvailable: state.browserAvailable === true };
  } catch {
    return undefined;
  }
}

export async function stopLocal(connection: Connection): Promise<void> {
  const result = await fetch(localOrigin + '/stop', {
    method: 'POST', headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(6_000),
  });
  if (!result.ok) throw new Error('Could not stop the local Trade service.');
  await result.json();
}

export async function connectLocal(start = true): Promise<Connection> {
  const running = await currentConnection();
  if (running) return running;
  if (!start) throw new Error('The local Trade service is stopped.');
  mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  const logPath = join(dataHome, 'service.log');
  const log = openSync(logPath, 'a', 0o600);
  const logLaunch = (event: string) => {
    try { appendFileSync(logPath, tradeLogLine('client', event, { port }), { mode: 0o600 }); } catch {}
  };
  logLaunch('launch_requested');
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.js', import.meta.url))], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', log],
    });
    child.on('error', () => logLaunch('spawn_failed'));
    child.unref();
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + 10_000;
  do {
    await delay(100);
    const connection = await currentConnection();
    if (connection) return connection;
  } while (Date.now() < deadline);
  logLaunch('connect_timeout');
  throw new Error(`Could not start the local Trade service. Check ${logPath}.`);
}

export async function callLocal(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const connection = await connectLocal();
  const response = await fetch(localOrigin + '/api', {
    method: 'POST',
    headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json() as { data?: Record<string, unknown>; error?: string };
  if (!response.ok || !result.data) throw new Error(result.error || 'The local Trade service did not respond.');
  return result.data;
}
