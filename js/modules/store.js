export const STORAGE_KEY = 'cementPlannerRebuild_v1';

const seed = () => ({
  ui: { activeTab: 'products', selectedFacilityId: 'MIA', mode: 'sandbox' },
  sandbox: freshDataset(),
  official: freshDataset()
});

function freshDataset(){
  return {
    facilities: [{id:'MIA', name:'Miami', region:'FL', country:'USA'}],
    materials: [], // id, code, name, category, unit, landedCost, fuel props, facilityId?
    recipes: [],   // id, facilityId, productId, version, effectiveStart, effectiveEnd, components:[{materialId,pct}]
    equipment: [], // id, facilityId, name, type
    storages: [],  // id, facilityId, name, categoryHint, allowedProductIds[]
    connections: [], // id, facilityId, fromId, toId
    capabilities: [], // id, equipmentId, productId, maxRateStpd, electricKwhPerStn, thermalMMBTUPerStn
    demandForecast: [], // date, facilityId, productId, qtyStn, source='forecast'
    campaigns: [], // date, facilityId, equipmentId, productId, rateStn
    actuals: {
      inventoryEOD: [], // date, facilityId, storageId, productId, qtyStn
      production: [], // date, facilityId, equipmentId, productId, qtyStn
      shipments: [] // date, facilityId, productId, qtyStn
    }
  };
}

export function loadState(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const s = seed();
      saveState(s);
      return s;
    }
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch {
    const s = seed(); saveState(s); return s;
  }
}

function migrate(s){
  const base = seed();
  const out = {...base, ...s};
  out.ui = {...base.ui, ...(s.ui||{})};
  out.sandbox = {...freshDataset(), ...(s.sandbox||{})};
  out.official = {...freshDataset(), ...(s.official||{})};
  out.sandbox.actuals = {...freshDataset().actuals, ...(out.sandbox.actuals||{})};
  out.official.actuals = {...freshDataset().actuals, ...(out.official.actuals||{})};
  return out;
}

export function saveState(state){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

export function getDataset(state){ return state.ui.mode === 'sandbox' ? state.sandbox : state.official; }
export function setDataset(state, dataset){ state[state.ui.mode] = dataset; }

export function pushSandboxToOfficial(state){
  state.official = JSON.parse(JSON.stringify(state.sandbox));
}
