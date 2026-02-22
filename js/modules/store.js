export const STORAGE_KEY = 'cementPlannerRebuild_v2';

const uid = (p='id') => `${p}_${Math.random().toString(36).slice(2,9)}`;

const seed = () => ({
  ui: {
    activeTab: 'plan',
    selectedFacilityId: null,
    mode: 'sandbox',
    activeSandboxId: 'default'
  },
  // Org hierarchy — shared across sandbox/official
  org: {
    countries: [],   // {id, name, code}
    regions: [],     // {id, countryId, name, code}
    subRegions: [],  // {id, regionId, name, code}
    facilities: [],  // {id, subRegionId, name, code, timezone}
  },
  // Regional shared material/product catalogs: regionId -> materials[]
  // Stored flat with regionId tag
  catalog: [],  // {id, regionId, code, name, category, unit, landedCostUsdPerStn, ...}

  // Official dataset (one, shared)
  official: freshFacilityData(),

  // Sandboxes: keyed by sandbox id
  sandboxes: {
    default: { name: 'Default Sandbox', createdAt: new Date().toISOString(), data: freshFacilityData() }
  }
});

export function freshFacilityData(){
  return {
    recipes: [],       // id, facilityId, productId, version, components
    equipment: [],     // id, facilityId, name, type
    storages: [],      // id, facilityId, name, categoryHint, allowedProductIds[], maxCapacityStn
    capabilities: [],  // id, equipmentId, productId, maxRateStpd, ...
    demandForecast: [],// date, facilityId, productId, qtyStn
    campaigns: [],     // date, facilityId, equipmentId, productId, rateStn, status
    actuals: {
      inventoryEOD: [],
      production: [],
      shipments: []
    }
  };
}

export function loadState(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw){ const s = seed(); saveState(s); return s; }
    return migrate(JSON.parse(raw));
  } catch {
    const s = seed(); saveState(s); return s;
  }
}

function migrate(s){
  const base = seed();
  const out = { ...base, ...s };
  out.ui = { ...base.ui, ...(s.ui||{}) };
  out.org = {
    countries:  (s.org?.countries  || []),
    regions:    (s.org?.regions    || []),
    subRegions: (s.org?.subRegions || []),
    facilities: (s.org?.facilities || []),
  };
  out.catalog = s.catalog || [];

  // Migrate old single-facility data if upgrading from v1
  if(s.sandbox || s.official){
    const oldDs = s.sandbox || s.official;
    // Create a default org structure from old data
    if(out.org.countries.length === 0 && oldDs?.facilities?.length){
      const oldFac = oldDs.facilities[0];
      const cid = 'country_USA';
      const rid = 'region_FL';
      const srid = 'subregion_SFL';
      const fid = oldFac.id || 'MIA';
      out.org.countries = [{id:cid, name:'United States', code:'USA'}];
      out.org.regions = [{id:rid, countryId:cid, name:'Florida', code:'FL'}];
      out.org.subRegions = [{id:srid, regionId:rid, name:'South Florida', code:'SFL'}];
      out.org.facilities = [{id:fid, subRegionId:srid, name: oldFac.name||'Miami', code:fid}];
      out.ui.selectedFacilityId = fid;
      // Migrate catalog from old materials
      if(oldDs.materials?.length){
        out.catalog = oldDs.materials.map(m=>({...m, regionId: rid}));
      }
      // Migrate operational data
      const migratedData = { ...freshFacilityData() };
      ['recipes','equipment','storages','capabilities','demandForecast','campaigns'].forEach(k=>{
        if(oldDs[k]) migratedData[k] = oldDs[k];
      });
      if(oldDs.actuals) migratedData.actuals = { ...freshFacilityData().actuals, ...oldDs.actuals };
      out.official = migratedData;
      out.sandboxes = { default: { name:'Default Sandbox', createdAt: new Date().toISOString(), data: JSON.parse(JSON.stringify(migratedData)) } };
    }
  } else {
    // Fresh v2 data
    out.official = { ...freshFacilityData(), ...(s.official||{}) };
    out.official.actuals = { ...freshFacilityData().actuals, ...(s.official?.actuals||{}) };
    out.sandboxes = s.sandboxes || base.sandboxes;
    Object.keys(out.sandboxes).forEach(k=>{
      out.sandboxes[k].data = { ...freshFacilityData(), ...(out.sandboxes[k].data||{}) };
      out.sandboxes[k].data.actuals = { ...freshFacilityData().actuals, ...(out.sandboxes[k].data?.actuals||{}) };
    });
  }

  // Ensure selected facility is valid
  if(!out.ui.selectedFacilityId && out.org.facilities.length){
    out.ui.selectedFacilityId = out.org.facilities[0].id;
  }
  if(!out.ui.activeSandboxId || !out.sandboxes[out.ui.activeSandboxId]){
    out.ui.activeSandboxId = Object.keys(out.sandboxes)[0] || 'default';
  }
  return out;
}

export function saveState(state){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

export function getDataset(state){
  if(state.ui.mode === 'official') return state.official;
  const sid = state.ui.activeSandboxId || 'default';
  return state.sandboxes[sid]?.data || state.official;
}

export function setDataset(state, dataset){
  if(state.ui.mode === 'official'){ state.official = dataset; return; }
  const sid = state.ui.activeSandboxId || 'default';
  if(!state.sandboxes[sid]) state.sandboxes[sid] = { name:'Sandbox', createdAt:new Date().toISOString(), data: dataset };
  else state.sandboxes[sid].data = dataset;
}

export function pushSandboxToOfficial(state){
  state.official = JSON.parse(JSON.stringify(getDataset(state)));
}

// Sandbox management
export function createSandbox(state, name){
  const id = `sb_${Math.random().toString(36).slice(2,9)}`;
  // Copy current official as starting point
  state.sandboxes[id] = {
    name: name || `Sandbox ${Object.keys(state.sandboxes).length + 1}`,
    createdAt: new Date().toISOString(),
    data: JSON.parse(JSON.stringify(state.official))
  };
  return id;
}

export function deleteSandbox(state, id){
  if(id === 'default') return; // protect default
  delete state.sandboxes[id];
  if(state.ui.activeSandboxId === id){
    state.ui.activeSandboxId = Object.keys(state.sandboxes)[0] || 'default';
  }
}

export function renameSandbox(state, id, name){
  if(state.sandboxes[id]) state.sandboxes[id].name = name;
}
