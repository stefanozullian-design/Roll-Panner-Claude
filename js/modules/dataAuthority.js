import { getDataset } from './store.js';

const uid = (p='id') => `${p}_${Math.random().toString(36).slice(2,9)}`;
const slug = s => (s||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'');

export const Categories = {
  RAW: 'RAW_MATERIAL', FUEL: 'FUEL', INT: 'INTERMEDIATE_PRODUCT', FIN: 'FINISHED_PRODUCT'
};

// Resolve which facilities are in scope for the current selection
// selectedFacilityIds can be an array of facilityId, subRegionId, regionId, or countryId
export function resolveScope(state){
  const org = state.org;

  // Support both legacy single id and new multi-select array
  const rawIds = state.ui.selectedFacilityIds?.length
    ? state.ui.selectedFacilityIds
    : state.ui.selectedFacilityId
      ? [state.ui.selectedFacilityId]
      : [];

  if(!rawIds.length) {
    return { type:'none', facilityIds:[], regionId: null, subRegionId: null };
  }

  // Expand each selected id to facility ids
  const allFacIds = new Set();
  let regionIds = new Set();
  let subRegionIds = new Set();

  rawIds.forEach(sel => {
    // Direct facility
    if(org.facilities.find(f=>f.id===sel)){
      allFacIds.add(sel);
      const fac = org.facilities.find(f=>f.id===sel);
      const sr = org.subRegions.find(s=>s.id===fac.subRegionId);
      if(sr) { subRegionIds.add(sr.id); const r = org.regions.find(x=>x.id===sr.regionId); if(r) regionIds.add(r.id); }
      return;
    }
    // Sub-region
    if(org.subRegions.find(s=>s.id===sel)){
      const sr = org.subRegions.find(s=>s.id===sel);
      subRegionIds.add(sel);
      const r = org.regions.find(x=>x.id===sr.regionId); if(r) regionIds.add(r.id);
      org.facilities.filter(f=>f.subRegionId===sel).forEach(f=>allFacIds.add(f.id));
      return;
    }
    // Region
    if(org.regions.find(r=>r.id===sel)){
      regionIds.add(sel);
      const srIds = org.subRegions.filter(s=>s.regionId===sel).map(s=>s.id);
      srIds.forEach(sid=>subRegionIds.add(sid));
      org.facilities.filter(f=>srIds.includes(f.subRegionId)).forEach(f=>allFacIds.add(f.id));
      return;
    }
    // Country
    if(org.countries.find(c=>c.id===sel)){
      const rIds = org.regions.filter(r=>r.countryId===sel).map(r=>r.id);
      rIds.forEach(rid=>regionIds.add(rid));
      const srIds = org.subRegions.filter(s=>rIds.includes(s.regionId)).map(s=>s.id);
      srIds.forEach(sid=>subRegionIds.add(sid));
      org.facilities.filter(f=>srIds.includes(f.subRegionId)).forEach(f=>allFacIds.add(f.id));
    }
  });

  const facilityIds = [...allFacIds];
  const type = facilityIds.length === 1 ? 'facility'
    : rawIds.every(id=>org.facilities.find(f=>f.id===id)) ? 'facility'
    : rawIds.some(id=>org.subRegions.find(s=>s.id===id)) ? 'subregion'
    : rawIds.some(id=>org.regions.find(r=>r.id===id)) ? 'region'
    : 'country';

  const regionId = regionIds.size === 1 ? [...regionIds][0] : (regionIds.size > 1 ? [...regionIds][0] : null);
  const subRegionId = subRegionIds.size === 1 ? [...subRegionIds][0] : null;

  return { type, facilityIds, regionId, subRegionId };
}

function getFacilityRegionId(state){
  return resolveScope(state).regionId;
}

// Get region ID for a specific facility
function getFacRegionId(state, facId){
  const fac = state.org.facilities.find(f=>f.id===facId);
  if(!fac) return null;
  const sr = state.org.subRegions.find(s=>s.id===fac.subRegionId);
  return sr ? sr.regionId : null;
}

export function selectors(state){
  const ds = getDataset(state);
  const scope = resolveScope(state);
  const { facilityIds, regionId } = scope;
  // Primary facility = first selected facility (for single-facility operations like equipment, recipes)
  const rawIds = state.ui.selectedFacilityIds?.length ? state.ui.selectedFacilityIds : [];
  const fac = facilityIds.length === 1 ? facilityIds[0]
    : rawIds.find(id => state.org.facilities.find(f=>f.id===id))
    || facilityIds[0] || null;

  // Materials: from regional catalog filtered to what any in-scope facility has activated
  // If scope is single facility: only show products that facility has activated
  // If scope is broader: show union of all activated products across facilities in scope
  const activatedIds = new Set(
    (ds.facilityProducts||[])
      .filter(fp => facilityIds.includes(fp.facilityId))
      .map(fp => fp.productId)
  );
  // Fall back to full regional catalog if no facility products defined yet
  const regionMats = state.catalog.filter(m => !regionId || m.regionId===regionId);
  const mats = activatedIds.size > 0
    ? regionMats.filter(m => activatedIds.has(m.id))
    : regionMats;

  const equip = ds.equipment.filter(e => facilityIds.includes(e.facilityId));
  const stor  = ds.storages.filter(s => facilityIds.includes(s.facilityId));
  const caps  = ds.capabilities.filter(c => equip.some(e=>e.id===c.equipmentId));

  return {
    dataset: ds,
    org: state.org,
    catalog: state.catalog,
    scope,
    facilityIds,
    isSingleFacility: facilityIds.length === 1,
    facility: state.org.facilities.find(f=>f.id===fac),
    facilities: state.org.facilities,
    regionId,
    materials: mats,
    // All catalog items for region (for product activation UI)
    regionCatalog: regionMats,
    finishedProducts: mats.filter(m=>m.category===Categories.FIN),
    intermediates: mats.filter(m=>m.category===Categories.INT),
    fuels: mats.filter(m=>m.category===Categories.FUEL),
    raws: mats.filter(m=>m.category===Categories.RAW),
    equipment: equip,
    storages: stor,
    capabilities: caps,
    // Active products for a specific facility
    getFacilityProducts: facId => {
      const ids = new Set((ds.facilityProducts||[]).filter(fp=>fp.facilityId===facId).map(fp=>fp.productId));
      const rId = getFacRegionId(state, facId);
      const cat = state.catalog.filter(m => !rId || m.regionId===rId);
      return ids.size > 0 ? cat.filter(m=>ids.has(m.id)) : cat;
    },
    getMaterial: id => state.catalog.find(m=>m.id===id),
    getEquipment: id => ds.equipment.find(e=>e.id===id),
    getStorage: id => ds.storages.find(s=>s.id===id),
    getCapsForEquipment: eid => ds.capabilities.filter(c=>c.equipmentId===eid),
    getRecipeForProduct: pid => ds.recipes
      .filter(r=>facilityIds.includes(r.facilityId) && r.productId===pid)
      .sort((a,b)=>(b.version||1)-(a.version||1))[0] || null,
    actualsForDate: (date)=>({
      inv:  ds.actuals.inventoryEOD.filter(r=>r.date===date && facilityIds.includes(r.facilityId)),
      prod: ds.actuals.production.filter(r=>r.date===date && facilityIds.includes(r.facilityId)),
      ship: ds.actuals.shipments.filter(r=>r.date===date && facilityIds.includes(r.facilityId)),
    }),
    demandForDateProduct: (date,pid)=>{
      // Sum across all facilities in scope
      const actual = ds.actuals.shipments
        .filter(r=>r.date===date && facilityIds.includes(r.facilityId) && r.productId===pid)
        .reduce((s,r)=>s+(+r.qtyStn||0),0);
      if(actual>0) return actual;
      return ds.demandForecast
        .filter(r=>r.date===date && facilityIds.includes(r.facilityId) && r.productId===pid)
        .reduce((s,r)=>s+(+r.qtyStn||0),0);
    },
    // Sandbox helpers
    sandboxes: state.sandboxes,
    activeSandboxId: state.ui.activeSandboxId,
    // Org helpers
    getCountry: id => state.org.countries.find(c=>c.id===id),
    getRegion: id => state.org.regions.find(r=>r.id===id),
    getSubRegion: id => state.org.subRegions.find(s=>s.id===id),
    getFacilityPath: id => {
      const f = state.org.facilities.find(x=>x.id===id);
      if(!f) return '';
      const sr = state.org.subRegions.find(x=>x.id===f.subRegionId);
      const r  = sr ? state.org.regions.find(x=>x.id===sr.regionId) : null;
      const c  = r  ? state.org.countries.find(x=>x.id===r.countryId) : null;
      return [c?.code, r?.code, sr?.code, f.code].filter(Boolean).join(' › ');
    },
    getScopeName: () => {
      const sel = state.ui.selectedFacilityId;
      const org = state.org;
      const f  = org.facilities.find(x=>x.id===sel);  if(f)  return f.name;
      const sr = org.subRegions.find(x=>x.id===sel);   if(sr) return sr.name;
      const r  = org.regions.find(x=>x.id===sel);      if(r)  return r.name;
      const ct = org.countries.find(x=>x.id===sel);    if(ct) return ct.name;
      return 'All';
    }
  };
}

export function actions(state){
  const ds = getDataset(state);
  const scope = resolveScope(state);
  // For write operations, always use the primary (single) facility
  const fac = scope.type==='facility' ? state.ui.selectedFacilityId : (scope.facilityIds[0]||null);
  const regionId = getFacilityRegionId(state);

  return {
    // ── ORG HIERARCHY ──
    // ── FACILITY PRODUCT ACTIVATION ──
    activateProductForFacility(facId, productId){
      if(!(ds.facilityProducts||[]).find(fp=>fp.facilityId===facId && fp.productId===productId)){
        if(!ds.facilityProducts) ds.facilityProducts = [];
        ds.facilityProducts.push({facilityId:facId, productId});
      }
    },
    deactivateProductForFacility(facId, productId){
      if(ds.facilityProducts) ds.facilityProducts = ds.facilityProducts.filter(fp=>!(fp.facilityId===facId && fp.productId===productId));
    },

    // ── ORG HIERARCHY ──
    addCountry({name, code}){
      const id = `country_${slug(code||name)}`;
      if(state.org.countries.some(c=>c.id===id)) return;
      state.org.countries.push({id, name, code: slug(code||name)});
      return id;
    },
    updateCountry({id, name, code}){
      const i = state.org.countries.findIndex(c=>c.id===id);
      if(i>=0) state.org.countries[i] = {...state.org.countries[i], name, code};
    },
    deleteCountry(id){
      // cascade delete
      const regions = state.org.regions.filter(r=>r.countryId===id).map(r=>r.id);
      regions.forEach(rid => this.deleteRegion(rid));
      state.org.countries = state.org.countries.filter(c=>c.id!==id);
    },
    addRegion({countryId, name, code}){
      const id = `region_${slug(code||name)}`;
      if(state.org.regions.some(r=>r.id===id)) return;
      state.org.regions.push({id, countryId, name, code: slug(code||name)});
      return id;
    },
    updateRegion({id, name, code}){
      const i = state.org.regions.findIndex(r=>r.id===id);
      if(i>=0) state.org.regions[i] = {...state.org.regions[i], name, code};
    },
    deleteRegion(id){
      const subs = state.org.subRegions.filter(s=>s.regionId===id).map(s=>s.id);
      subs.forEach(sid => this.deleteSubRegion(sid));
      state.org.regions = state.org.regions.filter(r=>r.id!==id);
      state.catalog = state.catalog.filter(m=>m.regionId!==id);
    },
    addSubRegion({regionId, name, code}){
      const id = `subregion_${slug(code||name)}`;
      if(state.org.subRegions.some(s=>s.id===id)) return;
      state.org.subRegions.push({id, regionId, name, code: slug(code||name)});
      return id;
    },
    updateSubRegion({id, name, code}){
      const i = state.org.subRegions.findIndex(s=>s.id===id);
      if(i>=0) state.org.subRegions[i] = {...state.org.subRegions[i], name, code};
    },
    deleteSubRegion(id){
      const facs = state.org.facilities.filter(f=>f.subRegionId===id).map(f=>f.id);
      facs.forEach(fid => this.deleteFacility(fid));
      state.org.subRegions = state.org.subRegions.filter(s=>s.id!==id);
    },
    addFacility({subRegionId, name, code}){
      const id = slug(code||name);
      if(state.org.facilities.some(f=>f.id===id)) return;
      state.org.facilities.push({id, subRegionId, name, code: slug(code||name)});
      return id;
    },
    updateFacility({id, name, code}){
      const i = state.org.facilities.findIndex(f=>f.id===id);
      if(i>=0) state.org.facilities[i] = {...state.org.facilities[i], name, code};
    },
    deleteFacility(id){
      state.org.facilities = state.org.facilities.filter(f=>f.id!==id);
      // Clean facility data from all sandboxes and official
      const clean = data => {
        ['equipment','storages','capabilities','demandForecast','campaigns','recipes'].forEach(k=>{
          if(data[k]) data[k] = data[k].filter(r=>r.facilityId!==id);
        });
        if(data.actuals){
          ['inventoryEOD','production','shipments'].forEach(k=>{
            if(data.actuals[k]) data.actuals[k] = data.actuals[k].filter(r=>r.facilityId!==id);
          });
        }
      };
      clean(state.official);
      Object.values(state.sandboxes||{}).forEach(sb=>clean(sb.data||{}));
    },

    // ── CATALOG (regional materials/products) ──
    upsertCatalogItem(m){
      const rId = m.regionId || regionId;
      if(m.id){
        const i = state.catalog.findIndex(x=>x.id===m.id);
        if(i>=0){ state.catalog[i]={...state.catalog[i],...m}; return state.catalog[i]; }
      }
      const code = slug(m.code || m.name);
      const id = `${rId}|${code}`;
      const row = { id, regionId: rId, code, name:m.name, category:m.category,
        unit:m.unit||'STn', landedCostUsdPerStn:+(m.landedCostUsdPerStn||0),
        calorificPowerMMBTUPerStn:+(m.calorificPowerMMBTUPerStn||0),
        co2FactorKgPerMMBTU:+(m.co2FactorKgPerMMBTU||0) };
      state.catalog.push(row);
      return row;
    },
    deleteCatalogItem(id){
      state.catalog = state.catalog.filter(m=>m.id!==id);
      // Clean references across all data
      const clean = data => {
        if(data.recipes) data.recipes = data.recipes.filter(r=>r.productId!==id && !(r.components||[]).some(c=>c.materialId===id));
        if(data.capabilities) data.capabilities = data.capabilities.filter(c=>c.productId!==id);
        if(data.storages) data.storages = data.storages.map(st=>({...st, allowedProductIds:(st.allowedProductIds||[]).filter(p=>p!==id)}));
        if(data.actuals?.inventoryEOD) data.actuals.inventoryEOD = data.actuals.inventoryEOD.filter(r=>r.productId!==id);
        if(data.actuals?.production) data.actuals.production = data.actuals.production.filter(r=>r.productId!==id);
        if(data.actuals?.shipments) data.actuals.shipments = data.actuals.shipments.filter(r=>r.productId!==id);
        if(data.demandForecast) data.demandForecast = data.demandForecast.filter(r=>r.productId!==id);
        if(data.campaigns) data.campaigns = data.campaigns.filter(r=>r.productId!==id);
      };
      clean(state.official);
      Object.values(state.sandboxes||{}).forEach(sb=>clean(sb.data||{}));
    },

    // Keep backward compat aliases
    upsertMaterial(m){ return this.upsertCatalogItem({...m, regionId: m.regionId||regionId}); },
    deleteMaterial(id){ return this.deleteCatalogItem(id); },

    // ── RECIPES ──
    saveRecipe({productId, version=1, components, effectiveStart='', effectiveEnd=''}){
      const rid = `${fac}|${(state.catalog.find(m=>m.id===productId)?.code)||productId}|v${version}`;
      const idx = ds.recipes.findIndex(r=>r.id===rid);
      const row = { id:rid, facilityId:fac, productId, version:+version, effectiveStart, effectiveEnd, components: components.filter(c=>c.materialId && c.pct>0).map(c=>({materialId:c.materialId,pct:+c.pct})) };
      if(idx>=0) ds.recipes[idx]=row; else ds.recipes.push(row);
      return row;
    },
    deleteRecipe(recipeId){ ds.recipes = ds.recipes.filter(r=>!(r.id===recipeId && r.facilityId===fac)); },

    // ── EQUIPMENT ──
    upsertEquipment({id,name,type}){
      const prefix = type==='kiln'?'K':(type==='finish_mill'?'FM':(type==='raw_mill'?'RM':'EQ'));
      const n = (name||'').trim() || `${prefix}${1+ds.equipment.filter(e=>e.facilityId===fac && e.type===type).length}`;
      const nextId = id || `${fac}_${slug(n)}`;
      const row = { id:nextId, facilityId:fac, name:n, type };
      const i = ds.equipment.findIndex(e=>e.id===nextId);
      if(i>=0) ds.equipment[i]=row; else ds.equipment.push(row);
      return row;
    },
    deleteEquipment(equipmentId){
      ds.equipment = ds.equipment.filter(e=>!(e.id===equipmentId && e.facilityId===fac));
      ds.capabilities = ds.capabilities.filter(c=>c.equipmentId!==equipmentId);
      ds.actuals.production = ds.actuals.production.filter(r=>!(r.facilityId===fac && r.equipmentId===equipmentId));
      ds.campaigns = ds.campaigns.filter(r=>!(r.facilityId===fac && r.equipmentId===equipmentId));
    },

    // ── STORAGES ──
    upsertStorage({id,name,categoryHint,allowedProductIds=[],maxCapacityStn}){
      const nextId = id || `${fac}_${slug(name)}`;
      const row = { id:nextId, facilityId:fac, name, categoryHint, allowedProductIds:[...allowedProductIds], maxCapacityStn:+(maxCapacityStn||0) };
      const i = ds.storages.findIndex(s=>s.id===nextId);
      if(i>=0) ds.storages[i]=row; else ds.storages.push(row);
      return row;
    },
    deleteStorage(storageId){
      ds.storages = ds.storages.filter(st=>!(st.id===storageId && st.facilityId===fac));
      ds.actuals.inventoryEOD = ds.actuals.inventoryEOD.filter(r=>!(r.facilityId===fac && r.storageId===storageId));
    },

    // ── CAPABILITIES ──
    upsertCapability({equipmentId,productId,maxRateStpd,electricKwhPerStn,thermalMMBTUPerStn}){
      const id=`${equipmentId}|${productId}`;
      const row={id,equipmentId,productId,maxRateStpd:+(maxRateStpd||0),electricKwhPerStn:+(electricKwhPerStn||0),thermalMMBTUPerStn:+(thermalMMBTUPerStn||0)};
      const i=ds.capabilities.findIndex(c=>c.id===id); if(i>=0) ds.capabilities[i]=row; else ds.capabilities.push(row);
    },
    deleteCapability(capabilityId){ ds.capabilities=ds.capabilities.filter(c=>c.id!==capabilityId); },
    addConnection({fromId,toId}){ ds.connections=(ds.connections||[]); ds.connections.push({id:uid('ln'),facilityId:fac,fromId,toId}); },

    // ── ACTUALS ──
    saveDailyActuals({date,inventoryRows,productionRows,shipmentRows}){
      ds.actuals.inventoryEOD = ds.actuals.inventoryEOD.filter(r=>!(r.date===date && r.facilityId===fac));
      ds.actuals.production   = ds.actuals.production.filter(r=>!(r.date===date && r.facilityId===fac));
      ds.actuals.shipments    = ds.actuals.shipments.filter(r=>!(r.date===date && r.facilityId===fac));
      inventoryRows.filter(r=>r.storageId&&r.productId&&isFinite(r.qtyStn)).forEach(r=>ds.actuals.inventoryEOD.push({date,facilityId:fac,storageId:r.storageId,productId:r.productId,qtyStn:+r.qtyStn}));
      productionRows.filter(r=>r.equipmentId&&r.productId&&isFinite(r.qtyStn)&&+r.qtyStn!==0).forEach(r=>ds.actuals.production.push({date,facilityId:fac,equipmentId:r.equipmentId,productId:r.productId,qtyStn:+r.qtyStn}));
      shipmentRows.filter(r=>r.productId&&isFinite(r.qtyStn)&&+r.qtyStn!==0).forEach(r=>ds.actuals.shipments.push({date,facilityId:fac,productId:r.productId,qtyStn:+r.qtyStn}));
    },

    // ── DEMAND ──
    saveDemandForecastRows(rows){
      rows.forEach(r=>{
        const key=`${r.date}|${fac}|${r.productId}`;
        ds.demandForecast=ds.demandForecast.filter(x=>`${x.date}|${x.facilityId}|${x.productId}`!==key);
        ds.demandForecast.push({date:r.date,facilityId:fac,productId:r.productId,qtyStn:+r.qtyStn,source:'forecast'});
      });
    },

    // ── CAMPAIGNS ──
    saveCampaignRows(rows){
      rows.forEach(r=>{
        const key=`${r.date}|${fac}|${r.equipmentId}`;
        ds.campaigns=ds.campaigns.filter(x=>`${x.date}|${x.facilityId}|${x.equipmentId}`!==key);
        const status=r.status||((r.productId&&(+r.rateStn||0)>0)?'produce':'idle');
        ds.campaigns.push({date:r.date,facilityId:fac,equipmentId:r.equipmentId,productId:r.productId||'',rateStn:+r.rateStn||0,status});
      });
    },
    saveCampaignBlock({equipmentId,status='produce',productId='',startDate,endDate,rateStn=0}){
      if(!equipmentId||!startDate||!endDate) return;
      let d=new Date(startDate+'T00:00:00'); const end=new Date(endDate+'T00:00:00');
      const rows=[];
      while(d<=end){ rows.push({date:d.toISOString().slice(0,10),equipmentId,status,productId:status==='produce'?productId:'',rateStn:status==='produce'?(+rateStn||0):0}); d.setDate(d.getDate()+1); }
      this.saveCampaignRows(rows);
    },
    deleteCampaignRange({equipmentId,startDate,endDate}){
      if(!equipmentId||!startDate||!endDate) return;
      ds.campaigns=ds.campaigns.filter(c=>!(c.facilityId===fac&&c.equipmentId===equipmentId&&c.date>=startDate&&c.date<=endDate));
    }
  };
}
