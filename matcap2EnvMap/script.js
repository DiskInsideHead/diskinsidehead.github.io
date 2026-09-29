// srcData = what the generator samples: base matcap with all layers composited on top.
// baseData = the untouched base matcap pixels.
let srcData = null, srcW = 0, srcH = 0;
let baseData = null;
let compositeDirty = false;
let generatedFaces = null, generatedSize = 0;
let renderTimeout = null;
let genTimer = null;
let isBallInteracting = false;
let isSliderInteracting = false;

const MAX_LAYERS = 16;
const THUMB_PX = 128;      // thumbnail backing size (shown at 64 css px)

const generateBtn = document.getElementById('generateBtn');
const resultArea = document.getElementById('resultArea');
const appMain = document.getElementById('appMain');
const mainPlaceholder = document.getElementById('mainPlaceholder');
const baseSlotHost = document.getElementById('baseSlotHost');
const baseInfo = document.getElementById('baseInfo');
const baseName = document.getElementById('baseName');
const baseDims = document.getElementById('baseDims');
const layersContainer = document.getElementById('layersContainer');
const addLayerBtn = document.getElementById('addLayerBtn');

const rotXInput = document.getElementById('rotX');
const rotYInput = document.getElementById('rotY');
const rotZInput = document.getElementById('rotZ');
const ballController = document.getElementById('ballController');
const ballHandle = document.getElementById('ballHandle');

function showStatus(text, duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast show align-items-center text-bg-dark border-0 mb-2 shadow-sm';
    toast.role = 'alert';
    toast.innerHTML = `
        <div class="d-flex">
            <div class="toast-body py-2 px-3"></div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
        </div>
    `;
    // textContent: file names must never be interpreted as HTML.
    toast.querySelector('.toast-body').textContent = text;
    container.appendChild(toast);
    if (duration > 0) {
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// ------------------------------------------------------------------
// Image decoding / rasterizing
// ------------------------------------------------------------------
const isImageFile = f => !!f && (f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(f.name));
const closeBmp = b => { if (b && typeof b.close === 'function') b.close(); };

async function decodeImage(file) {
    if (!isImageFile(file)) {
        showStatus(`Error: "${file.name}" is not an image.`);
        return null;
    }
    try {
        return await createImageBitmap(file);
    } catch (e) {
        // Fallback for formats createImageBitmap refuses (e.g. SVG).
        try {
            const url = URL.createObjectURL(file);
            const img = await new Promise((res, rej) => {
                const i = new Image();
                i.onload = () => res(i);
                i.onerror = rej;
                i.src = url;
            });
            URL.revokeObjectURL(url);
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            return c;
        } catch (e2) {
            showStatus(`Error: can't read "${file.name}" as an image.`);
            return null;
        }
    }
}

// Draws any bitmap stretched to w×h and returns its RGBA pixels.
const scratchCanvas = document.createElement('canvas');
function rasterize(src, w, h) {
    scratchCanvas.width = w;
    scratchCanvas.height = h;
    const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
}

// ------------------------------------------------------------------
// Slots: square, click-or-drop image pickers with a cropped thumbnail
// ------------------------------------------------------------------
function drawCover(ctx, bmp, size) {
    const s = Math.max(size / bmp.width, size / bmp.height);
    const dw = bmp.width * s, dh = bmp.height * s;
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, (size - dw) / 2, (size - dh) / 2, dw, dh);
}

function createSlot({ caption = '', large = false, clearable = false, onFile, onClear }) {
    const wrap = document.createElement('div');
    wrap.className = 'slot-wrap';
    wrap.innerHTML = `
        <div class="slot${large ? ' slot-lg' : ''}" tabindex="0" role="button" title="Click or drop an image">
            <canvas width="${THUMB_PX}" height="${THUMB_PX}"></canvas>
            ${clearable ? '<button type="button" class="slot-clear" title="Remove" aria-label="Remove">×</button>' : ''}
        </div>
        ${caption ? `<div class="slot-caption">${caption}</div>` : ''}
        <input type="file" hidden accept="image/*">`;

    const slotEl = wrap.querySelector('.slot');
    const ctx = wrap.querySelector('canvas').getContext('2d');
    const input = wrap.querySelector('input');
    const clearBtn = wrap.querySelector('.slot-clear');

    const api = {
        el: wrap,
        open: () => input.click(),
        setPreview(bmp) {
            drawCover(ctx, bmp, THUMB_PX);
            slotEl.classList.add('filled');
        },
        clear() {
            ctx.clearRect(0, 0, THUMB_PX, THUMB_PX);
            slotEl.classList.remove('filled');
        }
    };

    slotEl.addEventListener('click', e => {
        if (e.target.closest('.slot-clear')) return;
        input.click();
    });
    slotEl.addEventListener('keydown', e => {
        if (e.target === slotEl && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            input.click();
        }
    });
    input.addEventListener('change', () => {
        const file = input.files[0];
        input.value = '';   // lets the same file be picked again
        if (file) onFile(file);
    });
    if (clearBtn) {
        clearBtn.addEventListener('click', e => {
            e.stopPropagation();
            api.clear();
            if (onClear) onClear();
        });
    }
    slotEl.addEventListener('dragover', e => {
        e.preventDefault();
        slotEl.classList.add('dragover');
    });
    slotEl.addEventListener('dragleave', () => slotEl.classList.remove('dragover'));
    slotEl.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();   // don't let the main-area handler also load it as the base
        slotEl.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
    });

    return api;
}

// Slider that renders a cheap draft while dragging and a full frame on release.
function createSlider(label, { min, max, step, value }, onInput) {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `
        <div class="d-flex justify-content-between small text-muted">
            <span>${label}</span><strong class="val">${value.toFixed(2)}</strong>
        </div>
        <input type="range" class="form-range" min="${min}" max="${max}" step="${step}" value="${value}">`;
    const input = row.querySelector('input');
    const val = row.querySelector('.val');
    input.addEventListener('pointerdown', () => { isSliderInteracting = true; });
    input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        val.textContent = v.toFixed(2);
        onInput(v);
        scheduleRender();
    });
    const stop = () => {
        if (isSliderInteracting) {
            isSliderInteracting = false;
            scheduleRender(true);
        }
    };
    input.addEventListener('pointerup', stop);
    input.addEventListener('pointercancel', stop);
    input.addEventListener('change', stop);
    return row;
}

// ------------------------------------------------------------------
// Base matcap
// ------------------------------------------------------------------
let baseSeq = 0;
const baseSlot = createSlot({ large: true, onFile: loadBase });
baseSlotHost.appendChild(baseSlot.el);

async function loadBase(file) {
    const seq = ++baseSeq;                 // newest pick wins, older decodes are dropped
    const bmp = await decodeImage(file);
    if (!bmp) return;
    if (seq !== baseSeq) { closeBmp(bmp); return; }

    const w = bmp.width, h = bmp.height;
    baseData = new Uint8ClampedArray(rasterize(bmp, w, h));
    srcW = w; srcH = h;
    baseSlot.setPreview(bmp);
    closeBmp(bmp);

    baseName.textContent = file.name;
    baseDims.textContent = `${w} × ${h}`;
    baseInfo.hidden = false;

    // Layers are resampled to the base resolution.
    layers.forEach(l => rebuildCache(l));
    compositeDirty = true;
    ensureComposite();          // srcData must exist before the first generation

    generateBtn.disabled = false;
    showStatus(`Loaded: ${file.name} (${w}×${h})`);
    runGeneration(false);
}

// ------------------------------------------------------------------
// Layers: each one is an extra matcap + blend mode + opacity,
// composited over the base in list order.
// ------------------------------------------------------------------
const layers = [];   // { id, matcap, matcapPx, blendMode, opacity, seq, removed }
let nextLayerId = 1;

function rebuildCache(layer) {
    const bmp = layer.matcap;
    layer.matcapPx = bmp && baseData ? rasterize(bmp, srcW, srcH) : null;
}

function getBlendFn(mode) {
    switch (mode) {
        case 'multiply':
            return (b, l) => b * l;
        case 'screen':
            return (b, l) => 1 - (1 - b) * (1 - l);
        case 'overlay':
            return (b, l) => (b < 0.5 ? 2 * b * l : 1 - 2 * (1 - b) * (1 - l));
        case 'hard-light':
            return (b, l) => (l < 0.5 ? 2 * b * l : 1 - 2 * (1 - b) * (1 - l));
        case 'add':
            return (b, l) => Math.min(1, b + l);
        case 'soft-light':
            return (b, l) => (l <= 0.5 ? b - (1 - 2 * l) * b * (1 - b) : b + (2 * l - 1) * (Math.sqrt(Math.max(0, b)) - b));
        case 'darken':
            return (b, l) => Math.min(b, l);
        case 'lighten':
            return (b, l) => Math.max(b, l);
        case 'difference':
            return (b, l) => Math.abs(b - l);
        case 'normal':
        default:
            return (b, l) => l;
    }
}

function ensureComposite() {
    if (!baseData || !compositeDirty) return;
    compositeDirty = false;
    const active = layers.filter(l => l.matcapPx && l.opacity > 0);
    if (!active.length) { srcData = baseData; return; }

    const out = new Uint8ClampedArray(baseData);
    const n = srcW * srcH;
    for (const l of active) {
        const px = l.matcapPx, op = l.opacity, mode = l.blendMode || 'normal';
        const blendFn = getBlendFn(mode);
        for (let i = 0, j = 0; i < n; i++, j += 4) {
            const a = (px[j + 3] / 255) * op;
            if (a <= 0) continue;

            const bR = out[j] / 255, bG = out[j + 1] / 255, bB = out[j + 2] / 255;
            const lR = px[j] / 255,  lG = px[j + 1] / 255,  lB = px[j + 2] / 255;

            const rR = blendFn(bR, lR);
            const rG = blendFn(bG, lG);
            const rB = blendFn(bB, lB);

            out[j]     += (rR * 255 - out[j])     * a;
            out[j + 1] += (rG * 255 - out[j + 1]) * a;
            out[j + 2] += (rB * 255 - out[j + 2]) * a;
        }
    }
    srcData = out;
}

function layersChanged() {
    compositeDirty = true;
    scheduleRender(true);
}

async function setLayerImage(layer, slot, file) {
    const seq = (layer.seq = (layer.seq || 0) + 1);
    const bmp = await decodeImage(file);
    if (!bmp) return;
    if (layer.removed || seq !== layer.seq) { closeBmp(bmp); return; }
    closeBmp(layer.matcap);
    layer.matcap = bmp;
    slot.setPreview(bmp);
    rebuildCache(layer);
    layersChanged();
}

function clearLayerImage(layer) {
    layer.seq = (layer.seq || 0) + 1;   // cancels pending decode
    closeBmp(layer.matcap);
    layer.matcap = null;
    layer.matcapPx = null;
    layersChanged();
}

function renumberLayers() {
    [...layersContainer.children].forEach((card, i) => {
        card.querySelector('.layer-title').textContent = `Layer ${i + 1}`;
    });
}

function updateAddLayerState() {
    addLayerBtn.disabled = layers.length >= MAX_LAYERS;
    addLayerBtn.title = addLayerBtn.disabled ? `Up to ${MAX_LAYERS} layers` : '';
}

function createLayerCard(layer) {
    const card = document.createElement('div');
    card.className = 'settings-area p-3 border rounded bg-light layer-card';
    card.innerHTML = `
        <div class="d-flex justify-content-between align-items-center mb-2">
            <h3 class="layer-title mb-0">Layer</h3>
            <button type="button" class="btn btn-sm btn-outline-danger remove-layer-btn" title="Remove layer" aria-label="Remove layer">×</button>
        </div>
        <div class="d-flex align-items-center gap-3 mb-2">
            <div class="layer-slot-host"></div>
            <div class="flex-grow-1">
                <label class="form-label small text-muted mb-1">Blend mode</label>
                <select class="form-select form-select-sm blend-select">
                    <option value="normal">Normal</option>
                    <option value="multiply">Multiply</option>
                    <option value="screen">Screen</option>
                    <option value="overlay">Overlay</option>
                    <option value="add">Add (Linear Dodge)</option>
                    <option value="soft-light">Soft Light</option>
                    <option value="hard-light">Hard Light</option>
                    <option value="darken">Darken</option>
                    <option value="lighten">Lighten</option>
                    <option value="difference">Difference</option>
                </select>
            </div>
        </div>
        <div class="layer-sliders"></div>`;

    const matcapSlot = createSlot({
        caption: 'Matcap',
        clearable: true,
        onFile: f => setLayerImage(layer, matcapSlot, f),
        onClear: () => clearLayerImage(layer)
    });
    card.querySelector('.layer-slot-host').appendChild(matcapSlot.el);

    const select = card.querySelector('.blend-select');
    select.value = layer.blendMode || 'normal';
    select.addEventListener('change', () => {
        layer.blendMode = select.value;
        compositeDirty = true;
        scheduleRender(true);
    });

    card.querySelector('.layer-sliders').appendChild(
        createSlider('Opacity', { min: 0, max: 1, step: 0.01, value: layer.opacity }, v => {
            layer.opacity = v;
            compositeDirty = true;
        })
    );

    card.querySelector('.remove-layer-btn').addEventListener('click', () => removeLayer(layer, card));
    return card;
}

function addLayer() {
    if (layers.length >= MAX_LAYERS) return;
    const layer = {
        id: nextLayerId++,
        matcap: null,
        matcapPx: null,
        blendMode: 'normal',
        opacity: 1,
        seq: 0,
        removed: false
    };
    layers.push(layer);
    layersContainer.appendChild(createLayerCard(layer));
    renumberLayers();
    updateAddLayerState();
}

function removeLayer(layer, card) {
    const idx = layers.indexOf(layer);
    if (idx === -1) return;
    layer.removed = true;
    closeBmp(layer.matcap);
    layers.splice(idx, 1);
    card.remove();
    renumberLayers();
    updateAddLayerState();
    layersChanged();
}

addLayerBtn.addEventListener('click', addLayer);

// ------------------------------------------------------------------
// Drag & drop a base matcap anywhere on the main area
// ------------------------------------------------------------------
mainPlaceholder.addEventListener('click', () => baseSlot.open());
mainPlaceholder.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        baseSlot.open();
    }
});
appMain.addEventListener('dragover', e => {
    e.preventDefault();
    mainPlaceholder.classList.add('dragover');
});
appMain.addEventListener('dragleave', e => {
    if (!appMain.contains(e.relatedTarget)) mainPlaceholder.classList.remove('dragover');
});
appMain.addEventListener('drop', e => {
    e.preventDefault();
    mainPlaceholder.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) loadBase(file);
});
// A missed drop must not navigate the page to the image.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

addLayer();

function updateHandlePosition(pitchDeg, yawDeg) {
    if (!ballController || !ballHandle) return;
    const rect = ballController.getBoundingClientRect();
    const radius = rect.width / 2;
    const normX = (yawDeg / 180); 
    const normY = (-pitchDeg / 180);
    const handleX = radius + normX * (radius - 6);
    const handleY = radius + normY * (radius - 6);
    ballHandle.style.left = `${handleX}px`;
    ballHandle.style.top = `${handleY}px`;
}

function handleBallMove(e) {
    if (!isBallInteracting || !ballController) return;
    const rect = ballController.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    let dx = (clientX - cx) / (rect.width / 2);
    let dy = (clientY - cy) / (rect.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 1) {
        dx /= dist;
        dy /= dist;
    }
    const yaw = Math.round(dx * 180);
    const pitch = Math.round(-dy * 180);
    rotYInput.value = yaw;
    rotXInput.value = pitch;
    document.getElementById('rotYVal').textContent = yaw;
    document.getElementById('rotXVal').textContent = pitch;
    updateHandlePosition(pitch, yaw);
    scheduleRender();
}

if (ballController) {
    const startBallDrag = (e) => {
        isBallInteracting = true;
        handleBallMove(e);
    };
    ballController.addEventListener('mousedown', startBallDrag);
    ballController.addEventListener('touchstart', startBallDrag);
    window.addEventListener('mousemove', (e) => { if (isBallInteracting) handleBallMove(e); });
    window.addEventListener('touchmove', (e) => { if (isBallInteracting) handleBallMove(e); });
    const stopBallDrag = () => {
        if (isBallInteracting) {
            isBallInteracting = false;
            scheduleRender(true);
        }
    };
    window.addEventListener('mouseup', stopBallDrag);
    window.addEventListener('touchend', stopBallDrag);
}

['rotX', 'rotY', 'rotZ'].forEach(id => {
    const input = document.getElementById(id);
    const valSpan = document.getElementById(id + 'Val');
    if (input && valSpan) {
        input.addEventListener('mousedown', () => { isSliderInteracting = true; });
        input.addEventListener('touchstart', () => { isSliderInteracting = true; });
        input.addEventListener('input', () => {
            valSpan.textContent = input.value;
            if (id === 'rotX' || id === 'rotY') {
                updateHandlePosition(parseFloat(rotXInput.value), parseFloat(rotYInput.value));
            }
            scheduleRender();
        });
        const stopSliderInput = () => {
            if (isSliderInteracting) {
                isSliderInteracting = false;
                scheduleRender(true);
            }
        };
        input.addEventListener('mouseup', stopSliderInput);
        input.addEventListener('touchend', stopSliderInput);
        input.addEventListener('change', stopSliderInput);
    }
});

const resetRotationBtn = document.getElementById('resetRotation');
if (resetRotationBtn) {
    resetRotationBtn.addEventListener('click', () => {
        rotXInput.value = 0;
        rotYInput.value = 0;
        rotZInput.value = 0;
        document.getElementById('rotXVal').textContent = 0;
        document.getElementById('rotYVal').textContent = 0;
        document.getElementById('rotZVal').textContent = 0;
        updateHandlePosition(0, 0);
        scheduleRender(true);
    });
}

const backBlurStrengthInput = document.getElementById('backBlurStrength');
if (backBlurStrengthInput) {
    const valSpan = document.getElementById('backBlurStrengthVal');
    backBlurStrengthInput.addEventListener('mousedown', () => { isSliderInteracting = true; });
    backBlurStrengthInput.addEventListener('touchstart', () => { isSliderInteracting = true; });
    backBlurStrengthInput.addEventListener('input', () => {
        if (valSpan) valSpan.textContent = parseFloat(backBlurStrengthInput.value).toFixed(1);
        scheduleRender();
    });
    const stopBackBlurInput = () => {
        if (isSliderInteracting) {
            isSliderInteracting = false;
            scheduleRender(true);
        }
    };
    backBlurStrengthInput.addEventListener('mouseup', stopBackBlurInput);
    backBlurStrengthInput.addEventListener('touchend', stopBackBlurInput);
    backBlurStrengthInput.addEventListener('change', stopBackBlurInput);
}

document.querySelectorAll('input[name="backFill"]').forEach(input => {
    input.addEventListener('change', () => scheduleRender(true));
});

function getBackFillMode() {
    const checked = document.querySelector('input[name="backFill"]:checked');
    return checked ? checked.value : 'blur';
}

function getBackBlurStrength() {
    return backBlurStrengthInput ? parseFloat(backBlurStrengthInput.value) : 1.0;
}

const globalSoftnessInput = document.getElementById('globalSoftness');
if (globalSoftnessInput) {
    const valSpan = document.getElementById('globalSoftnessVal');
    globalSoftnessInput.addEventListener('mousedown', () => { isSliderInteracting = true; });
    globalSoftnessInput.addEventListener('touchstart', () => { isSliderInteracting = true; });
    globalSoftnessInput.addEventListener('input', () => {
        if (valSpan) valSpan.textContent = globalSoftnessInput.value;
        scheduleRender();
    });
    const stopGlobalSoftnessInput = () => {
        if (isSliderInteracting) {
            isSliderInteracting = false;
            scheduleRender(true);
        }
    };
    globalSoftnessInput.addEventListener('mouseup', stopGlobalSoftnessInput);
    globalSoftnessInput.addEventListener('touchend', stopGlobalSoftnessInput);
    globalSoftnessInput.addEventListener('change', stopGlobalSoftnessInput);
}

function getGlobalSoftness() {
    return globalSoftnessInput ? parseFloat(globalSoftnessInput.value) / 100 : 0;
}

function scheduleRender(forceFinal = false) {
    if (!srcData) return;
    if (renderTimeout) clearTimeout(renderTimeout);

    const isInteracting = isBallInteracting || isSliderInteracting;
    if (isInteracting && !forceFinal) {
        runGeneration(true);
    } else {
        showStatus('Rendering high quality...', 1000);
        renderTimeout = setTimeout(() => {
            runGeneration(false);
        }, 250);
    }
}

function sampleFast(u, v) {
    const x = Math.min(Math.max((u * srcW) | 0, 0), srcW - 1);
    const y = Math.min(Math.max((v * srcH) | 0, 0), srcH - 1);
    const idx = (y * srcW + x) * 4;
    return [srcData[idx], srcData[idx + 1], srcData[idx + 2], 255];
}

function bilinear(u, v) {
    u = Math.min(Math.max(u, 0), 1);
    v = Math.min(Math.max(v, 0), 1);
    const x = u * (srcW - 1), y = v * (srcH - 1);
    const x0 = Math.floor(x), x1 = Math.min(x0 + 1, srcW - 1);
    const y0 = Math.floor(y), y1 = Math.min(y0 + 1, srcH - 1);
    const fx = x - x0, fy = y - y0;
    const idx = (xx, yy) => (yy * srcW + xx) * 4;
    const out = [0, 0, 0, 255];
    for (let ch = 0; ch < 3; ch++) {
        const c00 = srcData[idx(x0, y0) + ch], c10 = srcData[idx(x1, y0) + ch];
        const c01 = srcData[idx(x0, y1) + ch], c11 = srcData[idx(x1, y1) + ch];
        const top = c00 * (1 - fx) + c10 * fx;
        const bot = c01 * (1 - fx) + c11 * fx;
        out[ch] = top * (1 - fy) + bot * fy;
    }
    return out;
}

const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
function faceDir(face, a, b) {
    switch (face) {
        case 'px': return [1, b, -a];
        case 'nx': return [-1, b, a];
        case 'py': return [a, 1, -b];
        case 'ny': return [a, -1, b];
        case 'pz': return [a, b, 1];
        case 'nz': return [-a, b, -1];
    }
}

function sampleMatcap(u, v) {
    return bilinear(u, v);
}

function buildDiscClampedSource() {
    const out = new Uint8ClampedArray(srcW * srcH * 4);
    const cx = (srcW - 1) / 2, cy = (srcH - 1) / 2;
    const R = Math.min(cx, cy);
    for (let y = 0; y < srcH; y++) {
        const ny = (y - cy) / R;
        for (let x = 0; x < srcW; x++) {
            const nx = (x - cx) / R;
            const r = Math.sqrt(nx * nx + ny * ny);
            let sx = x, sy = y;
            if (r > 0.995) {
                const k = 0.995 / r;
                sx = cx + nx * k * R;
                sy = cy + ny * k * R;
            }
            const c = bilinear(sx / (srcW - 1), sy / (srcH - 1));
            const off = (y * srcW + x) * 4;
            out[off] = c[0]; out[off + 1] = c[1]; out[off + 2] = c[2]; out[off + 3] = 255;
        }
    }
    return out;
}

function buildMipPyramid(baseData, baseW, baseH) {
    const levels = [{ data: baseData, w: baseW, h: baseH }];
    let w = baseW, h = baseH, data = baseData;
    while (w > 4 && h > 4 && levels.length < 8) {
        const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
        const nd = new Uint8ClampedArray(nw * nh * 4);
        for (let y = 0; y < nh; y++) {
            const y0 = Math.min(y * 2, h - 1), y1 = Math.min(y * 2 + 1, h - 1);
            for (let x = 0; x < nw; x++) {
                const x0 = Math.min(x * 2, w - 1), x1 = Math.min(x * 2 + 1, w - 1);
                for (let ch = 0; ch < 3; ch++) {
                    const s = data[(y0 * w + x0) * 4 + ch] + data[(y0 * w + x1) * 4 + ch] +
                              data[(y1 * w + x0) * 4 + ch] + data[(y1 * w + x1) * 4 + ch];
                    nd[(y * nw + x) * 4 + ch] = s / 4;
                }
                nd[(y * nw + x) * 4 + 3] = 255;
            }
        }
        levels.push({ data: nd, w: nw, h: nh });
        w = nw; h = nh; data = nd;
    }
    return levels;
}

function bilinearLevel(level, u, v) {
    u = Math.min(Math.max(u, 0), 1);
    v = Math.min(Math.max(v, 0), 1);
    const { data, w, h } = level;
    const x = u * (w - 1), y = v * (h - 1);
    const x0 = Math.floor(x), x1 = Math.min(x0 + 1, w - 1);
    const y0 = Math.floor(y), y1 = Math.min(y0 + 1, h - 1);
    const fx = x - x0, fy = y - y0;
    const idx = (xx, yy) => (yy * w + xx) * 4;
    const out = [0, 0, 0, 255];
    for (let ch = 0; ch < 3; ch++) {
        const c00 = data[idx(x0, y0) + ch], c10 = data[idx(x1, y0) + ch];
        const c01 = data[idx(x0, y1) + ch], c11 = data[idx(x1, y1) + ch];
        const top = c00 * (1 - fx) + c10 * fx;
        const bot = c01 * (1 - fx) + c11 * fx;
        out[ch] = top * (1 - fy) + bot * fy;
    }
    return out;
}

function sampleMipTrilinear(pyramid, u, v, levelFloat) {
    const maxLevel = pyramid.length - 1;
    levelFloat = Math.min(Math.max(levelFloat, 0), maxLevel);
    const l0 = Math.floor(levelFloat), l1 = Math.min(l0 + 1, maxLevel);
    const t = levelFloat - l0;
    const c0 = bilinearLevel(pyramid[l0], u, v);
    const c1 = bilinearLevel(pyramid[l1], u, v);
    return [
        c0[0] * (1 - t) + c1[0] * t,
        c0[1] * (1 - t) + c1[1] * t,
        c0[2] * (1 - t) + c1[2] * t,
        255
    ];
}

function buildBackFiller() {
    const clamped = buildDiscClampedSource();
    const pyramid = buildMipPyramid(clamped, srcW, srcH);
    pyramid[0] = { data: srcData, w: srcW, h: srcH };
    const flatColor = bilinearLevel(pyramid[pyramid.length - 1], 0.5, 0.5);
    return { pyramid, flatColor };
}

function smoothstep01(t) {
    t = Math.min(Math.max(t, 0), 1);
    return t * t * (3 - 2 * t);
}

function sampleBackHemisphere(filler, u, v, dx, mode, strength) {
    const t = smoothstep01(-dx * strength);
    if (mode === 'flat') {
        const sharp = bilinearLevel(filler.pyramid[0], u, v);
        return [
            sharp[0] * (1 - t) + filler.flatColor[0] * t,
            sharp[1] * (1 - t) + filler.flatColor[1] * t,
            sharp[2] * (1 - t) + filler.flatColor[2] * t,
            255
        ];
    }
    const maxLevel = filler.pyramid.length - 1;
    const levelFloat = Math.pow(t, 1.3) * maxLevel;
    return sampleMipTrilinear(filler.pyramid, u, v, levelFloat);
}

function getRotations() {
    const rx = parseFloat(rotXInput?.value || 0) * Math.PI / 180;
    const ry = parseFloat(rotYInput?.value || 0) * Math.PI / 180;
    const rz = parseFloat(rotZInput?.value || 0) * Math.PI / 180;
    return { rx, ry, rz };
}

function rotateVector(x, y, z, rx, ry, rz) {
    let y1 = y * Math.cos(rx) - z * Math.sin(rx);
    let z1 = y * Math.sin(rx) + z * Math.cos(rx);
    let x1 = x;

    let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
    let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
    let y2 = y1;

    let x3 = x2 * Math.cos(rz) - y2 * Math.sin(rz);
    let y3 = x2 * Math.sin(rz) + y2 * Math.cos(rz);
    let z3 = z2;

    return [x3, y3, z3];
}

function generateFaces(size, isFast = false) {
    ensureComposite();
    const result = {};
    const { rx, ry, rz } = getRotations();
    const backFillMode = isFast ? 'blur' : getBackFillMode();
    const backStrength = isFast ? 1.0 : getBackBlurStrength();
    const backFiller = isFast ? null : buildBackFiller();
    const globalSoftness = isFast ? 0 : getGlobalSoftness();
    
    const scale = getMatcapScale();

    for (const face of FACES) {
        const buf = new Uint8ClampedArray(size * size * 4);

        for (let row = 0; row < size; row++) {
            const b = 1 - 2 * row / (size - 1);

            for (let col = 0; col < size; col++) {
                const a = -1 + 2 * col / (size - 1);
                let [dx, dy, dz] = faceDir(face, a, b);

                const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                dx /= len; dy /= len; dz /= len;

                [dx, dy, dz] = rotateVector(dx, dy, dz, rx, ry, rz);

                const u = 0.5 - (dz * 0.5) / scale;
                const v = 0.5 - (dy * 0.5) / scale;
                
                let color;
                
                if (isFast) {
                    color = sampleFast(u, v);
                } else if (dx < 0) {
                    color = sampleBackHemisphere(backFiller, u, v, dx, backFillMode, backStrength);
                } else {
                    color = sampleMatcap(u, v);
                }

                if (!isFast) {
                    const SEAM_HALF_WIDTH = 0.16;
                    const seamT = 1 - smoothstep01(Math.abs(dx) / SEAM_HALF_WIDTH);
                    if (seamT > 0) {
                        const seamSample = sampleMipTrilinear(backFiller.pyramid, u, v, 3.0);
                        color = [
                            color[0] * (1 - seamT) + seamSample[0] * seamT,
                            color[1] * (1 - seamT) + seamSample[1] * seamT,
                            color[2] * (1 - seamT) + seamSample[2] * seamT,
                            255
                        ];
                    }
                }

                if (!isFast && globalSoftness > 0) {
                    const maxLevel = backFiller.pyramid.length - 1;
                    const soft = sampleMipTrilinear(backFiller.pyramid, u, v, globalSoftness * maxLevel);
                    color = [
                        color[0] * (1 - globalSoftness) + soft[0] * globalSoftness,
                        color[1] * (1 - globalSoftness) + soft[1] * globalSoftness,
                        color[2] * (1 - globalSoftness) + soft[2] * globalSoftness,
                        255
                    ];
                }

                const off = (row * size + col) * 4;
                buf[off] = color[0];
                buf[off + 1] = color[1];
                buf[off + 2] = color[2];
                buf[off + 3] = 255;
            }
        }
        result[face] = buf;
    }
    return result;
}

function renderPreview(faces, size) {
    const holder = document.getElementById('facesOutput');
    holder.innerHTML = '';
    resultArea.style.display = 'block';
    const placeholder = document.getElementById('mainPlaceholder');
    if (placeholder) placeholder.style.display = 'none';
    for (const face of FACES) {
        const cell = document.createElement('div');
        cell.className = 'face-cell';
        cell.dataset.face = face;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(faces[face], size, size), 0, 0);
        const label = document.createElement('span');
        label.textContent = face;
        cell.appendChild(canvas);
        cell.appendChild(label);
        holder.appendChild(cell);
    }
}

const VTF_FORMATS = {
    RGBA8888: 0,
    BGR888: 3,
    BGRA8888: 12,
    DXT1: 13,
    RGBA16161616F: 24,
};

// Minimal IEEE-754 half-float encoder (values expected in the 0..1 range).
function toHalfFloat(value) {
    const floatView = new Float32Array(1);
    const int32View = new Uint32Array(floatView.buffer);
    floatView[0] = value;
    const f = int32View[0];

    const sign = (f >> 16) & 0x8000;
    const exponent = ((f >> 23) & 0xff) - 127 + 15;
    const mantissa = f & 0x7fffff;

    if (exponent <= 0) {
        if (exponent < -10) return sign;
        const m = mantissa | 0x800000;
        const shift = 14 - exponent;
        return sign | (m >> shift);
    } else if (exponent >= 31) {
        return sign | 0x7c00;
    }
    return sign | (exponent << 10) | (mantissa >> 13);
}

function packRGBA16161616F(src) {
    const px = src.length / 4;
    const out = new Uint8Array(px * 8);
    let o = 0;
    for (let i = 0; i < src.length; i += 4) {
        for (let ch = 0; ch < 4; ch++) {
            const h = toHalfFloat(src[i + ch] / 255);
            out[o] = h & 0xff; out[o + 1] = (h >> 8) & 0xff;
            o += 2;
        }
    }
    return out;
}

function packBGRA8888(src) {
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += 4) {
        out[i] = src[i + 2]; out[i + 1] = src[i + 1]; out[i + 2] = src[i]; out[i + 3] = src[i + 3];
    }
    return out;
}

function packBGR888(src) {
    const px = src.length / 4;
    const out = new Uint8Array(px * 3);
    for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
        out[j] = src[i + 2]; out[j + 1] = src[i + 1]; out[j + 2] = src[i];
    }
    return out;
}

function rgb565(r, g, b) {
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function unpack565(c) {
    const r5 = (c >> 11) & 0x1f, g6 = (c >> 5) & 0x3f, b5 = c & 0x1f;
    return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

function encodeDXT1Block(src, size, bx, by) {
    let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
    const pixels = new Array(16);
    let p = 0;
    for (let y = 0; y < 4; y++) {
        const py = Math.min(by + y, size - 1);
        for (let x = 0; x < 4; x++) {
            const px_ = Math.min(bx + x, size - 1);
            const off = (py * size + px_) * 4;
            const r = src[off], g = src[off + 1], b = src[off + 2];
            pixels[p++] = [r, g, b];
            if (r < minR) minR = r; if (g < minG) minG = g; if (b < minB) minB = b;
            if (r > maxR) maxR = r; if (g > maxG) maxG = g; if (b > maxB) maxB = b;
        }
    }
    let c0 = rgb565(maxR, maxG, maxB);
    let c1 = rgb565(minR, minG, minB);
    if (c0 === c1) { if (c0 > 0) c1 = c0 - 1; else c0 = c1 + 1; }
    if (c0 < c1) { const t = c0; c0 = c1; c1 = t; }

    const [r0, g0, b0] = unpack565(c0);
    const [r1, g1, b1] = unpack565(c1);
    const palette = [
        [r0, g0, b0],
        [r1, g1, b1],
        [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (b0 + 2 * b1) / 3],
        [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3],
    ];

    let indices = 0;
    for (let i = 15; i >= 0; i--) {
        const [pr, pg, pb] = pixels[i];
        let best = 0, bestDist = Infinity;
        for (let k = 0; k < 4; k++) {
            const [cr, cg, cb] = palette[k];
            const d = (pr - cr) ** 2 + (pg - cg) ** 2 + (pb - cb) ** 2;
            if (d < bestDist) { bestDist = d; best = k; }
        }
        indices = (indices << 2) | best;
    }
    return { c0, c1, indices };
}

function packDXT1(src, size) {
    const blocksPerSide = size / 4;
    const out = new Uint8Array(blocksPerSide * blocksPerSide * 8);
    let o = 0;
    for (let by = 0; by < size; by += 4) {
        for (let bx = 0; bx < size; bx += 4) {
            const { c0, c1, indices } = encodeDXT1Block(src, size, bx, by);
            out[o] = c0 & 0xff; out[o + 1] = (c0 >> 8) & 0xff;
            out[o + 2] = c1 & 0xff; out[o + 3] = (c1 >> 8) & 0xff;
            out[o + 4] = indices & 0xff;
            out[o + 5] = (indices >> 8) & 0xff;
            out[o + 6] = (indices >> 16) & 0xff;
            out[o + 7] = (indices >> 24) & 0xff;
            o += 8;
        }
    }
    return out;
}

function packFace(rgba, size, format) {
    switch (format) {
        case 'BGRA8888': return packBGRA8888(rgba);
        case 'BGR888': return packBGR888(rgba);
        case 'DXT1': return packDXT1(rgba, size);
        case 'RGBA16161616F': return packRGBA16161616F(rgba);
        default: return rgba;
    }
}

function faceByteSize(size, format) {
    switch (format) {
        case 'BGRA8888': return size * size * 4;
        case 'BGR888': return size * size * 3;
        case 'DXT1': return (size / 4) * (size / 4) * 8;
        case 'RGBA16161616F': return size * size * 8;
        default: return size * size * 4;
    }
}

function downsampleFace(src, size) {
    const half = size / 2;
    const out = new Uint8ClampedArray(half * half * 4);
    for (let y = 0; y < half; y++) {
        const y0 = y * 2, y1 = y0 + 1;
        for (let x = 0; x < half; x++) {
            const x0 = x * 2, x1 = x0 + 1;
            const o00 = (y0 * size + x0) * 4, o10 = (y0 * size + x1) * 4;
            const o01 = (y1 * size + x0) * 4, o11 = (y1 * size + x1) * 4;
            const oo = (y * half + x) * 4;
            for (let ch = 0; ch < 4; ch++) {
                out[oo + ch] = (src[o00 + ch] + src[o10 + ch] + src[o01 + ch] + src[o11 + ch]) / 4;
            }
        }
    }
    return out;
}

function buildMipChain(faces, size, minSize) {
    const chain = [{ size, faces }];
    let curSize = size, curFaces = faces;
    while (curSize > minSize) {
        const nextSize = curSize / 2;
        const nextFaces = {};
        for (const face of FACES) nextFaces[face] = downsampleFace(curFaces[face], curSize);
        chain.push({ size: nextSize, faces: nextFaces });
        curSize = nextSize;
        curFaces = nextFaces;
    }
    return chain;
}

function flipFaceRows(rawRgba, size) {
    const rowBytes = size * 4;
    const flipped = new Uint8ClampedArray(rawRgba.length);
    for (let row = 0; row < size; row++) {
        flipped.set(rawRgba.subarray(row * rowBytes, (row + 1) * rowBytes), (size - 1 - row) * rowBytes);
    }
    return flipped;
}

function buildVTFGeneric(faces, size, flipRows, format, minSize) {
    const mipChain = buildMipChain(faces, size, minSize);
    const mipCount = mipChain.length;

    const headerSize = 64;
    let bodySize = 0;
    for (const level of mipChain) bodySize += faceByteSize(level.size, format) * 7;
    const totalSize = headerSize + bodySize;
    const buf = new ArrayBuffer(totalSize);
    const dv = new DataView(buf);
    let o = 0;
    const wU8 = v => { dv.setUint8(o, v); o += 1; };
    const wU16 = v => { dv.setUint16(o, v, true); o += 2; };
    const wU32 = v => { dv.setUint32(o, v, true); o += 4; };
    const wF32 = v => { dv.setFloat32(o, v, true); o += 4; };

    wU8(0x56); wU8(0x54); wU8(0x46); wU8(0x00);
    wU32(7); wU32(1);
    wU32(headerSize);
    wU16(size); wU16(size);
    const ENVMAP = 0x00004000, NOLOD = 0x00000200;
    wU32(ENVMAP | NOLOD);
    wU16(1); wU16(0);
    wU32(0);
    wF32(0.5); wF32(0.5); wF32(0.5);
    wU32(0);
    wF32(1.0);
    wU32(VTF_FORMATS[format]);
    wU8(mipCount);
    dv.setInt32(o, -1, true); o += 4;
    wU8(0); wU8(0);
    wU8(0);

    const writeFace = (rawRgba, faceSize) => {
        const src = flipRows ? flipFaceRows(rawRgba, faceSize) : rawRgba;
        const packed = packFace(src, faceSize, format);
        const faceBytes = faceByteSize(faceSize, format);
        new Uint8Array(buf, o, faceBytes).set(packed);
        o += faceBytes;
    };

    for (let i = mipChain.length - 1; i >= 0; i--) {
        const level = mipChain[i];
        for (const face of FACES) writeFace(level.faces[face], level.size);
        writeFace(level.faces[FACES[0]], level.size);
    }

    return new Uint8Array(buf);
}

function buildVTF(faces, size, flipRows, format) {
    const minSize = format === 'DXT1' ? 4 : 1;
    return buildVTFGeneric(faces, size, flipRows, format, minSize);
}

function buildVTFHDR(faces, size, flipRows) {
    return buildVTFGeneric(faces, size, flipRows, 'RGBA16161616F', 1);
}

function downsampleFaceN(rgba, size, times) {
    let cur = rgba, curSize = size;
    for (let i = 0; i < times; i++) {
        cur = downsampleFace(cur, curSize);
        curSize /= 2;
    }
    return { faces: cur, size: curSize };
}

function shrinkFacesForHDR(faces, size, divisor) {
    if (divisor <= 1) return { faces, size };
    const times = Math.log2(divisor);
    const outFaces = {};
    let outSize = size;
    for (const face of FACES) {
        const r = downsampleFaceN(faces[face], size, times);
        outFaces[face] = r.faces;
        outSize = r.size;
    }
    return { faces: outFaces, size: outSize };
}

function getHdrSizeDivisor() {
    const checked = document.querySelector('input[name="hdrSizeDiv"]:checked');
    return checked ? parseInt(checked.value, 10) : 2;
}

function getMatPath() {
    const matInput = document.getElementById('matPath');
    return matInput ? matInput.value.trim() : 'material';
}

function crc32(buf) {
    let c, table = crc32.table || (crc32.table = (() => {
        const t = [];
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c;
        }
        return t;
    })());
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
    const localParts = [], centralParts = [];
    let offset = 0;
    const encoder = new TextEncoder();
    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const crc = crc32(file.data);
        const size = file.data.length;

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0, true);
        local.setUint16(8, 0, true);
        local.setUint16(10, 0, true);
        local.setUint16(12, 0, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, size, true);
        local.setUint32(22, size, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);
        localParts.push(new Uint8Array(local.buffer), nameBytes, file.data);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        central.setUint16(8, 0, true);
        central.setUint16(10, 0, true);
        central.setUint16(12, 0, true);
        central.setUint16(14, 0, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, size, true);
        central.setUint32(24, size, true);
        central.setUint16(28, nameBytes.length, true);
        central.setUint16(30, 0, true);
        central.setUint16(32, 0, true);
        central.setUint16(34, 0, true);
        central.setUint16(36, 0, true);
        central.setUint32(38, 0, true);
        central.setUint32(42, offset, true);
        centralParts.push(new Uint8Array(central.buffer), nameBytes);

        offset += local.byteLength + nameBytes.length + size;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const p of centralParts) centralSize += p.length;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    end.setUint16(20, 0, true);

    const all = [...localParts, ...centralParts, new Uint8Array(end.buffer)];
    let total = 0;
    for (const p of all) total += p.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of all) { out.set(part, p); p += part.length; }
    return out;
}

function download(data, filename, mime) {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

function getFaceSize() {
    const checked = document.querySelector('input[name="faceSize"]:checked');
    return checked ? parseInt(checked.value, 10) : 512;
}

function getPixelFormat() {
    const checked = document.querySelector('input[name="pixelFormat"]:checked');
    return checked ? checked.value : 'DXT1';
}

function getFlipRows() {
    const checked = document.querySelector('input[name="flipRows"]:checked');
    return checked ? checked.value === 'true' : false;
}

function runGeneration(isFast = false) {
    if (!srcData) return;

    if (isFast) {
        clearTimeout(genTimer);
        const renderSize = 128;
        const faces = generateFaces(renderSize, true);
        renderPreview(faces, renderSize);
    } else {
        showStatus('Generating high quality...');
        generateBtn.disabled = true;

        clearTimeout(genTimer);
        genTimer = setTimeout(() => {
            const targetSize = getFaceSize();
            const faces = generateFaces(targetSize, false);
            generatedFaces = faces;
            generatedSize = targetSize;
            renderPreview(faces, targetSize);
            showStatus('Done!');
            generateBtn.disabled = false;
        }, 10);
    }
}

generateBtn.addEventListener('click', () => runGeneration(false));

document.getElementById('dlVtf').addEventListener('click', () => {
    if (!generatedFaces) return;
    const flip = getFlipRows();
    const format = getPixelFormat();
    const vtf = buildVTF(generatedFaces, generatedSize, flip, format);
    const matPath = getMatPath();
    const name = matPath.split('/').pop() + '_env.vtf';
    download(vtf, name, 'application/octet-stream');
});

const dlVtfHdrBtn = document.getElementById('dlVtfHdr');
if (dlVtfHdrBtn) {
    dlVtfHdrBtn.addEventListener('click', () => {
        if (!generatedFaces) return;
        const flip = getFlipRows();
        const divisor = getHdrSizeDivisor();
        const { faces: hdrFaces, size: hdrSize } = shrinkFacesForHDR(generatedFaces, generatedSize, divisor);
        const vtf = buildVTFHDR(hdrFaces, hdrSize, flip);
        const matPath = getMatPath();
        const name = matPath.split('/').pop() + '_env.hdr.vtf';
        download(vtf, name, 'application/octet-stream');
    });
}

document.getElementById('dlPngZip').addEventListener('click', () => {
    if (!generatedFaces) return;
    const files = [];
    for (const face of FACES) {
        const size = generatedSize;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(generatedFaces[face], size, size), 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        const b64 = dataUrl.split(',')[1];
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        files.push({ name: `matcap_${face}.png`, data: bytes });
    }
    const zip = buildZip(files);
    const matPath = getMatPath();
    download(zip, matPath.split('/').pop() + '_faces.zip', 'application/zip');
});

const matcapScaleInput = document.getElementById('matcapScale');
if (matcapScaleInput) {
    const valSpan = document.getElementById('matcapScaleVal');
    matcapScaleInput.addEventListener('mousedown', () => { isSliderInteracting = true; });
    matcapScaleInput.addEventListener('touchstart', () => { isSliderInteracting = true; });
    matcapScaleInput.addEventListener('input', () => {
        if (valSpan) valSpan.textContent = parseFloat(matcapScaleInput.value).toFixed(2);
        scheduleRender();
    });
    const stopScaleInput = () => {
        if (isSliderInteracting) {
            isSliderInteracting = false;
            scheduleRender(true);
        }
    };
    matcapScaleInput.addEventListener('mouseup', stopScaleInput);
    matcapScaleInput.addEventListener('touchend', stopScaleInput);
    matcapScaleInput.addEventListener('change', stopScaleInput);
}

function getMatcapScale() {
    return matcapScaleInput ? parseFloat(matcapScaleInput.value) : 1.0;
}