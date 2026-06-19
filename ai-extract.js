// ===== CLOUD AI EXTRACTION MODULE =====
// Reads lab/vital values from images using a multimodal AI model, as a more
// robust alternative to on-device Tesseract OCR (which struggles with screen
// photos / mixed report formats). Provider-flexible: Claude (default) + OpenAI.
//
// PRIVACY: in this mode the image(s) leave the device and are sent to the
// configured provider. The per-user API key lives only in this browser's
// localStorage and is sent only to that provider's endpoint. A consent gate
// (below) blocks any send until the user opts in. Offline (Tesseract) mode in
// ocr.js never calls anything here.

// ---- Storage keys ----
const AI_SETTINGS_KEY = 'fickcalc.ai';
const AI_CONSENT_KEY  = 'fickcalc.aiConsent';
const SCAN_MODE_KEY   = 'fickcalc.scanMode';

// ---- Structured-output schema (shared by both providers) ----
const FIELD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sao2:   { type: ['number', 'null'], description: 'Arterial O2 saturation: SaO2, SpO2/pulse-ox, or an explicitly ARTERIAL sample. Percent.' },
    svo2:   { type: ['number', 'null'], description: 'Mixed venous O2 saturation: SvO2, "SO2, Venous", PA/Swan/pulmonary-artery, mixed venous, or an explicitly VENOUS sample. Percent.' },
    hgb:    { type: ['number', 'null'], description: 'Hemoglobin (tHb / Hb / Hemoglobin). g/dL.' },
    hr:     { type: ['number', 'null'], description: 'Heart rate. bpm.' },
    weight: { type: ['number', 'null'], description: 'Body weight. kg.' },
    height: { type: ['number', 'null'], description: 'Height. cm.' },
    bsa:    { type: ['number', 'null'], description: 'Body surface area. m^2.' },
    vo2:    { type: ['number', 'null'], description: 'Oxygen consumption VO2. mL/min.' },
    notes:  { type: ['string', 'null'], description: 'Short note on anything ambiguous, e.g. which image was the arterial vs venous sample.' },
  },
  required: ['sao2', 'svo2', 'hgb', 'hr', 'weight', 'height', 'bsa', 'vo2'],
};

// Gemini uses a different (OpenAPI-subset) schema dialect: singular uppercase
// `type` plus `nullable: true`, instead of a `["x","null"]` type union.
// Derive it from FIELD_SCHEMA so the two can't drift apart.
function toGeminiSchema(schema) {
  const props = {};
  Object.entries(schema.properties).forEach(([key, def]) => {
    const types = Array.isArray(def.type) ? def.type : [def.type];
    const base  = types.find(t => t !== 'null') || types[0];
    props[key] = {
      type: base.toUpperCase(),
      ...(types.includes('null') ? { nullable: true } : {}),
      description: def.description,
    };
  });
  return { type: 'OBJECT', properties: props, required: schema.required };
}
const GEMINI_FIELD_SCHEMA = toGeminiSchema(FIELD_SCHEMA);

// ---- Per-provider defaults (model + endpoint) ----
const PROVIDER_DEFAULTS = {
  gemini: { model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
  claude: { model: 'claude-opus-4-8',  baseUrl: 'https://api.anthropic.com' },
  openai: { model: 'gpt-4o',           baseUrl: 'https://api.openai.com' },
};

const EXTRACTION_PROMPT = [
  'You are a careful clinical data-extraction assistant. You are given one or more photos or',
  'screenshots of lab reports, blood-gas / CO-oximetry printouts, or monitor screens.',
  'Extract ONLY the following values for a Fick cardiac-output calculation, reading them',
  'directly from the image(s):',
  '- sao2: arterial O2 saturation (SaO2, or SpO2/pulse-ox, or an explicitly ARTERIAL sample), %',
  '- svo2: mixed venous O2 saturation (SvO2; "SO2, Venous"; PA/Swan/pulmonary-artery; mixed venous; or an explicitly VENOUS sample), %',
  '- hgb: hemoglobin (tHb / Hb / Hemoglobin), g/dL',
  '- hr: heart rate, bpm',
  '- weight: kg ; height: cm ; bsa: m^2 ; vo2: mL/min',
  '',
  'Rules:',
  '- Distinguish ARTERIAL vs VENOUS saturations from the label / sample type. If a sample has only',
  '  Oxyhemoglobin (O2Hb) and no separate sO2, you may use O2Hb as that sample\'s saturation.',
  '- If separate arterial and venous images/samples are provided, combine them: arterial -> sao2, venous -> svo2.',
  '- Return the numeric value only (no units). Convert obvious unit variants to the target unit.',
  '- If a value is not clearly present and legible, return null. Do NOT guess or infer from reference ranges.',
  '- Use the notes field to flag anything ambiguous (e.g. which image was which sample).',
  'Return a single JSON object matching the schema.',
].join('\n');

// ---- Settings / consent / mode storage ----
function getAISettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}'); } catch (e) { s = {}; }
  return {
    provider: s.provider || 'gemini',
    apiKey:   s.apiKey   || '',
    model:    s.model    || '',
    baseUrl:  s.baseUrl  || '',
  };
}
function saveAISettings(obj) {
  try { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(obj)); } catch (e) {}
}
function getScanMode() {
  try { return localStorage.getItem(SCAN_MODE_KEY) || 'cloud'; } catch (e) { return 'cloud'; }
}
function setScanMode(mode) {
  try { localStorage.setItem(SCAN_MODE_KEY, mode); } catch (e) {}
}
function hasAIConsent() {
  try { return !!localStorage.getItem(AI_CONSENT_KEY); } catch (e) { return false; }
}
function grantAIConsent() {
  try { localStorage.setItem(AI_CONSENT_KEY, new Date().toISOString()); } catch (e) {}
}
function providerLabel(provider) {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'gemini') return 'Google Gemini';
  if (provider === 'claude') return 'Claude (Anthropic)';
  return 'the configured AI provider';
}

// ---- Image prep for AI (no binarization; AI handles photos/moiré natively) ----
function prepImageForAI(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 2200; // long-edge cap: accuracy without huge payloads
        const long = Math.max(img.width, img.height) || 1;
        const scale = long > MAX ? MAX / long : 1;
        const w = Math.max(1, Math.round(img.width  * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h); // flatten transparency
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob(blob => {
          if (!blob) { reject(new Error('image encode failed')); return; }
          const r = new FileReader();
          r.onload = () => {
            const dataUrl = String(r.result);
            resolve({ mediaType: 'image/jpeg', base64: dataUrl.split(',')[1] || '', dataUrl });
          };
          r.onerror = () => reject(new Error('image read failed'));
          r.readAsDataURL(blob);
        }, 'image/jpeg', 0.9);
      } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

// ---- Response parsing + sanity ----
function parseModelJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) {}
  const m = text.match(/\{[\s\S]*\}/); // recover a JSON object wrapped in prose
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}
function sanitizeFound(obj) {
  const found = {};
  ['sao2', 'svo2', 'hgb', 'hr', 'weight', 'height', 'bsa', 'vo2'].forEach(k => {
    let v = obj ? obj[k] : null;
    if (v === null || v === undefined || v === '') return;
    v = parseFloat(v);
    if (isNaN(v)) return;
    // Reuse ocr.js SANITY bounds to drop implausible reads before review.
    if (typeof SANITY !== 'undefined' && SANITY[k] && !SANITY[k](v)) return;
    found[k] = v;
  });
  return found;
}

async function apiError(res, name) {
  let detail = '';
  try { const j = await res.json(); detail = (j.error && (j.error.message || j.error.type)) || ''; } catch (e) {}
  if (res.status === 401) return new Error(`${name}: invalid API key (401). Check it in Settings.`);
  if (res.status === 429) return new Error(`${name}: rate limited (429). Wait and retry.`);
  return new Error(`${name} request failed (${res.status})${detail ? ': ' + detail : ''}`);
}

// ---- Provider adapters ----
async function claudeAdapter(images, settings) {
  const d     = PROVIDER_DEFAULTS.claude;
  const base  = (settings.baseUrl || d.baseUrl).replace(/\/+$/, '');
  const model = settings.model || d.model;
  const content = images.map(im => ({
    type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.base64 },
  }));
  content.push({ type: 'text', text: 'Extract the values as specified and return the JSON object.' });
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: EXTRACTION_PROMPT,
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: FIELD_SCHEMA } },
    }),
  });
  if (!res.ok) throw await apiError(res, 'Claude');
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { parsed: parseModelJSON(text), raw: data };
}

async function openaiAdapter(images, settings) {
  const d     = PROVIDER_DEFAULTS.openai;
  const base  = (settings.baseUrl || d.baseUrl).replace(/\/+$/, '');
  const model = settings.model || d.model;
  const content = images.map(im => ({ type: 'image_url', image_url: { url: im.dataUrl } }));
  content.push({ type: 'text', text: 'Extract the values as specified and return the JSON object.' });
  const res = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + settings.apiKey },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'fick_values', schema: FIELD_SCHEMA },
      },
    }),
  });
  if (!res.ok) throw await apiError(res, 'OpenAI');
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  return { parsed: parseModelJSON(text), raw: data };
}

// Google Gemini (AI Studio). Free tier: rate-limited but no cost; auth is a
// plain API key on the URL (?key=...), not a header. Verify current free-tier
// model availability/limits at https://ai.google.dev/ if this default model
// stops working — Google updates these over time.
async function geminiAdapter(images, settings) {
  const d     = PROVIDER_DEFAULTS.gemini;
  const base  = (settings.baseUrl || d.baseUrl).replace(/\/+$/, '');
  const model = settings.model || d.model;
  const parts = images.map(im => ({ inline_data: { mime_type: im.mediaType, data: im.base64 } }));
  parts.push({ text: 'Extract the values as specified and return the JSON object.' });
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema: GEMINI_FIELD_SCHEMA,
      },
    }),
  });
  if (!res.ok) throw await apiError(res, 'Gemini');
  const data = await res.json();
  const respParts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = respParts.map(p => p.text || '').join('\n');
  return { parsed: parseModelJSON(text), raw: data };
}

async function extractWithAI(images, settings) {
  if (!settings.apiKey) throw new Error('No API key set. Open Settings and paste your key.');
  if (!images.length) throw new Error('No images to read.');
  const provider = (settings.provider || 'gemini').toLowerCase();
  const result = provider === 'openai' ? await openaiAdapter(images, settings)
               : provider === 'gemini' ? await geminiAdapter(images, settings)
               : await claudeAdapter(images, settings);
  return {
    found: sanitizeFound(result.parsed),
    warning: result.parsed && result.parsed.notes ? String(result.parsed.notes) : null,
    raw: result.raw,
  };
}

// ===== UI: mode toggle / settings panel / consent gate =====
function setScanModeUI(mode) {
  setScanMode(mode);
  document.querySelectorAll('.ocr-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const hint  = $('ocr-hint');
  const label = $('ocr-scan-all-label');
  if (mode === 'cloud') {
    const p = providerLabel(getAISettings().provider);
    if (hint)  hint.textContent  = `Add one or more images, then Scan with AI. Images are sent to ${p} to read the values.`;
    if (label) label.textContent = 'Scan with AI';
  } else {
    if (hint)  hint.textContent  = 'Add one or more images, then Scan. Runs entirely on your device — nothing is sent anywhere.';
    if (label) label.textContent = 'Scan (offline)';
  }
}

function applyProviderPlaceholders() {
  const d = PROVIDER_DEFAULTS[$('ai-provider').value] || PROVIDER_DEFAULTS.gemini;
  $('ai-model').placeholder   = d.model;
  $('ai-baseurl').placeholder = d.baseUrl;
}

function openAISettings(focusKey) {
  const s = getAISettings();
  $('ai-provider').value = s.provider;
  $('ai-key').value      = s.apiKey;
  $('ai-model').value    = s.model;
  $('ai-baseurl').value  = s.baseUrl;
  applyProviderPlaceholders();
  $('ocr-settings-panel').style.display = '';
  [1, 2, 3].forEach(i => { $('ocr-step-' + i).style.display = 'none'; });
  $('ocr-consent').style.display = 'none';
  if (focusKey && !s.apiKey) setTimeout(() => $('ai-key').focus(), 50);
}
function closeAISettings() {
  $('ocr-settings-panel').style.display = 'none';
  showOCRStep(1);
}
function saveAISettingsFromUI() {
  saveAISettings({
    provider: $('ai-provider').value,
    apiKey:   $('ai-key').value.trim(),
    model:    $('ai-model').value.trim(),
    baseUrl:  $('ai-baseurl').value.trim(),
  });
  setScanModeUI(getScanMode()); // refresh provider name in the hint
  closeAISettings();
}

let _consentOnAccept = null;
function openAIConsent(onAccept) {
  _consentOnAccept = onAccept || null;
  const p = providerLabel(getAISettings().provider);
  const txt = $('ocr-consent-provider');
  if (txt) txt.textContent = p;
  $('ocr-consent').style.display = '';
  [1, 2, 3].forEach(i => { $('ocr-step-' + i).style.display = 'none'; });
  $('ocr-settings-panel').style.display = 'none';
}
function closeAIConsent() {
  $('ocr-consent').style.display = 'none';
  showOCRStep(1);
}

// Wire up the AI controls; called from initOCR() in ocr.js.
function initAIControls() {
  const gear = $('ocr-settings-btn');
  if (gear) gear.addEventListener('click', () => openAISettings(false));

  const providerSel = $('ai-provider');
  if (providerSel) providerSel.addEventListener('change', applyProviderPlaceholders);

  document.querySelectorAll('.ocr-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setScanModeUI(btn.dataset.mode));
  });

  const save = $('ai-settings-save');   if (save)   save.addEventListener('click', saveAISettingsFromUI);
  const cancel = $('ai-settings-cancel'); if (cancel) cancel.addEventListener('click', closeAISettings);

  const cAccept = $('ocr-consent-accept');
  if (cAccept) cAccept.addEventListener('click', () => {
    grantAIConsent();
    const cb = _consentOnAccept; _consentOnAccept = null;
    closeAIConsent();
    if (cb) cb();
  });
  const cCancel = $('ocr-consent-cancel');
  if (cCancel) cCancel.addEventListener('click', closeAIConsent);

  setScanModeUI(getScanMode()); // initial state
}
