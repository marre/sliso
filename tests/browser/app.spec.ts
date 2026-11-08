import {journeyLines} from './map-data';
import { test, expect } from '@playwright/test';
import { stockholmNow } from '../../src/core/time';
async function init(page: import('@playwright/test').Page) {
 await page.route('https://tile.openstreetmap.org/**',r=>r.abort());
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());
 await page.goto('/');
 await expect(page.locator('#stop-search')).toBeEnabled();
 await page.locator('#time').fill('08:00');
}
async function share(page: import('@playwright/test').Page){
 if(await page.locator('#mobile-toggle').isVisible()&&await page.locator('#mobile-toggle').getAttribute('aria-expanded')==='true')await page.locator('#mobile-close-search').click();
 await page.locator('#share').click();
}
async function select(page: import('@playwright/test').Page, name='T-Centralen') {
 await page.locator('#stop-search').fill(name);
 await page.locator('#stop-search').press('ArrowDown');
 await page.locator('#stop-search').press('Enter');
 await expect(page.locator('#calculate')).toBeEnabled();
}
test('local stop search, worker result, filters, share and marker detail',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await init(page);await select(page);
 await page.locator('#calculate').click();
 await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete',{timeout:20000});
 await expect(page.locator('#status')).toContainText('Färdigt.');
 await expect(page.locator('.time-note')).toContainText('Restid utan väntan före första avgången');
 await page.screenshot({path:`test-results/${test.info().project.name}-result.png`,fullPage:true});
 // A result click is a stop value, and its explicit action changes the origin.
 const marker=page.getByRole('button',{name:'Universitetet · Testläge A',exact:true});
 await marker.press('Enter');
 await expect(page.locator('#journey-panel')).toContainText('Avgång');
 await expect(page.locator('#journey-panel')).toContainText('Ankomst');
 await expect.poll(async()=>(await journeyLines(page)).length).toBeGreaterThan(0);
 await page.getByRole('button',{name:'Stäng resedetaljer'}).click();
 // Restore mobile panel to modify filters.
 if(await page.locator('#mobile-toggle').isVisible())await page.locator('#mobile-toggle').click();
 await page.locator('#options').evaluate((d:HTMLDetailsElement)=>d.open=true);
 for(const c of await page.locator('[name=mode]').all())await c.uncheck();
 await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
 await page.locator('#calculate').click();
 await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 await expect(page.locator('#map .map-stop:not([style*="display: none"])').first()).toBeAttached();
 await share(page);
 await expect(page).toHaveURL(/#s=/);
 const shared=page.url();
 await page.goto(shared);await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 expect(errors).toEqual([]);
});
test('station search automatically chooses a usable platform',async({page})=>{
 await init(page);await page.locator('#stop-search').fill('Slussen');
 await page.locator('#stop-search').press('Enter');
 await expect(page.locator('#platform-field, #platform')).toHaveCount(0);
 await expect(page.locator('#calculate')).toBeEnabled();
 await expect(page.locator('#status')).toContainText('Redo att beräkna');
});
test('A12/A14 cancellation and changed settings leave no finished result',async({page})=>{
 await init(page);await select(page);
 await page.route('**/*.bin',async r=>{await new Promise(resolve=>setTimeout(resolve,800));await r.continue();});
 await page.locator('#calculate').click();await page.locator('#cancel:visible, #map-cancel:visible').first().click();
 await expect(page.locator('#status')).toContainText('Avbruten');
 await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
 await page.locator('#time').fill('09:00');await page.locator('#time').blur();
 await page.waitForTimeout(1200);await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
});
test('missing origin and out-of-coverage date are never silently replaced',async({page})=>{
 await init(page);await select(page);
 await share(page);
 const s=JSON.parse(decodeURIComponent(new URL(page.url()).hash.slice(3)));
 s.stop='removed-id';s.name='Försvunnen hållplats';
 await page.goto('/#s='+encodeURIComponent(JSON.stringify(s)));
 await expect(page.locator('#form-error')).toContainText('finns inte längre');
 await expect(page.locator('#calculate')).toBeDisabled();
 s.stop='demo-2';s.date='2020-01-01';
 await page.goto('/#s='+encodeURIComponent(JSON.stringify(s)));
 await expect(page.locator('#form-error')).toContainText('Välj ett nytt datum');
 await expect(page.locator('#date')).toHaveValue('2020-01-01');
 await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
});
test('shared Stockholm times survive another browser timezone',async({browser})=>{
 const context=await browser.newContext({timezoneId:'America/New_York'});
 const page=await context.newPage();await init(page);await select(page);
 await share(page);
 const s=JSON.parse(decodeURIComponent(new URL(page.url()).hash.slice(3)));
 expect(s.time).toBe('08:00');expect(s.date).toBe(stockholmNow().date);
 await context.close();
});
test('missing timetable/quota failure leaves unknown rather than unreachable',async({page})=>{
 await init(page);await select(page);
 await page.route('**/*.bin',r=>r.fulfill({status:429,body:'quota'}));
 await page.locator('#calculate').click();
 await expect(page.locator('#form-error')).toContainText('Datakvoten');
 await expect(page.locator('#status')).toContainText('okänd');
 await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
});
test('changed settings terminate old data loading before it can publish',async({page})=>{
 await init(page);await select(page);
 await page.route('**/*.bin',async r=>{await new Promise(resolve=>setTimeout(resolve,800));await r.continue();});
 await page.locator('#calculate').click();
 if(await page.locator('#mobile-toggle').isVisible())await page.locator('#mobile-toggle').click();
 await page.locator('#stop-search').fill('Universitetet');await page.locator('#stop-search').press('Enter');
 await page.waitForTimeout(1000);
 await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
 await expect(page.locator('#map-label')).toContainText('UNIVERSITETET');
});
test('driver-coordinated stops are routable and show a rider notice',async({page})=>{
 await init(page);await page.locator('#stop-search').fill('Slussen');await page.locator('#stop-search').press('Enter');
 await page.getByRole('button',{name:'Slussen · Testläge B',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');if(await page.locator('#mobile-toggle').isVisible())await page.locator('#mobile-toggle').click();
 await page.locator('#options').evaluate((d:HTMLDetailsElement)=>d.open=true);
 for(const c of await page.locator('[name=mode]').all())if(await c.getAttribute('value')!=='bus')await c.uncheck();
 await page.locator('#calculate').click();await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 await page.getByRole('button',{name:'Nacka strand · Testläge A',exact:true}).press('Enter');
 await expect(page.locator('#journey-panel')).toContainText('meddela föraren');
});

test('destination route previews on hover, pins with keyboard, and recalculates on origin change',async({page},info)=>{
 await init(page);await select(page);await page.locator('#calculate').click();
 await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 const marker=page.getByRole('button',{name:'Universitetet · Testläge A',exact:true});
 if(info.project.name==='desktop'){
  await marker.hover({force:true});
  await expect(page.locator('#journey-panel')).toBeVisible();
  await expect(page.locator('#journey-panel')).toContainText('Tunnelbana');
  await expect.poll(async()=>(await journeyLines(page)).length).toBeGreaterThan(0);
  await page.mouse.move(20,10);
  await expect(page.locator('#journey-panel')).toBeHidden();
  await marker.hover({force:true});
  await expect(page.locator('#journey-content')).toBeHidden();
  await page.locator('#journey-expand').click();
  await expect(page.locator('#journey-expand')).toHaveAttribute('aria-expanded','true');
  await page.locator('#journey-pin').click();
 }else {await marker.press('Enter');await page.locator('#journey-expand').click();}
 await expect(page.locator('#journey-pin')).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('#journey-panel')).toContainText('Avgång');
 await expect(page.locator('#journey-panel')).toContainText('Ankomst');
 await expect(page.locator('#journey-panel')).toContainText('Schematisk resväg');
 await page.locator('#journey-fit').click();
 await expect(page.locator('#journey-panel')).toBeVisible();
 const visible=await page.evaluate(async()=>{const {map}=await import('/src/main.ts' as string),data=map.getSource('journey').serialize().data;return data.features.filter((f:any)=>f.geometry.type==='LineString').flatMap((f:any)=>f.geometry.coordinates).every((p:any)=>map.getBounds().contains(p));});
 expect(visible).toBe(true);
 await page.screenshot({path:`test-results/${info.project.name}-journey.png`,fullPage:true});
 await page.locator('#journey-start').click();
 await expect(page.locator('#map-label')).toContainText('UNIVERSITETET');
 await expect(page.locator('#journey-panel')).toBeHidden();
 expect(await journeyLines(page)).toHaveLength(0);
 await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
});

test('only known destinations remain after search; new search restores the map and retains filters',async({page})=>{
 await init(page);await select(page);
 const enabledMarkers=()=>page.locator('.map-stop').evaluateAll(items=>items.filter(e=>getComputedStyle(e).display!=='none').length);
 await expect(page.locator('.map-stop').first()).toBeAttached();
 const before=await enabledMarkers();
 await page.locator('#options').evaluate((d:HTMLDetailsElement)=>d.open=true);
 await page.locator('#walk').selectOption('5');
 for(const c of await page.locator('[name=mode]').all())await c.uncheck();
 await page.locator('#calculate').click();await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 await expect.poll(enabledMarkers).toBeLessThan(before);
 await expect(page.getByRole('button',{name:'Universitetet · Testläge A',exact:true})).toBeHidden();
 await expect(page.locator('#walking-status')).toContainText('Ungefärliga gångområden');
 await expect(page.locator('canvas.walking-raster').first()).toBeAttached();
 await share(page);await expect(page).toHaveURL(/#s=/);
 if(await page.locator('#mobile-toggle').isVisible()&&await page.locator('#mobile-toggle').getAttribute('aria-expanded')==='false')await page.locator('#mobile-toggle').click();await page.locator('#reset-search').click();
 await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');await expect(page.locator('#journey-panel')).toBeHidden();
 await expect(page.locator('#stop-search')).toHaveValue('');await expect(page.locator('#calculate')).toBeDisabled();
 await expect(page.locator('#walk')).toHaveValue('5');await expect(page.locator('#time')).toHaveValue('08:00');
 expect(new URL(page.url()).hash).toBe('');
 // Keyboard targets are remounted on the renderer's animation frame.
 // Reset updates the form first; wait for the complete map state, not a fixed delay.
 await expect.poll(enabledMarkers).toBe(before);
 await page.getByRole('button',{name:'Universitetet · Testläge A',exact:true}).press('Enter');
 await expect(page.locator('#map-label')).toContainText('UNIVERSITETET');
 await expect(page.locator('#calculate')).toBeEnabled();
});

test('walking legs show network distance and cancellation rejects in-flight results',async({page})=>{
 await init(page);await select(page);await page.locator('#options').evaluate((d:HTMLDetailsElement)=>d.open=true);
 for(const c of await page.locator('[name=mode]').all())await c.uncheck();
 await page.locator('#calculate').click();await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 await page.getByRole('button',{name:'Stockholm City · Testläge A',exact:true}).press('Enter');
 await expect(page.locator('#journey-panel')).toContainText('320 m');
 await expect(page.locator('#journey-panel')).toContainText('Gång totalt: 4 min');
 await page.getByRole('button',{name:'Stäng resedetaljer'}).click();
 if(await page.locator('#mobile-toggle').isVisible()&&await page.locator('#mobile-toggle').getAttribute('aria-expanded')==='false')await page.locator('#mobile-toggle').click();await page.locator('#reset-search').click();await select(page);
 // A warm Cache API response can finish before the cancel click. Hold an actual
 // uncached shard until cancellation instead of relying on an arbitrary delay.
 await page.evaluate(async()=>{await caches.delete('sliso-data-v1');});
 let release!:()=>void,requested!:()=>void;
 const gate=new Promise<void>(resolve=>release=resolve),loading=new Promise<void>(resolve=>requested=resolve);
 await page.route('**/*.bin',async r=>{requested();await gate;await r.continue().catch(()=>{});});
 try{
  await page.locator('#calculate').click();await loading;
  await page.locator('#cancel:visible, #map-cancel:visible').first().click();
 }finally{release();}
 await page.waitForTimeout(1000);
 await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');await expect(page.locator('#journey-panel')).toBeHidden();
 await expect(page.locator('#status')).toContainText('Avbruten');
});

test('compact walking payload is verified and used by the worker',async({page})=>{
 const {createHash}=await import('node:crypto');let packed='',seen=false;
 await page.route('**/data/manifest.json',async route=>{
  const response=await route.fetch(),m=await response.json();
  const walks=await (await page.request.get('http://127.0.0.1:5174'+m.walks.url)).json();
  const sources=[...new Set(walks.map((w:any)=>w.source))];
  packed=JSON.stringify({schema:1,sources,edges:walks.map((w:any)=>[w.from,w.to,w.seconds,w.metres??null,sources.indexOf(w.source)])});
  m.walks={url:'/data/browser-compact/walks.json',bytes:Buffer.byteLength(packed),sha256:createHash('sha256').update(packed).digest('hex')};
  // Exercise the legacy graph format; the inherited closure is bound to the
  // original walking file's checksum and cannot accompany a rewritten payload.
  delete m.walkingClosure;
  await route.fulfill({json:m});
 });
 await page.route('**/data/browser-compact/walks.json',r=>{seen=true;return r.fulfill({contentType:'application/json',body:packed});});
 await init(page);await select(page);await page.locator('#options').evaluate((d:HTMLDetailsElement)=>d.open=true);
 for(const c of await page.locator('[name=mode]').all())await c.uncheck();
 await page.locator('#calculate').click();await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 await page.getByRole('button',{name:'Stockholm City · Testläge A',exact:true}).press('Enter');
 await expect(page.locator('#journey-panel')).toContainText('320 m');
 await expect(page.locator('#journey-panel')).toContainText('Gång totalt: 4 min');expect(seen).toBe(true);
});

test('map progress shows provisional stations before completion and cancel rejects late batches',async({page})=>{
 await page.addInitScript(()=>{
  const NativeWorker=window.Worker;
  class StreamWorker {
   onmessage:any;onerror:any;id=0;
   constructor(url:string,options?:WorkerOptions){if(!String(url).includes('/worker.ts'))return new NativeWorker(url,options) as any;(window as any).streamWorker=this;}
   postMessage(message:any){this.id=message.id;}
   terminate(){}
   emit(message:any){this.onmessage?.({data:{id:this.id,...message}});}
  }
  (window as any).Worker=StreamWorker;
 });
 await init(page);await select(page);await page.locator('#calculate').click();
 const bar=page.locator('#map-progress [role=progressbar]');
 await expect(bar).toBeVisible();
 await page.evaluate(()=>(window as any).streamWorker.emit({type:'progress',phase:'data',completed:1,total:2,bytesCompleted:50,bytesTotal:100}));
 await expect(bar).toHaveAttribute('aria-valuenow','50');
 await page.evaluate(()=>(window as any).streamWorker.emit({type:'stations',completedRounds:1,totalRounds:6,processedLabels:10,queuedLabels:20,changes:[{stop:5,value:{seconds:600,arrival:1200,kind:'transit',boardings:1,journey:null}}]}));
 const marker=page.getByRole('button',{name:'Universitetet · Testläge A',exact:true});
 await expect(marker).toBeVisible();
 await expect(page.locator('#status')).toContainText('preliminära');
 const progressBox=await page.locator('.map-progress-text').boundingBox(),headingBox=await page.locator('.map-heading:visible, #mobile-toggle:visible').first().boundingBox();
 expect(progressBox!.y+progressBox!.height).toBeLessThanOrEqual(headingBox!.y);
 await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
 await marker.press('Enter');await expect(page.locator('.stop-popup')).toContainText('Preliminärt 10 min');
 await expect(page.locator('#map-label')).toContainText('T-CENTRALEN');
 await page.locator('#cancel:visible, #map-cancel:visible').first().click();
 await expect(page.locator('#map-progress')).toBeHidden();
 await page.evaluate(()=>(window as any).streamWorker.emit({type:'stations',completedRounds:2,totalRounds:6,changes:[{stop:5,value:{seconds:300,journey:null}}]}));
 await expect(page.locator('#map-progress')).toBeHidden();
 await expect(page.locator('#status')).toContainText('Avbruten');
});

test('disconnected walking exits remain flagged in search status',async({page})=>{
 await init(page);
 const s={v:1,stop:'demo-20',name:'Mörby station',lat:59.3887,lon:18.0507,date:stockholmNow().date,time:'22:26',maxMinutes:120,walkMinutes:30,maxTransfers:4,windowMinutes:30,modes:['boat']};
 await page.goto('/#s='+encodeURIComponent(JSON.stringify(s)));
 await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 await expect(page.locator('#status')).toBeVisible();
 await expect(page.locator('#status')).toContainText('missa möjliga resor');
});
