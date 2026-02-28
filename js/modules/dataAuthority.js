// ─────────────────────────────────────────────────────────────────────────────
// dataAuthority.js  —  Roll Panner · Selectors + Actions
// Version: 3  (multi-family catalog, customers, transfers, producers)
// ─────────────────────────────────────────────────────────────────────────────

import { getDataset, buildProductName, categoryFromFamily } from './store.js';

const uid  = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const slug = s => (s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

export const Categories = {
  RAW:  'RAW_MATERIAL',
  FUEL: 'FUEL',
  INT:  'INTERMEDIATE_PRODUCT',
  FIN:  'FINISHED_PRODUCT',
};

// ─────────────────────────────────────────────────────────────────────────────
// SCOPE RESOLUTION
// selectedFacilityIds can contain facilityId, subRegionId, regionId, countryId
// Returns flat list of resolved facility IDs
// ─────────────────────────────────────────────────────────────────────────────

export function resolveScope(state) {
  const org = state.org;

  const rawIds = state.ui.selectedFacilityIds?.length
    ? state.ui.selectedFacilityIds
    : state.ui.selectedFacilityId
      ? [state.ui.selectedFacilityId]
      : [];

  if (!rawIds.length) {
    return { type: 'none', facilityIds: [], regionId: null, subRegionId: null };
  }

  const allFacIds    = new Set();
  const regionIds    = new Set();
  const subRegionIds = new Set();

  rawIds.forEach(sel => {
    if (org.facilities.find(f => f.id === sel)) {
      allFacIds.add(sel);
      const fac = org.facilities.find(f => f.id === sel);
      const sr  = org.subRegions.find(s => s.id === fac.subRegionId);
      if (sr) {
        subRegionIds.add(sr.id);
        const r = org.regions.find(x => x.id === sr.regionId);
        if (r) regionIds.add(r.id);
      }
      return;
    }
    if (org.subRegions.find(s => s.id === sel)) {
      subRegionIds.add(sel);
      const sr  = org.subRegions.find(s => s.id === sel);
      const r   = org.regions.find(x => x.id === sr.regionId);
      if (r) regionIds.add(r.id);
      org.facilities.filter(f => f.subRegionId === sel).forEach(f => allFacIds.add(f.id));
      return;
    }
    if (org.regions.find(r => r.id === sel)) {
      regionIds.add(sel);
      const srIds = org.subRegions.filter(s => s.regionId === sel).map(s => s.id);
      srIds.forEach(sid => subRegionIds.add(sid));
      org.facilities.filter(f => srIds.includes(f.subRegionId)).forEach(f => allFacIds.add(f.id));
      return;
    }
    if (org.countries.find(c => c.id === sel)) {
      const rIds  = org.regions.filter(r => r.countryId === sel).map(r => r.id);
      rIds.forEach(rid => regionIds.add(rid));
      const srIds = org.subRegions.filter(s => rIds.includes(s.regionId)).map(s => s.id);
      srIds.forEach(sid => subRegionIds.add(sid));
      org.facilities.filter(f => srIds.includes(f.subRegionId)).forEach(f => allFacIds.add(f.id));
    }
  });

  const facilityIds = [...allFacIds];
  const type = facilityIds.length === 1 ? 'facility'
    : rawIds.every(id => org.facilities.find(f => f.id === id)) ? 'multi-facility'
    : rawIds.some(id => org.subRegions.find(s => s.id === id))  ? 'subregion'
    : rawIds.some(id => org.regions.find(r => r.id === id))     ? 'region'
    : 'country';

  const regionId    = regionIds.size    === 1 ? [...regionIds][0]    : (regionIds.size    > 1 ? [...regionIds][0]    : null);
  const subRegionId = subRegionIds.size === 1 ? [...subRegionIds][0] : null;

  return { type, facilityIds, regionId, subRegionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: get region ID for a specific facility
// ─────────────────────────────────────────────────────────────────────────────

function getFacRegionId(state, facId) {
  const fac = state.org.facilities.find(f => f.id === facId);
  if (!fac) return null;
  const sr = state.org.subRegions.find(s => s.id === fac.subRegionId);
  return sr ? sr.regionId : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECTORS
// ─────────────────────────────────────────────────────────────────────────────

export function selectors(state) {
  const ds    = getDataset(state);
  const scope = resolveScope(state);
  const { facilityIds, regionId } = scope;

  // Primary facility for single-facility operations (forms, recipes, etc.)
  const rawIds = state.ui.selectedFacilityIds?.length ? state.ui.selectedFacilityIds : [];
  const primaryFacId = facilityIds.length === 1
    ? facilityIds[0]
    : rawIds.find(id => state.org.facilities.find(f => f.id === id))
    || facilityIds[0]
    || null;

  // ── Catalog filtering ──
  const activatedIds = new Set(
    (ds.facilityProducts || [])
      .filter(fp => facilityIds.includes(fp.facilityId))
      .map(fp => fp.productId)
  );
  const regionMats = state.catalog.filter(m => !regionId || m.regionId === regionId);
  const mats = activatedIds.size > 0
    ? regionMats.filter(m => activatedIds.has(m.id))
    : regionMats;

  const equip = ds.equipment.filter(e => facilityIds.includes(e.facilityId));
  const stor  = ds.storages.filter(s => facilityIds.includes(s.facilityId));
  const caps  = ds.capabilities.filter(c => equip.some(e => e.id === c.equipmentId));

  // ── Reference table accessors ──
  const getFamily  = id => (state.productFamilies  || []).find(f => f.id === id);
  const getType    = id => (state.productTypes     || []).find(t => t.id === id);
  const getSubType = id => (state.productSubTypes  || []).find(s => s.id === id);
  const getProducer = id => (state.producers       || []).find(p => p.id === id);
  const getCustomer = id => (state.customers       || []).find(c => c.id === id);

  // ── Demand: actual shipment first, then forecast ──
  const demandForDateProduct = (date, pid) => {
    const actual = ds.actuals.shipments
      .filter(r => r.date === date && facilityIds.includes(r.facilityId) && r.productId === pid)
      .reduce((s, r) => s + (+r.qtyStn || 0), 0);
    if (actual > 0) return actual;
    return ds.demandForecast
      .filter(r => r.date === date && facilityIds.includes(r.facilityId) && r.productId === pid)
      .reduce((s, r) => s + (+r.qtyStn || 0), 0);
  };

  return {
    dataset:          ds,
    org:              state.org,
    catalog:          state.catalog,
    scope,
    facilityIds,
    isSingleFacility: facilityIds.length === 1,
    facility:         state.org.facilities.find(f => f.id === primaryFacId),
    facilities:       state.org.facilities,
    regionId,
    primaryFacId,

    // Materials in scope
    materials:        mats,
    regionCatalog:    regionMats,
    finishedProducts: mats.filter(m => m.category === Categories.FIN),
    intermediates:    mats.filter(m => m.category === Categories.INT),
    fuels:            mats.filter(m => m.category === Categories.FUEL),
    raws:             mats.filter(m => m.category === Categories.RAW),

    // Equipment & storage
    equipment:        equip,
    storages:         stor,
    capabilities:     caps,

    // Reference tables
    productFamilies:  state.productFamilies  || [],
    productTypes:     state.productTypes     || [],
    productSubTypes:  state.productSubTypes  || [],
    producers:        state.producers        || [],
    customers:        state.customers        || [],

    // Reference lookups
    getFamily,
    getType,
    getSubType,
    getProducer,
    getCustomer,

    // Cascade helpers for product form dropdowns
    typesForFamily:   familyId => (state.productTypes    || []).filter(t => t.familyId   === familyId),
    subTypesForType:  typeId   => (state.productSubTypes || []).filter(s => s.typeId     === typeId),

    // Facility-specific product activation
    getFacilityProducts: facId => {
      const ids = new Set(
        (ds.facilityProducts || [])
          .filter(fp => fp.facilityId === facId)
          .map(fp => fp.productId)
      );
      const rId = getFacRegionId(state, facId);
      const cat = state.catalog.filter(m => !rId || m.regionId === rId);
      return ids.size > 0 ? cat.filter(m => ids.has(m.id)) : cat;
    },

    // Lookups
    getMaterial:         id  => state.catalog.find(m => m.id === id),
    getMaterialByNumber: num => state.catalog.find(m =>
      (m.materialNumbers || []).some(mn => mn.number === String(num))
    ),
    getEquipment:        id  => ds.equipment.find(e => e.id === id),
    getStorage:          id  => ds.storages.find(s => s.id === id),
    getCapsForEquipment: eid => ds.capabilities.filter(c => c.equipmentId === eid),

    getRecipeForProduct: pid =>
      ds.recipes
        .filter(r => facilityIds.includes(r.facilityId) && r.productId === pid)
        .sort((a, b) => (b.version || 1) - (a.version || 1))[0] || null,

    // Actuals for a specific date + scope
    actualsForDate: date => ({
      inv:      ds.actuals.inventoryBOD.filter(r => r.date === date && facilityIds.includes(r.facilityId)),
      prod:     ds.actuals.production.filter(r => r.date === date && facilityIds.includes(r.facilityId)),
      ship:     ds.actuals.shipments.filter(r => r.date === date && facilityIds.includes(r.facilityId)),
      transfer: ds.actuals.transfers.filter(r =>
        r.date === date &&
        (facilityIds.includes(r.fromFacilityId) || facilityIds.includes(r.toFacilityId))
      ),
    }),

    demandForDateProduct,

    // Transfers for a facility on a date
    transfersForFacilityDate: (facId, date) => ({
      out: ds.actuals.transfers.filter(r => r.date === date && r.fromFacilityId === facId),
      in:  ds.actuals.transfers.filter(r => r.date === date && r.toFacilityId   === facId),
    }),

    // Org path helpers
    getCountry:    id => state.org.countries.find(c => c.id === id),
    getRegion:     id => state.org.regions.find(r => r.id === id),
    getSubRegion:  id => state.org.subRegions.find(s => s.id === id),
    getFacilityPath: id => {
      const f  = state.org.facilities.find(x => x.id === id);
      if (!f) return '';
      const sr = state.org.subRegions.find(x => x.id === f.subRegionId);
      const r  = sr ? state.org.regions.find(x => x.id === sr.regionId)   : null;
      const c  = r  ? state.org.countries.find(x => x.id === r.countryId) : null;
      return [c?.code, r?.code, sr?.code, f.code].filter(Boolean).join(' › ');
    },

    getScopeName: () => {
      // Use selectedFacilityIds first (new), fall back to legacy single id
      const ids = state.ui.selectedFacilityIds || [];
      if (ids.length === 1) {
        const sel = ids[0];
        const org = state.org;
        const f  = org.facilities.find(x => x.id === sel); if (f)  return f.name;
        const sr = org.subRegions.find(x => x.id === sel); if (sr) return sr.name;
        const r  = org.regions.find(x => x.id === sel);    if (r)  return r.name;
        const ct = org.countries.find(x => x.id === sel);  if (ct) return ct.name;
      }
      if (ids.length > 1) {
        return ids.map(id => {
          const org = state.org;
          return org.facilities.find(x => x.id === id)?.code
            || org.subRegions.find(x => x.id === id)?.code
            || org.regions.find(x => x.id === id)?.code
            || id;
        }).join(' + ');
      }
      return 'All';
    },

    // Sandbox helpers
    sandboxes:       state.sandboxes,
    activeSandboxId: state.ui.activeSandboxId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

export function actions(state) {
  const ds    = getDataset(state);
  const scope = resolveScope(state);

  // Primary facility for write operations
  const primaryFacId = scope.facilityIds.length === 1
    ? scope.facilityIds[0]
    : (state.ui.selectedFacilityIds || []).find(id => state.org.facilities.find(f => f.id === id))
    || scope.facilityIds[0]
    || null;

  const regionId = primaryFacId ? getFacRegionId(state, primaryFacId) : null;

  return {

    // ────────────────────────────────────────────────────────────────────────
    // PRODUCT REFERENCE TABLES
    // ────────────────────────────────────────────────────────────────────────

    // Families
    upsertFamily({ id, code, label, category }) {
      const row = { id: id || uid('fam'), code: code.toUpperCase(), label, category: category || 'FINISHED_PRODUCT' };
      const i   = (state.productFamilies || []).findIndex(f => f.id === row.id);
      if (!state.productFamilies) state.productFamilies = [];
      if (i >= 0) state.productFamilies[i] = row;
      else        state.productFamilies.push(row);
      return row;
    },
    deleteFamily(id) {
      // Cascade: delete types → subtypes → catalog items
      const typeIds = (state.productTypes || []).filter(t => t.familyId === id).map(t => t.id);
      typeIds.forEach(tid => this.deleteType(tid));
      state.productFamilies = (state.productFamilies || []).filter(f => f.id !== id);
    },

    // Types (scoped to a family)
    upsertType({ id, familyId, code, label }) {
      const row = { id: id || uid('type'), familyId, code: code.toUpperCase(), label };
      const i   = (state.productTypes || []).findIndex(t => t.id === row.id);
      if (!state.productTypes) state.productTypes = [];
      if (i >= 0) state.productTypes[i] = row;
      else        state.productTypes.push(row);
      return row;
    },
    deleteType(id) {
      const subIds = (state.productSubTypes || []).filter(s => s.typeId === id).map(s => s.id);
      subIds.forEach(sid => this.deleteSubType(sid));
      state.productTypes = (state.productTypes || []).filter(t => t.id !== id);
    },

    // Sub-types (scoped to a type)
    upsertSubType({ id, typeId, code, label }) {
      const row = { id: id || uid('sub'), typeId, code, label };
      const i   = (state.productSubTypes || []).findIndex(s => s.id === row.id);
      if (!state.productSubTypes) state.productSubTypes = [];
      if (i >= 0) state.productSubTypes[i] = row;
      else        state.productSubTypes.push(row);
      return row;
    },
    deleteSubType(id) {
      state.productSubTypes = (state.productSubTypes || []).filter(s => s.id !== id);
    },

    // ────────────────────────────────────────────────────────────────────────
    // PRODUCERS
    // { id, code, label, facilityId? }
    // facilityId → internal producer linked to a facility
    // facilityId null → external supplier
    // ────────────────────────────────────────────────────────────────────────

    upsertProducer({ id, code, label, facilityId }) {
      const row = { id: id || uid('prod'), code: (code || '').toUpperCase(), label, facilityId: facilityId || null };
      if (!state.producers) state.producers = [];
      const i = state.producers.findIndex(p => p.id === row.id);
      if (i >= 0) state.producers[i] = row;
      else        state.producers.push(row);
      // Auto-sync code with facility code when internal
      if (facilityId) {
        const fac = state.org.facilities.find(f => f.id === facilityId);
        if (fac && !row.code) row.code = fac.code;
      }
      return row;
    },
    deleteProducer(id) {
      state.producers = (state.producers || []).filter(p => p.id !== id);
      // Nullify producerId on catalog items
      state.catalog = state.catalog.map(m => m.producerId === id ? { ...m, producerId: null } : m);
    },

    // ────────────────────────────────────────────────────────────────────────
    // CUSTOMERS
    // { id, code, name, type: 'external'|'internal'|'both', facilityId? }
    // ────────────────────────────────────────────────────────────────────────

    upsertCustomer({ id, code, name, type, facilityId }) {
      const row = {
        id:         id || uid('cust'),
        code:       (code || '').toUpperCase(),
        name,
        type:       type || 'external',
        facilityId: facilityId || null,
      };
      if (!state.customers) state.customers = [];
      const i = state.customers.findIndex(c => c.id === row.id);
      if (i >= 0) state.customers[i] = row;
      else        state.customers.push(row);
      return row;
    },
    deleteCustomer(id) {
      state.customers = (state.customers || []).filter(c => c.id !== id);
      // Nullify customerId on shipments
      ds.actuals.shipments = ds.actuals.shipments.map(r =>
        r.customerId === id ? { ...r, customerId: null } : r
      );
    },

    // ────────────────────────────────────────────────────────────────────────
    // CATALOG (regional product definitions)
    // ────────────────────────────────────────────────────────────────────────

    upsertCatalogItem(m) {
      const rId = m.regionId || regionId;

      // Parse materialNumbers — accept:
      //   string[]  →  [{ number, source:'manual' }]
      //   object[]  →  kept as-is
      //   string    →  split by comma
      const parseMaterialNumbers = (raw) => {
        if (!raw) return [];
        if (Array.isArray(raw)) {
          return raw.map(mn => {
            if (typeof mn === 'string') return { number: mn.trim(), source: 'manual' };
            return { number: String(mn.number || mn).trim(), source: mn.source || 'manual', ...mn };
          }).filter(mn => mn.number);
        }
        if (typeof raw === 'string') {
          return raw.split(',').map(s => s.trim()).filter(Boolean)
            .map(n => ({ number: n, source: 'manual' }));
        }
        return [];
      };

      // Auto-derive category from family
      const category = m.category || categoryFromFamily(state, m.familyId);

      // Auto-generate name from attributes if not manually overridden
      const name = m.nameOverride
        ? m.nameOverride
        : buildProductName(state, { producerId: m.producerId, typeId: m.typeId, subTypeId: m.subTypeId });

      if (m.id) {
        const i = state.catalog.findIndex(x => x.id === m.id);
        if (i >= 0) {
          state.catalog[i] = {
            ...state.catalog[i],
            ...m,
            name,
            category,
            materialNumbers: parseMaterialNumbers(m.materialNumbers),
          };
          return state.catalog[i];
        }
      }

      // Build a stable, human-readable ID from producer + type + subtype
      const producer  = (state.producers     || []).find(p => p.id === m.producerId);
      const type      = (state.productTypes  || []).find(t => t.id === m.typeId);
      const subType   = (state.productSubTypes || []).find(s => s.id === m.subTypeId);
      const idParts   = [rId, producer?.code || 'EXT', type?.code, subType?.code].filter(Boolean);
      const id        = idParts.join('|');

      const row = {
        id,
        regionId:                  rId,
        producerId:                m.producerId    || null,
        familyId:                  m.familyId      || null,
        typeId:                    m.typeId        || null,
        subTypeId:                 m.subTypeId     || null,
        name,
        category,
        unit:                      m.unit          || 'STn',
        landedCostUsdPerStn:       +(m.landedCostUsdPerStn       || 0),
        calorificPowerMMBTUPerStn: +(m.calorificPowerMMBTUPerStn || 0),
        co2FactorKgPerMMBTU:       +(m.co2FactorKgPerMMBTU       || 0),
        materialNumbers:           parseMaterialNumbers(m.materialNumbers),
      };

      state.catalog.push(row);
      return row;
    },

    // Alias kept for backward compat
    upsertMaterial(m) { return this.upsertCatalogItem({ ...m, regionId: m.regionId || regionId }); },

    deleteCatalogItem(id) {
      state.catalog = state.catalog.filter(m => m.id !== id);
      // Cascade clean across all datasets (official + all sandboxes)
      const clean = data => {
        if (data.recipes)      data.recipes      = data.recipes.filter(r => r.productId !== id && !(r.components || []).some(c => c.materialId === id));
        if (data.capabilities) data.capabilities = data.capabilities.filter(c => c.productId !== id);
        if (data.storages)     data.storages      = data.storages.map(st => ({ ...st, allowedProductIds: (st.allowedProductIds || []).filter(p => p !== id) }));
        if (data.demandForecast) data.demandForecast = data.demandForecast.filter(r => r.productId !== id);
        if (data.campaigns)      data.campaigns      = data.campaigns.filter(r => r.productId !== id);
        if (data.actuals?.inventoryBOD) data.actuals.inventoryBOD = data.actuals.inventoryBOD.filter(r => r.productId !== id);
        if (data.actuals?.production)   data.actuals.production   = data.actuals.production.filter(r => r.productId !== id);
        if (data.actuals?.shipments)    data.actuals.shipments    = data.actuals.shipments.filter(r => r.productId !== id);
        if (data.actuals?.transfers)    data.actuals.transfers    = data.actuals.transfers.filter(r => r.productId !== id);
      };
      clean(state.official);
      Object.values(state.sandboxes || {}).forEach(sb => clean(sb.data || {}));
    },
    deleteMaterial(id) { return this.deleteCatalogItem(id); },

    // ── Add / remove material numbers on an existing catalog item ──
    addMaterialNumber(productId, { number, source, effectiveFrom, note }) {
      const i = state.catalog.findIndex(m => m.id === productId);
      if (i < 0) return;
      const nums = state.catalog[i].materialNumbers || [];
      if (!nums.find(mn => mn.number === String(number).trim())) {
        nums.push({ number: String(number).trim(), source: source || 'manual', effectiveFrom: effectiveFrom || null, note: note || null });
        state.catalog[i].materialNumbers = nums;
      }
    },
    removeMaterialNumber(productId, number) {
      const i = state.catalog.findIndex(m => m.id === productId);
      if (i < 0) return;
      state.catalog[i].materialNumbers = (state.catalog[i].materialNumbers || []).filter(mn => mn.number !== String(number));
    },

    // ────────────────────────────────────────────────────────────────────────
    // FACILITY PRODUCT ACTIVATION
    // ────────────────────────────────────────────────────────────────────────

    activateProductForFacility(facId, productId) {
      if (!ds.facilityProducts) ds.facilityProducts = [];
      if (!ds.facilityProducts.find(fp => fp.facilityId === facId && fp.productId === productId)) {
        ds.facilityProducts.push({ facilityId: facId, productId });
      }
    },
    deactivateProductForFacility(facId, productId) {
      if (ds.facilityProducts) {
        ds.facilityProducts = ds.facilityProducts.filter(fp => !(fp.facilityId === facId && fp.productId === productId));
      }
    },

    // ────────────────────────────────────────────────────────────────────────
    // ORG HIERARCHY
    // ────────────────────────────────────────────────────────────────────────

    addCountry({ name, code }) {
      const id = `country_${slug(code || name)}`;
      if (state.org.countries.some(c => c.id === id)) return id;
      state.org.countries.push({ id, name, code: slug(code || name) });
      return id;
    },
    updateCountry({ id, name, code }) {
      const i = state.org.countries.findIndex(c => c.id === id);
      if (i >= 0) state.org.countries[i] = { ...state.org.countries[i], name, code };
    },
    deleteCountry(id) {
      state.org.regions.filter(r => r.countryId === id).forEach(r => this.deleteRegion(r.id));
      state.org.countries = state.org.countries.filter(c => c.id !== id);
    },

    addRegion({ countryId, name, code }) {
      const id = `region_${slug(code || name)}`;
      if (state.org.regions.some(r => r.id === id)) return id;
      state.org.regions.push({ id, countryId, name, code: slug(code || name) });
      return id;
    },
    updateRegion({ id, name, code }) {
      const i = state.org.regions.findIndex(r => r.id === id);
      if (i >= 0) state.org.regions[i] = { ...state.org.regions[i], name, code };
    },
    deleteRegion(id) {
      state.org.subRegions.filter(s => s.regionId === id).forEach(s => this.deleteSubRegion(s.id));
      state.org.regions  = state.org.regions.filter(r => r.id !== id);
      state.catalog      = state.catalog.filter(m => m.regionId !== id);
    },

    addSubRegion({ regionId, name, code }) {
      const id = `subregion_${slug(code || name)}`;
      if (state.org.subRegions.some(s => s.id === id)) return id;
      state.org.subRegions.push({ id, regionId, name, code: slug(code || name) });
      return id;
    },
    updateSubRegion({ id, name, code }) {
      const i = state.org.subRegions.findIndex(s => s.id === id);
      if (i >= 0) state.org.subRegions[i] = { ...state.org.subRegions[i], name, code };
    },
    deleteSubRegion(id) {
      state.org.facilities.filter(f => f.subRegionId === id).forEach(f => this.deleteFacility(f.id));
      state.org.subRegions = state.org.subRegions.filter(s => s.id !== id);
    },

    addFacility({ subRegionId, name, code, facilityType = 'terminal' }) {
      const id = slug(code || name);
      if (state.org.facilities.some(f => f.id === id)) return id;
      state.org.facilities.push({ id, subRegionId, name, code: slug(code || name), facilityType });
      return id;
    },
    updateFacility({ id, name, code, facilityType }) {
      const i = state.org.facilities.findIndex(f => f.id === id);
      if (i >= 0) state.org.facilities[i] = { ...state.org.facilities[i], name, code, ...(facilityType ? { facilityType } : {}) };
    },
    deleteFacility(id) {
      state.org.facilities = state.org.facilities.filter(f => f.id !== id);
      const clean = data => {
        ['equipment', 'storages', 'capabilities', 'demandForecast', 'campaigns', 'recipes', 'facilityProducts'].forEach(k => {
          if (data[k]) data[k] = data[k].filter(r => r.facilityId !== id);
        });
        if (data.actuals) {
          ['inventoryBOD', 'production', 'shipments'].forEach(k => {
            if (data.actuals[k]) data.actuals[k] = data.actuals[k].filter(r => r.facilityId !== id);
          });
          if (data.actuals.transfers) {
            data.actuals.transfers = data.actuals.transfers.filter(r =>
              r.fromFacilityId !== id && r.toFacilityId !== id
            );
          }
        }
      };
      clean(state.official);
      Object.values(state.sandboxes || {}).forEach(sb => clean(sb.data || {}));
    },

    // ────────────────────────────────────────────────────────────────────────
    // RECIPES
    // ────────────────────────────────────────────────────────────────────────

    saveRecipe({ productId, version = 1, components, effectiveStart = '', effectiveEnd = '' }) {
      const prod = state.catalog.find(m => m.id === productId);
      const rid  = `${primaryFacId}|${prod?.name || productId}|v${version}`;
      const row  = {
        id: rid,
        facilityId: primaryFacId,
        productId,
        version: +version,
        effectiveStart,
        effectiveEnd,
        components: components
          .filter(c => c.materialId && c.pct > 0)
          .map(c => ({ materialId: c.materialId, pct: +c.pct })),
      };
      const idx = ds.recipes.findIndex(r => r.id === rid);
      if (idx >= 0) ds.recipes[idx] = row; else ds.recipes.push(row);
      return row;
    },
    deleteRecipe(recipeId) {
      ds.recipes = ds.recipes.filter(r => !(r.id === recipeId && r.facilityId === primaryFacId));
    },

    // ────────────────────────────────────────────────────────────────────────
    // EQUIPMENT
    // ────────────────────────────────────────────────────────────────────────

    upsertEquipment({ id, name, type }) {
      const prefix  = type === 'kiln' ? 'K' : type === 'finish_mill' ? 'FM' : type === 'raw_mill' ? 'RM' : 'EQ';
      const n       = (name || '').trim() || `${prefix}${1 + ds.equipment.filter(e => e.facilityId === primaryFacId && e.type === type).length}`;
      const nextId  = id || `${primaryFacId}_${slug(n)}`;
      const row     = { id: nextId, facilityId: primaryFacId, name: n, type };
      const i       = ds.equipment.findIndex(e => e.id === nextId);
      if (i >= 0) ds.equipment[i] = row; else ds.equipment.push(row);
      return row;
    },
    deleteEquipment(equipmentId) {
      ds.equipment     = ds.equipment.filter(e => !(e.id === equipmentId && e.facilityId === primaryFacId));
      ds.capabilities  = ds.capabilities.filter(c => c.equipmentId !== equipmentId);
      ds.actuals.production = ds.actuals.production.filter(r => !(r.facilityId === primaryFacId && r.equipmentId === equipmentId));
      ds.campaigns     = ds.campaigns.filter(r => !(r.facilityId === primaryFacId && r.equipmentId === equipmentId));
    },

    // ────────────────────────────────────────────────────────────────────────
    // STORAGES
    // ────────────────────────────────────────────────────────────────────────

    upsertStorage({ id, name, categoryHint, allowedProductIds = [], maxCapacityStn }) {
      const nextId = id || `${primaryFacId}_${slug(name)}`;
      const row    = {
        id: nextId,
        facilityId: primaryFacId,
        name,
        categoryHint,
        allowedProductIds: [...allowedProductIds],
        maxCapacityStn: +(maxCapacityStn || 0),
      };
      const i = ds.storages.findIndex(s => s.id === nextId);
      if (i >= 0) ds.storages[i] = row; else ds.storages.push(row);
      return row;
    },
    deleteStorage(storageId) {
      ds.storages = ds.storages.filter(st => !(st.id === storageId && st.facilityId === primaryFacId));
      ds.actuals.inventoryBOD = ds.actuals.inventoryBOD.filter(r => !(r.facilityId === primaryFacId && r.storageId === storageId));
    },

    // ────────────────────────────────────────────────────────────────────────
    // CAPABILITIES
    // ────────────────────────────────────────────────────────────────────────

    upsertCapability({ equipmentId, productId, maxRateStpd, electricKwhPerStn, thermalMMBTUPerStn }) {
      const id  = `${equipmentId}|${productId}`;
      const row = {
        id,
        equipmentId,
        productId,
        maxRateStpd:         +(maxRateStpd         || 0),
        electricKwhPerStn:   +(electricKwhPerStn   || 0),
        thermalMMBTUPerStn:  +(thermalMMBTUPerStn  || 0),
      };
      const i = ds.capabilities.findIndex(c => c.id === id);
      if (i >= 0) ds.capabilities[i] = row; else ds.capabilities.push(row);
    },
    deleteCapability(capabilityId) {
      ds.capabilities = ds.capabilities.filter(c => c.id !== capabilityId);
    },

    // ────────────────────────────────────────────────────────────────────────
    // ACTUALS  — Physical BOD inventory count
    // ────────────────────────────────────────────────────────────────────────

    saveDailyActuals({ date, facilityId, inventoryRows, productionRows, shipmentRows }) {
      const fid = facilityId || primaryFacId;
      // Clear existing actuals for this date + facility
      ds.actuals.inventoryBOD = ds.actuals.inventoryBOD.filter(r => !(r.date === date && r.facilityId === fid));
      ds.actuals.production   = ds.actuals.production.filter(r =>   !(r.date === date && r.facilityId === fid));
      ds.actuals.shipments    = ds.actuals.shipments.filter(r =>    !(r.date === date && r.facilityId === fid));

      // Physical BOD overrides
      inventoryRows
        .filter(r => r.storageId && r.productId && isFinite(r.qtyStn))
        .forEach(r => ds.actuals.inventoryBOD.push({
          date, facilityId: fid, storageId: r.storageId, productId: r.productId, qtyStn: +r.qtyStn
        }));

      // Production actuals
      productionRows
        .filter(r => r.equipmentId && r.productId && isFinite(r.qtyStn) && +r.qtyStn !== 0)
        .forEach(r => ds.actuals.production.push({
          date, facilityId: fid, equipmentId: r.equipmentId, productId: r.productId, qtyStn: +r.qtyStn
        }));

      // Shipment actuals
      shipmentRows
        .filter(r => r.productId && isFinite(r.qtyStn) && +r.qtyStn !== 0)
        .forEach(r => ds.actuals.shipments.push({
          date,
          facilityId:     fid,
          productId:      r.productId,
          qtyStn:         +r.qtyStn,
          customerId:     r.customerId     || null,
          deliveryTerms:  r.deliveryTerms  || 'FOB',
          materialNumber: r.materialNumber || null,
        }));
    },

    // ────────────────────────────────────────────────────────────────────────
    // ACTUALS  — Transfers (plant-to-plant)
    // ────────────────────────────────────────────────────────────────────────

    saveTransfer({ date, fromFacilityId, toFacilityId, productId, qtyStn, materialNumber, notes }) {
      if (!date || !fromFacilityId || !toFacilityId || !productId) return;
      // Replace any existing transfer for same date+from+to+product
      ds.actuals.transfers = ds.actuals.transfers.filter(r =>
        !(r.date === date && r.fromFacilityId === fromFacilityId && r.toFacilityId === toFacilityId && r.productId === productId)
      );
      ds.actuals.transfers.push({
        date,
        fromFacilityId,
        toFacilityId,
        productId,
        qtyStn:         +qtyStn || 0,
        materialNumber: materialNumber || null,
        notes:          notes          || null,
      });
    },
    deleteTransfer({ date, fromFacilityId, toFacilityId, productId }) {
      ds.actuals.transfers = ds.actuals.transfers.filter(r =>
        !(r.date === date && r.fromFacilityId === fromFacilityId && r.toFacilityId === toFacilityId && r.productId === productId)
      );
    },

    // ────────────────────────────────────────────────────────────────────────
    // DEMAND FORECAST
    // ────────────────────────────────────────────────────────────────────────

    saveDemandForecastRows(rows) {
      rows.forEach(r => {
        const key = `${r.date}|${primaryFacId}|${r.productId}`;
        ds.demandForecast = ds.demandForecast.filter(x => `${x.date}|${x.facilityId}|${x.productId}` !== key);
        ds.demandForecast.push({
          date:       r.date,
          facilityId: primaryFacId,
          productId:  r.productId,
          customerId: r.customerId || null,
          qtyStn:     +r.qtyStn,
          source:     'forecast',
        });
      });
    },

    // ────────────────────────────────────────────────────────────────────────
    // CAMPAIGNS
    // ────────────────────────────────────────────────────────────────────────

    saveCampaignRows(rows) {
      rows.forEach(r => {
        const key = `${r.date}|${primaryFacId}|${r.equipmentId}`;
        ds.campaigns = ds.campaigns.filter(x => `${x.date}|${x.facilityId}|${x.equipmentId}` !== key);
        const status = r.status || ((r.productId && (+r.rateStn || 0) > 0) ? 'produce' : 'idle');
        ds.campaigns.push({
          date:        r.date,
          facilityId:  primaryFacId,
          equipmentId: r.equipmentId,
          productId:   r.productId || '',
          rateStn:     +r.rateStn  || 0,
          status,
        });
      });
    },
    saveCampaignBlock({ equipmentId, status = 'produce', productId = '', startDate, endDate, rateStn = 0 }) {
      if (!equipmentId || !startDate || !endDate) return;
      const rows = [];
      let d      = new Date(startDate + 'T00:00:00');
      const end  = new Date(endDate   + 'T00:00:00');
      while (d <= end) {
        rows.push({
          date:        d.toISOString().slice(0, 10),
          equipmentId,
          status,
          productId:   status === 'produce' ? productId : '',
          rateStn:     status === 'produce' ? (+rateStn || 0) : 0,
        });
        d.setDate(d.getDate() + 1);
      }
      this.saveCampaignRows(rows);
    },
    deleteCampaignRange({ equipmentId, startDate, endDate }) {
      if (!equipmentId || !startDate || !endDate) return;
      ds.campaigns = ds.campaigns.filter(c =>
        !(c.facilityId === primaryFacId && c.equipmentId === equipmentId && c.date >= startDate && c.date <= endDate)
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGISTICS SELECTORS
// Read-only helpers that work against state.logistics (shared) and
// ds.logisticsSchedule (sandboxed).  No mutation here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return all Rules of Engagement, optionally filtered by facilityId and/or productId.
 */
export function getRulesOfEngagement(state, { facilityId, productId } = {}) {
  const rules = state.logistics?.rulesOfEngagement || [];
  return rules.filter(r =>
    (!facilityId || r.facilityId === facilityId) &&
    (!productId  || r.productId  === productId)
  );
}

/**
 * Return the single Rule of Engagement for a facility+product pair, or null.
 * This is what the agent calls first before making any recommendation.
 */
export function getRuleForFacilityProduct(state, facilityId, productId) {
  return (state.logistics?.rulesOfEngagement || []).find(
    r => r.facilityId === facilityId && r.productId === productId
  ) || null;
}

/**
 * Return all transport lanes, optionally filtered by toFacilityId or mode.
 */
export function getLanes(state, { toFacilityId, mode, isPrimary } = {}) {
  const lanes = state.logistics?.lanes || [];
  return lanes.filter(l =>
    (toFacilityId === undefined || l.toFacilityId === toFacilityId) &&
    (mode         === undefined || l.mode         === mode)         &&
    (isPrimary    === undefined || l.isPrimary     === isPrimary)
  );
}

/**
 * Return primary lane(s) that supply a given facility.
 * Multiple lanes can be primary if different modes supply the same terminal
 * (e.g. SUTT gets both rail and vessel).
 */
export function getPrimaryLanes(state, toFacilityId) {
  return getLanes(state, { toFacilityId, isPrimary: true });
}

/**
 * Return logistics schedule entries from the active dataset.
 * Filtered by status, laneId, or facilityId (destination).
 */
export function getScheduleEntries(state, { status, laneId, toFacilityId, mode } = {}) {
  const ds      = getDataset(state);
  const entries = ds.logisticsSchedule || [];
  const lanes   = state.logistics?.lanes || [];

  return entries.filter(e => {
    if (status      && e.status  !== status)  return false;
    if (laneId      && e.laneId  !== laneId)  return false;
    if (mode        && e.mode    !== mode)    return false;
    if (toFacilityId) {
      // Resolve via lane
      const lane = lanes.find(l => l.id === e.laneId);
      if (!lane || lane.toFacilityId !== toFacilityId) return false;
    }
    return true;
  });
}

/**
 * Return schedule entries arriving within a date window (inclusive).
 * Used by the simulation to project future inventory from confirmed movements.
 */
export function getScheduleInWindow(state, fromDate, toDate, { status = ['confirmed','arrived'] } = {}) {
  const ds      = getDataset(state);
  const entries = ds.logisticsSchedule || [];
  const statusSet = new Set(Array.isArray(status) ? status : [status]);
  return entries.filter(e =>
    statusSet.has(e.status) &&
    e.arrivalDateExpected >= fromDate &&
    e.arrivalDateExpected <= toDate
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGISTICS ACTIONS
// All mutations go through here — keeps core-app.js clean.
// ─────────────────────────────────────────────────────────────────────────────

const logUid = () => `log_${Math.random().toString(36).slice(2, 9)}`;

/**
 * Upsert a Rule of Engagement.
 * Pass id to update an existing rule, omit to create new.
 */
export function upsertRuleOfEngagement(state, {
  id,
  facilityId,
  productId,
  minCoverDays,
  tradingLeadTimeDays,
  standardVolumeStn,
  priorityRank = null,
  notes = '',
}) {
  if (!facilityId || !productId) throw new Error('facilityId and productId are required');

  const rules  = state.logistics.rulesOfEngagement;
  const now    = new Date().toISOString();
  const ruleId = id || logUid();

  const row = {
    id:                  ruleId,
    facilityId,
    productId,
    minCoverDays:        +(minCoverDays        || 0),
    tradingLeadTimeDays: +(tradingLeadTimeDays || 0),
    standardVolumeStn:   +(standardVolumeStn   || 0),
    priorityRank:        priorityRank !== null ? +priorityRank : null,
    notes:               notes || '',
    updatedAt:           now,
  };

  const idx = rules.findIndex(r => r.id === ruleId);
  if (idx >= 0) rules[idx] = row;
  else          rules.push(row);

  return row;
}

/**
 * Delete a Rule of Engagement by id.
 */
export function deleteRuleOfEngagement(state, id) {
  if (!state.logistics?.rulesOfEngagement) return;
  state.logistics.rulesOfEngagement = state.logistics.rulesOfEngagement.filter(r => r.id !== id);
}

/**
 * Upsert a Transport Lane.
 * fromFacilityId may be null for overseas/external origins — use fromName instead.
 */
export function upsertLane(state, {
  id,
  fromFacilityId = null,
  fromName,
  toFacilityId,
  mode,                       // 'vessel' | 'rail' | 'truck'
  transitDays,
  isPrimary = true,
  scheduleFrequencyDays = null,
  notes = '',
}) {
  if (!toFacilityId)                           throw new Error('toFacilityId is required');
  if (!['vessel','rail','truck'].includes(mode)) throw new Error('mode must be vessel | rail | truck');

  const lanes  = state.logistics.lanes;
  const laneId = id || logUid();

  const row = {
    id:                    laneId,
    fromFacilityId:        fromFacilityId || null,
    fromName:              fromName || '',
    toFacilityId,
    mode,
    transitDays:           +(transitDays || 0),
    isPrimary:             !!isPrimary,
    scheduleFrequencyDays: scheduleFrequencyDays ? +scheduleFrequencyDays : null,
    notes:                 notes || '',
  };

  const idx = lanes.findIndex(l => l.id === laneId);
  if (idx >= 0) lanes[idx] = row;
  else          lanes.push(row);

  return row;
}

/**
 * Delete a Transport Lane.
 * Note: does NOT delete schedule entries on this lane — caller decides.
 */
export function deleteLane(state, id) {
  if (!state.logistics?.lanes) return;
  state.logistics.lanes = state.logistics.lanes.filter(l => l.id !== id);
}

/**
 * Upsert a logistics schedule entry in the active dataset.
 * Status flow:  needed → confirmed → arrived
 *                                  ↘ cancelled (from any status)
 *
 * createdBy: 'agent' when the agent proposes it, 'user' when manually entered.
 */
export function upsertScheduleEntry(state, {
  id,
  laneId,
  mode,
  originName,
  vesselName = null,
  productId,
  volumeStn,
  departureDateExpected = null,
  arrivalDateExpected,
  status = 'needed',
  notes = '',
  createdBy = 'user',
}) {
  if (!laneId)               throw new Error('laneId is required');
  if (!arrivalDateExpected)  throw new Error('arrivalDateExpected is required');
  if (!['vessel','rail','truck'].includes(mode))
    throw new Error('mode must be vessel | rail | truck');
  if (!['needed','confirmed','arrived','cancelled'].includes(status))
    throw new Error('invalid status');

  const ds      = getDataset(state);
  if (!Array.isArray(ds.logisticsSchedule)) ds.logisticsSchedule = [];

  const now     = new Date().toISOString();
  const entryId = id || logUid();

  const existing = ds.logisticsSchedule.find(e => e.id === entryId);

  const row = {
    id:                   entryId,
    laneId,
    mode,
    originName:           originName || '',
    vesselName:           vesselName || null,
    productId:            productId  || null,
    volumeStn:            +(volumeStn || 0),
    departureDateExpected: departureDateExpected || null,
    arrivalDateExpected,
    status,
    notes:                notes || '',
    createdBy,
    createdAt:            existing?.createdAt || now,
    updatedAt:            now,
  };

  const idx = ds.logisticsSchedule.findIndex(e => e.id === entryId);
  if (idx >= 0) ds.logisticsSchedule[idx] = row;
  else          ds.logisticsSchedule.push(row);

  return row;
}

/**
 * Update only the status of a schedule entry.
 * Clean shorthand for the common human approval flow: needed → confirmed.
 */
export function updateScheduleStatus(state, id, status) {
  if (!['needed','confirmed','arrived','cancelled'].includes(status))
    throw new Error('invalid status');

  const ds  = getDataset(state);
  const idx = (ds.logisticsSchedule || []).findIndex(e => e.id === id);
  if (idx < 0) return null;

  ds.logisticsSchedule[idx] = {
    ...ds.logisticsSchedule[idx],
    status,
    updatedAt: new Date().toISOString(),
  };

  return ds.logisticsSchedule[idx];
}

/**
 * Delete a schedule entry.
 */
export function deleteScheduleEntry(state, id) {
  const ds = getDataset(state);
  if (!Array.isArray(ds.logisticsSchedule)) return;
  ds.logisticsSchedule = ds.logisticsSchedule.filter(e => e.id !== id);
}
