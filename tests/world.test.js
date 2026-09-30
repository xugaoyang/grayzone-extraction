import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWorld, createSoldier, createWeapon } from '../src/world.js';
import { createNavigator, isBlocked, moveWithCollision } from '../src/navigation.js';

let scene, world, navigation;

before(() => {
  // World labels need a CanvasTexture, but layout/collision/raycast tests do not
  // require a renderer or any browser drawing behavior.
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ fillRect() {}, strokeRect() {}, fillText() {} }),
    }),
  };
  try {
    scene = new THREE.Scene();
    world = createWorld(scene);
    navigation = createNavigator(world.solids);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

function dispose(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) {
      for (const material of [object.material].flat()) {
        materials.add(material);
        if (material.map) textures.add(material.map);
      }
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => texture.dispose());
}

after(() => dispose(scene));

function clearLine(from, to, height) {
  const origin = new THREE.Vector3(from.x, height, from.z);
  const target = new THREE.Vector3(to.x, height, to.z);
  const length = origin.distanceTo(target);
  const ray = new THREE.Raycaster(origin, target.sub(origin).normalize(), 0.02, length - 0.1);
  return ray.intersectObjects(world.blockers, false).length === 0;
}

test('deployment, guards, loot and evacuation all occupy playable ground', () => {
  assert.ok(world.lootSpawns.length >= 12);
  assert.ok(world.enemySpawns.length >= 8);
  assert.ok(world.lootSpawns.some(point => point.tier === 3));
  const positions = [world.spawn, world.extract, ...world.lootSpawns, ...world.enemySpawns];
  for (const point of positions) {
    assert.ok(Math.abs(point.x) <= 48 && Math.abs(point.z) <= 48);
    assert.equal(isBlocked(point.x, point.z, world.solids, 0.42), false, `Blocked spawn at ${point.x}, ${point.z}`);
  }
  for (const enemy of world.enemySpawns) {
    assert.ok(Math.hypot(enemy.x - world.spawn.x, enemy.z - world.spawn.z) > 24, 'Deployment must begin outside normal guard awareness');
  }
});

test('every mission point is reachable with the same navigator used by patrols', () => {
  const starts = [world.spawn, ...world.enemySpawns];
  const destinations = [world.extract, ...world.lootSpawns];
  for (const start of starts) for (const destination of destinations) {
    assert.equal(navigation.reachable(start, destination), true,
      `No route from ${start.x},${start.z} to ${destination.x},${destination.z}`);
    const path = navigation.path(start, destination);
    const endpoint = path.at(-1) ?? start;
    assert.ok(Math.hypot(endpoint.x - destination.x, endpoint.z - destination.z) < 3.1,
      'Route endpoint must reach interaction range');
  }
});

test('actual port routes remain traversable between waypoints, including thin poles and barriers', () => {
  const starts = [world.spawn, ...world.enemySpawns];
  const destinations = [world.extract, ...world.lootSpawns];
  for (const start of starts) for (const destination of destinations) {
    let previous = start;
    for (const waypoint of navigation.path(start, destination)) {
      const simulated = { ...previous };
      moveWithCollision(simulated, waypoint.x - previous.x, waypoint.z - previous.z, world.solids, 0.42);
      assert.ok(Math.hypot(simulated.x - waypoint.x, simulated.z - waypoint.z) < 1e-6,
        `Route crosses cover between (${previous.x},${previous.z}) and (${waypoint.x},${waypoint.z})`);
      previous = waypoint;
    }
  }
});

test('patrol movement reaches objectives while accepting waypoints within the live 0.65m tolerance', () => {
  for (const start of world.enemySpawns) for (const destination of [world.extract, ...world.lootSpawns]) {
    const actor = { ...start }, path = navigation.path(start, destination);
    let ticks = 0;
    while (path.length && ticks++ < 6000) {
      const waypoint = path[0], dx = waypoint.x - actor.x, dz = waypoint.z - actor.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 0.65) { path.shift(); continue; }
      // main.js uses an alerted speed of 2.5m/s and caps frame dt at 0.05s.
      moveWithCollision(actor, dx / distance * 0.125, dz / distance * 0.125, world.solids, 0.42);
    }
    assert.equal(path.length, 0,
      `Guard stalled from ${start.x},${start.z} toward ${destination.x},${destination.z}`);
    assert.ok(Math.hypot(actor.x - destination.x, actor.z - destination.z) < 3.1);
  }
});

test('visible cover blocks shooting while lanes and the introductory cache stay usable', () => {
  assert.equal(clearLine({ x: -17, z: -15 }, { x: -47, z: -15 }, 1.3), false, 'Warehouse must block fire');
  assert.equal(clearLine(world.spawn, world.lootSpawns[0], 0.8), true, 'Introductory cache must have an unobstructed approach');
  assert.equal(clearLine(world.spawn, { x: 0, z: 30 }, 1.3), true, 'Deployment lane should be open');
  assert.equal(clearLine({ x: -6, z: 30 }, { x: -6, z: 24 }, 0.85), false, 'Crouching behind a barrier must conceal the player');
  assert.equal(clearLine({ x: -6, z: 30 }, { x: -6, z: 24 }, 1.3), true, 'Standing actors should see over waist-height cover');
  for (const blocker of world.blockers) {
    assert.ok(blocker.isMesh && blocker.parent && blocker.geometry.attributes.position.count > 0,
      'Static batching must preserve live raycast collision meshes');
  }
});

test('all map boundaries prevent leaving the playable area', () => {
  for (const [start, dx, dz] of [
    [{ x: 47, z: 0 }, 20, 0], [{ x: -47, z: 0 }, -20, 0],
    [{ x: 0, z: 47 }, 0, 20], [{ x: 0, z: -47 }, 0, -20],
  ]) {
    moveWithCollision(start, dx, dz, world.solids, 0.38);
    assert.ok(Math.abs(start.x) < 49.1 && Math.abs(start.z) < 49.1);
    assert.equal(isBlocked(start.x, start.z, world.solids, 0.38), false);
  }
});

test('guard headshots and limb animation survive the shared model interface', () => {
  const soldier = createSoldier();
  soldier.group.updateMatrixWorld(true);
  const headRay = new THREE.Raycaster(new THREE.Vector3(0, 1.76, 3), new THREE.Vector3(0, 0, -1), 0, 5);
  const headHits = headRay.intersectObjects([...soldier.bodyMeshes, ...soldier.headMeshes], false);
  assert.ok(headHits.length > 0);
  assert.ok(soldier.headMeshes.includes(headHits[0].object), 'First head-height hit must be marked as a headshot');
  const bodyRay = new THREE.Raycaster(new THREE.Vector3(0, 1.25, 3), new THREE.Vector3(0, 0, -1), 0, 5);
  assert.ok(soldier.bodyMeshes.includes(bodyRay.intersectObjects(soldier.bodyMeshes, false)[0]?.object));
  for (const name of ['leftLeg', 'rightLeg', 'leftArm', 'rightArm']) {
    assert.ok(soldier.limbs[name].isGroup);
    assert.equal(soldier.limbs[name].parent, soldier.group);
  }
  const weapon = createWeapon();
  assert.ok(weapon.isGroup && weapon.userData.muzzle.z < 0);
  world.animate(100);
  dispose(soldier.group);
  dispose(weapon);
});
