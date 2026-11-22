import {initialStats, speciesConfig} from './desktop-pet-config.js';

const byId = id => document.getElementById(id);
const widget = byId('desktop-pet');
const list = byId('view-compare');
const stage = byId('pet-stage');
const panel = byId('pet-panel');
const notice = byId('pet-message');
const storageKey = 'pawthfinder_desktop_pets';
const labels = {
    satiety: '饱腹 Satiety', hydration: '水分 Hydration', happiness: '心情 Happiness',
    energy: '体力 Energy', health: '健康 Health', bond: '亲密 Bond',
};
const actions = {
    pet: {state: 'HAPPY', label: '抚摸', duration: 1700, cooldown: 1350, gain: {happiness: 7, bond: 4}},
    feed: {state: 'EATING', label: '喂食', duration: 3200, cooldown: 3800, gain: {satiety: 24}},
    drink: {state: 'DRINKING', label: '饮水', duration: 2800, cooldown: 3500, gain: {hydration: 26}},
    play: {state: 'PLAYING', label: '玩耍', duration: 4600, cooldown: 5200, gain: {happiness: 18, bond: 6, energy: -13, satiety: -6, hydration: -7}},
    sleep: {state: 'SLEEPING', label: '睡觉', duration: 16000, cooldown: 5000},
    check: {state: 'IDLE', label: '健康检查', duration: 3400, cooldown: 2500},
    move: {state: 'MOVING', label: '拖动位置', duration: 1550, cooldown: 0},
    dance: {state:'DANCING', label:'跳舞', duration:3700, cooldown:4300, gain:{happiness:12,bond:4,energy:-6}, message:'来跳支舞！'},
    bath: {state:'BATHING', label:'洗澡', duration:3400, cooldown:4300, gain:{happiness:5,bond:3}, message:'泡泡澡时间。'},
    study: {state:'STUDYING', label:'陪伴学习', duration:26000, cooldown:5000, gain:{bond:5}, message:'我陪你一起学习。'},
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
    slider.setAttribute('aria-label', '调整 '+label);
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
        row.textContent = new Date(item.at).toLocaleTimeString('zh-HK', {hour: '2-digit', minute: '2-digit', second: '2-digit'})
            + ' · ' + item.action + ' · ' + item.rule;
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
    byId('pet-rule').textContent = next.rule;
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
        state:'UNWELL', rule:'Health < 40', action:'健康提醒', reason:'健康值偏低，检查饱腹、水分和体力。',
        message:'有点不舒服，先检查我的照护状态。',
    };
    if (stats.hydration < 30) return {
        state:'IDLE', rule:'Hydration < 30', action:'提醒饮水', reason:'水分不足，等待你提供水。',
        message:'我渴了。',
    };
    if (stats.satiety < 30) return {
        state:'IDLE', rule:'Satiety < 30', action:'提醒喂食', reason:'饱腹值偏低，等待你提供' + profile.food + '。',
        message:profile.foodReminder ? 'Time for some hay!' : '我饿了。',
    };
    if (stats.energy < 25) return {
        state:'SLEEPING', rule:'Energy < 25', action:'自动睡觉', reason:'体力不足，先停下来恢复体力。',
        message:profile.nap,
    };
    if (stats.happiness < 40) return {
        state:'IDLE', rule:'Happiness < 40', action:'邀请互动', reason:'心情偏低，想和你互动。',
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
        publish({...currentDecision, reason:'继续安静休息，直到体力恢复到 60。'}, now);
        return;
    }
    if (now < nextRoutine){
        if (currentDecision?.state !== 'IDLE' || currentDecision?.rule !== '属性正常'){
            publish({state:'IDLE',rule:'属性正常',action:'待机',reason:'当前条件充足，安静观察。'},now);
        }
        return;
    }
    nextRoutine = now + 8000 + Math.random() * 3500;
    const minutesAway = (now - pet().lastInteraction) / 60000;
    if (profile.reunionMinutes && minutesAway >= profile.reunionMinutes){
        publish({state:'IDLE',rule:'陪伴间隔较长',action:'邀请玩耍',reason:'小狗一段时间没有和你互动。',message:profile.missed},now,4600);
        return;
    }
    if (profile.foodReminder && stats.satiety < profile.foodReminder){
        publish({state:'IDLE',rule:'兔子干草提醒',action:'请求干草',reason:'兔子的游戏设定更常提醒补充干草。',message:'Time for some hay!'},now,4600);
        return;
    }
    let roll = Math.random();
    const habit = Object.entries(profile.activity).find(([, weight])=>(roll -= weight) < 0)?.[0];
    if (habit === 'sleep' && stats.energy < 93){
        publish({state:'SLEEPING',rule:'物种日常权重',action:'小憩',reason:'根据该物种的休息权重选择小憩。',message:profile.nap},now,9500);
    } else if (habit === 'move'){
        publish({state:'MOVING',rule:'物种日常权重',action:'自主移动',reason:profile.wander},now,2450);
    } else if (habit === 'invite'){
        publish({state:'IDLE',rule:'小狗活动权重',action:'邀请玩耍',reason:'小狗的游戏设定偏好活动和陪伴。',message:profile.invite},now,4000);
    } else {
        publish({state:'IDLE',rule:'属性正常',action:'待机',reason:'当前条件充足，安静观察。'},now);
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
        tell('稍等一会儿再试。',now);
        return;
    }
    advance(now);
    animal.lastAction[action] = now;
    animal.lastInteraction = now;
    nextRoutine = now + rule.duration + 5000;
    let decision = {state:rule.state, rule:'手动互动', action:rule.label, reason:'用户选择了'+rule.label+'。', message:rule.message};
    if (action === 'pet' && profile.petLimit){
        animal.petTimes = animal.petTimes.filter(time => now - time < 14000);
        if (animal.petTimes.length >= profile.petLimit){
            change({happiness:-profile.petLoss});
            publish({
                state:store.selected === 'rabbit' ? 'MOVING' : 'IDLE',
                rule:'短时间内抚摸过多', action:'暂时躲开', reason:'让桌宠安静片刻再互动。', message:profile.reject,
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
    if (action === 'feed') decision.message = '吃一点' + profile.food + '。';
    if (action === 'drink') decision.message = '咕噜，喝点水。';
    if (action === 'pet') decision.message = profile.affection;
    if (action === 'play') decision.message = profile.toy + '来了！';
    if (action === 'sleep') decision.message = profile.nap;
    if (action === 'check'){
        const concern = need(animal.stats,profile);
        const issue = concern?.state === 'UNWELL' ? concern : null;
        decision = {...decision,state:issue?.state || 'IDLE',rule:concern?.rule || '属性正常',
            reason:concern?.reason || '目前没有触发照护提醒，保持规律互动。',
            message:concern?.message || '现在状态不错。'};
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
    byId('pet-visibility').textContent = store.hidden ? '显示桌宠' : '隐藏桌宠';
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
    sound.textContent = soundMuted ? '静音 Sound off' : '音效 Sound on';
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
                stageHint.textContent = '点击互动 · 拖动位置';
                publish({
                    state:'IDLE',rule:'属性正常',action:'待机',
                    reason:completed ? '全息召唤完成。' : '已结束召唤。',
                    message:completed ? config().greeting : '',
                },now,0,false);
            },
        })) return;
        clearTimeout(bubbleTimer);
        lastBubble = {message:'',at:0};
        notice.hidden = true;
        stageHint.textContent = '全息召唤中';
        publish({state:'SPAWNING',rule:'奶龙出场',action:'全息召唤',reason:'能量汇聚后重建并扫描模型。'},timestamp(),0,false);
    } catch (error) {
        byId('pet-load-status').textContent = '奶龙已载入。全息召唤启动失败，可从互动菜单重试。';
        console.error('Pico Nailong entrance',error);
    }
}

async function loadScene(appear){
    const type = store.selected;
    if (!isVisible() || !type || isSpawning()) return;
    const sequence = ++loadingSequence;
    canvasHost.hidden = true;
    replay.disabled = true;
    stageHint.textContent = '正在载入 '+config().name;
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
        stageHint.textContent = '点击互动 · 拖动位置';
        replay.disabled = false;
        if (summonRequested && type==='nailong'){
            summonRequested = false;
            startEntrance();
        }
    } catch (error) {
        rendererPromise = renderer ? rendererPromise : null;
        if (sequence !== loadingSequence || !isVisible()) return;
        summonRequested = false;
        stageHint.textContent = '3D 模型未载入';
        byId('pet-load-status').textContent = '桌宠加载失败。检查浏览器的 WebGL 支持，再点 Generate Pet 重试。';
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
        stage.setAttribute('aria-label',config().name+'，点击互动或拖动');
        publish({state:'IDLE',rule:'开启桌宠',action:'待机',reason:'已载入该物种的本地状态。',message:type==='nailong' ? '' : config().greeting},now);
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
