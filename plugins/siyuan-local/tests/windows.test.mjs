import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {windows,Config,Service} from '../server/core.mjs';

function helperMock({reply='{}',hold=false,fail=false}={}) {
  const calls=[];
  const spawnProcess=(command,args,options)=>{
    const child=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.stdout.setEncoding=child.stderr.setEncoding=()=>{};
    child.stdin=new EventEmitter();
    const call={command,args,options,child,killed:false};calls.push(call);
    child.kill=()=>{call.killed=true;queueMicrotask(()=>child.emit('close',1));};
    child.stdin.end=input=>{
      call.input=JSON.parse(input);
      if(!hold)queueMicrotask(()=>{if(fail)child.emit('error',new Error('synthetic error'));else {child.stdout.emit('data',reply);child.emit('close',0);}});
    };
    return child;
  };
  return {calls,options:{spawnProcess,platform:'win32'}};
}

test('configure and confirmation use visible interactive processes; secrets stay on stdin',async()=>{
  for(const mode of ['configure','confirm','protect','unprotect']) {
    const h=helperMock({reply:'safe-output'});
    assert.equal(await windows(mode,{token:'temporary-secret'},1000,h.options),'safe-output');
    const c=h.calls[0],interactive=['configure','confirm'].includes(mode);
    assert.equal(c.command,'powershell.exe');assert.equal(c.options.windowsHide,!interactive);
    assert.equal(c.args.includes('-NonInteractive'),!interactive);
    if(interactive)assert.equal(c.args[c.args.indexOf('-WindowStyle')+1],'Normal');
    assert.ok(c.args.includes('-STA'));assert.ok(!c.args.join(' ').includes('temporary-secret'));
    assert.deepEqual(c.input,{token:'temporary-secret'});
  }
});

test('cancel, timeout and process startup failure settle without leaving a dialog running',async()=>{
  const controller=new AbortController(),h=helperMock({hold:true});
  const call=windows('configure',{},1000,{...h.options,signal:controller.signal});
  const rejected=assert.rejects(call,/已取消/);controller.abort();await rejected;
  assert.equal(h.calls[0].killed,true);
  const h2=helperMock({hold:true});await assert.rejects(windows('configure',{},10,h2.options),/窗口已超时/);
  assert.equal(h2.calls[0].killed,true);
  const h3=helperMock({fail:true});await assert.rejects(windows('configure',{},1000,h3.options),/无法启动/);
  const h4=helperMock();await assert.rejects(windows('configure',{},1000,{...h4.options,signal:controller.signal}),/已取消/);
  assert.equal(h4.calls.length,0);
});

test('configuration keeps existing encrypted token, returns no ciphertext, and cancellation saves nothing',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-configure-'));
  try {
    let next={accepted:false},received;
    const config=new Config(dir,{runWindows:async(mode,data)=>{received={mode,data};return JSON.stringify(next);}});
    await config.save({apiUrl:'http://localhost:6806',tokenCipher:'old-cipher'});
    const before=await fs.readFile(config.file,'utf8');
    assert.deepEqual(await config.configure(),{saved:false});assert.equal(await fs.readFile(config.file,'utf8'),before);
    assert.deepEqual(received,{mode:'configure',data:{apiUrl:'http://localhost:6806'}});
    next={accepted:true,apiUrl:'http://127.0.0.1:6806',tokenCipher:'',clearToken:false};
    assert.deepEqual(await config.configure(),{saved:true,apiUrl:'http://127.0.0.1:6806',tokenConfigured:true});
    assert.equal((await config.load()).tokenCipher,'old-cipher');
    next={...next,tokenCipher:'new-cipher'};const result=await config.configure();
    assert.ok(!JSON.stringify(result).includes('cipher'));assert.equal((await config.load()).tokenCipher,'new-cipher');
    next={...next,clearToken:true};assert.equal((await config.configure()).tokenConfigured,false);
    assert.equal((await config.load()).tokenCipher,'');
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('cancelled configuration cannot save even if the helper returns an accepted response',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'siyuan-abort-'));
  try {
    const controller=new AbortController();
    const config=new Config(dir,{runWindows:async()=>{controller.abort();return JSON.stringify({accepted:true,apiUrl:'http://localhost:6807',tokenCipher:'new-cipher'});}});
    await config.save({apiUrl:'http://localhost:6806',tokenCipher:'old-cipher'});
    const before=await fs.readFile(config.file,'utf8');
    await assert.rejects(config.configure(controller.signal),/已取消/);
    assert.equal(await fs.readFile(config.file,'utf8'),before);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('both configuration entries share one dialog; settings changes clear stale write previews',async()=>{
  let release,receivedSignal;
  const config={configure:signal=>{receivedSignal=signal;return new Promise(r=>release=r);}};
  const s=new Service({config}),controller=new AbortController();
  s.pending.set('preview',{});
  const first=s.call('siyuan_configure',{},controller.signal);
  assert.equal(receivedSignal,controller.signal);
  await assert.rejects(s.call('settings.configure'),/配置窗口已打开/);
  release({saved:false});assert.deepEqual(await first,{saved:false});assert.equal(s.pending.size,1);
  const second=s.call('settings.configure');release({saved:true});await second;assert.equal(s.pending.size,0);
  s.busy=true;await assert.rejects(s.call('siyuan_configure'),/写入确认期间/);
  await assert.rejects(s.call('siyuan_configure',{token:'secret'}),/参数无效/);
});
