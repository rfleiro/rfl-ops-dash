/* ─────────────────────────────────────────────────────────────────────────────
   DashCore — shared engine for all dashboards in this repo.

   A dashboard is a folder with an index.html that loads this file and calls
   DashCore.start(manifest). Everything identifying (data repo, token) is
   supplied by the user at runtime and stored per-dashboard in localStorage.

   Manifest shape:
     id          string   short slug, e.g. "ops". Namespaces all storage keys.
     title       string   shown in the header
     briefPath   string   path to the JSON payload inside the data repo
     topics      [string] topic options offered when creating an item
     topicColors {topic:{bg,tx}}
     sections    [{label, filter(item), allowNew}]
     newLabels   [string] labels applied to items created from the dashboard
     dateField   {default,person} wording of the due-date field
   ───────────────────────────────────────────────────────────────────────────── */
"use strict";

window.DashCore = (function(){

const API = "https://api.github.com";

// ── manifest + runtime state ─────────────────────────────────────────────────
let M      = null;
let REPO   = "";
let TOKEN  = "";
let view   = "boot";        // setup | loading | ready | error
let errMsg = "";
let BRIEF  = null;
let S      = {ch:{},nt:[]};
let panels = {};
let showNF = false;
let syncing= false;
let results= null;
let lastLoad = null;
const TODAY = new Date().toISOString().slice(0,10);

// ── storage keys, namespaced per dashboard ───────────────────────────────────
function K(suffix){ return "dash:" + M.id + ":" + suffix; }
function ls(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

// ── icons ────────────────────────────────────────────────────────────────────
const IC = {
  check:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  msg:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  cal:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  ext:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  x:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  plus:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  warn:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  refresh:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  up:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  eye:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
  ok:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  bad:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  dot:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>`,
  load:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  back:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
};

// ── helpers ──────────────────────────────────────────────────────────────────
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function dc(d){ if(!d) return ""; if(d<TODAY) return "overdue"; if(d===TODAY) return "today"; return ""; }
function fd(d){ if(!d) return ""; const p=String(d).split("-"); return p[2]+"/"+p[1]; }
function hhmm(d){ return d.toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"}); }
function tc(t){ return (M.topicColors && M.topicColors[t]) || {bg:"#eee",tx:"#555"}; }
function ttag(t){ const c=tc(t); return "<span class='tag' style='background:"+c.bg+";color:"+c.tx+"'>"+esc(t)+"</span>"; }

// ── state ────────────────────────────────────────────────────────────────────
function stateKey(){ return K("state:" + (BRIEF ? BRIEF.date : "none")); }
function loadState(){ try{ S = JSON.parse(ls(stateKey())) || {ch:{},nt:[]}; }catch(e){ S={ch:{},nt:[]}; } }
function save(){ lsSet(stateKey(), JSON.stringify(S)); }
function ch(n){ return S.ch[n] || {}; }
function setCh(n,p){ S.ch[n] = Object.assign({}, ch(n), p); save(); render(); }

// ── GitHub API ───────────────────────────────────────────────────────────────
async function api(path, method, body){
  const h = {
    "Authorization":"Bearer " + TOKEN,
    "Accept":"application/vnd.github+json",
    "X-GitHub-Api-Version":"2022-11-28"
  };
  if(body) h["Content-Type"] = "application/json";
  let r;
  try{
    r = await fetch(API + path, {method:method||"GET", headers:h, body: body?JSON.stringify(body):undefined, cache:"no-store"});
  }catch(e){ throw new Error("Sin conexión con GitHub. Comprueba la red."); }
  if(!r.ok){
    let msg = String(r.status);
    try{ const j = await r.json(); if(j && j.message) msg += " · " + j.message; }catch(e){}
    if(r.status===401) msg = "401 · Token inválido o revocado.";
    if(r.status===404) msg = "404 · No encontrado. Comprueba el repo configurado y que el token tenga acceso.";
    if(r.status===403) msg += " · Permisos insuficientes o rate limit.";
    throw new Error(msg);
  }
  return r.status===204 ? null : r.json();
}
function b64utf8(b64){
  const bin = atob(String(b64).replace(/\s/g,""));
  const b = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(b);
}

async function loadBrief(){
  if(!TOKEN || !REPO){ view="setup"; render(); return; }
  view="loading"; render();
  try{
    const f = await api("/repos/"+REPO+"/contents/"+M.briefPath+"?ref=HEAD&t="+Date.now());
    BRIEF = JSON.parse(b64utf8(f.content));
    BRIEF.items    = BRIEF.items    || [];
    BRIEF.calendar = BRIEF.calendar || [];
    BRIEF.meta     = BRIEF.meta     || {};
    BRIEF.meta.warnings = BRIEF.meta.warnings || [];
    loadState();
    lastLoad = new Date();
    view="ready";
  }catch(e){
    errMsg = e.message || String(e);
    view="error";
  }
  render();
}

// ── pending actions ──────────────────────────────────────────────────────────
function actions(){
  const a=[];
  if(!BRIEF) return a;
  Object.keys(S.ch).forEach(function(n){
    const c=S.ch[n];
    const it=BRIEF.items.find(i=>String(i.number)===String(n));
    const t=it?it.title:"#"+n;
    if(c.done)    a.push({kind:"done",      number:+n,title:t,field:"done"});
    if(c.log)     a.push({kind:"log",       number:+n,title:t,text:c.log,field:"log"});
    if(c.newDate) a.push({kind:"reschedule",number:+n,title:t,newDate:c.newDate,itemType:it?it.type:"task",field:"newDate"});
  });
  S.nt.forEach(function(t,i){ a.push({kind:"create",idx:i,title:t.title,topic:t.topic,due:t.due,note:t.note}); });
  return a;
}

async function exec(a){
  const base = "/repos/"+REPO+"/issues";
  if(a.kind==="done"){
    await api(base+"/"+a.number,"PATCH",{state:"closed"});
  } else if(a.kind==="log"){
    await api(base+"/"+a.number+"/comments","POST",{body:"**"+BRIEF.date+"** — "+a.text});
  } else if(a.kind==="reschedule"){
    const iss = await api(base+"/"+a.number);
    const label = a.itemType==="person" ? M.dateField.person : M.dateField.default;
    let body = iss.body || "";
    const re = new RegExp("📅\\s*(" + M.dateField.default + "|" + M.dateField.person + ")\\s*:\\s*\\d{4}-\\d{2}-\\d{2}");
    const line = "📅 " + label + ": " + a.newDate;
    body = re.test(body) ? body.replace(re,line) : (line + "\n\n" + body);
    await api(base+"/"+a.number,"PATCH",{body:body});
  } else if(a.kind==="create"){
    const b = "📅 " + M.dateField.default + ": " + (a.due||"") + "\n\n## Notes\n" + (a.note||"");
    await api(base,"POST",{title:a.title, labels:(M.newLabels||[]).concat([a.topic]), body:b});
  }
}

function pruneSynced(){
  const okCreates=[];
  results.forEach(function(r){
    if(r.status!=="ok") return;
    if(r.kind==="create") okCreates.push(r.idx);
    else if(S.ch[r.number]){
      delete S.ch[r.number][r.field];
      if(!Object.keys(S.ch[r.number]).length) delete S.ch[r.number];
    }
  });
  S.nt = S.nt.filter((_,i)=>okCreates.indexOf(i)===-1);
  save();
}

async function runList(list){
  for(let i=0;i<list.length;i++){
    list[i].status="running"; renderModal();
    try{ await exec(list[i]); list[i].status="ok"; }
    catch(e){ list[i].status="err"; list[i].error = e.message||String(e); }
    renderModal();
  }
}
async function runSync(){
  const acts = actions();
  if(!acts.length || syncing) return;
  syncing = true;
  results = acts.map(a=>Object.assign({},a,{status:"pending"}));
  openModal(); renderModal();
  await runList(results);
  pruneSynced();
  syncing = false; renderModal(); render();
}
async function retryFailed(){
  const failed = results.filter(r=>r.status==="err");
  if(!failed.length) return;
  syncing = true;
  failed.forEach(r=>{ r.status="pending"; delete r.error; });
  renderModal();
  await runList(failed);
  pruneSynced();
  syncing = false; renderModal(); render();
}

// ── hide settled items until synced ───────────────────────────────────────────
// An item counts as "settled" once it's been ticked done or given a new date —
// the decision is made, it's just waiting to be pushed. Logging a note doesn't
// settle anything, so logged items stay visible.
let hideSettled = true;   // set per-dashboard in start()
function isSettled(item){ const c = ch(item.number); return !!(c.done || c.newDate); }
function settledCount(){ return BRIEF ? BRIEF.items.filter(isSettled).length : 0; }
function toggleHide(){
  hideSettled = !hideSettled;
  lsSet(K("hide"), hideSettled ? "1" : "0");
  render();
}

// ── new item form ────────────────────────────────────────────────────────────
function addTask(){
  const t = document.getElementById("nt-t");
  const title = t ? t.value.trim() : "";
  if(!title){ document.getElementById("nt-err").textContent = "Título obligatorio."; return; }
  S.nt.push({
    title: title,
    topic: document.getElementById("nt-tp").value,
    due:   document.getElementById("nt-d").value || null,
    note:  document.getElementById("nt-n").value.trim() || null
  });
  showNF = false; save(); render();
}
function rmTask(i){ S.nt.splice(i,1); save(); render(); }

// ── panels ───────────────────────────────────────────────────────────────────
function toggleP(n,w){
  const cur = panels[n]||{};
  panels[n]={log:false,date:false}; panels[n][w]=!cur[w];
  render();
}
function saveLog(n){
  const v=document.getElementById("lt-"+n).value.trim();
  if(v) setCh(n,{log:v}); else { panels[n]={}; render(); }
}
function saveDate(n){
  const v=document.getElementById("dt-"+n).value;
  if(v) setCh(n,{newDate:v}); else { panels[n]={}; render(); }
}

// ── config ───────────────────────────────────────────────────────────────────
function saveConfig(){
  const rp = document.getElementById("rp").value.trim()
    .replace(/^https?:\/\/github\.com\//,"").replace(/\.git$/,"").replace(/\/+$/,"");
  const tk = document.getElementById("tk").value.trim();
  const e  = document.getElementById("tk-err");
  if(!/^[\w.-]+\/[\w.-]+$/.test(rp)){ e.textContent = "Formato del repo: owner/nombre"; return; }
  if(!tk){ e.textContent = "Pega el token."; return; }
  REPO = rp; TOKEN = tk;
  lsSet(K("repo"),rp); lsSet(K("pat"),tk);
  loadBrief();
}
function resetConfig(){
  if(!confirm("Borrar el repo y el token guardados para «"+M.id+"» en este dispositivo?")) return;
  REPO=""; TOKEN=""; lsDel(K("repo")); lsDel(K("pat"));
  view="setup"; render();
}

// ── modal ────────────────────────────────────────────────────────────────────
function openModal(){ document.getElementById("overlay").classList.add("open"); }
function closeModal(){
  if(syncing) return;
  document.getElementById("overlay").classList.remove("open");
  results=null; if(BRIEF) render();
}
function renderModal(){
  const m = document.getElementById("modal");
  if(!results){ m.innerHTML=""; return; }
  const ok  = results.filter(r=>r.status==="ok").length;
  const bad = results.filter(r=>r.status==="err").length;
  const KL = {done:"cerrar issue",log:"comentario",reschedule:"nueva fecha",create:"crear item"};
  let h = "<h2>"+(syncing?"Sincronizando…":"Sync completado")+"</h2>";
  h += "<p>"+ok+" de "+results.length+" correctos"+(bad?" · <span style='color:var(--danger)'>"+bad+" con error</span>":"")+"</p><div class='mbody'>";
  results.forEach(function(r){
    const cls = r.status==="ok"?"ok":r.status==="err"?"err":"";
    const ico = r.status==="ok"?IC.ok:r.status==="err"?IC.bad:r.status==="running"?"<span class='spin'>"+IC.load+"</span>":IC.dot;
    h += "<div class='srow "+cls+"'><span class='st'>"+ico+"</span><div class='srow-t'>"
       + "<div class='srow-k'>"+(KL[r.kind]||r.kind)+(r.number?" · #"+r.number:"")+"</div>"+esc(r.title)
       + (r.error?"<div class='srow-e'>"+esc(r.error)+"</div>":"")+"</div></div>";
  });
  h += "</div><div class='mbtns'>";
  if(bad && !syncing) h += "<button class='btn' onclick='DashCore.retryFailed()'>Reintentar fallos</button>";
  h += "<button class='btn "+(syncing?"":"btn-p")+"' onclick='DashCore.closeModal()' "+(syncing?"disabled":"")+">"+(syncing?"Espera…":"Cerrar")+"</button></div>";
  m.innerHTML = h;
}

// ── render ───────────────────────────────────────────────────────────────────
function card(item){
  const n=item.number, c=ch(n), p=panels[n]||{};
  const dd=c.newDate||item.due, dcs=dc(dd), done=!!c.done;
  const isTask=item.type==="task", isPerson=item.type==="person";
  const dlabel = isPerson ? "Próximo seguimiento" : "Fecha límite";
  return "<div class='card "+dcs+(done?" done":"")+"'>"
    + "<div class='card-row'><span class='card-title"+(done?" struck":"")+"'>"+esc(item.title)+"</span><div class='acts'>"
    + (isTask?"<button class='act"+(done?" on-green":"")+"' onclick='DashCore.setCh("+n+",{done:"+(!done)+"})' title='"+(done?"Deshacer":"Hecho")+"'>"+IC.check+"</button>":"")
    + "<button class='act"+(p.log?" on":"")+"' onclick='DashCore.toggleP("+n+",\"log\")' title='Log'>"+IC.msg+"</button>"
    + "<button class='act"+(p.date?" on":"")+"' onclick='DashCore.toggleP("+n+",\"date\")' title='"+dlabel+"'>"+IC.cal+"</button>"
    + (item.url?"<a class='act' href='"+esc(item.url)+"' target='_blank' rel='noopener' title='GitHub'>"+IC.ext+"</a>":"")
    + "</div></div><div class='card-meta'>"+ttag(item.topic)
    + (dd?"<span class='chip "+dcs+"'>"+(dcs==="overdue"?"atrasado · ":"")+fd(dd)+(c.newDate?" ✓":"")+"</span>":"")
    + (c.log?"<span class='chip logged'>"+IC.msg+" log</span>":"")
    + "</div>"
    + (item.note?"<div class='cnote'>"+esc(item.note)+"</div>":"")
    + (p.log?"<div class='panel'><textarea id='lt-"+n+"' placeholder='Nota…'>"+esc(c.log||"")+"</textarea>"
       + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleP("+n+",\"log\")'>Cancelar</button>"
       + "<button class='btn btn-p' onclick='DashCore.saveLog("+n+")'>Guardar</button></div></div>":"")
    + (p.date?"<div class='panel'><div class='pfield'><label>"+dlabel+"</label>"
       + "<input type='date' id='dt-"+n+"' value='"+(dd||"")+"'></div>"
       + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleP("+n+",\"date\")'>Cancelar</button>"
       + "<button class='btn btn-p' onclick='DashCore.saveDate("+n+")'>Fijar</button></div></div>":"")
    + "</div>";
}

function render(){
  const app = document.getElementById("app");

  if(view==="setup"){
    app.innerHTML = "<div class='center'>"
      + "<a class='back' href='../'>"+IC.back+" dashboards</a>"
      + "<h2>"+esc(M.title)+"<span class='hdr-id'>"+esc(M.id)+"</span></h2>"
      + "<p>Indica el repositorio de datos y un token con acceso a él. Ambos se guardan sólo en este dispositivo, para este dashboard.</p>"
      + "<div class='steps'><ol>"
      + "<li>Crea un token en <a href='https://github.com/settings/personal-access-tokens/new' target='_blank' rel='noopener'>Settings → Developer settings → Fine-grained tokens</a></li>"
      + "<li><b>Repository access</b> → Only select repositories → el repo de datos</li>"
      + "<li><b>Permissions</b> → Contents: <code>Read</code> · Issues: <code>Read and write</code></li>"
      + "</ol></div>"
      + "<div class='pfield' style='margin-bottom:8px'><label>Repositorio de datos</label>"
      + "<input id='rp' type='text' placeholder='owner/repo' autocomplete='off' spellcheck='false'></div>"
      + "<div class='pfield'><label>Token</label>"
      + "<input id='tk' type='password' placeholder='github_pat_…' autocomplete='off' spellcheck='false'></div>"
      + "<p class='err' id='tk-err'></p>"
      + "<div class='pbtns' style='margin-top:10px'><button class='btn btn-p' onclick='DashCore.saveConfig()'>Guardar y entrar</button></div>"
      + "<p class='muted'>Nada queda registrado en este sitio. Las peticiones van sólo a api.github.com.</p></div>";
    ["rp","tk"].forEach(function(id){
      document.getElementById(id).addEventListener("keydown",function(e){ if(e.key==="Enter") saveConfig(); });
    });
    document.getElementById("rp").focus();
    return;
  }

  if(view==="loading"){
    app.innerHTML = "<div class='load'><span class='spin'>"+IC.load+"</span> Cargando…</div>";
    return;
  }

  if(view==="error"){
    app.innerHTML = "<div class='center'>"
      + "<a class='back' href='../'>"+IC.back+" dashboards</a>"
      + "<h2>No se pudo cargar</h2><div class='ebox'>"+esc(errMsg)+"</div>"
      + (errMsg.indexOf("404")===0 ? "<p>Si el repo y el token son correctos, puede que aún no exista <code>"+esc(M.briefPath)+"</code>. Pide a Claude que lo genere.</p>" : "")
      + "<div class='pbtns'><button class='lnk' onclick='DashCore.resetConfig()'>Cambiar repo/token</button>"
      + "<button class='btn btn-p' onclick='DashCore.loadBrief()'>Reintentar</button></div></div>";
    return;
  }

  const meta = BRIEF.meta, cal = BRIEF.calendar, items = BRIEF.items;
  const n = actions().length;
  const nSettled = settledCount();

  let h = "<div class='wrap'>";
  h += "<a class='back' href='../'>"+IC.back+" dashboards</a>";
  h += "<div class='hdr'><div><h1>"+esc(M.title)+"<span class='hdr-id'>"+esc(M.id)+"</span></h1>"
     + "<div class='hdr-date'>"+esc(new Date().toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"long"}))+"</div></div>"
     + "<div class='hdr-r'>"
     + "<button class='btn btn-icon' onclick='DashCore.loadBrief()' title='Recargar'>"+IC.refresh+"</button>"
     + (nSettled ? "<button class='btn btn-icon"+(hideSettled?" on":"")+"' onclick='DashCore.toggleHide()' title='"
         + (hideSettled ? "Mostrar "+nSettled+" resuelto(s)" : "Ocultar "+nSettled+" resuelto(s) hasta sincronizar")
         + "'>"+(hideSettled?IC.eyeOff:IC.eye)+"</button>" : "")
     + "<button class='btn "+(n?"btn-p pulse":"")+"' onclick='DashCore.runSync()' "+(n?"":"disabled")+">"
     + IC.up + (n?" Sync ("+n+")":" Sync") + "</button></div></div>";

  if(BRIEF.date !== TODAY)
    h += "<div class='warn'>"+IC.warn+" Los datos son del "+fd(BRIEF.date)+". Pide a Claude que los actualice.</div>";
  meta.warnings.forEach(function(w){ h += "<div class='warn'>"+IC.warn+" "+esc(w)+"</div>"; });
  if(meta.summary) h += "<div class='summary'>"+esc(meta.summary)+"</div>";

  if(cal.length){
    h += "<div class='sec'><div class='sec-hdr'><span class='sec-label'>Hoy</span></div><div class='cal-list'>"
      + cal.map(e=>"<div class='cal-row'><span class='cal-time'>"+(e.allDay?"":esc(e.time))+"</span><span class='cal-ev'>"+esc(e.title)+"</span>"+(e.allDay?"<span class='cal-ad'>todo el día</span>":"")+"</div>").join("")
      + "</div></div>";
  }

  (M.sections||[]).forEach(function(sec){
    const all    = items.filter(sec.filter);
    const hidden = hideSettled ? all.filter(isSettled) : [];
    const list   = hideSettled ? all.filter(i=>!isSettled(i)) : all;
    if(!all.length && !sec.allowNew) return;
    h += "<div class='sec'><div class='sec-hdr'><span class='sec-label'>"+esc(sec.label)+"</span>"
       + (sec.allowNew?"<button class='sec-add' onclick='DashCore.toggleNew()'>"+IC.plus+" nuevo</button>":"")
       + "</div>";
    if(sec.allowNew && showNF){
      h += "<div class='nform'>"
        + "<div class='field'><label>Título</label><input id='nt-t' type='text' placeholder='Admin — enviar X'></div>"
        + "<div class='grid'><div class='field'><label>Topic</label><select id='nt-tp'>"
        + (M.topics||[]).map(t=>"<option>"+esc(t)+"</option>").join("")+"</select></div>"
        + "<div class='field'><label>Fecha límite</label><input id='nt-d' type='date' value='"+TODAY+"'></div></div>"
        + "<div class='field'><label>Nota (opcional)</label><textarea id='nt-n' placeholder='Contexto…'></textarea></div>"
        + "<p class='err' id='nt-err'></p>"
        + "<div class='pbtns' style='margin-top:8px'><button class='btn' onclick='DashCore.toggleNew()'>Cancelar</button>"
        + "<button class='btn btn-p' onclick='DashCore.addTask()'>Añadir</button></div></div>";
    }
    h += list.map(card).join("");
    if(sec.allowNew){
      h += S.nt.map(function(t,i){
        const c=tc(t.topic);
        return "<div class='card isnew'><div class='card-row'><span class='card-title'>"+esc(t.title)+"</span>"
          + "<div class='acts'><button class='act rm' onclick='DashCore.rmTask("+i+")'>"+IC.x+"</button></div></div>"
          + "<div class='card-meta'><span class='tag' style='background:"+c.bg+";color:"+c.tx+"'>"+esc(t.topic)+"</span>"
          + (t.due?"<span class='chip'>"+fd(t.due)+"</span>":"")+"<span class='chip new'>nuevo</span></div>"
          + (t.note?"<div class='cnote'>"+esc(t.note)+"</div>":"")+"</div>";
      }).join("");
    }
    if(hidden.length){
      h += "<div class='hidden-row'>"+hidden.length+" oculto"+(hidden.length===1?"":"s")
         + " hasta sincronizar <button class='lnk' onclick='DashCore.toggleHide()'>mostrar</button></div>";
    }
    h += "</div>";
  });

  h += "<div class='foot'><span>"+esc(BRIEF.date)+(lastLoad?" · "+hhmm(lastLoad):"")+"</span>"
     + "<button class='lnk' onclick='DashCore.resetConfig()'>cambiar repo/token</button></div></div>";

  app.innerHTML = h;
}

// ── start ────────────────────────────────────────────────────────────────────
function start(manifest){
  M = Object.assign({
    id:"dash", title:"dash", briefPath:"brief/today.json",
    topics:[], topicColors:{}, sections:[], newLabels:[],
    dateField:{default:"Due", person:"Next follow-up"}
  }, manifest);
  REPO  = ls(K("repo")) || "";
  TOKEN = ls(K("pat"))  || "";
  const hv = ls(K("hide"));
  hideSettled = (hv === null) ? true : (hv === "1");
  document.title = M.title;
  document.getElementById("overlay").addEventListener("click", function(e){
    if(e.target.id==="overlay") closeModal();
  });
  document.addEventListener("visibilitychange", function(){
    if(!document.hidden && view==="ready" && lastLoad && (Date.now()-lastLoad.getTime())>600000) loadBrief();
  });
  loadBrief();
}

return {
  start, loadBrief, saveConfig, resetConfig,
  setCh, toggleP, saveLog, saveDate,
  addTask, rmTask, toggleNew:function(){ showNF=!showNF; render(); },
  runSync, retryFailed, toggleHide, closeModal
};
})();
