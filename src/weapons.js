/** Weapon handling is independent of equipment price and permanent upgrades. */
function weapon(config) {
  return Object.freeze({ ...config, fireModes: Object.freeze(config.fireModes) });
}

export const WEAPONS = Object.freeze({
  basic: weapon({
    id: 'basic', name: 'C9 紧凑冲锋枪', kind: 'smg',
    fireModes: ['auto'], interval: .083, reloadTime: 1.55, adsFov: 63,
    hipSpread: .016, moveSpread: .029, adsSpread: .0045,
    recoil: .024, kick: .046, noiseRadius: 34,
    flashColor: 0xffcb79, flashSize: .13, tracerColor: 0xffdf8c,
    tracerWidth: .012, ejectionSpeed: 2.5, range: 135,
    falloffStart: 22, falloffEnd: 85, minDamageMultiplier: .52,
  }),
  tactical: weapon({
    id: 'tactical', name: 'AR4 突击步枪', kind: 'assault',
    fireModes: ['auto', 'semi'], interval: .12, reloadTime: 1.9, adsFov: 55,
    hipSpread: .013, moveSpread: .025, adsSpread: .0027,
    recoil: .038, kick: .064, noiseRadius: 52,
    flashColor: 0xffac45, flashSize: .2, tracerColor: 0xffbc5d,
    tracerWidth: .016, ejectionSpeed: 3.4, range: 175,
    falloffStart: 45, falloffEnd: 130, minDamageMultiplier: .75,
  }),
  heavy: weapon({
    id: 'heavy', name: 'DMR7 精确步枪', kind: 'marksman',
    fireModes: ['semi'], interval: .32, reloadTime: 2.35, adsFov: 43,
    hipSpread: .023, moveSpread: .041, adsSpread: .0011,
    recoil: .07, kick: .104, noiseRadius: 70,
    flashColor: 0xff8754, flashSize: .28, tracerColor: 0xff9769,
    tracerWidth: .019, ejectionSpeed: 4.5, range: 220,
    falloffStart: 80, falloffEnd: 180, minDamageMultiplier: .94,
  }),
});

export function getWeapon(id) {
  return Object.hasOwn(WEAPONS, id) ? WEAPONS[id] : WEAPONS.basic;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Apply the range multiplier to the upgraded damage, with no negative/NaN damage. */
export function damageAtDistance(config, baseDamage, distance) {
  const damage = Number.isFinite(baseDamage) ? Math.max(0, baseDamage) : 0;
  const start = Number.isFinite(config?.falloffStart) ? Math.max(0, config.falloffStart) : 0;
  const end = Number.isFinite(config?.falloffEnd) ? Math.max(start, config.falloffEnd) : start;
  const minimum = Number.isFinite(config?.minDamageMultiplier) ? clamp(config.minDamageMultiplier, 0, 1) : 1;
  const range = distance === Infinity ? Infinity : Number.isFinite(distance) ? Math.max(0, distance) : 0;
  if (range <= start) return damage;
  const fraction = end > start ? clamp((range - start) / (end - start), 0, 1) : 1;
  return damage * (1 - (1 - minimum) * fraction);
}

export function normalizeFireMode(config, mode) {
  const modes = config?.fireModes?.length ? config.fireModes : WEAPONS.basic.fireModes;
  return modes.includes(mode) ? mode : modes[0];
}

export function needsTriggerRelease(config, mode) {
  return normalizeFireMode(config, mode) === 'semi';
}

export function nextFireMode(config, current) {
  const modes = config?.fireModes?.length ? config.fireModes : WEAPONS.basic.fireModes;
  return modes[(modes.indexOf(normalizeFireMode(config, current)) + 1) % modes.length];
}

/** Update this once per input event/frame, even while reload/cooldown prevents a shot. */
export function advanceTrigger(previous, held) {
  const triggerHeld = held === true;
  return { held: triggerHeld, pressed: triggerHeld && previous?.held !== true };
}

/** Semi-auto only accepts the press edge; automatic fire accepts a held trigger. */
export function canFireWeapon(config, input = {}) {
  if (input.blocked || !Number.isFinite(input.ammo) || input.ammo < 1 ||
      !Number.isFinite(input.cooldown) || input.cooldown > 0) return false;
  return needsTriggerRelease(config, input.fireMode) ? input.triggerPressed === true : input.triggerHeld === true;
}
