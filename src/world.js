import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
export { createSoldier, createWeapon } from './models.js';

const palette = {
  sand: 0xa69d81, asphalt: 0x424e4d, concrete: 0x9a9e90, pale: 0xc4c5ab,
  dark: 0x293d3d, teal: 0x357c79, rust: 0xb86136, yellow: 0xebba5a,
  blue: 0x506f80, green: 0x8fddb4, steel: 0x566360,
};

const material = (color, roughness = 0.85, extra = {}) => new THREE.MeshStandardMaterial({
  color, roughness,
  ...(extra.map ? { bumpMap: extra.map, bumpScale: 0.018, roughnessMap: extra.map } : {}),
  ...extra,
});

// Deterministic textures keep the port self-contained, including offline builds.
// DataTextures also make the world usable by the navigation tests without a DOM.
function surfaceTexture(kind, size = 128) {
  const pixels = new Uint8Array(size * size * 4);
  const noise = (x, y, seed = 0) => {
    const value = Math.sin(x * 127.1 + y * 311.7 + seed * 71.9) * 43758.5453;
    return value - Math.floor(value);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const grain = noise(x, y), broad = noise(Math.floor(x / 11), Math.floor(y / 13));
    const i = (y * size + x) * 4;
    let r, g, b;
    if (kind === 'water') {
      // Derivatives of crossing swell frequencies form a seamless normal field.
      const u = x / size * Math.PI * 2, v = y / size * Math.PI * 2;
      r = 128 + 27 * Math.cos(u * 5 + v * 3) + 14 * Math.cos(u * 11 - v * 7);
      g = 128 + 20 * Math.cos(u * 5 + v * 3) - 18 * Math.cos(u * 11 - v * 7);
      b = 239;
    } else {
      let value = 215 + grain * 26 + broad * 9;
      if (kind === 'concrete') {
        const seam = x < 2 || y < 2;
        const chip = noise(Math.floor(x / 3), Math.floor(y / 2), 8) > 0.987;
        value = seam ? 141 : value - (chip ? 55 : 0) - Math.max(0, Math.sin(x * 0.47)) * 7;
      } else if (kind === 'asphalt') {
        const gravel = grain > 0.93 ? 48 : 0;
        const stain = Math.max(0, Math.sin(x / 17) * Math.cos(y / 19)) * 27;
        value = 163 + grain * 46 + gravel - stain;
      } else if (kind === 'paint') {
        const drip = noise(Math.floor(x / 6), 0, 1) > 0.79 ? Math.max(0, 1 - y / size) * 43 : 0;
        const scar = noise(Math.floor(x / 2), Math.floor(y / 2), 12) > 0.967;
        value -= drip + (scar ? 100 : 0) + Math.cos(x / size * Math.PI * 16) * 8;
      } else if (kind === 'metal') value = 194 + grain * 24 + Math.sin(y * 1.4) * 19;
      else if (kind === 'wood') value = 176 + grain * 24 + Math.sin(y * 0.33 + Math.sin(x / 17)) * 30;
      else if (kind === 'glass') {
        value = 175 + y / size * 63 + Math.sin(x / 8) * 13;
        r = value * 0.66; g = value * 0.88; b = value;
      }
      if (r === undefined) { r = value; g = value; b = value * (kind === 'paint' ? 0.94 : 1); }
    }
    pixels[i] = THREE.MathUtils.clamp(r, 0, 255);
    pixels[i + 1] = THREE.MathUtils.clamp(g, 0, 255);
    pixels[i + 2] = THREE.MathUtils.clamp(b, 0, 255);
    pixels[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  if (kind !== 'water') texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createSky() {
  const shader = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
    uniforms: {
      time: { value: 0 },
      zenith: { value: new THREE.Color(0x4381b1) },
      horizon: { value: new THREE.Color(0xd2dfe4) },
      sunDirection: { value: new THREE.Vector3(-48, 55, -38).normalize() },
    },
    vertexShader: 'varying vec3 skyDirection; void main(){ skyDirection=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `
      uniform float time; uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunDirection;
      varying vec3 skyDirection;
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
      float cloud(vec2 p){ return noise(p)*0.57+noise(p*2.04)*0.28+noise(p*4.09)*0.15; }
      void main(){
        vec3 d=normalize(skyDirection);
        float elevation=max(d.y,0.0);
        vec3 color=mix(horizon,zenith,pow(elevation,0.46));
        float sun=max(dot(d,sunDirection),0.0);
        color+=vec3(0.29,0.18,0.06)*pow(sun,15.0);
        color+=vec3(0.8,0.55,0.27)*pow(sun,160.0);
        vec2 uv=d.xz/max(d.y,0.08)*2.8+vec2(time*0.0018,time*0.0008);
        float clouds=smoothstep(0.52,0.77,cloud(uv))*smoothstep(0.035,0.21,d.y);
        vec3 cloudColor=mix(vec3(0.51,0.62,0.68),vec3(0.92,0.94,0.91),cloud(uv+0.7));
        color=mix(color,cloudColor,clouds*0.8);
        color=mix(color,vec3(1.0,0.91,0.72),smoothstep(0.99945,0.99982,sun));
        gl_FragColor=vec4(color,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(240, 24, 14), shader);
  sky.name = 'Afternoon sky and moving clouds'; sky.renderOrder = -1000; sky.frustumCulled = false;
  sky.onBeforeRender = (_renderer, _scene, camera) => { sky.position.copy(camera.position); sky.updateMatrixWorld(); };
  return sky;
}

/** A compact original industrial port. All returned positions use ground-space x/z. */
export function createWorld(scene) {
  scene.background = new THREE.Color(0xc2d9e4);
  scene.fog = new THREE.FogExp2(0xc2d9e4, 0.0035);
  const solids = [], blockers = [], animated = [];
  const textures = Object.fromEntries(['concrete', 'asphalt', 'paint', 'metal', 'wood', 'glass', 'water'].map(kind => [kind, surfaceTexture(kind)]));
  const mats = Object.fromEntries(Object.entries(palette).map(([key, color]) => [key, material(color, 0.85, { map: textures[['asphalt', 'concrete', 'sand', 'pale'].includes(key) ? (key === 'asphalt' ? 'asphalt' : 'concrete') : ['steel', 'dark'].includes(key) ? 'metal' : 'paint'] })]));
  mats.asphalt.color.set(0x394149);
  mats.asphalt.bumpScale = 0.003;
  mats.concrete.color.set(0xa2a9a6);
  mats.dark.metalness = 0.32; mats.steel.metalness = 0.6; mats.steel.roughness = 0.58;
  const darkGlass = material(0x577481, 0.22, { metalness: 0.45, map: textures.glass });
  const wood = material(0x8e7956, 0.94, { map: textures.wood });
  const plant = material(0x616e46, 0.95);
  const world = new THREE.Group();
  world.name = 'Port Kestrel';
  scene.add(world);
  const sky = createSky(); scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xc6e3fb, 0x95836e, 2.2);
  scene.add(hemi);
  const sunlight = new THREE.DirectionalLight(0xffddb1, 3.25);
  sunlight.position.set(-48, 55, -38);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunlight.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 160 });
  sunlight.shadow.bias = -0.00025;
  sunlight.shadow.normalBias = 0.04;
  sunlight.shadow.radius = 3;
  scene.add(sunlight);

  function box(x, y, z, w, h, d, mat, solid = false, parent = world) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    if (solid) {
      solids.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, height: y + h / 2 });
      blockers.push(mesh);
    }
    return mesh;
  }

  function cylinder(x, y, z, radius, h, mat, sides = 8, parent = world) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, sides), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function label(text, x, y, z, w, h, rotation = 0, background = '#243c3c', color = '#e8e4c8') {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background; ctx.fillRect(0, 0, 1024, 256);
    ctx.strokeStyle = color; ctx.lineWidth = 8; ctx.strokeRect(18, 18, 988, 220);
    ctx.fillStyle = color;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 85px "Arial", "Microsoft YaHei", sans-serif';
    ctx.fillText(text, 512, 135, 940);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 }));
    mesh.position.set(x, y, z); mesh.rotation.y = rotation; world.add(mesh);
    return mesh;
  }

  function road(x, z, w, d, dashed = true) {
    // A metre-based top projection gives every road the same fine grain,
    // irrespective of whether its geometry is 8 m or 91 m long.
    function projectPavement(mesh) {
      const positions = mesh.geometry.attributes.position, normals = mesh.geometry.attributes.normal, uv = mesh.geometry.attributes.uv;
      for (let i = 0; i < positions.count; i++) if (Math.abs(normals.getY(i)) > 0.5) {
        uv.setXY(i, (mesh.position.x + positions.getX(i)) / 1.5, (mesh.position.z + positions.getZ(i)) / 1.5);
      }
      uv.needsUpdate = true;
      return mesh;
    }
    projectPavement(box(x, 0.017, z, w, 0.03, d, mats.asphalt));
    if (d > w) {
      for (const edge of [-1, 1]) box(x + edge * (w / 2 - 0.22), 0.042, z, 0.13, 0.025, d, mats.pale);
      if (dashed) for (let zz = z - d / 2 + 2; zz < z + d / 2; zz += 5) box(x, 0.047, zz, 0.12, 0.025, 2.2, mats.yellow);
    } else {
      for (const edge of [-1, 1]) box(x, 0.043, z + edge * (d / 2 - 0.22), w, 0.025, 0.13, mats.pale);
    }
    // Repeated tire traces and repaired pavement distinguish traffic lanes.
    const tire = material(0x202a30, 0.95, { transparent: true, opacity: 0.34, map: textures.asphalt, depthWrite: false });
    for (const side of [-1, 1]) {
      const trace = box(x + (d > w ? side * 2 : 0), 0.035, z + (d > w ? 0 : side * 1.7), d > w ? 0.31 : w * 0.83, 0.006, d > w ? d * 0.86 : 0.31, tire);
      projectPavement(trace);
      trace.castShadow = false;
    }
  }

  function container(x, z, color, code, length = 12, stacked = false) {
    const mat = material(color, 0.75, { map: textures.paint, metalness: 0.23 });
    const y = stacked ? 4.35 : 1.45;
    const body = box(x, y, z, 5.8, 2.9, length, mat, !stacked);
    if (stacked) blockers.push(body);
    for (let zz = z - length / 2 + 0.35; zz < z + length / 2; zz += 0.52) {
      for (const side of [-1, 1]) box(x + side * 2.93, y, zz, 0.09, 2.65, 0.08, mat);
    }
    for (const side of [-1, 1]) {
      box(x + side * 1.47, y, z + length / 2 + 0.025, 2.83, 2.63, 0.07, mat);
      box(x + side * 1.47, y, z + length / 2 + 0.08, 0.07, 2.25, 0.06, mats.pale);
    }
    box(x, y + 1.42, z, 5.94, 0.12, length + 0.08, mat);
    for (const xx of [-2.68, 2.68]) {
      for (const zz of [-length / 2 + 0.13, length / 2 - 0.13]) {
        box(x + xx, y + 1.34, z + zz, 0.26, 0.22, 0.25, mats.steel);
        box(x + xx, y - 1.34, z + zz, 0.26, 0.22, 0.25, mats.steel);
      }
    }
    for (const xx of [-2.25, -0.7, 0.7, 2.25]) {
      box(x + xx, y, z + length / 2 + 0.13, 0.045, 2.55, 0.04, mats.steel);
      box(x + xx + 0.12, y - 0.32, z + length / 2 + 0.15, 0.29, 0.065, 0.045, mats.steel);
    }
    box(x, y - 1.34, z + length / 2 + 0.085, 5.7, 0.12, 0.12, mats.dark);
    label(code, x, y + 0.62, z + length / 2 + 0.1, 3.0, 0.7, 0, '#213d3b', '#e8ddbe');
    return body;
  }

  function warehouse(x, z, w, d, name, color = mats.concrete) {
    const height = 7.2;
    box(x, height / 2, z, w, height, d, color, true);
    box(x, 7.27, z, w + 0.6, 0.23, d + 0.65, mats.dark);
    box(x, 0.28, z + d / 2 + 0.05, w + 0.3, 0.56, 0.2, mats.dark);
    for (let xx = x - w / 2 + 1; xx < x + w / 2; xx += 3.1) {
      box(xx, 4.9, z + d / 2 + 0.035, 2.43, 1.49, 0.13, mats.dark);
      box(xx, 4.9, z + d / 2 + 0.05, 2.25, 1.3, 0.1, darkGlass);
      box(xx, 4.9, z + d / 2 + 0.12, 0.08, 1.32, 0.08, mats.pale);
      box(xx, 4.9, z + d / 2 + 0.12, 2.25, 0.065, 0.08, mats.pale);
      box(xx, 4.18, z + d / 2 + 0.21, 2.51, 0.09, 0.44, mats.pale);
    }
    for (let xx = x - w / 2 + 2; xx < x + w / 2 - 2; xx += 7) {
      box(xx, 1.8, z + d / 2 + 0.11, 4.3, 3.15, 0.12, mats.steel);
      for (let yy = 0.5; yy < 3.4; yy += 0.3) box(xx, yy, z + d / 2 + 0.18, 4.15, 0.04, 0.03, mats.dark);
      box(xx, 3.65, z + d / 2 + 0.1, 4.65, 0.15, 0.75, mats.dark);
      for (const side of [-1, 1]) box(xx + side * 2.24, 1.72, z + d / 2 + 0.18, 0.09, 3.38, 0.08, mats.pale);
      box(xx + 1.62, 1.24, z + d / 2 + 0.2, 0.14, 0.12, 0.08, mats.yellow);
    }
    label(name, x, 6.35, z + d / 2 + 0.13, Math.min(w - 2, 11), 1.14);
    for (const offset of [-w * 0.3, w * 0.26]) {
      box(x + offset, 7.65, z - d * 0.15, 2.5, 0.8, 2.5, mats.steel);
      cylinder(x + offset, 8.15, z - d * 0.15, 0.7, 0.3, mats.dark);
      for (let i = 0; i < 6; i++) box(x + offset - 1 + i * 0.4, 7.9, z - d * 0.15 + 1.26, 0.07, 0.48, 0.035, mats.dark);
      const duct = cylinder(x + offset, 7.78, z - d * 0.15 - 2.1, 0.36, 2.4, mats.steel, 12);
      duct.rotation.x = Math.PI / 2;
      cylinder(x + offset, 8.08, z - d * 0.15 - 3.1, 0.36, 0.7, mats.steel, 12);
    }
    for (const side of [-1, 1]) {
      box(x + side * (w / 2 + 0.03), 3.3, z, 0.06, 0.4, d, mats.teal);
      for (let zz = z - d / 2 + 2; zz < z + d / 2; zz += 5) box(x + side * (w / 2 + 0.04), 4.8, zz, 0.1, 1.15, 2.6, darkGlass);
      // Gutters, seams and downpipes hug existing collision faces.
      box(x + side * (w / 2 + 0.12), 7.02, z, 0.18, 0.15, d + 0.24, mats.steel);
      cylinder(x + side * (w / 2 + 0.15), 3.49, z - d / 2 + 0.3, 0.095, 6.98, mats.steel, 8);
      for (let zz = z - d / 2 + 0.3; zz < z + d / 2; zz += 4.2) box(x + side * (w / 2 + 0.045), 3.5, zz, 0.09, 6.98, 0.1, mats.pale);
    }
    box(x, 0.28, z - d / 2 - 0.02, w + 0.1, 0.56, 0.08, mats.dark);
    for (const side of [-1, 1]) box(x + side * (w / 2 - 0.12), 3.6, z + d / 2 + 0.06, 0.17, 7.08, 0.11, mats.pale);
    // Maintenance catwalk railings and cable loops add an industrial roofline.
    box(x, 7.64, z - d / 2 + 0.15, w * 0.7, 0.055, 0.06, mats.steel);
    box(x, 7.94, z - d / 2 + 0.15, w * 0.7, 0.055, 0.06, mats.steel);
    for (let xx = x - w * 0.35; xx <= x + w * 0.35; xx += 2.7) box(xx, 7.61, z - d / 2 + 0.15, 0.055, 0.85, 0.06, mats.steel);
  }

  function barrier(x, z, direction = 'x') {
    const wide = direction === 'x';
    box(x, 0.62, z, wide ? 3.5 : 0.75, 1.24, wide ? 0.75 : 3.5, mats.concrete, true);
    box(x, 1.13, z, wide ? 3.52 : 0.77, 0.19, wide ? 0.77 : 3.52, mats.yellow);
    if (wide) for (let xx = -1.3; xx <= 1.3; xx += 0.65) box(x + xx, 0.68, z + 0.382, 0.26, 0.66, 0.025, mats.dark);
  }

  function barrel(x, z, color = mats.rust) {
    const mesh = cylinder(x, 0.61, z, 0.45, 1.22, color, 12);
    solids.push({ minX: x - 0.45, maxX: x + 0.45, minZ: z - 0.45, maxZ: z + 0.45, height: 1.22 });
    blockers.push(mesh);
    cylinder(x, 0.23, z, 0.46, 0.06, mats.dark, 12);
    cylinder(x, 0.98, z, 0.46, 0.06, mats.dark, 12);
    cylinder(x + 0.15, 1.23, z, 0.075, 0.03, mats.steel, 8);
  }

  function lamp(x, z, rotation = 0) {
    box(x, 3.9, z, 0.17, 7.8, 0.17, mats.dark, true);
    const arm = box(x + Math.cos(rotation) * 0.65, 7.72, z + Math.sin(rotation) * 0.65, 1.5, 0.11, 0.15, mats.dark);
    arm.rotation.y = -rotation;
    const light = box(x + Math.cos(rotation) * 1.22, 7.65, z + Math.sin(rotation) * 1.22, 0.65, 0.08, 0.4, material(0xffedbd, 0.4, { emissive: 0xffbf66, emissiveIntensity: 0.5 }));
    light.rotation.y = -rotation;
  }

  // Fine crossing normals drift over a slowly moving swell, without any assets.
  const waterClock = { value: 0 };
  textures.water.repeat.set(64, 64);
  const seaMaterial = material(0x3c7e96, 0.34, { metalness: 0.3, normalMap: textures.water, normalScale: new THREE.Vector2(0.1, 0.1) });
  seaMaterial.onBeforeCompile = shader => {
    shader.uniforms.waterTime = waterClock;
    shader.vertexShader = 'uniform float waterTime; varying vec2 ripplePosition;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nripplePosition=position.xy; transformed.z+=sin(position.x*0.2+waterTime*0.45)*0.055+sin(position.y*0.13-waterTime*0.31)*0.045;');
    shader.fragmentShader = 'uniform float waterTime; varying vec2 ripplePosition;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nfloat ripple=sin(ripplePosition.x*0.24+ripplePosition.y*0.17+waterTime*0.24)+0.5*sin(ripplePosition.y*0.29-ripplePosition.x*0.13-waterTime*0.18); diffuseColor.rgb*=0.99+0.009*ripple;');
  };
  seaMaterial.customProgramCacheKey = () => 'kestrel-water-v2';
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800, 48, 48), seaMaterial);
  sea.rotation.x = -Math.PI / 2; sea.position.y = -1.1; sea.receiveShadow = true; sea.name = 'Animated harbor water'; world.add(sea);
  box(0, -0.7, 0, 103, 1.4, 103, mats.sand);
  const quayMaterial = mats.concrete.clone(); quayMaterial.map = textures.concrete.clone(); quayMaterial.map.repeat.set(50, 50);
  quayMaterial.bumpMap = quayMaterial.roughnessMap = quayMaterial.map; quayMaterial.bumpScale = 0.002;
  box(0, -0.04, 0, 99.9, 0.07, 99.9, quayMaterial);
  for (let xx = -40; xx <= 40; xx += 10) box(xx, 0.006, 0, 0.028, 0.012, 100, mats.steel);
  for (let zz = -40; zz <= 40; zz += 10) box(0, 0.006, zz, 100, 0.012, 0.028, mats.steel);
  road(0, 23, 11, 53);
  road(14, -17, 9, 56);
  road(-4, -36, 91, 8, false);
  road(-1, 9, 91, 8, false);
  road(-1, 35, 91, 7, false);
  // Solid visible perimeter: short quay walls leave distant sea and cranes in view.
  box(-50, 1, 0, 1.1, 2, 101, mats.concrete, true);
  box(50, 1, 0, 1.1, 2, 101, mats.concrete, true);
  box(0, 1, -50, 100, 2, 1.1, mats.concrete, true);
  box(0, 1, 50, 100, 2, 1.1, mats.concrete, true);
  for (let zz = -46; zz < 50; zz += 8) {
    box(49.38, 1.55, zz, 0.1, 0.48, 1.8, mats.yellow);
    box(-49.38, 1.55, zz, 0.1, 0.48, 1.8, mats.yellow);
  }
  // Fenders, tide staining and reeds sit beyond the solid quay perimeter.
  for (const side of [-1, 1]) {
    box(side * 51.56, -0.15, 0, 0.14, 0.52, 99, mats.dark);
    for (let zz = -43; zz < 48; zz += 13) {
      cylinder(side * 52.2, 0.05, zz, 0.32, 1.45, mats.dark, 10);
      box(side * 51.71, 0.1, zz, 0.22, 1.7, 0.16, mats.steel);
      if (zz < 8) for (let i = 0; i < 4; i++) {
        const reed = box(side * (51.3 + i * 0.12), 0.14 + i * 0.1, zz + i * 0.15, 0.055, 0.7 + i * 0.14, 0.055, plant);
        reed.rotation.z = side * (0.17 + i * 0.06);
      }
    }
  }
  // Flat drains and paint scratches stay below boots and do not affect routes.
  for (const [x, z] of [[-4.1, 20], [4.3, 31], [11, -8], [17, -31], [-22, 6], [38, 7]]) {
    const drain = box(x, 0.041, z, 1.05, 0.012, 0.53, mats.dark); drain.castShadow = false;
    for (let i = 0; i < 7; i++) { const slat = box(x - 0.43 + i * 0.14, 0.052, z, 0.045, 0.006, 0.46, mats.steel); slat.castShadow = false; }
  }
  const roadDust = material(0x979389, 0.92, { transparent: true, opacity: 0.24, depthWrite: false, map: textures.asphalt });
  for (let i = 0; i < 18; i++) {
    const x = i < 7 ? ((i % 3) - 1) * 2.5 : -41 + (i - 7) * 7.3;
    const z = i < 7 ? 1 + i * 5.9 : i % 2 ? 10.5 : -35.2;
    const scuff = box(x, 0.059, z, 0.12 + (i % 4) * 0.08, 0.005, 0.5 + (i % 3) * 0.34, roadDust);
    scuff.rotation.y = i * 2.11; scuff.castShadow = false;
  }

  warehouse(-33, -15, 23, 27, '01 / PROCESSING');
  warehouse(29, -15, 22, 20, '02 / CUSTOMS', material(0x939f91, 0.88, { map: textures.concrete }));
  warehouse(-32, 22, 20, 14, '03 / LOGISTICS', material(0x9c9d84, 0.88, { map: textures.concrete }));
  warehouse(29, 21, 16, 12, '04 / SERVICE', material(0x8c9c91, 0.88, { map: textures.concrete }));
  container(-9, 10, palette.rust, 'KSTR 024');
  container(7.8, 1.6, palette.teal, 'AE 6701', 11);
  container(-8, -28, palette.blue, 'CARGO 08', 11);
  container(1.5, -17, palette.rust, 'KSTR 119', 8);
  container(-41, 40, palette.teal, 'RESERVE', 9);
  container(-8, -28, palette.rust, 'STACK 21', 11, true);
  container(41, 38, palette.blue, 'KSTR 903', 10);
  // Waist-high cover creates distinct approaches without blocking the main routes.
  for (const [x, z, direction] of [[-6, 27, 'x'], [6, 27, 'x'], [-16, -10, 'z'], [12, -25, 'x'], [39, 2, 'x'], [-27, -35, 'x'], [23, 31, 'x'], [2, -6, 'x']]) barrier(x, z, direction);
  for (const [x, z] of [[-18, 25], [-18.9, 25.5], [-18, 26], [-40, 11], [-39, 11], [39, -18], [40, -18.4], [19, -29], [-14, -31]]) barrel(x, z);
  for (const [x, z, rot] of [[-7, 35, 0], [7, 19, 0], [-18, 5, 0], [18, -3, Math.PI], [40, 30, Math.PI], [-39, -34, 0], [7, -39, 0]]) lamp(x, z, rot);
  for (const points of [
    [[-21.4, 7.05, -2], [-20.2, 6.5, 7], [-21.9, 7.05, 16]],
    [[18.05, 7.05, -6], [19.4, 6.6, 1.5], [21.05, 7.05, 15]],
    [[-7, 7.76, 35], [0, 6.9, 29], [7, 7.76, 19]],
  ]) {
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), 12, 0.026, 4, false), mats.dark);
    cable.name = 'Overhead utility cable'; world.add(cable);
  }

  // Pallet stacks and warning paint add readable scale beside primary cover.
  for (const [x, z] of [[-20, 20], [-20, 23], [39, 18], [38, -23], [-36, -31]]) {
    box(x, 0.5, z, 1.9, 1, 1.6, wood, true);
    for (let yy = 0.12; yy < 0.98; yy += 0.25) {
      box(x, yy, z + 0.83, 1.94, 0.12, 0.08, mats.sand);
      box(x, yy, z - 0.83, 1.94, 0.12, 0.08, mats.sand);
    }
  }
  // Tanks: their square bases deliberately make collision boundaries visible.
  for (const x of [-40, -33]) {
    box(x, 0.28, -43, 4.7, 0.56, 4.7, mats.dark, true);
    const tank = cylinder(x, 3.1, -43, 2.1, 5.8, mats.pale, 16);
    blockers.push(tank);
    solids.push({ minX: x - 2.1, maxX: x + 2.1, minZ: -45.1, maxZ: -40.9, height: 6 });
    cylinder(x, 5.75, -43, 2.14, 0.3, mats.teal, 16);
    cylinder(x, 6.08, -43, 1.1, 0.3, mats.steel, 12);
  }

  // An orange quayside gantry is a strong landmark visible from every route.
  for (const x of [43, 47]) for (const z of [-32, -41]) {
    box(x, 0.35, z, 1.7, 0.7, 2, mats.dark, true);
    box(x, 12, z, 0.75, 24, 0.75, mats.rust, true);
  }
  box(45, 23.5, -36.5, 5.5, 1.3, 10.8, mats.rust);
  box(31, 25, -36.5, 34, 1, 1.4, mats.rust);
  box(32, 27.5, -36.5, 30, 0.3, 0.4, mats.yellow);
  for (let xx = 18; xx <= 46; xx += 4) {
    box(xx, 26.25, -36.5, 0.24, 2.5, 0.3, mats.rust);
    const brace = box(xx + 1.8, 26.25, -36.5, 0.2, 4.5, 0.2, mats.rust);
    brace.rotation.z = -1.03;
  }
  box(45, 21.7, -34.3, 2.7, 2.8, 3.5, mats.dark);
  box(45, 22.15, -32.52, 2.2, 1.3, 0.04, darkGlass);
  box(18, 16.1, -36.5, 0.065, 16, 0.065, mats.dark);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.1, 6, 12, Math.PI * 1.5), mats.yellow);
  hook.position.set(18, 8, -36.5); world.add(hook);

  const extract = { x: 30, z: -36, radius: 5 };
  box(30, 0.07, -36, 12, 0.12, 12, mats.dark);
  const ring = new THREE.Mesh(new THREE.RingGeometry(4.65, 4.85, 64), new THREE.MeshBasicMaterial({ color: 0x9fd5b3, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(30, 0.14, -36); world.add(ring);
  box(28.75, 0.15, -36, 0.35, 0.025, 3.4, mats.pale);
  box(31.25, 0.15, -36, 0.35, 0.025, 3.4, mats.pale);
  box(30, 0.15, -36, 2.7, 0.025, 0.35, mats.pale);
  const beaconMat = material(0x92f9bc, 0.2, { emissive: 0x5be990, emissiveIntensity: 2 });
  const beamMat = new THREE.MeshBasicMaterial({ color: 0x7becb1, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  for (const dx of [-5.5, 5.5]) for (const dz of [-5.5, 5.5]) {
    box(30 + dx, 0.7, -36 + dz, 0.45, 1.4, 0.45, mats.dark, true);
    const beacon = cylinder(30 + dx, 1.5, -36 + dz, 0.2, 0.3, beaconMat);
    animated.push(beacon);
    cylinder(30 + dx, 8, -36 + dz, 0.14, 13, beamMat, 12);
  }
  label('E4 / EVAC', 30, 3, -42.3, 5.6, 1.2, 0, '#194c42', '#a2f2bf');
  for (const x of [27.5, 32.5]) box(x, 1.5, -42.4, 0.15, 3, 0.15, mats.dark, true);
  const evacLight = new THREE.PointLight(0x73fac0, 10, 18, 2);
  evacLight.position.set(30, 2.5, -36); world.add(evacLight);

  label('KESTREL / 09', 0, 3.1, 47.4, 8, 1.5, Math.PI, '#27403c', '#e6d4a5');
  for (const x of [-4.5, 4.5]) box(x, 1.8, 47.5, 0.2, 3.6, 0.2, mats.dark, true);
  // Start-area field table gives the first cache a clearly recognizable landmark.
  box(-5.5, 0.55, 40, 2.7, 1.1, 1.5, mats.teal, true);
  label('FIELD SUPPLY', -5.5, 0.65, 40.76, 2.3, 0.48, 0, '#284744', '#e3d8ac');
  label('EXTRACTION  ↑', 12.95, 2.2, 16, 4.1, 0.9, 0, '#365b51', '#e3e4c4');
  box(12.95, 1.05, 15.94, 0.15, 2.1, 0.15, mats.dark, true);

  // Distant freighter and rounded coastal hills frame the accessible port.
  const ship = new THREE.Group(); ship.position.set(92, 0, -28); ship.rotation.y = -0.18; world.add(ship);
  box(0, 0.5, 0, 17, 3, 69, mats.dark, false, ship);
  box(0, -0.25, 0, 16, 2, 67, mats.rust, false, ship);
  box(0, 2.05, 0, 16.8, 0.4, 68, mats.pale, false, ship);
  for (let z = -18; z <= 15; z += 8) for (const x of [-4, 3]) {
    box(x, 3.65, z, 5.9, 3, 7.5, z % 3 === 0 ? mats.rust : mats.teal, false, ship);
    if (z < 5) box(x, 6.65, z, 5.9, 3, 7.5, mats.blue, false, ship);
  }
  box(0, 7, 25, 13, 10, 10, mats.pale, false, ship);
  box(0, 10, 30.05, 11.7, 1.4, 0.1, darkGlass, false, ship);
  box(0, 13.5, 24, 0.35, 5, 0.35, mats.dark, false, ship);
  box(0, 13, 24, 7, 0.2, 0.2, mats.dark, false, ship);
  for (const side of [-1, 1]) {
    box(side * 8, 2.7, 0, 0.09, 0.08, 64, mats.steel, false, ship);
    for (let z = -28; z < 31; z += 7) box(side * 8, 2.44, z, 0.07, 0.62, 0.07, mats.steel, false, ship);
  }
  for (let z = 21; z < 30; z += 2.2) for (const side of [-1, 1]) box(side * 6.56, 8.5, z, 0.04, 1.12, 1.22, darkGlass, false, ship);
  cylinder(92, 13.3, -5, 0.9, 3.2, mats.rust, 12);
  const islandMats = [material(0x849b9b), material(0x98adab)];
  for (let i = 0; i < 13; i++) {
    const rings = 10, segments = 32, vertices = [], indices = [];
    const width = 43 + (i % 4) * 11, height = 11 + (i % 5) * 2;
    for (let ring = 0; ring <= rings; ring++) for (let j = 0; j <= segments; j++) {
      const radius = ring / rings, angle = j / segments * Math.PI * 2;
      const ridge = 1 + radius * (Math.sin(angle * 3 + i) * 0.11 + Math.sin(angle * 5 - i) * 0.035);
      const elevation = Math.pow(Math.max(0, 1 - radius * radius), 1.4) * height * ridge;
      vertices.push(Math.cos(angle) * radius * width, elevation, Math.sin(angle) * radius * width * 0.8);
      if (ring < rings && j < segments) {
        const a = ring * (segments + 1) + j, b = a + segments + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices);
    // Standard geometry attributes allow the hills to join the static batches.
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((rings + 1) * (segments + 1) * 2), 2));
    geometry.computeVertexNormals();
    const island = new THREE.Mesh(geometry, islandMats[i % 2]);
    island.position.set(-228 + i * 38, -1.1, -185 - (i % 3) * 17); island.rotation.y = i * 1.3;
    island.name = 'Coastal ridge'; world.add(island);
  }
  // Simple wind pennants: the geometry makes the extraction zone visible at range.
  for (const x of [-46, 46]) {
    box(x, 5, 43, 0.1, 10, 0.1, mats.dark, true);
    const flag = box(x + 1, 9, 43, 2, 1.1, 0.04, mats.yellow);
    animated.push(flag);
  }

  const lootSpawns = [
    { x: -1.8, z: 35.2, tier: 1, label: '前线补给' },
    { x: -16.5, z: 31.2, tier: 1, label: '维修物资' },
    { x: 17.5, z: 27.8, tier: 1, label: '运输箱' },
    { x: -14, z: 13.6, tier: 2, label: '物流器材' },
    { x: -32, z: 11.4, tier: 1, label: '配件箱' },
    { x: 13.3, z: 3.8, tier: 2, label: '战术物资' },
    { x: -17.1, z: -20.8, tier: 2, label: '工业元件' },
    { x: -26, z: -31.5, tier: 3, label: '加密货物' },
    { x: -13.3, z: -25.6, tier: 2, label: '走私货箱' },
    { x: 6.4, z: -20.8, tier: 2, label: '电子设备' },
    { x: 42.9, z: -17, tier: 3, label: '海关机密' },
    { x: 22, z: -28.2, tier: 3, label: '撤离物资' },
  ];
  const enemySpawns = [
    { x: 1.5, z: 12 }, { x: -16.5, z: -5.5 }, { x: -18, z: -30.5 },
    { x: 13.5, z: -14 }, { x: 42, z: -6 }, { x: 7, z: -30.5 },
    { x: -33, z: 7.2 }, { x: 28, z: 8 },
  ];
  const zones = [
    { x: 0, z: 37, name: '南侧集结区' }, { x: -23, z: 10, name: '物流仓储区' },
    { x: -23, z: -23, name: '工业加工区' }, { x: 30, z: -36, name: '北岸撤离区' },
  ];
  scene.updateMatrixWorld(true);
  // Batch static details by material. Collision meshes remain separate so
  // raycasts stay cheap and have exactly the same shape as the visible cover.
  const keepSeparate = new Set([...blockers, ...animated, sea]);
  const batches = new Map();
  world.traverse(object => {
    if (!object.isMesh || keepSeparate.has(object)) return;
    if (!batches.has(object.material)) batches.set(object.material, []);
    batches.get(object.material).push(object);
  });
  for (const [mat, meshes] of batches) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map(mesh => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
    const combined = mergeGeometries(geometries, false);
    geometries.forEach(geometry => geometry.dispose());
    if (!combined) continue;
    const batch = new THREE.Mesh(combined, mat);
    batch.castShadow = meshes.some(mesh => mesh.castShadow);
    batch.receiveShadow = true;
    batch.name = 'Static port details';
    world.add(batch);
    for (const mesh of meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); }
  }
  scene.updateMatrixWorld(true);
  return {
    solids, blockers, lootSpawns, enemySpawns, extract, spawn: { x: 0, z: 40 }, zones,
    animate(time) {
      sky.material.uniforms.time.value = time;
      waterClock.value = time;
      textures.water.offset.set(time * 0.006, time * 0.0025);
      beaconMat.emissiveIntensity = 1.6 + Math.sin(time * 2.2) * 0.4;
      evacLight.intensity = 10 + Math.sin(time * 2.2) * 2;
      animated.slice(4).forEach((flag, i) => { flag.rotation.y = Math.sin(time * 1.8 + i) * 0.15; });
    },
  };
}
