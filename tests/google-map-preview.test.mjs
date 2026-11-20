import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const [html,location,css,config,server,script]=await Promise.all([
  'index.html','location.js','location.css','store-config.js',
  'server/index.mjs','script.js'
].map(p=>readFile(new URL(p,root),'utf8')));

test('Blunder delivery dialog renders Google Maps iframe, not Leaflet tiles',()=>{
  assert.match(html,/<iframe[^>]+id="delivery-map"/);
  assert.match(html,/id="location-route"/);
  assert.match(html,/Full interactive Google Maps/);
  assert.doesNotMatch(html, /<script[^>]+assets\/vendor\/leaflet/);
  assert.doesNotMatch(html, /<link[^>]+assets\/vendor\/leaflet/);
  assert.match(location,/https:\/\/maps\.google\.com\/maps\?q=/);
  assert.match(location,/&hl=en&output=embed/);
  assert.doesNotMatch(location,/L\.map|L\.tileLayer|L\.marker/);
  assert.doesNotMatch(css,/\.leaflet-container/);
});

test('DTU and Rohini searches retain address selection and GPS',()=>{
  for (const label of ['DTU Main Gate','DTU Boys Hostels','Rohini Sec-16'])
    assert.ok(html.includes(label),'Missing '+label+' quick search');
  assert.match(location,/data-location-preset/);
  assert.match(location, /request\("search", \{ query \}/);
  assert.match(location, /request\("reverse", point, operation\.signal\)/);
  assert.match(location,/callbacks\.onSelect\?\.\(getSelection\(\), "confirm"\)/);
  assert.match(location,/sessionStorage\.setItem/);
  assert.match(location,/navigator\.geolocation\.getCurrentPosition/);
  assert.match(html,/id="delivery-pin"/);
  assert.match(html,/id="location-address"/);
  assert.match(config,/searchUrl: "https:\/\/nominatim.openstreetmap.org\/search"/);
  assert.match(config,/reverseUrl: "https:\/\/nominatim.openstreetmap.org\/reverse"/);
});

test('route link uses Maps URLs (free; no API keys) and checkout remains connected',()=>{
  assert.match(location, /https:\/\/www.google.com\/maps\/dir\/\?api=1&destination=/);
  assert.match(location, /https:\/\/www.google.com\/maps\/search\/\?api=1&query=/);
  assert.match(script,/Route in Google Maps ↗/);
  assert.match(script,/window\.BlunderLocation\.open\(seed\)/);
  assert.match(script,/applyDeliverySelection\(selection\)/);
  assert.match(html,/id="location-confirm"/);
  assert.doesNotMatch(location,/maps\.googleapis\.com\/maps\/api\/js|AIza[A-Za-z0-9_-]+/);
});

test('production CSP explicitly allows only the Google iframe origins',()=>{
  assert.match(server,/frame-src[^;]*https:\/\/maps.google.com https:\/\/www.google.com/);
  assert.doesNotMatch(server,/img-src[^;]*tile\.openstreetmap/);
});
