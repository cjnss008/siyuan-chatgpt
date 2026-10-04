import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HostRequests,createConfirmation} from '../server/confirmation.mjs';
import {Service} from '../server/core.mjs';

const notebook='20261004110000-abcdefg';
function harness(options={}) {
  const writes=[];
  const api={session:async()=>({apiUrl:'http://127.0.0.1:6806',token:''}),post:async(endpoint,body)=>{
    if(endpoint==='/api/notebook/lsNotebooks')return {notebooks:[{id:notebook,name:'Notebook'}]};
    writes.push({endpoint,body});return '20261004120000-abcdefg';
  }};
  return {service:new Service({api,...options}),writes};
}

test('default native confirmation passes complete long content and cancellation to the helper despite host form capability',async()=>{
  const controller=new AbortController();let received,formCalls=0;
  const h=harness({runWindows:async(mode,data,timeout,options)=>{
    received={mode,data,timeout,signal:options.signal};return JSON.stringify({accepted:false});
  }});
  h.service.confirm=createConfirmation({nativeConfirm:h.service.confirm,request:async()=>{formCalls++;},getCapabilities:()=>({elicitation:{form:{}}})});
  const markdown='first\n'+'完整聊天正文\n'.repeat(10000)+'last';
  const p=await h.service.call('siyuan_create_document',{notebook,path:'/ChatGPT/原文',markdown});
  assert.equal(p.previewTruncated,true);assert.ok(p.preview.length<2000);assert.equal(p.contentCharacters,markdown.length);
  let full='',offset=0;
  do {const r=await h.service.call('siyuan_read_write_preview',{operationId:p.operationId,offset,limit:12345});full+=r.content;offset=r.nextOffset;}while(offset!==null);
  assert.ok(full.includes(markdown));
  const result=await h.service.call('siyuan_commit_write',{operationId:p.operationId},controller.signal);
  assert.equal(result.written,false);assert.equal(h.writes.length,0);assert.equal(formCalls,0);
  assert.equal(received.mode,'confirm');assert.equal(received.signal,controller.signal);assert.equal(received.timeout,120000);assert.equal(received.data.message,full);
});

test('short host form approval is bound to the complete immutable write; late responses cannot approve expired requests',async()=>{
  const sent=[];const peer=new HostRequests(m=>sent.push(m),{timeout:30});
  const h=harness();
  h.service.confirm=createConfirmation({nativeConfirm:async()=>{throw new Error('unexpected native fallback');},request:peer.request.bind(peer),getCapabilities:()=>({elicitation:{form:{}}})});
  const markdown='FIRST '+'秘密完整正文'.repeat(10000)+' LAST';
  const p=await h.service.call('siyuan_create_document',{notebook,path:'/ChatGPT/Long',markdown});
  const first=h.service.call('siyuan_commit_write',{operationId:p.operationId,confirmationUi:'host'});
  const rejected=assert.rejects(first,/等待超时/);
  await new Promise(r=>setImmediate(r));
  assert.ok(sent[0].params.message.length<2000);assert.ok(!sent[0].params.message.includes(markdown));
  assert.ok(sent[0].params.message.includes(p.contentHash));
  await rejected;assert.equal(peer.pending.size,0);assert.equal(h.service.busy,false);assert.equal(h.writes.length,0);
  assert.equal(peer.settle({id:sent[0].id,result:{action:'accept',content:{confirm:true}}}),false);
  await assert.rejects(h.service.call('siyuan_commit_write',{operationId:p.operationId,confirmationUi:'host'}));
  const p2=await h.service.call('siyuan_create_document',{notebook,path:'/ChatGPT/Long',markdown});
  const second=h.service.call('siyuan_commit_write',{operationId:p2.operationId,confirmationUi:'host'});
  await new Promise(r=>setImmediate(r));
  peer.settle({id:sent[1].id,result:{action:'accept',content:{confirm:true}}});
  assert.equal((await second).written,true);assert.equal(h.writes.length,1);assert.equal(h.writes[0].body.markdown,markdown);
});

test('host cancellation and connection close release only affected requests and never accept stale replies',async()=>{
  const sent=[];const peer=new HostRequests(m=>sent.push(m),{timeout:1000});
  const controller=new AbortController();
  const first=peer.request('elicitation/create',{}, {signal:controller.signal});
  const second=peer.request('elicitation/create',{});
  const rejected=assert.rejects(first,/已取消/);controller.abort();await rejected;
  assert.equal(peer.pending.size,1);assert.equal(peer.settle({id:sent[0].id,result:{action:'accept'}}),false);
  const closed=assert.rejects(second,/连接关闭/);peer.close();await closed;assert.equal(peer.pending.size,0);
});

test('host decline, missing check, timeout and errors never open a fallback dialog',async()=>{
  for(const reply of [{action:'decline'},{action:'cancel'},{action:'accept',content:{confirm:false}},{action:'accept'},null]) {
    let nativeCalls=0;
    const confirm=createConfirmation({nativeConfirm:async()=>{nativeCalls++;return true;},request:async()=>reply,getCapabilities:()=>({elicitation:{form:{}}})});
    assert.equal(await confirm('full',{ui:'host',summary:'compact'}),false);assert.equal(nativeCalls,0);
  }
  let nativeCalls=0;
  const confirm=createConfirmation({nativeConfirm:async()=>{nativeCalls++;return true;},request:async()=>{throw new Error('timeout');},getCapabilities:()=>({elicitation:{form:{}}})});
  await assert.rejects(confirm('full',{ui:'host',summary:'compact'}),/timeout/);assert.equal(nativeCalls,0);
});

test('native cancellation kills the helper and releases the write lock without writing',async()=>{
  const controller=new AbortController();let signalSeen;
  const h=harness({runWindows:async(mode,data,timeout,{signal})=>{
    signalSeen=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('请求已取消')),{once:true}));
  }});
  const p=await h.service.call('siyuan_create_document',{notebook,path:'/Test',markdown:'original'});
  const pending=h.service.call('siyuan_commit_write',{operationId:p.operationId},controller.signal);
  const rejected=assert.rejects(pending,/已取消/);await new Promise(r=>setImmediate(r));controller.abort();await rejected;
  assert.equal(signalSeen,controller.signal);assert.equal(h.service.busy,false);assert.equal(h.writes.length,0);
});
