import { parseResearchReport, researchSource, webResearchSources } from '../../src/trade/assistant/research.js';
import type { ResearchSource } from '../../src/trade/assistant/research.js';

test('source links come only from observed public results', () => {
  const wiki = 'https://www.poewiki.net/wiki/Vortex';
  const forged = 'https://www.poewiki.net/wiki/Forged';
  const sources = webResearchSources({
    results: [{ url: wiki, title: 'Vortex' }, { url: 'https://poewiki.net.example.test/private' }],
  });
  sources.push(researchSource('official', 'https://web.poecdn.com/api/currency-exchange/1794999600', 'GGG') as ResearchSource);
  const { report } = parseResearchReport({
    version: 1, message: 'Check the setup', resultRefs: [], proposals: [],
    recommendations: [{ title: 'Review support gems', slot: 'Main skill', reason: 'Check existing setup', verification: 'Compare in PoB', sourceUrls: [wiki, forged] }],
  }, sources);
  expect(report.recommendations[0].sourceUrls).toEqual([wiki]);
  expect(report.sources.map(source => source.kind)).toEqual(['guide', 'official']);
  expect(researchSource('economy', 'https://poe.ninja@example.test/')).toBeUndefined();
});

test('research output never carries a write proposal', () => {
  expect(() => parseResearchReport({
    version: 1, message: 'Save the search', resultRefs: [], recommendations: [], proposals: [{ kind: 'remove_watch' }],
  }, [])).toThrow();
});

test('keeps separate official reference anchors as distinct sources', () => {
  const reference = 'https://www.pathofexile.com/developer/docs/reference';
  const addresses = [reference + '#get-league-ladder', reference + '#account-characters'];
  const { report } = parseResearchReport({
    version: 1, message: 'API access', resultRefs: [], proposals: [],
    recommendations: [{ title: 'Verify API access', slot: 'League', reason: 'Each endpoint has its own access requirements',
      verification: 'Read the reference', sourceUrls: addresses }],
  }, addresses.map(url => researchSource('official', url) as ResearchSource));
  expect(report.recommendations[0].sourceUrls).toEqual(addresses);
  expect(report.sources.map(source => source.url)).toEqual(addresses);
});
