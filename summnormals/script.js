document.addEventListener('DOMContentLoaded', () => {
    const baseInput = document.getElementById('baseMap');
    const detailInput = document.getElementById('detailMap');
    const strengthRange = document.getElementById('strengthRange');
    const strengthVal = document.getElementById('strengthVal');
    const outCanvas = document.getElementById('outCanvas');
    const downloadBtn = document.getElementById('downloadBtn');

    const gl = outCanvas.getContext('webgl', { preserveDrawingBuffer: true });

    const scaleRange = document.getElementById('scaleRange');
    const scaleVal = document.getElementById('scaleVal');

    if (!gl) return alert("WebGL не поддерживается вашим браузером");

    let textures = { base: null, detail: null };
    let imagesLoaded = { base: false, detail: false };
    let renderRequested = false;

    const vsSource = `
        attribute vec2 a_position;
        varying vec2 v_texCoord;
        void main() {
            gl_Position = vec4(a_position, 0, 1);
            v_texCoord = (a_position + 1.0) / 2.0;
            v_texCoord.y = 1.0 - v_texCoord.y; 
        }`;

    const fsSource = `
        precision highp float;
        uniform sampler2D u_baseMap;
        uniform sampler2D u_detailMap;
        uniform float u_strength;
        uniform float u_scale;
        varying vec2 v_texCoord;

        void main() {
            vec3 n1 = texture2D(u_baseMap, v_texCoord).rgb * 2.0 - 1.0;
            
            vec2 scaledCoord = mod(v_texCoord * u_scale, 1.0);
            vec3 n2 = texture2D(u_detailMap, scaledCoord).rgb * 2.0 - 1.0;

            n2.xy *= u_strength;
            n2 = normalize(n2);

            n1 += vec3(0.0, 0.0, 1.0);
            n2 *= vec3(-1.0, -1.0, 1.0);
            vec3 r = n1 * dot(n1, n2) / n1.z - n2;
            
            gl_FragColor = vec4(normalize(r) * 0.5 + 0.5, 1.0);
        }`;


    const program = createProgram(gl, vsSource, fsSource);
    const positionLoc = gl.getAttribLocation(program, "a_position");
    const baseLoc = gl.getUniformLocation(program, "u_baseMap");
    const detailLoc = gl.getUniformLocation(program, "u_detailMap");
    const strengthLoc = gl.getUniformLocation(program, "u_strength");
    const scaleLoc = gl.getUniformLocation(program, "u_scale");


    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

    function render() {
        if (!imagesLoaded.base || !imagesLoaded.detail) return;

        gl.viewport(0, 0, outCanvas.width, outCanvas.height);
        gl.useProgram(program);

        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textures.base);
        gl.uniform1i(baseLoc, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, textures.detail);
        gl.uniform1i(detailLoc, 1);

        gl.uniform1f(strengthLoc, parseFloat(strengthRange.value));
        gl.uniform1f(scaleLoc, parseFloat(scaleRange.value)); 

        gl.drawArrays(gl.TRIANGLES, 0, 6);
        renderRequested = false;
    }

    function requestRender() {
        if (!renderRequested) {
            renderRequested = true;
            requestAnimationFrame(render);
        }
    }

    async function onImageSelect(input, type) {
        const file = input.files[0];
        if (!file) return;
        
        if (textures[type]) {
            gl.deleteTexture(textures[type]);
        }

        const img = await loadImage(file);
        
        if (type === 'base') {
            outCanvas.width = img.width;
            outCanvas.height = img.height;
            imagesLoaded.base = true;
        } else {
            imagesLoaded.detail = true;
        }
        
        textures[type] = createTexture(gl, img);
        updatePreview(type === 'base' ? 'basePreview' : 'detailPreview', img.src, type.toUpperCase());
        
        render(); 
        
        const currentSrc = img.src;
        setTimeout(() => URL.revokeObjectURL(currentSrc), 100); 
    }

    strengthRange.addEventListener('input', () => {
        strengthVal.textContent = parseFloat(strengthRange.value).toFixed(2);
        requestRender(); 
    });

    scaleRange.addEventListener('input', () => {
        scaleVal.textContent = parseFloat(scaleRange.value).toFixed(2);
        requestRender(); 
    });

    baseInput.addEventListener('change', () => onImageSelect(baseInput, 'base'));
    detailInput.addEventListener('change', () => onImageSelect(detailInput, 'detail'));

    downloadBtn.addEventListener('click', () => {
        if (!imagesLoaded.base || !imagesLoaded.detail) {
            return alert("Загрузите оба изображения!");
        }

        render(); 
        
        downloadBtn.disabled = true;
        downloadBtn.textContent = "Processing...";

        outCanvas.toBlob((blob) => {
            if (!blob) {
                alert("Connection error.");
                downloadBtn.disabled = false;
                return;
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = 'combined_normal.png';
            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 100);
            downloadBtn.disabled = false;
            downloadBtn.textContent = "Download PNG";
        }, 'image/png');
    });

    function createTexture(gl, img) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        return tex;
    }

    function createProgram(gl, vs, fs) {
        const s1 = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(s1, vs); gl.compileShader(s1);
        const s2 = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(s2, fs); gl.compileShader(s2);
        const prog = gl.createProgram();
        gl.attachShader(prog, s1); gl.attachShader(prog, s2);
        gl.linkProgram(prog);
        return prog;
    }

    function loadImage(file) {
        return new Promise(res => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => res(img);
            img.src = url;
        });
    }

    function updatePreview(id, src, label) {
        const container = document.getElementById(id);
        container.innerHTML = `<span class="node-label">${label}</span><img src="${src}" style="max-width:100%; max-height:100%;">`;
    }

    window.addEventListener('dragover', e => e.preventDefault(), false);
    window.addEventListener('drop', e => e.preventDefault(), false);
        
    [baseInput, detailInput].forEach(input => {
        const zone = input.parentElement.querySelector('.drop-zone');

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            zone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        zone.addEventListener('dragover', () => zone.classList.add('bg-light'));
        zone.addEventListener('dragleave', () => zone.classList.remove('bg-light'));

        zone.addEventListener('drop', (e) => {
            zone.classList.remove('bg-light');
            
            const dt = e.dataTransfer;
            const files = dt.files;

            if (files.length > 0) {
                input.files = files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    });
});