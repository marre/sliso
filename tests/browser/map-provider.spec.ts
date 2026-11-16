import {test,expect} from '@playwright/test';

test('OpenFreeMap default style keeps credits accessible and uses responsive mobile attribution',async({page})=>{
 const styleURL='https://tiles.openfreemap.org/styles/liberty';
 await page.route(styleURL,r=>r.fulfill({json:{version:8,sources:{osm:{type:'vector',url:'https://tiles.openfreemap.org/test.json'}},layers:[{id:'base',type:'background',paint:{'background-color':'#e8eee4'}},{id:'land',type:'fill',source:'osm','source-layer':'land'}]}}));
 await page.route('https://tiles.openfreemap.org/test.json',r=>r.fulfill({json:{tilejson:'3.0.0',tiles:['https://tiles.openfreemap.org/test/{z}/{x}/{y}.pbf'],minzoom:0,maxzoom:14,attribution:'<a href="https://openmaptiles.org/">© OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>'}}));
 await page.route('https://tiles.openfreemap.org/test/**',r=>r.fulfill({body:Buffer.alloc(0)}));
 await page.goto('/');await expect(page.locator('#stop-search')).toBeEnabled();
 await page.evaluate(async()=>{
  const {createMap,MAP_STYLE}=await import('/src/map.ts');
  if(MAP_STYLE!=='https://tiles.openfreemap.org/styles/liberty')throw new Error('Unexpected default style');
  const el=document.createElement('div');el.id='provider-map';el.style.cssText='position:fixed;inset:0;z-index:10000';document.body.append(el);
  (window as any).providerMap=await createMap(el,[18,59.33],12,MAP_STYLE);
 });
 const attrib=page.locator('#provider-map .maplibregl-ctrl-attrib');
 const copy=page.locator('#provider-map .maplibregl-ctrl-attrib-inner');
 const toggle=page.locator('#provider-map .maplibregl-ctrl-attrib-button');
 await expect(copy).toContainText('© OpenMapTiles');
 await expect(copy).toContainText('© OpenStreetMap contributors');
 await expect(page.locator('#provider-map .maplibre-maptoolkit-logo-control')).toHaveCount(0);
 await expect(page.locator('#provider-map')).toHaveAttribute('data-basemap','openfreemap');
 await expect(copy.locator('a[href="https://openmaptiles.org/"]')).toHaveCount(1);
 await expect(copy.locator('a[href="https://www.openstreetmap.org/copyright"]')).toHaveCount(1);
 // The first view exposes the credit before it can be minimized by a gesture.
 await expect(copy).toBeVisible();
 await page.setViewportSize({width:320,height:568});
 await page.evaluate(()=>(window as any).providerMap.resize());
 await expect(copy).toBeVisible();
 await page.mouse.move(180,220);await page.mouse.down();await page.mouse.move(230,240,{steps:5});await page.mouse.up();
 await expect(attrib).toHaveClass(/maplibregl-compact/);
 await expect(attrib).not.toHaveClass(/maplibregl-compact-show/);
 await expect(toggle).toBeVisible();
 await expect(copy).toBeHidden();
 await toggle.click();
 await expect(copy).toBeVisible();
 await page.setViewportSize({width:844,height:390});
 await page.evaluate(()=>(window as any).providerMap.resize());
 await expect(attrib).not.toHaveClass(/maplibregl-compact/);
 await expect(copy).toBeVisible();
});
