document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    // ------------------------------------------------------------------
    // DOM
    // ------------------------------------------------------------------
    const byId = id => document.getElementById(id);
    const appShell = byId('appShell');
    const appMain = byId('appMain');
    const baseSlotHost = byId('baseSlotHost');
    const baseInfo = byId('baseInfo');
    const baseName = byId('baseName');
    const baseDims = byId('baseDims');
    const layersContainer = byId('layersContainer');
    const addLayerBtn = byId('addLayerBtn');
    const downloadBtn = byId('downloadBtn');
    const canvas = byId('outCanvas');
    const previewBox = byId('previewBox');
    const mainPlaceholder = byId('mainPlaceholder');
    const resultArea = byId('resultArea');
    const zoomLabel = byId('zoomLabel');
    const fitBtn = byId('fitBtn');
    const actualBtn = byId('actualBtn');
    const toast = byId('toast');

    // ------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------
    const MAX_LAYERS = 64;        // passes are cheap; the real limit is GPU memory
    const DRAFT_SCALE = 0.5;      // preview resolution factor while sliders/pan/zoom are moving
    const SETTLE_MS = 150;        // idle time before the full-quality re-render
    const MAX_VIEW_SCALE = 32;    // max zoom: screen px per image px
    const EXPORT_TILE = 2048;     // export is rendered in tiles to keep GPU memory bounded
    const THUMB_PX = 128;         // thumbnail backing size (shown at 64 css px)
    const ACCEPT = '.jpg,.jpeg,.png,.webp,.bmp';
    const DL_HTML = '<i class="fi-download"></i> Download PNG';

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

    let toastTimer = 0;
    function showError(msg) {
        toast.textContent = msg;
        toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
    }

    // ------------------------------------------------------------------
    // WebGL 2
    // ------------------------------------------------------------------
    const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
    });
    if (!gl) {
        mainPlaceholder.textContent = 'WebGL 2 is not supported by this browser';
        mainPlaceholder.style.cursor = 'default';
        addLayerBtn.disabled = true;
        return;
    }
    canvas.addEventListener('webglcontextlost', e => {
        e.preventDefault();
        showError('GPU context lost. Reload the page.');
    });

    const MAX_TEX = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    // Half-float intermediates avoid 8-bit rounding piling up across many layers.
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_color_buffer_half_float');

    function createRT(w, h, float) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (float) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { tex, fbo, w, h, ok };
    }

    function destroyRT(rt) {
        if (!rt) return;
        gl.deleteFramebuffer(rt.fbo);
        gl.deleteTexture(rt.tex);
    }

    let useFloatRT = true;
    {
        const probe = createRT(4, 4, true);
        useFloatRT = probe.ok;
        destroyRT(probe);
    }

    // ------------------------------------------------------------------
    // Shaders
    // ------------------------------------------------------------------
    // Fullscreen triangle, no vertex buffers needed.
    const VS = `#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

    // u_center / u_span map the target pixel grid to image UV, which is what
    // lets the same shader render a zoomed viewport or an export tile.
    const FS_HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform vec2 u_size;
uniform vec2 u_center;
uniform vec2 u_span;
out vec4 outColor;
vec2 imageUV() {
    vec2 s = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y) / u_size;
    return u_center + (s - 0.5) * u_span;
}
`;

    const FS_BASE = FS_HEAD + `
uniform sampler2D u_base;
void main() {
    vec2 uv = imageUV();
    vec3 c = texture(u_base, uv).rgb;
    bool inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
    outColor = inside ? vec4(c, 1.0) : vec4(0.0);
}`;

    const FS_LAYER = FS_HEAD + `
uniform sampler2D u_src;
uniform sampler2D u_detail;
uniform sampler2D u_mask;
uniform float u_strength;
uniform float u_scale;

vec3 blendNormals(vec3 n1, vec3 n2) {
    n1 += vec3(0.0, 0.0, 1.0);
    n2 *= vec3(-1.0, -1.0, 1.0);
    return normalize(n1 * dot(n1, n2) / n1.z - n2);
}

void main() {
    vec2 uv = imageUV();
    // Sample first, branch later: keeps derivatives (mip selection) well defined.
    vec3 d = texture(u_detail, uv * u_scale).rgb * 2.0 - 1.0;
    float m = texture(u_mask, uv).r;
    vec4 src = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0);

    d.xy *= u_strength;
    d = normalize(d);
    vec3 n = normalize(src.rgb * 2.0 - 1.0);
    n = normalize(mix(n, blendNormals(n, d), m));
    outColor = src.a > 0.5 ? vec4(n * 0.5 + 0.5, 1.0) : vec4(0.0);
}`;

    function compile(type, source) {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(s);
            gl.deleteShader(s);
            throw new Error(log);
        }
        return s;
    }

    function createProgram(fsSource) {
        const vs = compile(gl.VERTEX_SHADER, VS);
        const fs = compile(gl.FRAGMENT_SHADER, fsSource);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(prog));
        }
        const u = {};
        const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(prog, i);
            u[info.name] = gl.getUniformLocation(prog, info.name);
        }
        return { prog, u };
    }

    let baseProg, layerProg;
    try {
        baseProg = createProgram(FS_BASE);
        layerProg = createProgram(FS_LAYER);
    } catch (err) {
        console.error(err);
        showError('Shader compilation failed. See console.');
        return;
    }

    const vao = gl.createVertexArray();

    // ------------------------------------------------------------------
    // Textures
    // ------------------------------------------------------------------
    function createSolidTexture(r, g, b, a) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }
    const whiteTex = createSolidTexture(255, 255, 255, 255);

    // Mipmaps give clean downsampling when the preview shows a 4K map at fit size.
    // WebGL2 allows mipmaps and REPEAT on non-power-of-two textures.
    function uploadTexture(bitmap, repeat) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        return tex;
    }

    // Decode without colour-space conversion or alpha premultiplication:
    // normal maps must reach the shader byte-for-byte.
    async function decodeImage(file) {
        try {
            return await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        } catch (e) {
            try {
                return await createImageBitmap(file);
            } catch (e2) {
                showError(`Can't read "${file.name}" as an image.`);
                return null;
            }
        }
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    const state = {
        base: null,     // { tex, w, h }
        layers: []      // { id, detail, mask, strength, scale, removed }
    };
    let nextLayerId = 1;
    let exporting = false;

    // View: zoom 1 = fit to window; (cx, cy) = image UV at the viewport centre.
    const view = { zoom: 1, cx: 0.5, cy: 0.5 };

    // ------------------------------------------------------------------
    // Render pipeline
    //   base pass -> ping-pong layer passes -> final target
    // One small pass per layer means no texture-unit limit on layer count
    // and no shader recompilation when layers are added or removed.
    // ------------------------------------------------------------------
    function bindTarget(rt, w, h) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fbo : null);
        gl.viewport(0, 0, w, h);
    }

    function bindTex(unit, tex, loc) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(loc, unit);
    }

    function setViewUniforms(u, w, h, v) {
        gl.uniform2f(u.u_size, w, h);
        gl.uniform2f(u.u_center, v.cx, v.cy);
        gl.uniform2f(u.u_span, v.sx, v.sy);
    }

    // rts: two intermediate render targets (only touched when a layer is active).
    // finalRT: null = canvas.
    function renderPipeline(w, h, v, rts, finalRT) {
        const active = state.layers.filter(l => l.detail);
        gl.bindVertexArray(vao);
        gl.disable(gl.BLEND);

        gl.useProgram(baseProg.prog);
        bindTarget(active.length ? rts[0] : finalRT, w, h);
        setViewUniforms(baseProg.u, w, h, v);
        bindTex(0, state.base.tex, baseProg.u.u_base);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        if (!active.length) return;

        const u = layerProg.u;
        gl.useProgram(layerProg.prog);
        let read = 0;
        active.forEach((layer, i) => {
            const last = i === active.length - 1;
            bindTarget(last ? finalRT : rts[1 - read], w, h);
            setViewUniforms(u, w, h, v);
            bindTex(0, rts[read].tex, u.u_src);
            bindTex(1, layer.detail.tex, u.u_detail);
            bindTex(2, layer.mask ? layer.mask.tex : whiteTex, u.u_mask);
            gl.uniform1f(u.u_strength, layer.strength);
            gl.uniform1f(u.u_scale, layer.scale);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            read = 1 - read;
        });
    }

    // ------------------------------------------------------------------
    // Preview: rendered at viewport resolution, not image resolution.
    // Fit view of a 4K map costs ~1000x1000 px of shading; zooming in keeps
    // the pixel count constant but shows the visible region at full detail.
    // ------------------------------------------------------------------
    const previewRTs = [];

    function ensurePreviewRTs(w, h) {
        const rt = previewRTs[0];
        if (rt && rt.w >= w && rt.h >= h) return;
        previewRTs.forEach(destroyRT);
        previewRTs[0] = createRT(w, h, useFloatRT);
        previewRTs[1] = createRT(w, h, useFloatRT);
    }

    function computeMetrics() {
        const W = canvas.clientWidth, H = canvas.clientHeight, b = state.base;
        const fit = Math.min(W / b.w, H / b.h);
        const maxZoom = Math.max(1, MAX_VIEW_SCALE / fit);
        view.zoom = clamp(view.zoom, 1, maxZoom);
        const s = fit * view.zoom;   // screen px per image px
        return { W, H, fit, s, maxZoom, sx: W / (b.w * s), sy: H / (b.h * s) };
    }

    function clampCenter(m) {
        view.cx = m.sx >= 1 ? 0.5 : clamp(view.cx, m.sx / 2, 1 - m.sx / 2);
        view.cy = m.sy >= 1 ? 0.5 : clamp(view.cy, m.sy / 2, 1 - m.sy / 2);
    }

    function render(draft) {
        if (!state.base) return;
        const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
        if (!cssW || !cssH) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const fullW = Math.min(Math.round(cssW * dpr), MAX_TEX);
        const fullH = Math.min(Math.round(cssH * dpr), MAX_TEX);
        const q = draft ? DRAFT_SCALE : 1;
        const w = Math.max(1, Math.round(fullW * q));
        const h = Math.max(1, Math.round(fullH * q));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        const m = computeMetrics();
        clampCenter(m);
        if (state.layers.some(l => l.detail)) ensurePreviewRTs(fullW, fullH);

        renderPipeline(w, h, { cx: view.cx, cy: view.cy, sx: m.sx, sy: m.sy }, previewRTs, null);
        zoomLabel.textContent = Math.round(m.s * 100) + '%';
    }

    // Coalesce to one render per frame. Interactive changes render a cheap
    // draft; a full-quality frame follows once input has been idle briefly.
    let rafId = 0;
    let wantDraft = false;
    let settleTimer = 0;

    function requestRender(draft = false) {
        wantDraft = draft;
        if (draft) {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => requestRender(false), SETTLE_MS);
        }
        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                render(wantDraft);
            });
        }
    }

    new ResizeObserver(() => requestRender(false)).observe(canvas);

    // ------------------------------------------------------------------
    // Zoom / pan
    // ------------------------------------------------------------------
    function zoomAt(newZoom, ax, ay) {
        if (!state.base || !canvas.clientWidth) return;
        const m = computeMetrics();
        const u = view.cx + (ax / m.W - 0.5) * m.sx;
        const v = view.cy + (ay / m.H - 0.5) * m.sy;
        view.zoom = newZoom;
        const m2 = computeMetrics();
        view.cx = u - (ax / m2.W - 0.5) * m2.sx;
        view.cy = v - (ay / m2.H - 0.5) * m2.sy;
        clampCenter(m2);
        requestRender(true);
    }

    function panBy(dx, dy) {
        if (!state.base || !canvas.clientWidth) return;
        const m = computeMetrics();
        view.cx -= dx / (state.base.w * m.s);
        view.cy -= dy / (state.base.h * m.s);
        clampCenter(m);
        requestRender(true);
    }

    function resetView() {
        view.zoom = 1;
        view.cx = 0.5;
        view.cy = 0.5;
        requestRender(false);
    }

    // Zoom that shows real pixels (or a 4x step when the image is already upscaled at fit).
    function actualPixelsZoom(m) {
        const z = 1 / m.fit;
        return z > 1.05 ? z : Math.min(m.maxZoom, 4);
    }

    previewBox.addEventListener('wheel', e => {
        if (!state.base) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        let dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
        dy = clamp(dy, -300, 300);
        const k = e.ctrlKey ? 0.01 : 0.0015;   // ctrl+wheel = trackpad pinch
        zoomAt(view.zoom * Math.exp(-dy * k), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    let drag = null;
    previewBox.addEventListener('pointerdown', e => {
        if (e.button !== 0 || !state.base || e.target.closest('.view-tools')) return;
        drag = { x: e.clientX, y: e.clientY };
        previewBox.setPointerCapture(e.pointerId);
        previewBox.classList.add('dragging');
    });
    previewBox.addEventListener('pointermove', e => {
        if (!drag) return;
        panBy(e.clientX - drag.x, e.clientY - drag.y);
        drag.x = e.clientX;
        drag.y = e.clientY;
    });
    const endDrag = () => {
        drag = null;
        previewBox.classList.remove('dragging');
    };
    previewBox.addEventListener('pointerup', endDrag);
    previewBox.addEventListener('pointercancel', endDrag);

    previewBox.addEventListener('dblclick', e => {
        if (!state.base || e.target.closest('.view-tools')) return;
        const m = computeMetrics();
        if (view.zoom > 1.001) {
            resetView();
        } else {
            const rect = canvas.getBoundingClientRect();
            zoomAt(actualPixelsZoom(m), e.clientX - rect.left, e.clientY - rect.top);
        }
    });

    fitBtn.addEventListener('click', resetView);
    actualBtn.addEventListener('click', () => {
        if (!state.base) return;
        const m = computeMetrics();
        zoomAt(actualPixelsZoom(m), m.W / 2, m.H / 2);
    });

    // ------------------------------------------------------------------
    // UI building blocks
    // ------------------------------------------------------------------
    function drawCover(ctx, bmp, size) {
        const s = Math.max(size / bmp.width, size / bmp.height);
        const dw = bmp.width * s, dh = bmp.height * s;
        ctx.clearRect(0, 0, size, size);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, (size - dw) / 2, (size - dh) / 2, dw, dh);
    }

    // Square, click-or-drop image slot with a cropped thumbnail.
    function createSlot({ caption = '', large = false, clearable = false, onFile, onClear }) {
        const wrap = document.createElement('div');
        wrap.className = 'slot-wrap';
        wrap.innerHTML = `
            <div class="slot${large ? ' slot-lg' : ''}" tabindex="0" role="button" title="Click or drop an image">
                <canvas width="${THUMB_PX}" height="${THUMB_PX}"></canvas>
                ${clearable ? '<button type="button" class="slot-clear" title="Remove" aria-label="Remove">×</button>' : ''}
            </div>
            ${caption ? `<div class="slot-caption">${caption}</div>` : ''}
            <input type="file" hidden accept="${ACCEPT}">`;

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
        input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            val.textContent = v.toFixed(2);
            onInput(v);
        });
        return row;
    }

    // ------------------------------------------------------------------
    // Base map
    // ------------------------------------------------------------------
    const baseSlot = createSlot({ large: true, onFile: loadBase });
    baseSlotHost.appendChild(baseSlot.el);

    async function loadBase(file) {
        const bmp = await decodeImage(file);
        if (!bmp) return;
        if (bmp.width > MAX_TEX || bmp.height > MAX_TEX) {
            bmp.close();
            showError(`Image is larger than the GPU limit (${MAX_TEX}px).`);
            return;
        }
        if (state.base) gl.deleteTexture(state.base.tex);
        state.base = { tex: uploadTexture(bmp, false), w: bmp.width, h: bmp.height };
        baseSlot.setPreview(bmp);
        baseName.textContent = file.name;
        baseDims.textContent = `${bmp.width} × ${bmp.height}`;
        bmp.close();

        baseInfo.hidden = false;
        mainPlaceholder.hidden = true;
        resultArea.hidden = false;
        downloadBtn.disabled = false;
        view.zoom = 1;
        view.cx = 0.5;
        view.cy = 0.5;
        requestRender(false);
    }

    // ------------------------------------------------------------------
    // Layers
    // ------------------------------------------------------------------
    function updateAddLayerState() {
        addLayerBtn.disabled = state.layers.length >= MAX_LAYERS;
        addLayerBtn.title = addLayerBtn.disabled ? `Up to ${MAX_LAYERS} layers` : '';
    }

    function renumberLayers() {
        [...layersContainer.children].forEach((card, i) => {
            card.querySelector('.layer-title').textContent = `Layer ${i + 1}`;
        });
    }

    async function setLayerTexture(layer, key, slot, file) {
        const bmp = await decodeImage(file);
        if (!bmp) return;
        if (layer.removed) { bmp.close(); return; }
        if (bmp.width > MAX_TEX || bmp.height > MAX_TEX) {
            bmp.close();
            showError(`Image is larger than the GPU limit (${MAX_TEX}px).`);
            return;
        }
        if (layer[key]) gl.deleteTexture(layer[key].tex);
        layer[key] = { tex: uploadTexture(bmp, key === 'detail') };
        slot.setPreview(bmp);
        bmp.close();
        requestRender(false);
    }

    function clearLayerTexture(layer, key) {
        if (layer[key]) gl.deleteTexture(layer[key].tex);
        layer[key] = null;
        requestRender(false);
    }

    function createLayerCard(layer) {
        const card = document.createElement('div');
        card.className = 'settings-area p-3 border rounded bg-light layer-card';
        card.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-2">
                <h3 class="layer-title">Layer</h3>
                <button type="button" class="btn btn-sm btn-outline-danger remove-layer-btn" title="Remove layer" aria-label="Remove layer">×</button>
            </div>
            <div class="layer-slots mb-2"></div>
            <div class="layer-sliders"></div>`;

        const detailSlot = createSlot({
            caption: 'Detail',
            clearable: true,
            onFile: f => setLayerTexture(layer, 'detail', detailSlot, f),
            onClear: () => clearLayerTexture(layer, 'detail')
        });
        const maskSlot = createSlot({
            caption: 'Mask',
            clearable: true,
            onFile: f => setLayerTexture(layer, 'mask', maskSlot, f),
            onClear: () => clearLayerTexture(layer, 'mask')
        });
        card.querySelector('.layer-slots').append(detailSlot.el, maskSlot.el);

        const sliders = card.querySelector('.layer-sliders');
        sliders.appendChild(createSlider('Strength', { min: 0, max: 2, step: 0.01, value: 1 }, v => {
            layer.strength = v;
            requestRender(true);
        }));
        sliders.appendChild(createSlider('Scale', { min: 0.1, max: 10, step: 0.1, value: 1 }, v => {
            layer.scale = v;
            requestRender(true);
        }));

        card.querySelector('.remove-layer-btn').addEventListener('click', () => removeLayer(layer, card));
        return card;
    }

    function addLayer() {
        if (state.layers.length >= MAX_LAYERS) return;
        const layer = { id: nextLayerId++, detail: null, mask: null, strength: 1, scale: 1, removed: false };
        state.layers.push(layer);
        layersContainer.appendChild(createLayerCard(layer));
        renumberLayers();
        updateAddLayerState();
    }

    function removeLayer(layer, card) {
        const idx = state.layers.indexOf(layer);
        if (idx === -1) return;
        layer.removed = true;
        if (layer.detail) gl.deleteTexture(layer.detail.tex);
        if (layer.mask) gl.deleteTexture(layer.mask.tex);
        state.layers.splice(idx, 1);
        card.remove();
        renumberLayers();
        updateAddLayerState();
        requestRender(false);
    }

    addLayerBtn.addEventListener('click', addLayer);

    // ------------------------------------------------------------------
    // Drag & drop a base map anywhere on the main area
    // ------------------------------------------------------------------
    const isImageFile = f => !!f && (f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp)$/i.test(f.name));

    mainPlaceholder.addEventListener('click', () => { if (!mainPlaceholder.style.cursor) baseSlot.open(); });
    mainPlaceholder.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            baseSlot.open();
        }
    });
    appMain.addEventListener('dragover', e => {
        e.preventDefault();
        if (!state.base) mainPlaceholder.classList.add('dragover');
    });
    appMain.addEventListener('dragleave', () => mainPlaceholder.classList.remove('dragover'));
    appMain.addEventListener('drop', e => {
        e.preventDefault();
        mainPlaceholder.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (isImageFile(file)) loadBase(file);
    });
    // Don't let a missed drop navigate the page to the image.
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());

    // ------------------------------------------------------------------
    // Export: full resolution, rendered in tiles so memory stays bounded
    // regardless of image size.
    // ------------------------------------------------------------------
    const yieldToUI = () => new Promise(r => setTimeout(r, 0));

    async function exportPNG() {
        const base = state.base;
        if (!base || exporting) return;
        exporting = true;
        appShell.classList.add('is-busy');
        downloadBtn.disabled = true;
        downloadBtn.textContent = 'Rendering 0%';
        await yieldToUI();

        const { w, h } = base;
        const tile = Math.min(EXPORT_TILE, MAX_TEX);
        let inter = [], out = null;
        try {
            inter = [createRT(tile, tile, useFloatRT), createRT(tile, tile, useFloatRT)];
            out = createRT(tile, tile, false);

            const img = new ImageData(w, h);
            const tileBytes = new Uint8Array(tile * tile * 4);
            const tilesX = Math.ceil(w / tile), tilesY = Math.ceil(h / tile);
            const total = tilesX * tilesY;
            let done = 0;

            for (let ty = 0; ty < tilesY; ty++) {
                for (let tx = 0; tx < tilesX; tx++) {
                    const x0 = tx * tile, y0 = ty * tile;
                    const tw = Math.min(tile, w - x0), th = Math.min(tile, h - y0);
                    // Pixel centres of the tile land exactly on source texel centres.
                    const v = { cx: (x0 + tw / 2) / w, cy: (y0 + th / 2) / h, sx: tw / w, sy: th / h };
                    renderPipeline(tw, th, v, inter, out);

                    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
                    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, tileBytes);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

                    // GL rows are bottom-up; ImageData rows are top-down.
                    const rowBytes = tw * 4;
                    for (let j = 0; j < th; j++) {
                        const row = y0 + th - 1 - j;
                        img.data.set(tileBytes.subarray(j * rowBytes, (j + 1) * rowBytes), (row * w + x0) * 4);
                    }

                    done++;
                    downloadBtn.textContent = `Rendering ${Math.round(done / total * 100)}%`;
                    await yieldToUI();
                }
            }

            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            c.getContext('2d').putImageData(img, 0, 0);
            const blob = await new Promise(res => c.toBlob(res, 'image/png'));
            if (!blob) throw new Error('PNG encoding failed');

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = 'combined_normal.png';
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) {
            console.error(err);
            showError('Export failed. The image may be too large for this device.');
        } finally {
            inter.forEach(destroyRT);
            destroyRT(out);
            exporting = false;
            appShell.classList.remove('is-busy');
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = DL_HTML;
            requestRender(false);
        }
    }

    downloadBtn.addEventListener('click', exportPNG);

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    addLayer();
});
