'use strict';
const $=s=>document.querySelector(s);
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const state={pets:[],selected:[],profile:null,result:null,scenario:null};
const pagesPreview=document.body.hasAttribute('data-pages-preview');
const apiBase=new URL($('meta[name="pawth-api-base"]')?.content||(pagesPreview?'./snapshot/':'./api/'),document.baseURI);
const onlineQuiz=$('#online-quiz');
const numbers=['space','time','budget','years','activity','noise','grooming','experience','alone_hours','away_nights'];
const flags=['pet_allowed','backup','habitat_control','live_insects'];
const allergy={
    checkbox:$('#has-allergy'), panel:$('#allergy-questions'), fields:$('#allergy-fields'),
    options:$('#allergy-options'), toggle:$('#allergy-other-toggle'),
    otherLabel:$('#allergy-other-label'), other:$('#allergy-fields [name=other_allergy]'),
    uncertain:$('#allergy-fields [name=allergy_uncertain]'),
};
function apiUrl(path){
    const endpoint=path.slice('/api/'.length);
    return new URL(pagesPreview?endpoint+'.json':endpoint,apiBase);
}
async function requestApi(path,options={},timeout=25000){
    if(pagesPreview&&options.method==='POST') throw Error('Open the online app to submit data.');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeout);
    try{
        const response=await fetch(apiUrl(path),{...options,signal:controller.signal,credentials:'same-origin'});
        const result=await response.json().catch(()=>null);
        if(controller.signal.aborted) throw Error('The request timed out.');
        if(!response.ok){
            const fallback=[502,503,504].includes(response.status)
                ? 'The service may be starting or temporarily unavailable. Try again shortly.' : 'The request failed. Try again.';
            const error=Error(result?.error||fallback);
            if(result?.recommendation_status) error.decision=result;
            throw error;
        }
        if(!result) throw Error('The service returned an unreadable response. Try again.');
        return result;
    }catch(error){
        if(controller.signal.aborted) throw Error('The service took too long to respond. Check your connection or try again shortly.');
        if(error instanceof TypeError) throw Error('The service could not be reached. Check your connection and try again.');
        throw error;
    }finally{
        clearTimeout(timer);
    }
}
function api(path,data){
    return requestApi(path,data===undefined?{}:{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),
    });
}

let checkingOnlineQuiz=false;
async function openOnlineQuiz(){
    if(!onlineQuiz||checkingOnlineQuiz) return;
    const match=$('#view-match');
    const status=$('#online-status');
    const retry=$('#online-retry');
    const health=new URL('api/health',onlineQuiz.href);
    checkingOnlineQuiz=true;
    retry.hidden=true;
    status.textContent='Connecting to the recommendation service…';
    const slow=setTimeout(()=>{
        status.textContent='The recommendation service may be starting up. Please wait…';
    },5500);
    const deadline=Date.now()+65000;
    let unavailable='The online recommendation service could not be reached. Try reconnecting.';
    try{
        while(!match.hidden&&Date.now()<deadline){
            const controller=new AbortController();
            const timer=setTimeout(()=>controller.abort(),Math.min(16000,deadline-Date.now()));
            try{
                const response=await fetch(health,{credentials:'omit',cache:'no-store',signal:controller.signal});
                const result=await response.json().catch(()=>null);
                if(response.ok&&result?.database==='ok'){
                    if(!match.hidden) window.location.replace(onlineQuiz.href);
                    return;
                }
                if(result?.model_loaded===false){
                    unavailable='The online service has yet to load the model. Try again shortly.';
                    break;
                }
            }catch{
                // Keep the direct application link available while the connection is retried.
            }finally{
                clearTimeout(timer);
            }
            if(!match.hidden&&Date.now()<deadline){
                await new Promise(resolve=>setTimeout(resolve,Math.min(5000,deadline-Date.now())));
            }
        }
        status.textContent=unavailable;
        retry.hidden=false;
    }finally{
        clearTimeout(slow);
        checkingOnlineQuiz=false;
    }
}
$('#online-retry')?.addEventListener('click',openOnlineQuiz);
function notify(text){$('#toast').textContent=text;}
function modeText(mode){
    if(mode==='rules_only') return 'Expert System fallback · Model inference unavailable';
    if(mode==='uploaded_user_data') return 'Locally uploaded ratings · Trained model';
    return mode.startsWith('synthetic') ? 'Bundled synthetic dataset · Trained model' : 'Imported ratings · Trained model';
}
function list(items){const ul=node('ul');for(const text of items)ul.append(node('li',text));return ul;}
function updateOtherAllergy(){
    const show=allergy.checkbox.checked&&allergy.toggle.checked;
    allergy.toggle.setAttribute('aria-expanded',String(show));
    allergy.otherLabel.hidden=!show;
    allergy.other.disabled=!show;
    if(!show) allergy.other.value='';
}
function updateAllergyQuestions(){
    const show=allergy.checkbox.checked;
    allergy.checkbox.setAttribute('aria-expanded',String(show));
    allergy.panel.classList.toggle('is-open',show);
    allergy.panel.setAttribute('aria-hidden',String(!show));
    allergy.panel.inert=!show;
    allergy.fields.disabled=!show;
    if(!show){
        for(const input of allergy.fields.querySelectorAll('input[type=checkbox]')) input.checked=false;
    }
    updateOtherAllergy();
}
function populateAllergyOptions(options,notice){
    allergy.options.replaceChildren();
    for(const option of options){
        const label=node('label');
        const input=node('input');
        input.type='checkbox';
        input.name='allergy_types';
        input.value=option.id;
        label.append(input,' '+option.name);
        allergy.options.append(label);
    }
    if(notice) $('#allergy-notice').textContent=notice;
}
function fillProfile(profile){
    const values={...defaults,...profile};
    for(const key of numbers) $('#quiz').elements.namedItem(key).value=values[key]??'';
    for(const key of flags) $('#quiz').elements.namedItem(key).checked=Boolean(values[key]);
    allergy.checkbox.checked=Boolean(values.has_allergy??values.allergy);
    allergy.uncertain.checked=Boolean(values.allergy_uncertain??(!Object.hasOwn(values,'has_allergy')&&values.allergy));
    for(const input of allergy.options.querySelectorAll('input')) input.checked=(values.allergy_types||[]).includes(input.value);
    allergy.other.value=values.other_allergy||'';
    allergy.toggle.checked=Boolean(allergy.other.value);
    updateAllergyQuestions();
}
function readProfile(){
    const form=new FormData($('#quiz'));
    const profile={};
    for(const key of numbers){
        const value=form.get(key);
        profile[key]=typeof value==='string'&&value.trim()?Number(value):null;
    }
    for(const key of flags) profile[key]=form.has(key);
    profile.has_allergy=form.has('has_allergy');
    profile.allergy_types=profile.has_allergy?form.getAll('allergy_types'):[];
    profile.allergy_uncertain=profile.has_allergy&&form.has('allergy_uncertain');
    profile.other_allergy=profile.has_allergy?String(form.get('other_allergy')||'').trim():'';
    return profile;
}
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
    if(view==='match'&&pagesPreview) void openOnlineQuiz();
    if(view==='match') void playVirtualPreview();
    else stopVirtualPreview();
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
function renderHome(){$('#home-pets').replaceChildren();for(const p of state.pets){const card=node('button',undefined,'home-pet');card.type='button';card.append(petArt(p));const meta=node('div',undefined,'home-pet-meta');meta.append(node('span',String(p.art_index+1).padStart(2,'0'),'pet-number'),node('h3',p.display_name||p.name),node('span',p.fictional?'Virtual companion':'Meet them ↗','pet-link'));card.append(meta,node('p',p.tagline));card.onclick=()=>show('catalog',p.id);$('#home-pets').append(card);}}
$('#start-quiz').onclick=()=>show('match');$('#home-guide').onclick=()=>show('match');
function compareButton(p){const b=node('button',undefined,'compare-button');b.type='button';b.dataset.pet=p.id;b.onclick=()=>toggleCompare(p.id);updateCompareButton(b);return b;}
function updateCompareButton(b){const active=state.selected.includes(b.dataset.pet);b.textContent=active?'In My List · Click to remove':'＋ Add to My List';b.classList.toggle('active',active);b.setAttribute('aria-label',`${active?'Remove from My List':'Add to My List'} ${state.pets.find(p=>p.id===b.dataset.pet)?.name||''}`);b.setAttribute('aria-pressed',String(active));}
function toggleCompare(id){if(state.selected.includes(id))state.selected=state.selected.filter(x=>x!==id);else{if(state.selected.length>=3){notify('You can compare up to three pets. Remove one before adding another.');return;}state.selected.push(id);}try{localStorage.setItem('pawthfinder_compare',JSON.stringify(state.selected));}catch{}$('#compare-count').textContent=state.selected.length;for(const b of document.querySelectorAll('.compare-button'))updateCompareButton(b);renderCompare();notify(`My List has ${state.selected.length} ${state.selected.length === 1 ? 'pet' : 'pets'}.`);}
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
    $('#catalog-count').textContent='Showing '+pets.length+' / '+state.pets.length+' companions';
    if(!pets.length){
        $('#catalog-grid').append(node('p','No profiles match these filters. Try adjusting them.','empty'));
        return;
    }
for(const p of pets){const c=node('article',undefined,'catalog-card');c.id='pet-'+p.id;c.append(petArt(p),node('h3',p.display_name||p.name),node('p',p.note));if(p.fictional){c.append(node('span','Virtual companion · Separate from real-pet recommendations','fiction-tag'));$('#catalog-grid').append(c);continue;}const facts=node('div',undefined,'facts');for(const [label,value] of [['Monthly budget',`HK$ ${p.budget}`],['Daily care time',`${p.time} h`],['Available space',`${p.space} m²`],['Care commitment',`${p.years} years`]]){const d=node('div',label);d.append(node('strong',value));facts.append(d);}c.append(facts);const detail=node('details');detail.append(node('summary','More care details'),list([`Activity ${p.activity}/5 · Noise ${p.noise}/5`,`Grooming and cleaning ${p.grooming}/5 · Experience ${p.experience}/2`,`Example annual budget HK$ ${p.budget*12}, excluding equipment and unexpected veterinary costs.`,'These teaching profiles are unreviewed by care professionals. Care needs vary by individual animal.']));if(p.care_source){const source=node('a','Read care guidance','care-source');source.href=p.care_source;source.target='_blank';source.rel='noopener noreferrer';detail.append(source);}c.append(detail,compareButton(p));$('#catalog-grid').append(c);}}
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
    const currency=new Intl.NumberFormat('en-GB',{style:'currency',currency:'HKD',maximumFractionDigits:0});
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
        const {generateDesktopPet}=await import('./desktop-pet.js?v=en-GB');
        generateDesktopPet(button.dataset.generateDesktopPet);
    } catch(error) {
        notify('The desktop pet could not load. Refresh and try again.');
        console.error('Pico desktop pet',error);
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
const rows=[['Monthly budget (HKD)',...pets.map(p=>p.budget)],['Annual costs (HKD)',...pets.map(p=>p.budget*12)],['Daily care time (hours)',...pets.map(p=>p.time)],['Available space (m²)',...pets.map(p=>p.space)],['Care commitment (years)',...pets.map(p=>p.years)],['Activity / 5',...pets.map(p=>p.activity)],['Noise / 5',...pets.map(p=>p.noise)],['Grooming and cleaning / 5',...pets.map(p=>p.grooming)],['Experience / 2',...pets.map(p=>p.experience)],['Care notes',...pets.map(p=>p.note)]];
if(state.result?.run_id){rows.push(['Current recommendation',...pets.map(p=>{const yes=state.result.recommendations.find(x=>x.id===p.id);return yes?`Compatibility score ${yes.score.toFixed(1)}`:'Filtered out';})]);}
rows.push(['List actions',...pets.map(p=>{const b=node('button','Remove','secondary');b.onclick=()=>toggleCompare(p.id);return b;})]);$('#compare-content').append(table(['Attribute',...pets.map(p=>p.emoji+' '+p.name)],rows));}
const virtualResult=$('#virtual-result');
const adoptPartner=$('#virtual-adopt');
let previewScene,previewLoading;
let previewRequest=0;

function stopVirtualPreview(){
    previewRequest++;
    previewScene?.setVisible(false);
}
async function playVirtualPreview(){
    const companion=state.result?.virtual_companion;
    if(!companion||virtualResult.hidden||$('#view-match').hidden||document.hidden) return;
    const request=++previewRequest;
    const status=$('#virtual-preview-status');
    status.hidden=false;
    status.textContent='Loading the Naylong 3D model…';
    try{
        previewLoading ||= import('./desktop-pet-scene.js').then(async module=>{
            previewScene ||= module.createPetScene($('#virtual-preview'));
            await previewScene.select(companion.id,false);
            return previewScene;
        }).catch(error=>{previewLoading=null;throw error;});
        const scene=await previewLoading;
        if(request!==previewRequest) return;
        scene.setVisible(true);
        scene.playEntrance({onEnd:()=>{}});
        status.hidden=true;
    }catch{
        if(request!==previewRequest) return;
        status.textContent='The 3D preview could not load. Try again from My List.';
    }
}
document.addEventListener('visibilitychange',()=>{
    if(document.hidden) stopVirtualPreview();
    else void playVirtualPreview();
});
adoptPartner.onclick=async()=>{
    const companion=state.result?.virtual_companion;
    if(!companion) return;
    adoptPartner.disabled=true;
    try{
        const {generateDesktopPet}=await import('./desktop-pet.js?v=en-GB');
        if(state.result?.virtual_companion!==companion) return;
        show('compare');
        generateDesktopPet(companion.id);
    }catch{
        notify('The desktop pet is temporarily unavailable. Try again shortly.');
    }finally{
        adoptPartner.disabled=false;
    }
};
$('#virtual-adjust').onclick=()=>$('#quiz [name=space]').focus();

function resetRecommendation(){
    state.result=null;
    state.profile=null;
    state.scenario=null;
    $('#scenario-box').hidden=true;
    $('#scenario-apply').hidden=true;
    $('#export').disabled=true;
    $('#scenario-open').disabled=true;
    for(const id of ['cards','excluded','decision-trace','scenario-result']) $('#'+id).replaceChildren();
    for(const id of ['excluded-panel','decision-explanation','decision-notices']) $('#'+id).hidden=true;
    $('#decision-explanation').open=false;
    $('#excluded-panel').open=false;
    virtualResult.hidden=true;
    stopVirtualPreview();
    renderCompare();
}

function renderVirtualResult(result){
    const companion=result.virtual_companion;
    virtualResult.hidden=!companion;
    if(!companion) return;
    $('#virtual-title').textContent=companion.name+(companion.optional?' · Optional virtual companion':' · Your virtual companion');
    $('#virtual-message').textContent=companion.message;
    const guidance=$('#virtual-guidance');
    const triggers=result.triggered_rules.filter(rule=>rule.kind==='hard_constraint');
    guidance.hidden=triggers.length===0&&!result.suggestions.length;
    guidance.open=true;
    const gaps=triggers.map(rule=>{
        const pet=result.excluded_pets.find(item=>rule.pet_ids.includes(item.id));
        const example=result.exclusion_reasons[pet.id].find(check=>check.rule_id===rule.rule_id);
        return rule.rule_id+' · '+pet.name+' · '+example.reason;
    });
    $('#virtual-guidance-content').replaceChildren(list(gaps),list(result.suggestions));
    void playVirtualPreview();
}

const inferenceLabels={
    EXECUTED:'PyTorch inference ran on the real pets that passed screening.',
    RULES_ONLY:'Compatibility scores use the Expert System fallback.',
    SKIPPED_NO_ELIGIBLE:'Hard Constraint Filtering left no candidates, so model inference did not run.',
    SKIPPED_OUT_OF_DOMAIN:'Model inference was skipped because your answers are outside the model’s supported range.',
    SKIPPED_INVALID_INPUT:'Model inference was skipped because the quiz answers did not pass validation.',
    FAILED:'The inference service encountered a problem.',
    NOT_RUN:'Model inference did not run.',
};
function renderDecisionTrace(result){
    const details=$('#decision-explanation');
    details.hidden=!result.recommendation_status;
    if(details.hidden) return;
    const trace=$('#decision-trace');
    const profile=result.input_summary;
    if(profile){
        const known=(profile.allergy_types||[]).map(id=>state.pets.find(pet=>pet.id===id)?.display_name||id);
        const hasAllergy=profile.has_allergy??profile.allergy;
        const allergyAnswer=hasAllergy?[
            'Known allergy',known.length?known.join(', '):'No specific animal selected',
            profile.allergy_uncertain?'Allergen uncertain':'',profile.other_allergy,
        ].filter(Boolean).join(' · '):'No animal-related allergy reported';
        trace.append(table(['Quiz field','Your answers'],[
            ['Space and daily care time',profile.space+' m² · '+profile.time+' h'],
            ['Budget and care commitment','HK$ '+profile.budget+' · '+profile.years+' years'],
            ['Housing permission and backup care',(profile.pet_allowed?'Allowed':'Restricted')+' · '+(profile.backup?'Arranged':'Not arranged')],
            ['Activity, noise and grooming',[profile.activity,profile.noise,profile.grooming].join(' / ')],
            ['Experience and time away',profile.experience+' / 2 · '+profile.alone_hours+' h · Nights away per month: '+profile.away_nights],
            ['Habitat and live feeder insects',(profile.habitat_control?'Habitat care available':'Habitat care pending')+' · '+(profile.live_insects?'Live feeder insects available':'Live feeder insects unavailable')],
            ['Animal-related allergy',allergyAnswer],
        ]));
    }
    if(result.eligible_count!==null){
        trace.append(node('p',result.eligible_count+' of '+result.real_pet_count+' real-pet profiles passed Hard Constraint Filtering.'));
    }
    if(result.triggered_rules.length){
        trace.append(list(result.triggered_rules.map(rule=>rule.rule_id+' · '+rule.label+' · '+
            (rule.kind==='caution'?rule.reason:rule.pet_ids.length+' profiles triggered this rule'))));
    }
    trace.append(node('p',inferenceLabels[result.model_inference_status]),
        node('p',result.decision_reason));
    if(result.ranking.length){
        trace.append(table(['Rank','Real pet','Compatibility score'],result.ranking.map(pet=>[pet.rank,pet.name,pet.score.toFixed(1)])));
    }
    if(result.virtual_companion){
        trace.append(node('p',(result.fallback_triggered?'The virtual companion fallback was triggered. ':'A virtual companion is available as an option. ')+result.fallback_reason));
    }
}

function renderResult(result){
    state.result=result;
    state.profile=result.input_summary;
    const version=result.model_inference_status==='EXECUTED'?' · Model version '+result.model_version:'';
    const mode=result.model_inference_status==='EXECUTED'||result.model_inference_status==='RULES_ONLY'
        ?modeText(result.mode)+version+'. ':'';
    $('#summary').textContent=mode+result.decision_reason;
    $('#export').disabled=!result.run_id;
    $('#scenario-open').disabled=!result.run_id;
    const notices=$('#decision-notices');
    notices.textContent=[result.allergy_notice,...result.triggered_rules.filter(rule=>rule.kind==='caution').map(rule=>rule.reason)].filter(Boolean).join(' ');
    notices.hidden=!notices.textContent;
    for(const [index,pet] of result.recommendations.entries()){
        const card=node('article',undefined,'card');
        const catalogPet=state.pets.find(item=>item.id===pet.id);
        if(catalogPet) card.append(petArt(catalogPet));
        const head=node('div',undefined,'card-head');
        const score=node('div',pet.score.toFixed(1),'score');
        score.append(node('small','Compatibility score / 100'));
        head.append(node('h3',(index+1)+'. '+pet.name),score);
        const bar=node('progress');
        bar.max=100;
        bar.value=pet.score;
        bar.setAttribute('aria-label','Compatibility score');
        const details=node('details');
        details.append(node('summary','Care notes and score comparison'),
            list([...pet.warnings,'Expert System baseline score: '+pet.rule_score.toFixed(1)+' / 100']));
        card.append(head,bar,node('p','Evidence from rule checks','small'),list(pet.reasons),
            details,compareButton(pet),recommendationFeedback(result,pet));
        $('#cards').append(card);
    }
    $('#excluded-panel').hidden=result.excluded_pets.length===0;
    for(const pet of result.excluded_pets){
        const item=node('div',undefined,'exclude-item');
        item.append(node('strong',pet.name),list(result.exclusion_reasons[pet.id].map(check=>check.rule_id+' · '+check.reason)));
        $('#excluded').append(item);
    }
    renderDecisionTrace(result);
    renderVirtualResult(result);
    renderCompare();
}
function recommendationFeedback(result,pet){
    const row=node('div',undefined,'feedback');
    const label=node('span',result.ratings?.[pet.id]?'Rating saved':'How well does this recommendation fit?');
    label.setAttribute('role','status');
    const buttons=[];
    for(let rating=1;rating<=5;rating++){
        const button=node('button',String(rating));
        button.type='button';
        const selected=result.ratings?.[pet.id]===rating;
        button.classList.toggle('selected',selected);
        button.setAttribute('aria-pressed',String(selected));
        button.setAttribute('aria-label','Rate '+rating+' out of 5');
        button.onclick=async()=>{
            for(const option of buttons) option.disabled=true;
            label.textContent='Saving your rating…';
            try{
                await api('/api/feedback',{run_id:result.run_id,pet_id:pet.id,rating});
                result.ratings={...result.ratings,[pet.id]:rating};
                for(const option of buttons){
                    option.classList.toggle('selected',option===button);
                    option.setAttribute('aria-pressed',String(option===button));
                }
                label.textContent='Rating saved';
            }catch(error){
                label.textContent=error.message;
            }finally{
                for(const option of buttons) option.disabled=false;
            }
        };
        buttons.push(button);
    }
    row.append(label,...buttons);
    return row;
}
const quiz=$('#quiz');
const quizSubmit=$('#submit');
const submitLabel=quizSubmit.textContent;
allergy.checkbox.addEventListener('change',updateAllergyQuestions);
allergy.toggle.addEventListener('change',updateOtherAllergy);
updateAllergyQuestions();
quiz.addEventListener('input',event=>event.target.removeAttribute('aria-invalid'));
quiz.addEventListener('submit',async event=>{
    event.preventDefault();
    if(pagesPreview||quizSubmit.disabled) return;
    const errorBox=$('#error');
    const status=$('#quiz-status');
    errorBox.textContent='';
    status.textContent='';
    resetRecommendation();
    const invalid=[...quiz.elements].find(field=>field.willValidate&&
        (field.validity.valueMissing||field.validity.badInput||field.valueAsNumber<0));
    if(invalid){
        const label=invalid.closest('label')?.firstChild?.textContent.trim()||'Quiz field';
        invalid.setAttribute('aria-invalid','true');
        invalid.focus();
        const message=invalid.validity.badInput ? 'Enter a number.' :
            invalid.valueAsNumber<0 ? 'Enter a number of 0 or more.' : 'This field is required.';
        errorBox.textContent=label+'. '+message;
        $('#summary').textContent='Check your answers and submit the quiz again.';
        return;
    }
    const profile=readProfile();
    quizSubmit.disabled=true;
    quizSubmit.setAttribute('aria-busy','true');
    quizSubmit.textContent='Analysing your lifestyle…';
    $('#summary').textContent='Checking your answers against the care profiles…';
    const slow=setTimeout(()=>{
        status.textContent='The service is taking a while and may be starting up. Please wait…';
    },5500);
    try{
        const result=await api('/api/recommend',profile);
        renderResult(result);
        status.textContent='Recommendations updated.';
        $('#match-results').scrollIntoView({block:'start',
            behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    }catch(error){
        status.textContent='';
        if(error.decision?.recommendation_status==='OUT_OF_DOMAIN'){
            renderResult(error.decision);
            $('#match-results').scrollIntoView({block:'start'});
        }else{
            errorBox.textContent=error.message;
            if(error.decision) renderResult(error.decision);
            else $('#summary').textContent='Recommendations are temporarily unavailable. Try submitting again shortly.';
        }
    }finally{
        clearTimeout(slow);
        quizSubmit.disabled=false;
        quizSubmit.removeAttribute('aria-busy');
        quizSubmit.textContent=submitLabel;
    }
});
$('#scenario-open').onclick=()=>{if(!state.profile)return;$('#scenario-box').hidden=!$('#scenario-box').hidden;for(const k of ['budget','time','space'])$('#scenario-'+k).value=state.profile[k];};
$('#scenario-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{const before={...state.profile},after={...before};for(const k of ['budget','time','space'])after[k]=Number($('#scenario-'+k).value);const r=await api('/api/scenario',{before,after});state.scenario=after;$('#scenario-result').replaceChildren(node('p',`Eligible profiles: ${r.before_count} → ${r.after_count}. Scores are shown for eligible pets.`),table(['Pet','Original score','New score','Change'],r.changes.map(p=>[p.name,p.before===null?'—':p.before.toFixed(1),p.after===null?'—':p.after.toFixed(1),p.delta===null?p.state_label:`${p.delta>0?'+':''}${p.delta.toFixed(1)} · ${p.state_label}`])));const excluded=r.changes.filter(p=>p.blocked.length);if(excluded.length){const d=node('details');d.append(node('summary','See which profiles the new conditions exclude and why'),list(excluded.map(p=>p.name+': '+p.blocked.join('; '))));$('#scenario-result').append(d);}$('#scenario-apply').hidden=false;}catch(err){$('#scenario-result').textContent=err.message;$('#scenario-apply').hidden=true;}finally{button.disabled=false;}};
$('#scenario-apply').onclick=()=>{if(state.scenario){fillProfile(state.scenario);notify('The new values are in the quiz. Select See my recommendations to generate and save updated results. The current cards show the previous results.');}};
$('#export').onclick=()=>{if(!state.result)return;const r=state.result,u=state.profile;const lines=['# Pico Pet Recommendation Report','',`Run ID: ${r.run_id}`,`Model mode: ${modeText(r.mode)}`,'','## Quiz responses',...Object.entries(u).map(([k,v])=>`- ${k}: ${v}`),'','## Recommendations'];for(const [i,p] of r.recommendations.entries())lines.push(`### ${i+1}. ${p.name} · ${p.score}/100`,...p.reasons.map(t=>'- '+t),...p.warnings.map(t=>'- Care note: '+t),'');if(!r.recommendations.length)lines.push('No pets passed the screening rules.');lines.push('## Filtered out',...r.excluded.map(p=>`- ${p.name}: ${p.blocked.join('; ')}`),'','## Notes',r.notice,'All care thresholds are teaching examples. The training metrics describe the synthetic data used in this demo.');const blob=new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=`Pico_Report_${r.run_id.slice(0,8)}.md`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('The Markdown report has downloaded. You can open it in a text editor.');};
let defaults=null;
for(const b of document.querySelectorAll('[data-preset]'))b.onclick=()=>{if(!defaults)return;let p={...defaults};if(b.dataset.preset==='busy')Object.assign(p,{time:.5,budget:500,years:3});if(b.dataset.preset==='active')Object.assign(p,{space:60,time:4,budget:2200,activity:5,noise:5,grooming:4,experience:1,years:18});fillProfile(p);notify('The demo answers are in the quiz. Update them to match your situation and submit to refresh the results.');};
api('/api/info').then(j=>{defaults=j.defaults;state.pets=j.pets;populateAllergyOptions(j.allergy_options||[],j.allergy_notice);populateCostPets();$('#mode').textContent=modeText(j.mode);try{const saved=JSON.parse(localStorage.getItem('pawthfinder_compare')||'[]');if(Array.isArray(saved))state.selected=[...new Set(saved)].filter(id=>j.pets.some(p=>p.id===id)).slice(0,3);}catch{}$('#compare-count').textContent=state.selected.length;renderCatalog();renderCompare();renderHome();openLinkedProfile();}).catch(e=>{$('#mode').textContent=e.message;notify(e.message);});
