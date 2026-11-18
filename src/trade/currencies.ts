import type { TradeScope } from './query.js';

interface CurrencyOption {
  id: string | null;
  label: string;
}

// Verified 2026-11-18 from the English Trade site's Buyout Price catalog:
// https://www.pathofexile.com/api/trade/data/filters
// https://www.pathofexile.com/api/trade2/data/filters
// Copy result[trade_filters].filters[price].option.options in order, mapping text to label.
// The null option represents an equivalent price in the game's default currency.
export const tradeCurrencyOptions: Record<TradeScope['game'], readonly CurrencyOption[]> = {
  poe1: [
    { id: null, label: 'Chaos Orb Equivalent' },
    { id: 'chaos_divine', label: 'Chaos or Divine Orbs' },
    { id: 'chaos', label: 'Chaos Orb' },
    { id: 'exalted', label: 'Exalted Orb' },
    { id: 'divine', label: 'Divine Orb' },
    { id: 'mirror', label: 'Mirror of Kalandra' },
    { id: 'blessed', label: 'Blessed Orb' },
    { id: 'chrome', label: 'Chromatic Orb' },
    { id: 'gcp', label: "Gemcutter's Prism" },
    { id: 'jewellers', label: "Jeweller's Orb" },
    { id: 'scour', label: 'Orb of Scouring' },
    { id: 'regret', label: 'Orb of Regret' },
    { id: 'fusing', label: 'Orb of Fusing' },
    { id: 'chance', label: 'Orb of Chance' },
    { id: 'alt', label: 'Orb of Alteration' },
    { id: 'alch', label: 'Orb of Alchemy' },
    { id: 'regal', label: 'Regal Orb' },
    { id: 'vaal', label: 'Vaal Orb' },
  ],
  poe2: [
    { id: null, label: 'Exalted Orb Equivalent' },
    { id: 'exalted_divine', label: 'Exalted or Divine Orbs' },
    { id: 'aug', label: 'Orb of Augmentation' },
    { id: 'transmute', label: 'Orb of Transmutation' },
    { id: 'exalted', label: 'Exalted Orb' },
    { id: 'regal', label: 'Regal Orb' },
    { id: 'chaos', label: 'Chaos Orb' },
    { id: 'vaal', label: 'Vaal Orb' },
    { id: 'alch', label: 'Orb of Alchemy' },
    { id: 'divine', label: 'Divine Orb' },
    { id: 'annul', label: 'Orb of Annulment' },
    { id: 'mirror', label: 'Mirror of Kalandra' },
  ],
};
