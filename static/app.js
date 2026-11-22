'use strict';
const $=s=>document.querySelector(s);
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const state={pets:[],selected:[],profile:null,result:null,scenario:null};
const pagesPreview=document.body.hasAttribute('data-pages-preview');
const numbers=['space','time','budget','years','activity','noise','grooming','experience','alone_hours','away_nights'];
const flags=['pet_allowed','backup','allergy','habitat_control','live_insects'];
async function api(path,data){
    if(pagesPreview){
        if(data!==undefined) throw Error('请运行 app.py 使用此功能。');
        path='./snapshot/'+path.slice('/api/'.length)+'.json';
    }
    const response=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(!response.ok && pagesPreview) throw Error('暂时无法读取演示数据。');
    const result=await response.json();
    if(!response.ok) throw Error(result.error||'服务暂时不可用');
    return result;
}
function notify(text){$('#toast').textContent=text;}
function modeText(mode){
    if(mode==='rules_only') return '专家规则模式';
    if(mode==='uploaded_user_data') return '本地上传评分 · 自训练模型';
    return mode.startsWith('synthetic') ? '随附合成数据 · 自训练模型' : '导入评分数据 · 自训练模型';
}
function list(items){const ul=node('ul');for(const text of items)ul.append(node('li',text));return ul;}
function fillProfile(profile){
    const values={...defaults,...profile};
    for(const key of numbers) $('#quiz').elements.namedItem(key).value=values[key]??'';
    for(const key of flags) $('#quiz').elements.namedItem(key).checked=Boolean(values[key]);
}
function readProfile(){const f=new FormData($('#quiz')),u={};for(const k of numbers)u[k]=Number(f.get(k));for(const k of flags)u[k]=f.has(k);return u;}
function showFromLocation(){
    const route=location.hash.slice(1);
    const petRoute=route.startsWith('pet-');
    const requested=petRoute?'catalog':route;
    const view=document.getElementById('view-'+requested)?.classList.contains('view')?requested:'home';
    for(const section of document.querySelectorAll('.view')) section.hidden=section.id!=='view-'+view;
    for(const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed',String(button.dataset.view===view));
    if(view==='community') openCommunity();
    if(view==='model') loadModel();
    if(view==='compare') renderCompare();
    if(petRoute) openLinkedProfile();
    window.scrollTo({top:0,behavior:'auto'});
}
function show(view,petId){
    const hash=petId?'#pet-'+petId:view==='home'?'':'#'+view;
    if(location.hash!==hash) history.pushState(null,'',hash||location.pathname+location.search);
    showFromLocation();
}
function openLinkedProfile(){
    if(!location.hash.startsWith('#pet-')) return;
    const pet=state.pets.find(item=>'#pet-'+item.id===location.hash);
    if(!pet) return;
    $('#catalog-search').value=pet.display_name||pet.name;
    $('#catalog-budget').value=10000;
    clearQuickFilters();
    renderCatalog();
    const details=document.getElementById('pet-'+pet.id)?.querySelector('details');
    if(details) details.open=true;
}
window.addEventListener('DOMContentLoaded',showFromLocation);
window.addEventListener('hashchange',showFromLocation);
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>show(b.dataset.view);
function petArt(p){const d=node('div',undefined,`pet-art art-${p.art_index??0}`);d.setAttribute('role','img');d.setAttribute('aria-label',p.display_name||p.name);return d;}
function renderHome(){$('#home-pets').replaceChildren();for(const p of state.pets){const card=node('button',undefined,'home-pet');card.type='button';card.append(petArt(p));const meta=node('div',undefined,'home-pet-meta');meta.append(node('span',String(p.art_index+1).padStart(2,'0'),'pet-number'),node('h3',p.display_name||p.name),node('span',p.fictional?'幻想伙伴':'了解一下 ↗','pet-link'));card.append(meta,node('p',p.tagline));card.onclick=()=>show('catalog',p.id);$('#home-pets').append(card);}}
$('#start-quiz').onclick=()=>show('match');$('#home-guide').onclick=()=>show('match');
function compareButton(p){const b=node('button',undefined,'compare-button');b.type='button';b.dataset.pet=p.id;b.onclick=()=>toggleCompare(p.id);updateCompareButton(b);return b;}
function updateCompareButton(b){const active=state.selected.includes(b.dataset.pet);b.textContent=active?'已加入 · 点击移除':'＋ 加入对比';b.classList.toggle('active',active);b.setAttribute('aria-label',`${active?'移除对比':'加入对比'} ${state.pets.find(p=>p.id===b.dataset.pet)?.name||''}`);b.setAttribute('aria-pressed',String(active));}
function toggleCompare(id){if(state.selected.includes(id))state.selected=state.selected.filter(x=>x!==id);else{if(state.selected.length>=3){notify('最多同时对比 3 类宠物，请先移除一项。');return;}state.selected.push(id);}try{localStorage.setItem('pawthfinder_compare',JSON.stringify(state.selected));}catch{}$('#compare-count').textContent=state.selected.length;for(const b of document.querySelectorAll('.compare-button'))updateCompareButton(b);renderCompare();notify(`对比清单中有 ${state.selected.length} 类宠物。`);}
function table(headers,rows){const wrap=node('div',undefined,'table-wrap'),t=node('table'),thead=node('thead'),tr=node('tr');for(const h of headers)tr.append(node('th',h));thead.append(tr);t.append(thead);const body=node('tbody');for(const row of rows){const tr=node('tr');for(const v of row){const td=node('td');if(v instanceof Node)td.append(v);else td.textContent=v;tr.append(td);}body.append(tr);}t.append(body);wrap.append(t);return wrap;}
const carePredicates={
    quiet: pet=>pet.noise<=2,
    short: pet=>pet.time<=1,
    beginner: pet=>pet.experience===0,
};
const careButtons=[...document.querySelectorAll('[data-care-filter]')];

function clearQuickFilters(){
    for(const button of careButtons) button.setAttribute('aria-pressed','false');
}

function renderCatalog(){
    const search=$('#catalog-search').value.trim().toLowerCase();
    const budget=Number($('#catalog-budget').value || 10000);
    const filters=careButtons.filter(button=>button.getAttribute('aria-pressed')==='true');
    const pets=state.pets.filter(pet=>{
        const matchesName=(pet.name+' '+pet.display_name).toLowerCase().includes(search);
        const matchesBudget=pet.budget<=budget;
        const matchesCare=!filters.length || (!pet.fictional && filters.every(button=>carePredicates[button.dataset.careFilter](pet)));
        return matchesName && matchesBudget && matchesCare;
    });
    const sort=$('#catalog-sort').value;
    if(sort!=='name') pets.sort((a,b)=>a[sort]-b[sort]);
    $('#catalog-grid').replaceChildren();
    $('#catalog-count').textContent='显示 '+pets.length+' / '+state.pets.length+' 位伙伴';
    if(!pets.length){
        $('#catalog-grid').append(node('p','没有符合条件的档案，请调整筛选。','empty'));
        return;
    }
for(const p of pets){const c=node('article',undefined,'catalog-card');c.id='pet-'+p.id;c.append(petArt(p),node('h3',p.display_name||p.name),node('p',p.note));if(p.fictional){c.append(node('span','幻想伙伴 · 不参与真实推荐','fiction-tag'));$('#catalog-grid').append(c);continue;}const facts=node('div',undefined,'facts');for(const [label,value] of [['每月预算',`HK$ ${p.budget}`],['每日时间',`${p.time} 小时`],['可用空间',`${p.space} ㎡`],['承诺期限',`${p.years} 年`]]){const d=node('div',label);d.append(node('strong',value));facts.append(d);}c.append(facts);const detail=node('details');detail.append(node('summary','更多照护属性'),list([`活动强度 ${p.activity}/5；噪声等级 ${p.noise}/5`,`护理强度 ${p.grooming}/5；经验等级 ${p.experience}/2`,`年度常规预算示例 HK$ ${p.budget*12}，不包含初始设备和意外医疗。`,'档案未由专业人士审定，不等于具体动物的照护标准。']));if(p.care_source){const source=node('a','阅读照护资料','care-source');source.href=p.care_source;source.target='_blank';source.rel='noopener noreferrer';detail.append(source);}c.append(detail,compareButton(p));$('#catalog-grid').append(c);}}
for(const id of ['catalog-search','catalog-budget','catalog-sort']) $('#'+id).addEventListener('input',renderCatalog);
for(const button of careButtons){
    button.onclick=()=>{
        button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));
        renderCatalog();
    };
}
$('#clear-catalog-filters').onclick=()=>{
    $('#catalog-search').value='';
    $('#catalog-budget').value=10000;
    $('#catalog-sort').value='name';
    clearQuickFilters();
    renderCatalog();
};

function renderCost(){
    const fields=['monthly','setup','reserve'].map(name=>$('#cost-'+name));
    const complete=fields.every(field=>field.value!=='' && field.validity.valid);
    const [monthly,setup,reserve]=fields.map(field=>Number(field.value));
    const currency=new Intl.NumberFormat('zh-HK',{style:'currency',currency:'HKD',maximumFractionDigits:0});
    $('#cost-total').value=complete ? currency.format(monthly*12+setup+reserve) : '—';
}

function selectCostPet(){
    const pet=state.pets.find(item=>item.id===$('#cost-pet').value);
    $('#cost-monthly').value=pet?.budget??'';
    renderCost();
}

function populateCostPets(){
    for(const pet of state.pets.filter(item=>!item.fictional)){
        const option=node('option',pet.display_name);
        option.value=pet.id;
        $('#cost-pet').append(option);
    }
    selectCostPet();
}

$('#cost-pet').addEventListener('change',selectCostPet);
$('#cost-form').addEventListener('input',renderCost);
$('#cost-form').addEventListener('submit',event=>event.preventDefault());
const desktopPetById={cat:'cat',small_dog:'dog',rabbit:'rabbit',nailong:'nailong'};
$('#compare-pets').addEventListener('click',async event=>{
    const button=event.target.closest('[data-generate-desktop-pet]');
    if(!button)return;
    try {
        const {generateDesktopPet}=await import('./desktop-pet.js');
        generateDesktopPet(button.dataset.generateDesktopPet);
    } catch(error) {
        notify('桌宠组件加载失败，请刷新后重试。');
        console.error('PawthFinder desktop pet',error);
    }
});
function renderCompare(){const pets=state.selected.map(id=>state.pets.find(p=>p.id===id)).filter(p=>p&&!p.fictional);$('#compare-empty').hidden=!!pets.length;$('#compare-content').replaceChildren();$('#compare-pets').replaceChildren();
const nailong=state.pets.find(p=>p.id==='nailong');
const cards=nailong?[...pets,nailong]:pets;
for(const pet of cards){
    const card=node('article',undefined,'compare-pet');
    const copy=node('div');
    copy.append(node('h3',pet.display_name||pet.name));
    if(desktopPetById[pet.id]){
        const button=node('button','Generate Pet','secondary');
        button.type='button';
        button.dataset.generateDesktopPet=desktopPetById[pet.id];
        button.setAttribute('aria-label','Generate Pet · '+(pet.display_name||pet.name));
        copy.append(button);
    }
    card.append(petArt(pet),copy);
    $('#compare-pets').append(card);
}
if(!pets.length)return;
const rows=[['每月预算（港币）',...pets.map(p=>p.budget)],['年度常规预算（港币）',...pets.map(p=>p.budget*12)],['每日照护时间（小时）',...pets.map(p=>p.time)],['可用空间（㎡）',...pets.map(p=>p.space)],['承诺期限（年）',...pets.map(p=>p.years)],['活动强度 / 5',...pets.map(p=>p.activity)],['噪声等级 / 5',...pets.map(p=>p.noise)],['护理强度 / 5',...pets.map(p=>p.grooming)],['经验等级 / 2',...pets.map(p=>p.experience)],['照护提醒',...pets.map(p=>p.note)]];
if(state.result){rows.push(['当前显示推荐中的状态',...pets.map(p=>{const yes=state.result.recommendations.find(x=>x.id===p.id);return yes?`适配评分 ${yes.score.toFixed(1)}`:'未通过规则';})]);}
rows.push(['清单操作',...pets.map(p=>{const b=node('button','移除','secondary');b.onclick=()=>toggleCompare(p.id);return b;})]);$('#compare-content').append(table(['属性',...pets.map(p=>p.emoji+' '+p.name)],rows));}
function renderResult(r,u){state.result=r;state.profile={...u};state.scenario=null;$('#scenario-box').hidden=true;$('#scenario-result').replaceChildren();$('#scenario-apply').hidden=true;$('#cards').replaceChildren();$('#excluded').replaceChildren();$('#summary').textContent=r.message+' '+r.notice+(r.model_version?' 模型版本 '+r.model_version+'。':'');$('#export').disabled=false;$('#scenario-open').disabled=false;
for(const [i,p] of r.recommendations.entries()){const c=node('article',undefined,'card'),head=node('div',undefined,'card-head'),left=node('div');left.append(node('h3',`${i+1}. ${p.name}`));const catalogPet=state.pets.find(x=>x.id===p.id);if(catalogPet)c.append(petArt(catalogPet));const score=node('div',`${p.score.toFixed(1)}`,'score');score.append(node('small','适配评分 / 100'));head.append(left,score);c.append(head);const bar=node('progress');bar.max=100;bar.value=p.score;bar.setAttribute('aria-label','适配评分');c.append(bar,node('p','规则检查依据（非神经网络归因）','small'),list(p.reasons));const d=node('details');d.append(node('summary','照护提醒与评分对照'),list([...p.warnings,`规则基线评分：${p.rule_score.toFixed(1)} / 100`]));c.append(d,compareButton(p));const feedback=node('div',undefined,'feedback'),label=node('span',r.ratings?.[p.id]?'评分已保存':'这个推荐适合你吗？');feedback.append(label);for(let rating=1;rating<=5;rating++){const b=node('button',String(rating));b.type='button';if(r.ratings?.[p.id]===rating)b.classList.add('selected');b.setAttribute('aria-label',`评分 ${rating} 分`);b.onclick=async()=>{try{await api('/api/feedback',{run_id:r.run_id,pet_id:p.id,rating});r.ratings={...r.ratings,[p.id]:rating};for(const other of feedback.querySelectorAll('button'))other.classList.remove('selected');b.classList.add('selected');label.textContent='评分已保存';}catch(err){label.textContent=err.message;}};feedback.append(b);}c.append(feedback);$('#cards').append(c);}
$('#excluded-panel').hidden=r.excluded.length===0;for(const p of r.excluded){const d=node('div',undefined,'exclude-item');d.append(node('strong',p.name),list(p.blocked));$('#excluded').append(d);}renderCompare();}
$('#quiz').addEventListener('submit',async e=>{e.preventDefault();$('#error').textContent='';$('#submit').disabled=true;try{const u=readProfile(),r=await api('/api/recommend',u);renderResult(r,u);notify('已生成推荐并保存到本会话历史。');}catch(err){$('#error').textContent=err.message;}finally{$('#submit').disabled=false;}});
$('#scenario-open').onclick=()=>{if(!state.profile)return;$('#scenario-box').hidden=!$('#scenario-box').hidden;for(const k of ['budget','time','space'])$('#scenario-'+k).value=state.profile[k];};
$('#scenario-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{const before={...state.profile},after={...before};for(const k of ['budget','time','space'])after[k]=Number($('#scenario-'+k).value);const r=await api('/api/scenario',{before,after});state.scenario=after;$('#scenario-result').replaceChildren(node('p',`合格候选：${r.before_count} → ${r.after_count} 类。未通过规则的候选不显示评分。`),table(['宠物','原评分','新评分','变化'],r.changes.map(p=>[p.name,p.before===null?'—':p.before.toFixed(1),p.after===null?'—':p.after.toFixed(1),p.delta===null?p.state:`${p.delta>0?'+':''}${p.delta.toFixed(1)} · ${p.state}`])));const excluded=r.changes.filter(p=>p.blocked.length);if(excluded.length){const d=node('details');d.append(node('summary','查看新条件下仍不合格的原因'),list(excluded.map(p=>p.name+'：'+p.blocked.join('；'))));$('#scenario-result').append(d);}$('#scenario-apply').hidden=false;}catch(err){$('#scenario-result').textContent=err.message;$('#scenario-apply').hidden=true;}finally{button.disabled=false;}};
$('#scenario-apply').onclick=()=>{if(state.scenario){fillProfile(state.scenario);notify('已填入新条件。点击“探索我的宠物伙伴”生成并保存新推荐；当前卡片仍是原结果。');}};
$('#export').onclick=()=>{if(!state.result)return;const r=state.result,u=state.profile;const lines=['# PawthFinder 宠物推荐报告','',`记录编号：${r.run_id}`,`模型模式：${modeText(r.mode)}`,'','## 问卷资料',...Object.entries(u).map(([k,v])=>`- ${k}: ${v}`),'','## 推荐结果'];for(const [i,p] of r.recommendations.entries())lines.push(`### ${i+1}. ${p.name} · ${p.score}/100`,...p.reasons.map(t=>'- '+t),...p.warnings.map(t=>'- 提醒：'+t),'');if(!r.recommendations.length)lines.push('暂无满足规则的宠物。');lines.push('## 未通过规则',...r.excluded.map(p=>`- ${p.name}：${p.blocked.join('；')}`),'','## 说明',r.notice,'所有档案阈值为教学示例。模拟训练指标不代表真实推荐效果。');const blob=new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=`PawthFinder_Report_${r.run_id.slice(0,8)}.md`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已下载 Markdown 报告，可用文本编辑器打开。');};
let defaults=null;
for(const b of document.querySelectorAll('[data-preset]'))b.onclick=()=>{if(!defaults)return;let p={...defaults};if(b.dataset.preset==='busy')Object.assign(p,{time:.5,budget:500,years:3});if(b.dataset.preset==='active')Object.assign(p,{space:60,time:4,budget:2200,activity:5,noise:5,grooming:4,experience:1,years:18});fillProfile(p);notify('示例问卷已填入。请按真实情况修改后提交；当前结果尚未更新。');};
api('/api/info').then(j=>{defaults=j.defaults;state.pets=j.pets;populateCostPets();$('#mode').textContent=modeText(j.mode);try{const saved=JSON.parse(localStorage.getItem('pawthfinder_compare')||'[]');if(Array.isArray(saved))state.selected=[...new Set(saved)].filter(id=>j.pets.some(p=>p.id===id)).slice(0,3);}catch{}$('#compare-count').textContent=state.selected.length;renderCatalog();renderCompare();renderHome();openLinkedProfile();}).catch(e=>{$('#mode').textContent=e.message;notify(pagesPreview?e.message:'无法连接服务，请确认 app.py 正在运行。');});
