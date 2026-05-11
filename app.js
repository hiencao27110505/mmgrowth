/**
 * Roadmap Webapp — main app
 * State, fetch, render, view switching, filters, backlog submission.
 */

// ─── CONFIG (fill these in after deploying Apps Script + creating OAuth client) ───
const CONFIG = {
  API_URL:         'https://script.google.com/a/macros/mservice.com.vn/s/AKfycbwb_XBq77jVbB4QabiAFGc1LYI6TPOsI5YgHWc3YS38pWyG40ANBNzT1WnIb269kMZNYA/exec',
  OAUTH_CLIENT_ID: '967363967778-r12l4gsb7139jsljvpqg3jffigkqr3ls.apps.googleusercontent.com',
  // Set to true to render mock data without a backend (local UI preview only).
  USE_MOCK: new URLSearchParams(location.search).get('mock') === '1'
};

// ─── State ──────────────────────────────────────────────────────────────
const STATE = {
  rows: [],
  backlogRows: [],
  objectives: [],
  view: 'timeline',
  fetchedAt: 0,
  filters: { objective: '', owner: '', status: '', tech: '', quality: '' }, // Timeline filters; '' = no filter
  synthesis: {
    stakeholder: { text: '', generatedAt: 0 },
    operational: { text: '', generatedAt: 0 }
  },
  activeMode: 'stakeholder'
};

const CACHE_KEY    = 'roadmap_data_v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const SYNTH_CACHE_KEY    = 'roadmap_synthesis_v1';
const SYNTH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour client-side

// Only these emails can see/use the AI Insights tab. Server-side enforced too.
const INSIGHTS_ALLOWED = ['hien.cao1@mservice.com.vn'];

// Only these emails can edit cards inline (action=update). Server-side enforced too.
const EDITORS_ALLOWED = [
  'hien.cao1@mservice.com.vn',
  'trang.nguyen38@mservice.com.vn',
  'khanh.ho@mservice.com.vn',
  'hao.tang1@mservice.com.vn',
  'phuong.nguyen51@mservice.com.vn',
  'toan.tran1@mservice.com.vn'
];

// ─── Boot ───────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  loadCachedSynthesis();

  if (CONFIG.USE_MOCK) {
    showApp('mock@local');
    loadMockData();
  } else {
    AUTH.init({
      clientId: CONFIG.OAUTH_CLIENT_ID,
      onSignIn: (email) => {
        showApp(email);
        fetchData();
      },
      onError: (msg) => showGateError(msg)
    });
  }

  bindUI();
});

function showApp(email) {
  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;
  document.getElementById('viewerChip').textContent = email;
  document.getElementById('submitterEmail').textContent = email;

  // Hide AI Insights tab for non-allowlisted users. Backend also enforces this.
  const insightsAllowed = INSIGHTS_ALLOWED.map(s => s.toLowerCase()).includes((email || '').toLowerCase());
  const insightsTab = document.querySelector('[data-view="insights"]');
  if (insightsTab) insightsTab.hidden = !insightsAllowed;
  // If the user is somehow on the insights view but not allowed, fall back to timeline
  if (!insightsAllowed && STATE.view === 'insights') switchView('timeline');
}

function showGateError(msg) {
  const el = document.getElementById('gateError');
  el.textContent = msg;
  el.hidden = false;
}

// ─── UI bindings ────────────────────────────────────────────────────────
function bindUI() {
  // View tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchView(t.dataset.view));
  });

  // Refresh — bypass cache
  document.getElementById('refreshBtn').addEventListener('click', () => fetchData(true));

  // Keep "Updated Xm ago" indicator current
  setInterval(updateLastUpdated, 60 * 1000);

  // Insights — mode toggle
  document.querySelectorAll('.mode-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      STATE.activeMode = pill.dataset.mode;
      document.querySelectorAll('.mode-pill').forEach(p =>
        p.classList.toggle('is-active', p.dataset.mode === STATE.activeMode));
      renderInsights();
    });
  });

  // Insights — generate / re-generate
  document.getElementById('generateBtn').addEventListener('click', () => {
    const force = !!STATE.synthesis[STATE.activeMode].text; // re-gen if already have one
    generateSynthesis(STATE.activeMode, force);
  });


  // Sign out
  document.getElementById('signOutBtn').addEventListener('click', () => AUTH.signOut());

  // Header "Submit an idea" → open the submit modal in CREATE mode.
  // Wrapped so the click event isn't passed in as `row`.
  document.getElementById('submitBtn').addEventListener('click', () => openSubmitModal());

  // Submit modal close (delegated, same pattern as detail modal)
  const submitModalEl = document.getElementById('submitModal');
  if (submitModalEl) {
    submitModalEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-submit-close]')) {
        e.preventDefault();
        closeSubmitModal();
      }
    });
  }

  // Form submit
  document.getElementById('submitForm').addEventListener('submit', handleSubmit);

  // Live writing-rules checklist for What/Why/How
  ['fWhat', 'fWhy', 'fHow'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderChecklists);
  });

  // Clear stale error highlight on the Objective field (no rules list)
  const objEl = document.getElementById('fObjective');
  if (objEl) {
    objEl.addEventListener('input', () => {
      objEl.classList.remove('has-error');
      const errEl = document.getElementById('formError');
      if (errEl) errEl.hidden = true;
    });
  }

  // Rules-toggle buttons — collapse/expand the per-field writing-rules list
  document.querySelectorAll('.idea-rules-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.rulesFor;
      const cap = field.charAt(0).toUpperCase() + field.slice(1);
      const list = document.getElementById('check' + cap);
      if (!list) return;
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      list.hidden = open;
    });
  });

  // Copy-as-prototype-prompt buttons — submit modal copies live form values,
  // detail modal copies the read-only row.
  const submitCopyBtn = document.getElementById('submitCopyBtn');
  if (submitCopyBtn) submitCopyBtn.addEventListener('click', copyIdeaFromForm);
  const detailCopyBtn = document.getElementById('detailCopyBtn');
  if (detailCopyBtn) detailCopyBtn.addEventListener('click', copyIdeaFromCurrentDetail);

  // (Timeline filter listeners attached inside populateTimelineFilters —
  // they need to survive each rebuild of the <select> options.)

  // Detail modal close — delegated, so the listener is robust against
  // re-renders and works for any element under the modal carrying the
  // [data-detail-close] hook (backdrop, X button, future cancel links).
  const detailModalEl = document.getElementById('detailModal');
  if (detailModalEl) {
    detailModalEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-detail-close]')) {
        e.preventDefault();
        closeDetailModal();
      }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Close whichever modal is currently open. Detail modal takes precedence
    // if (somehow) both are visible.
    if (!document.getElementById('detailModal').hidden) closeDetailModal();
    else if (!document.getElementById('submitModal').hidden) closeSubmitModal();
  });
}

// ─── Fetch ──────────────────────────────────────────────────────────────
// All calls use JSONP because Apps Script's /exec returns a 302 redirect
// that strips CORS headers and breaks plain fetch().
async function fetchData(forceRefresh = false) {
  // Try cache first unless explicitly bypassed (refresh button / post-submit).
  if (!forceRefresh) {
    const cached = readCachedData();
    if (cached) {
      STATE.rows        = cached.rows;
      STATE.backlogRows = cached.backlogRows;
      STATE.objectives  = cached.objectives;
      STATE.fetchedAt   = cached.fetchedAt;
      populateObjectiveDatalist();
      renderAll();
      updateLastUpdated();
      return;
    }
  }

  showLoader(true);
  try {
    const data = await jsonpCall({
      action: 'read',
      token: AUTH.getToken(),
      ...(forceRefresh ? { fresh: '1' } : {})
    });
    if (!data.ok) throw new Error(data.error || 'Failed to load');
    // Normalize header keys: actual sheet headers may be multi-line (e.g.
    // "Objective\nJTBDs"); collapse to the first line so r.Objective works.
    STATE.rows        = (data.rows || []).map(normalizeRow);
    STATE.backlogRows = (data.backlogRows || []).map(normalizeRow);
    STATE.objectives = Array.from(new Set(
      STATE.rows.map(r => (r.Objective || '').trim()).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
    STATE.fetchedAt = Date.now();
    writeCachedData();
    populateObjectiveDatalist();
    renderAll();
    updateLastUpdated();
  } catch (err) {
    // If the cached token was rejected (expired, revoked, allowlist changed),
    // wipe it and reload so GIS sign-in fires again.
    if (/token|allowed|missing|invalid|audience|verified/i.test(err.message)) {
      AUTH.clearCachedToken();
      toast('Session expired. Reloading…', false);
      setTimeout(() => location.reload(), 1200);
    } else {
      toast('Could not load data: ' + err.message, true);
    }
  } finally {
    showLoader(false);
  }
}

function readCachedData() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.fetchedAt < CACHE_TTL_MS && Array.isArray(obj.rows)) {
      return obj;
    }
  } catch (_) { /* corrupt — fall through */ }
  localStorage.removeItem(CACHE_KEY);
  return null;
}

function writeCachedData() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      fetchedAt: STATE.fetchedAt,
      rows: STATE.rows,
      backlogRows: STATE.backlogRows,
      objectives: STATE.objectives
    }));
  } catch (_) { /* quota exceeded — ignore, just won't cache */ }
}

function updateLastUpdated() {
  const el = document.getElementById('lastUpdated');
  if (!el || !STATE.fetchedAt) return;
  el.textContent = 'Updated ' + relativeTime(STATE.fetchedAt);
  el.title = new Date(STATE.fetchedAt).toLocaleString();
}

function relativeTime(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' hr ago';
  return Math.floor(hr / 24) + ' d ago';
}

// Wrapper around jsonpCall that automatically refreshes an expired Google
// ID token and retries once. Use for write paths so editors don't get the
// raw "invalid token" error after sitting idle past the 1-hour JWT expiry.
async function jsonpCallWithReauth(params) {
  const first = await jsonpCall(params);
  if (first && first.ok) return first;
  const err = String((first && first.error) || '');
  const looksAuth = /invalid token|missing token|bad audience|email not verified/i.test(err);
  if (!looksAuth) return first;
  toast('Session expired — refreshing…');
  let newToken;
  try { newToken = await AUTH.refreshToken(); }
  catch (_) {
    toast('Could not refresh session. Please sign in again.', true);
    AUTH.signOut();
    return first;
  }
  return jsonpCall({ ...params, token: newToken });
}

function jsonpCall(params) {
  return new Promise((resolve, reject) => {
    const cbName = '__jsonp_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('request timeout')); }, 30000);

    function cleanup() {
      clearTimeout(timer);
      try { delete window[cbName]; } catch (_) { window[cbName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[cbName] = (data) => { cleanup(); resolve(data); };

    const qs = Object.entries({ ...params, callback: cbName })
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
      .join('&');
    script.src = CONFIG.API_URL + '?' + qs;
    script.onerror = () => { cleanup(); reject(new Error('network or auth error')); };
    document.head.appendChild(script);
  });
}

function loadMockData() {
  STATE.objectives = [
    'Improve eKYC retry UX',
    'Reduce account drop-off',
    'Family wallet adoption'
  ];
  STATE.rows = [
    { '#': '1', Objective: 'Improve eKYC retry UX', What: 'Smart retry hints',
      Why: 'Users abandon after 1 failed scan', How: 'Inline error guidance + retry CTA',
      'User Flow': '', Prototype: 'https://example.com/p1', When: '2026 Q2',
      Status: 'In progress', Who: 'Hân', 'Related Docs': '' },
    { '#': '2', Objective: 'Improve eKYC retry UX', What: 'NFC fallback path',
      Why: 'Camera-only scan fails on dim devices', How: 'Detect NFC-capable device, suggest NFC',
      'User Flow': '', Prototype: '', When: '2026 Q3',
      Status: 'Discovery', Who: 'Kiều', 'Related Docs': '' },
    { '#': '3', Objective: 'Reduce account drop-off', What: 'SIM-recycling detection',
      Why: 'Recycled SIMs cause account collisions', How: 'Cross-check SIM age against signup date',
      'User Flow': '', Prototype: '', When: '2026 Q2',
      Status: 'Shipped', Who: 'Linh', 'Related Docs': '' },
    { '#': '4', Objective: 'Family wallet adoption', What: 'Onboarding for sub-accounts',
      Why: 'Parents struggle to add kids', How: 'Dedicated family setup wizard',
      'User Flow': '', Prototype: '', When: '2026 Q4',
      Status: 'Discovery', Who: 'Hân', 'Related Docs': '' }
  ];
  populateObjectiveDatalist();
  renderAll();
}

// ─── Render orchestration ──────────────────────────────────────────────
function renderAll() {
  renderMetrics();
  populateTimelineFilters();
  renderRoadmapGlance();
  renderTimeline();
  renderBacklog();
  renderInsights();
}

// A row belongs in the Backlog tab when it has no scheduled month, OR when
// its Status is "Backlog" (regardless of whether a month is set). Used by
// both the Timeline (to exclude these) and the Backlog tab (to include them).
function isBacklogRow(r) {
  if (monthKey(r.When) === 'unscheduled') return true;
  if (/^backlog$/i.test(String(r.Status || '').trim())) return true;
  return false;
}

function switchView(view) {
  STATE.view = view;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('is-active', t.dataset.view === view);
  });
  document.getElementById('view-timeline').hidden  = view !== 'timeline';
  document.getElementById('view-backlog').hidden   = view !== 'backlog';
  document.getElementById('view-insights').hidden  = view !== 'insights';
}

// ─── Metrics row ────────────────────────────────────────────────────────
function renderMetrics() {
  const total = STATE.rows.length;
  const inProgress = STATE.rows.filter(r => /progress|doing|wip|building|develop/i.test(r.Status || '')).length;
  const shipped    = STATE.rows.filter(r => /ship|done|launch|complete|live/i.test(r.Status || '')).length;
  const teams = new Set(STATE.rows.map(r => (r.Who || '').trim()).filter(Boolean)).size;

  const cards = [
    { label: 'Total initiatives', value: total, detail: `${STATE.objectives.length} strategic objectives` },
    { label: 'In progress', value: inProgress, detail: 'currently being built' },
    { label: 'Shipped', value: shipped, detail: 'launched / completed' },
    { label: 'Owners involved', value: teams, detail: 'distinct people' }
  ];
  document.getElementById('metrics').innerHTML = cards.map(c => `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(c.label)}</div>
      <div class="metric-value">${c.value}</div>
      <div class="metric-detail">${escapeHtml(c.detail)}</div>
    </div>
  `).join('');
}

// ─── Timeline filters (Owner / Status / Card quality) ─────────────────
// "Card quality" buckets initiatives by completeness of KEY_FIELDS:
//   complete = no missing fields, gaps = at least one missing.
function applyTimelineFilters(rows) {
  const f = STATE.filters;
  return rows.filter(r => {
    if (f.objective && (r.Objective || '').trim() !== f.objective) return false;
    if (f.owner  && (r.Who    || '').trim() !== f.owner)  return false;
    if (f.status && (r.Status || '').trim() !== f.status) return false;
    if (f.tech) {
      const teams = String(r.Tech || r['Tech Team'] || '').split(/\s*,\s*/).filter(Boolean);
      if (!teams.includes(f.tech)) return false;
    }
    if (f.quality === 'complete' && missingFields(r).length > 0)  return false;
    if (f.quality === 'gaps'     && missingFields(r).length === 0) return false;
    return true;
  });
}

function onFilterChange(key, value) {
  STATE.filters[key] = value;
  updateClearFiltersBtn();
  renderRoadmapGlance();
  renderTimeline();
}

function populateTimelineFilters() {
  const owners = Array.from(new Set(
    STATE.rows.map(r => (r.Who || '').trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
  const statuses = Array.from(new Set(
    STATE.rows.map(r => (r.Status || '').trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const objectiveSel = document.getElementById('filterObjective');
  const ownerSel  = document.getElementById('filterOwner');
  const statusSel = document.getElementById('filterStatus');
  const techSel   = document.getElementById('filterTech');
  const qSel      = document.getElementById('filterQuality');
  if (objectiveSel) {
    const cur = STATE.filters.objective;
    objectiveSel.innerHTML = '<option value="">Objective</option>' +
      STATE.objectives.map(o => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join('');
    if (STATE.objectives.includes(cur)) objectiveSel.value = cur;
    else { objectiveSel.value = ''; STATE.filters.objective = ''; }
    objectiveSel.onchange = (e) => onFilterChange('objective', e.target.value);
  }
  if (ownerSel) {
    const cur = STATE.filters.owner;
    ownerSel.innerHTML = '<option value="">Owner</option>' +
      owners.map(o => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join('');
    // Keep selection if the current owner still exists, otherwise reset.
    if (owners.includes(cur)) ownerSel.value = cur;
    else { ownerSel.value = ''; STATE.filters.owner = ''; }
    // Direct property assignment — replaces any prior handler, immune to
    // delegation/timing issues from the previous bindUI approach.
    ownerSel.onchange = (e) => onFilterChange('owner', e.target.value);
  }
  if (statusSel) {
    const cur = STATE.filters.status;
    statusSel.innerHTML = '<option value="">Status</option>' +
      statuses.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
    if (statuses.includes(cur)) statusSel.value = cur;
    else { statusSel.value = ''; STATE.filters.status = ''; }
    statusSel.onchange = (e) => onFilterChange('status', e.target.value);
  }
  if (techSel) {
    // Tech values are comma-separated per row — split + dedupe across all rows.
    const techSet = new Set();
    STATE.rows.forEach(r => {
      String(r.Tech || r['Tech Team'] || '')
        .split(/\s*,\s*/).filter(Boolean)
        .forEach(t => techSet.add(t));
    });
    const techs = Array.from(techSet).sort((a, b) => a.localeCompare(b));
    const cur = STATE.filters.tech;
    techSel.innerHTML = '<option value="">Tech</option>' +
      techs.map(t => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('');
    if (techs.includes(cur)) techSel.value = cur;
    else { techSel.value = ''; STATE.filters.tech = ''; }
    techSel.onchange = (e) => onFilterChange('tech', e.target.value);
  }
  if (qSel) {
    qSel.value = STATE.filters.quality;
    qSel.onchange = (e) => onFilterChange('quality', e.target.value);
  }
  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) clearBtn.onclick = () => {
    STATE.filters = { objective: '', owner: '', status: '', tech: '', quality: '' };
    if (objectiveSel) objectiveSel.value = '';
    if (ownerSel)     ownerSel.value     = '';
    if (statusSel)    statusSel.value    = '';
    if (techSel)      techSel.value      = '';
    if (qSel)         qSel.value         = '';
    updateClearFiltersBtn();
    renderTimeline();
  };
  updateClearFiltersBtn();
}

function updateClearFiltersBtn() {
  const f = STATE.filters;
  const hasAny = !!(f.objective || f.owner || f.status || f.tech || f.quality);
  const btn = document.getElementById('clearFiltersBtn');
  if (btn) btn.hidden = !hasAny;
}

// ─── Roadmap at a glance (compact Objective × Month grid) ──────────────
// Birds-eye view above the timeline: one row per Objective, one column per
// month found in the data, each cell holds tiny clickable chips colored by
// status. Respects active timeline filters so the glance and the cards below
// always tell the same story.
function renderRoadmapGlance() {
  const host = document.getElementById('roadmapGlance');
  if (!host) return;

  // Glance reflects scheduled, non-backlog work only — backlog has its own tab.
  const scheduled = STATE.rows.filter(r => !isBacklogRow(r));

  // Fixed 3-column window — previous, current, next month — same as the
  // timeline columns below so the eye can map the two views 1:1.
  const today = new Date();
  const windowMonths = [-1, 0, 1].map(offset => {
    const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  const monthKeys = windowMonths.map(m => `${m.year}-${String(m.month).padStart(2, '0')}`);
  const monthSet = {};
  windowMonths.forEach((m, i) => {
    const synthetic = `${MONTH_NAMES_SHORT[m.month - 1]} ${m.year}`;
    const lab = monthLabel(synthetic);
    monthSet[monthKeys[i]] = (lab && typeof lab === 'object') ? (lab.text || '') : String(lab || '');
  });

  const inWindow = (r) => monthKeys.indexOf(monthKey(r.When)) !== -1;
  const rows = applyTimelineFilters(scheduled).filter(inWindow);
  if (rows.length === 0) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;

  // Group filtered rows by Objective → Month
  const NO_OBJ = '(no objective)';
  const objMap = new Map(); // objective → { monthKey → [rows] }
  rows.forEach(r => {
    const mk = monthKey(r.When);
    if (mk === 'unscheduled') return; // glance shows scheduled work only
    const obj = (r.Objective || '').trim() || NO_OBJ;
    if (!objMap.has(obj)) objMap.set(obj, {});
    const buckets = objMap.get(obj);
    if (!buckets[mk]) buckets[mk] = [];
    buckets[mk].push(r);
  });

  // If every row is unscheduled, hide the glance entirely
  if (monthKeys.length === 0 || objMap.size === 0) {
    host.hidden = true; host.innerHTML = '';
    return;
  }

  // Stable objective ordering: existing STATE.objectives order, then "(no objective)" last
  const objectives = [
    ...STATE.objectives.filter(o => objMap.has(o)),
    ...(objMap.has(NO_OBJ) ? [NO_OBJ] : [])
  ];

  const headerCells = monthKeys.map(k => {
    const label = monthSet[k];
    return `<div class="rg-th" title="${escapeAttr(label)}">${escapeHtml(label)}</div>`;
  }).join('');

  const bodyRows = objectives.map(obj => {
    const buckets = objMap.get(obj) || {};
    const cells = monthKeys.map(k => {
      const list = buckets[k] || [];
      const chips = list.map(r => {
        const cls = statusClass(r.Status);
        const title = `${r.What || '(no title)'}${r.Status ? ' · ' + r.Status : ''}${r.Who ? ' · ' + r.Who : ''}`;
        return `<button type="button" class="rg-chip ${cls}"
          data-row-key="${escapeAttr(r['#'] || '')}"
          title="${escapeAttr(title)}">${escapeHtml(r.What || '(no title)')}</button>`;
      }).join('');
      return `<div class="rg-td">${chips}</div>`;
    }).join('');
    return `
      <div class="rg-row">
        <div class="rg-rowhead" title="${escapeAttr(obj)}">${escapeHtml(obj)}</div>
        <div class="rg-cells" style="grid-template-columns: repeat(${monthKeys.length}, minmax(0, 1fr));">${cells}</div>
      </div>
    `;
  }).join('');

  host.innerHTML = `
    <div class="rg-head">
      <h3 class="rg-title">Roadmap at a glance</h3>
      <span class="rg-meta">${objectives.length} objective${objectives.length === 1 ? '' : 's'} · ${monthKeys.length} month${monthKeys.length === 1 ? '' : 's'}</span>
    </div>
    <div class="rg-grid">
      <div class="rg-headrow">
        <div class="rg-rowhead rg-rowhead-empty"></div>
        <div class="rg-cells" style="grid-template-columns: repeat(${monthKeys.length}, minmax(0, 1fr));">${headerCells}</div>
      </div>
      ${bodyRows}
    </div>
  `;

  // Clicking a chip opens the same detail modal as a Timeline card
  host.querySelectorAll('.rg-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const rowKey = btn.dataset.rowKey;
      const row = STATE.rows.find(r => String(r['#']) === String(rowKey));
      if (row) openDetailModal(row);
    });
  });
}

// Shared 3-bucket window used by both Timeline and Backlog tabs:
//   [previous month] [current month] [next month + everything later]
// Returns column descriptors + a function that maps a row's When to a
// bucket key. Rows before the previous month are dropped; "unscheduled"
// is returned as its own bucket so the Backlog tab can keep its column.
function timelineWindow() {
  const today = new Date();
  const prevD = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const curD  = new Date(today.getFullYear(), today.getMonth(),     1);
  const nextD = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const k = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const prevKey = k(prevD), curKey = k(curD), futureKey = k(nextD);
  const columns = [
    { key: prevKey,   synthetic: `${MONTH_NAMES_SHORT[prevD.getMonth()]} ${prevD.getFullYear()}`, isFuture: false },
    { key: curKey,    synthetic: `${MONTH_NAMES_SHORT[curD.getMonth()]} ${curD.getFullYear()}`,   isFuture: false },
    { key: futureKey, synthetic: `${MONTH_NAMES_SHORT[nextD.getMonth()]} ${nextD.getFullYear()}`, isFuture: true  }
  ];
  function bucketFor(whenStr) {
    const m = monthKey(whenStr);
    if (m === 'unscheduled') return 'unscheduled';
    if (m === prevKey) return prevKey;
    if (m === curKey)  return curKey;
    if (m >= futureKey) return futureKey;
    return null; // before window — drop
  }
  return { columns, bucketFor, prevKey, curKey, futureKey };
}

// ─── Timeline (grouped by Month) ───────────────────────────────────────
// Column STRUCTURE is built from STATE.rows (unfiltered) so the columns stay
// stable across filter changes — only the cards inside change. Columns with
// no matching cards show a small "No matches" placeholder instead of vanishing.
//
// Submitted ideas now live in the same What&Why tab with Status='Backlog'
// (no separate Backlog sheet read), so they appear in the "No timeline yet"
// column naturally — no special-case merging needed.
function renderTimeline() {
  // Backlog rows live in their own tab — exclude from Timeline entirely.
  const timelineRows = STATE.rows.filter(r => !isBacklogRow(r));

  // Fixed 3-bucket window: previous · current · next + everything later.
  const win = timelineWindow();
  const inWindow = (r) => {
    const b = win.bucketFor(r.When);
    return b && b !== 'unscheduled';
  };

  const windowRows = timelineRows.filter(inWindow);
  const filtered = applyTimelineFilters(windowRows);

  // Always render all 3 columns, even if empty, so the structure is stable.
  const groups = {};
  win.columns.forEach(col => {
    groups[col.key] = { label: monthLabel(col.synthetic), isFuture: col.isFuture, allRows: [], rows: [] };
  });
  windowRows.forEach(r => {
    const b = win.bucketFor(r.When);
    if (groups[b]) groups[b].allRows.push(r);
  });
  filtered.forEach(r => {
    const b = win.bucketFor(r.When);
    if (groups[b]) groups[b].rows.push(r);
  });

  // Filter-count chip: how many cards survived the filter (only when active)
  const f = STATE.filters;
  const hasAny = !!(f.objective || f.owner || f.status || f.tech || f.quality);
  const countEl = document.getElementById('filterCount');
  if (countEl) {
    countEl.hidden = !hasAny;
    countEl.textContent = `${filtered.length} of ${windowRows.length}`;
  }

  // Fixed prev → current → future order
  const sortedKeys = win.columns.map(c => c.key);

  document.getElementById('timelineColumns').innerHTML = sortedKeys.map(key => {
    const g = groups[key];
    const cls = [
      g.label.isNow  ? 'is-now'  : '',
      g.label.isPast ? 'is-past' : '',
      // Dim columns that lost all their cards to the filter, so the eye
      // skips past them instead of treating them as empty source data
      hasAny && g.rows.length === 0 ? 'is-filtered-out' : ''
    ].filter(Boolean).join(' ');
    const suffix = g.label.isNow ? ' · Now' : (g.isFuture ? ' & beyond' : '');
    // Count badge: when a filter is active, show "visible/total" so users
    // can see how many cards are hidden in each month at a glance.
    const countText = hasAny
      ? `${g.rows.length}/${g.allRows.length}`
      : `${g.allRows.length}`;
    const placeholder = hasAny
      ? '<div class="empty-state" style="padding:20px 0;font-size:12px">No matches</div>'
      : '<div class="empty-state" style="padding:20px 0;font-size:12px">No initiatives.</div>';
    return `
      <div class="timeline-col ${cls}">
        <div class="timeline-col-head">
          <span class="timeline-col-label">${escapeHtml(g.label.text)}${suffix}</span>
          <span class="timeline-col-count">${countText}</span>
        </div>
        ${g.rows.length ? g.rows.map(initCardHTML).join('') : placeholder}
      </div>
    `;
  }).join('');

  bindCardClicks(document.getElementById('timelineColumns'));
}

// ─── Backlog tab ────────────────────────────────────────────────────────
// Holds initiatives without a defined timeline AND/OR with Status=Backlog.
// Triaging = giving them a When (or changing Status off "Backlog") via the
// edit form, which moves them onto the Timeline.
function renderBacklog() {
  const backlogRows = STATE.rows.filter(isBacklogRow);

  const tabCount = document.getElementById('backlogTabCount');
  if (tabCount) {
    tabCount.hidden = backlogRows.length === 0;
    tabCount.textContent = String(backlogRows.length);
  }

  const grid = document.getElementById('backlogGrid');
  if (!grid) return;
  if (backlogRows.length === 0) {
    grid.innerHTML = '<div class="empty-state" style="padding:32px 0">Backlog is empty — every initiative has a timeline and a non-backlog status.</div>';
    return;
  }

  // Mirror the Timeline's column layout: prev · current · next & beyond,
  // plus an "unscheduled" column for backlog rows with no defined When.
  const win = timelineWindow();
  const groups = {};
  win.columns.forEach(col => {
    groups[col.key] = { label: monthLabel(col.synthetic), isFuture: col.isFuture, rows: [] };
  });
  // Unscheduled bucket — built lazily so the column only appears when needed
  let unscheduled = null;
  backlogRows.forEach(r => {
    const b = win.bucketFor(r.When);
    if (b === 'unscheduled') {
      if (!unscheduled) unscheduled = { label: { text: 'No timeline yet', isNow: false, isPast: false }, isFuture: false, rows: [] };
      unscheduled.rows.push(r);
      return;
    }
    if (!groups[b]) return; // before the window — drop
    groups[b].rows.push(r);
  });

  const sortedCols = win.columns.map(c => groups[c.key]);
  if (unscheduled) sortedCols.push(unscheduled);

  grid.innerHTML = `
    <div class="timeline">
      ${sortedCols.map(g => {
        const cls = [
          g.label.isNow  ? 'is-now'  : '',
          g.label.isPast ? 'is-past' : ''
        ].filter(Boolean).join(' ');
        const suffix = g.label.isNow ? ' · Now' : (g.isFuture ? ' & beyond' : '');
        return `
          <div class="timeline-col ${cls}">
            <div class="timeline-col-head">
              <span class="timeline-col-label">${escapeHtml(g.label.text)}${suffix}</span>
              <span class="timeline-col-count">${g.rows.length}</span>
            </div>
            ${g.rows.map(initCardHTML).join('')}
          </div>
        `;
      }).join('')}
    </div>
  `;

  bindCardClicks(grid);
}

// ─── Month grouping helpers ─────────────────────────────────────────────
function parseWhenToMonth(whenStr) {
  const s = String(whenStr || '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const today = new Date();
  const curY = today.getFullYear();
  const yearMatch = s.match(/(20\d{2})/);
  const y = yearMatch ? parseInt(yearMatch[1], 10) : curY;

  // ISO-like format: "2026-06-01", "2026/06/01 00:00" — what Apps Script emits
  // when Sheets auto-typed the "When" cell as a Date. Must come BEFORE the
  // Q-format check because "Q1" doesn't appear here, but "06" is the month.
  const isoMatch = s.match(/(20\d{2})[-\/](0?[1-9]|1[0-2])(?:[-\/]\d{1,2})?/);
  if (isoMatch) {
    return { year: parseInt(isoMatch[1], 10), month: parseInt(isoMatch[2], 10) };
  }

  // Q-format: "Q2", "Q2 2026", "2026 Q2" → first month of that quarter
  const qMatch = s.match(/Q\s*([1-4])/i);
  if (qMatch) {
    const q = parseInt(qMatch[1], 10);
    return { year: y, month: (q - 1) * 3 + 1 };
  }

  // Month-name pattern: "Jun", "June 2026", "Jul-Aug" (takes the first match)
  const monthMap = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
                     jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const monthMatch = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  if (monthMatch) {
    return { year: y, month: monthMap[monthMatch[1]] };
  }

  return null;
}

function monthKey(whenStr) {
  const p = parseWhenToMonth(whenStr);
  if (!p) return 'unscheduled';
  return p.year + '-' + String(p.month).padStart(2, '0');
}

function monthLabel(whenStr) {
  const p = parseWhenToMonth(whenStr);
  if (!p) return { text: 'No timeline yet', isNow: false, isPast: false };
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
  const today = new Date();
  const curY = today.getFullYear();
  const curM = today.getMonth() + 1;
  const isNow  = p.year === curY && p.month === curM;
  const isPast = p.year < curY || (p.year === curY && p.month < curM);
  return { text: monthNames[p.month - 1] + ' ' + p.year, isNow, isPast };
}

// ─── Card template (Timeline) ──────────────────────────────────────────
// Minimal: objective label · title (2-line clamp) · why preview (3-line clamp)
// · foot row of plain text (status, owner, when) + subtle Prototype link.
// Equal height across all cards. Click → opens detail modal with rich info.
function initCardHTML(r) {
  const protoUrl = firstUrl(r.Prototype);
  const footParts = [];
  if (r.Status) footParts.push(`<span class="card-status ${statusClass(r.Status)}">${escapeHtml(r.Status)}</span>`);
  if (r.Who)    footParts.push(`<span class="card-foot-text">${escapeHtml(r.Who)}</span>`);
  const foot = footParts.join('<span class="card-foot-sep">·</span>');

  return `
    <div class="init-card" data-row='${escapeAttr(JSON.stringify(r))}'>
      ${r.Objective ? `<div class="init-card-objective">${escapeHtml(r.Objective)}</div>` : ''}
      <div class="init-card-title">${escapeHtml(r.What || '(no title)')}</div>
      <div class="init-card-why">${whyPreview(r.Why)}</div>
      <div class="init-card-foot">
        <div class="card-foot-meta">${foot}</div>
        ${protoUrl ? `<a class="card-proto-link" href="${escapeAttr(protoUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Prototype ↗</a>` : ''}
      </div>
    </div>
  `;
}


// ─── Card helpers ───────────────────────────────────────────────────────
function statusPill(status) {
  if (!status) return `<span class="status-pill is-empty">no status</span>`;
  const cls = statusClass(status);
  // Filled variant for live/launched work — draws the eye to in-flight things
  const isLive = /shipped|progress|doing|wip|building|develop|launch|done|complete|live/i.test(status);
  return `<span class="status-pill ${cls}${isLive ? ' is-filled' : ''}">${escapeHtml(status)}</span>`;
}

function ownerChip(who) {
  if (!who) return `<span class="meta-empty">no owner</span>`;
  return `<span class="owner-chip">${escapeHtml(who)}</span>`;
}

function whyPreview(why) {
  const v = String(why || '').trim();
  if (!v) return `<span class="why-empty">— no rationale yet</span>`;
  // Collapse whitespace, truncate cleanly at ~160 chars
  const flat = v.replace(/\s+/g, ' ');
  const max = 160;
  return escapeHtml(flat.length > max ? flat.slice(0, max).replace(/\s+\S*$/, '') + '…' : flat);
}

const KEY_FIELDS = [
  { key: 'Why',         label: 'Why' },
  { key: 'How',         label: 'How' },
  { key: 'When',        label: 'When' },
  { key: 'Who',         label: 'Owner' },
  { key: 'Prototype',   label: 'Prototype' }
];

function missingFields(r) {
  const out = [];
  KEY_FIELDS.forEach(f => {
    const v = String(r[f.key] || '').trim();
    if (!v) out.push(f.label);
  });
  return out;
}

function fieldOrPlaceholder(label, value) {
  if (value && String(value).trim()) {
    return `<h4>${label}</h4><p>${escapeHtml(value)}</p>`;
  }
  return `<h4>${label}</h4><p class="field-empty">— not yet defined</p>`;
}

function linkSectionOrPlaceholder(label, value) {
  if (value && /https?:\/\//.test(String(value))) {
    return `<h4>${label}</h4><div class="detail-links">${linksFromCell(value, label)}</div>`;
  }
  return `<h4>${label}</h4><p class="field-empty">— no link added</p>`;
}

// ─── Submit-an-idea modal (opens from header button OR from a card click
// in editor mode, in which case the form is pre-filled with the row data
// and the submit handler issues an update instead of a create). ───────
let CURRENT_EDIT_ROW = null;

function openSubmitModal(row) {
  // Guard: only treat the argument as a row if it's a plain row-like object
  // (i.e. not a DOM Event from being used directly as an event listener).
  const looksLikeRow = row && typeof row === 'object' && !(row instanceof Event)
    && (('What' in row) || ('Objective' in row) || ('#' in row));
  CURRENT_EDIT_ROW = looksLikeRow ? row : null;
  const modal = document.getElementById('submitModal');
  if (!modal) return;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  populateSubmitWhenDropdown();
  populateOwnerDatalist();
  wireTechPicker();
  resetSubmitForm();

  // Adapt the modal's title and primary button based on mode
  const titleEl = document.getElementById('submitModalTitle');
  const submitBtn = document.getElementById('submitFormBtn');
  if (CURRENT_EDIT_ROW) {
    if (titleEl)   titleEl.textContent   = 'Edit idea';
    if (submitBtn) submitBtn.textContent = 'Save changes';
    prefillSubmitForm(CURRENT_EDIT_ROW);
  } else {
    if (titleEl)   titleEl.textContent   = 'Submit an idea';
    if (submitBtn) submitBtn.textContent = 'Submit idea';
  }

  setTimeout(() => {
    const sel = document.getElementById('fObjective');
    if (sel) sel.focus();
  }, 30);
}

// Pre-fill the idea form from an existing row. Mirrors the field set the
// form supports — Status / Owner / Prototype / Related Docs are not editable
// here (PM updates those directly in the sheet, by design).
function prefillSubmitForm(r) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('fObjective', r.Objective);
  set('fWhat',      r.What);
  set('fWhy',       r.Why);
  set('fHow',       r.How);
  set('fUserFlow',  r['User Flow']);
  set('fPrototype', r.Prototype);
  set('fConfluence', r.Confluence);
  set('fOwner',     r.Who);
  set('fStatus',    (r.Status || 'Backlog'));

  const parsed = parseWhenToMonth(r.When);
  set('fWhen', parsed ? String(parsed.month) : '');

  const teams = String(r.Tech || r['Tech Team'] || '').split(/\s*,\s*/).filter(Boolean);
  document.querySelectorAll('#fTechTeams input[name="techTeam"]').forEach(cb => {
    cb.checked = teams.includes(cb.value);
  });
  if (typeof renderTechPickerValue === 'function') renderTechPickerValue();

  // Refresh the live writing-rules indicators against the prefilled values
  if (typeof renderChecklists === 'function') renderChecklists();
}

// ── Tech-team multi-select picker ──────────────────────────────────────
// A clickable trigger renders selected values as inline chips; clicking it
// opens a dropdown of checkboxes. The underlying checkboxes preserve the
// existing handleSubmit data flow (querySelectorAll on :checked).
let TECH_PICKER_WIRED = false;
function wireTechPicker() {
  if (TECH_PICKER_WIRED) return;
  TECH_PICKER_WIRED = true;

  const root    = document.getElementById('fTechTeams');
  const trigger = document.getElementById('fTechTrigger');
  if (!root || !trigger) return;
  const menu    = root.querySelector('.multi-picker-menu');

  function close() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    root.classList.remove('is-open');
  }
  function open() {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    root.classList.add('is-open');
  }
  trigger.addEventListener('click', () => {
    if (menu.hidden) open(); else close();
  });
  // Close on outside click — bound once, ignores clicks inside the picker.
  document.addEventListener('click', (e) => {
    if (root.contains(e.target)) return;
    close();
  });
  // Re-render the trigger label on every checkbox change.
  root.querySelectorAll('input[name="techTeam"]').forEach(cb => {
    cb.addEventListener('change', renderTechPickerValue);
  });
  // Esc closes when focus is inside the picker.
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

// Render selected checkboxes as small chips inside the trigger. The trigger
// has a fixed height — show the first 2 chips inline and collapse the rest
// into a "+N" indicator so the field never grows with selection length.
function renderTechPickerValue() {
  const root = document.getElementById('fTechTeams');
  if (!root) return;
  const valEl = root.querySelector('.multi-picker-value');
  const checked = Array.from(root.querySelectorAll('input[name="techTeam"]:checked'));
  if (checked.length === 0) {
    valEl.textContent = valEl.dataset.emptyText || 'Pick…';
    valEl.classList.add('is-placeholder');
    return;
  }
  valEl.classList.remove('is-placeholder');
  const VISIBLE = 2;
  const visible = checked.slice(0, VISIBLE);
  const overflow = checked.length - visible.length;
  valEl.innerHTML =
    visible.map(cb => `<span class="multi-picker-chip">${escapeHtml(cb.value)}</span>`).join('') +
    (overflow > 0 ? `<span class="multi-picker-more">+${overflow}</span>` : '');
}

// Populate the Owner combobox suggestions from distinct existing values, so
// editors can pick a teammate fast or type a brand-new name.
function populateOwnerDatalist() {
  const list = document.getElementById('ownerSuggestions');
  if (!list) return;
  const owners = Array.from(new Set(
    STATE.rows.map(r => (r.Who || '').trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
  list.innerHTML = owners
    .map(o => `<option value="${escapeAttr(o)}"></option>`)
    .join('');
}

// Fill the "When" dropdown in the submit modal with the 12 months of 2026,
// matching the detail-edit form's month picker.
function populateSubmitWhenDropdown() {
  const sel = document.getElementById('fWhen');
  if (!sel) return;
  if (sel.options.length > 1) return; // already populated
  MONTH_NAMES_SHORT.forEach((name, i) => {
    const opt = document.createElement('option');
    opt.value = String(i + 1);
    opt.textContent = `${name} 2026`;
    sel.appendChild(opt);
  });
}

// Build the aggregated prototype-builder prompt text from arbitrary parts.
// Empty fields are skipped so the prompt stays clean.
function buildIdeaCopyText(parts) {
  const order = [
    ['Objective', parts.objective],
    ['What',      parts.what],
    ['Why',       parts.why],
    ['How',       parts.how],
    ['User flow', parts.userFlow]
  ];
  return order
    .map(([label, val]) => {
      const v = String(val || '').trim();
      return v ? `${label}: ${v}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

async function copyText(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMsg || 'Copied.');
  } catch (e) {
    // Fallback for older browsers / non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(successMsg || 'Copied.'); }
    catch (_) { toast('Copy failed — select & copy manually.'); }
    finally { document.body.removeChild(ta); }
  }
}

function copyIdeaFromForm() {
  const text = buildIdeaCopyText({
    objective: (document.getElementById('fObjective') || {}).value,
    what:      (document.getElementById('fWhat')      || {}).value,
    why:       (document.getElementById('fWhy')       || {}).value,
    how:       (document.getElementById('fHow')       || {}).value,
    userFlow:  (document.getElementById('fUserFlow')  || {}).value
  });
  if (!text) { toast('Nothing to copy yet.'); return; }
  copyText(text, 'Copied — paste into the prototype builder.');
}

function copyIdeaFromCurrentDetail() {
  const r = CURRENT_DETAIL_ROW;
  if (!r) { toast('Nothing to copy.'); return; }
  const text = buildIdeaCopyText({
    objective: r.Objective,
    what:      r.What,
    why:       r.Why,
    how:       r.How,
    userFlow:  r['User Flow']
  });
  if (!text) { toast('Nothing to copy yet.'); return; }
  copyText(text, 'Copied — paste into the prototype builder.');
}

function closeSubmitModal() {
  const modal = document.getElementById('submitModal');
  if (!modal) return;
  modal.hidden = true;
  CURRENT_EDIT_ROW = null;
  // Only restore body overflow if the detail modal isn't also open
  if (document.getElementById('detailModal').hidden) {
    document.body.style.overflow = '';
  }
}

function firstUrl(cell) {
  if (!cell) return '';
  const m = String(cell).match(/https?:\/\/\S+/);
  return m ? m[0] : '';
}

function linksFromCell(cell, label) {
  if (!cell) return '';
  const urls = String(cell).split(/[\s,;\n]+/).filter(s => /^https?:\/\//.test(s));
  if (urls.length === 0) return '';
  return urls.map(u => `<a href="${escapeAttr(u)}" target="_blank" rel="noopener">${label} ↗</a>`).join('');
}

function statusClass(status) {
  const s = String(status).toLowerCase();
  if (/ship|done|launch|complete|live/.test(s))         return 'is-shipped';
  if (/progress|doing|building|wip|develop/.test(s))     return 'is-progress';
  if (/^backlog$/.test(s))                               return 'is-backlog';
  if (/discov|explore|research|todo|planning/.test(s))   return 'is-discovery';
  if (/block|stuck|hold|paus/.test(s))                   return 'is-blocked';
  return '';
}

function bindCardClicks(scope) {
  scope.querySelectorAll('.init-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't open the modal if user clicked a link inside the card
      if (e.target.closest('a')) return;
      const row = JSON.parse(card.dataset.row);
      openDetailModal(row);
    });
  });
}

// ─── Detail modal (initiative) ──────────────────────────────────────────
// Stakeholders see this when they click any card in Timeline. Editors get
// an editable form with a single Save at the bottom; non-editors get a
// read-only summary of the same row.

const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const STATUS_OPTIONS    = ['Backlog','Discovery','Doing','In review','Blocked','Shipped'];
// Track open card so the Save handler can diff against it
let CURRENT_DETAIL_ROW = null;

function isEditorViewer() {
  const viewerEmail = (AUTH.getEmail() || '').toLowerCase();
  return EDITORS_ALLOWED.map(s => s.toLowerCase()).includes(viewerEmail);
}

function openDetailModal(r) {
  // Editors edit through the same idea-submit form (pre-filled). Non-editors
  // still see the read-only summary modal.
  if (isEditorViewer()) { openSubmitModal(r); return; }

  CURRENT_DETAIL_ROW = r;
  const protoUrl = firstUrl(r.Prototype);
  document.getElementById('detailModalTitle').textContent = r.What || '(no title)';
  document.getElementById('detailModalBody').innerHTML = renderDetailReadonly(r, protoUrl);
  document.getElementById('detailModal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDetailModal() {
  document.getElementById('detailModal').hidden = true;
  document.body.style.overflow = '';
  CURRENT_DETAIL_ROW = null;
}

// Read-only view — used for non-editors.
function renderDetailReadonly(r, protoUrl) {
  return `
    <div class="detail-modal-meta">
      ${r.Objective ? `<div class="detail-objective">${escapeHtml(r.Objective)}</div>` : ''}
      <div class="detail-modal-chips">
        ${statusPill(r.Status)}
        ${r.Who  ? `<span class="owner-chip-static">${escapeHtml(r.Who)}</span>`  : `<span class="meta-empty">no owner</span>`}
        ${r.When ? `<span class="meta-when">${escapeHtml(r.When)}</span>`         : `<span class="meta-empty">no horizon</span>`}
      </div>
      ${protoUrl ? `<a class="btn btn-primary detail-modal-cta" href="${escapeAttr(protoUrl)}" target="_blank" rel="noopener">View prototype ↗</a>` : ''}
    </div>
    <div class="detail-modal-content">
      ${fieldOrPlaceholder('Why', r.Why)}
      ${fieldOrPlaceholder('How', r.How)}
    </div>
  `;
}


// ─── Submit form (lives in the Backlog tab) ────────────────────────────
// Two-tier validation, by design:
//   1. INTEGRITY_CHECKS — hidden anti-cheat. Surfaced ONLY in the error popup
//      after the user clicks Submit. Tightened heuristics (~90% catch rate)
//      so cheaters can't iterate against visible rules.
//   2. QUALITY_CHECKS — visible Amazonian writing rules. Shown inline at each
//      field as a live checklist so users self-coach to a clearer submission.

// Hidden anti-cheat. Returns {ok:true} or {ok:false, reason:'short label'}.
// Catches: chunk repetition, char/word dominance, low lexical diversity,
// vowel-less "words", keyboard mashing, low bigram variety, missing spaces,
// over-long fake words, mostly-non-letter content.
function validateRealText(s, minDistinctWords) {
  const text = String(s || '').trim();
  if (!text) return { ok: false, reason: 'is empty' };

  // Repeated chunk. Two-tier so we don't false-positive on real abbreviations:
  //   - single char: needs 4+ in a row ("aaaa") so "CCCD" / "AAA Bank" pass
  //   - 2–8 char chunk: needs 3+ in a row ("ABCABCABC", "lalalala", "blah blah blah")
  if (/(.)\1{3,}/i.test(text) || /(.{2,8})\1{2,}/i.test(text)) {
    return { ok: false, reason: 'contains a repeated pattern (e.g. "ABCABC…")' };
  }

  // Spaces — real prose has multiple words separated by spaces
  const spaceCount = (text.match(/\s/g) || []).length;
  if (spaceCount < 4) return { ok: false, reason: 'needs more spaces — write real, multi-word sentences' };

  // Mostly-letters — discount whitespace; ≥50% should be letters
  const nonSpace = text.replace(/\s/g, '');
  const letterCount = (text.match(/\p{L}/gu) || []).length;
  if (nonSpace.length > 0 && letterCount / nonSpace.length < 0.5) {
    return { ok: false, reason: 'has too few letters (mostly digits/symbols)' };
  }

  // Single character dominance — tightened to 30% (was 50%)
  const alnum = text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  if (alnum.length >= 10) {
    const charCounts = {};
    for (const ch of alnum) charCounts[ch] = (charCounts[ch] || 0) + 1;
    const topChar = Math.max(...Object.values(charCounts));
    if (topChar / alnum.length > 0.30) return { ok: false, reason: 'overuses a single character' };
  }

  // Tokenize Unicode letter/digit runs
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  if (words.length < 5) return { ok: false, reason: 'has too few words to be a real sentence' };

  // Distinct-words minimum
  const distinct = new Set(words);
  if (distinct.size < minDistinctWords) {
    return { ok: false, reason: `needs ${minDistinctWords}+ distinct words (has ${distinct.size})` };
  }

  // Lexical diversity ratio — distinct/total ≥ 0.5 for non-trivial input
  if (words.length >= 8 && distinct.size / words.length < 0.5) {
    return { ok: false, reason: 'too many repeated words — write real prose, not filler' };
  }

  // Single word dominance — tightened to 25% (was 35%)
  if (words.length >= 6) {
    const wordCounts = {};
    words.forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });
    const topWord = Math.max(...Object.values(wordCounts));
    if (topWord / words.length > 0.25) return { ok: false, reason: 'overuses a single word' };
  }

  // Average word length — humans average 3–7 chars; >10 is suspicious junk
  const avgLen = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  if (avgLen > 10) return { ok: false, reason: 'has unusually long "words" (likely junk)' };

  // Vowel content — for words 4+ chars, most should contain a vowel
  // (covers Latin + full Vietnamese vowel range with diacritics)
  const VOWEL_RE = /[aeiouyăâêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
  const longWords = words.filter(w => w.length >= 4);
  if (longWords.length >= 3) {
    const vowelless = longWords.filter(w => !VOWEL_RE.test(w));
    if (vowelless.length / longWords.length > 0.30) {
      return { ok: false, reason: 'contains many "words" without vowels (likely junk)' };
    }
  }

  // Keyboard mashing — common left-to-right roll patterns
  const KEYBOARD_ROLLS = ['qwerty', 'wertyu', 'ertyui', 'rtyuio',
                          'asdfgh', 'sdfghj', 'dfghjk', 'fghjkl',
                          'zxcvbn', 'xcvbnm'];
  if (KEYBOARD_ROLLS.some(r => alnum.includes(r))) {
    return { ok: false, reason: 'contains a keyboard-mashing pattern (qwerty, asdfgh…)' };
  }

  // Bigram diversity — catches subtle repetition the chunk regex misses.
  // For 30+ chars of alnum, distinct adjacent pairs should be ≥ 25%.
  if (alnum.length >= 30) {
    const bigrams = new Set();
    for (let i = 0; i < alnum.length - 1; i++) bigrams.add(alnum.slice(i, i + 2));
    if (bigrams.size / (alnum.length - 1) < 0.25) {
      return { ok: false, reason: 'lacks character variety (looks like a repeated pattern)' };
    }
  }

  return { ok: true };
}

// Per-field minimum distinct-word counts for the integrity check.
// `what` is title-style (3–5 words) so it skips the prose-oriented integrity
// pass entirely — only the word-count rule in QUALITY_CHECKS applies.
const INTEGRITY_CHECKS = {
  why:  { minDistinctWords: 10, fieldLabel: 'Why'  },
  how:  { minDistinctWords: 6,  fieldLabel: 'How'  }
};

function runIntegrityChecks() {
  const failures = [];
  ['why', 'how'].forEach(field => {
    const cap = field.charAt(0).toUpperCase() + field.slice(1);
    const value = (document.getElementById('f' + cap) || {}).value || '';
    const cfg = INTEGRITY_CHECKS[field];
    const result = validateRealText(value, cfg.minDistinctWords);
    if (!result.ok) failures.push({ field, fieldLabel: cfg.fieldLabel, reason: result.reason });
  });
  return failures;
}

// VISIBLE Amazonian writing rules. Each item shows live next to its field as a
// coaching checklist. Length floors stay here (clarity, not anti-cheat).
const QUALITY_CHECKS = {
  what: [
    { label: '3–5 words — short, title-style',
      test: s => {
        const n = (s.trim().match(/\S+/g) || []).length;
        return n >= 3 && n <= 5;
      } },
    { label: 'No marketing fluff (amazing, world-class, seamless, magical, đột phá…)',
      test: s => s.trim().length > 0 && !/(amazing|awesome|world[-\s]?class|cutting[-\s]?edge|seamless|magical|revolutionary|innovative|delightful|game[-\s]?chang|next[-\s]?gen|state[-\s]?of[-\s]?the[-\s]?art|đột\s*phá|tuyệt\s*vời|đẳng\s*cấp|vượt\s*trội)/i.test(s) }
  ],
  why: [
    { label: 'At least 60 characters — gives context, not a tagline',
      test: s => s.trim().length >= 60 },
    { label: 'Includes data — a number tied to a metric (e.g. "30% drop-off", "200 tickets")',
      test: s => {
        // Require BOTH a number AND a metric/unit word, OR a quantitative phrase.
        const hasNumber = /\d/.test(s);
        const hasMetric = /(\bnps\b|drop[-\s]?off|churn|conversion|retention|tickets?|complaints?|sessions?|signups?|requests?|users?|customers?|orders?|errors?|crashes?|tỷ\s*lệ|phần\s*trăm|người\s*dùng|đơn|lỗi|tickets?)/i.test(s);
        return hasNumber && hasMetric;
      } },
    { label: 'Names the user/customer (user, customer, người dùng, khách hàng…)',
      test: s => /(\busers?\b|\bcustomers?\b|người\s*dùng|khách\s*hàng|stakeholder)/i.test(s) },
    { label: 'No weasel words (might, perhaps, we believe, có lẽ, có thể là…) — claim it confidently',
      test: s => s.trim().length > 0 && !/(\bmight\b|\bperhaps\b|\bpotentially\b|we\s+believe|we\s+think|it\s+seems|sort\s+of|kind\s+of|somewhat|hopefully|maybe|có\s*lẽ|có\s*thể\s*là|hình\s*như)/i.test(s) }
  ],
  how: [
    { label: 'At least 40 characters — concrete approach',
      test: s => s.trim().length >= 40 },
    { label: 'No corporate jargon (synergy, leverage, ecosystem, holistic, hệ sinh thái…)',
      test: s => s.trim().length > 0 && !/(synergy|leverage|ecosystem|holistic|paradigm|best[-\s]?in[-\s]?class|alignment|streamline|empower|robust\s+solution|move\s+the\s+needle|low[-\s]?hanging\s+fruit|bandwidth|circle\s+back|hệ\s*sinh\s*thái|cộng\s*hưởng|tối\s*ưu\s*hoá|toàn\s*diện)/i.test(s) }
  ]
};

// Returns set of field keys that fail validation. Used by handleSubmit.
function collectFailingFields() {
  const failing = new Set();
  ['what', 'why', 'how'].forEach(field => {
    const cap = field.charAt(0).toUpperCase() + field.slice(1);
    const value = (document.getElementById('f' + cap) || {}).value || '';
    if (!QUALITY_CHECKS[field].every(c => c.test(value))) failing.add(field);
  });
  const objVal = (document.getElementById('fObjective') || {}).value || '';
  if (!objVal.trim()) failing.add('objective');
  return failing;
}

function highlightFailingFields(failing) {
  ['what', 'why', 'how'].forEach(field => {
    const cap = field.charAt(0).toUpperCase() + field.slice(1);
    const input = document.getElementById('f' + cap);
    const checklist = document.getElementById('check' + cap);
    const toggle = document.querySelector(`[data-rules-for="${field}"]`);
    if (!failing.has(field)) return;
    if (input)     input.classList.add('has-error');
    if (checklist) checklist.classList.add('show-failed');
    // Auto-expand the rules list so the user can see exactly what failed
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  });
  if (failing.has('objective')) {
    const obj = document.getElementById('fObjective');
    if (obj) obj.classList.add('has-error');
  }
}

function scrollToFirstFailing(failing) {
  const order = ['objective', 'what', 'why', 'how'];
  const first = order.find(f => failing.has(f));
  if (!first) return;
  const id = first === 'objective' ? 'fObjective' : 'f' + first.charAt(0).toUpperCase() + first.slice(1);
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.focus({ preventScroll: true }), 350);
}

function resetSubmitForm() {
  document.getElementById('submitForm').reset();
  document.getElementById('formError').hidden = true;
  document.querySelectorAll('#submitForm .has-error').forEach(el => el.classList.remove('has-error'));
  document.querySelectorAll('.quality-list.show-failed').forEach(el => el.classList.remove('show-failed'));
  // form.reset() restores checkbox defaults — re-render the picker label
  if (typeof renderTechPickerValue === 'function') renderTechPickerValue();
  // Collapse all rules toggles back to closed
  document.querySelectorAll('.idea-rules-toggle[aria-expanded="true"]').forEach(t => {
    t.setAttribute('aria-expanded', 'false');
    const cap = t.dataset.rulesFor.charAt(0).toUpperCase() + t.dataset.rulesFor.slice(1);
    const target = document.getElementById('check' + cap);
    if (target) target.hidden = true;
  });
  renderChecklists();
}

// Live per-field writing-rules indicator. Renders the checklist (still hidden
// behind the toggle until the user expands it) and updates the toggle's
// indicator (○ → ● partial → ✓ all pass) plus its label ("2/3 rules met").
function renderChecklists() {
  // Any edit clears a stale error banner from a prior failed submit
  const formErrEl = document.getElementById('formError');
  if (formErrEl) formErrEl.hidden = true;

  ['what', 'why', 'how'].forEach(field => {
    const cap = field.charAt(0).toUpperCase() + field.slice(1);
    const input = document.getElementById('f' + cap);
    const container = document.getElementById('check' + cap);
    if (!container || !input) return;
    const value = input.value || '';

    const rules = QUALITY_CHECKS[field];
    const items = rules.map(c => {
      const passed = c.test(value);
      return `<li class="${passed ? 'is-passed' : ''}">
        <span class="check-icon" aria-hidden="true">${passed ? '✓' : '○'}</span>
        <span class="check-label">${escapeHtml(c.label)}</span>
      </li>`;
    }).join('');
    container.innerHTML = items;

    const passed = rules.filter(c => c.test(value)).length;
    const total = rules.length;
    const allPass = passed === total;

    const toggleEl = document.querySelector(`[data-rules-for="${field}"]`);
    if (toggleEl) {
      toggleEl.classList.toggle('is-passing', allPass);
      toggleEl.classList.toggle('is-failing', !allPass && passed > 0);
      const labelEl = document.querySelector(`[data-rules-label-for="${field}"]`);
      const iconEl = toggleEl.querySelector('.rules-icon');
      if (iconEl) iconEl.textContent = allPass ? '✓' : (passed > 0 ? '●' : '○');
      if (labelEl) {
        labelEl.textContent = value.trim().length === 0
          ? 'writing rules'
          : `${passed}/${total} rules met`;
      }
    }

    // Clear error highlight on the field once all its rules pass
    if (allPass) {
      input.classList.remove('has-error');
      container.classList.remove('show-failed');
    }
  });
}

// Confetti celebration on successful submit. MoMo brand colors. Fires three
// staggered bursts so it feels generous, not stingy. No-op if the library
// hasn't loaded (e.g., offline) — never blocks submission.
function celebrateSubmit() {
  if (typeof confetti !== 'function') return;
  const colors = ['#ae2070', '#faf2f6', '#d35400', '#1a7a4a', '#2266aa', '#ffffff'];
  const base = { ticks: 120, gravity: 0.85, decay: 0.94, startVelocity: 45, scalar: 1.05, colors };

  // Center burst — big and showy
  confetti({ ...base, particleCount: 120, spread: 90, origin: { x: 0.5, y: 0.65 } });
  // Side bursts — fountain in from left then right
  setTimeout(() => confetti({ ...base, particleCount: 70, angle: 60,  spread: 70, origin: { x: 0,   y: 0.7 } }), 180);
  setTimeout(() => confetti({ ...base, particleCount: 70, angle: 120, spread: 70, origin: { x: 1,   y: 0.7 } }), 360);
  // Top sprinkle for a final flourish
  setTimeout(() => confetti({ ...base, particleCount: 80, spread: 160, startVelocity: 25, origin: { x: 0.5, y: 0.2 } }), 540);
}

// Combobox: input + datalist. User can pick from existing objectives or type
// a new one. Whatever's in the input is what gets submitted — the backend
// treats existing-vs-new identically (just a string in the Objective column).
function populateObjectiveDatalist() {
  const list = document.getElementById('objectiveSuggestions');
  if (!list) return;
  list.innerHTML = STATE.objectives
    .map(o => `<option value="${escapeAttr(o)}"></option>`)
    .join('');
}

async function handleSubmit(e) {
  e.preventDefault();

  // Run BOTH validations together. Integrity errors (anti-cheat) appear in the
  // popup with specific reasons; Amazonian rule failures stay highlighted inline.
  const integrityFailures = runIntegrityChecks();
  const failingQuality    = collectFailingFields();

  if (integrityFailures.length > 0 || failingQuality.size > 0) {
    const allFailing = new Set(failingQuality);
    integrityFailures.forEach(f => allFailing.add(f.field));
    highlightFailingFields(allFailing);

    // Build a flat list of what's wrong, per field, so the user can act on it
    // without us needing to render an inline checklist.
    const reasons = [];
    if (failingQuality.has('objective')) reasons.push({ fieldLabel: 'Objective', reason: 'is required' });
    ['what', 'why', 'how'].forEach(field => {
      if (!failingQuality.has(field)) return;
      const cap = field.charAt(0).toUpperCase() + field.slice(1);
      const value = (document.getElementById('f' + cap) || {}).value || '';
      QUALITY_CHECKS[field].forEach(rule => {
        if (!rule.test(value)) {
          reasons.push({ fieldLabel: cap, reason: rule.label.replace(/—.*$/, '').trim() });
        }
      });
    });
    integrityFailures.forEach(f => reasons.push({ fieldLabel: f.fieldLabel, reason: f.reason }));

    showFormErrorList(reasons);
    scrollToFirstFailing(allFailing);
    return;
  }

  const objective = document.getElementById('fObjective').value.trim();
  const isNew = objective.length > 0 && !STATE.objectives.includes(objective);

  // When → "Mmm 2026" string, matching the format used by detail-edit
  const monthVal = (document.getElementById('fWhen') || {}).value || '';
  const whenStr  = monthVal ? `${MONTH_NAMES_SHORT[parseInt(monthVal, 10) - 1]} 2026` : '';

  const fields = {
    Objective: objective,
    Status:    (document.getElementById('fStatus') || {}).value || 'Backlog',
    What:      document.getElementById('fWhat').value.trim(),
    Why:       document.getElementById('fWhy').value.trim(),
    How:       document.getElementById('fHow').value.trim(),
    When:      whenStr,
    'User Flow': (document.getElementById('fUserFlow') || {}).value.trim(),
    Prototype: (document.getElementById('fPrototype') || {}).value.trim(),
    Confluence: (document.getElementById('fConfluence') || {}).value.trim(),
    Who: (document.getElementById('fOwner') || {}).value.trim(),
    Tech: Array.from(document.querySelectorAll('#fTechTeams input[name="techTeam"]:checked'))
      .map(cb => cb.value).join(', ')
  };
  const btn = document.getElementById('submitFormBtn');

  // ── Edit mode: send only changed fields to the update endpoint ────────
  if (CURRENT_EDIT_ROW) {
    const r = CURRENT_EDIT_ROW;
    const changes = {};
    Object.keys(fields).forEach(k => {
      const newVal = fields[k];
      const oldVal = ((r[k] || '') + '').trim();
      if (newVal !== oldVal) changes[k] = newVal;
    });
    if (Object.keys(changes).length === 0) {
      closeSubmitModal();
      toast('No changes to save.');
      return;
    }
    const rowKey = r['#'];
    if (!rowKey) { showFormError('This row has no "#" key — cannot update.'); return; }

    if (CONFIG.USE_MOCK) {
      console.log('[MOCK] Would UPDATE row', rowKey, 'with', changes);
      closeSubmitModal();
      toast('Mock update: changes would be saved.');
      return;
    }

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const data = await jsonpCallWithReauth({
        action: 'update',
        token:  AUTH.getToken(),
        rowKey: String(rowKey),
        fields: JSON.stringify(changes)
      });
      if (!data.ok) throw new Error(data.error || 'update failed');
      // Optimistic local update so Timeline reflects the change immediately
      const idx = STATE.rows.findIndex(x => String(x['#']) === String(rowKey));
      if (idx !== -1) {
        STATE.rows[idx] = { ...STATE.rows[idx], ...changes };
        STATE.objectives = Array.from(new Set(
          STATE.rows.map(x => (x.Objective || '').trim()).filter(Boolean)
        )).sort((a, b) => a.localeCompare(b));
        writeCachedData();
        populateTimelineFilters();
        renderRoadmapGlance();
        renderTimeline();
        renderBacklog();
        renderMetrics();
      }
      closeSubmitModal();
      toast('Changes saved.');
    } catch (err) {
      showFormError(err.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Save changes';
    }
    return;
  }

  // ── Create mode: append a new idea ─────────────────────────────────────
  const body = {
    token: AUTH.getToken() || 'mock-token',
    objective,
    objectiveIsNew: isNew,
    what: fields.What, why: fields.Why, how: fields.How,
    when: fields.When, userFlow: fields['User Flow'], tech: fields.Tech,
    status: fields.Status, prototype: fields.Prototype, who: fields.Who,
    confluence: fields.Confluence
  };

  if (CONFIG.USE_MOCK) {
    console.log('[MOCK] Would POST:', body);
    resetSubmitForm();
    closeSubmitModal();
    celebrateSubmit();
    toast('Mock submit: row would be appended to What&Why with Status=Backlog');
    return;
  }

  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const data = await jsonpCallWithReauth({ action: 'submit', ...body });
    if (!data.ok) throw new Error(data.error || 'submit failed');
    resetSubmitForm();
    closeSubmitModal();
    celebrateSubmit();
    toast(`Idea submitted (row #${data.rowKey || data.rowNumber}). Thanks!`);
    fetchData(true);
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Submit idea';
  }
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.hidden = false;
}

// Bullet list of every failing rule, grouped by field, so the user can fix
// everything in one pass without having to expand inline checklists.
function showFormErrorList(failures) {
  const el = document.getElementById('formError');
  el.innerHTML =
    '<strong>Fix the following before submitting:</strong>' +
    '<ul style="margin:6px 0 0 18px;padding:0">' +
      failures.map(f =>
        `<li><strong>${escapeHtml(f.fieldLabel)}</strong> ${escapeHtml(f.reason)}.</li>`
      ).join('') +
    '</ul>';
  el.hidden = false;
}

// ─── AI Insights ────────────────────────────────────────────────────────
async function generateSynthesis(mode, force) {
  const btn = document.getElementById('generateBtn');
  const body = document.getElementById('insightsBody');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  body.innerHTML = `
    <div class="insights-loading">
      <div class="spinner"></div>
      <span>Asking Gemini to analyze ${STATE.rows.length} initiatives…</span>
    </div>
  `;
  try {
    const data = await jsonpCall({
      action: 'synthesize',
      mode: mode,
      token: AUTH.getToken(),
      force: force ? 'true' : 'false'
    });
    if (!data.ok) throw new Error(data.error || 'synthesis failed');
    STATE.synthesis[mode] = {
      text: data.text,
      generatedAt: data.generatedAt ? new Date(data.generatedAt).getTime() : Date.now(),
      cached: !!data.cached
    };
    writeCachedSynthesis();
    renderInsights();
  } catch (err) {
    body.innerHTML = `<div class="insights-empty">Could not generate synthesis: ${escapeHtml(err.message)}</div>`;
    toast('Synthesis failed: ' + err.message, true);
  } finally {
    btn.disabled = false;
    // Label restored by renderInsights on success; restore manually on error too
    if (!STATE.synthesis[mode].text) btn.textContent = 'Generate synthesis';
    else btn.textContent = 'Re-generate';
  }
}

function renderInsights() {
  const mode = STATE.activeMode;
  const cur  = STATE.synthesis[mode];
  const btn  = document.getElementById('generateBtn');
  const meta = document.getElementById('synthesisMeta');
  const body = document.getElementById('insightsBody');

  // Update mode pills (in case state was changed programmatically)
  document.querySelectorAll('.mode-pill').forEach(p =>
    p.classList.toggle('is-active', p.dataset.mode === mode));

  if (cur.text) {
    btn.textContent = 'Re-generate';
    const cachedBadge = cur.cached ? ' <span class="synth-cached-badge">cached</span>' : '';
    meta.innerHTML = 'Generated ' + relativeTime(cur.generatedAt) + cachedBadge;
    body.innerHTML = renderMarkdown(cur.text);
  } else {
    btn.textContent = 'Generate synthesis';
    meta.textContent = '';
    body.innerHTML = `
      <div class="insights-empty">
        Click <strong>Generate synthesis</strong> to get an AI-written summary of the roadmap, focused on
        <strong>${mode === 'stakeholder' ? 'stakeholders & bosses' : 'operational risks for the PM'}</strong>.
        <br><br>
        Powered by Google Gemini · cached for 1 hour client-side, 6 hours server-side.
      </div>
    `;
  }
}

// Minimal Markdown renderer — handles ## h2, ### h3, **bold**, *italic*, `code`, - bullets, paragraphs.
function renderMarkdown(text) {
  // 1. Escape HTML first
  let s = escapeHtml(text);

  // 2. Normalize line endings
  s = s.replace(/\r\n/g, '\n');

  // 3. Block-level: headings
  s = s.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
  s = s.replace(/^##\s+(.+)$/gm,  '<h2 class="md-h2">$1</h2>');
  s = s.replace(/^#\s+(.+)$/gm,   '<h2 class="md-h2">$1</h2>');

  // 4. Bullet groups: collapse runs of "- foo" into <ul><li>...</li></ul>
  s = s.replace(/(?:^|\n)((?:[-*]\s+.+(?:\n|$))+)/g, function (_match, block) {
    const items = block
      .trim()
      .split(/\n/)
      .map(line => line.replace(/^[-*]\s+/, ''))
      .map(li => '<li>' + li + '</li>')
      .join('');
    return '\n<ul>' + items + '</ul>\n';
  });

  // 5. Inline: bold, italic, code (apply to non-tag text)
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 6. Wrap remaining loose lines in <p>
  const blocks = s.split(/\n{2,}/).map(blk => {
    blk = blk.trim();
    if (!blk) return '';
    if (/^<(h2|h3|ul|ol|p|div)/.test(blk)) return blk;
    return '<p>' + blk.replace(/\n/g, '<br>') + '</p>';
  });
  return blocks.join('\n');
}

function loadCachedSynthesis() {
  try {
    const raw = localStorage.getItem(SYNTH_CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    ['stakeholder', 'operational'].forEach(mode => {
      const item = obj[mode];
      if (item && item.text && item.generatedAt
          && Date.now() - item.generatedAt < SYNTH_CACHE_TTL_MS) {
        STATE.synthesis[mode] = item;
      }
    });
  } catch (_) { localStorage.removeItem(SYNTH_CACHE_KEY); }
}

function writeCachedSynthesis() {
  try {
    localStorage.setItem(SYNTH_CACHE_KEY, JSON.stringify(STATE.synthesis));
  } catch (_) { /* quota — ignore */ }
}

// ─── Helpers ────────────────────────────────────────────────────────────
// Sheet headers may be multi-line ("Objective\nJTBDs"); use the first line as key.
function normalizeRow(row) {
  const out = {};
  Object.entries(row).forEach(([k, v]) => {
    const firstLine = String(k).split(/\r?\n/)[0].trim();
    out[firstLine] = v;
  });
  return out;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function showLoader(show) {
  document.getElementById('loader').hidden = !show;
}

let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}
