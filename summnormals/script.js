document.addEventListener('DOMContentLoaded', () => {
    const baseInput = document.getElementById('baseInput');
    const baseThumb = document.getElementById('baseThumb');
    const layersContainer = document.getElementById('layersContainer');
    const addLayerBtn = document.getElementById('addLayerBtn');
    const layerLimitNote = document.getElementById('layerLimitNote');
    const downloadBtn = document.getElementById('downloadBtn');
    const canvas = document.getElementById('outCanvas');
    const mainPlaceholder = document.getElementById('mainPlaceholder');
    const resultArea = document.getElementById('resultArea');

    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) { alert("WebGL не поддерживается вашим браузером"); return; }

    const MAX_TEXTURE_UNITS = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);

    let baseImg = null;
    let baseTex = null;
    let layers = [];
    let nextLayerId = 1;
    let program = null;
    let positionLoc = null;
    let baseLoc = null;
    let whiteTex = null;
    let neutralTex = null;
    let renderRequested = false;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

    const vsSource = `
        attribute vec2 a_position;
        varying vec2 v_texCoord;
        void main() {
            gl_Position = vec4(a_position, 0, 1);
            v_texCoord = (a_position + 1.0) / 2.0;
            v_texCoord.y = 1.0 - v_texCoord.y;
        }`;

    function buildFragmentShader(numLayers) {
        let src = `
            precision highp float;
            uniform sampler2D u_baseMap;
            varying vec2 v_texCoord;
        `;
        for (let i = 0; i < numLayers; i++) {
            src += `
                uniform sampler2D u_detail${i};
                uniform sampler2D u_mask${i};
                uniform bool u_hasMask${i};
                uniform float u_strength${i};
                uniform float u_scale${i};
            `;
        }
        src += `
            vec3 blendNormals(vec3 n1, vec3 n2) {
                n1 += vec3(0.0, 0.0, 1.0);
                n2 *= vec3(-1.0, -1.0, 1.0);
                return normalize(n1 * dot(n1, n2) / n1.z - n2);
            }
            void main() {
                vec3 result = texture2D(u_baseMap, v_texCoord).rgb * 2.0 - 1.0;
        `;
        for (let i = 0; i < numLayers; i++) {
            src += `
                {
                    vec2 uv = mod(v_texCoord * u_scale${i}, 1.0);
                    vec3 n = texture2D(u_detail${i}, uv).rgb * 2.0 - 1.0;
                    n.xy *= u_strength${i};
                    n = normalize(n);
                    float mask = u_hasMask${i} ? texture2D(u_mask${i}, v_texCoord).r : 1.0;
                    vec3 blended = blendNormals(result, n);
                    result = mix(result, blended, mask);
                }
            `;
        }
        src += `
                gl_FragColor = vec4(normalize(result) * 0.5 + 0.5, 1.0);
            }
        `;
        return src;
    }

    function createShader(gl, type, source) {
        const s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(s));
        }
        return s;
    }

    function createProgram(gl, vs, fs) {
        const s1 = createShader(gl, gl.VERTEX_SHADER, vs);
        const s2 = createShader(gl, gl.FRAGMENT_SHADER, fs);
        const prog = gl.createProgram();
        gl.attachShader(prog, s1);
        gl.attachShader(prog, s2);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(prog));
        }
        gl.deleteShader(s1);
        gl.deleteShader(s2);
        return prog;
    }

    function createSolidTexture(r, g, b, a) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    function createTexture(img) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        return tex;
    }

    function loadImage(file) {
        return new Promise(res => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 100); };
            img.src = url;
        });
    }

    whiteTex = createSolidTexture(255, 255, 255, 255);
    neutralTex = createSolidTexture(128, 128, 255, 255);

    function rebuildProgram() {
        if (program) gl.deleteProgram(program);
        const fsSource = buildFragmentShader(layers.length);
        program = createProgram(gl, vsSource, fsSource);
        positionLoc = gl.getAttribLocation(program, 'a_position');
        baseLoc = gl.getUniformLocation(program, 'u_baseMap');
        layers.forEach((layer, i) => {
            layer.loc = {
                detail: gl.getUniformLocation(program, `u_detail${i}`),
                mask: gl.getUniformLocation(program, `u_mask${i}`),
                hasMask: gl.getUniformLocation(program, `u_hasMask${i}`),
                strength: gl.getUniformLocation(program, `u_strength${i}`),
                scale: gl.getUniformLocation(program, `u_scale${i}`),
            };
        });
    }

    function render() {
        if (!baseTex || !program) return;

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(program);

        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

        let unit = 0;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, baseTex);
        gl.uniform1i(baseLoc, unit);
        unit++;

        layers.forEach(layer => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, layer.detailTex || neutralTex);
            gl.uniform1i(layer.loc.detail, unit);
            unit++;

            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, layer.maskTex || whiteTex);
            gl.uniform1i(layer.loc.mask, unit);
            unit++;

            gl.uniform1i(layer.loc.hasMask, layer.maskTex ? 1 : 0);
            gl.uniform1f(layer.loc.strength, layer.strength);
            gl.uniform1f(layer.loc.scale, layer.scale);
        });

        gl.drawArrays(gl.TRIANGLES, 0, 6);
        renderRequested = false;
    }

    function requestRender() {
        if (!renderRequested) {
            renderRequested = true;
            requestAnimationFrame(render);
        }
    }

    function setThumb(el, src) {
        el.style.backgroundImage = `url("${src}")`;
    }

    function clearThumb(el) {
        el.style.backgroundImage = '';
    }

    function usedTextureUnits() {
        return 1 + layers.length * 2;
    }

    function updateAddLayerState() {
        const wouldUse = 1 + (layers.length + 1) * 2;
        addLayerBtn.disabled = wouldUse > MAX_TEXTURE_UNITS;
        layerLimitNote.textContent = addLayerBtn.disabled
            ? `Лимит текстурных юнитов GPU (${MAX_TEXTURE_UNITS}) достигнут`
            : `Слоёв: ${layers.length} (использовано ${usedTextureUnits()}/${MAX_TEXTURE_UNITS} юнитов)`;
    }

    function renumberLayers() {
        [...layersContainer.children].forEach((card, idx) => {
            card.querySelector('.layer-title').textContent = `Layer ${idx + 1}`;
        });
    }

    function createLayerCard(layer) {
        const card = document.createElement('div');
        card.className = 'settings-area p-3 border rounded bg-light layer-card';

        card.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-2">
                <h3 class="mb-0 layer-title">Layer</h3>
                <button type="button" class="btn btn-sm btn-outline-danger remove-layer-btn">×</button>
            </div>
            <div class="layer-thumbs mb-2">
                <div class="layer-thumb detail-thumb"><span class="thumb-label">Detail</span></div>
                <div class="layer-thumb mask-thumb"><span class="thumb-label">Mask</span></div>
            </div>
            <label class="form-label small mb-0 mt-1">Detail map</label>
            <input type="file" class="form-control form-control-sm mb-2 detail-input" accept=".jpg,.jpeg,.png,.webp,.tga,.bmp">
            <label class="form-label small mb-0">Mask (чёрный = без эффекта)</label>
            <div class="d-flex gap-2 mb-2">
                <input type="file" class="form-control form-control-sm mask-input" accept=".jpg,.jpeg,.png,.webp,.tga,.bmp">
                <button type="button" class="btn btn-sm btn-outline-secondary clear-mask-btn">Clear</button>
            </div>
            <div class="d-flex justify-content-between small text-muted">
                <label class="form-label mb-0">Strength:</label>
                <span><strong class="strength-val">1.00</strong></span>
            </div>
            <input type="range" class="form-range strength-range" min="0" max="2" step="0.01" value="1.0">
            <div class="d-flex justify-content-between small text-muted mt-1">
                <label class="form-label mb-0">Scale:</label>
                <span><strong class="scale-val">1.00</strong></span>
            </div>
            <input type="range" class="form-range scale-range" min="0.1" max="10" step="0.1" value="1.0">
        `;

        const detailInput = card.querySelector('.detail-input');
        const maskInput = card.querySelector('.mask-input');
        const clearMaskBtn = card.querySelector('.clear-mask-btn');
        const strengthRange = card.querySelector('.strength-range');
        const strengthVal = card.querySelector('.strength-val');
        const scaleRange = card.querySelector('.scale-range');
        const scaleVal = card.querySelector('.scale-val');
        const detailThumb = card.querySelector('.detail-thumb');
        const maskThumb = card.querySelector('.mask-thumb');
        const removeBtn = card.querySelector('.remove-layer-btn');

        detailInput.addEventListener('change', async () => {
            const file = detailInput.files[0];
            if (!file) return;
            if (layer.detailTex) gl.deleteTexture(layer.detailTex);
            const img = await loadImage(file);
            layer.detailTex = createTexture(img);
            setThumb(detailThumb, img.src);
            requestRender();
        });

        maskInput.addEventListener('change', async () => {
            const file = maskInput.files[0];
            if (!file) return;
            if (layer.maskTex) gl.deleteTexture(layer.maskTex);
            const img = await loadImage(file);
            layer.maskTex = createTexture(img);
            setThumb(maskThumb, img.src);
            requestRender();
        });

        clearMaskBtn.addEventListener('click', () => {
            if (layer.maskTex) gl.deleteTexture(layer.maskTex);
            layer.maskTex = null;
            maskInput.value = '';
            clearThumb(maskThumb);
            requestRender();
        });

        strengthRange.addEventListener('input', () => {
            layer.strength = parseFloat(strengthRange.value);
            strengthVal.textContent = layer.strength.toFixed(2);
            requestRender();
        });

        scaleRange.addEventListener('input', () => {
            layer.scale = parseFloat(scaleRange.value);
            scaleVal.textContent = layer.scale.toFixed(2);
            requestRender();
        });

        removeBtn.addEventListener('click', () => removeLayer(layer.id, card));

        return card;
    }

    function addLayer() {
        const wouldUse = 1 + (layers.length + 1) * 2;
        if (wouldUse > MAX_TEXTURE_UNITS) {
            alert(`Лимит текстурных юнитов GPU (${MAX_TEXTURE_UNITS}) достигнут — больше слоёв не добавить.`);
            return;
        }
        const layer = { id: nextLayerId++, detailTex: null, maskTex: null, strength: 1.0, scale: 1.0 };
        layers.push(layer);
        layersContainer.appendChild(createLayerCard(layer));
        renumberLayers();
        rebuildProgram();
        updateAddLayerState();
        requestRender();
    }

    function removeLayer(id, cardEl) {
        const idx = layers.findIndex(l => l.id === id);
        if (idx === -1) return;
        const layer = layers[idx];
        if (layer.detailTex) gl.deleteTexture(layer.detailTex);
        if (layer.maskTex) gl.deleteTexture(layer.maskTex);
        layers.splice(idx, 1);
        cardEl.remove();
        renumberLayers();
        rebuildProgram();
        updateAddLayerState();
        requestRender();
    }

    baseInput.addEventListener('change', async () => {
        const file = baseInput.files[0];
        if (!file) return;
        if (baseTex) gl.deleteTexture(baseTex);
        const img = await loadImage(file);
        baseImg = img;
        canvas.width = img.width;
        canvas.height = img.height;
        baseTex = createTexture(img);
        setThumb(baseThumb, img.src);
        mainPlaceholder.style.display = 'none';
        resultArea.style.display = 'flex';
        requestRender();
    });

    addLayerBtn.addEventListener('click', addLayer);

    downloadBtn.addEventListener('click', () => {
        if (!baseTex) {
            alert("Сначала загрузите базовую карту нормалей!");
            return;
        }
        render();

        downloadBtn.disabled = true;
        downloadBtn.textContent = "Processing...";

        canvas.toBlob((blob) => {
            if (!blob) {
                alert("Connection error.");
                downloadBtn.disabled = false;
                downloadBtn.textContent = "Download PNG";
                return;
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = 'combined_normal.png';
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
            downloadBtn.disabled = false;
            downloadBtn.innerHTML = '<i class="fi-download"></i> Download PNG';
        }, 'image/png');
    });

    rebuildProgram();
    updateAddLayerState();
    addLayer();
});
