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
      if (fam.code === 'TRANSF') return 'TRANSF';
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
// RULES OF ENGAGEMENT HELPERS — Recipe Version Selection
// Evaluates formal rules at runtime to determine which recipe version to use
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the applicable RoE rule for equipment + product combination
 * Returns rule object if found, null otherwise
 */
function getApplicableRule(logistics, facId, equipmentId, productId) {
  // ✓ SAFETY: Handle missing logistics structure gracefully
  if (!logistics?.rulesOfEngagement) return null;

  return logistics.rulesOfEngagement.find(roe =>
    roe.facilityId === facId &&
    (roe.equipmentId === equipmentId || !roe.equipmentId) &&  // specific or facility-wide
    roe.productId === productId &&
    roe.formalRule
  ) || null;
}

/**
 * Evaluate a formal rule at runtime given current inventory state
 * Returns { recipeVersion, allowedClinkerSources } or null if no matching condition
 */
function evaluateRoERule(formalRule, inventoryState) {
  if (!formalRule || !formalRule.rules) return null;

  // Evaluate each rule in order — return the first one whose condition matches
  for (const rule of formalRule.rules) {
    if (!rule.conditions) {
      // No conditions = always applies
      return { recipeVersion: rule.then?.recipeVersion, allowedClinkerSources: rule.then?.allowedClinkerSources };
    }

    // Evaluate conditions: currently supports clinkerSourceCoverDays
    let conditionsMet = true;
    for (const [condType, condition] of Object.entries(rule.conditions || {})) {
      if (condType === 'clinkerSourceCoverDays') {
        // condition = { operand: "BRS_CLK_K1", operator: ">=", value: 3 }
        const storageId = condition.operand;  // storage name or ID
        const coverDays = inventoryState[storageId] || 0;
        const value = condition.value;
        const op = condition.operator;

        let condMet = false;
        if (op === '>=') condMet = coverDays >= value;
        else if (op === '<=') condMet = coverDays <= value;
        else if (op === '>') condMet = coverDays > value;
        else if (op === '<') condMet = coverDays < value;
        else if (op === '===') condMet = coverDays === value;

        if (!condMet) {
          conditionsMet = false;
          break;
        }
      }
    }

    if (conditionsMet) {
      return { recipeVersion: rule.then?.recipeVersion, allowedClinkerSources: rule.then?.allowedClinkerSources };
    }
  }

  return null;  // No matching rule condition
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
  const loaders  = ds.equipment.filter(e  => e.facilityId === facId && e.type === 'loader');
  const allEquip = [...kilns, ...fms, ...loaders];

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

  // Check if equipment can run based on Rules of Engagement (run/idle constraints)
  const canEquipmentRun = (date, eqId, eqType) => {
    if (typeof RulesOfEngagement === 'undefined') return true; // No rules defined

    const rule = RulesOfEngagement.getRunIdleRule(eqType);
    if (!rule) return true; // No rule for this equipment type

    const stateKey = `${date}|${eqId}`;
    const runState = equipmentRunState.get(stateKey);

    // If equipment is currently idle, check minimum idle duration
    if (runState && runState.status === 'off') {
      if (runState.idleDaysSoFar < rule.minIdleDays) {
        return false; // Still within minimum idle period
      }

      // Check restart condition (inventory buffer)
      if (rule.restartCondition.type === 'inventoryBuffer') {
        const eq = s.equipment.find(e => e.id === eqId);
        if (!eq) return false;

        // Get the relevant storage for this equipment
        const storageForEq = storages.find(st =>
          st.facilityId === s.id &&
          (st.allowedProductIds || []).some(pid => getEqProd(date, eqId, pid) > 0)
        );

        if (storageForEq) {
          const maxCap = storageForEq.maxCapacity || 10000;
          const bod = bodMap.get(`${date}|${storageForEq.id}`) || 0;
          const avgConsumption = equipmentAvgConsumption.get(eqId) || 0;
          const maxProd = getEqProd(date, eqId, Array.from(campaignIndex.keys()).find(k => k.includes(eqId))?.split('|')[2]) || 0;

          // ✓ FIXED: Pass only 4 parameters (fixed 3× buffer in function)
          const canRestart = RulesOfEngagement.canRestartBasedOnBuffer(
            maxCap, bod, avgConsumption, maxProd
          );

          // ✓ DIAGNOSTIC: Log restart buffer calculation with both conditions DETAILED
          if (facId === 'BRS' && (eqId.includes('BRSKL') || eqId.includes('FM'))) {
            const headroom = maxCap - bod;
            const requiredHeadroom = 2 * maxProd; // 2-day safety buffer
            const netChange = maxProd - avgConsumption;

            let reason = '';
            // Condition 1: Is 10-day avg demand >= production capacity?
            const cond1 = avgConsumption >= maxProd; // Must be >= not >
            reason += cond1 ? '✓C1(Demand≥Prod)' : '✗C1(Demand<Prod)';

            // Condition 2: Is headroom >= 2x max production?
            const cond2 = headroom >= requiredHeadroom;
            reason += cond2 ? ' ✓C2(Buffer≥2xProd)' : ` ✗C2(${headroom.toFixed(0)}<${requiredHeadroom.toFixed(0)})`;

            // Net change: positive = accumulates, negative = drains
            const accumulates = netChange > 0;
            console.log(`[RESTART] ${date} | ${eqId} | Demand=${avgConsumption.toFixed(1)} | Prod=${maxProd.toFixed(1)} | NetChange=${netChange > 0 ? '+' : ''}${netChange.toFixed(1)} (${accumulates ? 'FILL' : 'DRAIN'}) | Headroom=${headroom.toFixed(0)}/${requiredHeadroom.toFixed(0)} | ${reason} | ${canRestart ? '✓ALLOW' : '✗DENY'}`);
          }
          }

          if (!canRestart) {
            return false; // Cannot restart yet, buffer not sufficient
          }
        }
      }
    }

    return true; // Equipment can run
  };

  // ── Output maps ──
  const bodMap          = new Map();  // `date|storageId` → qty
  const eodMap          = new Map();  // `date|storageId` → qty
  const shipMap         = new Map();  // `date|productId` → qty
  const kilnProdMap     = new Map();  // date → total
  const fmProdMap       = new Map();  // date → total
  const clkConsumedMap  = new Map();  // date → total clinker consumed by FMs
  const fm1ConsumedMap  = new Map();  // date → BROSFM01 clinker consumption (BRS only)
  const fm2ConsumedMap  = new Map();  // date → BROSFM02 clinker consumption (BRS only)
  const prodByEqMap     = new Map();  // `date|eqId` → qty
  const eqCellMeta      = new Map();  // `date|eqId` → { source, status, productId, ... }
  const eqConstraintMeta= new Map();  // `date|eqId` → { type, reason, ... }
  const invCellMeta     = new Map();  // `date|storageId` → { severity, warn, eod, ... }
  const alertsByDate    = new Map();  // date → alert[]

  // Equipment run/idle state tracking (Rules of Engagement)
  const equipmentRunState = new Map();  // `date|equipmentId` → { status: 'on'|'off', runDaysSoFar: n, idleDaysSoFar: n, reason: string }
  const equipmentAvgConsumption = new Map();  // `equipmentId` → rolling 10-day average consumption
  const clinkerConsumptionByStoragePerDay = new Map();  // `date|storageId` → qty consumed from that storage on that day

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

  // ✓ HARD-CODED: Clinker product to storage routing (replaces RoE for now)
  // Maps specific clinker products to their storage IDs based on which kiln produced them
  const clinkerProductStorageMap = {
    'BRS': {
      'BRS_CLK_K1': 'BRS_BRS_INV_CLK_BRSK01',
      'BRS_CLK_K2': 'BRS_BRS_INV_CLK_BRSK02',
      'region_FL|BRS_CLK_K1': 'BRS_BRS_INV_CLK_BRSK01',
      'region_FL|BRS_CLK_K2': 'BRS_BRS_INV_CLK_BRSK02'
    },
    'MIA': {
      'MIA_CLK_K1': 'MIA_MIA_INV_CLK_MIAK01'
    }
  };

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
    // ✓ FIXED: Recipe-aware clinker sourcing
    // Instead of treating all clinker as one pool, find the specific clinker storage(s)
    // that each FM recipe requires, and check availability per-storage.

    const fmReqLines = [];
    fms.forEach(eq => {
      s.getCapsForEquipment(eq.id).forEach(cap => {
        const reqQty = getEqProd(date, eq.id, cap.productId);
        if (!reqQty) return;

        // ✓ NEW: Check RoE rule for this equipment + product
        const roeRule = getApplicableRule(state.logistics, facId, eq.id, cap.productId);

        // Get recipe: use rule version if available, else highest version
        let recipe = s.getRecipeForProduct(cap.productId);
        let selectedRecipeVersion = null;
        let allowedClinkerSources = null;

        // ✓ RULES OF ENGAGEMENT: Apply recipe version selection from centralized rules
        // Checks RulesOfEngagement for facility-specific recipe routing logic
        if (typeof RulesOfEngagement !== 'undefined') {
          const ruleVersion = RulesOfEngagement.getRecipeVersion(facId, cap.productId, eq.id);
          if (ruleVersion) {
            selectedRecipeVersion = ruleVersion;
            console.log(`[RULES OF ENGAGEMENT] ${date} | Equipment=${eq.id} | Recipe version from rules: v${selectedRecipeVersion}`);

            // Find recipe with selected version
            const versioned = ds.recipes.find(r =>
              r.facilityId === facId &&
              r.productId === cap.productId &&
              r.version === selectedRecipeVersion
            );
            if (versioned) {
              recipe = versioned;
              console.log(`[RULES OF ENGAGEMENT] ${date} | Equipment=${eq.id} | Recipe updated to v${recipe.version}`);
            } else {
              console.log(`[RULES OF ENGAGEMENT] ${date} | Equipment=${eq.id} | NO RECIPE FOUND for v${selectedRecipeVersion}`);
            }
          }
        }

        if (roeRule) {
          // Build inventory state for rule evaluation (clinker cover days per storage)
          const inventoryState = {};
          storages
            .filter(st => familyOfProduct(s, (st.allowedProductIds||[])[0]) === 'CLINKER')
            .forEach(st => {
              const bod = bodMap.get(`${date}|${st.id}`) || 0;
              const deltaVal = delta.get(st.id) || 0;  // ✓ FIX: Use different var name to avoid shadowing
              const avail = bod + deltaVal;
              const expS = expectedShip(date, cap.productId);
              // coverDays = how many days of cement production this clinker can support
              const coverDays = expS > 0 ? Math.max(0, avail) / expS : 99999;
              inventoryState[st.id] = coverDays;
              inventoryState[st.name] = coverDays;  // Also by name for rule readability
            });

          const ruleResult = evaluateRoERule(roeRule.formalRule, inventoryState);
          if (ruleResult) {
            selectedRecipeVersion = ruleResult.recipeVersion;
            allowedClinkerSources = ruleResult.allowedClinkerSources;
            // If rule specifies version, find recipe with that version
            if (selectedRecipeVersion) {
              const versioned = ds.recipes.find(r =>
                r.facilityId === facId &&
                r.productId === cap.productId &&
                r.version === selectedRecipeVersion
              );
              if (versioned) recipe = versioned;
            }
          }
        }

        // ✓ HARD-CODED: Collect clinker sources using facility-specific product→storage mapping
        // Each entry: { materialId, storage, pct }
        const clinkerSources = [];
        if (recipe) {
          recipe.components.forEach(c => {
            if (familyOfProduct(s, c.materialId) === 'CLINKER') {
              let clkStorage = null;
              const clkProductId = c.materialId;  // e.g., "BRS_CLK_K1" or "BRS_CLK_K2"

              // ✓ Use Rules of Engagement for clinker routing, with fallback to hard-coded map
              // This ensures FM01 (which uses BRS_CLK_K1) goes to K1 storage
              //           and FM02 (which uses BRS_CLK_K2) goes to K2 storage

              let targetStorageId = null;

              // First try RulesOfEngagement
              if (typeof RulesOfEngagement !== 'undefined') {
                targetStorageId = RulesOfEngagement.getClilinkerStorage(facId, clkProductId);
                if (targetStorageId) {
                  console.log(`[RULES OF ENGAGEMENT] ${date} | Clinker routing: ${clkProductId} → ${targetStorageId}`);
                }
              }

              // Fallback to hard-coded map if RulesOfEngagement didn't find it
              if (!targetStorageId) {
                const facMapping = clinkerProductStorageMap[facId];
                if (facMapping && facMapping[clkProductId]) {
                  targetStorageId = facMapping[clkProductId];
                }
              }

              // Find storage by ID
              if (targetStorageId) {
                clkStorage = storages.find(st =>
                  st.facilityId === facId &&
                  st.id === targetStorageId
                );
              }

              // Fallback: if hard-coded mapping not found, use first available storage with this product
              if (!clkStorage) {
                clkStorage = storages.find(st =>
                  st.facilityId === facId &&
                  (st.allowedProductIds || []).includes(clkProductId)
                );
              }

              // ✓ DIAGNOSTIC: Log storage selection for each FM
              if (facId === 'BRS' && eq.id && eq.id.includes('FM')) {
                console.log(`[CLINKER ROUTING] ${date} | Equipment=${eq.id} | Product=${cap.productId} | ClinkProduct=${clkProductId} | SelectedStorage=${clkStorage?.name || clkStorage?.id || 'NONE'}`);
              }

              if (clkStorage) {
                clinkerSources.push({
                  materialId: clkProductId,
                  storage: clkStorage,
                  pct: +c.pct || 0
                });
              }
            }
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
        fmReqLines.push({
          eqId: eq.id, productId: cap.productId, reqQty: +reqQty, recipe,
          clinkerSources,  // ✓ Filtered by RoE rule
          selectedRecipeVersion,
          outSt, headroom, expShip: expS, daysCover
        });
      });
    });

    // Kiln requirements (unchanged logic, still uses findStorageForProduct for output)
    const kilnReqLines = [];
    kilns.forEach(eq => {
      s.getCapsForEquipment(eq.id).forEach(cap => {
        const qty = getEqProd(date, eq.id, cap.productId);
        if (!qty) return;
        kilnReqLines.push({ eqId: eq.id, productId: cap.productId, reqQty: +qty, outSt: findStorageForProduct(cap.productId) });
      });
    });

    // Sort FMs by urgency (lowest days of cover first)
    fmReqLines.sort((a, b) => {
      if ((a.daysCover || 99999) !== (b.daysCover || 99999)) return (a.daysCover || 99999) - (b.daysCover || 99999);
      if ((b.expShip || 0) !== (a.expShip || 0)) return (b.expShip || 0) - (a.expShip || 0);
      return String(a.eqId).localeCompare(String(b.eqId));
    });

    const fmUsed = new Map();
    for (const line of fmReqLines) {
      const { eqId, productId, reqQty, outSt, recipe, clinkerSources } = line;

      // ✓ NEW: Check if equipment is allowed to run based on run/idle rules
      const fm = fms.find(e => e.id === eqId);
      if (fm && !canEquipmentRun(date, eqId, 'finish_mill')) {
        eqConstraintMeta.set(`${date}|${eqId}`, {
          type: 'idle',
          reason: 'equipment idle (run/idle rules)',
          requested: reqQty, used: 0,
        });
        continue; // Skip this FM for this date
      }

      // ✓ NEW: Check EACH clinker source separately for availability
      // The FM can only produce as much as the most-constrained clinker allows
      let maxByClk = Infinity;
      const clkConstraintReasons = [];

      clinkerSources.forEach(src => {
        const clkBod    = bodMap.get(`${date}|${src.storage.id}`) || 0;
        const clkDelta  = delta.get(src.storage.id) || 0;
        const clkAvail  = clkBod + clkDelta;
        const neededPct = src.pct / 100;
        const maxByThisClk = neededPct > 0 ? Math.max(0, clkAvail / neededPct) : Infinity;

        if (maxByThisClk < Infinity) {
          clkConstraintReasons.push(`${s.getMaterial(src.materialId)?.code || src.materialId}: ${clkAvail.toFixed(1)}stn`);
        }
        maxByClk = Math.min(maxByClk, maxByThisClk);
      });

      // If no clinker sources, FM can produce unrestricted by clinker (legacy or recipe-less)
      if (clinkerSources.length === 0) {
        maxByClk = Infinity;
      }

      // ✓ CHANGED: Binary on/off behavior (not gradual restriction)
      // Equipment runs at FULL rated capacity OR is turned OFF completely
      // When storage reaches max capacity, equipment stops (does not reduce to partial rate)
      const canProduceAtFullRate = (reqQty <= line.headroom && reqQty <= maxByClk);
      const usedQty = canProduceAtFullRate ? reqQty : 0;

      // ✓ Store usedQty back into line so breakdown calculation uses actual production, not requirement
      line.actualUsedQty = usedQty;

      if (usedQty <= 0 && reqQty > 0) {
        // Equipment turned OFF due to storage constraints
        const reasons = [];
        if (line.headroom < reqQty - 1e-6) reasons.push('cement silo at max capacity');
        if (maxByClk < reqQty - 1e-6) {
          const clkInfo = clkConstraintReasons.length > 0 ? clkConstraintReasons.join(', ') : 'insufficient clinker';
          reasons.push(clkInfo);
        }
        eqConstraintMeta.set(`${date}|${eqId}`, { type: 'shutdown', reason: reasons.join(' + ') || 'storage constraint', requested: reqQty, used: 0 });
      }
      if (usedQty <= 0) { fmUsed.set(eqId, fmUsed.get(eqId) || 0); continue; }

      fmUsed.set(eqId, (fmUsed.get(eqId) || 0) + usedQty);
      fmTotal += usedQty;
      if (outSt) addDelta(outSt.id, usedQty);

      // ✓ FIXED: Consume from EACH clinker storage (respecting RoE rule filters)
      if (recipe) {
        recipe.components.forEach(c => {
          const compQty = usedQty * (+c.pct || 0) / 100;

          // ✓ For clinker: use filtered clinkerSources to respect RoE rules
          // For other components: find storage normally
          let compSt = null;
          if (familyOfProduct(s, c.materialId) === 'CLINKER') {
            // Use pre-filtered clinker sources (respects RoE allowedClinkerSources)
            const clkSrc = clinkerSources.find(src => src.materialId === c.materialId);
            if (clkSrc) compSt = clkSrc.storage;
            clkDerived += compQty;

            // ✓ DIAGNOSTIC: Log consumption deductions
            if (facId === 'BRS' && eqId && eqId.includes('FM')) {
              console.log(`[CONSUMPTION DEDUCTION] ${date} | FM=${eqId} | ClinkProduct=${c.materialId} | Qty=${compQty.toFixed(1)} | DeductedFrom=${compSt?.name || compSt?.id || 'NONE'}`);
            }

            // ✓ NEW: Track clinker consumption from this storage (for kiln demand calculation)
            if (compSt) {
              const key = `${date}|${compSt.id}`;
              clinkerConsumptionByStoragePerDay.set(key, (clinkerConsumptionByStoragePerDay.get(key) || 0) + compQty);
            }
          } else {
            // Non-clinker: find storage by matching allowedProductIds
            compSt = storages.find(st =>
              st.facilityId === facId &&
              (st.allowedProductIds || []).includes(c.materialId)
            );
          }

          if (compSt) addDelta(compSt.id, -compQty);
        });
      }
    }
    fms.forEach(eq => prodByEqMap.set(`${date}|${eq.id}`, fmUsed.get(eq.id) || 0));

    // ✓ NEW: Track run/idle state transitions for FMs after production calculation
    fms.forEach(eq => {
      const produced = fmUsed.get(eq.id) || 0;
      const rule = RulesOfEngagement?.getRunIdleRule('finish_mill');
      if (!rule) return;

      const stateKey = `${date}|${eq.id}`;
      const prevStateKey = idx > 0 ? `${dates[idx - 1]}|${eq.id}` : null;
      const prevState = prevStateKey ? equipmentRunState.get(prevStateKey) : null;

      let runState;
      if (!prevState) {
        // First day: equipment starts from 'idle' state
        runState = { status: 'idle', runDaysSoFar: 0, idleDaysSoFar: 0, reason: 'initial' };
      } else {
        runState = { ...prevState }; // Copy previous state
      }

      // Update state based on production
      if (produced > 0) {
        // Equipment is producing (running)
        if (runState.status === 'off') {
          runState.status = 'on'; // Restarting
          runState.runDaysSoFar = 1;
          runState.idleDaysSoFar = 0;
          runState.reason = 'restarted';
          console.log(`[RUN/IDLE] ${date} | FM=${eq.id} | Status=ON | RunDays=1 | Reason=restarted from idle`);
        } else {
          runState.runDaysSoFar++;
          runState.reason = 'running';
        }
      } else {
        // Equipment not producing (idle or constrained by storage/clinker)
        if (runState.status === 'on' && runState.runDaysSoFar >= rule.minRunDays) {
          // Min run duration satisfied, can now transition to idle
          runState.status = 'off';
          runState.idleDaysSoFar = 1;
          runState.runDaysSoFar = 0;
          runState.reason = 'idle (min run complete)';
          console.log(`[RUN/IDLE] ${date} | FM=${eq.id} | Status=OFF | IdleDays=1 | Reason=minimum run complete`);
        } else if (runState.status === 'off') {
          // Already idle, continue idle
          runState.idleDaysSoFar++;
          runState.reason = 'idle';
        } else if (runState.status === 'on' && runState.runDaysSoFar < rule.minRunDays) {
          // ✓ Binary on/off: Equipment forced OFF by constraint before min run met
          // Storage full, clinker unavailable, or other constraint prevented production
          // Equipment will stay OFF until restart condition is met (e.g., storage drains)
          runState.status = 'off';
          runState.idleDaysSoFar = 1;
          runState.runDaysSoFar = 0;
          runState.reason = `forced off by constraint (had ${runState.runDaysSoFar} of ${rule.minRunDays} min days)`;
          console.log(`[RUN/IDLE] ${date} | FM=${eq.id} | Status=OFF | Reason=forced off by constraint before min run complete`);
        }
      }

      equipmentRunState.set(stateKey, runState);
    });

    // ── Track FM-specific clinker consumption for breakdown display ──
    // Step 2 (FM production) already handles clinker deductions via clinkerSources
    // This section builds the breakdown maps for UI display

    const fmConsumptionMap = new Map(); // fmId → total consumption today

    // Populate consumption maps by re-iterating through FM production
    // to build the breakdown for UI display
    // ✓ Use actualUsedQty (after constraints) not original requirement
    let debugFM1Total = 0, debugFM2Total = 0;
    fmReqLines.forEach(line => {
      const { eqId, productId, actualUsedQty } = line;
      const usedQty = actualUsedQty || 0;  // Use stored actual production, fallback to 0
      if (!productId || usedQty <= 0) return;

      const recipe = s.getRecipeForProduct(productId);
      if (!recipe || !recipe.components) {
        // console.log(`[FM CONSUMPTION DEBUG] ${date}: ${eqId} - NO RECIPE for ${productId}`);
        return;
      }

      let fmClkConsumption = 0;
      recipe.components.forEach(c => {
        if (familyOfProduct(s, c.materialId) === 'CLINKER') {
          fmClkConsumption += usedQty * (+c.pct || 0) / 100;
        }
      });

      if (fmClkConsumption > 0) {
        fmConsumptionMap.set(eqId, (fmConsumptionMap.get(eqId) || 0) + fmClkConsumption);
        if (eqId.includes('FM01')) debugFM1Total += fmClkConsumption;
        if (eqId.includes('FM02')) debugFM2Total += fmClkConsumption;
      }
    });

    // ✓ DIAGNOSTIC: Show FM consumption calculation
    if (facId === 'BRS') {
      const fm1 = fmConsumptionMap.get('BRS_BRSFM01') || 0;
      const fm2 = fmConsumptionMap.get('BRS_BRSFM02') || 0;
      const total = clkConsumedMap.get(date) || 0;
      if (date === '2026-01-01' || date === '2026-01-02' || date === '2026-01-05') {
        console.log(`[FM CONSUMPTION] ${date}: FM01=${fm1.toFixed(1)}, FM02=${fm2.toFixed(1)}, Sum=${(fm1+fm2).toFixed(1)}, Total=${total.toFixed(1)}, Match=${((fm1+fm2)===total ? 'YES' : 'NO')}`);
      }
    }

    // For display: Store consumption per FM in facility-specific maps (if needed for custom UI)
    // BRS uses fm1ConsumedMap and fm2ConsumedMap - populate them if FM IDs match
    fmConsumptionMap.forEach((consumed, fmId) => {
      // Check for BRS facility FMs (by name pattern or facility config)
      if (facId === 'BRS') {
        if (fmId.includes('FM01')) fm1ConsumedMap.set(date, consumed);
        if (fmId.includes('FM02')) fm2ConsumedMap.set(date, consumed);
      }
      // Future facilities can add similar patterns or use a facility config map
    });

    // ✓ DIAGNOSTIC: Log consumption breakdown for debugging
    if (facId === 'BRS' && ['2026-01-01', '2026-01-02', '2026-01-05'].includes(date)) {
      const fm1 = fm1ConsumedMap.get(date) || 0;
      const fm2 = fm2ConsumedMap.get(date) || 0;
      const total = clkConsumedMap.get(date) || 0;
      console.log(`[CLK CONSUMPTION] ${date}: Total=${total.toFixed(1)}, FM01=${fm1.toFixed(1)}, FM02=${fm2.toFixed(1)}, Sum=${(fm1+fm2).toFixed(1)}`);
    }

    // ✓ NEW: Calculate rolling 10-day average DEMAND (shipments) for finish mills
    fms.forEach(eq => {
      const startIdx = Math.max(0, idx - 9); // Last 10 days including today
      let sumShipments = 0;

      // Find all products this FM can produce
      const producedProducts = fmReqLines.filter(l => l.eqId === eq.id).map(l => l.productId);

      for (let i = startIdx; i <= idx; i++) {
        const day = dates[i];
        // Sum all shipments of products this FM produces
        producedProducts.forEach(pid => {
          sumShipments += shipMap.get(`${day}|${pid}`) || 0;
        });
      }

      const daysCount = Math.min(idx + 1, 10); // Number of days in rolling window
      const avgDemand = daysCount > 0 ? sumShipments / daysCount : 0;
      equipmentAvgConsumption.set(eq.id, avgDemand);

      // ✓ DIAGNOSTIC: Show what demand is being used for restart calc
      if (facId === 'BRS' && eq.id && eq.id.includes('FM')) {
        console.log(`[FM DEMAND] ${date} | ${eq.id} | AvgDemand=${avgDemand.toFixed(1)} STn/day (based on shipments)`);
      }
    });

    // ── Step 3: Kiln production (cap by clinker silo headroom) ──
    const kilnUsed = new Map();
    for (const line of kilnReqLines) {
      const { eqId, productId, reqQty, outSt } = line;

      // ✓ NEW: Check if kiln is allowed to run based on run/idle rules
      const kiln = kilns.find(e => e.id === eqId);
      if (kiln && !canEquipmentRun(date, eqId, 'kiln')) {
        eqConstraintMeta.set(`${date}|${eqId}`, {
          type: 'idle',
          reason: 'equipment idle (run/idle rules)',
          requested: reqQty, used: 0,
        });
        continue; // Skip this kiln for this date
      }

      // ✓ CHANGED: Binary on/off behavior (not gradual restriction)
      // Equipment runs at FULL rated capacity OR is turned OFF completely
      // When storage reaches max capacity, equipment stops (does not reduce to partial rate)
      let usedQty = reqQty;
      if (outSt) {
        const maxCap = Number(outSt.maxCapacityStn);
        if (Number.isFinite(maxCap) && maxCap > 0) {
          const bod         = bodMap.get(`${date}|${outSt.id}`) || 0;
          const curDelta    = delta.get(outSt.id) || 0;
          const headroom    = Math.max(0, maxCap - (bod + curDelta));
          const canProduceAtFullRate = (reqQty <= headroom);
          usedQty = canProduceAtFullRate ? reqQty : 0;

          if (usedQty <= 0 && reqQty > 0) {
            // Equipment turned OFF due to storage at max capacity
            const prev   = eqConstraintMeta.get(`${date}|${eqId}`);
            const reason = 'clinker storage at max capacity';
            eqConstraintMeta.set(`${date}|${eqId}`, {
              type: 'shutdown',
              reason: prev ? `${prev.reason} + ${reason}` : reason,
              requested: reqQty, used: 0,
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

    // ✓ NEW: Calculate rolling 10-day average consumption of clinker FROM each kiln (by mills)
    kilns.forEach(eq => {
      const rule = RulesOfEngagement?.getRunIdleRule('kiln');
      if (!rule) return;

      // Find which storage this kiln's clinker goes to (based on kiln's output storage)
      const kilnProdLine = kilnReqLines.find(l => l.eqId === eq.id);
      const targetStorageId = kilnProdLine?.outSt?.id;

      if (!targetStorageId) return; // Can't calculate demand without storage mapping

      // Sum clinker consumption FROM this kiln's storage (over rolling 10 days)
      const startIdx = Math.max(0, idx - 9);
      let sumConsumption = 0;

      for (let i = startIdx; i <= idx; i++) {
        const day = dates[i];
        const dayConsumption = clinkerConsumptionByStoragePerDay.get(`${day}|${targetStorageId}`) || 0;
        sumConsumption += dayConsumption;
      }

      const daysCount = Math.min(idx + 1, 10);
      const avgDemand = daysCount > 0 ? sumConsumption / daysCount : 0;
      equipmentAvgConsumption.set(eq.id, avgDemand);

      // ✓ DIAGNOSTIC: Show what demand is being used with detailed breakdown
      if (facId === 'BRS' && eq.id && eq.id.includes('BRSKL')) {
        console.log(`[KILN DEMAND] ${date} | ${eq.id} | Storage=${targetStorageId} | SumConsumption=${sumConsumption.toFixed(1)} STn over ${daysCount} days | AvgDemand=${avgDemand.toFixed(1)} STn/day`);
      }
    });

    // ✓ NEW: Track run/idle state transitions for kilns after production calculation
    kilns.forEach(eq => {
      const produced = kilnUsed.get(eq.id) || 0;
      const rule = RulesOfEngagement?.getRunIdleRule('kiln');
      if (!rule) return;

      const stateKey = `${date}|${eq.id}`;
      const prevStateKey = idx > 0 ? `${dates[idx - 1]}|${eq.id}` : null;
      const prevState = prevStateKey ? equipmentRunState.get(prevStateKey) : null;

      let runState;
      if (!prevState) {
        // First day: equipment starts from 'idle' state
        runState = { status: 'idle', runDaysSoFar: 0, idleDaysSoFar: 0, reason: 'initial' };
      } else {
        runState = { ...prevState }; // Copy previous state
      }

      // Update state based on production
      if (produced > 0) {
        // Equipment is producing (running)
        if (runState.status === 'off') {
          runState.status = 'on'; // Restarting
          runState.runDaysSoFar = 1;
          runState.idleDaysSoFar = 0;
          runState.reason = 'restarted';
          console.log(`[RUN/IDLE] ${date} | Kiln=${eq.id} | Status=ON | RunDays=1 | Reason=restarted from idle`);
        } else {
          runState.runDaysSoFar++;
          runState.reason = 'running';
        }
      } else {
        // Equipment not producing (idle or constrained by storage)
        if (runState.status === 'on' && runState.runDaysSoFar >= rule.minRunDays) {
          // Min run duration satisfied, can now transition to idle
          runState.status = 'off';
          runState.idleDaysSoFar = 1;
          runState.runDaysSoFar = 0;
          runState.reason = 'idle (min run complete)';
          console.log(`[RUN/IDLE] ${date} | Kiln=${eq.id} | Status=OFF | IdleDays=1 | Reason=minimum run complete`);
        } else if (runState.status === 'off') {
          // Already idle, continue idle
          runState.idleDaysSoFar++;
          runState.reason = 'idle';
        } else if (runState.status === 'on' && runState.runDaysSoFar < rule.minRunDays) {
          // ✓ Binary on/off: Equipment forced OFF by constraint before min run met
          // Storage full or other constraint prevented production
          // Equipment will stay OFF until restart condition is met (e.g., storage drains)
          runState.status = 'off';
          runState.idleDaysSoFar = 1;
          runState.runDaysSoFar = 0;
          runState.reason = `forced off by constraint (had ${runState.runDaysSoFar} of ${rule.minRunDays} min days)`;
          console.log(`[RUN/IDLE] ${date} | Kiln=${eq.id} | Status=OFF | Reason=forced off by constraint before min run complete`);
        }
      }

      equipmentRunState.set(stateKey, runState);
    });

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

  const storageFamily = st => familyOfProduct(s, (st.allowedProductIds || [])[0]);
  const storagesByFamily = fam => storages.filter(st => storageFamily(st) === fam);

  // Helper: BOD subtotal + storage children for a family
  const bodSection = (fam, label) => {
    const rows = storagesByFamily(fam);
    if (!rows.length) return [];
    const sectionId = `inv_bod_${fam.toUpperCase()}`;
    return [
      { kind: 'section-header', label, _section: 'bod', _sectionId: sectionId,
        values: mkValues(d => rows.reduce((sum, st) => sum + (bodMap.get(`${d}|${st.id}`) || 0), 0)) },
      ...rows.map(st => ({ kind: 'row', storageId: st.id, label: st.name,
        productLabel: (st.allowedProductIds||[]).map(pid => s.getMaterial(pid)?.name).filter(Boolean).join(' / '),
        values: mkValues(d => bodMap.get(`${d}|${st.id}`) || 0),
        _sectionId: sectionId,
        allowedProductIds: st.allowedProductIds || [] })),
    ];
  };

  // Helper: EOD subtotal + storage children for a family (shows per-storage EOD breakdown)
  const eodSection = (fam, label) => {
    const rows = storagesByFamily(fam);
    if (!rows.length) return [];
    const sectionId = `inv_eod_${fam.toUpperCase()}`;
    return [
      { kind: 'section-header', label, _section: 'eod', _sectionId: sectionId,
        values: mkValues(d => rows.reduce((sum, st) => sum + (eodMap.get(`${d}|${st.id}`) || 0), 0)) },
      ...rows.map(st => ({ kind: 'row', storageId: st.id, label: st.name,
        productLabel: (st.allowedProductIds||[]).map(pid => s.getMaterial(pid)?.name).filter(Boolean).join(' / '),
        values: mkValues(d => eodMap.get(`${d}|${st.id}`) || 0),
        _sectionId: sectionId,
        allowedProductIds: st.allowedProductIds || [] })),
    ];
  };

  // Helper: TRANSF BOD storage section for Rail Transfer
  const transfrBodSection = () => {
    const rows = storagesByFamily('TRANSF');
    if (!rows.length) return [];
    const sectionId = `inv_bod_TRANSF`;
    return [
      { kind: 'section-header', label: '** / TRANSF / ** BOD', _section: 'bod', _sectionId: sectionId,
        values: mkValues(d => rows.reduce((sum, st) => sum + (bodMap.get(`${d}|${st.id}`) || 0), 0)) },
      ...rows.map(st => ({ kind: 'row', storageId: st.id, label: st.name,
        productLabel: (st.allowedProductIds||[]).map(pid => s.getMaterial(pid)?.name).filter(Boolean).join(' / '),
        values: mkValues(d => bodMap.get(`${d}|${st.id}`) || 0),
        _sectionId: sectionId,
        allowedProductIds: st.allowedProductIds || [] })),
    ];
  };

  // Helper: Consumption breakdown by finish mill (BRS facility only)
  const consumptionSection = () => {
    const rows = [];
    // Total consumption
    rows.push({ kind: 'subtotal', label: 'CLK CONSUMPTION', _section: 'consumption',
      values: mkValues(d => clkConsumedMap.get(d) || 0) });

    // For BRS: show BROSFM01 and BROSFM02 breakdowns
    if (facId === 'BRS') {
      rows.push({ kind: 'row', rowType: 'equipment', equipmentId: 'BRS_BRSFM01', label: 'BROSFM01',
        values: mkValues(d => fm1ConsumedMap.get(d) || 0) });
      rows.push({ kind: 'row', rowType: 'equipment', equipmentId: 'BRS_BRSFM02', label: 'BROSFM02',
        values: mkValues(d => fm2ConsumedMap.get(d) || 0) });
    }
    return rows;
  };

  // Helper: transfer rows for a given family's products
  const transferRows = (fam) => {
    const famStorages = storagesByFamily(fam);
    const famPids = new Set(famStorages.flatMap(st => st.allowedProductIds || []));

    const outPids = [...new Set(
      ds.actuals.transfers.filter(r => r.fromFacilityId === facId && famPids.has(r.productId)).map(r => r.productId)
    )];
    const inPids = [...new Set(
      ds.actuals.transfers.filter(r => r.toFacilityId === facId && famPids.has(r.productId)).map(r => r.productId)
    )];

    const rows = [];
    if (outPids.length) {
      outPids.forEach(pid => {
        const mat = s.getMaterial(pid);
        rows.push({ kind: 'row', label: `↑ OUT ${mat?.name || pid}`, _section: 'transfer',
          values: mkValues(d => ds.actuals.transfers
            .filter(r => r.fromFacilityId === facId && r.date === d && r.productId === pid)
            .reduce((sum, r) => sum + (+r.qtyStn || 0), 0)) });
      });
    }
    if (inPids.length) {
      inPids.forEach(pid => {
        const mat = s.getMaterial(pid);
        rows.push({ kind: 'row', label: `↓ IN ${mat?.name || pid}`, _section: 'transfer',
          values: mkValues(d => ds.actuals.transfers
            .filter(r => r.toFacilityId === facId && r.date === d && r.productId === pid)
            .reduce((sum, r) => sum + (+r.qtyStn || 0), 0)) });
      });
    }
    return rows;
  };

  // ── Facility-first unified rows ──
  // Facility type drives which product families and process rows appear.
  const fac         = state.org.facilities.find(f => f.id === facId);
  // Determine facility type: auto-detect from equipment, fallback to explicit config, final fallback to terminal
  let facType = fac?.facilityType;

  // Auto-detect based on equipment configuration (overrides default "terminal" type)
  const hasKilns = kilns.length > 0;
  const hasFinishMills = fms.length > 0;

  if (hasKilns) {
    facType = 'cement_plant';  // Has kilns → full cement production
  } else if (hasFinishMills) {
    facType = 'grinding';       // Has finish mills only → grinding facility
  } else if (!facType) {
    facType = 'terminal';       // Default fallback only if no config and no equipment
  }
  // If facType was explicitly configured as something other than what equipment suggests,
  // respect the config (unless it's just "terminal" - which is likely a default/placeholder)
  const facFinished = s.getFacilityProducts(facId).filter(m => m.category === Categories.FIN);
  const facFinishedRows = () => facFinished.map(fp => ({
    kind: 'row', label: fp.name, productLabel: fp.name, productId: fp.id, _facilityId: facId,
    values: mkValues(d => shipMap.get(`${d}|${fp.id}`) || 0),
  }));

  const facilityRows = []; // The new unified output

  // Clinker section displays for cement plants that produce clinker
  const hasClinkerSection = facType === 'cement_plant' && kilns.length > 0;

  if (hasClinkerSection) {
    // ── DEMAND section (at top level, same importance as CLINKER/CEMENT) ──
    facilityRows.push({ kind: 'family-header', label: 'DEMAND', _family: 'DEMAND' });
    facilityRows.push(...facFinishedRows());

    // ── CLINKER section (BRS and MIA only) ──
    // Order: BOD → Consumption → Production → EOD
    facilityRows.push({ kind: 'family-header', label: 'CLINKER', _family: 'CLINKER' });
    facilityRows.push(...bodSection('CLINKER', 'CLK INV-BOD'));

    // Clinker consumption (derived from FM production × recipe clinker %)
    facilityRows.push(...consumptionSection());

    // Kiln production (total and by kiln)
    if (kilns.length) {
      facilityRows.push({ kind: 'subtotal', label: 'KILN PRODUCTION', _section: 'prod',
        values: mkValues(d => kilnProdMap.get(d) || 0) });
      kilns.forEach(k => facilityRows.push({ kind: 'row', rowType: 'equipment', equipmentId: k.id, label: k.name,
        values: mkValues(d => prodByEqMap.get(`${d}|${k.id}`) || 0) }));
    }
    facilityRows.push(...transferRows('CLINKER'));

    // Clinker EOD (BOD + Production - Consumption) - with per-storage breakdown
    facilityRows.push(...eodSection('CLINKER', 'CLK INV-EOD'));

    // ── CEMENT section ──
    facilityRows.push({ kind: 'family-header', label: 'CEMENT', _family: 'CEMENT' });
    facilityRows.push(...bodSection('CEMENT', 'CEM INV-BOD'));
    if (fms.length) {
      facilityRows.push({ kind: 'subtotal', label: 'FM PRODUCTION', _section: 'prod',
        values: mkValues(d => fmProdMap.get(d) || 0) });
      fms.forEach(f => facilityRows.push({ kind: 'row', rowType: 'equipment', equipmentId: f.id, label: f.name,
        values: mkValues(d => prodByEqMap.get(`${d}|${f.id}`) || 0) }));
    }
    facilityRows.push(...transferRows('CEMENT'));

    // ── RAIL TRANSFER section (subtotal level under CEMENT, same importance as FM PRODUCTION) ──
    if (loaders.length || storagesByFamily('TRANSF').length) {
      facilityRows.push({ kind: 'subtotal', label: 'RAIL TRANSFER', _section: 'rail',
        values: mkValues(d => 0) }); // Placeholder for future calculation
      facilityRows.push(...transfrBodSection());
      loaders.forEach(l => facilityRows.push({ kind: 'row', rowType: 'equipment', equipmentId: l.id, label: l.name,
        values: mkValues(d => 0) })); // Placeholder for future calculation
    }

  } else if (facType === 'grinding' && hasClinkerSection) {
    // ── DEMAND section (at top level, same importance as CLINKER/CEMENT) ──
    facilityRows.push({ kind: 'family-header', label: 'DEMAND', _family: 'DEMAND' });
    facilityRows.push(...facFinishedRows());

    // ── CLINKER section (no kiln) — only for designated facilities ──
    facilityRows.push({ kind: 'family-header', label: 'CLINKER', _family: 'CLINKER' });
    facilityRows.push(...bodSection('CLINKER', 'CLK INV-BOD'));
    facilityRows.push(...consumptionSection());
    facilityRows.push(...transferRows('CLINKER'));
    facilityRows.push(...eodSection('CLINKER', 'CLK INV-EOD'));

    // ── CEMENT section ──
    facilityRows.push({ kind: 'family-header', label: 'CEMENT', _family: 'CEMENT' });
    facilityRows.push(...bodSection('CEMENT', 'CEM INV-BOD'));
    if (fms.length) {
      facilityRows.push({ kind: 'subtotal', label: 'FM PRODUCTION', _section: 'prod',
        values: mkValues(d => fmProdMap.get(d) || 0) });
      fms.forEach(f => facilityRows.push({ kind: 'row', rowType: 'equipment', equipmentId: f.id, label: f.name,
        values: mkValues(d => prodByEqMap.get(`${d}|${f.id}`) || 0) }));
    }
    facilityRows.push(...transferRows('CEMENT'));

    // ── RAIL TRANSFER section (subtotal level under CEMENT, same importance as FM PRODUCTION) ──
    if (loaders.length || storagesByFamily('TRANSF').length) {
      facilityRows.push({ kind: 'subtotal', label: 'RAIL TRANSFER', _section: 'rail',
        values: mkValues(d => 0) }); // Placeholder for future calculation
      facilityRows.push(...transfrBodSection());
      loaders.forEach(l => facilityRows.push({ kind: 'row', rowType: 'equipment', equipmentId: l.id, label: l.name,
        values: mkValues(d => 0) })); // Placeholder for future calculation
    }

  } else {
    // ── TERMINAL: finished products only ──
    // Group by product family (CEMENT, SCM, etc.) if multiple, else flat
    const famGroups = [...new Set(facFinished.map(fp =>
      familyOfProduct(s, fp.id) || 'CEMENT'
    ))];

    famGroups.forEach(fam => {
      const famProds = facFinished.filter(fp => (familyOfProduct(s, fp.id) || 'CEMENT') === fam);
      facilityRows.push({ kind: 'family-header', label: fam, _family: fam });
      facilityRows.push(...bodSection(fam, `${fam} INV-BOD`));
      // Placeholder for unloading (vessel arrivals — to be wired to logistics schedule)
      facilityRows.push({ kind: 'subtotal', label: 'UNLOADING', _section: 'unloading', _placeholder: true,
        values: mkValues(() => 0) });
      facilityRows.push(...transferRows(fam));
      facilityRows.push({ kind: 'subtotal', label: 'DEMAND', _section: 'demand',
        values: mkValues(d => famProds.reduce((sum, fp) => sum + (shipMap.get(`${d}|${fp.id}`) || 0), 0)) });
      famProds.forEach(fp => facilityRows.push({
        kind: 'row', label: fp.name, productLabel: fp.name, productId: fp.id, _facilityId: facId,
        values: mkValues(d => shipMap.get(`${d}|${fp.id}`) || 0),
      }));
    });
  }

  return {
    facId,
    facType,
    facilityRows,   // ← new primary output
    // Keep legacy arrays for backward compat with any direct consumers
    inventoryBODRows: facilityRows.filter(r => r._section === 'bod' || r.kind === 'subtotal' && r.label.includes('INV-BOD')),
    productionRows:   facilityRows.filter(r => r._section === 'prod'),
    outflowRows:      facilityRows.filter(r => r._section === 'demand' || r.label?.includes('DEMAND')),
    inventoryEODRows: facilityRows.filter(r => r._section === 'eod' || r.kind === 'subtotal' && r.label.includes('INV-EOD')),
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

  // ── Build unified row list — facility-first structure ──
  const isMulti = facIds.length > 1;

  let subCounter = 0;
  const mkSubId = (facId, label) => `sub_${facId}_${subCounter++}_${label}`;

  const unifiedRows = [];

  facResults.forEach(fr => {
    const fac     = state.org.facilities.find(f => f.id === fr.facId);
    const facName = fac ? (fac.code ? `${fac.code} — ${fac.name}` : fac.name) : fr.facId;

    // Facility header (always shown — essential for the new layout)
    unifiedRows.push({
      _type: 'facility-header',
      _facilityId: fr.facId,
      label: facName,
      facType: fr.facType,
    });

    let currentSubId = null;

    fr.facilityRows.forEach(r => {
      if (r.kind === 'family-header') {
        unifiedRows.push({ _type: 'family-header', _facilityId: fr.facId, label: r.label, _family: r._family });
        currentSubId = null;
        return;
      }
      if (r.kind === 'subtotal') {
        const subId = mkSubId(fr.facId, r.label);
        currentSubId = subId;
        unifiedRows.push({ ...r, _type: 'subtotal-header', _facilityId: fr.facId, _subId: subId });
        return;
      }
      if (r.kind === 'placeholder') {
        unifiedRows.push({ _type: 'placeholder', _facilityId: fr.facId, label: r.label });
        return;
      }
      // Normal child row
      unifiedRows.push({ ...r, _type: 'child', _facilityId: fr.facId, _subId: currentSubId });
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
    // Legacy flat arrays (for any backward-compat consumers in app.js)
    productionRows:   facResults.flatMap(fr => fr.productionRows),
    inventoryBODRows: facResults.flatMap(fr => fr.inventoryBODRows),
    outflowRows:      facResults.flatMap(fr => fr.outflowRows),
    inventoryEODRows: facResults.flatMap(fr => fr.inventoryEODRows),
    _debug: { facResults },
  };
}
