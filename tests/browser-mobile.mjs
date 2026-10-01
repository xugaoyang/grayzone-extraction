import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// This suite sends browser-native touch input, including simultaneous fingers.
// The development seam only prepares safe positions and reads gameplay state.
const executablePath = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find(path => existsSync(path));
if (!executablePath) throw new Error('Install Chrome/Edge or set BROWSER_PATH.');
mkdirSync('work', { recursive: true });
const browser = await chromium.launch({
  executablePath, headless: true,
  args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 1,
  hasTouch: true, isMobile: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const checks = [], errors = [], layouts = {}, weapons = {};
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const check = (name, condition) => {
  assert.ok(condition, name); checks.push(name); console.log('PASS', name);
};
const snapshot = () => page.evaluate(() => window.__game.snapshot());
const waitState = state => page.waitForFunction(wanted => window.__game.snapshot().state === wanted, state, { timeout: 45000 });
const actionSelector = action => `[data-touch-action="${action}"]`;
async function point(selector, x = .5, y = .5) {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`Missing touch bounds: ${selector}`);
  return { x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y, bounds };
}
async function tap(selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  const position = await point(selector);
  await page.touchscreen.tap(position.x, position.y);
}
const fingers = new Map();
async function dispatch(type) {
  await cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchCancel' ? [] : [...fingers.values()],
  });
}
async function down(id, position) {
  fingers.set(id, { id, x: position.x, y: position.y, radiusX: 5, radiusY: 5, force: 1 });
  await dispatch('touchStart');
}
async function move(id, position) {
  assert.ok(fingers.has(id), `Finger ${id} must be down before moving.`);
  fingers.set(id, { ...fingers.get(id), x: position.x, y: position.y });
  await dispatch('touchMove');
}
async function up(id) {
  const ended = fingers.get(id); fingers.delete(id);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: ended ? [ended] : [] });
}
async function releaseAll() {
  const ended = [...fingers.values()]; fingers.clear();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: ended });
}
async function cancelTouches() { fingers.clear(); await dispatch('touchCancel'); }
async function fingerTap(id, selector) { await down(id, await point(selector)); await up(id); }

// Software WebGL may run slower than real time. Wait on the game's capped
// elapsed dt, so a 6-second interaction is tested as 6 gameplay seconds.
async function sampleFor(seconds) {
  return page.evaluate(duration => new Promise((resolve, reject) => {
    const start = window.__game.snapshot().elapsed, samples = [];
    const timeout = setTimeout(() => reject(new Error('Mobile frames did not advance within 60 seconds.')), 60000);
    function sample() {
      const value = window.__game.snapshot(); samples.push(value);
      if (value.state !== 'hud') { clearTimeout(timeout); reject(new Error(`Mobile gameplay unexpectedly left HUD: ${value.state}`)); return; }
      if (value.elapsed - start >= duration) { clearTimeout(timeout); resolve(samples); return; }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }), seconds);
}
const noHeldInput = input => input && !input.firing && !input.aiming && Math.abs(input.movement.x) < .001 && Math.abs(input.movement.y) < .001;
async function deploy(id = 'basic') {
  await tap(`[data-kit="${id}"]`); await tap('#deploy'); await waitState('hud');
  await page.evaluate(() => { window.__game.safe(); window.__game.look(0, 0); });
  const value = await snapshot();
  check(`${id} touch deployment enters gameplay without pointer lock`, value.input.touch && !value.locked && await page.isVisible('#touch-controls'));
  check(`${id} only assault rifles expose the mode button`, await page.isVisible('#touch-mode-button') === (id === 'tactical'));
  weapons[id] = { magazine: value.player.ammo, mode: value.weapon.fireMode };
  return value;
}
async function abortRaid() {
  await tap(actionSelector('pause')); await waitState('pause');
  await tap('#abort'); await waitState('result'); await tap('#return-lobby'); await waitState('lobby');
}
async function holdAction(action, duration, id = 8) {
  await down(id, await point(actionSelector(action)));
  const samples = await sampleFor(duration); await up(id);
  return samples;
}
async function checkLayout(name, raid = false) {
  const layout = await page.evaluate(inRaid => {
    const root = document.documentElement, center = { x: innerWidth / 2, y: innerHeight / 2 };
    const actions = inRaid ? [...document.querySelectorAll('[data-touch-action]')].filter(element => !element.hidden && element.getBoundingClientRect().width > 0).map(element => {
      const bounds = element.getBoundingClientRect();
      return { action: element.dataset.touchAction, width: bounds.width, height: bounds.height,
        onScreen: bounds.left >= -.5 && bounds.top >= -.5 && bounds.right <= innerWidth + .5 && bounds.bottom <= innerHeight + .5,
        coversAim: bounds.left < center.x + 22 && bounds.right > center.x - 22 && bounds.top < center.y + 22 && bounds.bottom > center.y - 22 };
    }) : [];
    return { width: innerWidth, height: innerHeight, scrollWidth: root.scrollWidth, actions };
  }, raid);
  layouts[name] = layout;
  check(`${name} fits viewport width without sideways scrolling`, layout.scrollWidth <= layout.width + 1);
  if (raid) {
    check(`${name} touch buttons remain reachable on screen`, layout.actions.length >= 10 && layout.actions.every(action => action.onScreen));
    check(`${name} touch targets are usable and keep the crosshair clear`, layout.actions.every(action => action.width >= 38 && action.height >= 38 && !action.coversAim));
  } else {
    await page.locator('#deploy').scrollIntoViewIfNeeded();
    const position = await point('#deploy');
    check(`${name} deployment button is reachable`, position.x > 0 && position.x < layout.width && position.y > 0 && position.y < layout.height);
  }
  await page.screenshot({ path: `work/mobile-${name}.png` });
}

try {
  const gameUrl = (process.env.GAME_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
  await page.goto(`${gameUrl}/?test=1`);
  await page.waitForFunction(() => !!window.__game, null, { timeout: 45000 });
  check('mobile page boots without JavaScript errors', errors.length === 0);
  await checkLayout('portrait-lobby');
  await tap('#help-open'); await waitState('help'); await tap('#help-close'); await waitState('lobby');
  check('portrait help opens and closes using touch', !await page.isVisible('#help'));
  await tap('#settings-open'); await waitState('settings');
  await page.selectOption('#quality', 'low'); await tap('#settings-close'); await waitState('lobby');

  const initial = await deploy(); await checkLayout('portrait-raid', true);
  const joystick = await point('#touch-joystick'), look = await point('#touch-look', .5, .35);
  const forward = { x: joystick.x, y: joystick.y - Math.min(42, joystick.bounds.height * .3) };
  await down(1, joystick); await move(1, forward); await sampleFor(.45);
  let value = await snapshot();
  check('left joystick produces analog input and actual world movement', Math.hypot(value.input.movement.x, value.input.movement.y) > .2 && Math.hypot(value.player.x - initial.player.x, value.player.z - initial.player.z) > .3);
  const beforeLook = value.input;
  await down(2, look); await move(2, { x: look.x + 36, y: look.y + 22 }); await sampleFor(.15);
  value = await snapshot();
  check('second finger turns yaw and pitch while movement continues', Math.abs(value.input.yaw - beforeLook.yaw) > .01 && Math.abs(value.input.pitch - beforeLook.pitch) > .01 && Math.hypot(value.input.movement.x, value.input.movement.y) > .2);
  const beforeFire = value;
  await down(3, await point(actionSelector('fire'))); const fireFrames = await sampleFor(.5);
  value = await snapshot();
  check('three simultaneous fingers can move, look and fire', value.input.firing && Math.hypot(value.input.movement.x, value.input.movement.y) > .2 && value.player.ammo <= beforeFire.player.ammo - 3);
  check('touch automatic fire schedules sound once per consumed round', value.audio.shotEvents - beforeFire.audio.shotEvents === beforeFire.player.ammo - value.player.ammo);
  check('touch fire keeps effects bounded', fireFrames.every(frame => frame.weapon.particles <= 90));
  weapons.basic.heldShots = beforeFire.player.ammo - value.player.ammo;
  await up(3); value = await snapshot();
  check('releasing fire leaves the independent joystick active', !value.input.firing && Math.hypot(value.input.movement.x, value.input.movement.y) > .2);
  await up(2); await up(1); await sampleFor(.15);
  check('lifting all fingers stops movement and shooting', noHeldInput((await snapshot()).input));

  await tap(actionSelector('aim')); await sampleFor(.55); value = await snapshot();
  check('touch aim toggles on with the expected magnification', value.input.aiming && Math.abs(value.weapon.fov - 63) < .4);
  await tap(actionSelector('aim')); await sampleFor(.15);
  check('touch aim toggles off', !(await snapshot()).input.aiming);
  await tap(actionSelector('reload')); await page.waitForFunction(() => window.__game.snapshot().action === 'reload');
  await page.waitForFunction(() => !window.__game.snapshot().action, null, { timeout: 45000 });
  check('touch reload refills the actual magazine', (await snapshot()).player.ammo === 24);
  await tap(actionSelector('sprint')); check('touch sprint toggles on', (await snapshot()).input.sprinting);
  await tap(actionSelector('sprint')); check('touch sprint toggles off', !(await snapshot()).input.sprinting);
  await tap(actionSelector('crouch')); check('touch crouch toggles on', (await snapshot()).input.crouching);
  await tap(actionSelector('crouch')); check('touch crouch toggles off', !(await snapshot()).input.crouching);
  await page.evaluate(() => window.__game.damage(55)); const hurt = await snapshot();
  await tap(actionSelector('heal')); await page.waitForFunction(() => window.__game.snapshot().action === 'heal');
  await page.waitForFunction(() => !window.__game.snapshot().action, null, { timeout: 45000 }); value = await snapshot();
  check('touch medical action restores health and consumes one kit', value.player.health > hurt.player.health && value.player.medkits === hurt.player.medkits - 1);

  await down(1, joystick); await move(1, forward); await down(3, await point(actionSelector('fire'))); await sampleFor(.15);
  await cancelTouches(); await sampleFor(.15);
  check('native touchcancel clears movement and held fire', noHeldInput((await snapshot()).input));
  await down(1, joystick); await move(1, forward); await down(3, await point(actionSelector('fire'))); await sampleFor(.15);
  await fingerTap(4, actionSelector('map')); await waitState('map-overlay');
  value = await snapshot(); const pausedElapsed = value.elapsed;
  check('opening map with held fingers clears touch input', noHeldInput(value.input));
  await page.waitForTimeout(250); check('map pauses simulation', (await snapshot()).elapsed === pausedElapsed);
  await releaseAll(); await tap('#map-close'); await waitState('hud'); await sampleFor(.15);
  check('closing map restores play without a sticky trigger', noHeldInput((await snapshot()).input));
  await tap(actionSelector('inventory')); await waitState('inventory'); await tap('#inventory-close'); await waitState('hud');
  check('touch inventory opens and closes', !await page.isVisible('#inventory'));
  await tap(actionSelector('pause')); await waitState('pause'); await tap('#pause-settings'); await waitState('settings');
  await tap('#settings-close'); await waitState('pause'); await tap('#resume'); await waitState('hud');
  check('touch pause settings returns through pause to active gameplay', (await snapshot()).state === 'hud' && !(await snapshot()).locked);

  await down(1, joystick); await move(1, forward); await down(3, await point(actionSelector('fire')));
  await page.setViewportSize({ width: 844, height: 390 }); await releaseAll();
  if ((await snapshot()).state === 'pause') { await tap('#resume'); await waitState('hud'); }
  await sampleFor(.2);
  check('changing orientation resets held movement and fire', noHeldInput((await snapshot()).input));
  await checkLayout('landscape-raid', true);

  for (let index = 0; index < 2; index++) {
    await page.evaluate(i => { const game = window.__game, crate = game.snapshot().crates[i]; game.teleport(crate.x, crate.z + 1.8); game.look(0, 0); game.safe(); }, index);
    await sampleFor(.15); await holdAction('interact', 2.3);
    check(`touch hold searches real crate ${index + 1}`, (await snapshot()).crates[index].empty);
  }
  value = await snapshot(); check('touch searches collect enough loot for the contract', value.player.loot.length >= 3);
  await tap(actionSelector('inventory')); await waitState('inventory'); await page.screenshot({ path: 'work/mobile-landscape-inventory.png' });
  await tap('#inventory-close'); await waitState('hud');
  const expectedLoot = value.player.loot.reduce((sum, item) => sum + item.value, 0), creditsBefore = value.profile.credits, kills = value.player.kills;
  await page.evaluate(() => { const game = window.__game, extract = game.snapshot().extract; game.teleport(extract.x, extract.z); game.look(0, 0); game.safe(); });
  await sampleFor(.15); await down(8, await point(actionSelector('interact'))); await sampleFor(.7);
  check('holding touch interaction starts the extraction countdown', (await snapshot()).action === 'extract');
  await up(8); await sampleFor(.15); check('releasing touch interaction cancels extraction', !(await snapshot()).action);
  await down(8, await point(actionSelector('interact'))); await waitState('result'); await releaseAll(); value = await snapshot();
  check('six-second touch extraction settles correct rewards', value.profile.stats.extracts === 1 && value.profile.credits === creditsBefore + expectedLoot + kills * 100 + 800);
  check('result hides combat touch controls and clears input', !await page.isVisible('#touch-controls') && noHeldInput(value.input));
  await page.screenshot({ path: 'work/mobile-extraction.png' });
  await tap('#return-lobby'); await waitState('lobby'); await checkLayout('landscape-lobby');

  await deploy('tactical'); await tap(actionSelector('mode'));
  check('touch mode button selects assault semi-automatic fire', (await snapshot()).weapon.fireMode === 'semi');
  let before = await snapshot(); await holdAction('fire', 1); value = await snapshot();
  check('assault semi-auto touch hold fires exactly one round', value.player.ammo === before.player.ammo - 1);
  await tap(actionSelector('fire')); await sampleFor(.2);
  check('assault semi-auto release and press fires a second round', (await snapshot()).player.ammo === before.player.ammo - 2);
  await tap(actionSelector('mode')); before = await snapshot(); await holdAction('fire', .55); value = await snapshot();
  check('touch mode can return to assault automatic fire', value.weapon.fireMode === 'auto' && before.player.ammo - value.player.ammo >= 3);
  weapons.tactical.heldShots = before.player.ammo - value.player.ammo;
  await tap(actionSelector('aim')); await sampleFor(.6); await page.screenshot({ path: 'work/mobile-assault-aim.png' }); await tap(actionSelector('aim'));
  await abortRaid(); await deploy('heavy'); before = await snapshot(); await holdAction('fire', 1); value = await snapshot();
  check('precision rifle touch hold fires exactly one round', before.player.ammo - value.player.ammo === 1);
  weapons.heavy.heldShots = before.player.ammo - value.player.ammo;
  await tap(actionSelector('fire')); await sampleFor(.35);
  check('precision rifle release and press fires a second round', (await snapshot()).player.ammo === before.player.ammo - 2);
  await abortRaid();

  await page.setViewportSize({ width: 820, height: 1180 }); await checkLayout('tablet-lobby');
  await deploy(); await checkLayout('tablet-raid', true); await abortRaid();
  check('all mobile weapon, touch and extraction flows remain free of runtime errors', errors.length === 0);
  writeFileSync('work/mobile-browser-results.json', JSON.stringify({ passed: checks.length, checks, errors, layouts, weapons }, null, 2));
} catch (error) {
  const failureState = await snapshot().catch(() => null);
  await releaseAll().catch(() => {});
  await page.screenshot({ path: 'work/mobile-browser-failure.png' }).catch(() => {});
  writeFileSync('work/mobile-browser-results.json', JSON.stringify({ passed: checks.length, checks, errors, layouts, weapons, failure: error.message, state: failureState }, null, 2));
  throw error;
} finally {
  await browser.close();
}
