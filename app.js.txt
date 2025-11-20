/* app.js - BudgetBuddy
   Full application logic for the PWA.
   Matches the index.html supplied earlier.
   Author: ChatGPT (generated)
*/

/* ---------------------------
   Utilities & Constants
   --------------------------- */
const STORAGE_KEY = "budgetbuddy_v1_state";
const UNLOCK_FLAG = "budgetbuddy_unlocked_v1";

function uid(prefix='id'){
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random()*1e6).toString(36)}`;
}
function nowISO(){ return new Date().toISOString().slice(0,10); }
function monthKeyFrom(dateStr){
  const d = dateStr ? new Date(dateStr) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function clampCarryPct(v){ return Math.max(2, Number(v || 2)); }

function safeGet(id){ return document.getElementById(id); }
function elVal(id){ const e=safeGet(id); return e? e.value : ""; }
function setElVal(id,v){ const e=safeGet(id); if(e) e.value = v; }

/* currency symbol simple (you can expand) */
function currencySymbol(){
  // default to ZAR
  const cur = state.settings.currency || "ZAR";
  if(cur === "ZAR") return "R";
  if(cur === "USD") return "$";
  if(cur === "EUR") return "€";
  return "";
}
function fmtMoney(n){
  if (n === undefined || n === null) n = 0;
  return currencySymbol() + Number(n).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});
}

/* ---------------------------
   State (load / save)
   --------------------------- */
function defaultState(){
  const key = monthKeyFrom();
  return {
    settings: {
      currency: "ZAR",
      carryPercent: 2,
      passwordSalt: null,
      passwordHash: null,
      pinSalt: null,
      pinHash: null,
      biometrics: false
    },
    currentMonthKey: key,
    months: {
      [key]: createEmptyMonth(key, 0)
    },
    savingsAccounts: [], // {id,name,balance,monthlySetAside,annualInterestPercent}
    goals: [], // {id,title,targetAmount,deadline,savedSoFar}
    debitTemplates: [] // {id,title,day,amount,enabled}
  };
}
function createEmptyMonth(key, starting=0){
  return {
    key,
    startingBalance: Number(starting||0),
    reservedCarry: 0,      // locked portion at start
    appliedCarryTotal: 0,  // total carried in
    incomes: [],           // {id,source,amount,date}
    expenses: [],          // {id,category,budgeted,actual,date,fromDebitTemplateId?}
    budgets: [],           // {id,category,amount}
    setAsides: [],         // {id,accountId,amount}
    goalContribs: []       // {id,goalId,amount}
  };
}
let state = (function load(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // ensure current month exists
    if(!parsed.currentMonthKey) parsed.currentMonthKey = monthKeyFrom();
    if(!parsed.months) parsed.months = {};
    if(!parsed.months[parsed.currentMonthKey]) parsed.months[parsed.currentMonthKey] = createEmptyMonth(parsed.currentMonthKey,0);
    // migration small fixes
    if(!parsed.savingsAccounts) parsed.savingsAccounts = [];
    if(!parsed.goals) parsed.goals = [];
    if(!parsed.debitTemplates) parsed.debitTemplates = [];
    return parsed;
  }catch(e){
    console.error("Failed to load state", e);
    return defaultState();
  }
})();
function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){ console.error("save failed", e); }
}

/* ---------------------------
   Crypto: PBKDF2 helper for password & PIN (client-side only)
   --------------------------- */
async function genSaltBase64(){
  const s = crypto.getRandomValues(new Uint8Array(16));
  let str = "";
  for(let i=0;i<s.length;i++) str += String.fromCharCode(s[i]);
  return btoa(str);
}
function base64ToArrayBuffer(b64){
  const bin = atob(b64), len = bin.length, arr = new Uint8Array(len);
  for(let i=0;i<len;i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}
function arrayBufferToBase64(buf){
  const bytes = new Uint8Array(buf), L = bytes.length; let s="";
  for(let i=0;i<L;i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
async function derivePBKDF2(password, saltB64){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name:"PBKDF2", salt: base64ToArrayBuffer(saltB64), iterations:150000, hash:"SHA-256" }, key, 256);
  return arrayBufferToBase64(derived);
}
async function setPassword(password){
  if(!password){ state.settings.passwordSalt = null; state.settings.passwordHash = null; saveState(); return; }
  const salt = await genSaltBase64();
  const hash = await derivePBKDF2(password, salt);
  state.settings.passwordSalt = salt;
  state.settings.passwordHash = hash;
  saveState();
}
async function checkPassword(password){
  if(!state.settings.passwordHash) return true;
  if(!password) return false;
  try{
    const derived = await derivePBKDF2(password, state.settings.passwordSalt);
    return derived === state.settings.passwordHash;
  }catch(e){ console.error(e); return false; }
}
async function setPin(pin){
  if(!pin){ state.settings.pinSalt = null; state.settings.pinHash = null; saveState(); return; }
  const salt = await genSaltBase64();
  const hash = await derivePBKDF2(pin, salt);
  state.settings.pinSalt = salt;
  state.settings.pinHash = hash;
  saveState();
}
async function checkPin(pin){
  if(!state.settings.pinHash) return true;
  if(!pin) return false;
  try{
    const derived = await derivePBKDF2(pin, state.settings.pinSalt);
    return derived === state.settings.pinHash;
  }catch(e){ console.error(e); return false; }
}

/* ---------------------------
   Month lifecycle & carry reserved logic
   - When a new month is created: compute previous leftover, reserve minimum carry% (min 2%) of previous leftover,
     but per your spec: reserve that percentage (locked) and also carry the entire leftover into startingBalance.
     Reserved portion is shown and cannot be spent (availableToSpend excludes reservedCarry).
   --------------------------- */
function ensureMonth(key){
  if(state.months[key]) return state.months[key];
  // create
  const month = createEmptyMonth(key,0);
  // compute previous month
  const [y,m] = key.split("-");
  const prev = new Date(Number(y), Number(m)-1, 1);
  prev.setMonth(prev.getMonth() - 1);
  const prevKey = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
  let prevLeftover = 0;
  if(state.months[prevKey]){
    prevLeftover = computeTotals(prevKey).leftover;
  }
  const carryPct = clampCarryPct(state.settings.carryPercent || 2);
  let reserved = 0, appliedTotal = 0;
  if(prevLeftover > 0){
    reserved = +(prevLeftover * (carryPct/100)).toFixed(2);
    if(reserved > prevLeftover) reserved = prevLeftover;
    appliedTotal = +prevLeftover.toFixed(2); // carry all leftover
  }
  month.reservedCarry = reserved;
  month.appliedCarryTotal = appliedTotal;
  month.startingBalance = Number(month.startingBalance || 0) + appliedTotal;
  state.months[key] = month;
  saveState();
  // apply recurring debits to the new month
  applyDebitTemplatesToMonth(key);
  return month;
}
function setCurrentMonth(key){
  ensureMonth(key);
  state.currentMonthKey = key;
  saveState();
}

/* ---------------------------
   CRUD: incomes, expenses, budgets, debits, savings, goals
   --------------------------- */
function addIncome(monthKey, {source, amount, date}){
  ensureMonth(monthKey);
  state.months[monthKey].incomes.push({ id: uid("inc"), source, amount: Number(amount), date });
  saveState();
}
function removeIncome(monthKey, id){
  const m = state.months[monthKey];
  if(!m) return;
  m.incomes = m.incomes.filter(i => i.id !== id);
  saveState();
}

function addExpense(monthKey, {category, budgeted, actual, date, fromDebitTemplateId=null}){
  ensureMonth(monthKey);
  state.months[monthKey].expenses.push({ id: uid("exp"), category, budgeted: Number(budgeted||0), actual: Number(actual||0), date, fromDebitTemplateId });
  saveState();
}
function removeExpense(monthKey, id){
  const m = state.months[monthKey];
  if(!m) return;
  m.expenses = m.expenses.filter(e => e.id !== id);
  saveState();
}
function addBudget(monthKey, {category, amount}){
  ensureMonth(monthKey);
  const m = state.months[monthKey];
  const found = m.budgets.find(b => b.category.toLowerCase() === category.toLowerCase());
  if(found) found.amount = Number(amount);
  else m.budgets.push({ id: uid("bud"), category, amount: Number(amount) });
  saveState();
}
function removeBudget(monthKey, id){
  const m = state.months[monthKey];
  if(!m) return;
  m.budgets = m.budgets.filter(b => b.id !== id);
  saveState();
}

/* Debit templates (recurring): {id,title,day,amount,enabled} */
function addDebitTemplate({title, day, amount}){
  const t = { id: uid("dt"), title, day: Number(day||1), amount: Number(amount), enabled:true };
  state.debitTemplates.push(t);
  saveState();
  // apply immediately for current month
  applyDebitTemplateToMonth(t, state.currentMonthKey);
}
function updateDebitTemplate(id, patch){
  const t = state.debitTemplates.find(x=>x.id===id);
  if(!t) return;
  Object.assign(t, patch);
  saveState();
  alert("Debit template updated. Changes will apply to future months (already-applied past expenses are not changed).");
}
function removeDebitTemplate(id){
  if(!confirm("Remove recurring debit template? This will not remove already-applied expenses.")) return;
  state.debitTemplates = state.debitTemplates.filter(x=>x.id!==id);
  saveState();
}

/* Apply template to month (creates dated expense if not existing) */
function applyDebitTemplateToMonth(template, monthKey){
  ensureMonth(monthKey);
  const m = state.months[monthKey];
  if(!template.enabled) return;
  // avoid duplicate
  const exists = m.expenses.some(e => e.fromDebitTemplateId === template.id);
  if(exists) return;
  // compute date within month
  const [y,mm] = monthKey.split("-");
  const year = Number(y), month = Number(mm)-1;
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const day = Math.min(template.day || 1, daysInMonth);
  const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const expense = { id: uid("exp"), category: template.title, budgeted: 0, actual: Number(template.amount), date: dateStr, fromDebitTemplateId: template.id };
  m.expenses.push(expense);
  saveState();
}
function applyDebitTemplatesToMonth(monthKey){
  state.debitTemplates.forEach(t => applyDebitTemplateToMonth(t, monthKey));
}

/* Savings accounts */
function addSavingsAccount({name,balance,monthlySetAside,annualInterest}){
  state.savingsAccounts.push({ id: uid("sav"), name, balance: Number(balance||0), monthlySetAside: Number(monthlySetAside||0), annualInterestPercent: Number(annualInterest||0) });
  saveState();
}
function updateSavingsAccount(id, patch){
  const a = state.savingsAccounts.find(x=>x.id===id); if(!a) return; Object.assign(a, patch); saveState();
}
function removeSavingsAccount(id){ state.savingsAccounts = state.savingsAccounts.filter(x=>x.id!==id); saveState(); }

/* Goals */
function addGoal({title, targetAmount, deadline, savedSoFar}){
  state.goals.push({ id: uid("goal"), title, targetAmount: Number(targetAmount||0), deadline:null, savedSoFar: Number(savedSoFar||0) });
  // allow deadline optional
  if(deadline) {
    const date = new Date(deadline);
    if(!isNaN(date)) state.goals[state.goals.length-1].deadline = deadline;
  }
  saveState();
}
function updateGoal(id, patch){ const g = state.goals.find(x=>x.id===id); if(!g) return; Object.assign(g, patch); saveState(); }
function removeGoal(id){ state.goals = state.goals.filter(x=>x.id!==id); saveState(); }

/* Set-asides & goal contributions per month (simple) */
function setSetAside(monthKey, accountId, amount){
  ensureMonth(monthKey);
  const m = state.months[monthKey];
  const found = m.setAsides.find(s=>s.accountId===accountId);
  if(found) found.amount = Number(amount);
  else m.setAsides.push({ id: uid("sas"), accountId, amount: Number(amount) });
  saveState();
}
function removeSetAside(monthKey, id){ const m = state.months[monthKey]; if(!m) return; m.setAsides = m.setAsides.filter(s => s.id !== id); saveState(); }

function setGoalContrib(monthKey, goalId, amount){
  ensureMonth(monthKey);
  const m = state.months[monthKey];
  const found = m.goalContribs.find(g=>g.goalId===goalId);
  if(found) found.amount = Number(amount);
  else m.goalContribs.push({ id: uid("gcon"), goalId, amount: Number(amount) });
  saveState();
}
function removeGoalContrib(monthKey, id){ const m = state.months[monthKey]; if(!m) return; m.goalContribs = m.goalContribs.filter(g => g.id!==id); saveState(); }

/* ---------------------------
   Calculations: totals, forecasts, recommendations
   --------------------------- */
function computeTotals(monthKey){
  ensureMonth(monthKey);
  const m = state.months[monthKey];
  const starting = Number(m.startingBalance || 0);
  const totalIncome = m.incomes.reduce((s,i)=>s + Number(i.amount || 0), 0);
  const totalExpenses = m.expenses.reduce((s,e)=> s + Number(e.actual || 0), 0);
  const debits = m.expenses.filter(e=>e.fromDebitTemplateId).reduce((s,e)=>s + Number(e.actual || 0), 0);
  const setAsides = m.setAsides.reduce((s,sa)=> s + Number(sa.amount || 0), 0);
  const goalContribs = m.goalContribs.reduce((s,g)=> s + Number(g.amount || 0), 0);
  // total actual spend (explicit expenses includes debits)
  const totalActualSpend = Number(totalExpenses) + Number(setAsides) + Number(goalContribs);
  const leftover = (starting + totalIncome) - totalActualSpend;
  const availableToSpend = (starting + totalIncome) - (m.reservedCarry || 0) - setAsides - goalContribs;
  // budgets: compute actual totals per budget item
  const budgets = m.budgets.map(b => {
    const actual = m.expenses.filter(e => e.category.toLowerCase() === b.category.toLowerCase()).reduce((s,e)=>s + Number(e.actual || 0), 0);
    return { ...b, actual };
  });
  return { starting, totalIncome, totalExpenses, debits, setAsides, goalContribs, totalActualSpend, leftover, availableToSpend, budgets };
}

/* Savings projection (monthly compounding) */
function monthlyRate(apr){
  return (Number(apr || 0)/100) / 12;
}
function futureValueMonthly(initial, monthly, months, apr){
  const r = monthlyRate(apr);
  if(months <= 0) return Number(initial);
  if(r === 0) return Number(initial) + Number(monthly) * months;
  const fvInitial = Number(initial) * Math.pow(1+r, months);
  const fvContrib = Number(monthly) * ((Math.pow(1+r, months) - 1) / r);
  return fvInitial + fvContrib;
}
function projectSavingsAll(months){
  return state.savingsAccounts.reduce((s,a)=> s + futureValueMonthly(a.balance, a.monthlySetAside, months, a.annualInterestPercent), 0);
}

/* Goal recommendation */
function monthsBetweenInclusive(fromISO, toISO){
  const a = new Date(fromISO), b = new Date(toISO);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() >= a.getDate()) months += 1;
  if(months <= 0) months = 1;
  return months;
}
function recommendGoalMonthly(goalId, monthKey){
  const goal = state.goals.find(g=>g.id===goalId); if(!goal) return 0;
  const totals = computeTotals(monthKey);
  const available = Math.max(0, totals.availableToSpend); // conservative
  const today = nowISO();
  const monthsLeft = goal.deadline ? monthsBetweenInclusive(today, goal.deadline) : 12;
  const needed = Math.max(0, goal.targetAmount - (goal.savedSoFar || 0));
  const perMonth = needed / monthsLeft;
  // recommend min(required, available)
  return Math.min(perMonth, available);
}

/* Advice engine (simple rules) */
function generateAdvice(monthKey){
  const adv = [];
  const t = computeTotals(monthKey);
  if(t.totalIncome === 0) adv.push({type:'warning', text:'You have no income recorded for this month.'});
  if(t.leftover < 0) adv.push({type:'danger', text:`You are overspending by ${fmtMoney(Math.abs(t.leftover))}.`});
  // saving rate
  const savingPlanned = t.setAsides + t.goalContribs;
  const savePct = t.totalIncome > 0 ? (savingPlanned / t.totalIncome) * 100 : 0;
  if(savePct < 10 && t.totalIncome>0) adv.push({type:'advice', text:`Consider increasing planned savings — currently ${savePct.toFixed(1)}% of income.`});
  if(savePct >= 20) adv.push({type:'positive', text:`Nice — planned savings ${savePct.toFixed(1)}% of income.`});
  // debits high
  const debPct = t.totalIncome>0 ? (t.debits / t.totalIncome)*100 : 0;
  if(debPct > 40) adv.push({type:'danger', text:`Fixed debit orders are ${debPct.toFixed(1)}% of income — review subscriptions.`});
  // budgets
  t.budgets.forEach(b => {
    if(b.amount <= 0) return;
    const pct = (b.actual / b.amount)*100;
    if(pct > 120) adv.push({type:'danger', text:`${b.category}: over budget by ${Math.round(pct-100)}% (${fmtMoney(b.actual - b.amount)})`});
    else if(pct > 100) adv.push({type:'advice', text:`${b.category}: slightly over budget (${Math.round(pct)}%).`});
    else adv.push({type:'info', text:`${b.category}: within budget (${Math.round(pct)}%).`});
  });
  return adv;
}

/* ---------------------------
   Exports: PDF & CSV
   --------------------------- */

/* dynamic load of jsPDF if missing */
function ensureJsPDF(){
  return new Promise((resolve, reject) => {
    if(window.jspdf) return resolve(window.jspdf);
    // check if script tag present
    const existing = Array.from(document.getElementsByTagName('script')).find(s=> s.src && s.src.includes('jspdf'));
    if(existing){
      existing.addEventListener('load', ()=> resolve(window.jspdf));
      existing.addEventListener('error', ()=> reject(new Error('jsPDF load failed')));
      return;
    }
    // create script
    const s = document.createElement('script');
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    s.onload = ()=> resolve(window.jspdf || window.jspdf);
    s.onerror = ()=> reject(new Error('Failed to load jsPDF'));
    document.head.appendChild(s);
  });
}

async function exportMonthPDF(monthKey){
  ensureMonth(monthKey);
  const totals = computeTotals(monthKey);
  const m = state.months[monthKey];
  try{
    await ensureJsPDF();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:'pt', format:'a4' });
    let y = 40;
    doc.setFontSize(16);
    doc.text(`BudgetBuddy — Month Report: ${monthKey}`, 40, y); y += 26;
    doc.setFontSize(12);
    doc.text(`Starting balance: ${fmtMoney(totals.starting)}`, 40, y); y+=16;
    doc.text(`Total income: ${fmtMoney(totals.totalIncome)}`, 40, y); y+=16;
    doc.text(`Total actual spend (incl. set-asides & goals): ${fmtMoney(totals.totalActualSpend)}`, 40, y); y+=16;
    doc.text(`Leftover: ${fmtMoney(totals.leftover)}`, 40, y); y+=24;

    doc.setFontSize(13); doc.text("Incomes:", 40, y); y+=14; doc.setFontSize(11);
    m.incomes.forEach(i => {
      doc.text(`${i.date} • ${i.source} • ${fmtMoney(i.amount)}`, 50, y);
      y += 14;
      if(y > 760){ doc.addPage(); y = 40; }
    });

    y += 6; doc.setFontSize(13); doc.text("Expenses:", 40, y); y += 14; doc.setFontSize(11);
    m.expenses.forEach(e => {
      const tag = e.fromDebitTemplateId ? " (debit)" : "";
      doc.text(`${e.date} • ${e.category}${tag} • ${fmtMoney(e.actual)}`, 50, y);
      y += 14;
      if(y > 760){ doc.addPage(); y = 40; }
    });

    // Save
    doc.save(`BudgetBuddy_${monthKey}.pdf`);
  }catch(e){
    console.error("Export PDF failed", e);
    alert("PDF export failed. If offline-only, consider enabling network or host jsPDF locally.");
  }
}

function exportMonthCSV(monthKey){
  ensureMonth(monthKey);
  const m = state.months[monthKey];
  let csv = "type,date,category_or_source,amount\n";
  m.incomes.forEach(i => csv += `income,${i.date},${i.source},${i.amount}\n`);
  m.expenses.forEach(e => csv += `expense,${e.date},${e.category},${e.actual}\n`);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `BudgetBuddy_${monthKey}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

/* ---------------------------
   Charts (Chart.js) - bottom only
   --------------------------- */
let chartActual = null;
let chartSavings = null;

function renderCharts(){
  renderActualChart();
  renderSavingsChart();
}

function lastNMonthKeys(n=12){
  const keys = Object.keys(state.months).sort();
  return keys.slice(-n);
}

function renderActualChart(){
  const ctx = document.getElementById('chartActual');
  if(!ctx) return;
  const keys = lastNMonthKeys(12);
  const labels = keys.map(k => k);
  const incomes = keys.map(k=> computeTotals(k).totalIncome);
  const spends = keys.map(k=> computeTotals(k).totalActualSpend);
  if(chartActual) chartActual.destroy();
  chartActual = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Income', data: incomes, borderColor: '#14B8A6', fill:false },
        { label: 'Actual Spend', data: spends, borderColor: '#ef4444', fill:false }
      ]
    },
    options: { responsive:true, maintainAspectRatio:false }
  });
}

function renderSavingsChart(){
  const ctx = document.getElementById('chartSavings');
  if(!ctx) return;
  // projections: months [0,1,3,6,12,60]
  const months = [0,1,3,6,12,60];
  const labels = months.map(m=> `${m}m`);
  const data = months.map(m => projectSavingsAll(m));
  if(chartSavings) chartSavings.destroy();
  chartSavings = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{ label:'Projected total savings', data, borderColor:'#14B8A6', backgroundColor:'rgba(20,184,166,0.08)', fill:true }]
    },
    options: { responsive:true, maintainAspectRatio:false }
  });
}

/* ---------------------------
   UI Rendering
   --------------------------- */

function renderMonthSelector(){
  const sel = safeGet('monthSelector');
  if(!sel) return;
  sel.innerHTML = '';
  const keys = Object.keys(state.months).sort().reverse();
  keys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = new Date(k + '-01').toLocaleString(undefined, { month:'long', year:'numeric' });
    if(k === state.currentMonthKey) opt.selected = true;
    sel.appendChild(opt);
  });
}

function renderIncomes(){
  const tbl = safeGet('incomeTable');
  const tbody = tbl ? tbl.getElementsByTagName('tbody')[0] : null;
  // our index.html used a simple table without tbody; we'll clear rows except header
  if(!tbl) return;
  // remove all rows except the header
  while(tbl.rows.length > 1) tbl.deleteRow(1);
  const m = state.months[state.currentMonthKey];
  (m.incomes || []).slice().sort((a,b)=> a.date.localeCompare(b.date)).forEach(i=>{
    const row = tbl.insertRow();
    row.insertCell().innerText = i.source;
    row.insertCell().innerText = fmtMoney(i.amount);
    row.insertCell().innerText = i.date;
    const c = row.insertCell();
    const btn = document.createElement('button'); btn.className='small-btn'; btn.innerText='Remove';
    btn.addEventListener('click', ()=> { if(confirm('Remove income?')){ removeIncome(state.currentMonthKey, i.id); renderAll(); }});
    c.appendChild(btn);
  });
}

function renderExpenses(){
  const tbl = safeGet('expenseTable');
  if(!tbl) return;
  while(tbl.rows.length > 1) tbl.deleteRow(1);
  const m = state.months[state.currentMonthKey];
  (m.expenses || []).slice().sort((a,b)=> a.date.localeCompare(b.date)).forEach(e=>{
    const row = tbl.insertRow();
    row.insertCell().innerText = e.category;
    row.insertCell().innerText = fmtMoney(e.budgeted || 0);
    row.insertCell().innerText = fmtMoney(e.actual || 0);
    row.insertCell().innerText = e.date;
    const c = row.insertCell();
    const btn = document.createElement('button'); btn.className='small-btn'; btn.innerText='Remove';
    btn.addEventListener('click', ()=> { if(confirm('Remove expense?')){ removeExpense(state.currentMonthKey, e.id); renderAll(); }});
    c.appendChild(btn);
  });
}

function renderDebits(){
  const tbl = safeGet('debitTable');
  if(!tbl) return;
  while(tbl.rows.length > 1) tbl.deleteRow(1);
  (state.debitTemplates || []).forEach(d=>{
    const row = tbl.insertRow();
    row.insertCell().innerText = d.title;
    row.insertCell().innerText = fmtMoney(d.amount);
    row.insertCell().innerText = `day ${d.day}`;
    const c = row.insertCell();
    const toggle = document.createElement('button'); toggle.className='small-btn'; toggle.innerText = d.enabled ? 'Disable' : 'Enable';
    toggle.addEventListener('click', ()=>{ d.enabled = !d.enabled; saveState(); renderAll(); });
    const edit = document.createElement('button'); edit.className='small-btn'; edit.style.marginLeft='6px'; edit.innerText='Edit';
    edit.addEventListener('click', ()=>{
      const newTitle = prompt('Title', d.title); if(newTitle===null) return;
      const newDay = prompt('Day of month (1-28/31)', d.day); if(newDay===null) return;
      const newAmt = prompt('Amount', d.amount); if(newAmt===null) return;
      updateDebitTemplate(d.id, { title:newTitle, day:Number(newDay), amount:Number(newAmt) });
      renderAll();
    });
    const rem = document.createElement('button'); rem.className='small-btn'; rem.style.marginLeft='6px'; rem.innerText='Remove';
    rem.addEventListener('click', ()=>{ if(confirm('Remove template?')){ removeDebitTemplate(d.id); renderAll(); }});
    c.appendChild(toggle); c.appendChild(edit); c.appendChild(rem);
  });
}

function renderSavings(){
  const tbl = safeGet('savingsTable'); if(!tbl) return;
  while(tbl.rows.length > 1) tbl.deleteRow(1);
  (state.savingsAccounts || []).forEach(a=>{
    const row = tbl.insertRow();
    row.insertCell().innerText = a.name;
    row.insertCell().innerText = fmtMoney(a.balance);
    row.insertCell().innerText = fmtMoney(a.monthlySetAside);
    row.insertCell().innerText = `${a.annualInterestPercent}%`;
    const c = row.insertCell();
    const edit = document.createElement('button'); edit.className='small-btn'; edit.innerText='Edit';
    edit.addEventListener('click', ()=>{
      const nb = prompt('Balance', a.balance); if(nb===null) return;
      const nm = prompt('Monthly set-aside', a.monthlySetAside); if(nm===null) return;
      const na = prompt('Annual interest %', a.annualInterestPercent); if(na===null) return;
      updateSavingsAccount(a.id, { balance: Number(nb), monthlySetAside: Number(nm), annualInterestPercent: Number(na) });
      renderAll();
    });
    const rem = document.createElement('button'); rem.className='small-btn'; rem.style.marginLeft='6px'; rem.innerText='Remove';
    rem.addEventListener('click', ()=>{ if(confirm('Remove account?')){ removeSavingsAccount(a.id); renderAll(); }});
    c.appendChild(edit); c.appendChild(rem);
  });
}

function renderGoals(){
  const tbl = safeGet('goalTable'); if(!tbl) return;
  while(tbl.rows.length > 1) tbl.deleteRow(1);
  (state.goals || []).forEach(g=>{
    const suggested = recommendGoalMonthly(g.id, state.currentMonthKey);
    const row = tbl.insertRow();
    row.insertCell().innerText = g.title;
    row.insertCell().innerText = fmtMoney(g.targetAmount);
    row.insertCell().innerText = fmtMoney(suggested);
    const c = row.insertCell();
    const edit = document.createElement('button'); edit.className='small-btn'; edit.innerText='Edit';
    edit.addEventListener('click', ()=>{
      const ns = prompt('Already saved', g.savedSoFar||0); if(ns===null) return;
      updateGoal(g.id, { savedSoFar: Number(ns) }); renderAll();
    });
    const rem = document.createElement('button'); rem.className='small-btn'; rem.style.marginLeft='6px'; rem.innerText='Remove';
    rem.addEventListener('click', ()=>{ if(confirm('Remove goal?')){ removeGoal(g.id); renderAll(); }});
    c.appendChild(edit); c.appendChild(rem);
  });
}

function renderSummary(){
  const sums = computeTotals(state.currentMonthKey);
  safeGet('sumIncome').innerText = fmtMoney(sums.totalIncome);
  safeGet('sumActual').innerText = fmtMoney(sums.totalActualSpend);
  safeGet('sumSaved').innerText = fmtMoney(sums.setAsides);
  safeGet('sumGoal').innerText = fmtMoney(sums.goalContribs);
  safeGet('sumCarry').innerText = fmtMoney(state.months[state.currentMonthKey].reservedCarry || 0);
  safeGet('sumLeft').innerText = fmtMoney(sums.leftover);
  // insights
  const div = safeGet('insights'); div.innerHTML = '';
  const adv = generateAdvice(state.currentMonthKey);
  adv.forEach(a => {
    const p = document.createElement('p'); p.className='muted';
    if(a.type==='danger') p.style.color='#dc2626';
    if(a.type==='positive') p.style.color='#16a34a';
    if(a.type==='advice') p.style.color='#b45309';
    p.innerText = a.text;
    div.appendChild(p);
  });
}

function renderAll(){
  renderMonthSelector();
  renderIncomes();
  renderExpenses();
  renderDebits();
  renderSavings();
  renderGoals();
  renderSummary();
  renderCharts();
}

/* ---------------------------
   UI Wiring (event listeners)
   --------------------------- */
function wireUI(){
  // login screen
  const loginBtn = safeGet('loginBtn');
  const loginPassword = safeGet('loginPassword');
  const loginMessage = safeGet('loginMessage');
  const setupLink = safeGet('setupLink');

  function showScreen(id){
    ['loginScreen','setupScreen','appScreen'].forEach(sid=>{
      const el = safeGet(sid);
      if(!el) return;
      if(sid === id) el.classList.add('show');
      else el.classList.remove('show');
    });
  }

  // if no credentials: show setup link
  const hasPassword = !!(state.settings && state.settings.passwordHash);
  if(!hasPassword){
    if(setupLink) setupLink.classList.remove('hidden');
    if(loginMessage) loginMessage.innerText = "No password set — skip or create one.";
  } else {
    if(setupLink) setupLink.classList.add('hidden');
    if(loginMessage) loginMessage.innerText = "";
    if(loginPassword) loginPassword.classList.remove('hidden');
  }

  // login button behavior
  loginBtn?.addEventListener('click', async () => {
    // if no password set, allow skip to app
    if(!state.settings.passwordHash && !state.settings.pinHash){
      // user can skip
      localStorage.setItem(UNLOCK_FLAG, '1');
      showScreen('appScreen');
      renderAll();
      return;
    }
    // if password field visible, check; otherwise ask for PIN prompt
    const pw = loginPassword && loginPassword.value ? loginPassword.value : null;
    if(pw){
      const ok = await checkPassword(pw);
      if(ok){ localStorage.setItem(UNLOCK_FLAG,'1'); showScreen('appScreen'); renderAll(); return; }
      else { alert('Wrong password'); return; }
    } else {
      // attempt quick PIN prompt
      const pin = prompt('Enter PIN (or cancel to set password)'); if(pin===null) return;
      const ok = await checkPin(pin);
      if(ok){ localStorage.setItem(UNLOCK_FLAG,'1'); showScreen('appScreen'); renderAll(); return; }
      else { alert('Wrong PIN'); return; }
    }
  });

  setupLink?.addEventListener('click', ()=> {
    showScreen('setupScreen');
  });

  // setup screen buttons
  safeGet('savePasswordBtn')?.addEventListener('click', async ()=> {
    const p = elVal('setupPassword'), pc = elVal('setupPasswordConfirm');
    if(p !== pc){ return alert('Passwords do not match'); }
    if(p && p.length < 4) { if(!confirm('Password is short. Save anyway?')) return; }
    if(p) await setPassword(p);
    // after save, mark unlocked and open app screen
    localStorage.setItem(UNLOCK_FLAG, '1');
    showScreen('appScreen'); renderAll();
  });
  safeGet('skipPasswordBtn')?.addEventListener('click', ()=> {
    // user skipped
    localStorage.setItem(UNLOCK_FLAG,'1');
    showScreen('appScreen'); renderAll();
  });

  // logout
  safeGet('logoutBtn')?.addEventListener('click', ()=> {
    if(confirm('Lock app?')) {
      localStorage.removeItem(UNLOCK_FLAG);
      // go back to login
      showScreen('loginScreen');
    }
  });

  // month selector change
  safeGet('monthSelector')?.addEventListener('change', (e)=> {
    setCurrentMonth(e.target.value);
    renderAll();
  });

  // starting balance change
  safeGet('startingBalance')?.addEventListener('change', (e)=> {
    const v = Number(e.target.value || 0);
    ensureMonth(state.currentMonthKey);
    state.months[state.currentMonthKey].startingBalance = Number(v);
    saveState();
    renderAll();
  });

  // carry percent save
  safeGet('carryPercent')?.addEventListener('change', (e)=> {
    const v = clampCarryPct(Number(e.target.value || 2));
    state.settings.carryPercent = v;
    saveState();
    alert(`Carry percent saved (${v}%).`);
    renderAll();
  });

  // Add Income
  safeGet('addIncomeBtn')?.addEventListener('click', ()=> {
    const source = elVal('incomeSource').trim(); const amount = Number(elVal('incomeAmount')||0); const date = elVal('incomeDate') || nowISO();
    if(!source || !amount) return alert('Fill income source and amount');
    addIncome(state.currentMonthKey, { source, amount, date });
    setElVal('incomeSource',''); setElVal('incomeAmount',''); setElVal('incomeDate','');
    renderAll();
  });

  // Add Expense
  safeGet('addExpenseBtn')?.addEventListener('click', ()=> {
    const category = elVal('expenseCategory').trim(); const budgeted = Number(elVal('expenseBudget')||0); const actual = Number(elVal('expenseActual')||0); const date = elVal('expenseDate') || nowISO();
    if(!category) return alert('Enter category');
    if(!(budgeted || actual)) return alert('Enter a budgeted or actual amount');
    addExpense(state.currentMonthKey, { category, budgeted, actual, date });
    setElVal('expenseCategory',''); setElVal('expenseBudget',''); setElVal('expenseActual',''); setElVal('expenseDate','');
    renderAll();
  });

  // Add Debit template
  safeGet('addDebitBtn')?.addEventListener('click', ()=> {
    const title = elVal('debitName').trim(); const amount = Number(elVal('debitAmount')||0); const dateStr = elVal('debitDate');
    if(!title || !amount) return alert('Fill debit name & amount');
    let day = 1;
    if(dateStr){ const d = new Date(dateStr); if(!isNaN(d)) day = d.getDate(); }
    addDebitTemplate({ title, day, amount });
    setElVal('debitName',''); setElVal('debitAmount',''); setElVal('debitDate','');
    renderAll();
  });

  // Add savings account
  safeGet('addSavingsBtn')?.addEventListener('click', ()=> {
    const name = elVal('savingsName').trim(); const balance = Number(elVal('savingsCurrent')||0); const monthly = Number(elVal('savingsMonthly')||0); const rate = Number(elVal('savingsRate')||0);
    if(!name) return alert('Enter account name');
    addSavingsAccount({ name, balance, monthlySetAside: monthly, annualInterest: rate });
    setElVal('savingsName',''); setElVal('savingsCurrent',''); setElVal('savingsMonthly',''); setElVal('savingsRate','');
    renderAll();
  });

  // Add goal
  safeGet('addGoalBtn')?.addEventListener('click', ()=> {
    const title = elVal('goalName').trim(); const target = Number(elVal('goalTarget')||0);
    if(!title || !target) return alert('Enter goal details');
    addGoal({ title, targetAmount: target });
    setElVal('goalName',''); setElVal('goalTarget','');
    renderAll();
  });

  // Export PDF & CSV
  safeGet('exportPdfBtn')?.addEventListener('click', ()=> {
    if(!confirm('Export current month as PDF?')) return;
    exportMonthPDF(state.currentMonthKey);
  });

  // table action buttons are wired per-row in render functions
}

/* ---------------------------
   Initialization & Auth guard
   --------------------------- */

function showAppropriateScreenOnLoad(){
  const unlocked = !!(localStorage.getItem(UNLOCK_FLAG) || sessionStorage.getItem(UNLOCK_FLAG));
  // if unlocked -> show app, else show login
  if(unlocked){
    // show app
    document.getElementById('loginScreen').classList.remove('show');
    document.getElementById('setupScreen').classList.remove('show');
    document.getElementById('appScreen').classList.add('show');
    // make sure current month exists
    ensureMonth(state.currentMonthKey);
    renderAll();
  } else {
    document.getElementById('loginScreen').classList.add('show');
    document.getElementById('setupScreen').classList.remove('show');
    document.getElementById('appScreen').classList.remove('show');
  }
}

window.addEventListener('load', ()=>{
  // wire UI and then show appropriate screen
  try{
    wireUI();
    // ensure the month exists (applies debits)
    ensureMonth(state.currentMonthKey);
    showAppropriateScreenOnLoad();
  }catch(e){
    console.error('Init error', e);
    alert('Initialization failed — check console');
  }
});

/* ---------------------------
   Small helpers for developer testing (expose to window)
   --------------------------- */

window.bb_debug = {
  state,
  saveState,
  ensureMonth,
  computeTotals,
  exportMonthPDF,
  exportMonthCSV
};
