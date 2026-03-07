import { loadState, saveState, pushSandboxToOfficial, createSandbox, deleteSandbox, renameSandbox, firebaseListen } from './modules/store.js';
import { actions, selectors, Categories, getRulesOfEngagement, upsertRuleOfEngagement, deleteRuleOfEngagement } from './modules/dataAuthority.js';
import { buildProductionPlanView, yesterdayLocal, startOfMonth } from './modules/simEngine.js';
import { exportStateAsJSON, exportOfficialOnly, importStateFromFile, getExportSummary } from './modules/dataExport.js';

// State is loaded async from Firebase (falls back to localStorage)
let state = null;

async function init() {
  // Show loading indicator
  document.body.innerHTML += '<div id="fb-loading" style="position:fixed;top:0;left:0;right:0;bottom:0;background:#0f1117;display:flex;align-items:center;justify-content:center;z-index:9999;font-family:IBM Plex Mono,monospace;color:#7a8aa8;font-size:13px;letter-spacing:.05em">⟳ Loading from cloud...</div>';

  state = await loadState();

  // Normalize state structure after load (migration handled in store.js:migrateV2V3)
  const _datasets = [state.official, ...Object.values(state.sandboxes||{}).map(sb=>sb?.data)].filter(Boolean);
  _datasets.forEach(ds => {
    if (!ds.actuals) ds.actuals = {};
    // Note: inventoryEOD → inventoryBOD migration already handled by store.js migrations
    if (!Array.isArray(ds.actuals.inventoryBOD)) ds.actuals.inventoryBOD = [];
    if (!Array.isArray(ds.actuals.production))   ds.actuals.production   = [];
    if (!Array.isArray(ds.actuals.shipments))     ds.actuals.shipments    = [];
    if (!Array.isArray(ds.actuals.transfers))     ds.actuals.transfers    = [];
    if (!Array.isArray(ds.logisticsSchedule))     ds.logisticsSchedule    = [];
  });
  if (!state.logistics) state.logistics = { rulesOfEngagement: [], lanes: [] };
  if (!Array.isArray(state.logistics.rulesOfEngagement)) state.logistics.rulesOfEngagement = [];
  if (!Array.isArray(state.logistics.lanes))             state.logistics.lanes = [];

  document.getElementById('fb-loading')?.remove();

  // Live listener — update state when another computer saves
  firebaseListen(remoteState => {
    // Safety: never silently overwrite — show a notification with a manual reload button
    showToast('🔄 Another device saved changes. <button onclick="window.location.reload()" style="margin-left:8px;padding:2px 8px;border-radius:4px;border:1px solid #22c55e;background:none;color:#22c55e;cursor:pointer;font-size:11px">Reload</button>', 'ok', 8000);
  });

  // Expose state to global scope for debugging and export
  window.state = state;

  render();
}

init();



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
    { key:'logistics-rules',     label:'📋 Rules',      placeholder:false },
    { key:'logistics-shipments', label:'🚢 Shipments',  placeholder:true },
    { key:'logistics-imports',   label:'📦 Imports',    placeholder:true },
    { key:'logistics-transfers', label:'🔀 Transfers',  placeholder:false },
  ]},
];
// Flat list of all tab keys for panel toggling
const ALL_TAB_KEYS = NAV.flatMap(s=>s.subs.map(t=>t.key));
// Map tab key → parent section key
const TAB_PARENT = {};
NAV.forEach(s=>s.subs.forEach(t=>TAB_PARENT[t.key]=s.key));

const el = id => document.getElementById(id);
const q = id => document.getElementById(id);  // shorthand alias for el()

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

function persist(){
  saveState(state);
  window.state = state; // Keep global reference in sync
}

/* ─────────────────── DATA EXPORT/IMPORT ─────────────────── */
function exportBackup() {
  const summary = getExportSummary(state);
  const confirmed = confirm(
    summary + '\n\n' +
    'Click OK to download the backup as a JSON file.\n' +
    'You can use this file to restore your data later.'
  );

  if (confirmed) {
    const result = exportStateAsJSON(state);
    showToast(`✅ Backup exported: ${result.filename}`, 'ok', 3000);
  }
}

function exportOfficialBackup() {
  const result = exportOfficialOnly(state);
  showToast(`✅ Official dataset exported: ${result.filename}`, 'ok', 3000);
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';

  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      showToast('⏳ Importing data...', 'info', 1000);
      const importedData = await importStateFromFile(file);

      // Merge imported data with current state, preserving UI settings
      const uiState = state.ui;
      Object.assign(state, importedData);
      state.ui = uiState; // Preserve UI state

      // Save to localStorage and notify
      persist();
      showToast('✅ Data imported successfully! Reloading...', 'ok', 2000);

      // Reload after a short delay to apply changes
      setTimeout(() => window.location.reload(), 500);
    } catch (err) {
      console.error('[Import Error]', err);
      showToast(`❌ Import failed: ${err.message}`, 'error', 4000);
    }
  };

  input.click();
}

// Expose export/import functions to global scope for onclick handlers
window.exportBackup = exportBackup;
window.exportOfficialBackup = exportOfficialBackup;
window.importBackup = importBackup;

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

  // ── Single hierarchy tree selector ──
  const scopeWrap = el('scopeSelectorWrap') || (() => {
    const old = el('facilitySelector');
    if(old) {
      const div = document.createElement('div');
      div.id = 'scopeSelectorWrap';
      div.style.cssText = 'position:relative;display:inline-block;';
      old.parentNode.replaceChild(div, old);
      return div;
    }
    return null;
  })();

  const scopeFacsUnder = (type, id) => {
    if(type==='country'){
      const rids = org.regions.filter(r=>r.countryId===id).map(r=>r.id);
      const sids = org.subRegions.filter(s=>rids.includes(s.regionId)).map(s=>s.id);
      return org.facilities.filter(f=>sids.includes(f.subRegionId)).map(f=>f.id);
    }
    if(type==='region'){
      const sids = org.subRegions.filter(s=>s.regionId===id).map(s=>s.id);
      return org.facilities.filter(f=>sids.includes(f.subRegionId)).map(f=>f.id);
    }
    if(type==='sub'){
      return org.facilities.filter(f=>f.subRegionId===id).map(f=>f.id);
    }
    return [id];
  };

  const scopeButtonLabel = (facIds) => {
    const n = facIds.length;
    const total = org.facilities.length;
    if(!n)        return { icon:'🌎', text:'Select scope' };
    if(n===total) return { icon:'🌎', text:'All facilities' };
    if(n===1){
      const fac = org.facilities.find(f=>f.id===facIds[0]);
      return fac ? { icon:'🏭', text:`${fac.code} — ${fac.name}` } : { icon:'🏭', text:'1 facility' };
    }
    for(const sub of org.subRegions){
      const ids = scopeFacsUnder('sub', sub.id);
      if(ids.length && ids.length===n && ids.every(id=>facIds.includes(id)))
        return { icon:'▸', text:`${sub.code} · ${n} facilit${n===1?'y':'ies'}` };
    }
    for(const reg of org.regions){
      const ids = scopeFacsUnder('region', reg.id);
      if(ids.length && ids.length===n && ids.every(id=>facIds.includes(id)))
        return { icon:'📍', text:`${reg.code} · ${n} facilit${n===1?'y':'ies'}` };
    }
    for(const cnt of org.countries){
      const ids = scopeFacsUnder('country', cnt.id);
      if(ids.length && ids.length===n && ids.every(id=>facIds.includes(id)))
        return { icon:'🌎', text:`${cnt.name} · ${n} facilit${n===1?'y':'ies'}` };
    }
    const codes = facIds.map(id=>org.facilities.find(f=>f.id===id)?.code).filter(Boolean);
    const label = codes.length<=3 ? codes.join(' · ') : `${codes.slice(0,2).join(' · ')} · +${codes.length-2} more`;
    return { icon:'🏭', text:label };
  };

  let _scopePending = new Set(state.ui.selectedFacilityIds || []);

  const scopeCheckState = (facIds) => {
    const n = facIds.filter(id=>_scopePending.has(id)).length;
    if(n===0) return 'none';
    if(n===facIds.length) return 'all';
    return 'partial';
  };

  const buildScopeTree = () => {
    const treeEl = document.getElementById('scopeTreeBody');
    if(!treeEl) return;

    const nodeHtml = (level, icon, name, code, facIds, childrenHtml, nodeId) => {
      const st = scopeCheckState(facIds);
      const hasChildren = !!childrenHtml;
      const togId   = `stog-${nodeId}`;
      const childId = `sch-${nodeId}`;
      return `
        <div class="stree-node" style="padding-left:${level*14}px">
          <div class="stree-row ${st==='all'?'stree-checked':st==='partial'?'stree-partial':''}"
               data-fac-ids="${facIds.join(',')}">
            <span class="stree-toggle ${hasChildren?'':'stree-toggle-leaf'}" id="${togId}"
                  data-child="${childId}" style="${hasChildren?'':'visibility:hidden'}">▶</span>
            <input type="checkbox" class="stree-cb"
                   ${st==='all'?'checked':''}
                   data-fac-ids="${facIds.join(',')}"
                   style="accent-color:var(--accent);width:12px;height:12px;flex-shrink:0;cursor:pointer;">
            <span style="font-size:11px;flex-shrink:0">${icon}</span>
            <span class="stree-name">${esc(name)}</span>
            ${code?`<span class="stree-code">${esc(code)}</span>`:''}
          </div>
          ${hasChildren?`<div class="stree-children open" id="${childId}">${childrenHtml}</div>`:''}
        </div>`;
    };

    const facHtml = (fac) => nodeHtml(3,'🏭',fac.name,fac.code,[fac.id],'',`fac-${fac.id}`);
    const subHtml = (sub) => {
      const fids = scopeFacsUnder('sub', sub.id);
      const ch   = org.facilities.filter(f=>f.subRegionId===sub.id).map(facHtml).join('');
      return nodeHtml(2,'▸',sub.name,sub.code,fids,ch,`sub-${sub.id}`);
    };
    const regHtml = (reg) => {
      const fids = scopeFacsUnder('region', reg.id);
      const ch   = org.subRegions.filter(s=>s.regionId===reg.id).map(subHtml).join('');
      return nodeHtml(1,'📍',reg.name,reg.code,fids,ch,`reg-${reg.id}`);
    };
    const cntHtml = (cnt) => {
      const fids = scopeFacsUnder('country', cnt.id);
      const ch   = org.regions.filter(r=>r.countryId===cnt.id).map(regHtml).join('');
      return nodeHtml(0,'🌎',cnt.name,'',fids,ch,`cnt-${cnt.id}`);
    };

    treeEl.innerHTML = org.countries.map(cntHtml).join('');

    treeEl.querySelectorAll('.stree-cb').forEach(cb => {
      cb.indeterminate = cb.closest('.stree-row')?.classList.contains('stree-partial') || false;
    });
    treeEl.querySelectorAll('.stree-toggle:not(.stree-toggle-leaf)').forEach(tog => {
      tog.onclick = e => {
        e.stopPropagation();
        const ch = document.getElementById(tog.dataset.child);
        if(!ch) return;
        const isOpen = ch.classList.contains('open');
        ch.classList.toggle('open', !isOpen);
        tog.classList.toggle('open', !isOpen);
      };
    });
    treeEl.querySelectorAll('.stree-cb').forEach(cb => {
      cb.onclick  = e => e.stopPropagation();
      cb.onchange = () => {
        const fids = cb.dataset.facIds.split(',').filter(Boolean);
        const st   = scopeCheckState(fids);
        if(st==='all') fids.forEach(id=>_scopePending.delete(id));
        else           fids.forEach(id=>_scopePending.add(id));
        buildScopeTree();
        updateScopeFooter();
      };
    });
    treeEl.querySelectorAll('.stree-row').forEach(row => {
      row.onclick = e => {
        if(e.target.classList.contains('stree-cb') || e.target.classList.contains('stree-toggle')) return;
        const cb = row.querySelector('.stree-cb');
        if(cb){ cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
      };
    });
  };

  const updateScopeFooter = () => {
    const n     = _scopePending.size;
    const total = org.facilities.length;
    const el2   = document.getElementById('scopeFooterSummary');
    if(el2) el2.textContent = n===0 ? 'No facilities selected'
      : n===total ? 'All facilities'
      : `${n} facilit${n===1?'y':'ies'} selected`;
  };

  const updateScopeButton = () => {
    const btn = document.getElementById('scopeTriggerBtn');
    if(!btn) return;
    const fids = state.ui.selectedFacilityIds || [];
    const { icon, text } = scopeButtonLabel(fids);
    const iconEl  = btn.querySelector('#scopeBtnIcon');
    const labelEl = btn.querySelector('#scopeBtnLabel');
    if(iconEl)  iconEl.textContent  = icon;
    if(labelEl) labelEl.textContent = text;
  };

  const buildScopeUI = () => {
    if(!scopeWrap) return;
    if(!org.countries.length && !org.facilities.length) {
      scopeWrap.innerHTML = `<span style="font-size:11px;color:var(--muted)">— Set up facilities in ⚙ Settings —</span>`;
      return;
    }
    scopeWrap.innerHTML = `
      <button id="scopeTriggerBtn" class="scope-tree-btn"
              onclick="document.getElementById('scopeTreePanel').classList.toggle('open');event.stopPropagation();">
        <span id="scopeBtnIcon" style="font-size:12px">🌎</span>
        <span id="scopeBtnLabel" style="flex:1;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;">Select scope</span>
        <span style="font-size:8px;color:var(--muted);flex-shrink:0">▼</span>
      </button>
      <div id="scopeTreePanel" class="scope-tree-panel" onclick="event.stopPropagation()">
        <div style="padding:9px 14px 7px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)">Select Scope</span>
          <button id="scopeClearBtn" style="font-size:10px;color:var(--muted);border:none;background:none;cursor:pointer;padding:2px 6px;border-radius:4px;">✕ Clear all</button>
        </div>
        <div class="scope-tree-body" id="scopeTreeBody"></div>
        <div style="padding:7px 14px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
          <span id="scopeFooterSummary" style="font-size:10px;color:var(--muted)"></span>
          <button id="scopeApplyBtn" style="padding:4px 14px;border-radius:5px;font-size:11px;font-weight:600;background:var(--accent);color:#fff;border:none;cursor:pointer;">Apply</button>
        </div>
      </div>`;

    document.getElementById('scopeTriggerBtn').addEventListener('click', () => {
      const panel = document.getElementById('scopeTreePanel');
      if(panel.classList.contains('open')){
        _scopePending = new Set(state.ui.selectedFacilityIds || []);
        buildScopeTree();
        updateScopeFooter();
      }
    });
    document.getElementById('scopeApplyBtn').onclick = () => {
      state.ui.selectedFacilityIds = [..._scopePending];
      syncLegacyId(); persist();
      updateScopeButton();
      document.getElementById('scopeTreePanel').classList.remove('open');
      render();
    };
    document.getElementById('scopeClearBtn').onclick = () => {
      _scopePending = new Set();
      buildScopeTree();
      updateScopeFooter();
    };
    document.addEventListener('click', () => {
      const panel = document.getElementById('scopeTreePanel');
      if(panel) panel.classList.remove('open');
    });

    _scopePending = new Set(state.ui.selectedFacilityIds || []);
    buildScopeTree();
    updateScopeFooter();
    updateScopeButton();
  };

  if(scopeWrap) buildScopeUI();


  // Mode badge
  const badge = el('modeBadge');
  const isSandbox = state.ui.mode === 'sandbox';
  const sbName = isSandbox ? (state.sandboxes[state.ui.activeSandboxId]?.name || 'Sandbox') : '';
  badge.textContent = isSandbox ? `SANDBOX: ${sbName}` : 'OFFICIAL';
  badge.className = 'mode-badge ' + (isSandbox ? 'mode-sandbox' : 'mode-official');
  badge.onclick = () => { state.ui.mode = isSandbox ? 'official' : 'sandbox'; persist(); render(); };

  el('sandboxBtn').onclick = () => openSandboxDialog();
  el('settingsBtn').onclick = () => openSettingsDialog();
  el('dataIOBtn').onclick = () => openDataManagementDialog();

  el('pushOfficialBtn').onclick = () => {
    if(!confirm('Push current sandbox to Official? This overwrites the Official data.')) return;
    pushSandboxToOfficial(state); persist();
    showToast('Pushed to Official ✓', 'ok');
    render();
  };
}

/* ─────────────────── TOAST ─────────────────── */
function showToast(msg, type='ok', duration=2500){
  let t = el('toast');
  if(!t){ t = document.createElement('div'); t.id='toast'; t.style.cssText='position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 16px;border-radius:8px;font-size:12px;font-weight:600;transition:opacity .3s;pointer-events:auto;max-width:360px;'; document.body.appendChild(t); }
  t.innerHTML = msg;
  t.style.background = type==='ok' ? 'var(--ok-bg)' : type==='warn' ? 'var(--warn-bg)' : 'var(--danger-bg)';
  t.style.border = `1px solid ${type==='ok'?'var(--ok)':type==='warn'?'var(--warn)':'var(--danger)'}`;
  t.style.color = type==='ok' ? '#86efac' : type==='warn' ? '#fcd34d' : '#fca5a5';
  t.style.opacity='1';
  clearTimeout(t._timer);
  t._timer = setTimeout(()=>{ t.style.opacity='0'; }, duration);
}

/* ─────────────────── RENDER ─────────────────── */
function render(){
  if(!state) return; // wait for async init
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
  else if(t==='logistics-rules') renderLogisticsRules();
  else if(t==='logistics-shipments'||t==='logistics-imports') renderLogisticsPlaceholder(t);
  else if(t==='logistics-transfers') renderLogisticsTransfersPage();
}

/* ─────────────────── PLAN TAB ─────────────────── */
function renderPlan(){
  const root = el('tab-plan');
  if(!root) return;
  try {
  const s = selectors(state);
  const todayStr = today();

  // Build plan using new facility-first structure from simEngine
  const plan = buildProductionPlanView(state, SPINE_START, 1095); // 3 years: Jan 1 2025 - Dec 31 2027

  // Alert extraction (same as before)
  const allAlerts = Object.entries(plan.alertSummary||{})
    .flatMap(([date,arr])=>(arr||[]).map(a=>({...a,date})));

  // Filter alerts: exclude today and earlier, start from tomorrow onwards (no alerts for past data)
  const tomorrowDate = new Date(todayStr+'T00:00:00');
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().slice(0,10);
  const filteredAlerts = allAlerts.filter(a => a.date >= tomorrowStr);

  const stockouts = filteredAlerts.filter(a=>a.severity==='stockout');
  const overflows = filteredAlerts.filter(a=>a.severity==='full');
  const warnings  = filteredAlerts.filter(a=>a.warn && a.severity!=='stockout' && a.severity!=='full');
  let firstStockout = stockouts.length ? stockouts.reduce((min,a)=>a.date<min?a.date:min, stockouts[0].date) : null;
  const daysUntilStockout = firstStockout ? Math.max(0, Math.round((new Date(firstStockout)-new Date(todayStr))/86400000)) : null;

  // ── KPI Panel — two-state: expanded cards / collapsed slim bar ──
  const _kpiKey = 'kpiPanelOpen';
  const _kpiOpen = localStorage.getItem(_kpiKey) !== '0'; // default open

  // Product pills: short name + neon color per product
  const prodPillColor = pid => {
    const base = ['#3b82f6','#a78bfa','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316','#84cc16'];
    let h=0; (pid||'').split('').forEach(c=>h=(h*31+c.charCodeAt(0))>>>0);
    return base[h%base.length];
  };
  const prodPills = s.finishedProducts.map(p => {
    const col = prodPillColor(p.id);
    const short = p.name.length > 14 ? p.name.slice(0,13).trim()+'…' : p.name;
    return `<span style="display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;border:1px solid ${col}44;background:${col}18;color:${col};font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.04em;white-space:nowrap">${esc(short)}</span>`;
  }).join('');

  // Slim bar (collapsed state)
  const kpiSlim = `
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:${stockouts.length?'var(--danger)':'var(--ok)'}">
        🚨 ${stockouts.length} stockout${stockouts.length!==1?'s':''}
      </span>
      ${daysUntilStockout!==null?`<span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--warn)">⏱ ${daysUntilStockout}d to first</span>`:''}
      <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:${overflows.length?'var(--warn)':'var(--muted)'}">⚠ ${overflows.length} overflow${overflows.length!==1?'s':''}</span>
      <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted)">🏭 ${s.equipment.filter(e=>e.type==='kiln').length}k · ${s.equipment.filter(e=>e.type==='finish_mill').length}fm</span>
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">${prodPills}</div>
    </div>`;

  // Full expanded cards
  const kpiExpanded = `
    <div class="kpi-row" style="margin-bottom:0">
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
      <div class="kpi-card kpi-neutral" style="flex:2;min-width:220px">
        <div class="kpi-label" style="margin-bottom:6px">📦 Finished Products <span style="font-weight:400;color:var(--muted)">(${s.finishedProducts.length})</span></div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">${prodPills}</div>
      </div>
      <div class="kpi-card kpi-neutral">
        <div class="kpi-label">🏭 Equipment</div>
        <div class="kpi-value">${s.equipment.length}</div>
        <div class="kpi-sub">${s.equipment.filter(e=>e.type==='kiln').length} kilns · ${s.equipment.filter(e=>e.type==='finish_mill').length} mills</div>
      </div>
    </div>`;

  const kpiHTML = `
    <div id="kpiPanel" style="margin-bottom:12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div id="kpiToggleBar" style="display:flex;align-items:center;justify-content:space-between;padding:6px 14px;cursor:pointer;user-select:none;border-bottom:${_kpiOpen?'1px solid var(--border)':'none'}">
        <div id="kpiSlimContent" style="display:${_kpiOpen?'none':'flex'};align-items:center;gap:8px;flex:1">${kpiSlim}</div>
        <div style="display:${_kpiOpen?'block':'none'};font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)" id="kpiExpandedLabel">Production Intelligence</div>
        <span id="kpiCaret" style="font-size:10px;color:var(--muted);transition:transform .2s;display:inline-block;transform:${_kpiOpen?'rotate(0deg)':'rotate(-90deg)'}">▼</span>
      </div>
      <div id="kpiBody" style="display:${_kpiOpen?'block':'none'};padding:12px 14px">${kpiExpanded}</div>
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

  const _alertKey     = 'planAlertStripCollapsed';
  const _alertCollapsed = localStorage.getItem(_alertKey) === '1';
  const _alertHidden    = localStorage.getItem('planAlertStripHidden') === '1';
  const totalAlertCount = stockouts.length+overflows.length+warnings.length;
  const alertStripHTML = totalAlertCount>0
    ? `<div id="alertStrip" style="margin-bottom:16px;background:linear-gradient(135deg,rgba(239,68,68,0.08),rgba(245,158,11,0.05));border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:10px 16px;${_alertHidden?'display:none;':''}">
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
      </div>
      <div id="alertStripReveal" style="margin-bottom:16px;display:${_alertHidden?'flex':'none'};align-items:center;gap:8px;padding:6px 12px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:8px;cursor:pointer;" title="Show alerts">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:var(--danger);text-transform:uppercase;letter-spacing:.1em;">⚡ ${totalAlertCount} alert${totalAlertCount!==1?'s':''}</span>
        <span style="font-size:10px;color:var(--muted)">— click to show</span>
      </div>`
    : `<div style="margin-bottom:16px;padding:10px 14px;background:var(--ok-bg);border:1px solid rgba(34,197,94,0.3);border-radius:8px;font-size:12px;color:#86efac;">✅ <strong>All clear</strong> — No stockouts or capacity issues in the planning horizon.</div>`;

  // Helper functions
  const productColor = pid => {
    const base = ['#3b82f6','#a78bfa','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316','#84cc16'];
    let h=0; (pid||'').split('').forEach(c=>h=(h*31+c.charCodeAt(0))>>>0);
    return base[h%base.length];
  };
  const isWeekendDate = d => [0,6].includes(new Date(d+'T00:00:00').getDay());
  const wkdColStyle = 'background:rgba(239,68,68,0.06);border-left:1px solid rgba(239,68,68,0.3);';

  // Use facility-organized rows directly from simEngine
  const unifiedRows = plan.unifiedRows || [];

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Hierarchical date grouping (year → month → day columns)
  // ═══════════════════════════════════════════════════════════════════════════

  // Organize dates hierarchically: { year: { month: [dates...] } }
  const dateHierarchy = {};
  plan.dates.forEach(d => {
    const yyyy = d.slice(0, 4);
    const yyyymm = d.slice(0, 7);
    if(!dateHierarchy[yyyy]) dateHierarchy[yyyy] = {};
    if(!dateHierarchy[yyyy][yyyymm]) dateHierarchy[yyyy][yyyymm] = [];
    dateHierarchy[yyyy][yyyymm].push(d);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4: Smart date range defaults (7 days before + 2 weeks after today)
  // ═══════════════════════════════════════════════════════════════════════════

  // Calculate smart date range defaults
  const addDays = (dateStr, n) => {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const smartRangeStart = addDays(todayStr, -7);  // 7 days before today
  const smartRangeEnd = addDays(todayStr, 14);    // 2 weeks after today
  const todayMonth = todayStr.slice(0, 7);

  // Helper: check if a month overlaps with smart range
  const isMonthInSmartRange = (yyyymm) => {
    const [yyyy, mm] = yyyymm.split('-');
    const monthStart = `${yyyymm}-01`;
    const lastDay = new Date(parseInt(yyyy), parseInt(mm), 0).getDate();
    const monthEnd = `${yyyy}-${mm}-${String(lastDay).padStart(2, '0')}`;
    // Month overlaps if: monthStart <= rangeEnd AND monthEnd >= rangeStart
    return monthStart <= smartRangeEnd && monthEnd >= smartRangeStart;
  };

  // Initialize month collapse state with smart defaults
  const monthCollapseState = {};
  const savedCollapseState = localStorage.getItem('planMonthCollapseState');
  const savedState = savedCollapseState ? JSON.parse(savedCollapseState) : {};

  Object.entries(dateHierarchy).forEach(([yyyy, months]) => {
    Object.keys(months).forEach(yyyymm => {
      // Use saved state if available, otherwise default to expanded
      if(savedState[yyyymm] !== undefined) {
        monthCollapseState[yyyymm] = savedState[yyyymm];
      } else {
        // Default: all months expanded by default (user can click to collapse)
        monthCollapseState[yyyymm] = true;  // true = expanded, showing individual day columns
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: DATA PREPARATION - Campaign Visualization Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  // Helper: Group consecutive campaigns into blocks (same equipment, product, status)
  // Returns array of blocks: {equipmentId, productId, status, startDate, endDate, dateCount, rateStn}
  const groupCampaignsIntoBlocks = (campaigns, facilityId) => {
    if (!campaigns || !campaigns.length) return [];

    const filtered = campaigns
      .filter(c => c.facilityId === facilityId)
      .sort((a, b) =>
        a.equipmentId.localeCompare(b.equipmentId) ||
        a.date.localeCompare(b.date)
      );

    const blocks = [];
    filtered.forEach(campaign => {
      const last = blocks[blocks.length - 1];

      // Check if this campaign is consecutive with the previous one
      const isConsecutive = last &&
        last.equipmentId === campaign.equipmentId &&
        last.productId === campaign.productId &&
        last.status === campaign.status &&
        isConsecutiveDay(last.endDate, campaign.date);

      if (isConsecutive) {
        // Extend existing block
        last.endDate = campaign.date;
        last.dateCount++;
      } else {
        // Start new block
        blocks.push({
          equipmentId: campaign.equipmentId,
          productId: campaign.productId,
          status: campaign.status,
          startDate: campaign.date,
          endDate: campaign.date,
          dateCount: 1,
          rateStn: campaign.rateStn || 0
        });
      }
    });

    return blocks;
  };

  // Helper: Check if date2 is the next day after date1
  const isConsecutiveDay = (date1, date2) => {
    const d1 = new Date(date1 + 'T00:00:00');
    const d2 = new Date(date2 + 'T00:00:00');
    const nextDay = new Date(d1);
    nextDay.setDate(nextDay.getDate() + 1);
    return d2.getTime() === nextDay.getTime();
  };

  // Helper: Get cell dimensions (column width, row height, etc.)
  // Returns: {colWidth, cellHeight, rowHeight, colPadding, rowPadding}
  // Note: Call this after table is rendered in DOM
  const getCellDimensions = () => {
    const table = root.querySelector('.plan-table');
    if (!table) return null;

    const sampleHeader = table.querySelector('thead th[data-date]');
    const sampleCell = table.querySelector('tbody td');
    const sampleRow = table.querySelector('tbody tr');

    if (!sampleHeader || !sampleCell || !sampleRow) return null;

    return {
      colWidth: sampleHeader.offsetWidth || 50,
      cellHeight: sampleCell.offsetHeight || 30,
      rowHeight: sampleRow.offsetHeight || 30,
      colPadding: 6,    // from CSS: padding 5px 6px
      rowPadding: 5
    };
  };

  // Helper: Build date-to-column-index mapping, respecting month collapse state
  // Returns: {date → column index in visible columns}
  const buildDateToColIndexMap = (dateHierarchy, monthCollapseState) => {
    const dateToColIndex = {};
    let colIdx = 0;

    Object.entries(dateHierarchy).forEach(([yyyy, months]) => {
      Object.keys(months).sort().forEach(yyyymm => {
        const isOpen = monthCollapseState[yyyymm];

        // Always count month summary column
        colIdx++;

        // If month is expanded, count individual day columns
        if (isOpen) {
          const dates = months[yyyymm];
          dates.forEach(date => {
            dateToColIndex[date] = colIdx;
            colIdx++;
          });
        }
      });
    });

    return dateToColIndex;
  };

  // Build the mapping (will be used by drawCampaignLines)
  const dateToColIndex = buildDateToColIndexMap(dateHierarchy, monthCollapseState);

  // Helper: Get equipment row index from DOM
  // Returns: Map of equipmentId → row index in tbody
  const buildEquipmentRowIndexMap = () => {
    const eqIdToRowIndex = {};
    const tbody = root.querySelector('.plan-table tbody');
    if (!tbody) return eqIdToRowIndex;

    let rowIdx = 0;
    tbody.querySelectorAll('tr').forEach(tr => {
      // Try to get equipment ID from data attribute or cell content
      const equipmentId = tr.dataset.equipmentId;
      if (equipmentId) {
        eqIdToRowIndex[equipmentId] = rowIdx;
      }
      rowIdx++;
    });

    return eqIdToRowIndex;
  };

  // Helper: Build list of visible dates (dates in currently expanded months)
  const getVisibleDates = (dateHierarchy, monthCollapseState) => {
    const visibleDates = [];

    Object.entries(dateHierarchy).forEach(([yyyy, months]) => {
      Object.keys(months).sort().forEach(yyyymm => {
        if (monthCollapseState[yyyymm]) {
          const dates = months[yyyymm];
          visibleDates.push(...dates);
        }
      });
    });

    return visibleDates;
  };

  // Helper: Get visible date range (for viewport culling)
  // Returns: {startDate, endDate} currently visible in scroll area
  const getVisibleDateRange = (tableScroll, dateToColIndex, cellDimensions) => {
    if (!tableScroll || !cellDimensions) {
      return { startDate: null, endDate: null };
    }

    const scrollLeft = tableScroll.scrollLeft || 0;
    const scrollWidth = tableScroll.offsetWidth || 0;
    const colWidth = cellDimensions.colWidth || 50;
    const rowHeaderWidth = 200; // sticky row header

    // Convert pixel positions to approximate column indices
    const startCol = Math.floor((scrollLeft - rowHeaderWidth) / colWidth);
    const endCol = Math.ceil((scrollLeft + scrollWidth - rowHeaderWidth) / colWidth);

    // Find corresponding dates
    const visibleDates = getVisibleDates(dateHierarchy, monthCollapseState);
    const startDate = visibleDates[Math.max(0, startCol)] || visibleDates[0];
    const endDate = visibleDates[Math.min(visibleDates.length - 1, endCol)] || visibleDates[visibleDates.length - 1];

    return { startDate, endDate };
  };

  // Helper: Format campaign details for tooltip display
  // Returns: {equipment, product, rate, status, duration, dateRange}
  const formatCampaignDetails = (block) => {
    if (!block) return null;

    const s = selectors(state);
    const equipName = s.equipment.find(e => e.id === block.equipmentId)?.name || block.equipmentId;
    const prodName = s.getMaterial(block.productId)?.name || block.productId || 'Unknown';

    const d1 = new Date(block.startDate + 'T00:00:00');
    const d2 = new Date(block.endDate + 'T00:00:00');
    const startStr = d1.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endStr = d2.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const dateRange = block.dateCount === 1 ? startStr : `${startStr} - ${endStr}`;

    return {
      equipment: equipName,
      product: prodName,
      rate: `${block.rateStn || 0} STn/day`,
      status: block.status || 'unknown',
      duration: `${block.dateCount} day${block.dateCount !== 1 ? 's' : ''}`,
      dateRange: dateRange
    };
  };

  // Helper: Format month name and get day range
  const monthInfo = (yyyymm) => {
    const [, m] = yyyymm.split('-');
    const names = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    return { abbr: names[parseInt(m)], month: parseInt(m) };
  };

  // Helper: calculate month summary value for a row
  const monthSummaryValue = (row, yyyymm, dates) => {
    if(!row.values) return 0;
    if(row.kind === 'subtotal') {
      // BOD: first day of month, EOD: last day of month, others: sum
      const label = row.label || '';
      const firstDay = dates[0];
      const lastDay = dates[dates.length - 1];
      if(label.includes('BOD')) return row.values[firstDay] || 0;
      if(label.includes('EOD')) return row.values[lastDay] || 0;
    }
    // Default: sum all days in month
    return dates.reduce((sum, d) => sum + (row.values[d] || 0), 0);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3 REFACTOR: Excel-like column structure
  // Remove month header row, change headers to MMM-DD format, move collapse to summary
  // ═══════════════════════════════════════════════════════════════════════════

  const dayHeaderCells = [];

  // Build day headers with MMM-DD format and summary column with collapse control
  Object.entries(dateHierarchy).forEach(([yyyy, months]) => {
    const monthKeys = Object.keys(months).sort();

    monthKeys.forEach(yyyymm => {
      const isOpen = monthCollapseState[yyyymm];
      const dates = months[yyyymm];
      const { abbr, month } = monthInfo(yyyymm);

      // Month summary header with collapse control (rendered FIRST, at beginning of month)
      const mmyyyy = `${yyyymm.slice(5)}-${yyyymm.slice(0,4)}`;  // MM-YYYY format
      dayHeaderCells.push(`<th data-month="${yyyymm}" class="month-summary-col month-summary-${yyyymm.replace('-','_')}" style="min-width:50px;width:50px;background:rgba(59,130,246,0.15);border:1px solid var(--border);font-size:8px;color:var(--text);text-align:center;font-weight:600;cursor:pointer;user-select:none;" data-yyyymm="${yyyymm}">
        <span class="month-collapse-icon" style="display:inline-block;transition:transform 0.15s;font-size:8px;">${isOpen?'▼':'▶'}</span><br/>${mmyyyy}
      </th>`);

      // Day headers with MMM-DD format (only render if month is expanded)
      if(isOpen) {
        dates.forEach(d => {
          const isWk = isWeekendDate(d);
          const isTd = d === todayStr;
          const dd2 = d.slice(8, 10);
          let sty = isWk ? wkdColStyle : '';
          if(isTd) sty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);background:rgba(59,130,246,0.15);';
          const headerLabel = `${abbr}-${dd2}`;  // MMM-DD format (e.g., JAN-01)
          dayHeaderCells.push(`<th data-date="${d}" data-month="${yyyymm}" class="day-header day-${yyyymm.replace('-','_')}" style="min-width:50px;width:50px;${sty}font-size:8px;${isWk?'color:rgba(239,68,68,0.65)':isTd?'color:var(--accent)':'color:var(--muted)'}"><div style="font-weight:700">${headerLabel}</div></th>`);
        });
      }
    });
  });

  const dateHeaders = dayHeaderCells.join('');
  const yearHeaderRow = '';  // Year headers not used in current design
  const monthHeaderRow = '';  // REMOVED: No longer have separate month header row

  // Simplified cell renderer for each date (or month summary if month is collapsed)
  const renderDayCell = (r, d, isMonthSummary = false, yyyymm = null) => {
    const isWk = !isMonthSummary && isWeekendDate(d);
    const isTd = !isMonthSummary && d === todayStr;
    let v = r.values?.[d] || 0;

    // If rendering month summary, calculate aggregated value
    if(isMonthSummary && yyyymm && dateHierarchy[yyyymm.slice(0,4)] && dateHierarchy[yyyymm.slice(0,4)][yyyymm]) {
      const monthDates = dateHierarchy[yyyymm.slice(0,4)][yyyymm];
      v = monthSummaryValue(r, yyyymm, monthDates);
    }

    let baseSty = isWk ? wkdColStyle : '';
    if(isTd) baseSty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);';

    // Equipment cells
    if(r.rowType==='equipment' && r.equipmentId){
      // For month summary, show total equipment output across month
      if(isMonthSummary) {
        return `<td class="num month-summary-cell" style="${baseSty}background:rgba(59,130,246,0.08);font-size:9px;color:var(--muted);">${v?fmt0(v):''}</td>`;
      }
      const meta = plan.equipmentCellMeta?.[`${d}|${r.equipmentId}`];
      const status = meta?.status || 'idle';
      if(status==='maintenance') return `<td class="num" style="${baseSty}background:rgba(245,158,11,0.2);color:#fcd34d;font-size:9px;font-style:italic;">MNT</td>`;
      if(status==='out_of_order') return `<td class="num" style="${baseSty}background:rgba(139,92,246,0.2);color:#c4b5fd;font-size:9px;">OOO</td>`;
      if(!meta || status==='idle') return `<td class="num" style="${baseSty}color:var(--muted);font-size:9px"></td>`;
      const isActual = meta.source==='actual';
      const tip = `${isActual?'✓':'📋'}: ${fmt0(meta.totalQty||0)} STn`;

      // Real values (from actuals) are white, forecasted values are product-colored
      if(isActual){
        return `<td class="num" style="${baseSty}font-size:10px;color:var(--text);font-weight:600;" title="${esc(tip)}">${fmt0(v)}</td>`;
      } else {
        const color = productColor(meta.productId);
        return `<td class="num" style="${baseSty}background:${color}18;font-size:10px;color:${color}" title="${esc(tip)}">${fmt0(v)}</td>`;
      }
    }

    // Inventory cells (BOD, EOD, etc.) - color-coded based on real vs forecasted
    if(r.storageId){
      if(isMonthSummary) {
        // Month summary inventory - use same color coding as daily cells
        return `<td class="num month-summary-cell" style="${baseSty}background:rgba(59,130,246,0.08);font-size:9px;color:var(--text);font-weight:600;">${v?fmt0(v):''}</td>`;
      }
      const imeta = plan.inventoryCellMeta?.[`${d}|${r.storageId}`];
      let cellStyle = baseSty + 'font-size:10px;';
      const isActualInv = imeta?.source==='actual';

      // Real values are white/text colored, forecasted use product colors with severity overlays
      if(isActualInv){
        cellStyle += 'color:var(--text);font-weight:600;';
        // Still apply severity overlays on top
        if(imeta.severity==='stockout'){ cellStyle = baseSty + 'font-size:10px;background:rgba(239,68,68,0.18);color:#fca5a5;font-weight:700;'; }
        else if(imeta.severity==='full'){ cellStyle = baseSty + 'font-size:10px;background:rgba(245,158,11,0.18);color:#fcd34d;font-weight:700;'; }
        else if(imeta.warn==='high75'){ cellStyle += 'color:var(--warn);font-weight:700;'; }
      } else {
        // Forecasted values use product color, with severity overlays
        if(imeta && r.allowedProductIds && r.allowedProductIds.length > 0){
          const productId = r.allowedProductIds[0];
          const color = productColor(productId);
          cellStyle = baseSty + `font-size:10px;background:${color}18;color:${color};`;
          // Severity overlays still apply
          if(imeta.severity==='stockout'){ cellStyle = baseSty + 'font-size:10px;background:rgba(239,68,68,0.18);color:#fca5a5;font-weight:700;'; }
          else if(imeta.severity==='full'){ cellStyle = baseSty + 'font-size:10px;background:rgba(245,158,11,0.18);color:#fcd34d;font-weight:700;'; }
          else if(imeta.warn==='high75'){ cellStyle += 'font-weight:700;'; }
        } else {
          if(imeta){
            if(imeta.severity==='stockout'){ cellStyle += 'background:rgba(239,68,68,0.18);color:#fca5a5;font-weight:700;'; }
            else if(imeta.severity==='full'){ cellStyle += 'background:rgba(245,158,11,0.18);color:#fcd34d;font-weight:700;'; }
            else if(imeta.warn==='high75'){ cellStyle += 'color:var(--warn);'; }
          }
        }
      }
      return `<td class="num" style="${cellStyle}">${v?fmt0(v):''}</td>`;
    }

    // Default cell (used for CLK CONSUMPTION, KILN PRODUCTION, FM PRODUCTION, DEMAND, etc.)
    if(isMonthSummary) {
      return `<td class="num month-summary-cell" style="${baseSty}background:rgba(59,130,246,0.08);font-size:9px;font-weight:700;color:var(--text);">${v?fmt0(v):''}</td>`;
    }
    // For subtotal rows (CLK CONSUMPTION, DEMAND, etc.), use bold white text; for others, use muted
    const isSummaryRow = r.kind==='subtotal' || r._section;
    return `<td class="num" style="${baseSty}font-size:10px;${isSummaryRow?'font-weight:700;color:var(--text);':'color:var(--muted);'}">${v?fmt0(v):''}</td>`;
  };

  // Helper: build cells for a row - conditionally render based on collapse state
  const buildRowCells = (r) => {
    let cells = '';
    Object.entries(dateHierarchy).forEach(([yyyy, months]) => {
      Object.keys(months).sort().forEach(yyyymm => {
        const isOpen = monthCollapseState[yyyymm];
        const monthDates = months[yyyymm];

        // Always render month summary cell FIRST (at beginning of month)
        const summaryCell = renderDayCell(r, null, true, yyyymm);
        cells += summaryCell.replace(/<td/, `<td class="month-summary-${yyyymm.replace('-','_')}" `);

        // Conditionally render day cells only if month is expanded (after summary)
        if(isOpen) {
          cells += monthDates.map(d => {
            const dayCell = renderDayCell(r, d, false);
            // Add class for identification
            return dayCell.replace(/<td/, `<td class="day-${yyyymm.replace('-','_')}" `);
          }).join('');
        }
      });
    });
    return cells;
  };

  // Build HTML rows from facility-organized unifiedRows
  let lastFacilityId = null;
  let lastFamilyName = null;  // Track current family for child rows
  let lastSectionId = null;   // Track current section for child rows
  const tableRows = unifiedRows.map((r, idx) => {
    // Facility header rows - collapsible per facility
    if(r._type === 'facility-header'){
      lastFacilityId = r._facilityId;
      lastFamilyName = null;
      lastSectionId = null;
      const facId = r._facilityId;
      return `<tr class="plan-fac-header" data-fac="${facId}" style="cursor:pointer;user-select:none;">
        <td class="row-header" style="position:sticky;left:0;z-index:3;background:#0f1419;border:2px solid var(--border);padding:8px 12px;font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);">
          <span class="fac-collapse-icon" data-fac="${facId}" style="margin-right:8px;display:inline-block;transition:transform .15s;font-size:11px;">▼</span>${esc(r.label)}
        </td>
        <td colspan="9999" style="background:#0f1419;border:2px solid var(--border);border-left:none;padding:0;"></td>
      </tr>`;
    }

    // Family header rows within facilities - now collapsible
    if(r._type === 'family-header'){
      lastFamilyName = r._family;
      lastSectionId = null;
      const familyId = r._family;
      return `<tr class="plan-family-header collapsible-family fac-child fac-${lastFacilityId}" data-family="${familyId}" data-facility="${lastFacilityId}" style="display:none;cursor:pointer;user-select:none;">
        <td class="row-header" style="position:sticky;left:0;z-index:2;background:rgba(15,23,42,0.9);border:1px solid var(--border);padding:6px 12px 6px 24px;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text);">
          <span class="family-collapse-icon" style="margin-right:6px;display:inline-block;transition:transform .15s;font-size:9px;">▼</span>${esc(r.label)}
        </td>
        <td colspan="9999" style="background:rgba(15,23,42,0.5);border:1px solid var(--border);border-left:none;padding:0;"></td>
      </tr>`;
    }

    // Section header rows (BOD/EOD sections) - collapsible
    if(r.kind === 'section-header'){
      lastSectionId = r._sectionId;
      const sectionId = r._sectionId;
      const familyClass = lastFamilyName ? ` family-child family-${lastFamilyName}` : '';
      const cells = buildRowCells(r);
      return `<tr class="plan-section-header collapsible-section fac-child fac-${lastFacilityId}${familyClass}" data-section="${sectionId}" style="display:none;cursor:pointer;user-select:none;border-top:1px solid var(--border);">
        <td class="row-header" style="position:sticky;left:0;z-index:2;background:rgba(20,28,50,0.9);font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);padding-left:32px;">
          <span class="section-collapse-icon" style="margin-right:6px;display:inline-block;transition:transform .15s;font-size:9px;">▼</span>${esc(r.label)}
        </td>
        ${cells}
      </tr>`;
    }

    // Subtotal rows (legacy support) - now collapsible with consistent color & expand/collapse arrows
    if(r.kind === 'subtotal' || r._type === 'subtotal-header'){
      lastSectionId = null;  // Reset section for non-section subtotals
      const cells = buildRowCells(r);
      const familyClass = lastFamilyName ? ` family-child family-${lastFamilyName}` : '';
      const subtotalId = r.label.replace(/\s+/g, '-').toLowerCase();
      return `<tr class="plan-subtotal collapsible-subtotal fac-child fac-${lastFacilityId}${familyClass}" data-subtotal="${subtotalId}" style="display:none;border-top:1px solid var(--border);cursor:pointer;user-select:none;">
        <td class="row-header" style="position:sticky;left:0;z-index:2;background:rgba(20,28,50,0.9);font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);padding-left:32px;">
          <span class="subtotal-collapse-icon" style="margin-right:6px;display:inline-block;transition:transform .15s;font-size:9px;">▼</span>${esc(r.label)}
        </td>
        ${cells}
      </tr>`;
    }

    // Placeholder rows
    if(r._type === 'placeholder' || r.kind === 'placeholder'){
      const familyClass = lastFamilyName ? ` family-child family-${lastFamilyName}` : '';
      return `<tr class="plan-placeholder fac-child fac-${lastFacilityId}${familyClass}" style="display:none;opacity:0.6;">
        <td class="row-header" style="position:sticky;left:0;z-index:2;background:rgba(10,13,20,0.97);font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--muted);padding-left:40px;font-style:italic;">${esc(r.label)} (no data)</td>
        <td colspan="9999"></td>
      </tr>`;
    }

    // Regular data rows (including storage rows)
    const cells = buildRowCells(r);
    const familyClass = lastFamilyName ? ` family-child family-${lastFamilyName}` : '';
    const sectionClass = lastSectionId ? ` section-child section-${lastSectionId}` : '';

    // Apply colored left border for storage inventory rows
    let storageStyle = '';
    if(r.storageId && r.allowedProductIds && r.allowedProductIds.length > 0){
      const productId = r.allowedProductIds[0];
      const color = productColor(productId);
      storageStyle = `border-left: 4px solid ${color};`;
    }

    return `<tr class="plan-data-row fac-child fac-${lastFacilityId}${familyClass}${sectionClass}" style="display:none;">
      <td class="row-header" style="position:sticky;left:0;z-index:2;background:rgba(10,13,20,0.97);font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--text);padding-left:40px;${storageStyle}" title="${esc(r.productLabel||r.label)}">${esc(r.label)}</td>
      ${cells}
    </tr>`;
  }).join('');

  root.innerHTML = `
  ${kpiHTML}
  ${alertStripHTML}
  <div class="card" style="margin-bottom:16px">
    <div class="card-header sticky-table-header" id="planCardHeader">
      <div>
        <div class="card-title">📊 Production Plan — Facility Daily Status</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">Formula: EOD = BOD + Production - Shipments ± Transfers</div>
      </div>
      <div class="flex gap-2">
        <button class="btn" id="jumpTodayPlan">📅 Today</button>
        <button class="btn" id="openCampaigns">🎯 Campaigns</button>
        <button class="btn btn-primary" id="openActuals">📝 Daily Actuals</button>
      </div>
    </div>
    <div class="card-body" style="padding:0">
      ${!plan.dates || plan.dates.length===0?'<div style="padding:40px;text-align:center;color:var(--muted)">No data to display. Run simulation first.</div>':''}
      <div class="sticky-scroll-wrap" id="planScrollWrap">
        <div class="phantom-scrollbar" id="planPhantomBar"><div class="phantom-inner" id="planPhantomInner"></div></div>
        <div class="table-scroll" id="planTableScroll" style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 280px)">
          <table class="data-table plan-table" id="planTable" style="min-width:max-content;width:100%">
            <thead>
              ${yearHeaderRow}
              ${monthHeaderRow}
              <tr>
                <th class="row-header" style="min-width:200px;position:sticky;left:0;background:#0a0d14;z-index:5;font-weight:700;">Facility / Item</th>
                ${dateHeaders}
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
  <div style="font-size:11px;color:var(--muted);padding:4px 0 16px">
    Red text = Stockout (EOD&lt;0) · Amber text = Full (EOD&gt;max) · Warn color = High (EOD&gt;75%) · Pink = weekend · Colored = equipment producing · MNT = maintenance · OOO = out of order
    <br/><strong style="color:var(--accent);">📅 Month collapse:</strong> Click month headers (JAN, FEB, etc.) to toggle between day columns and monthly summary · Your preferences are saved
  </div>`;

  // Simple facility collapse/expand handler
  const facOpenState = {};
  const tbody = root.querySelector('.plan-table tbody');
  if(tbody){
    const table = root.querySelector('.plan-table');

    // Initialize all facilities as expanded
    unifiedRows.forEach(r => {
      if(r._type === 'facility-header') facOpenState[r._facilityId] = true;
    });

    // Show/hide rows based on initial open state
    Object.entries(facOpenState).forEach(([facId, isOpen]) => {
      root.querySelectorAll(`.fac-child.fac-${facId}`).forEach(row => {
        row.style.display = isOpen ? '' : 'none';
      });
    });

    // Family-level collapse state (per facility)
    const familyOpenState = {};
    unifiedRows.forEach(r => {
      if(r._type === 'family-header'){
        const key = `${r._facilityId}|${r._family}`;
        if(!familyOpenState[r._facilityId]) familyOpenState[r._facilityId] = {};
        familyOpenState[r._facilityId][r._family] = true; // All families start expanded
      }
    });

    // Initialize family rows display (show if facility and family are open)
    Object.entries(familyOpenState).forEach(([facId, families]) => {
      Object.entries(families).forEach(([familyName, isOpen]) => {
        if(isOpen) {
          root.querySelectorAll(`.family-child.family-${familyName}.fac-${facId}`).forEach(row => {
            row.style.display = '';
          });
        }
      });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // SECTION-LEVEL COLLAPSE STATE
    // ──────────────────────────────────────────────────────────────────────────

    // Section-level collapse state (collapsible BOD/EOD sections)
    const sectionOpenState = {};
    unifiedRows.forEach(r => {
      if(r.kind === 'section-header'){
        const sectionId = r._sectionId;
        if(!sectionOpenState[sectionId]) sectionOpenState[sectionId] = true; // All sections start expanded
      }
    });

    // Initialize section rows display (show if section is open)
    Object.entries(sectionOpenState).forEach(([sectionId, isOpen]) => {
      if(isOpen) {
        root.querySelectorAll(`.section-child.section-${sectionId}`).forEach(row => {
          row.style.display = '';
        });
      }
    });

    // SUBTOTAL-LEVEL COLLAPSE STATE
    // ──────────────────────────────────────────────────────────────────────────

    // Subtotal-level collapse state (collapsible CLK CONSUMPTION, KILN PRODUCTION, FM PRODUCTION, etc.)
    const subtotalOpenState = {};
    unifiedRows.forEach(r => {
      if(r.kind === 'subtotal' || r._type === 'subtotal-header'){
        const subtotalId = r.label.replace(/\s+/g, '-').toLowerCase();
        if(!subtotalOpenState[subtotalId]) subtotalOpenState[subtotalId] = true; // All subtotals start expanded
      }
    });

    // Initialize subtotal child rows display (show if subtotal is open)
    Object.entries(subtotalOpenState).forEach(([subtotalId, isOpen]) => {
      if(isOpen) {
        // Find the subtotal header and show all rows until next subtotal of same level
        const headers = root.querySelectorAll(`.collapsible-subtotal[data-subtotal="${subtotalId}"]`);
        headers.forEach(header => {
          let nextRow = header.nextElementSibling;
          while(nextRow && !nextRow.classList.contains('collapsible-subtotal') && !nextRow.classList.contains('plan-family-header')) {
            nextRow.style.display = '';
            nextRow = nextRow.nextElementSibling;
          }
        });
      }
    });

    // Section collapse/expand click handler
    root.querySelectorAll('.collapsible-section').forEach(header => {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const sectionId = header.getAttribute('data-section');
        if(!sectionId) return;

        // Toggle section state
        sectionOpenState[sectionId] = !sectionOpenState[sectionId];
        const isOpen = sectionOpenState[sectionId];

        // Show/hide section child rows
        root.querySelectorAll(`.section-child.section-${sectionId}`).forEach(row => {
          row.style.display = isOpen ? '' : 'none';
        });

        // Rotate icon
        const icon = header.querySelector('.section-collapse-icon');
        if(icon) {
          icon.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
        }
      });
    });

    // Subtotal collapse/expand click handler
    root.querySelectorAll('.collapsible-subtotal').forEach(header => {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const subtotalId = header.getAttribute('data-subtotal');
        if(!subtotalId) return;

        // Toggle subtotal state
        subtotalOpenState[subtotalId] = !subtotalOpenState[subtotalId];
        const isOpen = subtotalOpenState[subtotalId];

        // Show/hide subtotal child rows (equipment/storage rows under this subtotal)
        let nextRow = header.nextElementSibling;
        while(nextRow && !nextRow.classList.contains('collapsible-subtotal') && !nextRow.classList.contains('plan-family-header')) {
          nextRow.style.display = isOpen ? '' : 'none';
          nextRow = nextRow.nextElementSibling;
        }

        // Rotate icon
        const icon = header.querySelector('.subtotal-collapse-icon');
        if(icon) {
          icon.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
        }
      });
    });

    // Family collapse click handler (now also respects sections)
    root.querySelectorAll('.collapsible-family').forEach(header => {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        const familyId = header.getAttribute('data-family');
        const facId = header.getAttribute('data-facility');
        if(!familyId || !facId) return;

        // Toggle family state
        familyOpenState[facId][familyId] = !familyOpenState[facId][familyId];
        const isOpen = familyOpenState[facId][familyId];

        // Show/hide family child rows (but respect section visibility)
        root.querySelectorAll(`.family-child.family-${familyId}.fac-${facId}`).forEach(row => {
          const sectionId = row.getAttribute('class').match(/section-([^\s]+)/)?.[1];
          const isInOpenSection = !sectionId || sectionOpenState[sectionId];
          row.style.display = (isOpen && isInOpenSection) ? '' : 'none';
        });

        // Rotate icon
        const icon = header.querySelector('.family-collapse-icon');
        if(icon) {
          icon.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
        }
      });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2: SVG OVERLAY CREATION
    // ═══════════════════════════════════════════════════════════════════════════

    // Create SVG overlay for campaign duration lines
    const tableScroll = root.querySelector('#planTableScroll');
    const tableContainer = tableScroll?.parentElement;

    if (tableScroll && tableContainer) {
      // Create SVG overlay element
      const svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgOverlay.id = 'campaignLinesOverlay';
      svgOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 3;
        transform-origin: left top;
      `;

      // Insert SVG overlay before table scroll
      tableContainer.insertBefore(svgOverlay, tableScroll);

      // Update SVG dimensions based on table
      const updateSVGDimensions = () => {
        const table = root.querySelector('.plan-table');
        const tbody = table?.querySelector('tbody');

        if (!table || !tbody) return;

        const svgWidth = table.offsetWidth || 1000;
        const svgHeight = tbody.offsetHeight || 500;

        svgOverlay.setAttribute('width', svgWidth);
        svgOverlay.setAttribute('height', svgHeight);
        svgOverlay.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
      };

      // Initial dimension update
      setTimeout(updateSVGDimensions, 0);

      // Watch for table resizing
      const resizeObserver = new ResizeObserver(() => {
        updateSVGDimensions();
        // Will redraw campaign lines in Phase 3
      });

      if (table) {
        resizeObserver.observe(table);
      }

      // Store references in state for later use in Phase 3 & beyond
      window._campaignVisualization = window._campaignVisualization || {};
      window._campaignVisualization.svgOverlay = svgOverlay;
      window._campaignVisualization.tableScroll = tableScroll;
      window._campaignVisualization.updateSVGDimensions = updateSVGDimensions;
      window._campaignVisualization.dateToColIndex = dateToColIndex;
      window._campaignVisualization.getCellDimensions = getCellDimensions;
      window._campaignVisualization.groupCampaignsIntoBlocks = groupCampaignsIntoBlocks;
      window._campaignVisualization.formatCampaignDetails = formatCampaignDetails;
      window._campaignVisualization.getVisibleDateRange = getVisibleDateRange;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3: CAMPAIGN LINE RENDERING
    // ═══════════════════════════════════════════════════════════════════════════

    // Main function: Draw campaign duration lines
    const drawCampaignLines = () => {
      const svgOverlay = window._campaignVisualization?.svgOverlay;
      if (!svgOverlay) return;

      // Clear previous lines
      svgOverlay.innerHTML = '';

      // Get current facility
      const selectedFacilityId = state.ui.selectedFacilityId;
      if (!selectedFacilityId) return;

      // Get campaign blocks for this facility (campaigns are stored in state.sandboxes[dataset].data.campaigns)
      const selectedDataset = state.ui.selectedDataset || 'default';
      const campaigns = state?.sandboxes?.[selectedDataset]?.data?.campaigns || [];
      const campaignBlocks = groupCampaignsIntoBlocks(campaigns, selectedFacilityId);

      if (campaignBlocks.length === 0) return;

      const table = root.querySelector('.plan-table');
      const tbody = table?.querySelector('tbody');
      if (!table || !tbody) return;

      const dims = getCellDimensions();
      if (!dims) return;

      // For each campaign block, draw line segments (skipping actual data dates)
      campaignBlocks.forEach(block => {
        // Get all dates in this campaign block
        const blockStartDate = new Date(block.startDate + 'T00:00:00');
        const blockEndDate = new Date(block.endDate + 'T00:00:00');
        const blockDates = [];

        for (let d = new Date(blockStartDate); d <= blockEndDate; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().slice(0, 10);
          blockDates.push(dateStr);
        }

        if (blockDates.length === 0) return;

        // Identify forecast vs actual segments
        // A date is "actual" if equipment has actual production data
        const dateIsActual = (date) => {
          const cellMeta = plan.equipmentCellMeta?.[`${date}|${block.equipmentId}`];
          return cellMeta?.source === 'actual';
        };

        // Group consecutive forecast dates into segments
        const forecastSegments = [];
        let currentSegment = null;

        blockDates.forEach(date => {
          const isActual = dateIsActual(date);

          if (!isActual) {
            // This is a forecast date
            if (!currentSegment) {
              currentSegment = [date];
            } else {
              currentSegment.push(date);
            }
          } else {
            // This is an actual date - close current segment
            if (currentSegment && currentSegment.length > 0) {
              forecastSegments.push(currentSegment);
              currentSegment = null;
            }
          }
        });

        // Don't forget last segment
        if (currentSegment && currentSegment.length > 0) {
          forecastSegments.push(currentSegment);
        }

        // Draw a line for each forecast segment
        forecastSegments.forEach(segment => {
          const segmentStartDate = segment[0];
          const segmentEndDate = segment[segment.length - 1];

          // Find column indices for start and end
          const startColIdx = dateToColIndex[segmentStartDate];
          const endColIdx = dateToColIndex[segmentEndDate];

          if (startColIdx === undefined || endColIdx === undefined) {
            // Dates might be in a collapsed month
            return;
          }

          // Convert column indices to pixel positions
          const colWidth = dims.colWidth || 50;
          const rowHeaderWidth = 200; // sticky row header width

          const startX = rowHeaderWidth + (startColIdx * colWidth) + colWidth / 2;
          const endX = rowHeaderWidth + (endColIdx * colWidth) + colWidth / 2;

          // Find equipment row Y position
          const eqRows = Array.from(tbody.querySelectorAll('tr')).filter(tr => {
            const label = tr.querySelector('.row-header')?.textContent || '';
            return label.includes(block.equipmentId);
          });

          if (eqRows.length === 0) return;

          const eqRow = eqRows[0];
          const rowTop = eqRow.offsetTop || 0;
          const rowHeight = eqRow.offsetHeight || 30;
          const midlineY = rowTop + rowHeight / 2;

          // Get product color
          const s = selectors(state);
          const productColor = (pid) => {
            const base = ['#3b82f6','#a78bfa','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316','#84cc16'];
            let h = 0;
            (pid || '').split('').forEach(c => h = (h * 31 + c.charCodeAt(0)) >>> 0);
            return base[h % base.length];
          };
          const color = productColor(block.productId);

          // Determine line style based on status and source
          const isActualCampaign = plan.equipmentCellMeta?.[`${segment[0]}|${block.equipmentId}`]?.source === 'actual';
          const opacity = isActualCampaign ? 0.9 : 0.6;

          let strokeDasharray = 'none';
          if (block.status !== 'produce') {
            strokeDasharray = '5,5'; // dashed for non-produce status
          }

          // Draw main line
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', startX);
          line.setAttribute('y1', midlineY);
          line.setAttribute('x2', endX);
          line.setAttribute('y2', midlineY);
          line.setAttribute('stroke', color);
          line.setAttribute('stroke-width', '3');
          line.setAttribute('stroke-linecap', 'round');
          line.setAttribute('opacity', opacity);
          if (strokeDasharray !== 'none') {
            line.setAttribute('stroke-dasharray', strokeDasharray);
          }
          line.setAttribute('class', `campaign-line campaign-${block.equipmentId}`);
          line.setAttribute('data-equipment-id', block.equipmentId);
          line.setAttribute('data-product-id', block.productId);
          line.setAttribute('data-status', block.status);
          line.setAttribute('data-start-date', segmentStartDate);
          line.setAttribute('data-end-date', segmentEndDate);
          line.setAttribute('data-rate', block.rateStn);
          line.style.cursor = 'pointer';

          svgOverlay.appendChild(line);

          // Draw endpoint circles
          [startX, endX].forEach((x, idx) => {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', x);
            circle.setAttribute('cy', midlineY);
            circle.setAttribute('r', '4');
            circle.setAttribute('fill', color);
            circle.setAttribute('opacity', opacity);
            circle.setAttribute('class', 'campaign-endpoint');
            svgOverlay.appendChild(circle);
          });
        });
      });
    };

    // Call drawCampaignLines after SVG is set up
    if (window._campaignVisualization?.svgOverlay) {
      setTimeout(drawCampaignLines, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 4-6: SCROLL SYNC, DYNAMIC REDRAW, AND EVENT HANDLING
    // ═══════════════════════════════════════════════════════════════════════════

    // Phase 5: Scroll Synchronization
    // Sync SVG overlay position with table scroll
    if (tableScroll) {
      const syncSVGScroll = () => {
        const svgOverlay = window._campaignVisualization?.svgOverlay;
        if (svgOverlay) {
          svgOverlay.style.transform = `translateX(-${tableScroll.scrollLeft}px)`;
        }
      };

      tableScroll.addEventListener('scroll', syncSVGScroll);

      // Also redraw lines on scroll (with debounce)
      let scrollTimeout;
      tableScroll.addEventListener('scroll', () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(drawCampaignLines, 100);
      });
    }

    // Phase 6a: Re-render campaign lines when month collapse changes
    // Store original month handler and enhance it
    const originalMonthClickHandler = (e) => {
      const summaryHeader = e.target.closest('.month-summary-col');
      const collapseIcon = e.target.closest('.month-collapse-icon');

      if (summaryHeader || collapseIcon) {
        e.stopPropagation();
        const header = summaryHeader || collapseIcon.closest('.month-summary-col');
        const yyyymm = header?.dataset.yyyymm;

        if (yyyymm) {
          monthCollapseState[yyyymm] = !monthCollapseState[yyyymm];
          localStorage.setItem('planMonthCollapseState', JSON.stringify(monthCollapseState));

          // Re-render entire table (this will recreate everything including SVG)
          renderPlan();
        }
      }
    };

    // Phase 6b: Redraw lines when facility changes
    const observeFacilityChange = () => {
      // Watch for facility selector changes
      const facilitySelector = root.querySelector('select[id*="facility"], [id*="facilitySelector"]');
      if (facilitySelector) {
        facilitySelector.addEventListener('change', () => {
          setTimeout(drawCampaignLines, 100);
        });
      }
    };

    observeFacilityChange();

    // Phase 6c: Redraw lines on window resize
    let resizeTimeout;
    const onWindowResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        window._campaignVisualization?.updateSVGDimensions?.();
        drawCampaignLines();
      }, 200);
    };

    window.addEventListener('resize', onWindowResize);

    // Phase 6d: Watch for table structure changes (via MutationObserver)
    if (tbody) {
      const mutationObserver = new MutationObserver(() => {
        // Redraw lines if table DOM changes
        setTimeout(drawCampaignLines, 50);
      });

      // Only watch for row additions/removals, not text content changes
      mutationObserver.observe(tbody, {
        childList: true,
        subtree: false
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 7: TOOLTIP INTERACTION
    // ═══════════════════════════════════════════════════════════════════════════

    // Create tooltip container
    const tooltipEl = document.createElement('div');
    tooltipEl.id = 'campaignTooltip';
    tooltipEl.style.cssText = `
      position: fixed;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 11px;
      color: var(--text);
      z-index: 1000;
      pointer-events: none;
      display: none;
      max-width: 220px;
      white-space: nowrap;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
    `;
    document.body.appendChild(tooltipEl);

    // Hover handlers for campaign lines
    const svgOverlay = window._campaignVisualization?.svgOverlay;
    if (svgOverlay) {
      svgOverlay.addEventListener('mouseover', (e) => {
        const line = e.target.closest('.campaign-line');
        if (!line) return;

        // Get campaign details from line attributes
        const equipmentId = line.getAttribute('data-equipment-id');
        const productId = line.getAttribute('data-product-id');
        const status = line.getAttribute('data-status');
        const startDate = line.getAttribute('data-start-date');
        const endDate = line.getAttribute('data-end-date');
        const rate = line.getAttribute('data-rate');

        // Create a fake block object for formatting
        const fakeBlock = {
          equipmentId,
          productId,
          status,
          startDate,
          endDate,
          rateStn: parseFloat(rate),
          dateCount: (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24) + 1
        };

        const details = formatCampaignDetails(fakeBlock);
        if (details) {
          // Build tooltip content
          const tooltipHTML = `
            <strong style="color: var(--accent)">${details.equipment}</strong><br/>
            <span style="color: var(--muted)">Product:</span> ${details.product}<br/>
            <span style="color: var(--muted)">Rate:</span> ${details.rate}<br/>
            <span style="color: var(--muted)">Status:</span> ${details.status}<br/>
            <span style="color: var(--muted)">Duration:</span> ${details.duration}<br/>
            <span style="color: var(--muted)">Dates:</span> ${details.dateRange}
          `;

          tooltipEl.innerHTML = tooltipHTML;
          tooltipEl.style.display = 'block';

          // Position tooltip near cursor
          document.addEventListener('mousemove', (moveEvent) => {
            const offsetX = 10;
            const offsetY = 10;
            tooltipEl.style.left = (moveEvent.clientX + offsetX) + 'px';
            tooltipEl.style.top = (moveEvent.clientY + offsetY) + 'px';
          });

          // Highlight line on hover
          line.setAttribute('stroke-width', '5');
          line.setAttribute('opacity', Math.min(1, (parseFloat(line.getAttribute('opacity')) || 0.7) + 0.2));
        }
      });

      svgOverlay.addEventListener('mouseout', (e) => {
        const line = e.target.closest('.campaign-line');
        if (!line) return;

        // Hide tooltip
        tooltipEl.style.display = 'none';

        // Reset line style
        const originalOpacity = line.getAttribute('data-original-opacity') ||
          (plan.equipmentCellMeta?.[`${line.getAttribute('data-start-date')}|${line.getAttribute('data-equipment-id')}`]?.source === 'actual' ? 0.9 : 0.6);
        line.setAttribute('stroke-width', '3');
        line.setAttribute('opacity', originalOpacity);
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 8: PERFORMANCE OPTIMIZATIONS AND CLEANUP
    // ═══════════════════════════════════════════════════════════════════════════

    // Create optimized redraw function with viewport culling
    const drawCampaignLinesOptimized = () => {
      const svgOverlay = window._campaignVisualization?.svgOverlay;
      if (!svgOverlay) return;

      // Get visible date range for viewport culling
      const tableScroll = window._campaignVisualization?.tableScroll;
      const visibleRange = getVisibleDateRange(tableScroll, dateToColIndex, getCellDimensions());

      // Clear SVG
      svgOverlay.innerHTML = '';

      const selectedFacilityId = state.ui.selectedFacilityId;
      if (!selectedFacilityId) return;

      const campaigns = state.org.dataset.campaigns || [];
      const campaignBlocks = groupCampaignsIntoBlocks(campaigns, selectedFacilityId);

      // Filter blocks: only draw if at least partially visible
      const visibleBlocks = campaignBlocks.filter(block => {
        if (!visibleRange.startDate || !visibleRange.endDate) return true; // No culling if range unknown

        // Block is visible if it overlaps with visible date range
        return block.endDate >= visibleRange.startDate && block.startDate <= visibleRange.endDate;
      });

      if (visibleBlocks.length === 0) return;

      const table = root.querySelector('.plan-table');
      const tbody = table?.querySelector('tbody');
      if (!table || !tbody) return;

      const dims = getCellDimensions();
      if (!dims) return;

      // Draw lines for visible blocks only
      visibleBlocks.forEach(block => {
        const blockStartDate = new Date(block.startDate + 'T00:00:00');
        const blockEndDate = new Date(block.endDate + 'T00:00:00');
        const blockDates = [];

        for (let d = new Date(blockStartDate); d <= blockEndDate; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().slice(0, 10);
          blockDates.push(dateStr);
        }

        if (blockDates.length === 0) return;

        const dateIsActual = (date) => {
          const cellMeta = plan.equipmentCellMeta?.[`${date}|${block.equipmentId}`];
          return cellMeta?.source === 'actual';
        };

        const forecastSegments = [];
        let currentSegment = null;

        blockDates.forEach(date => {
          const isActual = dateIsActual(date);

          if (!isActual) {
            if (!currentSegment) {
              currentSegment = [date];
            } else {
              currentSegment.push(date);
            }
          } else {
            if (currentSegment && currentSegment.length > 0) {
              forecastSegments.push(currentSegment);
              currentSegment = null;
            }
          }
        });

        if (currentSegment && currentSegment.length > 0) {
          forecastSegments.push(currentSegment);
        }

        // Draw lines for each segment
        forecastSegments.forEach(segment => {
          const segmentStartDate = segment[0];
          const segmentEndDate = segment[segment.length - 1];

          const startColIdx = dateToColIndex[segmentStartDate];
          const endColIdx = dateToColIndex[segmentEndDate];

          if (startColIdx === undefined || endColIdx === undefined) return;

          const colWidth = dims.colWidth || 50;
          const rowHeaderWidth = 200;

          const startX = rowHeaderWidth + (startColIdx * colWidth) + colWidth / 2;
          const endX = rowHeaderWidth + (endColIdx * colWidth) + colWidth / 2;

          const eqRows = Array.from(tbody.querySelectorAll('tr')).filter(tr => {
            const label = tr.querySelector('.row-header')?.textContent || '';
            return label.includes(block.equipmentId);
          });

          if (eqRows.length === 0) return;

          const eqRow = eqRows[0];
          const rowTop = eqRow.offsetTop || 0;
          const rowHeight = eqRow.offsetHeight || 30;
          const midlineY = rowTop + rowHeight / 2;

          const productColor = (pid) => {
            const base = ['#3b82f6','#a78bfa','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316','#84cc16'];
            let h = 0;
            (pid || '').split('').forEach(c => h = (h * 31 + c.charCodeAt(0)) >>> 0);
            return base[h % base.length];
          };
          const color = productColor(block.productId);
          const isActualCampaign = plan.equipmentCellMeta?.[`${segment[0]}|${block.equipmentId}`]?.source === 'actual';
          const opacity = isActualCampaign ? 0.9 : 0.6;

          let strokeDasharray = 'none';
          if (block.status !== 'produce') {
            strokeDasharray = '5,5';
          }

          // Draw line
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', startX);
          line.setAttribute('y1', midlineY);
          line.setAttribute('x2', endX);
          line.setAttribute('y2', midlineY);
          line.setAttribute('stroke', color);
          line.setAttribute('stroke-width', '3');
          line.setAttribute('stroke-linecap', 'round');
          line.setAttribute('opacity', opacity);
          if (strokeDasharray !== 'none') {
            line.setAttribute('stroke-dasharray', strokeDasharray);
          }
          line.setAttribute('class', `campaign-line campaign-${block.equipmentId}`);
          line.setAttribute('data-equipment-id', block.equipmentId);
          line.setAttribute('data-product-id', block.productId);
          line.setAttribute('data-status', block.status);
          line.setAttribute('data-start-date', segmentStartDate);
          line.setAttribute('data-end-date', segmentEndDate);
          line.setAttribute('data-rate', block.rateStn);
          line.style.cursor = 'pointer';

          svgOverlay.appendChild(line);

          // Draw endpoint circles
          [startX, endX].forEach((x) => {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', x);
            circle.setAttribute('cy', midlineY);
            circle.setAttribute('r', '4');
            circle.setAttribute('fill', color);
            circle.setAttribute('opacity', opacity);
            circle.setAttribute('class', 'campaign-endpoint');
            svgOverlay.appendChild(circle);
          });
        });
      });
    };

    // Replace drawCampaignLines with optimized version
    window._campaignVisualization = window._campaignVisualization || {};
    window._campaignVisualization.drawCampaignLines = drawCampaignLinesOptimized;

    // Add cleanup: Remove tooltip on page change
    window.addEventListener('beforeunload', () => {
      document.getElementById('campaignTooltip')?.remove();
    });

    // Add thead click handler for month headers (which are in thead, not tbody)
    const thead = root.querySelector('.plan-table thead');
    if(thead) {
      thead.addEventListener('click', e => {
        const summaryHeader = e.target.closest('.month-summary-col');
        const collapseIcon = e.target.closest('.month-collapse-icon');

        // Check if click was on collapse icon or summary column
        if(summaryHeader || collapseIcon) {
          e.stopPropagation();
          const header = summaryHeader || collapseIcon.closest('.month-summary-col');
          const yyyymm = header?.dataset.yyyymm;

          if(yyyymm) {
            // Toggle month collapse state
            monthCollapseState[yyyymm] = !monthCollapseState[yyyymm];
            const open = monthCollapseState[yyyymm];

            // Save collapse state to localStorage
            localStorage.setItem('planMonthCollapseState', JSON.stringify(monthCollapseState));

            // **Re-render entire table to add/remove columns from DOM**
            renderPlan();
          }
        }
      });
    }

    tbody.addEventListener('click', e => {
      // Handle month header clicks in tbody would be here if needed
      const monthHeader = e.target.closest('.collapsible-month');
      if(monthHeader) {
        return;  // month header is in thead, not tbody
      }

      // Handle family header clicks
      const familyHeader = e.target.closest('.collapsible-family');
      if(familyHeader) {
        e.stopPropagation();
        const facId = familyHeader.dataset.facility;
        const familyName = familyHeader.dataset.family;

        if(!familyOpenState[facId]) familyOpenState[facId] = {};
        familyOpenState[facId][familyName] = !familyOpenState[facId][familyName];
        const open = familyOpenState[facId][familyName];

        const icon = familyHeader.querySelector('.family-collapse-icon');
        if(icon) icon.style.transform = open ? '' : 'rotate(-90deg)';

        root.querySelectorAll(`.family-child.family-${familyName}.fac-${facId}`).forEach(row => {
          row.style.display = open ? '' : 'none';
        });
        return;
      }

      // Handle facility header clicks
      const facHeader = e.target.closest('.plan-fac-header');
      if(!facHeader) return;

      const facId = facHeader.dataset.fac;
      facOpenState[facId] = !facOpenState[facId];
      const open = facOpenState[facId];

      const icon = facHeader.querySelector('.fac-collapse-icon');
      if(icon) icon.style.transform = open ? '' : 'rotate(-90deg)';

      root.querySelectorAll(`.fac-child.fac-${facId}`).forEach(row => {
        row.style.display = open ? '' : 'none';
      });
    });
  }

  // Button handlers
  const campBtn = root.querySelector('#openCampaigns');
  const actualsBtn = root.querySelector('#openActuals');
  const todayBtn = root.querySelector('#jumpTodayPlan');
  if(campBtn) campBtn.onclick = () => openCampaignDialog();
  if(actualsBtn) actualsBtn.onclick = () => openDailyActualsDialog();

  // Phantom scrollbar sync
  (function syncPlanPhantom(){
    const scroll  = document.getElementById('planTableScroll');
    const phantom = document.getElementById('planPhantomBar');
    const inner   = document.getElementById('planPhantomInner');
    if(!scroll || !phantom || !inner) return;
    const sync = () => { inner.style.width = scroll.scrollWidth + 'px'; };
    sync();
    new ResizeObserver(sync).observe(scroll);
    phantom.addEventListener('scroll', () => { scroll.scrollLeft = phantom.scrollLeft; });
    scroll.addEventListener('scroll',  () => { phantom.scrollLeft = scroll.scrollLeft; });
  })();

  // Jump to today with expansion options - PHASE 3 UPDATED
  if(todayBtn){
    todayBtn.onclick = () => {
      const scroll = document.getElementById('planTableScroll');
      const table  = document.getElementById('planTable');
      if(!scroll || !table) return;

      const todayStr = today();
      const todayMonth = todayStr.slice(0, 7); // YYYY-MM

      // Show expansion menu (simple confirm dialog)
      const options = 'What would you like to show?\n\n1. Today\'s month only\n2. Today + surrounding context\n3. Everything (all months/families)\n\nEnter 1, 2, or 3 (default: 3)';
      const choice = prompt(options, '3');

      if(choice === null) return; // User cancelled

      const expand = choice === '1' ? 'month' : choice === '2' ? 'context' : 'all';

      // Collapse/expand months based on choice - PHASE 4 UPDATED
      Object.keys(monthCollapseState).forEach(yyyymm => {
        if(expand === 'all') {
          monthCollapseState[yyyymm] = true; // expand all
        } else if(expand === 'context') {
          // Expand today's month and adjacent months
          const todayYYYY = todayMonth.slice(0, 4);
          const todayMM = parseInt(todayMonth.slice(5, 7));
          const [yyyy, mm] = yyyymm.split('-').map((s, i) => i === 0 ? parseInt(s) : parseInt(s));
          const monthDiff = (yyyy - todayYYYY) * 12 + (mm - todayMM);
          monthCollapseState[yyyymm] = Math.abs(monthDiff) <= 2; // expand today ± 2 months
        } else { // 'month' mode
          monthCollapseState[yyyymm] = (yyyymm === todayMonth); // expand only today's month
        }
      });

      // Save month collapse state to localStorage
      localStorage.setItem('planMonthCollapseState', JSON.stringify(monthCollapseState));

      // Expand facilities and families based on choice
      table.querySelectorAll('.plan-fac-header').forEach(tr => {
        const facId = tr.dataset.fac;
        if(expand !== 'all') {
          facOpenState[facId] = expand === 'context' || expand === 'all';
        } else {
          facOpenState[facId] = true;
        }
        tr.querySelector('.fac-collapse-icon').style.transform = facOpenState[facId] ? '' : 'rotate(-90deg)';
        root.querySelectorAll(`.fac-child.fac-${facId}`).forEach(r => r.style.display = facOpenState[facId] ? '' : 'none');
      });

      // Expand families based on choice
      table.querySelectorAll('.collapsible-family').forEach(tr => {
        const facId = tr.dataset.facility;
        const familyName = tr.dataset.family;
        if(!familyOpenState[facId]) familyOpenState[facId] = {};

        if(expand === 'all') {
          familyOpenState[facId][familyName] = true;
        } else if(expand === 'context') {
          familyOpenState[facId][familyName] = true;
        }
        // 'month' mode doesn't expand families, just shows the facility

        const icon = tr.querySelector('.family-collapse-icon');
        if(icon) icon.style.transform = familyOpenState[facId][familyName] ? '' : 'rotate(-90deg)';
        root.querySelectorAll(`.family-child.family-${familyName}.fac-${facId}`).forEach(r => {
          r.style.display = familyOpenState[facId][familyName] ? '' : 'none';
        });
      });

      // Re-render table to apply month collapse changes
      renderPlan();

      // Find and scroll to today's column (delayed to allow re-render)
      setTimeout(() => {
        let th = null;
        table.querySelectorAll('thead th[data-date]').forEach(t => { if(t.dataset.date === todayStr) th = t; });
        if(th){
          // Scroll with center positioning
          scroll.scrollTo({ left: Math.max(0, th.offsetLeft - scroll.offsetWidth/2 + th.offsetWidth/2), behavior: 'smooth' });

          // Highlight today's column with background
          setTimeout(() => {
            const colIndex = th.cellIndex;
            table.querySelectorAll(`tr > *:nth-child(${colIndex+1})`).forEach(c => {
              c.style.background = 'rgba(59,130,246,0.15)';
              c.style.transition = 'background 0.3s';
            });
          }, 300);
        }
      }, 100);
    };
  }

  // KPI panel toggle
  const kpiToggleBar = root.querySelector('#kpiToggleBar');
  if(kpiToggleBar){
    kpiToggleBar.onclick = () => {
      const body  = root.querySelector('#kpiBody');
      const caret = root.querySelector('#kpiCaret');
      const slim  = root.querySelector('#kpiSlimContent');
      if(!body) return;
      const nowOpen = body.style.display === 'none';
      body.style.display = nowOpen ? 'block' : 'none';
      slim.style.display = nowOpen ? 'none' : 'flex';
      caret.style.transform = nowOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
      localStorage.setItem('kpiPanelOpen', nowOpen ? '1' : '0');
    };
  }

  // Alert strip toggle
  const alertToggle = root.querySelector('#alertStripToggle');
  if(alertToggle){
    alertToggle.onclick = () => {
      const body = root.querySelector('#alertStripBody');
      const caret = root.querySelector('#alertStripCaret');
      const isNowHidden = body.style.display !== 'none';
      body.style.display = isNowHidden ? 'none' : 'block';
      caret.style.transform = isNowHidden ? 'rotate(-90deg)' : 'rotate(0deg)';
      localStorage.setItem('planAlertStripCollapsed', isNowHidden ? '1' : '0');
    };
  }

  // Alert chip click → jump to date
  root.querySelectorAll('[data-jump-date]').forEach(chip => {
    chip.onclick = () => {
      const scroll = document.getElementById('planTableScroll');
      const table  = document.getElementById('planTable');
      if(!scroll || !table) return;

      const targetDate = chip.dataset.jumpDate;
      let targetTh = null;
      table.querySelectorAll('thead th[data-date]').forEach(th => {
        if(th.dataset.date === targetDate) targetTh = th;
      });

      if(!targetTh) return;

      // Expand all facilities if needed
      table.querySelectorAll('.plan-fac-header').forEach(tr => {
        const facId = tr.dataset.fac;
        if(!facOpenState[facId]){
          facOpenState[facId] = true;
          tr.querySelector('.fac-collapse-icon').style.transform = '';
          root.querySelectorAll(`.fac-child.fac-${facId}`).forEach(r => r.style.display = '');
        }
      });

      scroll.scrollTo({ left: Math.max(0, targetTh.offsetLeft - 200), behavior: 'smooth' });

      // Flash the column
      const colIndex = targetTh.cellIndex;
      table.querySelectorAll(`tr > *:nth-child(${colIndex+1})`).forEach(c => {
        const orig = c.style.background;
        c.style.transition = 'background 0.15s';
        c.style.background = 'rgba(239,68,68,0.3)';
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
    fd.nameOverride = productName;  // tell upsertCatalogItem to use this name directly

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

  const eqTypeLabel = t => ({kiln:'Kiln',finish_mill:'Finish Mill',raw_mill:'Raw Mill',unloader:'Unloader',loader:'Loader',switch:'Rail Switch'}[t]||t);
  const eqTypePill = t => {
    const map = {kiln:'pill-amber',finish_mill:'pill-blue',raw_mill:'pill-gray',unloader:'pill-teal',loader:'pill-green',switch:'pill-purple'};
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
            <div><label class="form-label">Type *</label><select class="form-input" name="type"><option value="kiln">Kiln</option><option value="finish_mill">Finish Mill</option><option value="raw_mill">Raw Mill</option><option value="unloader">Unloader</option><option value="loader">Loader</option><option value="switch">Rail Switch</option></select></div>
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
  const rer = ()=>{ persist(); renderFlow(); renderPlan(); renderDemand(); };
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
    <div class="card-header sticky-table-header" id="demandCardHeader">
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
      <div class="sticky-scroll-wrap" id="demandScrollWrap">
        <div class="phantom-scrollbar" id="demandPhantomBar"><div class="phantom-inner" id="demandPhantomInner"></div></div>
        <div class="table-scroll" id="demandTableScroll" style="overflow-x:auto;overflow-y:auto;max-height:calc(100vh - 220px)">
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

  // Phantom scrollbar sync — demand
  (function syncDemandPhantom(){
    const scroll  = document.getElementById('demandTableScroll');
    const phantom = document.getElementById('demandPhantomBar');
    const inner   = document.getElementById('demandPhantomInner');
    if(!scroll || !phantom || !inner) return;
    const sync = () => { inner.style.width = scroll.scrollWidth + 'px'; };
    sync();
    new ResizeObserver(sync).observe(scroll);
    phantom.addEventListener('scroll', () => { scroll.scrollLeft = phantom.scrollLeft; });
    scroll.addEventListener('scroll',  () => { phantom.scrollLeft = scroll.scrollLeft; });
  })();
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
  const eqs = s.equipment.filter(e=>['kiln','finish_mill','loader'].includes(e.type));
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

        <!-- Loading Schedule (loader only) -->
        <div id="campLoadingScheduleWrap" style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;display:none;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:10px;">Loading Schedule</div>
          <select class="form-input" id="campLoadingDays" style="width:100%">
            <option value="weekdays">Weekdays only (Mon-Fri)</option>
            <option value="weekdays_sat">Weekdays + Saturday (Mon-Sat)</option>
            <option value="daily">Every day (Mon-Sun)</option>
          </select>
        </div>

        <!-- Switch Schedule (loader only) -->
        <div id="campSwitchScheduleWrap" style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;display:none;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:10px;">Switch Schedule (days the rail company picks up)</div>
          <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;">
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="campSwitch_MON" value="MON"> MON
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="campSwitch_TUE" value="TUE"> TUE
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="campSwitch_WED" value="WED"> WED
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="campSwitch_THU" value="THU"> THU
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="campSwitch_FRI" value="FRI"> FRI
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="campSwitch_SAT" value="SAT"> SAT
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="campSwitch_SUN" value="SUN"> SUN
            </label>
          </div>
          <div id="campSwitchWarning" style="font-size:10px;color:var(--warning);margin-top:8px;display:none;font-style:italic">⚠️ Previous campaign missing switch schedule</div>
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
          <div><label class="form-label" id="campRateLabel">Rate (STn/day)</label><input class="form-input text-mono" type="number" step="0.1" id="campRate" value="0"></div>
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

  const writeRate = v => {
    if(!isFinite(v)) return;
    const eqId=q('campEq').value;
    const eq = s.equipment.find(e=>e.id===eqId);
    const isLoader = eq?.type === 'loader';
    const displayValue = isLoader ? Math.round(v/112*10)/10 : v;
    const unit = isLoader ? 'cars/d' : 'STn/d';
    q('campRate').value=String(displayValue);
    q('campRateEcho').textContent=`${fmt(displayValue)} ${unit}`;
  };
  const renderHelpers = () => {
    const eqId=q('campEq').value; const status=q('campStatus').value; const productId=q('campProduct').value; const startDate=q('campStart').value;
    const eq=s.equipment.find(e=>e.id===eqId); const isLoader=eq?.type==='loader';
    const cap=s.getCapsForEquipment(eqId).find(c=>c.productId===productId);
    rateCache.cap=cap?.maxRateStpd??null;
    const capDisplay=isLoader?Math.round(rateCache.cap/112*10)/10:rateCache.cap;
    const capUnit=isLoader?'cars/d':'STn/d';
    q('campCapRate').textContent=isFinite(rateCache.cap)?`${fmt(capDisplay)} ${capUnit}`:'—';
    if(status!=='produce'||!productId){ q('campRateAssist').style.opacity='0.5'; q('campRollSource').textContent='—'; ['7','15','30'].forEach(k=>q('campRoll'+k).textContent='—'); q('campRateEcho').textContent=`${fmt(+q('campRate').value||0)} ${capUnit}`; return; }
    q('campRateAssist').style.opacity='1';
    const r7=computeRolling(eqId,productId,startDate,7); const r15=computeRolling(eqId,productId,startDate,15); const r30=computeRolling(eqId,productId,startDate,30);
    rateCache.r7=r7.value; rateCache.r15=r15.value; rateCache.r30=r30.value;
    const fmt7=isLoader?Math.round(r7.value/112*10)/10:r7.value;
    const fmt15=isLoader?Math.round(r15.value/112*10)/10:r15.value;
    const fmt30=isLoader?Math.round(r30.value/112*10)/10:r30.value;
    q('campRoll7').textContent=isFinite(r7.value)?`${fmt(fmt7)} (${r7.points})`:'N/A';
    q('campRoll15').textContent=isFinite(r15.value)?`${fmt(fmt15)} (${r15.points})`:'N/A';
    q('campRoll30').textContent=isFinite(r30.value)?`${fmt(fmt30)} (${r30.points})`:'N/A';
    q('campRollSource').textContent=[r7,r15,r30].find(x=>x.source&&x.source!=='none')?.source||'none';
    const unit=isLoader?'cars/d':'STn/d';
    q('campRateEcho').textContent=`${fmt(+q('campRate').value||0)} ${unit}`;
  };

  const refreshProducts = () => {
    const eqId=q('campEq').value; const status=q('campStatus').value;
    const eq = s.equipment.find(e=>e.id===eqId);
    const isLoader = eq?.type === 'loader';
    const rateUnit = isLoader ? 'Cars/day' : 'STn/day';
    q('campRateLabel').textContent = `Rate (${rateUnit})`;
    const caps=s.getCapsForEquipment(eqId);
    q('campProduct').innerHTML=caps.map(c=>`<option value="${c.productId}">${esc(s.getMaterial(c.productId)?.name||c.productId)} @ ${fmt0(c.maxRateStpd)} STn/d</option>`).join('');
    q('campProductWrap').style.display=status==='produce'?'':'none';
    q('campRate').disabled=status!=='produce';
    if(status==='produce'){ const firstCap=caps[0]; if(firstCap&&isFinite(+firstCap.maxRateStpd)) q('campRate').value=String(isLoader ? +firstCap.maxRateStpd/112 : +firstCap.maxRateStpd||0); } else q('campRate').value='0';

    // Show/hide schedule sections for loaders in produce mode
    const showSchedules = isLoader && status === 'produce';
    q('campLoadingScheduleWrap').style.display = showSchedules ? '' : 'none';
    q('campSwitchScheduleWrap').style.display = showSchedules ? '' : 'none';

    if(showSchedules) {
      // Pre-populate from last loader campaign
      const loaderCampaigns = camps.filter(c => {
        const loaderEq = s.equipment.find(ee=>ee.id===c.equipmentId);
        return loaderEq?.type === 'loader';
      });
      const lastLoaderCamp = loaderCampaigns[loaderCampaigns.length - 1]; // most recent

      // Pre-populate loading schedule
      if(lastLoaderCamp && lastLoaderCamp.loadingDays) {
        q('campLoadingDays').value = lastLoaderCamp.loadingDays;
      } else {
        q('campLoadingDays').value = 'weekdays'; // default to weekdays
      }

      // Clear all switch checkboxes first
      ['MON','TUE','WED','THU','FRI','SAT','SUN'].forEach(day => {
        q(`campSwitch_${day}`).checked = false;
      });

      // Hide warning initially
      q('campSwitchWarning').style.display = 'none';

      if(lastLoaderCamp) {
        if(lastLoaderCamp.switchDays && Array.isArray(lastLoaderCamp.switchDays)) {
          // Pre-select checkboxes from last campaign
          lastLoaderCamp.switchDays.forEach(day => {
            const checkbox = q(`campSwitch_${day}`);
            if(checkbox) checkbox.checked = true;
          });
        } else if(lastLoaderCamp.switchDays === undefined) {
          // Legacy campaign without switchDays field
          q('campSwitchWarning').style.display = 'block';
        }
      }
    }

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
  q('campProduct').onchange=()=>{ const eqId=q('campEq').value; const eq=s.equipment.find(e=>e.id===eqId); const isLoader=eq?.type==='loader'; const cap=s.getCapsForEquipment(eqId).find(c=>c.productId===q('campProduct').value); if(cap&&isFinite(+cap.maxRateStpd)) q('campRate').value=String(isLoader?Math.round(+cap.maxRateStpd/112*10)/10:+cap.maxRateStpd||0); renderHelpers(); };
  q('campStart').onchange=()=>dateCalc('start');
  q('campEnd').onchange=()=>dateCalc('end');
  q('campDuration').oninput=()=>dateCalc('duration');
  q('campRate').oninput=()=>{ const eqId=q('campEq').value; const eq=s.equipment.find(e=>e.id===eqId); const isLoader=eq?.type==='loader'; const unit=isLoader?'cars/d':'STn/d'; q('campRateEcho').textContent=`${fmt(+q('campRate').value||0)} ${unit}`; };
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
        const eq = s.getEquipment(eqId);
        const isLoader = eq?.type === 'loader';
        const loadingLabel = isLoader && b.loadingDays ? {'weekdays':'Wkdy','weekdays_sat':'Wkdy+Sat','daily':'Daily'}[b.loadingDays] || b.loadingDays : '';
        const switchDaysDisplay = isLoader && b.switchDays?.length ? ` [${b.switchDays.join(',')}]` : '';
        return `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--border);font-size:11px">
          <span class="pill ${statusPill(b.status)}" style="font-size:9px;padding:1px 5px;flex-shrink:0">${statusLabel(b.status)}</span>
          <span style="flex:1;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(prod)}">${prod ? esc(prod) : '<span style="color:var(--muted)">—</span>'}</span>
          <span class="text-mono" style="color:var(--muted);font-size:10px;flex-shrink:0">${b.start.slice(5)}→${b.end.slice(5)}</span>
          ${isLoader ? `<span class="text-mono" style="color:var(--muted);font-size:9px;flex-shrink:0">${loadingLabel}</span>` : ''}
          ${isLoader ? `<span class="text-mono" style="color:var(--accent);font-size:9px;flex-shrink:0">${switchDaysDisplay || '[no switch]'}</span>` : ''}
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
  q('campApply').onclick=e=>{ e.preventDefault(); const eqId=q('campEq').value; const eq=s.equipment.find(ee=>ee.id===eqId); const isLoader=eq?.type==='loader'; const rateValue=+q('campRate').value||0; const switchDays=isLoader?['MON','TUE','WED','THU','FRI','SAT','SUN'].filter(day=>q(`campSwitch_${day}`).checked):[]; const loadingDays=isLoader?q('campLoadingDays').value:null; const payload={equipmentId:eqId,status:q('campStatus').value,productId:q('campProduct').value,startDate:q('campStart').value,endDate:q('campEnd').value,rateStn:isLoader?rateValue*112:rateValue}; if(isLoader){payload.switchDays=switchDays;payload.loadingDays=loadingDays;} if(payload.status==='produce'&&!payload.productId){q('campMsg').textContent='Select a product.';return;} const warning=a.saveCampaignBlock(payload); persist(); if(warning){q('campMsg').textContent=warning;showToast('⚠️ Campaign applied with warnings');}else{q('campMsg').textContent='✓ Campaign block applied';showToast('Campaign applied ✓');} renderPlan(); openCampaignDialog(); };
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
    const uf = s.equipment.filter(e=>e.type==='unloader');
    const ld = s.equipment.filter(e=>e.type==='loader');  // loaders for Rail Transfers
    const canEqProd = (eqId,pid) => s.capabilities.some(c=>c.equipmentId===eqId&&c.productId===pid);
    const existing = s.actualsForDate(y);
    const invMap  = new Map((existing.inv ||[]).map(r=>[`${r.storageId}|${r.productId}`,r.qtyStn]));
    const prodMap = new Map((existing.prod||[]).map(r=>[`${r.equipmentId}|${r.productId}`,r.qtyStn]));
    const shipMap = new Map((existing.ship||[]).map(r=>[r.productId,r.qtyStn]));
    const railMap = new Map((existing.rail||[]).map(r=>[`${r.equipmentId}|${r.productId}`,r.qtyStn]));
    const railEodValue = existing.railEod ? (existing.railEod.qtyStn / 112) : '';  // Convert STn back to cars

    // Calculate loading and pickup values from existing rail data
    const railLoadingValue = (existing.rail || [])
      .filter(r => r.type === 'loading')
      .reduce((sum, r) => sum + (r.qtyStn || 0), 0) / 112;  // Convert STn to cars
    const railPickupValue = (existing.rail || [])
      .filter(r => r.type === 'pickup')
      .reduce((sum, r) => sum + (r.qtyStn || 0), 0) / 112;  // Convert STn to cars

    const fac = state.org.facilities.find(f=>f.id===activeFacId);
    const facLabel = fac ? `${fac.code} — ${fac.name}` : activeFacId;

    // Facility tabs
    const tabsHTML = facs.length > 1 ? `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)">
        ${facs.map(f=>`<button data-fac-tab="${f.id}" style="padding:5px 14px;border-radius:6px;border:1px solid ${f.id===activeFacId?'var(--accent)':'var(--border)'};background:${f.id===activeFacId?'rgba(99,179,237,0.15)':'transparent'};color:${f.id===activeFacId?'var(--accent)':'var(--muted)'};font-size:11px;font-weight:${f.id===activeFacId?'700':'400'};cursor:pointer">${esc(f.code||f.id)}</button>`).join('')}
      </div>` : '';

    // Pre-compute filtered HTML blocks to avoid nested template literal issues
    // Helper function to generate equipment table
    const createEquipmentTable = (eqArray, eqType) => {
      if (!eqArray.length) return '';
      const mats = s.materials.filter(m => eqArray.some(eq => canEqProd(eq.id, m.id)));
      if (!mats.length) return '';
      return '<table class="data-table" style="min-width:max-content"><thead><tr>' +
        '<th style="min-width:160px;position:sticky;left:0;background:#0a0d14;z-index:3">Equipment</th>' +
        mats.map(m=>'<th style="min-width:90px">'+esc(m.code||m.name.slice(0,10))+'</th>').join('') +
        '</tr></thead><tbody>' +
        eqArray.map(eq =>
          '<tr><td style="font-weight:600;position:sticky;left:0;background:var(--surface2);z-index:2">' +
          esc(eq.name)+' <span class="pill pill-gray" style="font-size:9px">'+eq.type+'</span></td>' +
          mats.map(m => canEqProd(eq.id,m.id)
            ? '<td><input class="cell-input prod-input" data-equipment="'+eq.id+'" data-product="'+m.id+'" value="'+(prodMap.get(eq.id+'|'+m.id)??'')+'"></td>'
            : '<td class="cell-gray">—</td>'
          ).join('') + '</tr>'
        ).join('') +
        '</tbody></table>';
    };

    // Generate separate tables for kilns and finish mills
    const kilnsTableHTML = kf.length
      ? createEquipmentTable(kf, 'kiln')
      : '<div class="text-muted" style="font-size:12px;padding:12px;text-align:center">No kilns for this facility</div>';

    const finishMillsTableHTML = ff.length
      ? createEquipmentTable(ff, 'finish_mill')
      : '<div class="text-muted" style="font-size:12px;padding:12px;text-align:center">No finish mills for this facility</div>';


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

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">1. Production Actuals - Kilns (STn)</div>
      <div class="table-scroll" style="margin-bottom:20px;max-height:260px;border-radius:8px;overflow-x:auto;overflow-y:auto;border:1px solid var(--border)">
        ${kilnsTableHTML}
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">2. Production Actuals - Finish Mills (STn)</div>
      <div class="table-scroll" style="margin-bottom:20px;max-height:260px;border-radius:8px;overflow-x:auto;overflow-y:auto;border:1px solid var(--border)">
        ${finishMillsTableHTML}
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#ffffff;margin-bottom:12px">3. Rail Transfer (Cars)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px">
        <div>
          <label class="form-label" style="color:#ffffff">Cars Loaded</label>
          <input class="form-input rail-simple" id="railLoading" type="number" step="1" placeholder="0" value="${railLoadingValue > 0 ? railLoadingValue : ''}">
        </div>
        <div>
          <label class="form-label" style="color:#ffffff">Cars Picked Up (Switch)</label>
          <input class="form-input rail-simple" id="railPickup" type="number" step="1" placeholder="0" value="${railPickupValue > 0 ? railPickupValue : ''}">
        </div>
        <div>
          <label class="form-label" style="color:#ffffff">EOD</label>
          <input class="form-input rail-simple" id="railEodCars" type="number" step="1" placeholder="0" value="${railEodValue}">
        </div>
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">4. Customer Shipments (STn)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;margin-bottom:20px">
        ${shipHTML}
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">5. Ending Inventory (STn)</div>
      <div class="table-scroll" style="margin-bottom:20px;max-height:200px;border-radius:8px;overflow-y:auto !important;border:1px solid var(--border)">
        <table class="data-table"><thead><tr><th>Storage</th><th>Product</th><th>EOD Quantity (STn)</th></tr></thead>
        <tbody>${s.storages.map(st=>{const pid=(st.allowedProductIds||[])[0]||'';return`<tr><td style="font-weight:600">${esc(st.name)}</td><td>${esc(s.getMaterial(pid)?.name||'')}</td><td><input class="cell-input inv-input" data-storage="${st.id}" data-product="${pid}" value="${invMap.get(`${st.id}|${pid}`)??''}"></td></tr>`;}).join('')||'<tr><td colspan="3" class="text-muted" style="text-align:center;padding:12px">No storages for this facility</td></tr>'}</tbody>
        </table>
      </div>

      `;

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
      // ✓ FIX: Only include rows where field has a value (blank = don't change existing value)
      // Before: +i.value||0 would convert empty "" to 0, overwriting existing inventory
      // Now: Filter out rows where value is blank - they won't be submitted, so existing values preserved
      const inventoryRows  = [...host.querySelectorAll('.inv-input')]
        .filter(i => i.value !== '' && i.value !== null)  // ✓ Skip empty fields
        .map(i=>({storageId:i.dataset.storage,productId:i.dataset.product,qtyStn:+i.value}))
        .filter(r=>r.productId);
      const productionRows = [...host.querySelectorAll('.prod-input')]
        .filter(i => i.value !== '' && i.value !== null)  // ✓ Skip empty fields
        .map(i=>({equipmentId:i.dataset.equipment,productId:i.dataset.product,qtyStn:+i.value}));

      // Rail Transfer: Get equipment IDs and product ID from facility configuration
      const loaderEq = s.equipment.find(e=>e.type==='loader');
      const switchEq = s.equipment.find(e=>e.type==='switch');
      const railStorage = s.storages.find(st=>st.categoryHint==='TRANSFER');
      const railProductId = railStorage?.allowedProductIds?.[0] || '';

      // DEBUG: Check if rail equipment/storage exist
      if (!switchEq || !railStorage || !railProductId) {
        console.log('⚠️ RAIL TRANSFER CONFIG ISSUE:', {
          hasSwitch: !!switchEq,
          hasStorage: !!railStorage,
          hasProduct: !!railProductId
        });
      }

      // Simple rail transfer fields: cars loaded, cars picked up, and EOD cars
      // Convert from CARS to STn (1 car = 112 STn)
      const railTransferRows = [];
      const carsLoaded = host.querySelector('#railLoading')?.value;
      const carsPicked = host.querySelector('#railPickup')?.value;
      const railEodCars = host.querySelector('#railEodCars')?.value;
      if (carsLoaded !== '' && carsLoaded !== null && +carsLoaded > 0) {
        if (loaderEq?.id && railProductId) {
          railTransferRows.push({type:'loading', equipmentId:loaderEq.id, productId:railProductId, qtyStn: +carsLoaded * 112});
        }
      }
      if (carsPicked !== '' && carsPicked !== null && +carsPicked > 0) {
        if (switchEq?.id && railProductId) {
          railTransferRows.push({type:'pickup', equipmentId:switchEq.id, productId:railProductId, qtyStn: +carsPicked * 112});
        }
      }
      if (railEodCars !== '' && railEodCars !== null && +railEodCars >= 0) {
        railTransferRows.push({type:'eod', qtyStn: +railEodCars * 112});
      }
      const shipmentRows   = [...host.querySelectorAll('.ship-input')]
        .filter(i => i.value !== '' && i.value !== null)  // ✓ Skip empty fields
        .map(i=>({productId:i.dataset.product,qtyStn:+i.value}));

      // Debug: Show what's being saved for rail transfers
      if (railTransferRows.length > 0) {
        console.log('🚂 RAIL TRANSFER DATA BEING SAVED:', railTransferRows);
      } else {
        console.log('⚠️ No rail transfer rows captured');
      }

      a.saveDailyActuals({date, facilityId: activeFacId, inventoryRows, productionRows, railTransferRows, shipmentRows});

      // DEBUG: Verify data is in state before persist
      const railInState = state.official?.actuals?.railTransfers || [];
      if (railTransferRows.length > 0) {
        console.log('📊 STATE CHECK - Rail transfers in state.official.actuals:', railInState.length, 'records');
      }

      persist(); renderDemand(); renderPlan(); showToast(`Actuals saved for ${activeFacId} ✓`);
    };

    // FIXED: Move facility tab/date handlers outside - they rely on buildForm being callable
    // The Save button handler stays with the modal setup since the button exists there
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
        ${type==='facility' ? `
        <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px">
          <label class="form-label" style="margin-bottom:8px;display:block">Facility Roles</label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:12px">
            <div style="display:flex;gap:6px"><input type="checkbox" id="sfRole_calcination" value="calcination" ${existing?.roles?.includes('calcination')?'checked':''} style="cursor:pointer"><label style="cursor:pointer">Calcination (Kilns)</label></div>
            <div style="display:flex;gap:6px"><input type="checkbox" id="sfRole_grinding" value="grinding" ${existing?.roles?.includes('grinding')?'checked':''} style="cursor:pointer"><label style="cursor:pointer">Grinding (Finish Mills)</label></div>
            <div style="display:flex;gap:6px"><input type="checkbox" id="sfRole_rail-dispatch" value="rail-dispatch" ${existing?.roles?.includes('rail-dispatch')?'checked':''} style="cursor:pointer"><label style="cursor:pointer">Rail Dispatch</label></div>
            <div style="display:flex;gap:6px"><input type="checkbox" id="sfRole_vessel-dispatch" value="vessel-dispatch" ${existing?.roles?.includes('vessel-dispatch')?'checked':''} style="cursor:pointer"><label style="cursor:pointer">Vessel Dispatch</label></div>
            <div style="display:flex;gap:6px"><input type="checkbox" id="sfRole_rail-receiving" value="rail-receiving" ${existing?.roles?.includes('rail-receiving')?'checked':''} style="cursor:pointer"><label style="cursor:pointer">Rail Receiving</label></div>
            <div style="display:flex;gap:6px"><input type="checkbox" id="sfRole_vessel-receiving" value="vessel-receiving" ${existing?.roles?.includes('vessel-receiving')?'checked':''} style="cursor:pointer"><label style="cursor:pointer">Vessel Receiving</label></div>
          </div>
        </div>
        ` : ''}
      </div>`;

    const q = id => formEl.querySelector('#'+id);
    q('sfCancel').onclick = () => { formEl.innerHTML = ''; };
    q('sfCode').oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); };

    q('sfSave').onclick = () => {
      const name = q('sfName').value.trim();
      const code = q('sfCode').value.trim().toUpperCase();
      if(!name){ q('sfName').focus(); return; }

      // Collect facility roles if this is a facility
      let roles = [];
      if(type==='facility'){
        const roleCheckboxes = ['calcination', 'grinding', 'rail-dispatch', 'vessel-dispatch', 'rail-receiving', 'vessel-receiving'];
        roles = roleCheckboxes.filter(r => formEl.querySelector('#sfRole_' + r)?.checked);
      }

      if(editId){
        if(type==='country')   a.updateCountry({id:editId, name, code});
        if(type==='region')    a.updateRegion({id:editId, name, code});
        if(type==='subregion') a.updateSubRegion({id:editId, name, code});
        if(type==='facility'){
          a.updateFacility({id:editId, name, code});
          a.updateFacilityRoles(editId, roles);
        }
      } else {
        if(type==='country')   a.addCountry({name, code});
        if(type==='region')    a.addRegion({countryId:parentId, name, code});
        if(type==='subregion') a.addSubRegion({regionId:parentId, name, code});
        if(type==='facility'){
          const facId = a.addFacility({subRegionId:parentId, name, code});
          if(facId) {
            a.updateFacilityRoles(facId, roles);
            if(!state.ui.selectedFacilityId) state.ui.selectedFacilityId = facId;
          }
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
/* ─────────────────── LOGISTICS — RULES OF ENGAGEMENT ─────────────────── */
function renderLogisticsRules(){
  const root = el('tab-logistics-rules');
  if(!root) return;

  const org      = state.org;
  const allFacs  = org.facilities;
  const catalog  = state.catalog || [];
  const rules    = getRulesOfEngagement(state);

  // Helper: product name from id
  const prodName = pid => {
    const p = catalog.find(c=>c.id===pid);
    return p ? (p.name || pid) : pid;
  };

  // Helper: facility name from id
  const facName = fid => {
    const f = allFacs.find(f=>f.id===fid);
    return f ? `${f.code} — ${f.name}` : fid;
  };

  // Group rules by facility for display
  const rulesByFac = {};
  allFacs.forEach(f => { rulesByFac[f.id] = []; });
  rules.forEach(r => {
    if(!rulesByFac[r.facilityId]) rulesByFac[r.facilityId] = [];
    rulesByFac[r.facilityId].push(r);
  });

  // Facilities that have at least one rule
  const facsWithRules = allFacs.filter(f => rulesByFac[f.id]?.length);
  const facsNoRules   = allFacs.filter(f => !rulesByFac[f.id]?.length);

  const ruleRow = (r) => `
    <div class="roe-rule-row" data-rule-id="${r.id}">
      <div class="roe-rule-product">${esc(prodName(r.productId))}</div>
      <div class="roe-rule-stat" title="Minimum cover days">
        <span class="roe-stat-label">Min Cover</span>
        <span class="roe-stat-value">${r.minCoverDays}d</span>
      </div>
      <div class="roe-rule-stat" title="Trading lead time — how many days before arrival the team must act">
        <span class="roe-stat-label">Lead Time</span>
        <span class="roe-stat-value">${r.tradingLeadTimeDays}d</span>
      </div>
      <div class="roe-rule-stat" title="Standard shipment volume">
        <span class="roe-stat-label">Std Volume</span>
        <span class="roe-stat-value">${r.standardVolumeStn ? r.standardVolumeStn.toLocaleString() + ' STn' : '—'}</span>
      </div>
      ${r.priorityRank ? `<div class="roe-rule-stat" title="Priority rank (1=highest)"><span class="roe-stat-label">Priority</span><span class="roe-stat-value">#${r.priorityRank}</span></div>` : ''}
      ${r.notes ? `<div class="roe-rule-notes" title="${esc(r.notes)}">📝 ${esc(r.notes.length>50?r.notes.slice(0,50)+'…':r.notes)}</div>` : ''}
      <div class="roe-rule-actions">
        <button class="btn" style="font-size:10px;padding:2px 8px" data-edit-rule="${r.id}">Edit</button>
        <button class="btn" style="font-size:10px;padding:2px 8px;color:var(--danger)" data-del-rule="${r.id}">Delete</button>
      </div>
    </div>`;

  const facBlock = (f) => {
    const facRules = rulesByFac[f.id] || [];
    return `
      <div class="roe-fac-block">
        <div class="roe-fac-header">
          <span style="font-size:12px">🏭</span>
          <span class="roe-fac-name">${esc(f.code)} <span style="font-weight:400;color:var(--muted)">— ${esc(f.name)}</span></span>
          <button class="btn btn-primary" style="font-size:10px;padding:2px 10px;margin-left:auto" data-add-rule-fac="${f.id}">+ Add Rule</button>
        </div>
        <div class="roe-rules-list">
          ${facRules.length ? facRules.map(ruleRow).join('') :
            '<div style="padding:10px 14px;font-size:11px;color:var(--muted);font-style:italic">No rules defined — the agent will ask before making recommendations for this facility.</div>'}
        </div>
      </div>`;
  };

  root.innerHTML = `
    <div style="max-width:960px;margin:0 auto;">

      <div class="card" style="margin-bottom:16px">
        <div class="card-header">
          <div>
            <div class="card-title">📋 Rules of Engagement</div>
            <div class="card-sub text-muted" style="font-size:11px">
              Regional policy — set once, applied by the agent on every recommendation.
              If a rule is missing, the agent will ask before proceeding.
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:10px;padding:3px 10px;border-radius:999px;background:rgba(99,179,237,0.1);border:1px solid rgba(99,179,237,0.3);color:var(--accent)">
              🌐 Shared — applies in all scenarios
            </span>
          </div>
        </div>
        <div class="card-body" style="padding:0">
          ${allFacs.length === 0
            ? '<div style="padding:40px;text-align:center;color:var(--muted);font-size:12px">No facilities configured. Set up your organization in ⚙ Settings first.</div>'
            : `<div id="roeList">
                ${facsWithRules.map(facBlock).join('')}
                ${facsNoRules.length && facsWithRules.length
                  ? `<div style="padding:6px 16px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);border-top:1px solid var(--border)">Facilities with no rules yet</div>`
                  : ''}
                ${facsNoRules.map(facBlock).join('')}
               </div>`
          }
        </div>
      </div>

      <!-- Inline form panel — hidden until add/edit triggered -->
      <div id="roeFormCard" class="card" style="display:none;margin-bottom:16px">
        <div class="card-header">
          <div class="card-title" id="roeFormTitle">Add Rule</div>
          <button class="btn" id="roeFormCancel">Cancel</button>
        </div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px">

            <div>
              <label class="form-label">Facility *</label>
              <select class="form-input" id="roeFacility">
                <option value="">— select —</option>
                ${allFacs.map(f=>`<option value="${f.id}">${esc(f.code)} — ${esc(f.name)}</option>`).join('')}
              </select>
            </div>

            <div>
              <label class="form-label">Product *</label>
              <select class="form-input" id="roeProduct">
                <option value="">— select facility first —</option>
              </select>
            </div>

          </div>

          <!-- ✓ NEW: Elements Panel for Drag-and-Drop -->
          <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
            <div style="font-size:11px;font-weight:600;color:var(--accent);text-transform:uppercase;margin-bottom:8px;letter-spacing:0.5px">
              Available Elements (Drag into rule)
            </div>

            <!-- Products Section -->
            <div style="margin-bottom:12px">
              <button type="button" class="elements-section-header" data-section="products"
                style="background:none;border:none;color:var(--accent);font-weight:600;font-size:12px;cursor:pointer;padding:4px 0;display:flex;align-items:center;gap:6px">
                <span style="display:inline-block;width:12px;text-align:center">▶</span>
                <span>Products</span>
              </button>
              <div class="elements-panel" id="elementsProducts" style="display:none;margin-top:6px"></div>
            </div>

            <!-- Equipment Section -->
            <div style="margin-bottom:12px">
              <button type="button" class="elements-section-header" data-section="equipment"
                style="background:none;border:none;color:var(--accent);font-weight:600;font-size:12px;cursor:pointer;padding:4px 0;display:flex;align-items:center;gap:6px">
                <span style="display:inline-block;width:12px;text-align:center">▶</span>
                <span>Equipment</span>
              </button>
              <div class="elements-panel" id="elementsEquipment" style="display:none;margin-top:6px"></div>
            </div>

            <!-- Storage Section -->
            <div style="margin-bottom:12px">
              <button type="button" class="elements-section-header" data-section="storage"
                style="background:none;border:none;color:var(--accent);font-weight:600;font-size:12px;cursor:pointer;padding:4px 0;display:flex;align-items:center;gap:6px">
                <span style="display:inline-block;width:12px;text-align:center">▶</span>
                <span>Storage</span>
              </button>
              <div class="elements-panel" id="elementsStorage" style="display:none;margin-top:6px"></div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:640px;margin-top:16px">

            <div>
              <label class="form-label">Minimum Cover Days *
                <span style="font-weight:400;color:var(--muted);font-size:10px">— trigger threshold</span>
              </label>
              <input class="form-input" type="number" id="roeMinCover" min="0" step="1" placeholder="e.g. 20">
            </div>

            <div>
              <label class="form-label">Trading Lead Time Days *
                <span style="font-weight:400;color:var(--muted);font-size:10px">— time team needs to act</span>
              </label>
              <input class="form-input" type="number" id="roeTradingLead" min="0" step="1" placeholder="e.g. 35">
            </div>

            <div>
              <label class="form-label">Standard Volume STn
                <span style="font-weight:400;color:var(--muted);font-size:10px">— typical shipment size</span>
              </label>
              <input class="form-input" type="number" id="roeStdVolume" min="0" step="100" placeholder="e.g. 30000">
            </div>

            <div>
              <label class="form-label">Priority Rank
                <span style="font-weight:400;color:var(--muted);font-size:10px">— 1 = highest (optional)</span>
              </label>
              <input class="form-input" type="number" id="roePriority" min="1" step="1" placeholder="e.g. 1">
            </div>

            <div style="grid-column:1/-1">
              <label class="form-label">Notes</label>
              <input class="form-input" type="text" id="roeNotes" placeholder="Any context or special conditions for this rule…" maxlength="200">
            </div>

          </div>

          <!-- ✓ NEW: Production Constraint Fields -->
          <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <input type="checkbox" id="roeEnableFormalRule" style="cursor:pointer">
              <label class="form-label" style="margin:0;cursor:pointer;flex:1" for="roeEnableFormalRule">
                Add Production Constraint Rule (recipe version &amp; clinker sourcing)
              </label>
            </div>

            <div id="roeFormalRuleSection" style="display:none">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                <div>
                  <label class="form-label">Equipment (optional)
                    <span style="font-weight:400;color:var(--muted);font-size:10px">— leave blank for all equipment</span>
                  </label>
                  <select class="form-input" id="roeEquipment">
                    <option value="">— any equipment —</option>
                  </select>
                </div>
                <div></div>
              </div>

              <div style="margin-top:12px">
                <label class="form-label">User Description
                  <span style="font-weight:400;color:var(--muted);font-size:10px">— drag elements + type natural language</span>
                </label>
                <div class="form-input description-input" id="roeUserDescription"
                  contenteditable="true"
                  style="min-height:80px;padding:12px;overflow-y:auto"
                  data-placeholder="Drag equipment/product/storage here and describe your rule…">
                </div>
              </div>

              <div style="margin-top:12px">
                <label class="form-label">Formal Rule (JSON)
                  <span style="font-weight:400;color:var(--muted);font-size:10px">— AI will generate this, or edit manually</span>
                </label>
                <textarea class="form-input" id="roeFormalRule"
                  style="min-height:120px;font-family:'IBM Plex Mono',monospace;font-size:11px"
                  placeholder='{"type":"equipmentClikerConstraint","targetEquipment":"BROSFM01","rules":[{"comment":"Always use v1","then":{"recipeVersion":"v1","allowedClinkerSources":["BRS_CLK_K1"]}}]}'>
                </textarea>
                <div style="font-size:11px;color:var(--muted);margin-top:4px">
                  ℹ Valid JSON with type, targetEquipment, and rules array required
                </div>
              </div>
            </div>
          </div>

          <div style="margin-top:16px;display:flex;gap:8px">
            <button class="btn btn-primary" id="roeFormSave">Save Rule</button>
            <button class="btn" id="roeFormCancel2">Cancel</button>
          </div>
          <input type="hidden" id="roeEditId">
        </div>
      </div>

    </div>`;

  // ── Populate product dropdown when facility changes ──
  const facSel  = root.querySelector('#roeFacility');
  const prodSel = root.querySelector('#roeProduct');

  const populateProducts = (facId, selectedProductId='') => {
    const ds = state.official; // rules are shared — always use official catalog
    const activated = (ds.facilityProducts || [])
      .filter(fp => fp.facilityId === facId)
      .map(fp => fp.productId);
    const prods = catalog.filter(p => activated.includes(p.id));
    prodSel.innerHTML = prods.length
      ? prods.map(p=>`<option value="${p.id}" ${p.id===selectedProductId?'selected':''}>${esc(p.name)}</option>`).join('')
      : '<option value="">— no products activated for this facility —</option>';
  };

  // ✓ NEW: Populate equipment dropdown when facility changes
  const equipSel = root.querySelector('#roeEquipment');
  const populateEquipment = (facId, selectedEquipId='') => {
    if (!facId) { equipSel.innerHTML = '<option value="">— select facility first —</option>'; return; }
    const allEquip = (state.official?.equipment || []).filter(e => e.facilityId === facId);
    equipSel.innerHTML =
      '<option value="">— any equipment —</option>' +
      allEquip.map(e => `<option value="${e.id}" ${e.id===selectedEquipId?'selected':''}>${esc(e.name)} (${esc(e.type)})</option>`).join('');
  };

  // ✓ NEW: Populate elements panels (products, equipment, storage) for drag-and-drop
  const populateElementsPanels = (facId) => {
    if (!facId) {
      root.querySelector('#elementsProducts').innerHTML = '';
      root.querySelector('#elementsEquipment').innerHTML = '';
      root.querySelector('#elementsStorage').innerHTML = '';
      return;
    }

    const ds = state.official;
    const catalog2 = state.catalog || [];

    // Products
    const activated = (ds.facilityProducts || [])
      .filter(fp => fp.facilityId === facId)
      .map(fp => fp.productId);
    const prods = catalog2.filter(p => activated.includes(p.id));
    root.querySelector('#elementsProducts').innerHTML = prods.map(p =>
      `<button type="button" class="element-chip" draggable="true" data-element-type="product" data-element-id="${esc(p.id)}">${esc(p.name)}</button>`
    ).join('');

    // Equipment
    const allEquip = (ds.equipment || []).filter(e => e.facilityId === facId);
    root.querySelector('#elementsEquipment').innerHTML = allEquip.map(e =>
      `<button type="button" class="element-chip" draggable="true" data-element-type="equipment" data-element-id="${esc(e.id)}">${esc(e.name)}</button>`
    ).join('');

    // Storage
    const allStorage = (ds.storages || []).filter(s => s.facilityId === facId);
    root.querySelector('#elementsStorage').innerHTML = allStorage.map(s =>
      `<button type="button" class="element-chip" draggable="true" data-element-type="storage" data-element-id="${esc(s.id)}">${esc(s.name)}</button>`
    ).join('');
  };

  facSel?.addEventListener('change', () => {
    populateProducts(facSel.value);
    populateEquipment(facSel.value);
    populateElementsPanels(facSel.value);
  });

  // ✓ NEW: Drag-and-Drop Event Handlers
  const descriptionInput = root.querySelector('#roeUserDescription');

  // Handle dragstart from element chips
  root.addEventListener('dragstart', (e) => {
    if (e.target.classList.contains('element-chip')) {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('elementType', e.target.dataset.elementType);
      e.dataTransfer.setData('elementId', e.target.dataset.elementId);
      e.dataTransfer.setData('elementName', e.target.textContent);
      e.target.classList.add('dragging');
    }
  });

  root.addEventListener('dragend', (e) => {
    if (e.target.classList.contains('element-chip')) {
      e.target.classList.remove('dragging');
    }
  });

  // Handle drag over and drop into description field
  descriptionInput?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    descriptionInput.classList.add('drag-over');
  });

  descriptionInput?.addEventListener('dragleave', (e) => {
    if (e.target === descriptionInput) {
      descriptionInput.classList.remove('drag-over');
    }
  });

  descriptionInput?.addEventListener('drop', (e) => {
    e.preventDefault();
    descriptionInput.classList.remove('drag-over');

    const elementType = e.dataTransfer.getData('elementType');
    const elementId = e.dataTransfer.getData('elementId');
    const elementName = e.dataTransfer.getData('elementName');

    if (!elementType || !elementId) return;

    // Create chip element
    const chip = document.createElement('span');
    chip.className = 'description-chip';
    chip.dataset.elementId = elementId;
    chip.dataset.elementType = elementType;
    chip.innerHTML = `${esc(elementName)} <button type="button" class="remove-chip" data-remove-chip="1">×</button>`;

    // Handle chip removal
    const removeBtn = chip.querySelector('[data-remove-chip]');
    removeBtn.addEventListener('click', (e2) => {
      e2.preventDefault();
      e2.stopPropagation();
      chip.remove();
    });

    // Insert chip at cursor position
    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.insertNode(chip);
      range.setStartAfter(chip);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      descriptionInput.appendChild(chip);
    }

    // Add space after chip
    descriptionInput.appendChild(document.createTextNode(' '));
    descriptionInput.focus();
  });

  // ✓ NEW: Toggle collapsible element sections
  root.querySelectorAll('.elements-section-header').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const section = btn.dataset.section;
      const panel = root.querySelector(`#elements${section.charAt(0).toUpperCase() + section.slice(1)}`);
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : '';
      btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    });
  });

  // ✓ NEW: Toggle formal rule section
  const enableCheckbox = root.querySelector('#roeEnableFormalRule');
  const formalSection = root.querySelector('#roeFormalRuleSection');
  enableCheckbox?.addEventListener('change', () => {
    formalSection.style.display = enableCheckbox.checked ? '' : 'none';
  });

  // ── Show form ──
  const showForm = (facId='', ruleId='') => {
    const formCard = root.querySelector('#roeFormCard');
    formCard.style.display = '';
    formCard.scrollIntoView({ behavior:'smooth', block:'nearest' });

    const existing = ruleId ? rules.find(r=>r.id===ruleId) : null;
    root.querySelector('#roeFormTitle').textContent = existing ? 'Edit Rule' : 'Add Rule';
    root.querySelector('#roeEditId').value = ruleId || '';

    if(facId) facSel.value = facId;
    populateProducts(facSel.value, existing?.productId || '');
    populateEquipment(facSel.value, existing?.equipmentId || '');
    populateElementsPanels(facSel.value);  // ✓ NEW: Populate elements panels

    if(existing){
      root.querySelector('#roeMinCover').value   = existing.minCoverDays   || '';
      root.querySelector('#roeTradingLead').value = existing.tradingLeadTimeDays || '';
      root.querySelector('#roeStdVolume').value   = existing.standardVolumeStn  || '';
      root.querySelector('#roePriority').value    = existing.priorityRank  || '';
      root.querySelector('#roeNotes').value       = existing.notes         || '';
      // ✓ NEW: Populate formal rule fields
      root.querySelector('#roeEnableFormalRule').checked = !!existing.formalRule;
      formalSection.style.display = existing.formalRule ? '' : 'none';

      // ✓ NEW: Reconstruct description with chips (for editing)
      descriptionInput.innerHTML = '';
      if (existing.userDescription) {
        // Parse description string with [TYPE:ID] markers and reconstruct chips + text
        const text = existing.userDescription;
        const chipRegex = /\[([A-Z_]+):([^\]]+)\]/g;
        let lastIdx = 0;
        let match;

        // Get facility data for name lookups
        const facilityId = facSel.value;
        const facilityData = state.org.facilities.find(f => f.id === facilityId);
        const facilityProducts = state.official.facilityProducts?.filter(fp => fp.facilityId === facilityId) || [];
        const facilityEquipment = state.official.equipment?.filter(e => e.facilityId === facilityId) || [];
        const facilityStorages = state.official.storages?.filter(st => st.facilityId === facilityId) || [];

        while ((match = chipRegex.exec(text)) !== null) {
          // Add text before chip
          if (match.index > lastIdx) {
            descriptionInput.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
          }

          const elementType = match[1].toLowerCase(); // e.g., 'equipment' from 'EQUIPMENT'
          const elementId = match[2];

          // Find element name from facility data (products, equipment, storage)
          let elementName = elementId; // fallback to ID if name not found
          if (elementType === 'product') {
            const prod = catalog.find(c => c.id === elementId);
            if (prod) elementName = prod.name;
          } else if (elementType === 'equipment') {
            const eq = facilityEquipment.find(e => e.id === elementId);
            if (eq) elementName = eq.name;
          } else if (elementType === 'storage') {
            const st = facilityStorages.find(s => s.id === elementId);
            if (st) elementName = st.name;
          }

          // Create and insert chip
          const chip = document.createElement('span');
          chip.className = 'description-chip';
          chip.dataset.elementId = elementId;
          chip.dataset.elementType = elementType;
          chip.innerHTML = `${esc(elementName)} <button type="button" class="remove-chip" data-remove-chip="1">×</button>`;

          // Re-attach remove handlers
          const removeBtn = chip.querySelector('[data-remove-chip]');
          removeBtn.addEventListener('click', (e2) => {
            e2.preventDefault();
            e2.stopPropagation();
            chip.remove();
          });

          descriptionInput.appendChild(chip);
          descriptionInput.appendChild(document.createTextNode(' '));
          lastIdx = chipRegex.lastIndex;
        }

        // Add remaining text after last chip
        if (lastIdx < text.length) {
          descriptionInput.appendChild(document.createTextNode(text.slice(lastIdx)));
        }
      }

      root.querySelector('#roeFormalRule').value = existing.formalRule ? JSON.stringify(existing.formalRule, null, 2) : '';
    } else {
      root.querySelector('#roeMinCover').value    = '';
      root.querySelector('#roeTradingLead').value = '';
      root.querySelector('#roeStdVolume').value   = '';
      root.querySelector('#roePriority').value    = '';
      root.querySelector('#roeNotes').value       = '';
      // ✓ NEW: Reset formal rule fields
      root.querySelector('#roeEnableFormalRule').checked = false;
      formalSection.style.display = 'none';
      descriptionInput.innerHTML = '';  // ✓ NEW: Clear contenteditable
      root.querySelector('#roeFormalRule').value = '';
    }
  };

  const hideForm = () => {
    root.querySelector('#roeFormCard').style.display = 'none';
  };

  // ── Delegate list button clicks (edit / delete / add) ──
  root.querySelector('#roeList')?.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if(!btn) return;

    if(btn.dataset.addRuleFac){
      showForm(btn.dataset.addRuleFac, '');
      return;
    }
    if(btn.dataset.editRule){
      const rule = rules.find(r=>r.id===btn.dataset.editRule);
      if(rule) showForm(rule.facilityId, rule.id);
      return;
    }
    if(btn.dataset.delRule){
      if(!confirm('Delete this rule? The agent will ask for it again next time it needs it.')) return;
      deleteRuleOfEngagement(state, btn.dataset.delRule);
      persistNow();
      showToast('Rule deleted');
      renderLogisticsRules();
    }
  });

  // ── Cancel buttons ──
  root.querySelector('#roeFormCancel')?.addEventListener('click',  hideForm);
  root.querySelector('#roeFormCancel2')?.addEventListener('click', hideForm);

  // ── Save ──
  root.querySelector('#roeFormSave')?.addEventListener('click', () => {
    const facilityId  = facSel?.value?.trim();
    const productId   = prodSel?.value?.trim();
    const minCover    = root.querySelector('#roeMinCover').value;
    const leadTime    = root.querySelector('#roeTradingLead').value;
    const stdVol      = root.querySelector('#roeStdVolume').value;
    const priority    = root.querySelector('#roePriority').value;
    const notes       = root.querySelector('#roeNotes').value.trim();
    const editId      = root.querySelector('#roeEditId').value || undefined;

    // ✓ NEW: Get formal rule fields
    const enableFormal   = root.querySelector('#roeEnableFormalRule').checked;
    const equipmentId    = enableFormal ? (root.querySelector('#roeEquipment').value || null) : null;

    // ✓ NEW: Extract description from contenteditable div (mixed text + chip elements)
    let userDesc = '';
    if (enableFormal) {
      const descDiv = root.querySelector('#roeUserDescription');
      descDiv.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          userDesc += node.textContent;
        } else if (node.classList && node.classList.contains('description-chip')) {
          const elementId = node.dataset.elementId;
          const elementType = node.dataset.elementType;
          // Store as [TYPE:ID] marker for later deserialization
          userDesc += `[${elementType.toUpperCase()}:${elementId}]`;
          // Add space to preserve text flow
          userDesc += ' ';
        }
      });
      userDesc = userDesc.trim();
    }

    const formalRuleJson = enableFormal ? root.querySelector('#roeFormalRule').value.trim() : '';

    if(!facilityId){ showToast('Select a facility', 'warn'); return; }
    if(!productId){  showToast('Select a product',  'warn'); return; }
    if(!minCover || +minCover < 0){ showToast('Enter minimum cover days', 'warn'); return; }
    if(!leadTime || +leadTime < 0){ showToast('Enter trading lead time',  'warn'); return; }

    // ✓ NEW: Validate formal rule if provided
    let formalRule = null;
    if(enableFormal && formalRuleJson){
      try {
        formalRule = JSON.parse(formalRuleJson);
        if(!formalRule.type || !formalRule.rules || !Array.isArray(formalRule.rules)){
          showToast('Formal rule must have type and rules array', 'warn');
          return;
        }
      } catch(e){
        showToast(`Invalid JSON in formal rule: ${e.message}`, 'warn');
        return;
      }
    }

    // Check for duplicate (different id, same facility+product)
    const duplicate = rules.find(r =>
      r.facilityId === facilityId &&
      r.productId  === productId  &&
      r.id         !== editId
    );
    if(duplicate){
      if(!confirm('A rule already exists for this facility and product. Replace it?')) return;
      deleteRuleOfEngagement(state, duplicate.id);
    }

    upsertRuleOfEngagement(state, {
      id:                  editId,
      facilityId,
      productId,
      equipmentId:         equipmentId || null,  // ✓ NEW
      minCoverDays:        +minCover,
      tradingLeadTimeDays: +leadTime,
      standardVolumeStn:   stdVol   ? +stdVol   : 0,
      priorityRank:        priority ? +priority : null,
      notes,
      userDescription:     userDesc || null,     // ✓ NEW
      formalRule:          formalRule || null,   // ✓ NEW
    });

    persistNow();
    showToast('Rule saved ✓');
    hideForm();
    renderLogisticsRules();
  });
}

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

function renderLogisticsTransfersPage(){
  const root = el('tab-logistics-transfers');
  if(!root) return;

  const org = state.org;
  const activeFacId = state.ui.selectedFacilityIds?.[0] || org.facilities[0]?.id;
  if(!activeFacId) {
    root.innerHTML = '<div style="padding:20px;color:var(--muted)">Please select a facility to view logistics transfers.</div>';
    return;
  }

  const date = new Date().toISOString().split('T')[0];

  // Use the same scoped state pattern as Daily Actuals
  const facState = {...state, ui:{...state.ui, selectedFacilityId: activeFacId, selectedFacilityIds:[activeFacId]}};
  const s = selectors(facState);
  const a = actions(facState);

  // Helper: Get all rail pickups for this facility (NOT aggregated - each pickup is separate batch)
  const getRailPickups = () => {
    const allRail = s.actuals?.railTransfers || [];
    console.log('🔍 getRailPickups - Total rail transfers in state:', allRail.length);
    if (allRail.length > 0) {
      console.log('🔍 Sample records:', allRail.slice(0, 2).map(r => ({type: r.type, fac: r.facilityId, date: r.date})));
    }
    console.log('🔍 Looking for: type=pickup AND facilityId=' + activeFacId);
    const railTransfers = allRail.filter(rt => rt.type === 'pickup' && rt.facilityId === activeFacId);
    console.log('🔍 Found matching pickups:', railTransfers.length);

    // Calculate allocated quantities for each batch to show remaining availability
    const pickups = railTransfers.map(rt => {
      // Get all assignments for this batch
      const allocations = (s.actuals?.railDistributions || []).filter(
        rd => rd.batchId === rt.batchId && rd.sourceFacilityId === activeFacId
      );
      const allocatedQty = allocations.reduce((sum, a) => sum + a.qtyStn, 0);
      const remainingQty = rt.qtyStn - allocatedQty;

      return {
        batchId: rt.batchId || `TEMP-${rt.date}-${rt.productId}`, // Fallback for old data without batchId
        pickupDate: rt.date,
        productId: rt.productId,
        qtyStn: rt.qtyStn,
        allocatedQty,
        remainingQty,
        isFullyAllocated: remainingQty <= 0
      };
    }).filter(p => p.remainingQty > 0); // Only show batches with unallocated quantity

    return pickups;
  };

  const allPickups = getRailPickups();
  const railReceivingFacs = state.org.facilities.filter(f =>
    f.id !== activeFacId && (f.roles || []).includes('rail-receiving')
  );

  const renderPage = () => {
    const batchOptions = allPickups.map((p, i) =>
      `<option value="${i}" data-batchid="${p.batchId}" data-date="${p.pickupDate}" data-product="${p.productId}" data-qty="${p.remainingQty}">${p.batchId} | ${p.pickupDate} | ${Math.round(p.remainingQty / 112)} cars remaining | ${esc(s.getMaterial(p.productId)?.name || p.productId)}</option>`
    ).join('');
    const destOptions = railReceivingFacs.map(f =>
      `<option value="${f.id}">${esc(f.code)} - ${esc(f.name)}</option>`
    ).join('');

    const dists = a.railDistributionsForDate({ sourceFacilityId: activeFacId, assignedDate: date }) || [];

    // Calculate batch allocation stats
    const batchStats = {};
    dists.forEach(d => {
      if (!batchStats[d.batchId]) {
        const originalPickup = allPickups.find(p => p.batchId === d.batchId);
        batchStats[d.batchId] = {
          totalQty: originalPickup?.qtyStn || 0,
          allocatedQty: 0
        };
      }
      batchStats[d.batchId].allocatedQty += d.qtyStn;
    });

    const distRows = dists.map(d => {
      const destFac = state.org.facilities.find(f => f.id === d.destinationFacilityId);
      const product = s.getMaterial(d.productId);
      const stats = batchStats[d.batchId];
      const allocPct = stats ? Math.round((stats.allocatedQty / stats.totalQty) * 100) : 0;

      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px">${d.pickupDate}</td>
        <td style="padding:8px;font-family:monospace;font-size:11px">${esc(d.batchId || 'N/A')}</td>
        <td style="padding:8px">${esc(product?.name || d.productId)}</td>
        <td style="padding:8px;text-align:right">${Math.round(d.qtyStn / 112)}</td>
        <td style="padding:8px">${esc(destFac?.code || '')}</td>
        <td style="padding:8px;text-align:right">${d.transitTimeInDays}</td>
        <td style="padding:8px">${d.expectedArrivalDate}</td>
        <td style="padding:8px;text-align:right;font-size:10px;color:var(--muted)">${allocPct}%</td>
      </tr>`;
    }).join('');

    root.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px;min-height:400px">
      <!-- LEFT: Assignment Form -->
      <div style="border-right:1px solid var(--border);padding-right:20px">
        <div style="font-weight:700;font-size:14px;margin-bottom:16px">Assign Rail Batch</div>
        <div style="display:grid;gap:12px">
          <div>
            <label class="form-label" style="font-size:11px">Available Batch</label>
            <select id="logBatchSelect" class="form-input" style="font-size:11px;padding:8px">
              <option value="">-- Select batch --</option>
              ${batchOptions}
            </select>
          </div>
          <div>
            <label class="form-label" style="font-size:11px">Quantity (Cars)</label>
            <input id="logBatchQty" type="number" readonly class="form-input" placeholder="0" style="font-size:11px;padding:8px;background-color:rgba(255,255,255,0.05);cursor:not-allowed">
          </div>
          <div>
            <label class="form-label" style="font-size:11px">Destination Facility</label>
            <select id="logDestFac" class="form-input" style="font-size:11px;padding:8px">
              <option value="">-- Select facility --</option>
              ${destOptions}
            </select>
          </div>
          <div>
            <label class="form-label" style="font-size:11px">Transit Days</label>
            <input id="logTransitDays" type="number" step="1" min="1" placeholder="1" class="form-input" style="font-size:11px;padding:8px">
          </div>
          <button id="logAssignBtn" class="btn btn-primary" style="margin-top:8px;padding:10px">Assign Batch</button>
        </div>
      </div>

      <!-- RIGHT: Assigned Distributions Table -->
      <div>
        <div style="font-weight:700;font-size:14px;margin-bottom:16px">Assigned Distributions</div>
        <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:350px;overflow-y:auto">
          <table class="data-table" style="font-size:10px;width:100%">
            <thead style="position:sticky;top:0;background:rgba(255,255,255,0.05);border-bottom:1px solid var(--border)">
              <tr><th style="padding:8px">Pickup</th><th style="padding:8px">Batch ID</th><th style="padding:8px">Product</th><th style="padding:8px;text-align:right">Cars</th><th style="padding:8px">Destination</th><th style="padding:8px;text-align:right">Days</th><th style="padding:8px">Arrival</th><th style="padding:8px;text-align:right">Alloc%</th></tr>
            </thead>
            <tbody id="logDistributionsTable" style="font-size:10px">
              ${distRows || '<tr><td colspan="8" style="text-align:center;padding:12px;color:var(--muted)">No assignments yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

    // Event handlers
    const batchSelect = root.querySelector('#logBatchSelect');
    const qtyInput = root.querySelector('#logBatchQty');
    const destSelect = root.querySelector('#logDestFac');
    const transitDaysInput = root.querySelector('#logTransitDays');
    const assignBtn = root.querySelector('#logAssignBtn');

    batchSelect.onchange = () => {
      if (batchSelect.value) {
        const selected = batchSelect.options[batchSelect.selectedIndex];
        const qtyStn = +selected.dataset.qty;
        qtyInput.value = Math.round(qtyStn / 112);
      } else {
        qtyInput.value = '';
      }
    };

    assignBtn.onclick = () => {
      const selectedIdx = batchSelect.value;
      const destFacId = destSelect.value;
      const transitDays = transitDaysInput.value;

      if (!selectedIdx) { alert('Please select a batch'); return; }
      if (!destFacId) { alert('Please select a destination facility'); return; }
      if (!transitDays || +transitDays < 1) { alert('Please enter valid transit days'); return; }

      const selected = batchSelect.options[batchSelect.selectedIndex];
      const batchId = selected.dataset.batchid;
      const pickupDate = selected.dataset.date;
      const productId = selected.dataset.product;
      const qtyStn = +selected.dataset.qty;

      // Check for over-allocation
      const originalBatch = allPickups[selectedIdx];
      const totalBatchQty = originalBatch?.qtyStn || qtyStn;
      const totalAllocated = (dists || [])
        .filter(d => d.batchId === batchId)
        .reduce((sum, d) => sum + d.qtyStn, 0);
      const newTotalAllocated = totalAllocated + qtyStn;

      if (newTotalAllocated > totalBatchQty) {
        const warning = `WARNING: You're assigning ${Math.round(newTotalAllocated / 112)} cars from a batch of ${Math.round(totalBatchQty / 112)} cars.\n\nTotal assigned will be ${Math.round(newTotalAllocated / 112)} cars (${Math.round((newTotalAllocated / totalBatchQty) * 100)}%).\n\nProceed?`;
        if (!confirm(warning)) return;
      }

      a.saveRailDistributions({
        sourceFacilityId: activeFacId,
        assignedDate: date,
        assignments: [{
          batchId,
          destinationFacilityId: destFacId,
          pickupDate,
          productId,
          qtyStn,
          transitTimeInDays: +transitDays
        }]
      });

      persist();
      showToast('Rail distribution assigned ✓');
      renderPage();
    };
  };

  renderPage();
}

// Boot handled by init() above

/* ─────────────────── DATA MANAGEMENT DIALOG ─────────────────── */
function openDataManagementDialog(){
  const host = el('dataIODialog');
  host.classList.add('open');

  const ds = state.official;
  const _facs = state.org.facilities || [];
  const _cat = state.catalog || [];
  const dateStr = new Date().toISOString().slice(0,10);

  // ── Shared utilities ──
  const parseDate = v => {
    if (!v) return '';
    if (v instanceof Date) return v.toISOString().slice(0,10);
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    const n = +s;
    if (!isNaN(n) && n > 40000 && n < 60000) {
      const d = new Date(Math.round((n - 25569) * 86400 * 1000));
      return d.toISOString().slice(0,10);
    }
    const p = new Date(s);
    return isNaN(p) ? '' : p.toISOString().slice(0,10);
  };

  const lookupFac = v => {
    const k = String(v || '').trim();
    if (!k) return { id: '', reason: 'empty_facility' };

    const ku = k.toUpperCase();
    // Exact match first (case-insensitive)
    let f = _facs.find(f => (f.code || '').toUpperCase() === ku || f.id.toUpperCase() === ku || (f.name || '').toUpperCase() === ku);
    if (f) return { id: f.id };

    // Partial match second
    f = _facs.find(f => (f.name || '').toUpperCase().includes(ku) || (f.code || '').toUpperCase().includes(ku));
    if (f) return { id: f.id };

    return { id: '', reason: `facility_not_found: "${k}"` };
  };

  const lookupProd = v => {
    const k = String(v || '').trim();
    if (!k || k === '0') return { id: '', reason: 'empty_product' };

    const ku = k.toUpperCase();
    // Material number match
    let m = _cat.find(m => (m.materialNumbers || []).some(x => String(typeof x === 'object' ? x.number : x).toUpperCase() === ku));
    if (m) return { id: m.id };

    // ID, code, or exact name match
    m = _cat.find(m => m.id.toUpperCase() === ku || (m.code || '').toUpperCase() === ku || (m.name || '').toUpperCase() === ku);
    if (m) return { id: m.id };

    // Partial name/code match
    m = _cat.find(m => (m.name || '').toUpperCase().includes(ku) || (m.code || '').toUpperCase().includes(ku));
    if (m) return { id: m.id };

    return { id: '', reason: `product_not_found: "${k}"` };
  };

  const facCode = id => _facs.find(f => f.id === id)?.code || id;
  const matNums = id => {
    const m = _cat.find(x => x.id === id);
    return (m?.materialNumbers || []).map(x => typeof x === 'object' ? x.number : x).filter(Boolean).join(', ') || '';
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  };

  // Build modal HTML
  host.innerHTML = `
    <div class="modal-content" style="max-width:600px">
      <h2>Data Management</h2>

      <div style="margin:20px 0">
        <label style="display:block;margin-bottom:4px">Data Type:</label>
        <select id="dataType" style="width:100%;padding:8px">
          <option value="production">Production Data</option>
          <option value="shipment">Shipment Data</option>
        </select>
      </div>

      <div style="display:flex;gap:10px;margin:20px 0">
        <button id="downloadBtn" style="flex:1;padding:8px;cursor:pointer">📥 Download</button>
        <button id="uploadBtn" style="flex:1;padding:8px;cursor:pointer">📤 Upload</button>
      </div>

      <div style="margin-top:20px;text-align:right">
        <button id="closeDialogBtn" style="padding:8px 16px;cursor:pointer">Close</button>
      </div>
    </div>
  `;

  // Download handler
  el('downloadBtn').onclick = () => {
    const dataType = el('dataType').value || 'production';

    // Show date range dialog
    const dlgHTML = `
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:white;padding:20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:10001">
        <h3 style="margin:0 0 15px 0">Download ${dataType === 'production' ? 'Production' : 'Shipment'} Data</h3>
        <div style="margin:15px 0">
          <label style="display:block;margin-bottom:4px">Date Range:</label>
          <select id="dlDateRange" style="width:100%;padding:8px">
            <option value="all">All Time</option>
            <option value="7days">Last 7 Days</option>
            <option value="30days">Last 30 Days</option>
            <option value="90days">Last 90 Days</option>
            <option value="custom">Custom Range</option>
          </select>
        </div>
        <div id="dlCustomRange" style="display:none;margin:15px 0">
          <div style="margin-bottom:10px">
            <label style="display:block;margin-bottom:4px">From:</label>
            <input type="date" id="dlStartDate" style="width:100%;padding:4px">
          </div>
          <div>
            <label style="display:block;margin-bottom:4px">To:</label>
            <input type="date" id="dlEndDate" style="width:100%;padding:4px">
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:20px">
          <button id="dlCancelBtn" style="flex:1;padding:8px;cursor:pointer">Cancel</button>
          <button id="dlConfirmBtn" style="flex:1;padding:8px;background:#4CAF50;color:white;cursor:pointer">Download</button>
        </div>
      </div>
    `;

    const dlg = document.createElement('div');
    dlg.innerHTML = dlgHTML;
    document.body.appendChild(dlg);

    const dlDateRange = dlg.querySelector('#dlDateRange');
    const dlCustomRange = dlg.querySelector('#dlCustomRange');

    dlDateRange.onchange = () => {
      dlCustomRange.style.display = dlDateRange.value === 'custom' ? 'block' : 'none';
    };

    dlg.querySelector('#dlCancelBtn').onclick = () => dlg.remove();

    dlg.querySelector('#dlConfirmBtn').onclick = () => {
      const rangeType = dlDateRange.value;
      const now = new Date();
      let startDate = '1900-01-01';
      let endDate = dateStr;

      if (rangeType === 'custom') {
        startDate = dlg.querySelector('#dlStartDate').value || '1900-01-01';
        endDate = dlg.querySelector('#dlEndDate').value || dateStr;
      } else if (rangeType !== 'all') {
        const daysAgo = rangeType === '7days' ? 7 : rangeType === '30days' ? 30 : 90;
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - daysAgo);
        startDate = cutoff.toISOString().slice(0,10);
      }

      // Filter and export data
      let records = [];
      if (dataType === 'production') {
        records = (ds.actuals.production || []).filter(r => r.date >= startDate && r.date <= endDate);
      } else {
        records = (ds.actuals.shipments || []).filter(r => r.date >= startDate && r.date <= endDate);
      }

      // Convert to CSV
      const headers = dataType === 'production'
        ? ['Date', 'Facility Code', 'Equipment ID', 'Material Number', 'Qty (STn)']
        : ['Date', 'Facility Code', 'Material Number', 'Qty (STn)'];

      const rows = records.map(r => {
        const matNum = matNums(r.productId);
        if (dataType === 'production') {
          return [r.date, facCode(r.facilityId), r.equipmentId || '', matNum, Math.ceil(r.qtyStn || 0)];
        } else {
          return [r.date, facCode(r.facilityId), matNum, Math.ceil(r.qtyStn || 0)];
        }
      });

      const csv = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      downloadBlob(blob, `${dataType}_data_${startDate}_to_${endDate}.csv`);

      showToast(`${dataType === 'production' ? 'Production' : 'Shipment'} data exported (${records.length} rows) ✓`, 'ok');
      dlg.remove();
    };
  };

  // Upload handler
  el('uploadBtn').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.xlsx,.xls,.csv';
    inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return;

      const dataType = el('dataType').value || 'production';
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          let rows = [];

          if (file.name.endsWith('.csv')) {
            const csv = e.target.result;
            const lines = csv.split('\n').slice(1); // skip header
            rows = lines
              .filter(line => line.trim())
              .map(line => {
                const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
                if (dataType === 'production') {
                  return {
                    date: parts[0],
                    facilityCode: parts[1],
                    equipmentId: parts[2],
                    materialNumber: parts[3],
                    qtyStn: +parts[4] || 0
                  };
                } else {
                  return {
                    date: parts[0],
                    facilityCode: parts[1],
                    materialNumber: parts[2],
                    qtyStn: +parts[3] || 0
                  };
                }
              });
          } else {
            // Excel file
            const wb = XLSX.read(e.target.result, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

            rows = data.map(row => {
              if (dataType === 'production') {
                return {
                  date: row['Date'] || row['date'] || '',
                  facilityCode: row['Facility Code'] || row['Facility'] || row['facilityCode'] || '',
                  equipmentId: row['Equipment ID'] || row['Equipment'] || row['equipmentId'] || '',
                  materialNumber: row['Material Number'] || row['Material'] || row['materialNumber'] || '',
                  qtyStn: +(row['Qty (STn)'] || row['Qty'] || row['qtyStn'] || 0)
                };
              } else {
                return {
                  date: row['Date'] || row['date'] || '',
                  facilityCode: row['Facility Code'] || row['Facility'] || row['facilityCode'] || '',
                  materialNumber: row['Material Number'] || row['Material'] || row['materialNumber'] || '',
                  qtyStn: +(row['Qty (STn)'] || row['Qty'] || row['qtyStn'] || 0)
                };
              }
            });
          }

          // Validate and import with detailed error tracking
          let created = 0, updated = 0, skipped = 0;
          const targetList = dataType === 'production' ? ds.actuals.production : ds.actuals.shipments;
          const errors = []; // Track detailed errors

          rows.forEach((row, rowIdx) => {
            const date = parseDate(row.date);
            const facLookup = lookupFac(row.facilityCode);
            const prodLookup = lookupProd(row.materialNumber);
            const facilityId = facLookup.id;
            const productId = prodLookup.id;
            const qty = Math.ceil(row.qtyStn || 0);

            // Collect error reasons
            let errorReasons = [];
            if (!date) errorReasons.push('invalid date');
            if (!facilityId) errorReasons.push(facLookup.reason || 'facility not found');
            if (!productId) errorReasons.push(prodLookup.reason || 'product not found');
            if (qty === 0) errorReasons.push('zero quantity');

            if (errorReasons.length > 0) {
              skipped++;
              errors.push({
                row: rowIdx + 1,
                data: row,
                reasons: errorReasons
              });
              return;
            }

            // Upsert logic
            if (dataType === 'production') {
              const idx = targetList.findIndex(r =>
                r.date === date && r.facilityId === facilityId && r.productId === productId && r.equipmentId === row.equipmentId
              );

              if (idx >= 0) {
                targetList[idx].qtyStn = qty;
                updated++;
              } else {
                targetList.push({
                  date, facilityId, productId, equipmentId: row.equipmentId || '', qtyStn: qty
                });
                created++;
              }
            } else {
              const idx = targetList.findIndex(r =>
                r.date === date && r.facilityId === facilityId && r.productId === productId
              );

              if (idx >= 0) {
                targetList[idx].qtyStn = qty;
                updated++;
              } else {
                targetList.push({ date, facilityId, productId, qtyStn: qty });
                created++;
              }
            }
          });

          persist();
          render();

          const summary = [];
          if (created > 0) summary.push(`${created} created`);
          if (updated > 0) summary.push(`${updated} updated`);

          let toastMsg = `Import complete: ${summary.length > 0 ? summary.join(', ') : 'no changes'}`;
          let toastType = 'ok';

          // Build detailed error message if there were skipped rows
          if (skipped > 0) {
            toastMsg += ` | ${skipped} rows skipped`;
            toastType = skipped >= rows.length * 0.5 ? 'warning' : 'ok';

            // Log detailed errors to console
            if (errors.length > 0) {
              console.group(`${dataType === 'production' ? 'Production' : 'Shipment'} Import Errors (${errors.length} rows)`);
              errors.slice(0, 20).forEach(err => {
                const msg = `Row ${err.row}: ${err.reasons.join(', ')} - Data: ${JSON.stringify(err.data)}`;
              });
              if (errors.length > 20) {
              }
              console.groupEnd();
            }
          }

          showToast(toastMsg + ' ✓', toastType);
        } catch (err) {
          showToast('Import failed: ' + err.message, 'danger');
          console.error(err);
        }
      };

      if (file.name.endsWith('.csv')) {
        reader.readAsText(file);
      } else {
        reader.readAsArrayBuffer(file);
      }
    };
    inp.click();
  };

  // Close handler
  el('closeDialogBtn').onclick = () => {
    host.classList.remove('open');
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// DEBUG: Expose clear rail transfer function to browser console
// ──────────────────────────────────────────────────────────────────────────────
window.DEBUG_clearRailTransferData = () => {
  if (!state) {
    console.error('State not loaded yet');
    return;
  }
  const a = actions(state);
  a.clearAllRailTransferData();
  location.reload();
};
