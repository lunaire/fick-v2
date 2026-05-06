// ===== OCR MODULE =====
// Multi-image scanning with conflict resolution
// Optimized for Epic EMR flowsheets AND GEM Premier ABG/CO-Oximetry printouts

// ---- Field definitions ----
const OCR_FIELDS = [
  { key: 'sao2',   label: 'Arterial SaO\u2082',    unit: '%',      },
  { key: 'svo2',   label: 'Mixed Venous SvO\u2082', unit: '%',      },
  { key: 'hgb',    label: 'Hemoglobin',          unit: 'g/dL',   },
  { key: 'hr',     label: 'Heart Rate',           unit: 'bpm',    },
  { key: 'weight', label: 'Weight',               unit: 'kg',     },
  { key: 'height', label: 'Height',               unit: 'cm',     },
  { key: 'bsa',    label: 'BSA',                  unit: 'm\u00b2',     },
  { key: 'vo2',    label: 'VO\u2082',                 unit: 'mL/min', },
];

// ---- Parsing patterns ----
// Supports three Epic layouts:
//   Format 1 (list):      "SO2, Venous          53.0  %"
//   Format 2 (reversed):  "53.0  SO2, Venous"
//   Format 3 (tabular):   "SO2, Venous | 04:00 | 53.0"  (| replaced by \n, 04:00 stripped)
const OCR_PATTERNS = {
  sao2: [
    // SpO2 (pulse ox) at bottom of Epic report → arterial sat
    /Sp[Oo]2\s+([\d]{2,3}(?:\.[\d]{1,2})?)\s*%?/i,
    // Standard labels
    /(?:S[pa]O2|SPO2|SAO2|Arterial\s*(?:O2\s*)?Sat(?:uration)?|Art\.?\s*Sat|O2\s*Sat\s*(?:Art|A\b)|SAT\s*ART)\s*[:\|]?\s*([\d]{1,3}(?:\.[\d]{1,2})?)\s*%?/i,
  ],
  svo2: [
    // Epic: "SO2, Venous" in all three formats (\s+ bridges stripped timestamp newline)
    /SO2[,\s]+Venous\s+([\d]{1,3}(?:\.[\d]{1,2})?)\s*%?/i,
    // Epic reversed: "53.0  SO2, Venous"
    /([\d]{1,3}(?:\.[\d]{1,2})?)\s+SO2[,\s]+Venous/i,
    // Epic: "Oxyhemoglobin, Venous" (fractional OxyHb)
    /Oxyhemoglobin[,\s]+Venous\s+([\d]{1,3}(?:\.[\d]{1,2})?)\s*%?/i,
    // Reversed: "51.7  Oxyhemoglobin, Venous"
    /([\d]{1,3}(?:\.[\d]{1,2})?)\s+Oxyhemoglobin[,\s]+Venous/i,
    // Generic SvO2 labels
    /(?:Sc?vO2|SCVO2|SVO2|Mixed\s*Venous(?:\s*O2\s*Sat)?|PA\s*(?:O2\s*)?Sat(?:uration)?|Venous\s*(?:O2\s*)?Sat|SAT\s*(?:VEN|MV|PA|SVC|IVC)|SvO2\s*(?:PA|Fick|MV)?)\s*[:\|]?\s*([\d]{1,3}(?:\.[\d]{1,2})?)\s*%?/i,
    /(?:PA\s*line|Swan|Pulmon)\b.*?([\d]{2,3})\s*%/i,
  ],
  hgb: [
    // Epic: "Hemoglobin, Venous" all formats
    /Hemoglobin[,\s]+Venous\s+([\d]{1,2}(?:\.[\d]{1,2})?)\s*(?:g\/d[Ll])?/i,
    // Reversed: "7.9  Hemoglobin, Venous"
    /([\d]{1,2}(?:\.[\d]{1,2})?)\s+Hemoglobin[,\s]+Venous/i,
    // GEM tHb
    /\bt[Hh]b\s+([\d]{1,2}(?:\.[\d]{1,2})?)\s*(?:g\/d[Ll])?/i,
    // Generic Hgb/Hb
    /(?:H(?:gb|b|emoglobin)|HGB|HB)\s*[:\|]?\s*([\d]{1,2}(?:\.[\d]{1,2})?)\s*(?:g\/d[Ll]|gm\/dL)?/i,
    /\bH(?:gb|b)\b\s+([\d]{1,2}(?:\.[\d])?)/i,
  ],
  hr: [
    // Must require "Heart" before "Rate" — bare "Rate" is respiratory rate in Epic
    /(?:Heart\s*Rate|HR|Pulse\s*Rate)\s*[:\|]?\s*([\d]{2,3})\s*(?:bpm|\/min)?/i,
    /\bHR\b\s+([\d]{2,3})\b/i,
  ],
  weight: [
    // Epic: "Last Weight  56.2 kg"
    /Last\s+Weight\s*[:\|]?\s*([\d]{2,3}(?:\.[\d]{1,2})?)\s*(?:kg|KG)/i,
    /(?:Wt\.?|Weight|WT|WEIGHT)\s*[:\|]?\s*([\d]{2,3}(?:\.[\d]{1,2})?)\s*(?:kg|KG)?/i,
    /\b(?:Wt|Weight)\b\D{0,5}([\d]{2,3}(?:\.[\d])?)\s*kg/i,
  ],
  height: [
    /(?:Ht\.?|Height|HT|HEIGHT)\s*[:\|]?\s*([\d]{2,3}(?:\.[\d]{1,2})?)\s*(?:cm|CM)/i,
    /(?:Ht\.?|Height)\s*[:\|]?\s*([\d])'\s*([\d]{1,2})"?/i,
    /\b(?:Ht|Height)\b\D{0,5}([\d]{2,3}(?:\.[\d])?)\s*cm/i,
  ],
  bsa: [
    /(?:BSA|Body\s*Surface\s*Area)\s*[:\|]?\s*(\d(?:\.[\d]{1,3})?)\s*(?:m2|m\u00b2)?/i,
  ],
  vo2: [
    /(?:VO2|VO\u2082|O2\s*Cons(?:umption)?|Oxygen\s*Consumption|O2\s*uptake)\s*[:\|]?\s*([\d]{2,4}(?:\.[\d]{1,2})?)\s*(?:mL\/min|ml\/min)?/i,
  ],
};

const SANITY = {
  sao2:   v => v > 20  && v <= 100,
  svo2:   v => v > 10  && v <= 100,
  hgb:    v => v > 2   && v < 25,
  hr:     v => v >= 20 && v <= 300,
  weight: v => v >= 5  && v <= 300,
  height: v => v >= 50 && v <= 250,
  bsa:    v => v >= 0.5 && v <= 3.5,
  vo2:    v => v >= 50 && v <= 2000,
};

function feetToCm(feet, inches) {
  return Math.round((parseInt(feet) * 30.48) + (parseInt(inches || 0) * 2.54));
}

function detectSource(raw) {
  if (/GEM|Premier|tHb|CO-Oxim|COHb|MetHb/i.test(raw))           return 'gem';
  if (/Venous\s*Blood\s*Gas|Blood\s*Gas\s*Veno|SO2[,\s]+Venous|Hemoglobin[,\s]+Venous|Oxyhemoglobin/i.test(raw)) return 'epic-vbg';
  if (/Epic|Flowsheet|iView|MAR|Synopsis/i.test(raw))              return 'epic';
  return 'generic';
}

function detectGEMSampleType(raw) {
  const m = raw.match(/Sample\s*Type\s*[:\|]?\s*(\w+)/i);
  if (!m) return null;
  const t = m[1].toLowerCase();
  if (t.includes('art')) return 'arterial';
  if (t.includes('ven') || t.includes('mix')) return 'venous';
  return null;
}

// preprocessOCRText is now inlined inside parseOCRText for multi-column support

// ===== MULTI-COLUMN DETECTION =====
// Detects Epic flowsheets with multiple time columns and extracts the most recent.
// Strategy: find all HH:MM timestamps BEFORE stripping them; if >1 unique time found,
// filter each label's value to only the one that follows the latest timestamp.
function resolveMultiColumn(pipedText) {
  // Find all HH:MM timestamps with positions
  const timeRe = /\b(\d{1,2}):(\d{2})\b/g;
  const allTimes = [];
  let m;
  while ((m = timeRe.exec(pipedText)) !== null) {
    const h = parseInt(m[1]), mn = parseInt(m[2]);
    if (h <= 23 && mn <= 59) allTimes.push({ str: m[0], total: h * 60 + mn, index: m.index });
  }

  const uniqueStrs = [...new Set(allTimes.map(t => t.str))];
  if (uniqueStrs.length <= 1) return { warning: null, text: pipedText };

  // Multiple timestamps found — find the latest
  const latestTotal = Math.max(...allTimes.map(t => t.total));
  const latestStr   = allTimes.find(t => t.total === latestTotal).str;

  // Split into lines; keep label lines always, keep value lines only when
  // they follow the latest timestamp (skip values after other timestamps).
  const timeLineRe = /^\s*(\d{1,2}):(\d{2})\s*$/;
  const lines = pipedText.split('\n');
  const out = [];
  let skipNext = false; // whether to skip the next value line

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tMatch = line.match(timeLineRe);
    if (tMatch) {
      const h = parseInt(tMatch[1]), mn = parseInt(tMatch[2]);
      const isLatest = (h * 60 + mn) === latestTotal;
      skipNext = !isLatest;
      // Don't emit the timestamp line itself (it gets stripped later)
    } else if (skipNext && /^\s*[\d.]+\s*$/.test(line)) {
      // This is a numeric value line following a non-latest timestamp — skip it
      skipNext = false;
    } else {
      skipNext = false;
      out.push(line);
    }
  }

  return {
    warning: `Multiple time columns detected. Using most recent: ${latestStr}. ` +
             `Other columns (${uniqueStrs.filter(s => s !== latestStr).join(', ')}) were ignored.`,
    text: out.join('\n'),
    resolvedTime: latestStr,
    allTimes: uniqueStrs,
  };
}

function parseOCRText(rawText) {
  // Step 1: pipe replacement + arrow stripping (before timestamp strip, so we can detect columns)
  const pipeReplaced = rawText
    .replace(/\r\n/g, '\n').replace(/\t/g, ' ')
    .replace(/[\u2191\u2193\u21D1\u21D3\u25b2\u25bc\u25b4\u25be]+/g, ' ')
    .replace(/\*/g, ' ')
    .replace(/\|/g, '\n');

  // Step 2: detect & resolve multi-column before stripping timestamps
  const multiResult = resolveMultiColumn(pipeReplaced);

  // Step 3: finish preprocessing on the (possibly filtered) text
  const text = multiResult.text
    .replace(/^[ \t]*\d{1,2}:\d{2}[ \t]*$/gm, '') // strip remaining standalone timestamps
    .replace(/[ ]{2,}/g, ' ')
    .replace(/(\d)O(\d)/g, '$10$2')
    .replace(/\u2082/g, '2')
    .replace(/[''`]/g, "'")
    .trim();

  const source = detectSource(rawText);
  const found  = {};
  let warning   = multiResult.warning;

  if (source === 'gem') {
    const sampleType = detectGEMSampleType(rawText);
    const tHbM = text.match(/\bt[Hh]b\s+([\d]{1,2}(?:\.[\d]{1,2})?)\s*(?:g\/d[Ll])?/i);
    if (tHbM) { const v = parseFloat(tHbM[1]); if (SANITY.hgb(v)) found.hgb = v; }
    const sO2M = text.match(/\bsO2\s+([\d]{1,3}(?:\.[\d]{1,2})?)\s*%?/i);
    if (sO2M) {
      const v = parseFloat(sO2M[1]);
      if (v > 20 && v <= 100) { sampleType === 'venous' ? (found.svo2 = v) : (found.sao2 = v); }
    }
    if (!found.sao2 && !found.svo2) {
      const o2hbM = text.match(/\bO2Hb\s+([\d]{1,3}(?:\.[\d]{1,2})?)\s*%?/i);
      if (o2hbM) {
        const v = parseFloat(o2hbM[1]);
        if (v > 20 && v <= 100) { sampleType === 'venous' ? (found.svo2 = v) : (found.sao2 = v); }
      }
    }
  }

  for (const [key, regexes] of Object.entries(OCR_PATTERNS)) {
    if (found[key] !== undefined) continue;
    for (const re of regexes) {
      const m = text.match(re);
      if (m) {
        if (key === 'height' && m[2] !== undefined) {
          found[key] = feetToCm(m[1], m[2]);
        } else {
          const val = parseFloat(m[1]);
          if (!isNaN(val) && SANITY[key] && SANITY[key](val)) found[key] = val;
        }
        if (found[key] !== undefined) break;
      }
    }
  }

  // If no timestamps but multiple values were expected, check with a broad pass
  // (only flag if we found no multi-column warning but multiple key fields empty)
  return { found, warning };
}

// ===== IMAGE QUEUE STATE =====
let imageQueue = [];  // [{ id, url, label, status, found }]
let queueIdCtr = 0;

// ===== MERGE & CONFLICT DETECTION =====
// Returns: { fieldKey: { value, conflict: false } | { conflict: true, options: [{value, label, imgIdx}] } }
function mergeResults(queue) {
  const merged = {};
  let globalWarning = null;
  OCR_FIELDS.forEach(({ key }) => {
    const sources = queue
      .filter(img => img.found && img.found[key] !== undefined)
      .map(img => ({ value: img.found[key], label: img.label }));
    if (sources.length === 0) return;
    const unique = [...new Set(sources.map(s => s.value))];
    if (unique.length === 1) {
      merged[key] = { value: unique[0], conflict: false };
    } else {
      merged[key] = { conflict: true, options: sources };
    }
  });
  // Collect per-image multi-column warnings
  const imgWarnings = queue.filter(img => img.warning).map(img => `${img.label}: ${img.warning}`);
  if (imgWarnings.length) globalWarning = imgWarnings.join(' | ');
  return { merged, globalWarning };
}

// ===== OCR UI =====
function initOCR() {
  const overlay   = $('ocr-overlay');
  const fileInput = $('ocr-file-input');

  $('ocr-launch-btn').addEventListener('click', () => {
    overlay.classList.add('open');
    showOCRStep(1);
  });
  $('ocr-close').addEventListener('click', closeOCR);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeOCR(); });

  $('ocr-camera-btn').addEventListener('click', () => {
    fileInput.setAttribute('capture', 'environment');
    fileInput.click();
  });
  $('ocr-upload-btn').addEventListener('click', () => {
    fileInput.removeAttribute('capture');
    fileInput.click();
  });

  fileInput.addEventListener('change', e => {
    const files = Array.from(e.target.files);
    files.forEach(file => addImageToQueue(file));
    fileInput.value = '';
  });

  $('ocr-scan-all-btn').addEventListener('click', scanAllImages);
  $('ocr-retry-btn').addEventListener('click', () => {
    // Go back to step 1 to add more images; keep existing queue
    showOCRStep(1);
  });
  $('ocr-apply-btn').addEventListener('click', applyOCRValues);
}

function closeOCR() {
  $('ocr-overlay').classList.remove('open');
}

function showOCRStep(n) {
  [1, 2, 3].forEach(i => {
    $('ocr-step-' + i).style.display = i === n ? '' : 'none';
  });
}

function addImageToQueue(file) {
  const id  = ++queueIdCtr;
  const url = URL.createObjectURL(file);
  const ext = file.name.split('.').pop().toUpperCase();
  const label = `Image ${id}`;
  const entry = { id, url, label, status: 'pending', found: {} };
  imageQueue.push(entry);
  renderQueue();
}

function renderQueue() {
  const list = $('ocr-queue-list');
  list.innerHTML = '';
  $('ocr-queue').style.display = imageQueue.length ? '' : 'none';
  $('ocr-scan-all-btn').style.display = imageQueue.length ? '' : 'none';
  $('ocr-queue-count').textContent = `${imageQueue.length} image${imageQueue.length !== 1 ? 's' : ''}`;

  imageQueue.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'ocr-queue-item';
    item.id = 'queue-item-' + entry.id;

    const statusClass = {
      pending:  'status-pending',
      scanning: 'status-scanning',
      done:     'status-done',
      error:    'status-error',
    }[entry.status] || 'status-pending';

    const statusText = {
      pending:  'Pending',
      scanning: 'Scanning…',
      done:     'Done',
      error:    'Error',
    }[entry.status] || 'Pending';

    item.innerHTML = `
      <img class="ocr-queue-thumb" src="${entry.url}" alt="${entry.label}" />
      <div class="ocr-queue-item-info">
        <span class="ocr-queue-item-label">${entry.label}</span>
        <span class="ocr-queue-item-status ${statusClass}">${statusText}</span>
        ${entry.status === 'done' ? `<span class="ocr-queue-item-found">${Object.keys(entry.found).length} field${Object.keys(entry.found).length !== 1 ? 's' : ''} found</span>` : ''}
      </div>
      ${entry.status === 'pending' ? `<button class="ocr-queue-remove" onclick="removeFromQueue(${entry.id})" title="Remove">✕</button>` : ''}
    `;
    list.appendChild(item);
  });
}

function removeFromQueue(id) {
  imageQueue = imageQueue.filter(e => e.id !== id);
  renderQueue();
}

async function scanAllImages() {
  if (!imageQueue.length) return;
  showOCRStep(2);

  const progressLabel = $('ocr-progress-label');
  const progressBar   = $('ocr-progress-bar');
  const batchStatus   = $('ocr-batch-status');

  try {
    // Ensure Tesseract.js is loaded (lazy-loaded on first use)
    await ensureTesseract();

    const worker = await Tesseract.createWorker('eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          progressBar.style.width = Math.round(m.progress * 100) + '%';
        }
      }
    });
    await worker.setParameters({ tessedit_pageseg_mode: '6' });

    for (let i = 0; i < imageQueue.length; i++) {
      const entry = imageQueue[i];
      entry.status = 'scanning';
      progressBar.style.width = '0%';
      progressLabel.textContent = `Scanning ${entry.label}…`;
      batchStatus.textContent   = `Image ${i + 1} of ${imageQueue.length}`;
      renderQueue();

      try {
        const { data: { text } } = await worker.recognize(entry.url);
        const result    = parseOCRText(text);
        entry.found     = result.found;
        entry.warning   = result.warning || null;
        entry.status    = 'done';
      } catch (err) {
        entry.status = 'error';
        console.error(`OCR error on ${entry.label}:`, err);
      }
    }

    await worker.terminate();

    const { merged, globalWarning } = mergeResults(imageQueue);
    renderOCRReview(merged, globalWarning);
    showOCRStep(3);

  } catch (err) {
    $('ocr-progress-label').textContent = 'OCR failed: ' + err.message;
    console.error(err);
  }
}

// ===== RENDER REVIEW WITH CONFLICT RESOLUTION =====
function renderOCRReview(merged, globalWarning) {
  const container = $('ocr-fields');
  container.innerHTML = '';
  let anyFound = false;

  // Show multi-column warning banner if present
  const warnEl = $('ocr-multicol-warning');
  if (warnEl) {
    if (globalWarning) {
      warnEl.style.display = '';
      warnEl.querySelector('.ocr-warning-text').textContent = globalWarning;
    } else {
      warnEl.style.display = 'none';
    }
  }

  OCR_FIELDS.forEach(({ key, label, unit }) => {
    const result   = merged[key];
    const detected = result !== undefined;
    if (detected) anyFound = true;

    const div = document.createElement('div');

    if (detected && result.conflict) {
      // --- CONFLICT CARD ---
      div.className = 'ocr-field ocr-field--conflict';
      let optionsHTML = result.options.map((opt, i) => `
        <label class="conflict-option">
          <input type="radio" name="conflict-${key}" value="${opt.value}" ${i === 0 ? 'checked' : ''} />
          <span class="conflict-option-val">${opt.value}</span>
          <span class="conflict-option-src">${opt.label}</span>
        </label>
      `).join('');
      div.innerHTML = `
        <div class="ocr-field-top">
          <div class="ocr-field-label">${label}</div>
          <div class="conflict-badge">CONFLICT</div>
        </div>
        <div class="conflict-options" id="conflict-opts-${key}">${optionsHTML}</div>
        <div class="ocr-field-unit">${unit}</div>
      `;
    } else if (detected) {
      // --- NORMAL DETECTED CARD ---
      div.className = 'ocr-field detected';
      div.innerHTML = `
        <div class="ocr-field-label">${label}</div>
        <input class="ocr-field-input" id="ocr-edit-${key}" type="number" value="${result.value}" step="any" />
        <div class="ocr-field-unit">${unit}</div>
      `;
    } else {
      // --- NOT FOUND CARD ---
      div.className = 'ocr-field';
      div.innerHTML = `
        <div class="ocr-field-label">${label}</div>
        <input class="ocr-field-input" id="ocr-edit-${key}" type="number" value="" placeholder="—" step="any" />
        <div class="ocr-field-unit">${unit}</div>
      `;
    }

    container.appendChild(div);
  });

  $('ocr-no-match').style.display  = anyFound ? 'none' : '';
  $('ocr-apply-btn').disabled      = !anyFound;
}

// ===== APPLY VALUES =====
function applyOCRValues() {
  const formMap = {
    sao2:   'sao2',
    svo2:   'svo2',
    hgb:    'hgb',
    hr:     'hr',
    weight: 'weight',
    height: 'height',
    bsa:    'bsa-direct',
    vo2:    'vo2-direct',
  };

  let hasBSA = false, hasHeight = false;

  OCR_FIELDS.forEach(({ key }) => {
    const formId = formMap[key];
    const formEl = $(formId);
    if (!formEl) return;

    let val = '';

    // Check if it's a conflict field (radio buttons)
    const conflictOpts = document.querySelector(`input[name="conflict-${key}"]:checked`);
    if (conflictOpts) {
      val = conflictOpts.value;
    } else {
      // Regular editable input
      const editEl = $('ocr-edit-' + key);
      if (editEl) val = editEl.value.trim();
    }

    if (val !== '') {
      formEl.value = val;
      formEl.classList.remove('error');
      if (key === 'bsa')    hasBSA    = true;
      if (key === 'height') hasHeight = true;
    }
  });

  // Auto-switch BSA/height mode
  if (hasBSA && !hasHeight) $('bsa-direct-btn').click();
  else if (hasHeight)        $('bsa-height-btn').click();

  // Auto-switch VO2 mode if direct VO2 found
  const vo2El = $('vo2-direct');
  if (vo2El && vo2El.value) $('vo2-measured-btn').click();

  updateVO2Preview();
  closeOCR();

  // Flash updated fields
  Object.values(formMap).forEach(id => {
    const el = $(id);
    if (el && el.value) {
      el.style.transition = 'background 0.3s';
      el.style.background = 'rgba(52,211,153,0.12)';
      setTimeout(() => { el.style.background = ''; }, 1400);
    }
  });

  // Reset queue for next session
  imageQueue = [];
  queueIdCtr = 0;
}
