/* Firebase web config is public; it is NOT a Gemini server credential. */
(() => {
 const config={projectId:'gen-lang-client-0580718541',appId:'1:714373498331:web:9ca598d4603eda9c9553fe',apiKey:'AIzaSyB2M8rFSHGlke4uS1qLvh_CTpF8yxp8HQY',authDomain:'gen-lang-client-0580718541.firebaseapp.com',firestoreDatabaseId:'ai-studio-aakasheceembedde-cbb0adda-8b7b-403c-a84c-887e93610453',storageBucket:'gen-lang-client-0580718541.firebasestorage.app',messagingSenderId:'714373498331'};
 let auth,db,fs,au,loading;
 const assetBase=new URL('.',document.currentScript.src);
 const sheet=document.createElement('link');sheet.rel='stylesheet';sheet.href=new URL('firebase-account.css?v=20261120-ui2',assetBase);document.head.append(sheet);
 const bar=document.createElement('dialog');bar.className='account-panel';bar.setAttribute('aria-labelledby','cloud-account-title');
 const heading=document.createElement('h2');heading.id='cloud-account-title';heading.textContent='Your account';
 const intro=document.createElement('p');intro.className='account-intro';intro.textContent='Sign in to keep your saved activity and bookmarks together across devices.';
 const close=document.createElement('button');close.className='account-close';close.textContent='×';close.setAttribute('aria-label','Close account');close.onclick=()=>bar.close();
 const launch=document.createElement('button');launch.className='account-launcher';launch.type='button';launch.textContent='Account';launch.setAttribute('aria-haspopup','dialog');launch.onclick=()=>{bar.showModal();prepareSignIn();};bar.addEventListener('close',()=>launch.focus());
 const target=document.querySelector('.top-links, .header-actions, #main-navigation');if(target)target.append(launch);else{const row=document.createElement('div');row.className='account-fallback';row.append(launch);document.body.prepend(row);}
 const login=document.createElement('button'),bookmark=document.createElement('button'),status=document.createElement('span');login.className='account-login';login.textContent='Continue with Google';bookmark.textContent='Bookmark this page';bookmark.hidden=true;status.setAttribute('role','status');bar.append(close,heading,intro,login,bookmark,status);document.body.append(bar);
 const message=s=>status.textContent=s;
 async function init(){if(loading)return loading;loading=(async()=>{const prefix='https://www.gstatic.com/firebasejs/11.10.0/';const [app,a,f]=await Promise.all([import(prefix+'firebase-app.js'),import(prefix+'firebase-auth.js'),import(prefix+'firebase-firestore.js')]);au=a;fs=f;const instance=app.getApps().length?app.getApp():app.initializeApp(config);auth=a.getAuth(instance);db=f.getFirestore(instance,config.firestoreDatabaseId);await new Promise(resolve=>a.onAuthStateChanged(auth,user=>{login.textContent=user?'Sign out':'Continue with Google';bookmark.hidden=!user;message(user?'Signed in as '+(user.displayName||'your account'):'Progress stays on this device until you sign in.');resolve();}));})().catch(e=>{loading=null;throw e;});return loading;}
 async function save(collection,id,data){if(!auth?.currentUser||!['testAttempts','bookmarks','orders'].includes(collection))return false;try{const uid=auth.currentUser.uid;await fs.setDoc(fs.doc(db,'users',uid,collection,String(id).replace(/\//g,'_')),{...JSON.parse(JSON.stringify(data)),updatedAt:fs.serverTimestamp()},{merge:true});message('Saved to your account.');return true;}catch{message('Cloud save unavailable. Your local progress is unchanged.');return false;}}
 function signInError(error){
  const code=error?.code||'auth/sdk-unavailable';
  const messages={
   'auth/popup-blocked':'Your browser blocked the sign-in window. Allow popups for this site, then try again.',
   'auth/popup-closed-by-user':'Sign-in was cancelled. You can continue without an account.',
   'auth/cancelled-popup-request':'Another sign-in window is already open.',
   'auth/unauthorized-domain':'Google sign-in is not enabled for this website domain.',
   'auth/operation-not-allowed':'Google sign-in has not been enabled for this Firebase project.',
   'auth/invalid-api-key':'The Firebase sign-in configuration needs to be corrected.',
   'auth/api-key-not-valid.-please-pass-a-valid-api-key.':'The Firebase sign-in configuration needs to be corrected.',
   'auth/network-request-failed':'Could not connect to Google sign-in. Check your connection and retry.',
   'auth/sdk-unavailable':'Sign-in could not load. Check your connection or content blocker, then reopen Account.'
  };
  message((messages[code]||'Sign-in could not finish. Please retry.')+' ('+code+')');
 }
 async function prepareSignIn(){
  login.disabled=true;login.textContent='Preparing secure sign-in…';
  try{await init();login.textContent=auth.currentUser?'Sign out':'Continue with Google';login.disabled=false;}
  catch(error){login.textContent='Sign-in unavailable';signInError(error);}
 }
 login.onclick=async()=>{
  if(!auth||!au)return;
  login.disabled=true;
  try{
   if(auth.currentUser){await au.signOut(auth);try{localStorage.removeItem('aakash.cloud.enabled');}catch{}return;}
   // Open directly within the user click, before any asynchronous work.
   const pending=au.signInWithPopup(auth,new au.GoogleAuthProvider());
   await pending;
   try{localStorage.setItem('aakash.cloud.enabled','1');}catch{}
   const u=auth.currentUser;
   try{
    const ref=fs.doc(db,'users',u.uid),old=await fs.getDoc(ref);
    await fs.setDoc(ref,{uid:u.uid,displayName:u.displayName||'',...(!old.exists()?{createdAt:fs.serverTimestamp()}:{}),updatedAt:fs.serverTimestamp()},{merge:true});
    await window.AakashAccount.syncLocal();
   }catch{message('Signed in successfully. Cloud saving is unavailable; your local progress is safe.');}
  }catch(error){signInError(error);}
  finally{login.disabled=false;login.textContent=auth.currentUser?'Sign out':'Continue with Google';}
 };

 bookmark.onclick=()=>save('bookmarks',encodeURIComponent(location.pathname),{url:location.origin+location.pathname,title:document.title});
 window.AakashAccount={save,async bestGuess(score){if(!auth?.currentUser)return;try{const ref=fs.doc(db,'users',auth.currentUser.uid);await fs.runTransaction(db,async tx=>{const snap=await tx.get(ref);const old=snap.data()?.bestGuessScore;if(!old||score<old)tx.set(ref,{bestGuessScore:score,updatedAt:fs.serverTimestamp()},{merge:true});});}catch{message('Score is saved locally; cloud sync is unavailable.');}},async list(collection){if(!auth?.currentUser)return [];if(!['testAttempts','bookmarks','orders'].includes(collection))return [];return (await fs.getDocs(fs.collection(db,'users',auth.currentUser.uid,collection))).docs.map(d=>({id:d.id,...d.data()}));},async syncLocal(){for(const key of Object.keys(localStorage)){if(key.startsWith('tclab.result.')){try{const result=JSON.parse(localStorage.getItem(key));await save('testAttempts',result.testId+'-'+(result.at||'latest'),result);}catch{}}}const score=Number(localStorage.getItem('bestScore'));if(score>0)await this.bestGuess(score);}};
 const saved=document.createElement('button');saved.textContent='My saved data';saved.onclick=async()=>{if(!auth?.currentUser){message('Sign in to view your saved data.');return;}try{const dialog=document.createElement('dialog');dialog.className='account-records';dialog.setAttribute('aria-label','Your saved data');const close=document.createElement('button');close.textContent='Close';close.onclick=()=>dialog.close();dialog.append(close);for(const name of ['testAttempts','bookmarks','orders']){const h=document.createElement('h3');h.textContent=({testAttempts:'Test history',bookmarks:'Bookmarks',orders:'Order history'})[name];dialog.append(h);for(const item of await window.AakashAccount.list(name)){const p=document.createElement('p');p.textContent=item.title||item.id;if(name==='bookmarks'&&typeof item.url==='string'&&item.url.startsWith('https://aakash9972sn.github.io/')){const a=document.createElement('a');a.href=item.url;a.textContent=p.textContent;p.replaceChildren(a);}dialog.append(p);}}document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();}catch{message('Saved data could not be loaded. Please retry.');}};bar.append(saved);
 try{if(localStorage.getItem('aakash.cloud.enabled'))init().catch(()=>message('Cloud connection unavailable. You can continue locally.'));}catch{}
})();
