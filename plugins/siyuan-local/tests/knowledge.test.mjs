import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Service,TOOLS,validate} from '../server/core.mjs';
import {mergeRanges} from '../server/knowledge.mjs';
const id='20261004120000-abcdefg',other='20261004120001-abcdefg',notebook='20261004110000-abcdefg';
async function harness(confirm=async()=>true){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-knowledge-test-'));
 const state={text:'# Source\n\nA grounded quote.',token:'test',created:[],exists:[],readbackFail:false,postFail:false,confirmCalls:0};
 const calls=[];
 const config={dir,load:async()=>({apiUrl:'http://127.0.0.1:6806',tokenCipher:''})};
 const api={session:async()=>({apiUrl:'http://127.0.0.1:6806',token:state.token}),post:async(endpoint,body)=>{
  calls.push({endpoint,body});
  if(endpoint==='/api/notebook/lsNotebooks')return {notebooks:[{id:notebook,name:'Notebook',closed:false}]};
  if(endpoint==='/api/query/sql'){
   if(body.stmt.startsWith('SELECT id, root_id'))return [{id,root_id:id}];
   if(body.stmt.startsWith('SELECT b.id'))return body.stmt.endsWith('OFFSET 0')?[{id,box:notebook,hpath:'/Source',title:'Source',incoming:0,outgoing:0}]:[];
   return [];
  }
  if(endpoint==='/api/block/getBlockKramdown'){if(state.readbackFail&&state.created.includes(body.id))throw Error('readback failed');return {kramdown:state.text};}
  if(endpoint==='/api/filetree/getIDsByHPath')return state.exists;
  if(endpoint==='/api/filetree/createDocWithMd'){if(state.postFail)throw Error('timeout');const created=state.created.length?other:id;state.created.push(created);return created;}
  if(endpoint==='/api/filetree/getHPathByID')return state.created.length===1?'/Map/A':'/Map/B';
  throw Error(endpoint);
 }};
 const service=new Service({api,config,confirm:async(...args)=>{state.confirmCalls++;return confirm(...args);}});
 return {service,dir,state,calls,restart:()=>new Service({api,config,confirm})};
}
const createJob=async h=>(await h.service.call('siyuan_start_knowledge_job',{notebook,title:'Knowledge'})).jobId;
const analysis=(sourceHash,quote='A grounded quote.')=>({id,sourceHash,stage:'analyzed',topics:['Concept'],summary:'Model summary',evidence:[{blockId:id,quote}]});
test('strict bounded arrays reject unsupported flags and nested shape',()=>{
 const schema=TOOLS.find(t=>t.name==='siyuan_prepare_document_batch').inputSchema;
 assert.throws(()=>validate(schema,{notebook,documents:[]}));
 assert.throws(()=>validate(schema,{notebook,documents:[{path:'/Map/A',markdown:'x',force:true}]}));
 assert.throws(()=>validate(schema,{notebook,documents:Array(51).fill({path:'/Map/A',markdown:'x'})}));
});
test('inventory and references use only fixed paginated queries',async()=>{
 const h=await harness();await h.service.call('siyuan_list_documents',{notebook,limit:20,offset:40});
 await h.service.call('siyuan_list_references',{id,scope:'document',direction:'both',limit:10,offset:20});
 assert.match(h.calls[0].body.stmt,/b.type = 'd'/);assert.match(h.calls[0].body.stmt,/ORDER BY b.id ASC LIMIT 20 OFFSET 40$/);
 assert.match(h.calls[1].body.stmt,/def_block_root_id/);assert.match(h.calls[1].body.stmt,/LIMIT 10 OFFSET 20$/);
 await assert.rejects(()=>h.service.call('siyuan_list_references',{id:"x'; DELETE FROM refs"}));
});
test('job survives restart; partial source fetch cannot claim analyzed; evidence and version enforced',async()=>{
 const h=await harness(),jobId=await createJob(h);
 let p=await h.service.call('siyuan_read_knowledge_source',{jobId,id,limit:5});
 assert.equal(p.fetchedAll,false);
 await assert.rejects(()=>h.service.call('siyuan_record_knowledge_analysis',{jobId,entries:[analysis(p.hash)]}));
 p=await h.service.call('siyuan_read_knowledge_source',{jobId,id,offset:5,limit:100});assert.equal(p.fetchedAll,true);
 await assert.rejects(()=>h.service.call('siyuan_record_knowledge_analysis',{jobId,entries:[analysis(p.hash,'invented quote')]}));
 await h.service.call('siyuan_record_knowledge_analysis',{jobId,entries:[analysis(p.hash)]});
 const restarted=h.restart(),r=await restarted.call('siyuan_read_knowledge_job',{jobId});assert.equal(r.counts.analyzed,1);assert.equal(r.documents[0].analysis.factVerification,'not-external-verified');
 h.state.text='Changed';await assert.rejects(()=>restarted.call('siyuan_record_knowledge_analysis',{jobId,entries:[analysis(p.hash)]}));
 await restarted.call('siyuan_read_knowledge_source',{jobId,id});assert.equal((await restarted.call('siyuan_read_knowledge_job',{jobId})).documents[0].analysis,undefined);
 h.state.token='different';await assert.rejects(()=>restarted.call('siyuan_read_knowledge_job',{jobId}));
});
test('wrong-document evidence, repeated IDs and skipped pagination fail closed',async()=>{
 const h=await harness(),jobId=await createJob(h);let p=await h.service.call('siyuan_read_knowledge_source',{jobId,id,offset:10,limit:100});assert.equal(p.fetchedAll,false);
 p=await h.service.call('siyuan_read_knowledge_source',{jobId,id,limit:100});
 const entry=analysis(p.hash);entry.evidence[0].blockId=other;
 await assert.rejects(()=>h.service.call('siyuan_record_knowledge_analysis',{jobId,entries:[entry]}));
 await assert.rejects(()=>h.service.call('siyuan_record_knowledge_analysis',{jobId,entries:[analysis(p.hash),analysis(p.hash)]}));
 assert.deepEqual(mergeRanges([[0,5],[12,20]],5,12),[[0,20]]);
});
const batch={notebook,documents:[{path:'/Map/A',markdown:'# A'},{path:'/Map/B',markdown:'# B'}]};
test('one full batch preview and user approval writes once per item and journals readback',async()=>{
 let displayed;const h=await harness(async m=>{displayed=m;return true;}),jobId=await createJob(h);
 const p=await h.service.call('siyuan_prepare_document_batch',{...batch,jobId});assert.equal(h.state.created.length,0);
 const r=await h.service.call('siyuan_commit_write',{operationId:p.operationId});assert.equal(r.written,true);assert.equal(h.state.confirmCalls,1);assert.match(displayed,/# A/);assert.match(displayed,/# B/);
 assert.equal(r.items.length,2);assert.ok(r.items.every(i=>i.status==='created_readback'));
 assert.equal((await h.restart().call('siyuan_read_knowledge_job',{jobId})).outputs[0].items.length,2);
 await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId}));
});
test('decline, duplicates, existing paths and post-approval races do not write',async()=>{
 const h=await harness(async()=>false);const p=await h.service.call('siyuan_prepare_document_batch',batch);assert.equal((await h.service.call('siyuan_commit_write',{operationId:p.operationId})).written,false);
 await assert.rejects(()=>h.service.call('siyuan_prepare_document_batch',{notebook,documents:[batch.documents[0],batch.documents[0]]}));
 h.state.exists=[id];await assert.rejects(()=>h.service.call('siyuan_prepare_document_batch',batch));assert.equal(h.state.created.length,0);
 const race=await harness(async()=>{race.state.exists=[id];return true;});const p2=await race.service.call('siyuan_prepare_document_batch',batch);assert.equal((await race.service.call('siyuan_commit_write',{operationId:p2.operationId})).written,false);assert.equal(race.state.created.length,0);
});
test('partial and unknown writes keep journals and never retry automatically',async()=>{
 const h=await harness(),jobId=await createJob(h);h.state.postFail=true;
 const p=await h.service.call('siyuan_prepare_document_batch',{...batch,jobId});const r=await h.service.call('siyuan_commit_write',{operationId:p.operationId});assert.equal(r.written,null);assert.equal(r.items[0].status,'uncertain');assert.equal(r.items[1].status,'not_started');
 assert.equal(h.calls.filter(c=>c.endpoint==='/api/filetree/createDocWithMd').length,1);
 assert.equal((await h.restart().call('siyuan_read_knowledge_job',{jobId})).outputs[0].items[0].status,'uncertain');
 const partial=await harness();partial.state.readbackFail=true;const p2=await partial.service.call('siyuan_prepare_document_batch',batch);const r2=await partial.service.call('siyuan_commit_write',{operationId:p2.operationId});assert.equal(r2.written,true);assert.equal(r2.items[0].status,'created_readback_failed');assert.equal(partial.state.created.length,1);
});
test('batch awaits network completion while holding the existing write lock',async()=>{
 const h=await harness();const original=h.service.api.post;let release;
 h.service.api.post=async(e,b,...rest)=>{if(e==='/api/filetree/createDocWithMd')await new Promise(r=>release=r);return original(e,b,...rest);};
 const p=await h.service.call('siyuan_prepare_document_batch',{notebook,documents:[batch.documents[0]]});const pending=h.service.call('siyuan_commit_write',{operationId:p.operationId});
 for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,2));assert.ok(release);assert.equal(h.service.busy,true);release();await pending;assert.equal(h.service.busy,false);
});
