import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
const http=createServer(async(req,res)=>{
  let path;
  try{
    const requested=new URL(req.url||'/', 'http://127.0.0.1');
    path=resolve(join(root,decodeURIComponent(requested.pathname==='/'?'/index.html':requested.pathname).replace(/^\/+/,'')));
    if(!path.startsWith(root+'/'))throw new Error('Forbidden');
    const body=await readFile(path);
    res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store'}).end(body);
  }catch(_){res.writeHead(404).end('Not found')}
});
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await page.route('https://maps.google.com/**',r=>r.fulfill({
  status:200,contentType:'text/html',body:'<!doctype html><html><body>Google Maps preview test fixture</body></html>'
}));
await page.route('https://nominatim.openstreetmap.org/search**',r=>r.fulfill({
  status:200,contentType:'application/json',body:JSON.stringify([{
    lat:'28.740000',lon:'77.110000',
    display_name:'Example Road, Rohini Sector 16, New Delhi, Delhi, India',
    address:{road:'Example Road',suburb:'Rohini Sector 16',city:'New Delhi',
      state:'Delhi',postcode:'110001',country_code:'in'}
  }])
}));
await page.route('https://nominatim.openstreetmap.org/reverse**',r=>r.fulfill({
  status:200,contentType:'application/json',body:JSON.stringify({
    lat:'28.740000',lon:'77.110000',
    display_name:'Example Road, New Delhi, India',
    address:{road:'Example Road',city:'New Delhi',state:'Delhi',postcode:'110001',country_code:'in'}
  })
}));
try{
  await page.goto('http://127.0.0.1:'+http.address().port+'/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.locator('#product-grid .product-card').first().waitFor({timeout:20000});
  await page.locator('.delivery-button').first().click();
  await page.locator('#delivery-dialog[open]').waitFor({timeout:8000});
  const iframe=page.locator('iframe#delivery-map');
  assert.equal(await iframe.count(),1);
  let url=new URL(await iframe.getAttribute('src'));
  assert.equal(url.hostname,'maps.google.com');
  assert.match(url.searchParams.get('q'),/Delhi Technological University/);
  // Regression: already typed hostel room survives a provider-based address pick.
  await page.locator('#location-address').fill('Room 204, Aryabhatta Hostel');
  await page.getByRole('button',{name:'Rohini Sec-16'}).click();
  url=new URL(await iframe.getAttribute('src'));
  assert.match(url.searchParams.get('q'),/Rohini Sector 16/);
  await page.locator('#location-results button').first().waitFor({timeout:15000});
  await page.locator('#location-results button').first().click();
  assert.equal(await page.locator('#location-address').inputValue(),
    'Room 204, Aryabhatta Hostel, Example Road, Rohini Sector 16');
  assert.equal(await page.locator('#location-city').inputValue(),'New Delhi');
  assert.equal(await page.locator('#location-state').inputValue(),'Delhi');
  assert.equal(await page.locator('#delivery-pin').inputValue(),'110001');
  assert.equal(await page.locator('#location-route').isVisible(),true);
  assert.match(await page.locator('#location-route').getAttribute('href'),/www.google.com\/maps\/dir\/\?api=1&destination=/);
  await page.locator('#location-confirm').click();
  await page.waitForFunction(()=>!document.querySelector('#delivery-dialog').open);
  const selected=await page.evaluate(()=>window.BlunderLocation.getSelection());
  assert.equal(selected.pincode,'110001');
  assert.equal(selected.city,'New Delhi');
  assert.equal(selected.address,'Room 204, Aryabhatta Hostel, Example Road, Rohini Sector 16');
  assert.ok(selected.point);

  // Mock an upstream 429 after reopening the picker. The customer must still
  // be able to enter a valid manual address and confirm without provider access.
  await page.route('https://nominatim.openstreetmap.org/search**',
    r=>r.fulfill({status:429,body:'Rate limited'}));
  await page.locator('.delivery-button').first().click();
  await page.locator('#delivery-dialog[open]').waitFor({timeout:8000});
  await page.locator('#location-address').fill('Flat 17, Market Street');
  await page.locator('#location-city').fill('New Delhi');
  await page.locator('#location-state').fill('Delhi');
  await page.locator('#delivery-pin').fill('110042');
  await page.locator('#location-search').fill('Rohini market');
  await page.locator('#location-search-button').click();
  await page.waitForFunction(()=>
    /unavailable|busy|manually|address/i.test(document.querySelector('#location-status').textContent)
    && !document.querySelector('#location-search-button').disabled,
    null,{timeout:20000});
  assert.equal(await page.locator('#location-address').inputValue(),'Flat 17, Market Street');
  assert.equal(await page.locator('#delivery-pin').inputValue(),'110042');
  assert.equal(await page.locator('#location-confirm').isEnabled(),true);
  await page.locator('#location-confirm').click();
  await page.waitForFunction(()=>!document.querySelector('#delivery-dialog').open);
  const manual = await page.evaluate(()=>window.BlunderLocation.getSelection());
  assert.equal(manual.address,'Flat 17, Market Street');
  assert.equal(manual.pincode,'110042');
  console.log('PASS: Google Maps location selection preserves hostel room; provider 429 still allows manual address and checkout confirmation.');
  if(errors.length)console.log('Page console errors:',JSON.stringify(errors.slice(0,8)));
}finally{
  try{await page.screenshot({path:'google-map-preview.png',fullPage:true})}catch(_){}
  await browser.close();await new Promise(resolve=>http.close(resolve));
}
