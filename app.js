// ============================================================
// RABI KAPADA PASAL - CLOUD BILLING ENGINE (v43.2 FINAL)
// ============================================================

// ============================================================
// SAFE STORAGE, SERIALIZED INDEXEDDB ENGINE & ESCAPING UTILITIES
// ============================================================
function safeGetLocal(k) { try { return localStorage.getItem(k); } catch(e) { return null; } }
function safeSetLocal(k, v) { try { localStorage.setItem(k, v); } catch(e) {} }

function escapeJsStr(str) {
    return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
function escapeHtmlAttr(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Serialized IndexedDB Wrapper (Prevents concurrent store.clear() race conditions)
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

// Offline-capable Firebase Push ID Generator (identical 20-char sortable format to Firebase SDK)
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

let editBillKey = null;
let editInvoiceNum = null;
let editOriginalCustomer = null;
let editModalPaymentsSum = 0;
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
// PIN LOCK LOGIC (SHA-256 HASHED PIN + DEFERRED FIREBASE INIT)
// ============================================================
let pinCode = '';
const PIN_SHA256 = 'a7e1f1e3f8f3b283978d570632807a495c510d5d51137d8c2291167c53852d85';

async function sha256Hex(str) {
    if (window.crypto && window.crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return str === '8860' ? PIN_SHA256 : '';
}

function unlockAppSession() {
    isUnlocked = true;
    const pw = document.getElementById('pw-screen');
    if (pw) pw.style.display = 'none';
    resetPinState();
    startFirebase();
}

async function pinPress(num) {
  if (pinCode.length < 4) {
    pinCode += num;
    const dot = document.getElementById('d' + (pinCode.length - 1));
    if (dot) dot.classList.add('filled');
  }

  if (pinCode.length === 4) {
    const entered = pinCode;
    const hash = await sha256Hex(entered);
    if (hash === PIN_SHA256 || entered === '8860') {
      sessionStorage.setItem('rkp_unlocked', '1');
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
// NON-BLOCKING OFFLINE OUTBOX QUEUE (SERIALIZED INDEXEDDB)
// ============================================================
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
        console.error("Sync error on item:", item, err);
        const msg = String(err && (err.code || err.message || err)).toUpperCase();
        // Quarantine rejected writes (e.g., updating a bill deleted on another device) so queue never freezes
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
// DETERMINISTIC CUSTOMER LEDGER & TRUE FIFO RECONCILIATION
// ============================================================
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
// CUSTOMER AUTO-FILL LOGIC
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

// ============================================================
// NORMALIZED CATALOG HELPERS (STRING + OBJECT COMPATIBLE)
// ============================================================
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

    if (sessionStorage.getItem('rkp_unlocked') === '1') {
        unlockAppSession();
    }
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
// FIREBASE CONNECTION (CALLED ONLY AFTER PIN UNLOCK)
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
// CATALOG & MEMORY (DOES NOT POLLUTE BASE RATE WITH CUSTOM DEALS)
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
// PRODUCT CATALOG UI MANAGEMENT (WITH CODE & BASE RATE)
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
// CAMERA BARCODE & QR SCANNER FOR S23 ULTRA
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
// POKA BUNDLING (OCTAL-SAFE MATH, ESCAPED ATTRS, IDEMPOTENT SYNC)
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
                last
