import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {hydrateImages,decodeImage,imageReferences,publicAddress,replaceImageLinks,MAX_IMAGE_BYTES} from '../server/images.mjs';
import {ChatCaptures,fromCodexThread,validateCapture} from '../server/chat.mjs';
import {Api,Service} from '../server/core.mjs';
import {captureChatPage} from '../browser-extension/capture.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
const digest=createHash('sha256').update(png).digest('hex'),id='01a103da-9260-7491-beeb-b7091e6b34a2',notebook='20261004110000-abcdefg';
const thread=(source,text='原文\n  保留空格')=>({id,title:'含图片聊天',turns:[{id:'t',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text},{type:'localImage',path:source}]},{id:'a',type:'agentMessage',text:`图片回答\n![图](<${source}>)`}]}]});
function harness(capture,{accept=true,upload,post}={}) {
  const events=[],chats=new ChatCaptures();const c=chats.store(capture);
  const api={session:async()=>({apiUrl:'http://localhost:6806',token:'private'}),uploadImages:async(images)=>{events.push('upload');assert.deepEqual(Buffer.from(images[0].base64,'base64'),png);return upload?upload(images):{succMap:{[images[0].name]:'assets/original-20261004120000-abcdefg.png'}};},post:async(endpoint,body)=>{if(endpoint==='/api/notebook/lsNotebooks')return {notebooks:[{id:notebook,name:'测试'}]};events.push({endpoint,body});return post?post(endpoint,body):notebook;}};
  const service=new Service({chatCaptures:chats,api,confirm:async(message)=>{events.push('confirm');assert.match(message,/1 个原文件/);assert.match(message,new RegExp(digest));return accept;}});
  return {service,c,events,chats};
}
const prepare=h=>h.service.call('siyuan_save_captured_chat',{captureId:h.c.captureId,mode:'original',notebook,path:'/图文'});

test('Codex image attachment and inline embed deduplicate original bytes into immutable snapshot',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-images-')),file=path.join(dir,'原图.png');
  try {
    await fs.writeFile(file,png);const chats=new ChatCaptures({readThread:async()=>fromCodexThread(thread(file))});const c=await chats.capture({source:'codex',threadId:id});
    assert.equal(c.imageCount,1);assert.equal(c.imageBytes,png.length);assert.deepEqual(c.missingImages,[]);assert.equal(c.imageCoverage,'original-files');
    const snapshot=chats.get(c.captureId);assert.equal(snapshot.capture.messages[0].text,'原文\n  保留空格');assert.equal(snapshot.capture.messages[0].attachments[0].imageId,digest);assert.match(snapshot.markdown,new RegExp(`siyuan-chat-image://${digest}`));
    await fs.writeFile(file,'changed after capture');const h=harness(snapshot.capture);const p=await prepare(h);assert.equal(h.events.length,0);const r=await h.service.call('siyuan_commit_write',{operationId:p.operationId});
    assert.equal(r.written,true);assert.equal(r.imageCount,1);assert.equal(h.events[0],'confirm');assert.equal(h.events[1],'upload');assert.ok(h.events[2].body.markdown.includes('assets/original-'));assert.ok(!h.events[2].body.markdown.includes('siyuan-chat-image://'));assert.ok(h.events[2].body.markdown.includes('原文\n  保留空格'));
  } finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('declined confirmation uploads neither resources nor document and cannot replay',async()=>{
  const capture=await hydrateImages(fromCodexThread(thread('/image.png')),{readSource:async()=>png});const h=harness(capture,{accept:false}),p=await prepare(h);
  assert.equal((await h.service.call('siyuan_commit_write',{operationId:p.operationId})).written,false);assert.deepEqual(h.events,['confirm']);await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId}),/已使用/);
});
test('Codex generated display image is archived without exporting the tool prompt or hidden outputs',async()=>{
  const value=thread('/image.png');value.turns[0].items.push({type:'imageGeneration',id:'generated',status:'completed',result:png.toString('base64'),revisedPrompt:'PRIVATE TOOL PROMPT'});
  const capture=await hydrateImages(fromCodexThread(value),{readSource:async()=>png});assert.equal(capture.messages.length,3);assert.equal(capture.messages[2].attachments[0].imageId,digest);assert.equal(capture.images.length,1);assert.ok(!JSON.stringify(capture).includes('PRIVATE TOOL PROMPT'));
});
test('cancellation during asset upload reports retained assets and never starts document write',async()=>{
  const capture=await hydrateImages(fromCodexThread(thread('/image.png')),{readSource:async()=>png});const controller=new AbortController();const h=harness(capture,{upload:images=>{controller.abort();return {succMap:{[images[0].name]:'assets/retained.png'}};}}),p=await prepare(h);
  const result=await h.service.call('siyuan_commit_write',{operationId:p.operationId},controller.signal);assert.equal(result.written,false);assert.equal(result.assets[digest],'assets/retained.png');assert.equal(h.events.length,2);assert.equal(h.service.busy,false);
});
test('missing image stops full save before confirmation; explicit text-only save is marked',async()=>{
  const capture=await hydrateImages(fromCodexThread(thread('/missing.png')),{readSource:async()=>{throw new Error('原图丢失');}});const h=harness(capture);
  await assert.rejects(()=>prepare(h),/无法完整保存图片/);assert.equal(h.events.length,0);
  const p=await h.service.call('siyuan_save_captured_chat',{captureId:h.c.captureId,mode:'original',includeImages:false,notebook,path:'/仅文字'});assert.match(p.preview,/未复制图片/);assert.ok(!p.preview.includes('siyuan-chat-image://'));
});
test('summary appends every original image; original mode cannot accept rewritten text',async()=>{
  const capture=await hydrateImages(fromCodexThread(thread('/image.png')),{readSource:async()=>png});const h=harness(capture);
  const p=await h.service.call('siyuan_save_captured_chat',{captureId:h.c.captureId,mode:'summary',summaryMarkdown:'结论',notebook,path:'/摘要'});assert.match(p.preview,/原聊天图片/);await h.service.call('siyuan_commit_write',{operationId:p.operationId});assert.match(h.events[2].body.markdown,/assets\/original/);
});
test('partial or ambiguous asset success never writes document and reports known uploaded resources',async()=>{
  const capture=await hydrateImages(fromCodexThread(thread('/image.png')),{readSource:async()=>png});
  for(const upload of [()=>({succMap:{},errFiles:['x']}),images=>({succFiles:[{index:0,name:images[0].name,path:'assets/ok.png'}],failedFiles:[{index:1,name:'x'}]}),()=>{throw new Error('网络结果不确定');}]) {
    const h=harness(capture,{upload}),p=await prepare(h),r=await h.service.call('siyuan_commit_write',{operationId:p.operationId});assert.equal(r.written,false);assert.equal(r.status,'asset_upload_incomplete');assert.equal(h.events.length,2);assert.match(r.verification,/勿直接重试/);
  }
});
test('document failure after successful upload preserves asset map and reports uncertain write',async()=>{
  const capture=await hydrateImages(fromCodexThread(thread('/image.png')),{readSource:async()=>png});const h=harness(capture,{post:()=>{throw new Error('连接中断');}}),p=await prepare(h);const r=await h.service.call('siyuan_commit_write',{operationId:p.operationId});assert.equal(r.status,'document_write_uncertain');assert.equal(r.written,null);assert.ok(r.assets[digest]);
});
test('browser JSON bytes round-trip and forged local paths are never read',async()=>{
  const capture=await hydrateImages(fromCodexThread(thread('/image.png')),{readSource:async()=>png});capture.source='chatgpt-web';capture.coverage='page-text-user-verified';capture.messages[0].attachments[0].source='C:/sensitive.png';
  const v=validateCapture(capture);assert.equal(v.messages[0].attachments[0].source,undefined);assert.deepEqual(Buffer.from(v.images[0].base64,'base64'),png);
  const h=harness(v),p=await prepare(h);assert.equal((await h.service.call('siyuan_commit_write',{operationId:p.operationId})).written,true);
  capture.images[0].id='forged';assert.throws(()=>validateCapture(capture),/SHA-256/);
});
test('image file import exceeds former 8 MiB cap without exposing binary in metadata',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-image-import-'));try {
    const large=Buffer.concat([png,Buffer.alloc(7*1024*1024)]);const c=await hydrateImages(fromCodexThread(thread('/image.png')),{readSource:async()=>large});c.source='chatgpt-web';c.coverage='page-text-user-verified';const file=path.join(dir,'capture.json');await fs.writeFile(file,JSON.stringify(c));assert.ok((await fs.stat(file)).size>8*1024*1024);
    const chats=new ChatCaptures(),meta=await chats.capture({source:'chatgpt-web',captureFile:file});assert.equal(meta.imageCount,1);assert.equal(meta.imageBytes,large.length);assert.ok(!JSON.stringify(chats.read({captureId:meta.captureId})).includes('base64'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('image parser handles spaces, nested parentheses, reference links and excludes code examples',()=>{
  const text='![a](<C:/a b.png>)\n![b](https://example.com/a(b).png)\n![c][ref]\n[ref]: https://example.com/c.png\n`![bad](/secret.png)`\n```md\n![bad2](/secret2.png)\n```';const refs=imageReferences(text);assert.equal(refs.length,3);assert.equal(refs[0].source,'C:/a b.png');assert.equal(refs[1].source,'https://example.com/a(b).png');assert.equal(refs[2].source,'https://example.com/c.png');
});
test('invalid image bytes, oversized images, private addresses and unsafe resource paths are rejected',()=>{
  assert.throws(()=>decodeImage(Buffer.from('not an image').toString('base64')),/原始图片/);assert.throws(()=>decodeImage('a'.repeat(Math.ceil(MAX_IMAGE_BYTES/3)*4+4)),/20 MiB/);
  for(const a of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicAddress(a),false);assert.equal(publicAddress('8.8.8.8'),true);
  for(const p of ['http://evil/x','assets/../x','assets/%2e%2e/x','assets/x)bad'])assert.throws(()=>replaceImageLinks('',[{id:digest}],{[digest]:p}),/无效/);
});
test('multipart upload uses SiYuan authentication only on loopback with original bytes and fixed assets folder',async()=>{
  let received;const server=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);received={url:req.url,headers:req.headers,bytes:Buffer.concat(chunks)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data:{succMap:{'test.png':'assets/test.png'}}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const api=new Api({session:async()=>({apiUrl:`http://127.0.0.1:${server.address().port}`,token:'test-only'})});await api.uploadImages([{name:'test.png',mime:'image/png',base64:png.toString('base64')}]);assert.equal(received.url,'/api/asset/upload');assert.equal(received.headers.authorization,'Token test-only');assert.match(received.headers['content-type'],/multipart\/form-data; boundary=/);assert.ok(received.bytes.includes(png));assert.match(received.bytes.toString(),/name="assetsDirPath"\r\n\r\n\/assets\//);assert.match(received.bytes.toString(),/name="file\[\]"; filename="test.png"/);}finally{await new Promise(r=>server.close(r));}
});
test('virtualized browser captures image bytes while each message is mounted, deduplicates and restores viewport',async()=>{
  const saved={location:globalThis.location,document:globalThis.document,getComputedStyle:globalThis.getComputedStyle,fetch:globalThis.fetch};let downloads=0,position=0;
  try {
    globalThis.location={href:'https://chatgpt.com/c/abcdefgh'};globalThis.fetch=async(_url,options)=>{downloads++;assert.equal(options.credentials,'same-origin');return new Response(png);};
    const scroller={scrollHeight:200,clientHeight:100,get scrollTop(){return position;},set scrollTop(n){position=Math.max(0,Math.min(100,n));}};
    const img={getAttribute:n=>n==='src'?'https://chatgpt.com/image.png':n==='alt'?'截图':null,closest:()=>null};
    const nodes=[0,1].map(i=>({parentElement:scroller,innerText:'消息'+i,getAttribute:n=>n==='data-message-author-role'?(i?'assistant':'user'):n==='data-message-id'?'m'+i:null,closest:s=>s==='[aria-hidden="true"]'?null:{getAttribute:()=>`conversation-turn-${i}`},querySelector:()=>null,querySelectorAll:()=>[img]}));
    const main={querySelector:()=>nodes[0],querySelectorAll:()=>[nodes[Math.floor(position/100)]]};globalThis.document={title:'图片测试',querySelector:s=>s==='main'?main:null};globalThis.getComputedStyle=()=>({overflowY:'auto'});
    const result=await captureChatPage({pollMs:1,maxMs:2000});assert.equal(downloads,1);assert.equal(result.images.length,1);assert.equal(result.images[0].id,digest);assert.deepEqual(Buffer.from(result.images[0].base64,'base64'),png);assert.equal(result.messages[1].attachments[0].imageId,digest);assert.equal(position,0);
    downloads=0;globalThis.fetch=async()=>new Response('expired',{status:403});const failed=await captureChatPage({pollMs:1,maxMs:2000});assert.match(failed.images[0].error,/失效/);assert.equal(position,0);
  }finally{Object.assign(globalThis,saved);}
});
