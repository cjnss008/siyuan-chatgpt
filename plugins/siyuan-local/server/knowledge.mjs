import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const hash=s=>createHash('sha256').update(s).digest('hex');
const quote=s=>`'${s.replaceAll("'","''")}'`;
const idPattern=/^\d{14}-[a-z0-9]{7}$/;
const uuidPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const identity=s=>hash(JSON.stringify({apiUrl:s.apiUrl,token:s.token}));
const checkAbort=signal=>{if(signal?.aborted)throw new Error('请求已取消。');};
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const id={type:'string',pattern:idPattern.source};
const jobId={type:'string',format:'uuid'};
const text={type:'string',minLength:1,maxLength:1500};
const pagination={offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:100}};
const localWrite={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
const read={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
const tool=(name,title,description,inputSchema,annotations=read)=>({name,title,description,inputSchema,annotations});
export const KNOWLEDGE_TOOLS=[
 tool('siyuan_list_documents','文档清单与引用数量','固定只读查询，分页返回文档标题、路径、更新时间、原有入链出链数。零引用只表示没有显式块引用，不表示内容无关。',object({notebook:id,...pagination})),
 tool('siyuan_list_references','查询双向块引用','按块或整篇文档查询入链、出链或两者；返回来源与被引块的 ID 和原文位置，支持分页。',object({id,direction:{type:'string',enum:['incoming','outgoing','both']},scope:{type:'string',enum:['block','document']},...pagination},['id'])),
 tool('siyuan_start_knowledge_job','建立知识地图处理清单','盘点指定笔记本，保存仅本机的清单和分层进度；不修改思源笔记，不把获取全文标为已精读。最多一万篇，超限报错。',object({notebook:id,title:{type:'string',minLength:1,maxLength:100}},['notebook','title']),localWrite),
 tool('siyuan_read_knowledge_job','读取知识地图进度','分页读取持久清单、全文获取状态、模型记录的分析、证据和写入日志。重启后按同一 jobId 继续，不自动重试未知写入。',object({jobId,...pagination},['jobId'])),
 tool('siyuan_read_knowledge_source','分页读取带版本的原文','读取清单内文档的完整 Kramdown，保留块 ID；分页响应被全部取到后才允许记录分析。原文变化会清除旧分析，返回完整源码 hash。',object({jobId,id,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100000}},['jobId','id']),localWrite),
 tool('siyuan_record_knowledge_analysis','记录有证据的分析进度','仅保存本机处理进度；模型归纳需给出当前 sourceHash、主题、摘要和最多四条原文证据。逐条核对证据块所属文档和逐字片段；不声称模型推断已经外部验证。索引与观点分析是不同状态。',object({jobId,entries:{type:'array',minItems:1,maxItems:10,items:object({id,sourceHash:{type:'string',pattern:'^[a-f0-9]{64}$'},stage:{type:'string',enum:['indexed','analyzed']},topics:{type:'array',minItems:1,maxItems:12,items:{type:'string',minLength:1,maxLength:100}},summary:text,evidence:{type:'array',minItems:1,maxItems:4,items:object({blockId:id,quote:{type:'string',minLength:1,maxLength:500}},['blockId','quote'])}},['id','sourceHash','stage','topics','summary','evidence'])}},['jobId','entries']),localWrite),
 tool('siyuan_prepare_document_batch','批量创建知识文档预览','仅预览：同一笔记本最多 50 篇新文档、合计 500000 字符；既有路径一律停止，避免重复和覆盖。用 siyuan_commit_write 一次原生确认后依次创建，记录已创建和未知结果；不是事务，不自动重试。可关联本机知识任务。',object({notebook:id,jobId,documents:{type:'array',minItems:1,maxItems:50,items:object({path:{type:'string',minLength:2,maxLength:1000},markdown:{type:'string',maxLength:100000}},['path','markdown'])}},['notebook','documents']),{...localWrite,destructiveHint:true}),
];

export function documentPath(p){if(!p.startsWith('/')||p.endsWith('/')||p.includes('\\')||/[\u0000-\u001f]/.test(p)||p.split('/').slice(1).some(s=>!s.trim()||['.','..'].includes(s)))throw new Error('文档路径无效。');return p;}
const rows=data=>{if(!Array.isArray(data))throw new Error('思源未返回有效列表。');return data;};
export function mergeRanges(ranges,start,end){const sorted=[...ranges,[start,end]].sort((a,b)=>a[0]-b[0]),out=[];for(const r of sorted){const last=out.at(-1);if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else out.push([...r]);}return out;}

export class Knowledge {
 constructor({service,dir}){this.service=service;this.dir=dir;this.busy=new Set();}
 async locked(id,fn){if(this.busy.has(id))throw new Error('同一知识任务正在处理，请稍后继续。');this.busy.add(id);try{return await fn();}finally{this.busy.delete(id);}}
 filename(id){if(!uuidPattern.test(id))throw new Error('任务 ID 无效。');return path.join(this.dir,`${id}.json`);}
 async save(job){await fs.mkdir(this.dir,{recursive:true});const file=this.filename(job.id),tmp=path.join(this.dir,`${randomUUID()}.tmp`);await fs.writeFile(tmp,JSON.stringify(job),'utf8');await fs.rename(tmp,file);}
 async load(id,session){let job;try{const raw=await fs.readFile(this.filename(id),'utf8');if(Buffer.byteLength(raw)>32*1024*1024)throw new Error();job=JSON.parse(raw);}catch{throw new Error('本机知识任务不存在或不可读。');}if(job.id!==id||job.version!==1||!Array.isArray(job.documents)||!Array.isArray(job.outputs))throw new Error('本机知识任务无效。');if(job.connection!==identity(session))throw new Error('任务的思源连接已经变化，不能跨连接沿用进度。');return job;}
 async inventory(a,session){
  const limit=a.limit??100,offset=a.offset??0;
  const filter=`b.type = 'd'${a.notebook?` AND b.box = ${quote(a.notebook)}`:''}`;
  const stmt=`SELECT b.id, b.box, b.hpath, b.content AS title, b.updated, (SELECT count(*) FROM refs r WHERE r.def_block_root_id = b.id) AS incoming, (SELECT count(*) FROM refs r WHERE r.root_id = b.id) AS outgoing FROM blocks b WHERE ${filter} ORDER BY b.id ASC LIMIT ${limit} OFFSET ${offset}`;
  const data=rows(await this.service.api.post('/api/query/sql',{stmt},session));
  return {documents:data.map(d=>({...d,url:`siyuan://blocks/${d.id}`})),offset,limit,nextOffset:data.length===limit?offset+limit:null,indexMayLag:true};
 }
 async references(a,session){
  const direction=a.direction??'both',scope=a.scope??'document',limit=a.limit??100,offset=a.offset??0;
  const incoming=`r.${scope==='document'?'def_block_root_id':'def_block_id'} = ${quote(a.id)}`;
  const outgoing=`r.${scope==='document'?'root_id':'block_id'} = ${quote(a.id)}`;
  const filter=direction==='incoming'?incoming:direction==='outgoing'?outgoing:`(${incoming} OR ${outgoing})`;
  const stmt=`SELECT r.id, r.block_id AS sourceBlockId, r.root_id AS sourceDocumentId, r.def_block_id AS targetBlockId, r.def_block_root_id AS targetDocumentId, r.content, s.hpath AS sourcePath, t.hpath AS targetPath FROM refs r LEFT JOIN blocks s ON s.id = r.block_id LEFT JOIN blocks t ON t.id = r.def_block_id WHERE ${filter} ORDER BY r.id ASC LIMIT ${limit} OFFSET ${offset}`;
  const data=rows(await this.service.api.post('/api/query/sql',{stmt},session));
  return {references:data.map(r=>({...r,sourceUrl:`siyuan://blocks/${r.sourceBlockId}`,targetUrl:`siyuan://blocks/${r.targetBlockId}`})),direction,scope,offset,limit,nextOffset:data.length===limit?offset+limit:null,indexMayLag:true};
 }
 async call(name,a,signal){
  const session=await this.service.api.session();checkAbort(signal);
  if(name==='siyuan_list_documents')return this.inventory(a,session);
  if(name==='siyuan_list_references')return this.references(a,session);
  if(name==='siyuan_prepare_document_batch')return this.prepareBatch(a,session,signal);
  if(name==='siyuan_start_knowledge_job'){
   const notebooks=(await this.service.api.post('/api/notebook/lsNotebooks',{},session))?.notebooks??[];
   if(!notebooks.some(n=>n.id===a.notebook&&!n.closed))throw new Error('笔记本不存在或未打开。');
   let documents=[],offset=0;
   while(true){checkAbort(signal);const p=await this.inventory({notebook:a.notebook,offset,limit:100},session);documents.push(...p.documents);if(documents.length>10000)throw new Error('清单超过一万篇，未保存不完整任务。');if(p.nextOffset===null)break;offset=p.nextOffset;}
   if(new Set(documents.map(d=>d.id)).size!==documents.length)throw new Error('盘点时清单发生变化，请重新盘点。');
   const job={id:randomUUID(),version:1,title:a.title,notebook:a.notebook,createdAt:new Date(this.service.now()).toISOString(),connection:identity(session),documents:documents.map(d=>({...d,stage:'inventoried'})),outputs:[]};
   checkAbort(signal);await this.save(job);return {jobId:job.id,documentCount:documents.length,stored:'local-only',stage:'inventoried',notice:'清单来自当前索引，不是全文精读。使用 jobId 续读和记录进度。'};
  }
  return this.locked(a.jobId,async()=>{
   const job=await this.load(a.jobId,session);
   if(name==='siyuan_read_knowledge_job'){
    const offset=a.offset??0,limit=a.limit??50;
    return {jobId:job.id,title:job.title,notebook:job.notebook,total:job.documents.length,counts:job.documents.reduce((c,d)=>(c[d.stage]=(c[d.stage]??0)+1,c),{}),documents:job.documents.slice(offset,offset+limit),offset,nextOffset:offset+limit<job.documents.length?offset+limit:null,outputs:job.outputs,notice:'fetched 是程序取得源码；analyzed 是模型已记录分析，并非外部事实核验。'};
   }
   if(name==='siyuan_read_knowledge_source'){
    const d=job.documents.find(d=>d.id===a.id);if(!d)throw new Error('文档不在本任务中。');
    const source=await this.service.api.post('/api/block/getBlockKramdown',{id:a.id},session);
    if(typeof source?.kramdown!=='string')throw new Error('原文不可读。');
    const sourceHash=hash(source.kramdown),offset=a.offset??0,limit=a.limit??20000,end=Math.min(source.kramdown.length,offset+limit);
    if(offset>source.kramdown.length)throw new Error('分页起点超出原文。');
    if(d.sourceHash!==sourceHash){delete d.analysis;d.sourceHash=sourceHash;d.ranges=[];d.stage='inventoried';}
    d.ranges=mergeRanges(d.ranges??[],offset,end);d.totalCharacters=source.kramdown.length;
    const fetchedAll=d.ranges[0]?.[0]===0&&d.ranges[0]?.[1]===source.kramdown.length;
    if(fetchedAll&&d.stage==='inventoried')d.stage='fetched';checkAbort(signal);await this.save(job);
    return {id:a.id,jobId:job.id,format:'kramdown',content:source.kramdown.slice(offset,end),offset,totalCharacters:source.kramdown.length,nextOffset:end<source.kramdown.length?end:null,hash:sourceHash,fetchedAll,stage:d.stage,url:`siyuan://blocks/${a.id}`};
   }
   if(name==='siyuan_record_knowledge_analysis'){
    if(new Set(a.entries.map(e=>e.id)).size!==a.entries.length)throw new Error('本次分析存在重复文档。');
    const staged=[];
    for(const entry of a.entries){
     checkAbort(signal);const d=job.documents.find(d=>d.id===entry.id);
     if(!d||!['fetched','indexed','analyzed'].includes(d.stage)||d.sourceHash!==entry.sourceHash)throw new Error('需先取得所有原文分页，并使用当前 hash。');
     const current=await this.service.api.post('/api/block/getBlockKramdown',{id:d.id},session);
     if(typeof current?.kramdown!=='string'||hash(current.kramdown)!==entry.sourceHash)throw new Error('原文已变化，请重新读取并分析；本次未记录。');
     for(const evidence of entry.evidence){
      const owner=rows(await this.service.api.post('/api/query/sql',{stmt:`SELECT id, root_id FROM blocks WHERE id = ${quote(evidence.blockId)} LIMIT 1`},session));
      if(owner[0]?.id!==evidence.blockId||(owner[0]?.root_id!==d.id&&evidence.blockId!==d.id))throw new Error('证据块不属于该文档。');
      const proof=evidence.blockId===d.id?current:await this.service.api.post('/api/block/getBlockKramdown',{id:evidence.blockId},session);
      if(typeof proof?.kramdown!=='string'||!proof.kramdown.includes(evidence.quote))throw new Error('证据必须是原文中的逐字片段。');
     }
     staged.push([d,{stage:entry.stage,analysis:{sourceHash:entry.sourceHash,topics:entry.topics,summary:entry.summary,evidence:entry.evidence,recordedAt:new Date(this.service.now()).toISOString(),origin:'model',factVerification:'not-external-verified'}}]);
    }
    checkAbort(signal);for(const [d,fields]of staged)Object.assign(d,fields);await this.save(job);
    return {jobId:job.id,recorded:staged.length,stored:'local-only',notice:'已核对片段与当前原文；观点和关系仍由模型归纳。'};
   }
   throw new Error('未知知识工具。');
  });
 }
 async pathsFree(documents,notebook,session){for(const d of documents){const existing=rows(await this.service.api.post('/api/filetree/getIDsByHPath',{notebook,path:d.path},session));if(existing.length)throw new Error(`路径已有文档：${d.path}。先读取核对，不重复创建。`);}}
 async prepareBatch(a,session,signal){
  const service=this.service;
  for(const [id,p]of service.pending)if(p.expiresAt<=service.now())service.pending.delete(id);
  if(service.pending.size>=30)throw new Error('待确认预览过多。');
  if(a.documents.reduce((n,d)=>n+d.markdown.length,0)>500000)throw new Error('批量正文超过 500000 字符，未截断。');
  for(const d of a.documents)documentPath(d.path);
  if(new Set(a.documents.map(d=>d.path)).size!==a.documents.length)throw new Error('批次含重复路径。');
  const notebooks=(await service.api.post('/api/notebook/lsNotebooks',{},session))?.notebooks??[];
  const n=notebooks.find(n=>n.id===a.notebook&&!n.closed);if(!n)throw new Error('笔记本不存在或未打开。');
  if(a.jobId){const job=await this.load(a.jobId,session);if(job.notebook!==a.notebook)throw new Error('批次笔记本与任务不一致。');}
  await this.pathsFree(a.documents,a.notebook,session);checkAbort(signal);
  const operationId=randomUUID(),expiresAt=service.now()+600000;
  const header=`思源笔记批量写入确认\nAPI：${session.apiUrl}\n笔记本：${n.name} (${n.id})\n新建：${a.documents.length} 篇\n不覆盖原文；缺失父文档可能自动创建。\n批次不是事务，中断会保留已创建文档；不自动重试。`;
  const message=header+'\n\n'+a.documents.map((d,i)=>`【${i+1}】路径：${d.path}\nSHA-256：${hash(d.markdown)}\n待写入全文：\n${d.markdown}`).join('\n\n');
  const summary=header+`\n总字符：${a.documents.reduce((n,d)=>n+d.markdown.length,0)}\n全文预览：siyuan_read_write_preview\n前 5 个路径：\n${a.documents.slice(0,5).map(d=>d.path.slice(0,150)).join('\n')}\n仅用户确认才写入。`;
  service.pending.set(operationId,{operationId,expiresAt,connection:identity(session),batch:true,notebook:a.notebook,jobId:a.jobId,documents:structuredClone(a.documents),message,summary,before:null,images:[]});
  return {status:'awaiting_confirmation',operationId,expiresAt:new Date(expiresAt).toISOString(),documentCount:a.documents.length,preview:message.length>4000?summary:message,previewTruncated:message.length>4000,previewCharacters:message.length,confirmationUi:'native',fullPreviewTool:'siyuan_read_write_preview'};
 }
 async commitBatch(p,session,signal){
  const fn=async()=>{
   const service=this.service,job=p.jobId?await this.load(p.jobId,session):null;
   let log={operationId:p.operationId,startedAt:new Date(service.now()).toISOString(),items:p.documents.map(d=>({path:d.path,sourceHash:hash(d.markdown),status:'not_started'}))};
   if(job){job.outputs.push(log);if(job.outputs.length>100)throw new Error('任务写入日志已达上限。请核对后建立新任务。');await this.save(job);}
   const persist=async()=>{if(job)await this.save(job);};
   // Validate the whole batch after approval before the first side effect.
   try{await this.pathsFree(p.documents,p.notebook,session);checkAbort(signal);}catch(e){return {status:'batch_stopped',written:false,error:e.message,items:log.items};}
   let anyWritten=false,uncertain=false;
   for(let i=0;i<p.documents.length;i++){
    const d=p.documents[i],item=log.items[i];
    try{
     checkAbort(signal);if(p.expiresAt<=service.now())throw new Error('预览已过期。');
     if(identity(await service.api.session())!==p.connection)throw new Error('思源连接已变化。');
     await this.pathsFree([d],p.notebook,session);
     item.status='attempted';await persist(); // Crash at/after POST means unknown, never resumable automatically.
     let id;
     try{id=await service.api.post('/api/filetree/createDocWithMd',{notebook:p.notebook,path:d.path,markdown:d.markdown},session);}catch(e){item.status='uncertain';item.error=e.message;uncertain=true;await persist();break;}
     if(typeof id!=='string'||!idPattern.test(id)){item.status='uncertain';uncertain=true;await persist();break;}
     item.id=id;item.url=`siyuan://blocks/${id}`;item.status='created';anyWritten=true;await persist();
     const actualPath=await service.api.post('/api/filetree/getHPathByID',{id},session);
     const actual=await service.api.post('/api/block/getBlockKramdown',{id},session);
     if(actualPath!==d.path||typeof actual?.kramdown!=='string')throw new Error('创建后路径或源码回读不匹配，请核对。');
     item.readbackHash=hash(actual.kramdown);item.status='created_readback';await persist();
    }catch(e){item.error=e.message;if(item.status==='attempted'){item.status='uncertain';uncertain=true;}else if(item.status==='created')item.status='created_readback_failed';else item.status='stopped';await persist();break;}
   }
   const complete=log.items.every(i=>i.status==='created_readback');
   return {status:complete?'completed':uncertain?'document_write_uncertain':'batch_partial',written:uncertain?null:anyWritten,items:log.items,jobId:p.jobId,verification:'created_readback 表示路径正确并已取得源码，不代表正文语义核验。批次不回滚、不自动重试；attempted/uncertain 先查询目标核对。'};
  };
  return p.jobId?this.locked(p.jobId,fn):fn();
 }
}
