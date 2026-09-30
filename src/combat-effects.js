import * as THREE from 'three';

/** Bounded visual particles; none participate in gameplay collision or aiming. */
export class CombatEffects {
  constructor(scene) {
    this.scene=scene;this.particles=[];
    this.shellGeometry=new THREE.CylinderGeometry(.009,.009,.045,6);
    this.shellMaterial=new THREE.MeshStandardMaterial({color:0xbd9852,metalness:.7,roughness:.38});
    this.speckGeometry=new THREE.SphereGeometry(.014,4,3);
    const size=32,data=new Uint8Array(size*size*4);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4,r=Math.hypot((x-15.5)/15.5,(y-15.5)/15.5);data[i]=data[i+1]=data[i+2]=255;data[i+3]=Math.max(0,1-r)**2*180;}
    this.smokeTexture=new THREE.DataTexture(data,size,size);this.smokeTexture.needsUpdate=true;this.smokeTexture.magFilter=THREE.LinearFilter;
  }
  add(mesh,life,extra={}) {
    this.scene.add(mesh);this.particles.push({mesh,life,maxLife:life,...extra});
    if(this.particles.length>90)this.remove(0);
  }
  remove(index) {
    const [p]=this.particles.splice(index,1);this.scene.remove(p.mesh);
    if(p.mesh.geometry&&p.mesh.geometry!==this.shellGeometry&&p.mesh.geometry!==this.speckGeometry)p.mesh.geometry.dispose();
    if(p.mesh.material!==this.shellMaterial)p.mesh.material.dispose();
  }
  clear(){while(this.particles.length)this.remove(0);}
  trace(from,to,color=0xffcb81,life=.065) {
    const mesh=new THREE.Line(new THREE.BufferGeometry().setFromPoints([from,to]),new THREE.LineBasicMaterial({color,transparent:true,opacity:.72,depthWrite:false}));
    this.add(mesh,life,{fade:true});
  }
  smoke(point,size=.1,life=.7,color=0x91968f) {
    const mesh=new THREE.Sprite(new THREE.SpriteMaterial({map:this.smokeTexture,color,transparent:true,opacity:.35,depthWrite:false}));
    mesh.position.copy(point);mesh.scale.setScalar(size);
    this.add(mesh,life,{fade:true,growth:.18,velocity:new THREE.Vector3((Math.random()-.5)*.06,.12,(Math.random()-.5)*.06)});
  }
  shot(weapon,config,camera) {
    const part=weapon.userData.parts?.casingEject;
    const point=part?.isObject3D?part.getWorldPosition(new THREE.Vector3()):weapon.localToWorld((part?.isVector3?part:new THREE.Vector3(.085,.052,-.13)).clone());
    const shell=new THREE.Mesh(this.shellGeometry,this.shellMaterial);shell.position.copy(point);shell.rotation.copy(camera.rotation);
    const velocity=new THREE.Vector3(config.ejectionSpeed,1.1+Math.random()*.7,.4+Math.random()*.4).applyQuaternion(camera.quaternion);
    this.add(shell,2.4,{velocity,gravity:true,spin:new THREE.Vector3(5,8,3),bounced:false});
    this.smoke(weapon.localToWorld(weapon.userData.muzzle.clone()),config.flashSize*.45,config.id==='heavy'?.9:.55);
  }
  impact(point,normal,metal=false,actor=false) {
    const direction=normal?.clone()||new THREE.Vector3(0,1,0);
    this.smoke(point,.1,actor?.32:.6,actor?0x998d7b:0xaab0a4);
    for(let i=0;i<(metal?5:3);i++){
      const mesh=new THREE.Mesh(this.speckGeometry,new THREE.MeshBasicMaterial({color:metal?0xffd481:actor?0xa08d75:0xa8aaa1,transparent:true,depthWrite:false}));
      mesh.position.copy(point);mesh.scale.setScalar(metal?.6:1.4);
      const velocity=direction.clone().multiplyScalar(.5+Math.random()*1.4).add(new THREE.Vector3((Math.random()-.5)*1.6,Math.random()*1.2,(Math.random()-.5)*1.6));
      this.add(mesh,metal?.23:.38,{velocity,gravity:true,fade:true});
    }
  }
  update(dt) {
    for(let i=this.particles.length-1;i>=0;i--){
      const p=this.particles[i];p.life-=dt;
      if(p.life<=0){this.remove(i);continue;}
      if(p.fade)p.mesh.material.opacity=Math.max(0,p.life/p.maxLife)*(p.mesh.isSprite?.35:.72);
      if(p.velocity){if(p.gravity)p.velocity.y-=9.8*dt;p.mesh.position.addScaledVector(p.velocity,dt);
        if(p.gravity&&p.mesh.position.y<.045){p.mesh.position.y=.045;if(!p.bounced){p.velocity.y=Math.abs(p.velocity.y)*.22;p.velocity.x*=.4;p.velocity.z*=.4;p.bounced=true;}else{p.velocity.set(0,0,0);p.spin?.set(0,0,0);p.gravity=false;}}
      }
      if(p.spin){p.mesh.rotation.x+=p.spin.x*dt;p.mesh.rotation.y+=p.spin.y*dt;p.mesh.rotation.z+=p.spin.z*dt;}
      if(p.growth)p.mesh.scale.addScalar(p.growth*dt);
    }
  }
}
