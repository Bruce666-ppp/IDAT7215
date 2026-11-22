import {initialStats, speciesConfig} from './desktop-pet-config.js?v=en-GB';

const byId = id => document.getElementById(id);
const widget = byId('desktop-pet');
const list = byId('view-compare');
const stage = byId('pet-stage');
const panel = byId('pet-panel');
const notice = byId('pet-message');
const storageKey = 'pawthfinder_desktop_pets';
const labels = {
    satiety: 'Satiety', hydration: 'Hydration', happiness: 'Happiness',
    energy: 'Energy', health: 'Health', bond: 'Bond',
};
// Keep rule keys and saved history intact while presenting their labels in English.
const ruleLabels = {
    '属性正常': 'Attributes in range',
    '陪伴间隔较长': 'Time since last interaction',
    '兔子干草提醒': 'Rabbit hay reminder',
    '物种日常权重': 'Species routine weight',
    '小狗活动权重': 'Puppy activity weight',
    '手动互动': 'Manual interaction',
    '短时间内抚摸过多': 'Too much petting in a short time',
    '奶龙出场': 'Naylong entrance',
    '开启桌宠': 'Desktop pet opened',
};
const legacyActionLabels = {
    '抚摸': 'Pet', '喂食': 'Feed', '饮水': 'Drink', '玩耍': 'Play', '睡觉': 'Sleep',
    '健康检查': 'Health check', '拖动位置': 'Move', '跳舞': 'Dance', '洗澡': 'Bath',
    '陪伴学习': 'Study together', '健康提醒': 'Health reminder', '提醒饮水': 'Water reminder',
    '提醒喂食': 'Food reminder', '自动睡觉': 'Fall asleep', '邀请互动': 'Ask for company',
    '待机': 'Idle', '邀请玩耍': 'Invite play', '请求干草': 'Ask for hay',
    '小憩': 'Nap', '自主移动': 'Explore', '暂时躲开': 'Move away briefly', '全息召唤': 'Holographic entrance',
};
const actions = {
    pet: {state: 'HAPPY', label: 'Pet', duration: 1700, cooldown: 1350, gain: {happiness: 7, bond: 4}},
    feed: {state: 'EATING', label: 'Feed', duration: 3200, cooldown: 3800, gain: {satiety: 24}},
    drink: {state: 'DRINKING', label: 'Drink', duration: 2800, cooldown: 3500, gain: {hydration: 26}},
    play: {state: 'PLAYING', label: 'Play', duration: 4600, cooldown: 5200, gain: {happiness: 18, bond: 6, energy: -13, satiety: -6, hydration: -7}},
    sleep: {state: 'SLEEPING', label: 'Sleep', duration: 16000, cooldown: 5000},
    check: {state: 'IDLE', label: 'Health check', duration: 3400, cooldown: 2500},
    move: {state: 'MOVING', label: 'Move', duration: 1550, cooldown: 0},
    dance: {state:'DANCING', label:'Dance', duration:3700, cooldown:4300, gain:{happiness:12,bond:4,energy:-6}, message:'Let’s dance!'},
    bath: {state:'BATHING', label:'Bath', duration:3400, cooldown:4300, gain:{happiness:5,bond:3}, message:'Time for a bubble bath.'},
    study: {state:'STUDYING', label:'Study together', duration:26000, cooldown:5000, gain:{bond:5}, message:'I’ll keep you company while you study.'},
};
const nailongActions = new Set(['dance','bath','study']);
const soundKey = 'pawthfinder_nailong_muted';
const clamp = n => Math.max(0, Math.min(100, n));
const hasSpecies = key => Object.hasOwn(speciesConfig, key);
const timestamp = () => Date.now();

function readState(){
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (saved && saved.pets && typeof saved.pets === 'object') {
            return {selected: hasSpecies(saved.selected) ? saved.selected : null, hidden: !!saved.hidden, pets: saved.pets};
        }
    } catch {}
    return {selected: null, hidden: false, pets: {}};
}

const store = readState();
let renderer;
let rendererPromise;
let loadingSequence = 0;
let currentDecision;
let heldUntil = 0;
let nextRoutine = 0;
let lastBubble = {message: '', at: 0};
let bubbleTimer;
let drag;
let ignoreClickUntil = 0;
let summonRequested = false;
let summonAudio;
let soundMuted = false;
try { soundMuted = localStorage.getItem(soundKey)==='1'; } catch {}
const stageHint = byId('pet-stage-label');
const canvasHost = byId('pet-canvas');
const replay = byId('pet-replay');
const sound = byId('pet-sound');
const actionButtons = widget.querySelectorAll('[data-pet-action], #pet-adjust');
const pet = () => store.pets[store.selected];
const config = () => speciesConfig[store.selected];
const isVisible = () => !!pet() && !store.hidden && !list.hidden && !document.hidden;
const isSpawning = () => currentDecision?.state === 'SPAWNING';

function save(){
    try { localStorage.setItem(storageKey, JSON.stringify(store)); } catch {}
}

function hydrate(type){
    const previous = store.pets[type] || {};
    const stats = Object.fromEntries(Object.entries(initialStats).map(([key, value])=>{
        const saved = previous.stats?.[key];
        return [key, Number.isFinite(saved) ? clamp(saved) : value];
    }));
    store.pets[type] = {
        stats, position: previous.position || null, resting: !!previous.resting,
        updatedAt: Number.isFinite(previous.updatedAt) ? previous.updatedAt : timestamp(),
        lastInteraction: previous.lastInteraction || timestamp(),
        lastAction: previous.lastAction || {}, petTimes: Array.isArray(previous.petTimes) ? previous.petTimes : [],
        history: Array.isArray(previous.history) ? previous.history.slice(0, 10) : [],
    };
}

function change(values){
    for (const [key, delta] of Object.entries(values)) pet().stats[key] = clamp(pet().stats[key] + delta);
}

function advance(now){
    const animal = pet();
    if (!animal) return;
    const minutes = Math.min(180, Math.max(0, now - animal.updatedAt) / 60000);
    animal.updatedAt = now;
    if (!minutes || isSpawning()) return;
    const {stats, resting} = animal;
    const drain = config().drain;
    const companion = Math.min(2, Math.max(0, now - animal.lastInteraction) / 240000);
    const deficits = [stats.satiety, stats.hydration, stats.energy].filter(value => value < 24).length;
    change({
        satiety: -drain.satiety * minutes,
        hydration: -drain.hydration * minutes,
        happiness: -(drain.happiness * (1 + companion)) * minutes,
        energy: (resting ? 35 : -drain.energy) * minutes,
        health: minutes * (deficits ? -0.85 * deficits : stats.energy > 48 ? 0.12 : 0),
        bond: -0.035 * minutes,
    });
}

const controls = {};
for (const [key, label] of Object.entries(labels)){
    const wrap = document.createElement('div');
    const title = document.createElement('span');
    const value = document.createElement('output');
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.setAttribute('aria-label', label);
    title.textContent = label;
    wrap.append(title, value, bar);
    byId('pet-attributes').append(wrap);

    const sliderLabel = document.createElement('label');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 100;
    slider.setAttribute('aria-label', 'Adjust '+label);
    sliderLabel.append(label, slider);
    byId('pet-sliders').append(sliderLabel);
    slider.addEventListener('input', ()=>{
        if (!pet()) return;
        pet().stats[key] = Number(slider.value);
        pet().updatedAt = timestamp();
        heldUntil = 0;
        nextRoutine = timestamp() + 4000;
        decide(timestamp());
        paintStats();
        save();
    });
    controls[key] = {bar, value, slider};
}

function paintStats(){
    if (!pet()) return;
    for (const [key, controlsForKey] of Object.entries(controls)){
        const value = Math.round(pet().stats[key]);
        controlsForKey.bar.value = value;
        controlsForKey.value.value = value;
        controlsForKey.slider.value = value;
    }
}

function tell(message, now = timestamp()){
    if (!message || (lastBubble.message === message && now - lastBubble.at < 12500)) return;
    clearTimeout(bubbleTimer);
    lastBubble = {message, at: now};
    notice.textContent = message;
    notice.hidden = false;
    bubbleTimer = setTimeout(()=>{notice.hidden = true;}, 3200);
}

function paintHistory(){
    byId('pet-history').replaceChildren(...pet().history.map(item=>{
        const row = document.createElement('li');
        row.textContent = new Date(item.at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', second: '2-digit'})
            + ' · ' + (legacyActionLabels[item.action] ?? item.action)
            + ' · ' + (ruleLabels[item.rule] ?? item.rule);
        return row;
    }));
}

function publish(next, now, pause = 0, record = true){
    const previous = currentDecision;
    if (previous && ['state','rule','action','reason'].every(key => previous[key] === next[key]) && !pause) return;
    currentDecision = next;
    if (pause) heldUntil = now + pause;
    const animal = pet();
    animal.resting = next.state === 'SLEEPING';
    if (record){
        animal.history.unshift({at: now, state: next.state, action: next.action, rule: next.rule, reason: next.reason});
        animal.history.length = Math.min(animal.history.length, 10);
        paintHistory();
    }
    widget.dataset.state = next.state;
    for (const button of actionButtons) button.disabled = isSpawning();
    for (const {slider} of Object.values(controls)) slider.disabled = isSpawning();
    replay.disabled = isSpawning() || canvasHost.hidden;
    byId('pet-state').textContent = next.state;
    byId('pet-rule').textContent = ruleLabels[next.rule] ?? next.rule;
    byId('pet-behavior').textContent = next.action;
    byId('pet-reason').textContent = next.reason;
    byId('pet-zzz').hidden = next.state !== 'SLEEPING';
    const hearts = byId('pet-hearts');
    hearts.hidden = true;
    if (next.state === 'HAPPY') {
        void hearts.offsetWidth;
        hearts.hidden = false;
    }
    renderer?.setState(next.state);
    tell(next.message, now);
    save();
    widget.dispatchEvent(new CustomEvent('pawthfinder:pet-update', {bubbles:true, detail:getPetSnapshot()}));
}

function need(stats, profile){
    if (stats.health < 40) return {
        state:'UNWELL', rule:'Health < 40', action:'Health reminder', reason:'Health is low. Check satiety, hydration and energy.',
        message:'I’m feeling a little unwell. Check how I’m doing.',
    };
    if (stats.hydration < 30) return {
        state:'IDLE', rule:'Hydration < 30', action:'Water reminder', reason:'Hydration is low. Waiting for you to offer water.',
        message:'I’m thirsty.',
    };
    if (stats.satiety < 30) return {
        state:'IDLE', rule:'Satiety < 30', action:'Food reminder', reason:'Satiety is low. Waiting for you to offer ' + profile.food + '.',
        message:profile.foodReminder ? 'Time for some hay!' : 'I’m hungry.',
    };
    if (stats.energy < 25) return {
        state:'SLEEPING', rule:'Energy < 25', action:'Fall asleep', reason:'Energy is low. Resting to recover.',
        message:profile.nap,
    };
    if (stats.happiness < 40) return {
        state:'IDLE', rule:'Happiness < 40', action:'Ask for company', reason:'Happiness is low. Looking for time with you.',
        message:profile.invite,
    };
    return null;
}

function decide(now){
    if (!pet() || isSpawning() || now < heldUntil) return;
    const profile = config();
    const stats = pet().stats;
    const priority = need(stats, profile);
    if (priority) {
        publish(priority, now);
        return;
    }
    if (currentDecision?.rule === 'Energy < 25' && stats.energy < 60){
        publish({...currentDecision, reason:'Resting until energy reaches 60.'}, now);
        return;
    }
    if (now < nextRoutine){
        if (currentDecision?.state !== 'IDLE' || currentDecision?.rule !== '属性正常'){
            publish({state:'IDLE',rule:'属性正常',action:'Idle',reason:'Needs are met. Watching quietly.'},now);
        }
        return;
    }
    nextRoutine = now + 8000 + Math.random() * 3500;
    const minutesAway = (now - pet().lastInteraction) / 60000;
    if (profile.reunionMinutes && minutesAway >= profile.reunionMinutes){
        publish({state:'IDLE',rule:'陪伴间隔较长',action:'Invite play',reason:'The puppy hasn’t spent time with you for a while.',message:profile.missed},now,4600);
        return;
    }
    if (profile.foodReminder && stats.satiety < profile.foodReminder){
        publish({state:'IDLE',rule:'兔子干草提醒',action:'Ask for hay',reason:'The rabbit simulation gives more frequent reminders for hay.',message:'Time for some hay!'},now,4600);
        return;
    }
    let roll = Math.random();
    const habit = Object.entries(profile.activity).find(([, weight])=>(roll -= weight) < 0)?.[0];
    if (habit === 'sleep' && stats.energy < 93){
        publish({state:'SLEEPING',rule:'物种日常权重',action:'Nap',reason:'The species’ rest tendency favours a nap.',message:profile.nap},now,9500);
    } else if (habit === 'move'){
        publish({state:'MOVING',rule:'物种日常权重',action:'Explore',reason:profile.wander},now,2450);
    } else if (habit === 'invite'){
        publish({state:'IDLE',rule:'小狗活动权重',action:'Invite play',reason:'The puppy simulation favours activity and company.',message:profile.invite},now,4000);
    } else {
        publish({state:'IDLE',rule:'属性正常',action:'Idle',reason:'Needs are met. Watching quietly.'},now);
    }
}

export function getPetSnapshot(){
    if (!pet()) return null;
    return {
        species: store.selected, name: config().name, attributes:{...pet().stats},
        state:currentDecision?.state || 'IDLE', decision:currentDecision ? {...currentDecision} : null,
    };
}

export function interactWithPet(action){
    if (!pet() || isSpawning() || !Object.hasOwn(actions,action)) return;
    if (nailongActions.has(action) && store.selected!=='nailong') return;
    const now = timestamp();
    const animal = pet();
    const profile = config();
    const rule = actions[action];
    if (now - (animal.lastAction[action] || 0) < rule.cooldown){
        tell('Wait a moment before trying again.',now);
        return;
    }
    advance(now);
    animal.lastAction[action] = now;
    animal.lastInteraction = now;
    nextRoutine = now + rule.duration + 5000;
    let decision = {state:rule.state, rule:'手动互动', action:rule.label, reason:'You chose '+rule.label+'.', message:rule.message};
    if (action === 'pet' && profile.petLimit){
        animal.petTimes = animal.petTimes.filter(time => now - time < 14000);
        if (animal.petTimes.length >= profile.petLimit){
            change({happiness:-profile.petLoss});
            publish({
                state:store.selected === 'rabbit' ? 'MOVING' : 'IDLE',
                rule:'短时间内抚摸过多', action:'Move away briefly', reason:'Give your desktop pet a quiet moment before interacting again.', message:profile.reject,
            },now,2000);
            paintStats();
            return;
        }
        animal.petTimes.push(now);
    }
    if (rule.gain){
        const gains={...rule.gain};
        if (action === 'feed' && profile.foodReminder) gains.satiety = 20;
        if (action === 'play' && store.selected === 'dog') gains.happiness = 21;
        change(gains);
    }
    if (action === 'feed') decision.message = 'Time for some ' + profile.food + '.';
    if (action === 'drink') decision.message = 'A little sip of water.';
    if (action === 'pet') decision.message = profile.affection;
    if (action === 'play') decision.message = 'Here comes the ' + profile.toy + '!';
    if (action === 'sleep') decision.message = profile.nap;
    if (action === 'check'){
        const concern = need(animal.stats,profile);
        const issue = concern?.state === 'UNWELL' ? concern : null;
        decision = {...decision,state:issue?.state || 'IDLE',rule:concern?.rule || '属性正常',
            reason:concern?.reason || 'No care reminders are active. Keep interacting regularly.',
            message:concern?.message || 'I’m doing well.'};
    }
    publish(decision,now,rule.duration);
    paintStats();
}

function place(position){
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)){
        widget.classList.remove('is-positioned');
        return;
    }
    const left = Math.max(4,Math.min(position.left, innerWidth-widget.offsetWidth-4));
    const top = Math.max(4,Math.min(position.top, innerHeight-widget.offsetHeight-4));
    widget.classList.add('is-positioned');
    widget.style.left = left+'px';
    widget.style.top = top+'px';
}

function showPanel(open){
    panel.hidden = !open;
    stage.setAttribute('aria-expanded',String(open));
    if (pet()?.position && !widget.hidden) place(pet().position);
}

function syncVisibility(){
    const animal = pet();
    widget.hidden = !animal || store.hidden;
    byId('pet-list-toolbar').hidden = !animal;
    byId('pet-visibility').textContent = store.hidden ? 'Show desktop pet' : 'Hide desktop pet';
    const visible = isVisible();
    if (!visible){
        summonRequested = false;
        loadingSequence++;
    }
    renderer?.setVisible(visible);
    if (visible) place(animal.position);
}

function prepareSound(){
    if (soundMuted) return;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        summonAudio ||= new AudioContext();
        void summonAudio.resume().catch(()=>{});
    } catch {}
}

function paintSound(){
    sound.textContent = soundMuted ? 'Sound off' : 'Sound on';
    sound.setAttribute('aria-pressed',String(!soundMuted));
}

function startEntrance(){
    if (!renderer || !isVisible() || canvasHost.hidden || store.selected!=='nailong') return;
    const animal = pet();
    try {
        if (!renderer.playEntrance({
            audio:{get context(){return summonAudio;},enabled:()=>!soundMuted},
            onEnd(completed){
                if (pet()!==animal) return;
                const now = timestamp();
                animal.updatedAt = now;
                heldUntil = now+(completed ? 2800 : 0);
                nextRoutine = now+5500;
                stageHint.textContent = 'Click to interact · Drag to move';
                publish({
                    state:'IDLE',rule:'属性正常',action:'Idle',
                    reason:completed ? 'Holographic entrance complete.' : 'The holographic entrance has ended.',
                    message:completed ? config().greeting : '',
                },now,0,false);
            },
        })) return;
        clearTimeout(bubbleTimer);
        lastBubble = {message:'',at:0};
        notice.hidden = true;
        stageHint.textContent = 'Summoning…';
        publish({state:'SPAWNING',rule:'奶龙出场',action:'Holographic entrance',reason:'Energy gathers, then reconstructs and scans the model.'},timestamp(),0,false);
    } catch (error) {
        byId('pet-load-status').textContent = 'Naylong loaded, but the holographic entrance failed to start. Retry from the interaction menu.';
        console.error('Pico Naylong entrance',error);
    }
}

async function loadScene(appear){
    const type = store.selected;
    if (!isVisible() || !type || isSpawning()) return;
    const sequence = ++loadingSequence;
    canvasHost.hidden = true;
    replay.disabled = true;
    stageHint.textContent = 'Loading '+config().name;
    byId('pet-load-status').textContent = '';
    try {
        rendererPromise ||= import('./desktop-pet-scene.js').then(module=>module.createPetScene(canvasHost));
        renderer = await rendererPromise;
        if (sequence !== loadingSequence || !isVisible()) return;
        await renderer.select(type,appear);
        if (sequence !== loadingSequence || !isVisible()) return;
        canvasHost.hidden = false;
        renderer.setState(currentDecision?.state || 'IDLE');
        renderer.setVisible(true);
        stageHint.textContent = 'Click to interact · Drag to move';
        replay.disabled = false;
        if (summonRequested && type==='nailong'){
            summonRequested = false;
            startEntrance();
        }
    } catch (error) {
        rendererPromise = renderer ? rendererPromise : null;
        if (sequence !== loadingSequence || !isVisible()) return;
        summonRequested = false;
        stageHint.textContent = '3D model unavailable';
        byId('pet-load-status').textContent = 'The desktop pet could not load. Check WebGL support in your browser, then select Generate Pet again.';
        console.error('Pico 3D pet',error);
    }
}

export function generateDesktopPet(type, clicked = true){
    if (!hasSpecies(type)) return;
    const switching = store.selected !== type;
    if (switching){
        summonRequested = false;
        advance(timestamp());
        renderer?.setVisible(false);
        store.selected = type;
        hydrate(type);
        const now = timestamp();
        advance(now);
        currentDecision = null;
        heldUntil = 0;
        nextRoutine = now + 5500;
        notice.hidden = true;
        showPanel(false);
        byId('pet-sliders').hidden = true;
        byId('pet-adjust').setAttribute('aria-expanded','false');
        byId('pet-name').textContent = config().name;
        byId('pet-species').textContent = config().label + ' · ' + type;
        byId('pet-feed').title = config().food;
        byId('pet-play').title = config().toy;
        for (const control of widget.querySelectorAll('[data-nailong-only]')) control.hidden = type!=='nailong';
        stage.setAttribute('aria-label',config().name+'. Click to interact or drag to move.');
        publish({state:'IDLE',rule:'开启桌宠',action:'Idle',reason:'The saved state for this species has loaded.',message:type==='nailong' ? '' : config().greeting},now);
        paintStats();
    }
    store.hidden = false;
    syncVisibility();
    const summon = clicked && type==='nailong' && isVisible();
    if (summon) prepareSound();
    if (summon && !switching && !canvasHost.hidden){
        startEntrance();
    } else if (!summonRequested){
        summonRequested = summon;
        void loadScene(switching);
    }
    save();
}

if (store.selected){
    const restored = store.selected;
    const wasHidden = store.hidden;
    store.selected = null;
    generateDesktopPet(restored,false);
    store.hidden = wasHidden;
    syncVisibility();
    save();
}

paintSound();
sound.onclick = ()=>{
    soundMuted = !soundMuted;
    try { localStorage.setItem(soundKey,soundMuted ? '1' : '0'); } catch {}
    paintSound();
    prepareSound();
};
replay.onclick = ()=>{
    prepareSound();
    startEntrance();
};

byId('pet-visibility').onclick = ()=>{
    if (!pet()) return;
    store.hidden = !store.hidden;
    showPanel(false);
    syncVisibility();
    if (!store.hidden) void loadScene(false);
    save();
};
byId('pet-hide').onclick = ()=>byId('pet-visibility').click();
byId('pet-remove').onclick = ()=>{
    loadingSequence++;
    advance(timestamp());
    store.selected = null;
    byId('pet-load-status').textContent = '';
    showPanel(false);
    syncVisibility();
    save();
};
byId('pet-menu-close').onclick = ()=>{showPanel(false); stage.focus();};
byId('pet-adjust').onclick = ()=>{
    const sliders = byId('pet-sliders');
    sliders.hidden = !sliders.hidden;
    byId('pet-adjust').setAttribute('aria-expanded',String(!sliders.hidden));
    if (pet()?.position) place(pet().position);
};
widget.querySelectorAll('[data-pet-action]').forEach(button=>{
    button.onclick = ()=>interactWithPet(button.dataset.petAction);
});
stage.onclick = ()=>{if (timestamp() >= ignoreClickUntil) showPanel(panel.hidden);};
stage.addEventListener('pointerdown', event=>{
    if (!pet() || isSpawning() || event.button !== 0) return;
    const rect = widget.getBoundingClientRect();
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY, left:rect.left, top:rect.top, moved:false};
    stage.setPointerCapture(event.pointerId);
});
stage.addEventListener('pointermove', event=>{
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX-drag.x, dy = event.clientY-drag.y;
    if (!drag.moved && Math.hypot(dx,dy)<6) return;
    drag.moved = true;
    place({left:drag.left+dx,top:drag.top+dy});
});
function finishDrag(event){
    if (drag?.id !== event.pointerId) return;
    if (drag.moved && pet()){
        const rect = widget.getBoundingClientRect();
        pet().position = {left:rect.left,top:rect.top};
        ignoreClickUntil = timestamp()+300;
        interactWithPet('move');
    }
    drag = null;
}
stage.addEventListener('pointerup',finishDrag);
stage.addEventListener('pointercancel',finishDrag);
window.addEventListener('resize',()=>{if (pet()?.position && isVisible()) place(pet().position);});
window.addEventListener('pagehide',save);
new MutationObserver(()=>{
    syncVisibility();
    if (isVisible()) void loadScene(false);
}).observe(list,{attributes:true,attributeFilter:['hidden']});
document.addEventListener('visibilitychange',()=>{
    syncVisibility();
    if (isVisible()) void loadScene(false);
});
setInterval(()=>{
    if (!pet()) return;
    const now = timestamp();
    advance(now);
    if (isVisible()){
        decide(now);
        paintStats();
    }
    if (Math.floor(now/1000)%5 === 0) save();
},1000);
