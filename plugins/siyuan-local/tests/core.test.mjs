import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {Service, Config, Api, TOOLS, normalizeUrl, windows} from '../server/core.mjs';

const block='20261004120000-abcdefg', notebook='20261004110000-abcdefg';
function harness(confirm=async()=>true) {
  let text='Old content',session={apiUrl:'http://127.0.0.1:6806',token:'test-secret'},now=1000000;
  const calls=[];
  const config={load:async()=>({apiUrl:session.apiUrl,tokenCipher:'ENCRYPTED'})};
  const api={session:async()=>({...session}),post:async(endpoint,body)=>{
    calls.push({endpoint,body});
    if(endpoint==='/api/notebook/lsNotebooks')return {notebooks:[{id:notebook,name:'Notebook',closed:false}]};
    if(endpoint==='/api/block/getBlockKramdown')return {id:block,kramdown:text};
    if(endpoint==='/api/filetree/getHPathByID')return '/Notes/Doc';
    if(endpoint==='/api/export/exportMdContent')return {hPath:'/Notes/Doc',content:'Document Markdown'};
    if(endpoint==='/api/query/sql')return body.stmt.startsWith('SELECT type')?[{type:'d'}]:[{id:block,content:'found'}];
    return block;
  }};
  const service=new Service({config,api,confirm,now:()=>now});
  return {service,calls,setText:v=>text=v,setSession:v=>session=v,tick:()=>now+=600001,writes:()=>calls.filter(c=>['/api/block/updateBlock','/api/block/appendBlock','/api/filetree/createDocWithMd'].includes(c.endpoint))};
}
test('loopback restriction rejects credential-bearing, remote and path URLs',()=>{
  assert.equal(normalizeUrl('http://localhost:6806/'),'http://localhost:6806');
  assert.equal(normalizeUrl('http://[::1]:6806'),'http://[::1]:6806');
  for(const url of ['https://example.com','http://192.168.1.1:6806','http://u:p@localhost:6806','http://localhost:6806/api','http://localhost:6806/?x=1','file:///x'])assert.throws(()=>normalizeUrl(url));
});
test('search uses escaped literal strings and bounded pagination',async()=>{
  const h=harness();await h.service.call('siyuan_search',{query:"'; DELETE FROM blocks; --",kind:'documents',notebook,limit:12,offset:24});
  const sql=h.calls[0].body.stmt;
  assert.ok(sql.startsWith('SELECT '));assert.ok(sql.includes("instr(content, '''; DELETE FROM blocks; --')"));assert.ok(sql.includes("type = 'd'"));assert.ok(sql.endsWith('LIMIT 12 OFFSET 24'));
  await assert.rejects(()=>h.service.call('siyuan_search',{query:'x',limit:101}));
  await assert.rejects(()=>h.service.call('siyuan_search',{query:'x',stmt:'DELETE'}));
});
test('read pagination preserves hash of full source',async()=>{
  const h=harness();const r=await h.service.call('siyuan_read_block',{id:block,limit:3});
  const r2=await h.service.call('siyuan_read_block',{id:block,offset:3,limit:100});
  assert.equal(r.content,'Old');assert.equal(r.nextOffset,3);assert.equal(r.hash,r2.hash);assert.equal(r2.nextOffset,null);
  assert.equal((await h.service.call('siyuan_read_document',{id:block})).content,'Document Markdown');
});
for(const [name,args,endpoint]of [
  ['siyuan_create_document',{notebook,path:'/New/Doc',markdown:'# New'},'/api/filetree/createDocWithMd'],
  ['siyuan_append_content',{parentId:block,markdown:'Append'},'/api/block/appendBlock'],
  ['siyuan_update_block',{id:block,markdown:'Replace'},'/api/block/updateBlock']
])test(`${name}: preview is read-only; confirmation writes exactly once`,async()=>{
  let message;const h=harness(async m=>{message=m;return true;});
  const p=await h.service.call(name,args);assert.equal(h.writes().length,0);assert.ok(p.preview.includes(args.markdown));
  const r=await h.service.call('siyuan_commit_write',{operationId:p.operationId});assert.equal(r.written,true);assert.equal(h.writes().length,1);assert.equal(h.writes()[0].endpoint,endpoint);assert.ok(message.includes(args.markdown));
  await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId}));
});
test('decline or cancel never writes and does not allow replay',async()=>{
  const h=harness(async()=>false);const p=await h.service.call('siyuan_update_block',{id:block,markdown:'New'});
  assert.equal((await h.service.call('siyuan_commit_write',{operationId:p.operationId})).written,false);assert.equal(h.writes().length,0);
  await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId}));
  const p2=await h.service.call('siyuan_update_block',{id:block,markdown:'New'});
  assert.equal((await h.service.call('siyuan_cancel_write',{operationId:p2.operationId})).cancelled,true);
  await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p2.operationId}));
});
test('model supplied confirmed/force flags are rejected',async()=>{
  const h=harness();const p=await h.service.call('siyuan_update_block',{id:block,markdown:'New'});
  await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId,confirmed:true}));
  await assert.rejects(()=>h.service.call('siyuan_update_block',{id:block,markdown:'New',force:true}));
  assert.equal(h.writes().length,0);
});
test('expiry before or during confirmation prevents writes',async()=>{
  const h=harness();const p=await h.service.call('siyuan_update_block',{id:block,markdown:'New'});h.tick();
  await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId}));assert.equal(h.writes().length,0);
  const h2=harness(async()=>{h2.tick();return true;});const p2=await h2.service.call('siyuan_update_block',{id:block,markdown:'New'});
  await assert.rejects(()=>h2.service.call('siyuan_commit_write',{operationId:p2.operationId}));assert.equal(h2.writes().length,0);
});
test('expected hash and content changed while user confirms prevent overwrite',async()=>{
  const h=harness(async()=>{h.setText('Concurrent edit');return true;});
  await assert.rejects(()=>h.service.call('siyuan_update_block',{id:block,markdown:'New',expectedHash:'0'.repeat(64)}));
  const p=await h.service.call('siyuan_update_block',{id:block,markdown:'New'});
  await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId}),/目标内容已变化/);assert.equal(h.writes().length,0);
});
test('changed connection or cancellation while confirming prevents writes',async()=>{
  const h=harness();const p=await h.service.call('siyuan_update_block',{id:block,markdown:'New'});h.setSession({apiUrl:'http://127.0.0.1:6807',token:'other'});
  await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId}),/连接设置已变化/);assert.equal(h.writes().length,0);
  const controller=new AbortController();const h2=harness(async()=>{controller.abort();return true;});const p2=await h2.service.call('siyuan_update_block',{id:block,markdown:'New'});
  await assert.rejects(()=>h2.service.call('siyuan_commit_write',{operationId:p2.operationId},controller.signal),/已取消/);assert.equal(h2.writes().length,0);
});
test('simultaneous commit cannot replay or show a second confirmation',async()=>{
  let release;const h=harness(()=>new Promise(r=>release=r));const p=await h.service.call('siyuan_update_block',{id:block,markdown:'New'});
  const first=h.service.call('siyuan_commit_write',{operationId:p.operationId});
  await new Promise(r=>setImmediate(r));
  await assert.rejects(()=>h.service.call('siyuan_commit_write',{operationId:p.operationId}));release(true);await first;assert.equal(h.writes().length,1);
});
test('invalid targets and non-container append are blocked before writes',async()=>{
  const h=harness();
  for(const p of ['New','/a/../b','/a//b','/a/','/a\\b'])await assert.rejects(()=>h.service.call('siyuan_create_document',{notebook,path:p,markdown:''}));
  await assert.rejects(()=>h.service.call('siyuan_read_block',{id:"'; DROP"}));
  const original=h.service.api.post;
  h.service.api.post=async(e,b)=>e==='/api/query/sql'?[{type:'p'}]:original(e,b);
  await assert.rejects(()=>h.service.call('siyuan_append_content',{parentId:block,markdown:'New'}),/容器块/);
  assert.equal(h.writes().length,0);
});
test('native settings preserve encrypted token and never return secret',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-test-'));
  try {
    const config=new Config(dir);await config.save({apiUrl:'http://127.0.0.1:6806',tokenCipher:'ciphertext'});
    const s=new Service({config});const settings=await s.call('settings.read',{});
    assert.equal(settings.values.apiUrl,'http://127.0.0.1:6806');assert.ok(!JSON.stringify(settings).includes('ciphertext'));
    await s.call('settings.update',{set:{apiUrl:'http://localhost:6807'}});
    assert.equal((await config.load()).tokenCipher,'ciphertext');
    assert.ok(TOOLS[0].outputSchema);assert.deepEqual(TOOLS[1]._meta.ui.visibility,['app']);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('DPAPI protects token for Windows current user', {skip:process.platform!=='win32'},async(t)=>{
  const secret='temporary-test-token-中文';let cipher;
  try {cipher=await windows('protect',{token:secret},20000);} catch(e) {
    if(e.message.includes('DPAPI 在当前进程')) {t.skip('Sandbox cannot access the Windows user DPAPI profile; verify in the desktop host.');return;}
    throw e;
  }
  assert.ok(!cipher.includes(secret));assert.equal(await windows('unprotect',{cipher},20000),secret);
});
test('real HTTP adapter authenticates, rejects errors, malformed JSON and redirects',async()=>{
  let auth,mode='ok',redirectTargetHits=0;
  const server=http.createServer((req,res)=>{
    auth=req.headers.authorization;
    if(mode==='redirect'){res.writeHead(302,{location:'/other'});return res.end();}
    if(req.url==='/other')redirectTargetHits++;
    if(mode==='auth'){res.writeHead(401);return res.end();}
    if(mode==='badjson')return res.end('<html>');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(mode==='apierror'?{code:1,msg:'sensitive',data:null}:{code:0,data:{ok:true}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const api=new Api({session:async()=>({apiUrl:`http://127.0.0.1:${server.address().port}`,token:'sample-token'})});
    assert.deepEqual(await api.post('/api/test'),{ok:true});assert.equal(auth,'Token sample-token');
    for(mode of ['auth','badjson','apierror','redirect'])await assert.rejects(()=>api.post('/api/test'));
    assert.equal(redirectTargetHits,0);
  } finally {await new Promise(r=>server.close(r));}
});
