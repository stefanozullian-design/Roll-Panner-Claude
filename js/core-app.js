import { loadState, saveState, pushSandboxToOfficial, createSandbox, deleteSandbox, renameSandbox } from './modules/store.js';
import { actions, selectors, Categories } from './modules/dataAuthority.js';
import { buildProductionPlanView, yesterdayLocal, startOfMonth } from './modules/simEngine.js';

let state = loadState();

// Two-level nav: top sections + sub-tabs
const NAV = [
  { key:'supply',    label:'Supply', subs:[
    { key:'products', label:'⚙ Products' },
    { key:'flow',     label:'🔄 Process' },
    { key:'plan',     label:'📊 Plan' },
  ]},
  { key:'demand',    label:'Demand', subs:[
    { key:'demand-external', label:'📤 External' },
    { key:'demand-internal', label:'🔁 Internal' },
    { key:'demand-total',    label:'∑ Total' },
  ]},
  { key:'logistics', label:'Logistics', subs:[
    { key:'logistics-shipments', label:'🚢 Shipments',  placeholder:true },
    { key:'logistics-imports',   label:'📦 Imports',    placeholder:true },
    { key:'logistics-transfers', label:'🔀 Transfers',  placeholder:true },
  ]},
];
// Flat list of all tab keys for panel toggling
const ALL_TAB_KEYS = NAV.flatMap(s=>s.subs.map(t=>t.key));
// Map tab key → parent section key
const TAB_PARENT = {};
NAV.forEach(s=>s.subs.forEach(t=>TAB_PARENT[t.key]=s.key));

const el = id => document.getElementById(id);

/* ─────────────────── MONTH-COLLAPSE SPINE ─────────────────── */
// Build full date spine: Jan 2025 → Dec 2027
const SPINE_START = '2025-01-01';
const SPINE_END   = '2027-12-31';

function buildFullSpine(){
  const dates = [];
  let d = new Date(SPINE_START+'T00:00:00');
  const end = new Date(SPINE_END+'T00:00:00');
  while(d <= end){ dates.push(d.toISOString().slice(0,10)); d.setDate(d.getDate()+1); }
  return dates;
}

// Group dates by month → [{ym:'2024-01', label:'Jan 2024', dates:[...]}]
function groupByMonth(dates){
  const months = {};
  dates.forEach(d => {
    const ym = d.slice(0,7);
    if(!months[ym]) months[ym] = { ym, label: new Date(d+'T00:00:00').toLocaleString('en-US',{month:'short',year:'numeric'}), dates:[] };
    months[ym].dates.push(d);
  });
  return Object.values(months);
}

// Persist collapse state: collapsed months stored as Set of 'YYYY-MM'
const COLLAPSE_KEY = 'cementPlannerCollapsedMonths';
function loadCollapsedMonths(){
  try{ return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY)||'null')||[]); }
  catch(e){ return new Set(); }
}
function saveCollapsedMonths(set){
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
}
// Default: all months collapsed except current and next
function defaultCollapsedMonths(allMonths){
  const now = new Date();
  const thisYM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const nextD = new Date(now); nextD.setMonth(nextD.getMonth()+1);
  const nextYM = `${nextD.getFullYear()}-${String(nextD.getMonth()+1).padStart(2,'0')}`;
  const set = new Set(allMonths.map(m=>m.ym));
  set.delete(thisYM); set.delete(nextYM);
  return set;
}

// Build <style> tag content to hide day columns for collapsed months
// Each day column has class `day-col-YYYY-MM`
function buildCollapseStyle(collapsedSet){
  if(!collapsedSet.size) return '';
  return [...collapsedSet].map(ym => `.day-col-${ym.replace('-','-')} { display:none; }`).join('\n');
}

// Inject/update the collapse style tag
function applyCollapseStyle(tableId, collapsedSet){
  const styleId = `col-style-${tableId}`;
  let styleEl = document.getElementById(styleId);
  if(!styleEl){ styleEl = document.createElement('style'); styleEl.id = styleId; document.head.appendChild(styleEl); }
  styleEl.textContent = buildCollapseStyle(collapsedSet);
}

// Toggle a month and persist
function toggleMonth(ym, tableId){
  const set = loadCollapsedMonths();
  if(set.has(ym)) set.delete(ym); else set.add(ym);
  saveCollapsedMonths(set);
  applyCollapseStyle(tableId, set);
  // Update chevron on all tables with this month header
  document.querySelectorAll(`[data-month-toggle="${ym}"]`).forEach(btn => {
    btn.textContent = set.has(ym) ? '▶' : '▼';
  });
}
const esc = s => (s??'').toString().replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n||0).toLocaleString(undefined, {maximumFractionDigits:1});
const fmt0 = n => Number(n||0).toLocaleString(undefined, {maximumFractionDigits:0});
const dateRange = (start, days) => { const a=[]; let d=new Date(start+'T00:00:00'); for(let i=0;i<days;i++){a.push(d.toISOString().slice(0,10)); d.setDate(d.getDate()+1);} return a; };
const today = () => new Date().toISOString().slice(0,10);

function persist(){ saveState(state); }

/* ─────────────────── SHELL ─────────────────── */
function initShell(){
  const s = selectors(state);

  // Top nav
  const activeSection = TAB_PARENT[state.ui.activeTab] || NAV[0].key;
  el('navTop').innerHTML = NAV.map(s =>
    `<button class="nav-top-btn${activeSection===s.key?' active':''}" data-section="${s.key}">${s.label}</button>`
  ).join('');
  el('navTop').onclick = e => {
    const btn = e.target.closest('[data-section]'); if(!btn) return;
    const sec = NAV.find(s=>s.key===btn.dataset.section); if(!sec) return;
    // Navigate to first non-placeholder sub
    const firstSub = sec.subs.find(t=>!t.placeholder) || sec.subs[0];
    state.ui.activeTab = firstSub.key; persist(); render();
  };

  // Sub nav — show subs for active section
  const activeSec = NAV.find(s=>s.key===activeSection) || NAV[0];
  el('navSub').innerHTML = activeSec.subs.map(t =>
    `<button class="nav-sub-btn${state.ui.activeTab===t.key?' active':''}${t.placeholder?' placeholder':''}" data-tab="${t.key}"${t.placeholder?' title="Coming soon"':''}>${t.label}${t.placeholder?' <span style=\'font-size:9px;opacity:0.5\'>(soon)</span>':''}</button>`
  ).join('');
  el('navSub').onclick = e => {
    const btn = e.target.closest('[data-tab]'); if(!btn) return;
    const tabKey = btn.dataset.tab;
    const sub = activeSec.subs.find(t=>t.key===tabKey);
    if(sub?.placeholder) return; // ignore clicks on placeholders
    state.ui.activeTab = tabKey; persist(); render();
  };

  // ── Scope selector — 4 cascading dropdowns with multi-select checkboxes ──
  const org = state.org;

  // Ensure selectedFacilityIds is always an array in state
  if(!state.ui.selectedFacilityIds) {
    state.ui.selectedFacilityIds = state.ui.selectedFacilityId ? [state.ui.selectedFacilityId] : [];
    if(!state.ui.selectedFacilityIds.length && org.facilities.length) {
      state.ui.selectedFacilityIds = [org.facilities[0].id];
    }
  }
  // Keep legacy selectedFacilityId in sync (first selected facility or first sub/region/country)
  const syncLegacyId = () => {
    const ids = state.ui.selectedFacilityIds || [];
    if(ids.length === 1) {
      // Check if it's a facility, subregion, region or country
      state.ui.selectedFacilityId = ids[0];
    } else if(ids.length > 1) {
      // Find common parent or keep first
      state.ui.selectedFacilityId = ids[0];
    } else {
      state.ui.selectedFacilityId = org.facilities[0]?.id || '';
    }
  };

  const scopeWrap = el('scopeSelectorWrap') || (() => {
    // Fallback: replace old facilitySelector select with a div
    const old = el('facilitySelector');
    if(old) {
      const div = document.createElement('div');
      div.id = 'scopeSelectorWrap';
      div.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
      old.parentNode.replaceChild(div, old);
      return div;
    }
    return null;
  })();

  const buildScopeUI = () => {
    if(!scopeWrap) return;
    const selIds = new Set(state.ui.selectedFacilityIds || []);

    // Derive selected countries/regions/subregions from selected facility ids
    const selectedFacIds    = [...selIds].filter(id => org.facilities.find(f=>f.id===id));
    const selectedSubIds    = [...selIds].filter(id => org.subRegions.find(s=>s.id===id));
    const selectedRegIds    = [...selIds].filter(id => org.regions.find(r=>r.id===id));
    const selectedCntIds    = [...selIds].filter(id => org.countries.find(c=>c.id===id));

    // Filter cascades based on what's selected above
    const activeCntIds  = org.countries.map(c=>c.id);
    const activeRegIds  = selectedCntIds.length
      ? org.regions.filter(r=>selectedCntIds.includes(r.countryId)).map(r=>r.id)
      : org.regions.map(r=>r.id);
    const activeSubIds  = selectedRegIds.length
      ? org.subRegions.filter(s=>selectedRegIds.includes(s.regionId)).map(s=>s.id)
      : selectedCntIds.length
        ? org.subRegions.filter(s=>activeRegIds.includes(s.regionId)).map(s=>s.id)
        : org.subRegions.map(s=>s.id);
    const activeFacIds  = selectedSubIds.length
      ? org.facilities.filter(f=>selectedSubIds.includes(f.subRegionId)).map(f=>f.id)
      : selectedRegIds.length
        ? org.facilities.filter(f=>activeSubIds.includes(f.subRegionId)).map(f=>f.id)
        : selectedCntIds.length
          ? org.facilities.filter(f=>activeSubIds.includes(f.subRegionId)).map(f=>f.id)
          : org.facilities.map(f=>f.id);

    const mkDropdown = (id, placeholder, items, selectedSet) => {
      if(!items.length) return `<div style="display:none"></div>`;
      const allChecked = items.every(it=>selectedSet.has(it.id));
      const selectAllRow = `<label style="display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;white-space:nowrap;font-size:11px;font-weight:700;border-bottom:1px solid var(--border);color:var(--text)" data-scope-all="${id}">
        <input type="checkbox" ${allChecked?'checked':''} data-scope-all-cb="${id}" style="accent-color:var(--accent);width:12px;height:12px">
        Select All
      </label>`;
      const opts = items.map(it =>
        `<label style="display:flex;align-items:center;gap:6px;padding:4px 10px;cursor:pointer;white-space:nowrap;font-size:11px;${selectedSet.has(it.id)?'color:var(--accent);background:rgba(99,179,237,0.08)':''}" data-scope-item="${it.id}">
          <input type="checkbox" ${selectedSet.has(it.id)?'checked':''} data-scope-cb="${it.id}" style="accent-color:var(--accent);width:12px;height:12px">
          ${esc(it.label)}
        </label>`
      ).join('');
      const anySelected = items.some(it=>selectedSet.has(it.id));
      const selCount = items.filter(it=>selectedSet.has(it.id)).length;
      return `<div style="position:relative;display:inline-block">
        <button class="scope-dd-btn" data-dd="${id}" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11px;color:${anySelected?'var(--accent)':'var(--muted)'};cursor:pointer;white-space:nowrap;min-width:80px;display:flex;align-items:center;gap:4px">
          ${placeholder}${anySelected?` <span style="background:var(--accent);color:#000;border-radius:10px;padding:0 5px;font-size:9px;font-weight:700">${selCount}</span>`:''}
          <span style="font-size:8px;margin-left:2px">▼</span>
        </button>
        <div class="scope-dd-menu" id="dd-${id}" style="display:none;position:absolute;top:100%;left:0;z-index:200;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:4px 0;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-height:280px;overflow-y:auto;margin-top:2px">
          ${selectAllRow}${opts}
        </div>
      </div>`;
    };

    const cntItems  = org.countries.map(c=>({id:c.id, label:`🌎 ${c.name}`}));
    const regItems  = org.regions.filter(r=>activeRegIds.includes(r.id)).map(r=>({id:r.id, label:`📍 ${r.code} — ${r.name}`}));
    const subItems  = org.subRegions.filter(s=>activeSubIds.includes(s.id)).map(s=>({id:s.id, label:`▸ ${s.code} — ${s.name}`}));
    const facItems  = org.facilities.filter(f=>activeFacIds.includes(f.id)).map(f=>({id:f.id, label:`🏭 ${f.code} — ${f.name}`}));

    scopeWrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${mkDropdown('cnt', 'Country', cntItems, new Set(selectedCntIds))}
        ${mkDropdown('reg', 'Region', regItems, new Set(selectedRegIds))}
        ${mkDropdown('sub', 'Sub-Region', subItems, new Set(selectedSubIds))}
        ${mkDropdown('fac', 'Facility', facItems, new Set(selectedFacIds))}
        ${selIds.size ? `<button id="scopeClearBtn" style="background:transparent;border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:10px;color:var(--muted);cursor:pointer">✕ Clear</button>` : ''}
        <span style="font-size:10px;color:var(--muted);padding:0 4px">${selIds.size ? `${selIds.size} selected` : 'Select scope'}</span>
      </div>`;

    // Track if selection changed while dropdown was open
    let _scopeChanged = false;

    const closeAllMenus = () => {
      scopeWrap.querySelectorAll('.scope-dd-menu').forEach(m => {
        if(m.style.display !== 'none'){
          m.style.display = 'none';
          if(_scopeChanged){
            _scopeChanged = false;
            syncLegacyId();
            persist();
            buildScopeUI();
            render();
          }
        }
      });
    };

    // Dropdown open/close — keep open while user clicks inside
    scopeWrap.querySelectorAll('.scope-dd-btn').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const ddId = 'dd-' + btn.dataset.dd;
        const menu = document.getElementById(ddId);
        const isOpen = menu.style.display !== 'none';
        // Close other menus (and trigger render if they had changes)
        scopeWrap.querySelectorAll('.scope-dd-menu').forEach(m => {
          if(m.id !== ddId && m.style.display !== 'none'){
            m.style.display = 'none';
            if(_scopeChanged){
              _scopeChanged = false;
              syncLegacyId(); persist(); buildScopeUI(); render();
            }
          }
        });
        menu.style.display = isOpen ? 'none' : 'block';
        if(isOpen && _scopeChanged){
          _scopeChanged = false;
          syncLegacyId(); persist(); buildScopeUI(); render();
        }
      };
    });

    // Prevent clicks inside dropdown from closing it
    scopeWrap.querySelectorAll('.scope-dd-menu').forEach(menu => {
      menu.addEventListener('click', e => e.stopPropagation());
    });

    // Checkbox change — just update state, don't render yet
    scopeWrap.querySelectorAll('[data-scope-cb]').forEach(cb => {
      cb.onchange = () => {
        const id = cb.dataset.scopeCb;
        const ids = new Set(state.ui.selectedFacilityIds || []);
        if(cb.checked) ids.add(id); else ids.delete(id);
        state.ui.selectedFacilityIds = [...ids];
        _scopeChanged = true;
        // Update visual state of this checkbox's label without full rebuild
        const label = cb.closest('label');
        if(label){
          label.style.color = cb.checked ? 'var(--accent)' : '';
          label.style.background = cb.checked ? 'rgba(99,179,237,0.08)' : '';
        }
        // Update Select All checkbox for this group
        const menu = cb.closest('.scope-dd-menu');
        if(menu){
          const allCbs = [...menu.querySelectorAll('[data-scope-cb]')];
          const allCheckedNow = allCbs.every(c=>c.checked);
          const allCb = menu.querySelector('[data-scope-all-cb]');
          if(allCb) allCb.checked = allCheckedNow;
        }
      };
    });

    // Select All checkbox
    scopeWrap.querySelectorAll('[data-scope-all-cb]').forEach(allCb => {
      allCb.onchange = () => {
        const menu = allCb.closest('.scope-dd-menu');
        if(!menu) return;
        const cbs = [...menu.querySelectorAll('[data-scope-cb]')];
        const ids = new Set(state.ui.selectedFacilityIds || []);
        cbs.forEach(cb => {
          cb.checked = allCb.checked;
          const label = cb.closest('label');
          if(label){
            label.style.color = allCb.checked ? 'var(--accent)' : '';
            label.style.background = allCb.checked ? 'rgba(99,179,237,0.08)' : '';
          }
          if(allCb.checked) ids.add(cb.dataset.scopeCb);
          else ids.delete(cb.dataset.scopeCb);
        });
        state.ui.selectedFacilityIds = [...ids];
        _scopeChanged = true;
      };
    });

    // Clear button
    scopeWrap.querySelector('#scopeClearBtn')?.addEventListener('click', e => {
      e.stopPropagation();
      state.ui.selectedFacilityIds = [];
      _scopeChanged = false;
      syncLegacyId();
      persist(); buildScopeUI(); render();
    });

    // Close dropdowns on outside click — triggers render if changed
    document.addEventListener('click', closeAllMenus, { once: true });
  };

  if(scopeWrap) {
    if(!org.countries.length && !org.facilities.length) {
      scopeWrap.innerHTML = `<span style="font-size:11px;color:var(--muted)">— Set up facilities in ⚙ Settings —</span>`;
    } else {
      buildScopeUI();
    }
  }

  // Mode badge
  const badge = el('modeBadge');
  const isSandbox = state.ui.mode === 'sandbox';
  const sbName = isSandbox ? (state.sandboxes[state.ui.activeSandboxId]?.name || 'Sandbox') : '';
  badge.textContent = isSandbox ? `SANDBOX: ${sbName}` : 'OFFICIAL';
  badge.className = 'mode-badge ' + (isSandbox ? 'mode-sandbox' : 'mode-official');
  badge.onclick = () => { state.ui.mode = isSandbox ? 'official' : 'sandbox'; persist(); render(); };

  el('sandboxBtn').onclick = () => openSandboxDialog();
  el('settingsBtn').onclick = () => openSettingsDialog();
  el('dataIOBtn').onclick = () => openDataIODialog();

  el('pushOfficialBtn').onclick = () => {
    if(!confirm('Push current sandbox to Official? This overwrites the Official data.')) return;
    pushSandboxToOfficial(state); persist();
    showToast('Pushed to Official ✓', 'ok');
    render();
  };
}

/* ─────────────────── TOAST ─────────────────── */
function showToast(msg, type='ok'){
  let t = el('toast');
  if(!t){ t = document.createElement('div'); t.id='toast'; t.style.cssText='position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 16px;border-radius:8px;font-size:12px;font-weight:600;transition:opacity .3s;pointer-events:none;'; document.body.appendChild(t); }
  t.textContent = msg;
  t.style.background = type==='ok' ? 'var(--ok-bg)' : type==='warn' ? 'var(--warn-bg)' : 'var(--danger-bg)';
  t.style.border = `1px solid ${type==='ok'?'var(--ok)':type==='warn'?'var(--warn)':'var(--danger)'}`;
  t.style.color = type==='ok' ? '#86efac' : type==='warn' ? '#fcd34d' : '#fca5a5';
  t.style.opacity='1';
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>{ t.style.opacity='0'; }, 2500);
}

/* ─────────────────── RENDER ─────────────────── */
function render(){
  initShell();
  ALL_TAB_KEYS.forEach(k=>{
    const p = el(`tab-${k}`);
    if(p) p.classList.toggle('active', k===state.ui.activeTab);
  });
  const t = state.ui.activeTab;
  if(t==='plan')             renderPlan();
  else if(t==='products')    renderProducts();
  else if(t==='flow')        renderFlow();
  else if(t==='demand-external' || t==='demand-internal' || t==='demand-total') renderDemand('total');
  else if(t==='logistics-shipments'||t==='logistics-imports'||t==='logistics-transfers') renderLogisticsPlaceholder(t);
}

/* ─────────────────── PLAN TAB ─────────────────── */
function renderPlan(){
  const root = el('tab-plan');
  if(!root) return;
  try {
  const s = selectors(state);
  const todayStr = today();

  // Full 3-year spine
  const allDates = buildFullSpine();
  const months   = groupByMonth(allDates);
  let collapsed = loadCollapsedMonths();
  if(collapsed.size === 0){ collapsed = defaultCollapsedMonths(months); saveCollapsedMonths(collapsed); }
  // Note: applyCollapseStyle is called after root.innerHTML is set below

  const plan = buildProductionPlanView(state, SPINE_START, allDates.length);

  const allAlerts = Object.entries(plan.alertSummary||{})
    .flatMap(([date,arr])=>(arr||[]).map(a=>({...a,date})));
  const stockouts = allAlerts.filter(a=>a.severity==='stockout');
  const overflows = allAlerts.filter(a=>a.severity==='full');
  const warnings  = allAlerts.filter(a=>a.warn && a.severity!=='stockout' && a.severity!=='full');
  let firstStockout = stockouts.length ? stockouts.reduce((min,a)=>a.date<min?a.date:min, stockouts[0].date) : null;
  const daysUntilStockout = firstStockout ? Math.max(0, Math.round((new Date(firstStockout)-new Date(todayStr))/86400000)) : null;

  const kpiHTML = `<div class="kpi-row">
    <div class="kpi-card ${stockouts.length?'kpi-danger':'kpi-ok'}">
      <div class="kpi-label">🚨 Stockout Alerts</div>
      <div class="kpi-value" style="color:${stockouts.length?'var(--danger)':'var(--ok)'}">${stockouts.length}</div>
      <div class="kpi-sub">${stockouts.length?'in 2025-2027 horizon':'None detected ✓'}</div>
    </div>
    ${daysUntilStockout!==null?`<div class="kpi-card kpi-danger">
      <div class="kpi-label">⏱ First Stockout</div>
      <div class="kpi-value" style="color:var(--warn)">${daysUntilStockout}d</div>
      <div class="kpi-sub">${firstStockout?.slice(5)} · ${stockouts[0]?.storageName||''}</div>
    </div>`:''}
    <div class="kpi-card ${overflows.length?'kpi-warn':'kpi-neutral'}">
      <div class="kpi-label">⚠ Capacity Breaches</div>
      <div class="kpi-value" style="color:${overflows.length?'var(--warn)':'var(--muted)'}">${overflows.length}</div>
      <div class="kpi-sub">Storage overflow events</div>
    </div>
    <div class="kpi-card kpi-neutral">
      <div class="kpi-label">📦 Finished Products</div>
      <div class="kpi-value">${s.finishedProducts.length}</div>
      <div class="kpi-sub">${s.finishedProducts.map(p=>p.code||p.name.slice(0,8)).join(', ')||'—'}</div>
    </div>
    <div class="kpi-card kpi-neutral">
      <div class="kpi-label">🏭 Equipment</div>
      <div class="kpi-value">${s.equipment.length}</div>
      <div class="kpi-sub">${s.equipment.filter(e=>e.type==='kiln').length} kilns · ${s.equipment.filter(e=>e.type==='finish_mill').length} mills</div>
    </div>
  </div>`;

  // Group consecutive alerts by storage+severity into date ranges
  const groupAlerts = (alerts) => {
    if(!alerts.length) return [];
    const sorted = [...alerts].sort((a,b)=>a.storageId.localeCompare(b.storageId)||a.date.localeCompare(b.date));
    const groups = [];
    sorted.forEach(a => {
      const last = groups[groups.length-1];
      const prevD = last ? new Date(last.endDate+'T00:00:00') : null;
      if(prevD) prevD.setDate(prevD.getDate()+1);
      if(last && last.storageId===a.storageId && last.severity===a.severity && prevD && prevD.toISOString().slice(0,10)===a.date){
        last.endDate = a.date; last.days++;
      } else {
        groups.push({storageId:a.storageId, storageName:a.storageName, severity:a.severity, startDate:a.date, endDate:a.date, days:1});
      }
    });
    return groups;
  };

  const stockoutGroups = groupAlerts(stockouts);
  const overflowGroups = groupAlerts(overflows);
  const warningGroups  = groupAlerts(warnings).slice(0,6);

  const makeChip = (g, cls, icon, label) => {
    const range = g.days>1 ? `${g.startDate.slice(5)}→${g.endDate.slice(5)} (${g.days}d)` : g.startDate.slice(5);
    return `<div class="alert-chip ${cls}" data-jump-date="${g.startDate}" style="cursor:pointer" title="Click to jump to ${g.startDate}">${icon} ${range} ${esc(g.storageName)} — ${label}</div>`;
  };

  const alertChips = [
    ...stockoutGroups.map(g => makeChip(g,'chip-stockout','🔴','STOCKOUT')),
    ...overflowGroups.map(g => makeChip(g,'chip-full','🟡','FULL')),
    ...warningGroups.map(g  => makeChip(g,'chip-high','△','>75%'))
  ].join('');

  const _alertKey = 'planAlertStripCollapsed';
  const _alertCollapsed = localStorage.getItem(_alertKey) === '1';
  const totalAlertCount = stockouts.length+overflows.length+warnings.length;
  const alertStripHTML = totalAlertCount>0
    ? `<div id="alertStrip" style="margin-bottom:16px;background:linear-gradient(135deg,rgba(239,68,68,0.08),rgba(245,158,11,0.05));border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:10px 16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none" id="alertStripToggle">
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--danger);">
            ⚡ Action Required
            <span style="font-weight:400;color:var(--muted);text-transform:none;letter-spacing:0;margin-left:8px">
              ${stockouts.length} stockout${stockouts.length!==1?'s':''} · ${overflows.length} overflow${overflows.length!==1?'s':''} · ${warnings.length} warning${warnings.length!==1?'s':''}
            </span>
          </div>
          <span id="alertStripCaret" style="font-size:11px;color:var(--muted);transition:transform .2s;display:inline-block;transform:${_alertCollapsed?'rotate(-90deg)':'rotate(0deg)'}">▼</span>
        </div>
        <div id="alertStripBody" style="display:${_alertCollapsed?'none':'block'};margin-top:8px">
          <div style="font-size:10px;color:var(--muted);margin-bottom:6px">· click any alert to jump to that date</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${alertChips}</div>
        </div>
      </div>`
    : `<div style="margin-bottom:16px;padding:10px 14px;background:var(--ok-bg);border:1px solid rgba(34,197,94,0.3);border-radius:8px;font-size:12px;color:#86efac;">✅ <strong>All clear</strong> — No stockouts or capacity issues in the planning horizon.</div>`;

  const productColor = pid => {
    const base = ['#3b82f6','#a78bfa','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316','#84cc16'];
    let h=0; (pid||'').split('').forEach(c=>h=(h*31+c.charCodeAt(0))>>>0);
    return base[h%base.length];
  };
  const isWeekendDate = d => [0,6].includes(new Date(d+'T00:00:00').getDay());
  const wkdColStyle = 'background:rgba(239,68,68,0.06);border-left:1px solid rgba(239,68,68,0.3);';

  // Build unified row list from all 4 sections
  // Filter production rows: skip subtotal+children if no equipment rows exist for that group
  const filterProductionRows = (rows) => {
    const out = [];
    let i = 0;
    while(i < rows.length){
      const r = rows[i];
      if(r.kind === 'subtotal'){
        const children = [];
        let j = i + 1;
        while(j < rows.length && rows[j].kind === 'row') { children.push(rows[j]); j++; }
        const hasEquipment = children.some(c => c.rowType === 'equipment');
        if(hasEquipment){
          out.push(r);
          children.forEach(c => out.push(c));
        }
        i = j;
      } else {
        out.push(r);
        i++;
      }
    }
    return out;
  };

  const SECTIONS = [
    { id:'bod',  title:'INV.-BOD (STn)', rows: plan.inventoryBODRows  },
    { id:'prod', title:'PROD. (STn/day)',      rows: filterProductionRows(plan.productionRows) },
    { id:'out',  title:'SHIP. (STn)', rows: (() => {
      // Rebuild outflow rows grouped by facility, only customer shipments
      // Collect all shipment rows from simEngine output
      const allShipRows = [];
      let inCustShip = false;
      for(const r of (plan.outflowRows||[])){
        if(r.kind==='group')      inCustShip = /CUSTOMER SHIP/i.test(r.label||'');
        else if(r.kind==='subtotal') inCustShip = false;
        else if(r.kind==='row' && inCustShip) allShipRows.push(r);
      }

      // Group by facility: for each selected facility that has finished products,
      // emit a facility group header then its product rows
      const facIds = (state.ui.selectedFacilityIds||[]).length ? state.ui.selectedFacilityIds : state.org.facilities.map(f=>f.id);
      const rows = [];
      facIds.forEach(facId => {
        const fac = state.org.facilities.find(f=>f.id===facId);
        if(!fac) return;
        const facProdIds = new Set(
          (s.dataset.facilityProducts||[])
            .filter(fp=>fp.facilityId===facId)
            .map(fp=>fp.productId)
        );
        // match shipRows to this facility's products
        // Match shipRows by productId (if present) or by material name lookup
        const facRows = allShipRows.filter(r => {
          if(r.productId) return facProdIds.has(r.productId);
          // simEngine doesn't attach productId — match by material name
          return [...facProdIds].some(pid => {
            const mat = s.getMaterial(pid);
            return mat && (r.label === mat.name || r.productLabel === mat.name);
          });
        });
        if(!facRows.length) return; // skip facilities with no finished products
        rows.push({ kind:'group', label: fac.code ? `${fac.code} — ${fac.name}` : fac.name });
        facRows.forEach(r => rows.push(r));
      });

      // Fallback: if grouping found nothing, show flat list
      if(!rows.length) allShipRows.forEach(r => rows.push(r));
      return rows;
    })() },
    { id:'eod',  title:'INV.-EOD (STn)',               rows: plan.inventoryEODRows   },
  ];
  const unifiedRows = [];
  let subCounter = 0;
  SECTIONS.forEach(sec => {
    unifiedRows.push({ _type:'section-header', _secId:sec.id, label:sec.title });
    let currentSubId = null;
    sec.rows.forEach(r => {
      if(r.kind==='group'){
        unifiedRows.push({ _type:'group-label', _secId:sec.id, label:r.label });
        currentSubId = null;
        return;
      }
      if(r.kind==='subtotal'){
        const subId = `sub_${subCounter++}`;
        currentSubId = subId;
        unifiedRows.push({ ...r, _type:'subtotal-header', _secId:sec.id, _subId:subId });
        return;
      }
      unifiedRows.push({ ...r, _type:'child', _secId:sec.id, _subId:currentSubId });
    });
  });

  // Month-grouped date headers
  const dateHeaders = months.map(mon => {
    const isCol = collapsed.has(mon.ym);
    const monthTh = `<th class="month-total-th" data-month-ym="${mon.ym}" style="min-width:64px;background:rgba(99,179,237,0.12);border-left:2px solid rgba(99,179,237,0.35);border-right:1px solid rgba(99,179,237,0.2);font-size:9px;font-weight:700;color:#93c5fd;text-align:center;cursor:pointer;user-select:none;white-space:nowrap;padding:3px 6px;" title="Click to toggle ${mon.label}"><span data-month-toggle="${mon.ym}" style="font-size:8px;margin-right:3px">${isCol?'▶':'▼'}</span>${mon.label}</th>`;
    const dayThs = mon.dates.map(d => {
      const isWk = isWeekendDate(d); const isTd = d===todayStr;
      const dd2 = d.slice(8,10);
      let sty = isWk ? wkdColStyle : '';
      if(isTd) sty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);';
      return `<th data-date="${d}" class="day-col-${mon.ym}" style="min-width:64px;width:64px;${sty}font-size:9px;${isWk?'color:rgba(239,68,68,0.65)':isTd?'color:var(--accent)':''}">` + dd2 + `</th>`;
    }).join('');
    return monthTh + dayThs;
  }).join('');

  // Month total cell for plan table
  const renderMonthTotalCell = (r, mon) => {
    if(r._type==='section-header' || r._type==='group-label') return '';
    const total = mon.dates.reduce((sum, d) => sum + (r.values?.[d]||0), 0);
    if(r.rowType==='equipment'){
      return `<td class="num" style="background:rgba(99,179,237,0.1);border-left:2px solid rgba(99,179,237,0.3);font-size:10px;font-weight:700;color:#93c5fd">${total?fmt0(total):''}</td>`;
    }
    const sev = r.storageId ? (() => {
      const hasStockout = mon.dates.some(d => plan.inventoryCellMeta?.[`${d}|${r.storageId}`]?.severity==='stockout');
      const hasFull     = mon.dates.some(d => plan.inventoryCellMeta?.[`${d}|${r.storageId}`]?.severity==='full');
      return hasStockout ? 'stockout' : hasFull ? 'full' : null;
    })() : null;
    let sty = 'background:rgba(99,179,237,0.1);border-left:2px solid rgba(99,179,237,0.3);font-size:10px;font-weight:700;color:#93c5fd;';
    if(sev==='stockout') sty = 'background:rgba(239,68,68,0.2);border-left:2px solid rgba(239,68,68,0.5);font-size:10px;font-weight:700;color:#fca5a5;';
    else if(sev==='full') sty = 'background:rgba(245,158,11,0.2);border-left:2px solid rgba(245,158,11,0.5);font-size:10px;font-weight:700;color:#fcd34d;';
    return `<td class="num" style="${sty}">${total?fmt0(total):''}</td>`;
  };

  // Day cell renderer for a single date
  const renderDayCell = (r, d, mon) => {
    const isWk = isWeekendDate(d); const isTd = d===todayStr;
    const isSubtotal = r._type==='subtotal-header';
    const v = r.values?.[d]||0;
    let baseSty = isWk ? wkdColStyle : '';
    if(isTd) baseSty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);';
    const cls = `day-col-${mon.ym}`;
    if(r.rowType==='equipment' && r.equipmentId){
      const meta = plan.equipmentCellMeta?.[`${d}|${r.equipmentId}`];
      const status = meta?.status || 'idle';
      if(status==='maintenance') return `<td class="num ${cls}" style="${baseSty}background:rgba(245,158,11,0.2);border-left:2px solid rgba(245,158,11,0.6);font-size:9px;color:#fcd34d;font-style:italic;">MNT</td>`;
      if(status==='out_of_order') return `<td class="num ${cls}" style="${baseSty}background:rgba(139,92,246,0.2);border-left:2px solid rgba(139,92,246,0.6);font-size:9px;color:#c4b5fd;">OOO</td>`;
      if(!meta || status==='idle'){
        const caps = s.getCapsForEquipment(r.equipmentId);
        const hasStockout = caps.some(cap => s.dataset.storages.filter(st=>(st.allowedProductIds||[]).includes(cap.productId)&&st.facilityId===state.ui.selectedFacilityId).some(st=>plan.inventoryCellMeta?.[`${d}|${st.id}`]?.severity==='stockout'));
        return hasStockout ? `<td class="num ${cls}" style="${baseSty}background:rgba(239,68,68,0.18);border-left:2px solid rgba(239,68,68,0.5);font-size:9px;color:#fca5a5;">IDL</td>`
          : `<td class="num ${cls}" style="${baseSty}color:var(--muted);font-size:10px"></td>`;
      }
      const color = productColor(meta.productId);
      const capped = meta.constraint?.type==='capped';
      const isActual = meta.source==='actual';
      const tip = `${isActual?'✓ Actual':'Plan'}: ${(meta.totalQty||0).toFixed(0)} STn${meta.productId?' · '+(s.getMaterial(meta.productId)?.code||meta.productId):''}${capped?' ⚠ '+meta.constraint.reason:''}`;
      return `<td class="num ${cls}" style="${baseSty}background:${color}18;border-left:2px solid ${color}40;font-size:10px;" title="${esc(tip)}">${fmt0(v)}${isActual?`<span style="color:${color}80;font-size:8px"> ✓</span>`:''}${capped?'<span style="color:var(--warn);font-size:8px"> ⚠</span>':''}</td>`;
    }
    if(r.storageId){
      const imeta = plan.inventoryCellMeta?.[`${d}|${r.storageId}`];
      if(imeta){
        const tip = imeta.reason||(imeta.warn==='high75'?`>75% capacity (${fmt0(imeta.eod)}/${fmt0(imeta.maxCap)})`:'');
        if(imeta.severity==='stockout') baseSty += 'background:rgba(239,68,68,0.18);color:#fca5a5;font-weight:700;';
        else if(imeta.severity==='full') baseSty += 'background:rgba(245,158,11,0.18);color:#fcd34d;font-weight:700;';
        else if(imeta.warn==='high75')   baseSty += 'color:var(--warn);';
        const dot = imeta.severity==='stockout'?'🔴 ':imeta.severity==='full'?'🟡 ':imeta.warn?'△ ':'';
        return `<td class="num ${cls}" style="${baseSty}font-size:10px${isSubtotal?';font-weight:700':''}" title="${esc(tip)}">${dot}${fmt0(v)}</td>`;
      }
    }
    return `<td class="num ${cls}" style="${baseSty}font-size:10px;${isSubtotal?'font-weight:700;':'color:var(--muted);'}">${v?fmt0(v):''}</td>`;
  };

  // Full month-grouped renderer — replaces renderDataCells in row building
  const renderAllCells = r => {
    if(r._type==='section-header' || r._type==='group-label') return '';
    return months.map(mon => renderMonthTotalCell(r, mon) + mon.dates.map(d => renderDayCell(r, d, mon)).join('')).join('');
  };

  // Cell renderer
  const renderDataCells = r => plan.dates.map(d => {
    const isWk = isWeekendDate(d); const isTd = d===todayStr;
    const isSubtotal = r._type==='subtotal-header';
    const v = r.values?.[d]||0;
    let baseSty = isWk ? wkdColStyle : '';
    if(isTd) baseSty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);';

    if(r.rowType==='equipment' && r.equipmentId){
      const meta = plan.equipmentCellMeta?.[`${d}|${r.equipmentId}`];
      const status = meta?.status || 'idle';

      // Maintenance (planned) — amber
      if(status==='maintenance'){
        return `<td class="num" style="${baseSty}background:rgba(245,158,11,0.2);border-left:2px solid rgba(245,158,11,0.6);font-size:9px;color:#fcd34d;font-style:italic;" title="Planned maintenance">MNT</td>`;
      }

      // Out of order (unplanned) — purple
      if(status==='out_of_order'){
        return `<td class="num" style="${baseSty}background:rgba(139,92,246,0.2);border-left:2px solid rgba(139,92,246,0.6);font-size:9px;color:#c4b5fd;" title="Out of order (unplanned)">OOO</td>`;
      }

      // Idle — check if any product this equipment can make has a stockout today
      if(!meta || status==='idle'){
        const caps = s.getCapsForEquipment(r.equipmentId);
        const hasStockout = caps.some(cap => {
          const linkedStorages = s.dataset.storages.filter(st =>
            (st.allowedProductIds||[]).includes(cap.productId) && st.facilityId===state.ui.selectedFacilityId
          );
          return linkedStorages.some(st => plan.inventoryCellMeta?.[`${d}|${st.id}`]?.severity==='stockout');
        });
        if(hasStockout){
          return `<td class="num" style="${baseSty}background:rgba(239,68,68,0.18);border-left:2px solid rgba(239,68,68,0.5);font-size:9px;color:#fca5a5;" title="Idle while product in stockout">IDL</td>`;
        }
        return `<td class="num" style="${baseSty}color:var(--muted);font-size:10px"></td>`;
      }

      // Producing — colored band by product
      const color = productColor(meta.productId);
      const capped = meta.constraint?.type==='capped';
      const isActual = meta.source==='actual';
      const tip = `${isActual?'✓ Actual':'Plan'}: ${(meta.totalQty||0).toFixed(0)} STn${meta.productId?' · '+(s.getMaterial(meta.productId)?.code||meta.productId):''}${capped?' ⚠ '+meta.constraint.reason:''}`;
      return `<td class="num" style="${baseSty}background:${color}18;border-left:2px solid ${color}40;font-size:10px;" title="${esc(tip)}">${fmt0(v)}${isActual?`<span style="color:${color}80;font-size:8px"> ✓</span>`:''}${capped?'<span style="color:var(--warn);font-size:8px"> ⚠</span>':''}</td>`;
    }
    if(r.storageId){
      const imeta = plan.inventoryCellMeta?.[`${d}|${r.storageId}`];
      if(imeta){
        const tip = imeta.reason||(imeta.warn==='high75'?`>75% capacity (${fmt0(imeta.eod)}/${fmt0(imeta.maxCap)})`:'');
        if(imeta.severity==='stockout')    baseSty += 'background:rgba(239,68,68,0.18);color:#fca5a5;font-weight:700;';
        else if(imeta.severity==='full')   baseSty += 'background:rgba(245,158,11,0.18);color:#fcd34d;font-weight:700;';
        else if(imeta.warn==='high75')     baseSty += 'color:var(--warn);';
        const dot = imeta.severity==='stockout'?'🔴 ':imeta.severity==='full'?'🟡 ':imeta.warn?'△ ':'';
        return `<td class="num" style="${baseSty}font-size:10px${isSubtotal?';font-weight:700':''}" title="${esc(tip)}">${dot}${fmt0(v)}</td>`;
      }
    }
    return `<td class="num" style="${baseSty}font-size:10px;${isSubtotal?'font-weight:700;':'color:var(--muted);'}">${v?fmt0(v):''}</td>`;
  }).join('');

  // Build HTML rows
  const tableRows = unifiedRows.map(r => {
    if(r._type==='section-header'){
      return `<tr class="plan-section-collapse" data-sec="${r._secId}" style="cursor:pointer;user-select:none;">
        <td colspan="${1+plan.dates.length}" style="background:#0a0d14;border:1px solid var(--border);padding:5px 10px;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);">
          <span class="collapse-icon" data-sec="${r._secId}" style="margin-right:6px;display:inline-block;transition:transform .15s;">▶</span>${esc(r.label)}
        </td></tr>`;
    }
    if(r._type==='group-label'){
      return `<tr class="sec-child sec-${r._secId}" style="display:none;">
        <td colspan="${1+plan.dates.length}" style="background:rgba(255,255,255,0.015);border:1px solid var(--border);padding:4px 10px 4px 22px;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);">${esc(r.label)}</td>
      </tr>`;
    }
    if(r._type==='subtotal-header'){
      return `<tr class="plan-sub-collapse sec-child sec-${r._secId}" data-sub="${r._subId}" style="cursor:pointer;user-select:none;display:none;">
        <td class="row-header" style="position:sticky;left:0;z-index:3;background:rgba(15,20,30,0.97);font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text);padding-left:14px;" title="${esc(r.productLabel||r.label)}">
          <span class="collapse-icon sub-icon" data-sub="${r._subId}" style="margin-right:5px;display:inline-block;transition:transform .15s;font-size:9px;">▶</span>${esc(r.label)}
        </td>${renderAllCells(r)}</tr>`;
    }
    return `<tr class="sec-child sec-${r._secId}${r._subId?' sub-child sub-'+r._subId:''}" style="display:none;">
      <td class="row-header" style="position:sticky;left:0;z-index:3;background:rgba(10,13,20,0.97);font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--text);padding-left:${r._subId?'26px':'14px'};" title="${esc(r.productLabel||r.label)}">${esc(r.label)}</td>
      ${renderAllCells(r)}</tr>`;
  }).join('');

  root.innerHTML = `
  ${kpiHTML}
  ${alertStripHTML}
  <div class="card" style="margin-bottom:16px">
    <div class="card-header">
      <div>
        <div class="card-title">📊 Production Plan — 2025–2027</div>
        <div class="card-sub text-muted" style="font-size:11px">3-year view · All months collapsed by default · click month header to expand · ▶ click rows to expand · ✓ = actual · ⚠ = constrained · pink cols = weekends</div>
      </div>
      <div class="flex gap-2">
        <button class="btn" id="jumpTodayPlan">📅 Today</button>
        <button class="btn" id="openCampaigns">🎯 Campaigns</button>
        <button class="btn btn-primary" id="openActuals">📝 Daily Actuals</button>
      </div>
    </div>
    <div class="card-body" style="padding:0">
      ${s.equipment.length===0?'<div style="padding:40px;text-align:center;color:var(--muted)">No equipment configured. Set up your Process Flow first.</div>':''}
      <div class="table-scroll" id="planTableScroll" style="overflow-x:auto;overflow-y:auto">
        <table class="data-table plan-table" id="planTable" style="min-width:max-content;width:100%">
          <thead><tr>
            <th class="row-header" style="min-width:160px;position:sticky;left:0;background:#0a0d14;z-index:5;">Row</th>
            ${dateHeaders}
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
  </div>
  <div style="font-size:11px;color:var(--muted);padding:4px 0 16px">
    🔴 Stockout · 🟡 Overflow · △ &gt;75% cap · Colored = producing · <span style="color:#fca5a5">■ IDL</span> = idle/stockout · <span style="color:#fcd34d">■ MNT</span> = maintenance · <span style="color:#c4b5fd">■ OOO</span> = out of order · Pink = weekend
  </div>`;

  // Apply month collapse CSS after DOM is ready
  applyCollapseStyle('planTable', collapsed);

  // Delegated collapse handler on tbody
  const secOpenState = {};
  const subOpenState = {};
  const tbody = root.querySelector('.plan-table tbody');
  tbody.addEventListener('click', e => {
    const subRow = e.target.closest('.plan-sub-collapse');
    const secRow = e.target.closest('.plan-section-collapse');

    if(subRow){
      e.stopPropagation();
      const subId = subRow.dataset.sub;
      subOpenState[subId] = !subOpenState[subId];
      const open = subOpenState[subId];
      const icon = subRow.querySelector('.sub-icon');
      if(icon) icon.style.transform = open ? 'rotate(90deg)' : '';
      root.querySelectorAll('.sub-child.sub-' + subId).forEach(row => { row.style.display = open ? '' : 'none'; });
      return;
    }
    if(secRow){
      const secId = secRow.dataset.sec;
      secOpenState[secId] = !secOpenState[secId];
      const open = secOpenState[secId];
      const icon = secRow.querySelector('.collapse-icon[data-sec="' + secId + '"]');
      if(icon) icon.style.transform = open ? 'rotate(90deg)' : '';
      root.querySelectorAll('.sec-child.sec-' + secId).forEach(row => {
        const isSub = row.classList.contains('plan-sub-collapse');
        const isSubChild = row.classList.contains('sub-child');
        if(isSubChild) return;
        row.style.display = open ? '' : 'none';
        if(!open && isSub){
          const subId = row.dataset.sub;
          subOpenState[subId] = false;
          root.querySelectorAll('.sub-child.sub-' + subId).forEach(c => { c.style.display = 'none'; });
          const si = row.querySelector('.sub-icon'); if(si) si.style.transform = '';
        }
      });
    }
  });

  root.querySelector('#openCampaigns').onclick = () => openCampaignDialog();
  root.querySelector('#openActuals').onclick = () => openDailyActualsDialog();
  root.querySelector('#jumpTodayPlan').onclick = () => {
    const scroll = document.getElementById('planTableScroll');
    const table  = document.getElementById('planTable');
    if(!scroll || !table) return;
    const todayStr = today();
    // Expand today's month if collapsed
    const ym = todayStr.slice(0,7);
    const cur = loadCollapsedMonths();
    if(cur.has(ym)){ cur.delete(ym); saveCollapsedMonths(cur); applyCollapseStyle('planTable', cur); }
    // Expand all sections so today column is visible
    table.querySelectorAll('.plan-section-collapse').forEach(tr => {
      const sec = tr.dataset.sec;
      tr.querySelectorAll('.collapse-icon').forEach(i=>{ i.style.transform='rotate(90deg)'; });
      table.querySelectorAll(`.sec-child.sec-${sec}`).forEach(r=>r.style.display='');
    });
    // Find and scroll to today's th using getBoundingClientRect for accurate offset
    let th = null;
    table.querySelectorAll('thead th').forEach(t=>{ if(t.dataset.date===todayStr) th=t; });
    if(th){
      const thRect    = th.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const delta = thRect.left - scrollRect.left;
      scroll.scrollBy({ left: delta - 220, behavior:'smooth' });
    }
  };

  // Month column collapse/expand
  root.querySelector('#planTable thead').addEventListener('click', e => {
    const th = e.target.closest('[data-month-ym]');
    if(!th) return;
    toggleMonth(th.dataset.monthYm, 'planTable');
  });

  // Alert strip collapse toggle
  const alertToggle = root.querySelector('#alertStripToggle');
  if(alertToggle){
    alertToggle.onclick = () => {
      const body  = root.querySelector('#alertStripBody');
      const caret = root.querySelector('#alertStripCaret');
      const isNowHidden = body.style.display !== 'none';
      body.style.display = isNowHidden ? 'none' : 'block';
      caret.style.transform = isNowHidden ? 'rotate(-90deg)' : 'rotate(0deg)';
      localStorage.setItem('planAlertStripCollapsed', isNowHidden ? '1' : '0');
    };
  }

  // Alert chip click → scroll plan table to that date and flash the column
  root.querySelectorAll('[data-jump-date]').forEach(chip => {
    chip.onclick = () => {
      const targetDate = chip.dataset.jumpDate;
      const scroll = document.getElementById('planTableScroll');
      const table  = document.getElementById('planTable');
      if(!scroll || !table) return;

      // Find the th with that date
      let targetTh = null;
      table.querySelectorAll('thead th').forEach(th => {
        if(th.dataset.date === targetDate) targetTh = th;
      });

      if(!targetTh){
        // Date not in 3-year spine (shouldn't happen) — just scroll to today
        scroll.scrollTo({ left: 0, behavior: 'smooth' });
        return;
      }
      // Make sure the month is expanded first
      const ym = targetDate.slice(0,7);
      const curCollapsed = loadCollapsedMonths();
      if(curCollapsed.has(ym)){
        curCollapsed.delete(ym);
        saveCollapsedMonths(curCollapsed);
        applyCollapseStyle('planTable', curCollapsed);
        // Re-find th after expansion
        table.querySelectorAll('thead th').forEach(th => { if(th.dataset.date === targetDate) targetTh = th; });
      }

      // Scroll horizontally to that column
      scroll.scrollTo({ left: Math.max(0, targetTh.offsetLeft - 180), behavior: 'smooth' });

      // Flash the column red briefly
      const colIndex = targetTh.cellIndex;
      table.querySelectorAll(`tr > *:nth-child(${colIndex+1})`).forEach(c => {
        const orig = c.style.background;
        c.style.transition = 'background 0.15s';
        c.style.background = 'rgba(239,68,68,0.4)';
        setTimeout(() => { c.style.background = orig; setTimeout(()=>c.style.transition='',500); }, 700);
      });
    };
  });
  } catch(err) {
    console.error('renderPlan crashed:', err);
    root.innerHTML = `<div style="padding:40px;text-align:center;color:var(--danger);font-size:13px;">
      <div style="font-size:32px;margin-bottom:12px">⚠</div>
      Plan view error: ${err.message}<br><br>
      <small style="color:var(--muted)">Open browser console (F12) for details.</small>
    </div>`;
  }
}

function renderProducts(){
  const root = el('tab-products');
  const s = selectors(state);
  const a = actions(state);

  // For products tab, always show region catalog regardless of scope
  // But flag which items the current facility has activated
  const isSingleFac = s.isSingleFacility;
  const currentFacId = s.facility?.id || null;
  const activatedIds = new Set(
    isSingleFac && currentFacId
      ? (s.dataset.facilityProducts||[]).filter(fp=>fp.facilityId===currentFacId).map(fp=>fp.productId)
      : []
  );

  const catLabel = cat => ({[Categories.RAW]:'Raw Material',[Categories.FUEL]:'Fuel',[Categories.INT]:'Intermediate',[Categories.FIN]:'Finished Product'}[cat]||cat);
  const catPill = cat => {
    const map = {[Categories.RAW]:'pill-gray',[Categories.FUEL]:'pill-amber',[Categories.INT]:'pill-blue',[Categories.FIN]:'pill-green'};
    return `<span class="pill ${map[cat]||'pill-gray'}">${catLabel(cat)}</span>`;
  };

  root.innerHTML = `
  <div class="grid-2" style="align-items:start">

    <div class="card">
      <div class="card-header"><div class="card-title">Materials & Products</div><div style="display:flex;gap:6px">${isSingleFac?`<button class="btn" id="resetFacProducts" style="color:var(--danger,#ef4444);border-color:rgba(239,68,68,0.3)" title="Remove all product activations for this facility">✕ Reset Facility</button>`:''}><button class="btn" id="clearMaterialEdit">+ New</button></div></div>
      <div class="card-body">
        <form id="materialForm" style="margin-bottom:16px">
          <input type="hidden" name="id">
          <input type="hidden" name="code">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
            <div style="grid-column:1/-1">
              <label class="form-label">Category *</label>
              <select class="form-input" name="category" id="matCategory">
                <option value="${Categories.FIN}" selected>Finished Product</option>
                <option value="${Categories.INT}">Intermediate Product</option>
                <option value="${Categories.RAW}">Raw Material</option>
                <option value="${Categories.FUEL}">Fuel</option>
              </select>
            </div>
            <div style="grid-column:1/-1">
              <label class="form-label">Name *</label>
              <input class="form-input" name="name" placeholder="e.g. MIA / CEM / IL (11%) / BULK" required>
            </div>
            <div style="grid-column:1/-1">
              <label class="form-label">Material Number</label>
              <input class="form-input" name="materialNumber" placeholder="e.g. 10045231">
            </div>
            <div id="matFieldLandedCost">
              <label class="form-label">Landed Cost (USD/STn)</label>
              <input class="form-input" type="number" step="0.01" name="landedCostUsdPerStn" placeholder="0">
            </div>
            <div id="matFieldMMBTU" style="display:none">
              <label class="form-label">MMBTU/STn</label>
              <input class="form-input" type="number" step="0.01" name="calorificPowerMMBTUPerStn" placeholder="0">
            </div>
            <div id="matFieldCO2" style="display:none">
              <label class="form-label">KgCO₂/MMBTU</label>
              <input class="form-input" type="number" step="0.01" name="co2FactorKgPerMMBTU" placeholder="0">
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button type="submit" id="saveMaterialBtn" class="btn btn-primary">Save</button>
            <button type="button" id="cancelMaterialEdit" class="btn hidden">Cancel</button>
          </div>
        </form>

        <div style="border-radius:8px;border:1px solid var(--border);overflow:hidden">
          ${isSingleFac ? `<div style="font-size:11px;color:var(--muted);padding:6px 8px;background:rgba(99,179,237,0.06);border-bottom:1px solid rgba(99,179,237,0.15)">
            Checkmark = active in <strong>${esc(s.facility?.name||'this facility')}</strong>. Toggle to control which products this facility uses.
          </div>` : `<div style="font-size:11px;color:var(--muted);padding:6px 8px;background:rgba(255,255,255,0.04);border-bottom:1px solid var(--border)">
            Showing region catalog. Select a specific facility to activate/deactivate products per facility.
          </div>`}
          <div style="display:flex;gap:6px;padding:8px;background:var(--surface2);border-bottom:1px solid var(--border);flex-wrap:wrap;align-items:center">
            <select id="prodFilterCategory" style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer">
              <option value="">All Categories</option>
              <option value="${Categories.FIN}">Finished Product</option>
              <option value="${Categories.INT}">Intermediate</option>
              <option value="${Categories.RAW}">Raw Material</option>
              <option value="${Categories.FUEL}">Fuel</option>
            </select>
            <select id="prodFilterPlant" style="background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer">
              <option value="">All Plants</option>
              ${(s.org?.facilities||[]).map(f=>`<option value="${esc(f.id)}">${esc(f.name||f.id)}</option>`).join('')}
            </select>
            <button id="prodFilterReset" style="background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer">✕ Reset</button>
            <span id="prodFilterCount" style="margin-left:auto;font-size:11px;color:var(--muted)"></span>
          </div>
          <div class="table-scroll" style="max-height:260px;overflow-y:auto !important">
          <table class="data-table" id="prodDirectoryTable">
            <thead><tr>${isSingleFac?'<th style="width:36px">Active</th>':''}<th>Name</th><th>Category</th><th>Code</th><th>Actions</th></tr></thead>
            <tbody>
              ${s.regionCatalog.map(m=>{
                const isActive = !isSingleFac || activatedIds.size===0 || activatedIds.has(m.id);
                const facIds = (s.org?.facilities||[]).filter(f=>{
                  const fps = s.dataset?.facilityProducts||[];
                  return fps.some(fp=>fp.facilityId===f.id && fp.productId===m.id);
                }).map(f=>f.id).join(',');
                return '<tr data-category="' + esc(m.category||'') + '" data-facids="' + facIds + '" style="' + (!isActive?'opacity:0.45':'') + '">'
                  + (isSingleFac ? '<td style="text-align:center"><input type="checkbox" class="fac-product-toggle" data-product="' + m.id + '" ' + (isActive?'checked':'') + ' style="cursor:pointer;width:14px;height:14px;accent-color:var(--accent)"></td>' : '')
                  + '<td>' + esc(m.name) + '</td>'
                  + '<td>' + catPill(m.category) + '</td>'
                  + '<td><span class="text-mono" style="font-size:11px">' + esc(m.code||'') + '</span></td>'
                  + '<td><div class="row-actions"><button class="action-btn" data-edit-material="' + m.id + '">Edit</button><button class="action-btn del" data-del-material="' + m.id + '">Delete</button></div></td>'
                  + '</tr>';
              }).join('')||'<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px">No materials in region catalog yet</td></tr>'}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Recipe Editor</div></div>
      <div class="card-body">
        <form id="recipeForm" class="form-grid" style="margin-bottom:16px">
          <input type="hidden" name="editingRecipeId">
          <div class="grid-2">
            <div>
              <label class="form-label">Product *</label>
              <select class="form-input" name="productId" required>
                <option value="">Select product…</option>
                ${s.materials.filter(m=>[Categories.INT,Categories.FIN].includes(m.category)).map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="form-label">Version</label>
              <input class="form-input" name="version" type="number" min="1" value="1">
            </div>
          </div>

          <div>
            <label class="form-label">Components <span style="color:var(--muted);font-weight:400;font-size:10px">(clinker/intermediate auto-calculates as remainder)</span></label>
            <div id="recipeComponents" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
              <button type="button" id="addRecipeLine" class="btn" style="font-size:11px">+ Add Component</button>
              <div style="flex:1"></div>
              <span style="font-size:11px;color:var(--muted)">Total:</span>
              <span id="recipeTotalPct" style="font-size:12px;font-weight:700;min-width:48px;text-align:right;color:var(--ok)">100%</span>
            </div>
            <div id="recipeAutoCalcRow" style="display:none;padding:6px 10px;background:rgba(99,179,237,0.08);border:1px solid rgba(99,179,237,0.2);border-radius:6px;font-size:11px;color:var(--accent)">
              🔵 <span id="recipeAutoCalcLabel">Clinker</span>: <strong id="recipeAutoCalcPct">—</strong> (auto-calculated)
            </div>
          </div>

          <div style="display:flex;gap:8px">
            <button type="submit" id="saveRecipeBtn" class="btn btn-primary">Save Recipe</button>
            <button type="button" id="cancelRecipeEdit" class="btn hidden">Cancel</button>
          </div>
        </form>

        <div style="border-top:1px solid var(--border);padding-top:12px">
          <div style="font-size:11px;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em;font-weight:600">Saved Recipes</div>
          ${s.dataset.recipes.filter(r=>r.facilityId===state.ui.selectedFacilityId).map(r=>{
            const p = s.getMaterial(r.productId);
            const totalPct = (r.components||[]).reduce((acc,c)=>acc+(+c.pct||0),0);
            return `<div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px" data-recipe-id="${r.id}">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
                <div style="font-weight:600">${esc(p?.name||r.productId)} <span class="pill pill-gray">v${r.version}</span></div>
                <div class="row-actions"><button class="action-btn" data-edit-recipe="${r.id}">Edit</button><button class="action-btn del" data-del-recipe="${r.id}">Delete</button></div>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:4px">
                ${r.components.map(c=>`<span class="pill pill-blue" style="font-size:10px">${esc(s.getMaterial(c.materialId)?.code||s.getMaterial(c.materialId)?.name||c.materialId)}: ${c.pct}%</span>`).join('')}
                <span class="pill ${Math.abs(totalPct-100)<0.1?'pill-green':'pill-amber'}" style="font-size:10px">∑ ${totalPct.toFixed(1)}%</span>
              </div>
            </div>`;
          }).join('')||'<div class="text-muted" style="font-size:12px">No recipes yet</div>'}
        </div>
      </div>
    </div>
  </div>`;

  // ── Product directory filters ──
  const applyProdFilters = () => {
    const catVal  = (el('prodFilterCategory')?.value || '').trim();
    const plantVal = (el('prodFilterPlant')?.value || '').trim();
    const rows = document.querySelectorAll('#prodDirectoryTable tbody tr[data-category]');
    let visible = 0;
    rows.forEach(tr => {
      const matchCat   = !catVal   || tr.dataset.category === catVal;
      const matchPlant = !plantVal || (tr.dataset.facids||'').split(',').includes(plantVal);
      const show = matchCat && matchPlant;
      tr.style.display = show ? '' : 'none';
      if(show) visible++;
    });
    const countEl = el('prodFilterCount');
    if(countEl) countEl.textContent = (catVal || plantVal) ? `${visible} of ${rows.length} shown` : '';
  };
  el('prodFilterCategory')?.addEventListener('change', applyProdFilters);
  el('prodFilterPlant')?.addEventListener('change', applyProdFilters);
  el('prodFilterReset')?.addEventListener('click', () => {
    const cf = el('prodFilterCategory'); if(cf) cf.value = '';
    const pf = el('prodFilterPlant');   if(pf) pf.value = '';
    applyProdFilters();
  });

  // Wire material form
  const comps = root.querySelector('#recipeComponents');
  const addRecipeLine = () => {
    const div = document.createElement('div');
    div.className = 'recipe-row';
    div.style.cssText='display:grid;grid-template-columns:1fr 90px 28px;gap:6px;align-items:center';
    div.innerHTML = `<select class="form-input" name="componentMaterialId" style="font-size:12px"><option value="">Component…</option>${s.materials.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select><input class="form-input" type="number" step="0.01" name="componentPct" placeholder="%" style="font-size:12px;text-align:right"><button type="button" style="background:none;border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;font-size:13px;line-height:1;height:30px" data-remove>✕</button>`;
    div.querySelector('[data-remove]').onclick = () => { div.remove(); updateRecipeTotals(); };
    div.querySelector('[name=componentMaterialId]').onchange = updateRecipeTotals;
    div.querySelector('[name=componentPct]').oninput = updateRecipeTotals;
    comps.appendChild(div);
  };

  // Find the intermediate/clinker material for auto-calc
  const getAutoCalcMat = () => s.materials.find(m=>m.category===Categories.INT);

  const updateRecipeTotals = () => {
    const rows = [...comps.querySelectorAll(':scope > div.recipe-row')];
    const autoMat = getAutoCalcMat();
    let manualTotal = 0;
    rows.forEach(div => {
      const selVal = div.querySelector('[name=componentMaterialId]').value;
      const pctInput = div.querySelector('[name=componentPct]');
      const isAuto = autoMat && selVal === autoMat.id;
      if(isAuto){
        pctInput.readOnly = true;
        pctInput.style.color = 'var(--accent)';
        pctInput.style.background = 'rgba(99,179,237,0.08)';
      } else {
        pctInput.readOnly = false;
        pctInput.style.color = '';
        pctInput.style.background = '';
        manualTotal += +pctInput.value || 0;
      }
    });
    // Set auto-calc row pct
    const autoPct = Math.max(0, 100 - manualTotal);
    rows.forEach(div => {
      const selVal = div.querySelector('[name=componentMaterialId]').value;
      const pctInput = div.querySelector('[name=componentPct]');
      if(autoMat && selVal === autoMat.id) pctInput.value = autoPct.toFixed(2);
    });
    // Total display
    const allTotal = manualTotal + (autoMat ? autoPct : 0);
    const totalEl = root.querySelector('#recipeTotalPct');
    const autoRow = root.querySelector('#recipeAutoCalcRow');
    if(totalEl){
      const hasAuto = rows.some(d=>autoMat && d.querySelector('[name=componentMaterialId]').value===autoMat.id);
      const displayTotal = hasAuto ? 100 : manualTotal;
      totalEl.textContent = displayTotal.toFixed(1) + '%';
      totalEl.style.color = Math.abs(displayTotal - 100) < 0.1 ? 'var(--ok)' : 'var(--danger)';
    }
    if(autoRow && autoMat){
      const hasAuto = rows.some(d=>d.querySelector('[name=componentMaterialId]').value===autoMat.id);
      autoRow.style.display = hasAuto ? '' : 'none';
      const lbl = root.querySelector('#recipeAutoCalcLabel');
      const pct = root.querySelector('#recipeAutoCalcPct');
      if(lbl) lbl.textContent = autoMat.name || 'Intermediate';
      if(pct) pct.textContent = Math.max(0,100-manualTotal).toFixed(2)+'%';
    }
  };

  root.querySelector('#addRecipeLine').onclick = () => { addRecipeLine(); updateRecipeTotals(); };
  addRecipeLine(); addRecipeLine();
  updateRecipeTotals();

  const clearRecipeForm = () => {
    root.querySelector('#recipeForm').reset();
    root.querySelector('[name=editingRecipeId]').value='';
    root.querySelector('#saveRecipeBtn').textContent='Save Recipe';
    root.querySelector('#cancelRecipeEdit').classList.add('hidden');
    comps.innerHTML=''; addRecipeLine(); addRecipeLine(); updateRecipeTotals();
  };
  root.querySelector('#cancelRecipeEdit').onclick = clearRecipeForm;

  root.querySelectorAll('[data-edit-recipe]').forEach(btn=>btn.onclick=()=>{
    const rec = s.dataset.recipes.find(r=>r.id===btn.dataset.editRecipe); if(!rec) return;
    const form = root.querySelector('#recipeForm');
    form.querySelector('[name=productId]').value=rec.productId;
    form.querySelector('[name=version]').value=rec.version||1;
    form.querySelector('[name=editingRecipeId]').value=rec.id;
    root.querySelector('#saveRecipeBtn').textContent='Update Recipe';
    root.querySelector('#cancelRecipeEdit').classList.remove('hidden');
    comps.innerHTML='';
    (rec.components?.length?rec.components:[{materialId:'',pct:''}]).forEach(c=>{
      addRecipeLine();
      const row=comps.lastElementChild;
      row.querySelector('[name=componentMaterialId]').value=c.materialId||'';
      row.querySelector('[name=componentPct]').value=c.pct??'';
    });
    updateRecipeTotals();
  });

  root.querySelectorAll('[data-del-recipe]').forEach(btn=>btn.onclick=()=>{
    const rec=s.dataset.recipes.find(r=>r.id===btn.dataset.delRecipe);
    if(!confirm(`Delete recipe for ${s.getMaterial(rec?.productId)?.name||rec?.productId}?`)) return;
    a.deleteRecipe(btn.dataset.delRecipe); persist(); renderProducts(); renderPlan();
  });

  root.querySelector('#recipeForm').onsubmit=e=>{
    e.preventDefault();
    const fd=new FormData(e.target);
    const rows=[...comps.querySelectorAll(':scope > div.recipe-row')].map(div=>({materialId:div.querySelector('[name=componentMaterialId]').value,pct:+div.querySelector('[name=componentPct]').value||0})).filter(r=>r.materialId);
    const total = rows.reduce((s,r)=>s+(+r.pct||0),0);
    if(Math.abs(total-100)>0.1){ showToast(`Total is ${total.toFixed(1)}% — must be 100%`, 'danger'); return; }
    a.saveRecipe({productId:fd.get('productId'),version:+fd.get('version')||1,components:rows});
    persist(); clearRecipeForm(); renderProducts(); renderPlan(); showToast('Recipe saved ✓');
  };

  // Wire material form
  const clearMaterialForm = () => {
    const mf = root.querySelector('#materialForm');
    if(!mf) return;
    mf.reset();
    mf.querySelector('[name=id]').value='';
    mf.querySelector('[name=code]').value='';
    mf.querySelector('[name=name]').value='';
    root.querySelector('#saveMaterialBtn').textContent='Save';
    root.querySelector('#cancelMaterialEdit').classList.add('hidden');
  };
  root.querySelector('#clearMaterialEdit').onclick = clearMaterialForm;
  root.querySelector('#cancelMaterialEdit').onclick = clearMaterialForm;

  // Reset facility product activations
  root.querySelector('#resetFacProducts')?.addEventListener('click', () => {
    const facId = s.facility?.id;
    if(!facId) return;
    if(!confirm(`Remove all product activations for ${s.facility.name}? The products stay in the catalog — this just clears which ones are active for this facility.`)) return;
    const ds = s.dataset;
    ds.facilityProducts = (ds.facilityProducts||[]).filter(fp => fp.facilityId !== facId);
    persist(); renderProducts(); showToast('Facility products reset ✓', 'ok');
  });

  // Facility product activation toggles
  root.querySelectorAll('.fac-product-toggle').forEach(cb => {
    cb.onchange = () => {
      const pid = cb.dataset.product;
      const facId = s.facility?.id;
      if(!facId) return;
      // If this is the first toggle action, initialize all as active first
      const ds = s.dataset;
      const hasAny = (ds.facilityProducts||[]).some(fp=>fp.facilityId===facId);
      if(!hasAny){
        // Activate all region catalog items for this facility first
        s.regionCatalog.forEach(m => a.activateProductForFacility(facId, m.id));
      }
      if(cb.checked) a.activateProductForFacility(facId, pid);
      else a.deactivateProductForFacility(facId, pid);
      persist(); renderProducts();
    };
  });

  const updateMatFields = () => {
    const cat = root.querySelector('#matCategory')?.value;
    const showLanded = [Categories.RAW, Categories.FUEL].includes(cat);
    const showFuel = cat === Categories.FUEL;
    const lc = root.querySelector('#matFieldLandedCost');
    const mb = root.querySelector('#matFieldMMBTU');
    const co = root.querySelector('#matFieldCO2');
    if(lc) lc.style.display = showLanded ? '' : 'none';
    if(mb) mb.style.display = showFuel ? '' : 'none';
    if(co) co.style.display = showFuel ? '' : 'none';
  };
  root.querySelector('#matCategory')?.addEventListener('change', updateMatFields);
  updateMatFields();

  root.querySelectorAll('[data-edit-material]').forEach(btn=>btn.onclick=()=>{
    const m=s.regionCatalog.find(x=>x.id===btn.dataset.editMaterial); if(!m) return;
    const f=root.querySelector('#materialForm');
    f.querySelector('[name=id]').value=m.id;
    f.querySelector('[name=name]').value=m.name||'';
    f.querySelector('[name=code]').value=m.code||'';
    f.querySelector('[name=materialNumber]').value=m.materialNumber||'';
    f.querySelector('[name=category]').value=m.category||Categories.FIN;
    f.querySelector('[name=landedCostUsdPerStn]').value=m.landedCostUsdPerStn||'';
    f.querySelector('[name=calorificPowerMMBTUPerStn]').value=m.calorificPowerMMBTUPerStn||'';
    f.querySelector('[name=co2FactorKgPerMMBTU]').value=m.co2FactorKgPerMMBTU||'';
    root.querySelector('#saveMaterialBtn').textContent='Update';
    root.querySelector('#cancelMaterialEdit').classList.remove('hidden');
    updateMatFields();
    f.scrollIntoView({behavior:'smooth',block:'start'});
  });

  root.querySelectorAll('[data-del-material]').forEach(btn=>btn.onclick=()=>{
    const m=s.regionCatalog.find(x=>x.id===btn.dataset.delMaterial);
    if(!confirm(`Delete ${m?.name}? Also removes related recipes, capabilities, and actuals.`)) return;
    a.deleteMaterial(btn.dataset.delMaterial); persist(); renderProducts(); renderFlow(); renderDemand(); renderPlan();
  });

  root.querySelector('#materialForm').onsubmit=e=>{
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());

    // Guard: name is required
    const productName = (fd.name||'').trim();
    if(!productName){
      const nameInput = root.querySelector('#materialForm [name=name]');
      if(nameInput){ nameInput.style.border='1.5px solid var(--danger,#ef4444)'; nameInput.focus(); setTimeout(()=>nameInput.style.border='',2000); }
      showToast('Product name is required', 'err');
      return;
    }
    fd.name = productName;

    const saved = a.upsertMaterial(fd);
    // upsertCatalogItem drops extra fields — patch them back in immediately
    if(saved){
      const idx = state.catalog.findIndex(m=>m.id===saved.id);
      if(idx>=0){
        state.catalog[idx].name            = productName; // ensure name is never lost
        state.catalog[idx].materialNumber  = fd.materialNumber||'';
        state.catalog[idx].materialNumbers = state.catalog[idx].materialNumbers||[];
        state.catalog[idx].familyId        = fd.familyId||null;
        state.catalog[idx].typeId          = fd.typeId||null;
        state.catalog[idx].subTypeId       = fd.subTypeId||null;
        state.catalog[idx].producerId      = fd.producerId||null;
      }
    }
    persist(); clearMaterialForm(); renderProducts(); renderDemand(); renderFlow(); renderPlan(); showToast('Material saved ✓');
  };
}

/* ─────────────────── FLOW TAB ─────────────────── */
function renderFlow(){
  const root = el('tab-flow');
  const s = selectors(state);
  const a = actions(state);

  const eqTypeLabel = t => ({kiln:'Kiln',finish_mill:'Finish Mill',raw_mill:'Raw Mill'}[t]||t);
  const eqTypePill = t => {
    const map = {kiln:'pill-amber',finish_mill:'pill-blue',raw_mill:'pill-gray'};
    return `<span class="pill ${map[t]||'pill-gray'}">${eqTypeLabel(t)}</span>`;
  };

  const equipmentRows = s.equipment.map(eq=>{
    const caps = s.getCapsForEquipment(eq.id);
    return `<tr>
      <td>${esc(eq.name)}</td>
      <td>${eqTypePill(eq.type)}</td>
      <td>${caps.map(c=>`<span class="pill pill-blue" style="font-size:10px">${esc(s.getMaterial(c.productId)?.code||c.productId)} @ ${fmt0(c.maxRateStpd)}</span>`).join(' ')||'<span class="text-muted">—</span>'}</td>
      <td><div class="row-actions"><button class="action-btn" data-edit-eq="${eq.id}">Edit</button><button class="action-btn del" data-del-eq="${eq.id}">Delete</button></div></td>
    </tr>`;
  }).join('');

  root.innerHTML = `
  <div class="grid-2" style="align-items:start;gap:16px">
    <div style="display:flex;flex-direction:column;gap:16px">

      <div class="card">
        <div class="card-header"><div class="card-title">Equipment</div></div>
        <div class="card-body">
          <form id="eqForm" class="form-grid" style="grid-template-columns:1fr 1fr;margin-bottom:16px">
            <input type="hidden" name="id">
            <div><label class="form-label">Name *</label><input class="form-input" name="name" placeholder="e.g. Kiln 1" required></div>
            <div><label class="form-label">Type *</label><select class="form-input" name="type"><option value="kiln">Kiln</option><option value="finish_mill">Finish Mill</option><option value="raw_mill">Raw Mill</option></select></div>
            <div style="grid-column:1/-1;display:flex;gap:8px">
              <button type="submit" id="saveEqBtn" class="btn btn-primary">Save</button>
              <button type="button" id="cancelEqEdit" class="btn hidden">Cancel</button>
            </div>
          </form>
          <div class="table-scroll" style="max-height:240px;border-radius:8px;overflow-y:auto !important;border:1px solid var(--border)">
            <table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Capabilities</th><th>Actions</th></tr></thead>
            <tbody>${equipmentRows||'<tr><td colspan="4" class="text-muted" style="text-align:center;padding:20px">No equipment</td></tr>'}</tbody></table>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Equipment Capabilities</div></div>
        <div class="card-body">
          <form id="capForm" class="form-grid" style="grid-template-columns:1fr 1fr;margin-bottom:16px">
            <input type="hidden" name="editingCapId">
            <div><label class="form-label">Equipment</label><select class="form-input" name="equipmentId">${s.equipment.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></div>
            <div><label class="form-label">Product</label><select class="form-input" name="productId"><option value="">Select…</option>${s.materials.filter(m=>[Categories.INT,Categories.FIN].includes(m.category)).map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>
            <div><label class="form-label">Max Rate (STn/day)</label><input class="form-input" type="number" step="0.1" name="maxRateStpd" placeholder="0"></div>
            <div><label class="form-label">kWh/STn</label><input class="form-input" type="number" step="0.01" name="electricKwhPerStn" placeholder="0"></div>
            <div style="grid-column:1/-1;display:flex;gap:8px">
              <button type="submit" id="saveCapBtn" class="btn btn-primary">Save Capability</button>
              <button type="button" id="cancelCapEdit" class="btn hidden">Cancel</button>
            </div>
          </form>
          <div class="table-scroll" style="max-height:220px;border-radius:8px;overflow-y:auto !important;border:1px solid var(--border)">
            <table class="data-table"><thead><tr><th>Equipment</th><th>Product</th><th>Max Rate</th><th>kWh/STn</th><th>Actions</th></tr></thead>
            <tbody>${s.capabilities.map(c=>`<tr><td>${esc(s.getEquipment(c.equipmentId)?.name||c.equipmentId)}</td><td>${esc(s.getMaterial(c.productId)?.name||c.productId)}</td><td class="num">${fmt(c.maxRateStpd)}</td><td class="num">${fmt(c.electricKwhPerStn)}</td><td><div class="row-actions"><button class="action-btn" data-edit-cap="${c.id}">Edit</button><button class="action-btn del" data-del-cap="${c.id}">Delete</button></div></td></tr>`).join('')||'<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px">No capabilities</td></tr>'}</tbody></table>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Storage Units</div></div>
      <div class="card-body">
        <form id="stForm" class="form-grid" style="grid-template-columns:1fr 1fr;margin-bottom:16px">
          <input type="hidden" name="id">
          <div><label class="form-label">Name *</label><input class="form-input" name="name" placeholder="e.g. Clinker Silo 1" required></div>
          <div><label class="form-label">Category Hint</label><input class="form-input" name="categoryHint" placeholder="CLINKER / CEMENT"></div>
          <div><label class="form-label">Allowed Product</label><select class="form-input" name="allowedProductId"><option value="">None</option>${s.materials.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>
          <div><label class="form-label">Max Capacity (STn)</label><input class="form-input" type="number" step="1" name="maxCapacityStn" placeholder="0"></div>
          <div style="grid-column:1/-1;display:flex;gap:8px">
            <button type="submit" id="saveStBtn" class="btn btn-primary">Save</button>
            <button type="button" id="cancelStEdit" class="btn hidden">Cancel</button>
          </div>
        </form>
        <div class="table-scroll" style="max-height:480px;border-radius:8px;overflow-y:auto !important;border:1px solid var(--border)">
          <table class="data-table"><thead><tr><th>Name</th><th>Hint</th><th>Product</th><th>Max Cap</th><th>Actions</th></tr></thead>
          <tbody>${s.storages.map(st=>`<tr>
            <td>${esc(st.name)}</td>
            <td><span class="pill pill-gray" style="font-size:10px">${esc(st.categoryHint||'—')}</span></td>
            <td>${(st.allowedProductIds||[]).map(pid=>esc(s.getMaterial(pid)?.name||pid)).join(', ')||'—'}</td>
            <td class="num">${st.maxCapacityStn?fmt0(st.maxCapacityStn):'—'}</td>
            <td><div class="row-actions"><button class="action-btn" data-edit-st="${st.id}">Edit</button><button class="action-btn del" data-del-st="${st.id}">Delete</button></div></td>
          </tr>`).join('')||'<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px">No storages</td></tr>'}</tbody></table>
        </div>
      </div>
    </div>
  </div>`;

  // Wire flow forms
  const rer = ()=>{ persist(); renderFlow(); renderPlan(); renderDemand(); renderData(); };
  const clearEq=()=>{ root.querySelector('#eqForm').reset(); root.querySelector('#eqForm [name=id]').value=''; root.querySelector('#saveEqBtn').textContent='Save'; root.querySelector('#cancelEqEdit').classList.add('hidden'); };
  const clearSt=()=>{ root.querySelector('#stForm').reset(); root.querySelector('#stForm [name=id]').value=''; root.querySelector('#saveStBtn').textContent='Save'; root.querySelector('#cancelStEdit').classList.add('hidden'); };
  const clearCap=()=>{ root.querySelector('#capForm').reset(); root.querySelector('[name=editingCapId]').value=''; root.querySelector('#saveCapBtn').textContent='Save Capability'; root.querySelector('#cancelCapEdit').classList.add('hidden'); };
  root.querySelector('#cancelEqEdit').onclick=clearEq;
  root.querySelector('#cancelStEdit').onclick=clearSt;
  root.querySelector('#cancelCapEdit').onclick=clearCap;
  root.querySelectorAll('[data-edit-eq]').forEach(btn=>btn.onclick=()=>{ const row=s.equipment.find(x=>x.id===btn.dataset.editEq); if(!row) return; const f=root.querySelector('#eqForm'); f.querySelector('[name=id]').value=row.id; f.querySelector('[name=name]').value=row.name; f.querySelector('[name=type]').value=row.type; root.querySelector('#saveEqBtn').textContent='Update'; root.querySelector('#cancelEqEdit').classList.remove('hidden'); });
  root.querySelectorAll('[data-del-eq]').forEach(btn=>btn.onclick=()=>{
    if(!confirm('Delete equipment and all capabilities/actuals?')) return;
    const eqId = btn.dataset.delEq;
    const eq = s.dataset.equipment.find(e=>e.id===eqId);
    if(!eq){ showToast('Equipment not found', 'err'); return; }
    // Scope actions to the equipment's own facilityId so fac matches
    const facActions = actions({...state, ui:{...state.ui, selectedFacilityId: eq.facilityId, selectedFacilityIds:[eq.facilityId]}});
    facActions.deleteEquipment(eqId);
    rer();
  });
  root.querySelectorAll('[data-edit-st]').forEach(btn=>btn.onclick=()=>{ const row=s.storages.find(x=>x.id===btn.dataset.editSt); if(!row) return; const f=root.querySelector('#stForm'); f.querySelector('[name=id]').value=row.id; f.querySelector('[name=name]').value=row.name; f.querySelector('[name=categoryHint]').value=row.categoryHint||''; f.querySelector('[name=allowedProductId]').value=(row.allowedProductIds||[])[0]||''; f.querySelector('[name=maxCapacityStn]').value=row.maxCapacityStn||''; root.querySelector('#saveStBtn').textContent='Update'; root.querySelector('#cancelStEdit').classList.remove('hidden'); });
  root.querySelectorAll('[data-del-st]').forEach(btn=>btn.onclick=()=>{
    if(!confirm('Delete storage and related inventory actuals?')) return;
    const stId = btn.dataset.delSt;
    const st = s.dataset.storages.find(x=>x.id===stId);
    if(!st){ showToast('Storage not found', 'err'); return; }
    const facActions = actions({...state, ui:{...state.ui, selectedFacilityId: st.facilityId, selectedFacilityIds:[st.facilityId]}});
    facActions.deleteStorage(stId);
    rer();
  });
  root.querySelectorAll('[data-edit-cap]').forEach(btn=>btn.onclick=()=>{ const c=s.capabilities.find(x=>x.id===btn.dataset.editCap); if(!c) return; const f=root.querySelector('#capForm'); f.querySelector('[name=editingCapId]').value=c.id; f.querySelector('[name=equipmentId]').value=c.equipmentId; f.querySelector('[name=productId]').value=c.productId; f.querySelector('[name=maxRateStpd]').value=c.maxRateStpd||''; f.querySelector('[name=electricKwhPerStn]').value=c.electricKwhPerStn||''; root.querySelector('#saveCapBtn').textContent='Update Capability'; root.querySelector('#cancelCapEdit').classList.remove('hidden'); });
  root.querySelectorAll('[data-del-cap]').forEach(btn=>btn.onclick=()=>{
    if(!confirm('Delete capability?')) return;
    const capId = btn.dataset.delCap;
    const cap = s.dataset.capabilities.find(c=>c.id===capId);
    const eq  = cap ? s.dataset.equipment.find(e=>e.id===cap.equipmentId) : null;
    const facId = eq?.facilityId || state.ui.selectedFacilityId;
    const facActions = actions({...state, ui:{...state.ui, selectedFacilityId: facId, selectedFacilityIds:[facId]}});
    facActions.deleteCapability(capId);
    rer();
  });
  root.querySelector('#eqForm').onsubmit=e=>{ e.preventDefault(); a.upsertEquipment(Object.fromEntries(new FormData(e.target).entries())); clearEq(); rer(); showToast('Equipment saved ✓'); };
  root.querySelector('#stForm').onsubmit=e=>{ e.preventDefault(); const fd=new FormData(e.target); a.upsertStorage({id:fd.get('id')||'',name:fd.get('name'),categoryHint:fd.get('categoryHint'),allowedProductIds:fd.get('allowedProductId')?[fd.get('allowedProductId')]:[], maxCapacityStn:fd.get('maxCapacityStn')}); clearSt(); rer(); showToast('Storage saved ✓'); };
  root.querySelector('#capForm').onsubmit=e=>{ e.preventDefault(); const fd=new FormData(e.target); a.upsertCapability({equipmentId:fd.get('equipmentId'),productId:fd.get('productId'),maxRateStpd:fd.get('maxRateStpd'),electricKwhPerStn:fd.get('electricKwhPerStn'),thermalMMBTUPerStn:'0'}); clearCap(); rer(); showToast('Capability saved ✓'); };
}

/* ─────────────────── DEMAND TAB ─────────────────── */
function renderDemand(mode='total'){
  // All modes render into demand-total; external/internal split later
  const root = el('tab-demand-total') || el('tab-demand-external');
  if(!root) return;
  const s = selectors(state);
  const ds = s.dataset;
  const todayStr = today();
  const demandTableId = 'demand-table-total';

  const allDates = buildFullSpine();
  const months   = groupByMonth(allDates);
  let collapsed = loadCollapsedMonths();
  if(collapsed.size === 0){ collapsed = defaultCollapsedMonths(months); saveCollapsedMonths(collapsed); }
  applyCollapseStyle(demandTableId, collapsed);

  const isWeekendDate = d => [0,6].includes(new Date(d+'T00:00:00').getDay());
  const wkdColStyle = 'background:rgba(239,68,68,0.06);border-left:1px solid rgba(239,68,68,0.3);';

  // Facilities in scope — fall back to all facilities if none selected
  const scopeFacIds = s.facilityIds.length ? s.facilityIds : state.org.facilities.map(f=>f.id);
  const scopeFacs   = state.org.facilities.filter(f => scopeFacIds.includes(f.id));

  // Active finished products for a facility
  const getFacProducts = facId => s.getFacilityProducts(facId).filter(m => m.category === 'FINISHED_PRODUCT');

  // Value for a cell: actual first, then forecast
  const getVal = (facId, pid, date) => {
    const actual = ds.actuals.shipments.find(r => r.date===date && r.facilityId===facId && r.productId===pid);
    if(actual) return { v: +actual.qtyStn||0, isActual: true };
    const fc = ds.demandForecast.find(r => r.date===date && r.facilityId===facId && r.productId===pid);
    return { v: fc ? +fc.qtyStn||0 : 0, isActual: false };
  };

  // Date headers
  const dateHeaders = months.map(mon => {
    const isCol = collapsed.has(mon.ym);
    const monthTh = `<th class="month-total-th" data-month-ym="${mon.ym}" style="min-width:64px;background:rgba(99,179,237,0.12);border-left:2px solid rgba(99,179,237,0.35);border-right:1px solid rgba(99,179,237,0.2);font-size:9px;font-weight:700;color:#93c5fd;text-align:center;cursor:pointer;user-select:none;white-space:nowrap;padding:3px 6px;" title="Click to toggle ${mon.label}"><span data-month-toggle="${mon.ym}" style="font-size:8px;margin-right:3px">${isCol?'▶':'▼'}</span>${mon.label}</th>`;
    const dayThs = mon.dates.map(d => {
      const isWk = isWeekendDate(d); const isTd = d===todayStr;
      let sty = isWk ? wkdColStyle : '';
      if(isTd) sty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);';
      return `<th data-date="${d}" class="day-col-${mon.ym}" style="min-width:64px;width:64px;${sty}font-size:9px;${isWk?'color:rgba(239,68,68,0.65)':isTd?'color:var(--accent)':''}">${d.slice(8,10)}</th>`;
    }).join('');
    return monthTh + dayThs;
  }).join('');

  // Helper: build all month+day cells for a row given a getCellData fn
  const makeMonthCells = (getCellData) => months.map(mon => {
    let monthTotal = 0;
    const dayCells = mon.dates.map(d => {
      const isWk = isWeekendDate(d); const isTd = d===todayStr;
      let sty = isWk ? wkdColStyle : '';
      if(isTd) sty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);';
      const { v, html } = getCellData(d, mon.ym, sty);
      monthTotal += v;
      return html;
    }).join('');
    const monthCell = `<td class="num" style="background:rgba(99,179,237,0.1);border-left:2px solid rgba(99,179,237,0.3);font-size:10px;font-weight:700;color:#93c5fd">${monthTotal ? fmt0(monthTotal) : ''}</td>`;
    return monthCell + dayCells;
  }).join('');

  // Build rows
  let bodyRows = '';

  if(!scopeFacs.length){
    bodyRows = `<tr><td class="text-muted" colspan="9999" style="text-align:center;padding:20px;font-size:12px;">No facilities in scope. Select a facility or region from the scope selector.</td></tr>`;
  } else {
    // Grand total row
    const grandCells = makeMonthCells((d, ym, sty) => {
      let v = 0;
      scopeFacs.forEach(fac => getFacProducts(fac.id).forEach(fp => { v += getVal(fac.id, fp.id, d).v; }));
      return { v, html: `<td class="num day-col-${ym}" style="min-width:64px;width:64px;${sty}font-size:10px;font-weight:700;">${v ? fmt0(v) : ''}</td>` };
    });
    bodyRows += `<tr style="background:rgba(99,179,237,0.08);">
      <td class="row-header" style="position:sticky;left:0;background:#0f1a2e;z-index:3;font-size:11px;font-weight:700;color:#93c5fd;padding-left:8px;">▶ TOTAL ALL FACILITIES</td>
      ${grandCells}
    </tr>`;

    // Per-facility blocks
    scopeFacs.forEach(fac => {
      const facProds = getFacProducts(fac.id);
      if(!facProds.length) return;

      const facCells = makeMonthCells((d, ym, sty) => {
        let v = 0;
        facProds.forEach(fp => { v += getVal(fac.id, fp.id, d).v; });
        return { v, html: `<td class="num day-col-${ym}" style="min-width:64px;width:64px;${sty}font-size:10px;font-weight:700;">${v ? fmt0(v) : ''}</td>` };
      });
      bodyRows += `<tr class="fac-header-row" data-fac-toggle="${fac.id}" style="cursor:pointer;background:rgba(255,255,255,0.04);border-top:2px solid var(--border);">
        <td class="row-header" style="position:sticky;left:0;background:#131c2e;z-index:3;font-size:11px;font-weight:700;padding-left:8px;">
          <span class="fac-chevron" style="font-size:9px;margin-right:5px;">▶</span>${esc(fac.name)} / SHIPMENT / CEM
        </td>${facCells}
      </tr>`;

      facProds.forEach(fp => {
        const prodCells = makeMonthCells((d, ym, sty) => {
          const { v, isActual } = getVal(fac.id, fp.id, d);
          const html = isActual
            ? `<td class="num day-col-${ym}" style="min-width:64px;width:64px;${sty}background:rgba(34,197,94,0.12);color:#86efac;font-size:10px;font-weight:600;" title="Actual">${v ? fmt0(v) : ''}</td>`
            : `<td class="day-col-${ym}" style="min-width:64px;width:64px;${sty}padding:1px 2px;"><input class="cell-input demand-input" data-fac="${fac.id}" data-date="${d}" data-product="${fp.id}" value="${v||''}" style="width:100%;min-width:60px;background:transparent;border:none;color:var(--text);font-size:10px;text-align:right;padding:3px 4px;border-radius:3px;"/></td>`;
          return { v, html };
        });
        bodyRows += `<tr class="fac-product-row fac-rows-${fac.id}" style="display:none;">
          <td class="row-header" style="position:sticky;left:0;background:var(--surface);z-index:2;font-size:11px;padding-left:24px;">${esc(fac.code||fac.name)} / ${esc(fp.name)}</td>
          ${prodCells}
        </tr>`;
      });
    });
  }

  root.innerHTML = `
  <div class="card">
    <div class="card-header">
      <div>
        <div class="card-title">📊 Demand Plan — Total Shipments</div>
        <div class="card-sub text-muted" style="font-size:11px">All facilities · Click facility row to expand · 🟢 Green = confirmed actual · White = forecast · Pink = weekends</div>
      </div>
      <div style="display:flex;gap:8px">
        <button id="jumpTodayDemand" class="btn">📅 Today</button>
        <button id="openForecastTool" class="btn">⚙ Forecast Tool</button>
        <button id="saveDemandBtn" class="btn btn-primary">💾 Save Forecast</button>
      </div>
    </div>
    <div class="card-body" style="padding:0">
      <div class="table-scroll" id="demandTableScroll" style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 180px)">
        <table class="data-table plan-table" id="${demandTableId}" style="min-width:max-content;width:100%">
          <thead><tr>
            <th class="row-header" style="min-width:200px;position:sticky;left:0;background:#0a0d14;z-index:5;">Facility / Product</th>
            ${dateHeaders}
          </tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>
  </div>
  <div style="font-size:11px;color:var(--muted);padding:4px 0 16px">
    🟢 Green = confirmed actual (locked) · White = editable forecast · Click facility row to expand · Pink = weekend
  </div>`;

  // Facility row expand/collapse
  root.querySelectorAll('.fac-header-row').forEach(row => {
    row.addEventListener('click', () => {
      const facId = row.dataset.facToggle;
      const chevron = row.querySelector('.fac-chevron');
      const productRows = root.querySelectorAll(`.fac-rows-${facId}`);
      const isOpen = productRows.length && productRows[0].style.display !== 'none';
      productRows.forEach(r => r.style.display = isOpen ? 'none' : '');
      if(chevron) chevron.textContent = isOpen ? '▶' : '▼';
    });
  });

  // Save forecast
  root.querySelector('#saveDemandBtn').onclick = () => {
    const rows = [...root.querySelectorAll('.demand-input')]
      .map(i => ({ date: i.dataset.date, facilityId: i.dataset.fac, productId: i.dataset.product, qtyStn: +i.value||0 }))
      .filter(r => r.qtyStn > 0 && r.facilityId && r.productId);
    rows.forEach(r => {
      const key = `${r.date}|${r.facilityId}|${r.productId}`;
      ds.demandForecast = ds.demandForecast.filter(x => `${x.date}|${x.facilityId}|${x.productId}` !== key);
      ds.demandForecast.push({ date: r.date, facilityId: r.facilityId, productId: r.productId, qtyStn: r.qtyStn, source: 'forecast' });
    });
    persist(); renderDemand('total'); renderPlan(); showToast('Forecast saved ✓');
  };

  // Month collapse (synced with supply plan)
  root.querySelector(`#${demandTableId}`)?.querySelector('thead')?.addEventListener('click', e => {
    const th = e.target.closest('[data-month-ym]');
    if(!th) return;
    toggleMonth(th.dataset.monthYm, demandTableId);
    applyCollapseStyle('planTable', loadCollapsedMonths());
    applyCollapseStyle('demand-table-total', loadCollapsedMonths());
  });

  root.querySelector('#openForecastTool').onclick = () => openForecastToolDialog();
  root.querySelector('#jumpTodayDemand').onclick = () => {
    const scroll = document.getElementById('demandTableScroll');
    const table  = document.getElementById('demand-table-total');
    if(!scroll || !table) return;
    const todayStr = today();
    const ym = todayStr.slice(0,7);
    const cur = loadCollapsedMonths();
    if(cur.has(ym)){ cur.delete(ym); saveCollapsedMonths(cur); applyCollapseStyle('demand-table-total', cur); }
    let th = null;
    table.querySelectorAll('thead th').forEach(t=>{ if(t.dataset.date===todayStr) th=t; });
    if(th){
      const thRect     = th.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const delta = thRect.left - scrollRect.left;
      scroll.scrollBy({ left: delta - 220, behavior:'smooth' });
    }
  };
}

/* ─────────────────── FORECAST TOOL DIALOG ─────────────────── */
function openForecastToolDialog(){
  const s = selectors(state); const a = actions(state);
  const host = el('forecastToolDialog');
  const startDefault = yesterdayLocal();
  host.classList.add('open');
  host.innerHTML = `<div class="modal" style="max-width:600px">
    <div class="modal-header">
      <div><div class="modal-title">⚙ Forecast Tool</div><div style="font-size:11px;color:var(--muted)">Uses actual shipments as baseline — never overwrites actuals</div></div>
      <button class="btn" id="fcClose">Close</button>
    </div>
    <div class="modal-body">
      <div class="form-grid" style="grid-template-columns:1fr 1fr">
        <div><label class="form-label">Product</label><select class="form-input" id="fcProduct">${state.catalog.filter(m=>m.category==='FINISHED_PRODUCT').map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
        <div><label class="form-label">Start Date</label><input class="form-input" type="date" id="fcStart" value="${startDefault}"></div>
        <div><label class="form-label">Method</label><select class="form-input" id="fcMethod"><option value="rolling">Rolling weekday average</option><option value="fixed">Fixed daily value</option><option value="monthTotal">Distribute monthly total</option></select></div>
        <div id="fcRollingWrap"><label class="form-label">Rolling Window</label><select class="form-input" id="fcRollingN"><option value="5">5 weekdays</option><option value="10">10 weekdays</option><option value="30">30 weekdays</option></select></div>
        <div id="fcFixedWrap" class="hidden"><label class="form-label">Fixed Daily (STn)</label><input class="form-input" type="number" step="0.1" id="fcFixedVal" value="0"></div>
        <div id="fcMonthWrap" class="hidden"><label class="form-label">Month Total Target (STn)</label><input class="form-input" type="number" step="0.1" id="fcMonthTotal" value="0"></div>
        <div id="fcHorizonWrap" style="grid-column:1/-1" class="hidden">
          <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr">
            <div><label class="form-label">Horizon</label><select class="form-input" id="fcHorizon"><option value="eom">End of month</option><option value="eoy">End of year</option><option value="date">Specific date</option></select></div>
            <div><label class="form-label">End date</label><input class="form-input" type="date" id="fcEndDate"></div>
          </div>
        </div>
        <div style="grid-column:1/-1"><label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer"><input type="checkbox" id="fcAllowSat" checked style="width:auto"> Ships Saturdays</label></div>
        <div style="grid-column:1/-1;padding:10px;background:var(--surface2);border-radius:8px;font-size:11px;color:var(--muted);min-height:36px" id="fcMsg"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="fcPreview">Preview</button>
      <button class="btn btn-primary" id="fcApply">Apply Forecast</button>
    </div>
  </div>`;

  const q = id => host.querySelector('#'+id);
  const syncMethodUi = () => {
    const m = q('fcMethod').value;
    q('fcRollingWrap').classList.toggle('hidden', m!=='rolling');
    q('fcFixedWrap').classList.toggle('hidden', m!=='fixed');
    q('fcMonthWrap').classList.toggle('hidden', m!=='monthTotal');
    q('fcHorizonWrap').classList.toggle('hidden', m==='monthTotal');
  };
  q('fcMethod').onchange = syncMethodUi; syncMethodUi();
  q('fcClose').onclick = () => host.classList.remove('open');
  host.onclick = e => { if(e.target===host) host.classList.remove('open'); };

  const isSunday = d => new Date(d+'T00:00:00').getDay()===0;
  const isSaturday = d => new Date(d+'T00:00:00').getDay()===6;
  const endOfMonth = d => { const x=new Date(d+'T00:00:00'); x.setMonth(x.getMonth()+1,0); return x.toISOString().slice(0,10); };
  const endOfYear = d => d.slice(0,4)+'-12-31';
  const enumDates = (a,b) => { const out=[]; let d=new Date(a+'T00:00:00'); const end=new Date(b+'T00:00:00'); while(d<=end){out.push(d.toISOString().slice(0,10));d.setDate(d.getDate()+1);} return out; };
  const prevDate = (d,n=1) => { const x=new Date(d+'T00:00:00'); x.setDate(x.getDate()-n); return x.toISOString().slice(0,10); };
  const actualQty = (d,pid) => {
    const facId = state.ui.selectedFacilityId || s.facilityIds[0] || state.org.facilities[0]?.id || '';
    const r=s.dataset.actuals.shipments.find(x=>x.facilityId===facId&&x.date===d&&x.productId===pid);
    return r?+r.qtyStn:null;
  };
  const hasActual = (d,pid) => actualQty(d,pid)!=null;
  const weekdaySample = (pid,start,n) => { const vals=[]; let cur=prevDate(start,1); let g=0; while(vals.length<n&&g<500){g++;const dow=new Date(cur+'T00:00:00').getDay();if(dow>=1&&dow<=5){const q=actualQty(cur,pid);if(q!=null)vals.push(q);}cur=prevDate(cur,1);} return vals; };
  const satCoef = (pid,start) => { const sat=[],wk=[]; let cur=prevDate(start,1); let g=0; while((sat.length<4||wk.length<20)&&g<400){g++;const dow=new Date(cur+'T00:00:00').getDay();const q=actualQty(cur,pid);if(q!=null){if(dow===6&&sat.length<4)sat.push(q);if(dow>=1&&dow<=5&&wk.length<20)wk.push(q);}cur=prevDate(cur,1);} const avgW=wk.length?wk.reduce((a,b)=>a+b,0)/wk.length:0;const avgS=sat.length?sat.reduce((a,b)=>a+b,0)/sat.length:0;return avgW>0?avgS/avgW:0; };

  const buildRows = () => {
    const pid=q('fcProduct').value; const start=q('fcStart').value; const method=q('fcMethod').value; const shipsSat=q('fcAllowSat').checked;
    const msg=[]; let rows=[];
    if(!pid||!start) return {rows,msg:['Select product and start date.']};
    if(method==='rolling'){
      const n=+q('fcRollingN').value; const sample=weekdaySample(pid,start,n);
      const avgW=sample.length?sample.reduce((a,b)=>a+b,0)/sample.length:0;
      const sc=shipsSat?satCoef(pid,start):0;
      msg.push(`Weekday avg: ${avgW.toFixed(1)} STn (${sample.length}/${n} pts) · Sat coef: ${sc.toFixed(2)}`);
      rows=enumDates(start,endOfMonth(start)).map(d=>({date:d,productId:pid,qtyStn:isSunday(d)?0:isSaturday(d)?(shipsSat?Math.round(avgW*sc):0):Math.round(avgW)}));
    } else if(method==='fixed'){
      const v=+q('fcFixedVal').value||0; const hz=q('fcHorizon').value;
      const end=hz==='eom'?endOfMonth(start):hz==='eoy'?endOfYear(start):(q('fcEndDate').value||start);
      rows=enumDates(start,end).map(d=>({date:d,productId:pid,qtyStn:isSunday(d)?0:(!shipsSat&&isSaturday(d)?0:v)}));
      msg.push(`Fixed ${v} STn/day from ${start} to ${end}`);
    } else {
      const total=+q('fcMonthTotal').value||0; const end=endOfMonth(start);
      const all=enumDates(start,end); const elig=all.filter(d=>!hasActual(d,pid)&&!isSunday(d)&&(shipsSat||!isSaturday(d)));
      if(!elig.length){msg.push('No eligible days.'); return {rows:[],msg};}
      const per=total/elig.length; let rem=total;
      rows=all.map(d=>({date:d,productId:pid,qtyStn:0}));
      elig.forEach((d,i)=>{ let qv=i===elig.length-1?rem:Math.round(per); rem-=qv; const row=rows.find(r=>r.date===d); row.qtyStn=qv; });
      msg.push(`Distributed ${total} STn over ${elig.length} eligible days`);
    }
    rows=rows.map(r=>hasActual(r.date,r.productId)?{...r,qtyStn:0}:r);
    const blocked=rows.filter(r=>r.qtyStn===0&&hasActual(r.date,r.productId)).length;
    if(blocked) msg.push(`${blocked} actual date(s) skipped`);
    return {rows,msg};
  };

  q('fcPreview').onclick = () => {
    const {rows,msg}=buildRows();
    q('fcMsg').textContent=[...msg,`Preview: ${rows.filter(r=>r.qtyStn>0).length} days with data`].join(' · ');
  };
  q('fcApply').onclick = () => {
    const {rows,msg}=buildRows();
    // Use selectedFacilityId — if empty fall back to first facility in scope
    const fac = state.ui.selectedFacilityId || s.facilityIds[0] || state.org.facilities[0]?.id || '';
    if(!fac){ showToast('Select a facility first', 'err'); return; }
    const keys=new Set(rows.map(r=>`${r.date}|${fac}|${r.productId}`));
    s.dataset.demandForecast=s.dataset.demandForecast.filter(x=>!keys.has(`${x.date}|${x.facilityId}|${x.productId}`));
    rows.filter(r=>(+r.qtyStn||0)>0&&!hasActual(r.date,r.productId)).forEach(r=>s.dataset.demandForecast.push({date:r.date,facilityId:fac,productId:r.productId,qtyStn:+r.qtyStn,source:'forecast'}));
    persist(); renderDemand('total'); renderPlan();
    q('fcMsg').innerHTML=`<span style="color:var(--ok)">✓ Applied to ${fac}</span> — `+[...msg].join(' · ');
    showToast('Forecast applied ✓');
  };
}

/* ─────────────────── CAMPAIGN DIALOG ─────────────────── */
function openCampaignDialog(){
  const s = selectors(state); const a = actions(state);
  const host = el('campaignDialog');
  const eqs = s.equipment.filter(e=>['kiln','finish_mill'].includes(e.type));
  const todayStr = yesterdayLocal();

  // Build compact campaign list: group consecutive same-eq/status/product rows into blocks
  const camps = s.dataset.campaigns
    .filter(c=>c.facilityId===state.ui.selectedFacilityId)
    .sort((a,b)=>a.equipmentId.localeCompare(b.equipmentId)||a.date.localeCompare(b.date));

  const blocks = [];
  camps.forEach(c=>{
    const last = blocks[blocks.length-1];
    const prevDate = last ? new Date(last.end+'T00:00:00') : null;
    if(prevDate) prevDate.setDate(prevDate.getDate()+1);
    const isContiguous = last && last.equipmentId===c.equipmentId && last.status===c.status && last.productId===c.productId && prevDate && prevDate.toISOString().slice(0,10)===c.date;
    if(isContiguous){ last.end=c.date; last.days++; }
    else blocks.push({equipmentId:c.equipmentId, status:c.status||'produce', productId:c.productId||'', start:c.date, end:c.date, days:1});
  });
  blocks.sort((a,b)=>b.start.localeCompare(a.start));

  const statusLabel = st => ({'produce':'Produce','maintenance':'Maint.','out_of_order':'OOO','idle':'Idle'}[st]||st);
  const statusPill = st => ({'produce':'pill-green','maintenance':'pill-amber','out_of_order':'pill-purple','idle':'pill-gray'}[st]||'pill-gray');

  // blocks already built above — grouped rendering done after DOM creation

  host.classList.add('open');
  host.innerHTML = `<div class="modal" style="max-width:860px">
    <div class="modal-header">
      <div><div class="modal-title">🎯 Campaign Planner</div><div style="font-size:11px;color:var(--muted)">Define production blocks. Daily Actuals override planned values.</div></div>
      <button class="btn" id="campClose">Close</button>
    </div>
    <div class="modal-body" style="display:grid;grid-template-columns:1fr 320px;gap:20px">

      <div>
        <div style="font-weight:600;margin-bottom:12px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">New Block</div>
        <div class="form-grid" style="margin-bottom:12px">
          <div><label class="form-label">Equipment</label><select class="form-input" id="campEq">${eqs.map(e=>`<option value="${e.id}">${esc(e.name)} (${e.type})</option>`).join('')}</select></div>
          <div><label class="form-label">Status</label><select class="form-input" id="campStatus"><option value="produce">Produce</option><option value="maintenance">Maintenance (planned)</option><option value="out_of_order">Out of Order (unplanned)</option><option value="idle">Idle</option></select></div>
          <div id="campProductWrap"><label class="form-label">Product</label><select class="form-input" id="campProduct"></select></div>
        </div>

        <!-- Smart date calculator -->
        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:10px;">Date Range — fill any two, third auto-calculates</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;align-items:end;">
            <div>
              <label class="form-label">Start date</label>
              <input class="form-input" type="date" id="campStart" value="${todayStr}">
            </div>
            <div>
              <label class="form-label">End date</label>
              <input class="form-input" type="date" id="campEnd" value="${todayStr}">
            </div>
            <div>
              <label class="form-label">Duration (days)</label>
              <input class="form-input text-mono" type="number" min="1" id="campDuration" value="1">
            </div>
          </div>
        </div>

        <div class="rate-helper" id="campRateAssist">
          <div class="rate-helper-title">Rate Helper — trimmed rolling actuals</div>
          <div class="rate-grid">
            <div class="rate-cell"><div class="rate-cell-label">Cap max</div><div class="rate-cell-value" id="campCapRate">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Source</div><div class="rate-cell-value" id="campRollSource" style="font-size:10px;color:var(--muted)">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Roll 7d</div><div class="rate-cell-value" id="campRoll7">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Roll 15d</div><div class="rate-cell-value" id="campRoll15">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Roll 30d</div><div class="rate-cell-value" id="campRoll30">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Will apply</div><div class="rate-cell-value" id="campRateEcho">—</div></div>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button class="btn" id="campUseCap" style="font-size:11px">Use Cap</button>
            <button class="btn" id="campUse7" style="font-size:11px">7d</button>
            <button class="btn" id="campUse15" style="font-size:11px">15d</button>
            <button class="btn" id="campUse30" style="font-size:11px">30d</button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end;margin-top:12px;">
          <div><label class="form-label">Rate (STn/day)</label><input class="form-input text-mono" type="number" step="0.1" id="campRate" value="0"></div>
          <button class="btn btn-primary" id="campApply" style="height:36px">Apply Block</button>
          <button class="btn" id="campClearRange" style="height:36px">Clear Range</button>
        </div>
        <div style="font-size:11px;color:var(--ok);min-height:16px;margin-top:6px" id="campMsg"></div>
      </div>

      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">Saved Blocks</div>
          <div style="font-size:10px;color:var(--muted)" id="blockCount"></div>
        </div>
        <div id="campBlockList" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:520px;overflow-y:auto;"></div>
      </div>

    </div>
  </div>`;

  const q = id => host.querySelector('#'+id);
  const rateCache = {cap:null,r7:null,r15:null,r30:null};

  const avgTrimmed = vals => {
    let arr=[...(vals||[])].filter(v=>isFinite(v)&&v>0);
    if(!arr.length) return null;
    if(arr.length>=5){ const mn=Math.min(...arr),mx=Math.max(...arr); let dm=false,dM=false; arr=arr.filter(v=>{if(!dm&&v===mn){dm=true;return false;}if(!dM&&v===mx){dM=true;return false;}return true;}); }
    if(!arr.length) return null;
    return arr.reduce((a,b)=>a+b,0)/arr.length;
  };

  const computeRolling = (eqId,productId,startDate,n) => {
    if(!eqId||!productId||!startDate||!n) return {value:null,source:'none',points:0};
    const ds=s.dataset; const fac=state.ui.selectedFacilityId;
    const d=new Date(startDate+'T00:00:00'); d.setDate(d.getDate()-1);
    const collect=mode=>{ const vals=[]; let cur=new Date(d.getTime()); let g=0; while(vals.length<n&&g<400){const date=cur.toISOString().slice(0,10);const rows=ds.actuals.production.filter(r=>r.date===date&&r.facilityId===fac&&r.productId===productId);let qty=0;if(mode==='eq')qty=rows.filter(r=>r.equipmentId===eqId).reduce((s0,r)=>s0+(+r.qtyStn||0),0);else qty=rows.reduce((s0,r)=>s0+(+r.qtyStn||0),0);if(qty>0)vals.push(qty);cur.setDate(cur.getDate()-1);g++;} return vals; };
    let vals=collect('eq'); let source='equipment+product';
    if(!vals.length){vals=collect('facility');source='facility+product';}
    if(!vals.length) return {value:null,source:'none',points:0};
    return {value:avgTrimmed(vals),source,points:vals.length};
  };

  const writeRate = v => { if(!isFinite(v)) return; q('campRate').value=String(Math.round(v*10)/10); q('campRateEcho').textContent=`${fmt(v)} STn/d`; };
  const renderHelpers = () => {
    const eqId=q('campEq').value; const status=q('campStatus').value; const productId=q('campProduct').value; const startDate=q('campStart').value;
    const cap=s.getCapsForEquipment(eqId).find(c=>c.productId===productId);
    rateCache.cap=cap?.maxRateStpd??null;
    q('campCapRate').textContent=isFinite(rateCache.cap)?`${fmt(rateCache.cap)} STn/d`:'—';
    if(status!=='produce'||!productId){ q('campRateAssist').style.opacity='0.5'; q('campRollSource').textContent='—'; ['7','15','30'].forEach(k=>q('campRoll'+k).textContent='—'); q('campRateEcho').textContent=`${fmt(+q('campRate').value||0)} STn/d`; return; }
    q('campRateAssist').style.opacity='1';
    const r7=computeRolling(eqId,productId,startDate,7); const r15=computeRolling(eqId,productId,startDate,15); const r30=computeRolling(eqId,productId,startDate,30);
    rateCache.r7=r7.value; rateCache.r15=r15.value; rateCache.r30=r30.value;
    q('campRoll7').textContent=isFinite(r7.value)?`${fmt(r7.value)} (${r7.points})`:'N/A';
    q('campRoll15').textContent=isFinite(r15.value)?`${fmt(r15.value)} (${r15.points})`:'N/A';
    q('campRoll30').textContent=isFinite(r30.value)?`${fmt(r30.value)} (${r30.points})`:'N/A';
    q('campRollSource').textContent=[r7,r15,r30].find(x=>x.source&&x.source!=='none')?.source||'none';
    q('campRateEcho').textContent=`${fmt(+q('campRate').value||0)} STn/d`;
  };

  const refreshProducts = () => {
    const eqId=q('campEq').value; const status=q('campStatus').value;
    const caps=s.getCapsForEquipment(eqId);
    q('campProduct').innerHTML=caps.map(c=>`<option value="${c.productId}">${esc(s.getMaterial(c.productId)?.name||c.productId)} @ ${fmt0(c.maxRateStpd)} STn/d</option>`).join('');
    q('campProductWrap').style.display=status==='produce'?'':'none';
    q('campRate').disabled=status!=='produce';
    if(status==='produce'){ const firstCap=caps[0]; if(firstCap&&isFinite(+firstCap.maxRateStpd)) q('campRate').value=String(+firstCap.maxRateStpd||0); } else q('campRate').value='0';
    renderHelpers();
  };

  // Smart date calculator — fill any 2, third auto-calculates
  let _lastDateEdit = 'duration'; // track which field was last manually edited
  const dateCalc = (changed) => {
    _lastDateEdit = changed;
    const start = q('campStart').value;
    const end   = q('campEnd').value;
    const dur   = parseInt(q('campDuration').value)||1;
    if(changed==='start' || changed==='end'){
      if(start && end){
        const ms = new Date(end+'T00:00:00') - new Date(start+'T00:00:00');
        const d = Math.round(ms/86400000)+1;
        if(d>=1) q('campDuration').value = d;
      }
    } else if(changed==='duration'){
      if(start && dur>=1){
        const s2 = new Date(start+'T00:00:00');
        s2.setDate(s2.getDate()+dur-1);
        q('campEnd').value = s2.toISOString().slice(0,10);
      } else if(end && dur>=1){
        const e2 = new Date(end+'T00:00:00');
        e2.setDate(e2.getDate()-(dur-1));
        q('campStart').value = e2.toISOString().slice(0,10);
      }
    }
    renderHelpers();
  };

  q('campEq').onchange=refreshProducts; q('campStatus').onchange=refreshProducts;
  q('campProduct').onchange=()=>{ const eqId=q('campEq').value; const cap=s.getCapsForEquipment(eqId).find(c=>c.productId===q('campProduct').value); if(cap&&isFinite(+cap.maxRateStpd)) q('campRate').value=String(+cap.maxRateStpd||0); renderHelpers(); };
  q('campStart').onchange=()=>dateCalc('start');
  q('campEnd').onchange=()=>dateCalc('end');
  q('campDuration').oninput=()=>dateCalc('duration');
  q('campRate').oninput=()=>q('campRateEcho').textContent=`${fmt(+q('campRate').value||0)} STn/d`;
  q('campUseCap').onclick=()=>writeRate(rateCache.cap); q('campUse7').onclick=()=>writeRate(rateCache.r7); q('campUse15').onclick=()=>writeRate(rateCache.r15); q('campUse30').onclick=()=>writeRate(rateCache.r30);
  // Init duration from default start/end
  dateCalc('end');
  refreshProducts();
  // ── BLOCK LIST: grouped by equipment, collapsible, edit/delete ──
  const collapsedEqs = new Set();

  const renderBlockList = () => {
    const listEl = q('campBlockList');
    const countEl = q('blockCount');
    if(!listEl) return;

    // Group blocks by equipment
    const byEq = {};
    blocks.forEach(b => {
      if(!byEq[b.equipmentId]) byEq[b.equipmentId] = [];
      byEq[b.equipmentId].push(b);
    });

    if(!blocks.length){
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">No campaigns yet</div>';
      if(countEl) countEl.textContent = '';
      return;
    }
    if(countEl) countEl.textContent = `${blocks.length} block${blocks.length!==1?'s':''}`;

    listEl.innerHTML = Object.entries(byEq).map(([eqId, eqBlocks]) => {
      const eq = s.getEquipment(eqId);
      const eqName = eq?.name || eqId;
      const isCollapsed = collapsedEqs.has(eqId);
      const totalDays = eqBlocks.reduce((t,b)=>t+b.days,0);
      const pills = ['produce','maintenance','out_of_order','idle'].map(st => {
        const n = eqBlocks.filter(b=>b.status===st).length;
        return n ? `<span class="pill ${statusPill(st)}" style="font-size:9px;padding:1px 5px">${n}</span>` : '';
      }).join('');

      const rows = isCollapsed ? '' : eqBlocks.map((b,bi) => {
        const prod = b.productId ? (s.getMaterial(b.productId)?.code || s.getMaterial(b.productId)?.name || '') : '';
        const isEditing = b._editing;
        if(isEditing){
          // Inline edit row
          const prodOpts = s.getCapsForEquipment(eqId).map(c=>`<option value="${c.productId}" ${c.productId===b.productId?'selected':''}>${esc(s.getMaterial(c.productId)?.name||c.productId)}</option>`).join('');
          return `<div class="camp-edit-row" data-eq="${eqId}" data-bi="${bi}" style="padding:8px;background:rgba(99,179,237,0.06);border-bottom:1px solid var(--border)">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
              <div><label class="form-label" style="font-size:9px">Status</label>
                <select class="form-input" style="font-size:11px" data-edit-status>
                  <option value="produce" ${b.status==='produce'?'selected':''}>Produce</option>
                  <option value="maintenance" ${b.status==='maintenance'?'selected':''}>Maintenance</option>
                  <option value="out_of_order" ${b.status==='out_of_order'?'selected':''}>Out of Order</option>
                  <option value="idle" ${b.status==='idle'?'selected':''}>Idle</option>
                </select>
              </div>
              <div class="edit-product-wrap" style="${b.status==='produce'?'':'display:none'}">
                <label class="form-label" style="font-size:9px">Product</label>
                <select class="form-input" style="font-size:11px" data-edit-product>${prodOpts}</select>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:6px">
              <div><label class="form-label" style="font-size:9px">Start</label>
                <input class="form-input" type="date" style="font-size:11px" data-edit-start value="${b.start}">
              </div>
              <div><label class="form-label" style="font-size:9px">End</label>
                <input class="form-input" type="date" style="font-size:11px" data-edit-end value="${b.end}">
              </div>
              <div><label class="form-label" style="font-size:9px">Rate STn/d</label>
                <input class="form-input" type="number" step="0.1" style="font-size:11px" data-edit-rate value="${b.rateStn||0}">
              </div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-primary" style="font-size:10px;padding:3px 10px" data-save-edit="${eqId}|${bi}">Save</button>
              <button class="btn" style="font-size:10px;padding:3px 10px" data-cancel-edit="${eqId}|${bi}">Cancel</button>
            </div>
          </div>`;
        }
        return `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--border);font-size:11px">
          <span class="pill ${statusPill(b.status)}" style="font-size:9px;padding:1px 5px;flex-shrink:0">${statusLabel(b.status)}</span>
          <span style="flex:1;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(prod)}">${prod ? esc(prod) : '<span style="color:var(--muted)">—</span>'}</span>
          <span class="text-mono" style="color:var(--muted);font-size:10px;flex-shrink:0">${b.start.slice(5)}→${b.end.slice(5)}</span>
          <span class="text-mono" style="color:var(--muted);font-size:10px;flex-shrink:0;min-width:24px;text-align:right">${b.days}d</span>
          <button class="action-btn" style="font-size:10px;padding:1px 6px;flex-shrink:0" data-edit-block="${eqId}|${bi}">Edit</button>
          <button class="action-btn del" style="font-size:10px;padding:1px 6px;flex-shrink:0" data-del-block="${eqId}|${bi}">Del</button>
        </div>`;
      }).join('');

      return `<div style="border-bottom:1px solid var(--border)">
        <div class="camp-eq-header" data-toggle-eq="${eqId}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,0.04);cursor:pointer;user-select:none">
          <span style="font-size:10px;color:var(--muted)">${isCollapsed?'▶':'▼'}</span>
          <span style="font-weight:700;font-size:11px;flex:1">${esc(eqName)}</span>
          <span style="display:flex;gap:3px">${pills}</span>
          <span style="font-size:10px;color:var(--muted)">${totalDays}d total</span>
        </div>
        ${rows}
      </div>`;
    }).join('');
  };

  // Wire block list interactions (delegated)
  const blockListEl = q('campBlockList');
  if(blockListEl){
    blockListEl.addEventListener('click', e => {
      // Toggle equipment group collapse
      const toggleBtn = e.target.closest('[data-toggle-eq]');
      if(toggleBtn){
        const eqId = toggleBtn.dataset.toggleEq;
        if(collapsedEqs.has(eqId)) collapsedEqs.delete(eqId);
        else collapsedEqs.add(eqId);
        renderBlockList(); return;
      }

      // Edit block
      const editBtn = e.target.closest('[data-edit-block]');
      if(editBtn){
        const [eqId, bi] = editBtn.dataset.editBlock.split('|');
        const eqBlocks = blocks.filter(b=>b.equipmentId===eqId);
        eqBlocks.forEach(b=>delete b._editing);
        if(eqBlocks[+bi]) eqBlocks[+bi]._editing = true;
        collapsedEqs.delete(eqId);
        renderBlockList(); return;
      }

      // Cancel edit
      const cancelBtn = e.target.closest('[data-cancel-edit]');
      if(cancelBtn){
        const [eqId] = cancelBtn.dataset.cancelEdit.split('|');
        blocks.filter(b=>b.equipmentId===eqId).forEach(b=>delete b._editing);
        renderBlockList(); return;
      }

      // Status change → show/hide product
      const statusSel = e.target.closest('[data-edit-status]');
      if(statusSel){
        const row = statusSel.closest('.camp-edit-row');
        if(row){
          const wrap = row.querySelector('.edit-product-wrap');
          if(wrap) wrap.style.display = statusSel.value==='produce' ? '' : 'none';
        }
        return;
      }

      // Save edit
      const saveBtn = e.target.closest('[data-save-edit]');
      if(saveBtn){
        const row = saveBtn.closest('.camp-edit-row');
        if(!row) return;
        const [eqId] = saveBtn.dataset.saveEdit.split('|');
        const newStatus  = row.querySelector('[data-edit-status]').value;
        const newProduct = row.querySelector('[data-edit-product]')?.value || '';
        const newStart   = row.querySelector('[data-edit-start]').value;
        const newEnd     = row.querySelector('[data-edit-end]').value;
        const newRate    = +row.querySelector('[data-edit-rate]').value || 0;
        if(!newStart || !newEnd){ showToast('Start and end dates required', 'warn'); return; }
        // Find the block being edited and delete its old date range, then save new
        const bi = +saveBtn.dataset.saveEdit.split('|')[1];
        const eqBlocks = blocks.filter(b=>b.equipmentId===eqId);
        const oldBlock = eqBlocks[bi];
        if(oldBlock){
          a.deleteCampaignRange({equipmentId:eqId, startDate:oldBlock.start, endDate:oldBlock.end});
          a.saveCampaignBlock({equipmentId:eqId, status:newStatus, productId:newProduct, startDate:newStart, endDate:newEnd, rateStn:newRate});
          persist(); renderPlan(); showToast('Block updated ✓');
          openCampaignDialog(); // full refresh
        }
        return;
      }

      // Delete block
      const delBtn = e.target.closest('[data-del-block]');
      if(delBtn){
        const [eqId, bi] = delBtn.dataset.delBlock.split('|');
        const eqBlocks = blocks.filter(b=>b.equipmentId===eqId);
        const b = eqBlocks[+bi];
        if(!b) return;
        const eq = s.getEquipment(eqId);
        if(!confirm(`Delete ${b.days}d ${b.status} block for ${eq?.name||eqId} (${b.start} → ${b.end})?`)) return;
        a.deleteCampaignRange({equipmentId:eqId, startDate:b.start, endDate:b.end});
        persist(); renderPlan(); showToast('Block deleted ✓');
        openCampaignDialog();
        return;
      }
    });

    // Also wire status change via change event (not just click)
    blockListEl.addEventListener('change', e => {
      const statusSel = e.target.closest('[data-edit-status]');
      if(statusSel){
        const row = statusSel.closest('.camp-edit-row');
        if(row){
          const wrap = row.querySelector('.edit-product-wrap');
          if(wrap) wrap.style.display = statusSel.value==='produce' ? '' : 'none';
        }
      }
    });
  }

  renderBlockList();

  q('campClose').onclick=()=>host.classList.remove('open');
  host.onclick=e=>{ if(e.target===host) host.classList.remove('open'); };
  q('campApply').onclick=e=>{ e.preventDefault(); const payload={equipmentId:q('campEq').value,status:q('campStatus').value,productId:q('campProduct').value,startDate:q('campStart').value,endDate:q('campEnd').value,rateStn:+q('campRate').value||0}; if(payload.status==='produce'&&!payload.productId){q('campMsg').textContent='Select a product.';return;} a.saveCampaignBlock(payload); persist(); q('campMsg').textContent='✓ Campaign block applied'; renderPlan(); openCampaignDialog(); showToast('Campaign applied ✓'); };
  q('campClearRange').onclick=e=>{ e.preventDefault(); a.deleteCampaignRange({equipmentId:q('campEq').value,startDate:q('campStart').value,endDate:q('campEnd').value}); persist(); q('campMsg').textContent='✓ Range cleared'; renderPlan(); openCampaignDialog(); };
}

/* ─────────────────── DAILY ACTUALS DIALOG ─────────────────── */
function openDailyActualsDialog(preselectedFacId){
  const host = el('dailyActualsDialog');

  // Resolve selected IDs down to actual facility IDs only
  // (selectedFacilityIds can contain subregion/region/country IDs too)
  const org = state.org;
  const resolveToFacilities = (ids) => {
    const facIds = [];
    (ids||[]).forEach(id => {
      if(org.facilities.find(f=>f.id===id)){
        facIds.push(id);
      } else if(org.subRegions.find(s=>s.id===id)){
        org.facilities.filter(f=>f.subRegionId===id).forEach(f=>facIds.push(f.id));
      } else if(org.regions.find(r=>r.id===id)){
        const srIds = org.subRegions.filter(s=>s.regionId===id).map(s=>s.id);
        org.facilities.filter(f=>srIds.includes(f.subRegionId)).forEach(f=>facIds.push(f.id));
      } else if(org.countries.find(c=>c.id===id)){
        const rIds  = org.regions.filter(r=>r.countryId===id).map(r=>r.id);
        const srIds = org.subRegions.filter(s=>rIds.includes(s.regionId)).map(s=>s.id);
        org.facilities.filter(f=>srIds.includes(f.subRegionId)).forEach(f=>facIds.push(f.id));
      }
    });
    return [...new Set(facIds)];
  };

  const rawIds  = (state.ui.selectedFacilityIds||[]).length
    ? state.ui.selectedFacilityIds
    : org.facilities.map(f=>f.id);
  const facIds  = resolveToFacilities(rawIds);
  const facs    = facIds.map(id=>org.facilities.find(f=>f.id===id)).filter(Boolean);

  let activeFacId = preselectedFacId || facIds[0] || '';

  const buildForm = () => {
    // Scope selectors to this one facility using the legacy selectedFacilityId path
    const facState = {...state, ui:{...state.ui, selectedFacilityId: activeFacId, selectedFacilityIds:[activeFacId]}};
    const s = selectors(facState);
    const a = actions(facState);

    const y = host.querySelector('#actualsDate')?.value || yesterdayLocal();
    const kf = s.equipment.filter(e=>e.type==='kiln');
    const ff = s.equipment.filter(e=>e.type==='finish_mill');
    const rf = s.equipment.filter(e=>e.type==='raw_mill');
    const canEqProd = (eqId,pid) => s.capabilities.some(c=>c.equipmentId===eqId&&c.productId===pid);
    const existing = s.actualsForDate(y);
    const invMap  = new Map((existing.inv ||[]).map(r=>[`${r.storageId}|${r.productId}`,r.qtyStn]));
    const prodMap = new Map((existing.prod||[]).map(r=>[`${r.equipmentId}|${r.productId}`,r.qtyStn]));
    const shipMap = new Map((existing.ship||[]).map(r=>[r.productId,r.qtyStn]));

    const fac = state.org.facilities.find(f=>f.id===activeFacId);
    const facLabel = fac ? `${fac.code} — ${fac.name}` : activeFacId;

    // Facility tabs
    const tabsHTML = facs.length > 1 ? `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)">
        ${facs.map(f=>`<button data-fac-tab="${f.id}" style="padding:5px 14px;border-radius:6px;border:1px solid ${f.id===activeFacId?'var(--accent)':'var(--border)'};background:${f.id===activeFacId?'rgba(99,179,237,0.15)':'transparent'};color:${f.id===activeFacId?'var(--accent)':'var(--muted)'};font-size:11px;font-weight:${f.id===activeFacId?'700':'400'};cursor:pointer">${esc(f.code||f.id)}</button>`).join('')}
      </div>` : '';

    // Pre-compute filtered HTML blocks to avoid nested template literal issues
    const facEqAll = [...rf,...kf,...ff];
    const facMats  = s.materials.filter(m => facEqAll.some(eq => canEqProd(eq.id, m.id)));
    const prodTableHTML = facEqAll.length
      ? '<table class="data-table" style="min-width:max-content"><thead><tr>' +
        '<th style="min-width:160px;position:sticky;left:0;background:#0a0d14;z-index:3">Equipment</th>' +
        facMats.map(m=>'<th style="min-width:90px">'+esc(m.code||m.name.slice(0,10))+'</th>').join('') +
        '</tr></thead><tbody>' +
        facEqAll.map(eq =>
          '<tr><td style="font-weight:600;position:sticky;left:0;background:var(--surface2);z-index:2">' +
          esc(eq.name)+' <span class="pill pill-gray" style="font-size:9px">'+eq.type+'</span></td>' +
          facMats.map(m => canEqProd(eq.id,m.id)
            ? '<td><input class="cell-input prod-input" data-equipment="'+eq.id+'" data-product="'+m.id+'" value="'+(prodMap.get(eq.id+'|'+m.id)??'')+'"></td>'
            : '<td class="cell-gray">—</td>'
          ).join('') + '</tr>'
        ).join('') +
        '</tbody></table>'
      : '<div class="text-muted" style="font-size:12px;padding:12px;text-align:center">No equipment for this facility</div>';

    // Derive finished products: use capabilities for production plants, facilityProducts for terminals
    const facEqForShip = s.dataset.equipment.filter(e=>e.facilityId===activeFacId);
    const isProductionPlant = facEqForShip.length > 0;
    let facFPs;
    if(isProductionPlant){
      // Products = unique finished products from capabilities
      const capProdIds = new Set(
        s.dataset.capabilities
          .filter(c=>facEqForShip.some(e=>e.id===c.equipmentId))
          .map(c=>c.productId)
      );
      facFPs = s.finishedProducts.filter(fp=>capProdIds.has(fp.id));
    } else {
      // Terminal — use facilityProducts
      const facProdIds = new Set((s.dataset.facilityProducts||[]).filter(fp=>fp.facilityId===activeFacId).map(fp=>fp.productId));
      facFPs = s.finishedProducts.filter(fp=>facProdIds.has(fp.id));
    }
    const shipHTML = facFPs.length
      ? facFPs.map(fp =>
          '<div style="display:flex;align-items:center;justify-content:space-between;border:1px solid var(--border);border-radius:6px;padding:8px 12px">' +
          '<span style="font-size:12px;font-weight:500">'+esc(fp.name)+'</span>' +
          '<input class="cell-input ship-input" style="max-width:100px" data-product="'+fp.id+'" value="'+(shipMap.get(fp.id)??'')+'">' +
          '</div>'
        ).join('')
      : '<div class="text-muted" style="font-size:12px">No finished products for this facility.</div>';

    host.querySelector('#actualsFormBody').innerHTML = `
      ${tabsHTML}
      <div style="margin-bottom:12px;font-size:12px;font-weight:600;color:var(--accent)">📍 ${esc(facLabel)}</div>

      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:16px">
        <div><label class="form-label">Date (default: yesterday)</label><input class="form-input" type="date" id="actualsDate" value="${y}"></div>
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">1. Ending Inventory (STn)</div>
      <div class="table-scroll" style="margin-bottom:20px;max-height:200px;border-radius:8px;overflow-y:auto !important;border:1px solid var(--border)">
        <table class="data-table"><thead><tr><th>Storage</th><th>Product</th><th>EOD Quantity (STn)</th></tr></thead>
        <tbody>${s.storages.map(st=>{const pid=(st.allowedProductIds||[])[0]||'';return`<tr><td style="font-weight:600">${esc(st.name)}</td><td>${esc(s.getMaterial(pid)?.name||'')}</td><td><input class="cell-input inv-input" data-storage="${st.id}" data-product="${pid}" value="${invMap.get(`${st.id}|${pid}`)??''}"></td></tr>`;}).join('')||'<tr><td colspan="3" class="text-muted" style="text-align:center;padding:12px">No storages for this facility</td></tr>'}</tbody>
        </table>
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">2. Production Actuals (STn)</div>
      <div class="table-scroll" style="margin-bottom:20px;max-height:260px;border-radius:8px;overflow-x:auto;overflow-y:auto;border:1px solid var(--border)">
        ${prodTableHTML}
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">3. Customer Shipments (STn)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">
        ${shipHTML}
      </div>`;

    // Facility tab switching
    host.querySelectorAll('[data-fac-tab]').forEach(btn => {
      btn.onclick = () => { activeFacId = btn.dataset.facTab; buildForm(); };
    });

    // Date change reloads existing actuals
    host.querySelector('#actualsDate').onchange = () => buildForm();

    // Save button
    host.querySelector('#saveActualsBtn').onclick = ev => {
      ev.preventDefault();
      const date = host.querySelector('#actualsDate').value;
      const inventoryRows  = [...host.querySelectorAll('.inv-input')].map(i=>({storageId:i.dataset.storage,productId:i.dataset.product,qtyStn:+i.value||0})).filter(r=>r.productId);
      const productionRows = [...host.querySelectorAll('.prod-input')].map(i=>({equipmentId:i.dataset.equipment,productId:i.dataset.product,qtyStn:+i.value||0}));
      const shipmentRows   = [...host.querySelectorAll('.ship-input')].map(i=>({productId:i.dataset.product,qtyStn:+i.value||0}));
      a.saveDailyActuals({date, inventoryRows, productionRows, shipmentRows});
      persist(); renderDemand(); renderPlan(); showToast(`Actuals saved for ${activeFacId} ✓`);
    };
  };

  host.classList.add('open');
  host.innerHTML = `<div class="modal" style="max-width:960px">
    <div class="modal-header">
      <div><div class="modal-title">📝 Daily Actuals Entry</div><div style="font-size:11px;color:var(--muted)">${state.ui.mode.toUpperCase()}</div></div>
      <button class="btn" id="actClose">Close</button>
    </div>
    <div class="modal-body" id="actualsFormBody" style="min-height:200px"></div>
    <div class="modal-footer">
      <button class="btn" id="actClose2">Cancel</button>
      <button class="btn btn-primary" id="saveActualsBtn">Save to ${state.ui.mode==='sandbox'?'Sandbox':'Official'}</button>
    </div>
  </div>`;

  const close = () => host.classList.remove('open');
  host.querySelector('#actClose').onclick  = close;
  host.querySelector('#actClose2').onclick = close;
  host.onclick = e => { if(e.target===host) close(); };

  buildForm();
}

/* ─────────────────── DATA TAB ─────────────────── */
function renderData(){
  const root = el('tab-data');
  const s = selectors(state);
  const ds = s.dataset;
  const tables = {
    Material: ds.materials,
    RecipeHeader: ds.recipes.map(r=>({id:r.id,facilityId:r.facilityId,productId:r.productId,version:r.version,components:r.components.length})),
    RecipeComponent: ds.recipes.flatMap(r=>r.components.map(c=>({recipeId:r.id,productId:r.productId,materialId:c.materialId,pct:c.pct}))),
    Equipment: ds.equipment,
    Storage: ds.storages,
    Capabilities: ds.capabilities,
    InventoryEOD: ds.actuals.inventoryEOD,
    ProductionActuals: ds.actuals.production,
    Shipments: ds.actuals.shipments,
    DemandForecast: ds.demandForecast,
    Campaigns: ds.campaigns,
  };

  root.innerHTML = `
  <div class="card">
    <div class="card-header">
      <div><div class="card-title">Data Inspector</div><div class="card-sub text-muted">Debug view · Current scenario: ${state.ui.mode.toUpperCase()}</div></div>
      <div class="flex gap-2">
        <button id="exportJson" class="btn">↓ Export JSON</button>
        <button id="importJson" class="btn">↑ Import JSON</button>
        <input id="jsonFile" type="file" accept="application/json" class="hidden">
      </div>
    </div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px">
        ${Object.entries(tables).map(([name,rows])=>`
        <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <div style="padding:8px 12px;background:var(--surface2);font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:space-between">
            <span>${name}</span><span class="pill pill-gray">${rows.length}</span>
          </div>
          <pre style="font-size:10px;padding:10px;overflow:auto;max-height:200px;color:var(--muted);line-height:1.5;margin:0">${esc(JSON.stringify(rows.slice(0,20),null,2))}</pre>
        </div>`).join('')}
      </div>
    </div>
  </div>`;

  root.querySelector('#exportJson').onclick = () => {
    const data = JSON.stringify(state[state.ui.mode], null, 2);
    const blob = new Blob([data],{type:'application/json'});
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`cement_planner_${state.ui.mode}.json`; a.click(); URL.revokeObjectURL(a.href);
  };
  root.querySelector('#importJson').onclick = () => root.querySelector('#jsonFile').click();
  root.querySelector('#jsonFile').onchange = async e => {
    const file=e.target.files[0]; if(!file) return;
    try { state[state.ui.mode]=JSON.parse(await file.text()); persist(); render(); showToast('Scenario imported ✓'); }
    catch(err){ alert('Invalid JSON'); }
  };
}


/* ─────────────────── SETTINGS DIALOG (Org Hierarchy) ─────────────────── */
function openSettingsDialog(){
  const host = el('settingsDialog');
  host.classList.add('open');
  renderSettingsContent();

  function renderSettingsContent(){
    const org = state.org;

    const treeHTML = org.countries.map(c => {
      const regions = org.regions.filter(r=>r.countryId===c.id);
      return `
      <div style="margin-bottom:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,255,255,0.04);font-weight:700;font-size:12px">
          <span style="color:var(--accent)">🌎</span>
          <span>${esc(c.name)}</span>
          <span class="pill pill-gray" style="font-size:9px">${esc(c.code)}</span>
          <span style="flex:1"></span>
          <button class="btn" style="font-size:10px;padding:2px 8px" data-edit-country="${c.id}">Edit</button>
          <button class="btn" style="font-size:10px;padding:2px 8px;color:var(--danger)" data-del-country="${c.id}">Delete</button>
          <button class="btn" style="font-size:10px;padding:2px 8px" data-add-region="${c.id}">+ Region</button>
        </div>
        ${regions.length ? regions.map(r => {
          const subs = org.subRegions.filter(s=>s.regionId===r.id);
          return `
          <div style="border-top:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:8px;padding:6px 12px 6px 28px;background:rgba(255,255,255,0.02);font-size:11px;font-weight:600">
              <span style="color:var(--muted)">📍</span>
              <span>${esc(r.name)}</span>
              <span class="pill pill-gray" style="font-size:9px">${esc(r.code)}</span>
              <span style="flex:1"></span>
              <button class="btn" style="font-size:10px;padding:2px 8px" data-edit-region="${r.id}">Edit</button>
              <button class="btn" style="font-size:10px;padding:2px 8px;color:var(--danger)" data-del-region="${r.id}">Delete</button>
              <button class="btn" style="font-size:10px;padding:2px 8px" data-add-sub="${r.id}">+ Sub-Region</button>
            </div>
            ${subs.length ? subs.map(sr => {
              const facs = org.facilities.filter(f=>f.subRegionId===sr.id);
              return `
              <div style="border-top:1px solid var(--border)">
                <div style="display:flex;align-items:center;gap:8px;padding:5px 12px 5px 44px;font-size:11px">
                  <span style="color:var(--muted)">▸</span>
                  <span>${esc(sr.name)}</span>
                  <span class="pill pill-gray" style="font-size:9px">${esc(sr.code)}</span>
                  <span style="flex:1"></span>
                  <button class="btn" style="font-size:10px;padding:2px 8px" data-edit-sub="${sr.id}">Edit</button>
                  <button class="btn" style="font-size:10px;padding:2px 8px;color:var(--danger)" data-del-sub="${sr.id}">Delete</button>
                  <button class="btn" style="font-size:10px;padding:2px 8px" data-add-fac="${sr.id}">+ Facility</button>
                </div>
                ${facs.length ? facs.map(f => `
                <div style="display:flex;align-items:center;gap:8px;padding:4px 12px 4px 60px;border-top:1px solid var(--border);font-size:11px;background:rgba(0,0,0,0.15)">
                  <span>🏭</span>
                  <span style="font-weight:600">${esc(f.name)}</span>
                  <span class="pill pill-gray" style="font-size:9px">${esc(f.code)}</span>
                  <span style="flex:1"></span>
                  <button class="btn" style="font-size:10px;padding:2px 8px" data-edit-fac="${f.id}">Edit</button>
                  <button class="btn" style="font-size:10px;padding:2px 8px;color:var(--danger)" data-del-fac="${f.id}">Delete</button>
                </div>`).join('') : ''}
              </div>`;
            }).join('') : ''}
          </div>`;
        }).join('') : ''}
      </div>`;
    }).join('') || '<div style="color:var(--muted);font-size:12px;padding:12px">No countries yet. Add one to get started.</div>';

    host.innerHTML = `<div class="modal" style="max-width:780px">
      <div class="modal-header">
        <div><div class="modal-title">⚙ Organization Settings</div>
        <div style="font-size:11px;color:var(--muted)">Manage the Country → Region → Sub-Region → Facility hierarchy</div></div>
        <button class="btn" id="settingsClose">Close</button>
      </div>
      <div class="modal-body">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)">Organization Tree</div>
          <button class="btn btn-primary" style="font-size:11px" id="addCountryBtn">+ Add Country</button>
        </div>
        <div id="orgTree">${treeHTML}</div>
        <div id="settingsForm" style="margin-top:16px"></div>
      </div>
    </div>`;

    const q = id => host.querySelector('#'+id);
    q('settingsClose').onclick = () => host.classList.remove('open');
    host.onclick = e => { if(e.target===host) host.classList.remove('open'); };

    q('addCountryBtn').onclick = () => showForm('country', null, null);

    // Delegate all tree button clicks
    host.querySelector('#orgTree').addEventListener('click', e => {
      const btn = e.target.closest('button[data-edit-country],button[data-del-country],button[data-add-region],button[data-edit-region],button[data-del-region],button[data-add-sub],button[data-edit-sub],button[data-del-sub],button[data-add-fac],button[data-edit-fac],button[data-del-fac]');
      if(!btn) return;
      const a = actions(state);
      if(btn.dataset.editCountry)  showForm('country', btn.dataset.editCountry, null);
      if(btn.dataset.addRegion)    showForm('region', null, btn.dataset.addRegion);
      if(btn.dataset.delCountry){  if(!confirm('Delete country and all its data?')) return; a.deleteCountry(btn.dataset.delCountry); persist(); renderSettingsContent(); }
      if(btn.dataset.editRegion)   showForm('region', btn.dataset.editRegion, null);
      if(btn.dataset.delRegion){   if(!confirm('Delete region and all its data?')) return; a.deleteRegion(btn.dataset.delRegion); persist(); renderSettingsContent(); }
      if(btn.dataset.addSub)       showForm('subregion', null, btn.dataset.addSub);
      if(btn.dataset.editSub)      showForm('subregion', btn.dataset.editSub, null);
      if(btn.dataset.delSub){      if(!confirm('Delete sub-region and all its facilities?')) return; a.deleteSubRegion(btn.dataset.delSub); persist(); renderSettingsContent(); }
      if(btn.dataset.addFac)       showForm('facility', null, btn.dataset.addFac);
      if(btn.dataset.editFac)      showForm('facility', btn.dataset.editFac, null);
      if(btn.dataset.delFac){      if(!confirm('Delete facility and all its data?')) return; a.deleteFacility(btn.dataset.delFac); persist(); render(); renderSettingsContent(); }
    });
  }

  function showForm(type, editId, parentId){
    const a = actions(state);
    const org = state.org;
    const formEl = host.querySelector('#settingsForm');
    const labels = {country:'Country', region:'Region', subregion:'Sub-Region', facility:'Facility'};
    const existing =
      type==='country'   ? org.countries.find(c=>c.id===editId) :
      type==='region'    ? org.regions.find(r=>r.id===editId) :
      type==='subregion' ? org.subRegions.find(s=>s.id===editId) :
                           org.facilities.find(f=>f.id===editId);

    formEl.innerHTML = `
      <div style="border:1px solid var(--accent);border-radius:8px;padding:14px;background:rgba(99,179,237,0.04)">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin-bottom:10px">
          ${editId ? 'Edit' : 'New'} ${labels[type]}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end">
          <div>
            <label class="form-label">Name</label>
            <input class="form-input" id="sfName" value="${esc(existing?.name||'')}" placeholder="${labels[type]} name">
          </div>
          <div>
            <label class="form-label">Code</label>
            <input class="form-input" id="sfCode" value="${esc(existing?.code||existing?.id?.split('_').pop()||'')}" placeholder="e.g. SFL" style="text-transform:uppercase">
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-primary" id="sfSave" style="height:36px">${editId?'Save':'Create'}</button>
            <button class="btn" id="sfCancel" style="height:36px">Cancel</button>
          </div>
        </div>
      </div>`;

    const q = id => formEl.querySelector('#'+id);
    q('sfCancel').onclick = () => { formEl.innerHTML = ''; };
    q('sfCode').oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); };

    q('sfSave').onclick = () => {
      const name = q('sfName').value.trim();
      const code = q('sfCode').value.trim().toUpperCase();
      if(!name){ q('sfName').focus(); return; }
      if(editId){
        if(type==='country')   a.updateCountry({id:editId, name, code});
        if(type==='region')    a.updateRegion({id:editId, name, code});
        if(type==='subregion') a.updateSubRegion({id:editId, name, code});
        if(type==='facility')  a.updateFacility({id:editId, name, code});
      } else {
        if(type==='country')   a.addCountry({name, code});
        if(type==='region')    a.addRegion({countryId:parentId, name, code});
        if(type==='subregion') a.addSubRegion({regionId:parentId, name, code});
        if(type==='facility'){
          const facId = a.addFacility({subRegionId:parentId, name, code});
          if(facId && !state.ui.selectedFacilityId) state.ui.selectedFacilityId = facId;
        }
      }
      persist(); render(); renderSettingsContent(); formEl.innerHTML = '';
    };
  }
}

/* ─────────────────── SANDBOX DIALOG ─────────────────── */
function openSandboxDialog(){
  const host = el('sandboxDialog');
  host.classList.add('open');
  renderSandboxContent();

  function renderSandboxContent(){
    const sbs = state.sandboxes || {};
    const active = state.ui.activeSandboxId;

    const rows = Object.entries(sbs).map(([id, sb]) => {
      const isActive = id === active;
      const date = sb.createdAt ? new Date(sb.createdAt).toLocaleDateString() : '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);${isActive?'background:rgba(99,179,237,0.08);':''}">
        ${isActive ? '<span style="color:var(--accent);font-size:10px">▶</span>' : '<span style="width:10px"></span>'}
        <span style="flex:1;font-size:12px;font-weight:${isActive?'700':'400'}">${esc(sb.name||id)}</span>
        <span style="font-size:10px;color:var(--muted)">${date}</span>
        ${!isActive ? `<button class="btn" style="font-size:10px;padding:2px 8px" data-load-sb="${id}">Load</button>` : '<span style="font-size:10px;color:var(--accent);padding:2px 8px">Active</span>'}
        <button class="btn" style="font-size:10px;padding:2px 8px" data-rename-sb="${id}">Rename</button>
        ${id!=='default' ? `<button class="btn" style="font-size:10px;padding:2px 8px;color:var(--danger)" data-del-sb="${id}">Delete</button>` : ''}
      </div>`;
    }).join('');

    host.innerHTML = `<div class="modal" style="max-width:600px">
      <div class="modal-header">
        <div><div class="modal-title">📂 Sandbox Scenarios</div>
        <div style="font-size:11px;color:var(--muted)">Save and switch between planning scenarios. Sandbox data is independent from Official.</div></div>
        <button class="btn" id="sbClose">Close</button>
      </div>
      <div class="modal-body">
        <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center">
          <input class="form-input" id="sbNewName" placeholder="New scenario name…" style="flex:1">
          <button class="btn btn-primary" id="sbCreate">+ Create Scenario</button>
        </div>
        <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
          ${rows || '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">No scenarios yet</div>'}
        </div>
        <div style="margin-top:12px;font-size:11px;color:var(--muted)">
          💡 Creating a scenario copies the current Official data as a starting point. Switch scenarios without losing data.
        </div>
      </div>
    </div>`;

    const q = id => host.querySelector('#'+id);
    q('sbClose').onclick = () => host.classList.remove('open');
    host.onclick = e => { if(e.target===host) host.classList.remove('open'); };

    q('sbCreate').onclick = () => {
      const name = q('sbNewName').value.trim() || `Scenario ${Object.keys(sbs).length + 1}`;
      const id = createSandbox(state, name);
      state.ui.mode = 'sandbox';
      state.ui.activeSandboxId = id;
      persist(); render(); renderSandboxContent();
    };

    host.addEventListener('click', e => {
      const btn = e.target.closest('button[data-load-sb],button[data-rename-sb],button[data-del-sb]');
      if(!btn) return;
      if(btn.dataset.loadSb){
        state.ui.mode = 'sandbox';
        state.ui.activeSandboxId = btn.dataset.loadSb;
        persist(); render(); renderSandboxContent();
        showToast(`Loaded: ${sbs[btn.dataset.loadSb]?.name}`, 'ok');
      }
      if(btn.dataset.renameSb){
        const newName = prompt('Rename scenario:', sbs[btn.dataset.renameSb]?.name || '');
        if(newName){ renameSandbox(state, btn.dataset.renameSb, newName.trim()); persist(); renderSandboxContent(); }
      }
      if(btn.dataset.delSb){
        if(!confirm(`Delete scenario "${sbs[btn.dataset.delSb]?.name}"? This cannot be undone.`)) return;
        deleteSandbox(state, btn.dataset.delSb);
        persist(); render(); renderSandboxContent();
      }
    });
  }
}

/* ─────────────────── LOGISTICS PLACEHOLDER ─────────────────── */
function renderLogisticsPlaceholder(tabKey){
  const labels = {
    'logistics-shipments': { icon:'🚢', title:'Shipments', desc:'Track outbound shipments to customers by route and vessel.' },
    'logistics-imports':   { icon:'📦', title:'Imports',   desc:'Manage inbound raw material and fuel import schedules.' },
    'logistics-transfers': { icon:'🔀', title:'Transfers', desc:'Plan inter-facility clinker and material transfers.' },
  };
  const info = labels[tabKey] || { icon:'🚧', title:'Coming Soon', desc:'' };
  const root = el(`tab-${tabKey}`);
  if(!root) return;
  root.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:320px;gap:16px;color:var(--muted)">
    <div style="font-size:48px">${info.icon}</div>
    <div style="font-size:20px;font-weight:700;color:var(--fg)">${info.title}</div>
    <div style="font-size:13px;max-width:380px;text-align:center">${info.desc}</div>
    <div style="font-size:11px;padding:6px 16px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:20px">🚧 Coming soon</div>
  </div>`;
}

// Boot
render();

/* ─────────────────── DATA I/O DIALOG ─────────────────── */
function openDataIODialog(){
  const host = el('dataIODialog');
  host.classList.add('open');

  const isSandbox = state.ui.mode === 'sandbox';
  const sbId = state.ui.activeSandboxId;
  const sbName = state.sandboxes?.[sbId]?.name || 'Sandbox';
  const dateStr = new Date().toISOString().slice(0,10);

  // ── HELPERS ──
  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  };

  const downloadJSON = (obj, filename) => {
    downloadBlob(new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'}), filename);
  };

  const slugName = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

  // ── JSON SAVE ──
  const saveOfficial = () => {
    downloadJSON({ _type:'official', _savedAt: new Date().toISOString(), org: state.org, catalog: state.catalog, data: state.official }, `official_${dateStr}.json`);
    showToast('Official saved ✓', 'ok');
  };

  const saveSandbox = () => {
    const sb = state.sandboxes?.[sbId];
    if(!sb){ showToast('No active sandbox', 'warn'); return; }
    downloadJSON({ _type:'sandbox', _name: sb.name, _savedAt: new Date().toISOString(), org: state.org, catalog: state.catalog, data: sb.data }, `scenario_${slugName(sb.name)}_${dateStr}.json`);
    showToast(`Scenario "${sb.name}" saved ✓`, 'ok');
  };

  // ── JSON LOAD ──
  const loadJSON = (target) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json';
    inp.onchange = () => {
      const file = inp.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const obj = JSON.parse(e.target.result);
          if(target === 'official'){
            if(!confirm(`Load "${file.name}" into Official? This will overwrite Official data.`)) return;
            if(obj.org) state.org = obj.org;
            if(obj.catalog) state.catalog = obj.catalog;
            if(obj.data) state.official = obj.data;
            else if(obj.sandbox) state.official = obj.sandbox; // legacy
            persist(); render();
            showToast('Official loaded ✓', 'ok');
          } else {
            // Load into a new sandbox scenario
            const name = obj._name || file.name.replace('.json','');
            const id = createSandbox(state, name);
            if(obj.data) state.sandboxes[id].data = obj.data;
            else if(obj.sandbox) state.sandboxes[id].data = obj.sandbox; // legacy
            if(obj.org) state.org = obj.org;
            if(obj.catalog) state.catalog = obj.catalog;
            state.ui.mode = 'sandbox';
            state.ui.activeSandboxId = id;
            persist(); render();
            showToast(`Loaded into new scenario "${name}" ✓`, 'ok');
          }
          openDataIODialog(); // refresh dialog
        } catch(err) {
          showToast('Invalid JSON file', 'danger');
        }
      };
      reader.readAsText(file);
    };
    inp.click();
  };

  // ── EXCEL EXPORT ──
  const exportExcel = () => {
    const s = selectors(state);
    const ds = s.dataset;
    const fids = s.facilityIds;
    const wb = XLSX.utils.book_new();

    // Sheet 1: Demand Forecast
    const demandRows = [['Facility','Material Number','Product','Date','Qty (STn)','Source']];
    ds.demandForecast.filter(r=>fids.includes(r.facilityId)).forEach(r=>{
      const fac = state.org.facilities.find(f=>f.id===r.facilityId);
      const prod = state.catalog.find(m=>m.id===r.productId);
      demandRows.push([fac?.code||fac?.name||r.facilityId, prod?.materialNumber||'', prod?.name||r.productId, r.date, +r.qtyStn||0, r.source||'forecast']);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(demandRows), 'Demand Forecast');

    // Sheet 2: Campaigns
    const campRows = [['Facility','Equipment','Status','Product','Date','Rate (STn/d)']];
    ds.campaigns.filter(r=>fids.includes(r.facilityId)).forEach(r=>{
      const fac = state.org.facilities.find(f=>f.id===r.facilityId);
      const eq  = ds.equipment.find(e=>e.id===r.equipmentId);
      const prod = state.catalog.find(m=>m.id===r.productId);
      campRows.push([fac?.name||r.facilityId, eq?.name||r.equipmentId, r.status||'produce', prod?.name||r.productId||'', r.date, +r.rateStn||0]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(campRows), 'Campaigns');

    // Sheet 3: Production Actuals
    const prodRows = [['Facility','Equipment','Material Number','Product','Date','Qty (STn)']];
    ds.actuals.production.filter(r=>fids.includes(r.facilityId)).forEach(r=>{
      const fac  = state.org.facilities.find(f=>f.id===r.facilityId);
      const eq   = ds.equipment.find(e=>e.id===r.equipmentId);
      const prod = state.catalog.find(m=>m.id===r.productId);
      prodRows.push([fac?.code||fac?.name||r.facilityId, eq?.name||r.equipmentId, prod?.materialNumber||'', prod?.name||r.productId, r.date, +r.qtyStn||0]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prodRows), 'Production Actuals');

    // Sheet 4: Shipment Actuals
    const shipRows = [['Facility','Material Number','Product','Date','Qty (STn)']];
    ds.actuals.shipments.filter(r=>fids.includes(r.facilityId)).forEach(r=>{
      const fac  = state.org.facilities.find(f=>f.id===r.facilityId);
      const prod = state.catalog.find(m=>m.id===r.productId);
      shipRows.push([fac?.code||fac?.name||r.facilityId, prod?.materialNumber||'', prod?.name||r.productId, r.date, +r.qtyStn||0]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(shipRows), 'Shipment Actuals');

    // Sheet 5: Inventory EOD
    const invRows = [['Facility','Storage','Material Number','Product','Date','Qty (STn)']];
    (ds.actuals.inventoryEOD||[]).filter(r=>fids.includes(r.facilityId)).forEach(r=>{
      const fac  = state.org.facilities.find(f=>f.id===r.facilityId);
      const stor = ds.storages.find(s=>s.id===r.storageId);
      const prod = state.catalog.find(m=>m.id===r.productId);
      invRows.push([fac?.code||fac?.name||r.facilityId, stor?.name||r.storageId, prod?.materialNumber||'', prod?.name||r.productId, r.date, +r.qtyStn||0]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(invRows), 'Inventory EOD');

    // Sheet 6: Setup — Equipment
    const eqRows = [['Facility','Equipment ID','Name','Type']];
    ds.equipment.filter(e=>fids.includes(e.facilityId)).forEach(e=>{
      const fac = state.org.facilities.find(f=>f.id===e.facilityId);
      eqRows.push([fac?.name||e.facilityId, e.id, e.name, e.type]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(eqRows), 'Equipment');

    // Sheet 7: Setup — Products (catalog)
    const prodSetupRows = [['Region','Material Number','Product ID','Code','Name','Category','Unit','Landed Cost USD/STn']];
    state.catalog.forEach(m=>{
      const reg = state.org.regions.find(r=>r.id===m.regionId);
      prodSetupRows.push([reg?.name||m.regionId||'', m.materialNumber||'', m.id, m.code||'', m.name, m.category, m.unit||'STn', m.landedCostUsdPerStn||0]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prodSetupRows), 'Products Catalog');

    const scope = s.getScopeName();
    const filename = `cement_planner_${slugName(scope)}_${dateStr}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('Excel exported ✓', 'ok');
  };

  // ── EXCEL IMPORT ──
  const importExcel = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.xlsx,.xls,.csv';
    inp.onchange = () => {
      const file = inp.files[0]; if(!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
          const ds = selectors(state).dataset;
          const fac = state.ui.selectedFacilityId;
          let imported = [];

          const readSheet = name => {
            const ws = wb.Sheets[name];
            if(!ws) return null;
            return XLSX.utils.sheet_to_json(ws, {defval:''});
          };

          // Import Demand Forecast
          const demand = readSheet('Demand Forecast');
          if(demand?.length){
            const rows = demand.map(r=>({
              date: typeof r['Date']==='object' ? r['Date'].toISOString().slice(0,10) : String(r['Date']),
              facilityId: state.org.facilities.find(f=>f.name===r['Facility'] || f.id===r['Facility'] || f.code===r['Facility'])?.id || fac,
              productId: state.catalog.find(m=>(m.materialNumber && m.materialNumber===String(r['Material Number']||r['Mat. Number']||r['MatNum']||'')) || (m.materialNumbers||[]).includes(String(r['Material Number']||r['Mat. Number']||r['MatNum']||'')) || m.code===r['Product'] || m.name===r['Product'] || m.id===r['Product'])?.id || '',
              qtyStn: +r['Qty (STn)']||0, source:'forecast'
            })).filter(r=>r.date && r.productId && r.qtyStn>0);
            // Overwrite for affected facility+dates
            const keys = new Set(rows.map(r=>`${r.date}|${r.facilityId}|${r.productId}`));
            ds.demandForecast = ds.demandForecast.filter(r=>`${r.date}|${r.facilityId}|${r.productId}`!==([...keys].find(k=>k===`${r.date}|${r.facilityId}|${r.productId}`))||true);
            rows.forEach(r=>{ ds.demandForecast = ds.demandForecast.filter(x=>`${x.date}|${x.facilityId}|${x.productId}`!==`${r.date}|${r.facilityId}|${r.productId}`); ds.demandForecast.push(r); });
            imported.push(`${rows.length} demand rows`);
          }

          // Import Production Actuals
          const prod = readSheet('Production Actuals');
          if(prod?.length){
            const rows = prod.map(r=>({
              date: typeof r['Date']==='object' ? r['Date'].toISOString().slice(0,10) : String(r['Date']),
              facilityId: state.org.facilities.find(f=>f.name===r['Facility'] || f.id===r['Facility'] || f.code===r['Facility'])?.id || fac,
              equipmentId: ds.equipment.find(e=>e.name===r['Equipment'] || e.id===r['Equipment'])?.id || '',
              productId: state.catalog.find(m=>(m.materialNumber && m.materialNumber===String(r['Material Number']||r['Mat. Number']||r['MatNum']||'')) || (m.materialNumbers||[]).includes(String(r['Material Number']||r['Mat. Number']||r['MatNum']||'')) || m.code===r['Product'] || m.name===r['Product'] || m.id===r['Product'])?.id || '',
              qtyStn: +r['Qty (STn)']||0
            })).filter(r=>r.date && r.equipmentId && r.productId);
            rows.forEach(r=>{ ds.actuals.production = ds.actuals.production.filter(x=>!(x.date===r.date&&x.facilityId===r.facilityId&&x.equipmentId===r.equipmentId)); ds.actuals.production.push(r); });
            imported.push(`${rows.length} production rows`);
          }

          // Import Shipments
          const ship = readSheet('Shipment Actuals');
          if(ship?.length){
            const rows = ship.map(r=>({
              date: typeof r['Date']==='object' ? r['Date'].toISOString().slice(0,10) : String(r['Date']),
              facilityId: state.org.facilities.find(f=>f.name===r['Facility'] || f.id===r['Facility'] || f.code===r['Facility'])?.id || fac,
              productId: state.catalog.find(m=>(m.materialNumber && m.materialNumber===String(r['Material Number']||r['Mat. Number']||r['MatNum']||'')) || (m.materialNumbers||[]).includes(String(r['Material Number']||r['Mat. Number']||r['MatNum']||'')) || m.code===r['Product'] || m.name===r['Product'] || m.id===r['Product'])?.id || '',
              qtyStn: +r['Qty (STn)']||0
            })).filter(r=>r.date && r.productId);
            rows.forEach(r=>{ ds.actuals.shipments = ds.actuals.shipments.filter(x=>!(x.date===r.date&&x.facilityId===r.facilityId&&x.productId===r.productId)); ds.actuals.shipments.push(r); });
            imported.push(`${rows.length} shipment rows`);
          }

          // Import Inventory EOD
          const inv = readSheet('Inventory EOD');
          if(inv?.length){
            const rows = inv.map(r=>({
              date: typeof r['Date']==='object' ? r['Date'].toISOString().slice(0,10) : String(r['Date']),
              facilityId: state.org.facilities.find(f=>f.name===r['Facility'] || f.id===r['Facility'] || f.code===r['Facility'])?.id || fac,
              storageId: ds.storages.find(s=>s.name===r['Storage'] || s.id===r['Storage'])?.id || '',
              productId: state.catalog.find(m=>(m.materialNumber && m.materialNumber===String(r['Material Number']||r['Mat. Number']||r['MatNum']||'')) || (m.materialNumbers||[]).includes(String(r['Material Number']||r['Mat. Number']||r['MatNum']||'')) || m.code===r['Product'] || m.name===r['Product'] || m.id===r['Product'])?.id || '',
              qtyStn: +r['Qty (STn)']||0
            })).filter(r=>r.date && r.storageId && r.productId);
            rows.forEach(r=>{ ds.actuals.inventoryEOD = ds.actuals.inventoryEOD.filter(x=>!(x.date===r.date&&x.facilityId===r.facilityId&&x.storageId===r.storageId)); ds.actuals.inventoryEOD.push(r); });
            imported.push(`${rows.length} inventory rows`);
          }

          // Import Campaigns
          const camps = readSheet('Campaigns');
          if(camps?.length){
            const rows = camps.map(r=>({
              date: typeof r['Date']==='object' ? r['Date'].toISOString().slice(0,10) : String(r['Date']),
              facilityId: state.org.facilities.find(f=>f.name===r['Facility'] || f.id===r['Facility'])?.id || fac,
              equipmentId: ds.equipment.find(e=>e.name===r['Equipment'] || e.id===r['Equipment'])?.id || '',
              status: r['Status']||'produce',
              productId: state.catalog.find(m=>m.name===r['Product'] || m.id===r['Product'] || m.code===r['Product'])?.id || '',
              rateStn: +r['Rate (STn/d)']||0
            })).filter(r=>r.date && r.equipmentId);
            rows.forEach(r=>{ ds.campaigns = ds.campaigns.filter(x=>!(x.date===r.date&&x.facilityId===r.facilityId&&x.equipmentId===r.equipmentId)); ds.campaigns.push(r); });
            imported.push(`${rows.length} campaign rows`);
          }

          if(imported.length){
            persist(); render();
            showToast(`Imported: ${imported.join(', ')} ✓`, 'ok');
          } else {
            showToast('No matching sheets found in file', 'warn');
          }
        } catch(err) {
          showToast('Import failed: ' + err.message, 'danger');
        }
      };
      reader.readAsArrayBuffer(file);
    };
    inp.click();
  };

  // ── RENDER DIALOG ──
  const s = selectors(state);
  const scopeName = s.getScopeName();
  const sandboxList = Object.entries(state.sandboxes||{}).map(([id,sb])=>`
    <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px">
      <span style="flex:1;${id===sbId?'font-weight:700;color:var(--accent)':''}">${esc(sb.name||id)}</span>
      <span style="color:var(--muted)">${sb.createdAt?new Date(sb.createdAt).toLocaleDateString():''}</span>
      <button class="btn" style="font-size:10px;padding:2px 8px" data-save-sb="${id}">💾 Save</button>
    </div>`).join('');

  host.innerHTML = `<div class="modal" style="max-width:680px">
    <div class="modal-header">
      <div><div class="modal-title">💾 Data — Save / Load / Export</div>
      <div style="font-size:11px;color:var(--muted)">localStorage is your working cache. Use Save/Load to back up and restore. Export Excel for reporting or bulk data entry.</div></div>
      <button class="btn" id="dioClose">✕ Close</button>
    </div>
    <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:20px">

      <!-- LEFT: JSON Save/Load -->
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:12px">JSON — Full Backup & Restore</div>

        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;margin-bottom:8px;color:var(--ok)">🏛 Official</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" id="dioSaveOfficial" style="font-size:11px">💾 Save Official</button>
            <button class="btn" id="dioLoadOfficial" style="font-size:11px">📂 Load into Official</button>
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:6px">Saving downloads <code>official_${dateStr}.json</code>. Loading overwrites current Official data.</div>
        </div>

        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;margin-bottom:8px;color:var(--accent)">📂 Sandbox Scenarios</div>
          <div style="margin-bottom:8px">${sandboxList||'<div style="color:var(--muted);font-size:11px">No scenarios</div>'}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" id="dioLoadSandbox" style="font-size:11px">📂 Load JSON → New Scenario</button>
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:6px">Loading a JSON creates a new scenario. Data imports always go into the active sandbox, never directly into Official.</div>
        </div>
      </div>

      <!-- RIGHT: Excel Export/Import -->
      <div>
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:12px">Excel — Reporting & Bulk Entry</div>

        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
          <div style="font-size:11px;font-weight:600;margin-bottom:4px">📊 Export Excel</div>
          <div style="font-size:10px;color:var(--muted);margin-bottom:8px">Exports all data for current scope: <strong>${esc(scopeName)}</strong></div>
          <button class="btn btn-primary" id="dioExcelExport" style="font-size:11px;width:100%">📊 Download Excel</button>
          <div style="font-size:10px;color:var(--muted);margin-top:6px">Sheets: Demand Forecast · Campaigns · Production Actuals · Shipments · Inventory EOD · Equipment · Products Catalog</div>
        </div>

        <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:12px">
          <div style="font-size:11px;font-weight:600;margin-bottom:4px">📥 Import Excel → Active Sandbox</div>
          <div style="font-size:10px;color:var(--muted);margin-bottom:8px">Use the exported file as a template. Edit data in Excel, import back here. <strong>Always imports into active sandbox</strong> — never directly into Official.</div>
          <button class="btn" id="dioExcelImport" style="font-size:11px;width:100%">📥 Import Excel File</button>
          <div style="font-size:10px;color:var(--muted);margin-top:6px">Existing data for matching dates/facilities will be overwritten. Unrecognized rows are skipped.</div>
        </div>

        <div style="margin-top:12px;padding:8px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font-size:10px;color:#fcd34d">
          ⚠ Currently active: <strong>${isSandbox ? `Sandbox — ${esc(sbName)}` : 'Official'}</strong>. Excel imports always go into the active sandbox.
        </div>
      </div>

    </div>
  </div>`;

  const q = id => host.querySelector('#'+id);
  q('dioClose').onclick = () => host.classList.remove('open');
  host.onclick = e => { if(e.target===host) host.classList.remove('open'); };

  q('dioSaveOfficial').onclick = saveOfficial;
  q('dioLoadOfficial').onclick = () => loadJSON('official');
  q('dioLoadSandbox').onclick  = () => loadJSON('sandbox');
  q('dioExcelExport').onclick  = exportExcel;
  q('dioExcelImport').onclick  = () => {
    // Always switch to sandbox before importing
    if(state.ui.mode !== 'sandbox'){
      state.ui.mode = 'sandbox';
      persist();
    }
    importExcel();
  };

  // Per-sandbox save buttons
  host.querySelectorAll('[data-save-sb]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.saveSb;
      const sb = state.sandboxes?.[id];
      if(!sb) return;
      const name = sb.name || id;
      downloadJSON({ _type:'sandbox', _name:name, _savedAt:new Date().toISOString(), org:state.org, catalog:state.catalog, data:sb.data }, `scenario_${slugName(name)}_${dateStr}.json`);
      showToast(`"${name}" saved ✓`, 'ok');
    };
  });
}
