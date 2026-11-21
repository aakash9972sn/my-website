/* Diagnostic-only: verifies which public AI routes actually exist.
   No API keys or private customer data are sent. */
const base="https://ais-pre-wdyrf6yb4psuwizvqpn4hw-374223411049.asia-northeast1.run.app";
const site="https://aakash9972sn.github.io";
async function probe(path,init={}) {
  try {
    const response=await fetch(base+path,{
      ...init,signal:AbortSignal.timeout(20000),
      headers:{Origin:site,...init.headers}
    });
    const type=response.headers.get('content-type')||'';
    const text=await response.text();
    const limited=text.slice(0,250);
    console.log(JSON.stringify({path,status:response.status,type,preview:limited.replace(/AIza[A-Za-z0-9_-]+/g,"[redacted]")}));
  }catch(e){
    console.log(JSON.stringify({path,error:e.name,detail:String(e.message).slice(0,150)}));
  }
}
await probe("/api/health");
await probe("/api/ai/shop-assistant",{
 method:"POST",headers:{"Content-Type":"application/json"},
 body:JSON.stringify({question:"Is this shopping assistant route available?",catalogSummary:"{}",cartSummary:"[]"})
});
await probe("/api/ai/chat/stream",{
 method:"POST",headers:{"Content-Type":"application/json"},
 body:JSON.stringify({question:"Briefly say hello.",history:[],pageContext:JSON.stringify({app:"shop",name:"Blunder"})})
});
