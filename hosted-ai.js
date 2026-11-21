/* Blunder AI: no browser API key. Calls the Node-hosted Gemini backend.
   A static GitHub Pages copy needs the public URL of that Node backend. */
(() => {
  "use strict";
  const isPages = /(^|\.)github\.io$/i.test(location.hostname);
  const candidate = String(window.BLUNDER_AI_API_ORIGIN || window.BLUNDER_API_ORIGIN || "").trim().replace(/\/+$/, "");
  let base = "";
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || (url.protocol === "http:" &&
        ["localhost","127.0.0.1"].includes(url.hostname))) base = url.origin;
    } catch (_) { /* Treat malformed configuration as missing. */ }
  }

  function endpoint(path) {
    if (!base && isPages) {
      throw new Error(
        "Blunder AI has no backend connected. GitHub Pages cannot run the Gemini server. " +
        "Deploy the Node backend with a private GEMINI_API_KEY, then set BLUNDER_AI_API_ORIGIN in store-config.js."
      );
    }
    return (base || location.origin) + path;
  }
  function explainHTTP(status, data) {
    if (typeof data?.error === "string" && data.error.trim())
      return data.error.slice(0, 250);
    if (status === 429) return "Gemini's free usage limit was reached. Try again later.";
    if (status === 404) return "This AI server does not support Blunder's Gemini chat route.";
    if (status === 403) return "Blunder's backend rejected this site. Check STOREFRONT_ORIGIN.";
    return "AI server returned HTTP " + status + ". Try again later.";
  }
  async function post(path, payload, signal) {
    let response;
    try {
      response = await fetch(endpoint(path), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json"
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: signal || AbortSignal.timeout(45000)
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw error;
      throw new Error("Cannot connect to Blunder's AI backend. Check backend URL, deployment and CORS.");
    }
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("text/html")) {
      throw new Error("The configured AI server returned an HTML webpage, not an AI response. " +
        "Connect the deployed Blunder Node backend instead of the old hosted app URL.");
    }
    if (!response.ok) {
      let data;
      if (type.includes("application/json")) {
        try { data = await response.json(); } catch (_) {}
      }
      throw new Error(explainHTTP(response.status, data));
    }
    return { response, type };
  }
  async function request(body, signal, onText) {
    if (!body || typeof body.question !== "string") throw new Error("Type a question first.");
    const payload = {
      question: body.question.slice(0,700),
      history: (Array.isArray(body.history) ? body.history : []).slice(-6).map(x=>({
        role: x.role === "assistant" ? "assistant" : "user",
        content: String(x.content || "").slice(0,800)
      })),
      pageContext: JSON.stringify(body.context || {}).slice(0,2600)
    };
    const {response,type} = await post("/api/ai/chat/stream",payload,signal);
    if (type.includes("application/json")) {
      const data = await response.json();
      if (typeof data?.answer !== "string" || !data.answer.trim())
        throw new Error("Gemini did not return an answer.");
      onText?.(data.answer);
      return data;
    }
    if (!type.includes("text/event-stream") || !response.body)
      throw new Error("AI backend returned an unexpected response format.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer="", answer="", done=false;
    function event(block) {
      const raw = block.split("\n").filter(line=>line.startsWith("data:"))
        .map(line=>line.slice(5).trimStart()).join("\n");
      if (!raw) return;
      if (raw === "[DONE]") { done=true; return; }
      let data;
      try { data=JSON.parse(raw); } catch (_) {
        throw new Error("AI returned malformed stream data.");
      }
      if (data.error) throw new Error(String(data.error).slice(0,250));
      if (typeof data.text==="string" && data.text.length) {
        answer += data.text;
        onText?.(answer.slice(0,8000));
      }
      if (data.done) done=true;
    }
    try {
      while(!done) {
        const part = await reader.read();
        const chunk = part.done ? decoder.decode() : decoder.decode(part.value,{stream:true});
        buffer += chunk.replace(/\r\n/g,"\n");
        let end;
        while((end=buffer.indexOf("\n\n"))>=0) {
          event(buffer.slice(0,end));
          buffer=buffer.slice(end+2);
          if(done)break;
        }
        if(part.done){if(buffer.trim())event(buffer);break;}
      }
    } finally {
      await reader.cancel().catch(()=>{});
      reader.releaseLock();
    }
    if(!answer.trim())throw new Error("Gemini returned an empty answer.");
    return {answer:answer.slice(0,8000)};
  }
  async function health(signal) {
    const res=await fetch(endpoint("/api/ai/health"), {
      method:"GET",cache:"no-store",signal:signal||AbortSignal.timeout(10000)
    });
    if(!(res.headers.get("content-type")||"").includes("application/json"))
      throw new Error("The AI health route returned HTML, not a real backend.");
    if(!res.ok)throw new Error("AI backend health check returned HTTP "+res.status);
    const result=await res.json();
    if(result.ok!==true || result.mode!=="server-side-gemini")
      throw new Error("The configured backend is not Blunder's Gemini API.");
    return result;
  }
  async function transport(_url,options={}) {
    if(options.method==="GET")return fetch(endpoint("/api/ai/health"),{signal:options.signal});
    return Response.json(await request(JSON.parse(options.body),options.signal));
  }
  window.HostedAI=Object.freeze({base,request,health,transport,configured:()=>!!base||!isPages});
})();