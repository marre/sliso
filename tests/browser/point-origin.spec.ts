import {journeyLines} from './map-data';
import {test,expect} from '@playwright/test';
import {stockholmNow} from '../../src/core/time';
const point={v:1,origin:'point',stop:'@point',name:'Vald kartpunkt',lat:59.331,lon:18.058,date:stockholmNow().date,time:'08:00',maxMinutes:60,walkMinutes:15,maxTransfers:3,windowMinutes:30,modes:['bus','metro','rail','tram','boat']};
test.beforeEach(async({page})=>{await page.route('https://tile.openstreetmap.org/**',r=>r.abort());});
test('mapped origin restores, draws access geometry, shares and resets on desktop and mobile',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/#s='+encodeURIComponent(JSON.stringify(point)));
 await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');await expect(page.locator('#status')).toContainText('Färdigt.');
 await expect(page.locator('#start-data-gap')).toContainText('Gångstart på kartlagd väg');
 const target=page.getByRole('button',{name:'T-Centralen · Testläge A',exact:true});await target.press('Enter');
 await expect(page.locator('#journey-panel')).toContainText('Vald kartpunkt');expect((await journeyLines(page,'walk')).length).toBeGreaterThan(0);
 await page.getByRole('button',{name:'Stäng resedetaljer'}).click();await page.locator('#share').click();
 const shared=JSON.parse(decodeURIComponent(new URL(page.url()).hash.slice(3)));expect(shared.origin).toBe('point');expect(shared.lon).toBe(point.lon);
 if(await page.locator('#mobile-toggle').isVisible()&&await page.locator('#mobile-toggle').getAttribute('aria-expanded')==='false')await page.locator('#mobile-toggle').click();await page.locator('#reset-search').click();await expect(page.locator('#stop-search')).toHaveValue('');await expect(page.locator('#calculate')).toBeDisabled();expect(errors).toEqual([]);
});
async function mapSetup(page:import('@playwright/test').Page){
 await page.addInitScript(()=>{
  const Original=window.Worker;(window as any).searches=[];
  window.Worker=class extends Original{postMessage(data:any,options?:any){if(data.settings)(window as any).searches.push(data.settings);super.postMessage(data,options);}};
  document.addEventListener('sliso:map-ready',event=>{if((event.target as HTMLElement).id==='map')(window as any).testMap=(event as CustomEvent).detail;});
 });
 await page.goto('/');await expect(page.locator('#stop-search')).toBeEnabled();await page.locator('#time').fill('08:00');
}
async function position(page:import('@playwright/test').Page,lat=59.331,lon=18.058){
 await page.evaluate(p=>{(window as any).testMap.jumpTo({center:[p.lon,p.lat],zoom:16});},{lat,lon});
 return page.evaluate(p=>{const map=(window as any).testMap,c=map.project([p.lon,p.lat]),b=map.getContainer().getBoundingClientRect();return{x:b.x+c.x,y:b.y+c.y};},{lat,lon});
}
async function drag(page:import('@playwright/test').Page,p:{x:number;y:number},mobile:boolean){
 if(!mobile){await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+65,p.y+25,{steps:8});await page.mouse.up();return;}
 const touch=await page.context().newCDPSession(page);await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});
 for(let i=1;i<=8;i++){await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x+i*8,y:p.y+i*3}]});await page.waitForTimeout(25);}
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await touch.detach();
}
test('map clicks calculate immediately and replace results; double clicks and dragging only navigate',async({page},info)=>{
 await mapSetup(page);const mobile=info.project.name==='mobile';if(mobile)await page.locator('#mobile-close-search').click();
 let p=await position(page),zoom=await page.evaluate(()=>(window as any).testMap.getZoom());
 await page.mouse.dblclick(p.x,p.y,{delay:100});await expect.poll(()=>page.evaluate(()=>(window as any).testMap.getZoom())).toBeGreaterThan(zoom);
 await page.waitForTimeout(550);expect(await page.evaluate(()=>(window as any).searches.length)).toBe(0);
 p=await position(page);const center=await page.evaluate(()=>(window as any).testMap.getCenter().lng);await drag(page,p,mobile);
 await expect.poll(()=>page.evaluate(()=>(window as any).testMap.getCenter().lng)).not.toBe(center);await page.waitForTimeout(550);expect(await page.evaluate(()=>(window as any).searches.length)).toBe(0);
 p=await position(page);await page.mouse.click(p.x,p.y);await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 expect(await page.evaluate(()=>(window as any).searches.length)).toBe(1);await expect(page.locator('#stop-search')).toHaveValue('Vald kartpunkt');
 p=await position(page,59.3319,18.0592);await page.mouse.click(p.x,p.y);await expect.poll(()=>page.evaluate(()=>(window as any).searches.length)).toBe(2);await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 const source=await page.evaluate(()=>(window as any).searches.at(-1));expect(source.lat).toBeCloseTo(59.3319,4);expect(source.lon).toBeCloseTo(18.0592,4);
 if(mobile)await expect(page.locator('.panel')).toBeHidden();
 zoom=await page.evaluate(()=>(window as any).testMap.getZoom());await page.mouse.dblclick(p.x+45,p.y,{delay:100});await expect.poll(()=>page.evaluate(()=>(window as any).testMap.getZoom())).toBeGreaterThan(zoom);
 await page.waitForTimeout(550);expect(await page.evaluate(()=>(window as any).searches.length)).toBe(2);
 p=await position(page);await drag(page,p,mobile);await page.waitForTimeout(550);expect(await page.evaluate(()=>(window as any).searches.length)).toBe(2);
 // A station marker follows the same click/zoom contract as the map background.
 p=await position(page,59.331,18.0592);await page.mouse.click(p.x,p.y);await expect.poll(()=>page.evaluate(()=>(window as any).searches.length)).toBe(3);await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
 expect(await page.evaluate(()=>(window as any).searches.at(-1).stop)).toBe('demo-2');
 await position(page,59.331,18.0592);
 const pin=page.locator('.start-pin');const box=await pin.boundingBox();
 zoom=await page.evaluate(()=>(window as any).testMap.getZoom());await page.mouse.dblclick(box!.x+box!.width/2,box!.y+box!.height/2,{delay:100});await expect.poll(()=>page.evaluate(()=>(window as any).testMap.getZoom())).toBeGreaterThan(zoom);
 await page.waitForTimeout(550);expect(await page.evaluate(()=>(window as any).searches.length)).toBe(3);
});
test('a new map click supersedes an in-flight calculation and ignores its late data',async({page},info)=>{
 await mapSetup(page);if(info.project.name==='mobile')await page.locator('#mobile-close-search').click();
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);await page.route('**/*.bin',async r=>{await gate;await r.continue().catch(()=>{});});
 try{
  let p=await position(page);await page.mouse.click(p.x,p.y);await expect.poll(()=>page.evaluate(()=>(window as any).searches.length)).toBe(1);
  p=await position(page,59.3319,18.0592);await page.mouse.click(p.x,p.y);await expect.poll(()=>page.evaluate(()=>(window as any).searches.length)).toBe(2);await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
 }finally{release();}
 await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');await expect(page.locator('#start-data-gap')).toContainText('Gångstart på kartlagd väg');
 expect(await page.evaluate(()=>(window as any).searches.at(-1).lat)).toBeCloseTo(59.3319,4);await expect(page.locator('#form-error')).toBeHidden();
});
test('unmapped origins show a useful error and never fall back to straight-line access',async({page})=>{
 await page.goto('/#s='+encodeURIComponent(JSON.stringify({...point,lat:59.34})));
 await expect(page.locator('#form-error')).toContainText('Ingen kartlagd gångväg');await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
});
