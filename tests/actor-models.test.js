import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSoldier, createWeapon } from '../src/models.js';
import { animateSoldier } from '../src/actor-animation.js';

function resources(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) for (const material of [object.material].flat()) {
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
  });
  return { geometries, materials, textures };
}

function dispose(root) {
  const sets = resources(root);
  Object.values(sets).forEach(set => set.forEach(resource => resource.dispose()));
}

test('human facial geometry and joint hierarchy preserve live shot classification', () => {
  const actor = createSoldier();
  const allMeshes = [];
  actor.group.traverse(object => { if (object.isMesh) allMeshes.push(object); });
  assert.equal(allMeshes.length, new Set([...actor.bodyMeshes, ...actor.headMeshes]).size);
  for (const y of [1.76, 1.25]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(0, y, 3), new THREE.Vector3(0, 0, -1), 0, 5);
    const first = ray.intersectObjects([...actor.bodyMeshes, ...actor.headMeshes], false)[0]?.object;
    assert.ok((y > 1.5 ? actor.headMeshes : actor.bodyMeshes).includes(first));
  }
  assert.equal(actor.rig.head.parent, actor.rig.torso);
  for (const label of ['left', 'right']) {
    const side = actor.rig[label];
    assert.equal(actor.limbs[`${label}Arm`], side.upperArm);
    assert.equal(side.upperArm.parent, actor.group);
    assert.equal(side.hip.parent, actor.group);
    assert.equal(side.elbow.parent, side.upperArm);
    assert.equal(side.hand.parent, side.elbow);
    assert.equal(side.knee.parent, side.hip);
    assert.equal(side.ankle.parent, side.knee);
  }
  assert.equal(actor.rig.eyes.length, 2);
  assert.equal(actor.rig.brows.length, 2);
  dispose(actor.group);
});

test('idle guards breathe and look around while preserving AI-owned transforms', () => {
  const actor = createSoldier();
  actor.group.position.set(12, .1, -9);
  actor.group.rotation.set(0, .73, 0);
  const position = actor.group.position.clone(), rotation = actor.group.quaternion.clone();
  const heights = [], gazes = [], blinks = [];
  for (let i = 0; i < 300; i++) {
    animateSoldier(actor, 1 / 60, { time: i / 60, speed: 0 });
    heights.push(actor.rig.torso.position.y);
    gazes.push(actor.rig.head.rotation.y);
    blinks.push(actor.rig.eyes[0].scale.y);
  }
  assert.ok(Math.max(...heights) - Math.min(...heights) > .008);
  assert.ok(Math.max(...gazes) - Math.min(...gazes) > .1);
  assert.ok(Math.min(...blinks) < .5);
  assert.ok(actor.group.position.equals(position));
  assert.ok(actor.group.quaternion.equals(rotation));
  dispose(actor.group);
});

test('moving guards bend knees, lift feet and transition smoothly back to idle', () => {
  const actor = createSoldier();
  const kneeAngles = [], ankleHeights = [];
  for (let i = 0; i < 180; i++) {
    animateSoldier(actor, 1 / 60, { time: i / 60, speed: 2.5 });
    kneeAngles.push(actor.rig.left.knee.rotation.x);
    ankleHeights.push(actor.rig.left.ankle.getWorldPosition(new THREE.Vector3()).y);
  }
  assert.ok(Math.max(...kneeAngles) - Math.min(...kneeAngles) > .5);
  assert.ok(Math.max(...ankleHeights) - Math.min(...ankleHeights) > .07);
  assert.ok(Math.min(...ankleHeights) > .06, 'Feet must not tunnel through the ground during a stride');
  const moving = actor.rig.animation.locomotion;
  animateSoldier(actor, 1 / 60, { time: 3, speed: 0 });
  assert.ok(actor.rig.animation.locomotion > moving * .7, 'Stopping must blend out the gait');
  for (let i = 0; i < 90; i++) animateSoldier(actor, 1 / 60, { time: 3 + i / 60, speed: 0 });
  assert.ok(actor.rig.animation.locomotion < .001);
  dispose(actor.group);
});

test('gun grip IK keeps both hands attached while aiming, turning and reacting to hits', () => {
  const actor = createSoldier();
  actor.group.position.set(-13, 0, 11);
  actor.group.rotation.y = 1.43;
  for (let i = 0; i < 120; i++) {
    animateSoldier(actor, 1 / 60, { time: i / 60, speed: 1.9, alert: true, aimPitch: Math.sin(i * .04) * .42, turn: .7, hit: i > 45 && i < 60 ? .8 : 0 });
    for (const side of [actor.rig.left, actor.rig.right]) {
      const target = side.grip.clone().applyMatrix4(actor.rig.rifle.matrixWorld);
      const actual = side.hand.getWorldPosition(new THREE.Vector3());
      assert.ok(actual.distanceTo(target) < .006, `Detached grip: ${actual.distanceTo(target)}`);
    }
  }
  assert.ok(actor.rig.animation.alert > .95);
  dispose(actor.group);
});

test('a planted foot stays on the ground as patrol speed advances the actor', () => {
  const actor = createSoldier(), speed = 1.15, previous = new Map();
  for (let i = 0; i < 120; i++) animateSoldier(actor, 1 / 60, { time: i / 60, speed });
  let samples = 0;
  for (let i = 0; i < 180; i++) {
    actor.group.position.z += speed / 60;
    animateSoldier(actor, 1 / 60, { time: 2 + i / 60, speed });
    for (const side of [actor.rig.left, actor.rig.right]) {
      const phase = (actor.rig.animation.phase + (side.sign > 0 ? Math.PI : 0)) % (Math.PI * 2);
      const contact = phase > .2 && phase < Math.PI - .2;
      const ankle = side.ankle.getWorldPosition(new THREE.Vector3());
      const last = previous.get(side.sign);
      if (contact && last?.contact) {
        assert.ok(Math.abs(ankle.z - last.z) < .003, 'A contact foot should remain planted instead of skating forward');
        samples++;
      }
      previous.set(side.sign, { contact, z: ankle.z });
    }
  }
  assert.ok(samples > 80);
  dispose(actor.group);
});

for (const [label, moveX, moveZ] of [
  ['right sidestep', 1.65, 0], ['left sidestep', -1.15, 0],
  ['backward retreat', 0, -1.15], ['diagonal approach', .8, .8],
]) test(`${label} keeps contact feet planted and toes facing the body heading`, () => {
  const actor = createSoldier(), previous = new Map(), speed = Math.hypot(moveX, moveZ);
  actor.group.rotation.y = .73;
  const worldVelocity = new THREE.Vector3(moveX, 0, moveZ).applyQuaternion(actor.group.quaternion);
  const bodyForward = new THREE.Vector3(0, 0, 1).applyQuaternion(actor.group.quaternion);
  for (let i = 0; i < 150; i++) animateSoldier(actor, 1 / 60, { time: i / 60, speed, moveX, moveZ, alert: true });
  let contacts = 0;
  for (let i = 0; i < 180; i++) {
    actor.group.position.addScaledVector(worldVelocity, 1 / 60);
    animateSoldier(actor, 1 / 60, { time: 2.5 + i / 60, speed, moveX, moveZ, alert: true });
    for (const side of [actor.rig.left, actor.rig.right]) {
      const phase = (actor.rig.animation.phase + (side.sign > 0 ? Math.PI : 0)) % (Math.PI * 2);
      const contact = phase > .2 && phase < Math.PI - .2;
      const ankle = side.ankle.getWorldPosition(new THREE.Vector3());
      const toeDirection = new THREE.Vector3(0, 0, 1).applyQuaternion(side.ankle.getWorldQuaternion(new THREE.Quaternion()));
      toeDirection.y = 0; toeDirection.normalize();
      assert.ok(toeDirection.dot(bodyForward) > .999, 'Strafing must not rotate the feet sideways or backward');
      const last = previous.get(side.sign);
      if (contact && last?.contact) {
        assert.ok(Math.hypot(ankle.x - last.x, ankle.z - last.z) < .003,
          `Contact foot slid while ${label}`);
        contacts++;
      }
      previous.set(side.sign, { contact, x: ankle.x, z: ankle.z });
    }
  }
  assert.ok(contacts > 80);
  assert.ok(actor.rig.animation.gripError < .005);
  dispose(actor.group);
});

test('a guard aiming above or below its horizon points the muzzle in that direction', () => {
  for (const pitch of [-.3, .3]) {
    const actor = createSoldier();
    actor.group.rotation.y = 1.17;
    for (let i = 0; i < 120; i++) animateSoldier(actor, 1 / 60, { time: i / 60, alert: true, aimPitch: pitch });
    const muzzleDirection = new THREE.Vector3(0, 0, -1).transformDirection(actor.rig.rifle.matrixWorld);
    assert.ok(muzzleDirection.y * pitch > .06, 'The rifle and face must aim toward the requested target height');
    assert.ok(actor.rig.head.rotation.x * pitch < 0);
    dispose(actor.group);
  }
});

test('death uses progressive local collapse while the gameplay root owns the fall', () => {
  const actor = createSoldier(), progress = [], angles = [];
  const root = actor.group.quaternion.clone();
  for (let i = 0; i <= 48; i++) {
    animateSoldier(actor, 1 / 60, { time: i / 60, dead: i / 60 });
    progress.push(actor.rig.animation.death);
    angles.push(actor.rig.torso.rotation.x);
    assert.ok(actor.group.quaternion.equals(root));
  }
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, i) => !i || value >= progress[i - 1]));
  assert.ok(angles.every((value, i) => !i || Math.abs(value - angles[i - 1]) < .03));
  assert.ok(actor.rig.left.knee.rotation.x > .45);
  dispose(actor.group);
});

test('three weapon silhouettes keep the same optical axis and complete animation nodes', () => {
  const weapons = ['basic', 'tactical', 'heavy'].map(kind => createWeapon(kind));
  const lengths = weapons.map(weapon => new THREE.Box3().setFromObject(weapon).getSize(new THREE.Vector3()).z);
  assert.ok(lengths[0] < lengths[1] - .2 && lengths[1] < lengths[2] - .15);
  assert.ok(weapons[0].userData.muzzle.z > weapons[1].userData.muzzle.z);
  assert.ok(weapons[2].userData.muzzle.z < weapons[1].userData.muzzle.z);
  for (const weapon of weapons) {
    assert.deepEqual(weapon.userData.reticle.toArray(), [0, .192, -.154]);
    for (const name of ['magazine', 'bolt', 'casingEject', 'leftHand', 'rightHand']) {
      const part = weapon.userData.parts[name];
      assert.ok(part.isGroup && part.parent === weapon);
      assert.ok(part.userData.restPosition.equals(part.position));
      assert.ok(part.userData.restQuaternion.equals(part.quaternion));
    }
    const dot = weapon.children.find(mesh => mesh.isMesh && mesh.material.color.getHex() === 0xff6043);
    assert.ok(dot);
    dot.geometry.computeBoundingBox();
    const dotCenter = dot.geometry.boundingBox.getCenter(new THREE.Vector3());
    assert.ok(dotCenter.distanceTo(weapon.userData.reticle) < 1e-7);
  }
  weapons.forEach(dispose);
});

test('instances own disposable resources and retain finite geometry within rendering budgets', () => {
  const first = createSoldier().group, second = createSoldier().group;
  const firstSets = resources(first), secondSets = resources(second);
  for (const key of Object.keys(firstSets)) for (const resource of firstSets[key]) assert.ok(!secondSets[key].has(resource));
  const weapons = ['basic', 'tactical', 'heavy'].map(createWeapon);
  for (const root of [first, second, ...weapons]) {
    let meshCount = 0, triangles = 0;
    root.traverse(object => {
      if (!object.isMesh) return;
      meshCount++;
      triangles += object.geometry.index ? object.geometry.index.count / 3 : object.geometry.attributes.position.count / 3;
      for (const value of object.geometry.attributes.position.array) assert.ok(Number.isFinite(value));
    });
    assert.ok(meshCount < 65);
    assert.ok(triangles < 16000);
    dispose(root);
  }
});
