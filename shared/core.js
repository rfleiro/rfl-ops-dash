/* ─────────────────────────────────────────────────────────────────────────────
   DashCore — shared engine for all dashboards in this repo.

   DATA MODEL — three layers, read in this order
   ─────────────────────────────────────────────
     1. brief      <briefPath>          generated each morning by Claude.
                                        Read-only for the dashboard.
     2. journal    <changesPath>        written ONLY by the dashboard.
                                        Every edit lands here, never in issues.
     3. local      localStorage         edits not yet pushed to the journal.

   Effective state = brief, overlaid with journal, overlaid with local.

   The dashboard never writes to issues. Claude applies the journal to issues at
   end of day, then clears it and regenerates the brief. That keeps a single
   writer to the issue tracker, so a reload can never show a stale or
   contradictory view, and edits survive across devices.

   Journal shape:
     { date, updated,
       changes: { "<issue#>": {done:true, log:"…", newDate:"YYYY-MM-DD"} },
       created: [ {cid, title, topic, due, note} ] }

   Manifest:
     id, title, briefPath, changesPath, topics, topicColors,
     sections:[{label,filter,allowNew}], dateField:{default,person}
   ───────────────────────────────────────────────────────────────────────────── */
"use strict";

window.DashCore = (function(){

const API = "https://api.github.com";
const BUILD = "20260910-1030";

let M       = null;
let REPO    = "";
let TOKEN   = "";
let view    = "boot";      // setup | loading | ready | error
let errMsg  = "";
let BRIEF   = null;
let J       = null;        // journal (server)
let J_SHA   = null;        // journal file sha, null when it doesn't exist yet
let S       = {ch:{},nt:[],rm:[],bd:[],bdrm:[],ib:{}};   // local, unpushed
let panels  = {};
let bdPanels = {};
let showNF  = false;
let showBD  = false;
let saving  = false;
let saveRes = null;
let lastLoad= null;
let hideSettled = true;
let COLL = {};
let WDISM = {};
const TODAY = new Date().toISOString().slice(0,10);

// ── storage, namespaced per dashboard ────────────────────────────────────────
function K(s){ return "dash:" + M.id + ":" + s; }
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
  load:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  back:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  star:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  starOn:`<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  clock:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`,
  edit:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  chevDown:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  chevRight:`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
};

// ── helpers ──────────────────────────────────────────────────────────────────
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function dc(d){ if(!d) return ""; if(d<TODAY) return "overdue"; if(d===TODAY) return "today"; return ""; }
function fd(d){ if(!d) return ""; const p=String(d).split("-"); return p[2]+"/"+p[1]; }
function hhmm(d){ return d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"}); }
function tc(t){ return (M.topicColors && M.topicColors[t]) || {bg:"#eee",tx:"#555"}; }
function ttag(t){ const c=tc(t); return "<span class='tag' style='background:"+c.bg+";color:"+c.tx+"'>"+esc(t)+"</span>"; }
function emptyJournal(date){ return {date:date, updated:null, changes:{}, created:[], braindump:[], inbox:{}}; }

// ── local layer ──────────────────────────────────────────────────────────────
function localKey(){ return K("local:" + (BRIEF ? BRIEF.date : "none")); }
function loadLocal(){
  try{ S = JSON.parse(ls(localKey())) || {}; }catch(e){ S = {}; }
  S.ch = S.ch || {}; S.nt = S.nt || []; S.rm = S.rm || [];
  S.bd = S.bd || []; S.bdrm = S.bdrm || []; S.ib = S.ib || {};
}
function saveLocal(){ lsSet(localKey(), JSON.stringify(S)); }

// ── effective state: journal overlaid with local ─────────────────────────────
const FIELDS = ["done","log","reminder","deadline"];
function jch(n){ return (J && J.changes[String(n)]) || {}; }
function lch(n){ return S.ch[String(n)] || {}; }
function eff(n){
  const out = Object.assign({}, jch(n));
  const l = lch(n);
  FIELDS.forEach(function(f){
    if(!(f in l)) return;
    const v = l[f];
    if(v === false || v === null || v === "") delete out[f];
    else out[f] = v;
  });
  return out;
}

// ── stars: dashboard-only, and only for today ────────────────────────────────
// Deliberately not part of the journal and never written to the issues. A star
// says "this is what I'm on right now", which is a today statement, so it is
// kept in localStorage under the brief's date and starts empty each morning.
let STAR = {};
function starKey(){ return K("star:" + (BRIEF ? BRIEF.date : "none")); }
function loadStars(){ try{ STAR = JSON.parse(ls(starKey())) || {}; }catch(e){ STAR = {}; } }
function isStarred(n){ return !!STAR[String(n)]; }
function toggleStar(n){
  const k = String(n);
  if(STAR[k]) delete STAR[k]; else STAR[k] = true;
  lsSet(starKey(), JSON.stringify(STAR));
  render();
}
// inbox items come from the brief and have no issue number; the journal records
// only what was decided about them: converted to a task, or dismissed.
function jib(id){ return (J && J.inbox && J.inbox[id]) || null; }
function lib(id){ return (id in S.ib) ? S.ib[id] : undefined; }
function effIb(id){
  const l = lib(id);
  if(l === undefined) return jib(id);
  return (l === null) ? null : l;          // explicit null = undo the decision
}
function inboxItems(){ return (BRIEF && BRIEF.inbox) || []; }
function effBraindump(){
  const fromJ = (J ? J.braindump : []).filter(b => S.bdrm.indexOf(b.id) === -1)
                                      .map(b => Object.assign({}, b, {queued:true}));
  const fromL = S.bd.map(b => Object.assign({}, b, {queued:false}));
  return fromJ.concat(fromL).sort((a,b) => String(b.ts).localeCompare(String(a.ts)));
}
function effCreated(){
  const fromJ = (J ? J.created : []).filter(c => S.rm.indexOf(c.cid) === -1)
                                    .map(c => Object.assign({}, c, {queued:true}));
  const fromL = S.nt.map(c => Object.assign({}, c, {queued:false}));
  return fromJ.concat(fromL);
}
// how many edits are sitting unpushed in localStorage
function localCount(){
  let n = 0;
  Object.keys(S.ch).forEach(function(k){
    const j = jch(k), l = S.ch[k];
    FIELDS.forEach(function(f){
      if(!(f in l)) return;
      const v = l[f], had = (f in j);
      if(v === false || v === null || v === ""){ if(had) n++; }
      else if(j[f] !== v) n++;
    });
  });
  let ib = 0;
  Object.keys(S.ib).forEach(function(id){
    const l = S.ib[id], j = jib(id);
    if(l === null){ if(j) ib++; }
    else if(!j || j.status !== l.status) ib++;
  });
  return n + S.nt.length + S.rm.length + S.bd.length + S.bdrm.length + ib;
}
// how many edits are in the journal, waiting for Claude
function queuedCount(){
  if(!J) return 0;
  let n = 0;
  Object.keys(J.changes).forEach(k => { n += Object.keys(J.changes[k]).filter(f=>FIELDS.indexOf(f)>=0).length; });
  return n + J.created.length + J.braindump.length + Object.keys(J.inbox||{}).length;
}
function setCh(n,p){
  const key = String(n);
  S.ch[key] = Object.assign({}, lch(key), p);
  saveLocal(); render();
}

// ── settled / hide ───────────────────────────────────────────────────────────
function isSettled(item){ const c = eff(item.number); return !!(c.done || c.reminder); }
function settledCount(){ return BRIEF ? BRIEF.items.filter(isSettled).length : 0; }
function toggleHide(){
  hideSettled = !hideSettled;
  lsSet(K("hide"), hideSettled ? "1" : "0");
  render();
}
function collKey(){ return K("coll"); }
function loadColl(){ try{ COLL = JSON.parse(ls(collKey())) || {}; }catch(e){ COLL = {}; } }
function isCollapsed(id){ return !!COLL[id]; }
function toggleSection(id){ COLL[id] = !COLL[id]; lsSet(collKey(), JSON.stringify(COLL)); render(); }
function wdismKey(){ return K("wdism:"+(BRIEF?BRIEF.date:"none")); }
function loadWdism(){ try{ WDISM = JSON.parse(ls(wdismKey())) || {}; }catch(e){ WDISM = {}; } }
function dismissWarn(i){ WDISM[i]=true; lsSet(wdismKey(),JSON.stringify(WDISM)); render(); }
function secChev(id){ return "<button class='sec-chev' onclick='DashCore.toggleSection(\""+id+"\")' title='"+(isCollapsed(id)?"Expand":"Collapse")+"'>"+(isCollapsed(id)?IC.chevRight:IC.chevDown)+"</button>"; }

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
  }catch(e){ throw new Error("Can't reach GitHub. Check your connection."); }
  if(!r.ok){
    let msg = String(r.status);
    try{ const j = await r.json(); if(j && j.message) msg += " · " + j.message; }catch(e){}
    if(r.status===401) msg = "401 · Token invalid or revoked.";
    if(r.status===404) msg = "404 · Not found. Check the configured repo and that the token has access.";
    if(r.status===403) msg += " · Insufficient permissions, or rate limited.";
    if(r.status===409 || r.status===422) msg = String(r.status) + " · Conflict — someone else changed the journal. Reload and try again.";
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
function utf8b64(str){
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ── load ─────────────────────────────────────────────────────────────────────
async function fetchJournal(){
  try{
    const f = await api("/repos/"+REPO+"/contents/"+M.changesPath+"?ref=HEAD&t="+Date.now());
    J_SHA = f.sha;
    const parsed = JSON.parse(b64utf8(f.content));
    parsed.changes   = parsed.changes   || {};
    parsed.created   = parsed.created   || [];
    parsed.braindump = parsed.braindump || [];
    parsed.inbox     = parsed.inbox     || {};
    // a journal left over from an earlier day is not ours — start clean
    J = (parsed.date === BRIEF.date) ? parsed : emptyJournal(BRIEF.date);
  }catch(e){
    if(String(e.message).indexOf("404") === 0){ J = emptyJournal(BRIEF.date); J_SHA = null; }
    else throw e;
  }
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
    await fetchJournal();
    loadLocal();
    loadStars();
    loadColl();
    loadWdism();
    lastLoad = new Date();
    view="ready";
  }catch(e){
    errMsg = e.message || String(e);
    view="error";
  }
  render();
}

// ── push local edits into the journal ────────────────────────────────────────
function mergeLocalInto(j){
  Object.keys(S.ch).forEach(function(key){
    const src = S.ch[key];
    const dst = Object.assign({}, j.changes[key] || {});
    FIELDS.forEach(function(f){
      if(!(f in src)) return;
      const v = src[f];
      if(v === false || v === null || v === "") delete dst[f];
      else dst[f] = v;
    });
    if(Object.keys(dst).length) j.changes[key] = dst; else delete j.changes[key];
  });
  j.created = j.created.filter(c => S.rm.indexOf(c.cid) === -1);
  S.nt.forEach(function(t){
    if(!j.created.some(c => c.cid === t.cid)) j.created.push(t);
  });
  j.braindump = (j.braindump || []).filter(b => S.bdrm.indexOf(b.id) === -1);
  S.bd.forEach(function(b){
    if(!j.braindump.some(x => x.id === b.id)) j.braindump.push(b);
  });
  j.braindump.sort((a,b) => String(a.ts).localeCompare(String(b.ts)));
  j.inbox = j.inbox || {};
  Object.keys(S.ib).forEach(function(id){
    const l = S.ib[id];
    if(l === null) delete j.inbox[id]; else j.inbox[id] = l;
  });
  j.date = BRIEF.date;
  j.updated = new Date().toISOString();
  return j;
}

async function push(){
  if(saving) return;
  if(!localCount()){ return; }
  saving = true; saveRes = null; openModal(); renderModal();
  try{
    // re-read first, so concurrent edits from another device aren't clobbered
    await fetchJournal();
    const merged = mergeLocalInto(J);
    const body = {
      message: M.id + ": journal " + BRIEF.date,
      content: utf8b64(JSON.stringify(merged, null, 2) + "\n")
    };
    if(J_SHA) body.sha = J_SHA;
    const res = await api("/repos/"+REPO+"/contents/"+M.changesPath, "PUT", body);
    J_SHA = res.content.sha;
    J = merged;
    S = {ch:{},nt:[],rm:[],bd:[],bdrm:[],ib:{}};
    saveLocal();
    saveRes = {ok:true, queued:queuedCount()};
  }catch(e){
    saveRes = {ok:false, error: e.message || String(e)};
  }
  saving = false; renderModal(); render();
}

// ── new items ────────────────────────────────────────────────────────────────
function cid(){ return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,7); }
function addTask(){
  const el = document.getElementById("nt-t");
  const title = el ? el.value.trim() : "";
  if(!title){ document.getElementById("nt-err").textContent = "Title is required."; return; }
  S.nt.push({
    cid:      cid(),
    title:    title,
    topic:    document.getElementById("nt-tp").value,
    due:      document.getElementById("nt-d").value || null,
    deadline: document.getElementById("nt-dl").value || null,
    note:     document.getElementById("nt-n").value.trim() || null
  });
  showNF = false; saveLocal(); render();
}
function dismissInbox(id){
  const cur = effIb(id);
  S.ib[id] = (cur && cur.status === "dismissed") ? null
           : {status:"dismissed", ts:new Date().toISOString()};
  saveLocal(); render();
}
function undoInbox(id){ S.ib[id] = null; saveLocal(); render(); }
function toggleIB(id){
  const cur = panels["ib-"+id] || {};
  panels["ib-"+id] = {open: !cur.open};
  render();
}
function convertInbox(id){
  const t = document.getElementById("ib-t-"+id);
  const title = t ? t.value.trim() : "";
  if(!title){ document.getElementById("ib-err-"+id).textContent = "Title is required."; return; }
  S.nt.push({
    cid:   "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,7),
    title: title,
    topic: document.getElementById("ib-tp-"+id).value,
    due:   document.getElementById("ib-d-"+id).value || null,
    note:  document.getElementById("ib-n-"+id).value.trim() || null,
    from:  "inbox:" + id
  });
  S.ib[id] = {status:"task", ts:new Date().toISOString()};
  panels["ib-"+id] = {};
  saveLocal(); render();
}
function toggleBD(){ showBD = !showBD; render(); }
function addBraindump(){
  const ta = document.getElementById("bd-t");
  const text = ta ? ta.value.trim() : "";
  if(!text){ document.getElementById("bd-err").textContent = "Nothing to add."; return; }
  const kindEl = document.getElementById("bd-k");
  S.bd.push({
    id:   "b-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,7),
    ts:   new Date().toISOString(),
    kind: kindEl ? kindEl.value : "note",
    text: text
  });
  showBD = false; saveLocal(); render();
}
function rmBraindump(id){
  const i = S.bd.findIndex(b => b.id === id);
  if(i >= 0){ S.bd.splice(i,1); }
  else if(S.bdrm.indexOf(id) === -1){ S.bdrm.push(id); }
  saveLocal(); render();
}
function toggleBDEdit(id){
  const cur = bdPanels[id] || {};
  bdPanels[id] = {editing: !cur.editing};
  render();
}
function saveBDEdit(id){
  const el = document.getElementById("bdet-" + id);
  const v = el ? el.value.trim() : "";
  if(v){
    const i = S.bd.findIndex(b => b.id === id);
    if(i >= 0){ S.bd[i].text = v; }
    else {
      const q = J ? J.braindump.find(b => b.id === id) : null;
      if(q){ const copy = Object.assign({}, q, {text: v}); if(S.bdrm.indexOf(id)===-1) S.bdrm.push(id); S.bd.push(copy); }
    }
    saveLocal();
  }
  bdPanels[id] = {}; render();
}
function rmTask(c){
  const i = S.nt.findIndex(t => t.cid === c);
  if(i >= 0){ S.nt.splice(i,1); }
  else if(S.rm.indexOf(c) === -1){ S.rm.push(c); }   // queued item — mark for removal
  saveLocal(); render();
}

// ── new-task panels ──────────────────────────────────────────────────────────
function ensureNtLocal(cid_val, mutate){
  const i = S.nt.findIndex(t => t.cid === cid_val);
  if(i >= 0){ mutate(S.nt[i]); return; }
  const q = J ? J.created.find(c => c.cid === cid_val) : null;
  if(q){ const copy = Object.assign({}, q); mutate(copy); if(S.rm.indexOf(cid_val)===-1) S.rm.push(cid_val); S.nt.push(copy); }
}
function toggleNtP(cid_val, w){
  const key = "nt-" + cid_val;
  const cur = panels[key] || {};
  panels[key] = {log:false, date:false};
  panels[key][w] = !cur[w];
  render();
}
function saveNtLog(cid_val){
  const el = document.getElementById("nlt-" + cid_val);
  const v = el ? el.value.trim() : "";
  if(v) ensureNtLocal(cid_val, function(t){ t.log = v; });
  panels["nt-" + cid_val] = {};
  saveLocal(); render();
}
function saveNtDate(cid_val){
  const rv = (document.getElementById("ndt-" + cid_val)||{value:""}).value;
  const dv = (document.getElementById("ndl-" + cid_val)||{value:""}).value;
  ensureNtLocal(cid_val, function(t){ if(rv) t.due = rv; if(dv) t.deadline = dv; });
  panels["nt-" + cid_val] = {};
  saveLocal(); render();
}
function toggleStarNt(cid_val){
  if(STAR[cid_val]) delete STAR[cid_val]; else STAR[cid_val] = true;
  lsSet(starKey(), JSON.stringify(STAR));
  render();
}
function toggleNtDone(cid_val){
  ensureNtLocal(cid_val, function(t){ t.done = !t.done; });
  saveLocal(); render();
}

// ── panels ───────────────────────────────────────────────────────────────────
function toggleP(n,w){
  const cur = panels[n]||{};
  panels[n]={log:false,date:false}; panels[n][w]=!cur[w];
  render();
}
function saveLog(n){
  const v=document.getElementById("lt-"+n).value.trim();
  panels[n]={};
  setCh(n,{log: v || false});
}
function saveDate(n){
  const rv=document.getElementById("dt-"+n).value;
  const dv=document.getElementById("dl-"+n).value;
  panels[n]={};
  setCh(n,{reminder: rv || false, deadline: dv || false});
}

// ── config ───────────────────────────────────────────────────────────────────
function saveConfig(){
  const rp = document.getElementById("rp").value.trim()
    .replace(/^https?:\/\/github\.com\//,"").replace(/\.git$/,"").replace(/\/+$/,"");
  const tk = document.getElementById("tk").value.trim();
  const e  = document.getElementById("tk-err");
  if(!/^[\w.-]+\/[\w.-]+$/.test(rp)){ e.textContent = "Repo format: owner/name"; return; }
  if(!tk){ e.textContent = "Paste the token."; return; }
  REPO = rp; TOKEN = tk;
  lsSet(K("repo"),rp); lsSet(K("pat"),tk);
  loadBrief();
}
function resetConfig(){
  if(!confirm("Clear the saved repo and token for \u201c"+M.id+"\u201d on this device?")) return;
  REPO=""; TOKEN=""; lsDel(K("repo")); lsDel(K("pat"));
  view="setup"; render();
}

// ── modal ────────────────────────────────────────────────────────────────────
function openModal(){ document.getElementById("overlay").classList.add("open"); }
function closeModal(){
  if(saving) return;
  document.getElementById("overlay").classList.remove("open");
  saveRes = null; if(BRIEF) render();
}
function renderModal(){
  const m = document.getElementById("modal");
  if(saving){
    m.innerHTML = "<h2>Saving\u2026</h2><p>Writing your changes to the journal.</p>"
      + "<div class='load'><span class='spin'>"+IC.load+"</span></div>";
    return;
  }
  if(!saveRes){ m.innerHTML=""; return; }
  if(saveRes.ok){
    m.innerHTML = "<h2>"+IC.ok+" Saved</h2>"
      + "<p>"+saveRes.queued+" change"+(saveRes.queued===1?"":"s")+" now queued in the journal. "
      + "Nothing has been written to the issues yet \u2014 Claude applies the journal at end of day.</p>"
      + "<div class='mbtns'><button class='btn btn-p' onclick='DashCore.closeModal()'>Close</button></div>";
  } else {
    m.innerHTML = "<h2>"+IC.bad+" Couldn't save</h2><div class='ebox'>"+esc(saveRes.error)+"</div>"
      + "<p>Your edits are still held on this device, so nothing is lost. Try again, or reload first if someone else edited from another device.</p>"
      + "<div class='mbtns'><button class='btn' onclick='DashCore.closeModal()'>Close</button>"
      + "<button class='btn btn-p' onclick='DashCore.push()'>Retry</button></div>";
  }
}

// ── render ───────────────────────────────────────────────────────────────────
function card(item){
  const n=item.number, c=eff(n), l=lch(n), p=panels[n]||{};
  const dd=c.reminder||item.reminder||item.due, dcs=dc(dd), done=!!c.done;
  const ddl=c.deadline||item.deadline;
  const isTask=item.type==="task", isPerson=item.type==="person";
  const dlabel = isPerson ? M.dateField.person : M.dateField.default;
  // is any part of this card's state still only on this device?
  const unsaved = FIELDS.some(function(f){
    if(!(f in l)) return false;
    const v=l[f], j=jch(n);
    return (v===false||v===null||v==="") ? (f in j) : (j[f] !== v);
  });
  const star = isStarred(n);
  return "<div class='card "+dcs+(done?" done":"")+(star?" starred":"")+"'>"
    + "<div class='card-row'><span class='card-title"+(done?" struck":"")+"'>"+esc(item.title)+"</span><div class='acts'>"
    + "<button class='act"+(star?" on-star":"")+"' onclick='DashCore.toggleStar("+n+")' title='"+(star?"Unstar":"Star \u2014 mark as important or active")+"'>"+(star?IC.starOn:IC.star)+"</button>"
    + (isTask?"<button class='act"+(done?" on-green":"")+"' onclick='DashCore.setCh("+n+",{done:"+(!done)+"})' title='"+(done?"Undo":"Done")+"'>"+IC.check+"</button>":"")
    + "<button class='act"+(p.log?" on":"")+(c.log&&!p.log?" on-green":"")+"' onclick='DashCore.toggleP("+n+",\"log\")' title='Log a note'>"+IC.msg+"</button>"
    + "<button class='act"+(p.date?" on":"")+"' onclick='DashCore.toggleP("+n+",\"date\")' title='"+dlabel+"'>"+IC.cal+"</button>"
    + (item.url?"<a class='act' href='"+esc(item.url)+"' target='_blank' rel='noopener' title='GitHub'>"+IC.ext+"</a>":"")
    + "</div></div><div class='card-meta'>"+ttag(item.topic)
    + (dd?"<span class='chip "+dcs+"'>"+(dcs==="overdue"?"overdue · ":"")+fd(dd)+(c.reminder?" \u2713":"")+"</span>":"")
    + (ddl?"<span class='chip dl "+dc(ddl)+"'>deadline "+fd(ddl)+(c.deadline?" \u2713":"")+"</span>":"")
    + (c.log?"<span class='chip logged'>"+IC.msg+" note</span>":"")
    + (unsaved?"<span class='chip unsaved'>unsaved</span>":(Object.keys(c).length?"<span class='chip queued'>queued</span>":""))
    + "</div>"
    + (item.note?"<div class='cnote'>"+esc(item.note)+"</div>":"")
    + (p.log?"<div class='panel'><textarea id='lt-"+n+"' placeholder='Note\u2026'>"+esc(c.log||"")+"</textarea>"
       + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleP("+n+",\"log\")'>Cancel</button>"
       + "<button class='btn btn-p' onclick='DashCore.saveLog("+n+")'>Save</button></div></div>":"")
    + (p.date?"<div class='panel'><div class='grid' style='display:grid;grid-template-columns:1fr 1fr;gap:8px'>"
       + "<div class='field'><label>Reminder</label><input type='date' id='dt-"+n+"' value='"+(dd||"")+"'></div>"
       + "<div class='field'><label>Deadline</label><input type='date' id='dl-"+n+"' value='"+(ddl||"")+"'></div></div>"
       + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleP("+n+",\"date\")'>Cancel</button>"
       + "<button class='btn btn-p' onclick='DashCore.saveDate("+n+")'>Set</button></div></div>":"")
    + "</div>";
}

function render(){
  const app = document.getElementById("app");

  if(view==="setup"){
    app.innerHTML = "<div class='center'>"
      + "<a class='back' href='../'>"+IC.back+" dashboards</a>"
      + "<h2>"+esc(M.title)+"<span class='hdr-id'>"+esc(M.id)+"</span></h2>"
      + "<p>Enter the data repository and a token with access to it. Both are stored only on this device, for this dashboard.</p>"
      + "<div class='steps'><ol>"
      + "<li>Create a token at <a href='https://github.com/settings/personal-access-tokens/new' target='_blank' rel='noopener'>Settings \u2192 Developer settings \u2192 Fine-grained tokens</a></li>"
      + "<li><b>Repository access</b> \u2192 Only select repositories \u2192 the data repo</li>"
      + "<li><b>Permissions</b> \u2192 Contents: <code>Read and write</code></li>"
      + "</ol></div>"
      + "<div class='pfield' style='margin-bottom:8px'><label>Data repository</label>"
      + "<input id='rp' type='text' placeholder='owner/repo' autocomplete='off' spellcheck='false'></div>"
      + "<div class='pfield'><label>Token</label>"
      + "<input id='tk' type='password' placeholder='github_pat_\u2026' autocomplete='off' spellcheck='false'></div>"
      + "<p class='err' id='tk-err'></p>"
      + "<div class='pbtns' style='margin-top:10px'><button class='btn btn-p' onclick='DashCore.saveConfig()'>Save and continue</button></div>"
      + "<p class='muted'>This dashboard never writes to your issues \u2014 it only appends to a change journal that Claude applies later. Requests go only to api.github.com.</p></div>";
    ["rp","tk"].forEach(function(id){
      document.getElementById(id).addEventListener("keydown",function(e){ if(e.key==="Enter") saveConfig(); });
    });
    document.getElementById("rp").focus();
    return;
  }

  if(view==="loading"){
    app.innerHTML = "<div class='load'><span class='spin'>"+IC.load+"</span> Loading\u2026</div>";
    return;
  }

  if(view==="error"){
    app.innerHTML = "<div class='center'>"
      + "<a class='back' href='../'>"+IC.back+" dashboards</a>"
      + "<h2>Couldn't load</h2><div class='ebox'>"+esc(errMsg)+"</div>"
      + (errMsg.indexOf("404")===0 ? "<p>If the repo and token are correct, <code>"+esc(M.briefPath)+"</code> may not exist yet. Ask Claude to generate it.</p>" : "")
      + "<div class='pbtns'><button class='lnk' onclick='DashCore.resetConfig()'>Change repo/token</button>"
      + "<button class='btn btn-p' onclick='DashCore.loadBrief()'>Retry</button></div></div>";
    return;
  }

  const meta = BRIEF.meta, cal = BRIEF.calendar, items = BRIEF.items;
  const nLocal = localCount(), nQueued = queuedCount(), nSettled = settledCount();

  let h = "<div class='wrap'>";
  h += "<a class='back' href='../'>"+IC.back+" dashboards</a>";
  h += "<div class='hdr'><div><h1>"+esc(M.title)+"<span class='hdr-id'>"+esc(M.id)+"</span></h1>"
     + "<div class='hdr-date'>"+esc(new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"}))+"</div></div>"
     + "<div class='hdr-r'>"
     + "<button class='btn btn-icon' onclick='DashCore.loadBrief()' title='Reload'>"+IC.refresh+"</button>"
     + (nSettled ? "<button class='btn btn-icon"+(hideSettled?" on":"")+"' onclick='DashCore.toggleHide()' title='"
         + (hideSettled ? "Show "+nSettled+" settled" : "Hide "+nSettled+" settled until applied")
         + "'>"+(hideSettled?IC.eyeOff:IC.eye)+"</button>" : "")
     + "<button class='btn "+(nLocal?"btn-p pulse":"")+"' onclick='DashCore.push()' "+(nLocal?"":"disabled")+">"
     + IC.up + (nLocal?" Save ("+nLocal+")":" Save") + "</button></div></div>";

  if(BRIEF.date !== TODAY)
    h += "<div class='warn'>"+IC.warn+" This data is from "+fd(BRIEF.date)+". Ask Claude to refresh it.</div>";
  meta.warnings.forEach(function(w,i){ if(WDISM[i]) return; h += "<div class='warn'>"+IC.warn+"<span style='flex:1'>"+esc(w)+"</span><button class='warn-x' onclick='DashCore.dismissWarn("+i+")' title='Dismiss'>"+IC.x+"</button></div>"; });
  if(meta.summary){
    var bCol = isCollapsed("brief");
    h += "<div class='sec'><div class='sec-hdr'><span class='sec-label'>Brief</span>" + secChev("brief") + "</div>";
    if(!bCol) h += "<div class='summary'>" + esc(meta.summary) + "</div>";
    h += "</div>";
  }

  if(cal.length){
    var cCol = isCollapsed("calendar");
    h += "<div class='sec'><div class='sec-hdr'><span class='sec-label'>Today</span>" + secChev("calendar") + "</div>";
    if(!cCol){
      h += "<div class='cal-list'>"
        + cal.map(e=>"<div class='cal-row'><span class='cal-time'>"+(e.allDay?"":esc(e.time))+"</span><span class='cal-ev'>"+esc(e.title)+"</span>"+(e.allDay?"<span class='cal-ad'>all day</span>":"")+"</div>").join("")
        + "</div>";
    }
    h += "</div>";
  }

  h += "<div class='cols'>";
  const created = effCreated();
  (M.sections||[]).forEach(function(sec){
    const all    = items.filter(sec.filter);
    const hidden = hideSettled ? all.filter(isSettled) : [];
    let   list   = hideSettled ? all.filter(i=>!isSettled(i)) : all;
    // starred first, original order preserved within each group
    list = list.filter(i=>isStarred(i.number)).concat(list.filter(i=>!isStarred(i.number)));
    if(!all.length && !sec.allowNew) return;
    var sId = "sec-"+sec.label.toLowerCase().replace(/[^a-z0-9]+/g,"-");
    var sCol = isCollapsed(sId);
    h += "<div class='sec'><div class='sec-hdr'><span class='sec-label'>"+esc(sec.label)+"</span>"
       + "<div class='sec-r'>"
       + (sec.allowNew?"<button class='sec-add' onclick='event.stopPropagation();DashCore.toggleNew()'>"+IC.plus+" new</button>":"")
       + secChev(sId)
       + "</div></div>";
    if(!sCol && sec.allowNew && showNF){
      h += "<div class='nform'>"
        + "<div class='field'><label>Title</label><input id='nt-t' type='text' placeholder='Admin \u2014 submit X'></div>"
        + "<div class='grid' style='grid-template-columns:1fr 1fr 1fr'>"
        + "<div class='field'><label>Topic</label><select id='nt-tp'>"
        + (M.topics||[]).map(t=>"<option>"+esc(t)+"</option>").join("")+"</select></div>"
        + "<div class='field'><label>Reminder</label><input id='nt-d' type='date' value='"+TODAY+"'></div>"
        + "<div class='field'><label>Deadline</label><input id='nt-dl' type='date'></div></div>"
        + "<div class='field'><label>Note (optional)</label><textarea id='nt-n' placeholder='Context\u2026'></textarea></div>"
        + "<p class='err' id='nt-err'></p>"
        + "<div class='pbtns' style='margin-top:8px'><button class='btn' onclick='DashCore.toggleNew()'>Cancel</button>"
        + "<button class='btn btn-p' onclick='DashCore.addTask()'>Add</button></div></div>";
    }
    if(!sCol) h += list.map(card).join("");
    if(!sCol && sec.allowNew){
      h += created.map(function(t){
        const c=tc(t.topic), p=panels["nt-"+t.cid]||{}, dcs=dc(t.due);
        const done=!!t.done, star=!!STAR[t.cid];
        return "<div class='card isnew"+(dcs?" "+dcs:"")+(done?" done":"")+(star?" starred":"")+"'>"
          + "<div class='card-row'><span class='card-title"+(done?" struck":"")+"'>"+esc(t.title)+"</span>"
          + "<div class='acts'>"
          + "<button class='act"+(star?" on-star":"")+"' onclick='DashCore.toggleStarNt(\""+esc(t.cid)+"\")' title='"+(star?"Unstar":"Star")+"'>"+(star?IC.starOn:IC.star)+"</button>"
          + "<button class='act"+(done?" on-green":"")+"' onclick='DashCore.toggleNtDone(\""+esc(t.cid)+"\")' title='"+(done?"Undo":"Done")+"'>"+IC.check+"</button>"
          + "<button class='act"+(p.log?" on":"")+(t.log&&!p.log?" on-green":"")+"' onclick='DashCore.toggleNtP(\""+esc(t.cid)+"\",\"log\")' title='Log'>"+IC.msg+"</button>"
          + "<button class='act"+(p.date?" on":"")+"' onclick='DashCore.toggleNtP(\""+esc(t.cid)+"\",\"date\")' title='Reminder'>"+IC.cal+"</button>"
          + "<button class='act rm' onclick='DashCore.rmTask(\""+esc(t.cid)+"\")' title='Remove'>"+IC.x+"</button>"
          + "</div></div>"
          + "<div class='card-meta'><span class='tag' style='background:"+c.bg+";color:"+c.tx+"'>"+esc(t.topic)+"</span>"
          + (t.due?"<span class='chip "+dcs+"'>"+fd(t.due)+"</span>":"")
          + (t.deadline?"<span class='chip dl "+dc(t.deadline)+"'>deadline "+fd(t.deadline)+"</span>":"")
          + (t.log?"<span class='chip logged'>"+IC.msg+" note</span>":"")
          + (done?"<span class='chip logged'>done \u2014 will create+close</span>":"")
          + (t.queued?"<span class='chip queued'>queued</span>":"<span class='chip unsaved'>unsaved</span>")
          + "</div>"
          + (t.note?"<div class='cnote'>"+esc(t.note)+"</div>":"")
          + (p.log?"<div class='panel'><textarea id='nlt-"+esc(t.cid)+"' placeholder='Note\u2026'>"+esc(t.log||"")+"</textarea>"
             + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleNtP(\""+esc(t.cid)+"\",\"log\")'>Cancel</button>"
             + "<button class='btn btn-p' onclick='DashCore.saveNtLog(\""+esc(t.cid)+"\")'>Save</button></div></div>":"")
          + (p.date?"<div class='panel'><div class='grid' style='display:grid;grid-template-columns:1fr 1fr;gap:8px'>"
             + "<div class='field'><label>Reminder</label><input type='date' id='ndt-"+esc(t.cid)+"' value='"+(t.due||"")+"'></div>"
             + "<div class='field'><label>Deadline</label><input type='date' id='ndl-"+esc(t.cid)+"' value='"+(t.deadline||"")+"'></div></div>"
             + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleNtP(\""+esc(t.cid)+"\",\"date\")'>Cancel</button>"
             + "<button class='btn btn-p' onclick='DashCore.saveNtDate(\""+esc(t.cid)+"\")'>Set</button></div></div>":"")
          + "</div>";
      }).join("");
    }
    if(!sCol && hidden.length){
      h += "<div class='hidden-row'>"+hidden.length+" hidden until applied"
         + " <button class='lnk' onclick='DashCore.toggleHide()'>show</button></div>";
    }
    h += "</div>";
  });

  if(M.inbox && inboxItems().length){
    const all    = inboxItems();
    const decided= all.filter(x => !!effIb(x.id));
    const list   = hideSettled ? all.filter(x => !effIb(x.id)) : all;
    var ibCol = isCollapsed("inbox");
    h += "<div class='sec'><div class='sec-hdr'><span class='sec-label'>Inbox</span>"
       + "<div class='sec-r'><span class='sec-note'>from email \u00b7 not issues yet</span>" + secChev("inbox") + "</div></div>";
    if(!ibCol) h += list.map(function(x){
      const st = effIb(x.id);
      const l  = lib(x.id);
      const unsaved = (l !== undefined) && (l === null ? !!jib(x.id) : (!jib(x.id) || jib(x.id).status !== l.status));
      const p  = panels["ib-"+x.id] || {};
      const done = st && st.status === "dismissed";
      const tasked = st && st.status === "task";
      return "<div class='card ib"+(done?" done":"")+"'>"
        + "<div class='card-row'><span class='card-title"+(done?" struck":"")+"'>"+esc(x.subject)+"</span>"
        + "<div class='acts'>"
        + "<button class='act"+(p.open?" on":"")+(tasked?" on-green":"")+"' onclick='DashCore.toggleIB(\""+esc(x.id)+"\")' title='Turn into a task'>"+IC.plus+"</button>"
        + "<button class='act"+(done?" on":"")+"' onclick='DashCore.dismissInbox(\""+esc(x.id)+"\")' title='"+(done?"Undo dismiss":"Dismiss")+"'>"+IC.x+"</button>"
        + (x.url?"<a class='act' href='"+esc(x.url)+"' target='_blank' rel='noopener' title='Open message'>"+IC.ext+"</a>":"")
        + "</div></div>"
        + "<div class='card-meta'>"
        + "<span class='chip src'>"+esc(x.source||"email")+"</span>"
        + (x.from?"<span class='chip'>"+esc(x.from)+"</span>":"")
        + (x.received?"<span class='chip'>"+fd(String(x.received).slice(0,10))+"</span>":"")
        + (tasked?"<span class='chip logged'>\u2192 task</span>":"")
        + (unsaved?"<span class='chip unsaved'>unsaved</span>":(st?"<span class='chip queued'>queued</span>":""))
        + "</div>"
        + (x.note?"<div class='cnote'>"+esc(x.note)+"</div>":"")
        + (p.open?"<div class='panel'>"
            + "<div class='field'><label>Task title</label><input id='ib-t-"+esc(x.id)+"' type='text' value='"+esc(x.suggest||x.subject)+"'></div>"
            + "<div class='grid' style='display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0'>"
            + "<div class='field'><label>Topic</label><select id='ib-tp-"+esc(x.id)+"'>"
            + (M.topics||[]).map(t=>"<option"+(t===(x.topic||"")?" selected":"")+">"+esc(t)+"</option>").join("")+"</select></div>"
            + "<div class='field'><label>Due date</label><input id='ib-d-"+esc(x.id)+"' type='date' value='"+esc(x.suggestDue||TODAY)+"'></div></div>"
            + "<div class='field'><label>Note (optional)</label><textarea id='ib-n-"+esc(x.id)+"'>"+esc(x.note||"")+"</textarea></div>"
            + "<p class='err' id='ib-err-"+esc(x.id)+"'></p>"
            + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleIB(\""+esc(x.id)+"\")'>Cancel</button>"
            + "<button class='btn btn-p' onclick='DashCore.convertInbox(\""+esc(x.id)+"\")'>Create task</button></div></div>":"")
        + "</div>";
    }).join("");
    if(!ibCol && hideSettled && decided.length){
      h += "<div class='hidden-row'>"+decided.length+" handled"
         + " <button class='lnk' onclick='DashCore.toggleHide()'>show</button></div>";
    }
    h += "</div>";
  }

  if(M.braindump){
    const bd = effBraindump();
    var bdCol = isCollapsed("braindump");
    h += "<div class='sec bd-sec'><div class='sec-hdr'><span class='sec-label'>Braindump</span>"
       + "<div class='sec-r'><span class='sec-note'>"+hhmm(new Date())+"</span>" + secChev("braindump") + "</div></div>";
    if(!bdCol){
    // always-on capture box: no click needed before you can start typing
    h += "<div class='bd-capture'>"
      + "<textarea id='bd-t' placeholder='Drop a thought, a note, a meeting log\u2026'></textarea>"
      + "<div class='bd-bar'><select id='bd-k'>"
      + "<option value='note'>note</option><option value='meeting'>meeting</option>"
      + "<option value='idea'>idea</option><option value='decision'>decision</option>"
      + "</select><span class='err' id='bd-err'></span>"
      + "<button class='btn btn-p' onclick='DashCore.addBraindump()'>"+IC.plus+" Add</button></div></div>";
    if(bd.length){
      h += bd.map(function(b){
        const t = new Date(b.ts);
        const ep = bdPanels[b.id] || {};
          return "<div class='bd-item'>"
          + "<div class='bd-head'><span class='bd-ts'>"+esc(isNaN(t)?b.ts:hhmm(t))+"</span>"
          + "<span class='bd-kind bd-"+esc(b.kind||"note")+"'>"+esc(b.kind||"note")+"</span>"
          + (b.queued?"<span class='chip queued'>queued</span>":"<span class='chip unsaved'>unsaved</span>")
          + "<button class='act"+(ep.editing?" on":"")+"' onclick='DashCore.toggleBDEdit(\""+esc(b.id)+"\")'  title='Edit'>"+IC.edit+"</button>"
          + "<button class='act rm' onclick='DashCore.rmBraindump(\""+esc(b.id)+"\")'  title='Remove'>"+IC.x+"</button></div>"
          + (ep.editing
            ? "<div class='panel'><textarea id='bdet-"+esc(b.id)+"'>"+esc(b.text)+"</textarea>"
              + "<div class='pbtns'><button class='btn' onclick='DashCore.toggleBDEdit(\""+esc(b.id)+"\")'>"+"Cancel</button>"
              + "<button class='btn btn-p' onclick='DashCore.saveBDEdit(\""+esc(b.id)+"\")'>"+"Save</button></div></div>"
            : "<div class='bd-text'>"+esc(b.text).replace(/\n/g,"<br>")+"</div>")
          + "</div>";
      }).join("");
    } else {
      h += "<div class='bd-empty'>Nothing yet today. Whatever lands here gets reviewed at end of day.</div>";
    }
    } // end !bdCol
    h += "</div>";   // .sec
  }
  h += "</div>";   // .cols
  h += "<div class='foot'><span>"+esc(BRIEF.date)+(lastLoad?" \u00b7 "+hhmm(lastLoad):"")
     + " \u00b7 <span class='build'>build "+BUILD+"</span>"+(nQueued?" \u00b7 "+nQueued+" queued":"")+(nLocal?" \u00b7 "+nLocal+" unsaved":"")+"</span>"
     + "<button class='lnk' onclick='DashCore.resetConfig()'>change repo/token</button></div></div>";

  app.innerHTML = h;
}

// ── start ────────────────────────────────────────────────────────────────────
function start(manifest){
  M = Object.assign({
    id:"dash", title:"dash",
    briefPath:"brief/today.json", changesPath:"brief/today_changes.json",
    topics:[], topicColors:{}, sections:[],
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
  toggleBD, addBraindump, rmBraindump, toggleBDEdit, saveBDEdit,
  dismissInbox, undoInbox, toggleIB, convertInbox,
  toggleStar, push, toggleHide, toggleSection, dismissWarn, closeModal,
  toggleNtP, saveNtLog, saveNtDate, toggleStarNt, toggleNtDone
};
})();


