function createEngineCore(post) {
    'use strict';

    const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

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

    let base = null;
    let back = null;
    const layerPx = new Map();
    let baseVer = 0, layerVer = 0;
    let composite = null, compKey = '';
    let pyramid = null;

    let running = null, queued = null;

    const chan = new MessageChannel();
    const yieldNow = () => new Promise(res => {
        chan.port1.onmessage = () => res();
        chan.port2.postMessage(0);
    });

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

        const sA = p.solid[3];
        const sR = p.solid[0] * sA, sG = p.solid[1] * sA, sB = p.solid[2] * sA;

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

let baseReady = false, srcW = 0, srcH = 0;
let generatedFaces = null, generatedSize = 0;
let backBmp = null;
let isBallDragging = false;

let renderTimer = null;
let renderSeq = 0, shownSeq = 0;
const DRAFT_SIZE = 128;
const FINAL_DELAY = 250;

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

document.addEventListener('dragstart', e => e.preventDefault());

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
function rasterize(src, w, h) {
    scratchCanvas.width = w;
    scratchCanvas.height = h;
    const ctx = scratchCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
}

function drawCover(ctx, bmp, size, fit) {
    const s = Math.max(size / bmp.width, size / bmp.height);
    const dw = bmp.width * s, dh = bmp.height * s;
    const ox = (size - dw) / 2, oy = (size - dh) / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, ox, oy, dw, dh);
    if (fit) {
        const cx = ox + fit.cx * dw, cy = oy + fit.cy * dh;
        const r = fit.r * Math.min(bmp.width, bmp.height) * s;
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ff2d95';
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
}

function normalizeMatcap(src, fit, size) {
    const w = src.width, h = src.height;
    const R = fit.r * Math.min(w, h);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, fit.cx * w - R, fit.cy * h - R, 2 * R, 2 * R, 0, 0, size, size);
    return c;
}

function fitOutSize(bmp, fit) {
    const s = Math.round(2 * fit.r * Math.min(bmp.width, bmp.height));
    return Math.max(64, Math.min(2048, s));
}

function detectDisc(bmp) {
    const k = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const w = Math.max(8, Math.round(bmp.width * k));
    const h = Math.max(8, Math.round(bmp.height * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;

    const at = (x, y) => {
        x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
        const i = (y * w + x) * 4;
        return [d[i], d[i + 1], d[i + 2], d[i + 3]];
    };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

    let box = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    let found = null;

    for (let iter = 0; iter < 3; iter++) {
        const cols = [
            at(box.x0 + 1, box.y0 + 1), at(box.x1 - 1, box.y0 + 1),
            at(box.x0 + 1, box.y1 - 1), at(box.x1 - 1, box.y1 - 1)
        ];
        const alphaBg = cols.every(c => c[3] < 16);
        let bg = [0, 0, 0, 255];
        if (!alphaBg) {
            if (cols.some(c => dist(c, cols[0]) > 40)) break;
            bg = cols[0];
        }
        const rowCnt = new Int32Array(h), colCnt = new Int32Array(w);
        let total = 0;
        for (let y = box.y0; y <= box.y1; y++) {
            for (let x = box.x0; x <= box.x1; x++) {
                const p = at(x, y);
                const on = alphaBg ? p[3] > 16 : (p[3] > 16 && dist(p, bg) > 24);
                if (on) { rowCnt[y]++; colCnt[x]++; total++; }
            }
        }
        let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
        for (let x = 0; x < w; x++) if (colCnt[x] >= 2) { if (x0 < 0) x0 = x; x1 = x; }
        for (let y = 0; y < h; y++) if (rowCnt[y] >= 2) { if (y0 < 0) y0 = y; y1 = y; }
        if (x0 < 0 || y0 < 0) break;

        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        found = { x0, y0, x1, y1, bw, bh };
        const fill = total / (bw * bh);
        const shrunk = (box.x1 - box.x0 + 1 - bw) > 2 || (box.y1 - box.y0 + 1 - bh) > 2;
        if (fill > 0.92 && shrunk) { box = { x0, y0, x1, y1 }; continue; }
        break;
    }
    if (!found) return null;

    let cx = (found.x0 + found.x1 + 1) / 2 / w;
    let cy = (found.y0 + found.y1 + 1) / 2 / h;
    let r = ((found.bw + found.bh) / 4) / Math.min(w, h);
    if (r < 0.15 || r > 0.75) return null;
    if (r > 0.49 && Math.abs(cx - 0.5) < 0.01 && Math.abs(cy - 0.5) < 0.01) { cx = 0.5; cy = 0.5; r = 0.5; }
    return { cx, cy, r };
}

function createFitPanel({ getBitmap, onChange }) {
    const fit = { cx: 0.5, cy: 0.5, r: 0.5 };
    const el = document.createElement('details');
    el.className = 'fit-panel mt-2';
    el.innerHTML = `
        <summary>Circle fit</summary>
        <div class="pt-2">
            <div class="d-flex justify-content-between small text-muted"><span>Circle size</span><span><strong data-v="d">100</strong>%</span></div>
            <input type="range" class="form-range" data-k="d" min="20" max="150" step="0.1" value="100">
            <div class="d-flex justify-content-between small text-muted"><span>Offset X</span><span><strong data-v="x">0</strong>%</span></div>
            <input type="range" class="form-range" data-k="x" min="-50" max="50" step="0.1" value="0">
            <div class="d-flex justify-content-between small text-muted"><span>Offset Y</span><span><strong data-v="y">0</strong>%</span></div>
            <input type="range" class="form-range" data-k="y" min="-50" max="50" step="0.1" value="0">
            <div class="d-flex gap-2 mt-1">
                <button type="button" class="btn btn-sm btn-outline-secondary flex-fill" data-act="auto">Auto-detect</button>
                <button type="button" class="btn btn-sm btn-outline-secondary flex-fill" data-act="reset">Reset</button>
            </div>
        </div>`;
    const q = s => el.querySelector(s);
    const inD = q('[data-k="d"]'), inX = q('[data-k="x"]'), inY = q('[data-k="y"]');

    function syncUI() {
        inD.value = fit.r * 200; inX.value = (fit.cx - 0.5) * 100; inY.value = (fit.cy - 0.5) * 100;
        q('[data-v="d"]').textContent = (fit.r * 200).toFixed(1);
        q('[data-v="x"]').textContent = ((fit.cx - 0.5) * 100).toFixed(1);
        q('[data-v="y"]').textContent = ((fit.cy - 0.5) * 100).toFixed(1);
    }
    function readUI() {
        fit.r = parseFloat(inD.value) / 200;
        fit.cx = 0.5 + parseFloat(inX.value) / 100;
        fit.cy = 0.5 + parseFloat(inY.value) / 100;
        syncUI();
    }
    [inD, inX, inY].forEach(inp => {
        inp.addEventListener('input', () => { readUI(); onChange(true); });
        inp.addEventListener('change', () => { readUI(); onChange(false); });
    });
    q('[data-act="auto"]').addEventListener('click', () => {
        const bmp = getBitmap();
        if (!bmp) return;
        const r = detectDisc(bmp) || { cx: 0.5, cy: 0.5, r: 0.5 };
        Object.assign(fit, r); syncUI(); onChange(false);
    });
    q('[data-act="reset"]').addEventListener('click', () => {
        Object.assign(fit, { cx: 0.5, cy: 0.5, r: 0.5 }); syncUI(); onChange(false);
    });

    return {
        el, fit,
        autoFit(bmp) {
            Object.assign(fit, detectDisc(bmp) || { cx: 0.5, cy: 0.5, r: 0.5 });
            syncUI();
        }
    };
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
        setPreview(bmp, fit) {
            drawCover(ctx, bmp, THUMB_PX, fit);
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

let baseSeq = 0;
let baseBmp = null;
const baseSlot = createSlot({ large: true, onFile: loadBase });
baseSlotHost.appendChild(baseSlot.el);

const baseFit = createFitPanel({
    getBitmap: () => baseBmp,
    onChange: draft => applyBase(draft)
});
document.getElementById('baseFitHost').appendChild(baseFit.el);

async function loadBase(file) {
    const seq = ++baseSeq;
    const bmp = await decodeImage(file);
    if (!bmp) return;
    if (seq !== baseSeq) { closeBmp(bmp); return; }

    closeBmp(baseBmp);
    baseBmp = bmp;
    baseFit.autoFit(bmp);

    baseName.textContent = file.name;
    baseInfo.hidden = false;
    applyBase(false);
}

function applyBase(draft) {
    if (!baseBmp) return;
    const fit = baseFit.fit;
    const size = fitOutSize(baseBmp, fit);
    const px = rasterize(normalizeMatcap(baseBmp, fit, size), size, size);
    srcW = size; srcH = size;
    baseReady = true;
    engine.send({ type: 'setBase', data: px, w: size, h: size }, [px.buffer]);

    baseSlot.setPreview(baseBmp, fit);
    baseDims.textContent = `${baseBmp.width} × ${baseBmp.height}  →  sphere ${size} px`;

    layers.forEach(l => rebuildCache(l));

    generateBtn.disabled = false;
    ['dlAnimPack', 'dlAnimHdr'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = false;
    });
    triggerRender(draft);
}

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

const backFit = createFitPanel({
    getBitmap: () => backBmp,
    onChange: draft => applyBack(draft)
});
const backFitHost = document.getElementById('backFitHost');
if (backFitHost) backFitHost.appendChild(backFit.el);

async function loadBackMatcap(file) {
    const bmp = await decodeImage(file);
    if (!bmp) return;
    closeBmp(backBmp);
    backBmp = bmp;
    backFit.autoFit(bmp);
    applyBack(false);
}

function applyBack(draft) {
    if (!backBmp) return;
    const size = fitOutSize(backBmp, backFit.fit);
    const px = rasterize(normalizeMatcap(backBmp, backFit.fit, size), size, size);
    engine.send({ type: 'setBack', data: px, w: size, h: size }, [px.buffer]);
    backMatcapSlot.setPreview(backBmp, backFit.fit);
    triggerRender(draft);
}

function clearBackMatcap() {
    closeBmp(backBmp);
    backBmp = null;
    engine.send({ type: 'setBack', data: null });
    backMatcapSlot.clear();
    triggerRender(false);
}

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

const layers = [];
let nextLayerId = 1;

function rebuildCache(layer) {
    if (layer.matcap && baseReady) {
        const px = rasterize(normalizeMatcap(layer.matcap, layer.fitPanel.fit, srcW), srcW, srcH);
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
    layer.fitPanel.autoFit(bmp);
    slot.setPreview(bmp, layer.fitPanel.fit);
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

    layer.fitPanel = createFitPanel({
        getBitmap: () => layer.matcap,
        onChange: draft => {
            if (!layer.matcap) return;
            matcapSlot.setPreview(layer.matcap, layer.fitPanel.fit);
            rebuildCache(layer);
            triggerRender(draft);
        }
    });
    card.appendChild(layer.fitPanel.el);

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

document.querySelectorAll('input[name="faceSize"]').forEach(input => {
    input.addEventListener('change', () => triggerRender(false));
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

function triggerRender(isDraft = false) {
    if (!baseReady || animBusy) return;
    clearTimeout(renderTimer);
    const size = getFaceSize();
    if (isDraft) {
        requestRender(Math.min(DRAFT_SIZE, size), false);
        renderTimer = setTimeout(() => requestRender(size, true), FINAL_DELAY);
    } else {
        requestRender(size, true);
    }
}

const framePending = new Map();
let animBusy = false;

function handleEngineMessage(m) {
    if (m.type === 'error') {
        console.error('Render error:', m.message);
        for (const h of framePending.values()) h.reject(new Error(m.message));
        framePending.clear();
        return;
    }
    if (m.type === 'faces' && framePending.has(m.seq)) {
        const h = framePending.get(m.seq);
        framePending.delete(m.seq);
        h.resolve(m);
        return;
    }
    if (m.type !== 'faces' || m.seq < shownSeq) return;
    shownSeq = m.seq;
    if (m.final) {
        generatedFaces = m.faces;
        generatedSize = m.size;
        if (baseBmp) {
            const cv = normalizeMatcap(baseBmp, baseFit.fit, m.size);
            generatedFaces.sphere = cv.getContext('2d').getImageData(0, 0, m.size, m.size).data;
        }
    }
    renderPreview(m.faces, m.size);
}

function canvasPngBytes(canvas) {
    const bin = atob(canvas.toDataURL('image/png').split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function renderPreview(faces, size) {
    const holder = document.getElementById('facesOutput');
    resultArea.style.display = 'block';
    const placeholder = document.getElementById('mainPlaceholder');
    if (placeholder) placeholder.style.display = 'none';

    if (baseBmp) {
        let mc = holder.querySelector('.face-cell[data-face="matcap"] canvas');
        if (!mc) {
            const cell = document.createElement('div');
            cell.className = 'face-cell';
            cell.dataset.face = 'matcap';
            mc = document.createElement('canvas');
            mc.draggable = false;
            const label = document.createElement('span');
            label.textContent = 'matcap';
            cell.appendChild(mc);
            cell.appendChild(label);
            holder.appendChild(cell);
        }
        const f = baseFit.fit;
        const key = `${size}|${f.cx}|${f.cy}|${f.r}`;
        if (mc._bmp !== baseBmp || mc._key !== key) {
            mc.width = mc.height = size;
            mc.getContext('2d').drawImage(normalizeMatcap(baseBmp, f, size), 0, 0);
            mc._bmp = baseBmp;
            mc._key = key;
        }
    }

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

function downsampleFaceN(rgba, size, times) {
    let cur = rgba, curSize = size;
    for (let i = 0; i < times; i++) {
        cur = downsampleFace(cur, curSize);
        curSize /= 2;
    }
    return { faces: cur, size: curSize };
}

function scaleFacesDown(faces, curSize, targetSize) {
    if (!faces || targetSize >= curSize) return faces;
    const times = Math.round(Math.log2(curSize / targetSize));
    if (times <= 0) return faces;
    const outFaces = {};
    for (const face of FACES) {
        outFaces[face] = downsampleFaceN(faces[face], curSize, times).faces;
    }
    if (faces.sphere) {
        outFaces.sphere = downsampleFaceN(faces.sphere, curSize, times).faces;
    }
    return outFaces;
}

function buildMipChain(faces, size, minSize) {
    const chain = [{ size, faces }];
    let curSize = size, curFaces = faces;
    while (curSize > minSize) {
        const nextSize = curSize / 2;
        const nextFaces = {};
        for (const face of FACES) nextFaces[face] = downsampleFace(curFaces[face], curSize);
        if (curFaces.sphere) nextFaces.sphere = downsampleFace(curFaces.sphere, curSize);
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
        writeFace(level.faces.sphere || level.faces[FACES[0]], level.size);
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

function getMatPath() {
    const matInput = document.getElementById('matPath');
    return matInput ? matInput.value.trim() : 'material';
}

function getFaceSize() {
    const checked = document.querySelector('input[name="faceSize"]:checked');
    return checked ? parseInt(checked.value, 10) : 512;
}

function getHdrFaceSize() {
    const checked = document.querySelector('input[name="hdrFaceSize"]:checked');
    return checked ? parseInt(checked.value, 10) : 256;
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

let exportRendered = false;

async function getFacesAt(size) {
    if (size <= generatedSize) return scaleFacesDown(generatedFaces, generatedSize, size);
    exportRendered = true;
    const res = await renderFrameAsync(size, collectParams());
    if (baseBmp) {
        const cv = normalizeMatcap(baseBmp, baseFit.fit, size);
        res.faces.sphere = cv.getContext('2d').getImageData(0, 0, size, size).data;
    }
    return res.faces;
}

function setupExport(id, run) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', async () => {
        if (!generatedFaces || btn.disabled) return;
        btn.disabled = true;
        try {
            await run();
        } catch (err) {
            console.error(err);
        } finally {
            btn.disabled = false;
            if (exportRendered) {
                exportRendered = false;
                triggerRender(false);
            }
        }
    });
}

const fileBase = () => getMatPath().split('/').pop();

setupExport('dlVtf', async () => {
    const size = getFaceSize();
    const faces = await getFacesAt(size);
    download(buildVTF(faces, size, getFlipRows(), getPixelFormat()), fileBase() + '_env.vtf', 'application/octet-stream');
});

setupExport('dlVtfHdr', async () => {
    const size = getHdrFaceSize();
    const faces = await getFacesAt(size);
    download(buildVTFHDR(faces, size, getFlipRows()), fileBase() + '_env.hdr.vtf', 'application/octet-stream');
});

setupExport('dlPngZip', async () => {
    const size = getFaceSize();
    const faces = await getFacesAt(size);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const files = FACES.map(face => {
        ctx.putImageData(new ImageData(faces[face], size, size), 0, 0);
        return { name: `matcap_${face}.png`, data: canvasPngBytes(canvas) };
    });
    const mcCanvas = document.querySelector('.face-cell[data-face="matcap"] canvas');
    if (mcCanvas) files.push({ name: 'matcap_original.png', data: canvasPngBytes(mcCanvas) });
    download(buildZip(files), fileBase() + '_faces.zip', 'application/zip');
});

function buildVTFAnimated(frameFaces, size, flipRows, format) {
    const minSize = format === 'DXT1' ? 4 : 1;
    const frameCount = frameFaces.length;
    const chains = frameFaces.map(f => buildMipChain(f, size, minSize));
    const mipCount = chains[0].length;

    const headerSize = 64;
    let bodySize = 0;
    for (const level of chains[0]) bodySize += faceByteSize(level.size, format) * 7 * frameCount;
    const buf = new ArrayBuffer(headerSize + bodySize);
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
    wU32(0x00004000 | 0x00000200);
    wU16(frameCount); wU16(0);
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

    for (let mip = mipCount - 1; mip >= 0; mip--) {
        for (let fr = 0; fr < frameCount; fr++) {
            const level = chains[fr][mip];
            for (const face of FACES) writeFace(level.faces[face], level.size);
            writeFace(level.faces.sphere || level.faces[FACES[0]], level.size);
        }
    }
    return new Uint8Array(buf);
}

function prepareFramesForSize(frameFaces, curSize, targetSize) {
    if (targetSize >= curSize) return { frames: frameFaces, size: curSize };
    const times = Math.round(Math.log2(curSize / targetSize));
    if (times <= 0) return { frames: frameFaces, size: curSize };
    let finalSize = targetSize;
    const scaledFrames = frameFaces.map(f => {
        const outFaces = {};
        for (const face of FACES) {
            const r = downsampleFaceN(f[face], curSize, times);
            outFaces[face] = r.faces;
            finalSize = r.size;
        }
        if (f.sphere) {
            outFaces.sphere = downsampleFaceN(f.sphere, curSize, times).faces;
        }
        return outFaces;
    });
    return { frames: scaledFrames, size: finalSize };
}

function renderFrameAsync(size, p) {
    return new Promise((resolve, reject) => {
        const seq = ++renderSeq;
        framePending.set(seq, { resolve, reject });
        engine.send({ type: 'render', seq, size, final: true, p });
        setTimeout(() => {
            if (framePending.delete(seq)) reject(new Error('Frame render timed out'));
        }, 60000);
    });
}

function animVmtSnippet(envPath, frames) {
    return `// Add to your VMT (keep your other parameters and proxies):
"$envmap" "${envPath}"
"$envmapframe" 0

// Source Engine will automatically load "${envPath}.hdr.vtf" in HDR mode,
// or "${envPath}.vtf" in LDR mode.

Proxies
{
    dih_envmapcameraspace
    {
        "offset" "180"
        "frames" "${frames}"
    }
}
`;
}

(function setupAnimPack() {
    const btnPack = document.getElementById('dlAnimPack');
    const btnHdr = document.getElementById('dlAnimHdr');
    const framesInput = document.getElementById('animFrames');
    const reverse = document.getElementById('animReverse');
    const includeHdrCheckbox = document.getElementById('animIncludeHdr');
    const includeExamplesCheckbox = document.getElementById('animIncludeExamples');
    const framesVal = document.getElementById('animFramesVal');
    const status = document.getElementById('animStatus');
    const stepLabel = document.getElementById('animStep');
    if (!btnPack || !framesInput) return;

    let animCache = null;

    const FRAME_STEPS = [4, 5, 6, 8, 9, 10, 12, 15, 18, 20, 24, 30, 36, 40, 45, 60, 72, 90, 120, 180, 360];
    const readFrames = () => FRAME_STEPS[Math.max(0, Math.min(FRAME_STEPS.length - 1, parseInt(framesInput.value, 10) || 0))];
    const getAnimAxis = () => {
        const checked = document.querySelector('input[name="animAxis"]:checked');
        return checked ? checked.value : 'y';
    };

    const updateStep = () => {
        const N = readFrames();
        const perFrame = size => faceByteSize(size, 'RGBA16161616F') * 7 * 4 / 3;
        const ldrSize = Math.min(getFaceSize(), 256);
        const hdrSize = Math.min(getHdrFaceSize(), 256);
        let bytes = N * faceByteSize(ldrSize, getPixelFormat()) * 7 * 4 / 3;
        if (!includeHdrCheckbox || includeHdrCheckbox.checked) bytes += N * perFrame(hdrSize);
        framesVal.textContent = N;
        stepLabel.textContent = `${(360 / N).toFixed(1).replace(/\.0$/, '')}°/frame, ~${(bytes / 1048576).toFixed(1)} MB`;
    };
    framesInput.addEventListener('input', updateStep);
    document.querySelectorAll('input[name="faceSize"], input[name="hdrFaceSize"], input[name="pixelFormat"], #animIncludeHdr')
        .forEach(el => el.addEventListener('change', updateStep));
    updateStep();

    document.querySelectorAll('input[name="animAxis"]').forEach(r => {
        r.addEventListener('change', () => { animCache = null; });
    });
    if (reverse) reverse.addEventListener('change', () => { animCache = null; });

    const setBusy = busy => {
        animBusy = busy;
        btnPack.disabled = busy || !baseReady;
        if (btnHdr) btnHdr.disabled = busy || !baseReady;
    };

    if (baseReady) {
        btnPack.disabled = false;
        if (btnHdr) btnHdr.disabled = false;
    }

    async function getOrRenderFrames(N, size, axis, dir) {
        const basePars = collectParams();
        const cfgKey = `${N}|${size}|${axis}|${dir}|${JSON.stringify(basePars)}`;
        if (animCache && animCache.key === cfgKey) {
            return animCache.frames;
        }

        let sphere = null;
        if (baseBmp) {
            const cv = normalizeMatcap(baseBmp, baseFit.fit, size);
            sphere = cv.getContext('2d').getImageData(0, 0, size, size).data;
        }

        const frames = [];
        for (let i = 0; i < N; i++) {
            status.textContent = `Rendering frame ${i + 1} / ${N}…`;
            const angleOffset = dir * i * 2 * Math.PI / N;
            const p = Object.assign({}, basePars);
            if (axis === 'x') {
                p.rx = basePars.rx + angleOffset;
            } else if (axis === 'z') {
                p.rz = basePars.rz + angleOffset;
            } else {
                p.ry = basePars.ry + angleOffset;
            }

            const res = await renderFrameAsync(size, p);
            if (sphere) res.faces.sphere = sphere;
            frames.push(res.faces);
        }

        animCache = { key: cfgKey, frames, size };
        return frames;
    }

    btnPack.addEventListener('click', async () => {
        if (!baseReady || animBusy) return;
        const N = readFrames();
        const ldrSize = Math.min(getFaceSize(), 256);
        const hdrSize = Math.min(getHdrFaceSize(), 256);
        const renderSize = Math.max(ldrSize, hdrSize);

        const format = getPixelFormat();
        const flip = getFlipRows();
        const dir = reverse.checked ? -1 : 1;
        const axis = getAnimAxis();
        const includeHdr = includeHdrCheckbox ? includeHdrCheckbox.checked : true;

        setBusy(true);
        clearTimeout(renderTimer);
        try {
            const rawFrames = await getOrRenderFrames(N, renderSize, axis, dir);

            status.textContent = 'Packing VTF…';
            await new Promise(r => setTimeout(r, 0));
            const { frames: ldrFrames } = prepareFramesForSize(rawFrames, renderSize, ldrSize);
            const vtf = buildVTFAnimated(ldrFrames, ldrSize, flip, format);

            const matPath = getMatPath();
            const last = matPath.split('/').pop();
            const vtfName = last + '_envanim.vtf';
            const files = [{ name: vtfName, data: vtf }];
            if (!includeExamplesCheckbox || includeExamplesCheckbox.checked) {
                files.push({ name: 'vmt_snippet.txt', data: new TextEncoder().encode(animVmtSnippet(matPath + '_envanim', N)) });
            }

            let hdrInfo = '';
            if (includeHdr) {
                status.textContent = 'Packing HDR VTF…';
                await new Promise(r => setTimeout(r, 0));
                const { frames: hdrFrames } = prepareFramesForSize(rawFrames, renderSize, hdrSize);
                const vtfHdr = buildVTFAnimated(hdrFrames, hdrSize, flip, 'RGBA16161616F');
                files.push({ name: last + '_envanim.hdr.vtf', data: vtfHdr });
                hdrInfo = ` + HDR (${hdrSize}px, ${(vtfHdr.length / 1048576).toFixed(2)} MB)`;
            }

            status.textContent = 'Zipping files…';
            await new Promise(r => setTimeout(r, 0));
            download(buildZip(files), last + '_envanim_pack.zip', 'application/zip');
            status.textContent = `Done: ${N} frames (${axis.toUpperCase()}), LDR (${ldrSize}px, ${(vtf.length / 1048576).toFixed(2)} MB)${hdrInfo}`;
        } catch (err) {
            console.error(err);
            status.textContent = 'Failed: ' + (err && err.message ? err.message : err);
        } finally {
            setBusy(false);
            triggerRender(false);
        }
    });

    if (btnHdr) {
        btnHdr.addEventListener('click', async () => {
            if (!baseReady || animBusy) return;
            const N = readFrames();
            const hdrSize = Math.min(getHdrFaceSize(), 256);
            const flip = getFlipRows();
            const dir = reverse.checked ? -1 : 1;
            const axis = getAnimAxis();

            setBusy(true);
            clearTimeout(renderTimer);
            try {
                const rawFrames = await getOrRenderFrames(N, hdrSize, axis, dir);

                status.textContent = 'Packing HDR VTF…';
                await new Promise(r => setTimeout(r, 0));
                const vtfHdr = buildVTFAnimated(rawFrames, hdrSize, flip, 'RGBA16161616F');

                const matPath = getMatPath();
                const last = matPath.split('/').pop();
                download(vtfHdr, last + '_envanim.hdr.vtf', 'application/octet-stream');
                status.textContent = `Done: HDR downloaded (${N} frames, ${hdrSize}px, ${(vtfHdr.length / 1048576).toFixed(2)} MB)`;
            } catch (err) {
                console.error(err);
                status.textContent = 'Failed: ' + (err && err.message ? err.message : err);
            } finally {
                setBusy(false);
                triggerRender(false);
            }
        });
    }
})();
