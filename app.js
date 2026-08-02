async function pickPhoneContact(){
  if('contacts' in navigator && 'ContactsManager' in window){
    try {
      const c = await navigator.contacts.select(['name', 'tel'], { multiple: false });
      if(c && c.length > 0){
        // 1. Extract & clean Name
        let name = (c[0].name && c[0].name.length > 0) ? c[0].name[0] : '';
        name = name.replace(/[.#$\[\]]/g, ' ').trim(); 
        document.getElementById('customer-name').value = name;

        // 2. Safely extract Phone Number
        let phone = '';
        if (c[0].tel && Array.isArray(c[0].tel) && c[0].tel.length > 0) {
          phone = c[0].tel[0];
        } else if (typeof c[0].tel === 'string') {
          phone = c[0].tel;
        }

        // 3. Clean up spaces, dashes, and parentheses (e.g., "980-123 4567" -> "9801234567")
        phone = phone.replace(/[\s\-\(\)]/g, '');

        document.getElementById('customer-phone').value = phone;

        // 4. Auto-fill saved customer ledger info if they exist in Firebase
        if(name && cloudCustomers[name]){
            document.getElementById('customer-address').value = cloudCustomers[name].address || '';
            document.getElementById('prev-balance').value = cloudCustomers[name].balance || '0';
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
