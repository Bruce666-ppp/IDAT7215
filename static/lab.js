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
const splitNames={train:'训练集',validation:'验证集',test:'测试集'};
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
    const fingerprint=node('p','数据指纹 '+job.dataset_sha256.slice(0,16)+'…','small');
    const summary=node('p',job.dataset_name+' · '+job.users.toLocaleString()+' 位用户 · '
        +job.rows.toLocaleString()+' 条配对 · '+job.pet_types+' 类伙伴');
    const sources=job.sources.length ? '文件标注：'+job.sources.join('、') : '文件未标注数据来源';
    const split=Object.entries(job.split).map(([part,counts])=>[splitNames[part],counts.users,counts.rows]);
    const sample=job.sample.map(row=>[row.user_id,row.pet,row.score,splitNames[row.split]]);
    trainingUi.preview.replaceChildren(node('h4','数据预览'),summary,fingerprint,node('p',sources,'small'),
        table(['数据划分','用户数','配对数'],split),node('h4','部分评分记录'),
        table(['匿名用户','伙伴','评分','集合'],sample));
    trainingUi.progress.max=job.epochs;
    trainingUi.progress.value=job.epoch;
    if(running){
        trainingUi.status.textContent='正在训练 · 第 '+job.epoch+' / '+job.epochs+' 轮';
    }else if(job.status==='done'){
        trainingUi.status.textContent='训练完成，已启用模型 '+job.model_version+'。提交问卷即可使用新模型评分。';
    }else if(job.status==='failed'){
        trainingUi.status.textContent=job.error;
    }else{
        trainingUi.status.textContent='已验证数据，等待你开始训练。';
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
        trainingUi.status.textContent='暂时读取不到训练状态，正在重试。';
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
    trainingUi.status.textContent='正在验证 CSV 和用户划分…';
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
    const {svg,draw}=chart('训练和验证 BCE 损失曲线');
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
    draw('text',{x:56,y:216},'第 1 轮');
    draw('text',{x:535,y:216,'text-anchor':'end'},'第 '+history.at(-1).epoch+' 轮');
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
        draw('text',{x:157+width,y:y+12},value.toLocaleString());
    });
    return svg;
}

function predictionGraph(points){
    const {svg,draw}=chart('测试标签与模型预测分数对照');
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
    draw('text',{x:70,y:17},'模型预测');
    draw('text',{x:280,y:226,'text-anchor':'middle'},'测试标签');
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
    box.textContent='正在读取启用模型…';
    void restoreTraining();
    try{
        const response=await api('/api/model');
        $('#mode').textContent=modeText(response.mode);
        box.replaceChildren();
        if(!response.metrics){
            box.append(node('p',$('#training-upload').hidden?'当前没有配套训练记录。':'当前没有配套训练记录。可上传评分 CSV 并训练新模型。'));
            return;
        }
        const m=response.metrics;
        const trainedAt=m.trained_at ? new Date(m.trained_at).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false})+'（香港时间）' : '—';
        const facts=table(['训练记录','本次模型'],[
            ['版本',response.model_version],['数据文件',response.dataset_name],
            ['文件来源标注',m.input_sources?.join('、') || '未标注'],
            ['数据指纹',m.dataset_sha256 || '—'],['训练时间',trainedAt],
            ['训练轮数',(m.history?.length??0)+' 轮，最佳验证轮次 '+(m.best_epoch??'—')],
            ['网络结构',response.architecture.join(' → ')+'（'+response.user_feature_count+' 项问卷特征）'],
        ]);
        const stats=node('div',undefined,'stats');
        for(const [label,value] of [
            ['配对评分',(m.train_rows+m.val_rows+m.test_rows).toLocaleString()],
            ['测试用户',m.test_users],['测试 MSE',m.model_mse.toFixed(4)],
            ['模型 NDCG@3',m.model_ranking.ndcg_at_3?.toFixed(4)??'不适用'],
        ]){
            const stat=node('div',label,'stat');
            stat.append(node('strong',String(value)));
            stats.append(stat);
        }
        const gallery=node('div',undefined,'lab-charts');
        if(m.history?.length) gallery.append(figure('训练与验证损失',lossGraph(m.history),'棕色为训练损失，金色为验证损失。'));
        const splits=[['训练集',m.train_rows],['验证集',m.val_rows],['测试集',m.test_rows]];
        gallery.append(figure('按集合查看配对数',rowsGraph(splits,'训练、验证与测试集配对数'),
            '训练、验证、测试分别有 '+m.train_users+'、'+m.val_users+'、'+m.test_users+' 位用户。'));
        if(m.prediction_sample?.length){
            gallery.append(figure('预测评分与标签',predictionGraph(m.prediction_sample),
                '每个点为测试集中一条合格候选配对。虚线表示预测与标签相同。'));
        }
        if(m.per_pet_rows?.length){
            const archivedVirtual=m.per_pet_rows.some(pet=>pet.id==='nailong');
            gallery.append(figure('各类伙伴的配对数',rowsGraph(m.per_pet_rows.map(pet=>[pet.name,pet.rows]),'各类伙伴的配对数'),
                archivedVirtual?'随附旧版训练记录包含奶龙的零标签占位。当前推理和新训练只处理真实宠物。':
                '统计本次训练数据中各真实宠物的配对数。'));
        }
        box.append(stats,facts,gallery,table(['方法','测试 MSE ↓','NDCG@3 ↑'],[
            ['神经网络',m.model_mse.toFixed(6),m.model_ranking.ndcg_at_3?.toFixed(4)??'不适用'],
            ['专家规则',m.rule_mse.toFixed(6),m.rule_ranking.ndcg_at_3?.toFixed(4)??'不适用'],
        ]),node('p',m.disclaimer+' '+response.notice,'small'));
    }catch(error){
        box.textContent=error.message;
    }
}
