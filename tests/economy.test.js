import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVE_KEY, LOADOUTS, UPGRADES, LOOT_TABLE, createProfile,
  loadProfile, saveProfile, beginRaid, purchaseUpgrade, upgradeCost,
  getCapacity, rollLoot, settleRaid,
} from '../src/economy.js';

const memoryStorage = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};
const items = (count) => Array.from({ length: count }, () => ({ ...LOOT_TABLE[0] }));

function freezeDeep(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeDeep(child);
  return value;
}

test('fresh profiles are independent and the free kit prevents bankruptcy lockout', () => {
  const profile = createProfile();
  assert.equal(profile.credits, 2500);
  profile.credits = 0;
  profile.upgrades.pack = 2;
  const { profile: deployed, loadout } = beginRaid(freezeDeep(profile), 'basic');
  assert.equal(deployed.credits, 0);
  assert.equal(loadout.magazine, 24);
  assert.equal(loadout.reserve, 96);
  assert.equal(loadout.health, 100);
  assert.equal(loadout.capacity, 20);
  assert.equal(createProfile().upgrades.pack, 0);
  assert.equal(createProfile().credits, 2500);
});

test('paid equipment charges once on deployment and applies permanent upgrades', () => {
  const profile = createProfile();
  profile.upgrades = { armor: 2, pack: 1, weapon: 3 };
  freezeDeep(profile);
  const { profile: next, loadout } = beginRaid(profile, 'tactical');
  assert.equal(next.credits, 2000);
  assert.equal(profile.credits, 2500);
  assert.equal(loadout.damage, 45);
  assert.equal(loadout.armor, 100);
  assert.equal(loadout.capacity, 16);
  assert.equal(loadout.cost, 500);
  assert.equal(next.stats.raids, 0);
  assert.equal(LOADOUTS.find((kit) => kit.id === 'tactical').damage, 36);
});

test('unaffordable and invalid purchases leave the input intact', () => {
  const profile = freezeDeep({ ...createProfile(), credits: 499 });
  assert.throws(() => beginRaid(profile, 'tactical'), { code: 'INSUFFICIENT_CREDITS' });
  assert.throws(() => beginRaid(profile, 'missing'), { code: 'UNKNOWN_LOADOUT' });
  assert.throws(() => purchaseUpgrade(profile, 'armor'), { code: 'INSUFFICIENT_CREDITS' });
  assert.throws(() => purchaseUpgrade(profile, 'missing'), { code: 'UNKNOWN_UPGRADE' });
  assert.throws(() => upgradeCost(profile, 'missing'), { code: 'UNKNOWN_UPGRADE' });
  assert.equal(profile.credits, 499);
});

test('upgrade pricing scales and cannot exceed the advertised cap', () => {
  for (const upgrade of UPGRADES) {
    let profile = { ...createProfile(), credits: 50_000 };
    let paid = 0;
    for (let level = 0; level < upgrade.maxLevel; level++) {
      const price = upgradeCost(profile, upgrade.id);
      assert.equal(price, upgrade.baseCost * (level + 1));
      paid += price;
      profile = purchaseUpgrade(freezeDeep(profile), upgrade.id);
      assert.equal(profile.upgrades[upgrade.id], level + 1);
      assert.equal(profile.credits, 50_000 - paid);
    }
    assert.equal(upgradeCost(profile, upgrade.id), 0);
    assert.throws(() => purchaseUpgrade(profile, upgrade.id), { code: 'MAX_LEVEL' });
  }
  const upgraded = createProfile();
  upgraded.upgrades.pack = 3;
  assert.equal(getCapacity(upgraded), 24);
});

test('successful extraction sells loot, rewards kills and completes exactly one contract', () => {
  const profile = freezeDeep(createProfile());
  const { profile: next, summary } = settleRaid(profile, { success: true, loot: items(3), kills: 2, duration: 91.8 });
  assert.deepEqual(summary, {
    success: true, lootValue: 480, killReward: 200, contractReward: 800,
    totalReward: 1480, contractCompleted: true, kills: 2, duration: 91,
    lootCount: 3, lostValue: 0,
  });
  assert.equal(next.credits, 3980);
  assert.deepEqual(next.stats, { raids: 1, extracts: 1, kills: 2, earned: 1480 });
  assert.deepEqual(next.contract, { level: 2, target: 4, reward: 800, progress: 0 });
  assert.equal(profile.contract.level, 1);
});

test('failed raids lose carried items and pay no reward while retaining statistics', () => {
  const deployed = beginRaid(createProfile(), 'heavy').profile;
  const { profile, summary } = settleRaid(freezeDeep(deployed), { success: false, loot: items(6), kills: 7, duration: 62 });
  assert.equal(profile.credits, 1400);
  assert.equal(summary.totalReward, 0);
  assert.equal(summary.killReward, 0);
  assert.equal(summary.lootValue, 0);
  assert.equal(summary.lostValue, 960);
  assert.equal(summary.contractCompleted, false);
  assert.deepEqual(profile.stats, { raids: 1, extracts: 0, kills: 7, earned: 0 });
  assert.equal(profile.contract.level, 1);
});

test('contract targets progress between raids, cap at six, and reset on completion', () => {
  let profile = createProfile();
  const early = settleRaid(profile, { success: true, loot: items(2) });
  assert.equal(early.summary.contractCompleted, false);
  assert.equal(early.profile.contract.target, 3);
  profile = early.profile;
  for (let level = 1; level <= 9; level++) {
    const target = Math.min(6, level + 2);
    assert.equal(profile.contract.target, target);
    const result = settleRaid(profile, { success: true, loot: items(target) });
    assert.equal(result.summary.contractReward, 800);
    assert.equal(result.profile.contract.level, level + 1);
    profile = result.profile;
  }
  assert.equal(profile.stats.raids, 10);
  assert.equal(profile.stats.extracts, 10);
});

test('save round trip and unavailable storage remain safe', () => {
  const storage = memoryStorage();
  const profile = purchaseUpgrade(createProfile(), 'pack');
  assert.equal(saveProfile(profile, storage), true);
  assert.deepEqual(loadProfile(storage), profile);
  const failing = { getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(loadProfile(failing), createProfile());
  assert.equal(saveProfile(profile, failing), false);
  assert.equal(saveProfile(profile, null), false);
  assert.deepEqual(loadProfile(null), createProfile());
});

test('invalid JSON, unsupported versions, and corrupted saves recover bounded fields', () => {
  const storage = memoryStorage();
  for (const raw of ['{', 'null', '[]', '{"version":2,"credits":-10}']) {
    storage.setItem(SAVE_KEY, raw);
    assert.deepEqual(loadProfile(storage), createProfile());
  }
  storage.setItem(SAVE_KEY, JSON.stringify({
    version: 1, credits: -10,
    upgrades: { armor: 99, pack: -1, weapon: '3' },
    stats: { raids: 2.9, extracts: 10, kills: -5, earned: 'bad' },
    contract: { level: 9, target: -20, reward: 1e99, progress: 100 },
  }));
  const recovered = loadProfile(storage);
  assert.equal(recovered.credits, 0);
  assert.deepEqual(recovered.upgrades, { armor: 3, pack: 0, weapon: 0 });
  assert.deepEqual(recovered.stats, { raids: 2, extracts: 2, kills: 0, earned: 0 });
  assert.deepEqual(recovered.contract, { level: 9, target: 6, reward: 800, progress: 0 });
});

test('loot rolls produce independent valid objects and deterministic endpoint samples', () => {
  const low = rollLoot(1, () => 0);
  const high = rollLoot(3, () => 1);
  assert.equal(low.length, 2);
  assert.equal(high.length, 3);
  assert.equal(low[0].id, LOOT_TABLE[0].id);
  assert.equal(high[0].id, LOOT_TABLE.at(-1).id);
  low[0].value = 1;
  assert.equal(low[1].value, 160);
  assert.equal(LOOT_TABLE[0].value, 160);
  for (const tier of [0, 1, 2, 3, 999, NaN]) {
    for (const sample of [0, 0.2, 0.5, 0.8, 1, -100, Infinity, NaN]) {
      const loot = rollLoot(tier, () => sample);
      assert.ok(loot.length >= 2 && loot.length <= 3);
      assert.ok(loot.every((item) => item.value > 0 && item.weight > 0 && typeof item.name === 'string'));
    }
  }
  assert.throws(() => rollLoot(1, 0), { code: 'INVALID_RNG' });
});

test('invalid raid data cannot create NaN balances or false contract payouts', () => {
  const result = settleRaid(createProfile(), {
    success: 'true', kills: Infinity, duration: -20,
    loot: [null, {}, { value: NaN, weight: 1 }, { value: -100, weight: 1 }, { value: 999, weight: -1 }],
  });
  assert.equal(result.profile.credits, 2500);
  assert.equal(result.summary.totalReward, 0);
  assert.equal(result.summary.lootCount, 0);
  assert.equal(result.summary.kills, 0);
  assert.equal(result.summary.duration, 0);
  assert.equal(settleRaid(createProfile(), null).profile.stats.raids, 1);
});
