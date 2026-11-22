import * as THREE from './vendor/three/build/three.module.min.js';

export const summonSettings = {
    duration: 3.8, primaryColor: 0x00ffd5, secondaryColor: 0x00ffaa,
    particleCount: 1500, particleSize: 3.1, beamCount: 24, ringCount: 3,
    glowIntensity: 1, scanSpeed: 1, digitalRainCount: 50, soundEnabled: true, soundVolume: 0.043,
};

const timeline = 3.8;
const ramp = (time, start, end) => THREE.MathUtils.smoothstep(time, start, end);
const tau = 2 * Math.PI;

function sampleSurface(model, count){
    const positions = new Float32Array(count * 3);
    const triangles = [];
    const cumulativeArea = [];
    const triangle = new THREE.Triangle();
    let area = 0;
    model.traverse(mesh=>{
        if (!mesh.isMesh) return;
        const {index, attributes:{position}} = mesh.geometry;
        for (let offset=0; offset+2<(index?.count ?? position.count); offset+=3){
            for (const [step, vertex] of [triangle.a, triangle.b, triangle.c].entries()){
                vertex.fromBufferAttribute(position, index ? index.getX(offset+step) : offset+step)
                    .applyMatrix4(mesh.matrixWorld);
            }
            const faceArea = triangle.getArea();
            if (faceArea <= 0) continue;
            area += faceArea;
            cumulativeArea.push(area);
            triangles.push(...triangle.a.toArray(), ...triangle.b.toArray(), ...triangle.c.toArray());
        }
    });
    for (let i=0; i<count; i++){
        const pick = Math.random() * area;
        let first = 0, last = cumulativeArea.length - 1;
        while (first < last){
            const mid = (first+last) >>> 1;
            if (pick <= cumulativeArea[mid]) last = mid;
            else first = mid+1;
        }
        const offset = first * 9;
        const edge = Math.sqrt(Math.random());
        const along = Math.random() * edge;
        for (let axis=0; axis<3; axis++){
            positions[i*3+axis] = triangles[offset+axis]*(1-edge)
                + triangles[offset+3+axis]*(edge-along) + triangles[offset+6+axis]*along;
        }
    }
    return positions;
}

function shader(uniforms, vertexShader, fragmentShader, options = {}){
    return new THREE.ShaderMaterial({
        uniforms, vertexShader, fragmentShader, transparent:true, depthWrite:false, toneMapped:false, ...options,
    });
}

function cloud(positions, uniforms, vertexShader, fragmentShader){
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    geometry.setAttribute('seed',new THREE.BufferAttribute(Float32Array.from({length:positions.length/3},Math.random),1));
    const points = new THREE.Points(geometry,shader(uniforms,vertexShader,fragmentShader));
    points.frustumCulled = false;
    points.renderOrder = 4;
    return points;
}

const assemblyVertex = `
    attribute float seed;
    uniform float uTime, uFloor, uHeight, uReveal, uPointSize, uRadius;
    varying float vAlpha, vGold, vSeed;
    void main(){
        float height = clamp((position.y-uFloor)/uHeight,0.0,1.0);
        float arrival = mix(0.85,2.06,height) + seed*0.13;
        float gather = smoothstep(arrival-0.59,arrival,uTime);
        float angle = seed*239.0 + (1.0-gather)*2.6;
        float radius = uRadius * (1.05+fract(seed*39.0)*1.0);
        vec3 start = vec3(cos(angle)*radius,uFloor+fract(seed*73.0)*0.34,sin(angle)*radius);
        vec3 point = mix(start,position,gather);
        point.y += sin(gather*3.14159)*0.19;
        float edge = 1.0-smoothstep(0.02,0.17,abs(position.y-uReveal));
        float flicker = 0.65+sin(seed*211.0 + uTime*26.0)*0.35;
        vAlpha = smoothstep(arrival-0.64,arrival-0.42,uTime)
            * (1.0-smoothstep(arrival+0.02,arrival+0.4,uTime)) * (0.33+edge*0.67);
        float dust = (1.0-smoothstep(0.0,0.12,seed))
            * smoothstep(0.03,0.33,uTime) * (1.0-smoothstep(0.6,0.94,uTime));
        point = mix(point,start*vec3(0.67,1.3,0.67),dust);
        float burst = smoothstep(3.12,3.81,uTime);
        vec3 flight = vec3(cos(seed*310.0),0.25+seed,sin(seed*310.0))*(0.46+seed);
        point += flight*burst;
        vGold = step(0.86,seed)*smoothstep(3.08,3.32,uTime);
        vAlpha = (vAlpha+dust*0.48 + step(0.76,seed)*smoothstep(3.14,3.29,uTime)
            * (1.0-smoothstep(3.39,3.8,uTime))) * flicker;
        vSeed = seed;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(point,1.0);
        gl_PointSize = uPointSize*(0.74+fract(seed*37.0)*0.9);
    }`;
const assemblyFragment = `
    uniform vec3 uColor, uMint;
    uniform float uGlow;
    varying float vAlpha, vGold, vSeed;
    void main(){
        vec2 uv = abs(gl_PointCoord-0.5);
        float radius = mix(length(uv),uv.x+uv.y,step(0.78,vSeed));
        float core = 1.0-smoothstep(0.04,0.26,radius);
        float aura = 1.0-smoothstep(0.12,0.5,radius);
        vec3 color = mix(mix(uColor,uMint,core),vec3(0.95,0.58,0.1),vGold);
        gl_FragColor = vec4(color,clamp((core*0.67+aura*0.65)*vAlpha*uGlow,0.0,1.0));
        #include <colorspace_fragment>
    }`;

const rainVertex = `
    attribute float seed;
    uniform float uFloor, uHeight, uTime, uPointSize;
    varying float vAlpha, vSeed;
    void main(){
        float descent = fract(position.y-uTime*(0.18+seed*0.39));
        vec3 point = vec3(position.x,uFloor+descent*(uHeight+0.27),position.z);
        float flicker = 0.5+sin(seed*94.0+uTime*12.0)*0.5;
        vAlpha = smoothstep(0.47,1.03,uTime)*(1.0-smoothstep(2.9,3.78,uTime))
            * smoothstep(0.0,0.14,descent)*(1.0-smoothstep(0.86,1.0,descent))*flicker;
        vSeed = seed;
        gl_Position = projectionMatrix*modelViewMatrix*vec4(point,1.0);
        gl_PointSize = uPointSize*(1.9+seed);
    }`;
const rainFragment = `
    uniform vec3 uColor, uMint;
    varying float vAlpha, vSeed;
    void main(){
        vec2 uv = gl_PointCoord-0.5;
        vec2 edge = abs(uv);
        float outer = max(edge.x/0.25,edge.y/0.44);
        float inner = max(edge.x/0.10,edge.y/0.29);
        float zero = (1.0-smoothstep(0.79,1.0,outer))*smoothstep(0.72,1.05,inner);
        float one = (1.0-smoothstep(0.05,0.14,edge.x))*(1.0-smoothstep(0.26,0.45,edge.y));
        one = max(one,(1.0-smoothstep(0.13,0.24,edge.x))*(1.0-smoothstep(0.07,0.13,abs(uv.y-0.32))));
        float glyph = mix(zero,one,step(0.5,vSeed));
        gl_FragColor = vec4(mix(uColor,uMint,glyph*0.38),vAlpha*glyph*0.85);
        #include <colorspace_fragment>
    }`;

function hologram(source, uniforms){
    const material = source.clone();
    material.transparent = true;
    material.onBeforeCompile = program=>{
        Object.assign(program.uniforms,uniforms);
        program.vertexShader = 'varying vec3 vSummonWorld;\n' + program.vertexShader.replace(
            '#include <project_vertex>',
            '#include <project_vertex>\nvSummonWorld = (modelMatrix * vec4(transformed,1.0)).xyz;'
        );
        program.fragmentShader = `
            varying vec3 vSummonWorld;
            uniform float uTime, uFloor, uHeight, uReveal, uScan, uRestore, uGlow;
            uniform vec3 uPrimary, uMint;
        ` + program.fragmentShader.replace('#include <opaque_fragment>',`
            if (vSummonWorld.y > uReveal) discard;
            vec3 worldNormal = normalize(cross(dFdx(vSummonWorld), dFdy(vSummonWorld)));
            vec3 look = normalize(cameraPosition - vSummonWorld);
            float rim = pow(1.0-clamp(abs(dot(worldNormal,look)),0.0,1.0),2.65);
            float stripe = 0.5+0.5*sin(vSummonWorld.y*193.0-uTime*13.0);
            float shimmer = 0.93 + 0.04*sin(uTime*31.0)+0.03*sin(uTime*59.0);
            float frontier = exp(-abs(vSummonWorld.y-uReveal)*52.0);
            float laser = exp(-abs(vSummonWorld.y-uScan)*39.0);
            float height = clamp((vSummonWorld.y-uFloor)/uHeight,0.0,1.0);
            float entity = smoothstep(0.0,0.18,uRestore*1.19 - (1.0-height));
            vec3 holographic = outgoingLight*vec3(0.29,0.62,0.55) + uPrimary*(0.085+stripe*0.105);
            holographic += uGlow*(uPrimary*rim*0.44+uMint*(rim*rim*0.7+frontier*1.25+laser*0.80));
            outgoingLight = mix(holographic,outgoingLight,entity);
            diffuseColor.a *= mix(clamp((0.48+rim*0.34+frontier*0.29+laser*0.28)*shimmer+stripe*0.085,0.0,1.0),1.0,entity);
            #include <opaque_fragment>
        `);
    };
    material.customProgramCacheKey = ()=>'nailong-height-reveal';
    return material;
}

function energyRing(geometry, color, mint, segmented = false, additive = false){
    const uniforms = {uColor:{value:color},uMint:{value:mint},uAlpha:{value:0},uSegments:{value:segmented ? 1 : 0}};
    const ring = new THREE.Mesh(geometry,shader(uniforms,`
        varying vec2 vRing;
        void main(){
            vRing = position.xy;
            gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
        }
    `,`
        varying vec2 vRing;
        uniform vec3 uColor, uMint;
        uniform float uAlpha, uSegments;
        void main(){
            float radial = abs(length(vRing)-1.0);
            float core = 1.0-smoothstep(0.009,0.029,radial);
            float halo = exp(-radial*23.0)*(1.0-smoothstep(0.10,0.17,radial));
            float arc = smoothstep(0.16,0.25,fract(atan(vRing.y,vRing.x)*1.91));
            gl_FragColor = vec4(mix(uColor,uMint,core*0.65),(core*0.65 + halo*0.42)*uAlpha*mix(1.0,arc,uSegments));
            #include <colorspace_fragment>
        }
    `,{side:THREE.DoubleSide,blending:additive ? THREE.AdditiveBlending : THREE.NormalBlending}));
    ring.rotation.x = -Math.PI/2;
    ring.renderOrder = additive ? 4 : 3;
    return ring;
}

function lightBeams(count, color, mint){
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(count*6),3).setUsage(THREE.DynamicDrawUsage);
    const colors = new Float32Array(count*6);
    for (let i=0; i<colors.length; i+=6){
        mint.toArray(colors,i);
        color.toArray(colors,i+3);
    }
    geometry.setAttribute('position',positions);
    geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
    const material = new THREE.LineBasicMaterial({
        vertexColors:true,transparent:true,opacity:0,depthWrite:false,toneMapped:false,
    });
    const lines = new THREE.LineSegments(geometry,material);
    lines.frustumCulled = false;
    lines.renderOrder = 3;
    return lines;
}

const cues = [
    {at:0, type:'sine', notes:[[188,565,0,0.27],[285,720,0.10,0.24]]},
    {at:2.12, type:'triangle', notes:[[945,340,0,0.22],[740,310,0.135,0.16]]},
    {at:3.43, type:'sine', notes:[[523,523,0,0.21],[659,659,0.08,0.21],[784,784,0.16,0.22]]},
];

export class NailongSpawnEffect {
    constructor(model, scene, camera, pixelRatio, {audio, reducedMotion}){
        this.model = model;
        this.scene = scene;
        this.audio = audio;
        this.reducedMotion = reducedMotion;
        this.effectGroup = new THREE.Group();
        this.effectGroup.name = 'NailongSpawnEffect';
        this.bounds = new THREE.Box3().setFromObject(model,true);
        const size = this.bounds.getSize(new THREE.Vector3());
        const floor = this.bounds.min.y;
        const radius = Math.hypot(size.x,size.z)/2+0.09;
        const mint = new THREE.Color(0xbffff2);
        const teal = new THREE.Color(summonSettings.primaryColor).multiplyScalar(0.40);
        const green = new THREE.Color(summonSettings.secondaryColor).multiplyScalar(0.46);
        this.radius = radius;
        this.uniforms = {
            uTime:{value:0}, uFloor:{value:floor}, uHeight:{value:size.y}, uRadius:{value:radius},
            uReveal:{value:floor}, uScan:{value:-10}, uRestore:{value:0}, uGlow:{value:summonSettings.glowIntensity},
            uPrimary:{value:new THREE.Color(summonSettings.primaryColor)}, uColor:{value:teal}, uMint:{value:mint},
            uPointSize:{value:summonSettings.particleSize*pixelRatio},
        };
        this.bindings = [];
        this.materials = new Map();
        this.notes = new Set();
        this.nextCue = 0;
        this.originalVisibility = model.visible;

        const halo = new THREE.Mesh(new THREE.PlaneGeometry(1,1),shader({
            uColor:{value:green},uAlpha:{value:0},
        },`
            varying vec2 vHalo;
            void main(){vHalo=uv*2.0-1.0;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}
        `,`
            varying vec2 vHalo;
            uniform vec3 uColor;
            uniform float uAlpha;
            void main(){
                float radius = length(vHalo);
                gl_FragColor=vec4(uColor*0.13,exp(-radius*radius*3.0)*(1.0-smoothstep(0.64,1.0,radius))*uAlpha);
                #include <colorspace_fragment>
            }
        `,{depthTest:false}));
        halo.position.set(0,floor+size.y*0.46,-0.30);
        halo.quaternion.copy(camera.quaternion);
        halo.scale.set(radius*3.9,size.y*1.68,1);
        halo.renderOrder = -2;
        this.halo = halo;

        const ringGeometry = new THREE.RingGeometry(0.81,1.19,96);
        this.platform = Array.from({length:summonSettings.ringCount},(_,i)=>energyRing(ringGeometry,i%2 ? green : teal,mint,i>0));
        this.scanRings = [
            energyRing(ringGeometry,teal,mint),energyRing(ringGeometry,green,mint,false,true),
            energyRing(ringGeometry,teal,mint),energyRing(ringGeometry,teal,mint),
        ];
        this.beams = lightBeams(summonSettings.beamCount,green,mint);
        const count = reducedMotion ? Math.round(summonSettings.particleCount/2) : summonSettings.particleCount;
        const rain = new Float32Array(summonSettings.digitalRainCount*3);
        for (let i=0; i<rain.length; i+=3){
            rain[i] = (i%2 ? -1 : 1)*radius*(0.94+Math.random()*0.83);
            rain[i+1] = Math.random();
            rain[i+2] = (Math.random()-0.58)*radius*1.7;
        }
        this.effectGroup.add(halo,...this.platform,...this.scanRings,this.beams,
            cloud(sampleSurface(model,count),this.uniforms,assemblyVertex,assemblyFragment),
            cloud(rain,this.uniforms,rainVertex,rainFragment));
    }

    start(now){
        this.startTime = now;
        const clone = source=>{
            if (!this.materials.has(source)) this.materials.set(source,hologram(source,this.uniforms));
            return this.materials.get(source);
        };
        this.model.traverse(mesh=>{
            if (!mesh.isMesh) return;
            this.bindings.push([mesh,mesh.material]);
            mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
        });
        this.model.visible = false;
        this.scene.add(this.effectGroup);
    }

    update(now){
        const seconds = (now-this.startTime)/1000;
        const t = Math.min(timeline,seconds*timeline/summonSettings.duration);
        const u = this.uniforms;
        const floor = u.uFloor.value;
        const height = u.uHeight.value;
        const fade = 1-ramp(t,3.11,3.8);
        u.uTime.value = t;
        u.uReveal.value = floor+(height+0.045)*ramp(t,0.6,2.2) + ramp(t,3.5,3.7)*0.15;
        u.uRestore.value = ramp(t,2.79,3.5);
        this.model.visible = this.originalVisibility && t>=0.6;
        this.halo.material.uniforms.uAlpha.value = ramp(t,0.02,0.58)*fade*0.37*u.uGlow.value;
        const closed = ramp(t,0.03,0.53);
        const retract = ramp(t,0.42,1.18);
        const beamPositions = this.beams.geometry.attributes.position;
        this.beams.material.opacity = closed*(1-retract)*0.83;
        this.beams.visible = this.beams.material.opacity>0.006;
        if (this.beams.visible){
            for (let i=0; i<summonSettings.beamCount; i++){
                const angle = i*tau/summonSettings.beamCount+t*0.27;
                const reach = this.radius*(1.23+(i%5)*0.19)*(1-retract*0.87);
                beamPositions.setXYZ(i*2,Math.cos(angle)*0.075,floor+0.031,Math.sin(angle)*0.075);
                beamPositions.setXYZ(i*2+1,Math.cos(angle)*reach,floor+(0.55+(i%6)*0.14)*(1-retract),Math.sin(angle)*reach);
            }
            beamPositions.needsUpdate = true;
        }
        const pulse = ramp(t,3.10,3.45);
        this.platform.forEach((ring,i)=>{
            const size = this.radius*(0.54+i*0.25)*Math.max(0.01,closed)+pulse*(0.18+i*0.04);
            ring.scale.setScalar(size);
            ring.position.y = floor+0.023+i*0.012;
            ring.rotation.z = t*(i%2 ? -1.5 : 0.8);
            ring.material.uniforms.uAlpha.value = closed*fade*(0.60+Math.sin(t*7-i)*0.14+0.46*(pulse-pulse*pulse))*u.uGlow.value;
        });
        const scanning = ramp(t,2.10,2.24)*(1-ramp(t,3.12,3.23));
        const progress = Math.pow(ramp(t,2.1,3.2),1/Math.max(0.1,summonSettings.scanSpeed));
        const scanY = floor+(1-progress)*height+0.021;
        u.uScan.value = scanning>0.01 ? scanY : -10;
        this.scanRings.forEach((ring,i)=>{
            ring.visible = scanning>0.005;
            ring.position.y = Math.min(floor+height+0.04,scanY+Math.max(0,i-1)*0.064);
            ring.scale.setScalar(this.radius*(i===1 ? 1.035 : 1+Math.max(0,i-1)*0.018));
            ring.material.uniforms.uAlpha.value = scanning*[1.42,0.48,0.45,0.23][i]*u.uGlow.value;
        });
        if (t>=3.5){
            this.restoreMaterials();
            if (!this.reducedMotion) this.model.position.y = Math.sin(Math.PI*(t-3.5)/0.30)*0.106;
        }
        if (!this.audio?.enabled()) this.stopNotes();
        while (this.nextCue<cues.length && t>=cues[this.nextCue].at){
            const cue = cues[this.nextCue++];
            if (t-cue.at<0.22) this.playCue(cue);
        }
        return seconds>=summonSettings.duration;
    }

    playCue(cue){
        const context = this.audio?.context;
        if (!summonSettings.soundEnabled || !this.audio?.enabled() || context?.state!=='running') return;
        try {
            for (const [from,to,delay,length] of cue.notes){
                const at = context.currentTime+delay;
                const voice = context.createOscillator();
                const gain = context.createGain();
                voice.type = cue.type;
                voice.frequency.setValueAtTime(from,at);
                voice.frequency.exponentialRampToValueAtTime(to,at+length);
                gain.gain.setValueAtTime(0.0001,at);
                gain.gain.exponentialRampToValueAtTime(summonSettings.soundVolume,at+0.026);
                gain.gain.exponentialRampToValueAtTime(0.0001,at+length);
                voice.connect(gain).connect(context.destination);
                this.notes.add(voice);
                voice.onended = ()=>{
                    this.notes.delete(voice);
                    voice.disconnect();
                    gain.disconnect();
                };
                voice.start(at);
                voice.stop(at+length+0.01);
            }
        } catch {}
    }

    stopNotes(){
        for (const voice of this.notes){
            try { voice.stop(); } catch {}
        }
        this.notes.clear();
    }

    restoreMaterials(){
        for (const [mesh,original] of this.bindings) mesh.material = original;
        this.bindings.length = 0;
    }

    dispose(){
        this.restoreMaterials();
        this.model.visible = this.originalVisibility;
        this.model.position.y = 0;
        this.stopNotes();
        this.scene.remove(this.effectGroup);
        const geometries = new Set();
        this.effectGroup.traverse(object=>{
            if (object.geometry) geometries.add(object.geometry);
            object.material?.dispose();
        });
        for (const geometry of geometries) geometry.dispose();
        for (const material of this.materials.values()) material.dispose();
        this.effectGroup.clear();
        this.materials.clear();
    }
}
