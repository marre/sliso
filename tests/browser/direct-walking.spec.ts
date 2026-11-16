import {test,expect} from '@playwright/test';

/** End-to-end coverage for an origin component with no stop bindings and no
 * precomputed stop contours. A short synthetic directed edge is enough to
 * exercise the real walking-band worker, canvas, and cutoff update pipeline. */
test('walking-only map renders directed reachability without any stop contour',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  document.addEventListener('sliso:map-ready',event=>{
   if((event.target as HTMLElement).id==='map')(window as any).directTestMap=(event as CustomEvent).detail;
  });
 });
 await page.goto('/');
 await expect(page.locator('#stop-search')).toBeEnabled();
 await page.evaluate(async()=>{
  const {WalkingView}=await import('/src/walking-view.ts' as string);
  const manifest=await (await fetch('/data/manifest.json')).json();
  const map=(window as any).directTestMap;
  map.jumpTo({center:[18.0585,59.331],zoom:15});
  const view=new WalkingView(map,()=>{},()=>{});
  (window as any).directTestView=view;
  view.setData({
   directWalking:{maxSeconds:180,segments:[[59.331,18.057,59.331,18.060,120,0,-1,0,1]]},
   values:[],journeys:[],routes:[],walkSources:[],labels:0,elapsed:0,complete:true
  },{v:1,origin:'point',stop:'@point',name:'Vald kartpunkt',lat:59.331,lon:18.057,
     date:'2026-11-16',time:'08:00',maxMinutes:30,walkMinutes:5,maxTransfers:0,
     windowMinutes:30,modes:[]},{...manifest,walkingAreas:undefined,waterMask:undefined},[]);
 });
 const canvas=page.locator('canvas.walking-raster');
 await expect(canvas).toBeAttached({timeout:15000});
 const count=()=>canvas.evaluate((el:HTMLCanvasElement)=>{
  const data=el.getContext('2d')!.getImageData(0,0,el.width,el.height).data;
  let n=0;for(let i=3;i<data.length;i+=4)if(data[i])n++;
  return n;
 });
 await expect.poll(count,{timeout:15000}).toBeGreaterThan(0);
 const before=await count();
 await page.evaluate(()=>(window as any).directTestView.setCutoff(1));
 await expect.poll(()=>canvas.getAttribute('data-cutoff'),{timeout:15000}).toBe('1');
 const after=await count();
 expect(after).toBeGreaterThan(0);expect(after).toBeLessThan(before);
 await page.evaluate(()=>(window as any).directTestView.reset());
 await expect(canvas).toHaveCount(0);
 expect(errors).toEqual([]);
});
