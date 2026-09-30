import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const executablePath = candidates.find(path => existsSync(path));
if (!executablePath) throw new Error('Install Chrome/Edge or set BROWSER_PATH.');
mkdirSync('work', { recursive: true });
const browser = await chromium.launch({
  executablePath, headless: true,
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [], checks = [], weapons = {}, reloads = {}, death = {};
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const check = (name, condition) => {
  assert.ok(condition, name); checks.push(name); console.log('PASS', name);
};
const snapshot = () => page.evaluate(() => window.__game.snapshot());
const waitState = state => page.waitForFunction(wanted => window.__game.snapshot().state === wanted, state, { timeout: 30000 });
async function ensureActive() {
  if ((await snapshot()).state === 'pause') await page.click('#resume');
  await waitState('hud');
  await page.waitForFunction(() => window.__game.snapshot().locked, null, { timeout: 10000 });
}

// Use simulated elapsed seconds. Rendering a 3D scene in software may run slower
// than wall time; gameplay caps dt and should still complete the same animation.
async function sampleFor(seconds) {
  return page.evaluate(duration => new Promise((resolve, reject) => {
    const start = window.__game.snapshot().elapsed, samples = [];
    const timeout = setTimeout(() => reject(new Error('Combat frames did not advance within 30 seconds.')), 30000);
    function sample() {
      const value = window.__game.snapshot(); samples.push(value);
      if (value.state !== 'hud') { clearTimeout(timeout); reject(new Error(`Combat unexpectedly left HUD: ${value.state}`)); return; }
      if (value.elapsed - start >= duration) { clearTimeout(timeout); resolve(samples); return; }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }), seconds);
}
async function holdTrigger(seconds) {
  const before = await snapshot();
  await page.mouse.down();
  const frames = await sampleFor(seconds);
  await page.mouse.up();
  const after = await snapshot();
  check(`${before.weapon.id} particles remain bounded during fire`, frames.every(frame => frame.weapon.particles <= 90));
  check(`${before.weapon.id} each fired bullet schedules its weapon sound`, after.audio.shotEvents - before.audio.shotEvents === before.player.ammo - after.player.ammo);
  return { before, after, frames, used: before.player.ammo - after.player.ammo };
}

async function deploy(id, magazine) {
  await page.locator(`[data-kit="${id}"]`).click();
  await page.click('#deploy'); await ensureActive();
  await page.evaluate(() => { window.__game.safe(); window.__game.look(0, .12); });
  const value = await snapshot();
  check(`${id} deploys its own model, ammunition and mode`, value.weapon.id === id && value.player.ammo === magazine && value.weapon.fireMode === (id === 'heavy' ? 'semi' : 'auto'));
  check(`${id} begins with a cleared effects pool`, value.weapon.particles === 0);
  weapons[id] = { magazine, muzzle: value.weapon.muzzle, initialMode: value.weapon.fireMode };
}
async function abortRaid(id) {
  await page.keyboard.press('Escape'); await waitState('pause');
  await page.click('#abort'); await waitState('result');
  check(`${id} can finish and return to the base`, (await snapshot()).reason.includes('主动结束'));
  await page.click('#return-lobby'); await waitState('lobby');
}
async function reload(id, expectedDuration) {
  const before = await snapshot(), missing = before.player.kit.magazine - before.player.ammo;
  await page.keyboard.press('KeyR');
  await page.waitForFunction(() => window.__game.snapshot().action === 'reload', null, { timeout: 10000 });
  const started = await snapshot();
  check(`${id} reload uses its own duration`, Math.abs(started.actionProgress.duration - expectedDuration) < .001);
  check(`${id} reload begins with a mechanical release sound`, started.audio.lastReloadStage === 'start');
  const samples = await sampleFor(expectedDuration * .5);
  let mid = samples.at(-1);
  check(`${id} does not refill ammunition before the reload animation ends`, mid.action === 'reload' && mid.player.ammo === before.player.ammo);
  check(`${id} magazine insertion has a separate sound`, samples.some(frame => frame.audio.lastReloadStage === 'magazine'));
  await page.waitForFunction(() => !window.__game.snapshot().action, null, { timeout: 30000 });
  const completed = await snapshot();
  check(`${id} complete reload transfers exactly the missing rounds`, completed.player.ammo === before.player.kit.magazine && completed.player.reserve === before.player.reserve - missing);
  check(`${id} reload finishes with a bolt sound`, completed.audio.lastReloadStage === 'bolt');
  reloads[id] = { duration: expectedDuration, refill: missing, simulationElapsed: completed.elapsed - started.elapsed + started.actionProgress.elapsed };
  check(`${id} reload timing matches the simulated action`, reloads[id].simulationElapsed >= expectedDuration - .12 && reloads[id].simulationElapsed < expectedDuration + .3);
}
async function aimScreenshot(id, expectedFov) {
  await page.evaluate(() => window.__game.look(0, 0));
  await page.mouse.down({ button: 'right' });
  await sampleFor(.7);
  const aimed = await snapshot();
  check(`${id} aims at the advertised magnification`, Math.abs(aimed.weapon.fov - expectedFov) < .2);
  weapons[id].adsFov = aimed.weapon.fov;
  await page.screenshot({ path: `work/combat-${id}.png` });
  await page.mouse.up({ button: 'right' });
  await sampleFor(.4);
}

try {
  const gameUrl = (process.env.GAME_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
  await page.goto(`${gameUrl}/?test=1`);
  await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
  check('combat test boots without JavaScript errors', errors.length === 0);
  await page.click('#settings-open'); await page.selectOption('#quality', 'low');
  await page.click('#settings-close');

  await deploy('basic', 24);
  const living = await sampleFor(.8);
  const first = living[0], last = living.at(-1);
  check('guards have articulated head, knees, elbows and torso', first.enemies.every(enemy => enemy.pose && Number.isFinite(enemy.pose.knee) && Number.isFinite(enemy.pose.elbow)));
  check('living guards breathe, shift their gaze or flex a joint over time', first.enemies.some((enemy, index) => {
    const later = last.enemies[index].pose;
    return Math.abs(enemy.pose.knee - later.knee) > .00001 || Math.abs(enemy.pose.elbow - later.elbow) > .00001 || enemy.pose.head.some((value, axis) => Math.abs(value - later.head[axis]) > .00001) || enemy.pose.torso.some((value, axis) => Math.abs(value - later.torso[axis]) > .00001);
  }));
  check('guard turning respects the smooth angular speed limit', living.slice(1).every((frame, index) => frame.enemies.every((enemy, enemyIndex) => {
    const previous = living[index], delta = Math.atan2(Math.sin(enemy.yaw - previous.enemies[enemyIndex].yaw), Math.cos(enemy.yaw - previous.enemies[enemyIndex].yaw));
    return Math.abs(delta) <= 3.4 * (frame.elapsed - previous.elapsed) + .005;
  })));
  const basicFire = await holdTrigger(.8);
  check('compact automatic weapon fires repeatedly while held', basicFire.used >= 5 && basicFire.used <= Math.ceil((basicFire.after.elapsed - basicFire.before.elapsed) / .083) + 1);
  check('compact weapon uses its own shot report', basicFire.after.audio.lastShotKind === 'basic');
  check('gunfire produces visible transient particles', basicFire.frames.some(frame => frame.weapon.particles > 0));
  weapons.basic.heldShots = basicFire.used;
  await reload('basic', 1.55); await aimScreenshot('basic', 63); await abortRaid('basic');

  await deploy('tactical', 30);
  await page.keyboard.press('KeyB');
  check('B selects single-shot mode on the assault rifle', (await snapshot()).weapon.fireMode === 'semi');
  const semiFire = await holdTrigger(1);
  check('assault single-shot mode consumes only one round while held', semiFire.used === 1);
  await page.mouse.click(720, 450); await sampleFor(.22);
  check('releasing and pressing again fires exactly one additional round', (await snapshot()).player.ammo === semiFire.after.player.ammo - 1);
  await page.keyboard.press('KeyB');
  check('B returns the assault rifle to automatic mode', (await snapshot()).weapon.fireMode === 'auto');
  const assaultFire = await holdTrigger(.6);
  check('assault automatic mode fires repeatedly while held', assaultFire.used >= 4 && assaultFire.used <= Math.ceil((assaultFire.after.elapsed - assaultFire.before.elapsed) / .12) + 1);
  check('assault weapon uses its own shot report', assaultFire.after.audio.lastShotKind === 'tactical');
  weapons.tactical.heldShots = assaultFire.used;
  await reload('tactical', 1.9); await aimScreenshot('tactical', 55); await abortRaid('tactical');

  await deploy('heavy', 18);
  await page.keyboard.press('KeyB');
  check('precision rifle stays in its fixed semi-automatic mode', (await snapshot()).weapon.fireMode === 'semi');
  const precisionFire = await holdTrigger(1);
  check('precision rifle consumes one round during a one-second hold', precisionFire.used === 1);
  check('precision rifle uses its own shot report', precisionFire.after.audio.lastShotKind === 'heavy');
  weapons.heavy.heldShots = precisionFire.used;
  await reload('heavy', 2.35); await aimScreenshot('heavy', 43);
  check('three weapon barrels have distinct muzzle positions', new Set(Object.values(weapons).map(weapon => JSON.stringify(weapon.muzzle))).size === 3);

  // Shoot a real nearby guard with actual raycast damage; the development seam
  // only chooses a collision-free firing position and suppresses return fire.
  await page.mouse.down({ button: 'right' }); await sampleFor(.4);
  let fallen = null;
  for (let attempt = 0; attempt < 8 && !fallen; attempt++) {
    await page.evaluate(() => {
      const game = window.__game, enemy = game.enemyTarget(0);
      const spots = [{ x: enemy.x, z: enemy.z + 3 }, { x: enemy.x, z: enemy.z - 3 }, { x: enemy.x + 3, z: enemy.z }, { x: enemy.x - 3, z: enemy.z }];
      const spot = spots.find(point => !game.blocked(point.x, point.z));
      if (!spot) throw new Error('No nearby collision-free guard firing position.');
      game.teleport(spot.x, spot.z); game.safe();
      game.look(Math.atan2(-(enemy.x - spot.x), -(enemy.z - spot.z)), Math.atan2(enemy.y - 1.68, Math.hypot(enemy.x - spot.x, enemy.z - spot.z)));
    });
    await page.mouse.click(720, 450);
    const current = await snapshot();
    if (!current.enemies[0].alive) fallen = current.enemies[0];
    else await sampleFor(.36);
  }
  await page.mouse.up({ button: 'right' });
  check('actual precision shots defeat a guard', !!fallen && (await snapshot()).player.kills >= 1);
  death.first = fallen;
  check('guard begins a timed collapse rather than instantly turning sideways', fallen.deathTime < .85 && Math.abs(fallen.roll) < 1.3);
  await sampleFor(1.05);
  death.settled = (await snapshot()).enemies[0];
  check('collapse progresses to a fallen pose with increasing roll', death.settled.deathTime >= .85 && Math.abs(death.settled.roll) > Math.abs(fallen.roll) + .05 && Math.abs(death.settled.roll) > 1.3);
  check('fallen pose bends the character joints', Math.abs(death.settled.pose.knee - fallen.pose.knee) > .04);
  await page.screenshot({ path: 'work/combat-guard-fallen.png' });
  await page.evaluate(() => window.__game.safe());
  await sampleFor(3);
  check('shells, smoke and impact particles expire instead of leaking', (await snapshot()).weapon.particles === 0);
  await abortRaid('heavy');
  check('no browser runtime errors across all weapon and character checks', errors.length === 0);
  writeFileSync('work/combat-browser-results.json', JSON.stringify({ passed: checks.length, checks, errors, weapons, reloads, death }, null, 2));
} catch (error) {
  await page.mouse.up().catch(() => {}); await page.mouse.up({ button: 'right' }).catch(() => {});
  await page.screenshot({ path: 'work/combat-browser-failure.png' }).catch(() => {});
  writeFileSync('work/combat-browser-results.json', JSON.stringify({ passed: checks.length, checks, errors, weapons, reloads, death, failure: error.message, state: await snapshot().catch(() => null) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
