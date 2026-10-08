import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join, extname, resolve} from 'node:path';
const root=resolve(import.meta.dirname);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
createServer(async (req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=resolve(join(root,pathname==='/'?'index.html':pathname));
  if(!file.startsWith(root+'/') && file!==root){res.writeHead(403);return res.end('Forbidden');}
  try{const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(data);}catch{res.writeHead(404);res.end('Not found');}
}).listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('Visit http://127.0.0.1:'+ (process.env.PORT||4173)));
