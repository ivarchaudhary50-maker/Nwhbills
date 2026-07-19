// ============================================================
// SAFE STORAGE & GLOBALS
// ============================================================
function safeGetLocal(k) { try { return localStorage.getItem(k); } catch(e) { return null; } }
function safeSetLocal(k, v) { try { localStorage.setItem(k, v); } catch(e) {} }
function safeGetSession(k) { try { return sessionStorage.getItem(k); } catch(e) { return null; } }
function safeSetSession(k, v) { try { sessionStorage.setItem(k, v); } catch(e) {} }

let editBillKey = null;
let editInvoiceNum = null;
let pendingBill = null;
let lang = 'en';
let pokaCounter = 0;
let allPokas = [];
let inventoryList = [];
let cloudCustomers={}, cloudNextInvoice=1001, allBills=[], db=null, fbReady=false;

// ============================================================
// PAGINATION LIMITS (RAM OPTIMIZATION)
// ============================================================
let dbBillsLimit = 50; 
let dbPokasLimit = 50;
let billsListenerRef = null;
let pokasListenerRef = null;

// ============================================================
// OFFLINE CACHE (FOR PERFECT DATES)
// ============================================================
let calendarCorrections = JSON.parse(safeGetLocal('nwh_cal_corrections') || '{}');

// ============================================================
// PIN LOCK LOGIC
// ============================================================
let pinCode = '';
const CORRECT_PIN = '8860'; 

function pinPress(num) {
  if(pinCode.length < 4) {
    pinCode += num;
    document.getElementById('d' + (pinCode.length - 1)).classList.add('filled');
  }
  if(pinCode.length === 4) {
    if(pinCode === CORRECT_PIN) {
      document.getElementById('pw-screen').style.display = 'none';
    } else {
      document.getElementById('pw-err').innerText = 'Incorrect PIN';
      setTimeout(() => {
        pinCode = '';
        document.getElementById('pw-err').innerText = '';
        document.querySelectorAll('.pin-dot').forEach(d => d.classList.remove('filled'));
      }, 1000);
    }
  }
}

function pinDel() {
  if(pinCode.length > 0) {
    document.getElementById('d' + (pinCode.length - 1)).classList.remove('filled');
    pinCode = pinCode.slice(0, -1);
  }
}

// ============================================================
// DEBOUNCE LOGIC (SPEED OPTIMIZATION)
// ============================================================
function debounce(func, delay = 300) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), delay);
  };
}

// ============================================================
// OFFLINE OUTBOX QUEUE (FOOLPROOF SYNCING)
// ============================================================
let isSyncing = false;
let syncQueue = JSON.parse(safeGetLocal('nwh_sync_queue') || '[]');

function updateSyncBadge() {
    const syncEl = document.getElementById('sync-status');
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
    if (!fbReady || isSyncing || syncQueue.length === 0 || !firebase.auth().currentUser) {
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
// BULLETPROOF CUSTOMER DATA AUTO-FILL ENGINE
// ============================================================
function triggerCustomerAutoFill() {
    const rawName = document.getElementById('customer-name').value.trim();
    if(!rawName) {
        if (!editBillKey) document.getElementById('prev-balance').value = '';
        return;
    }
    
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
    }

    if (!editBillKey) {
        let bal = cu ? parseFloat((cu.balance || '0').toString().replace(/,/g, '')) : 0;
        
        if (!bal || isNaN(bal) || bal === 0) {
            for(let i = 0; i < allBills.length; i++) {
                if(allBills[i].customer && allBills[i].customer.toLowerCase() === searchName) {
                    bal = parseFloat((allBills[i].remaining || '0').toString().replace(/,/g, ''));
                    break;
                }
            }
        }
        
        document.getElementById('prev-balance').value = (isNaN(bal) || bal === 0) ? '' : bal;
        calc();
    }
}

// ============================================================
// SUGGESTION BAR SYSTEM
// ============================================================
function initSuggestionBar() {
    const bar = document.getElementById('suggestion-bar');
    
    document.addEventListener('focusin', (e) => {
        const target = e.target;
        if(target.tagName === 'INPUT' && (target.id === 'customer-name' || target.id === 'slip-customer' || target.classList.contains('item-desc') || target.classList.contains('poka-desc-inp'))) {
            updateSuggestions(target);
            bar.style.display = 'flex';
        } else {
            bar.style.display = 'none';
        }
    });

    document.addEventListener('focusout', (e) => {
        setTimeout(() => { 
            if(!document.activeElement || document.activeElement.tagName !== 'INPUT') {
                bar.style.display = 'none'; 
            }
        }, 150);
    });
}

function updateSuggestions(target) {
    const bar = document.getElementById('suggestion-bar');
    bar.innerHTML = '';
    let opts = [];
    
    if (target.id === 'customer-name' || target.id === 'slip-customer') {
        opts = Object.keys(cloudCustomers);
    } else {
        opts = inventoryList;
    }
    
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
  const ref = Date.UTC(1943, 3, 15); 
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
    const ref = Date.UTC(1943, 3, 15); 
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
    return (4 + days) % 7; 
}

function updateBSDate() {
  const adVal = document.getElementById('current-date-ad').value;
  if(!adVal) { 
      document.getElementById('bs-date-inp').value = '';
      return; 
  }
  
  if (calendarCorrections[adVal]) {
      const correctBS = calendarCorrections[adVal]; 
      const [cy, cm, cd] = correctBS.split(',').map(Number);
      selCalY = cy; selCalM = cm; selCalD = cd;
      document.getElementById('bs-date-inp').value = `📅 ${cd} ${NM[cm-1]} ${cy}`;
      
      if(document.getElementById('np-cal-popup').style.display === 'block') {
          document.getElementById('np-cal-y').value = selCalY;
          document.getElementById('np-cal-m').value = selCalM;
          renderNpCal();
      }
      return;
  }

  const [y,m,d] = adVal.split('-').map(Number);
  const bsData = adToBS(y,m,d);
  
  if(bsData) {
      selCalY = bsData.year; selCalM = bsData.month; selCalD = bsData.day;
      document.getElementById('bs-date-inp').value = `📅 ${bsData.day} ${bsData.monthName} ${bsData.year}`;
      
      if(document.getElementById('np-cal-popup').style.display === 'block') {
          document.getElementById('np-cal-y').value = selCalY;
          document.getElementById('np-cal-m').value = selCalM;
          renderNpCal();
      }
  }
}

function populateCustomerList() {
    const list = document.getElementById('customer-list');
    list.innerHTML = '';
    Object.keys(cloudCustomers).forEach(name => {
        let option = document.createElement('option');
        option.value = name;
        list.appendChild(option);
    });
}

function initNpCal() {
    const ySel = document.getElementById('np-cal-y');
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
    document.getElementById('np-cal-grid').innerHTML = html;
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

const todayObj=new Date();
const tMM = String(todayObj.getMonth() + 1).padStart(2, '0');
const tDD = String(todayObj.getDate()).padStart(2, '0');
const todayStr= `${todayObj.getFullYear()}-${tMM}-${tDD}`;

window.onload = function() {
    initNpCal();
    initSuggestionBar();
    document.getElementById('current-date-ad').value = todayStr;
    document.getElementById('cash-paid-date').value = todayStr;
    document.getElementById('slip-date').value = todayStr;
    document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
    updateBSDate();

    const cNameInput = document.getElementById('customer-name');
    cNameInput.addEventListener('input', triggerCustomerAutoFill);
    cNameInput.addEventListener('blur', triggerCustomerAutoFill);
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
}

function filterHistory(){
  const q = document.getElementById('history-search').value.toLowerCase();
  const rows = document.querySelectorAll('#history-container .h-table tbody tr');
  rows.forEach(r => { r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none'; });
}

function filterLedger(){
  const q = document.getElementById('ledger-search').value.toLowerCase();
  const cards = document.querySelectorAll('#ledger-container .ledger-card');
  cards.forEach(c => { c.style.display = c.innerText.toLowerCase().includes(q) ? '' : 'none'; });
}

// ============================================================
// FIREBASE CONNECTION & DATA FETCHING
// ============================================================
const fbConfig={
  apiKey:"AIzaSyAwKhnpjyS6sqIuwjmP3idhE3b7kftRy9w",
  authDomain:"nwh-bills.firebaseapp.com",
  databaseURL:"https://nwh-bills-default-rtdb.firebaseio.com/",
  projectId:"nwh-bills"
};

function initFB(){
  try{
    if(!firebase.apps.length) firebase.initializeApp(fbConfig);
    db=firebase.database();

    // PERFECT FIX: Automatically use the anonymous login that is already working
    firebase.auth().signInAnonymously().then(() => {
        startDatabaseListeners();
    }).catch(e => console.error("Auth error:", e));

  }catch(e){ console.error(e); }
}
setTimeout(initFB, 300);

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
    
    db.ref('nwh/calendar_corrections').on('value', s => {
        if (s.val()) {
            calendarCorrections = s.val();
            safeSetLocal('nwh_cal_corrections', JSON.stringify(calendarCorrections));
            updateBSDate();
        }
    });

    db.ref('nwh/nextInvoiceNumber').on('value',s=>{
      const v=s.val();
      if(v){ cloudNextInvoice=v; if(!editBillKey) document.getElementById('invoice-number').innerText=v; }
      else queueDatabaseWrite('nwh/nextInvoiceNumber', 'set', 1001);
    });

    db.ref('nwh/customers').on('value',s=>{
        cloudCustomers=s.val()||{};
        populateCustomerList();
        if(document.getElementById('panel-ledger').classList.contains('active')) renderLedger();
    });

    db.ref('nwh/inventory').on('value',s=>{
      const val = s.val();
      if(Array.isArray(val)) inventoryList = val;
      else if(val) inventoryList = Object.values(val);
      renderInventory();
      safeSetLocal('nwh_inventory', JSON.stringify(inventoryList));
    });

    loadBills();
    loadPokas();
}

function loadBills() {
    if(billsListenerRef) db.ref('nwh/bills').off('value', billsListenerRef);
    billsListenerRef = db.ref('nwh/bills').orderByKey().limitToLast(dbBillsLimit).on('value', s => {
        const v = s.val();
        allBills = v ? Object.entries(v).map(([k, b]) => ({ key: k, ...b })).reverse() : [];
        if (document.getElementById('panel-history').classList.contains('active')) renderHistory();
    });
}

function loadPokas() {
    if(pokasListenerRef) db.ref('nwh/pokas').off('value', pokasListenerRef);
    pokasListenerRef = db.ref('nwh/pokas').orderByKey().limitToLast(dbPokasLimit).on('value', s => {
        const v = s.val();
        allPokas = v ? Object.entries(v).map(([k, p]) => ({ key: k, ...p })).reverse() : [];
        if (document.getElementById('panel-packing').classList.contains('active')) renderPokaHistory();
    });
}

function loadMoreBills() {
    dbBillsLimit += 50;
    loadBills();
}

function loadMorePokas() {
    dbPokasLimit += 50;
    loadPokas();
}

// ============================================================
// ITEM CATALOG & AUTO-FILL RATE MEMORY
// ============================================================
try {
    let saved = safeGetLocal('nwh_inventory');
    if (saved) inventoryList = JSON.parse(saved) || [];
} catch(e) {}

function renderInventory() {
    const list = document.getElementById('inventory-list');
    list.innerHTML = '';
    inventoryList.forEach(item => {
        let option = document.createElement('option');
        option.value = item;
        list.appendChild(option);
    });
}

function saveNewItems(itemsArray) {
    let changed = false;
    itemsArray.forEach(it => {
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
    }
}

function checkAndAutoFillRate(inputElement) {
    const row = inputElement.closest('tr');
    const custName = document.getElementById('customer-name').value.trim().replace(/[.#$\[\]]/g, ' ');
    const descInput = row.querySelector('.item-desc');
    const rateInput = row.querySelector('.rate');
    
    let hintSpan = row.querySelector('.rate-hint');
    if(!hintSpan) {
        hintSpan = document.createElement('div');
        hintSpan.className = 'rate-hint';
        hintSpan.style = 'font-size: 0.65rem; color: var(--green); position: absolute; margin-top: 2px; right: 12px; pointer-events: none;';
        rateInput.parentNode.appendChild(hintSpan);
        rateInput.parentNode.style.position = 'relative';
    }
    
    hintSpan.innerText = '';
    if(!custName || !descInput.value.trim()) return;
    
    let lastRate = null;
    for(let i=0; i<allBills.length; i++) {
        if(allBills[i].customer === custName && allBills[i].items) {
            const match = allBills[i].items.find(it => it.desc.toLowerCase() === descInput.value.toLowerCase().trim());
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

// ============================================================
// DYNAMIC NOTES SECTION
// ============================================================
function addNoteRow(dateVal = '', textVal = '') {
    const container = document.getElementById('notes-container');
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
addNoteRow();

// ============================================================
// POKA DRAFT HISTORY SYSTEM & MATRIX GENERATOR
// ============================================================
function addPokaGroup(items = null) {
    const existing = document.querySelectorAll('.poka-card-wrapper').length;
    pokaCounter = existing + 1; 
    
    const currentId = pokaCounter;
    const container = document.getElementById('poka-groups-container');
    
    const div = document.createElement('div');
    div.className = 'poka-card-wrapper';
    div.style = 'background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.03);';
    div.id = `poka-wrapper-${currentId}`;
    
    div.innerHTML = `
        <div style="background:var(--surface2); padding:10px 16px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
            <span style="font-weight:800; font-size:0.95rem; color:var(--text)">📦 Poka #${currentId}</span>
            <button class="del-row" onclick="removePokaGroup(${currentId})" style="color:var(--red); font-size:0.8rem; font-weight:700; background:#fee2e2; border:1px solid #fecaca; cursor:pointer; padding:6px 10px; border-radius:6px;">✕ Remove Poka</button>
        </div>
        <div style="padding:12px; display:flex; flex-direction:column; gap:10px;" id="poka-items-tbody-${currentId}">
            </div>
        <div style="padding:0 12px 12px 12px;">
            <button class="btn btn-ghost" onclick="addPokaItemRow(${currentId})" style="font-size:0.85rem; padding:8px 12px; width:100%; border:2px dashed var(--border); color:var(--accent);">+ Add Garment Breakdown</button>
        </div>
    `;
    container.appendChild(div);
    
    if (items && items.length > 0) {
        items.forEach(it => {
            let form = it.formula;
            let mult = '10'; 
            if (form.includes('×')) {
               const parts = form.split('×');
               form = parts[0].replace(/[() ]/g, '');
               mult = parts[1].trim();
            }
            addPokaItemRow(currentId, it.desc, form, mult);
        });
    } else {
        addPokaItemRow(currentId);
    }
    syncPokaCountValue();
    initSuggestionBar();
}

function addPokaItemRow(pokaId, desc='', formula='', mult='10') {
    const tbody = document.getElementById(`poka-items-tbody-${pokaId}`);
    const div = document.createElement('div');
    div.className = 'poka-item-row';
    div.style = "background:var(--surface2); padding:12px; border-radius:10px; border:1px solid var(--border);";
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; margin-bottom:10px; gap:10px;">
            <input type="text" class="inp poka-desc-inp" placeholder="Type Garment Description..." value="${desc}" list="inventory-list" style="flex:1; font-weight:600; font-size:0.9rem; padding:10px;">
            <button class="del-row" onclick="this.closest('.poka-item-row').remove(); syncPokaCountValue();" style="padding:8px 14px; font-size:1rem; background:#fee2e2; color:#991b1b; border-radius:8px; border:none; cursor:pointer;">✕</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
            <input type="text" class="inp poka-formula-inp" placeholder="e.g. 11+13+5" value="${formula}" oninput="evaluatePokaRowSum(this)" style="flex:2; font-family:'Space Mono', monospace; font-size:1rem; font-weight:700; padding:10px;">
            <span style="font-size:1.2rem; color:var(--text3); font-weight:bold;">×</span>
            <input type="number" class="inp poka-mult-inp" value="${mult}" oninput="evaluatePokaRowSum(this)" style="flex:1; max-width:70px; font-family:'Space Mono', monospace; font-size:1rem; font-weight:700; padding:10px; text-align:center;">
            <div style="min-width:65px; text-align:right;">
                <span class="poka-row-sum-output" style="font-family:'Space Mono', monospace; font-size:1.15rem; font-weight:800; color:var(--accent);">0</span>
            </div>
        </div>
    `;
    tbody.appendChild(div);
    
    const inputs = div.querySelectorAll('input');
    inputs.forEach((inp, index) => {
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (index < inputs.length - 1) {
                    inputs[index + 1].focus();
                } else {
                    addPokaItemRow(pokaId);
                    const newRows = document.querySelectorAll(`#poka-items-tbody-${pokaId} .poka-item-row`);
                    newRows[newRows.length - 1].querySelector('.poka-desc-inp').focus();
                }
            }
        });
    });

    if(formula) evaluatePokaRowSum(div.querySelector('.poka-formula-inp'));
    initSuggestionBar();
}

function evaluatePokaRowSum(inputElement) {
    const row = inputElement.closest('.poka-item-row');
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
    syncPokaCountValue();
    document.querySelectorAll('.poka-card-wrapper').forEach((wrapper, index) => {
        const newId = index + 1;
        wrapper.id = `poka-wrapper-${newId}`;
        wrapper.querySelector('span').innerText = `📦 Poka #${newId}`;
        wrapper.querySelector('button.del-row').setAttribute('onclick', `removePokaGroup(${newId})`);
        wrapper.querySelector('.poka-items-tbody').id = `poka-items-tbody-${newId}`;
        wrapper.querySelector('.btn-ghost').setAttribute('onclick', `addPokaItemRow(${newId})`);
    });
}

function syncPokaCountValue() {
    const elements = document.querySelectorAll('.poka-card-wrapper');
    document.getElementById('total-poka').value = elements.length > 0 ? elements.length : '';
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
    pokaCounter = 0;
    document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
    document.getElementById('slip-customer').value = '';
    addPokaGroup();
}

function renderPokaHistory() {
    const c = document.getElementById('saved-pokas-container');
    if(!allPokas.length) { 
        c.innerHTML = `<div class="empty-state"><div class="icon">📁</div><div class="L">No saved drafts</div></div>`; 
        return; 
    }

    let html = `<table class="h-table"><thead><tr><th>Date & Ref</th><th>Customer</th><th>Total</th><th>Actions</th></tr></thead><tbody>`;
    allPokas.forEach(p => {
        html += `<tr>
            <td><strong style="color:var(--accent);">${p.ref}</strong><br><span style="font-size:10px">${p.date}</span></td>
            <td><strong>${p.customer}</strong></td>
            <td>${p.totalPoka}</td>
            <td style="white-space:nowrap;">
                <button class="btn btn-ghost" style="padding:4px 8px; font-size:0.75rem; border-color:var(--accent); color:var(--accent);" onclick="loadPokaDraft('${p.key}')">⬇️ Load</button>
                <button class="btn btn-ghost" style="padding:4px 8px; font-size:0.75rem; border-color:var(--red); color:var(--red); margin-left:4px;" onclick="deletePokaDraft('${p.key}')">🗑️</button>
            </td>
        </tr>`;
    });
    c.innerHTML = html + `</tbody></table>`;
    
    if(allPokas.length >= dbPokasLimit) {
        c.innerHTML += `<button class="btn btn-ghost" style="width:100%; margin-top:10px;" onclick="loadMorePokas()">Load More Server Data</button>`;
    }
}

function loadPokaDraft(key) {
    const p = allPokas.find(x => x.key === key);
    if(!p) return;

    document.getElementById('slip-customer').value = p.customer !== 'Walk-in / Unknown' ? p.customer : '';
    document.getElementById('slip-ref').value = p.ref;
    document.getElementById('slip-date').value = p.date;

    document.getElementById('poka-groups-container').innerHTML = '';
    pokaCounter = 0;

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

// ============================================================
// INVOICE MATH
// ============================================================
function addRow(desc='',qty='',rate='',code=''){
  const tr=document.createElement('tr');
  tr.innerHTML=`<td><input type="text" class="ti item-desc" placeholder="Type item..." value="${desc}" list="inventory-list" oninput="checkAndAutoFillRate(this)"></td>
    <td><input type="text" class="ti r item-code" placeholder="—" value="${code}"></td>
    <td><input type="number" class="ti r qty" placeholder="0" min="0" value="${qty}" oninput="calc()"></td>
    <td style="position:relative;"><input type="number" class="ti r rate" placeholder="0" min="0" value="${rate}" oninput="manualRateOverride(this)"></td>
    <td class="amount" style="text-align:right; font-weight:bold; padding-right:12px;">0</td>
    <td class="no-print"><button class="del-row" onclick="this.closest('tr').remove();calc()">✕</button></td>`;
  document.getElementById('invoice-items').appendChild(tr);

  const inputs = tr.querySelectorAll('input');
  inputs.forEach((inp, index) => {
      inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
              e.preventDefault();
              if (index < inputs.length - 1) {
                  inputs[index + 1].focus();
              } else {
                  addRow();
                  const newRows = document.querySelectorAll('#invoice-items tr');
                  newRows[newRows.length - 1].querySelector('.item-desc').focus();
              }
          }
      });
  });

  if(qty&&rate) calc();
  initSuggestionBar();
}
addRow();

function calc(){
  let sub=0;
  document.querySelectorAll('#invoice-items tr').forEach(r=>{
    const q=parseFloat(r.querySelector('.qty').value)||0,rt=parseFloat(r.querySelector('.rate').value)||0,a=q*rt;
    r.querySelector('.amount').innerText=Math.round(a).toLocaleString('en-IN');sub+=a;
  });
  document.getElementById('items-total').innerText=Math.round(sub).toLocaleString('en-IN');
  const tr=parseFloat(document.getElementById('transport-expense').value)||0;
  const disc=parseFloat(document.getElementById('discount-amount').value)||0;
  const cb=(sub+tr)-disc;
  document.getElementById('current-bill').innerText=Math.round(cb).toLocaleString('en-IN');
  const pb=parseFloat(document.getElementById('prev-balance').value)||0,gt=cb+pb;
  document.getElementById('grand-total').innerText=Math.round(gt).toLocaleString('en-IN');
  const cp=parseFloat(document.getElementById('cash-paid').value)||0;
  document.getElementById('remaining-balance').innerText=Math.round(gt-cp).toLocaleString('en-IN');
}

function clearForm(){
  if(!confirm('Clear all form data?')) return;
  ['customer-name','customer-phone','customer-address','total-poka','transport-expense','discount-amount','prev-balance','cash-paid','db-search', 'slip-customer'].forEach(id=>{
      let el = document.getElementById(id);
      if(el) el.value = '';
  });
  
  document.getElementById('current-date-ad').value = todayStr;
  updateBSDate();
  document.getElementById('cash-paid-date').value = todayStr;
  document.getElementById('slip-date').value = todayStr;
  document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
  
  document.getElementById('invoice-items').innerHTML='';addRow();calc();
  document.getElementById('notes-container').innerHTML = '';
  document.getElementById('poka-groups-container').innerHTML = '';
  pokaCounter = 0; 
  addNoteRow();
  
  editBillKey = null;
  editInvoiceNum = null;
  document.getElementById('tab-invoice').innerHTML = `🧾 <span class="L" data-k="New Invoice">New Invoice</span>`;
  document.getElementById('invoice-number').innerText = cloudNextInvoice;
}

// ============================================================
// CUSTOMER SEARCH & SAVE
// ============================================================
function searchDB(){
  const q=document.getElementById('db-search').value.toLowerCase(),box=document.getElementById('search-results');
  box.innerHTML='';
  if(q.length<1){box.style.display='none';return;}
  let n=0;
  for(let name in cloudCustomers){
    const ph=(cloudCustomers[name].phone||'').toLowerCase();
    if(name.toLowerCase().includes(q)||ph.includes(q)){
      const d=document.createElement('div');d.className='sr-item';
      d.innerHTML=`<span><strong>${name}</strong> &nbsp;${cloudCustomers[name].phone||''}</span>`;
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
  if('contacts' in navigator&&'ContactsManager' in window){
    try{const c=await navigator.contacts.select(['name','tel'],{multiple:false});
      if(c.length>0){
        let name=c[0].name[0]||'';
        name = name.replace(/[.#$\[\]]/g, ' ').trim(); 
        document.getElementById('customer-name').value=name;
        if(name){
            triggerCustomerAutoFill();
        }
      }
    }catch(e){}
  }else{alert('Open in Google Chrome to use Contacts.');}
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

// ============================================================
// DATA EXTRACTION HELPER
// ============================================================
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

// ============================================================
// STANDALONE POKA PACKING SLIP
// ============================================================
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
        <div id="actual-slip-to-render" style="width: 800px; min-width: 800px; background: #ffffff; color: #000000; font-family: 'Plus Jakarta Sans', Arial, sans-serif; box-sizing: border-box; margin: 0; padding: 40px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;">
            <div style="text-align: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 30px;">
                <h1 style="font-size: 26px; color: #1a1f36; margin: 0; text-transform: uppercase; letter-spacing: 1px;">PACKING SLIP (POKA DETAILS)</h1>
                <h2 style="font-size: 18px; color: #4a5280; margin: 5px 0 0 0;">${bizName}</h2>
            </div>

            <table style="width: 100%; margin-bottom: 30px;">
                <tr>
                    <td style="width: 50%; vertical-align: top;">
                        <div style="background: #f7f9ff; padding: 15px; border-left: 4px solid #8b5cf6; border-radius: 4px;">
                            <p style="font-size: 11px; font-weight: bold; color: #8892b0; margin: 0 0 4px 0;">SHIP TO:</p>
                            <p style="font-size: 16px; font-weight: bold; color: #1a1f36; margin: 0;">${bill.customer}</p>
                            ${bill.phone ? `<p style="font-size: 13px; color: #4a5280; margin: 2px 0 0 0;">${bill.phone}</p>` : ''}
                            ${bill.address ? `<p style="font-size: 13px; color: #4a5280; margin: 2px 0 0 0;">${bill.address}</p>` : ''}
                        </div>
                    </td>
                    <td style="width: 50%; vertical-align: top; text-align: right;">
                        <p style="font-size: 13px; color: #4a5280; margin: 0 0 5px 0;"><strong>Date:</strong> ${slipDate}</p>
                        <p style="font-size: 13px; color: #4a5280; margin: 0 0 5px 0;"><strong>Slip Ref:</strong> ${slipRef}</p>
                        <p style="font-size: 13px; color: #4a5280; margin: 0;"><strong>Total Bundles:</strong> ${bill.totalPoka}</p>
                    </td>
                </tr>
            </table>
        `;

        bill.pokaDetails.forEach(p => {
            htmlString += `
            <div style="margin-bottom: 25px; border: 2px solid #cbd5e1; border-radius: 8px; overflow: hidden;">
                <div style="background: #f1f5f9; padding: 10px 15px; font-size: 14px; font-weight: 800; color: #1e293b; border-bottom: 2px solid #cbd5e1; display:flex; justify-content:space-between;">
                    <span>📦 Poka #${p.pokaNum}</span>
                </div>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                    <thead>
                        <tr style="background: #f8fafc; text-align: left; border-bottom: 1px solid #e2e8f0;">
                            <th style="padding: 12px 15px; color: #475569; font-weight: 700;">Garment Description</th>
                            <th style="padding: 12px 15px; color: #475569; font-weight: 700;">Breakdown</th>
                            <th style="padding: 12px 15px; text-align: right; color: #475569; font-weight: 700;">Total Pcs</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${p.items.map(it => `
                            <tr style="border-bottom: 1px solid #e2e8f0;">
                                <td style="padding: 12px 15px; font-weight: bold; color: #0f172a;">${it.desc}</td>
                                <td style="padding: 12px 15px; font-family: 'Space Mono', monospace; color: #334155; font-size: 15px; letter-spacing: 1px;">${it.formula || '—'}</td>
                                <td style="padding: 12px 15px; text-align: right; font-family: 'Space Mono', monospace; font-weight: bold; color: #0f172a; font-size: 15px;">${it.total}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
        });

        htmlString += `
            <div style="margin-top: 50px; text-align: center; color: #94a3b8; font-size: 12px; border-top: 1px solid #e2e8f0; padding-top: 20px;">
                This is a logistics packing slip only. It does not contain pricing or financial information.
            </div>
        </div>
    </div>`;

    document.getElementById('slip-body').innerHTML = htmlString;
    document.getElementById('slip-modal').classList.add('open');
}

function downloadSlipOnly() {
    const btn = document.getElementById('slip-dl-btn');
    const oldText = btn.innerHTML;
    btn.innerHTML = '⏳ Processing...';

    const originalElement = document.getElementById('actual-slip-to-render');
    const clone = originalElement.cloneNode(true);
    
    document.body.appendChild(clone);
    clone.style.position = 'absolute';
    clone.style.top = '-9999px';
    clone.style.left = '0';
    clone.style.width = '800px'; 
    clone.style.maxWidth = 'none';
    clone.style.margin = '0'; 

    html2canvas(clone, { scale: 4, useCORS: true, backgroundColor: '#ffffff' }).then(function (canvas) {
        document.body.removeChild(clone);
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        const refName = document.getElementById('customer-name').value.trim() || 'Customer';
        link.download = `PackingSlip-${refName}.png`;
        link.href = dataUrl;
        link.click();
        
        btn.innerHTML = oldText;
        closeModal('slip-modal');
    }).catch(function (error) {
        if(document.body.contains(clone)) document.body.removeChild(clone);
        console.error("Slip Error:", error);
        btn.innerHTML = oldText;
        alert("Error generating image.");
    });
}

// ============================================================
// MAIN INVOICE PREVIEW & SIGNATURE LOGIC
// ============================================================
function previewBill(){
  pendingBill = extractPendingBillData();
  generatePreviewHTML(pendingBill);
}

function generatePreviewHTML(bill) {
    let rowsHtml = "";
    bill.items.forEach(it => {
        rowsHtml += `<tr>
            <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px;">${it.desc}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; text-align:center;">${it.code || '—'}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; text-align:right;">${it.qty}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; text-align:right;">${it.rate}</td>
            <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; text-align:right; font-weight:bold;">${parseInt(it.amount).toLocaleString('en-IN')}</td>
        </tr>`;
    });

    const bizName = document.getElementById('biz-name').innerText || "Rabi Kapada Pasal";
    const bizSub = document.getElementById('biz-sub').innerText || "";
    
    let cashDateStr = '';
    if (bill.paid && bill.paid !== '0' && bill.cashPaidDate) {
        let bsStr = '';
        try {
            const [cy,cm,cd] = bill.cashPaidDate.split('-').map(Number);
            const cBs = adToBS(cy,cm,cd);
            if(cBs) bsStr = ` (${cBs.day} ${cBs.monthName})`;
        } catch(e){}
        cashDateStr = `<br><span style="font-size:11.5px; opacity:0.85; font-weight:normal;">📅 ${bill.cashPaidDate}${bsStr}</span>`;
    }

    let htmlString = `
    <div style="padding: 10px; width: 100%; overflow-x: auto; background: #e2e8f0; -webkit-overflow-scrolling: touch;">
        <div id="actual-bill-to-render" style="width: 800px; min-width: 800px; background: #ffffff; color: #000000; font-family: 'Plus Jakarta Sans', Arial, sans-serif; box-sizing: border-box; margin: 0; padding: 40px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;">
            <table style="width: 100%; border-bottom: 2px solid #e2e8f0; margin-bottom: 20px; border-collapse: collapse;">
                <tr>
                    <td style="vertical-align: top; padding-bottom: 20px;">
                        <h1 style="font-size: 28px; color: #1a1f36; margin: 0;">${bizName}</h1>
                        <p style="font-size: 14px; color: #4a5280; margin-top: 5px;">${bizSub}</p>
                    </td>
                    <td style="vertical-align: top; text-align: right; padding-bottom: 20px;">
                        <h2 style="font-size: 24px; color: #a0aec0; margin: 0; letter-spacing: 2px;">INVOICE</h2>
                        <p style="font-size: 16px; font-weight: bold; margin-top: 5px;">#${bill.invoiceNum}</p>
                        <p style="font-size: 14px; margin-top: 2px;">${bill.date}</p>
                        <p style="font-size: 12px; margin-top: 2px;">${bill.dateBS || ""}</p>
                    </td>
                </tr>
            </table>

            <div style="background: #f7f9ff; padding: 20px; border-left: 4px solid #8b5cf6; margin-bottom: 25px;">
                <p style="font-size: 12px; font-weight: bold; color: #8892b0; margin: 0 0 5px 0;">BILL TO:</p>
                <p style="font-size: 18px; font-weight: bold; margin: 0;">${bill.customer}</p>
                <p style="font-size: 14px; color: #4a5280; margin: 2px 0 0 0;">${bill.phone || ""}</p>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <thead>
                    <tr>
                        <th style="background: #8b5cf6; color: white; padding: 12px; font-size: 14px; text-align: left;">Description</th>
                        <th style="background: #8b5cf6; color: white; padding: 12px; font-size: 14px; text-align: center;">Code</th>
                        <th style="background: #8b5cf6; color: white; padding: 12px; font-size: 14px; text-align: right;">Qty</th>
                        <th style="background: #8b5cf6; color: white; padding: 12px; font-size: 14px; text-align: right;">Rate</th>
                        <th style="background: #8b5cf6; color: white; padding: 12px; font-size: 14px; text-align: right;">Total (NRS)</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>

            <table style="width: 100%; margin-top: 20px; border-collapse: collapse;">
                <tr>
                    <td style="width: 45%; vertical-align: top; padding-right: 20px;">
                        ${bill.billNotes && bill.billNotes.length > 0 ? `
                        <div style="padding: 12px; background: #f8fafc; border-left: 4px solid #8b5cf6; border-radius: 4px; margin-bottom:15px;">
                            <p style="margin: 0 0 8px 0; font-size: 12px; font-weight: bold; color: #8892b0;">REMARKS / NOTES:</p>
                            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                                ${bill.billNotes.map(n => `
                                    <tr>
                                        <td style="padding: 4px 0; width: 85px; color: #4a5280; font-family: 'Space Mono', monospace; vertical-align: top;">${n.date}</td>
                                        <td style="padding: 4px 0; color: #1a1f36; vertical-align: top;">${n.text}</td>
                                    </tr>
                                `).join('')}
                            </table>
                        </div>
                        ` : ''}
                    </td>
                    <td style="width: 55%; padding: 0;">
                        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                            <tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">Items Subtotal:</td><td style="text-align: right; padding: 10px 0; border-bottom: 1px solid #e2e8f0;">NRS ${parseInt(document.getElementById('items-total').innerText.replace(/,/g,'') || 0).toLocaleString('en-IN')}</td></tr>
                            <tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">Transport (+):</td><td style="text-align: right; padding: 10px 0; border-bottom: 1px solid #e2e8f0;">NRS ${parseInt(bill.transport || 0).toLocaleString('en-IN')}</td></tr>
                            
                            ${bill.discount && bill.discount !== '0' ? `<tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #dc2626;">Discount (-):</td><td style="text-align: right; padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #dc2626;">NRS ${parseInt(bill.discount).toLocaleString('en-IN')}</td></tr>` : ''}

                            <tr style="background: #f8fafc; font-weight: bold;"><td style="padding: 10px;">Today's Bill:</td><td style="text-align: right; padding: 10px;">NRS ${parseInt(bill.billAmount || 0).toLocaleString('en-IN')}</td></tr>
                            <tr><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">Purano Baki (+):</td><td style="text-align: right; padding: 10px 0; border-bottom: 1px solid #e2e8f0;">NRS ${parseInt(bill.prevBalance || 0).toLocaleString('en-IN')}</td></tr>
                            
                            ${bill.totalPoka && bill.totalPoka !== '0' ? `<tr style="font-size: 15px;"><td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-weight:bold;">📦 Total Poka:</td><td style="text-align: right; padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-weight:bold; color: #dc2626;">${bill.totalPoka}</td></tr>` : ''}

                            <tr style="background: #f5f3ff; color: #8b5cf6; font-weight: bold;"><td style="padding: 10px;">Jamma Total:</td><td style="text-align: right; padding: 10px;">NRS ${parseInt(bill.grandTotal || 0).toLocaleString('en-IN')}</td></tr>
                            
                            <tr style="color: #059669;">
                                <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; vertical-align: top;">Nagad Paid (-):${cashDateStr}</td>
                                <td style="text-align: right; padding: 10px 0; border-bottom: 1px solid #e2e8f0; vertical-align: top;">NRS ${parseInt(bill.paid || 0).toLocaleString('en-IN')}</td>
                            </tr>

                            <tr style="background: #fee2e2; color: #dc2626; font-size: 18px; font-weight: bold;"><td style="padding: 12px 10px;">Remaining Baki:</td><td style="text-align: right; padding: 12px 10px;">NRS ${parseInt(bill.remaining || 0).toLocaleString('en-IN')}</td></tr>
                        </table>
                    </td>
                </tr>
            </table>
            
            <div style="margin-top:50px; display:flex; justify-content:space-between; font-size:12px; color:#8892b0; align-items:flex-end;">
                <div style="text-align:center; border-top:1px solid #c7d2fe; padding-top:6px; width:200px;">Customer Signature</div>
                
                <div style="width:350px; display:flex; flex-direction:column; align-items:center; position:relative;">
                    <img id="bill-sig-img" src="" style="width:350px; height:120px; object-fit:contain; display:none; margin-bottom:4px;" />
                    <button id="sign-btn" onclick="openSignaturePad()" style="width:100%; padding:30px 0; border:2px dashed #cbd5e1; background:#f8fafc; border-radius:8px; cursor:pointer; margin-bottom:4px; color:#4a5280; font-weight:bold; font-size:15px; font-family:inherit;">✏️ Tap to Sign (Large)</button>
                    <div style="text-align:center; border-top:1px solid #c7d2fe; padding-top:6px; width:100%;">Authorized Signature & Stamp</div>
                </div>
            </div>
        </div>
    </div>
    `;

    document.getElementById('preview-body').innerHTML = htmlString;
    document.getElementById('preview-modal').classList.add('open');
}

let isDrawing = false;
let sigCtx = null;
let canvasListenersAdded = false;

function openSignaturePad() {
    document.getElementById('sig-pad-modal').classList.add('open');
    setTimeout(() => {
        const canvas = document.getElementById('large-sig-canvas');
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
        initSignaturePadCanvas(canvas);
    }, 150);
}

function initSignaturePadCanvas(canvas) {
    if(!canvas) return;
    sigCtx = canvas.getContext('2d');
    sigCtx.lineWidth = 4;
    sigCtx.lineCap = 'round';
    sigCtx.lineJoin = 'round';
    sigCtx.strokeStyle = '#1a1f36';
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
    const dataUrl = canvas.toDataURL('image/png');
    const img = document.getElementById('bill-sig-img');
    const btn = document.getElementById('sign-btn');
    img.src = dataUrl;
    img.style.display = 'block';
    btn.style.display = 'none';
    closeModal('sig-pad-modal');
}

window.clearLargeSignature = function() {
    const canvas = document.getElementById('large-sig-canvas');
    if(canvas && sigCtx) sigCtx.clearRect(0, 0, canvas.width, canvas.height);
}

window.clearSignature = function() {
    const img = document.getElementById('bill-sig-img');
    const btn = document.getElementById('sign-btn');
    if(img && btn) {
        img.src = '';
        img.style.display = 'none';
        btn.style.display = 'block';
    }
    clearLargeSignature();
}

function confirmAndDownload() {
    if(!pendingBill) return;

    const btn = document.getElementById('confirm-btn-text');
    const oldText = btn.innerHTML;
    btn.innerHTML = '⏳ Processing...';

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

    const originalElement = document.getElementById('actual-bill-to-render');
    const clone = originalElement.cloneNode(true);
    const signBtnNode = clone.querySelector('#sign-btn');
    if(signBtnNode) signBtnNode.style.display = 'none';
    
    document.body.appendChild(clone);
    clone.style.position = 'absolute';
    clone.style.top = '-9999px';
    clone.style.left = '0';
    clone.style.width = '800px'; 
    clone.style.maxWidth = 'none';
    clone.style.margin = '0'; 

    html2canvas(clone, { 
        scale: 4, 
        useCORS: true,
        backgroundColor: '#ffffff'
    }).then(function (canvas) {
        document.body.removeChild(clone);

        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `Invoice-${pendingBill.invoiceNum}.png`;
        link.href = dataUrl;
        link.click();

        btn.innerHTML = oldText;
        closeModal('preview-modal');
        
        ['customer-name','customer-phone','customer-address','total-poka','transport-expense','discount-amount','prev-balance','cash-paid','db-search', 'slip-customer'].forEach(id=>{
            let el = document.getElementById(id);
            if(el) el.value='';
        });
        
        document.getElementById('current-date-ad').value = todayStr;
        updateBSDate();
        document.getElementById('cash-paid-date').value = todayStr;
        document.getElementById('slip-date').value = todayStr;
        document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
        
        document.getElementById('invoice-items').innerHTML='';addRow();calc();
        document.getElementById('notes-container').innerHTML = '';
        document.getElementById('poka-groups-container').innerHTML = '';
        pokaCounter = 0;
        addNoteRow();
        
        editBillKey = null;
        editInvoiceNum = null;
        document.getElementById('tab-invoice').innerHTML = `🧾 <span class="L" data-k="New Invoice">New Invoice</span>`;
        document.getElementById('invoice-number').innerText = cloudNextInvoice;
        
        pendingBill = null;
    }).catch(function (error) {
        if(document.body.contains(clone)) document.body.removeChild(clone);
        btn.innerHTML = oldText;
        alert("Error generating image. " + (error.message || "Unknown Error"));
    });
}

// ============================================================
// MODALS AND LEDGER VIEWS
// ============================================================

function showPriceBook(custName) {
    document.getElementById('pb-title').innerText = `📕 ${custName} Rates`;
    const list = document.getElementById('price-book-list');
    list.innerHTML = '';
    const historyMap = {};
    for(let i=allBills.length-1; i>=0; i--) { 
        if(allBills[i].customer === custName && allBills[i].items) {
            allBills[i].items.forEach(it => {
                const desc = it.desc.trim();
                if(desc && desc !== 'Item') historyMap[desc] = it.rate;
            });
        }
    }
    const items = Object.entries(historyMap).sort((a,b) => a[0].localeCompare(b[0]));
    if(items.length === 0) {
        list.innerHTML = `<tr><td colspan="2" style="text-align:center; padding:20px; color:var(--text3);">No item history found.</td></tr>`;
    } else {
        items.forEach(([desc, rate]) => {
            list.innerHTML += `<tr style="border-bottom:1px solid var(--border);"><td style="padding:10px 18px; font-weight:500;">${desc}</td><td style="text-align:right; padding:10px 18px; font-family:'Space Mono',monospace; font-weight:700; color:var(--green);">NRS ${rate}</td></tr>`;
        });
    }
    document.getElementById('price-book-modal').classList.add('open');
}

function showLedgerStatement(custName) {
    document.getElementById('ls-cust-name').innerText = custName;
    const cu = cloudCustomers[custName] || {};
    let subInfo = [];
    if(cu.address) subInfo.push(cu.address);
    if(cu.phone) subInfo.push(cu.phone);
    document.getElementById('ls-cust-sub').innerText = subInfo.join(' • ');
    
    const list = document.getElementById('ledger-statement-list');
    list.innerHTML = '';
    
    let events = [];
    let totalBilled = 0;
    let totalPaid = 0;

    allBills.filter(b => b.customer === custName).forEach(b => {
        let billTotal = parseInt(b.billAmount) || 0;
        totalBilled += billTotal;

        if(b.payments) {
            Object.values(b.payments).forEach(p => {
                let amt = parseInt(p.amount) || 0;
                totalPaid += amt;
                events.push({ date: p.date, time: new Date(p.date).getTime() + 1000, desc: `Pay against Inv #${b.invoiceNum}`, debit: 0, credit: amt });
            });
        }
        
        let initialPaid = parseInt(b.paid) || 0;
        if(initialPaid > 0) {
            totalPaid += initialPaid;
            events.push({ date: b.cashPaidDate || b.date, time: new Date(b.cashPaidDate || b.date).getTime() + 500, desc: `Initial Pay Inv #${b.invoiceNum}`, debit: 0, credit: initialPaid });
        }

        events.push({ date: b.date, time: new Date(b.date).getTime(), desc: `Invoice #${b.invoiceNum}`, debit: billTotal, credit: 0, declaredPrev: parseInt(b.prevBalance) || 0, isInvoice: true });
    });
    
    events.sort((a,b) => a.time - b.time);
    let listHtml = '';
    const firstInvoice = events.find(e => e.isInvoice);
    let bal = firstInvoice ? firstInvoice.declaredPrev : 0;
    
    totalBilled += bal;

    listHtml += `<tr style="border-bottom:1px solid #e2e8f0; background:#f8fafc;"><td style="padding:12px;">—</td><td style="padding:12px; font-style:italic;">Opening Balance</td><td></td><td></td><td style="text-align:right; font-weight:bold;">${bal.toLocaleString('en-IN')}</td></tr>`;
    events.forEach(e => {
        bal += e.debit; bal -= e.credit;
        listHtml += `<tr style="border-bottom:1px solid #e2e8f0;">
            <td style="padding:12px; font-size:12px;">${e.date}</td>
            <td style="padding:12px; font-size:13px;">${e.desc}</td>
            <td style="text-align:right; padding:12px; font-size:13px;">${e.debit > 0 ? e.debit.toLocaleString('en-IN') : ''}</td>
            <td style="text-align:right; padding:12px; color:#059669; font-size:13px;">${e.credit > 0 ? e.credit.toLocaleString('en-IN') : ''}</td>
            <td style="text-align:right; font-weight:bold; font-size:13px;">${bal.toLocaleString('en-IN')}</td>
        </tr>`;
    });
    list.innerHTML = listHtml;

    const summaryDiv = document.getElementById('ls-summary-box') || document.createElement('div');
    summaryDiv.id = 'ls-summary-box';
    summaryDiv.style = "display:flex; justify-content:space-between; background:#f1f5f9; padding:15px; border-radius:8px; margin-bottom:20px; border:1px solid #cbd5e1;";
    summaryDiv.innerHTML = `
        <div style="text-align:center;"><div style="font-size:11px; color:#64748b; font-weight:bold;">TOTAL BILLED</div><div style="font-size:15px; font-weight:bold; color:#1e293b;">NRS ${totalBilled.toLocaleString('en-IN')}</div></div>
        <div style="text-align:center;"><div style="font-size:11px; color:#64748b; font-weight:bold;">TOTAL PAID</div><div style="font-size:15px; font-weight:bold; color:#059669;">NRS ${totalPaid.toLocaleString('en-IN')}</div></div>
        <div style="text-align:center;"><div style="font-size:11px; color:#64748b; font-weight:bold;">CURRENT DUE</div><div style="font-size:16px; font-weight:900; color:#dc2626;">NRS ${bal.toLocaleString('en-IN')}</div></div>
    `;
    
    const renderBox = document.getElementById('ledger-statement-render');
    const existingSummary = renderBox.querySelector('#ls-summary-box');
    if(existingSummary) existingSummary.remove();
    renderBox.insertBefore(summaryDiv, renderBox.querySelector('table'));

    document.getElementById('ledger-statement-modal').classList.add('open');
}

function shareStatementWA() {
    const custName = document.getElementById('ls-cust-name').innerText;
    const cu = cloudCustomers[custName];
    if(!cu || !cu.phone) {
        alert("No phone number found for this customer.");
        return;
    }
    const baki = parseInt(cu.balance || 0);
    const msg = `🏪 *Rabi Kapada Pasal*\n\nNamaste *${custName}*,\n\nHere is your updated account summary:\n🔴 *Total Remaining Due: NRS ${baki.toLocaleString('en-IN')}*\n\n*(Please find your detailed ledger statement image attached separately)*.\n\nThank you for your business!`;
    window.open('https://wa.me/'+cu.phone.replace(/\D/g,'')+'?text='+encodeURIComponent(msg),'_blank');
}

function downloadLedgerStatement() {
    const btn = document.getElementById('ls-download-btn');
    const oldText = btn.innerHTML;
    btn.innerHTML = '⏳ Processing...';
    const originalElement = document.getElementById('ledger-statement-render');
    const clone = originalElement.cloneNode(true);
    document.body.appendChild(clone);
    clone.style.position = 'absolute';
    clone.style.top = '-9999px';
    clone.style.left = '0';
    clone.style.width = '800px';

    html2canvas(clone, { scale: 4, useCORS: true, backgroundColor: '#ffffff' }).then(function (canvas) {
        document.body.removeChild(clone);
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `Statement-${document.getElementById('ls-cust-name').innerText}.png`;
        link.href = dataUrl;
        link.click();
        btn.innerHTML = oldText;
    }).catch(function (err) {
        if(document.body.contains(clone)) document.body.removeChild(clone);
        btn.innerHTML = oldText;
        alert("Error generating image.");
    });
}

function showBillDetail(key){
  const b=allBills.find(x=>x.key===key);if(!b) return;
  document.getElementById('modal-title').innerText=`Invoice #${b.invoiceNum} — ${b.customer}`;
  
  let iHtml='';
  if(b.items&&b.items.length){
    iHtml=`<div style="margin:12px 0;border:1px solid var(--border);border-radius:10px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:.79rem;"><thead><tr style="background:var(--surface2);"><th style="padding:7px 10px;text-align:left;color:var(--text2)">Item</th><th style="padding:7px 10px;text-align:center;color:var(--text2)">Code</th><th style="padding:7px 10px;text-align:right;color:var(--text2)">Qty</th><th style="padding:7px 10px;text-align:right;color:var(--text2)">Rate</th><th style="padding:7px 10px;text-align:right;color:var(--text2)">Total</th></tr></thead><tbody>`;
    b.items.forEach(it=>{iHtml+=`<tr style="border-top:1px solid var(--border)"><td style="padding:6px 10px">${it.desc}</td><td style="padding:6px 10px;text-align:center;font-family:'Space Mono',monospace;font-size:.73rem;color:var(--text3)">${it.code||'—'}</td><td style="padding:6px 10px;text-align:right">${it.qty}</td><td style="padding:6px 10px;text-align:right">${it.rate||''}</td><td style="padding:6px 10px;text-align:right;font-family:'Space Mono',monospace;font-weight:700">${parseInt(it.amount||0).toLocaleString('en-IN')}</td></tr>`;});
    iHtml+='</tbody></table></div>';
  }

  const baki=parseInt(b.remaining)||0;
  
  document.getElementById('modal-body').innerHTML=`
    <div class="d-row"><span class="d-label">Date (AD/BS)</span><span class="d-val">${b.date} / ${b.dateBS||''}</span></div>
    ${iHtml}
    ${b.discount && b.discount !== '0' ? `<div class="d-row"><span class="d-label">Discount</span><span class="d-val" style="color:var(--red)">- NRS ${parseInt(b.discount).toLocaleString('en-IN')}</span></div>` : ''}
    <div class="d-row"><span class="d-label">Bill Amount</span><span class="d-val">NRS ${parseInt(b.billAmount).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label">Purano Baki</span><span class="d-val">NRS ${parseInt(b.prevBalance || 0).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label">Jamma Total</span><span class="d-val">NRS ${parseInt(b.grandTotal || 0).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label">Paid</span><span class="d-val" style="color:green">NRS ${parseInt(b.paid).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label" style="color:red">Remaining</span><span class="d-val" style="color:red">NRS ${baki.toLocaleString('en-IN')}</span></div>
    
    <div style="display:flex; gap:8px; margin-top:16px;">
        <button class="btn btn-ghost" style="flex:1; justify-content:center; border-color:var(--accent); color:var(--accent);" onclick="loadBillForEdit('${key}')">✏️ Edit Bill</button>
        ${baki>0?`<button class="btn btn-green" style="flex:1; justify-content:center;" onclick="openPayModal('${key}','${(b.customer||'').replace(/'/g,'')}',${baki})">💰 Pay</button>`:''}
    </div>
  `;
  document.getElementById('bill-modal').classList.add('open');
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
    notesContainer.innerHTML = '';
    if (bill.billNotes && bill.billNotes.length > 0) {
        bill.billNotes.forEach(n => addNoteRow(n.date, n.text));
    } else {
        addNoteRow();
    }

    const pokaContainer = document.getElementById('poka-groups-container');
    pokaContainer.innerHTML = '';
    pokaCounter = 0;
    if (bill.pokaDetails && bill.pokaDetails.length > 0) {
        bill.pokaDetails.forEach(group => addPokaGroup(group.items));
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


function showCustDetail(name){
  const cu=cloudCustomers[name];if(!cu) return;
  const baki=parseInt(cu.balance)||0;
  document.getElementById('modal-title').innerText=`👤 ${name}`;
  document.getElementById('modal-body').innerHTML=`
    <div class="d-row"><span class="d-label">📞 Phone</span><span class="d-val">${cu.phone||'—'}</span></div>
    <div class="d-row"><span class="d-label">📍 Address</span><span class="d-val">${cu.address||'—'}</span></div>
    <div class="d-row" style="font-size:.92rem;font-weight:700"><span class="d-label" style="color:${baki>0?'var(--red)':'var(--green)'}">🔴 Total Baki</span><span class="d-val" style="color:${baki>0?'var(--red)':'var(--green)'}">NRS ${baki.toLocaleString('en-IN')}</span></div>
    
    <button class="btn btn-ghost" style="width:100%; justify-content:center; margin-top:10px; border-color:var(--accent); color:var(--accent);" onclick="showLedgerStatement('${name.replace(/'/g, "\\'")}')">📜 View Statement of Account</button>
    ${baki>0?`<button class="btn btn-green" style="width:100%;justify-content:center;margin-top:8px;" onclick="payFromLedger('${name.replace(/'/g,'')}',${baki})">💰 Record Payment</button>`:''}
  `;
  document.getElementById('bill-modal').classList.add('open');
}

function editCustomer(oldName) {
    const cu = cloudCustomers[oldName];
    if(!cu) return;
    document.getElementById('edit-cust-oldname').value = oldName;
    document.getElementById('edit-cust-name').value = oldName;
    document.getElementById('edit-cust-phone').value = cu.phone || '';
    document.getElementById('edit-cust-address').value = cu.address || '';
    document.getElementById('edit-cust-baki').value = cu.balance || '0';
    document.getElementById('edit-cust-modal').classList.add('open');
}

function saveEditedCustomer() {
    const oldName = document.getElementById('edit-cust-oldname').value;
    let newName = document.getElementById('edit-cust-name').value.trim();
    newName = newName.replace(/[.#$\[\]]/g, ' ').trim(); 
    
    const phone = document.getElementById('edit-cust-phone').value.trim();
    const address = document.getElementById('edit-cust-address').value.trim();
    const balance = document.getElementById('edit-cust-baki').value || "0";

    if(!newName) { alert("Name cannot be empty."); return; }

    queueDatabaseWrite('nwh/customers/' + newName, 'set', { phone, address, balance });
    if(newName !== oldName) {
        queueDatabaseWrite('nwh/customers/' + oldName, 'remove', null);
    }
    closeModal('edit-cust-modal');
}

function deleteCustomer(name) {
    if(confirm(`⚠️ Are you sure you want to delete the customer "${name}" from the ledger? This cannot be undone.`)) {
        queueDatabaseWrite('nwh/customers/' + name, 'remove', null);
    }
}

let _payKey='',_payCust='';
function openPayModal(key,cust,baki){
  _payKey=key;_payCust=cust;
  document.getElementById('pay-modal-title').innerText=`💰 Payment — ${cust}`;
  document.getElementById('pay-baki-display').innerText=`NRS ${baki.toLocaleString('en-IN')}`;
  document.getElementById('pay-amount-inp').value='';document.getElementById('pay-note-inp').value='';
  document.getElementById('pay-date-inp').value = todayStr;
  closeModal('bill-modal');
  document.getElementById('pay-modal').classList.add('open');
}

function payFromLedger(name,baki){
  const bill=allBills.find(b=>b.customer===name&&(parseInt(b.remaining)||0)>0);
  if(bill){closeModal('bill-modal');openPayModal(bill.key,name,baki);}
  else alert('No outstanding bills found.');
}

function confirmPayment(){
  const amount=parseFloat(document.getElementById('pay-amount-inp').value)||0;
  const note=document.getElementById('pay-note-inp').value.trim();
  const payDate = document.getElementById('pay-date-inp').value || todayStr; 
  
  if(amount<=0){alert('Enter a valid amount');return;}
  const bill=allBills.find(b=>b.key===_payKey);if(!bill) return;
  
  const newRem=Math.max(0,(parseInt(bill.remaining)||0)-amount);
  const newPaid=(parseInt(bill.paid)||0)+amount;
  const entry={amount, date: payDate, note}; 
  
  const currentCustBal = parseInt(cloudCustomers[_payCust]?.balance) || 0;
  const newCustBal = Math.max(0, currentCustBal - amount);
  
  queueDatabaseWrite('nwh/bills/'+_payKey+'/remaining', 'set', newRem.toString());
  queueDatabaseWrite('nwh/bills/'+_payKey+'/paid', 'set', newPaid.toString());
  queueDatabaseWrite('nwh/bills/'+_payKey+'/payments', 'push', entry);
  if(cloudCustomers[_payCust]) queueDatabaseWrite('nwh/customers/'+_payCust+'/balance', 'set', newCustBal.toString());
  
  closeModal('pay-modal');
  
  document.getElementById('rec-date').innerText = payDate;
  document.getElementById('rec-cust').innerText = _payCust;
  document.getElementById('rec-amt').innerText = amount.toLocaleString('en-IN');
  document.getElementById('rec-baki').innerText = newCustBal.toLocaleString('en-IN');
  document.getElementById('rec-note').innerText = note || '—';
  
  document.getElementById('receipt-modal').classList.add('open');
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
    html2canvas(targetElement, { scale: 4, useCORS: true, backgroundColor: '#ffffff' }).then(function (canvas) {
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `Receipt-${_payCust}.png`;
        link.href = dataUrl;
        link.click();
    }).catch(function (err) {
        console.error(err);
        alert('Error generating receipt image.');
    });
}

function closeModal(id){document.getElementById(id).classList.remove('open');}

function renderHistory(){
  const c=document.getElementById('history-container');
  if(!allBills || !allBills.length) return c.innerHTML=`<div class="empty-state">No bills yet</div>`;

  const q = document.getElementById('history-search').value.toLowerCase();
  let filtered = q ? allBills.filter(b => b.customer.toLowerCase().includes(q) || b.invoiceNum.toString().includes(q)) : allBills;
  if(!filtered.length) return c.innerHTML=`<div class="empty-state">No matching bills.</div>`;

  let html=`<table class="h-table"><thead><tr><th>#</th><th>Customer</th><th>Bill</th><th>Paid</th><th>Baki</th></tr></thead><tbody>`;
  filtered.forEach(b=>{
    const baki=parseInt(b.remaining)||0;
    html+=`<tr onclick="showBillDetail('${b.key}')"><td><span style="font-weight:700;color:var(--accent)">#${b.invoiceNum}</span><br><span style="font-size:10px">${b.date}</span></td><td><strong>${b.customer}</strong></td><td>NRS ${parseInt(b.billAmount || 0).toLocaleString('en-IN')}</td><td style="color:var(--green)">${parseInt(b.paid || 0).toLocaleString('en-IN')}</td><td><span class="badge ${baki>0?'b-red':'b-green'}">${baki.toLocaleString('en-IN')}</span></td></tr>`;
  });
  html += `</tbody></table>`;
  
  if(allBills.length >= dbBillsLimit) html += `<button class="btn btn-ghost" style="width:100%; margin-top:10px;" onclick="loadMoreBills()">Load More Server Data</button>`;
  c.innerHTML = html;
}
const debouncedFilterHistory = debounce(() => renderHistory());

let ledgerLimit = 30;
function renderLedger(resetLimit = false){
  if(resetLimit) ledgerLimit = 30;
  const c = document.getElementById('ledger-container');
  const custs = Object.entries(cloudCustomers);
  if(!custs.length) return c.innerHTML=`<div class="empty-state">No customers yet</div>`;

  const q = document.getElementById('ledger-search').value.toLowerCase();
  const sortMode = document.getElementById('ledger-sort').value;

  let filtered = q ? custs.filter(([n, cu]) => n.toLowerCase().includes(q) || (cu.phone && cu.phone.includes(q))) : custs;
  
  if(sortMode === 'dues') {
      filtered.sort((a,b) => (parseInt(b[1].balance)||0) - (parseInt(a[1].balance)||0));
  } else if (sortMode === 'recent') {
      const lastActive = {};
      allBills.forEach(b => {
         const t = new Date(b.date).getTime();
         if(!lastActive[b.customer] || t > lastActive[b.customer]) lastActive[b.customer] = t;
      });
      filtered.sort((a,b) => (lastActive[b[0]]||0) - (lastActive[a[0]]||0));
  } else {
      filtered.sort((a,b) => a[0].localeCompare(b[0]));
  }

  if(!filtered.length) return c.innerHTML=`<div class="empty-state">No matching customers.</div>`;

  let html = '';
  filtered.slice(0, ledgerLimit).forEach(([name,cu])=>{
    const baki = parseInt(cu.balance)||0;
    const safeName = name.replace(/'/g, "\\'"); 
    const phoneClean = cu.phone ? cu.phone.replace(/\D/g,'') : '';
    
    html += `<div class="ledger-card" onclick="showCustDetail('${safeName}')">
        <div style="flex:1;">
            <div class="lc-name">${name}</div>
            <div class="lc-phone" style="margin-bottom:8px;">${cu.phone||'—'}</div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
                <button class="btn btn-ghost" style="padding:4px 10px; font-size:0.7rem; border-color:#cbd5e1; color:#4a5280;" onclick="event.stopPropagation(); editCustomer('${safeName}')">✏️ Edit</button>
                <button class="btn btn-ghost" style="padding:4px 10px; font-size:0.7rem; border-color:#cbd5e1; color:var(--accent);" onclick="event.stopPropagation(); showPriceBook('${safeName}')">📕 Price</button>
                ${phoneClean ? `<button class="btn btn-ghost" style="padding:4px 10px; font-size:0.7rem; border-color:#cbd5e1; color:#059669;" onclick="event.stopPropagation(); window.open('https://wa.me/${phoneClean}', '_blank')">💬 WA</button>
                <button class="btn btn-ghost" style="padding:4px 10px; font-size:0.7rem; border-color:#cbd5e1; color:#2563eb;" onclick="event.stopPropagation(); window.open('tel:${phoneClean}', '_self')">📞 Call</button>` : ''}
            </div>
        </div>
        <div style="text-align:right">
            <div class="lc-baki ${baki>0?'due':'ok'}">NRS ${baki.toLocaleString('en-IN')}</div>
            <span class="badge ${baki>0?'b-red':'b-green'}">${baki>0?'Due':'Cleared'}</span>
        </div>
    </div>`;
  });
  
  if(filtered.length > ledgerLimit) html += `<button class="btn btn-ghost" style="width:100%; margin-top:10px;" onclick="ledgerLimit += 30; renderLedger();">Load More</button>`;
  c.innerHTML = html;
}
const debouncedFilterLedger = debounce(() => renderLedger(true));

// SERVICE WORKER REGISTRATION
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function(registrations) {
      for(let registration of registrations) { registration.unregister(); }
  });
}
