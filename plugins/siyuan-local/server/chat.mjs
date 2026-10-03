import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';

export const MAX_CHAT_BYTES=8*1024*1024;
const sha=text=>createHash('sha256').update(text).digest('hex');
const checkId=id=>{if(typeof id!=='string'||! /^[a-zA-Z0-9_-]{8,100}$/.test(id))throw new Error('需要宿主提供的当前聊天 ID，不能猜测或选择最近的聊天。');return id;};

export function fromCodexThread(thread,{capturedAt=new Date().toISOString()}={}) {
  checkId(thread?.id);
  if(!Array.isArray(thread.turns))throw new Error('宿主未返回完整 turns；不能使用摘要作为全文。');
  const messages=[],warnings=[];
  for(const turn of thread.turns) {
    if(!Array.isArray(turn.items))throw new Error('聊天历史包含未加载的消息，请读取完整历史。');
    for(const item of turn.items) {
      if(item.type==='agentMessage') {
        if(typeof item.text!=='string')throw new Error('助手消息不是完整文本。');
        messages.push({id:item.id??`${turn.id}-${messages.length}`,role:'assistant',text:item.text,phase:item.phase??null});
      } else if(item.type==='userMessage') {
        if(!Array.isArray(item.content))throw new Error('用户消息未加载。');
        const text=[],attachments=[];
        for(const part of item.content) {
          if(part.type==='text'&&typeof part.text==='string')text.push(part.text);
          else attachments.push({type:part.type??'unknown',name:part.path?path.basename(part.path):part.name??''});
        }
        messages.push({id:item.id??`${turn.id}-${messages.length}`,role:'user',text:text.join('\n'),attachments});
        if(attachments.length)warnings.push('包含附件；仅保存附件说明，不复制附件文件。');
      }
    }
    if(turn.status==='inProgress')warnings.push('当前回复尚未完成；快照只包含抓取时已经持久化的内容。');
  }
  return validateCapture({schema:'siyuan-chat-capture/v1',source:'codex',conversationId:thread.id,title:thread.name??thread.title??'Codex 聊天',capturedAt,coverage:'persisted-user-assistant-text',messages,warnings:[...new Set(warnings)]});
}

export function validateCapture(value) {
  if(value?.schema!=='siyuan-chat-capture/v1'||!['codex','chatgpt-web'].includes(value.source)||!Array.isArray(value.messages)||!value.messages.length)throw new Error('不是有效的聊天抓取文件。');
  checkId(value.conversationId);
  if(typeof value.title!=='string'||value.title.length>1000||typeof value.capturedAt!=='string'||!Number.isFinite(Date.parse(value.capturedAt)))throw new Error('聊天标题或抓取时间无效。');
  const coverage=value.source==='codex'?['persisted-user-assistant-text']:['page-text-unverified','page-text-user-verified'];
  if(!coverage.includes(value.coverage))throw new Error('聊天完整性声明无效。');
  const ids=new Set();
  const messages=value.messages.map(m=>{
    if(!m||typeof m.id!=='string'||!m.id||ids.has(m.id)||!['user','assistant'].includes(m.role)||typeof m.text!=='string')throw new Error('聊天消息缺失、重复或格式错误。');
    ids.add(m.id);
    const attachments=(m.attachments??[]).map(a=>{if(typeof a?.type!=='string'||typeof a?.name!=='string')throw new Error('附件说明无效。');return {type:a.type,name:a.name};});
    return {id:m.id,role:m.role,text:m.text,phase:typeof m.phase==='string'?m.phase:null,attachments};
  });
  const result={schema:value.schema,source:value.source,conversationId:value.conversationId,title:value.title,capturedAt:value.capturedAt,coverage:value.coverage,messages,warnings:(value.warnings??[]).filter(w=>typeof w==='string')};
  if(Buffer.byteLength(JSON.stringify(result))>MAX_CHAT_BYTES)throw new Error('聊天记录超过 8 MiB；未截断，请分段导出。');
  if(result.coverage==='page-text-unverified')result.warnings.push('网页记录未核对首尾，不能称为完整记录。');
  return result;
}

export function renderChat(capture) {
  const label=capture.source==='codex'?'Codex':'ChatGPT';
  const header=`# ${capture.title.replace(/[\r\n]/g,' ')}\n\n来源：${label}\n聊天 ID：${capture.conversationId}\n抓取时间：${capture.capturedAt}\n范围：用户与助手的文字消息\n`;
  const warnings=capture.warnings.length?'\n'+capture.warnings.map(w=>`> ${w.replace(/[\r\n]/g,' ')}`).join('\n')+'\n':'';
  return header+warnings+capture.messages.map((m,i)=>`\n## ${i+1}. ${m.role==='user'?'用户':label}\n\n${m.text}${m.attachments.length?'\n\n'+m.attachments.map(a=>`[附件：${a.type} ${a.name}]`).join('\n'):''}\n`).join('');
}

export async function findCodexExecutable() {
  if(process.env.SIYUAN_CODEX_EXECUTABLE)return process.env.SIYUAN_CODEX_EXECUTABLE;
  if(process.platform==='win32'&&process.env.LOCALAPPDATA) {
    const root=path.join(process.env.LOCALAPPDATA,'OpenAI','Codex','bin');
    const candidates=[];
    for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()) {
      const file=path.join(root,entry.name,'codex.exe');
      const stat=await fs.stat(file).catch(()=>null);if(stat?.isFile())candidates.push({file,mtime:stat.mtimeMs});
    }
    candidates.sort((a,b)=>b.mtime-a.mtime);if(candidates.length)return candidates[0].file;
  }
  return 'codex';
}

// Only initialize and read are allowed. Never resume a thread or start a model turn.
export async function readCodexThread(threadId,{signal,spawnProcess=spawn,executable,timeoutMs=45000}={}) {
  checkId(threadId);if(signal?.aborted)throw new Error('请求已取消。');
  executable??=await findCodexExecutable();
  return new Promise((resolve,reject)=>{
    const child=spawnProcess(executable,['app-server','--listen','stdio://'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env}});
    let settled=false,size=0;
    const lines=readline.createInterface({input:child.stdout});
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);lines.close();child.kill();error?reject(error):resolve(value);};
    const abort=()=>finish(new Error('请求已取消。'));
    const timer=setTimeout(()=>finish(new Error('读取 Codex 完整历史超时；未使用摘要替代。')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    const send=m=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
    child.stdin.on('error',()=>finish(new Error('Codex 历史连接已关闭。')));
    child.stderr.on('data',()=>{}); // Never expose configuration, paths or authentication diagnostics.
    child.stdout.on('data',d=>{size+=Buffer.byteLength(d);if(size>64*1024*1024)finish(new Error('宿主历史响应过大；未截断。'));});
    child.on('error',()=>finish(new Error('找不到可用的 Codex CLI；可通过桌面宿主的 read_thread 分页导入。')));
    child.on('close',()=>finish(new Error('Codex 未返回完整历史；可通过桌面宿主 read_thread 分页导入。')));
    lines.on('line',line=>{
      if(settled||!line.trim())return;
      let m;try{m=JSON.parse(line);}catch{return finish(new Error('Codex 返回无效的历史响应。'));}
      if(m.error&&[1,2].includes(m.id))return finish(new Error('Codex 无法读取这个聊天；请核对当前聊天 ID，或使用宿主分页导入。'));
      if(m.id===1) {send({method:'initialized'});send({id:2,method:'thread/read',params:{threadId,includeTurns:true}});}
      if(m.id===2) {
        if(m.result?.thread?.id!==threadId)return finish(new Error('返回的聊天 ID 与当前窗口不一致。'));
        try{finish(null,fromCodexThread(m.result.thread));}catch(e){finish(e);}
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'siyuan_chat_capture',title:'SiYuan chat capture',version:'1.1.0'},capabilities:{}}});
  });
}

export class ChatCaptures {
  constructor({readThread=readCodexThread,now=Date.now}={}) {this.readThread=readThread;this.now=now;this.snapshots=new Map();this.pages=new Map();}
  prune(){for(const map of [this.snapshots,this.pages])for(const [id,v]of map)if(v.expires<=this.now())map.delete(id);}
  store(value){this.prune();if(this.snapshots.size>=10)throw new Error('聊天快照过多；请重新加载插件清理。');const capture=validateCapture(value),markdown=renderChat(capture),captureId=randomUUID();this.snapshots.set(captureId,{capture,markdown,hash:sha(markdown),expires:this.now()+3600000});return this.describe(captureId);}
  get(id){this.prune();const v=this.snapshots.get(id);if(!v)throw new Error('抓取快照不存在或已过期，请重新抓取。');return v;}
  describe(id){const v=this.get(id);return {captureId:id,source:v.capture.source,conversationId:v.capture.conversationId,title:v.capture.title,messageCount:v.capture.messages.length,totalCharacters:v.markdown.length,hash:v.hash,coverage:v.capture.coverage,warnings:v.capture.warnings};}
  async capture(a,signal) {
    if(a.source==='codex') {if(a.captureFile)throw new Error('Codex 抓取不接收文件路径。');const id=a.threadId;if(!id)throw new Error('需要明确的当前聊天 ID；请通过当前窗口的可信信息取得 threadId，不能使用共享服务启动时的旧 ID。');return this.store(await this.readThread(id,{signal}));}
    if(a.threadId)throw new Error('网页抓取不接收 Codex threadId。');
    if(!a.captureFile||!path.isAbsolute(a.captureFile)||path.extname(a.captureFile).toLowerCase()!=='.json')throw new Error('请先在当前 ChatGPT 网页点击配套扩展，再提供它导出的 JSON 文件绝对路径。');
    let raw;
    try {
      const handle=await fs.open(a.captureFile,'r');
      try {
        const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_CHAT_BYTES)throw new Error();
        const bytes=Buffer.alloc(MAX_CHAT_BYTES+1);let count=0;
        while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}
        if(count>MAX_CHAT_BYTES)throw new Error();raw=bytes.subarray(0,count).toString('utf8');
      }finally{await handle.close();}
    }catch{throw new Error('抓取文件不可读、不是普通文件或超过 8 MiB。');}
    let value;try{value=JSON.parse(raw);}catch{throw new Error('抓取文件不是有效 JSON。');}
    if(value.source!=='chatgpt-web')throw new Error('文件不是网页抓取记录。');
    if(signal?.aborted)throw new Error('请求已取消。');return this.store(value);
  }
  // A desktop host can pass its raw read_thread response without asking a model to rewrite messages.
  ingest({pageJson,requestCursor,captureId}) {
    this.prune();let p;try{p=JSON.parse(pageJson);}catch{throw new Error('宿主分页不是有效 JSON。');}
    if(p.thread?.kind!=='codex'||!Array.isArray(p.turns)||p.page?.order!=='newest_first'||typeof p.page.hasMore!=='boolean')throw new Error('需要 Codex read_thread 的原始分页响应。');
    for(const turn of p.turns)for(const item of turn.items??[]) {
      if(!['userMessage','agentMessage'].includes(item.type))continue;
      const texts=item.type==='agentMessage'?[item.text]:(item.content??[]).filter(c=>c.type==='text').map(c=>c.text);
      if(item.truncated||texts.some(text=>typeof text!=='string'||text.length>=20000||/\[.{0,30}truncated.{0,30}\]/i.test(text)))throw new Error('宿主消息可能被截断；请使用 Codex thread/read 完整历史入口。');
    }
    checkId(p.thread.id);
    let state;
    if(captureId){state=this.pages.get(captureId);if(!state)throw new Error('分页抓取不存在或已过期。');}
    else {if(requestCursor)throw new Error('必须从当前聊天第一页开始。');if(this.pages.size>=10)throw new Error('分页抓取过多。');captureId=randomUUID();state={thread:p.thread,turns:[],nextCursor:null,seen:new Set(),bytes:0,expires:this.now()+3600000};}
    if(state.thread.id!==p.thread.id||state.nextCursor!==(requestCursor??null))throw new Error('聊天 ID 或分页游标不一致；未合并记录。');
    if(p.page.hasMore&&(!p.page.nextCursor||state.seen.has(p.page.nextCursor)))throw new Error('宿主分页游标缺失或重复。');
    if(p.turns.some(t=>state.turns.some(x=>x.id===t.id)))throw new Error('聊天分页有重复的 turn，不能作为完整历史。');
    if(state.bytes+Buffer.byteLength(pageJson)>64*1024*1024)throw new Error('宿主历史过大；未截断。');
    const turns=[...state.turns,...p.turns];
    if(!p.page.hasMore){const result=this.store(fromCodexThread({...state.thread,turns:turns.reverse()}));this.pages.delete(captureId);return {...result,ready:true,nextCursor:null};}
    state.turns=turns;state.bytes+=Buffer.byteLength(pageJson);state.nextCursor=p.page.nextCursor;state.seen.add(state.nextCursor);this.pages.set(captureId,state);
    return {captureId,ready:false,nextCursor:state.nextCursor,turnCount:turns.length,conversationId:state.thread.id};
  }
  read(a){const v=this.get(a.captureId),offset=a.offset??0,limit=a.limit??20000;return {...this.describe(a.captureId),content:v.markdown.slice(offset,offset+limit),offset,nextOffset:offset+limit<v.markdown.length?offset+limit:null};}
}
