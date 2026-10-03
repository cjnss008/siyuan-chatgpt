import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';

test('stdio lifecycle, discovery, native settings schema and real elicitation acceptance/decline',async()=>{
  const id='20261004120000-abcdefg';let writes=0,accept=false;
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',d=>body+=d);req.on('end',()=>{
      const args=JSON.parse(body);let data;
      if(req.url==='/api/block/getBlockKramdown')data={id:args.id,kramdown:'Before'};
      else if(req.url==='/api/filetree/getHPathByID')data='/Protocol Test';
      else if(req.url==='/api/block/updateBlock'){writes++;data:[{doOperations:[{id}]}];}
      else data={notebooks:[]};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,msg:'',data}));
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-protocol-'));
  await fs.writeFile(path.join(dir,'settings.json'),JSON.stringify({apiUrl:`http://127.0.0.1:${server.address().port}`,tokenCipher:''}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server/index.mjs',import.meta.url))],{env:{...process.env,SIYUAN_PLUGIN_CONFIG_DIR:dir},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let seq=0,elicitations=0,stderr='';const pending=new Map();
  child.stderr.on('data',d=>stderr+=d);
  const lines=readline.createInterface({input:child.stdout});
  const send=m=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
  lines.on('line',line=>{
    const m=JSON.parse(line); // Any stdout log breaks this test.
    if(m.method==='elicitation/create') {
      elicitations++;assert.ok(m.params.message.includes('After'));assert.equal(m.params.requestedSchema.properties.confirm.default,false);
      send({id:m.id,result:accept?{action:'accept',content:{confirm:true}}:{action:'decline'}});
    } else {
      const p=pending.get(m.id);assert.ok(p);pending.delete(m.id);clearTimeout(p.timer);p.resolve(m);
    }
  });
  const request=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq;const timer=setTimeout(()=>reject(new Error('protocol timeout')),20000);pending.set(id,{resolve,reject,timer});send({id,method,params});
  });
  const call=async(name,args={})=>(await request('tools/call',{name,arguments:args})).result;
  try {
    const init=await request('initialize',{protocolVersion:'2025-11-25',capabilities:{elicitation:{form:{}}},clientInfo:{name:'test',version:'1'}});
    assert.equal(init.result.protocolVersion,'2025-11-25');assert.equal(init.result.capabilities.experimental['openai/settings'].readTool,'settings.read');
    send({method:'notifications/initialized'});
    const discover=await request('server/discover');assert.equal(discover.result.resultType,'complete');
    const listed=await request('tools/list');assert.equal(listed.result.tools.length,18);
    const pageJson=JSON.stringify({thread:{id:'protocol-current-chat',kind:'codex',title:'Protocol chat'},page:{order:'newest_first',hasMore:false,nextCursor:null},turns:[{id:'turn-1',status:'completed',items:[{type:'userMessage',id:'user-1',content:[{type:'text',text:'原始聊天文字'}]}]}]});
    const captured=await call('siyuan_ingest_chat_page',{pageJson});assert.equal(captured.structuredContent.ready,true);
    const chatText=await call('siyuan_read_captured_chat',{captureId:captured.structuredContent.captureId});assert.ok(chatText.structuredContent.content.includes('原始聊天文字'));assert.equal(writes,0);
    const configure=listed.result.tools.find(t=>t.name==='siyuan_configure');
    assert.ok(configure);assert.ok(!configure._meta?.ui?.visibility || configure._meta.ui.visibility.includes('model'));
    assert.deepEqual(configure.inputSchema.properties,{});
    assert.equal((await call('siyuan_configure',{token:'must-not-be-accepted'})).isError,true);
    assert.ok(listed.result.tools.find(t=>t.name==='settings.read').outputSchema);
    assert.ok((await call('settings.read')).structuredContent.layout[0].items.some(i=>i.tool==='settings.configure'));
    assert.equal((await call('siyuan_status')).structuredContent.connected,true);
    const p=(await call('siyuan_update_block',{id,markdown:'After'})).structuredContent;assert.equal(writes,0);
    assert.equal((await call('siyuan_commit_write',{operationId:p.operationId})).structuredContent.written,false);assert.equal(writes,0);
    accept=true;const p2=(await call('siyuan_update_block',{id,markdown:'After'})).structuredContent;
    assert.equal((await call('siyuan_commit_write',{operationId:p2.operationId})).structuredContent.written,true);assert.equal(writes,1);assert.equal(elicitations,2);
    assert.equal((await call('siyuan_commit_write',{operationId:p2.operationId})).isError,true);
    assert.equal((await request('not/a/method')).error.code,-32601);
    assert.equal(stderr,'');
  } finally {
    for(const p of pending.values())clearTimeout(p.timer);
    child.kill();lines.close();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});
  }
});
