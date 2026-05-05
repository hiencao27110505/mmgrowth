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
  filters: { owner: '', status: '', quality: '' }, // Timeline filters; '' = no filter
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

  // Header "Submit an idea" → switch to Backlog tab + scroll to + focus the form
  document.getElementById('submitBtn').addEventListener('click', () => {
    switchView('backlog');
    setTimeout(() => {
      const card = document.querySelector('.backlog-form-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const sel = document.getElementById('fObjective');
      if (sel) sel.focus();
    }, 30);
  });

  // Form submit
  document.getElementById('submitForm').addEventListener('submit', handleSubmit);

  // Live quality checklist updates
  ['fWhat', 'fWhy', 'fHow'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderChecklists);
  });
  renderChecklists();

  // Objective dropdown — show "Other" input when chosen + re-evaluate submit gate
  document.getElementById('fObjective').addEventListener('change', (e) => {
    document.getElementById('fObjectiveOtherWrap').hidden = e.target.value !== '__other__';
    updateSubmitGate();
  });
  // "Other (specify)" text input also gates the submit
  const fOther = document.getElementById('fObjectiveOther');
  if (fOther) fOther.addEventListener('input', updateSubmitGate);

  // Timeline filters
  ['filterOwner', 'filterStatus', 'filterQuality'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', (e) => {
      const key = id.replace('filter', '').toLowerCase(); // owner / status / quality
      STATE.filters[key] = e.target.value;
      updateClearFiltersBtn();
      renderTimeline();
    });
  });
  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    STATE.filters = { owner: '', status: '', quality: '' };
    ['filterOwner', 'filterStatus', 'filterQuality'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    updateClearFiltersBtn();
    renderTimeline();
  });

  // Detail modal close
  document.querySelectorAll('[data-detail-close]').forEach(el => {
    el.addEventListener('click', closeDetailModal);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('detailModal').hidden) {
      closeDetailModal();
    }
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
      populateObjectiveDropdown();
      renderAll();
      updateLastUpdated();
      return;
    }
  }

  showLoader(true);
  try {
    const data = await jsonpCall({ action: 'read', token: AUTH.getToken() });
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
    populateObjectiveDropdown();
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
  populateObjectiveDropdown();
  renderAll();
}

// ─── Render orchestration ──────────────────────────────────────────────
function renderAll() {
  renderMetrics();
  populateTimelineFilters();
  renderTimeline();
  renderBacklog();
  renderInsights();
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
    if (f.owner  && (r.Who    || '').trim() !== f.owner)  return false;
    if (f.status && (r.Status || '').trim() !== f.status) return false;
    if (f.quality === 'complete' && missingFields(r).length > 0)  return false;
    if (f.quality === 'gaps'     && missingFields(r).length === 0) return false;
    return true;
  });
}

function populateTimelineFilters() {
  const owners = Array.from(new Set(
    STATE.rows.map(r => (r.Who || '').trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));
  const statuses = Array.from(new Set(
    STATE.rows.map(r => (r.Status || '').trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const ownerSel  = document.getElementById('filterOwner');
  const statusSel = document.getElementById('filterStatus');
  if (ownerSel) {
    const cur = STATE.filters.owner;
    ownerSel.innerHTML = '<option value="">All</option>' +
      owners.map(o => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join('');
    // Keep selection if the current owner still exists, otherwise reset.
    if (owners.includes(cur)) ownerSel.value = cur;
    else { ownerSel.value = ''; STATE.filters.owner = ''; }
  }
  if (statusSel) {
    const cur = STATE.filters.status;
    statusSel.innerHTML = '<option value="">All</option>' +
      statuses.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
    if (statuses.includes(cur)) statusSel.value = cur;
    else { statusSel.value = ''; STATE.filters.status = ''; }
  }
  const qSel = document.getElementById('filterQuality');
  if (qSel) qSel.value = STATE.filters.quality;
  updateClearFiltersBtn();
}

function updateClearFiltersBtn() {
  const f = STATE.filters;
  const hasAny = !!(f.owner || f.status || f.quality);
  const btn = document.getElementById('clearFiltersBtn');
  if (btn) btn.hidden = !hasAny;
}

// ─── Timeline (grouped by Month) ───────────────────────────────────────
function renderTimeline() {
  const filtered = applyTimelineFilters(STATE.rows);
  const groups = {};
  filtered.forEach(r => {
    const key = monthKey(r.When);
    if (!groups[key]) groups[key] = { label: monthLabel(r.When), rows: [] };
    groups[key].rows.push(r);
  });

  // Filter-count chip: how many cards survived the filter (only when active)
  const countEl = document.getElementById('filterCount');
  const f = STATE.filters;
  const hasAny = !!(f.owner || f.status || f.quality);
  if (countEl) {
    countEl.hidden = !hasAny;
    countEl.textContent = `${filtered.length} of ${STATE.rows.length}`;
  }

  // Sort: chronological asc; unscheduled last
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === 'unscheduled') return 1;
    if (b === 'unscheduled') return -1;
    return a.localeCompare(b);
  });

  if (sortedKeys.length === 0) {
    document.getElementById('timelineColumns').innerHTML = hasAny
      ? '<div class="empty-state">No initiatives match the current filters.</div>'
      : '<div class="empty-state">No initiatives in the sheet yet.</div>';
    return;
  }

  document.getElementById('timelineColumns').innerHTML = sortedKeys.map(key => {
    const g = groups[key];
    const cls = [
      g.label.isNow  ? 'is-now'  : '',
      g.label.isPast ? 'is-past' : ''
    ].filter(Boolean).join(' ');
    const suffix = g.label.isNow ? ' · Now' : '';
    return `
      <div class="timeline-col ${cls}">
        <div class="timeline-col-head">
          <span class="timeline-col-label">${escapeHtml(g.label.text)}${suffix}</span>
          <span class="timeline-col-count">${g.rows.length}</span>
        </div>
        ${g.rows.length
          ? g.rows.map(initCardHTML).join('')
          : '<div class="empty-state" style="padding:20px 0;font-size:12px">No initiatives.</div>'}
      </div>
    `;
  }).join('');

  bindCardClicks(document.getElementById('timelineColumns'));
}

// Backwards-compat shim: initCardHTML still uses mapHorizon for the
// horizon-colored left border. Keep it as a thin wrapper around quarter/horizon.
function mapHorizon(whenStr) {
  const p = parseWhenToMonth(whenStr);
  if (!p) return 'Later';
  const today = new Date();
  const curY = today.getFullYear();
  const curQ = Math.floor(today.getMonth() / 3) + 1;
  const nextQ = curQ === 4 ? 1 : curQ + 1;
  const nextY = curQ === 4 ? curY + 1 : curY;
  const q = Math.floor((p.month - 1) / 3) + 1;
  if (p.year === curY  && q === curQ)  return 'Now';
  if (p.year === nextY && q === nextQ) return 'Next';
  return 'Later';
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

// ─── Backlog view ───────────────────────────────────────────────────────
function renderBacklog() {
  const list = STATE.backlogRows;
  document.getElementById('backlog-count').textContent = list.length;

  const container = document.getElementById('backlogCardsList');
  if (!container) return;

  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:32px 0">No submissions yet. Be the first to suggest an idea using the form above.</div>';
    return;
  }

  // Newest first
  const sorted = [...list].sort((a, b) =>
    String(b.Timestamp || '').localeCompare(String(a.Timestamp || ''))
  );

  container.innerHTML = `
    <div class="cards-list cards-list-stack">
      ${sorted.map(backlogCardHTML).join('')}
    </div>
  `;
  container.querySelectorAll('.detail-head').forEach(head => {
    head.addEventListener('click', () => head.parentElement.classList.toggle('is-open'));
  });
}

function backlogCardHTML(r) {
  const isNewObjective = r['Objective Type'] === 'New (proposed)';
  const tsDate = r.Timestamp ? parseSheetTimestamp(r.Timestamp) : null;
  const tsRel  = tsDate ? relativeTime(tsDate.getTime()) : '';
  const whyText = whyPreview(r.Why);

  return `
    <div class="detail-card backlog-card">
      <div class="detail-head">
        <div class="detail-titlebox">
          ${r.Objective ? `<div class="detail-objective">${escapeHtml(r.Objective)}${isNewObjective ? '<span class="objective-type-flag">new objective</span>' : ''}</div>` : ''}
          <h3 class="detail-title">${escapeHtml(r.What || '(untitled)')}</h3>
          <div class="detail-why">${whyText}</div>
          <div class="detail-meta">
            ${r.Submitter ? `<span>${escapeHtml(r.Submitter)}</span>` : ''}
            ${tsRel ? `<span title="${escapeAttr(r.Timestamp)}">· submitted ${escapeHtml(tsRel)}</span>` : (r.Timestamp ? `<span>· ${escapeHtml(r.Timestamp)}</span>` : '')}
          </div>
        </div>
        <div class="detail-head-actions">
          ${statusPill(r.Status)}
          <span class="detail-toggle">+</span>
        </div>
      </div>
      <div class="detail-body">
        ${fieldOrPlaceholder('Why', r.Why)}
        ${fieldOrPlaceholder('How', r.How)}
        ${r['Reviewer Notes'] ? `<h4>Reviewer notes</h4><p>${escapeHtml(r['Reviewer Notes'])}</p>` : ''}
      </div>
    </div>
  `;
}

// Sheet timestamps come as "yyyy-MM-dd HH:mm:ss" strings — parse safely
function parseSheetTimestamp(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
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
  if (/discov|explore|research|backlog|todo|planning/.test(s)) return 'is-discovery';
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
function openDetailModal(r) {
  const protoUrl = firstUrl(r.Prototype);
  const horizon  = mapHorizon(r.When);
  const missing  = missingFields(r);

  document.getElementById('detailModalTitle').textContent = r.What || '(no title)';
  document.getElementById('detailModalBody').innerHTML = `
    <div class="detail-modal-meta horizon-${horizon.toLowerCase()}">
      ${r.Objective ? `<div class="detail-objective">${escapeHtml(r.Objective)}</div>` : ''}
      <div class="detail-modal-chips">
        ${statusPill(r.Status)}
        ${r.Who  ? `<span class="owner-chip-static">${escapeHtml(r.Who)}</span>`  : `<span class="meta-empty">no owner</span>`}
        ${r.When ? `<span class="meta-when">${escapeHtml(r.When)}</span>`         : `<span class="meta-empty">no horizon</span>`}
        ${missing.length ? `<span class="missing-chip" title="Missing: ${escapeAttr(missing.join(', '))}">missing ${escapeHtml(missing.length === 1 ? missing[0] : missing.length + ' fields')}</span>` : ''}
      </div>
      ${protoUrl ? `<a class="btn btn-primary detail-modal-cta" href="${escapeAttr(protoUrl)}" target="_blank" rel="noopener">View prototype ↗</a>` : ''}
    </div>
    <div class="detail-modal-content">
      ${fieldOrPlaceholder('Why', r.Why)}
      ${fieldOrPlaceholder('How', r.How)}
      ${fieldOrPlaceholder('User flow', r['User Flow'])}
      ${linkSectionOrPlaceholder('Prototype', r.Prototype)}
      ${linkSectionOrPlaceholder('Related docs', r['Related Docs'])}
    </div>
  `;
  document.getElementById('detailModal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDetailModal() {
  document.getElementById('detailModal').hidden = true;
  document.body.style.overflow = '';
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

  // Repeated chunk (1–8 chars repeating 3+ times in a row)
  // Catches: "ABCABCABC", "lalalala", "aaaaa", "blah blah blah blah".
  if (/(.{1,8})\1{2,}/i.test(text)) return { ok: false, reason: 'contains a repeated pattern (e.g. "ABCABC…")' };

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

// Per-field minimum distinct-word counts for the integrity check
const INTEGRITY_CHECKS = {
  what: { minDistinctWords: 6,  fieldLabel: 'What' },
  why:  { minDistinctWords: 10, fieldLabel: 'Why'  },
  how:  { minDistinctWords: 6,  fieldLabel: 'How'  }
};

function runIntegrityChecks() {
  const failures = [];
  ['what', 'why', 'how'].forEach(field => {
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
    { label: 'At least 40 characters — specific & complete',
      test: s => s.trim().length >= 40 },
    { label: 'Avoids vague verbs (improve, enhance, optimize, cải thiện…)',
      test: s => s.trim().length > 0 && !/(improve|enhance|optimize|better|nicer|great|cải\s*thiện|tối\s*ưu|nâng\s*cao|tốt\s*hơn)/i.test(s) },
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
    { label: 'Mentions scope, MVP, or an alternative considered',
      test: s => /(\bmvp\b|\bv1\b|\bv2\b|scope|phase|alternative|instead|trade[-\s]?off|fallback|out\s*of\s*scope|phạm\s*vi|giai\s*đoạn|lựa\s*chọn|thay\s*vì)/i.test(s) },
    { label: 'No corporate jargon (synergy, leverage, ecosystem, holistic, hệ sinh thái…)',
      test: s => s.trim().length > 0 && !/(synergy|leverage|ecosystem|holistic|paradigm|best[-\s]?in[-\s]?class|alignment|streamline|empower|robust\s+solution|move\s+the\s+needle|low[-\s]?hanging\s+fruit|bandwidth|circle\s+back|hệ\s*sinh\s*thái|cộng\s*hưởng|tối\s*ưu\s*hoá|toàn\s*diện)/i.test(s) }
  ]
};

function renderChecklists() {
  // Any edit clears a stale popup from a prior failed submit
  const formErrEl = document.getElementById('formError');
  if (formErrEl) formErrEl.hidden = true;

  ['what', 'why', 'how'].forEach(field => {
    const cap = field.charAt(0).toUpperCase() + field.slice(1);
    const input = document.getElementById('f' + cap);
    const container = document.getElementById('check' + cap);
    if (!container) return;
    const value = (input || {}).value || '';
    const items = QUALITY_CHECKS[field].map(c => {
      const passed = c.test(value);
      return `<li class="${passed ? 'is-passed' : ''}">
        <span class="check-icon" aria-hidden="true">${passed ? '✓' : '○'}</span>
        <span class="check-label">${escapeHtml(c.label)}</span>
      </li>`;
    }).join('');
    container.innerHTML = items;

    // If the user has fixed all checks for this field, clear its error highlight
    const allPass = QUALITY_CHECKS[field].every(c => c.test(value));
    if (input && allPass) {
      input.classList.remove('has-error');
      container.classList.remove('show-failed');
    }
  });

  // Objective field also clears its highlight when satisfied
  const objSel = document.getElementById('fObjective');
  const objOther = document.getElementById('fObjectiveOther');
  const objectiveOK = (objSel.value && objSel.value !== '__other__')
                  || (objSel.value === '__other__' && (objOther || {}).value && objOther.value.trim());
  if (objectiveOK) {
    objSel.classList.remove('has-error');
    if (objOther) objOther.classList.remove('has-error');
  }
}

// Returns set of field keys that fail validation. Used by handleSubmit.
function collectFailingFields() {
  const failing = new Set();
  ['what', 'why', 'how'].forEach(field => {
    const cap = field.charAt(0).toUpperCase() + field.slice(1);
    const value = (document.getElementById('f' + cap) || {}).value || '';
    if (!QUALITY_CHECKS[field].every(c => c.test(value))) failing.add(field);
  });
  const objVal = document.getElementById('fObjective').value;
  const otherVal = (document.getElementById('fObjectiveOther') || {}).value || '';
  const objectiveOK = (objVal && objVal !== '__other__')
                  || (objVal === '__other__' && otherVal.trim());
  if (!objectiveOK) failing.add('objective');
  return failing;
}

function highlightFailingFields(failing) {
  ['what', 'why', 'how'].forEach(field => {
    const cap = field.charAt(0).toUpperCase() + field.slice(1);
    const input = document.getElementById('f' + cap);
    const checklist = document.getElementById('check' + cap);
    if (failing.has(field)) {
      input && input.classList.add('has-error');
      checklist && checklist.classList.add('show-failed');
    }
  });
  if (failing.has('objective')) {
    document.getElementById('fObjective').classList.add('has-error');
    const other = document.getElementById('fObjectiveOther');
    if (other && document.getElementById('fObjective').value === '__other__') {
      other.classList.add('has-error');
    }
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
  document.getElementById('fObjectiveOtherWrap').hidden = true;
  document.getElementById('formError').hidden = true;
  // Clear any error highlights from a prior failed attempt
  document.querySelectorAll('.has-error').forEach(el => el.classList.remove('has-error'));
  document.querySelectorAll('.quality-list.show-failed').forEach(el => el.classList.remove('show-failed'));
  renderChecklists(); // re-render so all items go back to unchecked
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

function populateObjectiveDropdown() {
  const sel = document.getElementById('fObjective');
  sel.innerHTML =
    '<option value="" disabled selected>— Select an objective —</option>' +
    STATE.objectives.map(o => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join('') +
    '<option value="__other__">Other (specify)…</option>';
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
    if (integrityFailures.length > 0) {
      showFormErrorList(integrityFailures);
    } else {
      showFormError('Please address the highlighted requirements before submitting.');
    }
    scrollToFirstFailing(allFailing);
    return;
  }

  const objSel = document.getElementById('fObjective').value;
  const objOther = document.getElementById('fObjectiveOther').value.trim();
  const isNew = objSel === '__other__';
  const objective = isNew ? objOther : objSel;

  const body = {
    token: AUTH.getToken() || 'mock-token',
    objective,
    objectiveIsNew: isNew,
    what: document.getElementById('fWhat').value.trim(),
    why:  document.getElementById('fWhy').value.trim(),
    how:  document.getElementById('fHow').value.trim()
  };

  if (CONFIG.USE_MOCK) {
    console.log('[MOCK] Would POST:', body);
    resetSubmitForm();
    celebrateSubmit();
    toast('Mock submit: row would be appended to Backlog');
    return;
  }

  const btn = document.getElementById('submitFormBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const data = await jsonpCall({ action: 'submit', ...body });
    if (!data.ok) throw new Error(data.error || 'submit failed');
    resetSubmitForm();
    celebrateSubmit();
    toast(`Idea submitted (row #${data.rowNumber} in Backlog tab). Thanks!`);
    fetchData(true); // force-refresh so the new backlog row appears immediately
  } catch (err) {
    showFormError(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Submit to backlog';
  }
}

function showFormError(msg) {
  const el = document.getElementById('formError');
  el.textContent = msg;
  el.hidden = false;
}

// Anti-cheat reasons: bullet list with the field name so the user knows what to fix.
function showFormErrorList(failures) {
  const el = document.getElementById('formError');
  el.innerHTML =
    '<strong>This doesn\'t read like a real submission.</strong>' +
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
