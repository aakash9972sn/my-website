/* Public API client. All model credentials are owned by the hosted backend. */
(() => {
 'use strict';
 const base='https://ais-pre-wdyrf6yb4psuwizvqpn4hw-374223411049.asia-northeast1.run.app';
 async function post(path,body,signal){
  const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal||AbortSignal.timeout(90000)});
  if(!response.ok)throw new Error(response.status===429?'AI usage limit reached. Please try later.':'AI service is unavailable. Please retry.');
  return response;
 }
 async function stream(body,signal,onText){
  const response=await post('/api/ai/chat/stream',body,signal);
  if(!response.body)throw new Error('The AI stream is unavailable.');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',answer='',grounding=null,done=false;
  function event(block){const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!raw)return; if(raw==='[DONE]'){done=true;return;}const data=JSON.parse(raw);if(data.error)throw new Error('AI could not finish the answer. Please retry.');if(typeof data.text==='string'){answer+=data.text;onText?.(answer);}if(data.grounding)grounding=data.grounding;if(data.done)done=true;}
  try{while(!done){const part=await reader.read();buffer+=(part.done?decoder.decode():decoder.decode(part.value,{stream:true})).replace(/\r\n/g,'\n');let end;while((end=buffer.indexOf('\n\n'))>=0){event(buffer.slice(0,end));buffer=buffer.slice(end+2);}if(part.done){if(buffer.trim())event(buffer);break;}}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  if(!done||!answer.trim())throw new Error('AI returned an incomplete answer. Please retry.');
  const chunks=grounding?.groundingChunks||grounding?.sources||[];
  const sources=chunks.map(c=>({title:c.web?.title||c.title||'Source',url:c.web?.uri||c.url})).filter(c=>{try{return new URL(c.url).protocol==='https:';}catch{return false;}});
  return {answer,sources,googleGrounded:sources.length>0};
 }
 async function request(body,signal,onText){
  if(body.action==='generate'){
   const subjects={'gate-em':'Engineering Mathematics','gate-nt':'Network Theory','gate-ss':'Signals and Systems','gate-dc':'Digital Circuits','gate-ac':'Analog Circuits','gate-ed':'Electronic Devices','gate-cs':'Control Systems','gate-comm':'Communications','gate-emt':'Electromagnetics','gate-ga':'General Aptitude','neet-bio':'Biology','neet-phy':'Physics','neet-chem':'Chemistry'};
   const r=await post('/api/ai/study-mcq',{exam:body.exam==='neet'?'NEET UG':'GATE ECE',subject:subjects[body.subject]||body.subject,topic:body.topic||'Important syllabus concepts',count:body.count,difficulty:({Easy:'Foundation',Medium:'Exam Standard',Hard:'Challenge',Mixed:'Exam Standard'})[body.difficulty]||'Exam Standard'},signal);const data=await r.json();if(!Array.isArray(data.questions))throw new Error('AI returned an invalid question set.');return {questions:data.questions.map(q=>({q:q.q,o:q.options,a:q.answerIndex,e:q.explanation,t:q.topic}))};
  }
  if(body.action==='doubt')return (await post('/api/ai/study-doubt',body.question,signal)).json();
  if(body.app==='shop')return (await post('/api/ai/shop-assistant',{question:body.question,catalogSummary:JSON.stringify(body.context||{}),cartSummary:JSON.stringify(window.BlunderAICart?.()||[])},signal)).json();
  return stream({question:body.question||'Review these completed test results and suggest a revision plan.',history:(body.history||[]).filter(m=>['user','assistant'].includes(m.role)).slice(-6),pageContext:JSON.stringify(body.context||body.stats||{}),mode:'balanced',grounding:body.action==='google_search'?'search':'none'},signal,onText);
 }
 async function transport(url,options={}){if(options.method==='GET'||url.endsWith('/health')){return fetch(base+'/api/health',{signal:options.signal});}return Response.json(await request(JSON.parse(options.body),options.signal));}
 window.HostedAI={base,request,stream,transport,post:async(path,body,signal)=>(await post('/api/ai/'+path,body,signal)).json(),liveVoiceURL:(persona,context='')=>base.replace('https:','wss:')+'/api/live-voice?'+new URLSearchParams({persona,context})};
})();
