// ─────────────────────────────────────────────────────────────────────────────
// store.js  —  Roll Panner · State persistence & migration
// Version: 3  (catalog restructure + transfers + BOD override + multi-facility)
// ─────────────────────────────────────────────────────────────────────────────

import { firebaseSave, firebaseLoad, firebaseListen } from './firebase-sync.js';
export { firebaseListen };

export const STORAGE_KEY  = 'cementPlannerRebuild_v4';
const LEGACY_KEY_V3       = 'cementPlannerRebuild_v3';
const LEGACY_KEY_V2       = 'cementPlannerRebuild_v2';

// Generate cryptographically secure random IDs using Web Crypto API
// Fallback to Math.random() for older browsers (better than nothing)
const uid = (p = 'id') => {
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      const randomPart = Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 9);
      return `${p}_${randomPart}`;
    }
  } catch (e) {
    console.warn('[UID] crypto.getRandomValues failed, falling back to Math.random()');
  }
  // Fallback for older browsers or if crypto fails
  return `${p}_${Math.random().toString(36).slice(2, 9)}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT REFERENCE DATA
// Users can add/edit/delete all of these. These are just sensible starting
// points so the app is usable out of the box.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PRODUCT_FAMILIES = [
  { id: 'fam_CEM',  code: 'CEM',  label: 'Cement',       category: 'FINISHED_PRODUCT' },
  { id: 'fam_WHT',  code: 'WHT',  label: 'White Cement', category: 'FINISHED_PRODUCT' },
  { id: 'fam_ASH',  code: 'ASH',  label: 'Fly Ash',      category: 'FINISHED_PRODUCT' },
  { id: 'fam_SLAG', code: 'SLAG', label: 'Slag',         category: 'FINISHED_PRODUCT' },
  { id: 'fam_CLNK', code: 'CLNK', label: 'Clinker',      category: 'INTERMEDIATE_PRODUCT' },
  { id: 'fam_TRANSF', code: 'TRANSF', label: 'Rail Transfer', category: 'TRANSFER_PRODUCT' },
  { id: 'fam_RAW',  code: 'RAW',  label: 'Raw Material', category: 'RAW_MATERIAL' },
  { id: 'fam_FUEL', code: 'FUEL', label: 'Fuel',         category: 'FUEL' },
];

export const DEFAULT_PRODUCT_TYPES = [
  // Cement types
  { id: 'type_IL',   familyId: 'fam_CEM', code: 'IL',   label: 'Type IL (Portland-Limestone)' },
  { id: 'type_I_II', familyId: 'fam_CEM', code: 'I-II', label: 'Type I-II' },
  { id: 'type_III',  familyId: 'fam_CEM', code: 'III',  label: 'Type III' },
  { id: 'type_V',    familyId: 'fam_CEM', code: 'V',    label: 'Type V' },
  { id: 'type_SPEC', familyId: 'fam_CEM', code: 'SPEC', label: 'Special' },
  // White cement
  { id: 'type_WCEM', familyId: 'fam_WHT', code: 'WHT',  label: 'White' },
  // Clinker
  { id: 'type_CLNK', familyId: 'fam_CLNK', code: 'CLNK', label: 'Clinker' },
  // Rail Transfer
  { id: 'type_RAIL', familyId: 'fam_TRANSF', code: 'RAIL', label: 'Rail Transfer' },
  // Fly Ash
  { id: 'type_CI',   familyId: 'fam_ASH',  code: 'CI',   label: 'Class CI' },
  { id: 'type_CII',  familyId: 'fam_ASH',  code: 'CII',  label: 'Class CII' },
  // Slag
  { id: 'type_SLAG', familyId: 'fam_SLAG', code: 'SLAG', label: 'Slag' },
  // Fuel
  { id: 'type_COAL', familyId: 'fam_FUEL', code: 'COAL', label: 'Coal' },
  { id: 'type_PETC', familyId: 'fam_FUEL', code: 'PETC', label: 'Pet Coke' },
  { id: 'type_ALT',  familyId: 'fam_FUEL', code: 'ALT',  label: 'Alternative Fuel' },
];

export const DEFAULT_PRODUCT_SUBTYPES = [
  // IL limestone content
  { id: 'sub_8pct',    typeId: 'type_IL',   code: '8%',    label: '8% Limestone' },
  { id: 'sub_11pct',   typeId: 'type_IL',   code: '11%',   label: '11% Limestone' },
  { id: 'sub_15pct',   typeId: 'type_IL',   code: '15%',   label: '15% Limestone' },
  // SPEC sub-types
  { id: 'sub_STUCCO',  typeId: 'type_SPEC', code: 'Stucco', label: 'Stucco' },
  { id: 'sub_OIL',     typeId: 'type_SPEC', code: 'Oil',   label: 'Oil Well' },
  { id: 'sub_MORTAR',  typeId: 'type_SPEC', code: 'Mortar', label: 'Mortar' },
];

// ─────────────────────────────────────────────────────────────────────────────
// FRESH DATA STRUCTURES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-facility operational data. Stored in official and each sandbox.
 * All arrays are flat and filtered by facilityId at read time.
 */
export function freshFacilityData() {
  return {
    // Which catalog products each facility uses (activation toggle)
    facilityProducts: [],   // { facilityId, productId }

    // Production setup
    recipes:          [],   // { id, facilityId, productId, version, components[] }
    equipment:        [],   // { id, facilityId, name, type }
    storages:         [],   // { id, facilityId, name, categoryHint, allowedProductIds[], maxCapacityStn }
    capabilities:     [],   // { id, equipmentId, productId, maxRateStpd, electricKwhPerStn, thermalMMBTUPerStn }

    // Planning
    demandForecast:   [],   // { date, facilityId, productId, customerId?, qtyStn, source }
    campaigns:        [],   // { date, facilityId, equipmentId, productId, rateStn, status }

    // Actuals
    actuals: {
      // Physical inventory count — overrides BOD calculation when present
      // Renamed from inventoryEOD (v2) to inventoryBOD (v3) to reflect true semantics
      inventoryBOD:   [],   // { date, facilityId, storageId, productId, qtyStn }

      production:     [],   // { date, facilityId, equipmentId, productId, qtyStn }

      // Customer shipments (external or internal sales — NOT plant-to-plant moves)
      shipments:      [],   // { date, facilityId, customerId, productId, qtyStn,
                            //   deliveryTerms: 'FOB'|'DEL', materialNumber? }

      // Plant-to-plant material movements (clinker, etc.)
      // Separate from shipments because they affect TWO facilities' inventory
      transfers:      [],   // { date, fromFacilityId, toFacilityId, productId, qtyStn,
                            //   materialNumber?, notes? }

      // Rail loader operations (loader equipment actuals for transfer staging)
      railTransfers:  [],   // { date, facilityId, equipmentId, productId, qtyStn }

      // Rail inventory EOD (end-of-day cars in transit for rail transfer)
      railInventoryEod: [],   // { date, facilityId, qtyStn (cars × 112) }

      // Rail distributions (Stage 2 logistics: assigning batches to destination facilities)
      railDistributions: [],  // { id, sourceFacilityId, destinationFacilityId, pickupDate, assignedDate,
                              //   productId, qtyStn, transitTimeInDays, expectedArrivalDate,
                              //   status: 'assigned'|'in-transit'|'received' }
    },

    // ── Logistics schedule (sandboxed — what-if scenarios affect this) ──
    // Each entry is one planned movement on a lane.
    // Agent writes status:'needed', humans promote to 'confirmed', sim consumes 'confirmed'+'arrived'.
    logisticsSchedule: [], // {
                           //   id, laneId, mode: 'vessel'|'rail'|'truck',
                           //   originName,          // e.g. "Clinker Spain", "BRS"
                           //   vesselName?,         // identifier for vessels only
                           //   productId,
                           //   volumeStn,
                           //   departureDateExpected?,  // ISO date string or null
                           //   arrivalDateExpected,     // ISO date string — the key output
                           //   status: 'needed'|'confirmed'|'arrived'|'cancelled',
                           //   notes?,
                           //   createdBy: 'agent'|'user',
                           //   createdAt,           // ISO datetime
                           //   updatedAt?
                           // }
  };
}

/**
 * Full application state seed — used on first load or reset.
 */
function seed() {
  return {
    _version: 4,

    ui: {
      activeTab:            'plan',
      selectedFacilityId:   null,   // legacy single (kept for getScopeName compat)
      selectedFacilityIds:  [],     // multi-select array — source of truth
      mode:                 'sandbox',
      activeSandboxId:      'default',
    },

    // ── Org hierarchy (shared, not sandboxed) ──
    org: {
      countries:   [],  // { id, name, code }
      regions:     [],  // { id, countryId, name, code }
      subRegions:  [],  // { id, regionId, name, code }
      facilities:  [],  // { id, subRegionId, name, code, timezone?,
                        //   roles: ['calcination'|'grinding'|'rail-dispatch'|'vessel-dispatch'|
                        //           'rail-receiving'|'vessel-receiving'] }
    },

    // ── Logistics configuration (shared, not sandboxed) ──
    // Rules and network topology are company policy — they don't change per scenario.
    logistics: {

      // Rules of Engagement — owned at regional level, can be facility+product or facility+equipment+product specific.
      // Defines logistics rules (min cover days, lead times) and production constraints (recipe selection, clinker sourcing).
      rulesOfEngagement: [], // {
         //   id,
         //   facilityId,          // which terminal/plant this applies to
         //   equipmentId?,        // (optional) specific equipment this rule targets
         //   productId,           // which product (cement, clinker, etc.)
         //
         //   // Logistics fields
         //   minCoverDays,        // trigger threshold — request supply when cover drops below this
         //   tradingLeadTimeDays, // how many days before arrival the team needs to act
         //   standardVolumeStn,   // typical shipment size for this lane/mode
         //   priorityRank?,       // 1=highest — used when choosing which terminal to serve first
         //
         //   // Production constraint fields (for equipment/recipe rules)
         //   userDescription?,    // natural language description of desired behavior
         //   formalRule?,         // AI-generated rule {type, targetEquipment, targetProduct, rules:[]}
         //                        // Evaluated at runtime to select recipe version + clinker sources
         //
         //   notes?,
         //   updatedAt,
         //   updatedBy?
         // }

      // Transport Lanes — the fixed network topology.
      // Defines every valid origin→destination pair and its physical characteristics.
      lanes: [],             // {
                             //   id,
                             //   fromFacilityId,      // null = overseas/external origin
                             //   fromName,            // display name (e.g. "Spain", "BRS")
                             //   toFacilityId,
                             //   mode: 'vessel'|'rail'|'truck',
                             //   transitDays,         // typical days from departure to arrival
                             //   isPrimary,           // false = backup lane
                             //   scheduleFrequencyDays?, // for fixed-schedule rail (e.g. 3 = every 3 days)
                             //   notes?
                             // }
    },

    // ── Product reference tables (shared, users can extend) ──
    productFamilies:  [...DEFAULT_PRODUCT_FAMILIES],
    productTypes:     [...DEFAULT_PRODUCT_TYPES],
    productSubTypes:  [...DEFAULT_PRODUCT_SUBTYPES],

    // Producers: internal (facilityId set) or external (facilityId null)
    producers: [],      // { id, code, label, facilityId? }

    // Customers: external, internal (another plant), or both
    customers: [],      // { id, code, name, type: 'external'|'internal'|'both',
                        //   facilityId?  ← set when type includes 'internal' }

    // ── Regional product catalog (shared, not sandboxed) ──
    // Products are defined region-wide; facilities activate/deactivate them
    catalog: [],        // { id, regionId, producerId?, familyId, typeId, subTypeId?,
                        //   name (auto-generated), category, unit,
                        //   landedCostUsdPerStn, calorificPowerMMBTUPerStn?,
                        //   co2FactorKgPerMMBTU?,
                        //   materialNumbers: [{ number, source, effectiveFrom?, note? }] }

    // ── Operational data (sandboxed) ──
    official: freshFacilityData(),

    sandboxes: {
      default: {
        name:      'Default Sandbox',
        createdAt: new Date().toISOString(),
        data:      freshFacilityData(),
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-GENERATE PRODUCT NAME
// Producer.code + Type.code + SubType.code  →  "MIA IL 11%"
// ─────────────────────────────────────────────────────────────────────────────

export function buildProductName(state, { producerId, typeId, subTypeId }) {
  const producer = (state.producers || []).find(p => p.id === producerId);
  const type     = (state.productTypes || []).find(t => t.id === typeId);
  const subType  = (state.productSubTypes || []).find(s => s.id === subTypeId);

  const parts = [
    producer?.code,
    type?.code,
    subType?.code,
  ].filter(Boolean);

  return parts.join(' ') || 'Unnamed Product';
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION  v2 → v3
// ─────────────────────────────────────────────────────────────────────────────

function migrateV2V3(v2) {
  const base = seed();
  const out  = { ...base };

  // ── UI ──
  out.ui = {
    ...base.ui,
    ...(v2.ui || {}),
    // Ensure selectedFacilityIds is always an array
    selectedFacilityIds: v2.ui?.selectedFacilityIds?.length
      ? v2.ui.selectedFacilityIds
      : v2.ui?.selectedFacilityId
        ? [v2.ui.selectedFacilityId]
        : [],
  };
  // Remap old tab keys
  const tabRemap = { data: 'plan', demand: 'demand-external' };
  if (tabRemap[out.ui.activeTab]) out.ui.activeTab = tabRemap[out.ui.activeTab];

  // ── Org ──
  out.org = {
    countries:  v2.org?.countries  || [],
    regions:    v2.org?.regions    || [],
    subRegions: v2.org?.subRegions || [],
    facilities: v2.org?.facilities || [],
  };

  // ── Reference tables — keep defaults, user data comes later ──
  out.productFamilies = v2.productFamilies?.length ? v2.productFamilies : base.productFamilies;
  out.productTypes    = v2.productTypes?.length    ? v2.productTypes    : base.productTypes;
  out.productSubTypes = v2.productSubTypes?.length ? v2.productSubTypes : base.productSubTypes;
  out.producers       = v2.producers  || [];
  out.customers       = v2.customers  || [];

  // ── Catalog: migrate old flat materials → new structure ──
  // Old: { id, regionId, code, name, category, materialNumbers: string[] }
  // New: { id, regionId, familyId, typeId, subTypeId, producerId, name, category,
  //        materialNumbers: [{ number, source }] }
  out.catalog = (v2.catalog || []).map(m => {
    // Migrate materialNumbers from string[] to object[]
    const matNums = (m.materialNumbers || []).map(mn => {
      if (typeof mn === 'string') return { number: mn, source: 'legacy' };
      return mn;
    });

    return {
      ...m,
      // New fields — null means "not yet classified"; UI will prompt user to fill in
      familyId:   m.familyId   || null,
      typeId:     m.typeId     || null,
      subTypeId:  m.subTypeId  || null,
      producerId: m.producerId || null,
      materialNumbers: matNums,
    };
  });

  // ── Operational data ──
  const migrateDataset = (ds) => {
    if (!ds) return freshFacilityData();
    const fresh = freshFacilityData();
    return {
      facilityProducts: ds.facilityProducts || fresh.facilityProducts,
      recipes:          ds.recipes          || fresh.recipes,
      equipment:        ds.equipment        || fresh.equipment,
      storages:         ds.storages         || fresh.storages,
      capabilities:     ds.capabilities     || fresh.capabilities,
      demandForecast:   ds.demandForecast   || fresh.demandForecast,
      campaigns:        ds.campaigns        || fresh.campaigns,
      actuals: {
        // KEY RENAME: inventoryEOD → inventoryBOD
        // The v2 data was already being used as a BOD seed/override,
        // so no transformation needed — just rename the key.
        inventoryBOD: ds.actuals?.inventoryBOD
          || ds.actuals?.inventoryEOD   // ← migrate old key
          || fresh.actuals.inventoryBOD,

        production: ds.actuals?.production || fresh.actuals.production,

        // Shipments: add missing fields with safe defaults
        shipments: (ds.actuals?.shipments || []).map(r => ({
          customerId:     null,
          deliveryTerms:  'FOB',
          materialNumber: null,
          ...r,
        })),

        // Transfers: new table — start empty on migration
        transfers: ds.actuals?.transfers || fresh.actuals.transfers,

        // Rail transfers: loader operations for transfer staging
        railTransfers: ds.actuals?.railTransfers || fresh.actuals.railTransfers,

        // Rail inventory EOD: end-of-day cars in transit
        railInventoryEod: ds.actuals?.railInventoryEod || fresh.actuals.railInventoryEod,
      }
    };
  };

  // Official
  out.official = migrateDataset(v2.official);

  // Sandboxes
  out.sandboxes = {};
  const v2sbs = v2.sandboxes || {};
  if (Object.keys(v2sbs).length === 0) {
    out.sandboxes = base.sandboxes;
  } else {
    Object.entries(v2sbs).forEach(([id, sb]) => {
      out.sandboxes[id] = {
        name:      sb.name      || 'Sandbox',
        createdAt: sb.createdAt || new Date().toISOString(),
        data:      migrateDataset(sb.data),
      };
    });
  }

  // ── Handle very old v1 single-facility format ──
  if (v2.sandbox || (!v2.official && !v2.sandboxes)) {
    const oldDs = v2.sandbox || {};
    if (out.org.countries.length === 0 && oldDs.facilities?.length) {
      const oldFac = oldDs.facilities[0];
      const cid  = 'country_USA';
      const rid  = 'region_FL';
      const srid = 'subregion_SFL';
      const fid  = oldFac.id || 'MIA';
      out.org.countries  = [{ id: cid,  name: 'United States', code: 'USA' }];
      out.org.regions    = [{ id: rid,  countryId: cid, name: 'Florida', code: 'FL' }];
      out.org.subRegions = [{ id: srid, regionId: rid, name: 'South Florida', code: 'SFL' }];
      out.org.facilities = [{ id: fid,  subRegionId: srid, name: oldFac.name || 'Miami', code: fid }];
      out.ui.selectedFacilityId  = fid;
      out.ui.selectedFacilityIds = [fid];
      if (oldDs.materials?.length) {
        out.catalog = oldDs.materials.map(m => ({
          ...m,
          regionId:       rid,
          familyId:       null,
          typeId:         null,
          subTypeId:      null,
          producerId:     null,
          materialNumbers: (m.materialNumbers || []).map(mn =>
            typeof mn === 'string' ? { number: mn, source: 'legacy' } : mn
          ),
        }));
      }
      const migratedData = migrateDataset(oldDs);
      out.official = migratedData;
      out.sandboxes = {
        default: {
          name:      'Default Sandbox',
          createdAt: new Date().toISOString(),
          data:      JSON.parse(JSON.stringify(migratedData)),
        }
      };
    }
  }

  // ── Ensure UI selections are valid ──
  if (!out.ui.selectedFacilityId && out.org.facilities.length) {
    out.ui.selectedFacilityId = out.org.facilities[0].id;
  }
  if (!out.ui.selectedFacilityIds?.length && out.ui.selectedFacilityId) {
    out.ui.selectedFacilityIds = [out.ui.selectedFacilityId];
  }
  if (!out.ui.activeSandboxId || !out.sandboxes[out.ui.activeSandboxId]) {
    out.ui.activeSandboxId = Object.keys(out.sandboxes)[0] || 'default';
  }

  out._version = 3;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION  v3 → v4
// Purely additive — adds logistics config and logisticsSchedule to every dataset.
// Zero existing data is renamed, moved, or deleted.
// ─────────────────────────────────────────────────────────────────────────────

function migrateV3ToV4(v3) {
  const base = seed();

  // Deep-clone so we never mutate the input
  const out = JSON.parse(JSON.stringify(v3));

  // Add logistics block if missing (shared, not sandboxed)
  if (!out.logistics) {
    out.logistics = base.logistics;
  } else {
    // Ensure both sub-arrays exist even if partial data was saved
    if (!Array.isArray(out.logistics.rulesOfEngagement)) out.logistics.rulesOfEngagement = [];
    if (!Array.isArray(out.logistics.lanes))             out.logistics.lanes = [];
  }

  // Helper: add missing structures to a single dataset
  const patchDataset = (ds) => {
    if (!ds) return;
    if (!Array.isArray(ds.logisticsSchedule)) ds.logisticsSchedule = [];
    // Add rail transfer structures if missing (new in rail transfer feature)
    if (!Array.isArray(ds.actuals?.railTransfers)) {
      if (!ds.actuals) ds.actuals = {};
      ds.actuals.railTransfers = [];
    }
    if (!Array.isArray(ds.actuals?.railInventoryEod)) {
      if (!ds.actuals) ds.actuals = {};
      ds.actuals.railInventoryEod = [];
    }
  };

  patchDataset(out.official);
  Object.values(out.sandboxes || {}).forEach(sb => patchDataset(sb?.data));

  out._version = 4;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export async function loadState() {
  try {
    // ── Try Firebase first ──
    const remote = await firebaseLoad();
    if (remote) {
      const v = remote._version || 0;
      let remoteState = remote;
      if (v < 3) remoteState = migrateV2V3(remote);
      if (v < 4) remoteState = migrateV3ToV4(remoteState);

      // Preserve local ui state if it exists — each computer navigates independently
      const localRaw = localStorage.getItem(STORAGE_KEY);
      if (localRaw) {
        try {
          const localState = JSON.parse(localRaw);
          if (localState.ui) remoteState.ui = localState.ui;
        } catch(e) {}
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(remoteState));
      return remoteState;
    }

    // ── Fall back to localStorage ──
    // ── Try v4 key first ──
    const raw4 = localStorage.getItem(STORAGE_KEY);
    if (raw4) {
      const parsed = JSON.parse(raw4);
      const railCount = parsed.official?.actuals?.railTransfers?.length || 0;
      console.log('📂 loadState - Loaded from localStorage. Rail transfers:', railCount);
      if (parsed._version === 4) return parsed;
      // Key exists but wrong version — migrate forward
      if (parsed._version === 3) {
        const v4 = migrateV3ToV4(parsed);
        saveState(v4, { silent: true });
        return v4;
      }
      // Even older data in v4 key — full chain
      const v3 = migrateV2V3(parsed);
      const v4 = migrateV3ToV4(v3);
      saveState(v4, { silent: true });
      return v4;
    }

    // ── Fall back to v3 key ──
    const raw3 = localStorage.getItem(LEGACY_KEY_V3);
    if (raw3) {
      const v3 = JSON.parse(raw3);
      const v4 = migrateV3ToV4(v3._version === 3 ? v3 : migrateV2V3(v3));
      saveState(v4, { silent: true });
      return v4;
    }

    // ── Fall back to v2 key ──
    const raw2 = localStorage.getItem(LEGACY_KEY_V2);
    if (raw2) {
      const v3 = migrateV2V3(JSON.parse(raw2));
      const v4 = migrateV3ToV4(v3);
      saveState(v4, { silent: true });
      return v4;
    }

    // ── Fresh install ──
    const s = seed();
    saveState(s, { silent: true });
    return s;

  } catch (err) {
    console.warn('loadState error — resetting to seed:', err);
    const s = seed();
    saveState(s, { silent: true });
    return s;
  }
}

export function saveState(state, { silent = false } = {}) {
  try {
    const stateJson = JSON.stringify(state);
    const railCount = state.official?.actuals?.railTransfers?.length || 0;
    console.log('💾 PERSIST - Writing to localStorage. Rail transfers in state:', railCount);
    localStorage.setItem(STORAGE_KEY, stateJson);
    console.log('✅ PERSIST - localStorage write successful');
  } catch (err) {
    console.error('❌ PERSIST - localStorage write FAILED:', err.message);
  }
  if (!silent) firebaseSave(state);
}

/**
 * Returns the active dataset (official or current sandbox).
 */
export function getDataset(state) {
  if (state.ui.mode === 'official') return state.official;
  const sid = state.ui.activeSandboxId || 'default';
  return state.sandboxes[sid]?.data || state.official;
}

export function setDataset(state, dataset) {
  if (state.ui.mode === 'official') { state.official = dataset; return; }
  const sid = state.ui.activeSandboxId || 'default';
  if (!state.sandboxes[sid]) {
    state.sandboxes[sid] = { name: 'Sandbox', createdAt: new Date().toISOString(), data: dataset };
  } else {
    state.sandboxes[sid].data = dataset;
  }
}

export function pushSandboxToOfficial(state) {
  state.official = JSON.parse(JSON.stringify(getDataset(state)));
}

// ── Sandbox management ──

export function createSandbox(state, name) {
  const id = `sb_${Math.random().toString(36).slice(2, 9)}`;
  state.sandboxes[id] = {
    name:      name || `Sandbox ${Object.keys(state.sandboxes).length + 1}`,
    createdAt: new Date().toISOString(),
    // Copy current official as starting point
    data:      JSON.parse(JSON.stringify(state.official)),
  };
  return id;
}

export function deleteSandbox(state, id) {
  if (id === 'default') return; // protect default
  delete state.sandboxes[id];
  if (state.ui.activeSandboxId === id) {
    state.ui.activeSandboxId = Object.keys(state.sandboxes)[0] || 'default';
  }
}

export function renameSandbox(state, id, name) {
  if (state.sandboxes[id]) state.sandboxes[id].name = name;
}

// ── Helper: derive category from familyId ──
// Used when building catalog items so category stays in sync with family choice.
export function categoryFromFamily(state, familyId) {
  const fam = (state.productFamilies || []).find(f => f.id === familyId);
  return fam?.category || 'FINISHED_PRODUCT';
}
