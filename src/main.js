import * as THREE from 'three';
import './style.css';
import { createWorld, createSoldier, createWeapon } from './world.js';
import { LOADOUTS, UPGRADES, loadProfile, saveProfile, beginRaid, purchaseUpgrade, upgradeCost, getCapacity, rollLoot, settleRaid } from './economy.js';
import { moveWithCollision, createNavigator, isBlocked } from './navigation.js';
import { GameAudio } from './audio.js';

const $ = id => document.getElementById(id);
const money = n => Math.round(n).toLocaleString('zh-CN');
const clamp = THREE.MathUtils.clamp;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const screens = ['lobby', 'hud', 'inventory', 'pause', 'result', 'help', 'settings', 'map-overlay'];
const audio = new GameAudio();
let profile = loadProfile(), selectedKit = 'basic', state = 'lobby', overlayReturn = 'lobby';
let settings = { sensitivity: 1, volume: .5, quality: 'high' };
try {
  const stored = JSON.parse(localStorage.getItem('grayzone.settings') || '{}');
  settings = { sensitivity: clamp(Number(stored.sensitivity) || 1, .3, 2), volume: Number.isFinite(stored.volume) ? clamp(stored.volume, 0, 1) : .5, quality: ['low','medium','high'].includes(stored.quality) ? stored.quality : 'high' };
} catch { /* Keep safe defaults. */ }
audio.volume = settings.volume;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, .075, 280);
camera.rotation.order = 'YXZ';
scene.add(camera);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch {
  document.body.innerHTML = '<main style="padding:60px;color:#e0e8e0;background:#111b1c;font-family:sans-serif"><h1>需要支持 WebGL 的浏览器</h1><p>请使用新版 Chrome 或 Edge，并在浏览器设置中开启硬件加速，再重新打开游戏。</p></main>';
  throw new Error('WebGL unavailable');
}
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
$('viewport').append(renderer.domElement);
renderer.domElement.setAttribute('aria-label', '灰域行动 3D 游戏画面');
const world = createWorld(scene);
const navigation = createNavigator(world.solids);
const weapon = createWeapon();
camera.add(weapon);
weapon.position.set(.24, -.29, -.7);
weapon.visible = false;
const muzzle = new THREE.PointLight(0xffba5f, 0, 5);
muzzle.position.set(.28, -.16, -1.1);
camera.add(muzzle);
const ray = new THREE.Raycaster();
const up = new THREE.Vector3(0,1,0);
const keys = new Set();
let mouseDown = false, aiming = false, yaw = 0, pitch = 0, recoil = 0;
let player = null, enemies = [], crates = [], effects = [], raidTime = 480, elapsed = 0;
let action = null, nearest = null, nextShot = 0, footstep = 0, hitTime = 0, hurtTime = 0, hintAt = 0;
let raidNumber = 0, lastFrame = performance.now(), uiTime = 0, lobbyTime = 0, finishReason = '';
let saveWarningShown = false;

function persist() {
  if (!saveProfile(profile) && !saveWarningShown) {
    saveWarningShown = true;
    toast('浏览器禁止保存，本次进度仅在当前窗口有效。', 'warn');
  }
}
function setScreen(next) {
  state = next;
  for (const id of screens) $(id).hidden = id !== next && !(id === 'hud' && ['inventory','pause','map-overlay'].includes(next));
  document.body.dataset.state = next;
  mouseDown = false; aiming = false; keys.clear();
  if (next !== 'hud' && document.pointerLockElement) document.exitPointerLock();
}
function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`; node.textContent = message;
  $('toast-container').append(node);
  while ($('toast-container').children.length > 4) $('toast-container').firstChild.remove();
  setTimeout(() => node.remove(), 4200);
}
async function lockPointer() {
  if (state !== 'hud' || document.pointerLockElement === renderer.domElement) return;
  try { await renderer.domElement.requestPointerLock(); }
  catch { toast('点击画面进入鼠标控制；浏览器拒绝时请稍后重试。'); }
}
function renderLobby() {
  $('credits').textContent = money(profile.credits);
  $('stats').innerHTML = `<span><b>${profile.stats.raids}</b> 次行动</span><span><b>${profile.stats.extracts}</b> 次撤离</span><span><b>${profile.stats.kills}</b> 次击败</span>`;
  $('contract-text').innerHTML = `物资回收 · 第 ${profile.contract.level} 阶段<br><strong>单次携带 ${profile.contract.target} 件物资成功撤离</strong><br><span>额外奖励 ₵ ${money(profile.contract.reward)}</span>`;
  $('loadouts').innerHTML = LOADOUTS.map((kit, i) => `<button class="loadout-card ${selectedKit === kit.id ? 'selected' : ''}" data-kit="${kit.id}" aria-pressed="${selectedKit === kit.id}"><span class="card-index">0${i + 1}</span><span class="card-content"><strong>${kit.name}</strong><small>${kit.description}</small><span class="kit-spec">伤害 ${kit.damage + profile.upgrades.weapon * 3} &nbsp; 护甲 ${kit.armor + profile.upgrades.armor * 20}</span></span><b class="kit-price">${kit.cost ? '₵ ' + money(kit.cost) : '免费'}</b></button>`).join('');
  $('upgrades').innerHTML = UPGRADES.map(u => {
    const level = profile.upgrades[u.id], maxed = level >= u.maxLevel, cost = upgradeCost(profile, u.id);
    return `<button class="upgrade-card" data-upgrade="${u.id}" ${maxed || cost > profile.credits ? 'disabled' : ''} title="${u.description}"><span><strong>${u.name}</strong><small>${u.id === 'pack' ? '背包容量 ' + getCapacity(profile) : u.id === 'armor' ? '额外护甲 +' + level * 20 : '额外伤害 +' + level * 3}</small></span><span><i>${'▰'.repeat(level)}${'▱'.repeat(3-level)}</i><b>${maxed ? '已满级' : '₵ ' + money(cost)}</b></span></button>`;
  }).join('');
  $('loadouts').querySelectorAll('[data-kit]').forEach(button => button.onclick = () => { selectedKit = button.dataset.kit; renderLobby(); audio.unlock(); audio.play('hit'); });
  $('upgrades').querySelectorAll('[data-upgrade]').forEach(button => button.onclick = () => {
    try { profile = purchaseUpgrade(profile, button.dataset.upgrade); persist(); renderLobby(); audio.unlock(); audio.play('loot'); toast('基地升级完成，下一次行动生效。'); }
    catch (error) { toast(error.message, 'warn'); }
  });
  const kit = LOADOUTS.find(k => k.id === selectedKit);
  $('deploy').disabled = kit.cost > profile.credits;
  $('deploy').innerHTML = `<span>${kit.cost > profile.credits ? '资金不足 · 选择免费装备' : '开始部署'}</span><small>${kit.cost ? '装备费用 ₵ ' + money(kit.cost) : '免费补给 · 随时出发'} &nbsp; ↗</small>`;
}

const crateMaterials = [
  new THREE.MeshStandardMaterial({ color: 0x40564b, roughness: .8 }),
  new THREE.MeshStandardMaterial({ color: 0x485768, roughness: .75 }),
  new THREE.MeshStandardMaterial({ color: 0x8b6542, roughness: .65 }),
];
const crateBaseGeometry = new THREE.BoxGeometry(1.2, .66, .8);
const crateLidGeometry = new THREE.BoxGeometry(1.28, .12, .86);
const crateLineGeometry = new THREE.BoxGeometry(.82, .04, .02);
function addCrate(spec, items = null) {
  const tier = spec.tier || 1, group = new THREE.Group();
  group.position.set(spec.x, 0, spec.z);
  const base = new THREE.Mesh(crateBaseGeometry, crateMaterials[tier-1]); base.position.y = .34; base.castShadow = true; group.add(base);
  const lid = new THREE.Mesh(crateLidGeometry, crateMaterials[tier-1]); lid.position.y = .74; group.add(lid);
  const color = tier === 3 ? 0xffc570 : tier === 2 ? 0x82bde9 : 0x91e0b4;
  const trim = new THREE.Mesh(crateLineGeometry, new THREE.MeshBasicMaterial({ color })); trim.position.set(0,.56,.413); group.add(trim);
  const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(.13), new THREE.MeshBasicMaterial({ color }));
  beacon.position.y = 1.3; group.add(beacon); scene.add(group);
  const crate = { x:spec.x, z:spec.z, tier, label:spec.label || '战地物资', group, lid, beacon, items, searched:false, empty:false };
  crates.push(crate); return crate;
}
function clearRaid() {
  enemies.forEach(e => { scene.remove(e.group); disposeGroup(e.group); });
  crates.forEach(c => { scene.remove(c.group); for (const mesh of c.group.children) { if (mesh.geometry !== crateBaseGeometry && mesh.geometry !== crateLidGeometry && mesh.geometry !== crateLineGeometry) mesh.geometry?.dispose(); if (!crateMaterials.includes(mesh.material)) mesh.material?.dispose(); } });
  effects.forEach(e => { scene.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); });
  enemies = []; crates = []; effects = [];
}
function disposeGroup(group) {
  const geometries = new Set(), materials = new Set();
  group.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m)); });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
}
function deploy() {
  let kit;
  try { const start = beginRaid(profile, selectedKit); profile = start.profile; kit = start.loadout; }
  catch (error) { toast(error.message, 'warn'); return; }
  persist(); clearRaid(); raidNumber++;
  player = { x:world.spawn.x, z:world.spawn.z, health:100, armor:kit.armor, maxArmor:kit.armor, stamina:100, ammo:kit.magazine, reserve:kit.reserve, medkits:kit.medkits, kit, loot:[], kills:0, moving:false, sprinting:false, crouching:false };
  for (const spec of world.lootSpawns) addCrate(spec);
  for (const [i, spec] of world.enemySpawns.entries()) {
    const soldier = createSoldier();
    const enemy = { ...soldier, x:spec.x, z:spec.z, home:{x:spec.x,z:spec.z}, health:i > 5 ? 100 : 80, alive:true, alert:false, lastKnown:null, memory:0, cooldown:1 + Math.random()*2, path:[], pathTimer:0, patrolTimer:i, phase:Math.random()*6, index:i };
    enemy.group.position.set(spec.x,0,spec.z);
    enemy.bodyMeshes.forEach(m => { m.userData.enemy = enemy; m.userData.headshot = false; });
    enemy.headMeshes.forEach(m => { m.userData.enemy = enemy; m.userData.headshot = true; });
    enemies.push(enemy); scene.add(enemy.group);
  }
  elapsed = 0; raidTime = 480; action = null; nearest = null; nextShot = 0; hintAt = 0;
  hurtTime = 0; hitTime = 0; recoil = 0; yaw = 0; pitch = 0;
  camera.position.set(player.x,1.68,player.z); camera.rotation.set(0,0,0);
  weapon.visible = true; setScreen('hud'); updateHUD(); audio.unlock(); lockPointer();
  toast('行动开始：先搜索前方物资箱。长按 E 搜索，M 查看撤离路线。');
}

function currentWeight() { return player.loot.reduce((sum,item) => sum + item.weight, 0); }
function lootValue() { return player.loot.reduce((sum,item) => sum + item.value, 0); }
function lineClear(from, to, height = 1.2) {
  const origin = new THREE.Vector3(from.x,height,from.z), target = new THREE.Vector3(to.x,height,to.z);
  const len = origin.distanceTo(target);
  ray.set(origin, target.sub(origin).normalize()); ray.far = Math.max(.1, len - .1); ray.near = .02;
  return ray.intersectObjects(world.blockers, false).length === 0;
}
function targetNearby() {
  const inExtraction = distance(player, world.extract) <= world.extract.radius;
  const viewDirection = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
  let best = null, dist = 3.1;
  for (const crate of crates) {
    if (crate.empty) continue;
    const d = distance(player,crate);
    const lookingAtCrate = new THREE.Vector3(crate.x-player.x,.5-camera.position.y,crate.z-player.z).normalize().dot(viewDirection) > .78;
    if (d < dist && (!inExtraction || lookingAtCrate) && lineClear(player,crate,.8)) { best = { kind:'search', crate, label:crate.label, duration:crate.searched ? .65 : 1.8 }; dist = d; }
  }
  return best || (inExtraction ? { kind:'extract', label:'安全撤离', duration:6 } : null);
}
function startReload() {
  if (state !== 'hud' || action || player.ammo >= player.kit.magazine) return;
  if (player.reserve <= 0) { toast('备弹耗尽，搜索物资箱或敌人掉落补给。','warn'); return; }
  action = { kind:'reload', elapsed:0, duration:1.8 }; audio.play('reload');
}
function startHeal() {
  if (state !== 'hud' || action) return;
  if (player.health >= 100) { toast('生命值已满。'); return; }
  if (player.medkits <= 0) { toast('医疗包不足，搜索物资获取补给。','warn'); return; }
  action = { kind:'heal', elapsed:0, duration:2.4 }; audio.play('reload');
}
function searchCrate(crate) {
  if (!crate.searched) {
    crate.items ??= rollLoot(crate.tier);
    crate.searched = true;
    player.reserve = Math.min(300, player.reserve + 24);
    if (Math.random() < .35) player.medkits = Math.min(6, player.medkits + 1);
    toast('发现弹药补给 +24');
  }
  let count = 0;
  crate.items = crate.items.filter(item => {
    if (currentWeight() + item.weight > player.kit.capacity) return true;
    player.loot.push({...item}); count++; return false;
  });
  crate.empty = crate.items.length === 0;
  crate.beacon.visible = !crate.empty;
  crate.lid.rotation.x = -.7; crate.lid.position.z = -.25;
  if (count) { audio.play('loot'); toast(`已收入 ${count} 件物资 · 背包估值 ₵ ${money(lootValue())}`); }
  if (!crate.empty) toast(`容量不足，箱内剩余 ${crate.items.length} 件。Tab 可整理背包。`, 'warn');
  if (player.loot.length >= profile.contract.target) $('mission-text').classList.add('complete');
}
function updateAction(dt) {
  nearest = targetNearby();
  if (!action && keys.has('KeyE') && nearest) action = { ...nearest, elapsed:0, start:{x:player.x,z:player.z} };
  if (!action) return;
  if (['search','extract'].includes(action.kind) && (!keys.has('KeyE') || distance(player,action.start) > .6 || !nearest || nearest.kind !== action.kind || (action.kind === 'search' && nearest.crate !== action.crate))) { action = null; return; }
  if (action.kind === 'heal' && player.sprinting) { action = null; toast('冲刺中断治疗。'); return; }
  action.elapsed += dt;
  if (action.elapsed < action.duration) return;
  const completed = action; action = null;
  if (completed.kind === 'reload') { const count = Math.min(player.kit.magazine-player.ammo,player.reserve); player.ammo += count; player.reserve -= count; audio.play('reload'); }
  if (completed.kind === 'heal') { player.health = Math.min(100, player.health + 65); player.medkits--; audio.play('heal'); toast('治疗完成 · 恢复 65 生命'); }
  if (completed.kind === 'search') { keys.delete('KeyE'); searchCrate(completed.crate); }
  if (completed.kind === 'extract') finishRaid(true, '物资已安全送达基地');
}

function addTracer(from,to,color = 0xffcb81) {
  const geometry = new THREE.BufferGeometry().setFromPoints([from.clone(),to.clone()]);
  const mesh = new THREE.Line(geometry,new THREE.LineBasicMaterial({color,transparent:true,opacity:.85}));
  scene.add(mesh); effects.push({mesh,life:.08,maxLife:.08});
}
function impact(point,color = 0xffc985) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(.065,4,3),new THREE.MeshBasicMaterial({color,transparent:true}));
  mesh.position.copy(point); scene.add(mesh); effects.push({mesh,life:.16,maxLife:.16});
}
function shoot() {
  if (state !== 'hud' || action || nextShot > 0 || player.sprinting) return;
  nextShot = player.kit.id === 'heavy' ? .19 : .14;
  if (player.ammo <= 0) { audio.play('empty'); startReload(); return; }
  player.ammo--; audio.play('shot'); recoil = Math.min(.1,recoil + (aiming ? .022 : .04)); muzzle.intensity = 3;
  camera.updateMatrixWorld(true); scene.updateMatrixWorld(true);
  const direction = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
  const spread = aiming ? .003 : player.moving ? .021 : .011;
  direction.x += (Math.random()-.5)*spread; direction.y += (Math.random()-.5)*spread; direction.z += (Math.random()-.5)*spread; direction.normalize();
  ray.set(camera.position,direction); ray.far=150; ray.near=.1;
  const meshes = enemies.filter(e => e.alive).flatMap(e => [...e.bodyMeshes,...e.headMeshes]);
  const hits = ray.intersectObjects([...world.blockers,...meshes],false);
  const point = hits[0]?.point || camera.position.clone().addScaledVector(direction,100);
  addTracer(weapon.localToWorld(weapon.userData.muzzle.clone()),point);
  if (hits[0]) {
    const enemy = hits[0].object.userData.enemy;
    impact(point, enemy ? 0x9fffc7 : 0xffc985);
    if (enemy) {
      const headshot = hits[0].object.userData.headshot;
      enemy.health -= player.kit.damage * (headshot ? 2.15 : 1);
      enemy.alert = true; enemy.lastKnown = {x:player.x,z:player.z}; enemy.memory = 12;
      hitTime = .15; $('hitmarker').classList.toggle('headshot',headshot); audio.play('hit');
      if (enemy.health <= 0) killEnemy(enemy,headshot);
    }
  }
  for (const enemy of enemies) if (enemy.alive && distance(enemy,player) < 28) { enemy.alert = true; enemy.lastKnown = {x:player.x,z:player.z}; enemy.memory = 12; }
}
function killEnemy(enemy,headshot) {
  if (!enemy.alive) return;
  enemy.alive = false; enemy.group.rotation.z = Math.PI / 2; enemy.group.position.y = .35;
  player.kills++; audio.play('kill'); toast(`${headshot ? '精准命中 · ' : ''}击败守卫 · 撤离后奖励 ₵ 100`);
  addCrate({x:enemy.x,z:enemy.z,tier:2,label:'守卫战利品'},rollLoot(2));
}
function hurt(damage) {
  if (!player || state !== 'hud') return;
  const absorbed = Math.min(player.armor,damage*.7);
  player.armor -= absorbed; player.health -= damage-absorbed;
  hurtTime = .65; audio.play('hurt');
  if (action && ['heal','extract'].includes(action.kind)) { action = null; keys.delete('KeyE'); toast('受到攻击，操作已中断。','warn'); }
  if (player.health <= 0) { player.health = 0; finishRaid(false, '行动中失去战斗能力'); }
}

function updateEnemies(dt) {
  for (const enemy of enemies) {
    if (!enemy.alive || state !== 'hud') continue;
    const dist = distance(enemy,player);
    enemy.cooldown -= dt; enemy.pathTimer -= dt; enemy.memory -= dt; enemy.patrolTimer -= dt;
    const awareness = player.sprinting ? 29 : player.crouching ? 16 : 24;
    const visible = dist < awareness && lineClear(enemy,player,player.crouching ? .85 : 1.3);
    if (visible) { enemy.alert = true; enemy.lastKnown = {x:player.x,z:player.z}; enemy.memory = 9; }
    if (enemy.memory <= 0 && enemy.alert) { enemy.alert = false; enemy.path=[]; }
    if (enemy.alert && enemy.lastKnown) {
      if (enemy.pathTimer <= 0) { enemy.path = navigation.path(enemy,enemy.lastKnown); enemy.pathTimer = 1.25 + enemy.index*.06; }
      enemy.group.rotation.y = Math.atan2(player.x-enemy.x,player.z-enemy.z);
      if (visible && dist < 24 && enemy.cooldown <= 0) {
        enemy.cooldown = 1.05 + Math.random()*.85;
        const from = new THREE.Vector3(enemy.x,1.36,enemy.z), to = camera.position.clone();
        const chance = clamp(.78 - dist*.013 - (player.sprinting ? .2 : 0) - (player.crouching ? .08 : 0),.17,.75);
        const hit = Math.random() < chance;
        if (!hit) to.add(new THREE.Vector3((Math.random()-.5)*2.5,.5,0));
        addTracer(from,to,0xff875c); audio.play('enemy');
        if (hit) hurt(10 + Math.random()*5);
      }
    } else if (enemy.patrolTimer <= 0 || enemy.path.length === 0) {
      enemy.patrolTimer = 5 + Math.random()*5;
      const angle = Math.random()*Math.PI*2, r = 4+Math.random()*5;
      enemy.path = navigation.path(enemy,{x:clamp(enemy.home.x+Math.sin(angle)*r,-45,45),z:clamp(enemy.home.z+Math.cos(angle)*r,-45,45)});
    }
    let walking = false;
    if (enemy.path.length && !(visible && dist < 12)) {
      const target = enemy.path[0], d = distance(enemy,target);
      if (d < .65) enemy.path.shift();
      else {
        const speed = enemy.alert ? 2.5 : 1.15;
        const dx=(target.x-enemy.x)/d,dz=(target.z-enemy.z)/d;
        moveWithCollision(enemy,dx*dt*speed,dz*dt*speed,world.solids,.42);
        if (!visible) enemy.group.rotation.y = Math.atan2(dx,dz);
        walking=true;
      }
    }
    enemy.group.position.x=enemy.x; enemy.group.position.z=enemy.z;
    const swing = walking ? Math.sin(elapsed*8+enemy.phase)*.38 : 0;
    if (enemy.limbs) { enemy.limbs.leftLeg.rotation.x=swing; enemy.limbs.rightLeg.rotation.x=-swing; }
  }
}

function updatePlayer(dt) {
  const forward = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
  const side = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
  player.moving = forward !== 0 || side !== 0;
  player.crouching = keys.has('KeyC');
  player.sprinting = player.moving && forward > 0 && keys.has('ShiftLeft') && player.stamina > 1 && !aiming && !player.crouching && (!action || action.kind === 'heal');
  player.stamina = clamp(player.stamina + (player.sprinting ? -23 : 16)*dt,0,100);
  const speed = player.sprinting ? 7 : player.crouching ? 2 : aiming ? 2.5 : 4.2;
  const normal = Math.max(1,Math.hypot(forward,side));
  const dx = (Math.cos(yaw)*side - Math.sin(yaw)*forward) / normal;
  const dz = (-Math.sin(yaw)*side - Math.cos(yaw)*forward) / normal;
  moveWithCollision(player,dx*speed*dt,dz*speed*dt,world.solids,.38);
  player.x = clamp(player.x,-48,48); player.z=clamp(player.z,-48,48);
  const bob = player.moving ? Math.sin(elapsed*(player.sprinting?15:10))*(player.crouching?.014:.032) : 0;
  camera.position.x=player.x; camera.position.z=player.z;
  camera.position.y=THREE.MathUtils.damp(camera.position.y,(player.crouching?1.04:1.68)+bob,14,dt);
  recoil = Math.max(0,recoil-dt*.2);
  camera.rotation.set(pitch+recoil,yaw,0);
  const fov = aiming ? 49 : player.sprinting ? 83 : 76;
  camera.fov = THREE.MathUtils.damp(camera.fov,fov,12,dt); camera.updateProjectionMatrix();
  weapon.position.set(THREE.MathUtils.damp(weapon.position.x,aiming ? 0 : .24,14,dt),THREE.MathUtils.damp(weapon.position.y,aiming ? -.192 : -.29,14,dt) - Math.abs(bob)*.18, THREE.MathUtils.damp(weapon.position.z,aiming ? -.65 : -.7,14,dt) + recoil*.2);
  weapon.rotation.set(action?.kind==='reload' ? -.35-Math.sin(action.elapsed*4)*.2 : player.sprinting ? -.28 : 0,0,action?.kind==='heal' ? -.7 : player.sprinting ? -.2 : 0);
  footstep -= dt;
  if (player.moving && footstep <= 0) { footstep = player.sprinting ? .28 : .44; audio.play('step'); }
  nextShot = Math.max(0,nextShot-dt);
  if (mouseDown && document.pointerLockElement === renderer.domElement) shoot();
}

function drawMap(canvas, large = false) {
  const ctx=canvas.getContext('2d'), width=canvas.width, height=canvas.height;
  ctx.clearRect(0,0,width,height);
  ctx.fillStyle='#101d20'; ctx.fillRect(0,0,width,height);
  const padding=large?38:12, scale=(width-padding*2)/100;
  const px=x=>padding+(x+50)*scale, pz=z=>padding+(z+50)*scale;
  ctx.strokeStyle='#203034'; ctx.lineWidth=1;
  for(let a=-50;a<=50;a+=10){ctx.beginPath();ctx.moveTo(px(a),pz(-50));ctx.lineTo(px(a),pz(50));ctx.stroke();ctx.beginPath();ctx.moveTo(px(-50),pz(a));ctx.lineTo(px(50),pz(a));ctx.stroke();}
  ctx.fillStyle='#415052';
  for(const s of world.solids){if(s.maxX-s.minX>95||s.maxZ-s.minZ>95)continue;ctx.fillRect(px(s.minX),pz(s.minZ),(s.maxX-s.minX)*scale,(s.maxZ-s.minZ)*scale);}
  ctx.fillStyle='#88e5b6';ctx.strokeStyle='#88e5b6';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.arc(px(world.extract.x),pz(world.extract.z),world.extract.radius*scale,0,Math.PI*2);ctx.stroke();
  ctx.fillRect(px(world.extract.x)-2,pz(world.extract.z)-2,4,4);
  for(const crate of crates){if(crate.empty)continue;ctx.fillStyle=crate.tier===3?'#edbd72':'#9cb8b1';const size=large?5:3;ctx.fillRect(px(crate.x)-size/2,pz(crate.z)-size/2,size,size);}
  if(player){
    for(const enemy of enemies){if(!enemy.alive||distance(enemy,player)>22)continue;ctx.fillStyle=enemy.alert?'#ff785f':'#be7864';ctx.beginPath();ctx.arc(px(enemy.x),pz(enemy.z),large?3.5:2.5,0,Math.PI*2);ctx.fill();}
    ctx.save();ctx.translate(px(player.x),pz(player.z));ctx.rotate(-yaw);ctx.fillStyle='#eaf9f3';ctx.beginPath();ctx.moveTo(0,-7);ctx.lineTo(-4.5,5);ctx.lineTo(0,3);ctx.lineTo(4.5,5);ctx.closePath();ctx.fill();ctx.restore();
  }
  ctx.fillStyle='#7f9692';ctx.font=`${large?13:10}px sans-serif`;ctx.textAlign='center';ctx.fillText('N',width/2,large?20:11);
  if(large){
    ctx.font='12px sans-serif';
    for(const zone of world.zones){ctx.fillStyle='#a9b8b2';ctx.fillText(zone.name,px(zone.x),pz(zone.z)-13);}
    ctx.fillStyle='#88e5b6';ctx.fillText('北岸撤离区',px(world.extract.x),pz(world.extract.z)-world.extract.radius*scale-10);
    ctx.fillStyle='#90a7a1';ctx.textAlign='left';ctx.fillText('南侧部署点',px(world.spawn.x)+10,pz(world.spawn.z)+5);
  }
}

function updateHUD() {
  if(!player)return;
  const minutes=Math.floor(raidTime/60),seconds=Math.floor(raidTime%60);
  $('raid-timer').textContent=`${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
  $('raid-timer').classList.toggle('urgent',raidTime<60);
  $('health-value').textContent=Math.ceil(player.health);$('health-fill').style.width=`${player.health}%`;
  $('armor-value').textContent=Math.ceil(player.armor);$('armor-fill').style.width=`${player.maxArmor?player.armor/player.maxArmor*100:0}%`;
  $('stamina-fill').style.width=`${player.stamina}%`;
  $('ammo-current').textContent=String(player.ammo).padStart(2,'0');$('ammo-reserve').textContent=player.reserve;
  $('ammo-current').classList.toggle('urgent',player.ammo<6);
  $('weapon-name').textContent=player.kit.id==='heavy'?'BR-46 / 精确步枪':player.kit.id==='tactical'?'AR-36 / 突击步枪':'SR-32 / 侦察步枪';
  $('medkit-count').textContent=player.medkits;
  $('bag-summary').textContent=`${currentWeight()} / ${player.kit.capacity} KG · ₵ ${money(lootValue())}`;
  $('kill-count').textContent=player.kills;
  const heading=((THREE.MathUtils.radToDeg(-yaw)%360)+360)%360;
  const headings=['N','NE','E','SE','S','SW','W','NW'];
  $('compass').textContent=`${headings[Math.round(heading/45)%8]}　${Math.round(heading).toString().padStart(3,'0')}°`;
  const nearestZone=[...world.zones].sort((a,b)=>distance(player,a)-distance(player,b))[0];
  $('location-name').textContent=nearestZone?.name||'灰港工业区';
  $('mission-text').textContent=`回收物资 ${Math.min(player.loot.length,profile.contract.target)} / ${profile.contract.target} · ${player.loot.length>=profile.contract.target?'已达目标，前往撤离':'搜集后带出，获得额外 ₵ 800'}`;
  $('mission-text').classList.toggle('complete',player.loot.length>=profile.contract.target);
  const extractionDistance=Math.round(distance(player,world.extract));
  $('extract-label').textContent=`↗ 北岸撤离区　${extractionDistance} m`;
  $('interact-prompt').hidden=!nearest||!!action;
  if(nearest)$('interact-prompt').innerHTML=`<kbd>长按 E</kbd> ${nearest.kind==='extract'?'呼叫撤离 · 坚守 6 秒':`搜索 ${nearest.label}`}<small>${nearest.kind==='extract'?'松开按键、移动或受到攻击会中断':'获得物资与弹药补给'}</small>`;
  $('action-progress').hidden=!action;
  if(action){$('action-fill').style.width=`${clamp(action.elapsed/action.duration*100,0,100)}%`;$('action-label').textContent=`${({reload:'正在换弹',heal:'正在治疗',search:'正在搜索',extract:'正在撤离'})[action.kind]}　${Math.max(0,action.duration-action.elapsed).toFixed(1)} s`;}
  $('crosshair').classList.toggle('aiming',aiming);$('crosshair').classList.toggle('sprinting',player.sprinting);
  $('hitmarker').hidden=hitTime<=0;$('hitmarker').style.opacity=hitTime>0?'1':'0';
  $('damage-overlay').style.opacity=String(Math.max(hurtTime*.85,player.health<30?.14:0));
  drawMap($('minimap'));
}

function renderInventory() {
  $('inventory-weight').textContent=`${currentWeight()} / ${player.kit.capacity} KG · 撤离估值 ₵ ${money(lootValue())}`;
  $('inventory-items').innerHTML=player.loot.length?player.loot.map((item,i)=>`<div class="loot-row rarity-${item.rarity}"><span class="loot-icon">◇</span><span><strong>${item.name}</strong><small>${item.weight} KG</small></span><b>₵ ${money(item.value)}</b><button class="drop-item" data-drop="${i}" aria-label="丢弃${item.name}">丢弃</button></div>`).join(''):'<p class="empty-state">背包为空。靠近发光的物资箱，长按 E 搜索。</p>';
  $('inventory-items').querySelectorAll('[data-drop]').forEach(button=>button.onclick=()=>{
    const [item]=player.loot.splice(Number(button.dataset.drop),1);
    if(item){const ground=crates.find(c=>c.label==='丢弃的物资'&&distance(c,player)<1.5);if(ground){ground.items.push(item);ground.empty=false;ground.beacon.visible=true;}else{const crate=addCrate({x:player.x,z:player.z,tier:1,label:'丢弃的物资'},[item]);crate.searched=true;}audio.play('reload');renderInventory();updateHUD();}
  });
}

function finishRaid(success,reason) {
  if(!player||!['hud','pause'].includes(state))return;
  const carried=[...player.loot];
  const {profile:next,summary}=settleRaid(profile,{success,loot:carried,kills:player.kills,duration:elapsed});
  profile=next;persist();action=null;finishReason=reason;weapon.visible=false;setScreen('result');
  audio.play(success?'success':'fail');
  $('result-tag').textContent=success?'EXTRACTION COMPLETE':'OPERATION LOST';
  $('result-title').textContent=success?'成功撤离':'行动失败';
  $('result-title').className=success?'success':'failure';
  $('result-details').innerHTML=`<p class="result-reason">${reason}</p><div class="result-stats"><div><small>行动时间</small><strong>${Math.floor(elapsed/60)}<em>分</em>${Math.floor(elapsed%60)}<em>秒</em></strong></div><div><small>击败守卫</small><strong>${player.kills}</strong></div><div><small>${success?'带出物资':'损失物资'}</small><strong>${carried.length}</strong></div></div><div class="settlement-line"><span>物资兑换</span><b>₵ ${money(summary.lootValue)}</b></div><div class="settlement-line"><span>战斗奖励</span><b>₵ ${money(summary.killReward)}</b></div><div class="settlement-line"><span>合约奖励 ${summary.contractCompleted?'· 已完成':''}</span><b>₵ ${money(summary.contractReward)}</b></div><div class="settlement-total"><span>本次收入</span><strong>+ ₵ ${money(summary.totalReward)}</strong></div>${!success?'<p class="loss-note">本局物资及出战装备已损失。基地升级保留，免费装备随时可用。</p>':''}`;
  $('result-loot').innerHTML=carried.length?carried.map(item=>`<div class="loot-row rarity-${item.rarity}"><span class="loot-icon">◇</span><strong>${item.name}</strong><b>${success?'₵ '+money(item.value):'已损失'}</b></div>`).join(''):'<p class="empty-state">本局没有携带物资</p>';
}

function resume() { if(!player)return;setScreen('hud');audio.unlock();lockPointer(); }
function pause() { if(state!=='hud')return;action=null;setScreen('pause'); }
function openOverlay(id) {
  overlayReturn=state==='hud'?'hud':state;
  if(['inventory','map-overlay'].includes(id))overlayReturn='hud';
  action=null;setScreen(id);
  if(id==='inventory')renderInventory();
  if(id==='map-overlay')drawMap($('large-map'),true);
}
function closeOverlay() { if(overlayReturn==='hud')resume();else setScreen(overlayReturn); }
function applySettings() {
  audio.volume=settings.volume;
  renderer.setPixelRatio(Math.min(devicePixelRatio,settings.quality==='low'?1:settings.quality==='medium'?1.25:1.6));
  renderer.shadowMap.enabled=settings.quality!=='low';
  try{localStorage.setItem('grayzone.settings',JSON.stringify(settings));}catch{}
}
$('deploy').onclick=deploy;
$('return-lobby').onclick=()=>{player=null;weapon.visible=false;setScreen('lobby');renderLobby();};
$('help-open').onclick=()=>openOverlay('help');$('help-close').onclick=closeOverlay;
$('settings-open').onclick=()=>openOverlay('settings');$('settings-close').onclick=closeOverlay;
$('pause-settings').onclick=()=>openOverlay('settings');
$('inventory-close').onclick=resume;$('map-close').onclick=resume;$('resume').onclick=resume;
$('abort').onclick=()=>finishRaid(false,'主动结束行动，未能带出本局物资');
$('sensitivity').value=settings.sensitivity;$('volume').value=settings.volume;$('quality').value=settings.quality;
for(const id of ['sensitivity','volume','quality'])$(id).addEventListener('input',()=>{settings[id]=id==='quality'?$(id).value:Number($(id).value);applySettings();});

window.addEventListener('keydown',event=>{
  if(['Tab','Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.code))event.preventDefault();
  if(event.repeat)return;
  if(event.code==='Escape'){
    if(state==='hud')pause();else if(state==='pause')resume();else if(['help','settings','inventory','map-overlay'].includes(state))closeOverlay();
    return;
  }
  if(event.code==='Tab'&&state==='inventory'){resume();return;}
  if(event.code==='KeyM'&&state==='map-overlay'){resume();return;}
  if(state!=='hud')return;
  keys.add(event.code);
  if(event.code==='KeyR')startReload();
  if(event.code==='KeyF')startHeal();
  if(event.code==='Tab')openOverlay('inventory');
  if(event.code==='KeyM')openOverlay('map-overlay');
});
window.addEventListener('keyup',event=>keys.delete(event.code));
window.addEventListener('mousemove',event=>{
  if(state!=='hud'||document.pointerLockElement!==renderer.domElement)return;
  yaw-=event.movementX*.0021*settings.sensitivity*(aiming?.62:1);
  pitch=clamp(pitch-event.movementY*.0021*settings.sensitivity*(aiming?.62:1),-1.45,1.45);
});
renderer.domElement.addEventListener('mousedown',event=>{
  if(state!=='hud')return;
  audio.unlock();
  if(document.pointerLockElement!==renderer.domElement){lockPointer();return;}
  if(event.button===0){mouseDown=true;if(action?.kind==='heal')action=null;shoot();}
  if(event.button===2)aiming=true;
});
window.addEventListener('mouseup',event=>{if(event.button===0)mouseDown=false;if(event.button===2)aiming=false;});
window.addEventListener('contextmenu',event=>event.preventDefault());
document.addEventListener('pointerlockchange',()=>{if(!document.pointerLockElement&&state==='hud')pause();});
window.addEventListener('blur',()=>{keys.clear();mouseDown=false;aiming=false;pause();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});

function animate(now) {
  requestAnimationFrame(animate);
  const dt=Math.min(.05,Math.max(0,(now-lastFrame)/1000));lastFrame=now;lobbyTime+=dt;
  world.animate?.(lobbyTime);
  if(state==='hud'&&player){
    elapsed+=dt;raidTime=Math.max(0,480-elapsed);
    updatePlayer(dt);updateAction(dt);updateEnemies(dt);
    hitTime=Math.max(0,hitTime-dt);hurtTime=Math.max(0,hurtTime-dt);muzzle.intensity=Math.max(0,muzzle.intensity-dt*38);
    if(raidTime<=0)finishRaid(false,'行动窗口已关闭，未在时限内撤离');
    if(elapsed>35&&hintAt===0){hintAt=1;toast('按 M 查看地图。金色物资箱价值更高，绿色圆圈是撤离点。');}
    if(raidTime<60&&hintAt<2){hintAt=2;toast('剩余时间不足 1 分钟，立即前往北岸撤离区！','warn');}
    uiTime+=dt;if(uiTime>.07){uiTime=0;updateHUD();}
  }else if(state==='lobby'||(state==='help'&&overlayReturn==='lobby')||(state==='settings'&&overlayReturn==='lobby')){
    const angle=.45+Math.sin(lobbyTime*.07)*.11;
    camera.position.set(58*Math.sin(angle),28,58*Math.cos(angle));camera.lookAt(-3,1,-8);camera.fov=58;camera.updateProjectionMatrix();
  }
  for(const crate of crates){crate.beacon.rotation.y=lobbyTime*1.4;crate.beacon.position.y=1.3+Math.sin(lobbyTime*2+crate.x)*.1;}
  for(let i=effects.length-1;i>=0;i--){const e=effects[i];e.life-=dt;e.mesh.material.opacity=Math.max(0,e.life/e.maxLife);if(e.life<=0){scene.remove(e.mesh);e.mesh.geometry.dispose();e.mesh.material.dispose();effects.splice(i,1);}}
  renderer.render(scene,camera);
}
applySettings();renderLobby();setScreen('lobby');requestAnimationFrame(animate);

// Explicit development-only integration seam, eliminated from production builds.
if(import.meta.env.DEV&&new URLSearchParams(location.search).has('test')){
  window.__game={
    snapshot:()=>({state,profile:structuredClone(profile),player:player?{...player,loot:structuredClone(player.loot)}:null,raidTime,elapsed,action:action?.kind,reason:finishReason,enemies:enemies.map(e=>({x:e.x,z:e.z,alive:e.alive,health:e.health})),crates:crates.map(c=>({x:c.x,z:c.z,tier:c.tier,empty:c.empty})),extract:world.extract,spawn:world.spawn,solids:world.solids,locked:!!document.pointerLockElement,renderer:renderer.info.render}),
    teleport:(x,z)=>{if(player){player.x=x;player.z=z;camera.position.set(x,1.68,z);}},
    look:(y,p=0)=>{yaw=y;pitch=p;camera.rotation.set(p,y,0);camera.updateMatrixWorld(true);},
    damage:hurt,
    setElapsed:t=>{elapsed=t;},
    safe:()=>{for(const e of enemies){e.cooldown=99999;e.memory=0;e.alert=false;}},
    route:(a,b)=>navigation.path(a,b),
    blocked:(x,z)=>isBlocked(x,z,world.solids,.38),
    enemyTarget:(index=0)=>{const e=enemies[index];if(!e)return null;return {x:e.x,y:1.25,z:e.z};},
  };
}
