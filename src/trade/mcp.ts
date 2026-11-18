import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tradeTools } from './api.js';
import { callLocal } from './localConnection.js';

const server = new Server({ name: 'poe-local-trade', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tradeTools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const data = await callLocal(request.params.name, request.params.arguments ?? {});
    return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Trade MCP failed.' }] };
  }
});
await server.connect(new StdioServerTransport());
