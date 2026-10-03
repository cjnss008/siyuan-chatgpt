import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ChatCaptures,fromCodexThread,readCodexThread} from '../server/chat.mjs';
import {Service} from '../server/core.mjs';
import {captureChatPage} from '../browser-extension/capture.js';

const id='01a103da-9260-7491-beeb-b7091e6b34a2',notebook='20261004110000-abcdefg';
const turn=(n,text='原文\n  空格和 `代码`\n')=>({id:'turn-'+n,status:'completed',items:[{type:'userMessage',id:'u-'+n,content:[{type:'text',text}]},{type:'agentMessage',id:'a-'+n,text:'回答 '+n,phase:'final_answer'},{type:'reasoning',summary:['NEVER EXPORT']},{type:'mcpToolCall',arguments:{token:'NEVER EXPORT'}}]});
const thread={id,name:'测试聊天',turns:[turn(1),turn(2)]};
function harness(accept=true){const writes=[];let preview='';const chats=new ChatCaptures({readThread:async()=>fromCodexThread(thread)});const api={session:async()=>({apiUrl:'http://localhost:6806',token:''}),post:async(endpoint,body)=>{if(endpoint==='/api/notebook/lsNotebooks')return {notebooks:[{id:notebook,name:'测试'}]};writes.push({endpoint,body});return '20261004120000-abcdefg';}};return {service:new Service({chatCaptures:chats,api,confirm:async m=>{preview=m;return accept;}}),chats,writes,getPreview:()=>preview};}

test('full Codex text survives whitespace and excludes hidden reasoning and tool credentials',()=>{
  const v=fromCodexThread(thread);assert.equal(v.messages.length,4);assert.equal(v.messages[0].text,thread.turns[0].items[0].content[0].text);assert.ok(!JSON.stringify(v).includes('NEVER EXPORT'));
  assert.throws(()=>fromCodexThread({...thread,turns:[{id:'x'}]}),/未加载/);
  const pending=fromCodexThread({...thread,turns:[{...turn(1),status:'inProgress'}]});assert.match(pending.warnings[0],/尚未完成/);
});
test('immutable original save uses every captured character, previews before write, and decline never writes',async()=>{
  for(const accept of [true,false]){
    const h=harness(accept),capture=await h.service.call('siyuan_capture_current_chat',{source:'codex',threadId:id});
    const original=h.chats.get(capture.captureId).markdown;
    const p=await h.service.call('siyuan_save_captured_chat',{captureId:capture.captureId,mode:'original',notebook,path:'/聊天/完整'});assert.equal(h.writes.length,0);
    const saved=await h.service.call('siyuan_commit_write',{operationId:p.operationId});assert.equal(saved.written,accept);
    if(accept)assert.equal(h.writes[0].body.markdown,original);assert.ok(h.getPreview().includes(original));
    await assert.rejects(()=>h.service.call('siyuan_save_captured_chat',{captureId:capture.captureId,mode:'original',summaryMarkdown:'改写',notebook,path:'/x'}),/不接收/);
  }
});
test('summary and original remain separate; explicit destination and valid capture are required',async()=>{
  const h=harness(),c=await h.service.call('siyuan_capture_current_chat',{source:'codex',threadId:id});
  const p=await h.service.call('siyuan_save_captured_chat',{captureId:c.captureId,mode:'summary',summaryMarkdown:'保留结论和待办',notebook,path:'/摘要'});
  assert.ok(p.preview.includes('（摘要）'));assert.ok(p.preview.includes(c.hash));assert.ok(p.preview.includes('保留结论和待办'));
  await assert.rejects(()=>h.service.call('siyuan_save_captured_chat',{captureId:c.captureId,mode:'summary',notebook,path:'/摘要'}),/需要/);
  await assert.rejects(()=>h.service.call('siyuan_save_captured_chat',{captureId:c.captureId,mode:'original',notebook,path:'/摘要',parentId:notebook}),/混用/);
});
test('long snapshots paginate without silent truncation and expire',()=>{
  let now=0;const c=new ChatCaptures({now:()=>now});const v=c.store(fromCodexThread({...thread,turns:[turn(1,'长记录'.repeat(50000))]}));
  let text='',offset=0;
  do{const r=c.read({captureId:v.captureId,offset,limit:30000});assert.equal(r.hash,v.hash);text+=r.content;offset=r.nextOffset;}while(offset!==null);
  assert.equal(text,c.get(v.captureId).markdown);assert.ok(text.length>100000);now=3600001;assert.throws(()=>c.read({captureId:v.captureId}),/过期/);
});
test('original archive exceeds ordinary Markdown tool limit without losing text; truncated host input is rejected',async()=>{
  const h=harness(),c=h.chats.store(fromCodexThread({...thread,turns:[turn(1,'完整原文'.repeat(40000))]}));
  const expected=h.chats.get(c.captureId).markdown;
  const preview=await h.service.call('siyuan_save_captured_chat',{captureId:c.captureId,mode:'original',notebook,path:'/长聊天'});
  await h.service.call('siyuan_commit_write',{operationId:preview.operationId});assert.equal(h.writes[0].body.markdown,expected);assert.ok(expected.length>100000);
  const pageJson=JSON.stringify({thread:{id,kind:'codex'},page:{order:'newest_first',hasMore:false},turns:[turn(1,'x'.repeat(20000))]});assert.throws(()=>h.chats.ingest({pageJson}),/截断/);
});
test('host pages must start at first page, follow exact cursor and finish before a snapshot is available',()=>{
  const c=new ChatCaptures();const page=(turns,next)=>JSON.stringify({thread:{id,kind:'codex',title:'宿主聊天'},page:{order:'newest_first',hasMore:!!next,nextCursor:next},turns});
  const a=c.ingest({pageJson:page([turn(2)],'older')});assert.equal(a.ready,false);assert.throws(()=>c.get(a.captureId));
  assert.throws(()=>c.ingest({captureId:a.captureId,requestCursor:'wrong',pageJson:page([turn(1)],null)}),/游标/);
  assert.throws(()=>c.ingest({captureId:a.captureId,requestCursor:'older',pageJson:page([turn(2)],null)}),/重复/);
  const b=c.ingest({captureId:a.captureId,requestCursor:'older',pageJson:page([turn(1)],null)});assert.equal(b.ready,true);assert.equal(c.get(b.captureId).capture.messages[0].id,'u-1');assert.equal(b.messageCount,4);
});
test('browser imports require explicit JSON file; unverified page text cannot be saved as full history',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-chat-test-'));
  try{
    const file=path.join(dir,'capture.json'),value={...fromCodexThread(thread),source:'chatgpt-web',coverage:'page-text-unverified'};await fs.writeFile(file,JSON.stringify(value));
    const h=harness(),c=await h.service.call('siyuan_capture_current_chat',{source:'chatgpt-web',captureFile:file});
    await assert.rejects(()=>h.service.call('siyuan_save_captured_chat',{captureId:c.captureId,mode:'original',notebook,path:'/chat'}),/核对首尾/);
    value.coverage='page-text-user-verified';await fs.writeFile(file,JSON.stringify(value));const verified=await h.service.call('siyuan_capture_current_chat',{source:'chatgpt-web',captureFile:file});assert.equal(verified.messageCount,4);
    await assert.rejects(()=>h.service.call('siyuan_capture_current_chat',{source:'chatgpt-web',captureFile:'relative.json'}),/绝对路径/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Codex RPC reads exact full thread without starting or resuming a turn; cancellation kills helper',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-rpc-test-')),script=path.join(dir,'fake.mjs');
  await fs.writeFile(script,`import readline from 'node:readline';const thread=${JSON.stringify(thread)};readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n');else if(m.method==='thread/read'&&m.params.includeTurns===true&&m.params.threadId===thread.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{thread}})+'\\n');else if(m.id)throw Error('unexpected method');});`);
  try{
    const result=await readCodexThread(id,{spawnProcess:(_exe,args,opts)=>{assert.deepEqual(args,['app-server','--listen','stdio://']);return spawn(process.execPath,[script],opts);}});assert.equal(result.messages.length,4);
    const controller=new AbortController();let child;
    const pending=readCodexThread(id,{signal:controller.signal,spawnProcess:(_exe,_args,opts)=>{child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],opts);return child;}});setTimeout(()=>controller.abort(),50);
    await assert.rejects(()=>pending,/取消/);assert.equal(child.killed,true);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('browser capture fails safely outside ChatGPT and while a reply is generating',async()=>{
  const saved={location:globalThis.location,document:globalThis.document};
  try{
    globalThis.location={href:'https://example.com/c/abcdefgh'};await assert.rejects(()=>captureChatPage(),/ChatGPT/);
    globalThis.location={href:'https://chatgpt.com/c/abcdefgh'};globalThis.document={querySelector:s=>s==='main'?{}:{}};await assert.rejects(()=>captureChatPage(),/仍在生成/);
  }finally{globalThis.location=saved.location;globalThis.document=saved.document;}
});
test('browser scrolling collects virtualized messages in order, restores viewport and rejects gaps',async()=>{
  const saved={location:globalThis.location,document:globalThis.document,getComputedStyle:globalThis.getComputedStyle};
  try{
    globalThis.location={href:'https://chatgpt.com/c/abcdefgh'};
    let position=150,missing=false;
    const scroller={scrollHeight:400,clientHeight:100,get scrollTop(){return position;},set scrollTop(n){position=Math.max(0,Math.min(300,n));}};
    const nodes=Array.from({length:4},(_,i)=>({parentElement:scroller,innerText:`消息 ${i}\n代码\n  空格`,getAttribute:name=>name==='data-message-author-role'?(i%2?'assistant':'user'):name==='data-message-id'?'m'+i:null,closest:selector=>selector==='[aria-hidden="true"]'?null:{getAttribute:()=>`conversation-turn-${i}`},querySelector:()=>null,querySelectorAll:()=>[]}));
    const main={querySelector:()=>nodes[1],querySelectorAll:()=>{const i=Math.floor(position/100);return missing&&i===2?[]:[nodes[i]];}};
    globalThis.document={title:'浏览器测试 - ChatGPT',querySelector:s=>s==='main'?main:null};globalThis.getComputedStyle=()=>({overflowY:'auto'});
    const result=await captureChatPage({pollMs:1,maxMs:2000});assert.equal(result.messages.length,4);assert.equal(result.messages[0].text,nodes[0].innerText);assert.equal(result.messages.at(-1).id,'m3');assert.equal(result.coverage,'page-text-unverified');assert.equal(position,150);
    missing=true;await assert.rejects(()=>captureChatPage({pollMs:1,maxMs:2000}),/缺失/);assert.equal(position,150);
  }finally{Object.assign(globalThis,saved);}
});
