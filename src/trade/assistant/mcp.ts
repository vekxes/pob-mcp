import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tradeLog } from '../log.js';
import { assistantTools, AssistantToolError, isAssistantNamespace, isAssistantToolErrorCode } from './tools.js';

function loopbackOrigin(value: string | undefined): string | undefined {
  if (!value || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.origin === value) return value;
  } catch {
    // Fail closed for out-of-range ports and malformed origins.
  }
}

const namespace = process.argv[2];
const origin = loopbackOrigin(process.env.POE_ASSISTANT_ORIGIN);
const capability = process.env.POE_ASSISTANT_CAPABILITY;

if (!isAssistantNamespace(namespace) || process.argv.length !== 3 || !origin || !capability || !/^[a-f0-9]{64}$/.test(capability)) {
  tradeLog('assistant-mcp', 'configuration_rejected');
  process.exitCode = 1;
} else {
  const tools = assistantTools[namespace];
  const server = new Server({ name: `assistant_${namespace}`, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (!tools.some(tool => tool.name === name)) throw new AssistantToolError('unknown_tool');
      const response = await fetch(origin + '/assistant/gateway', {
        method: 'POST',
        headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace, name, args }),
        signal: AbortSignal.timeout(120_000),
        redirect: 'error',
      });
      const { data, code } = await response.json() as { data?: Record<string, unknown>; code?: unknown };
      if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data)) {
        if (isAssistantToolErrorCode(code)) throw new AssistantToolError(code);
        throw new Error();
      }
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      const text = error instanceof AssistantToolError ? error.message : 'The assistant gateway is unavailable for this request.';
      return { isError: true, content: [{ type: 'text', text }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
