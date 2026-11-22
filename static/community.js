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
const communityCategoryNames = {life:'Pet Life',knowledge:'Pet Knowledge',research:'Research'};
const communityTime = new Intl.DateTimeFormat('en-GB',{
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
    const avatar=node('span',[...name][0]||'G','community-avatar');
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
    communityBody.placeholder=paper ? 'Write a paper summary or share your reading notes…' : 'Share a pet care tip or ask the community a question…';
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
        row.append(button,node('small',item.topic?item.posts+(item.posts === 1 ? ' post' : ' posts'):item.interactions+(item.interactions === 1 ? ' interaction' : ' interactions')));
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
    setCommunityStatus(status,'Loading posts…');
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
            let message='No posts in this category yet.';
            if(communitySearch) message='No posts match your search.';
            else if(communityFilter==='mine') message='You haven’t published any posts yet.';
            else if(communityFilter==='saved') message='Your saved posts will appear here.';
            else if(communityFilter==='all') message='The feed is empty. Be the first to post.';
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
    setCommunityStatus(status,'Publishing…');
    try{
        const data=await requestApi('/api/community/posts',{method:'POST',body:new FormData(communityForm)},60000);
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
        setCommunityStatus(notice,'Your post is live in the latest feed.');
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
            const link=node('a','Open paper link');
            link.href=post.paper_url;
            link.target='_blank';
            link.rel='noopener noreferrer';
            links.append(link);
        }
        if(post.attachment_name){
            const file=node('a','Download PDF · '+post.attachment_name);
            file.href=apiUrl(root+'/paper');
            links.append(file);
        }
        article.append(links);
    }
    if(pagesPreview) return article;
    const tools=node('div',undefined,'community-post-tools');
    const like=communityButton('','community-reaction');
    const comment=communityButton('Comments '+post.comments,'community-reaction');
    const save=communityButton('','community-reaction community-bookmark');
    const status=node('p','','community-status');
    status.setAttribute('role','status');
    const redrawLike=()=>{
        like.textContent=(post.liked?'♥ Liked ':'♡ Like ')+post.likes;
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
        save.textContent=post.saved?'★ Saved':'☆ Save';
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
    const more=communityButton('Earlier comments','community-text-button');
    more.hidden=true;
    const status=node('p','','community-status');
    status.setAttribute('role','status');
    const form=node('form',undefined,'community-reply-form');
    const input=node('textarea');
    input.name='body';
    input.rows=2;
    input.maxLength=500;
    input.required=true;
    input.placeholder='Write a comment…';
    input.setAttribute('aria-label','Comment text');
    const reply=node('button','Post comment');
    reply.type='submit';
    form.append(input,reply);
    panel.append(more,list,status,form);
    let cursor=null;
    let requestId=0;

    async function read(older=false){
        const call=++requestId;
        more.disabled=true;
        const suffix=older&&cursor ? '?before='+encodeURIComponent(cursor) : '';
        setCommunityStatus(status,'Loading comments…');
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
            toggle.textContent='Comments '+data.count;
            setCommunityStatus(status,data.count?'':'No comments yet.');
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
