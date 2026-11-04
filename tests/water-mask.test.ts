import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WaterMask} from '../src/water-mask';
test('water masking removes water pixels, preserves land and retries failed downloads',async()=>{
 const original=globalThis.fetch;
 const bytes=new Uint8Array(512*512/8);bytes.fill(255,0,bytes.length/2);
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
 const mask=new WaterMask({format:'sliso-water-bitmap-v1',resolution:512,tileDegrees:.25,tiles:{'0,0':{url:'/data/water-test/tile.bin',bytes:bytes.length,sha256:hash}}});
 try{
  globalThis.fetch=async()=>new Response('',{status:503});
  const failed=new Uint8ClampedArray(16).fill(255);
  await mask.apply(failed,2,2,[0,0,.25,.25]);
  assert.ok(failed.every(x=>x===0));
  globalThis.fetch=async()=>new Response(bytes);
  const pixels=new Uint8ClampedArray(16).fill(255);
  await mask.apply(pixels,2,2,[0,0,.25,.25]);
  assert.deepEqual([pixels[3],pixels[7],pixels[11],pixels[15]],[255,255,0,0]);
 }finally{globalThis.fetch=original;}
});
