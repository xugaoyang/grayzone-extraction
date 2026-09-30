import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const down = new THREE.Vector3(0, -1, 0);
const shoulder = new THREE.Vector3(), target = new THREE.Vector3(), direction = new THREE.Vector3();
const bend = new THREE.Vector3(), elbowPosition = new THREE.Vector3(), upperDirection = new THREE.Vector3(), lowerDirection = new THREE.Vector3();
const lowerOrientation = new THREE.Quaternion(), rifleOrientation = new THREE.Quaternion(), inverseUpper = new THREE.Quaternion();
const rifleMatrix = new THREE.Matrix4(), scale = new THREE.Vector3(), translation = new THREE.Vector3();
const legTarget = new THREE.Vector3(), footOrientation = new THREE.Quaternion(), jointReaction = new THREE.Quaternion();
const footEuler = new THREE.Euler(), jointEuler = new THREE.Euler();

function poseArm(side, torso, rifle, collapse) {
  shoulder.copy(side.shoulderAnchor).applyMatrix4(torso.matrix);
  side.upperArm.position.copy(shoulder);
  target.copy(side.grip).applyMatrix4(rifleMatrix);
  direction.copy(target).sub(shoulder);
  const actualDistance = direction.length();
  const distance = clamp(actualDistance, .075, side.upperLength + side.lowerLength - .0005);
  direction.normalize();
  // A human elbow has a preferred bend plane, rather than a swinging stick.
  bend.set(side.sign * .77, -.8, -.26 - collapse * .1);
  bend.addScaledVector(direction, -bend.dot(direction)).normalize();
  const along = (side.upperLength ** 2 - side.lowerLength ** 2 + distance ** 2) / (2 * distance);
  const away = Math.sqrt(Math.max(0, side.upperLength ** 2 - along ** 2));
  elbowPosition.copy(shoulder).addScaledVector(direction, along).addScaledVector(bend, away);
  upperDirection.copy(elbowPosition).sub(shoulder).normalize();
  side.upperArm.quaternion.setFromUnitVectors(down, upperDirection);
  const reachableTarget = shoulder.clone().addScaledVector(direction, distance);
  lowerDirection.copy(reachableTarget).sub(elbowPosition).normalize();
  lowerOrientation.setFromUnitVectors(down, lowerDirection);
  inverseUpper.copy(side.upperArm.quaternion).invert();
  side.elbow.quaternion.copy(inverseUpper).multiply(lowerOrientation);
  side.hand.quaternion.copy(lowerOrientation).invert().multiply(rifleOrientation);
  return Math.max(0, actualDistance - distance);
}

function poseLeg(side, ankleTarget, footPitch, reaction, collapse) {
  shoulder.copy(side.hip.position);
  direction.copy(ankleTarget).sub(shoulder);
  const distance = clamp(direction.length(), .08, side.thighLength + side.shinLength - .00005);
  direction.normalize();
  // Knees keep a forward-facing bend plane even when the hip abducts sideways.
  bend.set(side.sign * .025, 0, 1);
  bend.addScaledVector(direction, -bend.dot(direction)).normalize();
  const along = (side.thighLength ** 2 - side.shinLength ** 2 + distance ** 2) / (2 * distance);
  const away = Math.sqrt(Math.max(0, side.thighLength ** 2 - along ** 2));
  elbowPosition.copy(shoulder).addScaledVector(direction, along).addScaledVector(bend, away);
  upperDirection.copy(elbowPosition).sub(shoulder).normalize();
  side.hip.quaternion.setFromUnitVectors(down, upperDirection);
  target.copy(shoulder).addScaledVector(direction, distance);
  lowerDirection.copy(target).sub(elbowPosition).normalize();
  lowerOrientation.setFromUnitVectors(down, lowerDirection);
  inverseUpper.copy(side.hip.quaternion).invert();
  side.knee.quaternion.copy(inverseUpper).multiply(lowerOrientation);
  footOrientation.setFromEuler(footEuler.set(footPitch, 0, side.sign * collapse * .1));
  side.ankle.quaternion.copy(lowerOrientation).invert().multiply(footOrientation);
  if (reaction || collapse) {
    jointReaction.setFromEuler(jointEuler.set(reaction * side.sign * .045 - collapse * (side.sign < 0 ? .31 : .15), 0, side.sign * (collapse * .12 + reaction * .03)));
    side.hip.quaternion.multiply(jointReaction);
    jointReaction.setFromEuler(jointEuler.set(collapse * (side.sign < 0 ? .46 : .31), 0, 0));
    side.knee.quaternion.multiply(jointReaction);
  }
}

/**
 * Character-local animation. AI owns group position/yaw and the external death
 * roll; this function owns breathing, gaze, joints, foot placement and grip IK.
 * moveX/moveZ are actual character-local velocity (right/forward, m/s). If
 * omitted, speed moves forward. dead is null while alive or death elapsed time.
 */
export function animateSoldier(soldier, dt, options = {}) {
  const rig = soldier.rig;
  if (!rig) return null;
  const { time = 0, speed = 0, moveX, moveZ, alert = false, aimPitch = 0, turn = 0, hit = 0, dead = null } = options;
  const frame = clamp(Number.isFinite(dt) ? dt : 0, 0, .1);
  const state = rig.animation;
  const dying = dead !== null && dead !== false && Number.isFinite(dead);
  const fall = dying ? THREE.MathUtils.smoothstep(Math.max(0, dead), 0, .8) : 0;
  const vectorSupplied = Number.isFinite(moveX) || Number.isFinite(moveZ);
  const localX = vectorSupplied && Number.isFinite(moveX) ? moveX : 0;
  const localZ = vectorSupplied ? Number.isFinite(moveZ) ? moveZ : 0 : Number.isFinite(speed) ? Math.abs(speed) : 0;
  const measuredSpeed = Math.hypot(localX, localZ);
  const actualSpeed = Math.min(4, measuredSpeed);
  if (measuredSpeed > .015 && !dying) {
    const desiredTravel = Math.atan2(localX, localZ);
    const lastTravel = state.travelYaw ?? desiredTravel;
    const travelDelta = Math.atan2(Math.sin(desiredTravel - lastTravel), Math.cos(desiredTravel - lastTravel));
    state.travelYaw = lastTravel + travelDelta * (1 - Math.exp(-frame * 12));
  }
  const directionX = Math.sin(state.travelYaw || 0), directionZ = Math.cos(state.travelYaw || 0);
  const lateral = Math.abs(directionX);
  const moveTarget = dying ? 0 : clamp(actualSpeed / .28, 0, 1);
  const forwardStride = clamp(.16 + actualSpeed * .11, .16, .43);
  const sideStride = clamp(.20 + actualSpeed * .035, .20, .28);
  const baseStride = THREE.MathUtils.lerp(forwardStride, sideStride, lateral);
  state.locomotion = THREE.MathUtils.damp(state.locomotion, moveTarget, 10, frame);
  state.alert = THREE.MathUtils.damp(state.alert, dying ? 0 : Number(Boolean(alert)), 7, frame);
  state.cadence = THREE.MathUtils.damp(state.cadence || 0, dying ? 0 : actualSpeed * Math.PI / (2 * baseStride), 10, frame);
  state.phase += frame * state.cadence;
  const phase = state.phase, walk = state.locomotion, ready = state.alert;
  const reaction = dying ? 0 : clamp(hit, 0, 1);
  const breath = Math.sin(time * (ready ? 3.35 : 2.7) + state.offset) * .006 * (1 - fall);
  const weight = Math.sin(phase) * .012 * walk;
  const bounce = -.012 * Math.abs(Math.sin(phase * 2)) * walk;
  // Lower the center of mass enough for the stance leg to reach its planted
  // foot at the widest part of the stride, instead of stretching/sliding it.
  const spread = lateral * (Math.max(0, baseStride - .139) + .015) * walk;
  const widestReach = Math.hypot(baseStride * Math.abs(directionX) + spread, baseStride * directionZ) + .01;
  const reachableHip = Math.min(.951, Math.sqrt(Math.max(.1, .84 ** 2 - widestReach ** 2)) + .107);
  const hipHeight = .951 + (reachableHip - .951) * walk + bounce - reaction * .027 - fall * .09;

  rig.torso.position.set(weight - reaction * .026, hipHeight + breath, reaction * -.038);
  rig.torso.rotation.set(walk * .035 * directionZ - ready * .017 + reaction * .11 + fall * .16,
    clamp(turn, -1, 1) * -.055 + Math.sin(phase) * walk * .036,
    -weight * 1.15 - directionX * walk * .035 - reaction * .075 + fall * .075);
  rig.torso.scale.y = 1 + breath * .38;
  rig.head.rotation.set(-clamp(aimPitch, -.65, .65) * ready * .38 + reaction * .07 + fall * .23,
    (1 - ready) * Math.sin(time * .47 + state.offset) * .25 + clamp(turn, -1, 1) * .15,
    Math.sin(time * .31 + state.offset) * .014 * (1 - ready) - reaction * .12);
  const blinkCycle = (time + state.offset) % 4.1;
  const blink = blinkCycle > 3.89 ? .18 + .82 * Math.abs((blinkCycle - 3.995) / .105) : 1;
  rig.eyes.forEach(eye => { eye.scale.y = dying ? 1 - fall * .85 : clamp(blink, .08, 1); });
  rig.brows.forEach((brow, i) => { brow.rotation.z = (i ? -1 : 1) * (ready * .09 + reaction * .13); });
  rig.mouth.scale.y = 1 + reaction * .8;

  // Hands use the actual moving gun transform, keeping both grips attached.
  rig.rifle.position.set(-.025, .28 + ready * .091 + breath * .25 - fall * .045, .125);
  rig.rifle.rotation.set(-.055 * (1 - ready) - clamp(aimPitch, -.7, .7) * ready + reaction * .055 - fall * .22,
    Math.PI, Math.sin(phase) * walk * .023 + reaction * .04);
  rig.torso.updateMatrix(); rig.rifle.updateMatrix();
  rifleMatrix.multiplyMatrices(rig.torso.matrix, rig.rifle.matrix);
  rifleMatrix.decompose(translation, rifleOrientation, scale);
  state.gripError = Math.max(poseArm(rig.left, rig.torso, rig.rifle, fall), poseArm(rig.right, rig.torso, rig.rifle, fall));

  for (const side of [rig.left, rig.right]) {
    const cycle = (phase + (side.sign > 0 ? Math.PI : 0)) % (Math.PI * 2);
    const stance = cycle < Math.PI;
    const progress = stance ? cycle / Math.PI : (cycle - Math.PI) / Math.PI;
    const stride = baseStride * walk;
    // During contact the foot moves backward at exactly the measured actor
    // speed. During recovery it lifts and eases forward for the next heel strike.
    const footAlong = stance ? stride * (1 - 2 * progress) : stride * (-1 + 2 * THREE.MathUtils.smoothstep(progress, 0, 1));
    const lift = stance ? 0 : Math.sin(progress * Math.PI) * .112 * walk;
    const footPitch = (stance ? (-.055 + progress * .145) * (directionZ < -.1 ? -1 : 1) : -.12 * Math.sin(progress * Math.PI)) * walk;
    const ankleY = .115 + lift + Math.abs(Math.sin(footPitch)) * .11;
    side.hip.position.set(side.sign * .139 + weight * .6, hipHeight, 0);
    legTarget.set(side.sign * (.139 + spread) + directionX * footAlong, ankleY, directionZ * footAlong);
    poseLeg(side, legTarget, footPitch + fall * .2, reaction, fall);
  }
  state.speed = measuredSpeed;
  state.moveX = localX;
  state.moveZ = localZ;
  state.headYaw = rig.head.rotation.y;
  state.breathing = breath;
  state.death = fall;
  state.leftKnee = rig.left.knee.rotation.x;
  state.rightKnee = rig.right.knee.rotation.x;
  soldier.group.updateMatrixWorld(true);
  return state;
}
