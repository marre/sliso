import {journeyLines} from './map-data';
import {test,expect} from '@playwright/test';import {stockholmNow} from '../../src/core/time';
const settings={origin:'point',v:1,stop:'@point',name:'Vald kartpunkt',lat:59.319,lon:18.0725,date:stockholmNow().date,time:'08:00',maxMinutes:60,walkMinutes:15,maxTransfers:3,windowMinutes:30,modes:['bus','metro','rail','tram','boat']};
async function init(page:import('@playwright/test').Page){
 await page.route('https://tile.openstreetmap.org/**',r=>r.abort());
 await page.addInitScript(()=>{document.addEventListener('sliso:map-ready',event=>{if((event.target as HTMLElement).id==='map')(window as any).slisoMap=(event as CustomEvent).detail;});});
 await page.goto('/#s='+encodeURIComponent(JSON.stringify(settings)));await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');
}
async function position(page:import('@playwright/test').Page,lat=59.3319,lon=18.0592){
 await page.evaluate(({lat,lon})=>{(window as any).slisoMap.jumpTo({center:[lon,lat],zoom:16});},{lat,lon});
 return page.evaluate(({lat,lon})=>{const map=(window as any).slisoMap,p=map.project([lon,lat]),box=map.getContainer().getBoundingClientRect();return {x:box.x+p.x,y:box.y+p.y};},{lat,lon});
}
async function inspect(page:import('@playwright/test').Page,point:{x:number;y:number},mobile:boolean){
 if(!mobile){await page.mouse.click(point.x,point.y,{button:'right'});return;}
 const touch=await page.context().newCDPSession(page);
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});
 await page.waitForTimeout(800);
 await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await touch.detach();
}
test('arbitrary destination shows walk–transit–walk, pins and can become the next origin',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await init(page);const point=await position(page);
 await page.mouse.click(point.x,point.y);
 await expect(page.locator('#journey-title')).toHaveText('Vald målpunkt',{timeout:15000});
 await expect(page.locator('#journey-panel')).toContainText('Vald kartpunkt');await expect(page.locator('#journey-panel')).toContainText('Slutgång på kartlagd väg');
 const labels=await page.locator('.journey-leg-head strong').allTextContents();expect(labels).toHaveLength(3);expect(labels[0]).toBe('Gång');expect(labels[1]).toContain('Tunnelbana');expect(labels[2]).toBe('Gång');
 await expect.poll(()=>journeyLines(page,'walk')).toHaveLength(2);
 if(info.project.name==='desktop'){await inspect(page,point,false);await page.mouse.move(point.x+20,point.y+20);}
 await expect(page.locator('#journey-pin')).toContainText('Fäst ✓');
 await page.locator('#journey-expand').click();
 await page.screenshot({path:`test-results/${info.project.name}-point-destination.png`,fullPage:true});
 await page.locator('#journey-start').click();await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');await expect(page.locator('#journey-panel')).toBeHidden();await expect(page.locator('#stop-search')).toHaveValue('Vald kartpunkt');expect(errors).toEqual([]);
});
test('unmapped targets do not invent a final walking link and reset clears pending destinations',async({page},info)=>{
 await init(page);const point=await position(page,59.34,18.0592);await inspect(page,point,info.project.name==='mobile');
 await expect(page.locator('#point-status')).toContainText('Ingen kartlagd gångväg',{timeout:15000});await expect(page.locator('#journey-panel')).toBeHidden();
 const mapped=await position(page);await page.mouse.move(mapped.x,mapped.y);if(await page.locator('#mobile-toggle').isVisible()&&await page.locator('#mobile-toggle').getAttribute('aria-expanded')==='false')await page.locator('#mobile-toggle').click();await page.locator('#reset-search').click();await page.waitForTimeout(500);
 await expect(page.locator('#journey-panel')).toBeHidden();await expect(page.locator('#point-status')).toBeHidden();await expect(page.locator('#map')).not.toHaveAttribute('data-search-state','complete');
});

test('double clicking a result map zooms without pinning a destination',async({page})=>{
 await init(page);const point=await position(page);const zoom=await page.evaluate(()=>(window as any).slisoMap.getZoom());
 await page.mouse.dblclick(point.x,point.y,{delay:100});
 await expect.poll(()=>page.evaluate(()=>(window as any).slisoMap.getZoom())).toBeGreaterThan(zoom);
 await page.waitForTimeout(550);await expect(page.locator('#journey-pin[aria-pressed=true]')).toHaveCount(0);
});
