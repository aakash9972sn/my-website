import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createAIService, AIServiceError } from "../server/ai.mjs";
import { createApp, loadSettings } from "../server/index.mjs";
import { createCommerce } from "../server/commerce.mjs";

const root = new URL("../", import.meta.url);
const frontend = await readFile(new URL("hosted-ai.js", root), "utf8");
const html = await readFile(new URL("index.html", root), "utf8");
const storeConfig = await readFile(new URL("store-config.js", root), "utf8");

function ai({key="test-private-gemini-key", status=200, payload=null}={}) {
  const captures=[];
  const service=createAIService({
    env:{GEMINI_API_KEY:key,GEMINI_MODEL:"gemini-3.1-flash-lite",AI_DAILY_LIMIT:"3"},
    fetchImpl: async(url,opts)=>{
      captures.push({url,opts});
      return new Response(payload || JSON.stringify({candidates:[
        {content:{parts:[{text:"Product prices should come from the supplied catalogue."}]}}
      ]}),{status,headers:{"Content-Type":"application/json"}});
    }
  });
  return {service,captures};
}
const sample={
  question:"Please suggest an affordable grocery basket.",
  history:[{role:"user",content:"I like vegetables."}],
  pageContext:JSON.stringify({products:[{name:"Tomato",price:1000}]})
};

test("private Gemini backend has explicit health, safe response and same model as portfolio ZIP",async()=>{
  const {service,captures}=ai();
  const health=service.health();
  assert.equal(health.configured,true);
  assert.equal(health.model,"gemini-3.1-flash-lite");
  assert.equal(health.mode,"server-side-gemini");
  assert.ok(!JSON.stringify(health).includes("test-private-gemini-key"));
  const result=await service.answer(sample);
  assert.match(result.answer,/Product prices/);
  assert.equal(captures.length,1);
  assert.match(captures[0].url,/gemini-3\.1-flash-lite:generateContent/);
  assert.equal(captures[0].opts.headers["x-goog-api-key"],"test-private-gemini-key");
  const provider=JSON.parse(captures[0].opts.body);
  assert.match(provider.contents.at(-1).parts[0].text,/Tomato/);
  assert.match(provider.contents.at(-1).parts[0].text,/grocery basket/);
  assert.ok(!JSON.stringify(result).includes("test-private-gemini-key"));
});

test("backend refuses missing keys, quota exhaustion, invalid questions and provider errors",async()=>{
  await assert.rejects(
    createAIService({env:{}}).answer(sample),
    e=>e instanceof AIServiceError && e.status===503 && /configured/i.test(e.message)
  );
  const {service}=ai();
  await assert.rejects(service.answer({...sample,question:"x"}),
    e=>e.status===400);
  await service.answer(sample);
  await service.answer(sample);
  await service.answer(sample);
  await assert.rejects(service.answer(sample),e=>e.status===429);
  const failing=ai({status:429}).service;
  await assert.rejects(failing.answer(sample),e=>e.status===429);
  const htmlProvider=ai({payload:"<html>not AI</html>"}).service;
  await assert.rejects(htmlProvider.answer(sample),e=>e.status===502);
});

test("Blunder Node serves health and valid SSE chat with CORS, even with checkout disabled",async t=>{
  const {service}=ai();
  const settings=loadSettings({STORE_ENABLED:"false"});
  const commerce=createCommerce(settings);
  const app=createApp({settings,commerce,aiService:service,
    env:{NODE_ENV:"production",PUBLIC_ORIGIN:"https://blunder-api.example",
      STOREFRONT_ORIGIN:"https://aakash9972sn.github.io"}});
  const server=createServer(app.handler);
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await app.close();});
  const base="http://127.0.0.1:"+server.address().port;
  const headers={Origin:"https://aakash9972sn.github.io","Content-Type":"application/json"};
  const health=await fetch(base+"/api/ai/health",{headers});
  assert.equal(health.status,200);
  assert.equal(health.headers.get("Access-Control-Allow-Origin"),headers.Origin);
  assert.equal((await health.json()).configured,true);

  const answer=await fetch(base+"/api/ai/chat/stream",{method:"POST",headers,body:JSON.stringify(sample)});
  assert.equal(answer.status,200);
  assert.match(answer.headers.get("Content-Type"),/text\/event-stream/);
  const stream=await answer.text();
  assert.match(stream,/data: \{"text":/);
  assert.match(stream,/data: \{"done":true\}/);
  const js=await fetch(base+"/hosted-ai.js");
  assert.equal(js.status,200);
  assert.match(js.headers.get("Content-Type"),/text\/javascript/);
  const forbidden=await fetch(base+"/api/ai/health",{
    headers:{Origin:"https://wrong-origin.example"}
  });
  assert.equal(forbidden.status,403);
});

function loadFrontend(options={}) {
  const window={BLUNDER_AI_API_ORIGIN: options.base || "",BLUNDER_API_ORIGIN:""};
  const location={hostname:"aakash9972sn.github.io",origin:"https://aakash9972sn.github.io"};
  const fetcher=options.fetcher || (async()=>{throw Error("Request should not be sent")});
  new Function("window","location","fetch","URL","AbortSignal","TextDecoder","Response",
    frontend)(window,location,fetcher,URL,AbortSignal,TextDecoder,Response);
  return window.HostedAI;
}

test("GitHub Pages without a deployed Node backend shows a clear error, not endless loading",async()=>{
  const client=loadFrontend();
  assert.equal(client.configured(),false);
  await assert.rejects(client.request({question:"Find groceries"}),
    /GitHub Pages cannot run the Gemini server/);
});

test("client reads complete streamed answer, never calls the abandoned shop-assistant route",async()=>{
  const called=[];
  const client=loadFrontend({base:"https://blunder-api.example",fetcher:async(url,opts)=>{
    called.push({url,opts});
    return new Response('data: {"text":"Hello "}\n\ndata: {"text":"from Gemini."}\n\ndata: {"done":true}\n\n',{
      status:200,headers:{"Content-Type":"text/event-stream"}
    });
  }});
  const updates=[];
  const data=await client.request({
    action:"assistant",app:"shop",question:"What products are here?",
    context:{products:[{name:"Tomato"}]}
  },undefined,text=>updates.push(text));
  assert.equal(data.answer,"Hello from Gemini.");
  assert.equal(updates.at(-1),"Hello from Gemini.");
  assert.equal(called.length,1);
  assert.equal(called[0].url,"https://blunder-api.example/api/ai/chat/stream");
  assert.ok(!called[0].url.includes("/shop-assistant"));
  assert.match(called[0].opts.body,/Tomato/);
});

test("client rejects a 200 HTML page rather than treating it as a real AI response",async()=>{
  const client=loadFrontend({base:"https://broken-api.example",fetcher:async()=>
    new Response("<!doctype html><html>Not an AI API</html>",{
      headers:{"Content-Type":"text/html"},status:200
    })
  });
  await assert.rejects(client.request({question:"Hello Gemini"}),
    /returned an HTML webpage/);
});

test("script order loads public backend config before AI client; no browser key is committed",()=>{
  assert.match(html,/hosted-ai\.js\?v=20261121-ai1" defer/);
  assert.ok(html.indexOf("store-config.js")<html.indexOf("hosted-ai.js"));
  assert.match(storeConfig,/BLUNDER_AI_API_ORIGIN/);
  assert.ok(!/AIza[A-Za-z0-9_-]+/.test(frontend));
  assert.ok(!frontend.includes("ais-pre-wdyrf6yb4psuwizvqpn4hw"));
});
