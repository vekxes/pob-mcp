import { execFile } from 'node:child_process';
import { CodexReadiness } from '../../src/trade/assistant/readiness.js';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
jest.mock('../../src/trade/log.js', () => ({ tradeLog: jest.fn() }));

const exec = execFile as unknown as jest.Mock;
const path = '/tools/codex';

test('requires a confirmed CLI login and allows an explicit refresh after signing in', async () => {
  const readiness = new CodexReadiness();
  exec.mockReset();
  exec.mockImplementationOnce((_file, _args, _options, done) => { done({ code: 1 }, '', 'Not logged in'); return {}; });
  exec.mockImplementationOnce((_file, _args, _options, done) => { done(null, '', 'Logged in using ChatGPT'); return {}; });
  await expect(readiness.check(path)).resolves.toBe('login_required');
  await expect(readiness.check(path, true)).resolves.toBe('ready');
  expect(exec).toHaveBeenNthCalledWith(2, path, ['login', 'status'], expect.objectContaining({ windowsHide: true }), expect.any(Function));
});

test('rejects a successful invocation that does not report a Codex login', async () => {
  const readiness = new CodexReadiness();
  exec.mockReset();
  exec.mockImplementationOnce((_file, _args, _options, done) => { done(null, 'Unrelated executable', ''); return {}; });
  await expect(readiness.check(path)).resolves.toBe('unavailable');
});
