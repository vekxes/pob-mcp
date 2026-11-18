import { handleLuaGetBuildSnapshot } from '../../src/handlers/luaHandlers.js';

test('uses the calculated main skill even when its selected socket group is disabled', async () => {
  const client = {
    getBuildInfo: async () => ({ className: 'Witch' }),
    getStats: async () => ({ TotalDPS: 500 }),
    getTree: async () => ({}),
    getItems: async () => [],
    getSkills: async () => ({
      mainSocketGroup: 1,
      groups: [
        { index: 1, enabled: false, mainActiveSkill: 2, skills: ['Frostbolt', 'Vortex'],
          gems: [{ name: 'Controlled Destruction', isSupport: true }, { name: 'Efficacy', isSupport: true, enabled: false }] },
        { index: 2, enabled: false, skills: ['Flame Dash'] },
      ],
    }),
  };
  const context = {
    getLuaClient: () => client,
    ensureLuaClient: async () => {},
  } as unknown as Parameters<typeof handleLuaGetBuildSnapshot>[0];

  const response = await handleLuaGetBuildSnapshot(context);
  expect(response).toMatchObject({ structuredContent: {
    mainSkill: 'Vortex', skills: ['Frostbolt', 'Vortex'], supportGems: ['Controlled Destruction'], stats: { TotalDPS: 500 },
  } });
});
