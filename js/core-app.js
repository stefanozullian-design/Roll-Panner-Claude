import { loadState, saveState, pushSandboxToOfficial } from './modules/store.js';
import { actions, selectors, Categories } from './modules/dataAuthority.js';
import { buildProductionPlanView, yesterdayLocal, startOfMonth } from './modules/simEngine.js';

let state = loadState();

const TABS = [
  ['plan','📊 Production Plan'],
  ['products','⚙️ Products & Recipes'],
  ['flow','🔄 Process Flow'],
  ['demand','📈 Demand'],
  ['data','🗄 Data'],
];

const el = id => document.getElementById(id);
const esc = s => (s??'').toString().replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n||0).toLocaleString(undefined, {maximumFractionDigits:1});
const fmt0 = n => Number(n||0).toLocaleString(undefined, {maximumFractionDigits:0});
const dateRange = (start, days) => { const a=[]; let d=new Date(start+'T00:00:00'); for(let i=0;i<days;i++){a.push(d.toISOString().slice(0,10)); d.setDate(d.getDate()+1);} return a; };
const today = () => new Date().toISOString().slice(0,10);

function persist(){ saveState(state); }

/* ─────────────────── SHELL ─────────────────── */
function initShell(){
  const ds = selectors(state);

  // Tabs
  el('tabs').innerHTML = TABS.map(([k,l])=>`<button class="tab-btn${state.ui.activeTab===k?' active':''}" data-tab="${k}">${l}</button>`).join('');
  el('tabs').onclick = e => {
    const btn = e.target.closest('[data-tab]'); if(!btn) return;
    state.ui.activeTab = btn.dataset.tab; persist(); render();
  };

  // Facility
  const fs = el('facilitySelector');
  fs.innerHTML = ds.facilities.map(f=>`<option value="${f.id}">${f.id} — ${esc(f.name)}</option>`).join('');
  fs.value = state.ui.selectedFacilityId;
  fs.onchange = () => { state.ui.selectedFacilityId = fs.value; persist(); render(); };

  // Mode badge
  const badge = el('modeBadge');
  badge.textContent = state.ui.mode.toUpperCase();
  badge.className = 'mode-badge ' + (state.ui.mode==='sandbox' ? 'mode-sandbox' : 'mode-official');
  badge.onclick = () => { state.ui.mode = state.ui.mode==='sandbox'?'official':'sandbox'; persist(); render(); };

  el('pushOfficialBtn').onclick = () => {
    if(!confirm('Push all sandbox data to Official? This overwrites the Official scenario.')) return;
    pushSandboxToOfficial(state); persist();
    showToast('Sandbox pushed to Official ✓', 'ok');
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
  TABS.forEach(([k])=>{
    const p = el(`tab-${k}`);
    if(p) p.classList.toggle('active', k===state.ui.activeTab);
  });
  if(state.ui.activeTab==='plan') renderPlan();
  else if(state.ui.activeTab==='products') renderProducts();
  else if(state.ui.activeTab==='flow') renderFlow();
  else if(state.ui.activeTab==='demand') renderDemand();
  else if(state.ui.activeTab==='data') renderData();
}

/* ─────────────────── PLAN TAB ─────────────────── */
function renderPlan(){
  const root = el('tab-plan');
  const s = selectors(state);
  const startDate = startOfMonth(yesterdayLocal());
  const plan = buildProductionPlanView(state, startDate, 35);
  const todayStr = today();

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
      <div class="kpi-sub">${stockouts.length?'in next 35 days':'None detected ✓'}</div>
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

  const alertChips = [
    ...stockouts.map(a=>`<div class="alert-chip chip-stockout">🔴 ${a.date.slice(5)} ${esc(a.storageName)} — STOCKOUT</div>`),
    ...overflows.map(a=>`<div class="alert-chip chip-full">🟡 ${a.date.slice(5)} ${esc(a.storageName)} — FULL</div>`),
    ...warnings.slice(0,4).map(a=>`<div class="alert-chip chip-high">△ ${a.date.slice(5)} ${esc(a.storageName)} &gt;75%</div>`)
  ].join('');
  const alertStripHTML = (stockouts.length+overflows.length+warnings.length)>0
    ? `<div style="margin-bottom:16px;background:linear-gradient(135deg,rgba(239,68,68,0.08),rgba(245,158,11,0.05));border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:12px 16px;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--danger);margin-bottom:8px;">⚡ Action Required</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${alertChips}</div></div>`
    : `<div style="margin-bottom:16px;padding:10px 14px;background:var(--ok-bg);border:1px solid rgba(34,197,94,0.3);border-radius:8px;font-size:12px;color:#86efac;">✅ <strong>All clear</strong> — No stockouts or capacity issues in the planning horizon.</div>`;

  const productColor = pid => {
    const base = ['#3b82f6','#a78bfa','#22c55e','#f59e0b','#ec4899','#06b6d4','#f97316','#84cc16'];
    let h=0; (pid||'').split('').forEach(c=>h=(h*31+c.charCodeAt(0))>>>0);
    return base[h%base.length];
  };
  const isWeekendDate = d => [0,6].includes(new Date(d+'T00:00:00').getDay());
  const wkdColStyle = 'background:rgba(239,68,68,0.06);border-left:1px solid rgba(239,68,68,0.3);';

  // Build unified row list from all 4 sections
  const SECTIONS = [
    { id:'bod',  title:'INVENTORY — BEGINNING OF DAY (STn)', rows: plan.inventoryBODRows  },
    { id:'prod', title:'EQUIPMENT PRODUCTION (STn/day)',      rows: plan.productionRows     },
    { id:'out',  title:'OUTFLOWS — SHIPMENTS & CONSUMPTION (STn)', rows: plan.outflowRows  },
    { id:'eod',  title:'INVENTORY — END OF DAY (STn)',        rows: plan.inventoryEODRows   },
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

  // Date header
  const dateHeaders = plan.dates.map(d => {
    const isWk = isWeekendDate(d); const isTd = d===todayStr;
    const mm=d.slice(5,7); const dd2=d.slice(8,10);
    let sty = isWk ? wkdColStyle : '';
    if(isTd) sty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);';
    return `<th style="min-width:44px;${sty}font-size:9px;${isWk?'color:rgba(239,68,68,0.65)':isTd?'color:var(--accent)':''}">${mm}/${dd2}</th>`;
  }).join('');

  // Cell renderer
  const renderDataCells = r => plan.dates.map(d => {
    const isWk = isWeekendDate(d); const isTd = d===todayStr;
    const isSubtotal = r._type==='subtotal-header';
    const v = r.values?.[d]||0;
    let baseSty = isWk ? wkdColStyle : '';
    if(isTd) baseSty += 'border-left:2px solid var(--accent);border-right:2px solid var(--accent);';

    if(r.rowType==='equipment' && r.equipmentId){
      const meta = plan.equipmentCellMeta?.[`${d}|${r.equipmentId}`];
      if(!meta || meta.status==='idle') return `<td class="num" style="${baseSty}color:var(--muted);font-size:10px"></td>`;
      if(meta.status==='maintenance') return `<td class="num" style="${baseSty}font-size:10px;font-style:italic;color:var(--muted)">MNT</td>`;
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
        <td class="row-header" style="background:rgba(255,255,255,0.04);font-weight:700;padding-left:14px;" title="${esc(r.productLabel||r.label)}">
          <span class="collapse-icon sub-icon" data-sub="${r._subId}" style="margin-right:5px;display:inline-block;transition:transform .15s;font-size:9px;">▶</span>${esc(r.label)}
        </td>${renderDataCells(r)}</tr>`;
    }
    return `<tr class="sec-child sec-${r._secId}${r._subId?' sub-child sub-'+r._subId:''}" style="display:none;">
      <td class="row-header" style="padding-left:${r._subId?'26px':'14px'};" title="${esc(r.productLabel||r.label)}">${esc(r.label)}</td>
      ${renderDataCells(r)}</tr>`;
  }).join('');

  root.innerHTML = `
  ${kpiHTML}
  ${alertStripHTML}
  <div class="card" style="margin-bottom:16px">
    <div class="card-header">
      <div>
        <div class="card-title">📊 35-Day Production Plan</div>
        <div class="card-sub text-muted" style="font-size:11px">Starting ${startDate} · ▶ click rows to expand · ✓ = actual · ⚠ = constrained · pink cols = weekends</div>
      </div>
      <div class="flex gap-2">
        <button class="btn" id="openCampaigns">🎯 Campaigns</button>
        <button class="btn btn-primary" id="openActuals">📝 Daily Actuals</button>
      </div>
    </div>
    <div class="card-body" style="padding:0">
      ${s.equipment.length===0?'<div style="padding:40px;text-align:center;color:var(--muted)">No equipment configured. Set up your Process Flow first.</div>':''}
      <div class="table-scroll">
        <table class="data-table plan-table" style="min-width:max-content;width:100%">
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
    🔴 Stockout · 🟡 Overflow · △ &gt;75% cap · Colored = campaign · MNT = maintenance · Pink cols = weekend
  </div>`;

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
}

function renderProducts(){
  const root = el('tab-products');
  const s = selectors(state);
  const a = actions(state);

  const catLabel = cat => ({[Categories.RAW]:'Raw Material',[Categories.FUEL]:'Fuel',[Categories.INT]:'Intermediate',[Categories.FIN]:'Finished Product'}[cat]||cat);
  const catPill = cat => {
    const map = {[Categories.RAW]:'pill-gray',[Categories.FUEL]:'pill-amber',[Categories.INT]:'pill-blue',[Categories.FIN]:'pill-green'};
    return `<span class="pill ${map[cat]||'pill-gray'}">${catLabel(cat)}</span>`;
  };

  root.innerHTML = `
  <div class="grid-2" style="align-items:start">

    <div class="card">
      <div class="card-header"><div class="card-title">Materials & Products</div><button class="btn" id="clearMaterialEdit">+ New</button></div>
      <div class="card-body">
        <form id="materialForm" class="form-grid" style="grid-template-columns:1fr 1fr;margin-bottom:16px">
          <input type="hidden" name="id">
          <div style="grid-column:1/-1">
            <label class="form-label">Name *</label>
            <input class="form-input" name="name" placeholder="e.g. MIA – Type IL (11%)" required>
          </div>
          <div>
            <label class="form-label">Code</label>
            <input class="form-input" name="code" placeholder="e.g. IL11">
          </div>
          <div>
            <label class="form-label">Category *</label>
            <select class="form-input" name="category">
              <option value="${Categories.RAW}">Raw Material</option>
              <option value="${Categories.FUEL}">Fuel</option>
              <option value="${Categories.INT}">Intermediate Product</option>
              <option value="${Categories.FIN}" selected>Finished Product</option>
            </select>
          </div>
          <div>
            <label class="form-label">Landed Cost (USD/STn)</label>
            <input class="form-input" type="number" step="0.01" name="landedCostUsdPerStn" placeholder="0">
          </div>
          <div>
            <label class="form-label">MMBTU/STn (fuel)</label>
            <input class="form-input" type="number" step="0.01" name="calorificPowerMMBTUPerStn" placeholder="0">
          </div>
          <div style="grid-column:1/-1;display:flex;gap:8px">
            <button type="submit" id="saveMaterialBtn" class="btn btn-primary">Save</button>
            <button type="button" id="cancelMaterialEdit" class="btn hidden">Cancel</button>
          </div>
        </form>

        <div class="table-scroll" style="max-height:360px;border-radius:8px;overflow:hidden;border:1px solid var(--border)">
          <table class="data-table">
            <thead><tr><th>Name</th><th>Category</th><th>Code</th><th>Actions</th></tr></thead>
            <tbody>
              ${s.materials.map(m=>`<tr>
                <td>${esc(m.name)}</td>
                <td>${catPill(m.category)}</td>
                <td><span class="text-mono" style="font-size:11px">${esc(m.code||'')}</span></td>
                <td><div class="row-actions"><button class="action-btn" data-edit-material="${m.id}">Edit</button><button class="action-btn del" data-del-material="${m.id}">Delete</button></div></td>
              </tr>`).join('')||'<tr><td colspan="4" class="text-muted" style="text-align:center;padding:20px">No materials yet</td></tr>'}
            </tbody>
          </table>
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
            <label class="form-label">Components</label>
            <div id="recipeComponents" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
            <button type="button" id="addRecipeLine" class="btn" style="font-size:11px">+ Add Component</button>
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

  // Wire material form
  const comps = root.querySelector('#recipeComponents');
  const addRecipeLine = () => {
    const div = document.createElement('div');
    div.style.cssText='display:grid;grid-template-columns:1fr 90px 28px;gap:6px;align-items:center';
    div.innerHTML = `<select class="form-input" name="componentMaterialId" style="font-size:12px"><option value="">Component…</option>${s.materials.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select><input class="form-input" type="number" step="0.01" name="componentPct" placeholder="%" style="font-size:12px;text-align:right"><button type="button" style="background:none;border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;font-size:13px;line-height:1;height:30px" data-remove>✕</button>`;
    div.querySelector('[data-remove]').onclick = () => div.remove();
    comps.appendChild(div);
  };

  root.querySelector('#addRecipeLine').onclick = addRecipeLine;
  addRecipeLine(); addRecipeLine();

  const clearRecipeForm = () => {
    root.querySelector('#recipeForm').reset();
    root.querySelector('[name=editingRecipeId]').value='';
    root.querySelector('#saveRecipeBtn').textContent='Save Recipe';
    root.querySelector('#cancelRecipeEdit').classList.add('hidden');
    comps.innerHTML=''; addRecipeLine(); addRecipeLine();
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
  });

  root.querySelectorAll('[data-del-recipe]').forEach(btn=>btn.onclick=()=>{
    const rec=s.dataset.recipes.find(r=>r.id===btn.dataset.delRecipe);
    if(!confirm(`Delete recipe for ${s.getMaterial(rec?.productId)?.name||rec?.productId}?`)) return;
    a.deleteRecipe(btn.dataset.delRecipe); persist(); renderProducts(); renderPlan();
  });

  root.querySelector('#recipeForm').onsubmit=e=>{
    e.preventDefault();
    const fd=new FormData(e.target);
    const rows=[...comps.querySelectorAll(':scope > div')].map(div=>({materialId:div.querySelector('[name=componentMaterialId]').value,pct:+div.querySelector('[name=componentPct]').value||0}));
    a.saveRecipe({productId:fd.get('productId'),version:+fd.get('version')||1,components:rows});
    persist(); clearRecipeForm(); renderProducts(); renderPlan(); showToast('Recipe saved ✓');
  };

  // Wire material form
  const clearMaterialForm = () => {
    root.querySelector('#materialForm').reset();
    root.querySelector('[name=id]').value='';
    root.querySelector('#saveMaterialBtn').textContent='Save';
    root.querySelector('#cancelMaterialEdit').classList.add('hidden');
  };
  root.querySelector('#clearMaterialEdit').onclick = clearMaterialForm;
  root.querySelector('#cancelMaterialEdit').onclick = clearMaterialForm;

  root.querySelectorAll('[data-edit-material]').forEach(btn=>btn.onclick=()=>{
    const m=s.materials.find(x=>x.id===btn.dataset.editMaterial); if(!m) return;
    const f=root.querySelector('#materialForm');
    f.querySelector('[name=id]').value=m.id;
    f.querySelector('[name=name]').value=m.name||'';
    f.querySelector('[name=code]').value=m.code||'';
    f.querySelector('[name=category]').value=m.category||Categories.FIN;
    f.querySelector('[name=landedCostUsdPerStn]').value=m.landedCostUsdPerStn||'';
    f.querySelector('[name=calorificPowerMMBTUPerStn]').value=m.calorificPowerMMBTUPerStn||'';
    root.querySelector('#saveMaterialBtn').textContent='Update';
    root.querySelector('#cancelMaterialEdit').classList.remove('hidden');
  });

  root.querySelectorAll('[data-del-material]').forEach(btn=>btn.onclick=()=>{
    const m=s.materials.find(x=>x.id===btn.dataset.delMaterial);
    if(!confirm(`Delete ${m?.name}? Also removes related recipes, capabilities, and actuals.`)) return;
    a.deleteMaterial(btn.dataset.delMaterial); persist(); renderProducts(); renderFlow(); renderDemand(); renderPlan();
  });

  root.querySelector('#materialForm').onsubmit=e=>{
    e.preventDefault();
    a.upsertMaterial(Object.fromEntries(new FormData(e.target).entries()));
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
          <div class="table-scroll" style="max-height:240px;border-radius:8px;overflow:hidden;border:1px solid var(--border)">
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
          <div class="table-scroll" style="max-height:220px;border-radius:8px;overflow:hidden;border:1px solid var(--border)">
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
        <div class="table-scroll" style="max-height:480px;border-radius:8px;overflow:hidden;border:1px solid var(--border)">
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
  root.querySelectorAll('[data-del-eq]').forEach(btn=>btn.onclick=()=>{ if(!confirm('Delete equipment and all capabilities/actuals?')) return; a.deleteEquipment(btn.dataset.delEq); rer(); });
  root.querySelectorAll('[data-edit-st]').forEach(btn=>btn.onclick=()=>{ const row=s.storages.find(x=>x.id===btn.dataset.editSt); if(!row) return; const f=root.querySelector('#stForm'); f.querySelector('[name=id]').value=row.id; f.querySelector('[name=name]').value=row.name; f.querySelector('[name=categoryHint]').value=row.categoryHint||''; f.querySelector('[name=allowedProductId]').value=(row.allowedProductIds||[])[0]||''; f.querySelector('[name=maxCapacityStn]').value=row.maxCapacityStn||''; root.querySelector('#saveStBtn').textContent='Update'; root.querySelector('#cancelStEdit').classList.remove('hidden'); });
  root.querySelectorAll('[data-del-st]').forEach(btn=>btn.onclick=()=>{ if(!confirm('Delete storage and related inventory actuals?')) return; a.deleteStorage(btn.dataset.delSt); rer(); });
  root.querySelectorAll('[data-edit-cap]').forEach(btn=>btn.onclick=()=>{ const c=s.capabilities.find(x=>x.id===btn.dataset.editCap); if(!c) return; const f=root.querySelector('#capForm'); f.querySelector('[name=editingCapId]').value=c.id; f.querySelector('[name=equipmentId]').value=c.equipmentId; f.querySelector('[name=productId]').value=c.productId; f.querySelector('[name=maxRateStpd]').value=c.maxRateStpd||''; f.querySelector('[name=electricKwhPerStn]').value=c.electricKwhPerStn||''; root.querySelector('#saveCapBtn').textContent='Update Capability'; root.querySelector('#cancelCapEdit').classList.remove('hidden'); });
  root.querySelectorAll('[data-del-cap]').forEach(btn=>btn.onclick=()=>{ if(!confirm('Delete capability?')) return; a.deleteCapability(btn.dataset.delCap); rer(); });
  root.querySelector('#eqForm').onsubmit=e=>{ e.preventDefault(); a.upsertEquipment(Object.fromEntries(new FormData(e.target).entries())); clearEq(); rer(); showToast('Equipment saved ✓'); };
  root.querySelector('#stForm').onsubmit=e=>{ e.preventDefault(); const fd=new FormData(e.target); a.upsertStorage({id:fd.get('id')||'',name:fd.get('name'),categoryHint:fd.get('categoryHint'),allowedProductIds:fd.get('allowedProductId')?[fd.get('allowedProductId')]:[], maxCapacityStn:fd.get('maxCapacityStn')}); clearSt(); rer(); showToast('Storage saved ✓'); };
  root.querySelector('#capForm').onsubmit=e=>{ e.preventDefault(); const fd=new FormData(e.target); a.upsertCapability({equipmentId:fd.get('equipmentId'),productId:fd.get('productId'),maxRateStpd:fd.get('maxRateStpd'),electricKwhPerStn:fd.get('electricKwhPerStn'),thermalMMBTUPerStn:'0'}); clearCap(); rer(); showToast('Capability saved ✓'); };
}

/* ─────────────────── DEMAND TAB ─────────────────── */
function renderDemand(){
  const root = el('tab-demand');
  const s = selectors(state);
  const a = actions(state);
  const start = startOfMonth(yesterdayLocal());
  const dates = dateRange(start, 35);

  root.innerHTML = `
  <div class="card">
    <div class="card-header">
      <div><div class="card-title">Demand Planning</div><div class="card-sub text-muted">Green = confirmed actual shipment (read-only). Enter forecast in white cells.</div></div>
      <div class="flex gap-2">
        <button id="openForecastTool" class="btn">⚙ Forecast Tool</button>
        <button id="saveDemandBtn" class="btn btn-primary">Save Forecast</button>
      </div>
    </div>
    <div class="card-body">
      ${!s.finishedProducts.length ? '<div style="padding:20px;background:var(--warn-bg);border:1px solid rgba(245,158,11,0.3);border-radius:8px;color:#fcd34d;font-size:12px">⚠ No finished products defined. Add them in Products & Recipes.</div>' : ''}
      <div class="table-scroll" style="max-height:65vh">
        <table class="data-table">
          <thead><tr><th style="min-width:160px;position:sticky;left:0;background:#0d1018;z-index:3">Product</th>${dates.map(d=>{
            const isWk=[0,6].includes(new Date(d+'T00:00:00').getDay());
            return `<th style="min-width:56px;${isWk?'color:var(--muted)':''}">${d.slice(5)}</th>`;
          }).join('')}</tr></thead>
          <tbody>
            ${s.finishedProducts.map(fp=>`<tr>
              <td style="position:sticky;left:0;background:var(--surface);z-index:2;font-weight:600">${esc(fp.name)}</td>
              ${dates.map(d=>{
                const actual=s.dataset.actuals.shipments.find(r=>r.date===d&&r.facilityId===state.ui.selectedFacilityId&&r.productId===fp.id);
                const fc=s.dataset.demandForecast.find(r=>r.date===d&&r.facilityId===state.ui.selectedFacilityId&&r.productId===fp.id);
                if(actual) return `<td class="num" style="background:rgba(34,197,94,0.1);color:#86efac;font-size:11px" title="Actual shipment">${fmt0(actual.qtyStn)}</td>`;
                return `<td><input class="cell-input demand-input" data-date="${d}" data-product="${fp.id}" value="${fc?fc.qtyStn:''}"></td>`;
              }).join('')}
            </tr>`).join('')||'<tr><td class="text-muted" style="text-align:center;padding:20px">No finished products</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  root.querySelector('#saveDemandBtn').onclick = () => {
    const rows = [...root.querySelectorAll('.demand-input')].map(i=>({date:i.dataset.date,productId:i.dataset.product,qtyStn:+i.value||0})).filter(r=>r.qtyStn>0);
    a.saveDemandForecastRows(rows); persist(); renderDemand(); renderPlan(); showToast('Forecast saved ✓');
  };
  root.querySelector('#openForecastTool').onclick = () => openForecastToolDialog();
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
        <div><label class="form-label">Product</label><select class="form-input" id="fcProduct">${s.finishedProducts.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
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
  const actualQty = (d,pid) => { const r=s.dataset.actuals.shipments.find(x=>x.facilityId===state.ui.selectedFacilityId&&x.date===d&&x.productId===pid); return r?+r.qtyStn:null; };
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
    const fac=state.ui.selectedFacilityId;
    const keys=new Set(rows.map(r=>`${r.date}|${fac}|${r.productId}`));
    s.dataset.demandForecast=s.dataset.demandForecast.filter(x=>!keys.has(`${x.date}|${x.facilityId}|${x.productId}`));
    rows.filter(r=>(+r.qtyStn||0)>0&&!hasActual(r.date,r.productId)).forEach(r=>s.dataset.demandForecast.push({date:r.date,facilityId:fac,productId:r.productId,qtyStn:+r.qtyStn,source:'forecast'}));
    persist(); renderDemand(); renderPlan();
    q('fcMsg').innerHTML=`<span style="color:var(--ok)">✓ Applied</span> — `+[...msg].join(' · ');
    showToast('Forecast applied ✓');
  };
}

/* ─────────────────── CAMPAIGN DIALOG ─────────────────── */
function openCampaignDialog(){
  const s = selectors(state); const a = actions(state);
  const host = el('campaignDialog');
  const eqs = s.equipment.filter(e=>['kiln','finish_mill'].includes(e.type));
  const todayStr = yesterdayLocal();

  host.classList.add('open');
  host.innerHTML = `<div class="modal" style="max-width:900px">
    <div class="modal-header">
      <div><div class="modal-title">🎯 Equipment Campaign Planner</div><div style="font-size:11px;color:var(--muted)">Define production blocks. Actual data entered in Daily Actuals will override planned values.</div></div>
      <button class="btn" id="campClose">Close</button>
    </div>
    <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div>
        <div style="font-weight:600;margin-bottom:12px">New Campaign Block</div>
        <div class="form-grid" style="margin-bottom:12px">
          <div><label class="form-label">Equipment</label><select class="form-input" id="campEq">${eqs.map(e=>`<option value="${e.id}">${esc(e.name)} (${e.type})</option>`).join('')}</select></div>
          <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr">
            <div><label class="form-label">Status</label><select class="form-input" id="campStatus"><option value="produce">Produce</option><option value="maintenance">Maintenance</option><option value="idle">Idle</option></select></div>
            <div><label class="form-label">Start</label><input class="form-input" type="date" id="campStart" value="${todayStr}"></div>
            <div><label class="form-label">End</label><input class="form-input" type="date" id="campEnd" value="${todayStr}"></div>
          </div>
          <div id="campProductWrap"><label class="form-label">Product</label><select class="form-input" id="campProduct"></select></div>
        </div>

        <div class="rate-helper" id="campRateAssist">
          <div class="rate-helper-title">Rate Helper — trimmed rolling actuals</div>
          <div class="rate-grid">
            <div class="rate-cell"><div class="rate-cell-label">Capability max</div><div class="rate-cell-value" id="campCapRate">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Source</div><div class="rate-cell-value" id="campRollSource" style="font-size:10px;color:var(--muted)">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Rolling 7d</div><div class="rate-cell-value" id="campRoll7">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Rolling 15d</div><div class="rate-cell-value" id="campRoll15">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Rolling 30d</div><div class="rate-cell-value" id="campRoll30">—</div></div>
            <div class="rate-cell"><div class="rate-cell-label">Will apply</div><div class="rate-cell-value" id="campRateEcho">—</div></div>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button class="btn" id="campUseCap" style="font-size:11px">Use Cap</button>
            <button class="btn" id="campUse7" style="font-size:11px">Use 7d</button>
            <button class="btn" id="campUse15" style="font-size:11px">Use 15d</button>
            <button class="btn" id="campUse30" style="font-size:11px">Use 30d</button>
          </div>
        </div>

        <div class="form-grid" style="margin-top:12px">
          <div><label class="form-label">Rate (STn/day)</label><input class="form-input text-mono" type="number" step="0.1" id="campRate" value="0"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-primary" id="campApply">Apply Block</button>
            <button class="btn" id="campClearRange">Clear Range</button>
          </div>
          <div style="font-size:11px;color:var(--ok);min-height:16px" id="campMsg"></div>
        </div>
      </div>

      <div>
        <div style="font-weight:600;margin-bottom:12px">Saved Campaign Rows (recent 60)</div>
        <div class="table-scroll" style="max-height:500px;border-radius:8px;overflow:hidden;border:1px solid var(--border)">
          <table class="data-table">
            <thead><tr><th>Date</th><th>Equipment</th><th>Status</th><th>Product</th><th>Rate</th></tr></thead>
            <tbody>${s.dataset.campaigns.filter(c=>c.facilityId===state.ui.selectedFacilityId).sort((a,b)=>(a.date+a.equipmentId).localeCompare(b.date+b.equipmentId)).slice(-60).map(c=>`<tr>
              <td class="text-mono" style="font-size:11px">${c.date}</td>
              <td>${esc(s.getEquipment(c.equipmentId)?.name||c.equipmentId)}</td>
              <td><span class="pill ${c.status==='produce'?'pill-green':c.status==='maintenance'?'pill-amber':'pill-gray'}" style="font-size:10px">${esc(c.status||'produce')}</span></td>
              <td>${esc(s.getMaterial(c.productId)?.code||s.getMaterial(c.productId)?.name||'')}</td>
              <td class="num">${fmt(c.rateStn||0)}</td>
            </tr>`).join('')||'<tr><td colspan="5" class="text-muted" style="text-align:center;padding:20px">No campaigns yet</td></tr>'}
            </tbody>
          </table>
        </div>
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

  q('campEq').onchange=refreshProducts; q('campStatus').onchange=refreshProducts;
  q('campProduct').onchange=()=>{ const eqId=q('campEq').value; const cap=s.getCapsForEquipment(eqId).find(c=>c.productId===q('campProduct').value); if(cap&&isFinite(+cap.maxRateStpd)) q('campRate').value=String(+cap.maxRateStpd||0); renderHelpers(); };
  q('campStart').onchange=renderHelpers;
  q('campRate').oninput=()=>q('campRateEcho').textContent=`${fmt(+q('campRate').value||0)} STn/d`;
  q('campUseCap').onclick=()=>writeRate(rateCache.cap); q('campUse7').onclick=()=>writeRate(rateCache.r7); q('campUse15').onclick=()=>writeRate(rateCache.r15); q('campUse30').onclick=()=>writeRate(rateCache.r30);
  refreshProducts();
  q('campClose').onclick=()=>host.classList.remove('open');
  host.onclick=e=>{ if(e.target===host) host.classList.remove('open'); };
  q('campApply').onclick=e=>{ e.preventDefault(); const payload={equipmentId:q('campEq').value,status:q('campStatus').value,productId:q('campProduct').value,startDate:q('campStart').value,endDate:q('campEnd').value,rateStn:+q('campRate').value||0}; if(payload.status==='produce'&&!payload.productId){q('campMsg').textContent='Select a product.';return;} a.saveCampaignBlock(payload); persist(); q('campMsg').textContent='✓ Campaign block applied'; renderPlan(); openCampaignDialog(); showToast('Campaign applied ✓'); };
  q('campClearRange').onclick=e=>{ e.preventDefault(); a.deleteCampaignRange({equipmentId:q('campEq').value,startDate:q('campStart').value,endDate:q('campEnd').value}); persist(); q('campMsg').textContent='✓ Range cleared'; renderPlan(); openCampaignDialog(); };
}

/* ─────────────────── DAILY ACTUALS DIALOG ─────────────────── */
function openDailyActualsDialog(){
  const s = selectors(state); const a = actions(state);
  const host = el('dailyActualsDialog');
  const y = yesterdayLocal();
  const kf = s.equipment.filter(e=>e.type==='kiln');
  const ff = s.equipment.filter(e=>e.type==='finish_mill');
  const rf = s.equipment.filter(e=>e.type==='raw_mill');
  const canEqProd = (eqId,pid) => s.capabilities.some(c=>c.equipmentId===eqId&&c.productId===pid);
  const existing = s.actualsForDate(y);
  const invMap = new Map(existing.inv.map(r=>[`${r.storageId}|${r.productId}`,r.qtyStn]));
  const prodMap = new Map(existing.prod.map(r=>[`${r.equipmentId}|${r.productId}`,r.qtyStn]));
  const shipMap = new Map(existing.ship.map(r=>[r.productId,r.qtyStn]));

  host.classList.add('open');
  host.innerHTML = `<div class="modal" style="max-width:960px">
    <div class="modal-header">
      <div><div class="modal-title">📝 Daily Actuals Entry</div><div style="font-size:11px;color:var(--muted)">${state.ui.mode.toUpperCase()} · Facility: ${esc(s.facility?.id||'')}</div></div>
      <button class="btn" id="actClose">Close</button>
    </div>
    <div class="modal-body">
      <div class="form-grid" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:16px">
        <div><label class="form-label">Date (default: yesterday)</label><input class="form-input" type="date" id="actualsDate" value="${y}"></div>
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">1. Ending Inventory (STn)</div>
      <div class="table-scroll" style="margin-bottom:20px;max-height:200px;border-radius:8px;overflow:hidden;border:1px solid var(--border)">
        <table class="data-table"><thead><tr><th>Storage</th><th>Product</th><th>EOD Quantity (STn)</th></tr></thead>
        <tbody>${s.storages.map(st=>{const pid=(st.allowedProductIds||[])[0]||'';return`<tr><td style="font-weight:600">${esc(st.name)}</td><td>${esc(s.getMaterial(pid)?.name||'')}</td><td><input class="cell-input inv-input" data-storage="${st.id}" data-product="${pid}" value="${invMap.get(`${st.id}|${pid}`)??''}"></td></tr>`;}).join('')}</tbody>
        </table>
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">2. Production Actuals (STn)</div>
      <div class="table-scroll" style="margin-bottom:20px;max-height:260px;border-radius:8px;overflow:hidden;border:1px solid var(--border)">
        <table class="data-table">
          <thead><tr><th style="min-width:140px">Equipment</th>${s.materials.map(m=>`<th style="min-width:80px">${esc(m.code||m.name.slice(0,8))}</th>`).join('')}</tr></thead>
          <tbody>${[...rf,...kf,...ff].map(eq=>`<tr>
            <td style="font-weight:600">${esc(eq.name)} <span class="pill pill-gray" style="font-size:9px">${eq.type}</span></td>
            ${s.materials.map(m=>canEqProd(eq.id,m.id)?`<td><input class="cell-input prod-input" data-equipment="${eq.id}" data-product="${m.id}" value="${prodMap.get(`${eq.id}|${m.id}`)??''}"></td>`:`<td class="cell-gray">—</td>`).join('')}
          </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:8px">3. Customer Shipments (STn)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px">
        ${s.finishedProducts.map(fp=>`<div style="display:flex;align-items:center;justify-content:space-between;border:1px solid var(--border);border-radius:6px;padding:8px 12px">
          <span style="font-size:12px;font-weight:500">${esc(fp.name)}</span>
          <input class="cell-input ship-input" style="max-width:100px" data-product="${fp.id}" value="${shipMap.get(fp.id)??''}">
        </div>`).join('')||'<div class="text-muted" style="font-size:12px">No finished products defined.</div>'}
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="actClose2">Cancel</button>
      <button class="btn btn-primary" id="saveActualsBtn">Save to ${state.ui.mode==='sandbox'?'Sandbox':'Official'}</button>
    </div>
  </div>`;

  const close = () => host.classList.remove('open');
  host.querySelector('#actClose').onclick = close;
  host.querySelector('#actClose2').onclick = close;
  host.onclick = e => { if(e.target===host) close(); };
  host.querySelector('#saveActualsBtn').onclick = e => {
    e.preventDefault();
    const date = host.querySelector('#actualsDate').value;
    const inventoryRows=[...host.querySelectorAll('.inv-input')].map(i=>({storageId:i.dataset.storage,productId:i.dataset.product,qtyStn:+i.value||0})).filter(r=>r.productId);
    const productionRows=[...host.querySelectorAll('.prod-input')].map(i=>({equipmentId:i.dataset.equipment,productId:i.dataset.product,qtyStn:+i.value||0}));
    const shipmentRows=[...host.querySelectorAll('.ship-input')].map(i=>({productId:i.dataset.product,qtyStn:+i.value||0}));
    a.saveDailyActuals({date,inventoryRows,productionRows,shipmentRows});
    persist(); close(); renderDemand(); renderPlan(); showToast('Daily actuals saved ✓');
  };
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

// Boot
render();
