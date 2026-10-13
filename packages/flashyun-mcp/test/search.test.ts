import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { rankResults, retrievalBudgets, searchWeb } from '../src/search.js';

test('registered retrieval modes expose increasing bounded budgets', () => {
  assert.deepEqual(Object.keys(retrievalBudgets), ['speed', 'balanced', 'quality']);
  assert.ok(retrievalBudgets.speed.searchResults < retrievalBudgets.balanced.searchResults);
  assert.ok(retrievalBudgets.balanced.searchResults < retrievalBudgets.quality.searchResults);
  assert.ok(retrievalBudgets.quality.pages <= 5);
});

test('embedding ranking keeps distinct source order by cosine score', () => {
  const ranked = rankResults(
    [1, 0],
    [
      { title: 'low', url: 'https://low.example', content: 'low' },
      { title: 'high', url: 'https://high.example', content: 'high' },
    ],
    [[0, 1], [1, 0]],
  );
  assert.deepEqual(ranked.map((item) => item.title), ['high', 'low']);
});


test('search preserves ordinary ordering, ranks bound vectors and falls back truthfully', async()=>{
 const results=[
  {title:'low',url:'https://1.1.1.1/low',content:'low'},
  {title:'high',url:'https://1.1.1.1/high',content:'high'},
 ];
 const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({results}));});
 await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address || typeof address==='string')throw new Error('fixture unavailable');
 const searxngBaseURL=`http://127.0.0.1:${address.port}`;
 try{
  let embedded=false;
  const embed=async(texts:string[])=>{embedded=true;assert.equal(texts.length,3);return [[1,0],[0,1],[1,0]];};
  const ordinary=await searchWeb('query',{mode:'ordinary'},{searxngBaseURL,embed});
  assert.equal(embedded,false);assert.equal(ordinary.mode,'ordinary');assert.deepEqual(ordinary.findings.map(item=>item.title),['low','high']);
  const advanced=await searchWeb('query',{mode:'speed'},{searxngBaseURL,embed});
  assert.equal(embedded,true);assert.equal(advanced.mode,'speed');assert.deepEqual(advanced.findings.map(item=>item.title),['high','low']);
  const fallback=await searchWeb('query',{mode:'speed'},{searxngBaseURL,embed:async()=>{throw new Error('private provider rejection');}});
  assert.equal(fallback.mode,'ordinary');assert.deepEqual(fallback.findings.map(item=>item.title),['low','high']);assert.ok(!JSON.stringify(fallback).includes('private provider'));
 }finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}
});
