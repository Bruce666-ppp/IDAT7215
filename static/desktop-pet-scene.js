import * as THREE from './vendor/three/build/three.module.min.js';
import {FBXLoader} from './vendor/three/examples/jsm/loaders/FBXLoader.js';
import {speciesConfig} from './desktop-pet-config.js';
import {NailongSpawnEffect} from './nailong-spawn-effect.js';

function fitActor(model, config){
    const aligned = new THREE.Group();
    const actor = new THREE.Group();
    aligned.add(model);
    aligned.rotation.y = config.yaw;
    const box = new THREE.Box3().setFromObject(aligned);
    const size = box.getSize(new THREE.Vector3());
    if (box.isEmpty() || !Number.isFinite(size.length())) throw Error('FBX has no usable mesh');
    aligned.scale.setScalar(Math.min(1.45/size.y,1.8/size.x,1.55/size.z));
    const fitted = new THREE.Box3().setFromObject(aligned);
    const center = fitted.getCenter(new THREE.Vector3());
    aligned.position.set(-center.x,-fitted.min.y,-center.z);
    actor.add(aligned);
    return actor;
}

function loadModel(species){
    const config = speciesConfig[species];
    const folder = new URL('./desktop-pets/'+species+'/', import.meta.url).href;
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url=>{
        if (url.startsWith('blob:') || url.startsWith('data:')) return url;
        const filename = url.replaceAll('\\','/').split('/').at(-1);
        return folder + encodeURIComponent(decodeURIComponent(filename));
    });
    const fbx = new FBXLoader(manager).setResourcePath(folder);
    if (config.nativeMaterial){
        const textureReady = new Promise((resolve,reject)=>{
            manager.onLoad = resolve;
            manager.onError = url=>reject(Error('Could not load '+url));
        });
        return Promise.all([fbx.loadAsync(folder+'model.fbx'),textureReady])
            .then(([model])=>fitActor(model,config));
    }
    const textures = new THREE.TextureLoader(manager);
    const load = name => textures.loadAsync(folder + encodeURIComponent(name));

    return Promise.all([
        fbx.loadAsync(folder+'model.fbx'), load('Color.jpg'), load('Normal.jpg'),
        load(config.texturePrefix+'_roughness.jpg'), load(config.texturePrefix+'_metallic.jpg'),
    ]).then(([model,color,normal,roughness,metalness])=>{
        color.colorSpace = THREE.SRGBColorSpace;
        const materials = new Map();
        function physical(source){
            if (!materials.has(source)){
                materials.set(source,new THREE.MeshStandardMaterial({
                    color:source.color, map:color, normalMap:normal, normalScale:source.normalScale,
                    roughness:1, roughnessMap:roughness, metalness:1, metalnessMap:metalness,
                    side:source.side,
                }));
            }
            return materials.get(source);
        }
        model.traverse(object=>{
            if (!object.isMesh) return;
            object.material = Array.isArray(object.material) ?
                object.material.map(physical) : physical(object.material);
        });

        return fitActor(model,config);
    });
}

function mesh(geometry,color){
    return new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color,roughness:0.83}));
}

function bowl(color){
    const group = new THREE.Group();
    const body = mesh(new THREE.CylinderGeometry(0.245,0.16,0.10,28),0x9b664b);
    body.position.y = 0.055;
    const contents = mesh(new THREE.CylinderGeometry(0.201,0.201,0.015,28),color);
    contents.position.y = 0.11;
    group.add(body,contents);
    group.position.set(0.63,0,0.58);
    return group;
}

function foodFor(type,config){
    const food = bowl(config.foodColor);
    if (type === 'rabbit'){
        const hay = new THREE.BoxGeometry(0.23,0.012,0.014);
        for (let index=0;index<12;index++){
            const strand = mesh(hay,index%2 ? 0xbba468 : 0xc9ad69);
            strand.position.set(Math.cos(index*1.4)*0.08,0.125+(index%3)*0.025,Math.sin(index*1.4)*0.10);
            strand.rotation.y = index*0.76;
            food.add(strand);
        }
        const pellet = new THREE.SphereGeometry(0.024,7,5);
        for (let index=0;index<3;index++){
            const piece = mesh(pellet,0x72633f);
            piece.position.set(-0.13+index*0.048,0.13,0.11);
            food.add(piece);
        }
    } else {
        const pellet = new THREE.SphereGeometry(0.031,8,6);
        for (let index=0;index<12;index++){
            const piece = mesh(pellet,index%2 ? config.foodColor : 0x8a502d);
            const radius = index%2 ? 0.09 : 0.15;
            piece.position.set(Math.cos(index*1.8)*radius,0.123,Math.sin(index*1.8)*radius);
            piece.scale.y = 0.66;
            food.add(piece);
        }
    }
    return food;
}

function toyFor(type,config){
    const group = new THREE.Group();
    group.add(mesh(new THREE.SphereGeometry(0.136,18,12),config.toyColor));
    const strands = type === 'dog' ? 2 : 6;
    const detail = type === 'dog' ? 0xf3edc8 : type === 'cat' ? 0xf0a395 : 0xa4a95d;
    for(let index=0;index<strands;index++){
        const ring = mesh(new THREE.TorusGeometry(0.129,0.006,6,24),detail);
        ring.rotation.set(Math.PI/3+index*0.4,index*0.63,index*0.4);
        ring.position.y = (index%2===0 ? 1 : -1)*0.017;
        group.add(ring);
    }
    return group;
}

function nailongProps(){
    const bubbles = new THREE.Group();
    const sphere = new THREE.SphereGeometry(0.08,12,8);
    const soap = new THREE.MeshStandardMaterial({
        color:0x84dbe9,roughness:0.26,transparent:true,opacity:0.58,depthWrite:false,
    });
    for (let i=0; i<8; i++) bubbles.add(new THREE.Mesh(sphere,soap));
    const book = new THREE.Group();
    const cover = mesh(new THREE.BoxGeometry(0.43,0.025,0.31),0xa46842);
    const pages = new THREE.BoxGeometry(0.193,0.024,0.276);
    for (const side of [-1,1]){
        const page = mesh(pages,0xffefd1);
        page.position.set(side*0.102,0.032,0);
        page.rotation.z = side*0.063;
        book.add(page);
    }
    book.add(cover);
    book.position.set(0.33,0.035,0.60);
    return {bubbles,book};
}

export function createPetScene(container){
    const renderer = new THREE.WebGLRenderer({alpha:true,antialias:true,powerPreference:'low-power'});
    renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 3.0;
    renderer.setClearColor(0x000000,0);
    renderer.domElement.setAttribute('aria-hidden','true');
    container.append(renderer.domElement);

    const stage = new THREE.Scene();
    const camera = new THREE.OrthographicCamera();
    camera.position.set(2.4,1.9,6.6);
    camera.lookAt(0,0.74,0);
    const key = new THREE.DirectionalLight(0xfff8ee,2.3);
    key.position.set(3,5,5);
    const bounce = new THREE.DirectionalLight(0xffefe0,0.75);
    bounce.position.set(-4,2,-2);
    const fill = new THREE.DirectionalLight(0xffffff,0);
    fill.position.set(-2,2.6,5.5);
    stage.add(key,bounce,fill,new THREE.HemisphereLight(0xfffaf3,0xc3b9aa,1.55));

    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.56,32),new THREE.MeshBasicMaterial({
        color:0x64472c,transparent:true,opacity:0.14,depthWrite:false,
    }));
    shadow.rotation.x = -Math.PI/2;
    shadow.scale.set(1.22,0.75,1);
    stage.add(shadow);

    const models = new Map();
    const props = new Map();
    const water = bowl(0x82b7c8);
    stage.add(water);
    water.visible = false;
    let actor, currentProps, species, requestNumber = 0;
    let frameId = 0;
    let visible = false;
    let state = 'IDLE';
    let stateStarted = performance.now();
    let appearedAt = 0;
    let wanderSide = 1;
    let entrance;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize(){
        const {width,height} = container.getBoundingClientRect();
        if (!width || !height) return;
        const aspect = width/height;
        Object.assign(camera,{left:-aspect*1.12,right:aspect*1.12,top:1.12,bottom:-1.12,near:0.1,far:30});
        camera.updateProjectionMatrix();
        renderer.setSize(width,height,false);
    }
    new ResizeObserver(resize).observe(container);

    function frame(now){
        if (!visible || !actor){
            frameId = 0;
            return;
        }
        if (entrance){
            if (entrance.effect.update(now)) endEntrance(true);
            renderer.render(stage,camera);
            frameId = requestAnimationFrame(frame);
            return;
        }
        const age = (now-stateStarted)/1000;
        const config = speciesConfig[species];
        let x = 0, y = 0, yaw = -0.14+Math.sin(now/2600)*0.18, lean = 0, sway = 0;
        const breathing = Math.sin(now/(state==='SLEEPING' ? 670 : 460))*0.017;
        const {food,toy,book,bubbles} = currentProps;
        food.visible = state === 'EATING';
        water.visible = state === 'DRINKING';
        toy.visible = state === 'PLAYING';
        if (book) book.visible = state === 'STUDYING';
        if (bubbles) bubbles.visible = state === 'BATHING';
        if (food.visible || water.visible){
            x = 0.12;
            yaw = 0.60;
            lean = 0.10 + Math.abs(Math.sin(age*config.eatRhythm*Math.PI))*0.12;
        } else if (toy.visible){
            const phase = age*config.speed;
            const direction = Math.sin(phase);
            x = direction*config.stride;
            y = Math.abs(Math.sin(age*config.rhythm*Math.PI))*config.jump;
            toy.position.set(Math.sin(phase+0.67)*(config.stride+0.22),0.15,0.55);
            toy.rotation.z = -phase*2.8;
            yaw = Math.atan2(toy.position.x-x, toy.position.z+0.1);
        } else if (state === 'MOVING'){
            x = wanderSide*config.stride*Math.sin(Math.PI*Math.min(1,age/2.5));
            y = Math.abs(Math.sin(age*config.rhythm*Math.PI))*config.jump*0.44;
            yaw = wanderSide*(age<1.25 ? 0.55 : -0.40);
        } else if (state === 'HAPPY'){
            sway = Math.sin(age*8)*0.10;
            y = Math.abs(Math.sin(age*config.rhythm*Math.PI))*config.jump*(species==='dog' ? 1.2 : 0.52);
        } else if (state === 'DANCING'){
            x = Math.sin(age*4)*0.15;
            y = Math.abs(Math.sin(age*7))*0.18;
            yaw = Math.sin(age*4)*0.36;
            sway = Math.sin(age*8)*0.13;
        } else if (state === 'BATHING'){
            sway = Math.sin(age*6)*0.085;
            bubbles.children.forEach((bubble,i)=>{
                const drift = (age*0.72+i*0.26)%1;
                bubble.position.set(Math.cos(i*2.3)*0.49,0.10+drift*1.33,Math.sin(i*2.3)*0.54);
                bubble.scale.setScalar((0.48+(i%3)*0.21)*Math.sin(drift*Math.PI));
            });
        } else if (state === 'STUDYING'){
            yaw = 0.26;
            lean = 0.11;
        } else if (state === 'SLEEPING'){
            yaw = -0.21;
            lean = 0.05;
        } else if (state === 'UNWELL'){
            yaw = -0.25;
            lean = 0.09;
        }
        const appearing = Math.min(1,(now-appearedAt)/440);
        const size = reducedMotion ? 1 : 0.67+(1-Math.pow(1-appearing,3))*0.33;
        actor.position.set(x,reducedMotion ? 0 : y,0);
        actor.rotation.set(reducedMotion ? lean*0.45 : lean,yaw,reducedMotion ? 0 : sway);
        actor.scale.set(size,size*(state==='SLEEPING' ? 0.89+breathing : 1+breathing),size);
        shadow.position.x = x;
        renderer.render(stage,camera);
        frameId = requestAnimationFrame(frame);
    }

    function setVisible(show){
        visible = show;
        if (show){
            resize();
            if (actor && !frameId) frameId = requestAnimationFrame(frame);
        } else {
            endEntrance(false);
            if (frameId){
                cancelAnimationFrame(frameId);
                frameId = 0;
            }
        }
    }

    function setState(next){
        state = next;
        stateStarted = performance.now();
        if (next === 'MOVING') wanderSide = Math.random()<0.5 ? -1 : 1;
    }

    function endEntrance(completed){
        if (!entrance) return;
        const {effect,onEnd} = entrance;
        entrance = null;
        effect.dispose();
        shadow.visible = true;
        setState('IDLE');
        onEnd(completed);
    }

    function playEntrance({audio,onEnd}){
        if (!visible || species!=='nailong') return false;
        endEntrance(false);
        actor.position.set(0,0,0);
        actor.rotation.set(0,-0.13,0);
        actor.scale.setScalar(1);
        const effect = new NailongSpawnEffect(actor,stage,camera,renderer.getPixelRatio(),{audio,reducedMotion});
        try { effect.start(performance.now()); }
        catch (error) { effect.dispose(); throw error; }
        for (const prop of Object.values(currentProps)) prop.visible = false;
        water.visible = false;
        shadow.visible = false;
        entrance = {effect,onEnd};
        appearedAt = performance.now()-440;
        return true;
    }

    async function select(type,appear){
        const request = ++requestNumber;
        if (type===species && actor) return;
        endEntrance(false);
        if (!models.has(type)){
            models.set(type,loadModel(type).catch(error=>{
                models.delete(type);
                throw error;
            }));
        }
        const model = await models.get(type);
        if (request!==requestNumber) return;
        if (actor) stage.remove(actor,...Object.values(currentProps));
        if (!props.has(type)){
            const config = speciesConfig[type];
            const extras = type==='nailong' ? nailongProps() : {};
            props.set(type,{food:foodFor(type,config),toy:toyFor(type,config),...extras});
        }
        currentProps = props.get(type);
        actor = model;
        species = type;
        fill.intensity = speciesConfig[type].fillLight;
        appearedAt = performance.now()-(appear ? 0 : 440);
        stage.add(actor,...Object.values(currentProps));
        renderer.domElement.dataset.species = type;
        setState('IDLE');
    }

    return {select,setState,setVisible,playEntrance};
}
