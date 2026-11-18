import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { tradeLog } from '../log.js';
import { codexEnvironment } from './runner.js';

type LoginState = 'ready' | 'login_required' | 'unavailable';

export const codexReadinessMessages = {
  ready: 'Codex CLI готов к работе.',
  setup_required: 'Укажи путь к доступному Codex CLI.',
  login_required: 'Выполни вход через codex login, затем проверь готовность.',
  unavailable: 'Не удалось проверить готовность Codex CLI.',
};

function checkLogin(path: string): Promise<LoginState> {
  return new Promise(resolve => {
    execFile(path, ['login', 'status'], {
      cwd: dirname(path), env: codexEnvironment(), timeout: 5_000, maxBuffer: 16_384, windowsHide: true,
    }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`;
      if (!error && /^Logged in using\b/im.test(output)) return resolve('ready');
      if (error?.code === 1 && /^Not logged in\b/im.test(output)) return resolve('login_required');
      resolve('unavailable');
    }).stdin?.end();
  });
}

export class CodexReadiness {
  private cached?: { path: string; state: LoginState; expires: number };
  private readonly pending = new Map<string, Promise<LoginState>>();

  check(path: string, force = false): Promise<LoginState> {
    const pending = this.pending.get(path);
    if (pending) return pending;
    if (!force && this.cached?.path === path && this.cached.expires > Date.now()) return Promise.resolve(this.cached.state);
    const request = checkLogin(path).catch(() => 'unavailable' as const).then(state => {
      if (this.cached?.path !== path || this.cached.state !== state) tradeLog('assistant', 'readiness_changed', { state });
      this.cached = { path, state, expires: Date.now() + (state === 'ready' ? 20_000 : 3_000) };
      return state;
    }).finally(() => this.pending.delete(path));
    this.pending.set(path, request);
    return request;
  }
}
