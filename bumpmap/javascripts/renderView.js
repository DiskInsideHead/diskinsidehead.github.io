var NMO_RenderView = new function(){
	this.scene = new THREE.Scene();
	this.camera = new THREE.PerspectiveCamera( 35, 1, 0.1, 100000 );
	this.renderer = new THREE.WebGLRenderer({ alpha: true,  antialias: true });
	this.displacement_map, this.diffuse_map, this.normal_map, this.specular_map, this.ao_map;
	this.material;
	this.rotation_enabled = false;   // автовращение убрано
	this.render_model;
	this.customModel;
	this.textureCube;
	
	this.renderView = function(){
		// request new frame
        requestAnimationFrame(function(){
            NMO_RenderView.renderView();
        });
		this.renderer.render(this.scene, this.camera);
		
		//console.log("rendering");
	};


	// подгоняем вьюпорт под контейнер (адаптивная вёрстка)
	this.resize = function(){
		var c = document.getElementById('render_view');
		var w = (c && c.clientWidth) || 800, h = (c && c.clientHeight) || 800;
		this.renderer.setSize( w, h );
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	};

	// Свободное вращение модели: ЛКМ + движение. Во время перетаскивания включается pointer lock,
	// поэтому курсор не упирается в край окна и можно крутить сколько угодно.
	this.initTrackball = function(){
		var self = this, el = this.renderer.domElement;
		var pointers = {}, count = 0, lastX = 0, lastY = 0, dragging = false, SPEED = 0.005;
		var AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0);
		el.style.touchAction = 'none';
		el.style.cursor = 'grab';

		function rotate(dx, dy){
			var m = self.render_model;
			if (!m) return;
			var qy = new THREE.Quaternion().setFromAxisAngle(AY, dx * SPEED);
			var qx = new THREE.Quaternion().setFromAxisAngle(AX, dy * SPEED);
			m.quaternion.multiplyQuaternions(qx, m.quaternion);
			m.quaternion.multiplyQuaternions(qy, m.quaternion);
			m.quaternion.normalize();
		}
		function end(e){
			if (pointers[e.pointerId]){ delete pointers[e.pointerId]; count--; }
			if (count <= 0){
				count = 0; dragging = false; el.style.cursor = 'grab';
				if (document.pointerLockElement === el) document.exitPointerLock();
			}
		}
		el.addEventListener('pointerdown', function(e){
			if (e.pointerType === 'mouse' && e.button !== 0) return;       // ПКМ — сдвиг, колесо — зум (OrbitControls)
			pointers[e.pointerId] = true; count++;
			if (count > 1){ dragging = false; return; }                      // два пальца — зум/сдвиг, не вращение
			dragging = true; lastX = e.clientX; lastY = e.clientY;
			el.style.cursor = 'grabbing';
			try { el.setPointerCapture(e.pointerId); } catch (err) {}
			if (e.pointerType === 'mouse' && el.requestPointerLock){
				try { var p = el.requestPointerLock(); if (p && p.catch) p.catch(function(){}); } catch (err) {}
			}
		});
		el.addEventListener('pointermove', function(e){
			if (!dragging) return;
			if (document.pointerLockElement === el) rotate(e.movementX, e.movementY);
			else rotate(e.clientX - lastX, e.clientY - lastY);
			lastX = e.clientX; lastY = e.clientY;
		});
		el.addEventListener('pointerup', end);
		el.addEventListener('pointercancel', end);
		el.addEventListener('dblclick', function(){ self.resetView(); });
	};

	// Полный сброс сцены: поворот, позиция модели, камера, сдвиг и зум
	this.resetView = function(){
		if (this.render_model){
			this.render_model.quaternion.set(0, 0, 0, 1);
			this.render_model.position.set(0, 0, 0);
			this.render_model.scale.set(1, 1, 1);
		}
		this.camera.up.set(0, 1, 0);
		this.camera.position.set(0, 0, 29);
		this.camera.zoom = 1;
		this.camera.updateProjectionMatrix();
		if (this.controls){
			this.controls.target.set(0, 0, 0);
			this.controls.update();
		}
		this.camera.lookAt(new THREE.Vector3(0, 0, 0));
	};

	this.initRenderer = function(){

		this.resize();
		//renderer.physicallyBasedShading = true;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		document.getElementById('render_view').appendChild( this.renderer.domElement );
		
		//camera.position.x = 2000;
	    this.camera.position.z = 29;
		this.camera.lookAt({
	        x: 0,
	        y: 0,
	        z: 0
	    });
		
		// OrbitControls оставляем для зума (колесо) и сдвига (ПКМ); вращение делаем сами — без ограничений
		this.controls = new THREE.OrbitControls( this.camera, this.renderer.domElement );
		this.controls.noRotate = true;
		this.initTrackball();
		
		
		var hemiLight = new THREE.HemisphereLight( 0xffffff, 0xffffff, 0.6 );
		hemiLight.color.setHSL( 0.6, 1, 0.6 );
		hemiLight.groundColor.setHSL( 0.095, 1, 0.75 );
		hemiLight.position.set( 0, 500, 0 );
		this.scene.add( hemiLight );

		
		var dirLight = new THREE.DirectionalLight( 0xffffff, 1 );
		dirLight.color.setHSL( 0.1, 1, 0.95 );
		dirLight.position.set( -1, 1.75, 1 );
		dirLight.position.multiplyScalar( 50 );
		this.scene.add( dirLight );

		dirLight.castShadow = true;

		dirLight.shadow.mapSize.width = 2048;
		dirLight.shadow.mapSize.height = 2048;

		var d = 50;

		dirLight.shadow.camera.left = -d;
		dirLight.shadow.camera.right = d;
		dirLight.shadow.camera.top = d;
		dirLight.shadow.camera.bottom = -d;

		dirLight.shadow.camera.far = 3500;
		dirLight.shadow.bias = -0.0001;
		
		
		
		//var height_canvas   = document.getElementById('height_canvas');
		
		this.diffuse_map			= new THREE.Texture( diffuse_canvas );
		this.specular_map  			= new THREE.Texture( NMO_SpecularMap.specular_canvas );
		this.normal_map  			= new THREE.Texture( NMO_NormalMap.normal_canvas );
		this.displacement_map		= new THREE.Texture( NMO_DisplacementMap.displacement_canvas );
		this.ao_map  				= new THREE.Texture( NMO_AmbientOccMap.ao_canvas );
		var maxAniso = this.renderer.getMaxAnisotropy();
		this.normal_map.anisotropy = this.specular_map.anisotropy = this.ao_map.anisotropy = maxAniso;
		this.diffuse_map.wrapS 		= this.diffuse_map.wrapT = THREE.RepeatWrapping;
		this.specular_map.wrapS 	= this.specular_map.wrapT = THREE.RepeatWrapping;
		this.normal_map.wrapS 		= this.normal_map.wrapT = THREE.RepeatWrapping;
		this.displacement_map.wrapS = this.displacement_map.wrapT = THREE.RepeatWrapping;
		this.ao_map.wrapS 			= this.ao_map.wrapT = THREE.RepeatWrapping;
		
		var loader = new THREE.CubeTextureLoader();
		loader.setPath( 'cubemaps/park/' );

		this.textureCube = loader.load( [
			'posx.jpg', 'negx.jpg',
			'posy.jpg', 'negy.jpg',
			'posz.jpg', 'negz.jpg'
		] );
		
		
		//var shader = THREE.NormalDisplacementShader;
		var shader = THREE.ShaderLib.phong
		
		// see ShaderLib (https://github.com/mrdoob/three.js/blob/master/src/renderers/shaders/ShaderLib.js)
		var uniforms = THREE.UniformsUtils.clone( shader.uniforms );
		
		//uniforms[ "diffuse" ].value = new THREE.Color(0xbbbbbb);
		//uniforms[ "specular" ].value = new THREE.Color(0x777777);
		//uniforms[ "ambientLightColor" ].value = new THREE.Color(0x000000);

		//console.log(this.diffuse_map);
		//uniforms["color"].value 	           = new THREE.Color("rgb(255, 0, 0)");
		var textureLoader = new THREE.TextureLoader();

		// ручная билинейная выборка float-карты смещения в вершинном шейдере
		uniforms.dispTexSize = { type: "v2", value: new THREE.Vector2(1, 1) };
		uniforms.dispBilinear = { type: "f", value: 0 };

		var dispPars = [
			"#include <displacementmap_pars_vertex>",
			"#ifdef USE_DISPLACEMENTMAP",
			"uniform vec2 dispTexSize;",
			"uniform float dispBilinear;",
			"float dispSample( vec2 uvc ) {",
			"  if ( dispBilinear < 0.5 ) return texture2D( displacementMap, uvc ).x;",
			"  vec2 p = uvc * dispTexSize - 0.5;",
			"  vec2 i = floor( p );",
			"  vec2 f = p - i;",
			"  vec2 inv = 1.0 / dispTexSize;",
			"  float a = texture2D( displacementMap, ( i + vec2( 0.5, 0.5 ) ) * inv ).x;",
			"  float b = texture2D( displacementMap, ( i + vec2( 1.5, 0.5 ) ) * inv ).x;",
			"  float c = texture2D( displacementMap, ( i + vec2( 0.5, 1.5 ) ) * inv ).x;",
			"  float d = texture2D( displacementMap, ( i + vec2( 1.5, 1.5 ) ) * inv ).x;",
			"  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );",
			"}",
			"#endif"
		].join("\n");
		var dispUse = [
			"#ifdef USE_DISPLACEMENTMAP",
			"  transformed += normal * ( dispSample( uv ) * displacementScale + displacementBias );",
			"#endif"
		].join("\n");
		var patchedVertexShader = shader.vertexShader
			.replace( "#include <displacementmap_pars_vertex>", dispPars )
			.replace( "#include <displacementmap_vertex>", dispUse );

		shaderUniforms = uniforms;
		//shaderUniforms.aoMap = this.ao_map;
		//console.log(shaderUniforms);

		var defines = {};

		//defines[ "USE_MAP" ] = "";
		defines[ "USE_SPECULARMAP" ] = "";
		if (document.getElementById('input_displacement').checked)
			defines[ "USE_DISPLACEMENTMAP" ] = "";
		defines[ "USE_AOMAP" ] = "";
		
		
		//defines[ "USE_LIGHTMAP" ] = "";
		defines[ "USE_NORMALMAP" ] = "";

		this.material = new THREE.ShaderMaterial( { 
			name: "renderViewShader",
			defines: defines,
			uniforms: shaderUniforms,
			vertexShader: patchedVertexShader, 
			fragmentShader: shader.fragmentShader,
			//transparent: true,
			lights: true
		} );
		//console.log(shaderUniforms)

		this.material.extensions.derivatives = true;  // needed for normalmap
		this.material.uniforms.map.value = this.diffuse_map;
		this.material.uniforms.normalMap.value = this.normal_map;
		this.material.uniforms.specularMap.value = this.specular_map;
		this.material.uniforms.displacementMap.value = this.displacement_map;
		//this.material.uniforms.lightMap.value = textureCube;
		this.material.uniforms.envMap.value = this.textureCube;
		this.material.uniforms.aoMap.value = this.ao_map;
		this.material.uniforms.aoMapIntensity.value = 1;
		this.material.uniforms.displacementScale.value = -0.3
		this.material.uniforms.displacementBias.value = 0;
		this.material.uniforms.diffuse.value = new THREE.Color(0xaaaaaa);
		this.material.uniforms.specular.value = new THREE.Color(0x444444);
		//this.material.unshininess.value = 40;
		//this.material.uniforms.ambientLightColor.value = new THREE.Color(0x777777);


		this.setModel("Plane");

		//this.scene.background = textureCube;
		
		//console.log("init done");
		this.renderView();
	};


	this.setRepeat = function(v_x, v_y){
		this.render_model.material.uniforms.offsetRepeat.value = new THREE.Vector4(0,0,v_x, v_y);
		this.render_model.material.needsUpdate = true;		
	};


	this.setModel = function(type){
		this.scene.remove( this.render_model );

		if (type == "Cube"){
			var geometry = new THREE.BoxGeometry(10, 10, 10, 128, 128, 128);
			geometry.faceVertexUvs[ 1 ] = geometry.faceVertexUvs[ 0 ];
			//geometry.computeTangents();
			this.render_model = new THREE.Mesh( new THREE.BufferGeometry().fromGeometry( geometry), this.material);
			this.render_model.castShadow = true;
			this.render_model.receiveShadow = true;
			this.scene.add( this.render_model );
		}
		else if (type == "Sphere"){
			var geometry = new THREE.SphereGeometry( 7, 128, 128);
			geometry.faceVertexUvs[ 1 ] = geometry.faceVertexUvs[ 0 ];
			//geometry.computeTangents();
			this.render_model = new THREE.Mesh( new THREE.BufferGeometry().fromGeometry( geometry), this.material);
			this.render_model.castShadow = true;
			this.render_model.receiveShadow = true;
			this.scene.add( this.render_model );
		}
		else if (type == "Cylinder"){
			var geometry = new THREE.CylinderGeometry( 7, 7, 10, 128 );
			geometry.faceVertexUvs[ 1 ] = geometry.faceVertexUvs[ 0 ];
			//geometry.computeTangents();
			this.render_model = new THREE.Mesh( new THREE.BufferGeometry().fromGeometry( geometry), this.material);
			this.render_model.castShadow = true;
			this.render_model.receiveShadow = true;
			this.scene.add( this.render_model );
		}
		else if (type == "Plane"){
			var geometry = new THREE.PlaneGeometry(12, 12, 128, 128);
			geometry.faceVertexUvs[ 1 ] = geometry.faceVertexUvs[ 0 ];
			//geometry.computeTangents();
			this.render_model = new THREE.Mesh( new THREE.BufferGeometry().fromGeometry( geometry), this.material);
			this.render_model.castShadow = true;
			this.render_model.receiveShadow = true;
			this.render_model.material.side = THREE.DoubleSide;
			this.scene.add( this.render_model );
		}
		else if (type == "Teapot"){
			var geometry = new THREE.TeapotBufferGeometry( 3, //teapotSize,
				15, // tesselation?!
				true, // bottom
				true, // lid
				true, // body
				true, // fitLid,
				true // nonblinn
				);

			this.render_model = new THREE.Mesh(	geometry, this.material );	// if no match, pick Phong
			this.render_model.castShadow = true;
			this.render_model.receiveShadow = true;
			this.scene.add( this.render_model );
			this.setDisplacement(false);
		}		
		else if (type == "Custom" && this.customModel){
			this.render_model = this.customModel;
			this.render_model.castShadow = true;
			this.render_model.receiveShadow = true;
			this.scene.add( this.render_model );
		}
		this.resetView();
	};

				

	this.setDisplacementOptions = function(scale, bias){
		this.render_model.material.uniforms[ "displacementScale" ].value = scale * 5;
		this.render_model.material.uniforms[ "displacementBias" ].value = scale * 5 * - bias;
	}

	this.setDisplacement = function(displacement){
		if (!displacement || this.render_model.material.defines["USE_DISPLACEMENTMAP"] == ""){
			delete this.render_model.material.defines["USE_DISPLACEMENTMAP"];
		}
		else{
			this.render_model.material.defines["USE_DISPLACEMENTMAP"] = "";
		}
		this.render_model.material.needsUpdate = true;
	};

	this.toggleNormal = function(){
		if (this.render_model.material.defines["USE_NORMALMAP"] == "")
			delete this.render_model.material.defines["USE_NORMALMAP"];
		else
			this.render_model.material.defines["USE_NORMALMAP"] = "";
		this.render_model.material.needsUpdate = true;
	};

	this.toggleAO = function(){
		if (this.render_model.material.defines["USE_AOMAP"] == "")
			delete this.render_model.material.defines["USE_AOMAP"];
		else
			this.render_model.material.defines["USE_AOMAP"] = "";
		this.render_model.material.needsUpdate = true;
	};

	this.toggleSpecular = function(){
		if (this.render_model.material.defines["USE_SPECULARMAP"] == "")
			delete this.render_model.material.defines["USE_SPECULARMAP"];
		else
			this.render_model.material.defines["USE_SPECULARMAP"] = "";
		this.render_model.material.needsUpdate = true;
	};


	this.toggleDiffuse = function(){
		if (this.render_model.material.defines["USE_MAP"] == "")
			delete this.render_model.material.defines["USE_MAP"];
		else
			this.render_model.material.defines["USE_MAP"] = "";
		this.render_model.material.needsUpdate = true;
	};

	this.enableDiffuse = function(){
		this.render_model.material.defines["USE_MAP"] = "";
		document.getElementById('input_diffuse').disabled = false;
		document.getElementById('input_diffuse').checked = true;

		this.render_model.material.needsUpdate = true;
	};

	this.setEnvironment = function(environment){
		if (!environment){
			delete this.render_model.material.defines["USE_ENVMAP"];
			delete this.render_model.material.defines["ENVMAP_MODE_REFLECTION"];
			delete this.render_model.material.defines["ENVMAP_TYPE_CUBE"];
			delete this.render_model.material.defines["ENVMAP_BLENDING_MIX"];
			this.scene.background = "";
		}
		else{
			this.render_model.material.defines["USE_ENVMAP"] = "";
			this.render_model.material.defines["ENVMAP_MODE_REFLECTION"] = "";
			this.render_model.material.defines["ENVMAP_TYPE_CUBE"] = "";
			this.render_model.material.defines["ENVMAP_BLENDING_MIX"] = "";
			//this.scene.background = this.textureCube;
		}
		this.render_model.material.needsUpdate = true;
	};

}
/*
$(document).ready(function() {
	$(".various").fancybox({
		maxWidth	: 600,
		maxHeight	: 600,
		fitToView	: false,
		width		: 600,
		height		: 600,
		autoSize	: false,
		closeClick	: false,
		openEffect	: 'none',
		closeEffect	: 'none',
	});

	$(".big_preview").fancybox({
		maxWidth	: 800,
		maxHeight	: 800,
		fitToView	: false,
		width		: 800,
		height		: 800,
		autoSize	: false,
		closeClick	: false,
		openEffect	: 'none',
		closeEffect	: 'none',
		
		afterShow: function(){


		},
		afterClose: function(){
			document.getElementById('render_view').appendChild(NMO_RenderView.renderer.domElement);
			NMO_RenderView.renderer.setSize(NMO_FileDrop.container_height, NMO_FileDrop.container_height );

			document.getElementById('renderBig').appendChild(NMO_RenderView.renderer.domElement);
			NMO_RenderView.renderer.setSize( 800, 800 );
		}
	});
});
*/