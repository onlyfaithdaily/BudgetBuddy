/* app.js - Enhanced BudgetBuddy logic
   Features:
   - incomes, expenses with remove support
   - monthly archive & move next/previous month
   - set-aside monthly savings and compound projection
   - savings goals per cause and months-to-goal calculator
   - fixed monthly debit orders
   - advice generation
   - simple password protection (localStorage)
   - persistence via localStorage
*/

///////////////////////
// Utilities & Storage
///////////////////////

const STORAGE_KEY = "budgetbuddy_v2_data_v1";

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    // initial structure
    return {
      passwordHash: null,           // string | null
      currentMonthIndex: 0,         // 0 = first month in months[]
      months: [{
        id: Date.now(),
        year: new Date().getFullYear(),
        month: new Date().getMonth() + 1, // 1-12
        incomes: [],
        expenses: [],
        monthlyDebits: [] // fixed monthly debits that repeat each month
      }],
      monthlySetAside: 0,          // amount user chooses to save each month
      monthlyInterestRate: 0,      // in percent (annual or monthly? we use monthly %)
      savingsGoals: []             // { id, title, targetAmount, savedSoFar (optional) }
    };
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse storage, resetting", e);
    localStorage.removeItem(STORAGE_KEY);
    return loadState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

///////////////////////
// Password protection
///////////////////////

// NOTE: This is a lightweight protection using btoa. For production, use secure hashing & server-side auth.
function setPassword(plain) {
  if(!plain) return;
  const h = btoa(plain); // not secure, but simple for local usage
  state.passwordHash = h;
  saveState();
}

function checkPassword(plain) {
  if (!state.passwordHash) return true; // no password set
  return btoa(plain || "") === state.passwordHash;
}

function removePassword() {
  state.passwordHash = null;
  saveState();
}

/////////////////////////////
// Month & archival methods
/////////////////////////////

function getCurrentMonth() {
  return state.months[state.currentMonthIndex];
}

function addNewMonthAfterCurrent() {
  const cur = getCurrentMonth();
  // compute next month/year
  let m = cur.month + 1;
  let y = cur.year;
  if (m > 12) { m = 1; y++; }
  const newMonth = {
    id: Date.now(),
    year: y,
    month: m,
    incomes: [],
    expenses: [],
    monthlyDebits: JSON.parse(JSON.stringify(cur.monthlyDebits)) // carry forward debits
  };
  // push after current index and move pointer
  state.months.splice(state.currentMonthIndex + 1, 0, newMonth);
  state.currentMonthIndex += 1;
  saveState();
}

function moveToPreviousMonth() {
  if (state.currentMonthIndex > 0) {
    state.currentMonthIndex -= 1;
    saveState();
  }
}

function moveToNextMonth() {
  if (state.currentMonthIndex < state.months.length - 1) {
    state.currentMonthIndex += 1;
  } else {
    // create next month if it doesn't exist yet
    addNewMonthAfterCurrent();
  }
  saveState();
}

///////////////////////
// Core add/remove
///////////////////////

function addIncome(source, amount) {
  if(!source || !isFinite(amount)) return;
  const cur = getCurrentMonth();
  cur.incomes.push({ id: Date.now() + Math.random(), source, amount: Number(amount) });
  saveState();
}

function removeIncome(id) {
  const cur = getCurrentMonth();
  cur.incomes = cur.incomes.filter(i => i.id !== id);
  saveState();
}

function addExpense(category, amount) {
  if(!category || !isFinite(amount)) return;
  const cur = getCurrentMonth();
  cur.expenses.push({ id: Date.now() + Math.random(), category, amount: Number(amount) });
  saveState();
}

function removeExpense(id) {
  const cur = getCurrentMonth();
  cur.expenses = cur.expenses.filter(e => e.id !== id);
  saveState();
}

//////////////////////////
// Monthly fixed debits
//////////////////////////

function addMonthlyDebit(title, amount) {
  if(!title || !isFinite(amount)) return;
  // monthly debits stored at app level but copied into months when new months created
  const cur = getCurrentMonth();
  cur.monthlyDebits.push({ id: Date.now() + Math.random(), title, amount: Number(amount) });
  saveState();
}

function removeMonthlyDebit(id) {
  const cur = getCurrentMonth();
  cur.monthlyDebits = cur.monthlyDebits.filter(d=>d.id !== id);
  saveState();
}

//////////////////////////
// Savings & goals
//////////////////////////

function setMonthlySetAside(amount) {
  state.monthlySetAside = Number(amount) || 0;
  saveState();
}

function setMonthlyInterestRate(percentMonthly) {
  state.monthlyInterestRate = Number(percentMonthly) || 0; // expressed per month percent (e.g., 0.5)
  saveState();
}

function addSavingsGoal(title, targetAmount, savedSoFar = 0) {
  if(!title || !isFinite(targetAmount)) return;
  state.savingsGoals.push({
    id: Date.now() + Math.random(),
    title,
    targetAmount: Number(targetAmount),
    savedSoFar: Number(savedSoFar)
  });
  saveState();
}

function removeSavingsGoal(id) {
  state.savingsGoals = state.savingsGoals.filter(g=>g.id !== id);
  saveState();
}

function updateSavingsGoalSaved(id, newSaved) {
  const goal = state.savingsGoals.find(g=>g.id===id);
  if(goal) {
    goal.savedSoFar = Number(newSaved);
    saveState();
  }
}

//////////////////////////////
// Calculations & insights
//////////////////////////////

function totalIncomeForCurrent() {
  const cur = getCurrentMonth();
  return cur.incomes.reduce((s,i)=>s + Number(i.amount), 0);
}

function totalExpensesForCurrent() {
  const cur = getCurrentMonth();
  const expensesSum = cur.expenses.reduce((s,e)=>s + Number(e.amount), 0);
  const debitsSum = cur.monthlyDebits.reduce((s,d)=>s + Number(d.amount), 0);
  return expensesSum + debitsSum;
}

function getBiggestExpense() {
  const cur = getCurrentMonth();
  const combined = [...cur.expenses.map(e=>({...e, type:'expense'})), ...cur.monthlyDebits.map(d=>({...d, type:'debit'}))];
  if (combined.length === 0) return null;
  return combined.reduce((max, x)=> x.amount > max.amount ? x : max);
}

// Future value with monthly compounding
// FV = P * (1 + r)^n + PMT * [((1+r)^n - 1)/r]
// Here we assume user sets monthly set-aside (PMT) and there's an initial balance equal to current savings
function futureValue(months, monthlyRateDecimal, initial=0, monthlyContribution=0) {
  const r = Number(monthlyRateDecimal);
  const n = Number(months);
  if (n <= 0) return initial;
  // If r == 0:
  if (r === 0) return initial + monthlyContribution * n;
  const fvInitial = initial * Math.pow(1 + r, n);
  const fvContrib = monthlyContribution * ((Math.pow(1 + r, n) - 1) / r);
  return fvInitial + fvContrib;
}

// months needed to reach a goal using monthly contribution and compounding approximate
// uses iterative approach if interest > 0
function monthsToReachGoal(target, monthlyRateDecimal, initial=0, monthlyContribution=0, maxMonths=1000) {
  if (monthlyContribution <= 0) return Infinity;
  for (let m = 1; m <= maxMonths; m++) {
    const fv = futureValue(m, monthlyRateDecimal, initial, monthlyContribution);
    if (fv >= target) return m;
  }
  return Infinity;
}

function generateInsights(currencySymbol) {
  const totalIncome = totalIncomeForCurrent();
  const totalExpenses = totalExpensesForCurrent();
  const savings = totalIncome - totalExpenses;
  let insights = [];

  // Savings / income ratio
  if (totalIncome === 0) {
    insights.push({ type: 'warning', text: `No income recorded for this month.` });
  } else {
    const savingRate = (savings / totalIncome) * 100;
    if (savingRate < 0) {
      insights.push({ type: 'danger', text: `You're overspending by ${currencySymbol}${Math.abs(savings).toFixed(2)} (${(Math.abs(savingRate)).toFixed(1)}% of income)`});
    } else {
      insights.push({ type: 'positive', text: `You're saving ${currencySymbol}${savings.toFixed(2)} (${savingRate.toFixed(1)}% of income)`});
      if (savingRate < 10) {
        insights.push({ type: 'advice', text: `Try to increase your savings rate — aim for at least 20% of income.`});
      } else if (savingRate >= 20) {
        insights.push({ type: 'positive', text: `Good job — saving >= 20% of income.`});
      }
    }
  }

  // biggest expense
  const biggest = getBiggestExpense();
  if (biggest) {
    insights.push({ type: 'info', text: `Biggest ongoing spend: ${biggest.type === 'debit' ? 'Debit' : 'Expense'} - ${biggest.title || biggest.category} (${currencySymbol}${biggest.amount.toFixed(2)})`});
  }

  // each expense percent of income
  const cur = getCurrentMonth();
  cur.expenses.forEach(e => {
    if (totalIncome > 0) {
      const pct = (e.amount / totalIncome) * 100;
      if (pct > 30) {
        insights.push({ type: 'advice', text: `Consider reducing ${e.category} — it's ${pct.toFixed(1)}% of your income.`});
      }
    }
  });

  // fixed debits burden
  const debitsSum = cur.monthlyDebits.reduce((s,d)=>s + Number(d.amount), 0);
  if (totalIncome > 0) {
    const debitsPct = (debitsSum / totalIncome) * 100;
    if (debitsPct > 50) {
      insights.push({ type: 'danger', text: `Monthly fixed debits are ${debitsPct.toFixed(1)}% of income — consider renegotiating or cancelling some.`});
    } else if (debitsPct > 30) {
      insights.push({ type: 'advice', text: `Fixed monthly debits are ${debitsPct.toFixed(1)}% of income — keep an eye on them.`});
    }
  }

  // set-aside advice
  if (state.monthlySetAside > 0) {
    if (totalIncome === 0) {
      insights.push({ type: 'advice', text: `You set aside ${currencySymbol}${state.monthlySetAside.toFixed(2)} month, but current month has no income recorded.`});
    } else {
      const pct = (state.monthlySetAside / totalIncome) * 100;
      insights.push({ type: 'info', text: `You plan to set aside ${currencySymbol}${state.monthlySetAside.toFixed(2)} per month (${pct.toFixed(1)}% of this month's income).`});
      if (pct < 5) insights.push({ type: 'advice', text: `Consider increasing monthly set-aside, even small increases compound over time.`});
    }
  }

  return insights;
}

//////////////////////////
// Currency & Symbol
//////////////////////////

function getCurrencySymbol(currency) {
  if (!currency) currency = document.getElementById("currencySelect")?.value || "ZAR";
  if (currency === "ZAR") return "R";
  if (currency === "USD") return "$";
  if (currency === "EUR") return "€";
  return "";
}

//////////////////////////
// UI Binding & Rendering
//////////////////////////

// Minimal DOM helpers
function $id(id) { return document.getElementById(id); }

function renderAll() {
  renderMonthHeader();
  renderIncomes();
  renderExpenses();
  renderDebits();
  renderSummary();
  renderCharts();
  renderSavingsGoals();
  renderAdvice();
  renderPasswordUI();
}

// Month header with nav
function renderMonthHeader() {
  const cur = getCurrentMonth();
  const mName = new Date(cur.year, cur.month - 1, 1).toLocaleString(undefined, { month: 'long' });
  $id("monthLabel").innerText = `${mName} ${cur.year}`;
}

// Incomes table with remove buttons
function renderIncomes() {
  const table = $id("incomeTable");
  const cur = getCurrentMonth();
  const symbol = getCurrencySymbol();
  // build rows
  let html = `<tr><th>Source</th><th>Amount</th><th>Action</th></tr>`;
  cur.incomes.forEach(i => {
    html += `<tr>
      <td>${escapeHtml(i.source)}</td>
      <td>${symbol}${Number(i.amount).toFixed(2)}</td>
      <td><button onclick="onRemoveIncome(${i.id})">Remove</button></td>
    </tr>`;
  });
  table.innerHTML = html;
}

// Expenses table with remove
function renderExpenses() {
  const table = $id("expenseTable");
  const cur = getCurrentMonth();
  const symbol = getCurrencySymbol();
  let html = `<tr><th>Category</th><th>Amount</th><th>Action</th></tr>`;
  cur.expenses.forEach(e => {
    html += `<tr>
      <td>${escapeHtml(e.category)}</td>
      <td>${symbol}${Number(e.amount).toFixed(2)}</td>
      <td><button onclick="onRemoveExpense(${e.id})">Remove</button></td>
    </tr>`;
  });
  table.innerHTML = html;
}

function renderDebits() {
  const table = $id("debitsTable");
  const cur = getCurrentMonth();
  const symbol = getCurrencySymbol();
  let html = `<tr><th>Debit Title</th><th>Amount</th><th>Action</th></tr>`;
  cur.monthlyDebits.forEach(d => {
    html += `<tr>
      <td>${escapeHtml(d.title)}</td>
      <td>${symbol}${Number(d.amount).toFixed(2)}</td>
      <td><button onclick="onRemoveDebit(${d.id})">Remove</button></td>
    </tr>`;
  });
  table.innerHTML = html;
}

// Summary + set aside + compound projection
function renderSummary() {
  const symbol = getCurrencySymbol();
  const totalIncome = totalIncomeForCurrent();
  const totalExpenses = totalExpensesForCurrent();
  const savings = totalIncome - totalExpenses;
  $id("totalIncome").innerText = symbol + totalIncome.toFixed(2);
  $id("totalExpenses").innerText = symbol + totalExpenses.toFixed(2);
  $id("totalSavings").innerText = symbol + savings.toFixed(2);

  // set-aside inputs
  $id("monthlySetAsideInput").value = state.monthlySetAside;
  $id("monthlyInterestInput").value = state.monthlyInterestRate;

  // compound projection preview for 12 months and 60 months
  const initialSavings = Math.max(0, savings); // assume immediate available saved amount
  const monthlyRateDecimal = state.monthlyInterestRate / 100;
  const fv12 = futureValue(12, monthlyRateDecimal, initialSavings, state.monthlySetAside);
  const fv60 = futureValue(60, monthlyRateDecimal, initialSavings, state.monthlySetAside);
  $id("projection12").innerText = `${symbol}${fv12.toFixed(2)} (12 months)`;
  $id("projection60").innerText = `${symbol}${fv60.toFixed(2)} (60 months)`;
}

// Savings goals
function renderSavingsGoals() {
  const container = $id("goalsList");
  const symbol = getCurrencySymbol();
  let html = "";
  state.savingsGoals.forEach(g => {
    const remaining = Math.max(0, g.targetAmount - (g.savedSoFar || 0));
    const monthlyRateDecimal = state.monthlyInterestRate / 100;
    const monthsNeeded = monthsToReachGoal(
      g.targetAmount,
      monthlyRateDecimal,
      g.savedSoFar || 0,
      state.monthlySetAside
    );
    const monthsText = monthsNeeded === Infinity ? "— (increase monthly set-aside)" : `${monthsNeeded} months`;
    html += `<div class="goal-item">
      <strong>${escapeHtml(g.title)}</strong> — target ${symbol}${Number(g.targetAmount).toFixed(2)}; saved ${symbol}${Number(g.savedSoFar || 0).toFixed(2)}; remaining ${symbol}${remaining.toFixed(2)}; est: ${monthsText}
      <div><button onclick="onRemoveGoal(${g.id})">Remove</button> 
      <button onclick="onEditGoalSaved(${g.id})">Edit saved</button></div>
    </div>`;
  });
  container.innerHTML = html || "<p>No goals yet</p>";
}

// Advice / insights render
function renderAdvice() {
  const container = $id("insights");
  const symbol = getCurrencySymbol();
  const insights = generateInsights(symbol);
  let html = "";
  insights.forEach(ins => {
    let color = "#333";
    if (ins.type === 'danger') color = "red";
    else if (ins.type === 'advice') color = "orange";
    else if (ins.type === 'positive') color = "green";
    html += `<p style="color:${color}">${escapeHtml(ins.text)}</p>`;
  });
  container.innerHTML = html;
}

// Chart rendering using Chart.js
let barChart = null, pieChart = null;
function renderCharts() {
  const ctxBar = document.getElementById("barChart")?.getContext("2d");
  const ctxPie = document.getElementById("pieChart")?.getContext("2d");
  if(!ctxBar || !ctxPie) return;

  const totalIncome = totalIncomeForCurrent();
  const totalExpenses = totalExpensesForCurrent();

  if (barChart) barChart.destroy();
  barChart = new Chart(ctxBar, {
    type: 'bar',
    data: {
      labels: ['Income','Expenses'],
      datasets: [{
        label: 'Amount',
        data: [totalIncome, totalExpenses],
        backgroundColor: ['#28a745','#dc3545']
      }]
    },
    options: { responsive:true }
  });

  // Pie: expense categories + debits
  const cur = getCurrentMonth();
  const labels = [];
  const data = [];

  cur.expenses.forEach(e => {
    labels.push(e.category);
    data.push(e.amount);
  });
  cur.monthlyDebits.forEach(d => {
    labels.push(d.title);
    data.push(d.amount);
  });

  if (pieChart) pieChart.destroy();
  pieChart = new Chart(ctxPie, {
    type: 'pie',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map(_=> '#'+Math.floor(Math.random()*16777215).toString(16))
      }]
    },
    options: { responsive:true }
  });
}

///////////////////////////
// DOM event handlers
///////////////////////////

function onAddIncomeFromUI() {
  const source = $id("incomeSource").value.trim();
  const amount = Number($id("incomeAmount").value);
  if(!source || !amount) return alert("Fill both income fields");
  addIncome(source, amount);
  $id("incomeSource").value = "";
  $id("incomeAmount").value = "";
  renderAll();
}

function onAddExpenseFromUI() {
  const category = $id("expenseCategory").value.trim();
  const amount = Number($id("expenseAmount").value);
  if(!category || !amount) return alert("Fill both expense fields");
  addExpense(category, amount);
  $id("expenseCategory").value = "";
  $id("expenseAmount").value = "";
  renderAll();
}

function onRemoveIncome(id) {
  if(!confirm("Remove this income?")) return;
  removeIncome(id);
  renderAll();
}

function onRemoveExpense(id) {
  if(!confirm("Remove this expense?")) return;
  removeExpense(id);
  renderAll();
}

function onAddDebitFromUI() {
  const title = $id("debitTitle").value.trim();
  const amount = Number($id("debitAmount").value);
  if(!title || !amount) return alert("Fill debit fields");
  addMonthlyDebit(title, amount);
  $id("debitTitle").value = "";
  $id("debitAmount").value = "";
  renderAll();
}

function onRemoveDebit(id) {
  if(!confirm("Remove this debit?")) return;
  removeMonthlyDebit(id);
  renderAll();
}

function onSaveSetAside() {
  const amt = Number($id("monthlySetAsideInput").value);
  const interest = Number($id("monthlyInterestInput").value);
  setMonthlySetAside(amt);
  setMonthlyInterestRate(interest);
  renderAll();
}

function onAddGoalFromUI() {
  const title = $id("goalTitle").value.trim();
  const amount = Number($id("goalAmount").value);
  if(!title || !amount) return alert("Fill goal fields");
  addSavingsGoal(title, amount, 0);
  $id("goalTitle").value = "";
  $id("goalAmount").value = "";
  renderAll();
}

function onRemoveGoal(id) {
  if(!confirm("Remove this goal?")) return;
  removeSavingsGoal(id);
  renderAll();
}

function onEditGoalSaved(id) {
  const g = state.savingsGoals.find(x=>x.id===id);
  if(!g) return;
  const newSaved = prompt("Enter new amount saved so far for this goal:", g.savedSoFar || 0);
  if (newSaved === null) return;
  const n = Number(newSaved);
  if (isNaN(n)) return alert("Invalid number");
  updateSavingsGoalSaved(id, n);
  renderAll();
}

// Month nav handlers
function onPrevMonth() {
  moveToPreviousMonth();
  renderAll();
}
function onNextMonth() {
  moveToNextMonth();
  renderAll();
}

// Password UI handlers
function onSetPasswordUI() {
  const pass = prompt("Enter a new password (will be stored locally):");
  if (pass === null) return;
  if (pass === "") {
    if (!confirm("Empty password will remove protection. Continue?")) return;
    removePassword();
    alert("Password removed.");
  } else {
    setPassword(pass);
    alert("Password set locally.");
  }
  renderPasswordUI();
}

function onEnterPasswordUI() {
  if (!state.passwordHash) {
    renderPasswordUI();
    return; // no password set
  }
  const pass = prompt("Enter password to unlock app:");
  if (pass === null) return;
  if (checkPassword(pass)) {
    localStorage.setItem("budgetbuddy_unlocked", "1");
    alert("Unlocked for this session.");
    renderPasswordUI();
  } else {
    alert("Wrong password.");
  }
}

function onLockApp() {
  localStorage.removeItem("budgetbuddy_unlocked");
  renderPasswordUI();
}

function renderPasswordUI() {
  // show/hide lock controls based on whether password is set and if unlocked for the session
  const hasPass = !!state.passwordHash;
  const sessionUnlocked = !!localStorage.getItem("budgetbuddy_unlocked");
  $id("passwordStatus").innerText = hasPass ? (sessionUnlocked ? "Unlocked (session)" : "Locked") : "No password set";
}

//////////////////////////
// Helpers
//////////////////////////

function escapeHtml(unsafe) {
  if (unsafe === undefined || unsafe === null) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

//////////////////////////
// Init & Bind DOM events
//////////////////////////

function initBindings() {
  // income/expense
  $id("addIncomeBtn").addEventListener("click", onAddIncomeFromUI);
  $id("addExpenseBtn").addEventListener("click", onAddExpenseFromUI);
  // debits
  $id("addDebitBtn").addEventListener("click", onAddDebitFromUI);
  // save set-aside
  $id("saveSetAsideBtn").addEventListener("click", onSaveSetAside);
  // goals
  $id("addGoalBtn").addEventListener("click", onAddGoalFromUI);
  // month nav
  $id("prevMonthBtn").addEventListener("click", onPrevMonth);
  $id("nextMonthBtn").addEventListener("click", onNextMonth);
  // password
  $id("setPasswordBtn").addEventListener("click", onSetPasswordUI);
  $id("enterPasswordBtn").addEventListener("click", onEnterPasswordUI);
  $id("lockAppBtn").addEventListener("click", onLockApp);
  // currency select triggers rerender
  $id("currencySelect").addEventListener("change", renderAll);
}

// run on load
window.addEventListener("load", () => {
  // create DOM elements if not present (very defensive)
  if(!$id("app-root")) {
    console.error("Missing app-root element. Check index.html.");
    return;
  }

  initBindings();
  renderAll();
});
