import readline from 'node:readline';
import {Service, TOOLS} from './core.mjs';
import {HostRequests, createConfirmation} from './confirmation.mjs';

const versions=['2026-07-28','2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const settings={readTool:'settings.read',updateTool:'settings.update'};
const caps={tools:{listChanged:false},experimental:{'openai/settings':settings},extensions:{'openai/settings':settings}};
const info={name:'siyuan-local',version:'1.3.0'};
let clientCaps={},initialized=false;
const active=new Map();
function send(value) {process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');}
const outbound=new HostRequests(send);
const service=new Service();
const nativeConfirm=service.confirm;
service.confirm=createConfirmation({nativeConfirm,request:outbound.request.bind(outbound),getCapabilities:()=>clientCaps});
async function handle(req) {
  if(req.method==='initialize') {
    clientCaps=req.params?.capabilities??{};initialized=true;
    return {protocolVersion:versions.includes(req.params?.protocolVersion)?req.params.protocolVersion:'2025-11-25',capabilities:caps,serverInfo:info,instructions:'Windows local SiYuan. Use siyuan_configure or plugin settings to open the native token password dialog; do not launch it through an agent sandbox shell. Never ask for a token in chat. All writes require user confirmation.'};
  }
  if(req.method==='server/discover')return {resultType:'complete',supportedVersions:versions,_meta:{'io.modelcontextprotocol/serverInfo':info},capabilities:caps};
  if(!initialized)throw Object.assign(new Error('请先初始化 MCP 会话。'),{code:-32000});
  if(req.method==='ping')return {};
  if(req.method==='tools/list')return {tools:TOOLS};
  if(req.method==='tools/call') {
    try {
      const data=await service.call(req.params?.name,req.params?.arguments??{},active.get(req.id)?.controller.signal);
      if(active.get(req.id)?.cancelled && !data.written && !['asset_upload_incomplete','document_write_uncertain'].includes(data.status))return {content:[{type:'text',text:'请求已取消。'}],isError:true};
      return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
    } catch(e) {return {content:[{type:'text',text:e.message}],isError:true};}
  }
  throw Object.assign(new Error('不支持的方法。'),{code:-32601});
}
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{
  if(!line.trim())return;
  let req;
  try {if(Buffer.byteLength(line)>2*1024*1024)throw new Error();req=JSON.parse(line);}catch{send({id:null,error:{code:-32700,message:'无效 JSON 或消息过大。'}});return;}
  if(req?.jsonrpc!=='2.0' || (!('method' in req) && !('id' in req))) {send({id:req?.id??null,error:{code:-32600,message:'无效 JSON-RPC 请求。'}});return;}
  if(!req.method) {outbound.settle(req);return;}
  if(req.method==='notifications/cancelled') {
    const task=active.get(req.params?.requestId);if(task) {task.cancelled=true;task.controller.abort();}
    return;
  }
  if(!('id' in req))return;
  if(active.has(req.id)){send({id:req.id,error:{code:-32600,message:'重复请求 ID。'}});return;}
  active.set(req.id,{cancelled:false,controller:new AbortController()});
  // Do not serialize: an elicitation response must be received during tools/call.
  handle(req).then(result=>send({id:req.id,result})).catch(e=>send({id:req.id,error:{code:e.code??-32603,message:e.message}})).finally(()=>active.delete(req.id));
});
lines.on('close',()=>{for(const task of active.values())task.controller.abort();outbound.close();});
const shutdown=()=>{for(const task of active.values())task.controller.abort();outbound.close();process.exit(0);};
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
