import * as THREE from 'three';
import './style.css';
import { createWorld, createSoldier, createWeapon } from './world.js';
import { LOADOUTS, UPGRADES, loadProfile, saveProfile, beginRaid, purchaseUpgrade, upgradeCost, getCapacity, rollLoot, settleRaid } from './economy.js';
import { moveWithCollision, createNavigator, isBlocked } from './navigation.js';
import { GameAudio } from './audio.js';
import { getWeapon, damageAtDistance, needsTriggerRelease, nextFireMode } from './weapons.js';
import { animateSoldier } from './actor-animation.js';
import { CombatEffects } from './combat-effects.js';
import { TouchControls } from './touch-controls.js';

const $ = id => document.getElementById(id);
const money = n => Math.round(n).toLocaleString('zh-CN');
const clamp = THREE.MathUtils.clamp;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const screens = ['lobby', 'hud', 'inventory', 'pause', 'result', 'help', 'settings', 'map-overlay'];
const audio = new GameAudio();
const prefersTouch = matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches);
let profile = loadProfile(), selectedKit = 'basic', state = 'lobby', overlayReturn = 'lobby';
let settings = { sensitivity: 1, volume: .5, musicVolume: .4, quality: prefersTouch ? 'low' : 'high' };
try {
  const stored = JSON.parse(localStorage.getItem('grayzone.settings') || '{}');
  settings = { sensitivity: clamp(Number(stored.sensitivity) || 1, .3, 2), volume: Number.isFinite(stored.volume) ? clamp(stored.volume, 0, 1) : .5, musicVolume: Number.isFinite(stored.musicVolume) ? clamp(stored.musicVolume, 0, 1) : .4, quality: ['low','medium','high'].includes(stored.quality) ? stored.quality : prefersTouch ? 'low' : 'high' };
} catch { /* Keep safe defaults. */ }
audio.volume = settings.volume;
audio.musicVolume = settings.musicVolume;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, .075, 280);
camera.rotation.order = 'YXZ';
scene.add(camera);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: !prefersTouch, powerPreference: 'high-performance' });
} catch {
  document.body.innerHTML = '<main style="padding:32px;color:#e0e8e0;background:#111b1c;font-family:sans-serif"><h1>需要支持 WebGL 的浏览器</h1><p>请使用新版 Safari、Chrome 或 Edge 打开游戏。</p></main>';
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
let weapon = createWeapon('basic'), weaponConfig=getWeapon('basic'), fireMode='auto';
camera.add(weapon);
weapon.position.set(.24, -.29, -.7);
weapon.visible = false;
const muzzle = new THREE.PointLight(0xffba5f, 0, 5);
muzzle.position.copy(weapon.userData.muzzle);
weapon.add(muzzle);
const muzzleFlash = new THREE.Mesh(new THREE.SphereGeometry(.036, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffdc8a, transparent: true, opacity: .85, blending: THREE.AdditiveBlending, depthWrite: false }));
muzzleFlash.position.copy(weapon.userData.muzzle); muzzleFlash.visible = false;
weapon.add(muzzleFlash);
const ray = new THREE.Raycaster();
const up = new THREE.Vector3(0,1,0);
const keys = new Set();
let touchControls = null;
const touchToggles = { sprint: false, crouch: false };
let mouseDown = false, aiming = false, yaw = 0, pitch = 0, recoil = 0;
let shotKick=0, shotAge=10;
let gaitPhase=0,motionEnvelope=0,viewRoll=0;
const weaponSway = new THREE.Vector2();
let player = null, enemies = [], crates = [], raidTime = 480, elapsed = 0;
const combatEffects=new CombatEffects(scene);
let action = null, nearest = null, nextShot = 0, footstep = 0, hitTime = 0, hurtTime = 0, hintAt = 0;
let raidNumber = 0, lastFrame = performance.now(), uiTime = 0, lobbyTime = 0, finishReason = '';
let saveWarningShown = false;
const mapBackgrounds = new Map();
let mapRoute = null;

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
  const fieldOverlay = ['inventory','pause','map-overlay'].includes(next) || (['help','settings'].includes(next) && player && overlayReturn !== 'lobby');
  audio.setMood(next === 'hud' ? 'raid' : next === 'result' ? 'result' : fieldOverlay ? 'pause' : 'lobby');
  resetInput();
  if (touchControls) { touchControls.setActive(next === 'hud'); $('touch-controls').hidden = next !== 'hud' || !touchControls.enabled; }
  if (next !== 'hud') { muzzle.intensity = 0; muzzleFlash.visible = false; }
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
  if (state !== 'hud' || touchControls?.enabled || document.pointerLockElement === renderer.domElement) return;
  try { await renderer.domElement.requestPointerLock(); }
  catch { toast('点击画面进入鼠标控制；浏览器拒绝时请稍后重试。'); }
}
function renderLobby() {
  $('credits').textContent = money(profile.credits);
  $('stats').innerHTML = `<span><b>${profile.stats.raids}</b> 次行动</span><span><b>${profile.stats.extracts}</b> 次撤离</span><span><b>${profile.stats.kills}</b> 次击败</span>`;
  $('contract-text').innerHTML = `物资回收 · 第 ${profile.contract.level} 阶段<br><strong>单次携带 ${profile.contract.target} 件物资成功撤离</strong><br><span>额外奖励 ₵ ${money(profile.contract.reward)}</span>`;
  $('loadouts').innerHTML = LOADOUTS.map((kit, i) => `<button class="loadout-card ${selectedKit === kit.id ? 'selected' : ''}" data-kit="${kit.id}" aria-pressed="${selectedKit === kit.id}"><span class="card-index">0${i + 1}</span><span class="card-content"><strong>${kit.name}</strong><small>${kit.description}</small><span class="kit-spec weapon-kit-name">${getWeapon(kit.weaponId).name} · ${kit.magazine} 发</span><span class="kit-spec">伤害 ${kit.damage + profile.upgrades.weapon * 3} &nbsp; 护甲 ${kit.armor + profile.upgrades.armor * 20}</span></span><b class="kit-price">${kit.cost ? '₵ ' + money(kit.cost) : '免费'}</b></button>`).join('');
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
  combatEffects.clear();
  enemies = []; crates = [];
}
function disposeGroup(group) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  group.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => materials.add(m)); });
  materials.forEach(m => { for (const value of Object.values(m)) if (value?.isTexture) textures.add(value); });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
}
function deploy() {
  let kit;
  try { const start = beginRaid(profile, selectedKit); profile = start.profile; kit = start.loadout; }
  catch (error) { toast(error.message, 'warn'); return; }
  persist(); clearRaid(); raidNumber++;
  camera.remove(weapon);weapon.remove(muzzle,muzzleFlash);disposeGroup(weapon);
  weaponConfig=getWeapon(kit.weaponId);fireMode=weaponConfig.fireModes[0];
  weapon=createWeapon(weaponConfig.id);camera.add(weapon);weapon.position.set(.24,-.29,-.7);
  muzzle.position.copy(weapon.userData.muzzle);muzzleFlash.position.copy(weapon.userData.muzzle);weapon.add(muzzle,muzzleFlash);
  muzzle.color.set(weaponConfig.flashColor);muzzleFlash.material.color.set(weaponConfig.flashColor);
  player = { x:world.spawn.x, z:world.spawn.z, health:100, armor:kit.armor, maxArmor:kit.armor, stamina:100, ammo:kit.magazine, reserve:kit.reserve, medkits:kit.medkits, kit, loot:[], kills:0, moving:false, sprinting:false, crouching:false };
  for (const spec of world.lootSpawns) addCrate(spec);
  for (const [i, spec] of world.enemySpawns.entries()) {
    const soldier = createSoldier();
    const enemy = { ...soldier, x:spec.x, z:spec.z, home:{x:spec.x,z:spec.z}, health:i > 5 ? 100 : 80, alive:true, alert:false, lastKnown:null, memory:0, cooldown:1 + Math.random()*2, path:[], pathTimer:0, patrolTimer:i, phase:Math.random()*6, index:i, speed:0, notice:0, reaction:.32+i*.035, ready:0, hit:0, shot:0, burst:0, reposition:0, deathTime:null, behavior:'patrol' };
    enemy.group.position.set(spec.x,0,spec.z);
    enemy.bodyMeshes.forEach(m => { m.userData.enemy = enemy; m.userData.headshot = false; });
    enemy.headMeshes.forEach(m => { m.userData.enemy = enemy; m.userData.headshot = true; });
    enemies.push(enemy); scene.add(enemy.group);
  }
  elapsed = 0; raidTime = 480; action = null; nearest = null; nextShot = 0; hintAt = 0;
  hurtTime = 0; hitTime = 0; recoil = 0; yaw = 0; pitch = 0;
  weaponSway.set(0,0);mapRoute = null;shotKick=0;shotAge=10;gaitPhase=0;motionEnvelope=0;viewRoll=0;
  camera.position.set(player.x,1.68,player.z); camera.rotation.set(0,0,0);
  weapon.visible = true; setScreen('hud'); updateHUD(); audio.unlock(); lockPointer();
  toast(touchControls?.enabled ? '行动开始：左侧摇杆移动，滑动画面瞄准，长按搜索按钮获取物资。' : '行动开始：先搜索前方物资箱。长按 E 搜索，M 查看撤离路线。');
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
  action = { kind:'reload', elapsed:0, duration:weaponConfig.reloadTime, stage:0 };audio.reload(weaponConfig.id,'start');
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
  if (!crate.empty) toast(`容量不足，箱内剩余 ${crate.items.length} 件。${touchControls?.enabled ? '点背包按钮' : 'Tab'}可整理背包。`, 'warn');
  if (player.loot.length >= profile.contract.target) $('mission-text').classList.add('complete');
}
function updateAction(dt) {
  nearest = targetNearby();
  if (!action && keys.has('KeyE') && nearest) action = { ...nearest, elapsed:0, start:{x:player.x,z:player.z} };
  if (!action) return;
  if (['search','extract'].includes(action.kind) && (!keys.has('KeyE') || distance(player,action.start) > .6 || !nearest || nearest.kind !== action.kind || (action.kind === 'search' && nearest.crate !== action.crate))) { action = null; return; }
  if (action.kind === 'heal' && player.sprinting) { action = null; toast('冲刺中断治疗。'); return; }
  action.elapsed += dt;
  if(action.kind==='reload'){const p=action.elapsed/action.duration;if(p>.35&&action.stage===0){action.stage=1;audio.reload(weaponConfig.id,'magazine');}if(p>.82&&action.stage===1){action.stage=2;audio.reload(weaponConfig.id,'bolt');}}
  if (action.elapsed < action.duration) return;
  const completed = action; action = null;
  if (completed.kind === 'reload') { const count = Math.min(player.kit.magazine-player.ammo,player.reserve); player.ammo += count; player.reserve -= count; }
  if (completed.kind === 'heal') { player.health = Math.min(100, player.health + 65); player.medkits--; audio.play('heal'); toast('治疗完成 · 恢复 65 生命'); }
  if (completed.kind === 'search') { keys.delete('KeyE'); searchCrate(completed.crate); }
  if (completed.kind === 'extract') finishRaid(true, '物资已安全送达基地');
}

function addTracer(from,to,color = 0xffcb81) {
  combatEffects.trace(from.clone(),to.clone(),color,weaponConfig.id==='heavy'?.11:.065);
}
function shoot(pressed=false) {
  if (state !== 'hud' || action || nextShot > 0 || player.sprinting) return;
  if(needsTriggerRelease(weaponConfig,fireMode)&&!pressed)return;
  nextShot=weaponConfig.interval;
  if (player.ammo <= 0) { audio.play('empty'); startReload(); return; }
  player.ammo--;audio.shot(weaponConfig.id);recoil=Math.min(.15,recoil+weaponConfig.recoil*(aiming?.58:1));shotKick=weaponConfig.kick;shotAge=0;
  muzzle.intensity=weaponConfig.flashSize*19;muzzleFlash.visible=true;
  const flash=weaponConfig.flashSize/.13;muzzleFlash.scale.set(flash*(.6+Math.random()*.4),flash*(.6+Math.random()*.4),flash*(1.9+Math.random()));
  camera.updateMatrixWorld(true); scene.updateMatrixWorld(true);
  const direction = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
  const spread=(aiming?weaponConfig.adsSpread:player.moving?weaponConfig.moveSpread:weaponConfig.hipSpread)*(player.crouching?.72:1)+recoil*.025;
  direction.x += (Math.random()-.5)*spread; direction.y += (Math.random()-.5)*spread; direction.z += (Math.random()-.5)*spread; direction.normalize();
  ray.set(camera.position,direction);ray.far=weaponConfig.range;ray.near=.1;
  const meshes = enemies.filter(e => e.alive).flatMap(e => [...e.bodyMeshes,...e.headMeshes]);
  const hits = ray.intersectObjects([...world.blockers,...meshes],false);
  const point = hits[0]?.point || camera.position.clone().addScaledVector(direction,weaponConfig.range);
  addTracer(weapon.localToWorld(weapon.userData.muzzle.clone()),point,weaponConfig.tracerColor);combatEffects.shot(weapon,weaponConfig,camera);
  if (hits[0]) {
    const enemy = hits[0].object.userData.enemy;
    const normal=hits[0].face?.normal.clone().transformDirection(hits[0].object.matrixWorld);
    combatEffects.impact(point,normal,hits[0].object.material?.metalness>.2,!!enemy);
    if (enemy) {
      const headshot = hits[0].object.userData.headshot;
      enemy.health-=damageAtDistance(weaponConfig,player.kit.damage,hits[0].distance)*(headshot?2.15:1);enemy.hit=1;enemy.reposition=0;
      audio.foley('pain',.4*clamp(1-distance(enemy,player)/40,.1,1));
      enemy.alert = true; enemy.lastKnown = {x:player.x,z:player.z}; enemy.memory = 12;
      hitTime = .15; $('hitmarker').classList.toggle('headshot',headshot); audio.play('hit');
      if (enemy.health <= 0) killEnemy(enemy,headshot);
    }
  }
  for (const enemy of enemies) if (enemy.alive && distance(enemy,player) < weaponConfig.noiseRadius) { enemy.alert = true; enemy.lastKnown = {x:player.x,z:player.z}; enemy.memory = 12; }
}
function killEnemy(enemy,headshot) {
  if (!enemy.alive) return;
  enemy.alive=false;enemy.deathTime=0;enemy.path=[];enemy.behavior='fallen';
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

function repositionGuard(enemy,takeCover=false) {
  const toward=Math.atan2(player.x-enemy.x,player.z-enemy.z),side=enemy.index%2?1:-1;
  let goal=null;
  if(takeCover){
    let best=Infinity;
    for(const s of world.solids){if(s.height<1.4||s.maxX-s.minX>40||s.maxZ-s.minZ>40)continue;
      const midX=(s.minX+s.maxX)/2,midZ=(s.minZ+s.maxZ)/2;
      for(const p of [{x:s.minX-.95,z:midZ},{x:s.maxX+.95,z:midZ},{x:midX,z:s.minZ-.95},{x:midX,z:s.maxZ+.95}]){
        const d=distance(p,enemy);if(d>9||d<1||isBlocked(p.x,p.z,world.solids,.55)||lineClear(player,p,1.3))continue;
        if(d<best){goal=p;best=d;}
      }
    }
  }
  if(!goal){
    for(const sign of [side,-side]){const p={x:enemy.x+Math.cos(toward)*sign*(2+Math.random()*1.5),z:enemy.z-Math.sin(toward)*sign*(2+Math.random()*1.5)};
      if(!isBlocked(p.x,p.z,world.solids,.55)&&Math.abs(p.x)<46&&Math.abs(p.z)<46){goal=p;break;}}
  }
  enemy.path=goal?navigation.path(enemy,goal):[];enemy.reposition=3+Math.random()*2;enemy.behavior=takeCover&&goal?'cover':'reposition';enemy.pathTimer=1.5;
}
function updateEnemies(dt) {
  for (const enemy of enemies) {
    if(state!=='hud')continue;
    if(!enemy.alive){
      enemy.deathTime+=dt;const t=clamp(enemy.deathTime/.85,0,1),fall=THREE.MathUtils.smoothstep(t,0,1);
      enemy.group.rotation.z=(enemy.index%2?1:-1)*fall*1.4;enemy.group.position.y=fall*.27;
      animateSoldier(enemy,dt,{time:elapsed+enemy.phase,dead:enemy.deathTime});continue;
    }
    const dist = distance(enemy,player);
    enemy.cooldown-=dt;enemy.pathTimer-=dt;enemy.memory-=dt;enemy.patrolTimer-=dt;enemy.reposition-=dt;enemy.hit=Math.max(0,enemy.hit-dt*3.5);enemy.shot=Math.max(0,enemy.shot-dt*8);
    const awareness = player.sprinting ? 29 : player.crouching ? 16 : 24;
    const visible = dist < awareness && lineClear(enemy,player,player.crouching ? .85 : 1.3);
    const heading=enemy.group.rotation.y+(enemy.rig?.head.rotation.y||0),facing=(Math.sin(heading)*(player.x-enemy.x)+Math.cos(heading)*(player.z-enemy.z))/Math.max(.1,dist);
    if(visible&&(enemy.alert||facing>.2||dist<5)){enemy.notice+=dt;if(enemy.notice>=enemy.reaction){enemy.alert=true;enemy.lastKnown={x:player.x,z:player.z};enemy.memory=9;}}
    else enemy.notice=Math.max(0,enemy.notice-dt*2);
    if(enemy.memory<=0&&enemy.alert){enemy.alert=false;enemy.path=[];enemy.burst=0;enemy.patrolTimer=1.2;}
    enemy.ready=THREE.MathUtils.damp(enemy.ready,enemy.alert?1:0,4,dt);
    let desiredYaw=enemy.group.rotation.y;
    if (enemy.alert && enemy.lastKnown) {
      desiredYaw=Math.atan2(enemy.lastKnown.x-enemy.x,enemy.lastKnown.z-enemy.z);
      if(enemy.hit>.45&&enemy.reposition<=0)repositionGuard(enemy,true);
      else if(visible&&dist<22&&enemy.reposition<=0)repositionGuard(enemy,false);
      else if(!visible&&enemy.pathTimer<=0){enemy.path=navigation.path(enemy,enemy.lastKnown);enemy.pathTimer=1.5+enemy.index*.07;enemy.behavior='search';}
      const targetAngle=Math.atan2(player.x-enemy.x,player.z-enemy.z),aimDelta=Math.atan2(Math.sin(targetAngle-enemy.group.rotation.y),Math.cos(targetAngle-enemy.group.rotation.y));
      if(visible&&dist<26&&enemy.ready>.7&&Math.abs(aimDelta)<.24&&enemy.cooldown<=0&&enemy.hit<.35){
        if(enemy.burst<=0)enemy.burst=2+(Math.random()<.25?1:0);enemy.burst--;
        enemy.cooldown=enemy.burst>0?.18:1.6+Math.random()*.8;enemy.shot=1;enemy.behavior='engage';
        enemy.group.updateMatrixWorld(true);
        const rifle=enemy.rig?.rifle,from=rifle?.userData.muzzle?rifle.localToWorld(rifle.userData.muzzle.clone()):new THREE.Vector3(enemy.x,1.36,enemy.z),to=camera.position.clone();
        const chance=clamp(.5-dist*.009-(player.sprinting?.16:0)-(player.crouching?.06:0),.12,.48);
        const hit = Math.random() < chance;
        if (!hit) to.add(new THREE.Vector3((Math.random()-.5)*2.5,.5,0));
        addTracer(from,to,0xff875c);audio.enemyShot('tactical',dist);combatEffects.smoke(from,.045,.3);
        if(hit)hurt(7+Math.random()*4);
      }
    } else if(enemy.patrolTimer<=0&&enemy.path.length===0){
      enemy.patrolTimer=4+Math.random()*4;enemy.behavior='patrol';
      const angle = Math.random()*Math.PI*2, r = 4+Math.random()*5;
      enemy.path = navigation.path(enemy,{x:clamp(enemy.home.x+Math.sin(angle)*r,-45,45),z:clamp(enemy.home.z+Math.cos(angle)*r,-45,45)});
    }
    const previous={x:enemy.x,z:enemy.z};
    const moveTarget=enemy.path.length&&enemy.hit<.5 ? enemy.alert?(visible?1.65:2.45):1.15:0;
    enemy.speed=THREE.MathUtils.damp(enemy.speed,moveTarget,5,dt);
    if(enemy.path.length&&enemy.hit<.5){
      const target = enemy.path[0], d = distance(enemy,target);
      if(d<.55){enemy.path.shift();if(!enemy.path.length&&!enemy.alert){enemy.patrolTimer=1.2+Math.random()*2.2;enemy.behavior='observe';}}
      else {
        const dx=(target.x-enemy.x)/d,dz=(target.z-enemy.z)/d;
        moveWithCollision(enemy,dx*dt*enemy.speed,dz*dt*enemy.speed,world.solids,.42);
        if(!visible||!enemy.alert)desiredYaw=Math.atan2(dx,dz);
      }
    }
    const delta=Math.atan2(Math.sin(desiredYaw-enemy.group.rotation.y),Math.cos(desiredYaw-enemy.group.rotation.y)),turn=clamp(delta*(1-Math.exp(-dt*7)),-dt*3.4,dt*3.4);
    enemy.group.rotation.y+=turn;
    enemy.group.position.x=enemy.x; enemy.group.position.z=enemy.z;
    const velocityX=(enemy.x-previous.x)/Math.max(dt,.001),velocityZ=(enemy.z-previous.z)/Math.max(dt,.001),bodyYaw=enemy.group.rotation.y;
    animateSoldier(enemy,dt,{time:elapsed+enemy.phase,speed:Math.hypot(velocityX,velocityZ),moveX:Math.cos(bodyYaw)*velocityX-Math.sin(bodyYaw)*velocityZ,moveZ:Math.sin(bodyYaw)*velocityX+Math.cos(bodyYaw)*velocityZ,alert:enemy.alert,aimPitch:visible?Math.atan2(camera.position.y-1.4,Math.max(1,dist)):0,turn:turn/Math.max(dt,.001),hit:Math.max(enemy.hit,enemy.shot*.2),dead:null});
  }
}

function updatePlayer(dt) {
  const stick = touchControls?.movement || { x: 0, y: 0 };
  const forward = clamp(Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown')) - stick.y, -1, 1);
  const side = clamp(Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')) + stick.x, -1, 1);
  player.moving = Math.hypot(forward,side) > .02;
  player.crouching = keys.has('KeyC') || touchToggles.crouch;
  player.sprinting = player.moving && forward > .1 && (keys.has('ShiftLeft') || touchToggles.sprint) && player.stamina > 1 && !aiming && !player.crouching && (!action || action.kind === 'heal');
  player.stamina = clamp(player.stamina + (player.sprinting ? -23 : 16)*dt,0,100);
  const speed = player.sprinting ? 7 : player.crouching ? 2 : aiming ? 2.5 : 4.2;
  const normal = Math.max(1,Math.hypot(forward,side));
  const dx = (Math.cos(yaw)*side - Math.sin(yaw)*forward) / normal;
  const dz = (-Math.sin(yaw)*side - Math.cos(yaw)*forward) / normal;
  moveWithCollision(player,dx*speed*dt,dz*speed*dt,world.solids,.38);
  player.x = clamp(player.x,-48,48); player.z=clamp(player.z,-48,48);
  motionEnvelope=THREE.MathUtils.damp(motionEnvelope,player.moving?1:0,8,dt);gaitPhase+=dt*(player.sprinting?15:player.crouching?7:10)*motionEnvelope;
  const bob=Math.sin(gaitPhase)*(player.crouching?.014:player.sprinting?.043:.024)*motionEnvelope;
  camera.position.x=player.x; camera.position.z=player.z;
  camera.position.y=THREE.MathUtils.damp(camera.position.y,(player.crouching?1.04:1.68)+bob+Math.sin(elapsed*1.6)*.002,14,dt);
  recoil=Math.max(0,recoil-dt*(weaponConfig.id==='heavy'?.2:.27));shotKick=THREE.MathUtils.damp(shotKick,0,18,dt);shotAge+=dt;
  viewRoll=THREE.MathUtils.damp(viewRoll,-side*.014*motionEnvelope*(aiming?.3:1),8,dt);
  camera.rotation.set(pitch+recoil,yaw,viewRoll);
  const fov=aiming?weaponConfig.adsFov:player.sprinting?83:76;
  camera.fov = THREE.MathUtils.damp(camera.fov,fov,12,dt); camera.updateProjectionMatrix();
  weaponSway.multiplyScalar(Math.exp(-dt*10));
  const reloadPose = action?.kind === 'reload' ? Math.sin(Math.PI*clamp(action.elapsed/action.duration,0,1)) : 0;
  const breath = Math.sin(elapsed*1.8)*.0025;
  const drift = aiming ? .08 : 1;
  const carry = player.sprinting ? .12 : 0;
  weapon.position.set(THREE.MathUtils.damp(weapon.position.x,(aiming ? 0 : .24)+weaponSway.x*drift+Math.cos(gaitPhase*.5)*.008*motionEnvelope*drift,14,dt),THREE.MathUtils.damp(weapon.position.y,(aiming ? -.192 : -.29)+breath*drift-carry-reloadPose*.11,14,dt) - Math.abs(bob)*.18*drift, THREE.MathUtils.damp(weapon.position.z,(aiming ? -.65 : -.7)+reloadPose*.12+shotKick,20,dt));
  weapon.rotation.set(THREE.MathUtils.damp(weapon.rotation.x,-reloadPose*.48-(player.sprinting ? .28 : 0)+weaponSway.y*drift,14,dt),THREE.MathUtils.damp(weapon.rotation.y,weaponSway.x*drift*.5,14,dt),THREE.MathUtils.damp(weapon.rotation.z,action?.kind==='heal' ? -.7 : reloadPose*.45-(player.sprinting ? .2 : 0),14,dt));
  for(const [name,part] of Object.entries(weapon.userData.parts||{})){
    if(!part?.isObject3D||name==='casingEject')continue;
    const pos=part.userData.restPosition??=part.position.clone(),rot=part.userData.restRotation??=part.rotation.clone();part.position.copy(pos);part.rotation.copy(rot);
    if(name==='magazine'){part.position.y-=reloadPose*.25;part.rotation.x+=reloadPose*.2;}
    if(name==='bolt'){part.position.z+=Math.exp(-shotAge*28)*.038+(action?.kind==='reload'&&action.elapsed/action.duration>.8?Math.sin((action.elapsed/action.duration-.8)*Math.PI*5)*.045:0);}
    if(name==='leftHand'){part.position.x-=reloadPose*.08;part.position.y-=reloadPose*.14;part.position.z+=reloadPose*.14;part.rotation.z-=reloadPose*.28;}
    if(name==='rightHand')part.rotation.x-=Math.exp(-shotAge*32)*.022;
  }
  footstep -= dt;
  if(player.moving&&footstep<=0){footstep=player.sprinting?.28:player.crouching?.58:.44;audio.foley(player.sprinting?'sprint':'walk',player.crouching?.45:1);}
  nextShot = Math.max(0,nextShot-dt);
  if (mouseDown && (touchControls?.enabled || document.pointerLockElement === renderer.domElement)) shoot();
}

function drawMap(canvas, large = false) {
  const ctx=canvas.getContext('2d'), width=canvas.width, height=canvas.height;
  const padding=large?38:12, scale=(width-padding*2)/100;
  const px=x=>padding+(x+50)*scale, pz=z=>padding+(z+50)*scale;
  const cacheKey=`${width}:${height}:${large}`;
  if(!mapBackgrounds.has(cacheKey)) {
    const background=document.createElement('canvas'); background.width=width; background.height=height;
    const b=background.getContext('2d'), sea=b.createLinearGradient(0,0,width,height);
    sea.addColorStop(0,'#10272d');sea.addColorStop(1,'#193c42');b.fillStyle=sea;b.fillRect(0,0,width,height);
    b.strokeStyle='#41616b33';b.lineWidth=1;
    for(let row=8;row<height;row+=12){b.beginPath();b.moveTo(0,row);b.lineTo(width,row-14);b.stroke();}
    b.shadowColor='#0009';b.shadowBlur=large?14:5;
    b.fillStyle='#2a3b3b';b.fillRect(px(-49),pz(-49),98*scale,98*scale);b.shadowBlur=0;
    b.strokeStyle='#758b7960';b.strokeRect(px(-49),pz(-49),98*scale,98*scale);
    const roads=[[0,23,11,53],[14,-17,9,56],[-4,-36,91,8],[-1,9,91,8],[-1,35,91,7]];
    b.fillStyle='#415152';
    for(const [x,z,w,d] of roads)b.fillRect(px(x-w/2),pz(z-d/2),w*scale,d*scale);
    b.strokeStyle='#bac3a455';b.lineWidth=large?1.2:.7;b.setLineDash([3*scale,2*scale]);
    for(const [x,z,w,d] of roads){b.beginPath();b.moveTo(px(w>d?x-w/2:x),pz(w>d?z:z-d/2));b.lineTo(px(w>d?x+w/2:x),pz(w>d?z:z+d/2));b.stroke();}b.setLineDash([]);
    b.strokeStyle='#c3d6c210';b.lineWidth=1;
    for(let a=-50;a<=50;a+=10){b.beginPath();b.moveTo(px(a),pz(-49));b.lineTo(px(a),pz(49));b.stroke();b.beginPath();b.moveTo(px(-49),pz(a));b.lineTo(px(49),pz(a));b.stroke();}
    for(const s of world.solids){
      const w=s.maxX-s.minX,d=s.maxZ-s.minZ;if(w>95||d>95)continue;
      b.fillStyle=w*d>50?'#71847d':'#596e68';b.strokeStyle='#a1b5a866';b.lineWidth=large?1:.6;
      b.fillRect(px(s.minX),pz(s.minZ),w*scale,d*scale);b.strokeRect(px(s.minX),pz(s.minZ),w*scale,d*scale);
      if(large&&w*d>50){b.strokeStyle='#152a2a30';for(let x=s.minX+2;x<s.maxX;x+=3){b.beginPath();b.moveTo(px(x),pz(s.minZ));b.lineTo(px(x),pz(s.maxZ));b.stroke();}}
    }
    b.fillStyle='#afc1ac';b.font=`${large?12:9}px sans-serif`;b.textAlign='center';b.fillText('N ↑',width/2,large?22:10);
    if(large){
      for(const zone of world.zones){if(distance(zone,world.extract)<16)continue;b.fillStyle='#162e31df';const x=px(zone.x),y=pz(zone.z)-13;b.fillRect(x-43,y-12,86,19);b.fillStyle='#d2dcc9';b.fillText(zone.name,x,y+1);}
      b.font='10px monospace';b.fillStyle='#a4bdb2';
      for(let a=-40;a<=40;a+=20){b.fillText(String(a),px(a),height-14);b.fillText(String(a),15,pz(a)+3);}
      b.textAlign='left';b.fillStyle='#a4bdb2';b.fillRect(width-95,height-24,10*scale,2);b.fillText('10 m',width-95,height-30);
    }
    mapBackgrounds.set(cacheKey,background);
  }
  ctx.clearRect(0,0,width,height);ctx.drawImage(mapBackgrounds.get(cacheKey),0,0);
  if(player){
    if(!mapRoute||elapsed-mapRoute.time>2||distance(player,mapRoute.start)>1.5){mapRoute={time:elapsed,start:{x:player.x,z:player.z},points:navigation.path(player,world.extract)};}
    ctx.strokeStyle=large?'#95eac399':'#95eac355';ctx.lineWidth=large?2:1;ctx.setLineDash(large?[5,5]:[2,3]);
    ctx.beginPath();ctx.moveTo(px(player.x),pz(player.z));for(const p of mapRoute.points)ctx.lineTo(px(p.x),pz(p.z));ctx.stroke();ctx.setLineDash([]);
  }
  ctx.fillStyle='#88e5b622';ctx.strokeStyle='#88e5b6';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.arc(px(world.extract.x),pz(world.extract.z),world.extract.radius*scale,0,Math.PI*2);ctx.fill();ctx.stroke();
  ctx.fillStyle='#a3f3bf';
  ctx.fillRect(px(world.extract.x)-2,pz(world.extract.z)-2,4,4);
  for(const crate of crates){if(crate.empty)continue;ctx.fillStyle=crate.tier===3?'#edbd72':'#bdcdc1';const size=large?6:3;ctx.save();ctx.translate(px(crate.x),pz(crate.z));ctx.rotate(Math.PI/4);ctx.fillRect(-size/2,-size/2,size,size);ctx.restore();}
  if(player){
    for(const enemy of enemies){if(!enemy.alive||distance(enemy,player)>22)continue;ctx.fillStyle=enemy.alert?'#ff785f':'#be7864';ctx.beginPath();ctx.arc(px(enemy.x),pz(enemy.z),large?3.5:2.5,0,Math.PI*2);ctx.fill();}
    ctx.save();ctx.translate(px(player.x),pz(player.z));ctx.rotate(-yaw);
    ctx.fillStyle='#d7f9e213';ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,large?31:16,-Math.PI/2-.52,-Math.PI/2+.52);ctx.closePath();ctx.fill();
    ctx.fillStyle='#eaf9f3';ctx.strokeStyle='#153b36';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,-7);ctx.lineTo(-4.5,5);ctx.lineTo(0,3);ctx.lineTo(4.5,5);ctx.closePath();ctx.stroke();ctx.fill();ctx.restore();
  }
  ctx.font='12px sans-serif';ctx.textAlign='center';
  if(large){
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
  $('weapon-name').textContent=weaponConfig.name;
  $('fire-mode').textContent=fireMode==='semi'?'单发':'自动';$('fire-mode-hint').hidden=weaponConfig.fireModes.length<2;
  $('touch-mode-button').hidden=weaponConfig.fireModes.length<2;
  ($('touch-mode-button').querySelector('.touch-button-label')||$('touch-mode-button')).textContent=fireMode==='semi'?'单发':'自动';
  $('touch-interact-button').querySelector('.touch-button-label').textContent=nearest?.kind==='extract'?'撤离':'搜索';
  $('touch-interact-button').classList.toggle('available',!!nearest);
  $('touch-interact-button').setAttribute('aria-label',nearest?.kind==='extract'?'长按撤离':'长按搜索');
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
  if(nearest)$('interact-prompt').innerHTML=`<kbd>${touchControls?.enabled?`按住${nearest.kind==='extract'?'撤离':'搜索'}按钮`:'长按 E'}</kbd> ${nearest.kind==='extract'?'呼叫撤离 · 坚守 6 秒':`搜索 ${nearest.label}`}<small>${nearest.kind==='extract'?'松开、移动或受到攻击会中断':'获得物资与弹药补给'}</small>`;
  $('action-progress').hidden=!action;
  if(action){$('action-fill').style.width=`${clamp(action.elapsed/action.duration*100,0,100)}%`;$('action-label').textContent=`${({reload:'正在换弹',heal:'正在治疗',search:'正在搜索',extract:'正在撤离'})[action.kind]}　${Math.max(0,action.duration-action.elapsed).toFixed(1)} s`;}
  $('crosshair').classList.toggle('aiming',aiming);$('crosshair').classList.toggle('sprinting',player.sprinting);
  $('hitmarker').hidden=hitTime<=0;$('hitmarker').style.opacity=hitTime>0?'1':'0';
  $('damage-overlay').style.opacity=String(Math.max(hurtTime*.85,player.health<30?.14:0));
  drawMap($('minimap'));
}

function renderInventory() {
  $('inventory-weight').textContent=`${currentWeight()} / ${player.kit.capacity} KG · 撤离估值 ₵ ${money(lootValue())}`;
  $('inventory-items').innerHTML=player.loot.length?player.loot.map((item,i)=>`<div class="loot-row rarity-${item.rarity}"><span class="loot-icon">◇</span><span><strong>${item.name}</strong><small>${item.weight} KG</small></span><b>₵ ${money(item.value)}</b><button class="drop-item" data-drop="${i}" aria-label="丢弃${item.name}">丢弃</button></div>`).join(''):`<p class="empty-state">背包为空。靠近发光的物资箱，${touchControls?.enabled?'按住搜索按钮':'长按 E'}搜索。</p>`;
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
function resetInput() {
  keys.clear(); mouseDown=false; aiming=false;
  touchToggles.sprint=false; touchToggles.crouch=false;
  touchControls?.reset();
}
function switchFireMode() {
  if(state!=='hud'||weaponConfig.fireModes.length<2||action)return;
  fireMode=nextFireMode(weaponConfig,fireMode);mouseDown=false;
  touchControls?.setPressed('fire',false);
  audio.reload(weaponConfig.id,'bolt');
  toast(`射击模式：${fireMode==='semi'?'单发点射':'全自动'}${touchControls?.enabled?'':' · B 切换'}`);
  updateHUD();
}
function moveView(dx,dy,touch=false) {
  const sensitivity=(touch?.0032:.0021)*settings.sensitivity*(aiming?.62:1);
  yaw-=dx*sensitivity;pitch=clamp(pitch-dy*sensitivity,-1.45,1.45);
  weaponSway.x=clamp(weaponSway.x-dx*.00018,-.025,.025);
  weaponSway.y=clamp(weaponSway.y-dy*.00014,-.018,.018);
}
function pressTouch(actionName) {
  if(state!=='hud')return;
  audio.unlock();
  if(actionName==='fire'){
    touchToggles.sprint=false;touchControls.setPressed('sprint',false);player.sprinting=false;
    mouseDown=true;if(action?.kind==='heal')action=null;shoot(true);
  }
  if(actionName==='interact')keys.add('KeyE');
  if(actionName==='aim'){
    aiming=!aiming;touchControls.setPressed('aim',aiming);
    if(aiming){touchToggles.sprint=false;touchControls.setPressed('sprint',false);player.sprinting=false;}
  }
  if(actionName==='sprint'){
    touchToggles.sprint=!touchToggles.sprint;touchControls.setPressed('sprint',touchToggles.sprint);
    if(touchToggles.sprint){aiming=false;touchToggles.crouch=false;touchControls.setPressed('aim',false);touchControls.setPressed('crouch',false);}
  }
  if(actionName==='crouch'){
    touchToggles.crouch=!touchToggles.crouch;touchControls.setPressed('crouch',touchToggles.crouch);
    if(touchToggles.crouch){touchToggles.sprint=false;touchControls.setPressed('sprint',false);}
  }
  if(actionName==='reload')startReload();
  if(actionName==='heal')startHeal();
  if(actionName==='mode')switchFireMode();
  if(actionName==='inventory')openOverlay('inventory');
  if(actionName==='map')openOverlay('map-overlay');
  if(actionName==='pause')pause();
  if(actionName==='fullscreen')toggleFullscreen();
}
function releaseTouch(actionName) {
  if(actionName==='fire')mouseDown=false;
  if(actionName==='interact')keys.delete('KeyE');
}
function resizeViewport() {
  const width=$('viewport').clientWidth||innerWidth,height=$('viewport').clientHeight||innerHeight;
  camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height);
}
async function toggleFullscreen() {
  audio.unlock();
  try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
  catch{toast('可以直接在浏览器中游玩，横屏视野更宽。');}
}
function applySettings() {
  audio.volume=settings.volume;
  audio.musicVolume=settings.musicVolume;
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
$('sensitivity').value=settings.sensitivity;$('volume').value=settings.volume;$('music-volume').value=settings.musicVolume;$('quality').value=settings.quality;
for(const id of ['sensitivity','volume','music-volume','quality'])$(id).addEventListener('input',()=>{settings[id==='music-volume'?'musicVolume':id]=id==='quality'?$(id).value:Number($(id).value);applySettings();});
document.addEventListener('pointerdown',()=>audio.unlock(),{capture:true,once:true});

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
  if(event.code==='KeyB')switchFireMode();
  if(event.code==='Tab')openOverlay('inventory');
  if(event.code==='KeyM')openOverlay('map-overlay');
});
window.addEventListener('keyup',event=>keys.delete(event.code));
window.addEventListener('mousemove',event=>{
  if(state!=='hud'||document.pointerLockElement!==renderer.domElement)return;
  moveView(event.movementX,event.movementY);
});
renderer.domElement.addEventListener('mousedown',event=>{
  if(state!=='hud'||touchControls?.enabled||event.sourceCapabilities?.firesTouchEvents)return;
  audio.unlock();
  if(document.pointerLockElement!==renderer.domElement){lockPointer();return;}
  if(event.button===0){mouseDown=true;if(action?.kind==='heal')action=null;shoot(true);}
  if(event.button===2)aiming=true;
});
window.addEventListener('mouseup',event=>{if(touchControls?.enabled||event.sourceCapabilities?.firesTouchEvents)return;if(event.button===0)mouseDown=false;if(event.button===2)aiming=false;});
window.addEventListener('contextmenu',event=>event.preventDefault());
document.addEventListener('pointerlockchange',()=>{if(!document.pointerLockElement&&!touchControls?.enabled&&state==='hud')pause();});
window.addEventListener('blur',()=>{resetInput();pause();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
window.addEventListener('resize',()=>{if(touchControls?.enabled)resetInput();resizeViewport();});
window.visualViewport?.addEventListener('resize',resizeViewport);
window.addEventListener('orientationchange',resetInput);

touchControls=new TouchControls({
  root:$('touch-controls'),joystick:$('touch-joystick'),knob:$('touch-knob'),look:$('touch-look'),
  onLook:(dx,dy)=>{if(state==='hud')moveView(dx,dy,true);},onPress:pressTouch,onRelease:releaseTouch,
  onMode:enabled=>{
    document.body.classList.toggle('touch-mode',enabled);
    $('touch-controls').hidden=!enabled||state!=='hud';touchControls.setActive(state==='hud');
    if(enabled&&document.pointerLockElement)document.exitPointerLock();
  },
});
document.body.classList.toggle('touch-mode',touchControls.enabled);
$('touch-fullscreen').hidden=typeof document.documentElement.requestFullscreen!=='function';
$('touch-fullscreen').dataset.touchAction='fullscreen';
$('touch-fullscreen').onclick=toggleFullscreen;
renderer.domElement.addEventListener('webglcontextlost',()=>{pause();toast('画面暂时中断，恢复后可继续行动。');});
renderer.domElement.addEventListener('webglcontextrestored',()=>toast('画面已恢复，点击继续行动。'));

function animate(now) {
  requestAnimationFrame(animate);
  const dt=Math.min(.05,Math.max(0,(now-lastFrame)/1000));lastFrame=now;lobbyTime+=dt;
  world.animate?.(lobbyTime);
  if(state==='hud'&&player){
    elapsed+=dt;raidTime=Math.max(0,480-elapsed);
    updatePlayer(dt);updateAction(dt);updateEnemies(dt);
    hitTime=Math.max(0,hitTime-dt);hurtTime=Math.max(0,hurtTime-dt);muzzle.intensity=Math.max(0,muzzle.intensity-dt*38);
    muzzleFlash.visible=muzzle.intensity>1;
    if(raidTime<=0)finishRaid(false,'行动窗口已关闭，未在时限内撤离');
    if(elapsed>35&&hintAt===0){hintAt=1;toast(`${touchControls?.enabled?'点地图按钮':'按 M'}查看地图。金色物资箱价值更高，绿色圆圈是撤离点。`);}
    if(raidTime<60&&hintAt<2){hintAt=2;toast('剩余时间不足 1 分钟，立即前往北岸撤离区！','warn');}
    uiTime+=dt;if(uiTime>.07){uiTime=0;updateHUD();}
  }else if(state==='lobby'||(state==='help'&&overlayReturn==='lobby')||(state==='settings'&&overlayReturn==='lobby')){
    const angle=.45+Math.sin(lobbyTime*.07)*.11;
    camera.position.set(58*Math.sin(angle),28,58*Math.cos(angle));camera.lookAt(-3,1,-8);camera.fov=58;camera.updateProjectionMatrix();
  }
  const threat=player&&state==='hud' ? clamp(enemies.reduce((sum,e)=>sum+(e.alive&&e.alert ? clamp(1-distance(e,player)/40,0,1)*.55 : 0),0),0,1) : 0;
  audio.update(dt,{threat,extracting:action?.kind==='extract',paused:state!=='hud'&&state!=='lobby'&&state!=='result'&&!!player});
  for(const crate of crates){crate.beacon.rotation.y=lobbyTime*1.4;crate.beacon.position.y=1.3+Math.sin(lobbyTime*2+crate.x)*.1;}
  if(state==='hud'||state==='lobby')combatEffects.update(dt);
  renderer.render(scene,camera);
}
applySettings();resizeViewport();renderLobby();setScreen('lobby');requestAnimationFrame(animate);

// Explicit development-only integration seam, eliminated from production builds.
if(import.meta.env.DEV&&new URLSearchParams(location.search).has('test')){
  window.__game={
    snapshot:()=>({state,profile:structuredClone(profile),settings:{...settings},audio:audio.getDiagnostics(),input:{touch:touchControls?.enabled??false,movement:touchControls?.movement??{x:0,y:0},aiming,firing:mouseDown,crouching:touchToggles.crouch||keys.has('KeyC'),sprinting:touchToggles.sprint||keys.has('ShiftLeft'),yaw,pitch},weapon:{id:weaponConfig.id,fireMode,fov:camera.fov,recoil,kick:shotKick,position:weapon.position.toArray(),muzzle:weapon.userData.muzzle.toArray(),particles:combatEffects.particles.length},player:player?{...player,loot:structuredClone(player.loot)}:null,raidTime,elapsed,action:action?.kind,actionProgress:action?{elapsed:action.elapsed,duration:action.duration}:null,reason:finishReason,enemies:enemies.map(e=>({x:e.x,z:e.z,alive:e.alive,health:e.health,yaw:e.group.rotation.y,roll:e.group.rotation.z,alert:e.alert,behavior:e.behavior,deathTime:e.deathTime,speed:e.speed,pose:e.rig?{head:e.rig.head.rotation.toArray().slice(0,3),knee:e.rig.left.knee.rotation.x,elbow:e.rig.left.elbow.rotation.x,torso:e.rig.torso.position.toArray()}:null})),crates:crates.map(c=>({x:c.x,z:c.z,tier:c.tier,empty:c.empty})),extract:world.extract,spawn:world.spawn,solids:world.solids,locked:!!document.pointerLockElement,renderer:renderer.info.render}),
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
