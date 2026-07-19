// ===== STATE =====
let vo2Mode = 'estimate';
let bsaMode = 'bsa';
let ageGroup = 'young'; // 'young' = < 70 (VO₂ = 125×BSA), 'elderly' = ≥ 70 (VO₂ = 110×BSA)
let ocrExtracted = {}; // legacy — state now in ocr.js imageQueue

// ===== DOM REFS =====
const $ = id => document.getElementById(id);

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  initSegControls();
  initVO2Mode();
  initBSAMode();
  initCalculator();
  initOCR();
  addLivePreview();
  initMobileTabs();
  initMobileActionBar();
  initRefToggle();
  initStartPopup();
  showStartPopup();
});

// ===== SEGMENTED CONTROLS =====
function initSegControls() {
  // Age group — a radiogroup with roving tabindex: it's a single Tab stop in the
  // streamlined entry flow, but still switchable via Arrow keys or click.
  const ageBtns = Array.from($('age-ctrl').querySelectorAll('.seg-btn'));
  function selectAge(btn, focus) {
    ageBtns.forEach(b => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    ageGroup = btn.dataset.val;
    updateVO2Preview();
    maybeAutoCalc();
    if (focus) btn.focus();
  }
  ageBtns.forEach(btn => btn.addEventListener('click', () => selectAge(btn, false)));
  $('age-ctrl').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const idx = ageBtns.findIndex(b => b.classList.contains('active'));
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
    selectAge(ageBtns[(idx + dir + ageBtns.length) % ageBtns.length], true);
  });

  // BSA mode
  $('bsa-mode-ctrl').querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('bsa-mode-ctrl').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bsaMode = btn.dataset.val;
      $('height-input-wrap').style.display = bsaMode === 'height' ? '' : 'none';
      $('bsa-input-wrap').style.display   = bsaMode === 'bsa'    ? '' : 'none';
      const lbl = $('bsa-height-label');
      lbl.innerHTML = bsaMode === 'height'
        ? 'Height / Weight <span class="label-hint">optional — for CO</span>'
        : 'BSA <span class="unit">(m²)</span><span class="label-hint">optional — for CO</span>';
      updateVO2Preview();
      maybeAutoCalc();
    });
  });
}

// ===== VO2 MODE =====
function initVO2Mode() {
  $('vo2-mode-ctrl').querySelectorAll('.seg-btn-full').forEach(btn => {
    btn.addEventListener('click', () => {
      $('vo2-mode-ctrl').querySelectorAll('.seg-btn-full').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      vo2Mode = btn.dataset.val;
      $('vo2-estimated-section').style.display = vo2Mode === 'estimate' ? '' : 'none';
      $('vo2-measured-section').style.display  = vo2Mode === 'measured' ? '' : 'none';
      maybeAutoCalc();
    });
  });
}

// ===== BSA MODE =====
function initBSAMode() {
  $('height-input-wrap').style.display = 'none';
  $('bsa-input-wrap').style.display = '';
}

// ===== LIVE VO2 PREVIEW =====
function addLivePreview() {
  ['weight','height','bsa-direct'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('input', updateVO2Preview);
  });
}

function updateVO2Preview() {
  if (vo2Mode !== 'estimate') return;
  const bsa = getBSA();
  if (!bsa || bsa <= 0) {
    $('vo2-preview-val').textContent = '—';
    return;
  }
  // ageGroup drives the coefficient: elderly (≥70) → 110, otherwise 125
  const age = ageGroup === 'elderly' ? 70 : 50;
  const vo2 = calcVO2(age, bsa);
  $('vo2-preview-val').textContent = isFinite(vo2) ? vo2.toFixed(1) : '—';
}

// ===== FORMULAS =====
function getBSA() {
  if (bsaMode === 'bsa') {
    return parseFloat($('bsa-direct').value) || null;
  }
  const w = parseFloat($('weight').value);
  const h = parseFloat($('height').value);
  if (!w || !h || w <= 0 || h <= 0) return null;
  return calcBSA(w, h);
}

function calcBSA(weight, height) {
  // Standard formula: BSA = √(Height cm × Weight kg / 3600)
  return Math.sqrt((height * weight) / 3600);
}

function calcVO2(age, bsa) {
  // 125 mL O2/min × BSA; 110 × BSA for elderly (age ≥ 70)
  const k = (age >= 70) ? 110 : 125;
  return k * bsa;
}

function calcFick({ vo2, sao2, svo2, hgb }) {
  // O2 content (mL O2 per dL blood): CxO2 = 1.34 × Hb × SxO2  (sats as fractions)
  const HUFNER = 1.34;                    // mL O2 carried per g of hemoglobin
  const sao2f  = sao2 / 100;
  const svo2f  = svo2 / 100;
  const cao2   = HUFNER * hgb * sao2f;    // arterial O2 content, mL/dL
  const cvo2   = HUFNER * hgb * svo2f;    // venous O2 content, mL/dL
  const avdO2  = cao2 - cvo2;             // arteriovenous O2 difference, mL/dL
  if (avdO2 <= 0) return null;
  // CO (L/min) = VO2 (mL/min) / [AVDO2 (mL/dL) × 10 dL/L]
  const co     = vo2 / (avdO2 * 10);      // L/min
  return { co, cao2, cvo2, avdO2 };
}

// ===== CALCULATOR =====
function initCalculator() {
  $('calc-btn').addEventListener('click', calculate);
  $('reset-btn').addEventListener('click', reset);
  // Pressing Enter in any value field submits — keeps the keyboard entry flow fast
  // (finish at SaO₂, hit Enter; tabbing to the Calculate button still works too).
  ['bsa-direct', 'hgb', 'svo2', 'sao2', 'vo2-direct', 'height', 'weight'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); calculate(); }
    });
    // Live auto-calculate: CI appears as soon as the core values are valid, and
    // entering BSA (or switching VO₂ inputs) upgrades the output in place.
    el.addEventListener('input', maybeAutoCalc);
  });
}

// ===== START POPUP =====
// A one-button "Begin entry" gate shown on load and after Reset. It launches the
// keyboard-first flow: pressing Enter (the button is autofocused) closes it and
// focuses the first field (age group).
function initStartPopup() {
  $('start-begin-btn')?.addEventListener('click', beginEntry);
  $('start-overlay')?.addEventListener('keydown', e => {
    if (e.key === 'Escape') beginEntry();
  });
}
function showStartPopup() {
  const overlay = $('start-overlay');
  if (!overlay) return;
  overlay.classList.add('open');
  setTimeout(() => $('start-begin-btn')?.focus(), 0);
}
function beginEntry() {
  $('start-overlay')?.classList.remove('open');
  // Focus the first field of the fast path — Hemoglobin. The three core values
  // (Hgb → SvO₂ → SaO₂) follow in DOM/tab order and auto-produce the cardiac index.
  $('hgb')?.focus();
}

// Accepted clinical input ranges (mirror the HTML min/max). Values outside
// these are rejected so bad input (0, negatives, typos) can't produce
// Infinity/NaN results — e.g. BSA 0 → CI Infinity.
const INPUT_RANGES = {
  sao2:         [20, 100],  // sat bounds mirror ocr.js SANITY (keep in sync)
  svo2:         [10, 100],
  hgb:          [1, 25],
  weight:       [1, 300],
  height:       [50, 250],
  'bsa-direct': [0.5, 3.5],
  'vo2-direct': [50, 2000],
};

// --- Pure field predicates (no DOM mutation) — shared by loud validate() and
//     the silent auto-calc gate. A field is valid when it's a number within its
//     range; an empty field is valid only when not required.
function fieldEmpty(id) { const el = $(id); return !el || !el.value; }
function fieldOutOfRange(id) {
  const el = $(id); if (!el) return false;
  const v = parseFloat(el.value); const range = INPUT_RANGES[id];
  return !!range && !isNaN(v) && (v < range[0] || v > range[1]);
}
function fieldValid(id, requirePresent) {
  if (fieldEmpty(id)) return !requirePresent;
  const v = parseFloat($(id).value);
  if (isNaN(v)) return false;
  return !fieldOutOfRange(id);
}

// Loud check on one field: apply error/shake styling + range hint. Returns validity.
function checkField(id, requirePresent) {
  const el = $(id);
  if (!el) return true;
  const ok = fieldValid(id, requirePresent);
  if (ok) {
    el.classList.remove('error');
    el.removeAttribute('title');
  } else {
    el.classList.add('error', 'shake');
    if (fieldOutOfRange(id)) { const r = INPUT_RANGES[id]; el.title = `Expected ${r[0]}–${r[1]}`; }
    setTimeout(() => el.classList.remove('shake'), 500);
  }
  return ok;
}

// Loud validation for the explicit Calculate action. BSA is optional now:
// only the three core values (and VO₂ in measured mode) are required.
function validate() {
  let valid = true;
  ['sao2', 'svo2', 'hgb'].forEach(id => { if (!checkField(id, true)) valid = false; });
  if (vo2Mode === 'measured' && !checkField('vo2-direct', true)) valid = false;
  if (bsaMode === 'bsa') {
    if (!checkField('bsa-direct', false)) valid = false;          // optional; range-check if present
  } else {
    // Height mode: one value alone can't yield BSA, so if either is present require both.
    const requireBoth = !fieldEmpty('height') || !fieldEmpty('weight');
    if (!checkField('height', requireBoth)) valid = false;
    if (!checkField('weight', requireBoth)) valid = false;
  }
  return valid;
}

// Silent gate for auto-calc: are the inputs sufficient to compute (no styling)?
function inputsReadyForAutoCalc() {
  if (!['sao2', 'svo2', 'hgb'].every(id => fieldValid(id, true))) return false;
  if (vo2Mode === 'measured' && !fieldValid('vo2-direct', true)) return false;
  // Any entered BSA field must itself be valid (a bad BSA shouldn't yield a CO).
  if (bsaMode === 'bsa') return fieldValid('bsa-direct', false);
  return fieldValid('height', false) && fieldValid('weight', false);
}

// Pure math → result object. BSA is optional: we compute at a baseline BSA of 1
// when none is given. In estimate mode BSA cancels out of CI (CI = k / (AVDO₂×10)),
// so the CI is exact regardless; CO only becomes meaningful once a real BSA is known.
function computeResults() {
  const age      = ageGroup === 'elderly' ? 70 : 50;  // proxy — only picks 110 vs 125
  const sao2     = parseFloat($('sao2').value);
  const svo2     = parseFloat($('svo2').value);
  const hgb      = parseFloat($('hgb').value);
  const realBSA  = getBSA();          // null when the user hasn't entered it
  const bsa      = realBSA || 1;      // baseline placeholder
  const hasBSA   = !!realBSA;
  const measured = vo2Mode === 'measured';

  const vo2  = measured ? parseFloat($('vo2-direct').value) : calcVO2(age, bsa);
  const fick = calcFick({ vo2, sao2, svo2, hgb });
  if (!fick) return null;

  const { co, cao2, cvo2, avdO2 } = fick;
  const ci    = co / bsa;
  const o2ext = ((cao2 - cvo2) / cao2) * 100;

  // Display rules: CO is real when measured || hasBSA; CI when estimate || hasBSA.
  const coShown = measured || hasBSA;
  const ciShown = !measured || hasBSA;

  return { co, ci, bsa, hasBSA, vo2, cao2, cvo2, avdO2, o2ext, coShown, ciShown };
}

// Explicit action (button / Enter): loud validation, alert on impossible input,
// and navigate to the results (tab switch on mobile, scroll on desktop).
function calculate() {
  if (!validate()) return;
  const r = computeResults();
  if (!r) {
    alert('AV O₂ difference is zero or negative. Check SaO₂ and SvO₂ values.');
    return;
  }
  displayResults(r, { navigate: true });
}

// Live auto-calculate as the user types. Silent: no styling, no alert, and it
// never yanks the mobile view to the results tab — it just updates + flags ready.
function maybeAutoCalc() {
  if (!inputsReadyForAutoCalc()) return;
  const r = computeResults();
  if (!r) return;
  displayResults(r, { navigate: false });
}

function displayResults(r, { navigate = true } = {}) {
  const { co, ci, bsa, hasBSA, vo2, cao2, cvo2, avdO2, o2ext, coShown, ciShown } = r;
  const DASH = '—';

  $('results-placeholder').style.display = 'none';
  $('results-content').style.display = '';

  // Cardiac index is the hero; cardiac output is secondary and shows "—" until knowable.
  $('ci-val').textContent = ciShown ? ci.toFixed(2) : DASH;
  $('co-val').textContent = coShown ? co.toFixed(2) : DASH;
  $('bsa-val').textContent = hasBSA ? bsa.toFixed(2) : DASH;
  $('vo2-result-val').textContent = coShown ? vo2.toFixed(1) : DASH;   // VO₂ tracks CO availability
  $('cao2-val').textContent = cao2.toFixed(2);
  $('cvo2-val').textContent = cvo2.toFixed(2);
  $('avdo2-val').textContent = avdO2.toFixed(2);
  $('o2ext-val').textContent = o2ext.toFixed(1);

  // Range reference labels
  $('ci-range').textContent = 'Normal: 2.5–4 L/min/m²';
  $('co-range').textContent = 'Normal: 4–8 L/min';

  // Gauge reflects the hero (CI): map CI 0–6 → 0–100%.
  const gauge = $('co-gauge');
  if (gauge) gauge.style.width = ciShown ? Math.min(Math.max((ci / 6) * 100, 2), 100) + '%' : '0%';

  // Status
  const banner = $('status-banner');
  const { cls, label, detail, interp } = interpret(r);
  banner.className = 'status-banner ' + cls;
  $('status-label').textContent = label;
  $('status-detail').textContent = detail;
  $('interp-body').innerHTML = interp;

  // Navigation is reserved for the explicit action. Auto-calc (navigate:false)
  // updates silently and, on mobile, just lights the "results ready" badge.
  if (isMobile()) {
    $('tab-result-badge').style.display = '';
    if (navigate) switchTab('results-panel');
  } else if (navigate) {
    $('results-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function interpret(r) {
  const { co, ci, o2ext, coShown, ciShown } = r;
  let cls, label;
  const lines = [];

  // Detail line leads with CI (the hero), CO second — either may be "—".
  const ciStr = ciShown ? ci.toFixed(2) : '—';
  const coStr = coShown ? co.toFixed(2) : '—';
  const detail = `CI ${ciStr} L/min/m² · CO ${coStr} L/min`;

  if (!ciShown) {
    // Measured VO₂ mode without BSA: CO is known but the index can't be graded.
    cls = 'normal'; label = 'Cardiac Output Only';
    lines.push('<p>ℹ️ <strong>Cardiac index needs BSA.</strong> Enter BSA (or height &amp; weight) to grade the cardiac index; cardiac output is shown above.</p>');
  } else if (ci < 1.8) {
    cls = 'critical'; label = 'Severe Low Output';
    lines.push('<p>⚠️ <strong>Critically reduced cardiac index</strong> (&lt;1.8 L/min/m²) — consistent with cardiogenic shock. Urgent hemodynamic support may be required.</p>');
  } else if (ci < 2.5) {
    cls = 'low'; label = 'Reduced Cardiac Index';
    lines.push('<p>⚠️ <strong>Reduced cardiac index</strong> (1.8–2.5 L/min/m²) — consider heart failure, hypovolemia, or tamponade.</p>');
  } else if (ci <= 4.0) {
    cls = 'normal'; label = 'Normal Cardiac Index';
    lines.push('<p>✅ <strong>Cardiac index within normal range</strong> (2.5–4.0 L/min/m²).</p>');
  } else {
    cls = 'high'; label = 'Elevated Cardiac Index';
    lines.push('<p>ℹ️ <strong>Elevated cardiac index</strong> (&gt;4.0 L/min/m²) — consider high-output states: sepsis, anemia, thyrotoxicosis, AV fistula.</p>');
  }

  // O₂ extraction is BSA-independent, so it's meaningful whenever we have results.
  if (o2ext > 35) lines.push('<p>🔴 <strong>High O₂ extraction</strong> (' + o2ext.toFixed(1) + '%) — tissues are extracting more oxygen to compensate for reduced delivery (DO₂/VO₂ mismatch).</p>');
  else if (o2ext < 20) lines.push('<p>🔵 <strong>Low O₂ extraction</strong> (' + o2ext.toFixed(1) + '%) — may indicate distributive shunting (e.g. sepsis) or high cardiac output.</p>');

  return { cls, label, detail, interp: lines.join('') };
}

function reset() {
  ['age','weight','height','sao2','svo2','hgb','vo2-direct','bsa-direct'].forEach(id => {
    const el = $(id);
    if (el) { el.value = ''; el.classList.remove('error'); el.removeAttribute('title'); }
  });
  // Restore segmented controls to their defaults (young / BSA / estimate);
  // clicking re-runs each handler so module state + input visibility reset too.
  $('age-young-btn')?.click();
  $('bsa-direct-btn')?.click();
  $('vo2-estimate-btn')?.click();
  $('vo2-preview-val').textContent = '—';
  $('results-placeholder').style.display = '';
  $('results-content').style.display = 'none';
  // Clear stale result UI (gauge fill + mobile results-ready badge)
  const gauge = $('co-gauge'); if (gauge) gauge.style.width = '0%';
  const badge = $('tab-result-badge'); if (badge) badge.style.display = 'none';
  // On mobile, switch back to inputs tab
  if (isMobile()) switchTab('inputs-panel');
  // Re-show the start popup so the next entry begins from the same keyboard flow
  showStartPopup();
}

// ===== MOBILE UTILITIES =====
function isMobile() { return window.innerWidth <= 640; }

// ===== MOBILE TABS =====
let activePanel = 'inputs-panel';

function initMobileTabs() {
  const tabs = document.querySelectorAll('.mobile-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.panel));
  });
}

function switchTab(panelId) {
  if (!isMobile()) return;
  activePanel = panelId;

  // Update tab buttons
  document.querySelectorAll('.mobile-tab').forEach(t => {
    const active = t.dataset.panel === panelId;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active);
  });

  // Show/hide panels
  const inputs  = document.querySelector('.inputs-panel');
  const results = $('results-panel');
  inputs.classList.toggle('panel-hidden',  panelId !== 'inputs-panel');
  results.classList.toggle('panel-hidden', panelId !== 'results-panel');

  // Scroll to top of panel
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== MOBILE ACTION BAR =====
function initMobileActionBar() {
  const mobCalc  = $('mob-calc-btn');
  const mobReset = $('mob-reset-btn');
  const mobScan  = $('mob-scan-btn');
  if (mobCalc)  mobCalc.addEventListener('click',  calculate);
  if (mobReset) mobReset.addEventListener('click',  reset);
  if (mobScan)  mobScan.addEventListener('click',   () => $('ocr-launch-btn').click());
}

// ===== REFERENCE TOGGLE =====
function initRefToggle() {
  const btn  = $('ref-toggle');
  const grid = $('ref-grid');
  if (!btn || !grid) return;

  // On desktop: show by default
  if (!isMobile()) {
    grid.style.display = '';
    btn.setAttribute('aria-expanded', 'true');
  }

  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    grid.style.display = open ? 'none' : 'grid';
  });
}

// ===== LAZY TESSERACT LOADER =====
let tesseractLoaded = false;
function ensureTesseract() {
  return new Promise((resolve, reject) => {
    if (typeof Tesseract !== 'undefined') { resolve(); return; }
    if (tesseractLoaded) { /* already injected, wait */ setTimeout(() => ensureTesseract().then(resolve, reject), 100); return; }
    tesseractLoaded = true;
    const script = document.createElement('script');
    // Self-hosted (vendor/) so OCR works fully offline — no CDN request.
    script.src = 'vendor/tesseract/tesseract.min.js';
    script.onload  = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}
