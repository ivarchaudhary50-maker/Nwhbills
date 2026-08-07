// ============================================================
// SAFE STORAGE & ESCAPING UTILITIES
// ============================================================
function safeGetLocal(k) { try { return localStorage.getItem(k); } catch(e) { return null; } }
function safeSetLocal(k, v) { try { localStorage.setItem(k, v); } catch(e) {} }

function escapeJsStr(str) {
    return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function escapeHtmlAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let editBillKey = null;
let editInvoiceNum = null;
let pendingBill = null;
let lang = 'en';
let allPokas = [];
let inventoryList = [];
let cloudCustomers={}, cloudNextInvoice=1001, allBills=[], db=null, fbReady=false;
let _payKey='', _payCust='';

// ============================================================
// PIN LOCK LOGIC (UNLOCKS WITH 8860)
// ============================================================
let pinCode = '';
const CORRECT_PIN = '8860'; 

function pinPress(num) {
  if (pinCode.length < 4) {
    pinCode += num;
    const dot = document.getElementById('d' + (pinCode.length - 1));
    if (dot) dot.classList.add('filled');
  }

  if (pinCode.length === 4) {
    if (pinCode === CORRECT_PIN) {
      const pw = document.getElementById('pw-screen');
      if (pw) {
        pw.style.display = 'none'; 
      }
      resetPinState();
    } else {
      const err = document.getElementById('pw-err');
      if (err) err.innerText = 'Incorrect PIN';

      setTimeout(() => {
        resetPinState();
        if (err) err.innerText = '';
      }, 600);
    }
  }
}

function pinDel() {
  if (pinCode.length > 0) {
    const dot = document.getElementById('d' + (pinCode.length - 1));
    if (dot) dot.classList.remove('filled');
    pinCode = pinCode.slice(0, -1);
  }
  const err = document.getElementById('pw-err');
  if (err) err.innerText = '';
}

function resetPinState() {
  pinCode = '';
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('d' + i);
    if (dot) dot.classList.remove('filled');
  }
}

// ============================================================
// DEBOUNCE LOGIC
// ============================================================
function debounce(func, delay = 300) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), delay);
  };
}

// ============================================================
// OFFLINE OUTBOX QUEUE
// ============================================================
let isSyncing = false;
let syncQueue = JSON.parse(safeGetLocal('nwh_sync_queue') || '[]');

function updateSyncBadge() {
    const syncEl = document.getElementById('sync-status');
    if (!syncEl) return;
    if (!fbReady) {
        syncEl.innerHTML = syncQueue.length > 0 ? `🟡 Offline (${syncQueue.length} pending)` : '🟡 Offline';
        syncEl.className = 'sync-badge';
    } else if (isSyncing || syncQueue.length > 0) {
        syncEl.innerHTML = `🔄 Syncing (${syncQueue.length} left)...`;
        syncEl.className = 'sync-badge';
    } else {
        syncEl.innerHTML = '🟢 Synced <span style="cursor:pointer; text-decoration:underline; margin-left:5px;" onclick="location.reload()">↻</span>';
        syncEl.className = 'sync-badge synced';
    }
}

function queueDatabaseWrite(path, method, data) {
    syncQueue.push({ id: Date.now(), path, method, data });
    safeSetLocal('nwh_sync_queue', JSON.stringify(syncQueue));
    updateSyncBadge();
    processSyncQueue();
}

async function processSyncQueue() {
    if (!fbReady || isSyncing || syncQueue.length === 0) {
        updateSyncBadge();
        return;
    }
    isSyncing = true;
    updateSyncBadge();

    const item = syncQueue[0];
    let ref = db.ref(item.path);

    try {
        if (item.method === 'push') await ref.push(item.data);
        else if (item.method === 'set') await ref.set(item.data);
        else if (item.method === 'update') await ref.update(item.data);
        else if (item.method === 'remove') await ref.remove();

        syncQueue.shift(); 
        safeSetLocal('nwh_sync_queue', JSON.stringify(syncQueue));
        isSyncing = false;
        processSyncQueue(); 
    } catch(err) {
        console.error("Sync failed:", err);
        isSyncing = false;
        updateSyncBadge();
    }
}

// ============================================================
// DYNAMIC TRUE CUSTOMER BALANCE
// ============================================================
function getCustomerTrueBalance(custName) {
    if (!custName) return 0;
    
    if (Array.isArray(allBills)) {
        const latestBill = allBills.find(b => b && typeof b === 'object' && b.customer === custName);
        if (latestBill && latestBill.remaining !== undefined && latestBill.remaining !== '') {
            const rem = parseFloat(latestBill.remaining);
            if (!isNaN(rem)) return rem;
        }
    }
    
    if (cloudCustomers && cloudCustomers[custName] && cloudCustomers[custName].balance !== undefined && cloudCustomers[custName].balance !== '') {
        const bal = parseFloat(cloudCustomers[custName].balance);
        if (!isNaN(bal)) return bal;
    }
    
    return 0;
}

// ============================================================
// CUSTOMER AUTO-FILL LOGIC
// ============================================================
function triggerCustomerAutoFill() {
    const nameEl = document.getElementById('customer-name');
    if(!nameEl) return;
    const rawName = nameEl.value.trim();
    if(!rawName) return;
    
    const searchName = rawName.toLowerCase();
    let cu = null;

    for(let key in cloudCustomers) {
        if(key.toLowerCase() === searchName) {
            cu = cloudCustomers[key];
            break;
        }
    }
    
    if(cu) {
        document.getElementById('customer-phone').value = cu.phone || '';
        document.getElementById('customer-address').value = cu.address || '';
        if (!editBillKey) {
            document.getElementById('prev-balance').value = getCustomerTrueBalance(rawName);
            calc();
        }
    }
}

// ============================================================
// SUGGESTION BAR SYSTEM
// ============================================================
function initSuggestionBar() {
    const bar = document.getElementById('suggestion-bar');
    if (!bar) return;
    
    document.addEventListener('focusin', (e) => {
        const target = e.target;
        if(target.tagName === 'INPUT' && (target.id === 'customer-name' || target.id === 'slip-customer' || target.classList.contains('item-desc') || target.classList.contains('poka-desc-inp'))) {
            updateSuggestions(target);
            bar.style.display = 'flex';
        } else {
            bar.style.display = 'none';
        }
    });

    document.addEventListener('focusout', () => {
        setTimeout(() => { 
            if(!document.activeElement || document.activeElement.tagName !== 'INPUT') {
                bar.style.display = 'none'; 
            }
        }, 150);
    });
}

function updateSuggestions(target) {
    const bar = document.getElementById('suggestion-bar');
    if(!bar) return;
    bar.innerHTML = '';
    let opts = (target.id === 'customer-name' || target.id === 'slip-customer') ? Object.keys(cloudCustomers || {}) : (inventoryList || []);
    
    if (opts.length === 0) { bar.style.display = 'none'; return; }
    
    opts.slice(0, 15).forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 's-btn';
        btn.innerText = opt;
        btn.onmousedown = (e) => e.preventDefault(); 
        
        btn.onclick = () => { 
            target.value = opt; 
            target.dispatchEvent(new Event('input')); 
            if(target.oninput) target.oninput(target); 
            
            if (target.id === 'customer-name') {
                triggerCustomerAutoFill();
            } else if(target.classList.contains('item-desc')) {
                checkAndAutoFillRate(target);
            }
            bar.style.display = 'none';
        };
        bar.appendChild(btn);
    });
}

// ============================================================
// LANGUAGE SYSTEM
// ============================================================
const STR = {
  en: { 'New Invoice':'New Invoice', 'Packing Slips':'Packing Slips', 'Bill History':'Bill History','Customer Ledger':'Customer Ledger','Bill To':'Bill To','Items':'Items','Garment Description':'Garment Description','Code':'Code','Qty':'Qty','Rate (NRS)':'Rate (NRS)','Total':'Total','Items Subtotal':'Items Subtotal','Total Poka':'Total Poka','Transport (+)':'Transport (+)','Discount (-)':'Discount (-)','Today\'s Bill NRS':'Today\'s Bill NRS','Purano Baki (+)':'Purano Baki (+)','Jamma Total':'Jamma Total','Nagad Paid (-)':'Nagad Paid (-)','Remaining Baki':'Remaining Baki','Add Row':'Add Row','Clear':'Clear','Preview & Sign':'Preview & Sign','Import from Phone Contacts':'Import from Phone Contacts','Add Item':'Add Item','Loading...':'Loading...','Loading customers...':'Loading customers...','Total Customers':'Total Customers','Total Baki':'Total Baki','Cleared':'Cleared', 'Confirm Payment':'Confirm Payment', 'Notes / Remarks':'Notes / Remarks' },
  np: { 'New Invoice':'नयाँ बिल', 'Packing Slips':'प्याकिङ स्लिप', 'Bill History':'बिल इतिहास','Customer Ledger':'ग्राहक खाता','Bill To':'बिल दिनु','Items':'सामान','Garment Description':'सामानको विवरण','Code':'कोड','Qty':'संख्या','Rate (NRS)':'दर (रु)','Total':'जम्मा','Items Subtotal':'सामान जम्मा','Total Poka':'जम्मा पोका','Transport (+)':'यातायात (+)','Discount (-)':'छुट (-)','Today\'s Bill NRS':'आजको बिल रु','Purano Baki (+)':'पुरानो बाकी (+)','Jamma Total':'जम्मा कुल','Nagad Paid (-)':'नगद भुक्तान (-)','Remaining Baki':'बाँकी रकम','Add Row':'थप्नुस','Clear':'मेट्नुस','Preview & Sign':'बचत गर्नुस','Import from Phone Contacts':'सम्पर्कबाट आयात','Add Item':'सामान थप्नुस','Loading...':'लोड हुँदैछ...','Loading customers...':'ग्राहक लोड हुँदैछ...','Total Customers':'कुल ग्राहक','Total Baki':'कुल बाकी','Cleared':'चुक्ता', 'Confirm Payment':'भुक्तान पुष्टि', 'Notes / Remarks':'नोट / कैफियत' }
};

function applyLang() {
  document.querySelectorAll('.L[data-k]').forEach(el => { const k=el.getAttribute('data-k'); if(STR[lang][k]) el.textContent=STR[lang][k]; });
}
function toggleLang() {
  lang = lang==='en'?'np':'en';
  document.getElementById('lang-btn').textContent = lang==='en'?'नेपाली':'English';
  applyLang(); renderHistory(); renderLedger();
}

// ============================================================
// NEPALI NATIVE CALENDAR SYSTEM
// ============================================================
const ND = [
[2000,[30,32,31,32,31,30,30,30,29,30,29,31]], [2001,[31,31,32,31,31,31,30,29,30,29,30,30]], [2002,[31,31,32,32,31,30,30,29,30,29,30,30]], [2003,[31,32,31,32,31,30,30,30,29,29,30,31]], [2004,[30,32,31,32,31,30,30,30,29,30,29,31]],
[2005,[31,31,32,31,31,31,30,29,30,29,30,30]], [2006,[31,31,32,32,31,30,30,29,30,29,30,30]], [2007,[31,32,31,32,31,30,30,30,29,29,30,31]], [2008,[31,31,31,32,31,30,30,30,29,30,29,31]], [2009,[31,31,32,31,31,31,30,29,30,29,30,30]],
[2010,[31,31,32,32,31,30,30,29,30,29,30,30]], [2011,[31,32,31,32,31,30,30,30,29,29,30,31]], [2012,[31,31,31,32,31,30,30,30,29,30,29,31]], [2013,[31,31,32,31,31,31,30,29,30,29,30,30]], [2014,[31,31,32,32,31,30,30,29,30,29,30,30]],
[2015,[31,32,31,32,31,30,30,30,29,29,30,31]], [2016,[31,31,31,32,31,30,30,30,29,30,29,31]], [2017,[31,31,32,31,31,31,30,29,30,29,30,30]], [2018,[31,31,32,32,31,30,30,29,30,29,30,30]], [2019,[31,32,31,32,31,30,30,30,29,29,30,31]],
[2020,[31,31,31,32,31,30,30,30,29,30,29,31]], [2021,[31,31,32,31,31,31,30,29,30,29,30,30]], [2022,[31,31,32,32,31,30,30,29,30,29,30,30]], [2023,[31,32,31,32,31,30,30,30,29,29,30,31]], [2024,[31,31,31,32,31,30,30,30,29,30,29,31]],
[2025,[31,31,32,31,31,31,30,29,30,29,30,30]], [2026,[31,31,32,32,31,30,30,29,30,29,30,30]], [2027,[31,32,31,32,31,30,30,30,29,29,30,31]], [2028,[31,31,31,32,31,30,30,30,29,30,29,31]], [2029,[31,31,32,31,31,31,30,29,30,29,30,30]],
[2030,[31,31,32,32,31,30,30,29,30,29,30,30]], [2031,[31,32,31,32,31,30,30,30,29,29,30,31]], [2032,[31,31,31,32,31,30,30,30,29,30,29,31]], [2033,[31,31,32,31,31,31,30,29,30,29,30,30]], [2034,[31,31,32,32,31,30,30,29,30,29,30,30]],
[2035,[31,32,31,32,31,30,30,30,29,29,30,31]], [2036,[31,31,31,32,31,30,30,30,29,30,29,31]], [2037,[31,31,32,31,31,31,30,29,30,29,30,30]], [2038,[31,31,32,32,31,30,30,29,30,29,30,30]], [2039,[31,32,31,32,31,30,30,30,29,29,30,31]],
[2040,[31,31,31,32,31,30,30,30,29,30,29,31]], [2041,[31,31,32,31,31,31,30,29,30,29,30,30]], [2042,[31,31,32,32,31,30,30,29,30,29,30,30]], [2043,[31,32,31,32,31,30,30,30,29,29,30,31]], [2044,[30,32,31,32,31,30,30,30,29,30,29,31]],
[2045,[31,31,32,31,31,31,30,29,30,29,30,30]], [2046,[31,31,32,32,31,30,30,29,30,29,30,30]], [2047,[31,32,31,32,31,30,30,30,29,29,30,31]], [2048,[31,31,31,32,31,30,30,30,29,30,29,31]], [2049,[31,31,32,31,31,31,30,29,30,29,30,30]],
[2050,[31,31,32,32,31,30,30,29,30,29,30,30]], [2051,[31,32,31,32,31,30,30,30,29,29,30,31]], [2052,[30,32,31,32,31,30,30,30,29,30,29,31]], [2053,[31,31,32,31,31,31,30,29,30,29,30,30]], [2054,[31,31,32,32,31,30,30,29,30,29,30,30]],
[2055,[31,32,31,32,31,30,30,30,29,29,30,31]], [2056,[31,31,31,32,31,30,30,30,29,30,29,31]], [2057,[31,31,32,31,31,31,30,29,30,29,30,30]], [2058,[31,31,32,32,31,30,30,29,30,29,30,30]], [2059,[31,32,31,32,31,30,30,30,29,29,30,31]],
[2060,[31,31,31,32,31,30,30,30,29,30,29,31]], [2061,[31,31,32,31,31,31,30,29,30,29,30,30]], [2062,[31,31,32,32,31,30,30,29,30,29,30,30]], [2063,[31,32,31,32,31,30,30,30,29,29,30,31]], [2064,[31,31,31,32,31,30,30,30,29,30,29,31]],
[2065,[31,31,32,31,31,31,30,29,30,29,30,30]], [2066,[31,31,32,32,31,30,30,29,30,29,30,30]], [2067,[31,32,31,32,31,30,30,30,29,29,30,31]], [2068,[31,31,31,32,31,30,30,30,29,30,29,31]], [2069,[31,31,32,31,31,31,30,29,30,29,30,30]],
[2070,[31,31,32,32,31,30,30,29,30,29,30,30]], [2071,[31,32,31,32,31,30,30,30,29,29,30,31]], [2072,[31,31,31,32,31,30,30,30,29,30,29,31]], [2073,[31,31,32,31,31,31,30,29,30,29,30,30]], [2074,[31,31,32,32,31,30,30,29,30,29,30,30]],
[2075,[31,32,31,32,31,30,30,30,29,29,30,31]], [2076,[31,31,31,32,31,30,30,30,29,30,29,31]], [2077,[31,31,32,31,31,31,30,29,30,29,30,30]], [2078,[31,31,32,32,31,30,30,29,30,29,30,30]], [2079,[31,32,31,32,31,30,30,30,29,29,30,31]],
[2080,[31,31,31,32,31,30,30,30,29,30,29,31]], [2081,[31,31,32,31,31,31,30,29,30,29,30,30]], [2082,[31,31,32,32,31,30,30,29,30,29,30,30]], [2083,[31,32,31,32,31,30,30,30,29,29,30,31]], [2084,[31,31,31,32,31,30,30,30,29,30,29,31]],
[2085,[31,31,32,31,31,31,30,29,30,29,30,30]], [2086,[31,31,32,32,31,30,30,29,30,29,30,30]], [2087,[31,32,31,32,31,30,30,30,29,29,30,31]], [2088,[31,31,31,32,31,30,30,30,29,30,29,31]], [2089,[31,31,32,31,31,31,30,29,30,29,30,30]],
[2090,[31,31,32,32,31,30,30,29,30,29,30,30]], [2091,[31,32,31,32,31,30,30,30,29,29,30,31]], [2092,[31,31,31,32,31,30,30,30,29,30,29,31]], [2093,[31,31,32,31,31,31,30,29,30,29,30,30]], [2094,[31,31,32,32,31,30,30,29,30,29,30,30]],
[2095,[31,32,31,32,31,30,30,30,29,29,30,31]], [2096,[31,31,31,32,31,30,30,30,29,30,29,31]], [2097,[31,31,32,31,31,31,30,29,30,29,30,30]], [2098,[31,31,32,32,31,30,30,29,30,29,30,30]], [2099,[31,32,31,32,31,30,30,30,29,29,30,31]]
];
const NM=['बैशाख','जेठ','असार','श्रावण','भाद्र','आश्विन','कार्तिक','मंसिर','पौष','माघ','फाल्गुन','चैत्र'];

let selCalY = 2080, selCalM = 1, selCalD = 1;

function adToBS(y,m,d){
  const ref = Date.UTC(1943, 3, 14); 
  const inp = Date.UTC(y, m-1, d);
  let days = Math.round((inp - ref) / 86400000);
  for(let i=0; i<ND.length; i++){
    const[yr,mo]=ND[i];
    for(let j=0; j<12; j++){
      if(days < mo[j]) return {year:yr, month:j+1, day:days+1, monthName:NM[j]};
      days -= mo[j];
    }
  } return null;
}

function bsToAd(bsY, bsM, bsD) {
    let days = 0;
    for(let i=0; i<ND.length; i++) {
        if(ND[i][0] < bsY) {
            for(let j=0; j<12; j++) days += ND[i][1][j];
        } else if(ND[i][0] === bsY) {
            for(let j=0; j<bsM-1; j++) days += ND[i][1][j];
            break;
        }
    }
    days += (bsD - 1);
    const ref = Date.UTC(1943, 3, 14); 
    return new Date(ref + days * 86400000);
}

function getBsMonthStartDayOfWeek(bsY, bsM) {
    let days = 0;
    for(let i=0; i<ND.length; i++) {
        if(ND[i][0] < bsY) {
            for(let j=0; j<12; j++) days += ND[i][1][j];
        } else if(ND[i][0] === bsY) {
            for(let j=0; j<bsM-1; j++) days += ND[i][1][j];
            break;
        }
    }
    return (3 + days) % 7; 
}

function updateBSDate() {
  const adValInput = document.getElementById('current-date-ad');
  if(!adValInput) return;
  const adVal = adValInput.value;
  if(!adVal) { 
      const bsInp = document.getElementById('bs-date-inp');
      if(bsInp) bsInp.value = '';
      return; 
  }
  
  const [y,m,d] = adVal.split('-').map(Number);
  const bsData = adToBS(y,m,d);
  if(bsData) {
      selCalY = bsData.year; selCalM = bsData.month; selCalD = bsData.day;
      const bsInp = document.getElementById('bs-date-inp');
      if(bsInp) bsInp.value = `📅 ${bsData.day} ${bsData.monthName} ${bsData.year}`;
      
      const popup = document.getElementById('np-cal-popup');
      if(popup && popup.style.display === 'block') {
          document.getElementById('np-cal-y').value = selCalY;
          document.getElementById('np-cal-m').value = selCalM;
          renderNpCal();
      }
  }
}

function populateCustomerList() {
    const list = document.getElementById('customer-list');
    if(!list) return;
    list.innerHTML = '';
    Object.keys(cloudCustomers || {}).forEach(name => {
        let option = document.createElement('option');
        option.value = name;
        list.appendChild(option);
    });
}

function initNpCal() {
    const ySel = document.getElementById('np-cal-y');
    if(!ySel) return;
    for(let i=0; i<ND.length; i++) ySel.innerHTML += `<option value="${ND[i][0]}">${ND[i][0]}</option>`;
    const mSel = document.getElementById('np-cal-m');
    NM.forEach((m, i) => mSel.innerHTML += `<option value="${i+1}">${m}</option>`);
    
    document.addEventListener('click', function(e) {
        const popup = document.getElementById('np-cal-popup');
        const inp = document.getElementById('bs-date-inp');
        if(popup && popup.style.display === 'block' && !popup.contains(e.target) && e.target !== inp) {
            popup.style.display = 'none';
        }
    });
}

function toggleNpCal() {
    const popup = document.getElementById('np-cal-popup');
    const inp = document.getElementById('bs-date-inp');
    if(!popup || !inp) return;

    if(popup.style.display === 'block') {
        popup.style.display = 'none';
    } else {
        document.getElementById('np-cal-y').value = selCalY;
        document.getElementById('np-cal-m').value = selCalM;
        renderNpCal();

        document.body.appendChild(popup);
        const rect = inp.getBoundingClientRect();
        popup.style.position = 'absolute';
        popup.style.top = (window.scrollY + rect.bottom + 8) + 'px';
        
        let calcLeft = window.scrollX + rect.right - 280; 
        if (calcLeft < 10) calcLeft = 10; 

        popup.style.left = calcLeft + 'px';
        popup.style.zIndex = '9999';

        popup.style.display = 'block';
    }
}

function prevNpMonth() {
    let m = parseInt(document.getElementById('np-cal-m').value);
    let y = parseInt(document.getElementById('np-cal-y').value);
    if(m === 1) { m = 12; y--; } else { m--; }
    if(y >= 2000) { document.getElementById('np-cal-m').value = m; document.getElementById('np-cal-y').value = y; renderNpCal(); }
}

function nextNpMonth() {
    let m = parseInt(document.getElementById('np-cal-m').value);
    let y = parseInt(document.getElementById('np-cal-y').value);
    if(m === 12) { m = 1; y++; } else { m++; }
    if(y <= 2099) { document.getElementById('np-cal-m').value = m; document.getElementById('np-cal-y').value = y; renderNpCal(); }
}

function renderNpCal() {
    const y = parseInt(document.getElementById('np-cal-y').value);
    const m = parseInt(document.getElementById('np-cal-m').value);
    const startDow = getBsMonthStartDayOfWeek(y, m);
    
    let totalDays = 30;
    const yData = ND.find(d => d[0] === y);
    if(yData) totalDays = yData[1][m-1];

    let html = '';
    for(let i=0; i<startDow; i++) html += `<div class="np-day empty"></div>`;
    
    for(let d=1; d<=totalDays; d++) {
        let isSel = (d === selCalD && y === selCalY && m === selCalM);
        html += `<div class="np-day ${isSel?'active':''}" onclick="selectNpDate(${y},${m},${d})">${d}</div>`;
    }
    const grid = document.getElementById('np-cal-grid');
    if(grid) grid.innerHTML = html;
}

function selectNpDate(y, m, d) {
    selCalY = y; selCalM = m; selCalD = d;
    document.getElementById('bs-date-inp').value = `📅 ${d} ${NM[m-1]} ${y}`;
    document.getElementById('np-cal-popup').style.display = 'none';
    
    const adDate = bsToAd(y, m, d);
    const mm = String(adDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(adDate.getUTCDate()).padStart(2, '0');
    document.getElementById('current-date-ad').value = `${adDate.getUTCFullYear()}-${mm}-${dd}`;
}

const todayObj = new Date();
const tMM = String(todayObj.getMonth() + 1).padStart(2, '0');
const tDD = String(todayObj.getDate()).padStart(2, '0');
const todayStr = `${todayObj.getFullYear()}-${tMM}-${tDD}`;

window.onload = function() {
    initNpCal();
    initSuggestionBar();
    if(document.getElementById('current-date-ad')) document.getElementById('current-date-ad').value = todayStr;
    if(document.getElementById('cash-paid-date')) document.getElementById('cash-paid-date').value = todayStr;
    if(document.getElementById('slip-date')) document.getElementById('slip-date').value = todayStr;
    if(document.getElementById('slip-ref')) document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
    updateBSDate();
    addRow();
};

function toggleDark(){const h=document.documentElement,d=h.getAttribute('data-theme')==='dark';h.setAttribute('data-theme',d?'light':'dark');document.getElementById('dark-btn').innerText=d?'🌙':'☀️';}

function switchTab(name){
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.getElementById('panel-'+name).classList.add('active');
    document.getElementById('tab-'+name).classList.add('active');
    if(name==='ledger') renderLedger(true);
    if(name==='history') renderHistory();
    if(name==='packing') renderPokaHistory();
    if(name==='inventory') renderInventoryCatalog();
}

function filterHistory(){
  const qEl = document.getElementById('history-search');
  if(!qEl) return;
  const q = qEl.value.toLowerCase();
  const rows = document.querySelectorAll('#history-container .h-table tbody tr');
  rows.forEach(r => { r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none'; });
}

function filterLedger(){
  const qEl = document.getElementById('ledger-search');
  if(!qEl) return;
  const q = qEl.value.toLowerCase();
  const cards = document.querySelectorAll('#ledger-container .ledger-card');
  cards.forEach(c => { c.style.display = c.innerText.toLowerCase().includes(q) ? '' : 'none'; });
}

// ============================================================
// FIREBASE CONNECTION
// ============================================================
const fbConfig={
  apiKey:"AIzaSyAwKhnpjyS6sqIuwjmP3idhE3b7kftRy9w",
  authDomain:"nwh-bills.firebaseapp.com",
  databaseURL:"https://nwh-bills-default-rtdb.firebaseio.com/",
  projectId:"nwh-bills"
};

function initFB(){
  try{
    if(typeof firebase === 'undefined') return;
    if(!firebase.apps.length) firebase.initializeApp(fbConfig);
    db=firebase.database();

    if(firebase.auth) {
        firebase.auth().signInAnonymously().then(() => {
            startDatabaseListeners();
        }).catch(() => {
            startDatabaseListeners();
        });
    } else {
        startDatabaseListeners();
    }

  }catch(e){ console.error(e); }
}

function startDatabaseListeners() {
    db.ref('.info/connected').on('value',s=>{
      if(s.val()===true){
        fbReady=true;
        processSyncQueue();
      }else{
        fbReady=false;
        updateSyncBadge();
      }
    });

    db.ref('nwh/nextInvoiceNumber').on('value',s=>{
      const v=s.val();
      if(v){ cloudNextInvoice=v; if(!editBillKey) document.getElementById('invoice-number').innerText=v; }
      else queueDatabaseWrite('nwh/nextInvoiceNumber', 'set', 1001);
    });

    db.ref('nwh/customers').on('value',s=>{
        const val = s.val();
        cloudCustomers = (val && typeof val === 'object') ? val : {};
        populateCustomerList();
        renderLedger();
    });

    db.ref('nwh/bills').on('value',s=>{
        const v = s.val();
        if (v && typeof v === 'object') {
            allBills = Object.entries(v)
                .filter(([k, b]) => b && typeof b === 'object')
                .map(([k, b]) => ({ key: k, ...b }))
                .reverse();
        } else {
            allBills = [];
        }
        renderHistory();
        renderLedger();
    });

    db.ref('nwh/pokas').on('value', s => {
        const v = s.val();
        allPokas = (v && typeof v === 'object') ? Object.entries(v).filter(([k, p]) => p && typeof p === 'object').map(([k, p]) => ({key: k, ...p})).reverse() : [];
        renderPokaHistory();
    });

    db.ref('nwh/inventory').on('value',s=>{
      const val = s.val();
      if(Array.isArray(val)) inventoryList = val;
      else if(val && typeof val === 'object') inventoryList = Object.values(val);
      renderInventory();
      renderInventoryCatalog();
      safeSetLocal('nwh_inventory', JSON.stringify(inventoryList));
    });
}

function startFirebase() {
  if (typeof firebase !== 'undefined' && firebase.apps) {
    initFB();
  } else {
    setTimeout(startFirebase, 150);
  }
}
setTimeout(startFirebase, 100);

// ============================================================
// CATALOG & MEMORY
// ============================================================
try {
    let saved = safeGetLocal('nwh_inventory');
    if (saved) inventoryList = JSON.parse(saved) || [];
} catch(e) {}

function renderInventory() {
    const list = document.getElementById('inventory-list');
    if(!list) return;
    list.innerHTML = '';
    (inventoryList || []).forEach(item => {
        let option = document.createElement('option');
        option.value = item;
        list.appendChild(option);
    });
}

function saveNewItems(itemsArray) {
    let changed = false;
    (itemsArray || []).forEach(it => {
        if (!it || !it.desc) return;
        const d = it.desc.trim();
        if (d && d !== 'Item' && !inventoryList.includes(d)) {
            inventoryList.push(d);
            changed = true;
        }
    });
    if (changed) {
        safeSetLocal('nwh_inventory', JSON.stringify(inventoryList));
        queueDatabaseWrite('nwh/inventory', 'set', inventoryList);
        renderInventory();
        renderInventoryCatalog();
    }
}

function checkAndAutoFillRate(inputElement) {
    const row = inputElement.closest('tr');
    if(!row) return;
    const custName = document.getElementById('customer-name').value.trim().replace(/[.#$\[\]]/g, ' ');
    const descInput = row.querySelector('.item-desc');
    const rateInput = row.querySelector('.rate');
    if (!descInput || !rateInput) return;
    
    let hintSpan = row.querySelector('.rate-hint');
    if(!hintSpan) {
        hintSpan = document.createElement('div');
        hintSpan.className = 'rate-hint';
        hintSpan.style = 'font-size: 0.65rem; color: var(--green); display: block; margin-top: 1px; pointer-events: none; font-weight: 600; font-style: normal; font-family: "Plus Jakarta Sans", sans-serif;';
        rateInput.parentNode.appendChild(hintSpan);
    }
    
    hintSpan.innerText = '';
    if(!custName || !descInput.value.trim()) return;
    
    let lastRate = null;
    for(let i=0; i<allBills.length; i++) {
        if(allBills[i] && allBills[i].customer === custName && allBills[i].items) {
            const match = allBills[i].items.find(it => it && it.desc && it.desc.toLowerCase() === descInput.value.toLowerCase().trim());
            if(match && match.rate) {
                lastRate = match.rate;
                break; 
            }
        }
    }
    
    if(lastRate) {
        if(!rateInput.value || rateInput.dataset.autofilled === 'true') {
            rateInput.value = lastRate;
            rateInput.dataset.autofilled = 'true';
            calc();
        }
        hintSpan.innerText = `Last: ${lastRate}`;
    } else {
        rateInput.dataset.autofilled = 'false';
    }
}

function manualRateOverride(inputElement) {
    inputElement.dataset.autofilled = 'false';
    calc();
}

function addNoteRow(dateVal = '', textVal = '') {
    const container = document.getElementById('notes-container');
    if(!container) return;
    const div = document.createElement('div');
    div.className = 'note-row';
    div.style = 'display:flex; gap:8px; margin-bottom:8px; align-items:center;';
    div.innerHTML = `
        <input type="date" class="inp note-date" style="width:130px; padding:6px; font-size:0.8rem;" value="${dateVal}">
        <input type="text" class="inp note-text" style="flex:1; padding:6px; font-size:0.8rem;" placeholder="Remark / Amount..." value="${textVal}">
        <button class="del-row" onclick="this.parentElement.remove()" style="padding:6px 10px;">✕</button>
    `;
    container.appendChild(div);
}

// ============================================================
// PRODUCT CATALOG UI MANAGEMENT
// ============================================================
function renderInventoryCatalog() {
  const container = document.getElementById('catalog-list-container');
  if (!container) return;

  if (!inventoryList || inventoryList.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🏷️</div><div>No items saved in catalog</div></div>`;
    return;
  }

  let html = `<table class="h-table">
    <thead>
      <tr>
        <th style="text-align:left;">Garment Description</th>
        <th style="text-align:right; width:90px;">Action</th>
      </tr>
    </thead>
    <tbody>`;

  inventoryList.forEach((item) => {
    const safeItem = escapeHtmlAttr(item);
    const safeJsItem = escapeJsStr(item);
    html += `<tr>
      <td><strong>${safeItem}</strong></td>
      <td style="text-align:right;">
        <button class="btn btn-red btn-sm" onclick="removeItemFromCatalog('${safeJsItem}')">🗑️ Delete</button>
      </td>
    </tr>`;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function addItemToCatalogFromUI() {
  const input = document.getElementById('new-item-catalog-input');
  if (!input) return;
  const val = input.value.trim();

  if (!val) {
    alert("Please enter a garment description.");
    return;
  }

  if (inventoryList.includes(val)) {
    alert("This item is already in your catalog.");
    return;
  }

  inventoryList.push(val);
  safeSetLocal('nwh_inventory', JSON.stringify(inventoryList));
  queueDatabaseWrite('nwh/inventory', 'set', inventoryList);

  input.value = '';
  renderInventory();
  renderInventoryCatalog();
  alert(`✅ Added "${val}" to product catalog!`);
}

function removeItemFromCatalog(itemName) {
  if (confirm(`Delete "${itemName}" from your product catalog?`)) {
    inventoryList = inventoryList.filter(i => i !== itemName);
    safeSetLocal('nwh_inventory', JSON.stringify(inventoryList));
    queueDatabaseWrite('nwh/inventory', 'set', inventoryList);

    renderInventory();
    renderInventoryCatalog();
  }
}

function filterInventoryList() {
  const qEl = document.getElementById('inventory-search');
  if (!qEl) return;
  const q = qEl.value.toLowerCase();
  const rows = document.querySelectorAll('#catalog-list-container table tbody tr');
  rows.forEach(r => {
    r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none';
  });
}

// ============================================================
// POKA BUNDLING
// ============================================================
function addPokaGroup(items = null) {
    const container = document.getElementById('poka-groups-container');
    if(!container) return;

    const currentId = Date.now() + Math.random().toString(36).substring(2, 7);

    const div = document.createElement('div');
    div.className = 'poka-card-wrapper';
    div.style = 'background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.03);';
    div.id = `poka-wrapper-${currentId}`;

    div.innerHTML = `
        <div style="background:var(--surface2); padding:10px 16px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
            <span class="poka-header-title" style="font-weight:800; font-size:0.95rem; color:var(--text)">📦 Poka #...</span>
            <button class="del-row" onclick="removePokaGroup('${currentId}')" style="color:var(--red); font-size:0.8rem; font-weight:700; background:#fee2e2; border:1px solid #fecaca; cursor:pointer; padding:6px 10px; border-radius:6px;">✕ Remove Poka</button>
        </div>
        <div style="padding:12px; display:flex; flex-direction:column; gap:10px;" id="poka-items-tbody-${currentId}">
        </div>
        <div style="padding:0 12px 12px 12px;">
            <button class="btn btn-ghost" onclick="addPokaItemRow('${currentId}')" style="font-size:0.85rem; padding:8px 12px; width:100%; border:2px dashed var(--border); color:var(--accent);">+ Add Garment Breakdown</button>
        </div>
    `;
    container.appendChild(div);

    if (items && items.length > 0) {
        items.forEach(it => {
            let form = it.formula || '';
            let mult = '10';
            if (form.includes('×')) {
               const parts = form.split('×');
               form = parts[0].replace(/[() ]/g, '');
               mult = parts[1].trim();
            }
            addPokaItemRow(currentId, it.desc || '', form, mult);
        });
    } else {
        addPokaItemRow(currentId);
    }

    renumberPokaGroups();
    initSuggestionBar();
}

function addPokaItemRow(pokaId, desc='', formula='', mult='10') {
    const tbody = document.getElementById(`poka-items-tbody-${pokaId}`);
    if(!tbody) return;
    const div = document.createElement('div');
    div.className = 'poka-item-row';
    div.style = "background:var(--surface2); padding:12px; border-radius:10px; border:1px solid var(--border);";
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; margin-bottom:10px; gap:10px;">
            <input type="text" class="inp poka-desc-inp" placeholder="Type Garment Description..." value="${desc}" list="inventory-list" style="flex:1; font-weight:600; font-size:0.9rem; padding:10px;">
            <button class="del-row" onclick="this.closest('.poka-item-row').remove(); syncPokaCountValue();" style="padding:8px 14px; font-size:1rem; background:#fee2e2; color:#991b1b; border-radius:8px; border:none; cursor:pointer;">✕</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
            <input type="text" class="inp poka-formula-inp" placeholder="e.g. 11+13+5" value="${formula}" oninput="evaluatePokaRowSum(this)" style="flex:2; font-family:'Plus Jakarta Sans', sans-serif; font-size:1rem; font-weight:600; padding:10px;">
            <span style="font-size:1.2rem; color:var(--text3); font-weight:bold;">×</span>
            <input type="number" class="inp poka-mult-inp" value="${mult}" oninput="evaluatePokaRowSum(this)" style="flex:1; max-width:70px; font-family:'Plus Jakarta Sans', sans-serif; font-size:1rem; font-weight:600; padding:10px; text-align:center;">
            <div style="min-width:65px; text-align:right;">
                <span class="poka-row-sum-output" style="font-family:'Plus Jakarta Sans', sans-serif; font-size:1.15rem; font-weight:700; color:var(--accent);">0</span>
            </div>
        </div>
    `;
    tbody.appendChild(div);

    if(formula) evaluatePokaRowSum(div.querySelector('.poka-formula-inp'));
    initSuggestionBar();
}

function evaluatePokaRowSum(inputElement) {
    const row = inputElement.closest('.poka-item-row');
    if(!row) return;
    const formulaVal = row.querySelector('.poka-formula-inp').value;
    const multVal = parseFloat(row.querySelector('.poka-mult-inp').value) || 1;
    const outputSpan = row.querySelector('.poka-row-sum-output');
    
    let clean = formulaVal.replace(/[^0-9+\-*/().]/g, '');
    if(!clean) { outputSpan.innerText = '0'; return; }
    
    try {
        let baseSum = new Function('return ' + clean)();
        let total = Math.round(baseSum * multVal);
        outputSpan.innerText = total.toLocaleString('en-IN');
    } catch(e) {
        outputSpan.innerText = '...'; 
    }
}

function removePokaGroup(id) {
    const el = document.getElementById(`poka-wrapper-${id}`);
    if(el) el.remove();
    renumberPokaGroups();
}

function renumberPokaGroups() {
    const wrappers = document.querySelectorAll('.poka-card-wrapper');
    wrappers.forEach((wrapper, index) => {
        const headerSpan = wrapper.querySelector('.poka-header-title');
        if (headerSpan) {
            headerSpan.innerText = `📦 Poka #${index + 1}`;
        }
    });
    syncPokaCountValue();
}

function syncPokaCountValue() {
    const elements = document.querySelectorAll('.poka-card-wrapper');
    const input = document.getElementById('total-poka');
    if(input) input.value = elements.length > 0 ? elements.length : '';
}

function savePokaDraft() {
    const customer = document.getElementById('slip-customer').value.trim() || 'Walk-in / Unknown';
    const ref = document.getElementById('slip-ref').value || 'PK-N/A';
    const date = document.getElementById('slip-date').value || todayStr;

    const structuredPokas = [];
    document.querySelectorAll('.poka-card-wrapper').forEach((group, index) => {
        const pItems = [];
        group.querySelectorAll('.poka-item-row').forEach(row => {
            const desc = row.querySelector('.poka-desc-inp').value.trim();
            const formula = row.querySelector('.poka-formula-inp').value.trim();
            const mult = row.querySelector('.poka-mult-inp').value.trim();
            const sum = row.querySelector('.poka-row-sum-output').innerText;
            
            if(desc || formula) {
                let displayFormula = formula;
                if (mult && mult !== '1') displayFormula = `(${formula}) × ${mult}`;
                pItems.push({ desc: desc || 'Garment Item', formula: displayFormula, total: sum });
            }
        });
        if(pItems.length > 0) structuredPokas.push({ pokaNum: index + 1, items: pItems });
    });

    if(structuredPokas.length === 0) {
        alert("Please add at least one item before saving.");
        return;
    }

    queueDatabaseWrite('nwh/pokas', 'push', { customer, ref, date, pokaDetails: structuredPokas, totalPoka: structuredPokas.length });
    alert(`✅ Packing Slip Draft saved!`);
    
    document.getElementById('poka-groups-container').innerHTML = '';
    document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
    document.getElementById('slip-customer').value = '';
    addPokaGroup();
}

function renderPokaHistory() {
    const c = document.getElementById('saved-pokas-container');
    if(!c) return;
    if(!allPokas.length) { 
        c.innerHTML = `<div class="empty-state"><div class="icon">📁</div><div class="L">No saved drafts</div></div>`; 
        return; 
    }

    let html = `<table class="h-table"><thead><tr><th>Date & Ref</th><th>Customer</th><th>Total</th><th>Actions</th></tr></thead><tbody>`;
    allPokas.forEach(p => {
        if(!p) return;
        html += `<tr>
            <td><strong style="color:var(--accent);">${escapeHtmlAttr(p.ref || 'N/A')}</strong><br><span style="font-size:10px">${p.date || ''}</span></td>
            <td><strong>${escapeHtmlAttr(p.customer || 'Unknown')}</strong></td>
            <td>${p.totalPoka || 0}</td>
            <td style="white-space:nowrap;">
                <button class="btn btn-ghost btn-sm" onclick="loadPokaDraft('${p.key}')">⬇️ Load</button>
                <button class="btn btn-red btn-sm" onclick="deletePokaDraft('${p.key}')">🗑️</button>
            </td>
        </tr>`;
    });
    c.innerHTML = html + `</tbody></table>`;
}

function loadPokaDraft(key) {
    const p = allPokas.find(x => x && x.key === key);
    if(!p) return;

    document.getElementById('slip-customer').value = p.customer !== 'Walk-in / Unknown' ? p.customer : '';
    document.getElementById('slip-ref').value = p.ref || '';
    document.getElementById('slip-date').value = p.date || todayStr;

    document.getElementById('poka-groups-container').innerHTML = '';

    if(p.pokaDetails && p.pokaDetails.length > 0) {
        p.pokaDetails.forEach(group => addPokaGroup(group.items));
    } else {
        addPokaGroup();
    }
    
    document.getElementById('customer-name').value = p.customer !== 'Walk-in / Unknown' ? p.customer : '';
}

function deletePokaDraft(key) {
    if(confirm("Are you sure you want to delete this Poka draft?")) {
        queueDatabaseWrite('nwh/pokas/' + key, 'remove', null);
    }
}

function syncPokasToInvoice() {
    let addedCount = 0;
    
    document.querySelectorAll('.poka-card-wrapper').forEach(group => {
        group.querySelectorAll('.poka-item-row').forEach(row => {
            const desc = row.querySelector('.poka-desc-inp').value.trim();
            const sum = parseInt(row.querySelector('.poka-row-sum-output').innerText.replace(/,/g, '')) || 0;
            
            if (desc && sum > 0) {
                let found = false;
                document.querySelectorAll('#invoice-items tr').forEach(invRow => {
                    const invDesc = invRow.querySelector('.item-desc').value.trim();
                    if(invDesc.toLowerCase() === desc.toLowerCase()) {
                        const currentQty = parseFloat(invRow.querySelector('.qty').value) || 0;
                        invRow.querySelector('.qty').value = currentQty + sum;
                        found = true;
                    }
                });

                if(!found) {
                    const emptyRow = Array.from(document.querySelectorAll('#invoice-items tr')).find(r => !r.querySelector('.item-desc').value.trim() && (parseFloat(r.querySelector('.qty').value)||0) === 0);
                    if (emptyRow) {
                        emptyRow.querySelector('.item-desc').value = desc;
                        emptyRow.querySelector('.qty').value = sum;
                        checkAndAutoFillRate(emptyRow.querySelector('.item-desc'));
                    } else {
                        addRow(desc, sum, '', '');
                        const lastRow = document.getElementById('invoice-items').lastElementChild;
                        if (lastRow) checkAndAutoFillRate(lastRow.querySelector('.item-desc'));
                    }
                }
                addedCount++;
            }
        });
    });
    
    if (addedCount > 0) {
        calc();
        alert(`✅ Successfully appended ${addedCount} Poka entries to the main invoice!`);
        switchTab('invoice');
    } else {
        alert("⚠️ No valid items to sync. Make sure bundles have descriptions and quantities.");
    }
}

function addRow(desc='',qty='',rate='',code=''){
  const tbody = document.getElementById('invoice-items');
  if(!tbody) return;
  const tr=document.createElement('tr');
  tr.innerHTML=`<td><input type="text" class="ti item-desc" placeholder="Type item..." value="${desc}" list="inventory-list" oninput="checkAndAutoFillRate(this)"></td>
    <td><input type="text" class="ti r item-code" placeholder="—" value="${code}"></td>
    <td><input type="number" class="ti r qty" placeholder="0" min="0" value="${qty}" oninput="calc()"></td>
    <td style="position:relative;"><input type="number" class="ti r rate" placeholder="0" min="0" value="${rate}" oninput="manualRateOverride(this)"></td>
    <td class="amount">0</td>
    <td class="no-print"><button class="del-row" onclick="this.closest('tr').remove();calc()">✕</button></td>`;
  tbody.appendChild(tr);

  if(qty&&rate) calc();
  initSuggestionBar();
}

function calc(){
  let sub=0;
  document.querySelectorAll('#invoice-items tr').forEach(r=>{
    const q=parseFloat(r.querySelector('.qty').value)||0;
    const rt=parseFloat(r.querySelector('.rate').value)||0;
    const a=q*rt;
    r.querySelector('.amount').innerText=Math.round(a).toLocaleString('en-IN');
    sub+=a;
  });
  document.getElementById('items-total').innerText=Math.round(sub).toLocaleString('en-IN');
  const tr=parseFloat(document.getElementById('transport-expense').value)||0;
  const disc=parseFloat(document.getElementById('discount-amount').value)||0;
  const cb=(sub+tr)-disc;
  document.getElementById('current-bill').innerText=Math.round(cb).toLocaleString('en-IN');
  const pb=parseFloat(document.getElementById('prev-balance').value)||0;
  const gt=cb+pb;
  document.getElementById('grand-total').innerText=Math.round(gt).toLocaleString('en-IN');
  const cp=parseFloat(document.getElementById('cash-paid').value)||0;
  document.getElementById('remaining-balance').innerText=Math.round(gt-cp).toLocaleString('en-IN');
}

function clearForm(){
  if(!confirm('Clear all form data?')) return;
  resetFormInputsSilently();
}

function resetFormInputsSilently() {
  ['customer-name','customer-phone','customer-address','total-poka','transport-expense','discount-amount','prev-balance','cash-paid','db-search', 'slip-customer'].forEach(id=>{
      let el = document.getElementById(id);
      if(el) el.value = '';
  });
  
  document.getElementById('current-date-ad').value = todayStr;
  updateBSDate();
  document.getElementById('cash-paid-date').value = todayStr;
  document.getElementById('slip-date').value = todayStr;
  document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
  
  document.getElementById('invoice-items').innerHTML=''; addRow(); calc();
  document.getElementById('notes-container').innerHTML = '';
  document.getElementById('poka-groups-container').innerHTML = '';
  addNoteRow();
  
  editBillKey = null;
  editInvoiceNum = null;
  document.getElementById('tab-invoice').innerHTML = `🧾 <span class="L" data-k="New Invoice">New Invoice</span>`;
  document.getElementById('invoice-number').innerText = cloudNextInvoice;
}

function searchDB(){
  const q=document.getElementById('db-search').value.toLowerCase(),box=document.getElementById('search-results');
  box.innerHTML='';
  if(q.length<1){box.style.display='none';return;}
  let n=0;
  for(let name in cloudCustomers){
    const ph=(cloudCustomers[name].phone||'').toLowerCase();
    if(name.toLowerCase().includes(q)||ph.includes(q)){
      const d=document.createElement('div');
      d.className='sr-item';
      d.innerHTML=`<span><strong>${escapeHtmlAttr(name)}</strong> &nbsp;${cloudCustomers[name].phone||''}</span>`;
      d.onclick=()=>{
          document.getElementById('customer-name').value=name;
          triggerCustomerAutoFill();
          document.getElementById('db-search').value='';box.style.display='none';
          document.querySelectorAll('.item-desc').forEach(el => checkAndAutoFillRate(el));
      };
      box.appendChild(d);n++;
    }
  }
  box.style.display=n?'block':'none';
}
const debouncedSearchDB = debounce(searchDB);

function saveCustomerOnly() {
    const rawName = document.getElementById('customer-name').value.trim();
    if(!rawName) { alert('Please enter a Customer Name first.'); return; }
    const safeName = rawName.replace(/[.#$\[\]]/g, ' ').trim(); 
    
    queueDatabaseWrite('nwh/customers/' + safeName, 'set', {
        phone: document.getElementById('customer-phone').value || "",
        address: document.getElementById('customer-address').value || "",
        balance: document.getElementById('prev-balance').value || "0"
    });
    alert(`✅ Customer "${safeName}" saved to ledger!`);
}

async function pickPhoneContact(){
  if('contacts' in navigator && 'ContactsManager' in window){
    try {
      const c = await navigator.contacts.select(['name', 'tel'], { multiple: false });
      if(c && c.length > 0){
        let name = (c[0].name && c[0].name.length > 0) ? c[0].name[0] : '';
        name = name.replace(/[.#$\[\]]/g, ' ').trim(); 
        document.getElementById('customer-name').value = name;

        let phone = '';
        if (c[0].tel && Array.isArray(c[0].tel) && c[0].tel.length > 0) {
          phone = c[0].tel[0];
        } else if (typeof c[0].tel === 'string') {
          phone = c[0].tel;
        }

        phone = phone.replace(/[\s\-\(\)]/g, '');
        document.getElementById('customer-phone').value = phone;

        if(name){
            triggerCustomerAutoFill();
        }
        calc();
      }
    } catch(e) {
      console.error("Contact picker error:", e);
    }
  } else {
    alert('Please open in Google Chrome on Android to import contacts.');
  }
}

function shareWA(){
  const phone=document.getElementById('customer-phone').value||'';
  if(!phone){alert('Please enter a phone number first.');return;}
  const biz="Rabi Kapada Pasal";
  const billDate = document.getElementById('current-date-ad').value;
  
  const rawBS = document.getElementById('bs-date-inp').value;
  const billDateBS = rawBS ? rawBS.replace('📅 ', '') + ' BS' : '';
  
  const invNum = document.getElementById('invoice-number').innerText;
  const custName = document.getElementById('customer-name').value||'Customer';
  const billAmt = document.getElementById('current-bill').innerText;
  
  const msg=`🏪 *${biz}*\n📄 Invoice #${invNum}\n📅 ${billDate} (${billDateBS})\n👤 *${custName}*\n🧾 Bill: *NRS ${billAmt}*`;
  window.open('https://wa.me/'+phone.replace(/\D/g,'')+'?text='+encodeURIComponent(msg),'_blank');
}

function extractPendingBillData() {
  const rawName=document.getElementById('customer-name').value.trim()||'Walk-in Customer';
  const safeName = rawName.replace(/[.#$\[\]]/g, ' ').trim(); 
  const currentBaki=document.getElementById('remaining-balance').innerText.replace(/,/g,'');
  const billDate = document.getElementById('current-date-ad').value;
  
  const rawBS = document.getElementById('bs-date-inp').value;
  const billDateBS = rawBS ? rawBS.replace('📅 ', '') + ' BS' : '';
  
  const items=[];
  document.querySelectorAll('#invoice-items tr').forEach(row=>{
    const desc=row.querySelector('.item-desc').value.trim(),qty=row.querySelector('.qty').value,rate=row.querySelector('.rate').value,code=row.querySelector('.item-code').value.trim(),amount=row.querySelector('.amount').innerText.replace(/,/g,'');
    if(desc||qty>0) items.push({desc:desc||'Item',qty:qty||0,rate:rate||0,code:code||'',amount});
  });

  const notesArr = [];
  document.querySelectorAll('.note-row').forEach(row => {
      const d = row.querySelector('.note-date').value;
      const t = row.querySelector('.note-text').value.trim();
      if(d || t) notesArr.push({ date: d, text: t });
  });

  const structuredPokas = [];
  document.querySelectorAll('.poka-card-wrapper').forEach((group, index) => {
      const pNum = index + 1;
      const pItems = [];
      group.querySelectorAll('.poka-item-row').forEach(row => {
          const desc = row.querySelector('.poka-desc-inp').value.trim();
          const formula = row.querySelector('.poka-formula-inp').value.trim();
          const mult = row.querySelector('.poka-mult-inp').value.trim();
          const sum = row.querySelector('.poka-row-sum-output').innerText;
          
          if(desc || formula) {
              let displayFormula = formula;
              if (mult && mult !== '1') displayFormula = `(${formula}) × ${mult}`;
              pItems.push({ desc: desc || 'Garment Item', formula: displayFormula, total: sum });
          }
      });
      if(pItems.length > 0) {
          structuredPokas.push({ pokaNum: pNum, items: pItems });
      }
  });

  return {
      invoiceNum: editInvoiceNum || cloudNextInvoice,
      date:billDate, dateBS:billDateBS, customer:safeName,
      phone:document.getElementById('customer-phone').value||'',
      address:document.getElementById('customer-address').value||'',
      billNotes: notesArr,
      pokaDetails: structuredPokas,
      totalPoka: document.getElementById('total-poka').value || '0',
      transport:document.getElementById('transport-expense').value||'0',
      discount: document.getElementById('discount-amount').value || '0',
      prevBalance:document.getElementById('prev-balance').value||'0',
      billAmount:document.getElementById('current-bill').innerText.replace(/,/g,''),
      grandTotal:document.getElementById('grand-total').innerText.replace(/,/g,''),
      paid:document.getElementById('cash-paid').value||'0',
      cashPaidDate: document.getElementById('cash-paid-date').value || todayStr,
      remaining:currentBaki, items
  };
}

function previewPackingSlip() {
    const bill = extractPendingBillData();
    if (!bill.pokaDetails || bill.pokaDetails.length === 0) {
        alert("No Poka bundle details have been added. Please add packing details first.");
        return;
    }
    
    const bizName = document.getElementById('biz-name').innerText || "Rabi Kapada Pasal";
    const slipDate = document.getElementById('slip-date').value || todayStr;
    const slipRef = document.getElementById('slip-ref').value || 'N/A';
    
    let htmlString = `
    <div style="padding: 10px; width: 100%; overflow-x: auto; background: #e2e8f0; -webkit-overflow-scrolling: touch;">
        <div id="actual-slip-to-render" style="width: 650px; min-width: 650px; background: #ffffff; color: #000000; font-family: 'Plus Jakarta Sans', Arial, sans-serif; box-sizing: border-box; margin: 0 auto; padding: 30px;">
            <div style="text-align: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 30px;">
                <h1 style="font-size: 24px; color: #1a1f36; margin: 0; text-transform: uppercase;">PACKING SLIP (POKA DETAILS)</h1>
                <h2 style="font-size: 16px; color: #4a5280; margin: 5px 0 0 0;">${bizName}</h2>
            </div>

            <table style="width: 100%; margin-bottom: 30px;">
                <tr>
                    <td style="width: 50%; vertical-align: top;">
                        <div style="background: #f7f9ff; padding: 12px 15px; border-left: 4px solid #8b5cf6;">
                            <p style="font-size: 10px; font-weight: bold; color: #8892b0; margin: 0 0 4px 0;">SHIP TO:</p>
                            <p style="font-size: 15px; font-weight: bold; color: #1a1f36; margin: 0;">${bill.customer}</p>
                            ${bill.phone ? `<p style="font-size: 12px; color: #4a5280; margin: 2px 0 0 0;">${bill.phone}</p>` : ''}
                        </div>
                    </td>
                    <td style="width: 50%; vertical-align: top; text-align: right;">
                        <p style="font-size: 12.5px; color: #4a5280; margin: 0 0 4px 0;"><strong>Date:</strong> ${slipDate}</p>
                        <p style="font-size: 12.5px; color: #4a5280; margin: 0 0 4px 0;"><strong>Slip Ref:</strong> ${slipRef}</p>
                        <p style="font-size: 12.5px; color: #4a5280; margin: 0;"><strong>Total Bundles:</strong> ${bill.totalPoka}</p>
                    </td>
                </tr>
            </table>`;

        bill.pokaDetails.forEach(p => {
            htmlString += `
            <div style="margin-bottom: 20px; border: 1.5px solid #cbd5e1; border-radius: 6px; overflow: hidden;">
                <div style="background: #f1f5f9; padding: 8px 12px; font-size: 13px; font-weight: 800;">
                    <span>📦 Poka #${p.pokaNum}</span>
                </div>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead>
                        <tr style="background: #f8fafc; text-align: left; border-bottom: 1px solid #e2e8f0;">
                            <th style="padding: 10px 12px;">Garment Description</th>
                            <th style="padding: 10px 12px;">Breakdown</th>
                            <th style="padding: 10px 12px; text-align: right;">Total Pcs</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${p.items.map(it => `
                            <tr style="border-bottom: 1px solid #e2e8f0;">
                                <td style="padding: 10px 12px; font-weight: bold;">${it.desc}</td>
                                <td style="padding: 10px 12px; font-family: 'Plus Jakarta Sans', sans-serif;">${it.formula || '—'}</td>
                                <td style="padding: 10px 12px; text-align: right; font-weight: bold;">${it.total}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
        });

        htmlString += `</div></div>`;

    document.getElementById('slip-body').innerHTML = htmlString;
    document.getElementById('slip-modal').classList.add('open');
}

// ============================================================
// SEAMLESS PNG CAPTURE (DOWNLOAD FIX)
// ============================================================
function downloadElementAsImage(targetElement, filename, callback) {
    if (!targetElement) {
        alert("Error: Element to capture was not found.");
        if (callback) callback();
        return;
    }

    const options = {
        scale: 3,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false,
        width: targetElement.offsetWidth || targetElement.scrollWidth,
        height: targetElement.offsetHeight || targetElement.scrollHeight
    };

    html2canvas(targetElement, options).then(function (canvas) {
        if (canvas.width === 0 || canvas.height === 0) {
            alert("Error: Generated image is empty.");
            if (callback) callback();
            return;
        }

        canvas.toBlob(function (blob) {
            if (!blob) {
                alert("Error creating PNG blob.");
                if (callback) callback();
                return;
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.download = filename.replace(/\.pdf$/i, '.png');
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            if (callback) callback();
        }, 'image/png');

    }).catch(function (error) {
        console.error("Capture error:", error);
        alert("Error saving document: " + error.message);
        if (callback) callback();
    });
}

function downloadSlipOnly() {
    const btn = document.getElementById('slip-dl-btn');
    if (btn) btn.innerHTML = '⏳ Processing...';

    const targetElement = document.getElementById('actual-slip-to-render');
    const custName = document.getElementById('customer-name').value.trim() || 'Customer';
    const safeCust = custName.replace(/[^a-zA-Z0-9]/g, '_');

    downloadElementAsImage(targetElement, `PackingSlip-${safeCust}.png`, () => {
        if (btn) btn.innerHTML = '💾 Download Slip Image';
        closeModal('slip-modal');
    });
}

function previewBill(){
  pendingBill = extractPendingBillData();
  generatePreviewHTML(pendingBill);
}

// ============================================================
// EXACT MATCH INVOICE GENERATOR
// ============================================================
function generatePreviewHTML(bill) {
    let rowsHtml = "";
    bill.items.forEach((it) => {
        rowsHtml += `<tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 10px 12px; font-size: 13px; color: #1a1f36; font-weight: 600; width: 45%; text-align: left;">${it.desc}</td>
            <td style="padding: 10px 8px; font-size: 12.5px; color: #8892b0; text-align: center; width: 10%;">${it.code || '—'}</td>
            <td style="padding: 10px 8px; font-size: 13px; color: #1a1f36; text-align: right; width: 13%;">${it.qty}</td>
            <td style="padding: 10px 8px; font-size: 13px; color: #1a1f36; text-align: right; width: 14%;">${it.rate}</td>
            <td style="padding: 10px 12px; font-size: 13px; color: #000000; text-align: right; font-weight: 800; width: 18%;">${parseInt(it.amount).toLocaleString('en-IN')}</td>
        </tr>`;
    });

    const bizName = document.getElementById('biz-name').innerText || "Rabi Kapada Pasal";

    let htmlString = `
    <div style="padding: 10px; width: 100%; overflow-x: auto; background: #e2e8f0; -webkit-overflow-scrolling: touch;">
        <div id="actual-bill-to-render" style="width: 680px; min-width: 680px; background: #ffffff; color: #000000; font-family: 'Plus Jakarta Sans', Arial, sans-serif; padding: 40px 42px; margin: 0 auto; box-sizing: border-box; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.06);">
            
            <table style="width: 100%; border-bottom: 2px solid #f8fafc; padding-bottom: 16px; margin-bottom: 24px;">
                <tr>
                    <td style="vertical-align: top;">
                        <h1 style="font-size: 26px; font-weight: 800; color: #1a1f36; margin: 0; letter-spacing: -0.5px;">${bizName}</h1>
                    </td>
                    <td style="vertical-align: top; text-align: right;">
                        <h2 style="font-size: 22px; color: #a0aec0; margin: 0; letter-spacing: 1.5px; font-weight: 800;">INVOICE</h2>
                        <p style="font-size: 15px; font-weight: 800; color: #1a1f36; margin: 3px 0 0 0;">#${bill.invoiceNum}</p>
                        <p style="font-size: 12.5px; color: #64748b; margin: 2px 0 0 0;">${bill.date}</p>
                        <p style="font-size: 11.5px; color: #8892b0; margin: 1px 0 0 0;">${bill.dateBS || ""}</p>
                    </td>
                </tr>
            </table>

            <div style="background: #f7f5ff; padding: 14px 18px; border-left: 4px solid #7c3aed; margin-bottom: 24px; border-radius: 6px;">
                <p style="font-size: 10px; font-weight: 800; color: #8b5cf6; margin: 0 0 4px 0; letter-spacing: 0.8px; text-transform: uppercase;">BILL TO:</p>
                <p style="font-size: 15.5px; font-weight: 800; color: #1a1f36; margin: 0;">${bill.customer}</p>
                ${bill.phone ? `<p style="font-size: 13px; color: #64748b; margin: 2px 0 0 0;">${bill.phone}</p>` : ''}
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 28px; table-layout: fixed;">
                <thead>
                    <tr style="background: #8b5cf6; color: #ffffff;">
                        <th style="padding: 10px 12px; font-size: 12.5px; font-weight: 700; text-align: left; width: 45%; border-top-left-radius: 6px; border-bottom-left-radius: 6px;">Description</th>
                        <th style="padding: 10px 8px; font-size: 12.5px; font-weight: 700; text-align: center; width: 10%;">Code</th>
                        <th style="padding: 10px 8px; font-size: 12.5px; font-weight: 700; text-align: right; width: 13%;">Qty</th>
                        <th style="padding: 10px 8px; font-size: 12.5px; font-weight: 700; text-align: right; width: 14%;">Rate</th>
                        <th style="padding: 10px 12px; font-size: 12.5px; font-weight: 700; text-align: right; width: 18%; border-top-right-radius: 6px; border-bottom-right-radius: 6px;">Total (NRS)</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>

            <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
                <tr>
                    <td style="width: 45%; vertical-align: top; padding-right: 20px;">
                        ${(bill.billNotes && bill.billNotes.length > 0) ? `
                        <div style="padding: 12px 14px; background: #f8fafc; border-left: 3px solid #8b5cf6; border-radius: 6px;">
                            <p style="margin: 0 0 6px 0; font-size: 10.5px; font-weight: 800; color: #8892b0; text-transform: uppercase;">REMARKS / NOTES:</p>
                            ${bill.billNotes.map(n => `<p style="margin: 3px 0; font-size: 12px; color: #4a5280;">${n.date ? n.date + ' ' : ''}${n.text}</p>`).join('')}
                        </div>` : ''}
                    </td>

                    <td style="width: 55%; vertical-align: top;">
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                            <tr>
                                <td style="padding: 5px 0; color: #64748b; font-weight: 500;">Items Subtotal:</td>
                                <td style="padding: 5px 0; text-align: right; font-weight: 700; color: #1a1f36;">NRS ${parseInt(document.getElementById('items-total').innerText.replace(/,/g,'') || 0).toLocaleString('en-IN')}</td>
                            </tr>
                            ${parseFloat(bill.transport) > 0 ? `
                            <tr>
                                <td style="padding: 5px 0; color: #64748b; font-weight: 500;">Transport (+):</td>
                                <td style="padding: 5px 0; text-align: right; color: #1a1f36; font-weight: 600;">NRS ${parseInt(bill.transport || 0).toLocaleString('en-IN')}</td>
                            </tr>` : ''}
                            ${parseFloat(bill.discount) > 0 ? `
                            <tr>
                                <td style="padding: 5px 0; color: #dc2626; font-weight: 500;">Discount (-):</td>
                                <td style="padding: 5px 0; text-align: right; color: #dc2626; font-weight: 700;">NRS ${parseInt(bill.discount || 0).toLocaleString('en-IN')}</td>
                            </tr>` : ''}
                            <tr style="background: #f8fafc; font-weight: 700;">
                                <td style="padding: 7px 6px; color: #1a1f36;">Today's Bill:</td>
                                <td style="padding: 7px 6px; text-align: right; color: #1a1f36; font-weight: 800;">NRS ${parseInt(bill.billAmount || 0).toLocaleString('en-IN')}</td>
                            </tr>
                            <tr>
                                <td style="padding: 5px 0; color: #64748b; font-weight: 500;">Purano Baki (+):</td>
                                <td style="padding: 5px 0; text-align: right; color: #64748b; font-weight: 600;">NRS ${parseInt(bill.prevBalance || 0).toLocaleString('en-IN')}</td>
                            </tr>
                            ${parseFloat(bill.totalPoka) > 0 ? `
                            <tr>
                                <td style="padding: 5px 0; font-weight: 700; color: #1a1f36;">📦 Total Poka:</td>
                                <td style="padding: 5px 0; text-align: right; font-weight: 800; color: #dc2626;">${bill.totalPoka}</td>
                            </tr>` : ''}
                            <tr style="background: #f5f3ff; color: #7c3aed; font-weight: 700; border-radius: 4px;">
                                <td style="padding: 7px 6px;">Jamma Total:</td>
                                <td style="padding: 7px 6px; text-align: right; font-weight: 800;">NRS ${parseInt(bill.grandTotal || 0).toLocaleString('en-IN')}</td>
                            </tr>
                            <tr style="color: #059669;">
                                <td style="padding: 5px 0; font-weight: 600;">Nagad Paid (-):</td>
                                <td style="padding: 5px 0; text-align: right; font-weight: 700;">NRS ${parseInt(bill.paid || 0).toLocaleString('en-IN')}</td>
                            </tr>
                            <tr style="background: #fee2e2; color: #dc2626; font-size: 14.5px; font-weight: 800; border-radius: 4px;">
                                <td style="padding: 8px 6px;">Remaining Baki:</td>
                                <td style="padding: 8px 6px; text-align: right;">NRS ${parseInt(bill.remaining || 0).toLocaleString('en-IN')}</td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>

            <!-- SIGNATURE SECTION -->
            <table style="width: 100%; margin-top: 45px; border-collapse: collapse;">
                <tr>
                    <td style="width: 50%; vertical-align: bottom;">
                        <div style="width: 200px; text-align: left;">
                            <div style="border-top: 1px dashed #cbd5e1; padding-top: 6px; font-size: 11px; color: #94a3b8; text-transform: uppercase;">
                                Customer Signature
                            </div>
                        </div>
                    </td>
                    <td style="width: 50%; vertical-align: bottom; text-align: right;">
                        <div style="width: 240px; margin-left: auto; text-align: center;">
                            <img id="bill-sig-img" src="" style="width: 220px; height: 70px; object-fit: contain; display: none; margin-bottom: 2px;" />
                            <button id="sign-btn" onclick="openSignaturePad()" style="width: 100%; padding: 12px 0; border: 1.5px dashed #cbd5e1; background: #f8fafc; border-radius: 6px; cursor: pointer; margin-bottom: 4px; color: #64748b; font-weight: 700; font-size: 12px; font-family: inherit;">✏️ Tap to Sign</button>
                            <div style="border-top: 1px solid #cbd5e1; padding-top: 4px; font-size: 11px; color: #64748b; text-transform: uppercase;">
                                Authorized Signature & Stamp
                            </div>
                        </div>
                    </td>
                </tr>
            </table>

        </div>
    </div>`;

    document.getElementById('preview-body').innerHTML = htmlString;
    document.getElementById('preview-modal').classList.add('open');
}

// ============================================================
// SIGNATURE PAD
// ============================================================
let isDrawing = false;
let sigCtx = null;
let canvasListenersAdded = false;

function openSignaturePad() {
    const modal = document.getElementById('sig-pad-modal');
    if (modal) modal.classList.add('open');
    setTimeout(() => {
        const canvas = document.getElementById('large-sig-canvas');
        if (!canvas) return;
        
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        
        initSignaturePadCanvas(canvas, dpr);
    }, 150);
}

function initSignaturePadCanvas(canvas, dpr = 1) {
    if(!canvas) return;
    sigCtx = canvas.getContext('2d');
    sigCtx.scale(dpr, dpr);
    sigCtx.lineWidth = 3;
    sigCtx.lineCap = 'round';
    sigCtx.lineJoin = 'round';
    sigCtx.strokeStyle = '#1e293b';
    sigCtx.clearRect(0, 0, canvas.width, canvas.height);

    const getPos = (e) => {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const startDraw = (e) => {
        isDrawing = true;
        const pos = getPos(e);
        sigCtx.beginPath();
        sigCtx.moveTo(pos.x, pos.y);
        if(e.touches) e.preventDefault(); 
    };

    const draw = (e) => {
        if(!isDrawing) return;
        const pos = getPos(e);
        sigCtx.lineTo(pos.x, pos.y);
        sigCtx.stroke();
        if(e.touches) e.preventDefault();
    };

    const stopDraw = () => { isDrawing = false; };

    if(!canvasListenersAdded) {
        canvas.addEventListener('mousedown', startDraw);
        canvas.addEventListener('mousemove', draw);
        canvas.addEventListener('mouseup', stopDraw);
        canvas.addEventListener('mouseleave', stopDraw);
        canvas.addEventListener('touchstart', startDraw, {passive: false});
        canvas.addEventListener('touchmove', draw, {passive: false});
        canvas.addEventListener('touchend', stopDraw);
        canvasListenersAdded = true;
    }
}

function saveLargeSignature() {
    const canvas = document.getElementById('large-sig-canvas');
    if(!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    const img = document.getElementById('bill-sig-img');
    const btn = document.getElementById('sign-btn');
    if (img && btn) {
        img.src = dataUrl;
        img.style.display = 'block';
        btn.style.display = 'none';
    }
    closeModal('sig-pad-modal');
}

function clearLargeSignature() {
    const canvas = document.getElementById('large-sig-canvas');
    if(canvas && sigCtx) sigCtx.clearRect(0, 0, canvas.width, canvas.height);
}

function clearSignature() {
    const img = document.getElementById('bill-sig-img');
    const btn = document.getElementById('sign-btn');
    if(img && btn) {
        img.src = '';
        img.style.display = 'none';
        btn.style.display = 'block';
    }
    clearLargeSignature();
}

// ============================================================
// FIXED CONFIRM & DOWNLOAD (NO DIALOG BLOCKS)
// ============================================================
function confirmAndDownload() {
    if(!pendingBill) return;

    saveNewItems(pendingBill.items);
    
    if(editBillKey) {
        queueDatabaseWrite('nwh/bills/' + editBillKey, 'update', pendingBill);
    } else {
        queueDatabaseWrite('nwh/customers/'+pendingBill.customer, 'set', {
            phone: pendingBill.phone,
            address: pendingBill.address,
            balance: pendingBill.remaining
        });
        queueDatabaseWrite('nwh/bills', 'push', pendingBill);
        queueDatabaseWrite('nwh/nextInvoiceNumber', 'set', cloudNextInvoice+1);
    }

    const targetElement = document.getElementById('actual-bill-to-render');
    const signBtnNode = targetElement ? targetElement.querySelector('#sign-btn') : null;
    const prevSignBtnDisplay = signBtnNode ? signBtnNode.style.display : '';
    
    if (signBtnNode) signBtnNode.style.display = 'none';

    const confirmBtn = document.getElementById('confirm-btn-text');
    if (confirmBtn) confirmBtn.innerText = '⏳ Saving...';

    const safeCust = (pendingBill.customer || 'Invoice').replace(/[^a-zA-Z0-9]/g, '_');

    downloadElementAsImage(targetElement, `Invoice-${pendingBill.invoiceNum}-${safeCust}.png`, () => {
        if (signBtnNode) signBtnNode.style.display = prevSignBtnDisplay;
        if (confirmBtn) confirmBtn.innerText = '💾 Confirm & Download';
        closeModal('preview-modal');
        
        // Reset inputs silently without triggering confirm dialog
        resetFormInputsSilently();
        pendingBill = null;
    });
}

function deleteBill(key) {
  const b = allBills.find(x => x.key === key);
  if (!b) return;

  if (confirm(`⚠️ Are you sure you want to delete Invoice #${b.invoiceNum} for ${b.customer}?`)) {
    queueDatabaseWrite('nwh/bills/' + key, 'remove', null);
    closeModal('bill-modal');
    renderHistory();
    renderLedger();
  }
}

function deleteCustomer(name) {
    if(!name) return;
    if(confirm(`⚠️ Are you sure you want to delete customer "${name}"?`)) {
        const safePathName = name.replace(/[.#$\[\]]/g, ' ').trim();

        queueDatabaseWrite('nwh/customers/' + safePathName, 'remove', null);

        if (Array.isArray(allBills)) {
            allBills.forEach(b => {
                if(b && b.customer === name && b.key) {
                    queueDatabaseWrite('nwh/bills/' + b.key, 'remove', null);
                }
            });
        }

        delete cloudCustomers[name];
        allBills = allBills.filter(b => b.customer !== name);

        closeModal('bill-modal');
        renderLedger();
        renderHistory();
    }
}

function loadBillForEdit(key) {
    const bill = allBills.find(b => b.key === key);
    if (!bill) return;

    editBillKey = bill.key;
    editInvoiceNum = bill.invoiceNum;

    document.getElementById('customer-name').value = bill.customer || '';
    document.getElementById('customer-phone').value = bill.phone || '';
    document.getElementById('customer-address').value = bill.address || '';
    
    document.getElementById('current-date-ad').value = bill.date || todayStr;
    updateBSDate();
    if (bill.cashPaidDate) document.getElementById('cash-paid-date').value = bill.cashPaidDate;

    const itemsTbody = document.getElementById('invoice-items');
    itemsTbody.innerHTML = '';
    if (bill.items && bill.items.length > 0) {
        bill.items.forEach(it => addRow(it.desc, it.qty, it.rate, it.code));
    } else {
        addRow();
    }

    const notesContainer = document.getElementById('notes-container');
    if(notesContainer) {
        notesContainer.innerHTML = '';
        if (bill.billNotes && bill.billNotes.length > 0) {
            bill.billNotes.forEach(n => addNoteRow(n.date, n.text));
        } else {
            addNoteRow();
        }
    }

    const pokaContainer = document.getElementById('poka-groups-container');
    if(pokaContainer) {
        pokaContainer.innerHTML = '';
        if (bill.pokaDetails && bill.pokaDetails.length > 0) {
            bill.pokaDetails.forEach(group => addPokaGroup(group.items));
        }
    }

    document.getElementById('total-poka').value = bill.totalPoka || '';
    document.getElementById('transport-expense').value = bill.transport || '';
    document.getElementById('discount-amount').value = bill.discount || '';
    document.getElementById('prev-balance').value = bill.prevBalance || '';
    document.getElementById('cash-paid').value = bill.paid || '';

    document.getElementById('invoice-number').innerText = bill.invoiceNum;
    document.getElementById('tab-invoice').innerHTML = `🧾 <span style="color:var(--red);">Editing #${bill.invoiceNum}</span>`;
    
    calc();
    closeModal('bill-modal');
    switchTab('invoice');
}

function showBillDetail(key){
  const b=allBills.find(x=>x.key===key);if(!b) return;
  document.getElementById('modal-title').innerText=`Invoice #${b.invoiceNum} — ${b.customer}`;
  
  let iHtml='';
  if(b.items&&b.items.length){
    iHtml=`<div style="margin:12px 0;border:1px solid var(--border);border-radius:10px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:.79rem;"><thead><tr style="background:var(--surface2);"><th style="padding:7px 10px;text-align:left;">Item</th><th style="padding:7px 10px;text-align:right;">Qty</th><th style="padding:7px 10px;text-align:right;">Rate</th><th style="padding:7px 10px;text-align:right;">Total</th></tr></thead><tbody>`;
    b.items.forEach(it=>{iHtml+=`<tr style="border-top:1px solid var(--border)"><td style="padding:6px 10px">${it.desc}</td><td style="padding:6px 10px;text-align:right">${it.qty}</td><td style="padding:6px 10px;text-align:right">${it.rate||''}</td><td style="padding:6px 10px;text-align:right;font-weight:500">${parseInt(it.amount||0).toLocaleString('en-IN')}</td></tr>`;});
    iHtml+='</tbody></table></div>';
  }

  const baki=parseInt(b.remaining)||0;
  
  document.getElementById('modal-body').innerHTML=`
    <div class="d-row"><span class="d-label">Date</span><span class="d-val">${b.date} / ${b.dateBS||''}</span></div>
    ${iHtml}
    <div class="d-row"><span class="d-label">Bill Amount</span><span class="d-val">NRS ${parseInt(b.billAmount).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label">Purano Baki</span><span class="d-val">NRS ${parseInt(b.prevBalance || 0).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label">Paid</span><span class="d-val" style="color:green">NRS ${parseInt(b.paid).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label" style="color:red">Remaining</span><span class="d-val" style="color:red">NRS ${baki.toLocaleString('en-IN')}</span></div>
    
    <div style="display:flex; gap:8px; margin-top:16px; flex-wrap:wrap;">
        <button class="btn btn-ghost" style="flex:1; justify-content:center; border-color:var(--accent); color:var(--accent);" onclick="loadBillForEdit('${key}')">✏️ Edit Bill</button>
        ${baki>0?`<button class="btn btn-green" style="flex:1; justify-content:center;" onclick="openPayModal('${key}','${escapeJsStr(b.customer||'')}',${baki})">💰 Pay</button>`:''}
        <button class="btn btn-ghost" style="flex:1; justify-content:center; border-color:var(--red); color:var(--red);" onclick="deleteBill('${key}')">🗑️ Delete Bill</button>
    </div>
  `;
  document.getElementById('bill-modal').classList.add('open');
}

function showCustDetail(name){
  const cu=cloudCustomers[name] || {};
  const baki=getCustomerTrueBalance(name);
  const safeName = escapeJsStr(name);
  const attrName = escapeHtmlAttr(name);
  document.getElementById('modal-title').innerText=`👤 ${name}`;
  document.getElementById('modal-body').innerHTML=`
    <div class="d-row"><span class="d-label">📞 Phone</span><span class="d-val">${cu.phone||'—'}</span></div>
    <div class="d-row"><span class="d-label">📍 Address</span><span class="d-val">${cu.address||'—'}</span></div>
    <div class="d-row" style="font-size:.92rem;font-weight:700"><span class="d-label" style="color:${baki>0?'var(--red)':'var(--green)'}">🔴 Total Baki</span><span class="d-val" style="color:${baki>0?'var(--red)':'var(--green)'}">NRS ${baki.toLocaleString('en-IN')}</span></div>
    
    <button class="btn btn-ghost" style="width:100%; justify-content:center; margin-top:12px; border-color:var(--accent); color:var(--accent);" onclick="showLedgerStatement('${safeName}')">📜 View Statement of Account</button>
    ${baki>0?`<button class="btn btn-green" style="width:100%;justify-content:center;margin-top:8px;" onclick="payFromLedger('${safeName}',${baki})">💰 Record Payment</button>`:''}
    <button class="btn btn-red" style="width:100%;justify-content:center;margin-top:8px;" onclick="deleteCustomer('${safeName}')">🗑️ Delete Customer</button>
  `;
  document.getElementById('bill-modal').classList.add('open');
}

// ============================================================
// STATEMENT OF ACCOUNT
// ============================================================
function showLedgerStatement(custName) {
    document.getElementById('ls-cust-name').innerText = custName;
    const cu = cloudCustomers[custName] || {};
    let subInfo = [];
    if(cu.address) subInfo.push(cu.address);
    if(cu.phone) subInfo.push(cu.phone);
    document.getElementById('ls-cust-sub').innerText = subInfo.join(' • ');
    
    const list = document.getElementById('ledger-statement-list');
    if(!list) return;
    list.innerHTML = '';
    
    let events = [];
    
    const custBills = allBills.filter(b => b && b.customer === custName).reverse();
    
    custBills.forEach(b => {
        let billTotal = parseFloat(b.billAmount) || 0;
        let totalPaidOnBill = parseFloat(b.paid) || 0;
        let timeBase = new Date(b.date || 0).getTime();
        if (isNaN(timeBase)) timeBase = 0;
        
        events.push({ 
            date: b.date || '—', 
            time: timeBase, 
            desc: `Invoice #${b.invoiceNum || 'N/A'}`, 
            debit: billTotal, 
            credit: 0 
        });
        
        let modalPaymentsSum = 0;
        if (b.payments && typeof b.payments === 'object') {
            Object.values(b.payments).forEach(p => {
                if(!p) return;
                let amt = parseFloat(p.amount) || 0;
                modalPaymentsSum += amt;
                let pTime = new Date(p.date || b.date || 0).getTime() + 1000;
                if (isNaN(pTime)) pTime = timeBase + 1000;
                events.push({ 
                    date: p.date || b.date || '—', 
                    time: pTime, 
                    desc: `Payment (${p.mode || 'Cash'}${p.note ? ' - ' + p.note : ''})`, 
                    debit: 0, 
                    credit: amt 
                });
            });
        }
        
        let initialPaid = totalPaidOnBill - modalPaymentsSum;
        if (initialPaid > 0) {
            let initTime = new Date(b.cashPaidDate || b.date || 0).getTime() + 500;
            if (isNaN(initTime)) initTime = timeBase + 500;
            events.push({ 
                date: b.cashPaidDate || b.date || '—', 
                time: initTime, 
                desc: `Payment (Cash)`, 
                debit: 0, 
                credit: initialPaid 
            });
        }
    });
    
    events.sort((a,b) => a.time - b.time);
    
    let listHtml = '';
    let bal = 0;
    listHtml += `<tr style="border-bottom:1px solid #e2e8f0; background:#f8fafc;"><td style="padding:10px;">—</td><td style="padding:10px;">Opening Balance</td><td></td><td></td><td style="text-align:right; font-weight:600;">0</td></tr>`;
    
    events.forEach(e => {
        bal += e.debit; 
        bal -= e.credit;
        listHtml += `<tr style="border-bottom:1px solid #e2e8f0;">
            <td style="padding:10px;">${e.date}</td>
            <td style="padding:10px;">${e.desc}</td>
            <td style="text-align:right; padding:10px;">${e.debit > 0 ? Math.round(e.debit).toLocaleString('en-IN') : ''}</td>
            <td style="text-align:right; padding:10px; color:#059669; font-weight:600;">${e.credit > 0 ? Math.round(e.credit).toLocaleString('en-IN') : ''}</td>
            <td style="text-align:right; font-weight:600;">${Math.round(bal).toLocaleString('en-IN')}</td>
        </tr>`;
    });
    
    list.innerHTML = listHtml;
    closeModal('bill-modal');
    document.getElementById('ledger-statement-modal').classList.add('open');
}

function shareStatementWA() {
    const custName = document.getElementById('ls-cust-name').innerText;
    const cu = cloudCustomers[custName];
    if(!cu || !cu.phone) { alert("No phone number found for this customer."); return; }
    const baki = getCustomerTrueBalance(custName);
    const msg = `🏪 *Rabi Kapada Pasal*\n\nNamaste *${custName}*,\nAccount Summary:\n🔴 *Total Due: NRS ${baki.toLocaleString('en-IN')}*`;
    window.open('https://wa.me/'+cu.phone.replace(/\D/g,'')+'?text='+encodeURIComponent(msg),'_blank');
}

function downloadLedgerStatement() {
    const targetElement = document.getElementById('ledger-statement-render');
    const custName = document.getElementById('ls-cust-name').innerText || 'Customer';
    const safeCust = custName.replace(/[^a-zA-Z0-9]/g, '_');
    const btn = document.getElementById('ls-download-btn');
    if (btn) btn.innerText = '⏳ Saving...';

    downloadElementAsImage(targetElement, `Statement-${safeCust}.png`, () => {
        if (btn) btn.innerText = '🖼️ Download Statement';
    });
}

function payFromLedger(name, baki){
  _payCust = name;
  const bill = allBills.find(b => b.customer === name && (parseFloat(b.remaining) || 0) > 0);
  _payKey = bill ? bill.key : '';
  
  document.getElementById('pay-modal-title').innerText = `💰 Payment — ${name}`;
  document.getElementById('pay-baki-display').innerText = `NRS ${Math.round(baki).toLocaleString('en-IN')}`;
  document.getElementById('pay-amount-inp').value = '';
  document.getElementById('pay-note-inp').value = '';
  document.getElementById('pay-date-inp').value = todayStr;
  
  closeModal('bill-modal');
  document.getElementById('pay-modal').classList.add('open');
}

function openPayModal(key, cust, baki){
  _payKey = key;
  _payCust = cust;
  document.getElementById('pay-modal-title').innerText = `💰 Payment — ${cust}`;
  document.getElementById('pay-baki-display').innerText = `NRS ${Math.round(baki).toLocaleString('en-IN')}`;
  document.getElementById('pay-amount-inp').value = '';
  document.getElementById('pay-note-inp').value = '';
  document.getElementById('pay-date-inp').value = todayStr;
  
  closeModal('bill-modal');
  document.getElementById('pay-modal').classList.add('open');
}

// ============================================================
// CONFIRM PAYMENT
// ============================================================
function confirmPayment(){
  const amount = parseFloat(document.getElementById('pay-amount-inp').value) || 0;
  const note = document.getElementById('pay-note-inp').value.trim();
  const payDate = document.getElementById('pay-date-inp').value || todayStr; 
  
  if(amount <= 0){ alert('Enter a valid amount'); return; }
  
  const currentCustBal = getCustomerTrueBalance(_payCust);
  const newCustBal = Math.max(0, currentCustBal - amount);

  let bill = allBills.find(b => b.key === _payKey);
  if(!bill && _payCust) {
      bill = allBills.find(b => b.customer === _payCust && (parseFloat(b.remaining) || 0) > 0);
  }
  
  if(bill) {
      const newBillRem = Math.max(0, (parseFloat(bill.remaining) || 0) - amount);
      const newPaid = (parseFloat(bill.paid) || 0) + amount;
      const entry = { amount, date: payDate, note }; 
      
      bill.remaining = newBillRem.toString();
      bill.paid = newPaid.toString();

      queueDatabaseWrite('nwh/bills/' + bill.key + '/remaining', 'set', newBillRem.toString());
      queueDatabaseWrite('nwh/bills/' + bill.key + '/paid', 'set', newPaid.toString());
      queueDatabaseWrite('nwh/bills/' + bill.key + '/payments', 'push', entry);
  }
  
  if(_payCust) {
      if (!cloudCustomers[_payCust]) cloudCustomers[_payCust] = {};
      cloudCustomers[_payCust].balance = newCustBal.toString();

      queueDatabaseWrite('nwh/customers/' + _payCust + '/balance', 'set', newCustBal.toString());

      const latestBill = allBills.find(b => b && b.customer === _payCust);
      if (latestBill) {
          latestBill.remaining = newCustBal.toString();
          queueDatabaseWrite('nwh/bills/' + latestBill.key + '/remaining', 'set', newCustBal.toString());
      }
      
      document.getElementById('rec-date').innerText = payDate;
      document.getElementById('rec-cust').innerText = _payCust;
      document.getElementById('rec-amt').innerText = Math.round(amount).toLocaleString('en-IN');
      document.getElementById('rec-baki').innerText = Math.round(newCustBal).toLocaleString('en-IN');
      document.getElementById('rec-note').innerText = note || '—';
  }
  
  closeModal('pay-modal');
  document.getElementById('receipt-modal').classList.add('open');
  renderLedger();
  renderHistory();
}

function shareReceiptWA() {
    const amt = document.getElementById('rec-amt').innerText;
    const baki = document.getElementById('rec-baki').innerText;
    const note = document.getElementById('rec-note').innerText;
    let msg = `🏪 *Rabi Kapada Pasal*\n✅ Payment Received: *NRS ${amt}*\n🔴 Remaining Baki: *NRS ${baki}*`;
    if(note !== '—') msg += `\n📝 Note: ${note}`;
    
    const phone = cloudCustomers[_payCust]?.phone || '';
    window.open('https://wa.me/'+phone.replace(/\D/g,'')+'?text='+encodeURIComponent(msg),'_blank');
}

function downloadReceiptImage() {
    const targetElement = document.getElementById('thermal-receipt');
    const btn = document.querySelector('#receipt-modal .btn-primary');
    if (btn) btn.innerText = '⏳ Saving...';

    const safeCustName = (_payCust || 'Customer').replace(/[^a-zA-Z0-9]/g, '_');
    downloadElementAsImage(targetElement, `Receipt-${safeCustName}.png`, () => {
        if (btn) btn.innerText = '🖼️ Save Image';
    });
}

function closeModal(id){document.getElementById(id).classList.remove('open');}

function renderHistory(){
  const c=document.getElementById('history-container');
  if(!c) return;
  if(!allBills || !allBills.length) return c.innerHTML=`<div class="empty-state">No bills yet</div>`;

  let html=`<table class="h-table"><thead><tr><th>#</th><th>Customer</th><th>Bill</th><th>Paid</th><th>Baki</th></tr></thead><tbody>`;
  allBills.forEach(b=>{
    const baki=parseInt(b.remaining)||0;
    html+=`<tr onclick="showBillDetail('${b.key}')"><td><span style="font-weight:700;color:var(--accent)">#${b.invoiceNum}</span><br><span style="font-size:10px">${b.date}</span></td><td><strong>${escapeHtmlAttr(b.customer)}</strong></td><td>NRS ${parseInt(b.billAmount || 0).toLocaleString('en-IN')}</td><td style="color:var(--green)">${parseInt(b.paid || 0).toLocaleString('en-IN')}</td><td><span class="badge ${baki>0?'b-red':'b-green'}">${baki.toLocaleString('en-IN')}</span></td></tr>`;
  });
  html += `</tbody></table>`;
  c.innerHTML = html;
}

function renderLedger(resetLimit = false){
  const c=document.getElementById('ledger-container');
  if(!c) return;
  
  const allCustNames = new Set(Object.keys(cloudCustomers || {}));
  if (Array.isArray(allBills)) {
      allBills.forEach(b => { if (b && b.customer) allCustNames.add(b.customer); });
  }
  
  if(!allCustNames.size) return c.innerHTML=`<div class="empty-state">No customers yet</div>`;

  let html = '';
  Array.from(allCustNames).sort().forEach(name => {
    const cu = cloudCustomers[name] || {};
    const baki = getCustomerTrueBalance(name);
    const safeName = escapeJsStr(name);
    const attrName = escapeHtmlAttr(name);
    html += `<div class="ledger-card" onclick="showCustDetail('${safeName}')"><div style="flex:1; pointer-events:none;"><div class="lc-name">${attrName}</div><div class="lc-phone" style="margin-top:2px;">${cu.phone||'—'}</div></div><div style="text-align:right; pointer-events:none;"><div class="lc-baki ${baki>0?'due':'ok'}">NRS ${Math.round(baki).toLocaleString('en-IN')}</div><span class="badge ${baki>0?'b-red':'b-green'}">${baki>0?'Due':'Cleared'}</span></div></div>`;
  });
  c.innerHTML = html;
}
