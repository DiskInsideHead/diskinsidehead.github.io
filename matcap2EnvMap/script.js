let srcData = null, srcW = 0, srcH = 0;
let generatedFaces = null, generatedSize = 0;

const imageInput = document.getElementById('imageInput');
const generateBtn = document.getElementById('generateBtn');
const statusEl = document.getElementById('status');
const resultArea = document.getElementById('resultArea');

imageInput.addEventListener('change', () => {
    const f = imageInput.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, img.width, img.height);
        srcData = id.data; srcW = img.width; srcH = img.height;
        generateBtn.disabled = false;
        statusEl.textContent = `Loaded: ${img.width}×${img.height}`;
    };
    img.src = URL.createObjectURL(f);
});

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

function buildVTF(faces, size, flipRows) {
    const headerSize = 64;
    const faceBytes = size * size * 4;
    // VTF v7.1–7.4 cubemap обязан содержать 7 граней: 6 настоящих
    // + 7-я легаси "spheremap" (движком не используется, но без неё
    // размер файла не совпадает с тем, что ждёт заголовок — файл не открывается)
    const totalSize = headerSize + faceBytes * 7;
    const buf = new ArrayBuffer(totalSize);
    const dv = new DataView(buf);
    let o = 0;
    const wU8 = v => { dv.setUint8(o, v); o += 1; };
    const wU16 = v => { dv.setUint16(o, v, true); o += 2; };
    const wU32 = v => { dv.setUint32(o, v, true); o += 4; };
    const wF32 = v => { dv.setFloat32(o, v, true); o += 4; };

    wU8(0x56); wU8(0x54); wU8(0x46); wU8(0x00); // "VTF\0"
    wU32(7); wU32(1);           // version 7.1
    wU32(headerSize);
    wU16(size); wU16(size);
    const ENVMAP = 0x00004000, NOMIP = 0x00000100, NOLOD = 0x00000200;
    wU32(ENVMAP | NOMIP | NOLOD);
    wU16(1); wU16(0);
    wU32(0);
    wF32(0.5); wF32(0.5); wF32(0.5);
    wU32(0);
    wF32(1.0);
    wU32(0); // RGBA8888
    wU8(1);
    dv.setInt32(o, -1, true); o += 4; // no low-res thumb
    wU8(0); wU8(0);
    wU8(0);

    const writeFace = (src) => {
        if (!flipRows) {
            new Uint8Array(buf, o, faceBytes).set(src);
            o += faceBytes;
        } else {
            for (let row = size - 1; row >= 0; row--) {
                const rowBytes = src.subarray(row * size * 4, (row + 1) * size * 4);
                new Uint8Array(buf, o, size * 4).set(rowBytes);
                o += size * 4;
            }
        }
    };

    for (const face of FACES) {
        writeFace(faces[face]);
    }
    // 7-я грань (spheremap-заглушка): дублируем первую — движком не используется,
    // главное чтобы данные были нужного размера
    writeFace(faces[FACES[0]]);

    return new Uint8Array(buf);
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

// Alternative for a regular prop with a texture + a bit of reflection:
// "VertexLitGeneric"
// {
//     "$basetexture"   "${matPath}_base"
//     "$envmap"        "${envName}"
//     "$envmaptint"    "[0.6 0.6 0.6]"
//     "$phong"         0
// }
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
    return parseInt(document.querySelector('input[name="faceSize"]:checked').value, 10);
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
        document.getElementById('vmtPreview').textContent = buildVMT(document.getElementById('matPath').value.trim());
        statusEl.textContent = 'Done.';
        generateBtn.disabled = false;
    }, 20);
});

document.getElementById('dlVtf').addEventListener('click', () => {
    if (!generatedFaces) return;
    const flip = document.getElementById('flipRows').checked;
    const vtf = buildVTF(generatedFaces, generatedSize, flip);
    const matPath = document.getElementById('matPath').value.trim();
    const name = matPath.split('/').pop() + '_env.vtf';
    download(vtf, name, 'application/octet-stream');
});

document.getElementById('dlVmt').addEventListener('click', () => {
    const matPath = document.getElementById('matPath').value.trim();
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
