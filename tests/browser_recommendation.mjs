import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Run with Node 22+ and Chrome. Test sessions use a separate SQLite directory.
const temp=await mkdtemp(join(tmpdir(),'pawthfinder-browser-'));
const defaultChrome={
    win32:'C:/Program Files/Google/Chrome/Application/chrome.exe',
    darwin:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};
const chrome=spawn(process.env.PAWTH_TEST_CHROME||defaultChrome[process.platform]||'google-chrome',[
    '--headless=new','--remote-debugging-port=0','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--disable-background-networking','--no-first-run','--window-size=1440,1050',
    '--user-data-dir='+join(temp,'chrome'),'about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let pageUrl=process.env.PAWTH_TEST_URL;
let server,serverPort='',logs='',socket,sequence=0;
const pending=new Map();
const exceptions=[];
const log=chunk=>{logs=(logs+chunk).slice(-2000);};
chrome.stderr.setEncoding('utf8').on('data',log);
chrome.on('error',error=>log(error.message));
if(!pageUrl){
    server=spawn(process.env.PAWTH_TEST_PYTHON||'python',['-u','-c',[
        'from app import create_app',
        'from werkzeug.serving import make_server',
        'service = make_server("127.0.0.1", 0, create_app(), threaded=True)',
        'print(service.server_port, flush=True)',
        'service.serve_forever()',
    ].join('\n')],{
        windowsHide:true,stdio:['ignore','pipe','pipe'],
        env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PAWTH_DATA_DIR:join(temp,'data'),PAWTH_REQUIRE_MODEL:'1'},
    });
    server.stdout.setEncoding('utf8').on('data',chunk=>serverPort+=chunk);
    server.stderr.setEncoding('utf8').on('data',log);
    server.on('error',error=>log(error.message));
}
async function until(check,timeout=16000){
    const end=Date.now()+timeout;
    while(Date.now()<end){
        try{const value=await check();if(value)return value;}catch{}
        await delay(75);
    }
    throw Error('Timed out waiting for '+check.toString());
}
function cdp(method,params={}){
    return new Promise((resolve,reject)=>{
        const id=++sequence;
        const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},12000);
        pending.set(id,{resolve,reject,timer});
        socket.send(JSON.stringify({id,method,params}));
    });
}
async function evaluate(expression,userGesture=false){
    const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,userGesture});
    if(result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result.value;
}
const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()',true);
const wait=expression=>until(()=>evaluate(expression));
const status=name=>"state.result?.recommendation_status==="+JSON.stringify(name)+"&&!document.querySelector('#submit').disabled";
async function screenshot(name){
    const {data}=await cdp('Page.captureScreenshot',{format:'png'});
    await writeFile(join(temp,name+'.png'),Buffer.from(data,'base64'));
}

try{
    if(!pageUrl){
        const port=await until(()=>serverPort.match(/^\d+/)?.[0]);
        pageUrl='http://127.0.0.1:'+port+'/#match';
    }
    const port=await until(async()=>(await readFile(join(temp,'chrome','DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);
    const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{
        socket.addEventListener('open',resolve,{once:true});
        socket.addEventListener('error',reject,{once:true});
    });
    socket.addEventListener('message',({data})=>{
        const {id,method,params,result,error}=JSON.parse(data);
        if(id){
            const request=pending.get(id);
            if(!request)return;
            clearTimeout(request.timer);pending.delete(id);
            if(error)request.reject(Error(error.message));else request.resolve(result);
        }else if(method==='Runtime.exceptionThrown'){
            exceptions.push(params.exceptionDetails.exception?.description||params.exceptionDetails.text);
        }else if(method==='Fetch.requestPaused'){
            void cdp('Fetch.failRequest',{requestId:params.requestId,errorReason:'InternetDisconnected'});
        }
    });
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Page.navigate',{url:pageUrl});
    await until(()=>evaluate("!document.body.hasAttribute('data-pages-preview') && !document.querySelector('#view-match').hidden && document.querySelectorAll('#allergy-options input').length>0"),65000);
    assert.equal(await evaluate("document.querySelectorAll('#allergy-options input').length"),await evaluate('state.pets.filter(pet=>!pet.fictional).length'));
    await click('#has-allergy');
    await click('#allergy-options input[value=cat]');
    await click('#allergy-options input[value=small_dog]');
    await click('#allergy-other-toggle');
    await evaluate("document.querySelector('[name=other_allergy]').value='示例补充'");
    await click('[name=allergy_uncertain]');
    await screenshot('allergy-questions');
    await click('#has-allergy');
    assert.deepEqual(await evaluate('(()=>{const p=readProfile();return [p.has_allergy,p.allergy_types,p.allergy_uncertain,p.other_allergy,allergy.panel.inert];})()'),
        [false,[],false,'',true]);
    await click('#has-allergy');
    assert.ok(await evaluate("!document.querySelector('#allergy-fields input:checked')"));
    await click('#allergy-options input[value=cat]');
    await click('#submit');
    await wait(status('REAL_PET_RECOMMENDATION'));
    assert.ok(await evaluate("state.result.exclusion_reasons.cat.some(rule=>rule.rule_id==='A01')"));
    assert.ok(await evaluate("!state.result.recommended_pets.some(pet=>pet.id==='cat')"));

    await evaluate("document.querySelector('#quiz [name=budget]').value=10500");
    await click('#submit');
    await wait(status('OUT_OF_DOMAIN'));
    assert.ok(await evaluate("!state.result.fallback_triggered && !document.querySelector('#virtual-result').hidden"));
    await evaluate("document.querySelector('#quiz [name=budget]').value=0");
    await click('#submit');
    await wait(status('NO_ELIGIBLE_PET'));
    await wait("document.querySelector('#virtual-preview canvas')?.dataset.species==='nailong' && document.querySelector('#virtual-preview-status').hidden");
    await evaluate("document.querySelector('#virtual-result').scrollIntoView()");
    await screenshot('virtual-result');
    await click('#virtual-adopt');
    await wait("location.hash==='#compare' && document.querySelector('#pet-canvas canvas')?.dataset.species==='nailong'");
    await wait("!document.querySelector('#pet-message').hidden && document.querySelector('#pet-message').textContent.includes('Naylong')");

    await click('[data-view=match]');
    await cdp('Fetch.enable',{patterns:[{urlPattern:'*/api/recommend',requestStage:'Request'}]});
    await click('#submit');
    await wait("document.querySelector('#error').textContent.includes('Check your connection') && !document.querySelector('#submit').disabled");
    assert.ok(await evaluate("document.querySelector('#virtual-result').hidden && !state.result"));
    assert.deepEqual(exceptions,[]);
    console.log('Browser checks passed: allergen options, clearing, rule A01, out-of-domain feedback, 3D preview and adoption, network failure recovery.');
    console.log('Screenshots: '+temp);
}catch(error){
    console.error(error,exceptions,logs);
    process.exitCode=1;
}finally{
    socket?.close();
    chrome.kill();
    server?.kill();
    for(const request of pending.values())clearTimeout(request.timer);
}
