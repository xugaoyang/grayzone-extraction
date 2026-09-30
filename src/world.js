import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const palette = {
  sand: 0xa69d81, asphalt: 0x424e4d, concrete: 0x9a9e90, pale: 0xc4c5ab,
  dark: 0x293d3d, teal: 0x357c79, rust: 0xb86136, yellow: 0xebba5a,
  blue: 0x506f80, green: 0x8fddb4, steel: 0x566360,
};

const material = (color, roughness = 0.85, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });

/** A compact original industrial port. All returned positions use ground-space x/z. */
export function createWorld(scene) {
  scene.background = new THREE.Color(0xc2d2cb);
  scene.fog = new THREE.FogExp2(0xc2d2cb, 0.006);
  const solids = [], blockers = [], animated = [];
  const mats = Object.fromEntries(Object.entries(palette).map(([key, color]) => [key, material(color)]));
  const darkGlass = material(0x284747, 0.28, { metalness: 0.35 });
  const world = new THREE.Group();
  world.name = 'Port Kestrel';
  scene.add(world);

  const hemi = new THREE.HemisphereLight(0xc6e4ef, 0x827050, 2.0);
  scene.add(hemi);
  const sunlight = new THREE.DirectionalLight(0xffe2ab, 3.5);
  sunlight.position.set(-35, 65, 28);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunlight.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 1, far: 160 });
  sunlight.shadow.bias = -0.00025;
  sunlight.shadow.normalBias = 0.04;
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
    box(x, 0.017, z, w, 0.03, d, mats.asphalt);
    if (d > w) {
      for (const edge of [-1, 1]) box(x + edge * (w / 2 - 0.22), 0.042, z, 0.13, 0.025, d, mats.pale);
      if (dashed) for (let zz = z - d / 2 + 2; zz < z + d / 2; zz += 5) box(x, 0.047, zz, 0.12, 0.025, 2.2, mats.yellow);
    } else {
      for (const edge of [-1, 1]) box(x, 0.043, z + edge * (d / 2 - 0.22), w, 0.025, 0.13, mats.pale);
    }
  }

  function container(x, z, color, code, length = 12, stacked = false) {
    const mat = material(color);
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
    label(code, x, y + 0.62, z + length / 2 + 0.1, 3.0, 0.7, 0, '#213d3b', '#e8ddbe');
    return body;
  }

  function warehouse(x, z, w, d, name, color = mats.concrete) {
    const height = 7.2;
    box(x, height / 2, z, w, height, d, color, true);
    box(x, 7.27, z, w + 0.6, 0.23, d + 0.65, mats.dark);
    box(x, 0.28, z + d / 2 + 0.05, w + 0.3, 0.56, 0.2, mats.dark);
    for (let xx = x - w / 2 + 1; xx < x + w / 2; xx += 3.1) {
      box(xx, 4.9, z + d / 2 + 0.05, 2.25, 1.3, 0.1, darkGlass);
      box(xx, 4.9, z + d / 2 + 0.12, 0.08, 1.32, 0.08, mats.pale);
    }
    for (let xx = x - w / 2 + 2; xx < x + w / 2 - 2; xx += 7) {
      box(xx, 1.8, z + d / 2 + 0.11, 4.3, 3.15, 0.12, mats.steel);
      for (let yy = 0.5; yy < 3.4; yy += 0.3) box(xx, yy, z + d / 2 + 0.18, 4.15, 0.04, 0.03, mats.dark);
      box(xx, 3.65, z + d / 2 + 0.1, 4.65, 0.15, 0.75, mats.dark);
    }
    label(name, x, 6.35, z + d / 2 + 0.13, Math.min(w - 2, 11), 1.14);
    for (const offset of [-w * 0.3, w * 0.26]) {
      box(x + offset, 7.65, z - d * 0.15, 2.5, 0.8, 2.5, mats.steel);
      cylinder(x + offset, 8.15, z - d * 0.15, 0.7, 0.3, mats.dark);
    }
    for (const side of [-1, 1]) {
      box(x + side * (w / 2 + 0.03), 3.3, z, 0.06, 0.4, d, mats.teal);
      for (let zz = z - d / 2 + 2; zz < z + d / 2; zz += 5) box(x + side * (w / 2 + 0.04), 4.8, zz, 0.1, 1.15, 2.6, darkGlass);
    }
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

  // The port sits above a broad, still bay. Low-poly islands frame the horizon.
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800), material(0x477f87, 0.28, { metalness: 0.32 }));
  sea.rotation.x = -Math.PI / 2; sea.position.y = -1.1; sea.receiveShadow = true; world.add(sea);
  box(0, -0.7, 0, 103, 1.4, 103, mats.sand);
  box(0, -0.04, 0, 99.9, 0.07, 99.9, mats.concrete);
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

  warehouse(-33, -15, 23, 27, '01 / PROCESSING');
  warehouse(29, -15, 22, 20, '02 / CUSTOMS', material(0x939f91));
  warehouse(-32, 22, 20, 14, '03 / LOGISTICS', material(0x9c9d84));
  warehouse(29, 21, 16, 12, '04 / SERVICE', material(0x8c9c91));
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

  // Pallet stacks and warning paint add readable scale beside primary cover.
  for (const [x, z] of [[-20, 20], [-20, 23], [39, 18], [38, -23], [-36, -31]]) {
    box(x, 0.5, z, 1.9, 1, 1.6, material(0x756f52), true);
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

  // Distant freighter and mountains are scenery, outside the accessible port.
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
  for (let i = 0; i < 22; i++) {
    const mountain = new THREE.Mesh(new THREE.ConeGeometry(20 + (i % 4) * 9, 18 + (i % 5) * 7, 5), material(i % 2 ? 0x7b9690 : 0x889f91));
    mountain.position.set(-195 + i * 21, 4 + (i % 5) * 2, -160 - (i % 3) * 18);
    mountain.rotation.y = i * 1.4; mountain.scale.z = 0.75; world.add(mountain);
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
  const keepSeparate = new Set([...blockers, ...animated]);
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
      beaconMat.emissiveIntensity = 1.6 + Math.sin(time * 2.2) * 0.4;
      evacLight.intensity = 10 + Math.sin(time * 2.2) * 2;
      animated.slice(4).forEach((flag, i) => { flag.rotation.y = Math.sin(time * 1.8 + i) * 0.15; });
    },
  };
}

/** Stylized armored guard. Faces +Z; movable pivots are returned for walk animation. */
export function createSoldier() {
  const group = new THREE.Group();
  const bodyMeshes = [], headMeshes = [];
  const uniform = material(0x596456);
  const armor = material(0x303e37);
  const cloth = material(0x747660);
  const skin = material(0xbaa07d);
  const boots = material(0x252d2a);
  const visor = material(0x1c3336, 0.3, { metalness: 0.45 });
  const amber = material(0xc89546);

  function part(parent, w, h, d, x, y, z, mat, head = false) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh); (head ? headMeshes : bodyMeshes).push(mesh);
    return mesh;
  }
  part(group, 0.55, 0.6, 0.34, 0, 1.24, 0, uniform);
  part(group, 0.59, 0.42, 0.19, 0, 1.28, 0.2, armor);
  part(group, 0.48, 0.47, 0.22, 0, 1.25, -0.22, armor);
  part(group, 0.51, 0.13, 0.38, 0, 0.96, 0, boots);
  for (const x of [-0.18, 0, 0.18]) part(group, 0.12, 0.2, 0.1, x, 1.13, 0.335, cloth);
  part(group, 0.18, 0.09, 0.04, 0.13, 1.43, 0.31, amber);
  part(group, 0.2, 0.19, 0.2, 0, 1.58, 0, cloth, true);
  part(group, 0.33, 0.33, 0.31, 0, 1.76, 0.035, skin, true);
  part(group, 0.42, 0.19, 0.4, 0, 1.91, 0.01, armor, true);
  part(group, 0.44, 0.07, 0.47, 0, 1.825, 0.055, armor, true);
  part(group, 0.3, 0.12, 0.055, 0, 1.775, 0.205, visor, true);
  part(group, 0.32, 0.12, 0.08, 0, 1.63, 0.19, cloth, true);
  part(group, 0.08, 0.14, 0.12, -0.235, 1.79, 0, boots, true);
  part(group, 0.08, 0.14, 0.12, 0.235, 1.79, 0, boots, true);

  const limbs = {};
  for (const [name, side] of [['leftLeg', -1], ['rightLeg', 1]]) {
    const pivot = new THREE.Group(); pivot.position.set(side * 0.16, 0.94, 0); group.add(pivot);
    part(pivot, 0.23, 0.38, 0.26, 0, -0.22, 0, uniform);
    part(pivot, 0.23, 0.22, 0.09, 0, -0.43, 0.145, armor);
    part(pivot, 0.19, 0.35, 0.22, 0, -0.62, 0, uniform);
    part(pivot, 0.25, 0.17, 0.36, 0, -0.855, 0.07, boots);
    limbs[name] = pivot;
  }
  for (const [name, side] of [['leftArm', -1], ['rightArm', 1]]) {
    const pivot = new THREE.Group(); pivot.position.set(side * 0.37, 1.46, 0); group.add(pivot);
    const upper = part(pivot, 0.2, 0.35, 0.22, 0, -0.16, 0.02, uniform);
    upper.rotation.x = -0.4;
    part(pivot, 0.22, 0.19, 0.25, 0, -0.01, 0, armor);
    const lower = part(pivot, 0.18, 0.32, 0.18, side * -0.06, -0.32, 0.18, cloth);
    lower.rotation.x = -1.08;
    part(pivot, 0.17, 0.15, 0.17, side * -0.13, -0.36, 0.36, boots);
    limbs[name] = pivot;
  }
  // Rifle rests forward across the arms; its narrow shapes are body hitboxes.
  part(group, 0.14, 0.17, 0.62, 0.2, 1.125, 0.5, boots);
  part(group, 0.11, 0.12, 0.36, 0.2, 1.135, 0.95, armor);
  part(group, 0.08, 0.08, 0.2, 0.2, 1.135, 1.2, boots);
  part(group, 0.13, 0.22, 0.14, 0.2, 0.97, 0.43, boots);
  part(group, 0.1, 0.08, 0.17, 0.2, 1.245, 0.48, visor);
  return { group, bodyMeshes, headMeshes, limbs };
}

/** View-model weapon oriented along camera -Z, built without external models. */
export function createWeapon() {
  const group = new THREE.Group();
  const steel = material(0x283430, 0.42, { metalness: 0.55 });
  const dark = material(0x162321, 0.7);
  const tan = material(0x7d8165, 0.75);
  const rail = material(0x4c5750, 0.4, { metalness: 0.5 });
  const glove = material(0x3a463a);
  const sleeve = material(0x6d7560);
  const glass = new THREE.MeshBasicMaterial({ color: 0x75ae9b, transparent: true, opacity: 0.16, depthWrite: false });

  function part(w, h, d, x, y, z, mat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z); group.add(mesh); return mesh;
  }
  part(0.115, 0.16, 0.42, 0, 0, -0.06, tan);
  part(0.1, 0.08, 0.44, 0, 0.075, -0.07, steel);
  part(0.105, 0.11, 0.36, 0, 0, -0.44, tan);
  part(0.115, 0.035, 0.72, 0, 0.098, -0.23, rail);
  for (let z = -0.58; z < 0.07; z += 0.034) part(0.122, 0.015, 0.012, 0, 0.12, z, dark);
  for (const side of [-1, 1]) for (let z = -0.53; z < -0.3; z += 0.058) part(0.006, 0.025, 0.035, side * 0.055, 0.012, z, dark);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.27, 10), steel);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.026, -0.745); group.add(barrel);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.09, 10), dark);
  muzzle.rotation.x = Math.PI / 2; muzzle.position.set(0, 0.026, -0.88); group.add(muzzle);
  part(0.09, 0.135, 0.23, 0, -0.02, 0.25, tan);
  part(0.13, 0.16, 0.04, 0, -0.035, 0.38, dark);
  const grip = part(0.074, 0.18, 0.09, 0, -0.15, 0.075, dark); grip.rotation.x = -0.23;
  const magazine = part(0.08, 0.235, 0.13, 0, -0.18, -0.11, dark); magazine.rotation.x = -0.13;
  for (let y = -0.12; y > -0.27; y -= 0.045) part(0.084, 0.012, 0.132, 0, y, -0.105, rail);
  part(0.028, 0.04, 0.095, 0.072, 0.015, -0.04, steel);
  // Open reflex sight with a luminous reticle.
  part(0.095, 0.035, 0.095, 0, 0.145, -0.16, dark);
  part(0.017, 0.095, 0.036, -0.045, 0.19, -0.16, dark);
  part(0.017, 0.095, 0.036, 0.045, 0.19, -0.16, dark);
  part(0.106, 0.018, 0.036, 0, 0.24, -0.16, dark);
  part(0.073, 0.08, 0.007, 0, 0.194, -0.16, glass);
  part(0.006, 0.006, 0.009, 0, 0.192, -0.154, new THREE.MeshBasicMaterial({ color: 0xfd6643 }));
  // Gloved hands and forearms deliberately stay below the sight line.
  const rightHand = part(0.105, 0.11, 0.13, 0.025, -0.125, 0.105, glove); rightHand.rotation.x = -0.3;
  const rightArm = part(0.13, 0.13, 0.38, 0.075, -0.2, 0.26, sleeve); rightArm.rotation.y = -0.22; rightArm.rotation.x = 0.2;
  const leftHand = part(0.14, 0.09, 0.17, -0.04, -0.071, -0.4, glove); leftHand.rotation.z = 0.2;
  const leftArm = part(0.13, 0.13, 0.45, -0.16, -0.15, -0.19, sleeve); leftArm.rotation.y = 0.46; leftArm.rotation.x = -0.22;
  group.userData.muzzle = new THREE.Vector3(0, 0.026, -0.94);
  return group;
}
