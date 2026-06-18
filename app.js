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
});

// ===== SEGMENTED CONTROLS =====
function initSegControls() {
  // Age group
  $('age-ctrl').querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $('age-ctrl').querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ageGroup = btn.dataset.val;
      updateVO2Preview();
    });
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
        ? 'Height / Weight'
        : 'BSA <span class="unit">(m²)</span>';
      updateVO2Preview();
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
}

// Accepted clinical input ranges (mirror the HTML min/max). Values outside
// these are rejected so bad input (0, negatives, typos) can't produce
// Infinity/NaN results — e.g. HR 0 → SV Infinity, BSA 0 → CI Infinity.
const INPUT_RANGES = {
  hr:           [20, 300],
  sao2:         [20, 100],  // sat bounds mirror ocr.js SANITY (keep in sync)
  svo2:         [10, 100],
  hgb:          [1, 25],
  weight:       [1, 300],
  height:       [50, 250],
  'bsa-direct': [0.5, 3.5],
  'vo2-direct': [50, 2000],
};

function validate() {
  const required = ['hr','sao2','svo2','hgb'];
  if (bsaMode === 'height') required.push('weight','height');
  else required.push('bsa-direct');
  if (vo2Mode === 'measured') required.push('vo2-direct');

  let valid = true;
  required.forEach(id => {
    const el = $(id);
    if (!el) return;
    const v = parseFloat(el.value);
    const range = INPUT_RANGES[id];
    const outOfRange = range && (v < range[0] || v > range[1]);
    if (!el.value || isNaN(v) || outOfRange) {
      el.classList.add('error');
      el.classList.add('shake');
      if (outOfRange) el.title = `Expected ${range[0]}–${range[1]}`;
      setTimeout(() => el.classList.remove('shake'), 500);
      valid = false;
    } else {
      el.classList.remove('error');
      el.removeAttribute('title');
    }
  });
  return valid;
}

function calculate() {
  if (!validate()) return;

  const age  = ageGroup === 'elderly' ? 70 : 50;  // proxy value — only determines 110 vs 125
  const hr   = parseFloat($('hr').value);
  const sao2 = parseFloat($('sao2').value);
  const svo2 = parseFloat($('svo2').value);
  const hgb  = parseFloat($('hgb').value);
  const bsa  = getBSA();

  let vo2;
  if (vo2Mode === 'estimate') {
    vo2 = calcVO2(age, bsa);
  } else {
    vo2 = parseFloat($('vo2-direct').value);
  }

  const fick = calcFick({ vo2, sao2, svo2, hgb });
  if (!fick) {
    alert('AV O₂ difference is zero or negative. Check SaO₂ and SvO₂ values.');
    return;
  }

  const { co, cao2, cvo2, avdO2 } = fick;
  const ci  = co / bsa;
  const sv  = (co / hr) * 1000;
  const o2ext = ((cao2 - cvo2) / cao2) * 100;

  displayResults({ co, ci, sv, bsa, vo2, cao2, cvo2, avdO2, o2ext, hr });
}

function displayResults({ co, ci, sv, bsa, vo2, cao2, cvo2, avdO2, o2ext, hr }) {
  $('results-placeholder').style.display = 'none';
  $('results-content').style.display = '';

  $('co-val').textContent = co.toFixed(2);
  $('ci-val').textContent = ci.toFixed(2);
  $('sv-val').textContent = sv.toFixed(0);
  $('bsa-val').textContent = bsa.toFixed(2);
  $('vo2-result-val').textContent = vo2.toFixed(1);
  $('cao2-val').textContent = cao2.toFixed(2);
  $('cvo2-val').textContent = cvo2.toFixed(2);
  $('avdo2-val').textContent = avdO2.toFixed(2);
  $('o2ext-val').textContent = o2ext.toFixed(1);

  // CO range reference labels
  $('co-range').textContent = 'Normal: 4–8 L/min';
  $('ci-range').textContent = 'Normal: 2.5–4 L/min/m²';
  $('sv-range').textContent = 'Normal: 60–100 mL/beat';

  // Gauge: map CO 0-12 → 0-100%
  const gaugeWidth = Math.min(Math.max((co / 12) * 100, 2), 100);
  $('co-gauge').style.width = gaugeWidth + '%';

  // Status
  const banner = $('status-banner');
  const { cls, label, detail, interp } = interpret(co, ci, sv, o2ext);
  banner.className = 'status-banner ' + cls;
  $('status-label').textContent = label;
  $('status-detail').textContent = detail;
  $('interp-body').innerHTML = interp;

  // Scroll results into view on mobile, or switch tab
  if (isMobile()) {
    switchTab('results-panel');
    $('tab-result-badge').style.display = '';
  } else {
    $('results-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function interpret(co, ci, sv, o2ext) {
  let cls, label, detail;
  const lines = [];

  if (ci < 1.8) {
    cls = 'critical'; label = 'Severe Low Output'; detail = `CO ${co.toFixed(2)} L/min · CI ${ci.toFixed(2)} L/min/m²`;
    lines.push('<p>⚠️ <strong>Critically reduced cardiac index</strong> (&lt;1.8 L/min/m²) — consistent with cardiogenic shock. Urgent hemodynamic support may be required.</p>');
  } else if (ci < 2.5) {
    cls = 'low'; label = 'Reduced Cardiac Output'; detail = `CO ${co.toFixed(2)} L/min · CI ${ci.toFixed(2)} L/min/m²`;
    lines.push('<p>⚠️ <strong>Reduced cardiac index</strong> (1.8–2.5 L/min/m²) — consider heart failure, hypovolemia, or tamponade.</p>');
  } else if (ci <= 4.0) {
    cls = 'normal'; label = 'Normal Cardiac Output'; detail = `CO ${co.toFixed(2)} L/min · CI ${ci.toFixed(2)} L/min/m²`;
    lines.push('<p>✅ <strong>Cardiac index within normal range</strong> (2.5–4.0 L/min/m²).</p>');
  } else {
    cls = 'high'; label = 'Elevated Cardiac Output'; detail = `CO ${co.toFixed(2)} L/min · CI ${ci.toFixed(2)} L/min/m²`;
    lines.push('<p>ℹ️ <strong>Elevated cardiac index</strong> (&gt;4.0 L/min/m²) — consider high-output states: sepsis, anemia, thyrotoxicosis, AV fistula.</p>');
  }

  if (sv < 60) lines.push('<p>📉 <strong>Reduced stroke volume</strong> (&lt;60 mL/beat) — may reflect impaired contractility, dysrhythmia, or high afterload.</p>');
  else if (sv > 100) lines.push('<p>📈 <strong>Elevated stroke volume</strong> (&gt;100 mL/beat) — consistent with high-output state or athletic physiology.</p>');

  if (o2ext > 35) lines.push('<p>🔴 <strong>High O₂ extraction</strong> (' + o2ext.toFixed(1) + '%) — tissues are extracting more oxygen to compensate for reduced delivery (DO₂/VO₂ mismatch).</p>');
  else if (o2ext < 20) lines.push('<p>🔵 <strong>Low O₂ extraction</strong> (' + o2ext.toFixed(1) + '%) — may indicate distributive shunting (e.g. sepsis) or high cardiac output.</p>');

  return { cls, label, detail, interp: lines.join('') };
}

function reset() {
  ['age','weight','height','hr','sao2','svo2','hgb','vo2-direct','bsa-direct'].forEach(id => {
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
