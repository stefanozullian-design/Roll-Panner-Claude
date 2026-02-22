import { getDataset } from './store.js';

const uid = (p='id') => `${p}_${Math.random().toString(36).slice(2,9)}`;
const slug = s => (s||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'');

export const Categories = {
  RAW: 'RAW_MATERIAL', FUEL: 'FUEL', INT: 'INTERMEDIATE_PRODUCT', FIN: 'FINISHED_PRODUCT'
};

export function selectors(state){
  const ds = getDataset(state);
  const fac = state.ui.selectedFacilityId;
  const mats = ds.materials.filter(m => !m.facilityId || m.facilityId===fac);
  const equip = ds.equipment.filter(e => e.facilityId===fac);
  const stor = ds.storages.filter(s => s.facilityId===fac);
  const caps = ds.capabilities.filter(c => equip.some(e=>e.id===c.equipmentId));
  return {
    dataset: ds,
    facility: ds.facilities.find(f=>f.id===fac),
    facilities: ds.facilities,
    materials: mats,
    finishedProducts: mats.filter(m=>m.category===Categories.FIN),
    intermediates: mats.filter(m=>m.category===Categories.INT),
    fuels: mats.filter(m=>m.category===Categories.FUEL),
    raws: mats.filter(m=>m.category===Categories.RAW),
    equipment: equip,
    storages: stor,
    capabilities: caps,
    getMaterial: id => ds.materials.find(m=>m.id===id),
    getEquipment: id => ds.equipment.find(e=>e.id===id),
    getStorage: id => ds.storages.find(s=>s.id===id),
    getCapsForEquipment: eid => ds.capabilities.filter(c=>c.equipmentId===eid),
    getRecipeForProduct: pid => ds.recipes.filter(r=>r.facilityId===fac && r.productId===pid)
      .sort((a,b)=>(b.version||1)-(a.version||1))[0] || null,
    actualsForDate: (date)=> ({
      inv: ds.actuals.inventoryEOD.filter(r=>r.date===date && r.facilityId===fac),
      prod: ds.actuals.production.filter(r=>r.date===date && r.facilityId===fac),
      ship: ds.actuals.shipments.filter(r=>r.date===date && r.facilityId===fac),
    }),
    demandForDateProduct: (date,pid)=> {
      const actual = ds.actuals.shipments.find(r=>r.date===date && r.facilityId===fac && r.productId===pid);
      if (actual) return actual.qtyStn;
      return ds.demandForecast.find(r=>r.date===date && r.facilityId===fac && r.productId===pid)?.qtyStn || 0;
    }
  };
}

export function actions(state){
  const ds = getDataset(state);
  const fac = state.ui.selectedFacilityId;
  return {
    addFacility(name, id, region='FL', country='USA'){
      if(ds.facilities.some(f=>f.id===id)) return;
      ds.facilities.push({id, name, region, country});
    },
    upsertMaterial(m){
      if (m.id) {
        const i=ds.materials.findIndex(x=>x.id===m.id); if(i>=0) ds.materials[i]={...ds.materials[i],...m}; return ds.materials[i];
      }
      const code = slug(m.code || m.name);
      const recVer = Number(m.recipeVersionNo||1);
      const id = `${fac}|${code}|v${recVer}`;
      const row = { id, facilityId: fac, code, name:m.name, category:m.category, unit:m.unit||'STn', landedCostUsdPerStn:+(m.landedCostUsdPerStn||0), calorificPowerMMBTUPerStn: +(m.calorificPowerMMBTUPerStn||0), co2FactorKgPerMMBTU:+(m.co2FactorKgPerMMBTU||0), recipeVersionNo: recVer };
      ds.materials.push(row);
      return row;
    },
    deleteMaterial(materialId){
      ds.materials = ds.materials.filter(m=>!(m.id===materialId && m.facilityId===fac));
      ds.recipes = ds.recipes.filter(r=>!(r.facilityId===fac && (r.productId===materialId || (r.components||[]).some(c=>c.materialId===materialId))));
      ds.capabilities = ds.capabilities.filter(c=>c.productId!==materialId);
      ds.storages = ds.storages.map(st=>({ ...st, allowedProductIds:(st.allowedProductIds||[]).filter(pid=>pid!==materialId) }));
      ds.actuals.inventoryEOD = ds.actuals.inventoryEOD.filter(r=>!(r.facilityId===fac && r.productId===materialId));
      ds.actuals.production = ds.actuals.production.filter(r=>!(r.facilityId===fac && r.productId===materialId));
      ds.actuals.shipments = ds.actuals.shipments.filter(r=>!(r.facilityId===fac && r.productId===materialId));
      ds.demandForecast = ds.demandForecast.filter(r=>!(r.facilityId===fac && r.productId===materialId));
      ds.campaigns = ds.campaigns.filter(r=>!(r.facilityId===fac && r.productId===materialId));
    },
    saveRecipe({productId, version=1, components, effectiveStart='', effectiveEnd=''}){
      const rid = `${fac}|${(ds.materials.find(m=>m.id===productId)?.code)||productId}|v${version}`;
      const idx = ds.recipes.findIndex(r=>r.id===rid);
      const row = { id:rid, facilityId:fac, productId, version:+version, effectiveStart, effectiveEnd, components: components.filter(c=>c.materialId && c.pct>0).map(c=>({materialId:c.materialId,pct:+c.pct})) };
      if(idx>=0) ds.recipes[idx]=row; else ds.recipes.push(row);
      return row;
    },
    deleteRecipe(recipeId){
      ds.recipes = ds.recipes.filter(r=>!(r.id===recipeId && r.facilityId===fac));
    },
    upsertEquipment({id,name,type}){
      const prefix = type==='kiln'?'K':(type==='finish_mill'?'FM':(type==='raw_mill'?'RM':'EQ'));
      const n = (name||'').trim() || `${prefix}${1 + ds.equipment.filter(e=>e.facilityId===fac && e.type===type).length}`;
      const nextId = id || `${fac}_${slug(n)}`;
      const row = { id: nextId, facilityId: fac, name:n, type };
      const i = ds.equipment.findIndex(e=>e.id===nextId);
      if(i>=0) ds.equipment[i]=row; else ds.equipment.push(row);
      return row;
    },
    deleteEquipment(equipmentId){
      ds.equipment = ds.equipment.filter(e=>!(e.id===equipmentId && e.facilityId===fac));
      ds.capabilities = ds.capabilities.filter(c=>c.equipmentId!==equipmentId);
      ds.actuals.production = ds.actuals.production.filter(r=>!(r.facilityId===fac && r.equipmentId===equipmentId));
      ds.campaigns = ds.campaigns.filter(r=>!(r.facilityId===fac && r.equipmentId===equipmentId));
      ds.connections = ds.connections.filter(c=>c.fromId!==equipmentId && c.toId!==equipmentId);
    },
    upsertStorage({id,name, categoryHint, allowedProductIds=[], maxCapacityStn}){
      const nextId = id || `${fac}_${slug(name)}`;
      const row = { id:nextId, facilityId:fac, name, categoryHint, allowedProductIds:[...allowedProductIds], maxCapacityStn:+(maxCapacityStn||0) };
      const i = ds.storages.findIndex(s=>s.id===nextId);
      if(i>=0) ds.storages[i]=row; else ds.storages.push(row);
      return row;
    },
    deleteStorage(storageId){
      ds.storages = ds.storages.filter(st=>!(st.id===storageId && st.facilityId===fac));
      ds.actuals.inventoryEOD = ds.actuals.inventoryEOD.filter(r=>!(r.facilityId===fac && r.storageId===storageId));
      ds.connections = ds.connections.filter(c=>c.fromId!==storageId && c.toId!==storageId);
    },
    addConnection({fromId,toId}){ ds.connections.push({id:uid('ln'), facilityId:fac, fromId, toId}); },
    upsertCapability({equipmentId, productId, maxRateStpd, electricKwhPerStn, thermalMMBTUPerStn}){
      const id = `${equipmentId}|${productId}`;
      const row = { id, equipmentId, productId, maxRateStpd:+(maxRateStpd||0), electricKwhPerStn:+(electricKwhPerStn||0), thermalMMBTUPerStn:+(thermalMMBTUPerStn||0) };
      const i=ds.capabilities.findIndex(c=>c.id===id); if(i>=0) ds.capabilities[i]=row; else ds.capabilities.push(row);
    },
    deleteCapability(capabilityId){ ds.capabilities = ds.capabilities.filter(c=>c.id!==capabilityId); },
    saveDailyActuals(payload){
      const {date, inventoryRows, productionRows, shipmentRows} = payload;
      ds.actuals.inventoryEOD = ds.actuals.inventoryEOD.filter(r=>!(r.date===date && r.facilityId===fac));
      ds.actuals.production = ds.actuals.production.filter(r=>!(r.date===date && r.facilityId===fac));
      ds.actuals.shipments = ds.actuals.shipments.filter(r=>!(r.date===date && r.facilityId===fac));
      inventoryRows.filter(r=>r.storageId && r.productId && isFinite(r.qtyStn)).forEach(r=>ds.actuals.inventoryEOD.push({date, facilityId:fac, storageId:r.storageId, productId:r.productId, qtyStn:+r.qtyStn}));
      productionRows.filter(r=>r.equipmentId && r.productId && isFinite(r.qtyStn) && +r.qtyStn!==0).forEach(r=>ds.actuals.production.push({date, facilityId:fac, equipmentId:r.equipmentId, productId:r.productId, qtyStn:+r.qtyStn}));
      shipmentRows.filter(r=>r.productId && isFinite(r.qtyStn) && +r.qtyStn!==0).forEach(r=>ds.actuals.shipments.push({date, facilityId:fac, productId:r.productId, qtyStn:+r.qtyStn}));
    },
    saveDemandForecastRows(rows){
      rows.forEach(r=>{
        const key = `${r.date}|${fac}|${r.productId}`;
        ds.demandForecast = ds.demandForecast.filter(x=>`${x.date}|${x.facilityId}|${x.productId}`!==key);
        ds.demandForecast.push({date:r.date, facilityId:fac, productId:r.productId, qtyStn:+r.qtyStn, source:'forecast'});
      })
    },
    saveCampaignRows(rows){
      rows.forEach(r=>{
        const key = `${r.date}|${fac}|${r.equipmentId}`;
        ds.campaigns = ds.campaigns.filter(x=>`${x.date}|${x.facilityId}|${x.equipmentId}`!==key);
        const status = r.status || ((r.productId && (+r.rateStn||0)>0) ? 'produce' : 'idle');
        ds.campaigns.push({date:r.date, facilityId:fac, equipmentId:r.equipmentId, productId:r.productId||'', rateStn:+r.rateStn||0, status});
      })
    },
    saveCampaignBlock({equipmentId, status='produce', productId='', startDate, endDate, rateStn=0}){
      if(!equipmentId || !startDate || !endDate) return;
      let d = new Date(startDate+'T00:00:00');
      const end = new Date(endDate+'T00:00:00');
      const rows = [];
      while(d <= end){
        rows.push({ date:d.toISOString().slice(0,10), equipmentId, status, productId: status==='produce' ? productId : '', rateStn: status==='produce' ? (+rateStn||0) : 0 });
        d.setDate(d.getDate()+1);
      }
      this.saveCampaignRows(rows);
    },
    deleteCampaignRange({equipmentId, startDate, endDate}){
      if(!equipmentId || !startDate || !endDate) return;
      ds.campaigns = ds.campaigns.filter(c=> !(c.facilityId===fac && c.equipmentId===equipmentId && c.date>=startDate && c.date<=endDate));
    }
  };
}
