// ============================================================
// RABI KAPADA PASAL - CLOUD BILLING ENGINE (v43.2 VERIFIED)
// ============================================================

function safeGetLocal(k) { try { return localStorage.getItem(k); } catch(e) { return null; } }
function safeSetLocal(k, v) { try { localStorage.setItem(k, v); } catch(e) {} }

function escapeJsStr(str) {
    return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function escapeHtmlAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// SERIALIZED INDEXEDDB OUTBOX
// ============================================================
const IDB_NAME = 'RabiKapadaDB_v43';
const IDB_STORE = 'outbox';
let idbInstance = null;
let idbWriteChain = Promise.resolve();

function openOutboxDB() {
    return new Promise((resolve) => {
        if (idbInstance) return resolve(idbInstance);
        if (!('indexedDB' in window)) return resolve(null);
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(IDB_STORE)) {
                database.createObjectStore(IDB_STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = (e) => { idbInstance = e.target.result; resolve(idbInstance); };
        req.onerror = () => resolve(null);
    });
}

function saveOutboxToIDB(queueArr) {
    const snapshot = queueArr.map(item => ({ ...item }));
    safeSetLocal('nwh_sync_queue', JSON.stringify(snapshot));

    idbWriteChain = idbWriteChain.then(async () => {
        const database = await openOutboxDB();
        if (!database) return;
        return new Promise((resolve) => {
            try {
                const tx = database.transaction(IDB_STORE, 'readwrite');
                const store = tx.objectStore(IDB_STORE);
                store.clear();
                snapshot.forEach(item => store.put(item));
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch (e) {
                resolve();
            }
        });
    });
    return idbWriteChain;
}

async function loadOutboxFromIDB() {
    const database = await openOutboxDB();
    if (!database) {
        return JSON.parse(safeGetLocal('nwh_sync_queue') || '[]');
    }
    return new Promise((resolve) => {
        try {
            const tx = database.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const req = store.getAll();
            req.onsuccess = () => {
                const res = req.result || [];
                if (res.length > 0) resolve(res.sort((a, b) => a.id - b.id));
                else resolve(JSON.parse(safeGetLocal('nwh_sync_queue') || '[]'));
            };
            req.onerror = () => resolve(JSON.parse(safeGetLocal('nwh_sync_queue') || '[]'));
        } catch (e) {
            resolve(JSON.parse(safeGetLocal('nwh_sync_queue') || '[]'));
        }
    });
}

// ============================================================
// OFFLINE FIREBASE PUSH KEY GENERATOR
// ============================================================
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
let lastRandChars = [];

function generateOfflinePushKey(refPath) {
    if (db && typeof db.ref === 'function') {
        try {
            const sdkKey = db.ref(refPath || 'nwh/bills').push().key;
            if (sdkKey) return sdkKey;
        } catch (e) {}
    }
    let now = Date.now();
    const duplicateTime = (now === lastPushTime);
    lastPushTime = now;
    const timeStampChars = new Array(8);
    for (let i = 7; i >= 0; i--) {
        timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
        now = Math.floor(now / 64);
    }
    let id = timeStampChars.join('');
    if (!duplicateTime) {
        for (let i = 0; i < 12; i++) lastRandChars[i] = Math.floor(Math.random() * 64);
    } else {
        let i = 11;
        for (; i >= 0 && lastRandChars[i] === 63; i--) lastRandChars[i] = 0;
        lastRandChars[i]++;
    }
    for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRandChars[i]);
    return id;
}

// ============================================================
// GLOBAL STATE
// ============================================================
let editBillKey = null;
let editInvoiceNum = null;
let editOriginalCustomer = null;
let pendingBill = null;
let lang = 'en';
let allPokas = [];
let inventoryList = [];
let cloudCustomers = {};
let cloudNextInvoice = parseInt(safeGetLocal('nwh_next_inv') || '1001', 10);
let allBills = [];
let db = null;
let fbReady = false;
let isUnlocked = false;
let _payKey = '', _payCust = '';

// ============================================================
// PIN LOCK LOGIC (UNLOCKS IMMEDIATELY ON 8860)
// ============================================================
let pinCode = '';
const CORRECT_PIN = '8860';

function unlockAppSession() {
    isUnlocked = true;
    const pw = document.getElementById('pw-screen');
    if (pw) pw.style.display = 'none';
    resetPinState();
    startFirebase();
}

function pinPress(num) {
  if (pinCode.length < 4) {
    pinCode += num;
    const dot = document.getElementById('d' + (pinCode.length - 1));
    if (dot) dot.classList.add('filled');
  }

  if (pinCode.length === 4) {
    if (pinCode === CORRECT_PIN) {
      try { sessionStorage.setItem('rkp_unlocked', '1'); } catch (e) {}
      unlockAppSession();
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
// DEBOUNCE & NON-BLOCKING SYNC QUEUE
// ============================================================
function debounce(func, delay = 300) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), delay);
  };
}

let isSyncing = false;
let syncQueue = JSON.parse(safeGetLocal('nwh_sync_queue') || '[]');
let queueSeq = 0;

function updateSyncBadge() {
    const syncEl = document.getElementById('sync-status');
    if (!syncEl) return;
    if (!isUnlocked) {
        syncEl.innerHTML = '🔒 Locked';
        syncEl.className = 'sync-badge';
        return;
    }
    if (!fbReady) {
        syncEl.innerHTML = syncQueue.length > 0 ? `🟡 Offline (${syncQueue.length} pending)` : '🟡 Offline';
        syncEl.className = 'sync-badge';
    } else if (isSyncing || syncQueue.length > 0) {
        syncEl.innerHTML = `🔄 Syncing (${syncQueue.length} left)...`;
        syncEl.className = 'sync-badge';
    } else {
        syncEl.innerHTML = '🟢 Synced ↻';
        syncEl.className = 'sync-badge synced';
    }
}

function queueDatabaseWrite(path, method, data) {
    queueSeq = (queueSeq + 1) % 10000;
    const uniqueId = Date.now() * 10000 + queueSeq;
    syncQueue.push({ id: uniqueId, path, method, data });
    saveOutboxToIDB(syncQueue);
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
        await saveOutboxToIDB(syncQueue);
        isSyncing = false;
        processSyncQueue();
    } catch(err) {
        console.error("Sync error:", err);
        const msg = String(err && (err.code || err.message || err)).toUpperCase();
        if (msg.includes('PERMISSION_DENIED')) {
            const failed = JSON.parse(safeGetLocal('nwh_failed_writes') || '[]');
            failed.push({ ...item, error: msg, failedAt: Date.now() });
            safeSetLocal('nwh_failed_writes', JSON.stringify(failed.slice(-25)));
            syncQueue.shift();
            await saveOutboxToIDB(syncQueue);
            isSyncing = false;
            processSyncQueue();
        } else {
            isSyncing = false;
            updateSyncBadge();
        }
    }
}

// ============================================================
// DETERMINISTIC CUSTOMER LEDGER & FIFO RECONCILIATION
// ============================================================
function getCustomerBillsChronological(custName) {
    if (!custName || !Array.isArray(allBills)) return [];
    return allBills
        .filter(b => b && typeof b === 'object' && b.customer === custName)
        .slice()
        .sort((a, b) => {
            const dateCmp = String(a.date || '').localeCompare(String(b.date || ''));
            if (dateCmp !== 0) return dateCmp;
            return (parseInt(a.invoiceNum, 10) || 0) - (parseInt(b.invoiceNum, 10) || 0);
        });
}

function getCustomerOpeningBalance(custName, custBills) {
    const cu = cloudCustomers[custName] || {};
    if (cu.openingBalance !== undefined && cu.openingBalance !== '' && !isNaN(parseFloat(cu.openingBalance))) {
        return Math.round(parseFloat(cu.openingBalance));
    }
    if (custBills && custBills.length > 0) {
        return Math.round(parseFloat(custBills[0].prevBalance) || 0);
    }
    return Math.round(parseFloat(cu.balance) || 0);
}

function getCustomerTrueBalance(custName) {
    if (!custName) return 0;
    const custBills = getCustomerBillsChronological(custName);

    if (custBills.length > 0) {
        const latestBill = custBills[custBills.length - 1];
        if (latestBill && latestBill.remaining !== undefined && latestBill.remaining !== '') {
            const rem = parseFloat(latestBill.remaining);
            if (!isNaN(rem)) return Math.round(rem);
        }
    }

    if (cloudCustomers && cloudCustomers[custName] && cloudCustomers[custName].balance !== undefined && cloudCustomers[custName].balance !== '') {
        const bal = parseFloat(cloudCustomers[custName].balance);
        if (!isNaN(bal)) return Math.round(bal);
    }

    return 0;
}

function backfillLegacyOpeningBalances() {
    const grouped = {};
    allBills.forEach(b => {
        if (!b || !b.customer) return;
        if (!grouped[b.customer]) grouped[b.customer] = [];
        grouped[b.customer].push(b);
    });

    Object.entries(grouped).forEach(([custName, bills]) => {
        if (!cloudCustomers[custName]) cloudCustomers[custName] = {};
        if (cloudCustomers[custName].openingBalance === undefined) {
            bills.sort((a, b) => {
                const d = String(a.date || '').localeCompare(String(b.date || ''));
                return d !== 0 ? d : ((parseInt(a.invoiceNum, 10) || 0) - (parseInt(b.invoiceNum, 10) || 0));
            });
            cloudCustomers[custName].openingBalance = String(Math.round(parseFloat(bills[0].prevBalance) || 0));
        }
    });
}

function recalculateCustomerLedger(custName) {
    if (!custName) return 0;
    const custBills = getCustomerBillsChronological(custName);
    const cu = cloudCustomers[custName] || {};

    if (custBills.length === 0) {
        const fallback = cu.openingBalance !== undefined ? parseFloat(cu.openingBalance) : (parseFloat(cu.balance) || 0);
        const cleanBal = Math.round(fallback || 0);
        if (cloudCustomers[custName]) {
            cloudCustomers[custName].balance = cleanBal.toString();
            queueDatabaseWrite('nwh/customers/' + custName + '/balance', 'set', cleanBal.toString());
        }
        return cleanBal;
    }

    let runningBaki = getCustomerOpeningBalance(custName, custBills);
    if (cu.openingBalance === undefined) {
        if (!cloudCustomers[custName]) cloudCustomers[custName] = {};
        cloudCustomers[custName].openingBalance = runningBaki.toString();
        queueDatabaseWrite('nwh/customers/' + custName + '/openingBalance', 'set', runningBaki.toString());
    }

    custBills.forEach((b) => {
        b.prevBalance = Math.round(runningBaki).toString();
        const billAmt = parseFloat(b.billAmount) || 0;
        const paidAmt = parseFloat(b.paid) || 0;
        const grand = runningBaki + billAmt;
        runningBaki = grand - paidAmt;
        b.grandTotal = Math.round(grand).toString();
        b.remaining = Math.round(runningBaki).toString();

        if (b.key) {
            queueDatabaseWrite('nwh/bills/' + b.key, 'update', {
                prevBalance: b.prevBalance,
                grandTotal: b.grandTotal,
                remaining: b.remaining,
                paid: b.paid
            });
        }
    });

    const finalBal = Math.round(runningBaki);
    if (!cloudCustomers[custName]) cloudCustomers[custName] = {};
    cloudCustomers[custName].balance = finalBal.toString();
    queueDatabaseWrite('nwh/customers/' + custName + '/balance', 'set', finalBal.toString());
    return finalBal;
}

// ============================================================
// HISTORICAL LEDGER ADJUSTMENT / SETTLEMENT HELPER
// ============================================================
function openLedgerAdjustmentModal(custName) {
    const currentStmtBal = getCustomerTrueBalance(custName);
    const actualStr = prompt(
        `Current calculated balance for ${custName}: NRS ${currentStmtBal.toLocaleString('en-IN')}\n\n` +
        `Enter the ACTUAL true balance (e.g., 54440):`
    );
    if (actualStr === null) return;
    const targetBal = Math.round(parseFloat(actualStr.replace(/,/g, '')));
    if (isNaN(targetBal) || targetBal < 0) {
        alert("Please enter a valid number.");
        return;
    }

    const diff = currentStmtBal - targetBal;
    if (diff === 0) {
        alert("Balance already matches!");
        return;
    }

    const custBills = getCustomerBillsChronological(custName);
    if (custBills.length > 0 && diff > 0) {
        const oldestBill = custBills[0];
        applyPaymentToSingleBill(
            oldestBill,
            diff,
            oldestBill.date || todayStr,
            'Adjustment',
            'Historical Ledger Settlement / Pre-July Cleared'
        );
        recalculateCustomerLedger(custName);
    } else {
        if (!cloudCustomers[custName]) cloudCustomers[custName] = {};
        const currentOpen = getCustomerOpeningBalance(custName, custBills);
        const newOpen = Math.max(0, currentOpen - diff);
        cloudCustomers[custName].openingBalance = newOpen.toString();
        cloudCustomers[custName].balance = targetBal.toString();
        queueDatabaseWrite('nwh/customers/' + custName, 'set', cloudCustomers[custName]);
        recalculateCustomerLedger(custName);
    }

    closeModal('bill-modal');
    renderLedger();
    renderHistory();
    alert(`✅ Ledger reconciled! ${custName} balance is now NRS ${targetBal.toLocaleString('en-IN')}.`);
}

// ============================================================
// CUSTOMER AUTO-FILL & CATALOG NORMALIZATION
// ============================================================
function triggerCustomerAutoFill() {
    const nameEl = document.getElementById('customer-name');
    if(!nameEl) return;
    const rawName = nameEl.value.trim();
    if(!rawName) return;

    const searchName = rawName.toLowerCase();
    let matchedKey = null;
    let cu = null;

    for(let key in cloudCustomers) {
        if(key.toLowerCase() === searchName) {
            matchedKey = key;
            cu = cloudCustomers[key];
            break;
        }
    }

    if(cu) {
        document.getElementById('customer-phone').value = cu.phone || '';
        document.getElementById('customer-address').value = cu.address || '';
        if (!editBillKey) {
            document.getElementById('prev-balance').value = getCustomerTrueBalance(matchedKey);
            calc();
        }
    }
}

function normalizeCatalogItem(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') {
        return { name: entry.trim(), code: '', rate: '' };
    }
    if (typeof entry === 'object' && entry.name) {
        return {
            name: String(entry.name).trim(),
            code: String(entry.code || '').trim(),
            rate: entry.rate !== undefined && entry.rate !== null ? String(entry.rate).trim() : ''
        };
    }
    return null;
}

function getNormalizedCatalog() {
    const map = new Map();
    (inventoryList || []).forEach(raw => {
        const norm = normalizeCatalogItem(raw);
        if (norm && norm.name) {
            map.set(norm.name.toLowerCase(), norm);
        }
    });
    return Array.from(map.values());
}

// ============================================================
// SUGGESTION BAR SYSTEM (SINGLE LISTENER, LIVE FILTERING)
// ============================================================
let suggestionListenersBound = false;

function initSuggestionBar() {
    if (suggestionListenersBound) return;
    const bar = document.getElementById('suggestion-bar');
    if (!bar) return;
    suggestionListenersBound = true;

    const isSuggestInput = (el) => {
        return el && el.tagName === 'INPUT' && (
            el.id === 'customer-name' ||
            el.id === 'slip-customer' ||
            el.classList.contains('item-desc') ||
            el.classList.contains('poka-desc-inp')
        );
    };

    document.addEventListener('focusin', (e) => {
        if (isSuggestInput(e.target)) {
            updateSuggestions(e.target);
        } else {
            bar.style.display = 'none';
        }
    });

    document.addEventListener('input', (e) => {
        if (isSuggestInput(e.target)) {
            updateSuggestions(e.target);
        }
    });

    document.addEventListener('focusout', () => {
        setTimeout(() => {
            if (!document.activeElement || !isSuggestInput(document.activeElement)) {
                bar.style.display = 'none';
            }
        }, 160);
    });
}

function updateSuggestions(target) {
    const bar = document.getElementById('suggestion-bar');
    if(!bar) return;
    bar.innerHTML = '';

    const query = (target.value || '').trim().toLowerCase();
    const isCustomerField = (target.id === 'customer-name' || target.id === 'slip-customer');

    if (isCustomerField) {
        const custNames = Object.keys(cloudCustomers || {});
        const filtered = query ? custNames.filter(n => n.toLowerCase().includes(query)) : custNames;
        if (filtered.length === 0) { bar.style.display = 'none'; return; }

        filtered.slice(0, 15).forEach(name => {
            const btn = document.createElement('button');
            btn.className = 's-btn';
            const baki = getCustomerTrueBalance(name);
            btn.innerHTML = `<span>${escapeHtmlAttr(name)}</span>${baki > 0 ? `<small>Due: ${baki}</small>` : ''}`;
            btn.onmousedown = (e) => e.preventDefault();
            btn.onclick = () => {
                target.value = name;
                if (target.id === 'customer-name') {
                    triggerCustomerAutoFill();
                    document.querySelectorAll('.item-desc').forEach(el => checkAndAutoFillRate(el));
                }
                bar.style.display = 'none';
            };
            bar.appendChild(btn);
        });
        bar.style.display = 'flex';
    } else {
        const catItems = getNormalizedCatalog();
        const filtered = query
            ? catItems.filter(it => it.name.toLowerCase().includes(query) || (it.code && it.code.toLowerCase().includes(query)))
            : catItems;
        if (filtered.length === 0) { bar.style.display = 'none'; return; }

        filtered.slice(0, 15).forEach(it => {
            const btn = document.createElement('button');
            btn.className = 's-btn';
            let meta = [];
            if (it.code) meta.push(it.code);
            if (it.rate) meta.push(`Rs.${it.rate}`);
            btn.innerHTML = `<span>${escapeHtmlAttr(it.name)}</span>${meta.length ? `<small>${escapeHtmlAttr(meta.join(' • '))}</small>` : ''}`;
            btn.onmousedown = (e) => e.preventDefault();
            btn.onclick = () => {
                target.value = it.name;
                if (target.classList.contains('item-desc')) {
                    checkAndAutoFillRate(target);
                }
                bar.style.display = 'none';
            };
            bar.appendChild(btn);
        });
        bar.style.display = 'flex';
    }
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
    ySel.innerHTML = '';
    for(let i=0; i<ND.length; i++) ySel.innerHTML += `<option value="${ND[i][0]}">${ND[i][0]}</option>`;
    const mSel = document.getElementById('np-cal-m');
    mSel.innerHTML = '';
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
    let m = parseInt(document.getElementById('np-cal-m').value, 10);
    let y = parseInt(document.getElementById('np-cal-y').value, 10);
    if(m === 1) { m = 12; y--; } else { m--; }
    if(y >= 2000) { document.getElementById('np-cal-m').value = m; document.getElementById('np-cal-y').value = y; renderNpCal(); }
}

function nextNpMonth() {
    let m = parseInt(document.getElementById('np-cal-m').value, 10);
    let y = parseInt(document.getElementById('np-cal-y').value, 10);
    if(m === 12) { m = 1; y++; } else { m++; }
    if(y <= 2099) { document.getElementById('np-cal-m').value = m; document.getElementById('np-cal-y').value = y; renderNpCal(); }
}

function renderNpCal() {
    const y = parseInt(document.getElementById('np-cal-y').value, 10);
    const m = parseInt(document.getElementById('np-cal-m').value, 10);
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

window.onload = async function() {
    initNpCal();
    initSuggestionBar();
    syncQueue = await loadOutboxFromIDB();

    if(document.getElementById('current-date-ad')) document.getElementById('current-date-ad').value = todayStr;
    if(document.getElementById('cash-paid-date')) document.getElementById('cash-paid-date').value = todayStr;
    if(document.getElementById('slip-date')) document.getElementById('slip-date').value = todayStr;
    if(document.getElementById('slip-ref')) document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
    if(document.getElementById('invoice-number')) document.getElementById('invoice-number').innerText = cloudNextInvoice;

    updateBSDate();
    addRow();
    addNoteRow();
    addPokaGroup();

    try {
        if (sessionStorage.getItem('rkp_unlocked') === '1') {
            unlockAppSession();
        }
    } catch (e) {}
};

function toggleDark(){
    const h=document.documentElement,d=h.getAttribute('data-theme')==='dark';
    h.setAttribute('data-theme',d?'light':'dark');
    document.getElementById('dark-btn').innerText=d?'🌙':'☀️';
}

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
      const v = parseInt(s.val(), 10);
      if(v && !isNaN(v)){
        cloudNextInvoice = Math.max(cloudNextInvoice, v);
        safeSetLocal('nwh_next_inv', String(cloudNextInvoice));
        if(!editBillKey) document.getElementById('invoice-number').innerText = cloudNextInvoice;
      } else {
        queueDatabaseWrite('nwh/nextInvoiceNumber', 'set', cloudNextInvoice);
      }
    });

    db.ref('nwh/customers').on('value',s=>{
        const val = s.val();
        cloudCustomers = (val && typeof val === 'object') ? val : {};
        backfillLegacyOpeningBalances();
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
        backfillLegacyOpeningBalances();
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
  if (!isUnlocked) return;
  if (typeof firebase !== 'undefined' && firebase.apps) {
    initFB();
  } else {
    setTimeout(startFirebase, 150);
  }
}

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
    getNormalizedCatalog().forEach(item => {
        let option = document.createElement('option');
        option.value = item.name;
        list.appendChild(option);
    });
}

function saveNewItems(itemsArray) {
    let changed = false;
    const currentCatalog = getNormalizedCatalog();

    (itemsArray || []).forEach(it => {
        if (!it || !it.desc) return;
        const d = it.desc.trim();
        if (!d || d === 'Item') return;

        const existing = currentCatalog.find(c => c.name.toLowerCase() === d.toLowerCase());
        if (!existing) {
            currentCatalog.push({
                name: d,
                code: (it.code || '').trim(),
                rate: ''
            });
            changed = true;
        } else if (!existing.code && it.code) {
            existing.code = it.code.trim();
            changed = true;
        }
    });

    if (changed) {
        inventoryList = currentCatalog;
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
    const codeInput = row.querySelector('.item-code');
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
    const queryDesc = descInput.value.trim().toLowerCase();
    if(!queryDesc) return;

    const catalogMatch = getNormalizedCatalog().find(c => c.name.toLowerCase() === queryDesc);
    if (catalogMatch && codeInput && !codeInput.value.trim() && catalogMatch.code) {
        codeInput.value = catalogMatch.code;
    }

    let lastCustRate = null;
    if (custName) {
        for(let i=0; i<allBills.length; i++) {
            if(allBills[i] && allBills[i].customer && allBills[i].customer.toLowerCase() === custName.toLowerCase() && allBills[i].items) {
                const match = allBills[i].items.find(it => it && it.desc && it.desc.toLowerCase().trim() === queryDesc);
                if(match && match.rate) {
                    lastCustRate = match.rate;
                    break;
                }
            }
        }
    }

    if(lastCustRate) {
        if(!rateInput.value || rateInput.dataset.autofilled === 'true') {
            rateInput.value = lastCustRate;
            rateInput.dataset.autofilled = 'true';
            calc();
        }
        hintSpan.innerText = `Cust Last: ${lastCustRate}`;
    } else if (catalogMatch && catalogMatch.rate) {
        if(!rateInput.value || rateInput.dataset.autofilled === 'true') {
            rateInput.value = catalogMatch.rate;
            rateInput.dataset.autofilled = 'true';
            calc();
        }
        hintSpan.innerText = `Base: ${catalogMatch.rate}`;
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
        <input type="date" class="inp note-date" style="width:130px; padding:6px; font-size:0.8rem;" value="${escapeHtmlAttr(dateVal)}">
        <input type="text" class="inp note-text" style="flex:1; padding:6px; font-size:0.8rem;" placeholder="Remark / Amount..." value="${escapeHtmlAttr(textVal)}">
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

  const catalog = getNormalizedCatalog();
  if (catalog.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🏷️</div><div>No items saved in catalog</div></div>`;
    return;
  }

  let html = `<table class="h-table">
    <thead>
      <tr>
        <th style="text-align:left;">Garment Description</th>
        <th style="text-align:center; width:90px;">Code</th>
        <th style="text-align:right; width:110px;">Base Rate</th>
        <th style="text-align:right; width:90px;">Action</th>
      </tr>
    </thead>
    <tbody>`;

  catalog.forEach((item) => {
    const safeName = escapeHtmlAttr(item.name);
    const safeCode = escapeHtmlAttr(item.code || '—');
    const safeRate = item.rate ? `NRS ${parseInt(item.rate, 10).toLocaleString('en-IN')}` : '—';
    const safeJsName = escapeJsStr(item.name);
    html += `<tr>
      <td><strong>${safeName}</strong></td>
      <td style="text-align:center;color:var(--text2);">${safeCode}</td>
      <td style="text-align:right;font-weight:700;color:var(--green);">${safeRate}</td>
      <td style="text-align:right;">
        <button class="btn btn-red btn-sm" onclick="removeItemFromCatalog('${safeJsName}')">🗑️</button>
      </td>
    </tr>`;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function addItemToCatalogFromUI() {
  const nameInp = document.getElementById('new-item-catalog-input');
  const codeInp = document.getElementById('new-item-code-input');
  const rateInp = document.getElementById('new-item-rate-input');
  if (!nameInp) return;

  const nameVal = nameInp.value.trim();
  const codeVal = codeInp ? codeInp.value.trim() : '';
  const rateVal = rateInp ? rateInp.value.trim() : '';

  if (!nameVal) {
    alert("Please enter a garment description.");
    return;
  }

  const catalog = getNormalizedCatalog();
  const existingIdx = catalog.findIndex(c => c.name.toLowerCase() === nameVal.toLowerCase());
  if (existingIdx >= 0) {
    catalog[existingIdx].code = codeVal || catalog[existingIdx].code;
    catalog[existingIdx].rate = rateVal || catalog[existingIdx].rate;
  } else {
    catalog.push({ name: nameVal, code: codeVal, rate: rateVal });
  }

  inventoryList = catalog;
  safeSetLocal('nwh_inventory', JSON.stringify(inventoryList));
  queueDatabaseWrite('nwh/inventory', 'set', inventoryList);

  nameInp.value = '';
  if (codeInp) codeInp.value = '';
  if (rateInp) rateInp.value = '';
  renderInventory();
  renderInventoryCatalog();
}

function removeItemFromCatalog(itemName) {
  if (confirm(`Delete "${itemName}" from your product catalog?`)) {
    inventoryList = getNormalizedCatalog().filter(i => i.name.toLowerCase() !== itemName.toLowerCase());
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
// CAMERA BARCODE SCANNER
// ============================================================
let scannerStream = null;
let scannerInterval = null;

async function openBarcodeScanner() {
    const modal = document.getElementById('scanner-modal');
    const video = document.getElementById('scanner-video');
    const status = document.getElementById('scanner-status');
    if (!modal || !video) return;
    modal.classList.add('open');

    try {
        scannerStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
        });
        video.srcObject = scannerStream;
        await video.play();

        if ('BarcodeDetector' in window) {
            const detector = new BarcodeDetector({ formats: ['qr_code', 'ean_13', 'code_128', 'code_39', 'upc_a'] });
            scannerInterval = setInterval(async () => {
                try {
                    const barcodes = await detector.detect(video);
                    if (barcodes && barcodes.length > 0) {
                        handleScannedCode(barcodes[0].rawValue);
                    }
                } catch (e) {}
            }, 250);
        } else {
            status.innerText = 'Camera active. Enter code below if auto-detect is unsupported on this browser.';
        }
    } catch (err) {
        status.innerText = 'Camera permission denied or unavailable. Use manual code entry below.';
    }
}

function closeBarcodeScanner() {
    if (scannerInterval) { clearInterval(scannerInterval); scannerInterval = null; }
    if (scannerStream) {
        scannerStream.getTracks().forEach(t => t.stop());
        scannerStream = null;
    }
    closeModal('scanner-modal');
}

function handleScannedCode(rawCode) {
    const code = (rawCode || '').trim();
    if (!code) return;
    closeBarcodeScanner();

    const catalog = getNormalizedCatalog();
    const matched = catalog.find(c => (c.code && c.code.toLowerCase() === code.toLowerCase()) || c.name.toLowerCase() === code.toLowerCase());

    const descToUse = matched ? matched.name : code;
    const codeToUse = matched ? (matched.code || code) : code;
    const rateToUse = matched ? (matched.rate || '') : '';

    const emptyRow = Array.from(document.querySelectorAll('#invoice-items tr')).find(
        r => !r.querySelector('.item-desc').value.trim() && (parseFloat(r.querySelector('.qty').value) || 0) === 0
    );

    if (emptyRow) {
        emptyRow.querySelector('.item-desc').value = descToUse;
        emptyRow.querySelector('.item-code').value = codeToUse;
        emptyRow.querySelector('.qty').value = 1;
        if (rateToUse) emptyRow.querySelector('.rate').value = rateToUse;
        checkAndAutoFillRate(emptyRow.querySelector('.item-desc'));
    } else {
        addRow(descToUse, 1, rateToUse, codeToUse);
        const lastRow = document.getElementById('invoice-items').lastElementChild;
        if (lastRow) checkAndAutoFillRate(lastRow.querySelector('.item-desc'));
    }
    calc();
}

// ============================================================
// POKA BUNDLING
// ============================================================
function addPokaGroup(items = null, vatVal = '') {
    const container = document.getElementById('poka-groups-container');
    if(!container) return;

    const currentId = Date.now() + Math.random().toString(36).substring(2, 7);

    const div = document.createElement('div');
    div.className = 'poka-card-wrapper';
    div.style = 'background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden; box-shadow:0 4px 12px rgba(0,0,0,0.03);';
    div.id = `poka-wrapper-${currentId}`;

    div.innerHTML = `
        <div style="background:var(--surface2); padding:10px 14px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
            <span class="poka-header-title" style="font-weight:800; font-size:0.95rem; color:var(--text)">📦 Poka #...</span>
            <div style="display:flex; align-items:center; gap:6px;">
                <input type="text" class="inp poka-vat-inp" placeholder="VAT #" value="${escapeHtmlAttr(vatVal)}" style="width:85px; padding:5px 8px; font-size:0.8rem; font-weight:700; text-align:center; color:#7c3aed; background:var(--surface);">
                <button class="del-row" onclick="removePokaGroup('${currentId}')" style="color:var(--red); font-size:0.8rem; font-weight:700; background:#fee2e2; border:1px solid #fecaca; cursor:pointer; padding:5px 9px; border-radius:6px;">✕ Remove</button>
            </div>
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
}

function addPokaItemRow(pokaId, desc='', formula='', mult='10') {
    const tbody = document.getElementById(`poka-items-tbody-${pokaId}`);
    if(!tbody) return;
    const div = document.createElement('div');
    div.className = 'poka-item-row';
    div.style = "background:var(--surface2); padding:12px; border-radius:10px; border:1px solid var(--border);";
    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; margin-bottom:10px; gap:10px;">
            <input type="text" class="inp poka-desc-inp" placeholder="Type Garment Description..." value="${escapeHtmlAttr(desc)}" list="inventory-list" style="flex:1; font-weight:600; font-size:0.9rem; padding:10px;">
            <button class="del-row" onclick="this.closest('.poka-item-row').remove(); syncPokaCountValue();" style="padding:8px 14px; font-size:1rem; background:#fee2e2; color:#991b1b; border-radius:8px; border:none; cursor:pointer;">✕</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
            <input type="text" class="inp poka-formula-inp" placeholder="e.g. 11+13+5" value="${escapeHtmlAttr(formula)}" oninput="evaluatePokaRowSum(this)" style="flex:2; font-family:'Plus Jakarta Sans', sans-serif; font-size:1rem; font-weight:600; padding:10px;">
            <span style="font-size:1.2rem; color:var(--text3); font-weight:bold;">×</span>
            <input type="number" class="inp poka-mult-inp" value="${escapeHtmlAttr(mult)}" oninput="evaluatePokaRowSum(this)" style="flex:1; max-width:70px; font-family:'Plus Jakarta Sans', sans-serif; font-size:1rem; font-weight:600; padding:10px; text-align:center;">
            <div style="min-width:65px; text-align:right;">
                <span class="poka-row-sum-output" style="font-family:'Plus Jakarta Sans', sans-serif; font-size:1.15rem; font-weight:700; color:var(--accent);">0</span>
            </div>
        </div>
    `;
    tbody.appendChild(div);

    if(formula) evaluatePokaRowSum(div.querySelector('.poka-formula-inp'));
}

function evaluatePokaRowSum(inputElement) {
    const row = inputElement.closest('.poka-item-row');
    if(!row) return;
    const formulaVal = row.querySelector('.poka-formula-inp').value;
    const multVal = parseFloat(row.querySelector('.poka-mult-inp').value) || 1;
    const outputSpan = row.querySelector('.poka-row-sum-output');

    let clean = formulaVal
        .replace(/[^0-9+\-*/().]/g, '')
        .replace(/\b0+(\d+)/g, '$1')
        .replace(/[+\-*/.]+$/, '');

    if(!clean) { outputSpan.innerText = '0'; return; }

    try {
        let baseSum = new Function('return (' + clean + ')')();
        if (typeof baseSum === 'number' && isFinite(baseSum)) {
            let total = Math.round(baseSum * multVal);
            outputSpan.innerText = total.toLocaleString('en-IN');
        } else {
            outputSpan.innerText = '0';
        }
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
    const transport = document.getElementById('slip-transport') ? document.getElementById('slip-transport').value.trim() : '';
    const ref = document.getElementById('slip-ref').value || 'PK-N/A';
    const date = document.getElementById('slip-date').value || todayStr;
    const vatBillNo = document.getElementById('slip-vat') ? document.getElementById('slip-vat').value.trim() : '';

    const structuredPokas = [];
    document.querySelectorAll('.poka-card-wrapper').forEach((group, index) => {
        const pItems = [];
        const pVat = group.querySelector('.poka-vat-inp')?.value.trim() || '';

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
        if(pItems.length > 0) structuredPokas.push({ pokaNum: index + 1, vat: pVat, items: pItems });
    });

    if(structuredPokas.length === 0) {
        alert("Please add at least one item before saving.");
        return;
    }

    const pokaKey = generateOfflinePushKey('nwh/pokas');
    queueDatabaseWrite('nwh/pokas/' + pokaKey, 'set', {
        customer,
        transport,
        ref,
        date,
        vatBillNo,
        pokaDetails: structuredPokas,
        totalPoka: structuredPokas.length
    });
    alert(`✅ Packing Slip Draft saved!`);

    document.getElementById('poka-groups-container').innerHTML = '';
    document.getElementById('slip-ref').value = 'PK-' + Math.floor(1000 + Math.random() * 9000);
    document.getElementById('slip-customer').value = '';
    if (document.getElementById('slip-transport')) document.getElementById('slip-transport').value = '';
    if (document.getElementById('slip-vat')) document.getElementById('slip-vat').value = '';
    addPokaGroup();
}

function renderPokaHistory() {
    const c = document.getElementById('saved-pokas-container');
    if(!c) return;
    if(!allPokas.length) {
        c.innerHTML = `<div class="empty-state"><div class="icon">📁</div><div class="L">No saved drafts</div></div>`;
        return;
    }

    let html = `<table class="h-table"><thead><tr><th>Date & Ref</th><th>Customer / Transport</th><th>Bundles</th><th>Actions</th></tr></thead><tbody>`;
    allPokas.forEach(p => {
        if(!p) return;
        html += `<tr>
            <td><strong style="color:var(--accent);">${escapeHtmlAttr(p.ref || 'N/A')}</strong><br><span style="font-size:10px">${escapeHtmlAttr(p.date || '')}</span></td>
            <td><strong>${escapeHtmlAttr(p.customer || 'Unknown')}</strong>${p.transport ? `<br><span style="font-size:11px;color:var(--text2);">🚚 ${escapeHtmlAttr(p.transport)}</span>` : ''}</td>
            <td><span class="badge b-green">${p.totalPoka || 0} Poka</span></td>
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
    if (document.getElementById('slip-transport')) document.getElementById('slip-transport').value = p.transport || '';
    document.getElementById('slip-ref').value = p.ref || '';
    document.getElementById('slip-date').value = p.date || todayStr;
    if (document.getElementById('slip-vat')) document.getElementById('slip-vat').value = p.vatBillNo || '';

    document.getElementById('poka-groups-container').innerHTML = '';

    if(p.pokaDetails && p.pokaDetails.length > 0) {
        p.pokaDetails.forEach(group => addPokaGroup(group.items, group.vat || ''));
    } else {
        addPokaGroup();
    }

    if (p.customer && p.customer !== 'Walk-in / Unknown') {
        document.getElementById('customer-name').value = p.customer;
        triggerCustomerAutoFill();
    }
    if (p.transport && document.getElementById('transport-name')) {
        document.getElementById('transport-name').value = p.transport;
    }
}

function deletePokaDraft(key) {
    if(confirm("Are you sure you want to delete this Poka draft?")) {
        queueDatabaseWrite('nwh/pokas/' + key, 'remove', null);
    }
}

function syncPokasToInvoice() {
    const vatList = [];
    const aggregatedMap = new Map();

    const slipCust = document.getElementById('slip-customer').value.trim();
    if (slipCust && !document.getElementById('customer-name').value.trim()) {
        document.getElementById('customer-name').value = slipCust;
        triggerCustomerAutoFill();
    }
    const slipTrans = document.getElementById('slip-transport') ? document.getElementById('slip-transport').value.trim() : '';
    if (slipTrans && document.getElementById('transport-name')) {
        document.getElementById('transport-name').value = slipTrans;
    }

    document.querySelectorAll('.poka-card-wrapper').forEach((group, index) => {
        const pVat = group.querySelector('.poka-vat-inp')?.value.trim() || '';
        if (pVat) {
            vatList.push({ pNum: index + 1, vat: pVat });
        }

        group.querySelectorAll('.poka-item-row').forEach(row => {
            const desc = row.querySelector('.poka-desc-inp').value.trim();
            const sum = parseInt(row.querySelector('.poka-row-sum-output').innerText.replace(/,/g, ''), 10) || 0;

            if (desc && sum > 0) {
                const key = desc.toLowerCase();
                if (aggregatedMap.has(key)) {
                    aggregatedMap.get(key).qty += sum;
                } else {
                    aggregatedMap.set(key, { desc, qty: sum });
                }
            }
        });
    });

    if (aggregatedMap.size === 0) {
        alert("⚠️ No valid items to sync. Make sure bundles have descriptions and quantities.");
        return;
    }

    document.querySelectorAll('#invoice-items tr[data-from-poka="true"]').forEach(r => r.remove());

    let addedCount = 0;
    aggregatedMap.forEach(({ desc, qty }) => {
        const emptyRow = Array.from(document.querySelectorAll('#invoice-items tr')).find(
            r => !r.querySelector('.item-desc').value.trim() && (parseFloat(r.querySelector('.qty').value)||0) === 0
        );
        if (emptyRow) {
            emptyRow.dataset.fromPoka = 'true';
            emptyRow.querySelector('.item-desc').value = desc;
            emptyRow.querySelector('.qty').value = qty;
            checkAndAutoFillRate(emptyRow.querySelector('.item-desc'));
        } else {
            addRow(desc, qty, '', '');
            const lastRow = document.getElementById('invoice-items').lastElementChild;
            if (lastRow) {
                lastRow.dataset.fromPoka = 'true';
                checkAndAutoFillRate(lastRow.querySelector('.item-desc'));
            }
        }
        addedCount++;
    });

    if (document.getElementById('vat-bill-no')) {
        if (vatList.length > 0) {
            const uniqueVats = [...new Set(vatList.map(v => v.vat))];
            if (uniqueVats.length === 1 && vatList.length === document.querySelectorAll('.poka-card-wrapper').length) {
                document.getElementById('vat-bill-no').value = uniqueVats[0];
            } else {
                document.getElementById('vat-bill-no').value = vatList.map(v => `${v.vat} (P${v.pNum})`).join(', ');
            }
        } else {
            const slipVat = document.getElementById('slip-vat') ? document.getElementById('slip-vat').value.trim() : '';
            if (slipVat) document.getElementById('vat-bill-no').value = slipVat;
        }
    }

    syncPokaCountValue();
    calc();
    alert(`✅ Synced ${addedCount} garment types from Pokas to the main invoice!`);
    switchTab('invoice');
}

function addRow(desc='',qty='',rate='',code=''){
  const tbody = document.getElementById('invoice-items');
  if(!tbody) return;
  const tr=document.createElement('tr');
  tr.innerHTML=`<td><input type="text" class="ti item-desc" placeholder="Type item..." value="${escapeHtmlAttr(desc)}" list="inventory-list" oninput="checkAndAutoFillRate(this)"></td>
    <td><input type="text" class="ti r item-code" placeholder="—" value="${escapeHtmlAttr(code)}" style="text-align:center;"></td>
    <td><input type="number" class="ti r qty" placeholder="0" min="0" value="${escapeHtmlAttr(qty)}" oninput="calc()"></td>
    <td style="position:relative;"><input type="number" class="ti r rate" placeholder="0" min="0" value="${escapeHtmlAttr(rate)}" oninput="manualRateOverride(this)"></td>
    <td class="amount">0</td>
    <td class="no-print"><button class="del-row" onclick="this.closest('tr').remove();calc()">✕</button></td>`;
  tbody.appendChild(tr);

  if(qty || rate) calc();
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
  ['customer-name','customer-phone','customer-address','transport-name','bilti-no','total-poka','transport-expense','discount-amount','prev-balance','cash-paid','db-search', 'slip-customer', 'slip-transport', 'vat-bill-no', 'slip-vat'].forEach(id=>{
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
  addPokaGroup();

  editBillKey = null;
  editInvoiceNum = null;
  editOriginalCustomer = null;
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
      const baki = getCustomerTrueBalance(name);
      d.innerHTML=`<span><strong>${escapeHtmlAttr(name)}</strong> &nbsp;${escapeHtmlAttr(cloudCustomers[name].phone||'')}</span><span class="badge ${baki>0?'b-red':'b-green'}">NRS ${baki.toLocaleString('en-IN')}</span>`;
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
    const balVal = document.getElementById('prev-balance').value || "0";

    if (!cloudCustomers[safeName]) cloudCustomers[safeName] = {};
    cloudCustomers[safeName].phone = document.getElementById('customer-phone').value || "";
    cloudCustomers[safeName].address = document.getElementById('customer-address').value || "";
    cloudCustomers[safeName].balance = balVal;
    cloudCustomers[safeName].openingBalance = balVal;

    queueDatabaseWrite('nwh/customers/' + safeName, 'set', cloudCustomers[safeName]);
    recalculateCustomerLedger(safeName);
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
  const remBaki = document.getElementById('remaining-balance').innerText;
  const transName = document.getElementById('transport-name') ? document.getElementById('transport-name').value.trim() : '';
  const biltiNo = document.getElementById('bilti-no') ? document.getElementById('bilti-no').value.trim() : '';
  const pokas = document.getElementById('total-poka').value;

  let msg=`🏪 *${biz}*\n📄 Invoice #${invNum}\n📅 ${billDate} (${billDateBS})\n👤 *${custName}*\n🧾 Today's Bill: *NRS ${billAmt}*\n🔴 Total Baki: *NRS ${remBaki}*`;
  if (pokas && parseInt(pokas, 10) > 0) msg += `\n📦 Total Poka: *${pokas}*`;
  if (transName) msg += `\n🚚 Transport: *${transName}*${biltiNo ? ` (Bilti: ${biltiNo})` : ''}`;

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
    const desc=row.querySelector('.item-desc').value.trim(),
          qty=row.querySelector('.qty').value,
          rate=row.querySelector('.rate').value,
          code=row.querySelector('.item-code').value.trim(),
          amount=row.querySelector('.amount').innerText.replace(/,/g,'');
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
      const pVat = group.querySelector('.poka-vat-inp')?.value.trim() || '';
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
          structuredPokas.push({ pokaNum: pNum, vat: pVat, items: pItems });
      }
  });

  return {
      invoiceNum: editInvoiceNum || cloudNextInvoice,
      vatBillNo: document.getElementById('vat-bill-no') ? document.getElementById('vat-bill-no').value.trim() : '',
      transportName: document.getElementById('transport-name') ? document.getElementById('transport-name').value.trim() : '',
      biltiNo: document.getElementById('bilti-no') ? document.getElementById('bilti-no').value.trim() : '',
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
    const slipVat = document.getElementById('slip-vat') ? document.getElementById('slip-vat').value.trim() : '';
    const slipCust = document.getElementById('slip-customer').value.trim() || bill.customer;
    const slipTrans = (document.getElementById('slip-transport') ? document.getElementById('slip-transport').value.trim() : '') || bill.transportName;
    const activeVat = bill.vatBillNo || slipVat;

    if (!bill.pokaDetails || bill.pokaDetails.length === 0) {
        alert("No Poka bundle details have been added. Please add packing details first.");
        return;
    }

    const bizName = document.getElementById('biz-name').innerText || "Rabi Kapada Pasal";
    const slipDate = document.getElementById('slip-date').value || todayStr;
    const slipRef = document.getElementById('slip-ref').value || 'N/A';

    let htmlString = `
    <div style="padding: 10px; width: 100%; overflow-x: auto; background: #e2e8f0; -webkit-overflow-scrolling: touch;">
        <div id="actual-slip-to-render" style="width: 560px; min-width: 560px; min-height: 750px; background: #ffffff; color: #000000; font-family: 'Plus Jakarta Sans', Arial, sans-serif; box-sizing: border-box; margin: 0 auto; padding: 30px;">
            <div style="text-align: center; border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 24px;">
                <h1 style="font-size: 22px; color: #1a1f36; margin: 0; text-transform: uppercase;">PACKING SLIP (POKA DETAILS)</h1>
                <h2 style="font-size: 15px; color: #4a5280; margin: 4px 0 0 0;">${escapeHtmlAttr(bizName)}</h2>
            </div>

            <table style="width: 100%; margin-bottom: 24px;">
                <tr>
                    <td style="width: 55%; vertical-align: top;">
                        <div style="background: #f7f9ff; padding: 10px 14px; border-left: 4px solid #8b5cf6; border-radius: 4px;">
                            <p style="font-size: 10px; font-weight: bold; color: #8892b0; margin: 0 0 3px 0;">SHIP TO:</p>
                            <p style="font-size: 14.5px; font-weight: bold; color: #1a1f36; margin: 0;">${escapeHtmlAttr(slipCust)}</p>
                            ${bill.phone ? `<p style="font-size: 12px; color: #4a5280; margin: 2px 0 0 0;">${escapeHtmlAttr(bill.phone)}</p>` : ''}
                            ${slipTrans ? `<p style="font-size: 12px; color: #059669; font-weight: 700; margin: 4px 0 0 0;">🚚 Transport: ${escapeHtmlAttr(slipTrans)}</p>` : ''}
                        </div>
                    </td>
                    <td style="width: 45%; vertical-align: top; text-align: right;">
                        <p style="font-size: 12px; color: #4a5280; margin: 0 0 3px 0;"><strong>Date:</strong> ${escapeHtmlAttr(slipDate)}</p>
                        <p style="font-size: 12px; color: #4a5280; margin: 0 0 3px 0;"><strong>Slip Ref:</strong> ${escapeHtmlAttr(slipRef)}</p>
                        ${activeVat ? `<p style="font-size: 12px; color: #7c3aed; font-weight: 700; margin: 0 0 3px 0;"><strong>VAT Bill No.</strong> ${escapeHtmlAttr(activeVat)}</p>` : ''}
                        <p style="font-size: 12px; color: #4a5280; margin: 0;"><strong>Total Bundles:</strong> ${bill.pokaDetails.length}</p>
                    </td>
                </tr>
            </table>`;

        bill.pokaDetails.forEach(p => {
            htmlString += `
            <div style="margin-bottom: 16px; border: 1.5px solid #cbd5e1; border-radius: 6px; overflow: hidden;">
                <div style="background: #f1f5f9; padding: 8px 12px; font-size: 12.5px; font-weight: 800; display:flex; justify-content:space-between; align-items:center;">
                    <span>📦 Poka #${p.pokaNum}</span>
                    ${p.vat ? `<span style="color:#7c3aed; font-size:12px; font-weight:700;">VAT Bill No. ${escapeHtmlAttr(p.vat)}</span>` : ''}
                </div>
                <table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">
                    <thead>
                        <tr style="background: #f8fafc; text-align: left; border-bottom: 1px solid #e2e8f0;">
                            <th style="padding: 8px 12px;">Garment Description</th>
                            <th style="padding: 8px 12px;">Breakdown</th>
                            <th style="padding: 8px 12px; text-align: right;">Total Pcs</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${p.items.map(it => `
                            <tr style="border-bottom: 1px solid #e2e8f0;">
                                <td style="padding: 8px 12px; font-weight: bold;">${escapeHtmlAttr(it.desc)}</td>
                                <td style="padding: 8px 12px; font-family: 'Plus Jakarta Sans', sans-serif;">${escapeHtmlAttr(it.formula || '—')}</td>
                                <td style="padding: 8px 12px; text-align: right; font-weight: bold;">${escapeHtmlAttr(it.total)}</td>
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
// DIRECT-RENDER GPU-SAFE CAPTURE ENGINE
// ============================================================
function captureElementToCanvas(targetElement, callback) {
    if (!targetElement) {
        alert("Error: Element to capture was not found.");
        if (callback) callback(null);
        return;
    }

    const originalParent = targetElement.parentNode;
    const nextSibling = targetElement.nextSibling;

    const renderHolder = document.createElement('div');
    renderHolder.style.position = 'fixed';
    renderHolder.style.left = '0';
    renderHolder.style.top = '0';
    renderHolder.style.zIndex = '999999';
    renderHolder.style.background = '#ffffff';
    renderHolder.style.width = (targetElement.offsetWidth || 560) + 'px';
    renderHolder.style.boxSizing = 'border-box';
    renderHolder.style.padding = '0';
    renderHolder.style.margin = '0';

    renderHolder.appendChild(targetElement);
    document.body.appendChild(renderHolder);

    const options = {
        scale: 2.2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: false,
        scrollX: 0,
        scrollY: 0,
        windowWidth: Math.max(document.documentElement.offsetWidth, targetElement.offsetWidth || 560),
        windowHeight: document.documentElement.offsetHeight
    };

    html2canvas(targetElement, options).then(function (canvas) {
        if (originalParent) originalParent.insertBefore(targetElement, nextSibling);
        if (document.body.contains(renderHolder)) document.body.removeChild(renderHolder);
        callback(canvas);
    }).catch(function (error) {
        console.error("Capture error:", error);
        if (originalParent) originalParent.insertBefore(targetElement, nextSibling);
        if (document.body.contains(renderHolder)) document.body.removeChild(renderHolder);
        alert("Error rendering document: " + error.message);
        callback(null);
    });
}

function downloadElementAsImage(targetElement, filename, callback) {
    captureElementToCanvas(targetElement, (canvas) => {
        if (!canvas || canvas.width === 0 || canvas.height === 0) { if (callback) callback(); return; }
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = filename;
        link.href = dataUrl;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        if (callback) callback();
    });
}

function shareElementAsImageNative(targetElement, filename, shareText, callback) {
    captureElementToCanvas(targetElement, (canvas) => {
        if (!canvas || canvas.width === 0 || canvas.height === 0) { if (callback) callback(); return; }
        canvas.toBlob(async (blob) => {
            if (!blob) { if (callback) callback(); return; }
            const file = new File([blob], filename, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: filename,
                        text: shareText || ''
                    });
                } catch (e) {}
            } else {
                const dataUrl = canvas.toDataURL('image/png');
                const link = document.createElement('a');
                link.download = filename;
                link.href = dataUrl;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }
            if (callback) callback();
        }, 'image/png');
    });
}

function downloadElementAsPDF(targetElement, filename, callback) {
    captureElementToCanvas(targetElement, (canvas) => {
        if (!canvas || canvas.width === 0 || canvas.height === 0) { if (callback) callback(); return; }
        try {
            const { jsPDF } = window.jspdf;
            const imgData = canvas.toDataURL('image/jpeg', 0.95);
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const imgWidth = pageWidth;
            const imgHeight = (canvas.height * imgWidth) / canvas.width;

            let heightLeft = imgHeight;
            let position = 0;

            pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
            heightLeft -= pageHeight;

            while (heightLeft > 5) {
                position = heightLeft - imgHeight;
                pdf.addPage();
                pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
                heightLeft -= pageHeight;
            }

            pdf.save(filename.replace(/\.png$/i, '') + '.pdf');
        } catch (err) {
            alert("PDF export error: " + err.message);
        }
        if (callback) callback();
    });
}

function downloadSlipOnly() {
    const btn = document.getElementById('slip-dl-btn');
    if (btn) btn.innerHTML = '⏳ Processing...';
    const targetElement = document.getElementById('actual-slip-to-render');
    const custName = document.getElementById('slip-customer').value.trim() || document.getElementById('customer-name').value.trim() || 'Customer';
    const safeCust = custName.replace(/[^a-zA-Z0-9]/g, '_');

    downloadElementAsImage(targetElement, `PackingSlip-${safeCust}.png`, () => {
        if (btn) btn.innerHTML = '💾 Download PNG';
        closeModal('slip-modal');
    });
}

function shareSlipOnlyNative() {
    const targetElement = document.getElementById('actual-slip-to-render');
    const custName = document.getElementById('slip-customer').value.trim() || document.getElementById('customer-name').value.trim() || 'Customer';
    const safeCust = custName.replace(/[^a-zA-Z0-9]/g, '_');
    shareElementAsImageNative(targetElement, `PackingSlip-${safeCust}.png`, `📦 Packing Slip - ${custName}`, () => {
        closeModal('slip-modal');
    });
}

function downloadSlipOnlyPDF() {
    const targetElement = document.getElementById('actual-slip-to-render');
    const custName = document.getElementById('slip-customer').value.trim() || document.getElementById('customer-name').value.trim() || 'Customer';
    const safeCust = custName.replace(/[^a-zA-Z0-9]/g, '_');
    downloadElementAsPDF(targetElement, `PackingSlip-${safeCust}.pdf`, () => {
        closeModal('slip-modal');
    });
}

function previewBill(){
  pendingBill = extractPendingBillData();
  generatePreviewHTML(pendingBill);
}

// ============================================================
// INVOICE GENERATOR
// ============================================================
function generatePreviewHTML(bill) {
    let rowsHtml = "";
    bill.items.forEach((it) => {
        rowsHtml += `<tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 8px 6px; font-size: 12.5px; color: #1a1f36; font-weight: 500; width: 44%; word-break: break-word;">${escapeHtmlAttr(it.desc)}</td>
            <td style="padding: 8px 4px; font-size: 12px; color: #8892b0; text-align: center; width: 10%;">${escapeHtmlAttr(it.code || '—')}</td>
            <td style="padding: 8px 4px; font-size: 12.5px; color: #1a1f36; text-align: right; width: 13%;">${escapeHtmlAttr(it.qty)}</td>
            <td style="padding: 8px 4px; font-size: 12.5px; color: #1a1f36; text-align: right; width: 14%;">${escapeHtmlAttr(it.rate)}</td>
            <td style="padding: 8px 6px; font-size: 12.5px; color: #000000; text-align: right; font-weight: 800; width: 19%;">${parseInt(it.amount || 0, 10).toLocaleString('en-IN')}</td>
        </tr>`;
    });

    const bizName = document.getElementById('biz-name').innerText || "Rabi Kapada Pasal";

    let htmlString = `
    <div style="padding: 10px; width: 100%; overflow-x: auto; background: #e2e8f0; -webkit-overflow-scrolling: touch;">
        <div id="actual-bill-to-render" style="width: 560px; min-width: 560px; min-height: 820px; display: flex; flex-direction: column; justify-content: space-between; background: #ffffff; color: #000000; font-family: 'Plus Jakarta Sans', Arial, sans-serif; padding: 35px 30px; margin: 0 auto; box-sizing: border-box; border-radius: 4px; box-shadow: 0 4px 15px rgba(0,0,0,0.08);">
            
            <div>
                <table style="width: 100%; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; margin-bottom: 18px;">
                    <tr>
                        <td style="vertical-align: top;">
                            <h1 style="font-size: 23px; font-weight: 800; color: #1a1f36; margin: 0; letter-spacing: -0.3px;">${escapeHtmlAttr(bizName)}</h1>
                            <p style="font-size: 12px; color: #64748b; margin: 3px 0 0 0;">Wholesale Garment Manufacturer & Distributor</p>
                        </td>
                        <td style="vertical-align: top; text-align: right;">
                            <h2 style="font-size: 19px; color: #a0aec0; margin: 0; letter-spacing: 1px; font-weight: 700;">INVOICE</h2>
                            <p style="font-size: 14px; font-weight: 800; color: #1a1f36; margin: 2px 0 0 0;">#${escapeHtmlAttr(bill.invoiceNum)}</p>
                            ${bill.vatBillNo ? `<p style="font-size: 12px; font-weight: 700; color: #7c3aed; margin: 2px 0 0 0;">VAT Bill No. ${escapeHtmlAttr(bill.vatBillNo)}</p>` : ''}
                            <p style="font-size: 12px; color: #4a5280; margin: 2px 0 0 0;">${escapeHtmlAttr(bill.date)}</p>
                            <p style="font-size: 11px; color: #64748b; margin: 1px 0 0 0;">${escapeHtmlAttr(bill.dateBS || "")}</p>
                        </td>
                    </tr>
                </table>

                <div style="background: #f7f9ff; padding: 12px 14px; border-left: 4px solid #8b5cf6; margin-bottom: 20px; border-radius: 4px; display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <p style="font-size: 10px; font-weight: 700; color: #8892b0; margin: 0 0 3px 0; text-transform: uppercase;">BILL TO:</p>
                        <p style="font-size: 15px; font-weight: 800; color: #1a1f36; margin: 0;">${escapeHtmlAttr(bill.customer)}</p>
                        ${bill.address ? `<p style="font-size: 12px; color: #4a5280; margin: 2px 0 0 0;">${escapeHtmlAttr(bill.address)}</p>` : ''}
                        ${bill.phone ? `<p style="font-size: 12px; color: #4a5280; margin: 2px 0 0 0;">📞 ${escapeHtmlAttr(bill.phone)}</p>` : ''}
                    </div>
                    ${(bill.transportName || bill.biltiNo) ? `
                    <div style="text-align:right;">
                        ${bill.transportName ? `<p style="font-size: 11.5px; font-weight: 700; color: #059669; margin: 0;">🚚 ${escapeHtmlAttr(bill.transportName)}</p>` : ''}
                        ${bill.biltiNo ? `<p style="font-size: 11px; font-weight: 600; color: #4a5280; margin: 3px 0 0 0;">🎫 Bilti/LR: ${escapeHtmlAttr(bill.biltiNo)}</p>` : ''}
                    </div>` : ''}
                </div>

                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; table-layout: fixed;">
                    <thead>
                        <tr style="background: #8b5cf6; color: #ffffff;">
                            <th style="padding: 8px 6px; font-size: 12px; font-weight: 700; text-align: left; width: 44%;">Description</th>
                            <th style="padding: 8px 4px; font-size: 12px; font-weight: 700; text-align: center; width: 10%;">Code</th>
                            <th style="padding: 8px 4px; font-size: 12px; font-weight: 700; text-align: right; width: 13%;">Qty</th>
                            <th style="padding: 8px 4px; font-size: 12px; font-weight: 700; text-align: right; width: 14%;">Rate</th>
                            <th style="padding: 8px 6px; font-size: 12px; font-weight: 700; text-align: right; width: 19%;">Total (NRS)</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>

                <table style="width: 100%; border-collapse: collapse; margin-top: 6px;">
                    <tr>
                        <td style="width: 44%; vertical-align: top; padding-right: 14px;">
                            ${(bill.billNotes && bill.billNotes.length > 0) ? `
                            <div style="padding: 10px 12px; background: #f8fafc; border-left: 3px solid #8b5cf6; border-radius: 4px;">
                                <p style="margin: 0 0 4px 0; font-size: 10px; font-weight: 700; color: #8892b0; text-transform: uppercase;">REMARKS / NOTES:</p>
                                ${bill.billNotes.map(n => `<p style="margin: 2px 0; font-size: 11.5px; color: #4a5280; font-family: monospace;">${escapeHtmlAttr(n.date ? n.date + ' ' : '')}${escapeHtmlAttr(n.text)}</p>`).join('')}
                            </div>` : ''}
                        </td>

                        <td style="width: 56%; vertical-align: top;">
                            <table style="width: 100%; border-collapse: collapse; font-size: 12.5px;">
                                <tr>
                                    <td style="padding: 4px 0; color: #4a5280;">Items Subtotal:</td>
                                    <td style="padding: 4px 0; text-align: right; font-weight: 700; color: #1a1f36;">NRS ${parseInt(document.getElementById('items-total').innerText.replace(/,/g,'') || 0, 10).toLocaleString('en-IN')}</td>
                                </tr>
                                ${parseFloat(bill.transport) > 0 ? `
                                <tr>
                                    <td style="padding: 4px 0; color: #4a5280;">Transport (+):</td>
                                    <td style="padding: 4px 0; text-align: right; color: #1a1f36;">NRS ${parseInt(bill.transport || 0, 10).toLocaleString('en-IN')}</td>
                                </tr>` : ''}
                                ${parseFloat(bill.discount) > 0 ? `
                                <tr>
                                    <td style="padding: 4px 0; color: #dc2626;">Discount (-):</td>
                                    <td style="padding: 4px 0; text-align: right; color: #dc2626;">NRS ${parseInt(bill.discount || 0, 10).toLocaleString('en-IN')}</td>
                                </tr>` : ''}
                                <tr style="background: #f8fafc; font-weight: 700;">
                                    <td style="padding: 6px 4px; color: #1a1f36;">Today's Bill:</td>
                                    <td style="padding: 6px 4px; text-align: right; color: #1a1f36;">NRS ${parseInt(bill.billAmount || 0, 10).toLocaleString('en-IN')}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 4px 0; color: #4a5280;">Purano Baki (+):</td>
                                    <td style="padding: 4px 0; text-align: right; color: #4a5280;">NRS ${parseInt(bill.prevBalance || 0, 10).toLocaleString('en-IN')}</td>
                                </tr>
                                ${parseFloat(bill.totalPoka) > 0 ? `
                                <tr>
                                    <td style="padding: 4px 0; font-weight: 700; color: #4a5280;">📦 Total Poka:</td>
                                    <td style="padding: 4px 0; text-align: right; font-weight: 800; color: #dc2626;">${escapeHtmlAttr(bill.totalPoka)}</td>
                                </tr>` : ''}
                                <tr style="background: #f5f3ff; color: #8b5cf6; font-weight: 700;">
                                    <td style="padding: 6px 4px;">Jamma Total:</td>
                                    <td style="padding: 6px 4px; text-align: right;">NRS ${parseInt(bill.grandTotal || 0, 10).toLocaleString('en-IN')}</td>
                                </tr>
                                <tr style="color: #059669;">
                                    <td style="padding: 4px 0; font-weight: 600;">Nagad Paid (-):</td>
                                    <td style="padding: 4px 0; text-align: right; font-weight: 700;">NRS ${parseInt(bill.paid || 0, 10).toLocaleString('en-IN')}</td>
                                </tr>
                                <tr style="background: #fee2e2; color: #dc2626; font-size: 14px; font-weight: 800;">
                                    <td style="padding: 7px 4px;">Remaining Baki:</td>
                                    <td style="padding: 7px 4px; text-align: right;">NRS ${parseInt(bill.remaining || 0, 10).toLocaleString('en-IN')}</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </div>

            <table style="width: 100%; margin-top: 35px; border-collapse: collapse;">
                <tr>
                    <td style="width: 50%; vertical-align: bottom;">
                        <div style="width: 170px; text-align: left;">
                            <div style="border-top: 1px dashed #cbd5e1; padding-top: 6px; font-size: 10.5px; color: #94a3b8; text-transform: uppercase;">
                                Customer Signature
                            </div>
                        </div>
                    </td>
                    <td style="width: 50%; vertical-align: bottom; text-align: right;">
                        <div style="width: 210px; margin-left: auto; text-align: center;">
                            <img id="bill-sig-img" src="" style="width: 190px; height: 60px; object-fit: contain; display: none; margin-bottom: 2px;" />
                            <button id="sign-btn" onclick="openSignaturePad()" style="width: 100%; padding: 10px 0; border: 1.5px dashed #cbd5e1; background: #f8fafc; border-radius: 6px; cursor: pointer; margin-bottom: 4px; color: #64748b; font-weight: 700; font-size: 11.5px; font-family: inherit;">✏️ Tap to Sign</button>
                            <div style="border-top: 1px solid #cbd5e1; padding-top: 4px; font-size: 10.5px; color: #64748b; text-transform: uppercase;">
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
// COMMIT BILL TO DATABASE
// ============================================================
function commitPendingBillToDatabase() {
    if (!pendingBill) return;
    saveNewItems(pendingBill.items);

    if (editBillKey) {
        const idx = allBills.findIndex(b => b.key === editBillKey);
        if (idx >= 0) {
            const existingPayments = allBills[idx].payments || null;
            allBills[idx] = { ...allBills[idx], ...pendingBill, key: editBillKey };
            if (existingPayments) allBills[idx].payments = existingPayments;
        }
        queueDatabaseWrite('nwh/bills/' + editBillKey, 'update', pendingBill);

        if (editOriginalCustomer && editOriginalCustomer !== pendingBill.customer) {
            recalculateCustomerLedger(editOriginalCustomer);
        }
        recalculateCustomerLedger(pendingBill.customer);
    } else {
        const realBillKey = generateOfflinePushKey('nwh/bills');
        allBills.unshift({ key: realBillKey, ...pendingBill });

        if (!cloudCustomers[pendingBill.customer]) {
            cloudCustomers[pendingBill.customer] = {
                openingBalance: pendingBill.prevBalance || "0"
            };
        }
        cloudCustomers[pendingBill.customer].phone = pendingBill.phone;
        cloudCustomers[pendingBill.customer].address = pendingBill.address;
        cloudCustomers[pendingBill.customer].balance = pendingBill.remaining;

        queueDatabaseWrite('nwh/customers/' + pendingBill.customer, 'set', cloudCustomers[pendingBill.customer]);
        queueDatabaseWrite('nwh/bills/' + realBillKey, 'set', pendingBill);

        cloudNextInvoice = (parseInt(cloudNextInvoice, 10) || 1001) + 1;
        safeSetLocal('nwh_next_inv', String(cloudNextInvoice));
        queueDatabaseWrite('nwh/nextInvoiceNumber', 'set', cloudNextInvoice);
    }
}

function confirmAndDownload() {
    if(!pendingBill) return;
    const billSnap = { ...pendingBill };
    commitPendingBillToDatabase();

    const targetElement = document.getElementById('actual-bill-to-render');
    const signBtnNode = targetElement ? targetElement.querySelector('#sign-btn') : null;
    const prevSignBtnDisplay = signBtnNode ? signBtnNode.style.display : '';
    if (signBtnNode) signBtnNode.style.display = 'none';

    const confirmBtn = document.getElementById('confirm-btn-text');
    if (confirmBtn) confirmBtn.innerText = '⏳ Saving...';

    const safeCust = (billSnap.customer || 'Invoice').replace(/[^a-zA-Z0-9]/g, '_');

    downloadElementAsImage(targetElement, `Invoice-${billSnap.invoiceNum}-${safeCust}.png`, () => {
        if (signBtnNode) signBtnNode.style.display = prevSignBtnDisplay;
        if (confirmBtn) confirmBtn.innerText = '💾 Confirm & PNG';
        closeModal('preview-modal');
        resetFormInputsSilently();
        pendingBill = null;
    });
}

function confirmAndShareNative() {
    if(!pendingBill) return;
    const billSnap = { ...pendingBill };
    commitPendingBillToDatabase();

    const targetElement = document.getElementById('actual-bill-to-render');
    const signBtnNode = targetElement ? targetElement.querySelector('#sign-btn') : null;
    const prevSignBtnDisplay = signBtnNode ? signBtnNode.style.display : '';
    if (signBtnNode) signBtnNode.style.display = 'none';

    const safeCust = (billSnap.customer || 'Invoice').replace(/[^a-zA-Z0-9]/g, '_');
    const caption = `🏪 Rabi Kapada Pasal\n📄 Invoice #${billSnap.invoiceNum}\n👤 ${billSnap.customer}\n🧾 Bill: NRS ${parseInt(billSnap.billAmount||0,10).toLocaleString('en-IN')}\n🔴 Baki: NRS ${parseInt(billSnap.remaining||0,10).toLocaleString('en-IN')}`;

    shareElementAsImageNative(targetElement, `Invoice-${billSnap.invoiceNum}-${safeCust}.png`, caption, () => {
        if (signBtnNode) signBtnNode.style.display = prevSignBtnDisplay;
        closeModal('preview-modal');
        resetFormInputsSilently();
        pendingBill = null;
    });
}

function confirmAndDownloadPDF() {
    if(!pendingBill) return;
    const billSnap = { ...pendingBill };
    commitPendingBillToDatabase();

    const targetElement = document.getElementById('actual-bill-to-render');
    const signBtnNode = targetElement ? targetElement.querySelector('#sign-btn') : null;
    const prevSignBtnDisplay = signBtnNode ? signBtnNode.style.display : '';
    if (signBtnNode) signBtnNode.style.display = 'none';

    const safeCust = (billSnap.customer || 'Invoice').replace(/[^a-zA-Z0-9]/g, '_');

    downloadElementAsPDF(targetElement, `Invoice-${billSnap.invoiceNum}-${safeCust}.pdf`, () => {
        if (signBtnNode) signBtnNode.style.display = prevSignBtnDisplay;
        closeModal('preview-modal');
        resetFormInputsSilently();
        pendingBill = null;
    });
}

function deleteBill(key) {
  const b = allBills.find(x => x.key === key);
  if (!b) return;

  if (confirm(`⚠️ Are you sure you want to delete Invoice #${b.invoiceNum} for ${b.customer}?`)) {
    const custName = b.customer;
    allBills = allBills.filter(x => x.key !== key);
    queueDatabaseWrite('nwh/bills/' + key, 'remove', null);
    recalculateCustomerLedger(custName);
    closeModal('bill-modal');
    renderHistory();
    renderLedger();
  }
}

function deleteCustomer(name) {
    if(!name) return;
    if(confirm(`⚠️ Are you sure you want to delete customer "${name}" and all their bills?`)) {
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
    editOriginalCustomer = bill.customer;

    document.getElementById('customer-name').value = bill.customer || '';
    document.getElementById('customer-phone').value = bill.phone || '';
    document.getElementById('customer-address').value = bill.address || '';
    if (document.getElementById('vat-bill-no')) document.getElementById('vat-bill-no').value = bill.vatBillNo || '';
    if (document.getElementById('transport-name')) document.getElementById('transport-name').value = bill.transportName || '';
    if (document.getElementById('bilti-no')) document.getElementById('bilti-no').value = bill.biltiNo || '';

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
            bill.pokaDetails.forEach(group => addPokaGroup(group.items, group.vat || ''));
        }
    }

    document.getElementById('total-poka').value = bill.totalPoka || '';
    document.getElementById('transport-expense').value = bill.transport || '';
    document.getElementById('discount-amount').value = bill.discount || '';
    document.getElementById('prev-balance').value = bill.prevBalance || '';

    let editModalPaymentsSum = 0;
    if (bill.payments && typeof bill.payments === 'object') {
        Object.values(bill.payments).forEach(p => {
            if (p) editModalPaymentsSum += (parseFloat(p.amount) || 0);
        });
    }
    const initialCashPaid = Math.max(0, (parseFloat(bill.paid) || 0) - editModalPaymentsSum);
    document.getElementById('cash-paid').value = initialCashPaid || '';

    document.getElementById('invoice-number').innerText = bill.invoiceNum;
    document.getElementById('tab-invoice').innerHTML = `🧾 <span style="color:var(--red);">Editing #${bill.invoiceNum}</span>`;

    calc();
    closeModal('bill-modal');
    switchTab('invoice');
}

// ============================================================
// PAYMENT AUDIT TRAIL & REVERSAL
// ============================================================
function reverseBillPayment(billKey, payId) {
    const b = allBills.find(x => x.key === billKey);
    if (!b || !b.payments || !b.payments[payId]) return;
    const p = b.payments[payId];
    const amt = parseFloat(p.amount) || 0;

    if (!confirm(`Reverse payment of NRS ${amt.toLocaleString('en-IN')} (${p.date || ''})?`)) return;

    b.paid = String(Math.max(0, (parseFloat(b.paid) || 0) - amt));
    delete b.payments[payId];

    queueDatabaseWrite(`nwh/bills/${billKey}/payments/${payId}`, 'remove', null);
    queueDatabaseWrite(`nwh/bills/${billKey}/paid`, 'set', b.paid);

    recalculateCustomerLedger(b.customer);
    closeModal('bill-modal');
    renderHistory();
    renderLedger();
}

function showBillDetail(key){
  const b=allBills.find(x=>x.key===key);if(!b) return;
  document.getElementById('modal-title').innerText=`Invoice #${b.invoiceNum} — ${b.customer}`;

  let iHtml='';
  if(b.items&&b.items.length){
    iHtml=`<div style="margin:12px 0;border:1px solid var(--border);border-radius:10px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:.79rem;"><thead><tr style="background:var(--surface2);"><th style="padding:7px 10px;text-align:left;">Item</th><th style="padding:7px 10px;text-align:right;">Qty</th><th style="padding:7px 10px;text-align:right;">Rate</th><th style="padding:7px 10px;text-align:right;">Total</th></tr></thead><tbody>`;
    b.items.forEach(it=>{iHtml+=`<tr style="border-top:1px solid var(--border)"><td style="padding:6px 10px">${escapeHtmlAttr(it.desc)}</td><td style="padding:6px 10px;text-align:right">${escapeHtmlAttr(it.qty)}</td><td style="padding:6px 10px;text-align:right">${escapeHtmlAttr(it.rate||'')}</td><td style="padding:6px 10px;text-align:right;font-weight:500">${parseInt(it.amount||0, 10).toLocaleString('en-IN')}</td></tr>`;});
    iHtml+='</tbody></table></div>';
  }

  let payHistoryHtml = '';
  if (b.payments && typeof b.payments === 'object' && Object.keys(b.payments).length > 0) {
      payHistoryHtml = `<div class="sec-div">Recorded Payments</div>`;
      Object.entries(b.payments).forEach(([pid, p]) => {
          if (!p) return;
          payHistoryHtml += `<div class="d-row" style="align-items:center;">
              <span>${escapeHtmlAttr(p.date || '')} • <strong>${escapeHtmlAttr(p.mode || 'Cash')}</strong> ${p.note ? `(${escapeHtmlAttr(p.note)})` : ''}</span>
              <span style="display:flex;align-items:center;gap:8px;">
                  <strong style="color:var(--green);">NRS ${parseInt(p.amount||0,10).toLocaleString('en-IN')}</strong>
                  <button class="btn btn-red btn-sm" onclick="reverseBillPayment('${key}','${escapeJsStr(pid)}')" title="Reverse Payment">↩️</button>
              </span>
          </div>`;
      });
  }

  const baki=parseInt(b.remaining, 10)||0;

  document.getElementById('modal-body').innerHTML=`
    <div class="d-row"><span class="d-label">Date</span><span class="d-val">${escapeHtmlAttr(b.date)} / ${escapeHtmlAttr(b.dateBS||'')}</span></div>
    ${b.vatBillNo ? `<div class="d-row"><span class="d-label" style="color:var(--accent);">VAT Bill #</span><span class="d-val" style="color:var(--accent);">${escapeHtmlAttr(b.vatBillNo)}</span></div>` : ''}
    ${b.transportName ? `<div class="d-row"><span class="d-label">🚚 Transport</span><span class="d-val">${escapeHtmlAttr(b.transportName)} ${b.biltiNo ? `(Bilti: ${escapeHtmlAttr(b.biltiNo)})` : ''}</span></div>` : ''}
    ${iHtml}
    <div class="d-row"><span class="d-label">Bill Amount</span><span class="d-val">NRS ${parseInt(b.billAmount||0, 10).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label">Purano Baki</span><span class="d-val">NRS ${parseInt(b.prevBalance || 0, 10).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label">Paid</span><span class="d-val" style="color:var(--green)">NRS ${parseInt(b.paid||0, 10).toLocaleString('en-IN')}</span></div>
    <div class="d-row"><span class="d-label" style="color:var(--red)">Remaining</span><span class="d-val" style="color:var(--red)">NRS ${baki.toLocaleString('en-IN')}</span></div>
    ${payHistoryHtml}
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

  let custPaymentsHtml = '';
  const custBills = getCustomerBillsChronological(name);
  const recentPayments = [];
  custBills.forEach(b => {
      if (b.payments && typeof b.payments === 'object') {
          Object.entries(b.payments).forEach(([pid, p]) => {
              if (p) recentPayments.push({ billKey: b.key, invNum: b.invoiceNum, pid, ...p });
          });
      }
  });

  if (recentPayments.length > 0) {
      custPaymentsHtml = `<div class="sec-div">Recent Ledger Payments</div>`;
      recentPayments.slice(-5).reverse().forEach(p => {
          custPaymentsHtml += `<div class="d-row" style="align-items:center;font-size:0.8rem;">
              <span>${escapeHtmlAttr(p.date || '')} (${escapeHtmlAttr(p.mode || 'Cash')}) #${escapeHtmlAttr(p.invNum)}</span>
              <span style="display:flex;align-items:center;gap:6px;">
                  <strong style="color:var(--green);">NRS ${parseInt(p.amount||0,10).toLocaleString('en-IN')}</strong>
                  <button class="btn btn-red btn-sm" onclick="reverseBillPayment('${p.billKey}','${escapeJsStr(p.pid)}')">↩️</button>
              </span>
          </div>`;
      });
  }

  document.getElementById('modal-title').innerText=`👤 ${name}`;
  document.getElementById('modal-body').innerHTML=`
    <div class="d-row"><span class="d-label">📞 Phone</span><span class="d-val">${escapeHtmlAttr(cu.phone||'—')}</span></div>
    <div class="d-row"><span class="d-label">📍 Address</span><span class="d-val">${escapeHtmlAttr(cu.address||'—')}</span></div>
    <div class="d-row" style="font-size:.92rem;font-weight:700"><span class="d-label" style="color:${baki>0?'var(--red)':'var(--green)'}">🔴 Total Baki</span><span class="d-val" style="color:${baki>0?'var(--red)':'var(--green)'}">NRS ${baki.toLocaleString('en-IN')}</span></div>
    ${custPaymentsHtml}
    <button class="btn btn-ghost" style="width:100%; justify-content:center; margin-top:12px; border-color:var(--accent); color:var(--accent);" onclick="showLedgerStatement('${safeName}')">📜 View Statement of Account</button>
    <button class="btn btn-ghost" style="width:100%; justify-content:center; margin-top:8px;" onclick="openLedgerAdjustmentModal('${safeName}')">⚖️ Adjust / Fix Legacy Baki</button>
    ${baki>0?`<button class="btn btn-green" style="width:100%;justify-content:center;margin-top:8px;" onclick="payFromLedger('${safeName}',${baki})">💰 Record Payment (FIFO)</button>`:''}
    <button class="btn btn-red" style="width:100%;justify-content:center;margin-top:8px;" onclick="deleteCustomer('${safeName}')">🗑️ Delete Customer</button>
  `;
  document.getElementById('bill-modal').classList.add('open');
}

// ============================================================
// CHRONOLOGICAL STATEMENT OF ACCOUNT (UPGRADED)
// ============================================================
let _activeStatementCust = '';

function refreshCurrentStatement() {
    if (_activeStatementCust) {
        showLedgerStatement(_activeStatementCust);
    }
}

function formatDualDateCell(adDateStr) {
    if (!adDateStr || adDateStr === '—') return '—';
    const parts = adDateStr.split('-').map(Number);
    if (parts.length === 3 && !isNaN(parts[0])) {
        const bs = adToBS(parts[0], parts[1], parts[2]);
        if (bs) {
            return `<div style="font-weight:600;color:#1a1f36;">${escapeHtmlAttr(adDateStr)}</div><div style="font-size:10px;color:#64748b;font-family:'Tiro Devanagari Hindi',serif;">${bs.day} ${bs.monthName} ${bs.year}</div>`;
        }
    }
    return escapeHtmlAttr(adDateStr);
}

function showLedgerStatement(custName) {
    _activeStatementCust = custName;
    document.getElementById('ls-cust-name').innerText = custName;
    const cu = cloudCustomers[custName] || {};
    let subInfo = [];
    if (cu.address) subInfo.push(cu.address);
    if (cu.phone) subInfo.push('📞 ' + cu.phone);
    document.getElementById('ls-cust-sub').innerText = subInfo.join(' • ');

    const rangeMode = document.getElementById('ls-range-filter') ? document.getElementById('ls-range-filter').value : 'all';
    let cutoffDate = '';
    let periodText = 'Period: All Time';

    if (rangeMode === '30d') {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        cutoffDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        periodText = `From ${cutoffDate} to Today`;
    } else if (rangeMode === 'month') {
        const d = new Date();
        cutoffDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        periodText = `This Month (${cutoffDate} – Today)`;
    }

    const periodEl = document.getElementById('ls-period-label');
    if (periodEl) periodEl.innerText = periodText;

    const list = document.getElementById('ledger-statement-list');
    if (!list) return;
    list.innerHTML = '';

    let events = [];
    const custBills = getCustomerBillsChronological(custName);
    const openingBal = getCustomerOpeningBalance(custName, custBills);

    custBills.forEach((b, idx) => {
        const billTotal = parseFloat(b.billAmount) || 0;
        const totalPaidOnBill = parseFloat(b.paid) || 0;
        const billInvSeq = parseInt(b.invoiceNum, 10) || (idx + 1);

        let detailsLabel = `<strong>Invoice #${escapeHtmlAttr(b.invoiceNum || 'N/A')}</strong>`;
        if (b.vatBillNo) detailsLabel += ` <span style="color:#7c3aed;font-size:10.5px;">(VAT: ${escapeHtmlAttr(b.vatBillNo)})</span>`;
        if (b.transportName) detailsLabel += `<div style="font-size:10px;color:#64748b;">🚚 ${escapeHtmlAttr(b.transportName)}${b.biltiNo ? ' • Bilti: ' + escapeHtmlAttr(b.biltiNo) : ''}</div>`;

        events.push({
            date: b.date || '—',
            seq: billInvSeq * 1000,
            descHtml: detailsLabel,
            debit: billTotal,
            credit: 0
        });

        let modalPaymentsSum = 0;
        if (b.payments && typeof b.payments === 'object') {
            Object.values(b.payments).forEach((p, pIdx) => {
                if (!p) return;
                const amt = parseFloat(p.amount) || 0;
                modalPaymentsSum += amt;
                const pDate = p.date || b.date || '—';
                const seqNum = (pDate === b.date)
                    ? (billInvSeq * 1000 + 200 + pIdx)
                    : (billInvSeq * 1000 + 500 + pIdx);

                events.push({
                    date: pDate,
                    seq: seqNum,
                    descHtml: `Payment Received <span style="color:#059669;font-weight:600;">(${escapeHtmlAttr(p.mode || 'Cash')})</span>${p.note ? `<div style="font-size:10px;color:#64748b;">${escapeHtmlAttr(p.note)}</div>` : ''}`,
                    debit: 0,
                    credit: amt
                });
            });
        }

        const initialPaid = Math.max(0, Math.round(totalPaidOnBill - modalPaymentsSum));
        if (initialPaid > 0) {
            events.push({
                date: b.cashPaidDate || b.date || '—',
                seq: billInvSeq * 1000 + 100,
                descHtml: `Cash Paid on Bill #${escapeHtmlAttr(b.invoiceNum || '')}`,
                debit: 0,
                credit: initialPaid
            });
        }
    });

    events.sort((a, b) => {
        const dateCmp = String(a.date).localeCompare(String(b.date));
        if (dateCmp !== 0) return dateCmp;
        return a.seq - b.seq;
    });

    let runningBal = openingBal;
    const visibleEvents = [];

    events.forEach(e => {
        if (cutoffDate && e.date !== '—' && e.date < cutoffDate) {
            runningBal += e.debit;
            runningBal -= e.credit;
        } else {
            visibleEvents.push(e);
        }
    });

    let totalDebit = 0;
    let totalCredit = 0;

    let listHtml = `<tr style="border-bottom:1px solid #e2e8f0; background:#f8fafc;">
        <td style="padding:8px;">—</td>
        <td style="padding:8px; font-weight:700; color:#4a5280;">${cutoffDate ? 'Balance Brought Forward (B/F)' : 'Opening Balance (Purano Baki)'}</td>
        <td style="text-align:right; padding:8px;">${runningBal > 0 ? Math.round(runningBal).toLocaleString('en-IN') : '—'}</td>
        <td style="text-align:right; padding:8px;">—</td>
        <td style="text-align:right; font-weight:800; padding:8px; color:#1a1f36;">${Math.round(runningBal).toLocaleString('en-IN')}</td>
    </tr>`;

    visibleEvents.forEach((e, i) => {
        runningBal += e.debit;
        runningBal -= e.credit;
        totalDebit += e.debit;
        totalCredit += e.credit;
        const rowBg = i % 2 === 1 ? '#fafbff' : '#ffffff';

        listHtml += `<tr style="border-bottom:1px solid #f1f5f9; background:${rowBg};">
            <td style="padding:8px; vertical-align:top;">${formatDualDateCell(e.date)}</td>
            <td style="padding:8px; vertical-align:top;">${e.descHtml}</td>
            <td style="text-align:right; padding:8px; vertical-align:top; font-weight:600; color:#1a1f36;">${e.debit > 0 ? Math.round(e.debit).toLocaleString('en-IN') : ''}</td>
            <td style="text-align:right; padding:8px; vertical-align:top; color:#059669; font-weight:700;">${e.credit > 0 ? Math.round(e.credit).toLocaleString('en-IN') : ''}</td>
            <td style="text-align:right; padding:8px; vertical-align:top; font-weight:800; color:${runningBal > 0 ? '#dc2626' : '#059669'};">${Math.round(runningBal).toLocaleString('en-IN')}</td>
        </tr>`;
    });

    list.innerHTML = listHtml;

    const netBal = Math.round(runningBal);
    const closingEl = document.getElementById('ls-closing-bal');
    if (closingEl) {
        closingEl.innerText = `NRS ${netBal.toLocaleString('en-IN')}`;
        closingEl.style.color = netBal > 0 ? '#dc2626' : '#059669';
    }
    if (document.getElementById('ls-sum-debit')) document.getElementById('ls-sum-debit').innerText = `NRS ${Math.round(totalDebit).toLocaleString('en-IN')}`;
    if (document.getElementById('ls-sum-credit')) document.getElementById('ls-sum-credit').innerText = `NRS ${Math.round(totalCredit).toLocaleString('en-IN')}`;
    if (document.getElementById('ls-sum-net')) document.getElementById('ls-sum-net').innerText = `NRS ${netBal.toLocaleString('en-IN')}`;

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
        if (btn) btn.innerText = '🖼️ Save PNG';
    });
}

function shareStatementImageNative() {
    const targetElement = document.getElementById('ledger-statement-render');
    const custName = document.getElementById('ls-cust-name').innerText || 'Customer';
    const safeCust = custName.replace(/[^a-zA-Z0-9]/g, '_');
    const baki = getCustomerTrueBalance(custName);
    shareElementAsImageNative(targetElement, `Statement-${safeCust}.png`, `📜 Statement of Account - ${custName} (Closing Due: NRS ${baki.toLocaleString('en-IN')})`);
}

function downloadLedgerStatementPDF() {
    const targetElement = document.getElementById('ledger-statement-render');
    const custName = document.getElementById('ls-cust-name').innerText || 'Customer';
    const safeCust = custName.replace(/[^a-zA-Z0-9]/g, '_');
    downloadElementAsPDF(targetElement, `Statement-${safeCust}.pdf`);
}

function payFromLedger(name, baki){
  _payCust = name;
  _payKey = '';

  document.getElementById('pay-modal-title').innerText = `💰 Payment — ${name}`;
  document.getElementById('pay-baki-display').innerText = `NRS ${Math.round(baki).toLocaleString('en-IN')}`;
  document.getElementById('pay-amount-inp').value = '';
  document.getElementById('pay-note-inp').value = '';
  document.getElementById('pay-date-inp').value = todayStr;
  if (document.getElementById('pay-mode-inp')) document.getElementById('pay-mode-inp').value = 'Cash';

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
  if (document.getElementById('pay-mode-inp')) document.getElementById('pay-mode-inp').value = 'Cash';

  closeModal('bill-modal');
  document.getElementById('pay-modal').classList.add('open');
}

// ============================================================
// TRUE MULTI-BILL FIFO PAYMENT ALLOCATION
// ============================================================
function applyPaymentToSingleBill(bill, allocAmt, payDate, payMode, note) {
    const payId = generateOfflinePushKey(`nwh/bills/${bill.key}/payments`);
    const newPaid = Math.round((parseFloat(bill.paid) || 0) + allocAmt);
    const entry = { amount: Math.round(allocAmt), date: payDate, mode: payMode, note };

    bill.paid = newPaid.toString();
    if (!bill.payments || typeof bill.payments !== 'object') bill.payments = {};
    bill.payments[payId] = entry;

    queueDatabaseWrite(`nwh/bills/${bill.key}/paid`, 'set', newPaid.toString());
    queueDatabaseWrite(`nwh/bills/${bill.key}/payments/${payId}`, 'set', entry);
}

function confirmPayment(){
  const amount = parseFloat(document.getElementById('pay-amount-inp').value) || 0;
  const note = document.getElementById('pay-note-inp').value.trim();
  const payDate = document.getElementById('pay-date-inp').value || todayStr;
  const payMode = document.getElementById('pay-mode-inp') ? document.getElementById('pay-mode-inp').value : 'Cash';

  if(amount <= 0){ alert('Enter a valid amount'); return; }

  const custBills = _payCust ? getCustomerBillsChronological(_payCust) : [];

  if (_payKey) {
      const specificBill = allBills.find(b => b.key === _payKey);
      if (specificBill) {
          const billOwnUnpaid = Math.max(0, (parseFloat(specificBill.billAmount) || 0) - (parseFloat(specificBill.paid) || 0));
          const directAlloc = custBills.length > 1 && billOwnUnpaid > 0 ? Math.min(amount, billOwnUnpaid) : amount;
          applyPaymentToSingleBill(specificBill, directAlloc, payDate, payMode, note);

          let leftover = amount - directAlloc;
          if (leftover > 0 && custBills.length > 1) {
              for (const b of custBills) {
                  if (b.key === specificBill.key || leftover <= 0) continue;
                  const bUnpaid = Math.max(0, (parseFloat(b.billAmount) || 0) - (parseFloat(b.paid) || 0));
                  if (bUnpaid > 0) {
                      const spill = Math.min(leftover, bUnpaid);
                      applyPaymentToSingleBill(b, spill, payDate, payMode, note);
                      leftover -= spill;
                  }
              }
              if (leftover > 0) {
                  const latest = custBills[custBills.length - 1];
                  applyPaymentToSingleBill(latest, leftover, payDate, payMode, note);
              }
          }
      }
  } else if (custBills.length > 0) {
      let remainingToAllocate = amount;
      for (const b of custBills) {
          if (remainingToAllocate <= 0) break;
          const bOwnUnpaid = Math.max(0, (parseFloat(b.billAmount) || 0) - (parseFloat(b.paid) || 0));
          if (bOwnUnpaid > 0) {
              const alloc = Math.min(remainingToAllocate, bOwnUnpaid);
              applyPaymentToSingleBill(b, alloc, payDate, payMode, note);
              remainingToAllocate -= alloc;
          }
      }
      if (remainingToAllocate > 0) {
          const latestBill = custBills[custBills.length - 1];
          applyPaymentToSingleBill(latestBill, remainingToAllocate, payDate, payMode, note);
      }
  }

  let finalBal = 0;
  if (_payCust) {
      if (custBills.length > 0) {
          finalBal = recalculateCustomerLedger(_payCust);
      } else {
          const currentCustBal = getCustomerTrueBalance(_payCust);
          finalBal = Math.max(0, Math.round(currentCustBal - amount));
          if (!cloudCustomers[_payCust]) cloudCustomers[_payCust] = {};
          cloudCustomers[_payCust].balance = finalBal.toString();
          cloudCustomers[_payCust].openingBalance = finalBal.toString();
          queueDatabaseWrite('nwh/customers/' + _payCust, 'set', cloudCustomers[_payCust]);
      }

      document.getElementById('rec-date').innerText = payDate;
      document.getElementById('rec-cust').innerText = _payCust;
      if (document.getElementById('rec-mode')) document.getElementById('rec-mode').innerText = payMode;
      document.getElementById('rec-amt').innerText = Math.round(amount).toLocaleString('en-IN');
      document.getElementById('rec-baki').innerText = Math.round(finalBal).toLocaleString('en-IN');
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
    const mode = document.getElementById('rec-mode') ? document.getElementById('rec-mode').innerText : 'Cash';
    const note = document.getElementById('rec-note').innerText;
    let msg = `🏪 *Rabi Kapada Pasal*\n✅ Payment Received: *NRS ${amt}* (${mode})\n🔴 Remaining Baki: *NRS ${baki}*`;
    if(note !== '—') msg += `\n📝 Note: ${note}`;

    const phone = cloudCustomers[_payCust]?.phone || '';
    window.open('https://wa.me/'+phone.replace(/\D/g,'')+'?text='+encodeURIComponent(msg),'_blank');
}

function shareReceiptImageNative() {
    const targetElement = document.getElementById('thermal-receipt');
    const safeCustName = (_payCust || 'Customer').replace(/[^a-zA-Z0-9]/g, '_');
    const amt = document.getElementById('rec-amt').innerText;
    shareElementAsImageNative(targetElement, `Receipt-${safeCustName}.png`, `✅ Payment Receipt: NRS ${amt} - ${_payCust}`);
}

function downloadReceiptImage() {
    const targetElement = document.getElementById('thermal-receipt');
    const btn = document.querySelector('#receipt-modal .btn-primary');
    if (btn) btn.innerText = '⏳ Saving...';

    const safeCustName = (_payCust || 'Customer').replace(/[^a-zA-Z0-9]/g, '_');
    downloadElementAsImage(targetElement, `Receipt-${safeCustName}.png`, () => {
        if (btn) btn.innerText = '🖼️ Save PNG';
    });
}

function closeModal(id){document.getElementById(id).classList.remove('open');}

function renderHistory(){
  const c=document.getElementById('history-container');
  if(!c) return;
  if(!allBills || !allBills.length) return c.innerHTML=`<div class="empty-state">No bills yet</div>`;

  let html=`<table class="h-table"><thead><tr><th>#</th><th>Customer</th><th>Bill</th><th>Paid</th><th>Baki</th></tr></thead><tbody>`;
  allBills.forEach(b=>{
    const baki=parseInt(b.remaining, 10)||0;
    html+=`<tr onclick="showBillDetail('${b.key}')">
      <td><span style="font-weight:700;color:var(--accent)">#${escapeHtmlAttr(b.invoiceNum)}</span><br><span style="font-size:10px">${escapeHtmlAttr(b.date)}</span></td>
      <td><strong>${escapeHtmlAttr(b.customer)}</strong>${b.transportName ? `<br><span style="font-size:10px;color:var(--text3);">🚚 ${escapeHtmlAttr(b.transportName)}</span>` : ''}</td>
      <td>NRS ${parseInt(b.billAmount || 0, 10).toLocaleString('en-IN')}</td>
      <td style="color:var(--green)">${parseInt(b.paid || 0, 10).toLocaleString('en-IN')}</td>
      <td><span class="badge ${baki>0?'b-red':'b-green'}">${baki.toLocaleString('en-IN')}</span></td>
    </tr>`;
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

  let totalMarketBaki = 0;
  let html = '';
  Array.from(allCustNames).sort().forEach(name => {
    const cu = cloudCustomers[name] || {};
    const baki = getCustomerTrueBalance(name);
    if (baki > 0) totalMarketBaki += baki;
    const safeName = escapeJsStr(name);
    const attrName = escapeHtmlAttr(name);
    html += `<div class="ledger-card" onclick="showCustDetail('${safeName}')"><div style="flex:1; pointer-events:none;"><div class="lc-name">${attrName}</div><div class="lc-phone" style="margin-top:2px;">${escapeHtmlAttr(cu.phone||'—')}</div></div><div style="text-align:right; pointer-events:none;"><div class="lc-baki ${baki>0?'due':'ok'}">NRS ${Math.round(baki).toLocaleString('en-IN')}</div><span class="badge ${baki>0?'b-red':'b-green'}">${baki>0?'Due':'Cleared'}</span></div></div>`;
  });
  c.innerHTML = html;

  const totalBadge = document.getElementById('ledger-total-badge');
  if (totalBadge) {
      totalBadge.innerText = `Total Due: NRS ${Math.round(totalMarketBaki).toLocaleString('en-IN')}`;
  }
}

// ============================================================
// SERVICE WORKER REGISTRATION
// ============================================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('ServiceWorker registration failed:', err);
    });
  });
}
