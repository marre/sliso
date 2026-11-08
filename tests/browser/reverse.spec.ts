import {test,expect,type Page} from '@playwright/test';
import {stockholmNow,stockholmInstant} from '../../src/core/time';
import {journeyLines} from './map-data';
const query={v:1,direction:'arrive',origin:'point',stop:'@point',name:'Vald kartpunkt',lat:59.319,lon:18.0725,date:stockholmNow().date,time:'09:00',maxMinutes:60,walkMinutes:15,maxTransfers:3,windowMinutes:30,modes:['bus','metro','rail','tram','boat']};
async function openPanel(page:Page){if(await page.locator('#mobile-toggle').isVisible()&&await page.locator('#mobile-toggle').getAttribute('aria-expanded')==='false')await page.locator('#mobile-toggle').click();}

test('arrive-by mode selects a destination, shows chronological journeys, shares and switches back',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.locator('#stop-search')).toBeEnabled();
 await page.locator('#direction').selectOption('arrive');await expect(page.locator('#place-label')).toHaveText('Vart vill du komma?');await expect(page.locator('#time-label')).toHaveText('Senast framme');await expect(page.locator('#window')).toBeHidden();
 await page.locator('#stop-search').fill('T-Centralen');await page.locator('#stop-search').press('ArrowDown');await page.locator('#stop-search').press('Enter');await page.locator('#time').fill('09:00');await page.locator('#calculate').click();
 await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');await expect(page.locator('#status')).toContainText('kan nå målet');await expect(page.locator('#map-label')).toHaveText('TILL T-CENTRALEN');
 await page.getByRole('button',{name:'Slussen · Testläge A',exact:true}).press('Enter');await expect(page.locator('#journey-panel .eyebrow')).toHaveText('FRÅN');
 const times=await page.locator('.journey-times time').evaluateAll(nodes=>nodes.map(n=>Date.parse(n.getAttribute('datetime')!)/1000));
 expect(times).toHaveLength(2);expect(times[0]).toBeLessThan(times[1]);expect(times[1]).toBeLessThanOrEqual(stockholmInstant(query.date,query.time));
 await expect.poll(async()=>(await journeyLines(page,'transit')).length).toBeGreaterThan(0);
 await page.locator('#journey-expand').click();
 await page.screenshot({path:`test-results/${test.info().project.name}-arrive-by.png`,fullPage:true});
 await page.getByRole('button',{name:'Stäng resedetaljer'}).click();await page.locator('#share').click();expect(JSON.parse(decodeURIComponent(new URL(page.url()).hash.slice(3))).direction).toBe('arrive');
 await page.reload();await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');await expect(page.locator('#direction')).toHaveValue('arrive');
 await openPanel(page);await page.locator('#direction').selectOption('depart');await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');await expect(page.locator('#time-label')).toHaveText('Avresetid');await expect(page.locator('#map-label')).toHaveText('FRÅN T-CENTRALEN');expect(errors).toEqual([]);
});

test('reverse point destination includes incoming walking layer and a walk–transit–walk origin preview',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{document.addEventListener('sliso:map-ready',event=>{if((event.target as HTMLElement).id==='map')(window as any).reverseMap=(event as CustomEvent).detail;});});
 await page.goto('/#s='+encodeURIComponent(JSON.stringify(query)));await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');await expect(page.locator('#start-data-gap')).toContainText('Gångmål');
 await expect(page.locator('#walking-status')).toContainText('ungefärlig visningsbredd',{timeout:15000});
 expect(await page.locator('canvas.walking-raster').evaluate((canvas:HTMLCanvasElement)=>canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data.some(v=>v>0))).toBe(true);
 await page.evaluate(()=>{(window as any).reverseMap.jumpTo({center:[18.0592,59.3319],zoom:16});});
 const p=await page.evaluate(()=>{const map=(window as any).reverseMap,p=map.project([18.0592,59.3319]),box=map.getContainer().getBoundingClientRect();return {x:box.x+p.x,y:box.y+p.y};});
 if(info.project.name==='desktop')await page.mouse.click(p.x,p.y,{button:'right'});
 else {const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await page.waitForTimeout(800);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
 await expect(page.locator('#journey-title')).toHaveText('Vald startpunkt',{timeout:15000});
 expect(await page.locator('.journey-leg-head strong').allTextContents()).toEqual(['Gång','Tunnelbana · 14','Gång']);
 await expect.poll(()=>journeyLines(page,'walk')).toHaveLength(2);await expect(page.locator('#journey-panel')).toContainText('Vald kartpunkt');
 await page.getByRole('button',{name:'Stäng resedetaljer'}).click();await openPanel(page);await page.locator('#reset-search').click();await expect(page.locator('canvas.walking-raster')).toHaveCount(0);await expect(page.locator('#direction')).toHaveValue('arrive');expect(errors).toEqual([]);
});

test('arrival mode ignores an invalid departure window instead of blocking the form',async({page})=>{
 await page.goto('/');await expect(page.locator('#stop-search')).toBeEnabled();
 await page.locator('#options').evaluate((el:HTMLDetailsElement)=>el.open=true);await page.locator('#window').fill('');
 await page.locator('#direction').selectOption('arrive');await expect(page.locator('#window')).toBeDisabled();
 await page.locator('#stop-search').fill('T-Centralen');await page.locator('#stop-search').press('ArrowDown');await page.locator('#stop-search').press('Enter');await page.locator('#time').fill('09:00');
 await page.locator('#calculate').click();await expect(page.locator('#map')).toHaveAttribute('data-search-state','complete');await expect(page.locator('#form-error')).toBeHidden();
});
