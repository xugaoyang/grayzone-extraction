import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Original procedural models. Shape detail lives in geometry, so these models
// also work in Node and do not depend on downloaded assets or canvas textures.
const TAU = Math.PI * 2;
const surface = (color, roughness = .8, metalness = 0, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

function fabricTexture(camouflage = true) {
  const size = 64, data = new Uint8Array(size * size * 4);
  const colors = camouflage ? [[86, 98, 78], [111, 116, 89], [56, 69, 57], [141, 133, 101]] : [[127, 119, 91]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const field = Math.sin(x * .27 + Math.sin(y * .20) * 2.8) + Math.cos(y * .29 + Math.sin(x * .12) * 3.5);
    const index = camouflage ? (field > 1.1 ? 3 : field > .05 ? 1 : field < -.9 ? 2 : 0) : 0;
    const weave = ((x ^ y) & 1 ? 3 : -3) + Math.sin(x * 5.7 + y * 17.3) * 2;
    const offset = (y * size + x) * 4;
    for (let i = 0; i < 3; i++) data[offset + i] = colors[index][i] + weave;
    data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.repeat.set(2, 2);
  texture.needsUpdate = true;
  return texture;
}

function roundedRectangle(width, height, radius, x = 0, y = 0) {
  const shape = new THREE.Shape(), l = x - width / 2, r = x + width / 2, b = y - height / 2, t = y + height / 2;
  shape.moveTo(l + radius, b);
  shape.lineTo(r - radius, b); shape.quadraticCurveTo(r, b, r, b + radius);
  shape.lineTo(r, t - radius); shape.quadraticCurveTo(r, t, r - radius, t);
  shape.lineTo(l + radius, t); shape.quadraticCurveTo(l, t, l, t - radius);
  shape.lineTo(l, b + radius); shape.quadraticCurveTo(l, b, l + radius, b);
  return shape;
}

function bevelBox(width, height, depth, bevel = .01) {
  if (bevel <= 0) return new THREE.BoxGeometry(width, height, depth);
  const edge = Math.min(bevel, width * .19, height * .19, depth * .19);
  const shape = roundedRectangle(width - edge * 2, height - edge * 2, edge);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth - edge * 2, bevelEnabled: true, bevelThickness: edge,
    bevelSize: edge, bevelSegments: 1, steps: 1, curveSegments: 2,
  });
  geometry.translate(0, 0, -depth / 2 + edge);
  return geometry;
}

// A side silhouette in y/z coordinates, extruded across the firearm's width.
function sideProfile(points, width, holes = [], bevel = .004) {
  const shape = new THREE.Shape();
  points.forEach(([y, z], i) => i ? shape.lineTo(z, y) : shape.moveTo(z, y));
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    hole.forEach(([y, z], i) => i ? path.lineTo(z, y) : path.moveTo(z, y));
    path.closePath(); shape.holes.push(path);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel,
    bevelSize: bevel, bevelSegments: 1, curveSegments: 3, steps: 1,
  });
  geometry.translate(0, 0, -width / 2 + bevel);
  geometry.rotateY(-Math.PI / 2);
  return geometry;
}

/** Merge by material within each movable pivot, keeping visible raycast parts. */
function assembler(root, hitLists = null) {
  const batches = new Map();
  function add(parent, geometry, mat, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1], head = false) {
    const key = `${parent.uuid}:${mat.uuid}:${head}`;
    if (!batches.has(key)) batches.set(key, { parent, mat, head, geometries: [] });
    const transform = new THREE.Matrix4().compose(
      new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale),
    );
    geometry.applyMatrix4(transform);
    batches.get(key).geometries.push(geometry);
  }
  function box(parent, size, position, mat, rotation = [0, 0, 0], head = false, bevel = .01) {
    add(parent, bevelBox(...size, bevel), mat, position, rotation, [1, 1, 1], head);
  }
  function ellipsoid(parent, position, radii, mat, head = false, segments = 10) {
    add(parent, new THREE.SphereGeometry(1, segments, hitLists ? 5 : 6), mat, position, [0, 0, 0], radii, head);
  }
  function bone(parent, start, end, radius, mat, head = false, endRadius = radius) {
    const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end);
    const direction = b.clone().sub(a), length = direction.length();
    const geometry = new THREE.CylinderGeometry(endRadius, radius, length, 8, 1);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
    geometry.translate(...a.add(b).multiplyScalar(.5).toArray());
    add(parent, geometry, mat, [0, 0, 0], [0, 0, 0], [1, 1, 1], head);
    if (hitLists) {
      add(parent, new THREE.SphereGeometry(1, 6, 4), mat, start, [0, 0, 0], [radius, radius, radius], head);
      add(parent, new THREE.SphereGeometry(1, 6, 4), mat, end, [0, 0, 0], [endRadius, endRadius, endRadius], head);
    } else {
      ellipsoid(parent, start, [radius, radius, radius], mat, head, 8);
      ellipsoid(parent, end, [endRadius, endRadius, endRadius], mat, head, 8);
    }
  }
  function flush() {
    for (const { parent, mat, head, geometries } of batches.values()) {
      // Primitives and extrusions may have different UV/index layouts.
      const normalized = geometries.map(geometry => {
        const flat = geometry.index ? geometry.toNonIndexed() : geometry;
        flat.deleteAttribute('uv1');
        return flat;
      });
      const merged = mergeGeometries(normalized, false);
      if (!merged) throw new Error('Procedural model geometry could not be merged');
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${parent.name || root.name} / ${head ? 'head' : 'surface'}`;
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      if (hitLists) (head ? hitLists.headMeshes : hitLists.bodyMeshes).push(mesh);
      for (const geometry of new Set([...geometries, ...normalized])) geometry.dispose();
    }
    batches.clear();
  }
  return { add, box, ellipsoid, bone, flush };
}

function rifleMaterials(detailed = true) {
  const steel = surface(0x303633, .36, .72);
  const polymer = surface(0x262b26, .73, .03);
  const tan = surface(0x9d906d, .66, .15);
  return {
    steel, polymer, tan,
    bright: detailed ? surface(0x727973, .3, .76) : steel,
    rubber: detailed ? surface(0x151b18, .91) : polymer,
    glass: detailed ? new THREE.MeshBasicMaterial({ color: 0x91c9b2, transparent: true, opacity: .10, depthWrite: false, side: THREE.DoubleSide }) : steel,
    dot: detailed ? new THREE.MeshBasicMaterial({ color: 0xff6043, toneMapped: false }) : polymer,
  };
}

/** Modern original carbine. Forward is -Z; the handle is close to the origin. */
function buildCarbine(group, a, detailed = true) {
  const m = rifleMaterials(detailed);
  const box = (size, position, mat, rotation, bevel) => a.box(group, size, position, mat, rotation, false, bevel);
  const profile = (points, width, mat, holes = [], position = [0, 0, 0], bevel = .004, parent = group) =>
    a.add(parent, sideProfile(points, width, holes, bevel), mat, position);

  profile([[.058, .125], [.079, .07], [.079, -.25], [.057, -.283], [-.035, -.271], [-.064, -.18], [-.053, .095]], .113, m.tan);
  profile([[.012, .098], [.015, -.178], [-.027, -.208], [-.075, -.177], [-.091, -.056], [-.052, .091]], .098, m.tan);
  // Exposed barrel extension, receiver pins, ejection port and charging handle.
  box([.015, .041, .112], [.061, .024, -.065], m.polymer, undefined, .004);
  box([.009, .015, .081], [.071, .025, -.058], m.bright, undefined, .002);
  box([.044, .017, .048], [.078, .049, -.012], m.steel, [0, .19, 0], .003);
  box([.17, .013, .025], [0, .072, .107], m.polymer, undefined, .003);
  if (detailed) {
    for (const z of [.057, -.185]) for (const side of [-1, 1]) {
      a.add(group, new THREE.CylinderGeometry(.007, .007, .005, 8), m.bright, [side * .059, -.021, z], [0, 0, Math.PI / 2]);
    }
    box([.009, .014, .034], [-.061, -.029, .048], m.polymer, [.3, 0, 0], .002);
    box([.007, .021, .011], [-.062, -.04, -.12], m.steel, undefined, .002);
  }

  // Adjustable buttstock with a real open triangular brace and rubber pad.
  a.add(group, new THREE.CylinderGeometry(.019, .021, .205, 10), m.steel, [0, .023, .21], [Math.PI / 2, 0, 0]);
  profile([[.061, .161], [.07, .33], [.048, .387], [-.096, .391], [-.107, .326], [-.026, .17]], .09, m.tan,
    [[[.018, .208], [.029, .303], [-.051, .325], [-.047, .28]]]);
  box([.115, .164, .024], [0, -.025, .392], m.rubber, [-.12, 0, 0], .009);
  box([.096, .022, .135], [0, .069, .262], m.polymer, undefined, .006);
  if (detailed) for (let y = -.084; y < .045; y += .027) box([.102, .007, .012], [0, y, .408], m.polymer, undefined, .001);

  // Actual openings in both handguard side plates rather than painted holes.
  const handguardOutline = [[.066, -.264], [.062, -.608], [.04, -.635], [-.035, -.616], [-.045, -.292]];
  const slots = [];
  for (let z = -.319; z >= -.569; z -= .064) {
    slots.push([[.034, z + .020], [.038, z - .02], [.007, z - .023], [.003, z + .022]]);
    if (detailed) slots.push([[-.02, z + .018], [-.018, z - .019], [-.031, z - .019], [-.033, z + .018]]);
  }
  for (const side of [-1, 1]) profile(handguardOutline, .009, m.tan, slots, [side * .052, 0, 0], .0015);
  box([.083, .018, .337], [0, -.047, -.449], m.tan, undefined, .003);
  box([.092, .018, .714], [0, .091, -.254], m.steel, undefined, .003);
  const railCount = detailed ? 24 : 12;
  for (let i = 0; i < railCount; i++) box([.111, .012, .012], [0, .106, .073 - i * .028 * (detailed ? 1 : 2)], m.polymer, undefined, detailed ? .0015 : 0);
  a.add(group, new THREE.CylinderGeometry(.017, .019, .252, 12), m.steel, [0, .026, -.749], [Math.PI / 2, 0, 0]);
  a.add(group, new THREE.CylinderGeometry(.025, .027, .061, 12), m.steel, [0, .026, -.631], [Math.PI / 2, 0, 0]);
  if (detailed) for (const side of [-1, 1]) for (const z of [-.285, -.60]) {
    a.add(group, new THREE.CylinderGeometry(.007, .007, .005, 8), m.bright, [side * .06, -.003, z], [0, 0, Math.PI / 2]);
  }
  // Open muzzle bore: the black interior is visibly recessed behind the lip.
  a.add(group, new THREE.CylinderGeometry(.029, .027, .071, 12, 1, true), m.steel, [0, .026, -.90], [Math.PI / 2, 0, 0]);
  a.add(group, new THREE.TorusGeometry(.023, .0055, 4, 12), m.bright, [0, .026, -.936]);
  a.add(group, new THREE.CircleGeometry(.021, 12), m.rubber, [0, .026, -.909]);
  if (detailed) for (const side of [-1, 1]) for (const z of [-.882, -.908]) {
    box([.006, .018, .015], [side * .028, .026, z], m.rubber, undefined, .002);
  }

  // Angled pistol grip, open trigger guard and independently movable magazine.
  profile([[-.052, .049], [-.07, .118], [-.215, .153], [-.23, .083], [-.167, .065]], .074, m.polymer);
  if (detailed) for (let y = -.12; y >= -.20; y -= .024) {
    box([.079, .005, .058], [0, y, .099 + (-y - .12) * .22], m.rubber, [-.2, 0, 0], .001);
  }
  profile([[-.06, .061], [-.138, .067], [-.146, -.055], [-.065, -.066]], .035, m.polymer,
    [[[-.073, .05], [-.121, .051], [-.128, -.042], [-.073, -.05]]], [0, 0, 0], .002);
  a.add(group, new THREE.TorusGeometry(.02, .004, 4, 10, Math.PI * 1.05), m.bright, [0, -.094, .001], [0, Math.PI / 2, -.5]);
  const magazine = new THREE.Group(); magazine.name = 'Curved detachable magazine'; group.add(magazine);
  profile([[-.067, -.057], [-.159, -.051], [-.255, -.075], [-.322, -.111], [-.324, -.178], [-.248, -.172], [-.153, -.149], [-.071, -.143]], .079, m.polymer, [], [0, 0, 0], .005, magazine);
  a.box(magazine, [.088, .015, .089], [0, -.325, -.143], m.rubber, [.18, 0, 0], false, .004);
  if (detailed) for (const side of [-1, 1]) for (const z of [-.078, -.108, -.135]) {
    a.bone(magazine, [side * .043, -.108, z], [side * .043, -.279, z - .025], .0024, m.bright);
  }

  // Rounded reflex hood. Its open optical axis matches the gameplay ADS offset.
  box([.082, .022, .107], [0, .126, -.158], m.polymer, undefined, .004);
  if (detailed) {
    const hood = roundedRectangle(.121, .126, .026, 0, .194);
    const opening = roundedRectangle(.085, .087, .017, 0, .194);
    hood.holes.push(new THREE.Path(opening.getPoints(4)));
    const hoodGeometry = new THREE.ExtrudeGeometry(hood, { depth: .028, bevelEnabled: true, bevelThickness: .002, bevelSize: .002, bevelSegments: 1, curveSegments: 3, steps: 1 });
    hoodGeometry.translate(0, 0, -.175);
    a.add(group, hoodGeometry, m.polymer);
    const lens = new THREE.ShapeGeometry(roundedRectangle(.083, .085, .016, 0, .194), 4);
    a.add(group, lens, m.glass, [0, 0, -.159]);
    a.add(group, new THREE.SphereGeometry(.0027, 8, 6), m.dot, [0, .192, -.154]);
    box([.018, .028, .035], [.068, .178, -.162], m.polymer, undefined, .003);
    a.add(group, new THREE.CylinderGeometry(.011, .011, .012, 10), m.bright, [.08, .178, -.162], [0, 0, Math.PI / 2]);
  } else {
    for (const side of [-1, 1]) box([.017, .108, .027], [side * .05, .191, -.16], m.polymer, undefined, 0);
    box([.11, .017, .027], [0, .246, -.16], m.polymer, undefined, 0);
  }
  group.userData.muzzle = new THREE.Vector3(0, .026, -.94);
  group.userData.parts = { magazine };
}

/** Anatomical guard with articulated shoulders/hips, armor and equipment. */
export function createSoldier() {
  const group = new THREE.Group(); group.name = 'Armored patrol guard';
  const bodyMeshes = [], headMeshes = [], limbs = {};
  const a = assembler(group, { bodyMeshes, headMeshes });
  const uniform = surface(0xffffff, .96, 0, { map: fabricTexture() });
  const carrier = surface(0x61634c, .93);
  const fabric = surface(0x84836b, .97);
  const dark = surface(0x2a3029, .85);
  const rubber = surface(0x202622, .91);
  const skin = surface(0xba9c7d, .78);
  const lens = surface(0x172e2b, .18, .55);
  const buckles = surface(0x92927b, .52, .3);

  // Tapered, flattened torso and pelvis, with a rounded plate carrier.
  a.add(group, new THREE.CylinderGeometry(.255, .206, .51, 10), uniform, [0, 1.23, 0], [0, 0, 0], [1, 1, .64]);
  a.ellipsoid(group, [0, .97, 0], [.233, .144, .165], uniform);
  a.add(group, sideProfile([[1.43, .15], [1.49, .09], [1.51, -.055], [1.4, -.095], [1.08, -.083], [1.047, .18]], .43, [], .016), carrier);
  a.box(group, [.455, .394, .101], [0, 1.285, .153], carrier, undefined, false, .024);
  a.box(group, [.362, .397, .145], [0, 1.275, -.239], carrier, undefined, false, .035);
  a.box(group, [.29, .127, .15], [0, 1.014, -.232], fabric, undefined, false, .023);
  for (const x of [-.183, .183]) {
    a.box(group, [.067, .208, .062], [x, 1.43, .15], fabric, [-.33, 0, x > 0 ? -.10 : .10], false, .011);
    a.box(group, [.071, .026, .072], [x, 1.4, .193], buckles, undefined, false, 0);
  }
  for (const x of [-.14, 0, .14]) {
    a.box(group, [.116, .175, .088], [x, 1.159, .224], fabric, undefined, false, .016);
    a.box(group, [.118, .047, .034], [x, 1.234, .271], carrier, undefined, false, .007);
  }
  for (const y of [1.31, 1.353]) a.box(group, [.372, .012, .015], [0, y, .211], fabric, undefined, false, 0);
  a.box(group, [.1, .052, .014], [.055, 1.422, .213], dark, undefined, false, .003);
  a.box(group, [.452, .063, .344], [0, .973, .003], dark, undefined, false, .011);
  a.box(group, [.092, .05, .025], [0, .972, .188], buckles, undefined, false, 0);
  a.box(group, [.101, .175, .094], [.247, 1.25, .029], carrier, undefined, false, .015);
  a.add(group, new THREE.CylinderGeometry(.005, .006, .227, 6), dark, [.2635, 1.4485, .029]);
  a.box(group, [.106, .172, .117], [-.242, .96, .017], fabric, undefined, false, .017);

  // Human skull, exposed cheek/ear shapes, balaclava, goggles and shell helmet.
  a.ellipsoid(group, [0, 1.571, .016], [.078, .11, .075], fabric, true);
  a.ellipsoid(group, [0, 1.749, .021], [.142, .179, .131], skin, true, 12);
  a.ellipsoid(group, [0, 1.663, .084], [.126, .07, .088], fabric, true);
  a.ellipsoid(group, [0, 1.739, .151], [.025, .045, .035], skin, true, 8);
  for (const side of [-1, 1]) {
    a.ellipsoid(group, [side * .143, 1.758, .018], [.029, .048, .029], skin, true, 8);
    a.ellipsoid(group, [side * .174, 1.787, -.002], [.034, .074, .057], rubber, true, 8);
    a.box(group, [.023, .046, .064], [side * .193, 1.80, .003], carrier, undefined, true, .01);
  }
  const helmet = new THREE.SphereGeometry(.208, 12, 7, 0, TAU, 0, Math.PI * .61);
  a.add(group, helmet, carrier, [0, 1.842, .002], [0, 0, 0], [1, .73, .99], true);
  a.add(group, new THREE.TorusGeometry(.195, .014, 4, 16), rubber, [0, 1.817, .002], [Math.PI / 2, 0, 0], [1, 1, 1], true);
  a.box(group, [.058, .07, .031], [0, 1.908, .19], dark, [-.25, 0, 0], true, .008);
  a.box(group, [.262, .078, .05], [0, 1.777, .15], dark, undefined, true, .018);
  a.box(group, [.229, .053, .027], [0, 1.78, .179], lens, undefined, true, .015);
  a.box(group, [.025, .07, .015], [0, 1.778, .197], dark, undefined, true, .005);
  a.bone(group, [-.174, 1.753, .033], [-.12, 1.687, .19], .005, dark, true);
  a.ellipsoid(group, [-.108, 1.687, .202], [.017, .009, .009], rubber, true, 8);

  for (const [name, side] of [['leftLeg', -1], ['rightLeg', 1]]) {
    const pivot = new THREE.Group(); pivot.name = name; pivot.position.set(side * .139, .95, 0); group.add(pivot); limbs[name] = pivot;
    a.bone(pivot, [0, -.057, 0], [side * .012, -.377, .014], .112, uniform, false, .089);
    a.bone(pivot, [side * .012, -.448, .015], [side * .012, -.73, -.004], .084, uniform, false, .069);
    a.ellipsoid(pivot, [side * .012, -.412, .112], [.096, .11, .032], carrier);
    a.box(pivot, [.177, .042, .186], [side * .012, -.447, .004], dark, undefined, false, .01);
    a.ellipsoid(pivot, [0, -.829, .043], [.105, .119, .177], rubber);
    a.box(pivot, [.212, .043, .29], [0, -.927, .053], dark, undefined, false, .016);
    a.box(pivot, [.136, .106, .076], [0, -.808, .12], fabric, [.31, 0, 0], false, .013);
    for (let y = -.779; y > -.85; y -= .027) a.box(pivot, [.105, .005, .009], [0, y, .161], dark, undefined, false, 0);
  }

  const handTargets = { leftArm: [-.015, 1.191, .471], rightArm: [.059, 1.121, .164] };
  for (const [name, side] of [['leftArm', -1], ['rightArm', 1]]) {
    const pivot = new THREE.Group(); pivot.name = name; pivot.position.set(side * .31, 1.451, 0); group.add(pivot); limbs[name] = pivot;
    const elbow = name === 'leftArm' ? [.102, -.258, .213] : [-.004, -.267, .073];
    const target = new THREE.Vector3(...handTargets[name]).sub(pivot.position).toArray();
    const wrist = new THREE.Vector3(...target).lerp(new THREE.Vector3(...elbow), .12).toArray();
    a.bone(pivot, [0, -.023, 0], elbow, .099, uniform, false, .08);
    a.bone(pivot, elbow, wrist, .078, uniform, false, .052);
    a.ellipsoid(pivot, [0, -.023, -.023], [.115, .114, .086], carrier);
    a.ellipsoid(pivot, [elbow[0], elbow[1], elbow[2] - .057], [.075, .066, .036], carrier);
    a.ellipsoid(pivot, target, [.059, .051, .069], dark);
    for (let i = 0; i < 4; i++) a.ellipsoid(pivot,
      [target[0] + (i - 1.5) * .022, target[1] - .03, target[2] + .027], [.011, .022, .022], rubber, false, 6);
  }

  const rifle = new THREE.Group(); rifle.name = 'Guard carbine'; rifle.position.set(.052, 1.216, .245); rifle.rotation.y = Math.PI; rifle.scale.setScalar(.62); group.add(rifle);
  buildCarbine(rifle, a, false);
  a.flush();
  return { group, bodyMeshes, headMeshes, limbs };
}

/** Player carbine with real openings, sculpted metal/polymer and gloved hands. */
export function createWeapon() {
  const group = new THREE.Group(); group.name = 'AR-36 tactical carbine';
  const a = assembler(group);
  buildCarbine(group, a, true);
  const sleeve = surface(0xffffff, .97, 0, { map: fabricTexture(false) });
  const glove = surface(0x555749, .96);
  const padding = surface(0x303931, .84);
  const seams = surface(0x8c876e, .95);
  // Forearm tapers follow the elbow-to-wrist direction, rather than box arms.
  a.bone(group, [.154, -.279, .44], [.037, -.164, .112], .074, sleeve, false, .047);
  a.bone(group, [-.338, -.246, .207], [-.091, -.091, -.368], .068, sleeve, false, .049);
  a.ellipsoid(group, [.027, -.136, .091], [.057, .074, .065], glove, false, 12);
  a.ellipsoid(group, [-.035, -.062, -.424], [.066, .047, .09], glove, false, 12);
  a.ellipsoid(group, [.069, -.138, .098], [.021, .043, .03], padding);
  a.ellipsoid(group, [-.053, -.09, -.412], [.062, .017, .052], padding);
  a.box(group, [.103, .017, .032], [.035, -.179, .133], padding, [-.26, 0, .26], false, .009);
  a.box(group, [.104, .016, .026], [-.093, -.096, -.348], padding, [0, -.36, -.19], false, .008);
  // Individually rounded curled fingers wrap the grip and handguard.
  for (let i = 0; i < 3; i++) {
    const y = -.112 - i * .025;
    a.bone(group, [.048, y, .065], [.027, y - .006, .032], .0117, glove);
    a.bone(group, [.027, y - .006, .032], [-.006, y - .004, .047], .0117, glove);
    a.ellipsoid(group, [.045, y + .002, .068], [.016, .01, .019], padding);
  }
  a.bone(group, [.046, -.079, .069], [.049, -.082, -.009], .0114, glove);
  a.bone(group, [.049, -.082, -.009], [.017, -.094, -.018], .011, glove);
  a.bone(group, [-.027, -.104, .087], [-.025, -.099, .058], .016, glove);
  for (let i = 0; i < 4; i++) {
    const z = -.387 - i * .026;
    a.bone(group, [-.073, -.042, z], [-.056, -.013, z], .0115, glove);
    a.bone(group, [-.056, -.013, z], [-.03, -.009, z], .0108, glove);
    a.ellipsoid(group, [-.067, -.033, z], [.014, .012, .013], padding);
  }
  a.bone(group, [.006, -.067, -.363], [.033, -.039, -.392], .017, glove);
  a.bone(group, [-.327, -.237, .191], [-.111, -.08, -.347], .0028, seams);
  a.flush();
  return group;
}
