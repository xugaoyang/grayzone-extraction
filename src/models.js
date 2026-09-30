import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { animateSoldier } from './actor-animation.js';

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
    add(parent, new THREE.SphereGeometry(1, segments, head && segments >= 12 ? 10 : hitLists ? 5 : 6), mat, position, [0, 0, 0], radii, head);
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
function buildCarbine(group, a, detailed = true, kind = 'tactical') {
  const m = rifleMaterials(detailed);
  if (kind === 'basic') { m.tan.color.setHex(0x465158); m.polymer.color.setHex(0x242e31); }
  if (kind === 'heavy') { m.tan.color.setHex(0x646951); m.polymer.color.setHex(0x222821); }
  const box = (size, position, mat, rotation, bevel) => a.box(group, size, position, mat, rotation, false, bevel);
  const profile = (points, width, mat, holes = [], position = [0, 0, 0], bevel = .004, parent = group) =>
    a.add(parent, sideProfile(points, width, holes, bevel), mat, position);

  profile([[.058, .125], [.079, .07], [.079, -.25], [.057, -.283], [-.035, -.271], [-.064, -.18], [-.053, .095]], .113, m.tan);
  profile([[.012, .098], [.015, -.178], [-.027, -.208], [-.075, -.177], [-.091, -.056], [-.052, .091]], .098, m.tan);
  // Exposed barrel extension, receiver pins, ejection port and charging handle.
  box([.015, .041, .112], [.061, .024, -.065], m.polymer, undefined, .004);
  const bolt = new THREE.Group(); bolt.name = 'Reciprocating bolt'; bolt.position.set(.071, .025, -.058); group.add(bolt);
  a.box(bolt, [.009, .015, .081], [0, 0, 0], m.bright, undefined, false, .002);
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
  const magazine = new THREE.Group(); magazine.name = 'Detachable magazine'; group.add(magazine);
  const magazineProfiles = {
    basic: [[-.067, -.073], [-.362, -.082], [-.366, -.145], [-.067, -.137]],
    tactical: [[-.067, -.057], [-.159, -.051], [-.255, -.075], [-.322, -.111], [-.324, -.178], [-.248, -.172], [-.153, -.149], [-.071, -.143]],
    heavy: [[-.067, -.054], [-.245, -.056], [-.265, -.075], [-.267, -.165], [-.074, -.16]],
  };
  profile(magazineProfiles[kind], kind === 'basic' ? .061 : .079, m.polymer, [], [0, 0, 0], .005, magazine);
  const magazineBottom = kind === 'basic' ? -.363 : kind === 'heavy' ? -.268 : -.325;
  a.box(magazine, [kind === 'basic' ? .072 : .088, .015, kind === 'basic' ? .072 : .089], [0, magazineBottom, kind === 'basic' ? -.113 : -.143], m.rubber, [kind === 'tactical' ? .18 : 0, 0, 0], false, .004);
  if (detailed) for (const side of [-1, 1]) for (const z of [-.078, -.108, -.135]) {
    a.bone(magazine, [side * (kind === 'basic' ? .033 : .043), -.108, z], [side * (kind === 'basic' ? .033 : .043), magazineBottom + .046, z - (kind === 'tactical' ? .025 : 0)], .0024, m.bright);
  }

  // Rounded reflex hood. Its open optical axis matches the gameplay ADS offset.
  box([.082, .022, .107], [0, .126, -.158], m.polymer, undefined, .004);
  if (detailed && kind === 'heavy') {
    // A visibly longer optical tube, open along the same ADS sight axis.
    a.add(group, new THREE.CylinderGeometry(.061, .059, .194, 18, 1, true), m.polymer, [0, .192, -.155], [Math.PI / 2, 0, 0]);
    a.add(group, new THREE.CylinderGeometry(.075, .061, .086, 18, 1, true), m.steel, [0, .192, -.293], [Math.PI / 2, 0, 0]);
    for (const [z, radius] of [[-.058, .06], [-.253, .06], [-.336, .075]]) {
      a.add(group, new THREE.TorusGeometry(radius, .006, 5, 18), m.rubber, [0, .192, z]);
    }
    a.add(group, new THREE.CircleGeometry(.057, 18), m.glass, [0, .192, -.241]);
    a.add(group, new THREE.CylinderGeometry(.024, .024, .022, 12), m.steel, [.071, .192, -.146], [0, 0, Math.PI / 2]);
    a.add(group, new THREE.CylinderGeometry(.025, .025, .025, 12), m.polymer, [0, .266, -.146]);
    for (const z of [-.096, -.219]) box([.089, .02, .021], [0, .14, z], m.steel, undefined, .002);
    a.add(group, new THREE.SphereGeometry(.0027, 8, 6), m.dot, [0, .192, -.154]);
  } else if (detailed) {
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
  group.userData.reticle = new THREE.Vector3(0, .192, -.154);
  const casingEject = new THREE.Group(); casingEject.name = 'Ejection port'; casingEject.position.set(.097, .028, -.065); group.add(casingEject);
  group.userData.parts = { magazine, bolt, casingEject };
}

/** Human guard with an articulated anatomical rig and independently movable face. */
export function createSoldier() {
  const group = new THREE.Group(); group.name = 'Human patrol operator';
  const bodyMeshes = [], headMeshes = [], limbs = {};
  const a = assembler(group, { bodyMeshes, headMeshes });
  const uniform = surface(0xffffff, .96, 0, { map: fabricTexture() });
  const carrier = surface(0x64654f, .93), fabric = surface(0x86816b, .97);
  const dark = surface(0x30372d, .86), rubber = surface(0x222820, .92);
  const skin = surface(0xc29c7c, .82), lips = surface(0x916957, .93);
  const hair = surface(0x463d33, .99), eyeWhite = surface(0xd8dacb, .38);
  const iris = surface(0x65765c, .35), pupil = surface(0x111914, .24);
  const buckles = surface(0x92927b, .52, .3), glass = surface(0x1d3736, .18, .6);
  const torso = new THREE.Group(); torso.name = 'Breathing torso'; torso.position.y = .955; group.add(torso);
  const head = new THREE.Group(); head.name = 'Head and neck'; head.position.y = .625; torso.add(head);
  const rig = { torso, head, eyes: [], brows: [], animation: { phase: 0, locomotion: 0, alert: 0, offset: Math.random() * 3.5 } };

  // Human shoulders slope into a narrower waist rather than a rectangular body.
  a.add(torso, new THREE.CylinderGeometry(.226, .177, .49, 12), uniform, [0, 1.228, 0], [0, 0, 0], [1, 1, .64]);
  a.ellipsoid(torso, [0, .981, -.008], [.207, .127, .151], uniform);
  a.box(torso, [.397, .371, .088], [0, 1.283, .142], carrier, undefined, false, .028);
  a.box(torso, [.318, .367, .143], [0, 1.289, -.22], carrier, undefined, false, .032);
  a.box(torso, [.255, .105, .157], [0, 1.042, -.237], fabric, undefined, false, .02);
  for (const x of [-.154, .154]) {
    a.box(torso, [.056, .194, .046], [x, 1.428, .132], fabric, [-.29, 0, x > 0 ? -.1 : .1], false, .01);
    a.box(torso, [.059, .023, .025], [x, 1.411, .159], buckles, undefined, false, 0);
  }
  for (const x of [-.12, 0, .12]) {
    a.box(torso, [.102, .163, .075], [x, 1.169, .209], fabric, undefined, false, .015);
    a.box(torso, [.106, .039, .025], [x, 1.24, .25], carrier, undefined, false, .006);
  }
  for (const y of [1.324, 1.366]) a.box(torso, [.31, .011, .015], [0, y, .19], fabric, undefined, false, 0);
  a.box(torso, [.085, .04, .012], [.046, 1.414, .185], dark, undefined, false, .002);
  a.box(torso, [.399, .058, .31], [0, .996, .002], dark, undefined, false, .01);
  a.box(torso, [.082, .046, .019], [0, .992, .162], buckles, undefined, false, 0);
  a.box(torso, [.075, .15, .075], [.224, 1.285, -.005], carrier, undefined, false, .011);
  a.add(torso, new THREE.CylinderGeometry(.004, .005, .20, 6), dark, [.233, 1.463, -.005]);
  a.box(torso, [.092, .148, .096], [-.21, .981, .006], fabric, undefined, false, .015);

  // Exposed facial anatomy: a shaped jaw, eyelids, irises, brows, nose and lips.
  a.add(head, new THREE.CylinderGeometry(.059, .067, .119, 10), skin, [0, 1.585, .008], [0, 0, 0], [1, 1, 1], true);
  a.ellipsoid(head, [0, 1.76, -.002], [.126, .153, .119], skin, true, 16);
  a.ellipsoid(head, [0, 1.667, .018], [.094, .067, .088], skin, true, 10);
  a.ellipsoid(head, [0, 1.732, .115], [.016, .031, .016], skin, true, 12);
  a.ellipsoid(head, [0, 1.714, .129], [.020, .012, .016], skin, true, 12);
  const mouth = new THREE.Group(); mouth.name = 'Expression mouth'; mouth.position.set(0, .108, .128); head.add(mouth); rig.mouth = mouth;
  a.ellipsoid(mouth, [0, .002, -.004], [.036, .003, .005], lips, true, 10);
  a.ellipsoid(mouth, [0, -.003, -.005], [.034, .0035, .005], lips, true, 10);
  a.ellipsoid(mouth, [0, 0, .001], [.032, .0012, .0014], hair, true, 8);
  for (const side of [-1, 1]) {
    a.ellipsoid(head, [side * .119, 1.752, -.003], [.026, .043, .024], skin, true, 8);
    a.ellipsoid(head, [side * .145, 1.783, -.023], [.025, .057, .044], rubber, true, 8);
    a.box(head, [.018, .043, .04], [side * .161, 1.782, -.02], carrier, undefined, true, .007);
    const eye = new THREE.Group(); eye.name = side < 0 ? 'Left eye' : 'Right eye'; eye.position.set(side * .046, .182, .108); head.add(eye); rig.eyes.push(eye);
    a.ellipsoid(eye, [0, 0, 0], [.021, .007, .006], eyeWhite, true, 10);
    a.ellipsoid(eye, [0, 0, .006], [.0077, .0067, .0022], iris, true, 8);
    a.ellipsoid(eye, [0, 0, .008], [.0040, .0048, .0015], pupil, true, 8);
    a.ellipsoid(head, [side * .046, 1.773, .108], [.024, .0035, .006], skin, true, 8);
    const brow = new THREE.Group(); brow.name = 'Expressive brow'; brow.position.set(side * .052, .204, .109); head.add(brow); rig.brows.push(brow);
    a.ellipsoid(brow, [0, 0, 0], [.028, .0035, .006], hair, true, 8);
  }
  // Goggles are raised onto the helmet, so the operator's eyes remain visible.
  a.add(head, new THREE.SphereGeometry(.179, 14, 7, 0, TAU, 0, Math.PI * .61), carrier, [0, 1.855, -.006], [0, 0, 0], [1, .67, 1], true);
  a.add(head, new THREE.TorusGeometry(.166, .011, 4, 18), rubber, [0, 1.824, -.006], [Math.PI / 2, 0, 0], [1, 1, 1], true);
  a.box(head, [.201, .048, .038], [0, 1.886, .14], dark, [-.2, 0, 0], true, .013);
  for (const side of [-1, 1]) a.box(head, [.08, .031, .015], [side * .046, 1.887, .16], glass, [-.2, 0, 0], true, .009);
  a.bone(head, [-.145, 1.759, .016], [-.095, 1.699, .145], .004, dark, true);
  a.ellipsoid(head, [-.084, 1.699, .157], [.014, .007, .007], rubber, true, 8);

  for (const [label, sign] of [['left', -1], ['right', 1]]) {
    const hip = new THREE.Group(); hip.name = `${label} hip`; hip.position.set(sign * .139, .951, 0); group.add(hip); limbs[`${label}Leg`] = hip;
    const knee = new THREE.Group(); knee.name = `${label} knee`; knee.position.y = -.425; hip.add(knee);
    const ankle = new THREE.Group(); ankle.name = `${label} ankle`; ankle.position.y = -.415; knee.add(ankle);
    a.bone(hip, [0, -.041, 0], [0, -.397, 0], .095, uniform, false, .079);
    a.bone(knee, [0, -.024, 0], [0, -.376, -.004], .073, uniform, false, .056);
    a.ellipsoid(knee, [0, -.01, .083], [.077, .081, .025], carrier);
    a.box(knee, [.152, .03, .151], [0, -.043, 0], dark, undefined, false, .007);
    a.ellipsoid(ankle, [0, -.041, .02], [.09, .072, .138], rubber);
    a.box(ankle, [.19, .031, .263], [0, -.098, .051], dark, undefined, false, .012);
    a.ellipsoid(ankle, [0, -.061, .142], [.089, .042, .06], rubber);
    a.box(ankle, [.121, .067, .053], [0, -.019, .095], fabric, [.28, 0, 0], false, .011);
    for (const y of [-.005, -.028, -.051]) a.box(ankle, [.092, .004, .007], [0, y, .12], dark, undefined, false, 0);

    const upperArm = new THREE.Group(); upperArm.name = `${label} shoulder`; upperArm.position.set(sign * .275, 1.445, 0); group.add(upperArm); limbs[`${label}Arm`] = upperArm;
    const elbow = new THREE.Group(); elbow.name = `${label} elbow`; elbow.position.y = -.31; upperArm.add(elbow);
    const hand = new THREE.Group(); hand.name = `${label} wrist and fingers`; hand.position.y = -.29; elbow.add(hand);
    a.bone(upperArm, [0, -.025, 0], [0, -.282, 0], .081, uniform, false, .068);
    a.ellipsoid(upperArm, [0, -.024, -.015], [.091, .085, .071], carrier);
    a.bone(elbow, [0, -.018, 0], [0, -.268, 0], .065, uniform, false, .043);
    a.ellipsoid(elbow, [0, -.009, -.053], [.058, .052, .022], carrier);
    a.ellipsoid(hand, [0, -.006, 0], [.048, .047, .064], dark);
    for (let i = 0; i < 4; i++) a.ellipsoid(hand, [(i - 1.5) * .019, -.027, .021], [.009, .022, .019], rubber, false, 6);
    a.ellipsoid(hand, [sign * .044, -.009, .009], [.014, .024, .016], dark, false, 6);
    rig[label] = { sign, upperArm, elbow, hand, hip, knee, ankle, upperLength: .31, lowerLength: .29, thighLength: .425, shinLength: .415,
      shoulderAnchor: new THREE.Vector3(sign * .275, .49, 0), grip: new THREE.Vector3(label === 'left' ? -.04 : 0, label === 'left' ? -.062 : -.14, label === 'left' ? -.424 : .07) };
  }
  const rifle = new THREE.Group(); rifle.name = 'Operator held rifle'; rifle.position.set(-.025, .28, .125); rifle.rotation.y = Math.PI; rifle.scale.setScalar(.62); torso.add(rifle); rig.rifle = rifle;
  buildCarbine(rifle, a, false);
  a.flush();
  // Body/head parts were authored in familiar ground coordinates; joints own
  // local geometry from this point onward, so gaze and breathing need no skins.
  for (const child of torso.children) if (child.isMesh) child.geometry.translate(0, -.955, 0);
  for (const child of head.children) if (child.isMesh) child.geometry.translate(0, -1.58, 0);
  const soldier = { group, bodyMeshes, headMeshes, limbs, rig };
  animateSoldier(soldier, 0, { time: 0 });
  return soldier;
}

function deformWeaponFront(mesh, factor) {
  if (!mesh.isMesh || factor === 1) return;
  const positions = mesh.geometry.attributes.position, normals = mesh.geometry.attributes.normal;
  for (let i = 0; i < positions.count; i++) if (positions.getZ(i) < -.264) {
    positions.setZ(i, -.264 + (positions.getZ(i) + .264) * factor);
    if (normals) {
      const x = normals.getX(i), y = normals.getY(i), z = normals.getZ(i) / factor;
      const length = Math.hypot(x, y, z) || 1; normals.setXYZ(i, x / length, y / length, z / length);
    }
  }
  positions.needsUpdate = true; if (normals) normals.needsUpdate = true;
  mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
}

/** Three distinct firearm silhouettes, with shared ADS and animation contracts. */
export function createWeapon(kind = 'basic') {
  if (!['basic', 'tactical', 'heavy'].includes(kind)) kind = 'basic';
  const group = new THREE.Group();
  group.name = { basic: 'SR-32 compact carbine', tactical: 'AR-36 assault rifle', heavy: 'BR-46 precision rifle' }[kind];
  group.userData.kind = kind;
  const a = assembler(group);
  buildCarbine(group, a, true, kind);
  a.flush();
  const factor = { basic: .62, tactical: 1, heavy: 1.32 }[kind];
  group.children.filter(child => child.isMesh).forEach(mesh => deformWeaponFront(mesh, factor));
  group.userData.muzzle.z = -.264 + (group.userData.muzzle.z + .264) * factor;
  const sleeve = surface(0xffffff, .97, 0, { map: fabricTexture(false) });
  const glove = surface(0x555749, .96), padding = surface(0x303931, .84), seams = surface(0x8c876e, .95);
  const leftHand = new THREE.Group(), rightHand = new THREE.Group();
  leftHand.name = 'Support hand and forearm'; rightHand.name = 'Trigger hand and forearm'; group.add(leftHand, rightHand);
  group.userData.parts.leftHand = leftHand; group.userData.parts.rightHand = rightHand;
  a.bone(rightHand, [.154, -.279, .44], [.037, -.164, .112], .074, sleeve, false, .047);
  a.bone(leftHand, [-.338, -.246, .207], [-.091, -.091, -.368], .068, sleeve, false, .049);
  a.ellipsoid(rightHand, [.027, -.136, .091], [.057, .074, .065], glove, false, 12);
  a.ellipsoid(leftHand, [-.035, -.062, -.424], [.066, .047, .09], glove, false, 12);
  a.ellipsoid(rightHand, [.069, -.138, .098], [.021, .043, .03], padding);
  a.ellipsoid(leftHand, [-.053, -.09, -.412], [.062, .017, .052], padding);
  a.box(rightHand, [.103, .017, .032], [.035, -.179, .133], padding, [-.26, 0, .26], false, .009);
  a.box(leftHand, [.104, .016, .026], [-.093, -.096, -.348], padding, [0, -.36, -.19], false, .008);
  for (let i = 0; i < 3; i++) {
    const y = -.112 - i * .025;
    a.bone(rightHand, [.048, y, .065], [.027, y - .006, .032], .0117, glove);
    a.bone(rightHand, [.027, y - .006, .032], [-.006, y - .004, .047], .0117, glove);
    a.ellipsoid(rightHand, [.045, y + .002, .068], [.016, .01, .019], padding);
  }
  a.bone(rightHand, [.046, -.079, .069], [.049, -.082, -.009], .0114, glove);
  a.bone(rightHand, [.049, -.082, -.009], [.017, -.094, -.018], .011, glove);
  a.bone(rightHand, [-.027, -.104, .087], [-.025, -.099, .058], .016, glove);
  for (let i = 0; i < 4; i++) {
    const z = -.387 - i * .026;
    a.bone(leftHand, [-.073, -.042, z], [-.056, -.013, z], .0115, glove);
    a.bone(leftHand, [-.056, -.013, z], [-.03, -.009, z], .0108, glove);
    a.ellipsoid(leftHand, [-.067, -.033, z], [.014, .012, .013], padding);
  }
  a.bone(leftHand, [.006, -.067, -.363], [.033, -.039, -.392], .017, glove);
  a.bone(leftHand, [-.327, -.237, .191], [-.111, -.08, -.347], .0028, seams);
  a.flush();
  // Pivot at the wrists; the forearms stay attached when the support hand
  // reaches for a magazine, while the sight and receiver remain stationary.
  leftHand.position.set(-.035, -.062, -.264 + (-.424 + .264) * factor);
  rightHand.position.set(.027, -.136, .091);
  for (const mesh of leftHand.children) if (mesh.isMesh) {
    deformWeaponFront(mesh, factor); mesh.geometry.translate(-leftHand.position.x, -leftHand.position.y, -leftHand.position.z);
  }
  for (const mesh of rightHand.children) if (mesh.isMesh) mesh.geometry.translate(-rightHand.position.x, -rightHand.position.y, -rightHand.position.z);
  for (const part of Object.values(group.userData.parts)) {
    part.userData.restPosition = part.position.clone();
    part.userData.restRotation = part.rotation.clone();
    part.userData.restQuaternion = part.quaternion.clone();
  }
  return group;
}
