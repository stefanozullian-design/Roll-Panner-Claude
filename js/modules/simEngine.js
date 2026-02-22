import { selectors, Categories } from './dataAuthority.js';

const fmtDate = d => d.toISOString().slice(0,10);
const addDays = (dateStr,n)=>{ const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+n); return fmtDate(d); };
export const startOfMonth = (dateStr)=> `${dateStr.slice(0,7)}-01`;

function familyOfProduct(s, pid){
  const m = s.getMaterial(pid);
  if(!m) return 'OTHER';
  if(/CLINKER|\bCLK\b/i.test(m.name) || m.category===Categories.INT) return 'CLINKER';
  if(m.category===Categories.FIN) return 'CEMENT';
  if(m.category===Categories.FUEL) return 'FUEL';
  if(m.category===Categories.RAW) return 'RAW';
  return 'OTHER';
}

export function buildProductionPlanView(state, startDate, days=35){
  const s = selectors(state);
  const ds = s.dataset;
  const fac = state.ui.selectedFacilityId;
  const dates = Array.from({length:days},(_,i)=>addDays(startDate,i));
  const storages = s.storages;
  const kilns = s.equipment.filter(e=>e.type==='kiln');
  const fms = s.equipment.filter(e=>e.type==='finish_mill');

  const invEODByDateStorage = new Map();
  ds.actuals.inventoryEOD.filter(r=>r.facilityId===fac).forEach(r=>invEODByDateStorage.set(`${r.date}|${r.storageId}`, r));
  const actualProdByDateEqProd = new Map();
  ds.actuals.production.filter(r=>r.facilityId===fac).forEach(r=>actualProdByDateEqProd.set(`${r.date}|${r.equipmentId}|${r.productId}`, +r.qtyStn));

  const storageByProduct = new Map();
  storages.forEach(st=> (st.allowedProductIds||[]).forEach(pid=>{ if(!storageByProduct.has(pid)) storageByProduct.set(pid, st); }));
  const findStorageForProduct = pid => storageByProduct.get(pid);

  const demandFallbackByProduct = new Map();
  const avgActualShip = (pid, beforeDate, n=7)=>{
    let vals=[]; let cur=new Date(beforeDate+'T00:00:00'); cur.setDate(cur.getDate()-1); let guard=0;
    while(vals.length<n && guard<120){
      guard++; const ds0 = cur.toISOString().slice(0,10); const dow = cur.getDay();
      if(dow!==0){
        const row = ds.actuals.shipments.find(r=>r.facilityId===fac && r.date===ds0 && r.productId===pid);
        const q = row ? +row.qtyStn : null; if(q!=null && q>0) vals.push(q);
      }
      cur.setDate(cur.getDate()-1);
    }
    return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : 0;
  };
  const expectedShipForProduct = (date,pid)=>{
    const key=`${date}|${pid}`; if(demandFallbackByProduct.has(key)) return demandFallbackByProduct.get(key);
    const q = +s.demandForDateProduct(date,pid) || 0;
    const v = q>0 ? q : avgActualShip(pid,date,7);
    demandFallbackByProduct.set(key,v);
    return v;
  };

  const getEqProd = (date, eqId, pid) => {
    let q = actualProdByDateEqProd.get(`${date}|${eqId}|${pid}`);
    if(q==null){
      const camp = ds.campaigns.find(c=>c.date===date && c.facilityId===fac && c.equipmentId===eqId && (c.status||'produce')==='produce' && c.productId===pid);
      q = camp?.rateStn ?? 0;
    }
    return +q||0;
  };

  const bodByStorageDate = new Map();
  const eodByStorageDate = new Map();
  const shipByProductDate = new Map();
  const derivedClkUseByDate = new Map();
  const kilnProdByDate = new Map();
  const fmProdByDate = new Map();
  const prodByEqDate = new Map();
  const eqCellMeta = new Map();
  const eqConstraintMeta = new Map();
  const inventoryCellMeta = new Map();
  const alertsByDate = new Map();

  const yesterday = addDays(startDate,-1);
  storages.forEach(st=>{
    // Interim v1 rule for testing: inventory rows entered in Daily Actuals are treated as
    // the beginning inventory for the selected date (seed), not an override of calculated EOD.
    // This matches the user's validation workflow: BOD + production - outflows = EOD.
    const sameDaySeed = invEODByDateStorage.get(`${startDate}|${st.id}`);
    const prevDaySeed = invEODByDateStorage.get(`${yesterday}|${st.id}`);
    const seed = sameDaySeed ?? prevDaySeed;
    bodByStorageDate.set(`${startDate}|${st.id}`, seed ? +seed.qtyStn : 0);
  });


  const productColorFor = (pid)=> {
    const base = ['#dbeafe','#fef3c7','#dcfce7','#fce7f3','#ede9fe','#cffafe','#fee2e2','#e2e8f0'];
    let h=0; const s0=(pid||''); for(let i=0;i<s0.length;i++) h = (h*31 + s0.charCodeAt(i))>>>0;
    return base[h % base.length];
  };
  const setEqMeta = (date, eqId) => {
    const actualRows = ds.actuals.production.filter(r=>r.facilityId===fac && r.date===date && r.equipmentId===eqId && (+r.qtyStn||0)!==0);
    if(actualRows.length){
      const total = actualRows.reduce((a,b)=>a + (+b.qtyStn||0),0);
      const dom = [...actualRows].sort((a,b)=>(+b.qtyStn||0)-(+a.qtyStn||0))[0];
      const cmeta = eqConstraintMeta.get(`${date}|${eqId}`) || null;
      eqCellMeta.set(`${date}|${eqId}`, { source:'actual', status:'produce', productId:dom?.productId||'', totalQty:total, multiProduct:actualRows.length>1, color:productColorFor(dom?.productId||''), constraint:cmeta });
      return;
    }
    const camp = ds.campaigns.find(c=>c.facilityId===fac && c.date===date && c.equipmentId===eqId);
    if(camp){
      const st = camp.status || ((camp.productId && (+camp.rateStn||0)>0)?'produce':'idle');
      const cmeta = eqConstraintMeta.get(`${date}|${eqId}`) || null;
      eqCellMeta.set(`${date}|${eqId}`, { source:'plan', status:st, productId:camp.productId||'', totalQty:+camp.rateStn||0, color: st==='produce' ? productColorFor(camp.productId||'') : '', constraint:cmeta });
      return;
    }
    const cmeta = eqConstraintMeta.get(`${date}|${eqId}`) || null;
    eqCellMeta.set(`${date}|${eqId}`, { source:'none', status:'idle', productId:'', totalQty:0, color:'', constraint:cmeta });
  };

  dates.forEach((date, idx)=>{
    if(idx>0){
      const prev = dates[idx-1];
      storages.forEach(st=> bodByStorageDate.set(`${date}|${st.id}`, eodByStorageDate.get(`${prev}|${st.id}`) ?? 0));
    }

    const delta = new Map();
    const addDelta = (storageId, q)=> delta.set(storageId, (delta.get(storageId)||0) + q);

    let kilnTotal = 0;
    let fmTotal = 0;
    let clkDerived = 0;

    // Shipments first (finished products) to create same-day headroom for cement inventory constraints
    const shipmentByProduct = new Map();
    s.finishedProducts.forEach(fp=>{
      const q = +s.demandForDateProduct(date, fp.id) || 0;
      shipByProductDate.set(`${date}|${fp.id}`, q);
      shipmentByProduct.set(fp.id, q);
      if(q){ const st = findStorageForProduct(fp.id); if(st) addDelta(st.id, -q); }
    });

    // Requested production rows from actuals/campaigns
    const kilnReqLines = [];
    kilns.forEach(eq=>{
      s.getCapsForEquipment(eq.id).forEach(cap=>{
        const qty = getEqProd(date, eq.id, cap.productId);
        if(!qty) return;
        kilnReqLines.push({ eqId:eq.id, productId:cap.productId, reqQty:+qty||0, outSt: findStorageForProduct(cap.productId) });
      });
    });

    const fmReqLines = [];
    fms.forEach(eq=>{
      s.getCapsForEquipment(eq.id).forEach(cap=>{
        const reqQty = getEqProd(date, eq.id, cap.productId);
        if(!reqQty) return;
        const recipe = s.getRecipeForProduct(cap.productId);
        let clkFactor = 0;
        if(recipe){
          recipe.components.forEach(c=>{ if(familyOfProduct(s,c.materialId)==='CLINKER') clkFactor += (+c.pct||0)/100; });
        }
        const outSt = findStorageForProduct(cap.productId);
        const bodCem = outSt ? (+bodByStorageDate.get(`${date}|${outSt.id}`)||0) : 0;
        const shipCem = +(shipmentByProduct.get(cap.productId)||0);
        const maxCap = Number(outSt?.maxCapacityStn);
        const headroom = (Number.isFinite(maxCap) && maxCap>0) ? Math.max(0, maxCap - (bodCem - shipCem)) : Infinity;
        const expShip = expectedShipForProduct(date, cap.productId);
        const daysCover = expShip>0 ? (Math.max(0,bodCem)/expShip) : 99999;
        fmReqLines.push({ eqId:eq.id, productId:cap.productId, reqQty:+reqQty||0, recipe, clkFactor, outSt, headroom, expShip, daysCover });
      });
    });

    // Allocate FM production under clinker scarcity using urgency (lower days cover first)
    const totalClkBod = storages.filter(st=>familyOfProduct(s,(st.allowedProductIds||[])[0])==='CLINKER')
      .reduce((acc,st)=> acc + (+bodByStorageDate.get(`${date}|${st.id}`)||0), 0);
    const totalKilnReq = kilnReqLines.reduce((a,l)=>a+(+l.reqQty||0),0);
    let remainingClkForFM = totalClkBod + totalKilnReq; // daily granularity approximation; kiln may refill same day

    fmReqLines.sort((a,b)=>{
      if((a.daysCover||99999)!==(b.daysCover||99999)) return (a.daysCover||99999)-(b.daysCover||99999);
      if((b.expShip||0)!==(a.expShip||0)) return (b.expShip||0)-(a.expShip||0);
      return String(a.eqId).localeCompare(String(b.eqId));
    });

    const fmUsedByEq = new Map();
    for(const line of fmReqLines){
      const {eqId, productId, reqQty, outSt, recipe, clkFactor} = line;
      const maxByStorage = line.headroom;
      let maxByClk = Infinity;
      if(clkFactor>0){
        maxByClk = Math.max(0, remainingClkForFM / clkFactor);
      }
      const usedQty = Math.max(0, Math.min(reqQty, maxByStorage, maxByClk));
      if(usedQty < reqQty - 1e-6){
        const reasons = [];
        if(maxByStorage < reqQty - 1e-6) reasons.push('cement silo capacity');
        if(maxByClk < reqQty - 1e-6) reasons.push(`clinker scarcity (${(line.daysCover||0).toFixed(1)} d cover priority)`);
        eqConstraintMeta.set(`${date}|${eqId}`, { type:'capped', reason: reasons.join(' + ') || 'constraint', requested:reqQty, used:usedQty });
      }
      if(usedQty<=0){ prodByEqDate.set(`${date}|${eqId}`, prodByEqDate.get(`${date}|${eqId}`)||0); continue; }
      fmUsedByEq.set(eqId, (fmUsedByEq.get(eqId)||0) + usedQty);
      fmTotal += usedQty;
      if(outSt) addDelta(outSt.id, usedQty);
      if(recipe){
        recipe.components.forEach(c=>{
          const compQty = usedQty * (+c.pct||0) / 100;
          const compSt = findStorageForProduct(c.materialId);
          if(compSt) addDelta(compSt.id, -compQty);
          if(familyOfProduct(s, c.materialId)==='CLINKER'){
            clkDerived += compQty;
            remainingClkForFM = Math.max(0, remainingClkForFM - compQty);
          }
        });
      }
    }
    fms.forEach(eq=> prodByEqDate.set(`${date}|${eq.id}`, fmUsedByEq.get(eq.id)||0));

    // Kiln production after FM consumption, cap by clinker storage headroom
    const kilnUsedByEq = new Map();
    for(const line of kilnReqLines){
      const {eqId, productId, reqQty, outSt} = line;
      let usedQty = reqQty;
      if(outSt){
        const maxCap = Number(outSt.maxCapacityStn);
        if(Number.isFinite(maxCap) && maxCap>0){
          const bod = +bodByStorageDate.get(`${date}|${outSt.id}`) || 0;
          const currentDelta = +delta.get(outSt.id) || 0; // includes FM clinker consumption and prior kiln additions
          const headroom = Math.max(0, maxCap - (bod + currentDelta));
          usedQty = Math.min(reqQty, headroom);
          if(usedQty < reqQty - 1e-6){
            const prev = eqConstraintMeta.get(`${date}|${eqId}`);
            const reason = 'clinker storage max capacity';
            eqConstraintMeta.set(`${date}|${eqId}`, { type:'capped', reason: prev ? `${prev.reason} + ${reason}` : reason, requested:reqQty, used:usedQty });
          }
        }
      }
      if(usedQty<=0){ kilnUsedByEq.set(eqId, (kilnUsedByEq.get(eqId)||0)); continue; }
      kilnUsedByEq.set(eqId, (kilnUsedByEq.get(eqId)||0) + usedQty);
      kilnTotal += usedQty;
      if(outSt) addDelta(outSt.id, usedQty);
    }
    kilns.forEach(eq=> prodByEqDate.set(`${date}|${eq.id}`, kilnUsedByEq.get(eq.id)||0));
    [...kilns,...fms].forEach(eq=> setEqMeta(date, eq.id));

    derivedClkUseByDate.set(date, clkDerived);
    kilnProdByDate.set(date, kilnTotal);
    fmProdByDate.set(date, fmTotal);

    storages.forEach(st=>{
      const bod = bodByStorageDate.get(`${date}|${st.id}`) ?? 0;
      const calc = bod + (delta.get(st.id)||0);
      // Do not override EOD with manual inventory rows in v1 testing mode.
      // Daily Actuals inventory is currently used as the day's starting inventory seed.
      eodByStorageDate.set(`${date}|${st.id}`, calc);
      const maxCap = Number(st.maxCapacityStn);
      let severity = '';
      let reason = '';
      let warn = '';
      if(Number.isFinite(maxCap) && maxCap>0 && calc >= 0.75*maxCap) warn = 'high75';
      if(Number.isFinite(maxCap) && maxCap>0 && calc > maxCap){
        severity = 'full';
        reason = `EOD ${calc.toFixed(1)} > max ${maxCap.toFixed(1)}`;
      } else if (calc < 0){
        severity = 'stockout';
        reason = `EOD ${calc.toFixed(1)} < 0`;
      }
      if(severity || warn){
        inventoryCellMeta.set(`${date}|${st.id}`, { severity, warn, eod: calc, maxCap: Number.isFinite(maxCap)?maxCap:null, storageId: st.id, storageName: st.name, reason });
        const arr = alertsByDate.get(date) || [];
        arr.push({ severity, storageId: st.id, storageName: st.name, reason });
        alertsByDate.set(date, arr);
      }
    });
  });

  const visibleStorages = storages.filter(st=>{
    const pid = (st.allowedProductIds||[])[0];
    const fam = familyOfProduct(s, pid);
    return fam==='CLINKER' || fam==='CEMENT';
  });
  const storageFamily = st => familyOfProduct(s, (st.allowedProductIds||[])[0]);

  const mkValues = (getter)=> Object.fromEntries(dates.map(d=>[d, getter(d)]));

  // Inventory rows split BOD / EOD with family subtotals
  const inventoryBODRows = [];
  const inventoryEODRows = [];
  ['CLINKER','CEMENT'].forEach(group=>{
    const rows = visibleStorages.filter(st=>storageFamily(st)===group);
    const label = `${group} INVENTORY`;
    inventoryBODRows.push({kind:'subtotal', label, values: mkValues(d=> rows.reduce((s0,st)=>s0 + (+bodByStorageDate.get(`${d}|${st.id}`)||0),0))});
    rows.forEach(st=> inventoryBODRows.push({kind:'row', storageId: st.id, label: st.name, productLabel: (st.allowedProductIds||[]).map(pid=>s.getMaterial(pid)?.name).filter(Boolean).join(' / '), values: mkValues(d=> +bodByStorageDate.get(`${d}|${st.id}`)||0)}));

    inventoryEODRows.push({kind:'subtotal', label, values: mkValues(d=> rows.reduce((s0,st)=>s0 + (+eodByStorageDate.get(`${d}|${st.id}`)||0),0))});
    rows.forEach(st=> inventoryEODRows.push({kind:'row', storageId: st.id, label: st.name, productLabel: (st.allowedProductIds||[]).map(pid=>s.getMaterial(pid)?.name).filter(Boolean).join(' / '), values: mkValues(d=> +eodByStorageDate.get(`${d}|${st.id}`)||0)}));
  });

  const productionRows = [];
  productionRows.push({kind:'subtotal', label:'CLINKER PRODUCTION', values: mkValues(d=>kilnProdByDate.get(d)||0)});
  kilns.forEach(k=> productionRows.push({kind:'row', rowType:'equipment', equipmentId:k.id, label:k.name, values: mkValues(d=>prodByEqDate.get(`${d}|${k.id}`)||0)}));
  productionRows.push({kind:'subtotal', label:'FINISH MILL PRODUCTION', values: mkValues(d=>fmProdByDate.get(d)||0)});
  fms.forEach(f=> productionRows.push({kind:'row', rowType:'equipment', equipmentId:f.id, label:f.name, values: mkValues(d=>prodByEqDate.get(`${d}|${f.id}`)||0)}));

  const outflowRows = [];
  outflowRows.push({kind:'group', label:'CUSTOMER SHIPMENTS'});
  s.finishedProducts.forEach(fp=> outflowRows.push({kind:'row', label:`MIA / SHIP / CEM / ${fp.name.replace(/^.*\/ /,'')}`.replace(/^MIA \/ SHIP \/ CEM \/ /,'').includes('MIA /')?fp.name:fp.name, productLabel: fp.name, values: mkValues(d=>shipByProductDate.get(`${d}|${fp.id}`)||0)}));
  outflowRows.push({kind:'group', label:'INTERNAL CONSUMPTION (DERIVED)'});
  outflowRows.push({kind:'subtotal', label:'CLK CONSUMED BY FINISH MILLS', values: mkValues(d=>derivedClkUseByDate.get(d)||0)});

  const alertSummary = Object.fromEntries(dates.map(d=>[d, (alertsByDate.get(d)||[])]));
  return { dates, productionRows, inventoryBODRows, outflowRows, inventoryEODRows, equipmentCellMeta: Object.fromEntries([...eqCellMeta.entries()]), inventoryCellMeta: Object.fromEntries([...inventoryCellMeta.entries()]), alertSummary, debug:{bodByStorageDate,eodByStorageDate} };
}

export function yesterdayLocal(){
  const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10);
}
