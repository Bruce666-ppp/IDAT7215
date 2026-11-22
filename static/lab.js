'use strict';

const trainingUi={
    form:$('#training-upload'),
    file:$('#training-file'),
    preview:$('#training-preview-content'),
    previewButton:$('#training-preview'),
    start:$('#training-start'),
    progress:$('#training-progress'),
    status:$('#training-status'),
};
const splitNames={train:'Training set',validation:'Validation set',test:'Test set'};
let trainingJob=null;
let pollTimer;
let restoreAttempted=false;

function displayJob(job){
    trainingJob=job;
    const running=job?.status==='running';
    const ready=job?.status==='ready'||job?.status==='failed';
    trainingUi.file.disabled=running;
    trainingUi.previewButton.disabled=running;
    trainingUi.start.hidden=!ready;
    trainingUi.start.disabled=!ready;
    trainingUi.progress.hidden=!running;
    trainingUi.preview.hidden=!job;
    if(!job){
        trainingUi.status.textContent='';
        trainingUi.preview.replaceChildren();
        return;
    }
    const fingerprint=node('p','Dataset fingerprint '+job.dataset_sha256.slice(0,16)+'…','small');
    const summary=node('p',job.dataset_name+' · '+job.users.toLocaleString('en-GB')+' users · '
        +job.rows.toLocaleString('en-GB')+' pairs · '+job.pet_types+' pet types');
    const sources=job.sources.length ? 'File labels: '+job.sources.join(', ') : 'No data source specified in the file.';
    const split=Object.entries(job.split).map(([part,counts])=>[splitNames[part],counts.users,counts.rows]);
    const sample=job.sample.map(row=>[row.user_id,row.pet,row.score,splitNames[row.split]]);
    trainingUi.preview.replaceChildren(node('h4','Data preview'),summary,fingerprint,node('p',sources,'small'),
        table(['Data split','Users','Pairs'],split),node('h4','Sample rating records'),
        table(['Anonymous user','Companion','Rating','Split'],sample));
    trainingUi.progress.max=job.epochs;
    trainingUi.progress.value=job.epoch;
    if(running){
        trainingUi.status.textContent='Training · Epoch '+job.epoch+' / '+job.epochs;
    }else if(job.status==='done'){
        trainingUi.status.textContent='Training complete. Model '+job.model_version+' is now active. Submit the quiz to use the new model.';
    }else if(job.status==='failed'){
        trainingUi.status.textContent=job.error;
    }else{
        trainingUi.status.textContent='Data verified. Select Start Training when ready.';
    }
}

async function pollTraining(jobId){
    try{
        const job=await api('/api/training/'+encodeURIComponent(jobId));
        displayJob(job);
        if(job.status==='running'){
            pollTimer=setTimeout(()=>pollTraining(jobId),1000);
        }else if(job.status==='done'){
            await loadModel();
        }
    }catch(error){
        trainingUi.status.textContent='Training status is temporarily unavailable. Retrying…';
        pollTimer=setTimeout(()=>pollTraining(jobId),3500);
    }
}

trainingUi.file.addEventListener('change',()=>{
    clearTimeout(pollTimer);
    displayJob(null);
    try{sessionStorage.removeItem('paw_training_job');}catch{}
});

trainingUi.form.addEventListener('submit',async event=>{
    event.preventDefault();
    const data=new FormData(trainingUi.form);
    displayJob(null);
    trainingUi.previewButton.disabled=true;
    trainingUi.file.disabled=true;
    trainingUi.status.textContent='Checking the CSV and user-level splits…';
    try{
        const result=await requestApi('/api/training/preview',{method:'POST',body:data},120000);
        displayJob(result);
        try{sessionStorage.setItem('paw_training_job',result.id);}catch{}
    }catch(error){
        trainingUi.status.textContent=error.message;
    }finally{
        trainingUi.previewButton.disabled=false;
        trainingUi.file.disabled=false;
    }
});

trainingUi.start.addEventListener('click',async ()=>{
    if(!trainingJob) return;
    trainingUi.start.disabled=true;
    trainingUi.file.disabled=true;
    trainingUi.previewButton.disabled=true;
    try{
        const job=await api('/api/training/'+encodeURIComponent(trainingJob.id)+'/start',{});
        displayJob(job);
        await pollTraining(job.id);
    }catch(error){
        displayJob(trainingJob);
        trainingUi.status.textContent=error.message;
    }
});

function chart(title,width=560,height=245){
    const namespace='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(namespace,'svg');
    svg.setAttribute('viewBox','0 0 '+width+' '+height);
    svg.setAttribute('class','chart lab-chart');
    svg.setAttribute('role','img');
    svg.setAttribute('aria-label',title);
    function draw(tag,attributes,text){
        const item=document.createElementNS(namespace,tag);
        for(const [key,value] of Object.entries(attributes)) item.setAttribute(key,value);
        if(text!==undefined) item.textContent=text;
        svg.append(item);
        return item;
    }
    return {svg,draw};
}

function axes(draw,left,bottom,right,top){
    draw('line',{x1:left,y1:top,x2:left,y2:bottom,class:'chart-axis'});
    draw('line',{x1:left,y1:bottom,x2:right,y2:bottom,class:'chart-axis'});
}

function lossGraph(history){
    const {svg,draw}=chart('Training and validation BCE loss curves');
    const ceiling=Math.max(...history.flatMap(row=>[row.train_bce,row.val_bce]),0.01)*1.05;
    axes(draw,56,190,535,16);
    for(let i=0;i<=4;i++){
        const y=190-i*43.5;
        draw('line',{x1:56,y1:y,x2:535,y2:y,class:'graph-guide'});
        draw('text',{x:47,y:y+4,'text-anchor':'end'},(ceiling*i/4).toFixed(2));
    }
    for(const [key,style] of [['train_bce','train-line'],['val_bce','val-line']]){
        const points=history.map((row,index)=>(56+index/Math.max(1,history.length-1)*479)+','+(190-row[key]/ceiling*174));
        draw('polyline',{points:points.join(' '),class:style});
    }
    draw('text',{x:56,y:216},'Epoch 1');
    draw('text',{x:535,y:216,'text-anchor':'end'},'Epoch '+history.at(-1).epoch);
    return svg;
}

function rowsGraph(rows,label){
    const height=rows.length*29+32;
    const {svg,draw}=chart(label,560,height);
    const maximum=Math.max(1,...rows.map(([,value])=>value));
    rows.forEach(([name,value],index)=>{
        const y=20+index*29;
        const width=value/maximum*300;
        draw('text',{x:135,y:y+12,'text-anchor':'end'},name);
        draw('rect',{x:147,y,width,height:15,rx:2,class:'sample-bar'});
        draw('text',{x:157+width,y:y+12},value.toLocaleString('en-GB'));
    });
    return svg;
}

function predictionGraph(points){
    const {svg,draw}=chart('Predicted scores and test labels');
    const x=value=>70+value*420;
    const y=value=>184-value*155;
    axes(draw,x(0),y(0),x(1),y(1));
    draw('line',{x1:x(0),y1:y(0),x2:x(1),y2:y(1),class:'prediction-reference'});
    for(const point of points){
        draw('circle',{cx:x(point.label),cy:y(point.prediction),r:3,class:'prediction-dot'});
    }
    for(const value of [0,0.5,1]){
        draw('text',{x:x(value),y:202,'text-anchor':'middle'},value);
        draw('text',{x:58,y:y(value)+4,'text-anchor':'end'},value);
    }
    draw('text',{x:70,y:17},'Predicted score');
    draw('text',{x:280,y:226,'text-anchor':'middle'},'Test label');
    return svg;
}

function figure(heading,graphic,caption){
    const wrapper=node('figure',undefined,'lab-figure');
    wrapper.append(node('h4',heading),graphic,node('figcaption',caption,'chart-note'));
    return wrapper;
}

async function restoreTraining(){
    if(restoreAttempted||$('#training-upload').hidden) return;
    restoreAttempted=true;
    let saved;
    try{saved=sessionStorage.getItem('paw_training_job');}catch{}
    if(!saved) return;
    try{
        const job=await api('/api/training/'+encodeURIComponent(saved));
        displayJob(job);
        if(job.status==='running') await pollTraining(job.id);
    }catch{
        try{sessionStorage.removeItem('paw_training_job');}catch{}
    }
}

async function loadModel(){
    const box=$('#model-content');
    box.textContent='Loading the active model…';
    void restoreTraining();
    try{
        const response=await api('/api/model');
        $('#mode').textContent=modeText(response.mode);
        box.replaceChildren();
        if(!response.metrics){
            box.append(node('p',$('#training-upload').hidden?'No training records are available.':'No training records are available. Upload a ratings CSV to train a new model.'));
            return;
        }
        const m=response.metrics;
        const trainedAt=m.trained_at ? new Date(m.trained_at).toLocaleString('en-GB',{timeZone:'Asia/Hong_Kong',hour12:false})+' (Hong Kong time)' : '—';
        const facts=table(['Training record','Active model'],[
            ['Version',response.model_version],['Dataset',response.dataset_name],
            ['File source labels',m.input_sources?.join(', ') || 'Unlabelled'],
            ['Dataset fingerprint',m.dataset_sha256 || '—'],['Training time',trainedAt],
            ['Training epochs',(m.history?.length??0)+' epochs, best validation epoch '+(m.best_epoch??'—')],
            ['Network architecture',response.architecture.join(' → ')+' ('+response.user_feature_count+' quiz features)'],
        ]);
        const stats=node('div',undefined,'stats');
        for(const [label,value] of [
            ['Rating pairs',(m.train_rows+m.val_rows+m.test_rows).toLocaleString('en-GB')],
            ['Test users',m.test_users],['Test MSE',m.model_mse.toFixed(4)],
            ['Model NDCG@3',m.model_ranking.ndcg_at_3?.toFixed(4)??'N/A'],
        ]){
            const stat=node('div',label,'stat');
            stat.append(node('strong',String(value)));
            stats.append(stat);
        }
        const gallery=node('div',undefined,'lab-charts');
        if(m.history?.length) gallery.append(figure('Training and validation loss',lossGraph(m.history),'The solid blue line shows training loss. The dashed orange line shows validation loss.'));
        const splits=[['Training set',m.train_rows],['Validation set',m.val_rows],['Test set',m.test_rows]];
        gallery.append(figure('Rating pairs by split',rowsGraph(splits,'Rating pairs in the training, validation and test sets'),
            'Users by split: '+m.train_users+' training, '+m.val_users+' validation and '+m.test_users+' test.'));
        if(m.prediction_sample?.length){
            gallery.append(figure('Predicted scores and labels',predictionGraph(m.prediction_sample),
                'Each dot represents one eligible pair in the test set. The dashed line marks where predictions equal the labels.'));
        }
        if(m.per_pet_rows?.length){
            const archivedVirtual=m.per_pet_rows.some(pet=>pet.id==='nailong');
            gallery.append(figure('Rating pairs by companion',rowsGraph(m.per_pet_rows.map(pet=>[pet.name,pet.rows]),'Rating pairs by companion'),
                archivedVirtual?'The bundled training history includes zero-score placeholders for Naylong. Current inference and new training use real-pet profiles only.':
                'Counts rating pairs for each real pet in this training dataset.'));
        }
        box.append(stats,facts,gallery,table(['Method','Test MSE ↓','NDCG@3 ↑'],[
            ['Neural Network',m.model_mse.toFixed(6),m.model_ranking.ndcg_at_3?.toFixed(4)??'N/A'],
            ['Expert System',m.rule_mse.toFixed(6),m.rule_ranking.ndcg_at_3?.toFixed(4)??'N/A'],
        ]),node('p',m.disclaimer+' '+response.notice,'small'));
    }catch(error){
        box.textContent=error.message;
    }
}
