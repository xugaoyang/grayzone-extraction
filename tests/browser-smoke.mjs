import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const candidates=[process.env.BROWSER_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
const executablePath=candidates.find(p=>existsSync(p));
if(!executablePath)throw new Error('Install Chrome/Edge or set BROWSER_PATH.');
mkdirSync('work',{recursive:true});
const browser=await chromium.launch({executablePath,headless:true,args:['--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required']});
const context=await browser.newContext({viewport:{width:1600,height:1000}});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const checks=[];
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);console.log('PASS',name);};
const snapshot=()=>page.evaluate(()=>window.__game.snapshot());
async function ensureActive(){const s=await snapshot();if(s.state==='pause')await page.click('#resume');await page.waitForFunction(()=>window.__game.snapshot().state==='hud');}
async function hold(code,ms){await page.keyboard.down(code);await page.waitForTimeout(ms);await page.keyboard.up(code);}
async function lootAt(index){
  await page.evaluate(i=>{const g=window.__game;const c=g.snapshot().crates[i];g.teleport(c.x,c.z+1.8);g.safe();},index);
  await page.waitForTimeout(200);await hold('KeyE',2300);
}
try{
  await page.goto((process.env.GAME_URL||'http://127.0.0.1:5173')+'/?test=1');
  await page.waitForFunction(()=>!!window.__game,{},{timeout:30000});
  check('lobby loads without JavaScript errors',errors.length===0);
  await page.screenshot({path:'work/lobby.png'});
  await page.click('#help-open');check('help opens',await page.isVisible('#help'));await page.click('#help-close');
  await page.click('#settings-open');await page.selectOption('#quality','low');await page.click('#settings-close');
  await page.click('#deploy');await ensureActive();await page.evaluate(()=>window.__game.safe());
  let s=await snapshot();check('raid starts with eight enemies and twelve loot points',s.enemies.length===8&&s.crates.length===12&&s.player.ammo===24);
  check('mouse capture succeeds',s.locked);
  await page.evaluate(()=>window.__game.look(0,0));await page.waitForTimeout(120);await page.screenshot({path:'work/deployment.png'});
  const startZ=s.player.z;await hold('KeyW',450);s=await snapshot();check('W input moves player through 3D world',s.player.z<startZ-1);
  await page.mouse.click(800,500);await page.waitForTimeout(180);s=await snapshot();check('shooting consumes ammunition',s.player.ammo<24);
  await page.keyboard.press('KeyR');await page.waitForTimeout(2300);s=await snapshot();check('reload transfers reserve to magazine',s.player.ammo===24&&s.player.reserve<96);
  await page.evaluate(()=>window.__game.damage(55));s=await snapshot();const hurtHealth=s.player.health;
  await page.keyboard.press('KeyF');await page.waitForTimeout(2900);s=await snapshot();check('medical kit restores health and is consumed',s.player.health>hurtHealth&&s.player.medkits===1);
  await page.evaluate(()=>window.__game.damage(5));await page.keyboard.press('KeyF');await page.waitForTimeout(180);
  await page.keyboard.down('ShiftLeft');await page.keyboard.down('KeyW');await page.waitForTimeout(250);await page.keyboard.up('KeyW');await page.keyboard.up('ShiftLeft');
  s=await snapshot();check('sprinting interrupts healing without consuming a kit',!s.action&&s.player.medkits===1);
  await lootAt(0);s=await snapshot();check('holding E searches real crate and adds loot',s.player.loot.length>=2);
  await lootAt(1);s=await snapshot();check('second search reaches contract target',s.player.loot.length>=3);
  await page.evaluate(()=>window.__game.look(0,-.03));await page.waitForTimeout(100);await page.screenshot({path:'work/gameplay.png'});
  await page.keyboard.press('Tab');check('inventory opens and pauses gameplay',await page.isVisible('#inventory'));const countBefore=s.player.loot.length;
  await page.locator('[data-drop]').first().click();s=await snapshot();check('inventory drop removes item and leaves world pickup',s.player.loot.length===countBefore-1&&s.crates.length===13);
  await page.keyboard.press('Tab');await ensureActive();
  await hold('KeyE',1000);s=await snapshot();check('dropped item can be recovered',s.player.loot.length===countBefore);
  await page.keyboard.press('KeyM');check('tactical map opens',await page.isVisible('#map-overlay'));await page.screenshot({path:'work/map.png'});await page.keyboard.press('KeyM');await ensureActive();
  await page.keyboard.press('Escape');await page.waitForTimeout(150);s=await snapshot();check('Escape pauses raid',s.state==='pause');
  const pausedTime=s.elapsed;await page.waitForTimeout(400);check('pause freezes raid timer',(await snapshot()).elapsed===pausedTime);
  await page.click('#pause-settings');await page.click('#settings-close');check('settings returns to pause',await page.isVisible('#pause'));await page.click('#resume');await ensureActive();
  // Aim at a live enemy through an unobstructed nearby position; use real mouse shots.
  for(let shot=0;shot<8&&(await snapshot()).player.kills===0;shot++){
    await page.evaluate(()=>{
      const g=window.__game,e=g.enemyTarget(0);const spots=[{x:e.x,z:e.z+3},{x:e.x,z:e.z-3},{x:e.x+3,z:e.z},{x:e.x-3,z:e.z}];
      const p=spots.find(p=>!g.blocked(p.x,p.z));g.teleport(p.x,p.z);g.look(Math.atan2(-(e.x-p.x),-(e.z-p.z)),Math.atan2(e.y-1.68,Math.hypot(e.x-p.x,e.z-p.z)));g.safe();
    });
    await page.waitForTimeout(280);await page.mouse.click(800,500);await page.waitForTimeout(230);
  }
  s=await snapshot();check('real raycast gunfire defeats a guard',s.player.kills>=1);
  const expectedLoot=s.player.loot.reduce((n,i)=>n+i.value,0),creditsBefore=s.profile.credits,kills=s.player.kills;
  await page.evaluate(()=>{const g=window.__game,e=g.snapshot().extract;g.teleport(e.x,e.z);g.safe();});
  await page.keyboard.press('Tab');const extractBagCount=(await snapshot()).player.loot.length;await page.locator('[data-drop]').first().click();await page.keyboard.press('Tab');await ensureActive();
  await page.evaluate(()=>window.__game.look(0,-1.3));await page.waitForTimeout(150);await hold('KeyE',1000);
  check('looking down recovers dropped loot inside extraction zone',(await snapshot()).player.loot.length===extractBagCount);
  await page.evaluate(()=>window.__game.look(0,0));
  await page.waitForTimeout(120);await hold('KeyE',1000);await page.waitForTimeout(100);s=await snapshot();check('releasing E cancels extraction',s.state==='hud'&&!s.action);
  await page.keyboard.down('KeyE');await page.waitForFunction(()=>window.__game.snapshot().state==='result',{},{timeout:15000});await page.keyboard.up('KeyE');
  s=await snapshot();check('six-second extraction completes and pays correct rewards',s.profile.credits===creditsBefore+expectedLoot+kills*100+800&&s.profile.stats.extracts===1);
  await page.screenshot({path:'work/extraction.png'});
  const settled=s.profile.credits;await page.waitForTimeout(300);check('result cannot settle twice',(await snapshot()).profile.credits===settled);
  await page.click('#return-lobby');await page.locator('[data-upgrade="pack"]').click();s=await snapshot();check('base upgrade spends cash and persists',s.profile.upgrades.pack===1&&s.profile.credits===settled-800);
  await page.locator('[data-kit="tactical"]').click();const beforePaid=s.profile.credits;await page.click('#deploy');await ensureActive();s=await snapshot();check('second deployment charges kit and applies permanent capacity',s.profile.credits===beforePaid-500&&s.player.kit.capacity===16);
  await page.evaluate(()=>window.__game.damage(1000));s=await snapshot();check('death settles failure without extra payout',s.state==='result'&&s.profile.stats.raids===2&&s.profile.stats.extracts===1&&s.profile.credits===beforePaid-500);
  await page.click('#return-lobby');await page.locator('[data-kit="basic"]').click();await page.click('#deploy');await ensureActive();await page.evaluate(()=>{window.__game.safe();window.__game.setElapsed(481);});
  await page.waitForFunction(()=>window.__game.snapshot().state==='result');s=await snapshot();check('raid timeout ends action as failure',s.profile.stats.raids===3&&s.reason.includes('时限'));
  const finalProfile=s.profile;await page.reload();await page.waitForFunction(()=>!!window.__game);s=await snapshot();check('profile survives reload',JSON.stringify(s.profile)===JSON.stringify(finalProfile));
  await page.setViewportSize({width:1280,height:720});await page.screenshot({path:'work/lobby-720.png'});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight);
  check('lobby fits 1280x720 viewport',!overflow);
  check('no browser runtime errors throughout complete loop',errors.length===0);
  writeFileSync('work/browser-results.json',JSON.stringify({passed:checks.length,checks,errors},null,2));
}catch(error){
  await page.screenshot({path:'work/browser-failure.png'}).catch(()=>{});
  writeFileSync('work/browser-results.json',JSON.stringify({passed:checks.length,checks,errors,failure:error.message,state:await snapshot().catch(()=>null)},null,2));
  throw error;
}finally{await browser.close();}
