let srcData = null, srcW = 0, srcH = 0;
let generatedFaces = null, generatedSize = 0;

const imageInput = document.getElementById('imageInput');
const dropArea = document.getElementById('drop-area');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');
const resultArea = document.getElementById('resultArea');

// ---------- Функция загрузки и обработки изображения ----------
function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) {
        statusEl.textContent = 'Error: Please upload a valid image file.';
        return;
    }
    const img = new Image();
    img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, img.width, img.height);
        srcData = id.data; srcW = img.width; srcH = img.height;
        generateBtn.disabled = false;
        statusEl.textContent = `Loaded: ${file.name} (${img.width}×${img.height})`;
    };
    img.src = URL.createObjectURL(file);
}

// Загрузка через обычный инпут
imageInput.addEventListener('change', () => {
    if (imageInput.files && imageInput.files[0]) {
        handleFile(imageInput.files[0]);
    }
});

// ---------- Drag & Drop поддержка ----------

// Отменяем стандартное поведение браузера (открытие файла вместо загрузки)
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    document.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, false);
});

// Эффект подсвечивания при наведении на зону загрузки
if (dropArea) {
    ['dragenter', 'dragover'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.classList.add('drag-active'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropArea.addEventListener(eventName, () => dropArea.classList.remove('drag-active'), false);
    });
}

// Обработка сброса файла (drop) в любое место страницы
document.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
        handleFile(dt.files[0]);
    }
});

// ---------- Генерация кубмапы ----------

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

function generateFaces(size) {
    const result = {};
    for (const face of FACES) {
        const buf = new Uint8ClampedArray(size * size * 4);
        for (let row = 0; row < size; row++) {
            const b = 1 - 2 * row / (size - 1);
            for (let col = 0; col < size; col++) {
                const a = -1 + 2 * col / (size - 1);
                let [dx, dy, dz] = faceDir(face, a, b);
                const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                dx /= len; dy /= len; dz /= len;
                const m = 2 * Math.sqrt(Math.max(dx * dx + dy * dy + (dz + 1) * (dz + 1), 1e-6));
                const u = dx / m + 0.5;
                const v = 1 - (dy / m + 0.5);
                const [r, g, bl] = bilinear(u, v);
                const off = (row * size + col) * 4;
                buf[off] = r; buf[off + 1] = g; buf[off + 2] = bl; buf[off + 3] = 255;
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
    for (const face of FACES) {
        const cell = document.createElement('div');
        cell.className = 'face-cell';
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

// ---------- VTF pixel format packing ----------

const VTF_FORMATS = {
    RGBA8888: 0,
    BGR888: 3,
    BGRA8888: 12,
    DXT1: 13,
};

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
        default: return rgba;
    }
}
function faceByteSize(size, format) {
    switch (format) {
        case 'BGRA8888': return size * size * 4;
        case 'BGR888': return size * size * 3;
        case 'DXT1': return (size / 4) * (size / 4) * 8;
        default: return size * size * 4;
    }
}

// ---------- VTF file assembly ----------

function buildVTF(faces, size, flipRows, format) {
    const headerSize = 64;
    const faceBytes = faceByteSize(size, format);
    const totalSize = headerSize + faceBytes * 7;
    const buf = new ArrayBuffer(totalSize);
    const dv = new DataView(buf);
    let o = 0;
    const wU8 = v => { dv.setUint8(o, v); o += 1; };
    const wU16 = v => { dv.setUint16(o, v, true); o += 2; };
    const wU32 = v => { dv.setUint32(o, v, true); o += 4; };
    const wF32 = v => { dv.setFloat32(o, v, true); o += 4; };

    wU8(0x56); wU8(0x46); wU8(0x54); wU8(0x00);
    wU32(7); wU32(1);
    wU32(headerSize);
    wU16(size); wU16(size);
    const ENVMAP = 0x00004000, NOMIP = 0x00000100, NOLOD = 0x00000200;
    wU32(ENVMAP | NOMIP | NOLOD);
    wU16(1); wU16(0);
    wU32(0);
    wF32(0.5); wF32(0.5); wF32(0.5);
    wU32(0);
    wF32(1.0);
    wU32(VTF_FORMATS[format]);
    wU8(1);
    dv.setInt32(o, -1, true); o += 4;
    wU8(0); wU8(0);
    wU8(0);

    const writeFace = (rawRgba) => {
        let src = rawRgba;
        if (flipRows) {
            const rowBytes = size * 4;
            const flipped = new Uint8ClampedArray(rawRgba.length);
            for (let row = 0; row < size; row++) {
                flipped.set(rawRgba.subarray(row * rowBytes, (row + 1) * rowBytes), (size - 1 - row) * rowBytes);
            }
            src = flipped;
        }
        const packed = packFace(src, size, format);
        new Uint8Array(buf, o, faceBytes).set(packed);
        o += faceBytes;
    };

    for (const face of FACES) writeFace(faces[face]);
    writeFace(faces[FACES[0]]);

    return new Uint8Array(buf);
}

function getMatPath() {
    const matInput = document.getElementById('matPath');
    return matInput ? matInput.value.trim() : 'material';
}

function buildVMT(matPath) {
    const envName = matPath + '_env';
    return `"UnlitGeneric"
{
    // matcap look: reflection only, no base texture
    "$envmap"        "${envName}"
    "$envmaptint"    "[1 1 1]"
    "$envmapfresnel" 0
    "$nofog"         0
}
`;
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

generateBtn.addEventListener('click', () => {
    if (!srcData) return;
    statusEl.textContent = 'Generating faces...';
    generateBtn.disabled = true;
    setTimeout(() => {
        const size = getFaceSize();
        const faces = generateFaces(size);
        generatedFaces = faces; generatedSize = size;
        renderPreview(faces, size);
        document.getElementById('vmtPreview').textContent = buildVMT(getMatPath());
        statusEl.textContent = 'Done.';
        generateBtn.disabled = false;
    }, 20);
});

document.getElementById('dlVtf').addEventListener('click', () => {
    if (!generatedFaces) return;
    const flip = getFlipRows();
    const format = getPixelFormat();
    const vtf = buildVTF(generatedFaces, generatedSize, flip, format);
    const matPath = getMatPath();
    const name = matPath.split('/').pop() + '_env.vtf';
    download(vtf, name, 'application/octet-stream');
});

document.getElementById('dlVmt').addEventListener('click', () => {
    const matPath = getMatPath();
    const vmt = buildVMT(matPath);
    const name = matPath.split('/').pop() + '.vmt';
    download(new TextEncoder().encode(vmt), name, 'text/plain');
});

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
    download(zip, 'matcap_faces.zip', 'application/zip');
});