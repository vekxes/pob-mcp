import type { PoBLuaApiClient } from '../pobLuaBridge.js';
import { wrapHandler } from '../utils/errorHandling.js';

interface NativeSearchContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

async function getClient(context: NativeSearchContext): Promise<PoBLuaApiClient> {
  await context.ensureLuaClient();
  const client = context.getLuaClient();
  if (!client) throw new Error('Lua bridge not active. Load a build first.');
  return client;
}

export async function handleGetNodePower(context: NativeSearchContext, args: object) {
  return wrapHandler('get node power', async () => {
    const report = await (await getClient(context)).getNodePower(args);
    const lines = [
      `=== Node Power: ${report.label} ===`,
      `Showing ${report.nodes.length} of ${report.total} nodes/effects with a nonzero change within ${report.maxDepth} points.`,
    ];
    if (report.nonFinite > 0) lines.push(`Skipped ${report.nonFinite} non-finite changes reported by PoB.`);
    for (const row of report.nodes) {
      lines.push(`- ${row.name} [${row.nodeId}]${row.masteryEffectId ? ` (effect ${row.masteryEffectId})` : ''}: ${row.nodeDelta} node, ${row.pathDelta} path, ${row.points} points, ${Number(row.deltaPerPoint.toPrecision(5))} per point`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }], structuredContent: report };
  });
}

export async function handleFindTimelessJewel(context: NativeSearchContext, args: object) {
  return wrapHandler('find timeless jewel', async () => {
    const report = await (await getClient(context)).findTimelessJewel(args);
    const lines = [
      `=== ${report.jewel} (${report.conqueror}) at socket ${report.socketNodeId} ===`,
      `Scanned ${report.seedsScanned} seeds across ${report.notables} notables. Showing ${report.results.length} of ${report.total} matching seeds.`,
    ];
    if (!report.socketAllocated) lines.push('The socket is unallocated in the current build.');
    for (const result of report.results) {
      const matches = result.matches.map(match => `${match.nodeName} [${match.nodeId}]: ${match.modId}`);
      lines.push(`- Seed ${result.seed}, score ${result.score}: ${matches.join('; ')}`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }], structuredContent: report };
  });
}
