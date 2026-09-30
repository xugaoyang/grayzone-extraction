import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlocked, moveWithCollision, createNavigator } from '../src/navigation.js';

const box = (minX, maxX, minZ, maxZ) => ({ minX, maxX, minZ, maxZ });
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

test('collision includes actor radius and permits contact without penetration', () => {
  const solids = [box(1, 3, -1, 1)];
  assert.equal(isBlocked(2, 0, solids), true);
  assert.equal(isBlocked(0.7, 0, solids, 0.4), true);
  assert.equal(isBlocked(0.6, 0, solids, 0.4), false);
  assert.equal(isBlocked(2, 1.5, solids, 0.4), false);
  assert.equal(isBlocked(2, 1.3, solids, 0.4), true);
  assert.equal(isBlocked(0, 0, []), false);
});

test('large movement cannot tunnel through thin walls on either horizontal axis', () => {
  const xWall = [box(0, 0.05, -20, 20)];
  const position = { x: -5, y: 1.68, z: 0 };
  const returned = moveWithCollision(position, 15, 0, xWall);
  assert.equal(returned, position);
  assert.ok(position.x <= -0.4 + 1e-8);
  assert.ok(position.x > -0.65);
  assert.equal(position.y, 1.68);
  assert.equal(isBlocked(position.x, position.z, xWall), false);

  const zWall = [box(-20, 20, -0.05, 0)];
  const second = { x: 0, z: 5 };
  moveWithCollision(second, 0, -15, zWall);
  assert.ok(second.z >= 0.4 - 1e-8);
  assert.ok(second.z < 0.65);
  assert.equal(isBlocked(second.x, second.z, zWall), false);
});

test('diagonal movement slides along walls and stops in closed corners', () => {
  const wall = [box(0, 1, -10, 10)];
  const position = { x: -2, z: -2 };
  moveWithCollision(position, 5, 4, wall);
  assert.ok(position.x <= -0.4 + 1e-8);
  approx(position.z, 2);
  assert.equal(isBlocked(position.x, position.z, wall), false);

  const corner = [box(0, 1, -10, 10), box(-10, 10, 0, 1)];
  const trapped = { x: -2, z: -2 };
  moveWithCollision(trapped, 5, 5, corner);
  assert.ok(trapped.x <= -0.4 + 1e-8 && trapped.z <= -0.4 + 1e-8);
  assert.equal(isBlocked(trapped.x, trapped.z, corner), false);
});

test('unobstructed movement preserves distance and stationary positions', () => {
  const position = { x: 0, z: 0 };
  moveWithCollision(position, 3, -4, []);
  approx(position.x, 3);
  approx(position.z, -4);
  moveWithCollision(position, 0, 0, []);
  approx(position.x, 3);
  approx(position.z, -4);
});

test('navigation routes around obstacles using adjacent collision-free cells', () => {
  const solids = [box(-0.5, 0.5, -1.5, 1.5)];
  const navigator = createNavigator(solids, 1, 6);
  const start = { x: -4, z: 0 }, end = { x: 4, z: 0 };
  const path = navigator.path(start, end);
  assert.ok(path.length > 8, 'detour must be longer than direct route');
  assert.deepEqual(path.at(-1), end);
  assert.equal(navigator.reachable(start, end), true);
  let previous = start;
  for (const point of path) {
    assert.equal(isBlocked(point.x, point.z, solids, 0.55), false);
    approx(Math.abs(previous.x - point.x) + Math.abs(previous.z - point.z), 1);
    const simulated = { ...previous };
    moveWithCollision(simulated, point.x - previous.x, point.z - previous.z, solids, 0.42);
    approx(simulated.x, point.x);
    approx(simulated.z, point.z);
    previous = point;
  }
  assert.ok(path.some((point) => Math.abs(point.z) >= 3));
});

test('blocked endpoints resolve to available nearby cells', () => {
  const solids = [box(-0.5, 0.5, -0.5, 0.5)];
  const navigator = createNavigator(solids, 1, 6);
  const path = navigator.path({ x: -4, z: -4 }, { x: 0, z: 0 });
  assert.ok(path.length > 0);
  assert.equal(isBlocked(path.at(-1).x, path.at(-1).z, solids, 0.55), false);
  assert.ok(Math.hypot(path.at(-1).x, path.at(-1).z) <= 2);
  const open = { x: -4, z: -4 };
  assert.deepEqual(navigator.path(open, open), []);
  assert.equal(navigator.reachable(open, open), true);
});

test('a wall spanning the navigation map makes the other side unreachable', () => {
  const navigator = createNavigator([box(-0.5, 0.5, -10, 10)], 1, 6);
  const start = { x: -4, z: 0 }, end = { x: 4, z: 0 };
  assert.deepEqual(navigator.path(start, end), []);
  assert.equal(navigator.reachable(start, end), false);
  assert.equal(navigator.reachable(start, { x: -4, z: 4 }), true);
});

test('a fully blocked map has no reachable endpoint', () => {
  const navigator = createNavigator([box(-10, 10, -10, 10)], 1, 6);
  assert.deepEqual(navigator.path({ x: 0, z: 0 }, { x: 3, z: 3 }), []);
  assert.equal(navigator.reachable({ x: 0, z: 0 }, { x: 3, z: 3 }), false);
});

test('navigation checks edges so thin poles between grid cells cannot trap a patrol', () => {
  const solids = [box(-1.085, -0.915, -0.085, 0.085)];
  const navigator = createNavigator(solids, 2, 6);
  const start = { x: -4, z: 0 }, end = { x: 4, z: 0 };
  const path = navigator.path(start, end);
  assert.ok(path.length > 0);
  assert.deepEqual(path.at(-1), end);
  let previous = start;
  for (const waypoint of path) {
    const actual = { ...previous };
    moveWithCollision(actual, waypoint.x - previous.x, waypoint.z - previous.z, solids, 0.42);
    approx(actual.x, waypoint.x);
    approx(actual.z, waypoint.z);
    previous = waypoint;
  }
});
