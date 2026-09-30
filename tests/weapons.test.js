import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEAPONS, getWeapon, damageAtDistance, needsTriggerRelease,
  nextFireMode, advanceTrigger, canFireWeapon,
} from '../src/weapons.js';
import { beginRaid, createProfile, LOADOUTS } from '../src/economy.js';

test('equipment selects three immutable weapon roles while retaining economy values', () => {
  for (const kit of LOADOUTS) {
    assert.equal(getWeapon(kit.weaponId).id, kit.id);
    assert.equal(beginRaid(createProfile(), kit.id).loadout.weaponId, kit.weaponId);
    assert.ok(Object.isFrozen(getWeapon(kit.weaponId)));
    assert.ok(Object.isFrozen(getWeapon(kit.weaponId).fireModes));
  }
  assert.equal(getWeapon('unknown'), WEAPONS.basic);
  assert.equal(getWeapon('__proto__'), WEAPONS.basic);
  assert.deepEqual(LOADOUTS.map(kit => kit.magazine), [24, 30, 18]);
  assert.ok(WEAPONS.basic.interval < WEAPONS.tactical.interval);
  assert.ok(WEAPONS.tactical.interval < WEAPONS.heavy.interval);
  assert.ok(WEAPONS.heavy.adsFov < WEAPONS.tactical.adsFov);
  assert.ok(WEAPONS.basic.recoil < WEAPONS.tactical.recoil);
});

test('range damage preserves upgrade scaling, declines smoothly and stays bounded', () => {
  for (const config of Object.values(WEAPONS)) {
    const midpoint = (config.falloffStart + config.falloffEnd) / 2;
    for (const damage of [32, 36, 46, 55]) {
      assert.equal(damageAtDistance(config, damage, 0), damage);
      assert.equal(damageAtDistance(config, damage, config.falloffStart), damage);
      assert.ok(Math.abs(damageAtDistance(config, damage, midpoint) - damage * (1 + config.minDamageMultiplier) / 2) < 1e-10);
      assert.ok(Math.abs(damageAtDistance(config, damage, config.falloffEnd) - damage * config.minDamageMultiplier) < 1e-10);
      assert.equal(damageAtDistance(config, damage, 99999), damageAtDistance(config, damage, config.falloffEnd));
      assert.equal(damageAtDistance(config, damage, Infinity), damageAtDistance(config, damage, config.falloffEnd));
    }
    let previous = Infinity;
    for (let distance = 0; distance < 260; distance++) {
      const value = damageAtDistance(config, 32, distance);
      assert.ok(value <= previous && value >= 32 * config.minDamageMultiplier - 1e-10);
      previous = value;
    }
    assert.equal(damageAtDistance(config, -1, 1000), 0);
    assert.equal(damageAtDistance(config, NaN, 1000), 0);
    assert.equal(damageAtDistance(config, 32, NaN), 32);
  }
  assert.equal(damageAtDistance({}, 32, 200), 32);
});

test('semi-auto consumes a press edge and cannot repeat while the trigger is held', () => {
  const config = WEAPONS.heavy;
  let trigger = advanceTrigger(null, true);
  assert.equal(canFireWeapon(config, { ammo: 18, cooldown: 0, triggerHeld: trigger.held, triggerPressed: trigger.pressed }), true);
  trigger = advanceTrigger(trigger, true);
  assert.equal(canFireWeapon(config, { ammo: 17, cooldown: 0, triggerHeld: trigger.held, triggerPressed: trigger.pressed }), false);
  trigger = advanceTrigger(trigger, false);
  trigger = advanceTrigger(trigger, true);
  assert.equal(canFireWeapon(config, { ammo: 17, cooldown: 0, triggerHeld: trigger.held, triggerPressed: trigger.pressed }), true);
  assert.equal(needsTriggerRelease(config), true);
});

test('automatic repeats after cooldown, but never without ammo, during actions or before cycle completes', () => {
  const input = { ammo: 1, cooldown: 0, triggerHeld: true, triggerPressed: false };
  assert.equal(canFireWeapon(WEAPONS.basic, input), true);
  for (const changes of [{ cooldown: .001 }, { ammo: 0 }, { ammo: -1 }, { ammo: NaN }, { blocked: true }, { triggerHeld: false }, { cooldown: NaN }]) {
    assert.equal(canFireWeapon(WEAPONS.basic, { ...input, ...changes }), false);
  }
  assert.equal(needsTriggerRelease(WEAPONS.basic), false);
  assert.equal(canFireWeapon(WEAPONS.tactical, { ...input, fireMode: 'semi' }), false);
  assert.equal(canFireWeapon(WEAPONS.tactical, { ...input, fireMode: 'semi', triggerPressed: true }), true);
});

test('only the assault rifle toggles between automatic and single-shot modes', () => {
  assert.equal(nextFireMode(WEAPONS.tactical, 'auto'), 'semi');
  assert.equal(nextFireMode(WEAPONS.tactical, 'semi'), 'auto');
  assert.equal(nextFireMode(WEAPONS.basic, 'auto'), 'auto');
  assert.equal(nextFireMode(WEAPONS.heavy, 'semi'), 'semi');
  assert.equal(needsTriggerRelease(WEAPONS.tactical, 'missing'), false);
});
