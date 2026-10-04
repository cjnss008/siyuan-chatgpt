import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {ChatCaptures, MAX_CHAT_BYTES} from './chat.mjs';

const WINDOWS = fileURLToPath(new URL('./windows.ps1', import.meta.url));
const ID = '^\\d{14}-[a-z0-9]{7}$';
const idSchema = {type:'string', pattern:ID};
const markdown = {type:'string', maxLength:100000};
const object = (properties={}, required=[]) => ({type:'object',properties,required,additionalProperties:false});
const readHint = {readOnlyHint:true, destructiveHint:false, openWorldHint:false};
const writeHint = {readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:false};
const tool = (name,title,description,inputSchema,annotations=readHint) => ({name,title,description,inputSchema,annotations});
export const TOOLS = [
  tool('settings.read','思源连接设置','读取设置和配置入口；不返回 token。',object()),
  tool('settings.update','更新 API 地址','仅更新本机 API 地址；token 通过本机密码输入窗口配置。',object({set:object({apiUrl:{type:'string'}},['apiUrl'])},['set']),{...writeHint,destructiveHint:false,idempotentHint:true}),
  tool('settings.configure','配置地址和 Token','打开 Windows 本机设置窗口，密码输入 token；取消不会保存。',object(),{...writeHint,destructiveHint:false,idempotentHint:true}),
  tool('siyuan_status','检查连接','检查思源连接及鉴权，不写入笔记。',object()),
  tool('siyuan_list_notebooks','列出笔记本','返回笔记本 ID、名称和关闭状态。',object()),
  tool('siyuan_search','搜索笔记和块','字面子串搜索；只读固定 SQL，不接受任意 SQL。按更新时间和 ID 排序，可分页。',object({query:{type:'string',minLength:1,maxLength:500},kind:{type:'string',enum:['all','documents','blocks']},notebook:idSchema,limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0,maximum:10000}},['query'])),
  tool('siyuan_read_block','读取块或文档源码','读取 Kramdown，包括子块；offset/limit 为字符分页。hash 是完整源码 SHA-256。',object({id:idSchema,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100000}},['id'])),
  tool('siyuan_read_document','读取文档 Markdown','通过公开导出 API 读取完整文档 Markdown，支持字符分页。',object({id:idSchema,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100000}},['id'])),
  tool('siyuan_create_document','创建文档','先创建待确认预览，不执行写入；返回的 operationId 交给 siyuan_commit_write。父文档可能自动创建。',object({notebook:idSchema,path:{type:'string',minLength:2,maxLength:1000},markdown},['notebook','path','markdown'])),
  tool('siyuan_append_content','追加内容','先预览在文档或容器末尾插入子块，不执行写入；parentId 必须是文档或容器块。',object({parentId:idSchema,markdown:{...markdown,minLength:1}},['parentId','markdown'])),
  tool('siyuan_update_block','更新块','先预览替换整个块（容器含子块）；expectedHash 可防止覆盖已变化的内容。',object({id:idSchema,markdown,expectedHash:{type:'string',pattern:'^[a-f0-9]{64}$'}},['id','markdown'])),
  tool('siyuan_commit_write','确认并执行写入','默认打开独立 Windows 窗口，全文滚动且按钮固定。confirmationUi=host 使用简短备用表单。只有用户确认才写入；异常不自动重试。',object({operationId:{type:'string',format:'uuid'},confirmationUi:{type:'string',enum:['native','host']}},['operationId']),writeHint),
  tool('siyuan_read_write_preview','读取完整写入预览','分页读取待确认预览，包含原内容和待写入全文。nextOffset 非空时继续；不写入。',object({operationId:{type:'string',format:'uuid'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100000}},['operationId'])),
  tool('siyuan_cancel_write','取消待确认写入','移除预览，不写入思源。',object({operationId:{type:'string',format:'uuid'}},['operationId']),{...writeHint,destructiveHint:false,idempotentHint:true}),
  tool('siyuan_configure','打开思源连接配置','通过插件本地进程打开 Windows 配置窗口；API 地址下方是 Token 密码框。不要在聊天中发送 Token。取消不会保存。',object(),{...writeHint,destructiveHint:false}),
  tool('siyuan_capture_current_chat','抓取当前聊天记录','Codex：使用可信的当前 threadId 读取完整持久化历史，不能猜测最近聊天。网页：导入当前 ChatGPT 页面配套扩展导出的 JSON；不读取其他窗口。返回不可变快照，不写入思源。',object({source:{type:'string',enum:['codex','chatgpt-web']},threadId:{type:'string',minLength:8,maxLength:100},captureFile:{type:'string',maxLength:2000}},['source'])),
  tool('siyuan_ingest_chat_page','导入宿主聊天原始分页','Codex CLI 不可用时，将 read_thread 当前聊天的原始响应直接传入 pageJson，不能重写消息。第一页不传 captureId/requestCursor；之后使用返回游标，直到 ready=true。不是模型总结。',object({pageJson:{type:'string',maxLength:1500000},captureId:{type:'string',format:'uuid'},requestCursor:{type:'string',maxLength:20000}},['pageJson'])),
  tool('siyuan_read_captured_chat','读取抓取快照','分页读取抓取后的完整文字快照用于检查或总结；hash 对应完整 Markdown。nextOffset 非空时继续读取。',object({captureId:{type:'string',format:'uuid'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100000}},['captureId'])),
  tool('siyuan_save_captured_chat','保存聊天原文或摘要预览','original 直接用不可变快照生成思源预览，不经模型重写。summary 用读完快照后生成的 summaryMarkdown。新建传 notebook/path，追加传 parentId；必须再调用 siyuan_commit_write 由用户确认。',object({captureId:{type:'string',format:'uuid'},mode:{type:'string',enum:['original','summary']},summaryMarkdown:{type:'string',minLength:1,maxLength:100000},notebook:idSchema,path:{type:'string',minLength:2,maxLength:1000},parentId:idSchema},['captureId','mode']))
];
TOOLS[0].outputSchema = object({schema:{type:'object'},values:{type:'object'},layout:{type:'array',items:{type:'object'}}},['schema','values']);
TOOLS[1].outputSchema = object({values:{type:'object'}},['values']);
// Settings controls are user-facing, not instructions to send a secret through chat.
for (const t of TOOLS.slice(0,3)) t._meta = {ui:{visibility:['app']}};

export function validate(schema, value, label='arguments') {
  const bad = () => {throw new Error(`参数无效：${label}`);};
  if (schema.type==='object') {
    if (!value || typeof value!=='object' || Array.isArray(value)) bad();
    for (const key of schema.required??[]) if (!(key in value)) bad();
    for (const [key,v] of Object.entries(value)) {
      if (!(key in schema.properties)) {if (schema.additionalProperties===false) bad(); continue;}
      validate(schema.properties[key],v,`${label}.${key}`);
    }
  } else if (schema.type==='string') {
    if (typeof value!=='string') bad();
    if (schema.minLength!==undefined && value.length<schema.minLength) bad();
    if (schema.maxLength!==undefined && value.length>schema.maxLength) bad();
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) bad();
    if (schema.format==='uuid' && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) bad();
  } else if (schema.type==='integer') {
    if (!Number.isSafeInteger(value)) bad();
    if (schema.minimum!==undefined && value<schema.minimum) bad();
    if (schema.maximum!==undefined && value>schema.maximum) bad();
  }
  if (schema.enum && !schema.enum.includes(value)) bad();
}
export function normalizeUrl(value) {
  const u = new URL(value);
  if (!['http:','https:'].includes(u.protocol) || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname!=='/') throw new Error('仅支持本机地址，例如 http://127.0.0.1:6806；不能含用户名、查询或路径。');
  return u.origin;
}
export function windows(mode,data,timeout=300000,{signal,spawnProcess=spawn,platform=process.platform}={}) {
  if (platform!=='win32') return Promise.reject(new Error('此版本需要 Windows 桌面。'));
  if (!['protect','unprotect','configure','confirm'].includes(mode)) return Promise.reject(new Error('无效的 Windows 辅助操作。'));
  if (signal?.aborted) return Promise.reject(new Error('请求已取消。'));
  return new Promise((resolve,reject)=>{
    const interactive=mode==='configure'||mode==='confirm';
    const args=['-NoProfile',...(interactive?['-WindowStyle','Normal']:['-NonInteractive']),'-STA','-ExecutionPolicy','Bypass','-File',WINDOWS,'-Mode',mode];
    // Native dialogs must run visibly in the MCP host's desktop session.
    // Only the background DPAPI helpers should inherit a hidden window.
    const child=spawnProcess('powershell.exe',args,{windowsHide:!interactive,stdio:['pipe','pipe','pipe']});
    let out='',err='',settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
    const abort=()=>{child.kill();finish(new Error('请求已取消。'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error(mode==='confirm'?'本机确认窗口已超时，本次未写入。请重新准备预览。':interactive?'本机窗口已超时；请通过插件配置入口重试，未批准保存或写入。':'Windows 加密操作超时。'));},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    child.stdout.setEncoding('utf8');child.stdout.on('data',d=>out+=d);
    child.stderr.on('data',d=>err+=d);
    child.on('error',()=>finish(new Error('无法启动 Windows 本机设置或确认窗口。')));
    child.on('close',code=>{if(code!==0) finish(new Error((mode==='protect'||mode==='unprotect') && /data protection operation was unsuccessful|CryptographicException/.test(err)?'Windows DPAPI 在当前进程的用户配置中不可用；请在正常 Windows 桌面用户会话运行。':'Windows 配置或加密操作失败。'));else finish(null,out);});
    // Values go over stdin, never shell interpolation or process arguments.
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(data));
  });
}
export class Config {
  constructor(dir=process.env.SIYUAN_PLUGIN_CONFIG_DIR ?? path.join(process.env.LOCALAPPDATA??os.homedir(),'SiYuanChatGPT'),{runWindows=windows}={}) {this.dir=dir;this.file=path.join(dir,'settings.json');this.revision=0;this.runWindows=runWindows;}
  async load() {
    let c;
    try {c=JSON.parse(await fs.readFile(this.file,'utf8'));} catch(e) {if(e.code!=='ENOENT') throw new Error('本机配置损坏或不可读，请打开配置窗口重新保存。');c={};}
    return {apiUrl:normalizeUrl(c.apiUrl??'http://127.0.0.1:6806'),tokenCipher:c.tokenCipher??''};
  }
  async save(c) {
    c.apiUrl=normalizeUrl(c.apiUrl);
    await fs.mkdir(this.dir,{recursive:true});
    const tmp=path.join(this.dir,`${randomUUID()}.tmp`);
    await fs.writeFile(tmp,JSON.stringify(c,null,2),'utf8');
    await fs.rename(tmp,this.file);this.revision++;
  }
  async session() {
    const c=await this.load();
    return {...c,token:c.tokenCipher?await windows('unprotect',{cipher:c.tokenCipher},10000):''};
  }
  async configure(signal) {
    const c=await this.load();
    const next=JSON.parse(await this.runWindows('configure',{apiUrl:c.apiUrl},300000,{signal}));
    if(signal?.aborted)throw new Error('请求已取消。');
    if (!next.accepted) return {saved:false};
    await this.save({apiUrl:next.apiUrl,tokenCipher:next.clearToken?'':next.tokenCipher||c.tokenCipher});
    return {saved:true,apiUrl:normalizeUrl(next.apiUrl),tokenConfigured:!next.clearToken && !!(next.tokenCipher||c.tokenCipher)};
  }
}
export class Api {
  constructor(config) {this.config=config;}
  async session() {return this.config.session();}
  async post(endpoint,body={},session) {
    session??=await this.session();
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    try {
      const r=await fetch(session.apiUrl+endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(session.token?{Authorization:`Token ${session.token}`}:{})},body:JSON.stringify(body),redirect:'error',signal:controller.signal});
      if (!r.ok) throw new Error(r.status===401||r.status===403?'鉴权失败，请检查 API token。':`思源返回 HTTP ${r.status}。`);
      const reader=r.body.getReader();let chunks=[],size=0;
      while (true) {const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>16*1024*1024){controller.abort();throw new Error('思源响应超过 16 MiB 限制。');}chunks.push(value);}
      let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('思源未返回有效 JSON。');}
      if (result.code!==0) throw new Error(`思源 API 报告错误（code ${Number.isFinite(result.code)?result.code:'unknown'}）。`);
      return result.data;
    } catch(e) {
      if (e.name==='AbortError' || e.name==='TypeError') throw new Error('无法连接思源或请求超时；请检查地址、token，并保持思源运行。写请求可能已生效，请先读取核对，勿直接重试。');
      throw e;
    } finally {clearTimeout(timer);}
  }
}
const hash=text=>createHash('sha256').update(text).digest('hex');
const quote=s=>`'${s.replaceAll("'","''")}'`;
function page(text,a) {const offset=a.offset??0,limit=a.limit??20000;return {content:text.slice(offset,offset+limit),offset,totalCharacters:text.length,nextOffset:offset+limit<text.length?offset+limit:null,hash:hash(text)};}
function kramdown(data) {if(typeof data?.kramdown!=='string')throw new Error('思源未返回块源码。');return data.kramdown;}
function documentPath(p) {if(!p.startsWith('/') || p.endsWith('/') || p.includes('\\') || /[\u0000-\u001f]/.test(p) || p.split('/').slice(1).some(s=>!s.trim() || ['.','..'].includes(s))) throw new Error('文档路径必须以 / 开头，每层非空，不能含 .、..、反斜线或控制字符。');return p;}

export class Service {
  constructor({config=new Config(),api,confirm,now=Date.now,chatCaptures,runWindows=windows}={}) {this.config=config;this.api=api??new Api(config);this.confirm=confirm??(async(message,{signal}={})=>JSON.parse(await runWindows('confirm',{message},120000,{signal})).accepted===true);this.now=now;this.chats=chatCaptures??new ChatCaptures({now});this.pending=new Map();this.busy=false;this.configuring=false;}
  async settings() {
    const c=await this.config.load();
    return {schema:{type:'object',properties:{apiUrl:{type:'string',title:'思源 API 地址',description:'仅限本机回环地址，默认 http://127.0.0.1:6806'}}},values:{apiUrl:c.apiUrl},layout:[{kind:'group',title:c.tokenCipher?'思源连接（Token 已保存）':'思源连接（Token 未配置）',items:[{kind:'property',property:'apiUrl'},{kind:'tool',tool:'settings.configure',title:'配置地址和 API Token…',description:'在本机密码输入框填写 token，不在聊天中发送。'},{kind:'tool',tool:'siyuan_status',title:'测试连接'}]}]};
  }
  async call(name,a={},signal) {
    const t=TOOLS.find(t=>t.name===name);if(!t)throw new Error('未知工具。');validate(t.inputSchema,a);
    if(name==='siyuan_capture_current_chat')return this.chats.capture(a,signal);
    if(name==='siyuan_ingest_chat_page')return this.chats.ingest(a);
    if(name==='siyuan_read_captured_chat')return this.chats.read(a);
    if(name==='siyuan_save_captured_chat') {
      const snapshot=this.chats.get(a.captureId);
      if(snapshot.capture.coverage==='page-text-unverified')throw new Error('网页记录尚未核对首尾，请在扩展中核对后重新导出。');
      if(a.mode==='original'&&a.summaryMarkdown!==undefined)throw new Error('保存原文不接收模型改写内容。');
      if(a.mode==='summary'&&!a.summaryMarkdown)throw new Error('摘要模式需要 summaryMarkdown。');
      if(a.parentId?(a.notebook!==undefined||a.path!==undefined):(!a.notebook||!a.path))throw new Error('请明确新建 notebook/path 或追加 parentId，两者不能混用。');
      const text=a.mode==='original'?snapshot.markdown:`# ${snapshot.capture.title.replace(/[\r\n]/g,' ')}（摘要）\n\n来源：${snapshot.capture.source}\n聊天 ID：${snapshot.capture.conversationId}\n原文 SHA-256：${snapshot.hash}\n抓取时间：${snapshot.capture.capturedAt}\n\n${snapshot.capture.warnings.map(w=>'> '+w).join('\n')}\n\n${a.summaryMarkdown}`;
      if(Buffer.byteLength(text)>MAX_CHAT_BYTES)throw new Error('待保存记录超过 8 MiB；未截断，请分段保存。');
      const result=await this.prepare(a.parentId?'siyuan_append_content':'siyuan_create_document',a.parentId?{parentId:a.parentId,markdown:text}:{notebook:a.notebook,path:a.path,markdown:text});
      return {...result,captureId:a.captureId,mode:a.mode,sourceHash:snapshot.hash,messageCount:snapshot.capture.messages.length};
    }
    if(name==='settings.read')return this.settings();
    if(name==='settings.update') {if(this.busy)throw new Error('写入确认期间无法修改连接。');const c=await this.config.load();await this.config.save({...c,...a.set});this.pending.clear();return {values:{apiUrl:normalizeUrl(a.set.apiUrl)}};}
    if(name==='settings.configure'||name==='siyuan_configure') {
      if(this.busy)throw new Error('写入确认期间无法修改连接。');
      if(this.configuring)throw new Error('配置窗口已打开，请完成或取消当前窗口。');
      this.configuring=true;
      try {const r=await this.config.configure(signal);if(r.saved)this.pending.clear();return r;}
      finally {this.configuring=false;}
    }
    if(name==='siyuan_status') {const c=await this.config.load();const d=await this.api.post('/api/notebook/lsNotebooks');return {connected:true,apiUrl:c.apiUrl,tokenConfigured:!!c.tokenCipher,notebookCount:d?.notebooks?.length??0};}
    if(name==='siyuan_list_notebooks')return {notebooks:(await this.api.post('/api/notebook/lsNotebooks'))?.notebooks??[]};
    if(name==='siyuan_search') {
      const filters=[`(instr(content, ${quote(a.query)}) > 0 OR instr(hpath, ${quote(a.query)}) > 0)`];
      if(a.kind==='documents')filters.push("type = 'd'");if(a.kind==='blocks')filters.push("type != 'd'");if(a.notebook)filters.push(`box = ${quote(a.notebook)}`);
      const limit=a.limit??30,offset=a.offset??0;
      const stmt=`SELECT id, root_id, box, hpath, type, substr(content,1,1000) AS content, updated FROM blocks WHERE ${filters.join(' AND ')} ORDER BY updated DESC, id ASC LIMIT ${limit} OFFSET ${offset}`;
      const rows=await this.api.post('/api/query/sql',{stmt});if(!Array.isArray(rows))throw new Error('思源未返回搜索结果列表。');
      return {results:rows.map(r=>({...r,url:`siyuan://blocks/${r.id}`})),limit,offset,nextOffset:rows.length===limit?offset+limit:null,indexMayLag:true};
    }
    if(name==='siyuan_read_block') {const d=await this.api.post('/api/block/getBlockKramdown',{id:a.id});return {id:a.id,format:'kramdown',...page(kramdown(d),a),url:`siyuan://blocks/${a.id}`};}
    if(name==='siyuan_read_document') {const d=await this.api.post('/api/export/exportMdContent',{id:a.id});if(typeof d?.content!=='string')throw new Error('思源未返回文档 Markdown。');return {id:a.id,hPath:d.hPath,format:'markdown',...page(d.content,a),url:`siyuan://blocks/${a.id}`};}
    if(name==='siyuan_cancel_write') {return {cancelled:this.pending.delete(a.operationId)};}
    if(name==='siyuan_read_write_preview') {
      const p=this.pending.get(a.operationId);if(!p||p.expiresAt<=this.now())throw new Error('预览不存在、已使用或已过期，请重新准备。');
      return {operationId:a.operationId,...page(p.message,a)};
    }
    if(name==='siyuan_commit_write')return this.commit(a.operationId,signal,a.confirmationUi??'native');
    return this.prepare(name,a);
  }
  async prepare(name,a) {
    for(const [id,p]of this.pending)if(p.expiresAt<=this.now())this.pending.delete(id);
    if(this.pending.size>=30)throw new Error('待确认预览过多，请先取消或执行。');
    const session=await this.api.session();
    const connection=hash(JSON.stringify({apiUrl:session.apiUrl,token:session.token}));
    let endpoint,body,before=null,target;
    if(name==='siyuan_create_document') {
      documentPath(a.path);
      const notebooks=(await this.api.post('/api/notebook/lsNotebooks',{},session))?.notebooks??[];
      const n=notebooks.find(n=>n.id===a.notebook);if(!n || n.closed)throw new Error('目标笔记本不存在或未打开。');
      endpoint='/api/filetree/createDocWithMd';body={notebook:a.notebook,path:a.path,markdown:a.markdown};target=`笔记本：${n.name} (${a.notebook})\n路径：${a.path}\n不存在的父文档也可能自动创建。`;
    } else {
      const id=a.id??a.parentId;
      before=kramdown(await this.api.post('/api/block/getBlockKramdown',{id},session));
      const hPath=await this.api.post('/api/filetree/getHPathByID',{id},session);
      target=`目标：${hPath}\n块 ID：${id}`;
      if(name==='siyuan_update_block') {
        if(a.expectedHash && a.expectedHash!==hash(before))throw new Error('块已变化，请重新读取后编辑。');
        endpoint='/api/block/updateBlock';body={id,dataType:'markdown',data:a.markdown};
      } else if(name==='siyuan_append_content') {
        const rows=await this.api.post('/api/query/sql',{stmt:`SELECT type FROM blocks WHERE id = ${quote(id)} LIMIT 1`},session);
        if(!['d','l','i','b','s'].includes(rows?.[0]?.type))throw new Error('追加目标必须是文档或容器块；请使用文档 root_id。');
        endpoint='/api/block/appendBlock';body={parentID:id,dataType:'markdown',data:a.markdown};
      } else throw new Error('未知写入操作。');
    }
    const operationId=randomUUID(),expiresAt=this.now()+600000;
    const action={'siyuan_create_document':'创建文档','siyuan_append_content':'追加内容','siyuan_update_block':'替换块（容器的子块也可能被替换）'}[name];
    const message=`思源笔记写入确认\n操作：${action}\nAPI：${session.apiUrl}\n${target}\n\n${before!==null?`原内容（完整）：\n${before}\n\n`:''}待写入内容（完整）：\n${a.markdown}\n\n仅点击 Confirm 或确认复选框才执行；取消不会写入。`;
    const boundedTarget=target.length>1200?target.slice(0,850)+'\n…（完整路径见独立窗口或完整预览）…\n'+target.slice(-300):target;
    const excerpt=a.markdown.length>240?a.markdown.slice(0,120)+'\n…（正文省略）…\n'+a.markdown.slice(-120):a.markdown;
    const summary=`思源笔记写入确认\n操作：${action}\nAPI：${session.apiUrl}\n${boundedTarget}\n\n待写入：${a.markdown.length} 字符\nSHA-256：${hash(a.markdown)}\n${before!==null?'将替换/追加到已预览的目标内容；完整原内容见预览。\n':''}\n正文节选：\n${excerpt}\n\n独立窗口提供可滚动全文，按钮固定在底部。宿主备用表单只显示摘要；完整内容可由 siyuan_read_write_preview 分页核对。仅用户确认才写入；取消不会写入。`;
    this.pending.set(operationId,{operationId,expiresAt,connection,endpoint,body,before,message,summary});
    const previewTruncated=message.length>4000;
    return {status:'awaiting_confirmation',operationId,expiresAt:new Date(expiresAt).toISOString(),preview:previewTruncated?summary:message,previewTruncated,previewCharacters:message.length,contentCharacters:a.markdown.length,contentHash:hash(a.markdown),confirmationUi:'native',fullPreviewTool:'siyuan_read_write_preview'};
  }
  async commit(id,signal,ui='native') {
    const p=this.pending.get(id);if(!p || p.expiresAt<=this.now()){this.pending.delete(id);throw new Error('预览不存在、已使用或已过期，请重新准备。');}
    if(this.busy)throw new Error('已有写入正在等待用户确认，请稍后再试。');
    this.busy=true;this.pending.delete(id); // Single-use even if cancelled or the network result is uncertain.
    try {
      const session=await this.api.session();
      if(hash(JSON.stringify({apiUrl:session.apiUrl,token:session.token}))!==p.connection)throw new Error('连接设置已变化，请重新准备预览。');
      if(signal?.aborted)throw new Error('请求已取消，本次未写入。');
      if(await this.confirm(p.message,{ui,summary:p.summary,signal})!==true)return {status:'cancelled',written:false};
      if(signal?.aborted)throw new Error('请求已取消，本次未写入。');
      if(p.expiresAt<=this.now())throw new Error('确认时预览已过期，请重新准备。');
      const latest=await this.api.session();
      if(hash(JSON.stringify({apiUrl:latest.apiUrl,token:latest.token}))!==p.connection)throw new Error('确认期间连接已变化，请重新准备。');
      if(p.before!==null) {
        const current=kramdown(await this.api.post('/api/block/getBlockKramdown',{id:p.body.id??p.body.parentID},session));
        if(hash(current)!==hash(p.before))throw new Error('确认期间目标内容已变化，本次未写入。请重新读取并准备预览。');
      }
      if(signal?.aborted)throw new Error('请求已取消，本次未写入。');
      const data=await this.api.post(p.endpoint,p.body,session);
      return {status:'completed',written:true,data,verification:'通过读块核对实际结果；搜索索引可能延迟。'};
    } finally {this.busy=false;}
  }
}
