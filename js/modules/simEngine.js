// ─────────────────────────────────────────────────────────────────────────────
// simEngine.js  —  Roll Panner · Production Plan Simulation
// Version: 3
//
// Key changes from v2:
//   1. Multi-facility — loops over ALL facilities in scope, each gets its own
//      row block. The caller (renderPlan) stitches them into one table.
//   2. BOD physical override — every day of the simulation checks whether a
//      physical count exists for that storage+date. If yes, it replaces the
//      calculated carry-forward (EOD(D-1)). This is the correct behaviour for
//      "plant team walked the silos and measured 9,850t, not the 10,200t we
//      calculated yesterday."
//   3. Transfers — plant-to-plant movements reduce inventory at the source
//      facility and increase inventory at the destination facility. Processed
//      AFTER production and BEFORE EOD calculation so the delta is correct.
// ─────────────────────────────────────────────────────────────────────────────

import { selectors, Categories } from './dataAuthority.js';

const fmtDate = d => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmtDate(d);
};

export const startOfMonth = dateStr => `${dateStr.slice(0, 7)}-01`;
export const yesterdayLocal = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return fmtDate(d);
};

// ─────────────────────────────────────────────────────────────────────────────
// Classify a product into its simulation family
// CLINKER  — intermediate product consumed by finish mills
// CEMENT   — finished product shipped to customers
// FUEL / RAW — consumed as inputs, not tracked in silo inventory (future)
// ─────────────────────────────────────────────────────────────────────────────

function familyOfProduct(s, pid) {
  const m = s.getMaterial(pid);
  if (!m) return 'OTHER';
  // Use familyId if available (v3 catalog)
  if (m.familyId) {
    const fam = s.getFamily(m.familyId);
    if (fam) {
      if (fam.code === 'CLNK') return 'CLINKER';
      if (['CEM', 'WHT', 'ASH', 'SLAG'].includes(fam.code)) return 'CEMENT';
      if (fam.code === 'FUEL') return 'FUEL';
      if (fam.code === 'RAW')  return 'RAW';
    }
  }
  // Fallback to category (v2 compat)
  if (m.category === Categories.INT)  return 'CLINKER';
  if (m.category === Categories.FIN)  return 'CEMENT';
  if (m.category === Categories.FUEL) return 'FUEL';
  if (m.category === Categories.RAW)  return 'RAW';
  return 'OTHER';
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE-FACILITY SIMULATION
//
// Returns row data + cell metadata for one facility over the given date range.
// Called once per facility in scope, results merged by buildProductionPlanView.
// ─────────────────────────────────────────────────────────────────────────────

function simulateFacility(state, s, ds, facId, dates) {
  const storages = ds.storages.filter(st => st.facilityId === facId);
  const kilns    = ds.equipment.filter(e  => e.facilityId === facId && e.type === 'kiln');
  const fms      = ds.equipment.filter(e  => e.facilityId === facId && e.type === 'finish_mill');
  const allEquip = [...kilns, ...fms];

  // ── Pre-index actuals for O(1) lookup ──
  const invBODIndex = new Map();   // `date|storageId` → qtyStn  (physical count)
  ds.actuals.inventoryBOD
    .filter(r => r.facilityId === facId)
    .forEach(r => invBODIndex.set(`${r.date}|${r.storageId}`, +r.qtyStn));

  const actualProdIndex = new Map(); // `date|eqId|productId` → qtyStn
  ds.actuals.production
    .filter(r => r.facilityId === facId)
    .forEach(r => actualProdIndex.set(`${r.date}|${r.equipmentId}|${r.productId}`, +r.qtyStn));

  // Transfer index: `date|storageId` → net delta (positive = in, negative = out)
  // Transfers reference products, not storages, so we resolve to storage below.
  const storageByProduct = new Map();
  storages.forEach(st =>
    (st.allowedProductIds || []).forEach(pid => {
      if (!storageByProduct.has(pid)) storageByProduct.set(pid, st);
    })
  );
  const findStorageForProduct = pid => storageByProduct.get(pid);

  const transferDeltaIndex = new Map(); // `date|storageId` → net delta
  ds.actuals.transfers.forEach(r => {
    if (r.productId) {
      const st = findStorageForProduct(r.productId);
      if (!st) return;
      // Only apply if this storage belongs to this facility
      if (st.facilityId !== facId) return;
      const key   = `${r.date}|${st.id}`;
      const delta = r.fromFacilityId === facId ? -(+r.qtyStn || 0) : +(+r.qtyStn || 0);
      transferDeltaIndex.set(key, (transferDeltaIndex.get(key) || 0) + delta);
    }
  });

  // ── Pre-index campaigns for O(1) lookup ──
  const campaignIndex = new Map(); // `date|eqId|pid` → camp, `date|eqId` → status camp
  ds.campaigns
    .filter(c => c.facilityId === facId)
    .forEach(c => {
      // Index by date|eqId|productId for production lookup
      if (c.productId) campaignIndex.set(`${c.date}|${c.equipmentId}|${c.productId}`, c);
      // Index by date|eqId for status lookup (maintenance, idle, etc.)
      campaignIndex.set(`${c.date}|${c.equipmentId}`, c);
    });

  // ── Pre-index demandForecast for O(1) lookup ──
  const forecastIndex = new Map(); // `date|pid` → total qty
  ds.demandForecast
    .filter(r => r.facilityId === facId)
    .forEach(r => {
      const k = `${r.date}|${r.productId}`;
      forecastIndex.set(k, (forecastIndex.get(k) || 0) + (+r.qtyStn || 0));
    });

  // ── Pre-index actuals shipments for O(1) rolling avg ──
  const shipmentIndex = new Map(); // `date|pid` → total qty
  ds.actuals.shipments
    .filter(r => r.facilityId === facId)
    .forEach(r => {
      const k = `${r.date}|${r.productId}`;
      shipmentIndex.set(k, (shipmentIndex.get(k) || 0) + (+r.qtyStn || 0));
    });

  // ── Demand lookup: stored data only (actuals → forecast → 0) ──
  // Rolling average / auto-forecast runs only via the Forecast Tool, never automatically.
  const expectedShip = (date, pid) => {
    // 1. Confirmed actual shipment takes precedence
    const actualQ = shipmentIndex.get(`${date}|${pid}`) || 0;
    if (actualQ > 0) return actualQ;
    // 2. Saved forecast entry
    return forecastIndex.get(`${date}|${pid}`) || 0;
    // Note: no rolling-average fallback — use Forecast Tool to generate future values
  };

  const getEqProd = (date, eqId, pid) => {
    const actual = actualProdIndex.get(`${date}|${eqId}|${pid}`);
    if (actual != null) return actual;
    const camp = campaignIndex.get(`${date}|${eqId}|${pid}`);
    return (camp && (camp.status || 'produce') === 'produce') ? (camp.rateStn ?? 0) : 0;
  };

  // ── Output maps ──
  const bodMap          = new Map();  // `date|storageId` → qty
  const eodMap          = new Map();  // `date|storageId` → qty
  const shipMap         = new Map();  // `date|productId` → qty
  const kilnProdMap     = new Map();  // date → total
  const fmProdMap       = new Map();  // date → total
  const clkConsumedMap  = new Map();  // date → total clinker consumed by FMs
  const prodByEqMap     = new Map();  // `date|eqId` → qty
  const eqCellMeta      = new Map();  // `date|eqId` → { source, status, productId, ... }
  const eqConstraintMeta= new Map();  // `date|eqId` → { type, reason, ... }
  const invCellMeta     = new Map();  // `date|storageId` → { severity, warn, eod, ... }
  const alertsByDate    = new Map();  // date → alert[]

  // ────────────────────────────────────────────────────────────────────────
  // Seed BOD for day 0 — use physical count if available, else 0
  // ────────────────────────────────────────────────────────────────────────
  const startDate = dates[0];
  const prevDate0 = addDays(startDate, -1);

  storages.forEach(st => {
    // Look for a physical count on the start date itself first
    const countToday = invBODIndex.get(`${startDate}|${st.id}`);
    // Then yesterday's EOD (which might also be a physical count from a prior run)
    const countYest  = invBODIndex.get(`${prevDate0}|${st.id}`);
    bodMap.set(`${startDate}|${st.id}`, countToday ?? countYest ?? 0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // MAIN DATE LOOP
  // ────────────────────────────────────────────────────────────────────────

  dates.forEach((date, idx) => {

    // ── Carry forward BOD from previous EOD, then check for physical override ──
    if (idx > 0) {
      const prev = dates[idx - 1];
      storages.forEach(st => {
        const physicalCount = invBODIndex.get(`${date}|${st.id}`);
        if (physicalCount != null) {
          // Physical count overrides calculated carry-forward
          bodMap.set(`${date}|${st.id}`, physicalCount);
        } else {
          // No measurement today — use yesterday's calculated EOD
          bodMap.set(`${date}|${st.id}`, eodMap.get(`${prev}|${st.id}`) ?? 0);
        }
      });
    }

    const delta = new Map(); // storageId → net delta for this date
    const addDelta = (storageId, q) => delta.set(storageId, (delta.get(storageId) || 0) + q);

    let kilnTotal   = 0;
    let fmTotal     = 0;
    let clkDerived  = 0;

    // ── Step 1: Outbound shipments (demand) ──
    // Apply demand first so cement silo headroom calculation in FM allocation
    // correctly accounts for product that will leave today.
    const finishedProds = s.materials.filter(m => m.category === Categories.FIN && (ds.facilityProducts || []).some(fp => fp.facilityId === facId && fp.productId === m.id) || s.getFacilityProducts(facId).some(fp => fp.id === m.id));
    // Use all finished products that this facility has activated
    const facFinished = s.getFacilityProducts(facId).filter(m => m.category === Categories.FIN);

    const shipByPid = new Map();
    facFinished.forEach(fp => {
      const q = expectedShip(date, fp.id);
      shipMap.set(`${date}|${fp.id}`, q);
      shipByPid.set(fp.id, q);
      if (q) {
        const st = findStorageForProduct(fp.id);
        if (st) addDelta(st.id, -q);
      }
    });

    // ── Step 2: FM production (clinker-constrained) ──
    const fmReqLines = [];
    fms.forEach(eq => {
      s.getCapsForEquipment(eq.id).forEach(cap => {
        const reqQty = getEqProd(date, eq.id, cap.productId);
        if (!reqQty) return;
        const recipe    = s.getRecipeForProduct(cap.productId);
        let clkFactor   = 0;
        if (recipe) {
          recipe.components.forEach(c => {
            if (familyOfProduct(s, c.materialId) === 'CLINKER') clkFactor += (+c.pct || 0) / 100;
          });
        }
        const outSt    = findStorageForProduct(cap.productId);
        const bodCem   = outSt ? (bodMap.get(`${date}|${outSt.id}`) || 0) : 0;
        const shipCem  = shipByPid.get(cap.productId) || 0;
        const maxCap   = Number(outSt?.maxCapacityStn);
        const headroom = (Number.isFinite(maxCap) && maxCap > 0)
          ? Math.max(0, maxCap - (bodCem - shipCem))
          : Infinity;
        const expS     = expectedShip(date, cap.productId);
        const daysCover = expS > 0 ? Math.max(0, bodCem) / expS : 99999;
        fmReqLines.push({ eqId: eq.id, productId: cap.productId, reqQty: +reqQty, recipe, clkFactor, outSt, headroom, expShip: expS, daysCover });
      });
    });

    // Total available clinker = BOD across all clinker storages + today's kiln req
    const kilnReqLines = [];
    kilns.forEach(eq => {
      s.getCapsForEquipment(eq.id).forEach(cap => {
        const qty = getEqProd(date, eq.id, cap.productId);
        if (!qty) return;
        kilnReqLines.push({ eqId: eq.id, productId: cap.productId, reqQty: +qty, outSt: findStorageForProduct(cap.productId) });
      });
    });
    const totalClkBod  = storages
      .filter(st => familyOfProduct(s, (st.allowedProductIds || [])[0]) === 'CLINKER')
      .reduce((acc, st) => acc + (bodMap.get(`${date}|${st.id}`) || 0), 0);
    const totalKilnReq = kilnReqLines.reduce((a, l) => a + (+l.reqQty || 0), 0);
    let remainingClk   = totalClkBod + totalKilnReq;

    // Sort FMs by urgency (lowest days of cover first)
    fmReqLines.sort((a, b) => {
      if ((a.daysCover || 99999) !== (b.daysCover || 99999)) return (a.daysCover || 99999) - (b.daysCover || 99999);
      if ((b.expShip || 0) !== (a.expShip || 0)) return (b.expShip || 0) - (a.expShip || 0);
      return String(a.eqId).localeCompare(String(b.eqId));
    });

    const fmUsed = new Map();
    for (const line of fmReqLines) {
      const { eqId, productId, reqQty, outSt, recipe, clkFactor } = line;
      const maxByClk     = clkFactor > 0 ? Math.max(0, remainingClk / clkFactor) : Infinity;
      const usedQty      = Math.max(0, Math.min(reqQty, line.headroom, maxByClk));

      if (usedQty < reqQty - 1e-6) {
        const reasons = [];
        if (line.headroom < reqQty - 1e-6) reasons.push('cement silo capacity');
        if (maxByClk      < reqQty - 1e-6) reasons.push(`clinker scarcity (${(line.daysCover || 0).toFixed(1)}d cover)`);
        eqConstraintMeta.set(`${date}|${eqId}`, { type: 'capped', reason: reasons.join(' + ') || 'constraint', requested: reqQty, used: usedQty });
      }
      if (usedQty <= 0) { fmUsed.set(eqId, fmUsed.get(eqId) || 0); continue; }

      fmUsed.set(eqId, (fmUsed.get(eqId) || 0) + usedQty);
      fmTotal += usedQty;
      if (outSt) addDelta(outSt.id, usedQty);

      if (recipe) {
        recipe.components.forEach(c => {
          const compQty = usedQty * (+c.pct || 0) / 100;
          const compSt  = findStorageForProduct(c.materialId);
          if (compSt) addDelta(compSt.id, -compQty);
          if (familyOfProduct(s, c.materialId) === 'CLINKER') {
            clkDerived  += compQty;
            remainingClk = Math.max(0, remainingClk - compQty);
          }
        });
      }
    }
    fms.forEach(eq => prodByEqMap.set(`${date}|${eq.id}`, fmUsed.get(eq.id) || 0));

    // ── Step 3: Kiln production (cap by clinker silo headroom) ──
    const kilnUsed = new Map();
    for (const line of kilnReqLines) {
      const { eqId, productId, reqQty, outSt } = line;
      let usedQty = reqQty;
      if (outSt) {
        const maxCap = Number(outSt.maxCapacityStn);
        if (Number.isFinite(maxCap) && maxCap > 0) {
          const bod         = bodMap.get(`${date}|${outSt.id}`) || 0;
          const curDelta    = delta.get(outSt.id) || 0;
          const headroom    = Math.max(0, maxCap - (bod + curDelta));
          usedQty = Math.min(reqQty, headroom);
          if (usedQty < reqQty - 1e-6) {
            const prev   = eqConstraintMeta.get(`${date}|${eqId}`);
            const reason = 'clinker storage max capacity';
            eqConstraintMeta.set(`${date}|${eqId}`, {
              type: 'capped',
              reason: prev ? `${prev.reason} + ${reason}` : reason,
              requested: reqQty, used: usedQty,
            });
          }
        }
      }
      if (usedQty <= 0) { kilnUsed.set(eqId, kilnUsed.get(eqId) || 0); continue; }
      kilnUsed.set(eqId, (kilnUsed.get(eqId) || 0) + usedQty);
      kilnTotal += usedQty;
      if (outSt) addDelta(outSt.id, usedQty);
    }
    kilns.forEach(eq => prodByEqMap.set(`${date}|${eq.id}`, kilnUsed.get(eq.id) || 0));

    // ── Step 4: Transfers IN / OUT ──
    // Already indexed above; apply net delta per storage
    storages.forEach(st => {
      const tDelta = transferDeltaIndex.get(`${date}|${st.id}`);
      if (tDelta) addDelta(st.id, tDelta);
    });

    // ── Step 5: Set equipment cell metadata ──
    allEquip.forEach(eq => {
      const actualRows = ds.actuals.production.filter(r =>
        r.facilityId === facId && r.date === date && r.equipmentId === eq.id && (+r.qtyStn || 0) !== 0
      );
      if (actualRows.length) {
        const total = actualRows.reduce((a, r) => a + (+r.qtyStn || 0), 0);
        const dom   = [...actualRows].sort((a, b) => (+b.qtyStn || 0) - (+a.qtyStn || 0))[0];
        eqCellMeta.set(`${date}|${eq.id}`, {
          source: 'actual', status: 'produce', productId: dom?.productId || '',
          totalQty: total, multiProduct: actualRows.length > 1,
          constraint: eqConstraintMeta.get(`${date}|${eq.id}`) || null,
        });
        return;
      }
      const camp = campaignIndex.get(`${date}|${eq.id}`);
      if (camp) {
        const st = camp.status || ((camp.productId && (+camp.rateStn || 0) > 0) ? 'produce' : 'idle');
        eqCellMeta.set(`${date}|${eq.id}`, {
          source: 'plan', status: st, productId: camp.productId || '',
          totalQty: +camp.rateStn || 0,
          constraint: eqConstraintMeta.get(`${date}|${eq.id}`) || null,
        });
        return;
      }
      eqCellMeta.set(`${date}|${eq.id}`, {
        source: 'none', status: 'idle', productId: '', totalQty: 0,
        constraint: eqConstraintMeta.get(`${date}|${eq.id}`) || null,
      });
    });

    kilnProdMap.set(date, kilnTotal);
    fmProdMap.set(date, fmTotal);
    clkConsumedMap.set(date, clkDerived);

    // ── Step 6: EOD calculation + alert tagging ──
    storages.forEach(st => {
      const bod  = bodMap.get(`${date}|${st.id}`) ?? 0;
      const eod  = bod + (delta.get(st.id) || 0);
      eodMap.set(`${date}|${st.id}`, eod);

      const maxCap = Number(st.maxCapacityStn);
      let severity = '';
      let warn     = '';
      let reason   = '';

      if (Number.isFinite(maxCap) && maxCap > 0 && eod >= 0.75 * maxCap) warn = 'high75';
      if (Number.isFinite(maxCap) && maxCap > 0 && eod > maxCap) {
        severity = 'full';
        reason   = `EOD ${eod.toFixed(1)} > max ${maxCap.toFixed(1)}`;
      } else if (eod < 0) {
        severity = 'stockout';
        reason   = `EOD ${eod.toFixed(1)} < 0`;
      }

      if (severity || warn) {
        invCellMeta.set(`${date}|${st.id}`, {
          severity, warn, eod, bod,
          maxCap:      Number.isFinite(maxCap) ? maxCap : null,
          storageId:   st.id,
          storageName: st.name,
          reason,
          facilityId:  facId,
        });
        const arr = alertsByDate.get(date) || [];
        arr.push({ severity, storageId: st.id, storageName: st.name, reason, facilityId: facId });
        alertsByDate.set(date, arr);
      }
    });
  }); // end date loop

  // ── Build row objects ──
  const mkValues = getter => Object.fromEntries(dates.map(d => [d, getter(d)]));

  // Build set of product IDs activated for this specific facility
  const activatedProductIds = new Set(
    (ds.facilityProducts || [])
      .filter(fp => fp.facilityId === facId)
      .map(fp => fp.productId)
  );
  // A storage is visible only if:
  //   (a) its product family is CLINKER or CEMENT, AND
  //   (b) at least one of its allowed products is activated for this facility
  //       (or no facilityProducts entries exist at all — legacy fallback)
  const hasActivation = activatedProductIds.size > 0;
  const visibleStorages = storages.filter(st => {
    const fam = familyOfProduct(s, (st.allowedProductIds || [])[0]);
    if (fam !== 'CLINKER' && fam !== 'CEMENT') return false;
    if (!hasActivation) return true; // legacy: no facilityProducts configured, show all
    return (st.allowedProductIds || []).some(pid => activatedProductIds.has(pid));
  });
  const storageFamily = st => familyOfProduct(s, (st.allowedProductIds || [])[0]);

  // BOD rows — only emit sections that have at least one storage at this facility
  const inventoryBODRows = [];
  ['CLINKER', 'CEMENT'].forEach(group => {
    const rows = visibleStorages.filter(st => storageFamily(st) === group);
    if (rows.length === 0) return; // facility has nothing of this type — skip entirely
    inventoryBODRows.push({
      kind: 'subtotal', label: `${group} INV-BOD`,
      values: mkValues(d => rows.reduce((sum, st) => sum + (bodMap.get(`${d}|${st.id}`) || 0), 0)),
    });
    rows.forEach(st => inventoryBODRows.push({
      kind: 'row', storageId: st.id,
      label: st.name,
      productLabel: (st.allowedProductIds || []).map(pid => s.getMaterial(pid)?.name).filter(Boolean).join(' / '),
      values: mkValues(d => bodMap.get(`${d}|${st.id}`) || 0),
    }));
  });

  // Production rows
  const productionRows = [];
  productionRows.push({ kind: 'subtotal', label: 'CLINKER PRODUCTION', values: mkValues(d => kilnProdMap.get(d) || 0) });
  kilns.forEach(k => productionRows.push({
    kind: 'row', rowType: 'equipment', equipmentId: k.id, label: k.name,
    values: mkValues(d => prodByEqMap.get(`${d}|${k.id}`) || 0),
  }));
  productionRows.push({ kind: 'subtotal', label: 'FINISH MILL PRODUCTION', values: mkValues(d => fmProdMap.get(d) || 0) });
  fms.forEach(f => productionRows.push({
    kind: 'row', rowType: 'equipment', equipmentId: f.id, label: f.name,
    values: mkValues(d => prodByEqMap.get(`${d}|${f.id}`) || 0),
  }));

  // Outflow rows
  // Use activatedProductIds (already built above) so terminals only show
  // products they actually have configured — not the entire regional catalog.
  // getFacilityProducts falls back to the full catalog when no facilityProducts
  // entries exist, which causes every product to appear on every facility.
  const facFinished = activatedProductIds.size > 0
    ? state.catalog.filter(m => activatedProductIds.has(m.id) && m.category === Categories.FIN)
    : s.getFacilityProducts(facId).filter(m => m.category === Categories.FIN);

  const outflowRows = [];
  outflowRows.push({ kind: 'group', label: 'CUSTOMER SHIPMENTS' });
  facFinished.forEach(fp => outflowRows.push({
    kind: 'row', label: fp.name, productLabel: fp.name,
    values: mkValues(d => shipMap.get(`${d}|${fp.id}`) || 0),
  }));
  outflowRows.push({ kind: 'group', label: 'TRANSFERS OUT' });
  const transferProducts = [...new Set(
    ds.actuals.transfers
      .filter(r => r.fromFacilityId === facId)
      .map(r => r.productId)
  )];
  if (transferProducts.length) {
    transferProducts.forEach(pid => {
      const mat = s.getMaterial(pid);
      outflowRows.push({
        kind: 'row', label: `→ ${mat?.name || pid}`,
        values: mkValues(d =>
          ds.actuals.transfers
            .filter(r => r.fromFacilityId === facId && r.date === d && r.productId === pid)
            .reduce((sum, r) => sum + (+r.qtyStn || 0), 0)
        ),
      });
    });
  } else {
    outflowRows.push({ kind: 'placeholder', label: 'No transfers recorded' });
  }
  outflowRows.push({ kind: 'group', label: 'TRANSFERS IN' });
  const transferInProducts = [...new Set(
    ds.actuals.transfers
      .filter(r => r.toFacilityId === facId)
      .map(r => r.productId)
  )];
  if (transferInProducts.length) {
    transferInProducts.forEach(pid => {
      const mat = s.getMaterial(pid);
      outflowRows.push({
        kind: 'row', label: `← ${mat?.name || pid}`,
        values: mkValues(d =>
          ds.actuals.transfers
            .filter(r => r.toFacilityId === facId && r.date === d && r.productId === pid)
            .reduce((sum, r) => sum + (+r.qtyStn || 0), 0)
        ),
      });
    });
  } else {
    outflowRows.push({ kind: 'placeholder', label: 'No transfers recorded' });
  }
  outflowRows.push({ kind: 'subtotal', label: 'CLK CONSUMED BY MILLS', values: mkValues(d => clkConsumedMap.get(d) || 0) });

  // EOD rows — only emit sections that have at least one storage at this facility
  const inventoryEODRows = [];
  ['CLINKER', 'CEMENT'].forEach(group => {
    const rows = visibleStorages.filter(st => storageFamily(st) === group);
    if (rows.length === 0) return; // skip empty sections
    inventoryEODRows.push({
      kind: 'subtotal', label: `${group} INV-EOD`,
      values: mkValues(d => rows.reduce((sum, st) => sum + (eodMap.get(`${d}|${st.id}`) || 0), 0)),
    });
    rows.forEach(st => inventoryEODRows.push({
      kind: 'row', storageId: st.id,
      label: st.name,
      productLabel: (st.allowedProductIds || []).map(pid => s.getMaterial(pid)?.name).filter(Boolean).join(' / '),
      values: mkValues(d => eodMap.get(`${d}|${st.id}`) || 0),
    }));
  });

  return {
    facId,
    inventoryBODRows,
    productionRows,
    outflowRows,
    inventoryEODRows,
    kilns,
    fms,
    eqCellMeta,
    invCellMeta,
    alertsByDate,
    bodMap,
    eodMap,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINT
//
// Runs simulation for ALL facilities in scope and merges results.
// The return shape is compatible with v2 renderPlan except:
//   - rows now include a `_facilityId` tag and facility header rows
//   - equipmentCellMeta / inventoryCellMeta are keyed `date|id` as before
//     (equipment IDs are already globally unique per facility code prefix)
// ─────────────────────────────────────────────────────────────────────────────

export function buildProductionPlanView(state, startDate, days = 35) {
  const s   = selectors(state);
  const ds  = s.dataset;

  // Resolve facilities in scope — fall back to all facilities if none selected
  const facIds = s.facilityIds.length
    ? s.facilityIds
    : state.org.facilities.map(f => f.id);

  const dates = Array.from({ length: days }, (_, i) => addDays(startDate, i));

  // ── Run simulation per facility ──
  const facResults = facIds.map(facId => simulateFacility(state, s, ds, facId, dates));

  // ── Merge equipment + inventory cell metadata (globally keyed by date|id) ──
  const equipmentCellMeta  = {};
  const inventoryCellMeta  = {};
  const alertSummary       = {};

  facResults.forEach(fr => {
    fr.eqCellMeta.forEach((v, k)  => { equipmentCellMeta[k]  = v; });
    fr.invCellMeta.forEach((v, k) => { inventoryCellMeta[k]  = v; });
    fr.alertsByDate.forEach((arr, date) => {
      alertSummary[date] = [...(alertSummary[date] || []), ...arr];
    });
  });

  // ── Build unified row list ──
  // Multi-facility: wrap each facility's rows in a facility header block
  // Single facility: no header needed (same as v2 behaviour)
  const isMulti = facIds.length > 1;

  const SECTIONS = ['bod', 'prod', 'out', 'eod'];
  const sectionLabel = { bod: 'INV-BOD [STn]', prod: 'PROD [STn/day]', out: 'SHIPMENTS [STn]', eod: 'INV-EOD [STn]' };

  // Grand total rows (sum across all facilities) for multi-facility view
  const grandTotals = {};
  if (isMulti) {
    SECTIONS.forEach(sec => {
      const allRows = facResults.flatMap(fr => {
        const rowSet = sec === 'bod' ? fr.inventoryBODRows
          : sec === 'prod' ? fr.productionRows
          : sec === 'out'  ? fr.outflowRows
          : fr.inventoryEODRows;
        return rowSet.filter(r => r.kind === 'subtotal');
      });
      // Build a combined subtotal per section label
      const combined = {};
      allRows.forEach(r => {
        const lbl = r.label;
        if (!combined[lbl]) combined[lbl] = { kind: 'subtotal', label: `∑ ${lbl}`, values: {} };
        dates.forEach(d => {
          combined[lbl].values[d] = (combined[lbl].values[d] || 0) + (r.values[d] || 0);
        });
      });
      grandTotals[sec] = Object.values(combined);
    });
  }

  // Flatten into unified rows the same way app.js expects
  const unifiedRows = [];

  SECTIONS.forEach(sec => {
    // Section header
    unifiedRows.push({ _type: 'section-header', _secId: sec, label: sectionLabel[sec] });

    // Grand totals (multi-facility only)
    if (isMulti && grandTotals[sec]) {
      grandTotals[sec].forEach(r => {
        unifiedRows.push({ ...r, _type: 'subtotal-header', _secId: sec, _subId: `grand_${sec}_${r.label}`, _isGrand: true });
      });
    }

    // Per-facility blocks
    facResults.forEach(fr => {
      const fac     = state.org.facilities.find(f => f.id === fr.facId);
      const facName = fac?.name || fr.facId;
      const facCode = fac?.code || fr.facId;

      const rowSet = sec === 'bod' ? fr.inventoryBODRows
        : sec === 'prod' ? fr.productionRows
        : sec === 'out'  ? fr.outflowRows
        : fr.inventoryEODRows;

      if (rowSet.length === 0) return;

      // Facility sub-header (only in multi-facility mode)
      if (isMulti) {
        unifiedRows.push({
          _type:       'facility-header',
          _secId:      sec,
          _facilityId: fr.facId,
          label:       `🏭 ${facName}`,
          facCode,
        });
      }

      let currentSubId = null;
      rowSet.forEach(r => {
        if (r.kind === 'group') {
          unifiedRows.push({ _type: 'group-label', _secId: sec, _facilityId: fr.facId, label: r.label });
          currentSubId = null;
          return;
        }
        if (r.kind === 'subtotal') {
          const subId = `sub_${fr.facId}_${sec}_${r.label}`;
          currentSubId = subId;
          unifiedRows.push({ ...r, _type: 'subtotal-header', _secId: sec, _facilityId: fr.facId, _subId: subId });
          return;
        }
        if (r.kind === 'placeholder') {
          unifiedRows.push({ _type: 'placeholder', _secId: sec, _facilityId: fr.facId, label: r.label });
          return;
        }
        // Normal row
        unifiedRows.push({ ...r, _type: 'child', _secId: sec, _facilityId: fr.facId, _subId: currentSubId });
      });
    });
  });

  return {
    dates,
    unifiedRows,
    equipmentCellMeta,
    inventoryCellMeta,
    alertSummary,
    isMultiFacility: isMulti,
    facilityIds:     facIds,
    // Keep these for backward compat with parts of app.js that read them directly
    productionRows:    facResults.flatMap(fr => fr.productionRows),
    inventoryBODRows:  facResults.flatMap(fr => fr.inventoryBODRows),
    outflowRows:       facResults.flatMap(fr => fr.outflowRows),
    inventoryEODRows:  facResults.flatMap(fr => fr.inventoryEODRows),
    // Debug
    _debug: { facResults },
  };
}
