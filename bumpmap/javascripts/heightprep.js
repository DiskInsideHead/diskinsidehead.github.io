/*
 * NMO_HeightPrep
 * --------------
 * Почему появляются "лесенки": карта высот — 8-битная (256 уровней). Гладкий склон
 * превращается в террасы, а Sobel/Scharr + смещение вершин превращают границы террас
 * в тонкие линии-ступеньки. Блюр по готовой карте нормалей только размазывает всё подряд.
 *
 * Здесь высота восстанавливается в float ДО расчёта нормалей и смещения:
 *   1. читаем высоту как float (уровни 0..255);
 *   2. "de-band": итеративно сглаживаем и после каждого шага возвращаем значение
 *      в исходный интервал квантования [v-0.5, v+0.5] (проекция на выпуклые множества).
 *      Террасы превращаются в плавные склоны, а реальные детали остаются, потому что
 *      результат никогда не уходит от исходных данных дальше чем на пол-уровня;
 *   3. нормали и смещение считаются из float-текстуры (FloatType), без потери точности.
 */
var NMO_HeightPrep = new function(){
	var self = this;

	this.iterations = 24;      // сила de-band (0 = выключено)
	this.w = 0;
	this.h = 0;
	this.srcR = null;          // Float32Array, уровни 0..255 (канал R — его читает шейдер нормалей)
	this.srcL = null;          // Float32Array, яркость (как Filters.grayscale)
	this.alpha = null;         // Float32Array 0..1
	this.heightR = null;       // после de-band
	this.heightL = null;
	this.normalTexture = null;
	this.displacementTexture = null;
	this.displacementSize = [1, 1];
	this.ready = false;
	this._token = 0;
	this._img = null;

	/* ---------------- чистые функции (без DOM / WebGL) ---------------- */

	this.blurH = function(src, dst, w, h, r){
		var inv = 1 / (2 * r + 1);
		for (var y = 0; y < h; y++){
			var o = y * w, s = 0, k;
			for (k = -r; k <= r; k++) s += src[o + (((k % w) + w) % w)];
			for (var x = 0; x < w; x++){
				dst[o + x] = s * inv;
				var a = x + r + 1; if (a >= w) a -= w;
				var b = x - r;     if (b < 0)  b += w;
				s += src[o + a] - src[o + b];
			}
		}
	};

	this.blurV = function(src, dst, w, h, r){
		var inv = 1 / (2 * r + 1);
		var col = new Float64Array(w);
		var k, x, y;
		for (k = -r; k <= r; k++){
			var oo = (((k % h) + h) % h) * w;
			for (x = 0; x < w; x++) col[x] += src[oo + x];
		}
		for (y = 0; y < h; y++){
			var o = y * w;
			for (x = 0; x < w; x++) dst[o + x] = col[x] * inv;
			var a = y + r + 1; if (a >= h) a -= h;
			var b = y - r;     if (b < 0)  b += h;
			var oa = a * w, ob = b * w;
			for (x = 0; x < w; x++) col[x] += src[oa + x] - src[ob + x];
		}
	};

	// список радиусов: сначала крупные (дотягиваются до середины широких террас), потом мелкие
	this.schedule = function(iters, w, h){
		var maxR = Math.max(1, Math.min(6, Math.floor(Math.min(w, h) / 4)));
		var radii = [], i;
		for (i = 0; i < iters; i++){
			var t = i / Math.max(1, iters);
			var r = t < 0.25 ? maxR : t < 0.5 ? Math.ceil(maxR / 2) : t < 0.75 ? 2 : 1;
			radii.push(Math.max(1, Math.min(r, maxR)));
		}
		return radii;
	};

	// один шаг: блюр + возврат в интервал квантования
	this.debandStep = function(H, T, src, w, h, r){
		this.blurH(H, T, w, h, r);
		this.blurV(T, H, w, h, r);
		for (var i = 0, n = w * h; i < n; i++){
			var s = src[i], v = H[i];
			if (v > s + 0.5) v = s + 0.5;
			else if (v < s - 0.5) v = s - 0.5;
			H[i] = v;
		}
	};

	// синхронная версия (используется в тестах и как fallback)
	this.debandSync = function(src, w, h, iters){
		var H = new Float32Array(src), T = new Float32Array(w * h);
		var radii = this.schedule(iters, w, h);
		for (var i = 0; i < radii.length; i++) this.debandStep(H, T, src, w, h, radii[i]);
		return H;
	};

	// асинхронная версия: не вешает интерфейс, умеет отменяться по токену
	this.debandAsync = function(src, w, h, iters, token, onProgress, done){
		var H = new Float32Array(src), T = new Float32Array(w * h);
		var radii = this.schedule(iters, w, h), i = 0;
		(function pump(){
			if (token !== self._token) return;           // пришла новая загрузка — бросаем эту
			var t0 = Date.now();
			while (i < radii.length && Date.now() - t0 < 30){
				self.debandStep(H, T, src, w, h, radii[i]);
				i++;
			}
			if (onProgress) onProgress(radii.length ? i / radii.length : 1);
			if (i < radii.length) setTimeout(pump, 0);
			else done(H);
		})();
	};

	/* ---------------- чтение картинки ---------------- */

	this.readPixels = function(img){
		var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
		var c = document.createElement('canvas');
		c.width = w; c.height = h;
		var ctx = c.getContext('2d');
		ctx.drawImage(img, 0, 0, w, h);
		var d = ctx.getImageData(0, 0, w, h).data;
		var n = w * h;
		this.w = w; this.h = h;
		this.srcR = new Float32Array(n);
		this.srcL = new Float32Array(n);
		this.alpha = new Float32Array(n);
		for (var i = 0, p = 0; i < n; i++, p += 4){
			this.srcR[i] = d[p];
			this.srcL[i] = Math.round(0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]);
			this.alpha[i] = d[p + 3] / 255;
		}
	};

	/* ---------------- публичный API ---------------- */

	// Читает картинку и считает de-band. cb вызывается, когда всё готово.
	this.prepare = function(img, cb){
		var token = ++this._token;
		this._img = img;
		this.ready = false;
		this.readPixels(img);
		this._setStatus(0);
		var w = this.w, h = this.h, iters = this.iterations;
		var finish = function(hr, hl){
			if (token !== self._token) return;            // устаревшая загрузка
			self.heightR = hr; self.heightL = hl;
			self.ready = true;
			self._setStatus(-1);
			self.buildNormalTexture();
			if (cb) cb();
		};
		if (iters <= 0){
			finish(this.srcR, this.srcL);
			return;
		}
		var same = this._sameChannels();
		this.debandAsync(this.srcR, w, h, iters, token,
			function(p){ self._setStatus(p * (same ? 1 : 0.5)); },
			function(hr){
				if (same){ finish(hr, hr); return; }
				self.debandAsync(self.srcL, w, h, iters, token,
					function(p){ self._setStatus(0.5 + p * 0.5); },
					function(hl){ finish(hr, hl); });
			});
	};

	// Пересчитать при смене силы de-band (картинка не перечитывается)
	this.setIterations = function(n, cb){
		this.iterations = Math.max(0, Math.min(128, parseInt(n, 10) || 0));
		if (this._img) this.prepare(this._img, cb);
	};

	this._sameChannels = function(){
		// для обычных серых карт R == L: считаем один раз
		var a = this.srcR, b = this.srcL;
		for (var i = 0, n = a.length; i < n; i++) if (a[i] !== b[i]) return false;
		return true;
	};

	this._setStatus = function(p){
		var el = typeof document !== 'undefined' ? document.getElementById('deband_status') : null;
		if (!el) return;
		el.textContent = p < 0 ? '' : 'Сглаживание высоты… ' + Math.round(p * 100) + '%';
	};

	/* ---------------- WebGL-текстуры ---------------- */

	this.floatSupported = function(){
		try {
			var gl = NMO_RenderView.renderer.getContext();
			return !!gl.getExtension('OES_texture_float');
		} catch (e){ return false; }
	};

	// float-текстура высоты для шейдера нормалей: .r = высота (0..1), .a = альфа
	this.buildNormalTexture = function(){
		if (typeof THREE === 'undefined' || !this.heightR) return;
		var w = this.w, h = this.h, data = new Float32Array(w * h * 2);
		for (var y = 0; y < h; y++){
			var sy = h - 1 - y;                        // DataTexture не переворачивается по Y
			for (var x = 0; x < w; x++){
				var si = sy * w + x, di = (y * w + x) * 2;
				data[di] = this.heightR[si] / 255;
				data[di + 1] = this.alpha[si];
			}
		}
		if (this.normalTexture) this.normalTexture.dispose();
		var tex = new THREE.DataTexture(data, w, h, THREE.LuminanceAlphaFormat, THREE.FloatType);
		tex.minFilter = tex.magFilter = THREE.NearestFilter;
		tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;
		this.normalTexture = tex;
	};

	// подставить float-высоту в шейдер нормалей
	this.applyToNormalView = function(){
		var nv = NMO_RenderNormalview;
		if (!this.normalTexture || !nv.normalmap_uniforms) return;
		nv.height_map = this.normalTexture;
		nv.normalmap_uniforms["tHeightMap"].value = this.normalTexture;
		nv.normalmap_uniforms["dimensions"].value = [this.w, this.h, 0];
	};

	// float-текстура смещения для 3D (контраст и инверсия — как в шейдере displacement)
	this.updateDisplacement = function(){
		if (typeof THREE === 'undefined' || !this.ready || !NMO_RenderView.material) return;
		var uu = NMO_RenderView.material.uniforms;
		if (NMO_Main.normal_map_mode !== "height" || !this.floatSupported()){
			// нет float-текстур или режим "pictures": остаёмся на обычной 8-битной карте
			uu.displacementMap.value = NMO_RenderView.displacement_map;
			uu.dispBilinear.value = 0;
			return;
		}

		var contrast = parseFloat(NMO_DisplacementMap.contrast);
		var invert = NMO_DisplacementMap.invert_displacement;
		var factor = (contrast + 1) / (1 - contrast);

		// не больше 2048 по большей стороне — для вершинной выборки больше не нужно
		var step = Math.max(1, Math.ceil(Math.max(this.w, this.h) / 2048));
		var ow = Math.floor(this.w / step), oh = Math.floor(this.h / step);
		var size = ow * oh;
		var tex = this.displacementTexture;
		if (!tex || tex.image.width !== ow || tex.image.height !== oh){
			if (tex) tex.dispose();
			tex = new THREE.DataTexture(new Float32Array(size), ow, oh, THREE.LuminanceFormat, THREE.FloatType);
			tex.minFilter = tex.magFilter = THREE.NearestFilter;
			tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
			tex.generateMipmaps = false;
			this.displacementTexture = tex;
		}
		var out = tex.image.data, area = step * step;
		for (var y = 0; y < oh; y++){
			var sy0 = (oh - 1 - y) * step;
			for (var x = 0; x < ow; x++){
				var s = 0;
				for (var j = 0; j < step; j++){
					var o = (sy0 + j) * this.w + x * step;
					for (var i = 0; i < step; i++) s += this.heightL[o + i];
				}
				var v = s / area / 255;
				v = factor * (v - 0.5) + 0.5;
				if (invert) v = 1 - v;
				out[y * ow + x] = v < 0 ? 0 : v > 1 ? 1 : v;
			}
		}
		tex.needsUpdate = true;
		this.displacementSize = [ow, oh];

		var u = NMO_RenderView.material.uniforms;
		u.displacementMap.value = tex;
		u.dispTexSize.value.set(ow, oh);
		u.dispBilinear.value = 1;
	};
};

if (typeof module !== 'undefined') module.exports = NMO_HeightPrep;
