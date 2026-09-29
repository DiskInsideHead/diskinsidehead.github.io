// =====================================================================
// Matcap -> EnvMap
//
// All heavy pixel work (layer compositing, mip pyramid, cubemap face
// generation) lives in createEngineCore(). It is executed inside a Web
// Worker so the UI (sliders, colour picker) never blocks. If workers are
// unavailable it runs on the main thread in cooperative (yielding) mode.
// =====================================================================

// ------------------------------------------------------------------
// Render engine core (must stay self-contained: it is stringified
// and shipped to the worker)
// ------------------------------------------------------------------
function createEngineCore(post) {
    'use strict';

    const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    // Per-face basis: direction = A*a + B*b + C  (a, b in [-1, 1])
    const BASIS = {
        px: [0, 0, -1, 0, 1, 0, 1, 0, 0],
        nx: [0, 0, 1, 0, 1, 0, -1, 0, 0],
        py: [1, 0, 0, 0, 0, -1, 0, 1, 0],
        ny: [1, 0, 0, 0, 0, 1, 0, -1, 0],
        pz: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        nz: [-1, 0, 0, 0, 1, 0, 0, 0, -1]
    };

    const BLEND = {
        normal: (b, l) => l,
        multiply: (b, l) => b * l,
        screen: (b, l) => 1 - (1 - b) * (1 - l),
        overlay: (b, l) => (b < 0.5 ? 2 * b * l : 1 - 2 * (1 - b) * (1 - l)),
        'hard-light': (b, l) => (l < 0.5 ? 2 * b * l : 1 - 2 * (1 - b) * (1 - l)),
        add: (b, l) => Math.min(1, b + l),
        'soft-light': (b, l) => (l <= 0.5
            ? b - (1 - 2 * l) * b * (1 - b)
            : b + (2 * l - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b)),
        darken: (b, l) => Math.min(b, l),
        lighten: (b, l) => Math.max(b, l),
        difference: (b, l) => Math.abs(b - l)
    };

    // ---- state ----
    let base = null;                 // { data, w, h }
    let back = null;                 // { data, w, h }
    const layerPx = new Map();       // id -> Uint8ClampedArray (same size as base)
    let baseVer = 0, layerVer = 0;
    let composite = null, compKey = '';
    let pyramid = null;

    let running = null, queued = null;

    // ---- yielding (lets incoming messages be processed during long jobs) ----
    const chan = new MessageChannel();
    const yieldNow = () => new Promise(res => {
        chan.port1.onmessage = () => res();
        chan.port2.postMessage(0);
    });

    // ---- sampling ----
    function sample(data, w, h, u, v, out) {
        u = u < 0 ? 0 : (u > 1 ? 1 : u);
        v = v < 0 ? 0 : (v > 1 ? 1 : v);
        const x = u * (w - 1), y = v * (h - 1);
        const x0 = x | 0, y0 = y | 0;
        const x1 = x0 + 1 < w ? x0 + 1 : w - 1;
        const y1 = y0 + 1 < h ? y0 + 1 : h - 1;
        const fx = x - x0, fy = y - y0;
        const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
        const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy, w11 = fx * fy;
        out[0] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
        out[1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
        out[2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
    }

    // Same as sample(), but UVs outside the matcap disc are pulled onto its rim.
    function sampleDisc(data, w, h, u, v, out) {
        const nu = (u - 0.5) * 2, nv = (v - 0.5) * 2;
        const r2 = nu * nu + nv * nv;
        if (r2 > 0.990025) {
            const k = 0.995 / Math.sqrt(r2);
            u = 0.5 + nu * k * 0.5;
            v = 0.5 + nv * k * 0.5;
        }
        sample(data, w, h, u, v, out);
    }

    const smooth = t => { t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); };

    // ---- compositing of extra matcap layers over the base ----
    function ensureComposite(layerDefs) {
        const active = layerDefs.filter(l => layerPx.has(l.id));
        const key = baseVer + '|' + layerVer + '|' +
            active.map(l => l.id + ':' + l.opacity + ':' + l.blend).join(',');
        if (composite && key === compKey) return;
        compKey = key;
        pyramid = null;

        if (!active.length) { composite = base.data; return; }

        const out = new Uint8ClampedArray(base.data);
        const n = base.w * base.h;
        for (const l of active) {
            const px = layerPx.get(l.id);
            if (!px || px.length < n * 4) continue;
            const op = l.opacity;
            const fn = BLEND[l.blend] || BLEND.normal;
            for (let i = 0, j = 0; i < n; i++, j += 4) {
                const a = (px[j + 3] / 255) * op;
                if (a <= 0) continue;
                const bR = out[j] / 255, bG = out[j + 1] / 255, bB = out[j + 2] / 255;
                out[j]     += (fn(bR, px[j] / 255) * 255 - out[j]) * a;
                out[j + 1] += (fn(bG, px[j + 1] / 255) * 255 - out[j + 1]) * a;
                out[j + 2] += (fn(bB, px[j + 2] / 255) * 255 - out[j + 2]) * a;
            }
        }
        composite = out;
    }

    // ---- mip pyramid (used for blur back-fill and global softness) ----
    function buildDiscClamped(src, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        const cx = (w - 1) / 2, cy = (h - 1) / 2;
        const R = Math.min(cx, cy);
        const tmp = new Float64Array(3);
        for (let y = 0; y < h; y++) {
            const ny = (y - cy) / R;
            for (let x = 0; x < w; x++) {
                const nx = (x - cx) / R;
                const r = Math.sqrt(nx * nx + ny * ny);
                let sx = x, sy = y;
                if (r > 0.995) {
                    const k = 0.995 / r;
                    sx = cx + nx * k * R;
                    sy = cy + ny * k * R;
                }
                sample(src, w, h, sx / (w - 1), sy / (h - 1), tmp);
                const off = (y * w + x) * 4;
                out[off] = tmp[0]; out[off + 1] = tmp[1]; out[off + 2] = tmp[2]; out[off + 3] = 255;
            }
        }
        return out;
    }

    function buildPyramid(data0, w0, h0) {
        const levels = [{ data: data0, w: w0, h: h0 }];
        let w = w0, h = h0, data = data0;
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

    function getPyramid() {
        if (!pyramid) {
            const clamped = buildDiscClamped(composite, base.w, base.h);
            pyramid = buildPyramid(clamped, base.w, base.h);
            pyramid[0] = { data: composite, w: base.w, h: base.h };
        }
        return pyramid;
    }

    const mipA = new Float64Array(3), mipB = new Float64Array(3);
    function sampleMip(pyr, u, v, level, out) {
        const maxLevel = pyr.length - 1;
        level = level < 0 ? 0 : (level > maxLevel ? maxLevel : level);
        const l0 = level | 0, l1 = l0 + 1 < maxLevel ? l0 + 1 : maxLevel;
        const t = level - l0;
        const p0 = pyr[l0], p1 = pyr[l1];
        sample(p0.data, p0.w, p0.h, u, v, mipA);
        sample(p1.data, p1.w, p1.h, u, v, mipB);
        out[0] = mipA[0] * (1 - t) + mipB[0] * t;
        out[1] = mipA[1] * (1 - t) + mipB[1] * t;
        out[2] = mipA[2] * (1 - t) + mipB[2] * t;
    }

    function makeRotator(rx, ry, rz) {
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cy = Math.cos(ry), sy = Math.sin(ry);
        const cz = Math.cos(rz), sz = Math.sin(rz);
        return (x, y, z, out) => {
            const y1 = y * cx - z * sx, z1 = y * sx + z * cx;
            const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
            out[0] = x2 * cz - y1 * sz;
            out[1] = x2 * sz + y1 * cz;
            out[2] = z2;
        };
    }

    // ---- face generation ----
    // Returns an object of face buffers, or null if the job was aborted.
    async function generate(size, p, job) {
        ensureComposite(p.layers);
        const src = composite, sw = base.w, sh = base.h;
        const rot = makeRotator(p.rx, p.ry, p.rz);

        const mode = (p.backMode === 'matcap' && !back) ? 'blur' : p.backMode;
        const soft = p.softness;
        const pyr = (mode === 'blur' || soft > 0) ? getPyramid() : null;
        const maxLevel = pyr ? pyr.length - 1 : 0;

        const hs = 0.5 / p.scale;
        const bhs = 0.5 / p.backScale;
        const threshold = -(1 - p.backRadius);
        const halfWidth = 0.4 * Math.pow(1 - p.edgeSharp, 2.2) + 0.002;
        const inv2hw = 1 / (2 * halfWidth);

        // Solid fill (premultiplied by its alpha)
        const sA = p.solid[3];
        const sR = p.solid[0] * sA, sG = p.solid[1] * sA, sB = p.solid[2] * sA;

        // Gradient fill (premultiplied interpolation, like CSS gradients)
        const a1 = p.grad1[3], a2 = p.grad2[3];
        const g1R = p.grad1[0] * a1, g1G = p.grad1[1] * a1, g1B = p.grad1[2] * a1;
        const g2R = p.grad2[0] * a2, g2G = p.grad2[1] * a2, g2B = p.grad2[2] * a2;
        const gRange = Math.max(0.001, 1 + threshold);
        const gInv = 1 / (2 * (0.5 * Math.pow(1 - p.gradSharp, 2.2) + 0.0015));
        const gInner = p.gradInner;

        const cF = new Float64Array(3), cB = new Float64Array(3), cS = new Float64Array(3);
        const rv = new Float64Array(3);
        const denom = size - 1;
        const rowsPerChunk = Math.max(4, (32768 / size) | 0);
        const faces = {};

        for (const face of FACES) {
            const bs = BASIS[face];
            rot(bs[0], bs[1], bs[2], rv); const Ax = rv[0], Ay = rv[1], Az = rv[2];
            rot(bs[3], bs[4], bs[5], rv); const Bx = rv[0], By = rv[1], Bz = rv[2];
            rot(bs[6], bs[7], bs[8], rv); const Cx = rv[0], Cy = rv[1], Cz = rv[2];

            const buf = new Uint8ClampedArray(size * size * 4);
            let off = 0;

            for (let row = 0; row < size; row++) {
                if (job.final && row > 0 && row % rowsPerChunk === 0) {
                    await yieldNow();
                    if (job.aborted) return null;
                }
                const b = 1 - 2 * row / denom;
                const rowX = Bx * b + Cx, rowY = By * b + Cy, rowZ = Bz * b + Cz;

                for (let col = 0; col < size; col++, off += 4) {
                    const a = -1 + 2 * col / denom;
                    const il = 1 / Math.sqrt(a * a + b * b + 1);
                    const dx = (Ax * a + rowX) * il;
                    const dy = (Ay * a + rowY) * il;
                    const dz = (Az * a + rowZ) * il;

                    const uF = 0.5 - dz * hs, vF = 0.5 - dy * hs;
                    sampleDisc(src, sw, sh, uF, vF, cF);
                    let r = cF[0], g = cF[1], bl = cF[2];

                    const raw = (threshold - dx) * inv2hw + 0.5;
                    if (raw > 0) {
                        const tB = raw >= 1 ? 1 : raw * raw * (3 - 2 * raw);
                        let br, bg, bb;

                        if (mode === 'matcap') {
                            sampleDisc(back.data, back.w, back.h, 0.5 + dz * bhs, 0.5 - dy * bhs, cB);
                            br = cB[0]; bg = cB[1]; bb = cB[2];
                        } else if (mode === 'gradient') {
                            let dn = (dx + 1) / gRange;
                            dn = dn < 0 ? 0 : (dn > 1 ? 1 : dn);
                            const t = smooth((dn - gInner) * gInv + 0.5);
                            const aa = a1 * (1 - t) + a2 * t;
                            // fill over the matcap underneath
                            br = r * (1 - aa) + g1R * (1 - t) + g2R * t;
                            bg = g * (1 - aa) + g1G * (1 - t) + g2G * t;
                            bb = bl * (1 - aa) + g1B * (1 - t) + g2B * t;
                        } else if (mode === 'color') {
                            br = r * (1 - sA) + sR;
                            bg = g * (1 - sA) + sG;
                            bb = bl * (1 - sA) + sB;
                        } else {
                            const bt = smooth(-dx);
                            sampleMip(pyr, uF, vF, Math.pow(bt, 1.3) * maxLevel, cB);
                            br = cB[0]; bg = cB[1]; bb = cB[2];
                        }

                        r = r * (1 - tB) + br * tB;
                        g = g * (1 - tB) + bg * tB;
                        bl = bl * (1 - tB) + bb * tB;
                    }

                    if (soft > 0) {
                        sampleMip(pyr, uF, vF, soft * maxLevel, cS);
                        r = r * (1 - soft) + cS[0] * soft;
                        g = g * (1 - soft) + cS[1] * soft;
                        bl = bl * (1 - soft) + cS[2] * soft;
                    }

                    buf[off] = r;
                    buf[off + 1] = g;
                    buf[off + 2] = bl;
                    buf[off + 3] = 255;
                }
            }
            faces[face] = buf;
        }
        return faces;
    }

    // ---- job queue: newest request wins; unfinished "final" jobs are aborted ----
    async function startNext() {
        if (running || !queued) return;
        const m = queued;
        queued = null;
        const job = running = { final: m.final, aborted: false };
        try {
            const faces = await generate(m.size, m.p, job);
            if (faces) {
                post({ type: 'faces', seq: m.seq, size: m.size, final: m.final, faces },
                     FACES.map(f => faces[f].buffer));
            }
        } catch (err) {
            post({ type: 'error', message: String((err && err.stack) || err) });
        }
        running = null;
        startNext();
    }

    return {
        handle(m) {
            switch (m.type) {
                case 'setBase':
                    if (running) running.aborted = true;
                    base = { data: m.data, w: m.w, h: m.h };
                    baseVer++;
                    break;
                case 'setLayer':
                    if (running) running.aborted = true;
                    if (m.data) layerPx.set(m.id, m.data); else layerPx.delete(m.id);
                    layerVer++;
                    break;
                case 'setBack':
                    if (running) running.aborted = true;
                    back = m.data ? { data: m.data, w: m.w, h: m.h } : null;
                    break;
                case 'render':
                    if (!base) return;
                    queued = m;
                    if (running && running.final) running.aborted = true;
                    startNext();
                    break;
            }
        }
    };
}

// ------------------------------------------------------------------
// Engine bootstrap (Worker, with main-thread fallback)
// ------------------------------------------------------------------
const engine = (() => {
    try {
        const code = `const core=(${createEngineCore.toString()})((m,t)=>self.postMessage(m,t));` +
                     `self.onmessage=e=>core.handle(e.data);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const worker = new Worker(url);
        worker.onmessage = e => handleEngineMessage(e.data);
        worker.onerror = e => console.error('Render worker error:', e.message);
        return { send: (m, transfer) => worker.postMessage(m, transfer || []) };
    } catch (err) {
        console.warn('Web Worker unavailable, rendering on the main thread.', err);
        const core = createEngineCore(m => setTimeout(() => handleEngineMessage(m), 0));
        return { send: m => setTimeout(() => core.handle(m), 0) };
    }
})();

// ------------------------------------------------------------------
// State (main thread)
// ------------------------------------------------------------------
let baseReady = false, srcW = 0, srcH = 0;
let generatedFaces = null, generatedSize = 0;
let backBmp = null;
let isBallDragging = false;

let renderTimer = null;
let renderSeq = 0, shownSeq = 0;
const DRAFT_SIZE = 128;
const FINAL_DELAY = 250;

// Colours: rgb 0..255, a 0..1
const colorState = {
    solid: { rgb: [26, 26, 26], a: 1 },
    grad1: { rgb: [13, 110, 253], a: 1 },
    grad2: { rgb: [17, 24, 39], a: 1 }
};

const MAX_LAYERS = 16;
const THUMB_PX = 128;

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

// Nothing in this app relies on native drag & drop from inside the page
// (files are dropped from outside). Killing it prevents the browser from
// "picking up" a selection / canvas while a slider is being dragged.
document.addEventListener('dragstart', e => e.preventDefault());

// ------------------------------------------------------------------
// Image decoding / rasterizing
// ------------------------------------------------------------------
const isImageFile = f => !!f && (f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(f.name));
const closeBmp = b => { if (b && typeof b.close === 'function') b.close(); };

async function decodeImage(file) {
    if (!isImageFile(file)) return null;
    try {
        return await createImageBitmap(file);
    } catch (e) {
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
            return null;
        }
    }
}

const scratchCanvas = document.createElement('canvas');
// Returns a fresh Uint8ClampedArray (its buffer can be transferred to the worker).
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
// Slots
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
            <canvas width="${THUMB_PX}" height="${THUMB_PX}" draggable="false"></canvas>
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
        input.value = '';
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
        e.stopPropagation();
        slotEl.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
    });

    return api;
}

// ------------------------------------------------------------------
// Base matcap
// ------------------------------------------------------------------
let baseSeq = 0;
const baseSlot = createSlot({ large: true, onFile: loadBase });
baseSlotHost.appendChild(baseSlot.el);

async function loadBase(file) {
    const seq = ++baseSeq;
    const bmp = await decodeImage(file);
    if (!bmp) return;
    if (seq !== baseSeq) { closeBmp(bmp); return; }

    const w = bmp.width, h = bmp.height;
    const px = rasterize(bmp, w, h);
    srcW = w; srcH = h;
    baseReady = true;
    engine.send({ type: 'setBase', data: px, w, h }, [px.buffer]);

    baseSlot.setPreview(bmp);
    closeBmp(bmp);

    baseName.textContent = file.name;
    baseDims.textContent = `${w} × ${h}`;
    baseInfo.hidden = false;

    layers.forEach(l => rebuildCache(l));

    generateBtn.disabled = false;
    triggerRender(false);
}

// ------------------------------------------------------------------
// Back-face second matcap
// ------------------------------------------------------------------
const backMatcapSlot = createSlot({
    caption: 'Back Matcap',
    clearable: true,
    onFile: loadBackMatcap,
    onClear: clearBackMatcap
});
const backMatcapSlotHost = document.getElementById('backMatcapSlotHost');
if (backMatcapSlotHost) {
    backMatcapSlotHost.appendChild(backMatcapSlot.el);
}

async function loadBackMatcap(file) {
    const bmp = await decodeImage(file);
    if (!bmp) return;
    closeBmp(backBmp);
    backBmp = bmp;
    const w = bmp.width, h = bmp.height;
    const px = rasterize(bmp, w, h);
    engine.send({ type: 'setBack', data: px, w, h }, [px.buffer]);
    backMatcapSlot.setPreview(bmp);
    triggerRender(false);
}

function clearBackMatcap() {
    closeBmp(backBmp);
    backBmp = null;
    engine.send({ type: 'setBack', data: null });
    backMatcapSlot.clear();
    triggerRender(false);
}

// ------------------------------------------------------------------
// Colour controls (solid / gradient) with alpha
// ------------------------------------------------------------------
function hexToRgb(hex) {
    hex = hex.replace(/^#/, '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const num = parseInt(hex, 16);
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

async function pickWithPipette(onColor) {
    if (window.EyeDropper) {
        try {
            const res = await new EyeDropper().open();
            if (res && res.sRGBHex) onColor(res.sRGBHex);
        } catch (err) {}
    }
}

function bindColorControl(key, { picker, alpha, alphaVal, pipette, hexLabel }) {
    if (!picker || !alpha) return;
    const st = colorState[key];

    const apply = (isDraft, render = true) => {
        st.rgb = hexToRgb(picker.value);
        st.a = parseFloat(alpha.value) / 100;
        if (hexLabel) hexLabel.textContent = picker.value;
        if (alphaVal) alphaVal.textContent = Math.round(parseFloat(alpha.value));
        alpha.style.setProperty('--alpha-color', picker.value);
        if (render) triggerRender(isDraft);
    };

    // 'input' fires continuously while dragging inside the native picker;
    // rendering is coalesced in the worker so this stays cheap.
    picker.addEventListener('input', () => apply(true));
    picker.addEventListener('change', () => apply(false));
    alpha.addEventListener('input', () => apply(true));
    alpha.addEventListener('change', () => apply(false));

    if (pipette) {
        pipette.addEventListener('click', () => {
            if (window.EyeDropper) {
                pickWithPipette(hex => { picker.value = hex; apply(false); });
            } else {
                picker.click();
            }
        });
    }
    apply(false, false);
}

bindColorControl('solid', {
    picker: document.getElementById('backColorPicker'),
    alpha: document.getElementById('backColorAlpha'),
    alphaVal: document.getElementById('backColorAlphaVal'),
    pipette: document.getElementById('pipetteBtn'),
    hexLabel: document.getElementById('backColorHex')
});
bindColorControl('grad1', {
    picker: document.getElementById('gradColor1Picker'),
    alpha: document.getElementById('gradColor1Alpha'),
    alphaVal: document.getElementById('gradColor1AlphaVal'),
    pipette: document.getElementById('pipetteGrad1')
});
bindColorControl('grad2', {
    picker: document.getElementById('gradColor2Picker'),
    alpha: document.getElementById('gradColor2Alpha'),
    alphaVal: document.getElementById('gradColor2AlphaVal'),
    pipette: document.getElementById('pipetteGrad2')
});

// ------------------------------------------------------------------
// Layers
// ------------------------------------------------------------------
const layers = [];
let nextLayerId = 1;

// Rasterize the layer's matcap at base resolution and hand it to the engine.
function rebuildCache(layer) {
    if (layer.matcap && baseReady) {
        const px = rasterize(layer.matcap, srcW, srcH);
        layer.hasPx = true;
        engine.send({ type: 'setLayer', id: layer.id, data: px }, [px.buffer]);
    } else {
        layer.hasPx = false;
        engine.send({ type: 'setLayer', id: layer.id, data: null });
    }
}

function layersChanged() {
    triggerRender(false);
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
    layer.seq = (layer.seq || 0) + 1;
    closeBmp(layer.matcap);
    layer.matcap = null;
    rebuildCache(layer);
    layersChanged();
}

function renumberLayers() {
    [...layersContainer.children].forEach((card, i) => {
        card.querySelector('.layer-title').textContent = `Layer ${i + 1}`;
    });
}

function updateAddLayerState() {
    addLayerBtn.disabled = layers.length >= MAX_LAYERS;
}

function createLayerCard(layer) {
    const card = document.createElement('div');
    card.className = 'settings-area p-3 border rounded bg-light layer-card';
    card.innerHTML = `
        <div class="d-flex justify-content-between align-items-center mb-2">
            <h3 class="layer-title mb-0">Layer</h3>
            <button type="button" class="btn btn-sm btn-outline-danger remove-layer-btn" title="Remove layer">×</button>
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
        <div class="layer-sliders">
            <div class="slider-row">
                <div class="d-flex justify-content-between small text-muted">
                    <span>Opacity</span><strong class="val">1.00</strong>
                </div>
                <input type="range" class="form-range" min="0" max="1" step="0.01" value="1">
            </div>
        </div>`;

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
        layersChanged();
    });

    const opInput = card.querySelector('.layer-sliders input');
    const opVal = card.querySelector('.layer-sliders .val');
    opInput.addEventListener('input', () => {
        const v = parseFloat(opInput.value);
        opVal.textContent = v.toFixed(2);
        layer.opacity = v;
        triggerRender(true);
    });
    opInput.addEventListener('change', () => triggerRender(false));

    card.querySelector('.remove-layer-btn').addEventListener('click', () => removeLayer(layer, card));
    return card;
}

function addLayer() {
    if (layers.length >= MAX_LAYERS) return;
    const layer = {
        id: nextLayerId++,
        matcap: null,
        hasPx: false,
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
    layer.matcap = null;
    layers.splice(idx, 1);
    engine.send({ type: 'setLayer', id: layer.id, data: null });
    card.remove();
    renumberLayers();
    updateAddLayerState();
    layersChanged();
}

addLayerBtn.addEventListener('click', addLayer);

// ------------------------------------------------------------------
// Drag & drop base matcap
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
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

addLayer();

// ------------------------------------------------------------------
// Interactive UI & Unified Slider Binder
// ------------------------------------------------------------------
function setupInteractiveSlider(id, valId, formatFn = v => v) {
    const input = document.getElementById(id);
    const valSpan = document.getElementById(valId);
    if (!input) return;

    input.addEventListener('input', () => {
        if (valSpan) valSpan.textContent = formatFn(parseFloat(input.value));
        triggerRender(true);
    });
    input.addEventListener('change', () => triggerRender(false));
}

setupInteractiveSlider('rotX', 'rotXVal', v => Math.round(v));
setupInteractiveSlider('rotY', 'rotYVal', v => Math.round(v));
setupInteractiveSlider('rotZ', 'rotZVal', v => Math.round(v));

const rotXEl = document.getElementById('rotX');
const rotYEl = document.getElementById('rotY');
if (rotXEl && rotYEl) {
    const updateBallFromInputs = () => updateHandlePosition(parseFloat(rotXEl.value), parseFloat(rotYEl.value));
    rotXEl.addEventListener('input', updateBallFromInputs);
    rotYEl.addEventListener('input', updateBallFromInputs);
}

setupInteractiveSlider('matcapScale', 'matcapScaleVal', v => v.toFixed(2));
setupInteractiveSlider('backMatcapScale', 'backMatcapScaleVal', v => v.toFixed(2));
setupInteractiveSlider('gradInnerRadius', 'gradInnerRadiusVal', v => Math.round(v));
setupInteractiveSlider('gradSharpness', 'gradSharpnessVal', v => Math.round(v));
setupInteractiveSlider('backRadius', 'backRadiusVal', v => v.toFixed(2));
setupInteractiveSlider('backEdgeSharpness', 'backEdgeSharpnessVal', v => Math.round(v));
setupInteractiveSlider('globalSoftness', 'globalSoftnessVal', v => Math.round(v));

// ------------------------------------------------------------------
// Rotation & 3D Ball
// ------------------------------------------------------------------
function updateHandlePosition(pitchDeg, yawDeg) {
    if (!ballController || !ballHandle) return;
    const radius = ballController.clientWidth / 2;
    const normX = (yawDeg / 180);
    const normY = (-pitchDeg / 180);
    ballHandle.style.left = `${radius + normX * (radius - 6)}px`;
    ballHandle.style.top = `${radius + normY * (radius - 6)}px`;
}

function handleBallMove(e) {
    if (!isBallDragging || !ballController) return;
    const rect = ballController.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = (e.clientX - cx) / (rect.width / 2);
    let dy = (e.clientY - cy) / (rect.height / 2);
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
    triggerRender(true);
}

if (ballController) {
    // Pointer events + pointer capture: works for mouse/touch/pen and keeps
    // receiving moves even when the cursor leaves the ball.
    ballController.addEventListener('pointerdown', e => {
        e.preventDefault();
        isBallDragging = true;
        try { ballController.setPointerCapture(e.pointerId); } catch (err) {}
        handleBallMove(e);
    });
    ballController.addEventListener('pointermove', handleBallMove);
    const stopBallDrag = () => {
        if (isBallDragging) {
            isBallDragging = false;
            triggerRender(false);
        }
    };
    ballController.addEventListener('pointerup', stopBallDrag);
    ballController.addEventListener('pointercancel', stopBallDrag);
}

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
        triggerRender(false);
    });
}

function updateBackFillUI() {
    const mode = getBackFillMode();
    const colorArea = document.getElementById('backColorArea');
    const gradArea = document.getElementById('backGradientArea');
    const matcapArea = document.getElementById('backMatcapArea');

    if (colorArea) colorArea.style.display = mode === 'color' ? 'block' : 'none';
    if (gradArea) gradArea.style.display = mode === 'gradient' ? 'block' : 'none';
    if (matcapArea) matcapArea.style.display = mode === 'matcap' ? 'block' : 'none';
}

document.querySelectorAll('input[name="backFill"]').forEach(input => {
    input.addEventListener('change', () => {
        updateBackFillUI();
        triggerRender(false);
    });
});
updateBackFillUI();

['faceSize', 'pixelFormat', 'flipRows'].forEach(name => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
        input.addEventListener('change', () => triggerRender(false));
    });
});

function getBackFillMode() {
    const checked = document.querySelector('input[name="backFill"]:checked');
    return checked ? checked.value : 'blur';
}

const readNum = (id, fallback, div = 1) => {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) / div : fallback;
};
const getBackMatcapScale = () => readNum('backMatcapScale', 1.0);
const getBackRadius = () => readNum('backRadius', 1.0);
const getBackEdgeSharpness = () => readNum('backEdgeSharpness', 0.25, 100);
const getGradInnerRadius = () => readNum('gradInnerRadius', 0.5, 100);
const getGradSharpness = () => readNum('gradSharpness', 0.0, 100);
const getGlobalSoftness = () => readNum('globalSoftness', 0, 100);
const getMatcapScale = () => readNum('matcapScale', 1.0);

function getRotations() {
    const rx = parseFloat(rotXInput?.value || 0) * Math.PI / 180;
    const ry = parseFloat(rotYInput?.value || 0) * Math.PI / 180;
    const rz = parseFloat(rotZInput?.value || 0) * Math.PI / 180;
    return { rx, ry, rz };
}

// ------------------------------------------------------------------
// Render scheduling (main thread side)
// ------------------------------------------------------------------
function collectParams() {
    const { rx, ry, rz } = getRotations();
    const c = colorState;
    return {
        rx, ry, rz,
        backMode: getBackFillMode(),
        softness: getGlobalSoftness(),
        scale: getMatcapScale(),
        backScale: getBackMatcapScale(),
        backRadius: getBackRadius(),
        edgeSharp: getBackEdgeSharpness(),
        gradSharp: getGradSharpness(),
        gradInner: getGradInnerRadius(),
        solid: [...c.solid.rgb, c.solid.a],
        grad1: [...c.grad1.rgb, c.grad1.a],
        grad2: [...c.grad2.rgb, c.grad2.a],
        layers: layers
            .filter(l => l.hasPx && l.opacity > 0)
            .map(l => ({ id: l.id, opacity: l.opacity, blend: l.blendMode || 'normal' }))
    };
}

function requestRender(size, final) {
    engine.send({ type: 'render', seq: ++renderSeq, size, final, p: collectParams() });
}

// isDraft: quick low-res preview now, full-res result once input settles.
function triggerRender(isDraft = false) {
    if (!baseReady) return;
    clearTimeout(renderTimer);
    if (isDraft) {
        requestRender(Math.min(DRAFT_SIZE, getFaceSize()), false);
        renderTimer = setTimeout(() => requestRender(getFaceSize(), true), FINAL_DELAY);
    } else {
        requestRender(getFaceSize(), true);
    }
}

function handleEngineMessage(m) {
    if (m.type === 'error') {
        console.error('Render error:', m.message);
        return;
    }
    if (m.type !== 'faces' || m.seq < shownSeq) return;
    shownSeq = m.seq;
    if (m.final) {
        generatedFaces = m.faces;
        generatedSize = m.size;
    }
    renderPreview(m.faces, m.size);
}

function renderPreview(faces, size) {
    const holder = document.getElementById('facesOutput');
    resultArea.style.display = 'block';
    const placeholder = document.getElementById('mainPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    for (const face of FACES) {
        let cell = holder.querySelector(`.face-cell[data-face="${face}"]`);
        let canvas;
        if (!cell) {
            cell = document.createElement('div');
            cell.className = 'face-cell';
            cell.dataset.face = face;
            canvas = document.createElement('canvas');
            canvas.draggable = false;
            const label = document.createElement('span');
            label.textContent = face;
            cell.appendChild(canvas);
            cell.appendChild(label);
            holder.appendChild(cell);
        } else {
            canvas = cell.querySelector('canvas');
        }

        if (canvas.width !== size || canvas.height !== size) {
            canvas.width = size;
            canvas.height = size;
        }
        canvas.getContext('2d').putImageData(new ImageData(faces[face], size, size), 0, 0);
    }
}

const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

generateBtn.addEventListener('click', () => triggerRender(false));

// ------------------------------------------------------------------
// Export & VTF Packing
// ------------------------------------------------------------------
const VTF_FORMATS = {
    RGBA8888: 0,
    BGR888: 3,
    BGRA8888: 12,
    DXT1: 13,
    RGBA16161616F: 24,
};

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
        [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3],
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