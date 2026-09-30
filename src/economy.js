/** Persistent progression and raid rewards. All operations return new values. */
export const SAVE_KEY = 'grayzone-extraction.profile.v1';

export const LOADOUTS = Object.freeze([
  Object.freeze({ id: 'basic', weaponId: 'basic', name: '轻装侦察', cost: 0, damage: 32, magazine: 24, reserve: 96, armor: 20, medkits: 2, description: 'C9 冲锋枪：高射速、低后坐，适合近距离突入。免费补给，随时重新出发。' }),
  Object.freeze({ id: 'tactical', weaponId: 'tactical', name: '战术突击', cost: 500, damage: 36, magazine: 30, reserve: 150, armor: 60, medkits: 3, description: 'AR4 突击步枪：中距均衡，可切换单发 / 自动；配备更多弹药与护甲。' }),
  Object.freeze({ id: 'heavy', weaponId: 'heavy', name: '重装先锋', cost: 1100, damage: 46, magazine: 18, reserve: 120, armor: 100, medkits: 4, description: 'DMR7 精确步枪：半自动点射、18 发弹匣，高倍率瞄准与远距威力，配重型护甲。' }),
]);

export const UPGRADES = Object.freeze([
  Object.freeze({ id: 'armor', name: '防护强化', description: '每级提升 20 点初始护甲，所有装备生效。', maxLevel: 3, baseCost: 700 }),
  Object.freeze({ id: 'pack', name: '背包扩容', description: '每级增加 4 点携带容量，带走更多战利品。', maxLevel: 3, baseCost: 800 }),
  Object.freeze({ id: 'weapon', name: '武器调校', description: '每级增加 3 点子弹伤害，所有武器生效。', maxLevel: 3, baseCost: 1000 }),
]);

export const LOOT_TABLE = Object.freeze([
  Object.freeze({ id: 'parts', name: '机械零件', value: 160, weight: 1, rarity: 'common', color: '#c4cec1' }),
  Object.freeze({ id: 'battery', name: '工业电池', value: 240, weight: 2, rarity: 'common', color: '#c4cec1' }),
  Object.freeze({ id: 'medicine', name: '医疗物资', value: 320, weight: 1, rarity: 'uncommon', color: '#78be8b' }),
  Object.freeze({ id: 'radio', name: '军用电台', value: 420, weight: 2, rarity: 'uncommon', color: '#78be8b' }),
  Object.freeze({ id: 'chip', name: '加密芯片', value: 650, weight: 1, rarity: 'rare', color: '#79b9e2' }),
  Object.freeze({ id: 'intel', name: '情报终端', value: 900, weight: 3, rarity: 'rare', color: '#79b9e2' }),
  Object.freeze({ id: 'core', name: '实验核心', value: 1450, weight: 3, rarity: 'epic', color: '#c399ef' }),
  Object.freeze({ id: 'gold', name: '精炼金锭', value: 1800, weight: 4, rarity: 'epic', color: '#ebbc64' }),
]);

const LIMIT = 1_000_000_000;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const whole = (value, fallback = 0, max = LIMIT) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;
const contractFor = (level = 1) => ({ level, target: Math.min(6, level + 2), reward: 800, progress: 0 });

export function createProfile() {
  return {
    version: 1,
    credits: 2500,
    upgrades: { armor: 0, pack: 0, weapon: 0 },
    stats: { raids: 0, extracts: 0, kills: 0, earned: 0 },
    contract: contractFor(),
  };
}

/** Recover only known, bounded fields; future save versions start clean. */
function normalizeProfile(input) {
  const profile = createProfile();
  if (!record(input) || input.version !== 1) return profile;
  profile.credits = whole(input.credits, 2500);
  if (record(input.upgrades)) {
    for (const upgrade of UPGRADES) profile.upgrades[upgrade.id] = whole(input.upgrades[upgrade.id], 0, upgrade.maxLevel);
  }
  if (record(input.stats)) {
    for (const key of Object.keys(profile.stats)) profile.stats[key] = whole(input.stats[key]);
    profile.stats.extracts = Math.min(profile.stats.extracts, profile.stats.raids);
  }
  if (record(input.contract)) profile.contract = contractFor(Math.max(1, whole(input.contract.level, 1, 100_000)));
  return profile;
}

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function loadProfile(storage = defaultStorage()) {
  try {
    const saved = storage?.getItem(SAVE_KEY);
    return saved ? normalizeProfile(JSON.parse(saved)) : createProfile();
  } catch {
    return createProfile();
  }
}

export function saveProfile(profile, storage = defaultStorage()) {
  try {
    if (typeof storage?.setItem !== 'function') return false;
    storage.setItem(SAVE_KEY, JSON.stringify(normalizeProfile(profile)));
    return true;
  } catch {
    return false;
  }
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function getCapacity(profile) {
  return 12 + normalizeProfile(profile).upgrades.pack * 4;
}

export function upgradeCost(profile, id) {
  const upgrade = UPGRADES.find((item) => item.id === id);
  if (!upgrade) return fail('UNKNOWN_UPGRADE', '未知的升级项目。');
  const level = normalizeProfile(profile).upgrades[id];
  return level >= upgrade.maxLevel ? 0 : upgrade.baseCost * (level + 1);
}

export function purchaseUpgrade(profile, id) {
  const next = normalizeProfile(profile);
  const upgrade = UPGRADES.find((item) => item.id === id);
  if (!upgrade) return fail('UNKNOWN_UPGRADE', '未知的升级项目。');
  if (next.upgrades[id] >= upgrade.maxLevel) return fail('MAX_LEVEL', '该项目已达到最高等级。');
  const cost = upgradeCost(next, id);
  if (next.credits < cost) return fail('INSUFFICIENT_CREDITS', '资金不足，成功撤离可获得更多资金。');
  next.credits -= cost;
  next.upgrades[id] += 1;
  return next;
}

export function beginRaid(profile, loadoutId = 'basic') {
  const next = normalizeProfile(profile);
  const kit = LOADOUTS.find((item) => item.id === loadoutId);
  if (!kit) return fail('UNKNOWN_LOADOUT', '未知的出战装备。');
  if (next.credits < kit.cost) return fail('INSUFFICIENT_CREDITS', '资金不足，请选择免费的轻装侦察装备。');
  next.credits -= kit.cost;
  return {
    profile: next,
    loadout: {
      ...kit,
      health: 100,
      damage: kit.damage + next.upgrades.weapon * 3,
      armor: kit.armor + next.upgrades.armor * 20,
      capacity: getCapacity(next),
    },
  };
}

/** Higher-tier crates improve rarity; rng injection makes simulations reproducible. */
export function rollLoot(tier = 1, rng = Math.random) {
  if (typeof rng !== 'function') return fail('INVALID_RNG', '随机数生成器无效。');
  const level = Math.max(1, whole(tier, 1, 3));
  const random = () => {
    const value = rng();
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(0.999999999, value)) : 0;
  };
  const count = random() < 0.55 ? 2 : 3;
  const weights = level === 3 ? [1, 1, 2, 2, 4, 4, 3, 2] : level === 2 ? [3, 3, 4, 4, 3, 2, 1, 1] : [6, 5, 4, 3, 2, 1, 0.4, 0.2];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return Array.from({ length: count }, () => {
    let cursor = random() * total;
    let index = 0;
    while (index < weights.length - 1 && cursor >= weights[index]) cursor -= weights[index++];
    return { ...LOOT_TABLE[index] };
  });
}

/** Call once per raid. The caller owns its raid state and duplicate-settlement guard. */
export function settleRaid(profile, result = {}) {
  const next = normalizeProfile(profile);
  const safeResult = record(result) ? result : {};
  const success = safeResult.success === true;
  const kills = whole(safeResult.kills, 0, 1000);
  const duration = whole(safeResult.duration, 0, 86_400);
  const loot = (Array.isArray(safeResult.loot) ? safeResult.loot : []).filter((item) => record(item) && typeof item.value === 'number' && Number.isFinite(item.value) && item.value > 0 && typeof item.weight === 'number' && Number.isFinite(item.weight) && item.weight > 0).slice(0, 100);
  const carriedValue = loot.reduce((sum, item) => sum + whole(item.value, 0, 100_000), 0);
  const lootValue = success ? carriedValue : 0;
  const killReward = success ? kills * 100 : 0;
  const contractCompleted = success && loot.length >= next.contract.target;
  const contractReward = contractCompleted ? next.contract.reward : 0;
  const totalReward = lootValue + killReward + contractReward;
  next.credits = Math.min(LIMIT, next.credits + totalReward);
  next.stats.raids = Math.min(LIMIT, next.stats.raids + 1);
  next.stats.extracts = Math.min(LIMIT, next.stats.extracts + (success ? 1 : 0));
  next.stats.kills = Math.min(LIMIT, next.stats.kills + kills);
  next.stats.earned = Math.min(LIMIT, next.stats.earned + totalReward);
  if (contractCompleted) next.contract = contractFor(Math.min(100_000, next.contract.level + 1));
  return {
    profile: next,
    summary: { success, lootValue, killReward, contractReward, totalReward, contractCompleted, kills, duration, lootCount: loot.length, lostValue: success ? 0 : carriedValue },
  };
}
