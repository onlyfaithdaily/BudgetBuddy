let incomes = JSON.parse(localStorage.getItem("incomes") || "[]");
let expenses = JSON.parse(localStorage.getItem("expenses") || "[]");

function saveData() {
  localStorage.setItem("incomes", JSON.stringify(incomes));
  localStorage.setItem("expenses", JSON.stringify(expenses));
}

// Add income
function addIncome() {
  const source = document.getElementById("incomeSource").value;
  const amount = Number(document.getElementById("incomeAmount").value);
  if (!source || !amount) return alert("Fill both fields");
  incomes.push({ source, amount });
  saveData();
  updateUI();
}

// Add expense
function addExpense() {
  const category = document.getElementById("expenseCategory").value;
  const amount = Number(document.getElementById("expenseAmount").value);
  if (!category || !amount) return alert("Fill both fields");
  expenses.push({ category, amount });
  saveData();
  updateUI();
}

// Currency
function getCurrencySymbol() {
  const currency = document.getElementById("currencySelect").value;
  if(currency === "ZAR") return "R";
  if(currency === "USD") return "$";
  if(currency === "EUR") return "€";
  return "";
}

// Update UI
function updateUI() {
  updateIncomeTable();
  updateExpenseTable();
  updateSummary();
  updateCharts();
}

// Update Income Table
function updateIncomeTable() {
  const table = document.getElementById("incomeTable");
  const symbol = getCurrencySymbol();
  table.innerHTML = "<tr><th>Source</th><th>Amount</th></tr>";
  incomes.forEach(i => {
    table.innerHTML += `<tr><td>${i.source}</td><td>${symbol}${i.amount}</td></tr>`;
  });
}

// Update Expense Table
function updateExpenseTable() {
  const table = document.getElementById("expenseTable");
  const symbol = getCurrencySymbol();
  table.innerHTML = "<tr><th>Category</th><th>Amount</th></tr>";
  expenses.forEach(e => {
    table.innerHTML += `<tr><td>${e.category}</td><td>${symbol}${e.amount}</td></tr>`;
  });
}

// Update Summary & Suggestions
function updateSummary() {
  const symbol = getCurrencySymbol();
  const totalIncome = incomes.reduce((s,i)=>s+i.amount,0);
  const totalExpenses = expenses.reduce((s,e)=>s+e.amount,0);
  const savings = totalIncome - totalExpenses;

  document.getElementById("totalIncome").innerText = symbol + totalIncome;
  document.getElementById("totalExpenses").innerText = symbol + totalExpenses;
  document.getElementById("totalSavings").innerText = symbol + savings;

  let insights = "";
  if(savings<0) insights += `<p style="color:red">Overspending by ${symbol}${Math.abs(savings)}</p>`;
  else insights += `<p style="color:green">Saving ${symbol}${savings}</p>`;

  if(expenses.length>0){
    const biggest = expenses.reduce((max,e)=>e.amount>max.amount?e:max);
    insights += `<p>Biggest expense: ${biggest.category} (${symbol}${biggest.amount})</p>`;
    if(savings>0) insights += `<p>Try to save at least 20% of income: ${symbol}${(totalIncome*0.2).toFixed(2)}</p>`;
    expenses.forEach(e=>{
      const percent = ((e.amount/totalIncome)*100).toFixed(1);
      if(percent>30) insights += `<p>Consider reducing ${e.category} (${percent}% of income)</p>`;
    });
  }
  document.getElementById("insights").innerHTML = insights;
}

// Charts
let barChart, pieChart;
function updateCharts() {
  const ctxBar = document.getElementById("barChart").getContext("2d");
  const ctxPie = document.getElementById("pieChart").getContext("2d");

  const totalIncome = incomes.reduce((s,i)=>s+i.amount,0);
  const totalExpenses = expenses.reduce((s,e)=>s+e.amount,0);

  if(barChart) barChart.destroy();
  if(pieChart) pieChart.destroy();

  barChart = new Chart(ctxBar, {
    type: 'bar',
    data: {
      labels: ['Income','Expenses'],
      datasets: [{
        label: 'Amount',
        data: [totalIncome,totalExpenses],
        backgroundColor: ['#28a745','#dc3545']
      }]
    },
    options: { responsive:true }
  });

  const categories = expenses.map(e=>e.category);
  const amounts = expenses.map(e=>e.amount);
  const colors = categories.map(_=> '#' + Math.floor(Math.random()*16777215).toString(16));

  pieChart = new Chart(ctxPie, {
    type: 'pie',
    data: {
      labels: categories,
      datasets: [{
        data: amounts,
        backgroundColor: colors
      }]
    },
    options: { responsive:true }
  });
}

// Initialize UI
updateUI();
