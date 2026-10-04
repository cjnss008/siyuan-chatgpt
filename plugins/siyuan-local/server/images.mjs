import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const MAX_IMAGE_BYTES=20*1024*1024, MAX_IMAGE_TOTAL=100*1024*1024, MAX_IMAGES=200;
export const MAX_CAPTURE_FILE_BYTES=144*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function imageFormat(b) {
  if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return ['png','image/png'];
  if(b[0]===255&&b[1]===216&&b[2]===255)return ['jpg','image/jpeg'];
  if(/^GIF8[79]a$/.test(b.subarray(0,6).toString('ascii')))return ['gif','image/gif'];
  if(b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP')return ['webp','image/webp'];
  if(b.subarray(0,2).toString()==='BM')return ['bmp','image/bmp'];
  if(['49492a00','4d4d002a'].includes(b.subarray(0,4).toString('hex')))return ['tiff','image/tiff'];
  if(b.subarray(4,8).toString()==='ftyp'&&/avif|avis/.test(b.subarray(8,32).toString('ascii')))return ['avif','image/avif'];
  throw new Error('不是受支持的原始图片（PNG/JPEG/GIF/WebP/BMP/TIFF/AVIF）。');
}
export function decodeImage(base64) {
  if(typeof base64!=='string'||base64.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||base64.length%4||/[^A-Za-z0-9+/=]/.test(base64))throw new Error('图片编码无效或超过 20 MiB。');
  const bytes=Buffer.from(base64,'base64');if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==base64)throw new Error('图片编码无效、为空或超过 20 MiB。');
  const [extension,mime]=imageFormat(bytes);return {bytes,extension,mime,hash:hash(bytes)};
}

// Inspect only actual image embeds, excluding fenced and inline code examples.
export function imageReferences(text) {
  const visible=text.replace(/(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3[^\n]*(?=\n|$)|$)/g,m=>m.replace(/[^\n]/g,' ')).replace(/(`+)(?!`)[\s\S]*?\1/g,m=>m.replace(/[^\n]/g,' '));
  const refs=[];let match;
  const starts=/!\[(?:\\.|[^\]\\])*\]\(/g;
  while((match=starts.exec(visible))) {
    let start=starts.lastIndex;while(/\s/.test(visible[start]??'')&&start<visible.length)start++;
    let end=start;
    if(visible[start]==='<'){start++;end=visible.indexOf('>',start);if(end<0)continue;}
    else {let depth=0;for(;end<visible.length;end++){const c=visible[end];if(c==='\\'){end++;continue;}if(c==='(')depth++;if(c===')'){if(!depth)break;depth--;}if(/\s/.test(c)&&!depth)break;}}
    if(end>start)refs.push({start,end,source:text.slice(start,end).replace(/\\([() ])/g,'$1')});
  }
  const definitions=new Map();for(const m of visible.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))/gm))definitions.set(m[1].toLowerCase(),{source:m[2]??m[3]});
  for(const m of visible.matchAll(/!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?(?!\()/g)) {
    const d=definitions.get((m[2]||m[1]).toLowerCase());if(d)refs.push({start:m.index,end:m.index+m[0].length,source:d.source,whole:true,alt:m[1]});
  }
  for(const m of visible.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi)){const start=m.index+m[0].indexOf(m[2]);refs.push({start,end:start+m[2].length,source:m[2]});}
  return refs;
}
export function publicAddress(address) {
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !([0,10,127].includes(a)||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&[18,19].includes(b)));}
  // Global unicast only, excluding documentation and IPv4 mapped addresses.
  return isIP(address)===6&&/^[23]/i.test(address)&&!/^2001:db8:/i.test(address);
}
async function remoteImage(source,signal,redirects=0) {
  const u=new URL(source);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw new Error('只下载聊天中明确引用的公开 HTTPS 图片。');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await dns.lookup(host,{all:true});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('图片地址不是公开互联网地址。');
  return new Promise((resolve,reject)=>{
    const target=addresses[0];
    const req=https.get(u,{signal,autoSelectFamily:false,lookup:(_host,_opts,cb)=>cb(null,target.address,target.family)},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){res.resume();if(redirects>=4||!res.headers.location)return reject(new Error('图片重定向过多。'));return resolve(remoteImage(new URL(res.headers.location,u).href,signal,redirects+1));}
      if(res.statusCode!==200){res.resume();return reject(new Error('图片链接失效或需要网页登录，请用浏览器扩展导出图片。'));}
      if(Number(res.headers['content-length'])>MAX_IMAGE_BYTES){res.destroy();return reject(new Error('图片超过 20 MiB。'));}
      let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>MAX_IMAGE_BYTES){res.destroy();reject(new Error('图片超过 20 MiB。'));}else chunks.push(chunk);});res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',()=>reject(new Error('图片下载中断。')));
    });const timer=setTimeout(()=>req.destroy(new Error('图片下载超时。')),20000);req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(new Error('图片无法下载或已取消。')));
  });
}
export async function readImageSource(source,{signal}={}) {
  if(signal?.aborted)throw new Error('请求已取消。');
  if(typeof source!=='string'||!source)throw new Error('历史记录缺少原始图片地址。');
  if(source.startsWith('data:')){const m=source.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]+)$/);if(!m)throw new Error('图片 data URL 无效。');return decodeImage(m[1]).bytes;}
  if(source.startsWith('https:'))return remoteImage(source,signal);
  // Desktop Markdown file links may use /C:/... while Windows files use C:/....
  const file=source.startsWith('file:')?fileURLToPath(source):source.replace(/^\/([A-Za-z]:[\\/])/,'$1');
  if(!path.isAbsolute(file)||/^[/\\]{2}/.test(file)||/[\x00-\x1f]/.test(file)||file.slice(2).includes(':')||! /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i.test(file))throw new Error('原始图片必须是本机普通图片文件或公开 HTTPS 图片。');
  const handle=await fs.open(file,'r');try{const s=await handle.stat();if(!s.isFile()||s.size>MAX_IMAGE_BYTES)throw new Error('图片不是普通文件或超过 20 MiB。');const bytes=Buffer.alloc(Math.min(s.size+1,MAX_IMAGE_BYTES+1));let count=0;while(count<bytes.length){if(signal?.aborted)throw new Error('请求已取消。');const r=await handle.read(bytes,count,bytes.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}if(count>s.size||count>MAX_IMAGE_BYTES)throw new Error('读取期间图片大小变化。');return bytes.subarray(0,count);}finally{await handle.close();}
}

export async function hydrateImages(value,{signal,readSource=readImageSource}={}) {
  const capture=structuredClone(value),images=[],cache=new Map(),byHash=new Map();let total=0,count=0;
  const add=async(source,name)=>{
    if(signal?.aborted)throw new Error('请求已取消。');if(cache.has(source))return cache.get(source);
    if(++count>MAX_IMAGES)throw new Error('图片引用超过 200 个；未截断。');
    let image;
    try{const bytes=await readSource(source,{signal});if(bytes.length>MAX_IMAGE_BYTES)throw new Error('图片超过 20 MiB。');const [extension,mime]=imageFormat(bytes),digest=hash(bytes);if(byHash.has(digest)){cache.set(source,byHash.get(digest).id);return byHash.get(digest).id;}total+=bytes.length;if(total>MAX_IMAGE_TOTAL)throw new Error('图片总量超过 100 MiB。');image={id:digest,name:`chat-${digest}.${extension}`,mime,base64:bytes.toString('base64'),bytes:bytes.length};byHash.set(digest,image);}
    catch(e){if(signal?.aborted)throw new Error('请求已取消。');image={id:`missing-${images.length}`,name:name||'图片',error:e.code==='ENOENT'?'原始图片文件已不存在。':e.code?'原始图片文件不可读。':e.message};}
    images.push(image);cache.set(source,image.id);return image.id;
  };
  for(const m of capture.messages){
    m.imageReferences=[];
    for(const ref of imageReferences(m.text))m.imageReferences.push({...ref,imageId:await add(ref.source,'正文图片')});
    for(const a of m.attachments??[])if(['image','localImage'].includes(a.type))a.imageId=await add(a.source??'',a.name);
  }
  capture.images=images;capture.imageCoverage='original-files';return capture;
}
export function normalizeImages(value) {
  const images=(value.images??[]);if(!Array.isArray(images)||images.length>MAX_IMAGES)throw new Error('图片列表无效或过多。');
  let total=0;const ids=new Set();return images.map(image=>{
    if(typeof image?.id!=='string'||ids.has(image.id)||typeof image.name!=='string'||image.name.length>1000)throw new Error('图片标识无效。');ids.add(image.id);
    if(image.error){if(typeof image.error!=='string')throw new Error('图片错误无效。');return {id:image.id,name:image.name,error:image.error.slice(0,500)};}
    const d=decodeImage(image.base64);total+=d.bytes.length;if(total>MAX_IMAGE_TOTAL)throw new Error('图片总量超过 100 MiB。');if(d.hash!==image.id)throw new Error('图片 SHA-256 与记录不一致。');
    return {id:d.hash,name:`chat-${d.hash}.${d.extension}`,mime:d.mime,base64:image.base64,bytes:d.bytes.length};
  });
}
export const imagePlaceholder=id=>`siyuan-chat-image://${id}`;
export function imageMarkdown(capture) {
  return capture.images.map(i=>`![${i.name.replace(/[\[\]\\\r\n]/g,' ')}](${imagePlaceholder(i.id)})`).join('\n\n');
}
export function replaceImageLinks(markdown,images,assets) {
  let result=markdown;for(const i of images){const url=assets[i.id];if(typeof url!=='string'||!/^assets\/[A-Za-z0-9_./%-]+$/.test(url)||url.split('/').some(p=>p==='..'||p==='.')||/%(?:2e|2f|5c)/i.test(url))throw new Error('思源返回无效的图片资源路径；正文未写入。');result=result.replaceAll(imagePlaceholder(i.id),url);}return result;
}
