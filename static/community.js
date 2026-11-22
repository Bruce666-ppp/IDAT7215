'use strict';

const communityForm = $('#community-composer');
const communityFeed = $('#community-feed');
const communityMore = $('#community-more');
const communityAuthor = $('#community-author');
const communityBody = communityForm.elements.namedItem('body');
const communityPaperFields = $('#community-paper-fields');
const communityDialog = $('#community-dialog');
const communityQuery = $('#community-query');
const communityMobileFilter = $('#community-mobile-filter');
const communityCategoryNames = {life:'养宠日常',knowledge:'养宠知识',research:'论文分享'};
const communityTime = new Intl.DateTimeFormat('zh-HK',{
    timeZone:'Asia/Hong_Kong',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false,
});
let communityFilter = 'all';
let communitySearch = '';
let communityCursor = null;
let communityRequest = 0;
let communityNoticeTimer;

function communityButton(label,css){
    const button=node('button',label,css);
    button.type='button';
    return button;
}

function communityDate(value){
    const time=node('time',communityTime.format(new Date(value)));
    time.dateTime=value;
    return time;
}

function communityAvatar(name){
    const avatar=node('span',[...name][0]||'访','community-avatar');
    const sum=[...name].reduce((total,character)=>total+character.codePointAt(0),0);
    avatar.dataset.tone=String(sum%4);
    avatar.setAttribute('aria-hidden','true');
    return avatar;
}

function setCommunityStatus(element,text,error=false){
    element.textContent=text;
    element.classList.toggle('community-error',error);
}

function showPaperFields(){
    const paper=communityForm.elements.namedItem('kind').value==='paper';
    communityPaperFields.hidden=!paper;
    for(const input of communityPaperFields.querySelectorAll('input')) input.disabled=!paper;
    $('#community-category-label').hidden=paper;
    communityForm.elements.namedItem('category').disabled=paper;
    communityForm.elements.namedItem('title').required=paper;
    communityBody.required=!paper;
    communityBody.placeholder=paper ? '写下论文摘要或阅读心得…' : '分享你的养宠心得，或者问大家一个问题…';
    $('#community-body-count').textContent=communityBody.value.length+' / 3000';
}

communityForm.addEventListener('change',showPaperFields);
communityBody.addEventListener('input',showPaperFields);
showPaperFields();

function selectCommunityFilter(filter){
    communityFilter=filter;
    communityMobileFilter.value=filter;
    for(const button of document.querySelectorAll('[data-community-filter]')){
        button.setAttribute('aria-pressed',String(button.dataset.communityFilter===filter));
    }
}

function openCommunity(){
    communityQuery.value='';
    communitySearch='';
    selectCommunityFilter('all');
    void loadCommunity();
}

function searchCommunity(query){
    communityQuery.value=query;
    communitySearch=query.trim();
    void loadCommunity();
}

function renderCommunityHot(items){
    const list=$('#community-hot-list');
    list.replaceChildren();
    $('#community-hot-empty').hidden=items.length>0;
    for(const item of items){
        const query=item.topic||item.excerpt;
        const row=node('li');
        const button=communityButton(item.topic?'#'+query:query,'community-hot-topic');
        button.onclick=()=>{
            selectCommunityFilter('all');
            searchCommunity(query);
        };
        row.append(button,node('small',item.topic?item.posts+' 篇':item.interactions+' 次互动'));
        list.append(row);
    }
}

async function previewCommunityPosts(){
    const data=await api('/api/community/posts');
    const query=communitySearch.toLocaleLowerCase().replace(/^#|#$/g,'');
    data.items=data.items.filter(post=>{
        if(communityFilter==='paper'&&post.kind!=='paper') return false;
        if(['life','knowledge'].includes(communityFilter)&&post.category!==communityFilter) return false;
        return !query||[post.title,post.body,post.topic].some(value=>value.toLocaleLowerCase().includes(query));
    });
    if(communityFilter==='popular') data.items.sort((a,b)=>(b.likes+2*b.comments)-(a.likes+2*a.comments));
    return data;
}

async function loadCommunity(append=false){
    const call=++communityRequest;
    const cursor=append ? communityCursor : null;
    const status=$('#community-feed-status');
    const params=new URLSearchParams({view:communityFilter});
    if(cursor) params.set('before',cursor);
    if(communitySearch) params.set('q',communitySearch);
    communityMore.disabled=true;
    if(!append) communityMore.hidden=true;
    setCommunityStatus(status,'正在读取动态…');
    try{
        const data=await (pagesPreview?previewCommunityPosts():api('/api/community/posts?'+params));
        if(call!==communityRequest) return;
        communityAuthor.placeholder=data.author;
        $('#community-total').textContent=data.counts.posts;
        $('#community-paper-total').textContent=data.counts.papers;
        $('#community-comment-total').textContent=data.counts.comments;
        renderCommunityHot(data.hot);
        if(!append) communityFeed.replaceChildren();
        for(const post of data.items){
            if(!communityFeed.querySelector('#community-post-'+post.id)) communityFeed.append(communityPost(post));
        }
        if(!append&&!data.items.length){
            const empty=node('div',undefined,'community-card community-empty');
            let message='这个分类还没有动态。';
            if(communitySearch) message='没有找到符合搜索词的动态。';
            else if(communityFilter==='mine') message='你还没有发布动态。';
            else if(communityFilter==='saved') message='收藏的帖子会出现在这里。';
            else if(communityFilter==='all') message='还没有社区动态，来发第一帖吧。';
            empty.append(node('p',message));
            communityFeed.append(empty);
        }
        communityCursor=data.next_before;
        communityMore.hidden=!communityCursor;
        setCommunityStatus(status,'');
    }catch(error){
        if(call===communityRequest) setCommunityStatus(status,error.message,true);
    }finally{
        if(call===communityRequest) communityMore.disabled=false;
    }
}

for(const button of document.querySelectorAll('[data-community-filter]')){
    button.onclick=()=>{
        selectCommunityFilter(button.dataset.communityFilter);
        void loadCommunity();
    };
}
$('#community-refresh').onclick=()=>loadCommunity();
communityMore.onclick=()=>loadCommunity(true);
communityMobileFilter.onchange=()=>{
    selectCommunityFilter(communityMobileFilter.value);
    void loadCommunity();
};
$('#community-search').onsubmit=event=>{
    event.preventDefault();
    selectCommunityFilter('all');
    searchCommunity(communityQuery.value);
};
communityQuery.oninput=()=>{
    if(!communityQuery.value&&communitySearch) searchCommunity('');
};
for(const button of document.querySelectorAll('[data-community-create]')){
    button.onclick=()=>{
        setCommunityStatus($('#community-compose-status'),'');
        communityDialog.showModal();
    };
}
$('#community-cancel').onclick=()=>communityDialog.close();
communityDialog.addEventListener('cancel',event=>{
    if($('#community-publish').disabled) event.preventDefault();
});

communityForm.addEventListener('submit',async event=>{
    event.preventDefault();
    const publish=$('#community-publish'),status=$('#community-compose-status');
    const cancel=$('#community-cancel');
    publish.disabled=true;
    cancel.disabled=true;
    setCommunityStatus(status,'正在发布…');
    try{
        const response=await fetch('/api/community/posts',{method:'POST',body:new FormData(communityForm)});
        const data=await response.json();
        if(!response.ok) throw Error(data.error||'发布失败');
        communityForm.reset();
        communityAuthor.value=data.author;
        showPaperFields();
        communityDialog.close();
        communityQuery.value='';
        communitySearch='';
        selectCommunityFilter('all');
        await loadCommunity();
        const notice=$('#community-publish-notice');
        clearTimeout(communityNoticeTimer);
        setCommunityStatus(notice,'发布成功，已显示在最新动态。');
        notice.scrollIntoView({block:'nearest',behavior:'smooth'});
        communityNoticeTimer=setTimeout(()=>setCommunityStatus(notice,''),3500);
    }catch(error){
        setCommunityStatus(status,error.message,true);
    }finally{
        publish.disabled=false;
        cancel.disabled=false;
    }
});

function communityPost(post){
    const article=node('article',undefined,'community-card community-post');
    article.id='community-post-'+post.id;
    const header=node('header',undefined,'community-post-header');
    const profile=node('div',undefined,'community-post-profile');
    profile.append(node('strong',post.author),communityDate(post.created_at));
    header.append(communityAvatar(post.author),profile);
    const badges=node('div',undefined,'community-post-tags');
    badges.append(node('span',communityCategoryNames[post.category],'community-paper-tag'));
    if(post.demo) badges.append(node('span','Demo','community-demo-tag'));
    header.append(badges);
    article.append(header);
    if(post.title) article.append(node('h3',post.title,'community-post-title'));
    if(post.body) article.append(node('p',post.body,'community-post-body'));
    if(post.topic){
        const topic=communityButton('#'+post.topic,'community-topic');
        topic.onclick=()=>{
            selectCommunityFilter('all');
            searchCommunity(post.topic);
        };
        article.append(topic);
    }
    const root='/api/community/posts/'+encodeURIComponent(post.id);
    if(post.paper_url||post.attachment_name){
        const links=node('div',undefined,'community-paper-links');
        if(post.paper_url){
            const link=node('a','打开论文链接');
            link.href=post.paper_url;
            link.target='_blank';
            link.rel='noopener noreferrer';
            links.append(link);
        }
        if(post.attachment_name){
            const file=node('a','下载 PDF · '+post.attachment_name);
            file.href=root+'/paper';
            links.append(file);
        }
        article.append(links);
    }
    if(pagesPreview) return article;
    const tools=node('div',undefined,'community-post-tools');
    const like=communityButton('','community-reaction');
    const comment=communityButton('评论 '+post.comments,'community-reaction');
    const save=communityButton('','community-reaction community-bookmark');
    const status=node('p','','community-status');
    status.setAttribute('role','status');
    const redrawLike=()=>{
        like.textContent=(post.liked?'♥ 已赞 ':'♡ 点赞 ')+post.likes;
        like.setAttribute('aria-pressed',String(post.liked));
    };
    redrawLike();
    like.onclick=async ()=>{
        like.disabled=true;
        try{
            const result=await api(root+'/like',{liked:!post.liked});
            Object.assign(post,result);
            redrawLike();
            setCommunityStatus(status,'');
        }catch(error){
            setCommunityStatus(status,error.message,true);
        }finally{
            like.disabled=false;
        }
    };
    const redrawSave=()=>{
        save.textContent=post.saved?'★ 已收藏':'☆ 收藏';
        save.setAttribute('aria-pressed',String(post.saved));
    };
    redrawSave();
    save.onclick=async ()=>{
        save.disabled=true;
        try{
            const result=await api(root+'/save',{saved:!post.saved});
            post.saved=result.saved;
            redrawSave();
            setCommunityStatus(status,'');
            if(!post.saved&&communityFilter==='saved') void loadCommunity();
        }catch(error){
            setCommunityStatus(status,error.message,true);
        }finally{
            save.disabled=false;
        }
    };
    tools.append(like,comment,save);
    article.append(tools,status,communityComments(post,root,comment));
    return article;
}

function communityComments(post,root,toggle){
    const panel=node('section',undefined,'community-comments');
    panel.id='comments-'+post.id;
    panel.hidden=true;
    toggle.setAttribute('aria-expanded','false');
    toggle.setAttribute('aria-controls',panel.id);
    const list=node('ol',undefined,'community-comment-list');
    const more=communityButton('更早的评论','community-text-button');
    more.hidden=true;
    const status=node('p','','community-status');
    status.setAttribute('role','status');
    const form=node('form',undefined,'community-reply-form');
    const input=node('textarea');
    input.name='body';
    input.rows=2;
    input.maxLength=500;
    input.required=true;
    input.placeholder='写条评论…';
    input.setAttribute('aria-label','评论内容');
    const reply=node('button','发送评论');
    reply.type='submit';
    form.append(input,reply);
    panel.append(more,list,status,form);
    let cursor=null;
    let requestId=0;

    async function read(older=false){
        const call=++requestId;
        more.disabled=true;
        const suffix=older&&cursor ? '?before='+encodeURIComponent(cursor) : '';
        setCommunityStatus(status,'正在读取评论…');
        try{
            const data=await api(root+'/comments'+suffix);
            if(call!==requestId) return;
            if(!older) list.replaceChildren();
            const entries=data.items.slice().reverse().map(item=>{
                const row=node('li',undefined,'community-comment');
                const head=node('div',undefined,'community-comment-meta');
                head.append(node('strong',item.author),communityDate(item.created_at));
                row.append(communityAvatar(item.author),head,node('p',item.body));
                return row;
            });
            if(older) list.prepend(...entries);
            else list.append(...entries);
            cursor=data.next_before;
            more.hidden=!cursor;
            toggle.textContent='评论 '+data.count;
            setCommunityStatus(status,data.count?'':'暂无评论。');
        }catch(error){
            if(call===requestId) setCommunityStatus(status,error.message,true);
        }finally{
            if(call===requestId) more.disabled=false;
        }
    }

    toggle.onclick=()=>{
        panel.hidden=!panel.hidden;
        toggle.setAttribute('aria-expanded',String(!panel.hidden));
        if(!panel.hidden) void read();
    };
    more.onclick=()=>read(true);
    form.onsubmit=async event=>{
        event.preventDefault();
        reply.disabled=true;
        try{
            const result=await api(root+'/comments',{author:communityAuthor.value,body:input.value});
            communityAuthor.placeholder=result.author;
            input.value='';
            const total=$('#community-comment-total');
            const previous=Number(total.textContent);
            if(Number.isFinite(previous)) total.textContent=previous+1;
            await read();
        }catch(error){
            setCommunityStatus(status,error.message,true);
        }finally{
            reply.disabled=false;
        }
    };
    return panel;
}
