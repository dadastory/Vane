import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { embedTexts } from '../src/embedding.js';

async function fixture(handler: Parameters<typeof createServer>[0]) {
 const server=createServer(handler);
 await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 if(!address || typeof address === 'string') throw new Error('fixture invalid');
 return {server,base:`http://127.0.0.1:${address.port}`};
}

test('official SDK sends scoped model/key and attributes embedding use without outer retry',async()=>{
 let calls=0;
 const {server,base}=await fixture(async(request,response)=>{
  calls++;
  assert.equal(request.url,'/v1/embeddings');
  assert.equal(request.headers.authorization,'Bearer scope-a-key');
  assert.deepEqual(JSON.parse(String(request.headers['x-litellm-spend-logs-metadata'])),{flashyun_service_id:'web_search_embedding'});
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  assert.deepEqual(body,{model:'scope-a-model',input:['query','source'],encoding_format:'float'});
  response.writeHead(200,{'content-type':'application/json'});
  response.end(JSON.stringify({object:'list',model:body.model,data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}],usage:{prompt_tokens:2,total_tokens:2}}));
 });
 try{assert.deepEqual(await embedTexts(base,{model:'scope-a-model',key:'scope-a-key'},['query','source']),[[1,0],[0,1]]);assert.equal(calls,1);}
 finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}
});

test('SDK errors are sanitized and no retry duplicates an embedding batch',async()=>{
 let calls=0;const {server,base}=await fixture((_request,response)=>{
  calls++;response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'private upstream body scope-secret'}}));
 });
 try{await assert.rejects(()=>embedTexts(base,{model:'scoped-model',key:'scope-secret'},['query']),{message:'embedding_unavailable'});assert.equal(calls,1);}
 finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}
});

test('SDK does not forward scoped credentials across a redirect',async()=>{
 let redirected=false;const destination=await fixture((_request,response)=>{redirected=true;response.end();});
 const source=await fixture((_request,response)=>{response.writeHead(307,{location:destination.base+'/v1/embeddings'});response.end();});
 try{await assert.rejects(()=>embedTexts(source.base,{model:'scoped-model',key:'private-key'},['query']),{message:'embedding_unavailable'});assert.equal(redirected,false);}
 finally{await Promise.all([source.server,destination.server].map(server=>new Promise<void>((resolve)=>server.close(()=>resolve()))));}
});

test('invalid duplicate/missing vector indexes never enter ranking',async()=>{
 const {server,base}=await fixture((_request,response)=>{
  response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({data:[{index:0,embedding:[1,0]},{index:0,embedding:[0,1]}]}));
 });
 try{await assert.rejects(()=>embedTexts(base,{model:'scoped-model',key:'scope-key'},['a','b']),{message:'embedding_unavailable'});}
 finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}
});
