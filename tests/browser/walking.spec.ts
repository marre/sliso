import { test, expect } from '@playwright/test';
import {gzipSync} from 'node:zlib';
import {archive,packFixed} from '../../src/core/contours';
import type {AreaGeometry} from '../../src/core/bands';
import { createHash } from 'node:crypto';

async function walkingFixture(page: import('@playwright/test').Page,binary=false,profile=false) {
  await page.route('https://tile.openstreetmap.org/**', r => r.abort());
  await page.goto(profile?'/?profile=1':'/');
  const geometry = { type: 'Polygon', coordinates: [[[17.99,59.32],[18.01,59.32],[18.01,59.34],[17.99,59.34],[17.99,59.32]]] };
  const bodies = ['a','b'].map(id => {if(!binary)return Buffer.from(JSON.stringify({ [id]: [{ minutes: 10, geometry }] }));const chunk=packFixed(geometry as AreaGeometry);return gzipSync(Buffer.from(archive({[id]:[{minutes:10,offset:0,length:chunk.byteLength}]},[chunk])));});
  const refs = bodies.map((body,i) => ({ url: `/data/progressive/${i}.json`, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/data/progressive/*.json', async route => {
    const i = Number(new URL(route.request().url()).pathname.split('/').at(-1)!.split('.')[0]);
    if (i === 1) await pending;
    await route.fulfill({ contentType: 'application/json', body: bodies[i] }).catch(() => {});
  });
  await page.evaluate(async ({refs,binary}) => {
    const component = '/src/walking-view.ts', mapModule = '/src/map.ts';
    const { WalkingView } = await import(component), {createMap} = await import(mapModule);
    const el = document.createElement('div'); el.id = 'progressive-map';
    el.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:300px;z-index:10000'; document.body.append(el);
    const status = document.createElement('p'); status.id = 'progressive-status'; document.body.append(status);
    const view = new WalkingView(await createMap(el,[18,59.33],13,'none'), (text:string) => { status.textContent = text; }, () => {});
    (window as any).progressiveView = view;
    view.setData({ walkSources: [{ stop:0,seconds:0,walked:0 },{ stop:1,seconds:600,walked:0 }] },
      { maxMinutes:20,walkMinutes:10 }, { walkingAreas: { index:{ a:0,b:1 },files:refs,...(binary?{format:'sliso-contours-v1'}:{}) } }, [{ id:'a',lat:59.33,lon:18 },{ id:'b',lat:59.33,lon:18 }]);
  }, {refs,binary});
  return release;
}

test('walking areas paint before the final file arrives and preserve faster colors', async ({page}) => {
  const release = await walkingFixture(page);
  await expect(page.locator('#progressive-status')).toContainText('1 av 2 (50 %)');
  const first = page.locator('#progressive-map canvas.walking-raster');
  await expect(first).toBeAttached();
  expect(await first.evaluate((canvas:HTMLCanvasElement) => {
    const data=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    return data.some((value,index)=>index%4===3&&value>0);
  })).toBe(true);
  const sample=()=>first.evaluate((canvas:HTMLCanvasElement)=>{const ctx=canvas.getContext('2d')!,data=ctx.getImageData(0,0,canvas.width,canvas.height).data;for(let i=0;i<data.length;i+=4)if(data[i+3]===255&&data[i]!==255)return [...data.slice(i,i+4)];return [];});
  const faster=await sample();expect(faster.length).toBe(4);
  // Verify the actual WebGL texture, not only the worker's hidden CPU canvas.
  const gpu=await page.evaluate(()=>new Promise<number[]>(resolve=>{
    const map=(window as any).progressiveView.map;
    map.once('render',()=>{const canvas=map.getCanvas(),gl=canvas.getContext('webgl2')!,pixel=new Uint8Array(4);gl.readPixels(canvas.width/2,canvas.height/2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);resolve(Array.from(pixel));});map.triggerRepaint();
  }));
  const expected=faster.slice(0,3).map((value,i)=>Math.round(value*.48+[232,238,228][i]*.52));
  for(let i=0;i<3;i++)expect(Math.abs(gpu[i]-expected[i])).toBeLessThanOrEqual(2);

  release();
  await expect(page.locator('#progressive-status')).toContainText('Ungefärliga');
  expect(await sample()).toEqual(faster);
});

test('reset removes partial walking areas and ignores late arrivals', async ({page}) => {
  const release = await walkingFixture(page);
  await expect(page.locator('#progressive-status')).toContainText('1 av 2');
  await page.evaluate(() => { (window as any).progressiveView.setCutoff(11); (window as any).progressiveView.reset(); });
  release();
  await expect(page.locator('#progressive-map canvas.walking-raster')).toHaveCount(0);
  await page.waitForTimeout(150);
  await expect(page.locator('#progressive-map canvas.walking-raster')).toHaveCount(0);
  await expect(page.locator('#progressive-status')).not.toContainText('Ungefärliga');
});

test('consecutive mapped and estimated walks form one labelled journey step', async ({page}) => {
  await page.route('https://tile.openstreetmap.org/**', r=>r.abort());
  await page.goto('/');
  // Main initialization resets the shared journey panel; finish it before mounting a standalone view.
  await expect(page.locator('#stop-search')).toBeEnabled();
  await page.evaluate(async () => {
    const component='/src/journey-view.ts';
    const mapModule='/src/map.ts';const {JourneyView}=await import(component),{createMap}=await import(mapModule);
    const el=document.createElement('div');el.style.cssText='width:300px;height:300px';document.body.append(el);
    const stops=['A','B','C','D'].map((platform,i)=>({id:String(i),name:'Station',platform,lat:59.+i*.0005,lon:18.,walking:'estimated'}));
    const map=await createMap(el,[18,59],13,'none'),markers:any[]=[];
    const view=new JourneyView(map,markers,()=>{});
    view.setData({values:[null,null,null,{seconds:180,kind:'walk',arrival:240,boardings:0,journey:2}],journeys:[
      {previous:null,kind:'walk',from:0,to:1,departure:60,arrival:120,stops:[0,1],metres:70},
      {previous:0,kind:'walk',from:1,to:2,departure:120,arrival:180,stops:[1,2],metres:80,estimated:true},
      {previous:1,kind:'walk',from:2,to:3,departure:180,arrival:240,stops:[2,3],metres:90}],routes:[]},{date:'2026-10-21',maxMinutes:120},stops);
    view.pin(3);(window as any).cutoffJourney=view;
  });
  await expect(page.locator('#journey-panel')).toContainText('Gång · uppskattad');
  await expect(page.locator('#journey-panel')).toContainText('Uppskattad gång ingår');
  await expect(page.locator('#journey-panel')).toContainText('Gång totalt: 3 min · 240 m');
  await expect(page.locator('#journey-panel .journey-leg')).toHaveCount(1);
  await page.evaluate(()=>(window as any).cutoffJourney.setCutoff(2));
  await expect(page.locator('#journey-panel')).toBeHidden();
  await page.evaluate(()=>{(window as any).cutoffJourney.setCutoff(3);(window as any).cutoffJourney.pin(3);});
  await expect(page.locator('#journey-panel')).toBeVisible();
});

test('walking profiles load for the visible map then follow a new viewport',async({page})=>{
 await page.route('https://tile.openstreetmap.org/**',r=>r.abort());await page.goto('/');
 const bodies=[JSON.stringify({a:[{minutes:10,geometry:{type:'Polygon',coordinates:[[[17.99,59.32],[18.01,59.32],[18.01,59.34],[17.99,59.34],[17.99,59.32]]]}}]}),JSON.stringify({b:[{minutes:10,geometry:{type:'Polygon',coordinates:[[[17.89,59.51],[17.91,59.51],[17.91,59.53],[17.89,59.53],[17.89,59.51]]]}}]})];
 const refs=bodies.map((body,i)=>({url:`/data/viewport/${i}.json`,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}));
 const requested:number[]=[];let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/data/viewport/*.json',async route=>{const i=Number(new URL(route.request().url()).pathname.split('/').at(-1)!.split('.')[0]);requested.push(i);if(i===0)await held;await route.fulfill({contentType:'application/json',body:bodies[i]}).catch(()=>{});});
 await page.evaluate(async refs=>{
  const component='/src/walking-view.ts',mapModule='/src/map.ts';const {WalkingView}=await import(component),{createMap}=await import(mapModule);
  const el=document.createElement('div');el.id='viewport-map';el.style.cssText='position:fixed;left:0;top:0;width:300px;height:300px;z-index:10000';document.body.append(el);
  const status=document.createElement('p');status.id='viewport-status';document.body.append(status);
  const map=await createMap(el,[18,59.33],14,'none');(window as any).viewportMap=map;
  const view=new WalkingView(map,(text:string)=>status.textContent=text,()=>{});
  view.setData({walkSources:[{stop:0,seconds:0,walked:0},{stop:1,seconds:0,walked:0}]},{maxMinutes:20,walkMinutes:10},{walkingAreas:{index:{a:0,b:1},files:refs}},[{id:'a',lat:59.33,lon:18},{id:'b',lat:59.52,lon:17.9}]);
 },refs);
 await expect.poll(()=>requested).toEqual([0]);
 await expect(page.locator('#viewport-status')).toContainText('0 av 1');
 await page.evaluate(()=>(window as any).viewportMap.jumpTo({center:[17.9,59.52],zoom:14}));
 await expect.poll(()=>requested).toEqual([0,1]);
 await expect(page.locator('#viewport-status')).toContainText('Ungefärliga');
 release();
 await page.evaluate(()=>(window as any).viewportMap.jumpTo({center:[18,59.33],zoom:14}));
 await expect.poll(()=>requested).toEqual([0,1,0]);
 await expect(page.locator('#viewport-status')).toContainText('Ungefärliga');
});

 test('fixed-point delivery streams contours from the worker and reloads after toggling',async({page})=>{
  const release=await walkingFixture(page,true);
  await expect(page.locator('#progressive-status')).toContainText('1 av 2');
  await expect(page.locator('#progressive-map canvas.walking-raster')).toBeAttached();release();
  await expect(page.locator('#progressive-status')).toContainText('Ungefärliga');
  await page.evaluate(()=>{(window as any).progressiveView.toggle(false);(window as any).progressiveView.toggle(true)});
  await expect(page.locator('#progressive-status')).toContainText('Ungefärliga');
  await expect(page.locator('#progressive-map canvas.walking-raster')).toBeAttached();
 });

 test('opt-in profiling preserves contour pixels and reports worker stages',async({page})=>{
  const hash=()=>page.locator('#progressive-map canvas.walking-raster').evaluate(async(c:HTMLCanvasElement)=>{
   const pixels=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;
   return [...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].join(',');
  });
  let release=await walkingFixture(page,true);release();
  await expect(page.locator('#progressive-status')).toContainText('Ungefärliga');const baseline=await hash();
  expect(await page.evaluate(()=>typeof (window as any).__slisoProfile)).toBe('undefined');
  release=await walkingFixture(page,true,true);release();
  await expect(page.locator('#progressive-status')).toContainText('Ungefärliga');expect(await hash()).toBe(baseline);
  const events=await page.evaluate(()=>(window as any).__slisoProfile.snapshot());
  for(const name of ['data.hash','contour.inflate','contour.decode','raster.add','render.paint','main.canvas'])expect(events.some((e:any)=>e.name===name)).toBe(true);
  expect(events.every((e:any)=>e.ms>=0&&Number.isFinite(e.at))).toBe(true);
  expect(events.some((e:any)=>e.lane==='walking-worker')).toBe(true);
 });

test('bundled neighbours contribute only through logical selection and can be removed without a refetch',async({page})=>{
 await page.route('https://tile.openstreetmap.org/**',r=>r.abort());await page.goto('/');
 const g={type:'Polygon',coordinates:[[[17.9,59.2],[18.1,59.2],[18.1,59.5],[17.9,59.5],[17.9,59.2]]]};
 const body=JSON.stringify({a:[{minutes:10,geometry:g}],b:[{minutes:10,geometry:g}]});
 const ref={url:'/data/logical/bundle.json',bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')};let requests=0;
 await page.route('**/data/logical/bundle.json',r=>{requests++;return r.fulfill({contentType:'application/json',body})});
 await page.evaluate(async ref=>{
  const component='/src/walking-view.ts',mapModule='/src/map.ts';const {WalkingView}=await import(component),{createMap}=await import(mapModule);
  const el=document.createElement('div');el.id='logical-map';el.style.cssText='position:fixed;left:0;top:0;width:300px;height:300px;z-index:10000';document.body.append(el);
  const status=document.createElement('p');status.id='logical-status';document.body.append(status);
  const map=await createMap(el,[18,59.33],13,'none');(window as any).logicalMap=map;
  // Just beyond the padded selection; a small pan admits b without changing raster bounds.
  const north=map.getBounds().getNorth()+(10*80+50)/111320;
  const view=new WalkingView(map,(text:string)=>status.textContent=text,()=>{});
  view.setData({walkSources:[{stop:0,seconds:600,walked:0},{stop:1,seconds:0,walked:0}]},{maxMinutes:20,walkMinutes:10},{walkingAreas:{index:{a:0,b:0},sources:{a:0,b:1},files:[ref]}},[{id:'a',lat:59.33,lon:18},{id:'b',lat:north+.0005,lon:18}]);
 },ref);
 const canvas=page.locator('#logical-map canvas.walking-raster');
 const pixels=()=>canvas.evaluate((c:HTMLCanvasElement)=>Array.from(c.getContext('2d')!.getImageData(c.width/2,c.height/2,1,1).data));
 await expect(page.locator('#logical-status')).toContainText('Ungefärliga');const original=await pixels();expect(original[3]).toBe(255);
 await page.evaluate(()=>(window as any).logicalMap.panBy([0,-30],{duration:0}));
 await expect.poll(pixels).not.toEqual(original);
 await page.evaluate(()=>(window as any).logicalMap.panBy([0,30],{duration:0}));
 await expect.poll(pixels).toEqual(original);expect(requests).toBe(1);
});

test('broad views use only the labelled overview, replace it on zoom and cancel late detail on reset',async({page})=>{
 await page.route('https://tile.openstreetmap.org/**',r=>r.abort());await page.goto('/');
 const geometry={type:'Polygon',coordinates:[[[17.99,59.32],[18.01,59.32],[18.01,59.34],[17.99,59.34],[17.99,59.32]]]};
 const stops=Array.from({length:48},(_,i)=>({id:'s'+i,lat:59.33,lon:18}));
 const bodies=stops.map(s=>JSON.stringify({[s.id]:[{minutes:7,geometry}]}).padEnd(45000,' '));
 const ref=(url:string,body:string)=>({url,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});
 const refs=bodies.map((b,i)=>ref(`/data/layers/detail-${i}.json`,b));
 const preview=JSON.stringify(Object.fromEntries(stops.map(s=>[s.id,[{minutes:5,geometry}]])));
 const overview=ref('/data/layers/overview.json',preview);let details=0,previews=0,hold=false,release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 await page.route('**/data/layers/*.json',async r=>{
  if(r.request().url().endsWith('/overview.json')){previews++;await r.fulfill({contentType:'application/json',body:preview});return;}
  details++;if(hold)await held;
  const i=Number(r.request().url().split('detail-')[1].split('.')[0]);await r.fulfill({contentType:'application/json',body:bodies[i]}).catch(()=>{});
 });
 await page.evaluate(async({refs,overview,stops})=>{
  const component='/src/walking-view.ts',mapModule='/src/map.ts';const {WalkingView}=await import(component),{createMap}=await import(mapModule);
  const el=document.createElement('div');el.id='layer-map';el.style.cssText='position:fixed;left:0;top:0;width:300px;height:300px;z-index:10000';document.body.append(el);
  const status=document.createElement('p');status.id='layer-status';document.body.append(status);
  const map=await createMap(el,[18,59.33],11,'none'),view=new WalkingView(map,(text:string)=>status.textContent=text,()=>{});
  (window as any).layerMap=map;(window as any).layerView=view;
  const index=Object.fromEntries(stops.map((s,i)=>[s.id,i]));
  view.setData({walkSources:stops.map((s,i)=>({stop:i,seconds:0,walked:0}))},{maxMinutes:20,walkMinutes:7},{walkingAreas:{index,sources:index,files:refs,overview:{index:Object.fromEntries(stops.map(s=>[s.id,0])),files:[overview],stepMinutes:5}}},stops);
 },{refs,overview,stops});
 await expect(page.locator('#layer-status')).toContainText('Översiktliga');
 await expect(page.locator('#layer-map canvas.walking-raster')).toHaveAttribute('data-layer','overview');
 await expect(page.locator('#layer-map .walking-overview-note')).toBeVisible();
 expect(previews).toBe(1);expect(details).toBe(0);
 expect(await page.locator('#layer-map canvas.walking-raster').evaluate((c:HTMLCanvasElement)=>c.getContext('2d')!.getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0))).toBe(true);
 await page.evaluate(()=>(window as any).layerMap.setZoom(12));
 await expect(page.locator('#layer-status')).toContainText('Ungefärliga');
 await expect(page.locator('#layer-map canvas.walking-raster')).toHaveAttribute('data-layer','detail');expect(details).toBe(48);
 await expect(page.locator('#layer-map .walking-overview-note')).toHaveCount(0);
 await page.evaluate(()=>(window as any).layerMap.setZoom(11));
 await expect(page.locator('#layer-map canvas.walking-raster')).toHaveAttribute('data-layer','overview');
 // Clear persistent detail files, hold a fresh refinement, then reset before it returns.
 await page.evaluate(async()=>{const cache=await caches.open('sliso-data-v1');for(const req of await cache.keys())if(req.url.includes('/data/layers/detail-'))await cache.delete(req);});
 hold=true;await page.evaluate(()=>(window as any).layerMap.setZoom(12));
 await expect.poll(()=>details).toBeGreaterThan(48);
 await page.evaluate(()=>(window as any).layerView.reset());release();
 await expect(page.locator('#layer-map canvas.walking-raster')).toHaveCount(0);
 await page.waitForTimeout(150);await expect(page.locator('#layer-map canvas.walking-raster')).toHaveCount(0);
});

test('profile arrivals during animated zoom keep raster dimensions consistent',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const release=await walkingFixture(page,true);await expect(page.locator('#progressive-map canvas.walking-raster')).toBeAttached();
 await page.evaluate(()=>{const map=(window as any).progressiveView.map;map.zoomTo(map.getZoom()+1,{duration:1000});});
 await page.waitForFunction(()=>(window as any).progressiveView.map.isZooming());
 release();await expect(page.locator('#progressive-status')).toContainText('Ungefärliga');
 await expect(page.locator('#progressive-map canvas.walking-raster')).toBeAttached();expect(errors).toEqual([]);
});
