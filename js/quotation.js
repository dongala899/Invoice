// js/quotation.js — Quotation Generator module

/**
 * generateFY(date)
 * Returns a "YY-YY" financial year string using April–March boundaries.
 * April–December: FY starts that calendar year  (e.g. May 2025  → "25-26")
 * January–March:  FY started the previous year  (e.g. Jan 2026  → "25-26")
 * @param {Date} date
 * @returns {string}
 */
function generateFY(date) {
  const year  = date.getFullYear();
  const month = date.getMonth() + 1; // 1-based

  const fyStart = month >= 4 ? year : year - 1;
  const fyEnd   = fyStart + 1;

  const yy1 = String(fyStart).slice(-2);
  const yy2 = String(fyEnd).slice(-2);
  return `${yy1}-${yy2}`;
}

/**
 * generateRefNumber(seq, customerCode, fy)
 * Returns a reference number in the format "DDIS/<seq>/<customerCode>/<fy>".
 * seq is zero-padded to at least two digits.
 * @param {number} seq
 * @param {string} customerCode
 * @param {string} fy
 * @returns {string}
 */
function generateRefNumber(seq, customerCode, fy) {
  const paddedSeq = String(seq).padStart(2, '0');
  return `DDIS/${paddedSeq}/${customerCode}/${fy}`;
}

/**
 * computeLineItemTotals(unitPrice, qty, taxPct)
 * Returns { total, taxAmount, totalAmount } for a single line item.
 * total       = unitPrice × qty
 * taxAmount   = total × taxPct / 100
 * totalAmount = total + taxAmount
 * @param {number} unitPrice
 * @param {number} qty
 * @param {number} taxPct
 * @returns {{ total: number, taxAmount: number, totalAmount: number }}
 */
function computeLineItemTotals(unitPrice, qty, taxPct) {
  const total       = unitPrice * qty;
  const taxAmount   = total * taxPct / 100;
  const totalAmount = total + taxAmount;
  return { total, taxAmount, totalAmount };
}

/**
 * computeGrandTotal(lineItems)
 * Returns the sum of all totalAmount values across the line items array.
 * @param {Array<{ totalAmount: number }>} lineItems
 * @returns {number}
 */
function computeGrandTotal(lineItems) {
  return lineItems.reduce((sum, item) => sum + item.totalAmount, 0);
}

// Expose pure utility functions on window so other scripts can call them
window.generateFY             = generateFY;
window.generateRefNumber      = generateRefNumber;
window.computeLineItemTotals  = computeLineItemTotals;
window.computeGrandTotal      = computeGrandTotal;

// ---------------------------------------------------------------------------
// Storage and sequence counter functions
// ---------------------------------------------------------------------------

/**
 * getNextSequence(fy)
 * Reads quotationCounters from localStorage, increments the counter for the
 * given FY string (treats missing as 0), persists the updated counters, and
 * returns the new counter value as a zero-padded two-digit string.
 * @param {string} fy  e.g. "25-26"
 * @returns {string}   e.g. "01", "02", …
 */
function getNextSequence(fy) {
  let counters = {};
  try {
    const raw = localStorage.getItem('quotationCounters');
    if (raw) counters = JSON.parse(raw);
  } catch (_) {
    counters = {};
  }

  const current = typeof counters[fy] === 'number' ? counters[fy] : 0;
  const next = current + 1;
  counters[fy] = next;

  localStorage.setItem('quotationCounters', JSON.stringify(counters));
  return String(next).padStart(2, '0');
}

/**
 * getSafeQuotations()
 * Reads the `quotations` key from localStorage and returns the parsed array.
 * Returns [] on any error (missing key, parse failure, etc.).
 * @returns {Array}
 */
function getSafeQuotations() {
  try {
    const raw = localStorage.getItem('quotations');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * persistQuotations(quotations)
 * JSON-stringifies the array and writes it to localStorage under key `quotations`.
 * The file-storage bridge auto-syncs on setItem — no extra trigger needed.
 * @param {Array} quotations
 */
function persistQuotations(quotations) {
  localStorage.setItem('quotations', JSON.stringify(quotations));
}

// Expose storage/sequence functions on window
window.getNextSequence    = getNextSequence;
window.getSafeQuotations  = getSafeQuotations;
window.persistQuotations  = persistQuotations;

// ---------------------------------------------------------------------------
// Draft items state and saveQuotation / resetQuotationForm
// ---------------------------------------------------------------------------

let quotationDraftItems = [];
let editingQuotationRef = null;

function formatQuotationCurrency(value) {
  const amount = Number(value) || 0;
  return `\u20B9${amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function syncQuotationEditUi() {
  const actionBtn = document.getElementById('quotActionBtn');
  const cancelBtn = document.getElementById('quotCancelEditBtn');
  const refNumberDisplay = document.getElementById('quotRefNumber');

  if (actionBtn) {
    actionBtn.textContent = editingQuotationRef ? 'Update Quotation' : 'Save Quotation';
  }
  if (cancelBtn) {
    cancelBtn.style.display = editingQuotationRef ? '' : 'none';
  }
  if (refNumberDisplay) {
    refNumberDisplay.placeholder = editingQuotationRef
      ? 'Reference number locked while editing'
      : 'Auto-generated on save';
  }
}

/**
 * resetQuotationForm()
 * Clears the quotation form back to its default state:
 * - Empties the draft items array
 * - Resets customer selector to empty
 * - Clears customer code input
 * - Sets date field to today
 * - Resets covering letter and business terms to their default templates
 * - Clears the reference number display field
 */
function resetQuotationForm() {
  quotationDraftItems = [];
  editingQuotationRef = null;

  const customerSelect = document.getElementById('quotCustomer');
  if (customerSelect) customerSelect.value = '';

  const customerCodeInput = document.getElementById('quotCustomerCode');
  if (customerCodeInput) customerCodeInput.value = '';

  const dateInput = document.getElementById('quotDate');
  if (dateInput) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm   = String(today.getMonth() + 1).padStart(2, '0');
    const dd   = String(today.getDate()).padStart(2, '0');
    dateInput.value = `${yyyy}-${mm}-${dd}`;
  }

  const coveringLetterTextarea = document.getElementById('quotCoveringLetter');
  if (coveringLetterTextarea) {
    coveringLetterTextarea.value =
      'Dear Sir/Madam,\n\nWe are pleased to submit our quotation for your kind consideration.\n\nWe hope you will find our offer competitive and look forward to your valued order.\n\nThanking you,\nYours faithfully,\nFor DigiDat InfoSystems';
  }

  const businessTermsTextarea = document.getElementById('quotBusinessTerms');
  if (businessTermsTextarea) {
    businessTermsTextarea.value =
      '1. Payment within 30 days of invoice date.\n2. Prices are valid for 30 days from the date of this quotation.\n3. Delivery subject to availability.\n4. Taxes as applicable.';
  }

  const refNumberDisplay = document.getElementById('quotRefNumber');
  if (refNumberDisplay) refNumberDisplay.value = '';
  syncQuotationEditUi();

  // Re-render the draft items table if the function exists (Task 5)
  if (typeof renderDraftItemsTable === 'function') {
    renderDraftItemsTable();
  }
  updateGrandTotalDisplay();
}

/**
 * saveQuotation()
 * Validates the quotation form, builds a quotation record, persists it to
 * localStorage, resets the form, and refreshes the saved quotations list.
 */
function saveQuotation() {
  // --- 4.1 Validate form fields ---
  const customerSelect   = document.getElementById('quotCustomer');
  const customerCodeInput = document.getElementById('quotCustomerCode');
  const dateInput        = document.getElementById('quotDate');

  const selectedCustomerValue = customerSelect ? customerSelect.value : '';
  const customerCode          = customerCodeInput ? customerCodeInput.value.trim().toUpperCase() : '';
  const quotDate              = dateInput ? dateInput.value : '';

  if (!selectedCustomerValue) {
    alert('Please select a customer.');
    return;
  }

  if (!customerCode) {
    alert('Please enter a customer code.');
    return;
  }

  if (!quotDate) {
    alert('Please enter a quotation date.');
    return;
  }

  if (!quotationDraftItems || quotationDraftItems.length === 0) {
    alert('Please add at least one line item.');
    return;
  }

  // --- 4.2 Build quotation record ---
  const quotations = getSafeQuotations();
  const existingQuotation = editingQuotationRef
    ? quotations.find((q) => q.refNumber === editingQuotationRef)
    : null;
  const fy        = generateFY(new Date(quotDate));
  const seq       = existingQuotation ? null : getNextSequence(fy);
  const refNumber = existingQuotation
    ? existingQuotation.refNumber
    : generateRefNumber(seq, customerCode, fy);

  // Resolve customer object from the selector's selected option
  let customerObj = { id: '', name: '', address: '' };
  try {
    const selectedOption = customerSelect.options[customerSelect.selectedIndex];
    const raw = selectedOption ? selectedOption.dataset.customer : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      customerObj = {
        id:      String(parsed.id      || '').trim(),
        name:    String(parsed.name    || '').trim(),
        address: String(parsed.address || '').trim()
      };
    } else {
      customerObj.name = selectedOption ? selectedOption.textContent.trim() : selectedCustomerValue;
    }
  } catch (_) {
    // fallback: use raw value as name
    customerObj.name = selectedCustomerValue;
  }

  const coveringLetterTextarea  = document.getElementById('quotCoveringLetter');
  const businessTermsTextarea   = document.getElementById('quotBusinessTerms');

  const lineItemsCopy = quotationDraftItems.map(item => ({ ...item }));
  const rawTotal      = computeGrandTotal(lineItemsCopy);
  const grandTotal    = Math.round(rawTotal);
  const roundOff      = grandTotal - rawTotal;

  const quotation = {
    refNumber,
    customer:       customerObj,
    customerCode,
    quotationDate:  quotDate,
    lineItems:      lineItemsCopy,
    grandTotal,
    roundOff,
    coveringLetter: coveringLetterTextarea ? coveringLetterTextarea.value : '',
    businessTerms:  businessTermsTextarea  ? businessTermsTextarea.value  : '',
    status:         existingQuotation?.status || 'Draft',
    createdAt:      existingQuotation?.createdAt || new Date().toISOString(),
    updatedAt:      new Date().toISOString()
  };

  // --- 4.3 Persist ---
  if (existingQuotation) {
    persistQuotations(quotations.map((q) => (
      q.refNumber === editingQuotationRef ? quotation : q
    )));
  } else {
    quotations.push(quotation);
    persistQuotations(quotations);
  }

  resetQuotationForm();

  // renderQuotationList will be implemented in Task 6
  if (typeof renderQuotationList === 'function') {
    renderQuotationList();
  }
}

function loadQuotationForEdit(refNumber) {
  const quotation = getSafeQuotations().find((q) => q.refNumber === refNumber);
  if (!quotation) {
    alert('Quotation not found: ' + refNumber);
    return;
  }

  editingQuotationRef = quotation.refNumber || null;

  const customerSelect = document.getElementById('quotCustomer');
  if (customerSelect) {
    customerSelect.value = quotation.customer?.id || '';
    if (!customerSelect.value && quotation.customer?.name) {
      const match = Array.from(customerSelect.options).find(
        (option) => option.textContent.trim() === quotation.customer.name.trim()
      );
      if (match) customerSelect.value = match.value;
    }
  }

  const customerCodeInput = document.getElementById('quotCustomerCode');
  if (customerCodeInput) customerCodeInput.value = quotation.customerCode || '';

  const dateInput = document.getElementById('quotDate');
  if (dateInput) dateInput.value = quotation.quotationDate || '';

  const refNumberDisplay = document.getElementById('quotRefNumber');
  if (refNumberDisplay) refNumberDisplay.value = quotation.refNumber || '';

  const coveringLetterTextarea = document.getElementById('quotCoveringLetter');
  if (coveringLetterTextarea) {
    coveringLetterTextarea.value = quotation.coveringLetter || DEFAULT_COVERING_LETTER;
  }

  const businessTermsTextarea = document.getElementById('quotBusinessTerms');
  if (businessTermsTextarea) {
    businessTermsTextarea.value = quotation.businessTerms || DEFAULT_BUSINESS_TERMS;
  }

  quotationDraftItems = Array.isArray(quotation.lineItems)
    ? quotation.lineItems.map((item) => {
        const copy = { ...item };
        // Re-compute derived totals in case they are missing or stale
        const unitPrice = Number(copy.unitPrice) || 0;
        const qty       = Number(copy.qty)       || 0;
        const taxPct    = Number(copy.taxPct)    || 0;
        const rawTotal  = unitPrice * qty;
        const rawTax    = rawTotal * taxPct / 100;
        if (typeof copy.total       !== 'number') copy.total       = rawTotal;
        if (typeof copy.taxAmount   !== 'number') copy.taxAmount   = rawTax;
        if (typeof copy.totalAmount !== 'number') copy.totalAmount = rawTotal + rawTax;
        return copy;
      })
    : [];

  renderDraftItemsTable();
  updateGrandTotalDisplay();
  syncQuotationEditUi();

  const workspaceRoot = document.getElementById('quotationWorkspace') || document.getElementById('quotCustomer');
  if (workspaceRoot?.scrollIntoView) {
    workspaceRoot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function cancelQuotationEdit() {
  resetQuotationForm();
}

// Expose on window
window.saveQuotation      = saveQuotation;
window.resetQuotationForm = resetQuotationForm;
window.cancelQuotationEdit = cancelQuotationEdit;

// ---------------------------------------------------------------------------
// Task 5 — Quotation form UI helpers and workspace init
// ---------------------------------------------------------------------------

/** Default covering letter template (shared by resetQuotationForm and initQuotationWorkspace) */
const DEFAULT_COVERING_LETTER =
  'Dear Sir/Madam,\n\nWe are pleased to submit our quotation for your kind consideration.\n\nWe hope you will find our offer competitive and look forward to your valued order.\n\nThanking you,\nYours faithfully,\nFor DigiDat InfoSystems';

/** Default business terms template (shared by resetQuotationForm and initQuotationWorkspace) */
const DEFAULT_BUSINESS_TERMS =
  '1. Payment within 30 days of invoice date.\n2. Prices are valid for 30 days from the date of this quotation.\n3. Delivery subject to availability.\n4. Taxes as applicable.';

/**
 * renderDraftItemsTable()
 * Renders quotationDraftItems into #quotDraftItemsBody.
 * Shows a placeholder row when the array is empty.
 */
function renderDraftItemsTable() {
  const tbody = document.getElementById('quotDraftItemsBody');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (quotationDraftItems.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = 'No items added yet.';
    td.style.textAlign = 'center';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  quotationDraftItems.forEach((item, index) => {
    const tr = document.createElement('tr');
    const taxAmt   = Number(item.taxAmount)   || 0;
    const totalAmt = Number(item.totalAmount) || 0;

    // Use inline input fields so every column is editable
    tr.innerHTML = `
      <td style="text-align:center;vertical-align:middle;">${index + 1}</td>
      <td>
        <input type="text"
               data-field="description" data-idx="${index}"
               oninput="updateQuotationLineItem(${index},'description',this.value)"
               placeholder="Description"
               style="width:100%;min-width:140px;box-sizing:border-box;">
        <input type="text"
               data-field="comments" data-idx="${index}"
               oninput="updateQuotationLineItem(${index},'comments',this.value)"
               placeholder="Additional comments (optional)"
               style="width:100%;min-width:140px;box-sizing:border-box;margin-top:4px;font-size:0.82em;color:#6b7280;">
      </td>
      <td style="text-align:right;">
        <input type="number" data-field="unitPrice" data-idx="${index}" min="0" step="0.01"
               onchange="updateQuotationLineItem(${index},'unitPrice',this.value)"
               style="width:90px;text-align:right;">
      </td>
      <td style="text-align:right;">
        <input type="number" data-field="qty" data-idx="${index}" min="1" step="1"
               onchange="updateQuotationLineItem(${index},'qty',this.value)"
               style="width:60px;text-align:right;">
      </td>
      <td style="text-align:center;">
        <input type="number" data-field="taxPct" data-idx="${index}" min="0" max="100"
               onchange="updateQuotationLineItem(${index},'taxPct',this.value)"
               style="width:58px;text-align:right;">
      </td>
      <td id="quot-tax-${index}" style="text-align:right;">${taxAmt.toFixed(2)}</td>
      <td id="quot-total-${index}" style="text-align:right;">${totalAmt.toFixed(2)}</td>
      <td><button type="button" onclick="removeQuotationLineItem(${index})">Remove</button></td>
    `;
    tbody.appendChild(tr);

    // Set input values via JS to safely handle special characters / quotes
    const inputs = tr.querySelectorAll('input');
    inputs[0].value = item.description || '';
    inputs[1].value = item.comments    || '';
    inputs[2].value = Number(item.unitPrice) || 0;
    inputs[3].value = Number(item.qty)       || 0;
    inputs[4].value = Number(item.taxPct)    || 0;
  });
}

/**
 * updateQuotationLineItem(index, field, value)
 * Updates a single field on the draft item at [index], recomputes the
 * derived totals, and refreshes only the tax/total cells for that row
 * (no full table re-render, so input focus is never lost).
 */
function updateQuotationLineItem(index, field, value) {
  if (index < 0 || index >= quotationDraftItems.length) return;
  const item = quotationDraftItems[index];

  switch (field) {
    case 'description': item.description = value;               break;
    case 'comments':    item.comments    = value;               break;
    case 'unitPrice':   item.unitPrice   = Number(value) || 0;  break;
    case 'qty':         item.qty         = Number(value) || 0;  break;
    case 'taxPct':      item.taxPct      = Number(value) || 0;  break;
    default: return;
  }

  // Re-derive computed fields
  const { total, taxAmount, totalAmount } = computeLineItemTotals(
    Number(item.unitPrice) || 0,
    Number(item.qty)       || 0,
    Number(item.taxPct)    || 0
  );
  item.total       = total;
  item.taxAmount   = taxAmount;
  item.totalAmount = totalAmount;

  // Patch only the computed cells so the user's input focus stays intact
  const taxCell   = document.getElementById('quot-tax-'   + index);
  const totalCell = document.getElementById('quot-total-' + index);
  if (taxCell)   taxCell.textContent   = taxAmount.toFixed(2);
  if (totalCell) totalCell.textContent = totalAmount.toFixed(2);

  updateGrandTotalDisplay();
}

/**
 * updateGrandTotalDisplay()
 * Computes grand total with round-off and updates #quotGrandTotal display.
 */
function updateGrandTotalDisplay() {
  const el = document.getElementById('quotGrandTotal');
  if (!el) return;
  const rawTotal = computeGrandTotal(quotationDraftItems);
  const rounded  = Math.round(rawTotal);
  const roundOff = rounded - rawTotal;
  let html = rounded.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  if (Math.abs(roundOff) >= 0.01) {
    const sign = roundOff >= 0 ? '+' : '';
    html += ' <span style="font-size:0.8em;color:#6b7280;font-weight:normal;">(Round off: ' + sign + roundOff.toFixed(2) + ')</span>';
  }
  el.innerHTML = html;
}

/**
 * updateRefNumberPreview()
 * Shows a live preview of the reference number based on current customer code and date.
 * Uses the next sequence number (without incrementing the counter).
 */
function updateRefNumberPreview() {
  var refDisplay = document.getElementById('quotRefNumber');
  if (!refDisplay) return;

  if (editingQuotationRef) {
    refDisplay.value = editingQuotationRef;
    return;
  }

  var codeInput = document.getElementById('quotCustomerCode');
  var dateInput = document.getElementById('quotDate');

  var code = codeInput ? codeInput.value.trim().toUpperCase() : '';
  var dateVal = dateInput ? dateInput.value : '';

  if (!code || !dateVal) {
    refDisplay.value = '';
    refDisplay.placeholder = 'Fill Customer Code to preview';
    return;
  }

  var fy = generateFY(new Date(dateVal));

  // Peek at next sequence without incrementing
  var counters = {};
  try {
    var raw = localStorage.getItem('quotationCounters');
    if (raw) counters = JSON.parse(raw);
  } catch (_) {}
  var current = typeof counters[fy] === 'number' ? counters[fy] : 0;
  var nextSeq = String(current + 1).padStart(2, '0');

  refDisplay.value = 'DDIS/' + nextSeq + '/' + code + '/' + fy;
}

/**
 * initQuotationWorkspace()
 * Called once on DOMContentLoaded.
 * - Populates #quotCustomer from appCustomers in localStorage
 * - Sets #quotDate to today
 * - Pre-fills covering letter and business terms with defaults
 * - Ensures #quotRefNumber is empty (readonly is set in HTML)
 * - Calls renderDraftItemsTable() to initialise the empty draft table
 */
function initQuotationWorkspace() {
  // Populate customer selector
  const customerSelect = document.getElementById('quotCustomer');
  if (customerSelect) {
    customerSelect.innerHTML = '<option value="">-- Select Customer --</option>';
    try {
      const raw = localStorage.getItem('appCustomers');
      const customers = raw ? JSON.parse(raw) : [];
      if (Array.isArray(customers)) {
        customers.forEach((customer) => {
          const option = document.createElement('option');
          option.value = customer.id;
          option.textContent = customer.name;
          option.dataset.customer = JSON.stringify(customer);
          customerSelect.appendChild(option);
        });
      }
    } catch (_) {
      // fallback: leave selector with only the placeholder
    }
  }

  // Set date to today
  const dateInput = document.getElementById('quotDate');
  if (dateInput) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm   = String(today.getMonth() + 1).padStart(2, '0');
    const dd   = String(today.getDate()).padStart(2, '0');
    dateInput.value = `${yyyy}-${mm}-${dd}`;
    dateInput.addEventListener('change', updateRefNumberPreview);
  }

  // Pre-fill covering letter
  const coveringLetterTextarea = document.getElementById('quotCoveringLetter');
  if (coveringLetterTextarea) {
    coveringLetterTextarea.value = DEFAULT_COVERING_LETTER;
  }

  // Pre-fill business terms
  const businessTermsTextarea = document.getElementById('quotBusinessTerms');
  if (businessTermsTextarea) {
    businessTermsTextarea.value = DEFAULT_BUSINESS_TERMS;
  }

  // Ensure ref number field is empty (readonly is already set in HTML)
  const refNumberDisplay = document.getElementById('quotRefNumber');
  if (refNumberDisplay) {
    refNumberDisplay.value = '';
  }
  syncQuotationEditUi();

  // Initialise the draft items table
  renderDraftItemsTable();
  updateGrandTotalDisplay();

  // Populate item suggestions datalist from appItems
  var itemDatalist = document.getElementById('quotItemSuggestions');
  if (itemDatalist) {
    itemDatalist.innerHTML = '';
    try {
      var rawItems = localStorage.getItem('appItems');
      var items = rawItems ? JSON.parse(rawItems) : [];
      if (Array.isArray(items)) {
        items.forEach(function(item) {
          var opt = document.createElement('option');
          opt.value = item.name || '';
          opt.dataset.rate = item.defaultRate || '';
          opt.dataset.description = item.description || item.name || '';
          itemDatalist.appendChild(opt);
        });
      }
    } catch (_) {}
  }

  // Auto-fill customer code from most recent quotation for this customer
  var quotCustomerSelect = document.getElementById('quotCustomer');
  if (quotCustomerSelect) {
    quotCustomerSelect.addEventListener('change', function() {
      var customerId = quotCustomerSelect.value;
      if (!customerId) return;
      var codeInput = document.getElementById('quotCustomerCode');
      if (!codeInput || codeInput.value.trim()) {
        updateRefNumberPreview();
        return;
      }
      var existing = getSafeQuotations()
        .filter(function(q) { return q.customer && q.customer.id === customerId && q.customerCode; })
        .sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
      if (existing.length > 0) {
        codeInput.value = existing[0].customerCode;
      }
      updateRefNumberPreview();
    });
  }

  // Live preview of reference number as customer code is typed
  var codeInput = document.getElementById('quotCustomerCode');
  if (codeInput) {
    codeInput.addEventListener('input', updateRefNumberPreview);
  }

  updateRefNumberPreview();
  var descInput = document.getElementById('quotItemDesc');
  if (descInput) {
    descInput.addEventListener('input', function() {
      var val = descInput.value;
      var opts = itemDatalist ? Array.from(itemDatalist.options) : [];
      var match = opts.find(function(o) { return o.value === val; });
      if (match && match.dataset.rate) {
        var rateInput = document.getElementById('quotItemUnitPrice');
        if (rateInput && !rateInput.value) {
          rateInput.value = parseFloat(match.dataset.rate).toFixed(2);
        }
      }
    });
  }
}

/**
 * addQuotationLineItem()
 * Reads item inputs, validates, computes totals, pushes to draft array,
 * clears inputs, and re-renders the table and grand total.
 */
function addQuotationLineItem() {
  const descInput      = document.getElementById('quotItemDesc');
  const commentsInput  = document.getElementById('quotItemComments');
  const qtyInput       = document.getElementById('quotItemQty');
  const unitPriceInput = document.getElementById('quotItemUnitPrice');
  const taxPctInput    = document.getElementById('quotItemTaxPct');

  const description = descInput      ? descInput.value.trim()       : '';
  const comments    = commentsInput  ? commentsInput.value.trim()   : '';
  const qty         = qtyInput       ? Number(qtyInput.value)       : 0;
  const unitPrice   = unitPriceInput ? Number(unitPriceInput.value) : 0;
  const taxPct      = taxPctInput    ? Number(taxPctInput.value)    : 18;

  if (!description) {
    alert('Please enter an item description.');
    return;
  }
  if (!(qty > 0)) {
    alert('Quantity must be greater than 0.');
    return;
  }
  if (!(unitPrice >= 0)) {
    alert('Unit price must be 0 or greater.');
    return;
  }

  const { total, taxAmount, totalAmount } = computeLineItemTotals(unitPrice, qty, taxPct);

  quotationDraftItems.push({ description, comments, qty, unitPrice, taxPct, total, taxAmount, totalAmount });

  // Clear inputs
  if (descInput)      descInput.value      = '';
  if (commentsInput)  commentsInput.value  = '';
  if (qtyInput)       qtyInput.value       = '';
  if (unitPriceInput) unitPriceInput.value = '';
  if (taxPctInput)    taxPctInput.value    = '18';

  renderDraftItemsTable();
  updateGrandTotalDisplay();
}

/**
 * removeQuotationLineItem(index)
 * Removes the item at the given index from quotationDraftItems,
 * then re-renders the table and updates the grand total.
 * @param {number} index
 */
function removeQuotationLineItem(index) {
  quotationDraftItems.splice(index, 1);
  renderDraftItemsTable();
  updateGrandTotalDisplay();
}

/**
 * refreshQuotationWorkspace()
 * Re-reads storage and re-renders the saved quotations list.
 * renderQuotationList() will be implemented in Task 6.
 */
function refreshQuotationWorkspace() {
  if (typeof renderQuotationList === 'function') {
    renderQuotationList();
  }
}

// Expose on window
window.initQuotationWorkspace    = initQuotationWorkspace;
window.addQuotationLineItem      = addQuotationLineItem;
window.removeQuotationLineItem   = removeQuotationLineItem;
window.updateQuotationLineItem   = updateQuotationLineItem;
window.refreshQuotationWorkspace = refreshQuotationWorkspace;
window.renderDraftItemsTable     = renderDraftItemsTable;

// ---------------------------------------------------------------------------
// Task 6 — Saved quotations list rendering
// ---------------------------------------------------------------------------

/**
 * renderQuotationList()
 * Reads all saved quotations, sorts them descending by createdAt (most recent
 * first), and renders them into the #quotSavedListBody tbody.
 * Each row shows: refNumber, customer name, quotation date, grand total
 * (2 decimal places), status badge, and three action buttons.
 * When the list is empty, a single colspan=6 row is shown instead.
 */
function renderQuotationList() {
  const select = document.getElementById('quotSavedSelect');
  if (!select) return;

  const quotations = getSafeQuotations();
  quotations.sort((a, b) => {
    const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tB - tA;
  });

  const prev = select.value;
  select.innerHTML = '<option value="">-- Select a saved quotation --</option>';
  quotations.forEach((q) => {
    const opt = document.createElement('option');
    opt.value = q.refNumber || '';
    opt.textContent = (q.refNumber || '') + ' | ' + ((q.customer && q.customer.name) ? q.customer.name : '') + ' | ₹' + (typeof q.grandTotal === 'number' ? q.grandTotal.toFixed(2) : '0.00') + ' | ' + (q.status || 'Draft');
    opt.textContent = (q.refNumber || '') + ' | ' + ((q.customer && q.customer.name) ? q.customer.name : '') + ' | ' + formatQuotationCurrency(q.grandTotal) + ' | ' + (q.status || 'Draft');
    select.appendChild(opt);
  });

  // Restore previous selection if still valid
  if (prev && Array.from(select.options).some(o => o.value === prev)) {
    select.value = prev;
  }
  onQuotationSelectChange();
}

function onQuotationSelectChange() {
  const select = document.getElementById('quotSavedSelect');
  const detail = document.getElementById('quotSavedDetail');
  if (!select || !detail) return;

  const ref = select.value;
  if (!ref) { detail.style.display = 'none'; return; }

  const q = getSafeQuotations().find(x => x.refNumber === ref);
  if (!q) { detail.style.display = 'none'; return; }

  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('quotDetailRef', q.refNumber || '—');
  setEl('quotDetailCustomer', (q.customer && q.customer.name) ? q.customer.name : '—');
  setEl('quotDetailDate', q.quotationDate || '—');
  setEl('quotDetailTotal', typeof q.grandTotal === 'number' ? '₹' + q.grandTotal.toFixed(2) : '—');
  setEl('quotDetailRef', q.refNumber || '—');
  setEl('quotDetailCustomer', (q.customer && q.customer.name) ? q.customer.name : '—');
  setEl('quotDetailDate', q.quotationDate || '—');
  setEl('quotDetailTotal', typeof q.grandTotal === 'number' ? formatQuotationCurrency(q.grandTotal) : '—');
  setEl('quotDetailRef', q.refNumber || '-');
  setEl('quotDetailCustomer', (q.customer && q.customer.name) ? q.customer.name : '-');
  setEl('quotDetailDate', q.quotationDate || '-');
  setEl('quotDetailTotal', typeof q.grandTotal === 'number' ? formatQuotationCurrency(q.grandTotal) : '-');
  setEl('quotDetailStatus', q.status || 'Draft');
  detail.style.display = 'block';
}

function onQuotPreview() {
  const ref = document.getElementById('quotSavedSelect')?.value;
  if (ref) openQuotationPreview(ref);
}

function onQuotConvert() {
  const ref = document.getElementById('quotSavedSelect')?.value;
  if (ref) convertQuotationToInvoice(ref);
}

function onQuotDelete() {
  const ref = document.getElementById('quotSavedSelect')?.value;
  if (ref) deleteQuotation(ref);
}

function onQuotEdit() {
  const ref = document.getElementById('quotSavedSelect')?.value;
  if (ref) loadQuotationForEdit(ref);
}

// Expose on window
window.renderQuotationList = renderQuotationList;
window.onQuotationSelectChange = onQuotationSelectChange;
window.onQuotPreview = onQuotPreview;
window.onQuotConvert = onQuotConvert;
window.onQuotDelete = onQuotDelete;
window.onQuotEdit = onQuotEdit;

// ---------------------------------------------------------------------------
// Task 8 — Quotation actions: preview, delete, convert to invoice
// ---------------------------------------------------------------------------

/**
 * openQuotationPreview(refNumber)
 * Finds the quotation with the given refNumber, writes it to localStorage
 * under key `currentQuotationPreview`, then opens quotation-preview.html
 * in a new tab.
 * @param {string} refNumber
 */
function openQuotationPreview(refNumber) {
  const quotations = getSafeQuotations();
  const quotation = quotations.find((q) => q.refNumber === refNumber);
  if (!quotation) {
    alert('Quotation not found: ' + refNumber);
    return;
  }
  localStorage.setItem('currentQuotationPreview', JSON.stringify(quotation));
  window.open('quotation-preview.html', '_blank');
}

/**
 * deleteQuotation(refNumber)
 * Shows a confirm() prompt. If confirmed, removes the quotation from storage
 * and refreshes the list. If cancelled, does nothing.
 * @param {string} refNumber
 */
function deleteQuotation(refNumber) {
  const confirmed = confirm('Delete quotation ' + refNumber + '? This cannot be undone.');
  if (!confirmed) return;

  const quotations = getSafeQuotations();
  const updated = quotations.filter((q) => q.refNumber !== refNumber);
  persistQuotations(updated);
  if (editingQuotationRef === refNumber) {
    resetQuotationForm();
  }
  renderQuotationList();
}

/**
 * convertQuotationToInvoice(refNumber)
 * Converts a saved quotation to an invoice by:
 * - Optionally prompting if already converted
 * - Switching to the invoice workspace tab
 * - Pre-populating invoice form fields (customer, date, first line item)
 * - Updating the quotation status to "Converted" in storage
 * - Refreshing the quotation list
 * @param {string} refNumber
 */
function convertQuotationToInvoice(refNumber) {
  const quotations = getSafeQuotations();
  const quotation = quotations.find((q) => q.refNumber === refNumber);
  if (!quotation) {
    alert('Quotation not found: ' + refNumber);
    return;
  }

  // If already converted, ask before proceeding
  if (quotation.status === 'Converted') {
    const proceed = confirm('This quotation has already been converted. Convert again?');
    if (!proceed) return;
  }

  // Ensure the main section is visible (not setup section)
  if (typeof window.showMainSection === 'function') {
    window.showMainSection();
  }

  // Switch to the invoice workspace tab
  if (typeof window.showWorkspaceView === 'function') {
    window.showWorkspaceView('invoice');
  }

  // Update quotation status to "Converted" in storage immediately
  const updatedQuotations = getSafeQuotations().map((q) => {
    if (q.refNumber === refNumber) {
      return { ...q, status: 'Converted' };
    }
    return q;
  });
  persistQuotations(updatedQuotations);
  renderQuotationList();

  // Defer population so showMainSection/resetInvoiceEditor finish first
  setTimeout(function() {
    // Set customer on the dropdown and trigger change so app.js updates invoice object
    const customerSelect = document.getElementById('customerSelect');
    if (customerSelect && quotation.customer) {
      const customerId = quotation.customer.id || '';
      customerSelect.value = customerId;
      if (!customerSelect.value && quotation.customer.name) {
        const options = Array.from(customerSelect.options);
        const match = options.find((o) => o.textContent.trim() === quotation.customer.name.trim());
        if (match) customerSelect.value = match.value;
      }
      customerSelect.dispatchEvent(new Event('change'));
    }

    // Set invoice date
    const invoiceDateInput = document.getElementById('invoiceDate');
    if (invoiceDateInput && quotation.quotationDate) {
      invoiceDateInput.value = quotation.quotationDate;
      invoiceDateInput.dispatchEvent(new Event('change'));
    }

    // Add all line items — auto-add missing items to catalog first
    const currentInvoice = typeof window.getInvoice === 'function' ? window.getInvoice() : null;
    if (quotation.lineItems && quotation.lineItems.length > 0 && currentInvoice) {

      // Read current items catalog
      let itemsData = [];
      try {
        const raw = localStorage.getItem('appItems');
        itemsData = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(itemsData)) itemsData = [];
      } catch (_) { itemsData = []; }

      // Helper: title-case a string (e.g. "lenovo laptop" → "Lenovo Laptop")
      function toTitleCase(str) {
        return String(str || '').trim().replace(/\w\S*/g, function(w) {
          return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        });
      }

      // Helper: get next SRV id
      function nextSrvId() {
        let max = 0;
        itemsData.forEach(function(i) {
          const m = String(i.id || '').match(/(\d+)$/);
          if (m) max = Math.max(max, parseInt(m[1], 10));
        });
        return 'SRV' + String(max + 1).padStart(3, '0');
      }

      let catalogChanged = false;

      quotation.lineItems.forEach(function(item) {
        const itemName = toTitleCase(item.description || '');
        if (!itemName) return;

        // Check if item already exists (case-insensitive)
        const existing = itemsData.find(function(i) {
          return String(i.name || '').toLowerCase() === itemName.toLowerCase();
        });

        let catalogItem;
        if (existing) {
          catalogItem = existing;
        } else {
          // Add new item to catalog
          catalogItem = {
            id: nextSrvId(),
            type: 'Service',
            name: itemName,
            description: itemName,
            hsnSac: item.hsnSac || '-',
            defaultRate: item.unitPrice || 0
          };
          itemsData.push(catalogItem);
          catalogChanged = true;
        }

        currentInvoice.addItem(
          { id: catalogItem.id, name: catalogItem.name, description: catalogItem.description, hsnSac: catalogItem.hsnSac },
          item.qty,
          item.unitPrice
        );
      });

      // Persist updated catalog if new items were added
      if (catalogChanged) {
        localStorage.setItem('appItems', JSON.stringify(itemsData));
        // Refresh app.js in-memory itemsData and all dropdowns
        if (typeof window.refreshItemCatalogFromStorage === 'function') {
          window.refreshItemCatalogFromStorage();
        }
      }

      if (typeof window.updateInvoicePreview === 'function') window.updateInvoicePreview();
      if (typeof window.renderItemsTable === 'function') window.renderItemsTable();
    }
  }, 100);
}

// Expose on window
window.openQuotationPreview        = openQuotationPreview;
window.deleteQuotation             = deleteQuotation;
window.convertQuotationToInvoice   = convertQuotationToInvoice;
