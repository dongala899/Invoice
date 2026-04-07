// Global variables
let invoice;
let storage;
let companyData;
let customersData;
let vendorsData;
let itemsData;
let customerPurchaseOrdersData;
let organizationPurchaseOrdersData;
let editingInvoiceIndex = null;
let currentInvoiceStatus = 'Active';
let editingCustomerIndex = null;
let editingVendorIndex = null;
let editingItemIndex = null;
let editingCustomerPurchaseOrderIndex = null;
let editingOrganizationPurchaseOrderIndex = null;
let currentWorkspaceView = 'invoice';
let customerPurchaseOrderDraftItems = [];
let organizationPurchaseOrderDraftItems = [];
let formListenersAttached = false;
let storageRefreshTimerId = null;
const FALLBACK_AUTH_KEY = "digidat_invoice_auth";
const FALLBACK_CREDENTIALS_KEY = "digidat_invoice_credentials";
const LOGIN_PAGE_ALIAS = "login.html";
const APP_VERSION = "1.2.0";
const BACKUP_SCHEMA = "shaker-backup-v1";
const STORAGE_KEYS = {
  company: "appCompany",
  customers: "appCustomers",
  vendors: "appVendors",
  items: "appItems",
  invoices: "invoices",
  customerPurchaseOrders: "customerPurchaseOrders",
  organizationPurchaseOrders: "organizationPurchaseOrders",
  currentInvoiceDraft: "currentInvoiceDraft"
};
const INVOICE_EDIT_START_DAY = 10;

function isStandalonePreviewPage() {
  const bodyMode = document.body?.dataset?.previewPage === "true";
  const path = window.location.pathname.toLowerCase();
  return bodyMode || path.endsWith("/invoice-preview.html") || path.endsWith("invoice-preview.html");
}

function hasValidSession() {
  if (typeof window.isAuthenticated === "function") {
    return window.isAuthenticated();
  }
  try {
    const raw = localStorage.getItem(FALLBACK_AUTH_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!(parsed && parsed.active === true && parsed.username);
  } catch (error) {
    return false;
  }
}

function ensureAuthenticated() {
  if (hasValidSession()) return true;
  window.location.replace(LOGIN_PAGE_ALIAS);
  return false;
}

async function logoutAndExit() {
  if (typeof window.clearAuthentication === "function") {
    window.clearAuthentication();
  } else {
    localStorage.removeItem(FALLBACK_AUTH_KEY);
  }

  if (typeof window.ShakerServerSession?.releaseCurrentWindow === "function") {
    try {
      await window.ShakerServerSession.releaseCurrentWindow("logout");
    } catch (error) {
      // Fall through to regular login redirect if server management is unavailable.
    }
  }

  window.location.replace(`${LOGIN_PAGE_ALIAS}?forceLogin=1&source=logout`);
}

function openChangePasswordScreen() {
  window.location.href = "change-password.html";
}

function updateStorageStatusBadge() {
  const badge = document.getElementById('storageStatusBadge');
  if (!badge) return;

  const isFileBacked = window.ShakerFileStorage?.isFileBacked?.() === true;
  const isManaged = window.ShakerServerSession?.supportsManagedShutdown?.() === true;
  const invoiceCount = getSafeInvoices().length;

  badge.textContent = `${isFileBacked ? 'Disk-backed' : 'Browser-only'} | Managed: ${isManaged ? 'Yes' : 'No'} | Browser invoices: ${invoiceCount}`;
  badge.classList.toggle('is-file-backed', isFileBacked);
  badge.classList.toggle('is-browser-only', !isFileBacked);
  badge.style.display = 'inline-flex';
}

function scheduleStorageRefresh(delayMs = 120) {
  if (storageRefreshTimerId) {
    clearTimeout(storageRefreshTimerId);
  }

  storageRefreshTimerId = window.setTimeout(() => {
    storageRefreshTimerId = null;
    refreshAppStateFromStorage();
  }, delayMs);
}

window.logoutAndExit = logoutAndExit;
window.openChangePasswordScreen = openChangePasswordScreen;
window.openInvoicePreviewPage = openInvoicePreviewPage;
window.returnToInvoiceEditor = returnToInvoiceEditor;
// Expose invoice accessor for external modules (e.g. quotation.js)
window.getInvoice = function() { return invoice; };
// Expose item catalog refresh so external modules can sync after adding items
window.refreshItemCatalogFromStorage = function() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.items);
    const parsed = raw ? JSON.parse(raw) : [];
    itemsData = Array.isArray(parsed) ? parsed.map(ensureCatalogItem) : [];
  } catch (_) {}
  populateItemsDropdown();
  if (typeof populateItemNameSuggestions === 'function') populateItemNameSuggestions();
  if (typeof populateCustomerPurchaseOrderItemDropdown === 'function') populateCustomerPurchaseOrderItemDropdown();
  if (typeof populateOrganizationPurchaseOrderItemDropdown === 'function') populateOrganizationPurchaseOrderItemDropdown();
  if (typeof displayItemsList === 'function') displayItemsList();
};

function getSafeInvoices() {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.invoices)) || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ensureSavedInvoiceState(entry));
}

function ensureSavedInvoiceState(entry) {
  const record = entry && typeof entry === 'object' ? { ...entry } : {};
  record.invoiceNumber = Invoice.normalizeInvoiceNumber(record.invoiceNumber);
  if (!record.status) {
    record.status = 'Active';
  }
  return record;
}

function getInvoiceEditWindowStart(invoiceDate) {
  const dateValue = String(invoiceDate || '').trim();
  if (!dateValue) return null;
  const created = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(created.getTime())) return null;
  return new Date(created.getFullYear(), created.getMonth(), INVOICE_EDIT_START_DAY, 0, 0, 0, 0);
}

function canEditInvoiceRecord(savedInvoice) {
  if (!savedInvoice || savedInvoice.status === 'Cancelled') return false;
  const dateValue = String(savedInvoice.invoiceDate || '').trim();
  if (!dateValue) return false;
  const invoiceDate = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(invoiceDate.getTime())) return false;

  const now = new Date();
  const invoiceDay = invoiceDate.getDate();

  let lockYear, lockMonth;

  if (invoiceDay < INVOICE_EDIT_START_DAY) {
    // Invoice dated 1–9: lock on the 10th of the SAME month
    lockYear  = invoiceDate.getFullYear();
    lockMonth = invoiceDate.getMonth();
  } else {
    // Invoice dated 10–31: lock on the 10th of the NEXT month
    const nextMonth = invoiceDate.getMonth() + 1;
    lockYear  = nextMonth > 11 ? invoiceDate.getFullYear() + 1 : invoiceDate.getFullYear();
    lockMonth = nextMonth > 11 ? 0 : nextMonth;
  }

  const lockDate = new Date(lockYear, lockMonth, INVOICE_EDIT_START_DAY, 0, 0, 0, 0);
  return now < lockDate;
}

function getSafeStoredList(key) {
  const raw = readStorageJson(key, []);
  return Array.isArray(raw) ? raw : [];
}

function readStorageJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined || raw === "") return fallback;
    return JSON.parse(raw);
  } catch (error) {
    return fallback;
  }
}

function buildCurrentInvoiceDraftPayload() {
  if (!invoice) return null;
  return {
    invoice: invoice.toJSON(),
    editingInvoiceIndex,
    readOnly: false,
    invoiceStatus: currentInvoiceStatus
  };
}

function readCurrentInvoiceDraftPayload() {
  return readStorageJson(STORAGE_KEYS.currentInvoiceDraft, null);
}

function persistCurrentInvoiceDraft() {
  const payload = buildCurrentInvoiceDraftPayload();
  if (!payload) return;
  localStorage.setItem(STORAGE_KEYS.currentInvoiceDraft, JSON.stringify(payload));
}

function normalizeEditingInvoiceIndex(index) {
  return Number.isInteger(index) && index >= 0 && index < getSafeInvoices().length
    ? index
    : null;
}

function getAuthStorageKey() {
  return typeof window.AUTH_STORAGE_KEY === "string" ? window.AUTH_STORAGE_KEY : FALLBACK_AUTH_KEY;
}

function getAuthCredentialsKey() {
  return typeof window.AUTH_CREDENTIALS_KEY === "string" ? window.AUTH_CREDENTIALS_KEY : FALLBACK_CREDENTIALS_KEY;
}

function buildStorageSnapshotForDisk() {
  const snapshot = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || key === "__shaker_file_storage_manifest__") continue;
    snapshot[key] = localStorage.getItem(key);
  }
  return snapshot;
}

async function persistAppStorageToDisk() {
  if (!window.ShakerFileStorage?.isFileBacked?.()) {
    return false;
  }

  const response = await fetch("/__shaker__/storage", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      storage: buildStorageSnapshotForDisk()
    })
  });

  if (!response.ok) {
    throw new Error(`Disk sync failed with ${response.status}`);
  }

  window.dispatchEvent(new CustomEvent('shaker-storage-status-changed'));
  return true;
}

function buildBackupPayload() {
  return {
    schema: BACKUP_SCHEMA,
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    data: {
      appCompany: readStorageJson(STORAGE_KEYS.company, {}),
      appCustomers: readStorageJson(STORAGE_KEYS.customers, []),
      appVendors: readStorageJson(STORAGE_KEYS.vendors, []),
      appItems: readStorageJson(STORAGE_KEYS.items, []),
      customerPurchaseOrders: readStorageJson(STORAGE_KEYS.customerPurchaseOrders, []),
      organizationPurchaseOrders: readStorageJson(STORAGE_KEYS.organizationPurchaseOrders, []),
      invoices: getSafeInvoices(),
      invoiceCounter: localStorage.getItem("invoiceCounter"),
      quotations: readStorageJson('quotations', []),
      authSession: readStorageJson(getAuthStorageKey(), null),
      authCredentials: readStorageJson(getAuthCredentialsKey(), null)
    }
  };
}

async function downloadAppBackup() {
  const payload = buildBackupPayload();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `shaker-backup-${timestamp}.json`;
  const content = JSON.stringify(payload, null, 2);
  const blob = new Blob([content], { type: "application/json" });

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        excludeAcceptAllOption: false,
        types: [
          {
            description: "JSON Backup",
            accept: {
              "application/json": [".json"]
            }
          }
        ]
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function triggerRestoreBackup() {
  const input = document.getElementById("restoreBackupInput");
  if (!input) {
    alert("Restore input is not available.");
    return;
  }
  input.value = "";
  input.click();
}

function applyBackupPayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : null;
  if (!payload) return null;
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;

  const safeCompany = data.appCompany && typeof data.appCompany === "object" ? data.appCompany : defaultCompanyData;
  const safeCustomers = Array.isArray(data.appCustomers) ? data.appCustomers.map(ensureCustomerState) : [];
  const safeVendors = Array.isArray(data.appVendors) ? data.appVendors.map(ensureVendorState) : [];
  const safeItems = Array.isArray(data.appItems) ? data.appItems.map(ensureCatalogItem) : [];
  const safeInvoices = Array.isArray(data.invoices) ? data.invoices : [];
  const safeCustomerPurchaseOrders = Array.isArray(data.customerPurchaseOrders)
    ? data.customerPurchaseOrders.map(ensureCustomerPurchaseOrder)
    : [];
  const safeOrganizationPurchaseOrders = Array.isArray(data.organizationPurchaseOrders)
    ? data.organizationPurchaseOrders.map(ensureOrganizationPurchaseOrder)
    : [];

  localStorage.setItem(STORAGE_KEYS.company, JSON.stringify(safeCompany));
  localStorage.setItem(STORAGE_KEYS.customers, JSON.stringify(safeCustomers));
  localStorage.setItem(STORAGE_KEYS.vendors, JSON.stringify(safeVendors));
  localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(safeItems));
  localStorage.setItem(STORAGE_KEYS.invoices, JSON.stringify(safeInvoices));
  localStorage.setItem(STORAGE_KEYS.customerPurchaseOrders, JSON.stringify(safeCustomerPurchaseOrders));
  localStorage.setItem(STORAGE_KEYS.organizationPurchaseOrders, JSON.stringify(safeOrganizationPurchaseOrders));

  const invoiceCounter = data.invoiceCounter;
  if (invoiceCounter !== undefined && invoiceCounter !== null && String(invoiceCounter).trim() !== "") {
    localStorage.setItem("invoiceCounter", String(invoiceCounter));
  } else {
    localStorage.removeItem("invoiceCounter");
  }

  if (data.quotations) {
    localStorage.setItem('quotations', JSON.stringify(data.quotations));
  }

  if (Object.prototype.hasOwnProperty.call(data, "authSession")) {
    if (data.authSession) {
      localStorage.setItem(getAuthStorageKey(), JSON.stringify(data.authSession));
    } else {
      localStorage.removeItem(getAuthStorageKey());
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, "authCredentials") && data.authCredentials) {
    localStorage.setItem(getAuthCredentialsKey(), JSON.stringify(data.authCredentials));
  }

  return {
    companyApplied: !!safeCompany,
    customerCount: safeCustomers.length,
    vendorCount: safeVendors.length,
    itemCount: safeItems.length,
    invoiceCount: safeInvoices.length,
    customerPurchaseOrderCount: safeCustomerPurchaseOrders.length,
    organizationPurchaseOrderCount: safeOrganizationPurchaseOrders.length,
    invoiceCounter: invoiceCounter !== undefined && invoiceCounter !== null && String(invoiceCounter).trim() !== ""
      ? String(invoiceCounter)
      : ""
  };
}

function restoreAppBackup(event) {
  const input = event?.target;
  const file = input?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || "{}"));
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid backup structure.");
      }

      const proceed = confirm("Restore this backup now? Current unsaved changes on screen will be lost.");
      if (!proceed) return;

      const applied = applyBackupPayload(parsed);
      if (!applied) {
        throw new Error("Backup data could not be applied.");
      }

      if (typeof window.ShakerFileStorage?.persistNow === "function") {
        try {
          window.ShakerFileStorage.persistNow();
        } catch (persistError) {
          console.error("Backup disk sync failed:", persistError);
        }
      }

      updateStorageStatusBadge();
      alert("Backup restored successfully. The app will reload now.");
      window.location.reload();
    } catch (error) {
      console.error("Backup restore failed:", error);
      alert("Backup restore failed. Please use a valid backup JSON file.");
    } finally {
      if (input) input.value = "";
    }
  };

  reader.onerror = () => {
    alert("Unable to read the selected backup file.");
    if (input) input.value = "";
  };

  reader.readAsText(file, "utf-8");
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value) {
  return invoice.formatCurrency(safeNumber(value));
}

function formatMoneyForPDF(value) {
  const amount = safeNumber(value);
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
  return `\u20B9 ${formatted}`;
}

function pdfTextNeedsCanvasRender(text) {
  return String(text || '').includes('\u20B9');
}

function getPdfCanvasFontSpec(fontSize, fontStyle = 'normal') {
  const fontPx = Math.max(1, fontSize * (96 / 72));
  const fontWeight = fontStyle === 'bold' ? '700' : '400';
  return {
    fontPx,
    fontWeight,
    font: `${fontWeight} ${fontPx}px Arial, Helvetica, sans-serif`
  };
}

function measurePdfCanvasTextWidthMm(text, fontSize, fontStyle = 'normal') {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const textValue = String(text || '');
  const fontSpec = getPdfCanvasFontSpec(fontSize, fontStyle);
  ctx.font = fontSpec.font;
  const widthPx = ctx.measureText(textValue).width;
  return (widthPx * 25.4) / 96;
}

function drawPdfCanvasText(doc, text, x, baselineY, options = {}) {
  const textValue = String(text || '');
  const align = options.align || 'left';
  const fontSize = options.fontSize || doc.getFontSize();
  const fontStyle = options.fontStyle || doc.getFont().fontStyle || 'normal';
  const color = options.color || '#000000';
  const fontSpec = getPdfCanvasFontSpec(fontSize, fontStyle);

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) {
    doc.text(textValue, x, baselineY, { align });
    return;
  }

  measureCtx.font = fontSpec.font;
  const metrics = measureCtx.measureText(textValue);
  const textWidthPx = Math.max(1, Math.ceil(metrics.width));
  const ascentPx = Math.max(1, Math.ceil(metrics.actualBoundingBoxAscent || fontSpec.fontPx * 0.8));
  const descentPx = Math.max(1, Math.ceil(metrics.actualBoundingBoxDescent || fontSpec.fontPx * 0.25));
  const paddingPx = Math.max(2, Math.ceil(fontSpec.fontPx * 0.22));

  const canvas = document.createElement('canvas');
  canvas.width = textWidthPx + paddingPx * 2;
  canvas.height = ascentPx + descentPx + paddingPx * 2;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    doc.text(textValue, x, baselineY, { align });
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = fontSpec.font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  ctx.fillText(textValue, paddingPx, paddingPx + ascentPx);

  const widthMm = (canvas.width * 25.4) / 96;
  const heightMm = (canvas.height * 25.4) / 96;
  const baselineOffsetMm = ((paddingPx + ascentPx) * 25.4) / 96;

  let drawX = x;
  if (align === 'center') drawX = x - (widthMm / 2);
  if (align === 'right') drawX = x - widthMm;

  const drawY = baselineY - baselineOffsetMm;
  doc.addImage(canvas.toDataURL('image/png'), 'PNG', drawX, drawY, widthMm, heightMm);
}

function convertNumberBelowThousandToWords(num) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const value = Math.floor(num);
  if (value === 0) return '';
  if (value < 20) return ones[value];
  if (value < 100) return `${tens[Math.floor(value / 10)]}${value % 10 ? ` ${ones[value % 10]}` : ''}`;
  return `${ones[Math.floor(value / 100)]} Hundred${value % 100 ? ` ${convertNumberBelowThousandToWords(value % 100)}` : ''}`;
}

function numberToIndianWords(value) {
  const amount = Math.round(safeNumber(value));
  if (amount === 0) return 'Zero Rupees Only';

  const parts = [
    { divisor: 10000000, label: 'Crore' },
    { divisor: 100000, label: 'Lakh' },
    { divisor: 1000, label: 'Thousand' },
    { divisor: 1, label: '' }
  ];

  let remaining = amount;
  const output = [];

  parts.forEach(({ divisor, label }) => {
    if (remaining < divisor) return;
    const chunk = divisor === 1 ? remaining : Math.floor(remaining / divisor);
    if (chunk > 0) {
      output.push(convertNumberBelowThousandToWords(divisor === 1 ? chunk : chunk % 1000));
      if (label) output.push(label);
    }
    remaining = divisor === 1 ? 0 : remaining % divisor;
  });

  return `${output.join(' ').replace(/\s+/g, ' ').trim()} Rupees Only`;
}

function getInvoiceTermsLines() {
  return [
    'Terms and conditions:',
    'Payment on Delivery',
    'Make all cheques/DD payable to "DIGIDAT INFO SYSTEMS"',
    'Bank: HDFC Bank | Account: 50200077107985 | IFSC: HDFC0000377'
  ];
}

function getInvoiceBottomSectionMarkup(grandTotalWords) {
  const termsLines = getInvoiceTermsLines();
  return `
    <div class="invoice-bottom-row">
      <div class="invoice-terms">
        <p class="grand-total-words"><strong>Grand Total in Words:</strong> ${grandTotalWords}</p>
        <p><strong>${termsLines[0]}</strong></p>
        <p>${termsLines[1]}</p>
        <p>${termsLines[2]}</p>
        <p>${termsLines[3]}</p>
      </div>
      <div class="totals-signature">
        <p class="signature-company">For DigiDat InfoSystems</p>
        <img
          class="invoice-stamp"
          src="assets/Signature.jpeg"
          alt="Company Stamp"
          onerror="handleStampFallback(this)"
        >
        <p class="signature-company">Authorised Signatory</p>
      </div>
    </div>
  `;
}

function displayOptional(value) {
  const text = String(value ?? '').trim();
  return text || '-';
}

function getNextEntityId(prefix, records) {
  let maxValue = 0;
  (Array.isArray(records) ? records : []).forEach((record) => {
    const match = String(record?.id || '').match(/(\d+)$/);
    if (!match) return;
    const numericValue = parseInt(match[1], 10);
    if (Number.isFinite(numericValue)) {
      maxValue = Math.max(maxValue, numericValue);
    }
  });
  return `${prefix}${String(maxValue + 1).padStart(3, '0')}`;
}

function fitTextToWidth(doc, text, maxWidth, ellipsis = "...") {
  const source = String(text || "-");
  if (!doc || !Number.isFinite(maxWidth) || maxWidth <= 0) return source;
  if (doc.getTextWidth(source) <= maxWidth) return source;

  let output = source;
  while (output.length > 0 && doc.getTextWidth(`${output}${ellipsis}`) > maxWidth) {
    output = output.slice(0, -1);
  }
  return output ? `${output}${ellipsis}` : ellipsis;
}

function fitBuyerAddressLineElements(root = document, viewWindow = window) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const lines = Array.from(root.querySelectorAll('.buyer-address-line'));
  lines.forEach((line) => {
    if (!line) return;

    line.style.whiteSpace = 'normal';
    line.style.overflow = 'visible';
    line.style.textOverflow = 'unset';
    line.style.overflowWrap = 'anywhere';
    line.style.wordBreak = 'break-word';
    line.style.maxWidth = '100%';
    line.style.fontSize = '';
    line.style.letterSpacing = '';
  });
}

const DEFAULT_LOCAL_STATE = 'Telangana';

// Case normalization utilities
function toTitleCase(str) {
  return String(str || '').trim().replace(/\w\S*/g, function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

function toSentenceCase(str) {
  const text = String(str || '').trim();
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isValidGstin(gstin) {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(String(gstin || '').trim().toUpperCase());
}

const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh'
};

const STATE_OPTIONS = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal'
].sort((a, b) => {
  if (a === DEFAULT_LOCAL_STATE) return -1;
  if (b === DEFAULT_LOCAL_STATE) return 1;
  return a.localeCompare(b);
});

function normalizeState(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeHsnSac(value) {
  return String(value || '').trim() || '-';
}

function inferStateFromGstin(gstin) {
  const gst = String(gstin || '').trim();
  const code = gst.slice(0, 2);
  return GST_STATE_CODES[code] || '';
}

function ensureCustomerState(customer) {
  const safeCustomer = { ...customer };
  const stateFromData = normalizeState(safeCustomer.state);
  const stateFromGstin = inferStateFromGstin(safeCustomer.gstin);
  safeCustomer.state = stateFromData || stateFromGstin || DEFAULT_LOCAL_STATE;
  return safeCustomer;
}

function ensureVendorState(vendor) {
  const safeVendor = { ...vendor };
  const stateFromData = normalizeState(safeVendor.state);
  const stateFromGstin = inferStateFromGstin(safeVendor.gstin);
  safeVendor.id = String(safeVendor.id || '').trim();
  safeVendor.name = String(safeVendor.name || '').trim();
  safeVendor.email = String(safeVendor.email || '').trim();
  safeVendor.phone = String(safeVendor.phone || '').trim();
  safeVendor.address = String(safeVendor.address || '').trim();
  safeVendor.gstin = String(safeVendor.gstin || '').trim();
  safeVendor.state = stateFromData || stateFromGstin || DEFAULT_LOCAL_STATE;
  return safeVendor;
}

function ensureCatalogItem(item) {
  return {
    ...item,
    hsnSac: normalizeHsnSac(item?.hsnSac || item?.hsn || item?.sac)
  };
}

function ensureOrderLineItem(item) {
  const quantity = safeNumber(item?.quantity);
  const rate = safeNumber(item?.rate);
  const taxRate = safeNumber(item?.taxRate ?? 18); // default 18%
  return {
    id: String(item?.id || '').trim(),
    name: String(item?.name || '').trim() || '-',
    description: String(item?.description || '').trim(),
    hsnSac: normalizeHsnSac(item?.hsnSac || item?.hsn || item?.sac),
    quantity,
    rate,
    taxRate,
    total: quantity * rate
  };
}

function ensureCustomerPurchaseOrder(record) {
  const items = Array.isArray(record?.items) ? record.items.map(ensureOrderLineItem) : [];
  const derivedAmount = items.reduce((sum, item) => sum + safeNumber(item.total), 0);
  return {
    id: String(record?.id || '').trim(),
    customerId: String(record?.customerId || '').trim(),
    customerName: String(record?.customerName || '').trim(),
    poNumber: String(record?.poNumber || '').trim(),
    poDate: String(record?.poDate || '').trim(),
    amount: items.length > 0 ? derivedAmount : safeNumber(record?.amount),
    status: String(record?.status || 'Open').trim() || 'Open',
    notes: String(record?.notes || '').trim(),
    items,
    linkedInvoiceNumber: String(record?.linkedInvoiceNumber || '').trim(),
    createdAt: record?.createdAt || new Date().toISOString()
  };
}

function ensureOrganizationPurchaseOrder(record) {
  const items = Array.isArray(record?.items) ? record.items.map(ensureOrderLineItem) : [];
  const subtotal = items.length > 0
    ? items.reduce((sum, item) => sum + safeNumber(item.total), 0)
    : safeNumber(record?.subtotal || record?.amount);
  const taxType = String(record?.taxType || 'CGST_SGST').trim();
  // Per-item tax calculation
  const totalTax = items.reduce((sum, item) => sum + safeNumber(item.total) * (safeNumber(item.taxRate) / 100), 0);
  const cgst = taxType === 'CGST_SGST' ? (items.length > 0 ? totalTax / 2 : safeNumber(record?.cgst)) : 0;
  const sgst = taxType === 'CGST_SGST' ? (items.length > 0 ? totalTax / 2 : safeNumber(record?.sgst)) : 0;
  const igst = taxType === 'IGST'       ? (items.length > 0 ? totalTax     : safeNumber(record?.igst)) : 0;
  const grandTotal = subtotal + cgst + sgst + igst;
  return {
    id: String(record?.id || '').trim(),
    vendorName: String(record?.vendorName || '').trim(),
    poNumber: String(record?.poNumber || record?.orderNumber || '').trim(),
    poDate: String(record?.poDate || record?.orderDate || '').trim(),
    subtotal,
    cgst,
    sgst,
    igst,
    taxType,
    amount: grandTotal,
    items,
    status: String(record?.status || 'Placed').trim() || 'Placed',
    notes: String(record?.notes || '').trim(),
    createdAt: record?.createdAt || new Date().toISOString()
  };
}

function ensureInvoiceLineItem(item) {
  return ensureOrderLineItem(item);
}

function getSafeCustomerPurchaseOrders() {
  return getSafeStoredList(STORAGE_KEYS.customerPurchaseOrders).map(ensureCustomerPurchaseOrder);
}

function getSafeOrganizationPurchaseOrders() {
  return getSafeStoredList(STORAGE_KEYS.organizationPurchaseOrders).map(ensureOrganizationPurchaseOrder);
}

function persistCustomerPurchaseOrders() {
  localStorage.setItem(STORAGE_KEYS.customerPurchaseOrders, JSON.stringify(customerPurchaseOrdersData));
}

function persistOrganizationPurchaseOrders() {
  localStorage.setItem(STORAGE_KEYS.organizationPurchaseOrders, JSON.stringify(organizationPurchaseOrdersData));
}

function persistVendors() {
  localStorage.setItem(STORAGE_KEYS.vendors, JSON.stringify(vendorsData));
}

function populateStateDropdown(selectId, selectedState = DEFAULT_LOCAL_STATE) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const normalizedSelected = normalizeState(selectedState) || DEFAULT_LOCAL_STATE;
  select.innerHTML = '';

  STATE_OPTIONS.forEach((state) => {
    const option = document.createElement('option');
    option.value = state;
    option.textContent = state;
    if (state === normalizedSelected) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  if (!STATE_OPTIONS.includes(normalizedSelected)) {
    const extraOption = document.createElement('option');
    extraOption.value = normalizedSelected;
    extraOption.textContent = normalizedSelected;
    extraOption.selected = true;
    select.appendChild(extraOption);
  }
}

function formatDateDisplay(value) {
  if (!value) return '-';
  return invoice?.formatDate ? invoice.formatDate(value) : value;
}

function getEmbeddedPdfAsset(...keys) {
  if (!window.PDF_ASSETS) return null;
  for (const key of keys) {
    const value = window.PDF_ASSETS[key];
    if (typeof value === "string" && value.startsWith("data:image/")) {
      return value;
    }
  }
  return null;
}

function getImageTypeForPdf(dataUrl) {
  if (typeof dataUrl !== "string") return "JPEG";
  if (dataUrl.startsWith("data:image/png")) return "PNG";
  if (dataUrl.startsWith("data:image/webp")) return "WEBP";
  return "JPEG";
}

function waitForInvoiceImages(root, timeoutMs = 4000) {
  const images = Array.from(root.querySelectorAll('img'));
  if (images.length === 0) return Promise.resolve();

  const waits = images.map((img) => {
    if (img.complete) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(done, timeoutMs);
    });
  });

  return Promise.all(waits).then(() => undefined);
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function imageElementToDataUrl(img) {
  return new Promise((resolve) => {
    if (!img) {
      resolve(null);
      return;
    }

    const convert = () => {
      try {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        if (!width || !height) {
          resolve(null);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.95));
      } catch (error) {
        resolve(null);
      }
    };

    if (img.complete && img.naturalWidth > 0) {
      convert();
      return;
    }

    const onLoad = () => convert();
    const onError = () => resolve(null);
    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });
    setTimeout(() => resolve(null), 2000);
  });
}

async function inlineImages(root) {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map(async (img) => {
    if (!img.src || img.src.startsWith('data:')) return;
    try {
      const response = await fetch(img.src, { cache: 'force-cache' });
      if (!response.ok) return;
      const blob = await response.blob();
      const dataUrl = await blobToDataUrl(blob);
      img.src = dataUrl;
    } catch (error) {
      const sameSrcImg = Array.from(document.images).find(
        (domImg) => domImg.src === img.src && domImg !== img
      );
      const dataUrl = await imageElementToDataUrl(sameSrcImg);
      if (dataUrl) {
        img.src = dataUrl;
      }
    }
  }));
}

async function loadPdfAssetDataUrl(paths, selectors = [], embeddedKeys = []) {
  const keys = Array.isArray(embeddedKeys) ? embeddedKeys : [embeddedKeys];
  const embeddedAsset = getEmbeddedPdfAsset(...keys);
  if (embeddedAsset) return embeddedAsset;

  for (const selector of selectors) {
    const domImg = document.querySelector(selector);
    const dataUrl = await imageElementToDataUrl(domImg);
    if (dataUrl) return dataUrl;
  }

  for (const path of paths) {
    try {
      const response = await fetch(path, { cache: "force-cache" });
      if (!response.ok) continue;
      const blob = await response.blob();
      return await blobToDataUrl(blob);
    } catch (error) {
      // Try next path.
    }
  }
  return null;
}

const pdfFontBase64Cache = new Map();

async function loadPdfFontBase64(path) {
  if (pdfFontBase64Cache.has(path)) {
    return pdfFontBase64Cache.get(path);
  }

  const response = await fetch(path, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Unable to load PDF font asset: ${path}`);
  }

  const blob = await response.blob();
  const dataUrl = await blobToDataUrl(blob);
  const base64 = String(dataUrl).split(",")[1] || "";
  pdfFontBase64Cache.set(path, base64);
  return base64;
}

async function registerInvoicePdfFonts(doc) {
  if (!doc?.addFileToVFS || !doc?.addFont) {
    return false;
  }
  if (doc.__invoicePdfFontsRegistered) {
    return true;
  }

  try {
    const [regularBase64, boldBase64] = await Promise.all([
      loadPdfFontBase64("assets/arial.ttf"),
      loadPdfFontBase64("assets/arialbd.ttf")
    ]);

    doc.addFileToVFS("arial.ttf", regularBase64);
    doc.addFont("arial.ttf", "invoicepdf", "normal");
    doc.addFileToVFS("arialbd.ttf", boldBase64);
    doc.addFont("arialbd.ttf", "invoicepdf", "bold");
    doc.__invoicePdfFontsRegistered = true;
    return true;
  } catch (error) {
    console.warn("Embedded PDF fonts could not be loaded.", error);
    return false;
  }
}

function resolvePdfMoneyFontStyle(text, requestedStyle = "normal") {
  if (pdfTextNeedsCanvasRender(text) && requestedStyle === "bold") {
    return "normal";
  }
  return requestedStyle;
}

async function exportBasicPdfData() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("jsPDF unavailable for basic export");
  }

  const logoDataUrl = await loadPdfAssetDataUrl([
    "assets/Logo.jpeg",
    "assets/digidat-logo.png",
    "assets/logo.png"
  ], [".invoice-logo-image"], ["logo"]);
  const signDataUrl = await loadPdfAssetDataUrl([
    "assets/Signature.jpeg",
    "assets/digidat-stamp.png",
    "assets/stamp.png"
  ], [".invoice-stamp"], ["signature", "stamp"]);

  const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const hasEmbeddedPdfFont = await registerInvoicePdfFonts(doc);
  const pdfFontFamily = hasEmbeddedPdfFont ? "invoicepdf" : "helvetica";
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const left = 10;
  const right = pageW - 10;
  let y = 14;

  const setPdfFont = (fontStyle = "normal") => {
    doc.setFont(pdfFontFamily, fontStyle);
  };

  const line = (text, x, yPos, align = "left") => {
    const textValue = String(text);
    if (!hasEmbeddedPdfFont && pdfTextNeedsCanvasRender(textValue)) {
      drawPdfCanvasText(doc, textValue, x, yPos, {
        align,
        fontSize: doc.getFontSize(),
        fontStyle: doc.getFont().fontStyle || "normal"
      });
      return;
    }
    doc.text(textValue, x, yPos, { align });
  };

  const company = invoice.companyInfo || {};
  const customer = ensureCustomerState(invoice.customerSelected || {});
  const isInterState = invoice.isInterStateSale();

  // Cancelled banner
  if (currentInvoiceStatus === 'Cancelled') {
    setPdfFont("bold");
    doc.setFontSize(13);
    doc.setTextColor(211, 47, 47);
    doc.setDrawColor(211, 47, 47);
    doc.setFillColor(255, 235, 238);
    doc.rect(left, y - 4, pageW - left * 2, 9, 'FD');
    doc.text("CANCELLED", pageW / 2, y + 2, { align: "center" });
    doc.setTextColor(0, 0, 0);
    doc.setDrawColor(0, 0, 0);
    y += 10;
  }

  const headerTop = y;
  const poDateText = invoice.poDate ? invoice.formatDate(invoice.poDate) : "-";
  let contentStartY = headerTop + 6;
  const logoLeft = left;
  const logoTop = headerTop - 2;
  let logoBottomY = headerTop;
  if (logoDataUrl) {
    try {
      const logoWidth = 34;
      const logoHeight = 12;
      doc.addImage(
        logoDataUrl,
        getImageTypeForPdf(logoDataUrl),
        logoLeft,
        logoTop,
        logoWidth,
        logoHeight
      );
      logoBottomY = logoTop + logoHeight;
      contentStartY = headerTop + 14;
    } catch (error) {
      console.warn("Logo image could not be embedded in PDF.", error);
    }
  }

  setPdfFont("bold");
  doc.setFontSize(12);
  line("Tax Invoice", pageW / 2, contentStartY - 2, "center");

  const headerGap = 6;
  const detailsColWidth = 44;
  const detailsLeft = right - detailsColWidth;
  const companyX = left;
  const companyW = 80;
  const buyerX = companyX + companyW + headerGap;
  const buyerW = Math.max(48, detailsLeft - buyerX - headerGap);

  setPdfFont("bold");
  doc.setFontSize(9.5);
  const companyNameY = Math.max(contentStartY + 1, logoBottomY + 1.5);
  line(company.name || "DigiDat InfoSystems", companyX, companyNameY);

  setPdfFont("normal");
  doc.setFontSize(8.5);
  const companyAddressY = companyNameY + 4;
  const companyAddressLines = doc.splitTextToSize(company.address || "-", companyW);
  doc.text(companyAddressLines, companyX, companyAddressY);
  const companyLineHeight = 3.2;
  let companyBlockBottom = companyAddressY + ((Math.max(companyAddressLines.length, 1) - 1) * companyLineHeight);
  line(`Phone: ${company.phone || "-"}`, companyX, companyBlockBottom + 3.2);
  line(`Email: ${company.email || "-"}`, companyX, companyBlockBottom + 6.4);
  line(`GSTIN: ${company.gstin || "-"}`, companyX, companyBlockBottom + 9.6);
  companyBlockBottom += 9.6;

  setPdfFont("bold");
  doc.setFontSize(9.5);
  line("Buyer (Bill To):", buyerX, contentStartY + 4);

  setPdfFont("normal");
  doc.setFontSize(8.5);
  let buyerY = contentStartY + 8;
  line(customer.name || "-", buyerX, buyerY);
  buyerY += 4;
  const buyerAddress = fitTextToWidth(doc, customer.address || "-", buyerW);
  doc.text(buyerAddress, buyerX, buyerY);
  buyerY += 4;
  const stateAndGstinLines = doc.splitTextToSize(
    `State: ${customer.state || DEFAULT_LOCAL_STATE} | GSTIN: ${displayOptional(customer.gstin)}`,
    buyerW
  );
  doc.text(stateAndGstinLines, buyerX, buyerY);
  buyerY += stateAndGstinLines.length * 4;
  const phoneAndEmailLines = doc.splitTextToSize(
    `Phone: ${displayOptional(customer.phone)} | Email: ${displayOptional(customer.email)}`,
    buyerW
  );
  doc.text(phoneAndEmailLines, buyerX, buyerY);
  buyerY += phoneAndEmailLines.length * 4;
  const shippingAddressText = String(invoice.shippingAddress || "").trim();
  if (shippingAddressText) {
    setPdfFont("bold");
    doc.setFontSize(9.5);
    line("Shipping Address:", buyerX, buyerY + 1);
    buyerY += 5;
    setPdfFont("normal");
    doc.setFontSize(8.5);
    const shippingLines = doc.splitTextToSize(shippingAddressText, buyerW);
    doc.text(shippingLines, buyerX, buyerY);
    buyerY += shippingLines.length * 4;
  }
  const buyerBlockBottom = buyerY - 4;

  setPdfFont("bold");
  doc.setFontSize(9.5);
  line(`INV No: ${invoice.invoiceNumber || "-"}`, right, contentStartY + 4, "right");
  setPdfFont("normal");
  doc.setFontSize(8.5);
  line(`Invoice Date: ${invoice.formatDate(invoice.invoiceDate)}`, right, contentStartY + 8, "right");
  line(`PO No: ${invoice.poNumber || "-"}`, right, contentStartY + 12, "right");
  line(`PO Date: ${poDateText}`, right, contentStartY + 16, "right");
  const invoiceBlockBottom = contentStartY + 16;

  y = Math.max(companyBlockBottom, buyerBlockBottom, invoiceBlockBottom) + 6;
  doc.line(left, y, right, y);
  y += 5;

  const tableWidth = right - left;
  const columnWidths = {
    sno: 10,
    desc: 70,
    hsn: 23,
    qty: 12,
    rate: 24,
    rateTax: 24
  };
  const fixedWidth = columnWidths.sno + columnWidths.desc + columnWidths.hsn + columnWidths.qty + columnWidths.rate + columnWidths.rateTax;
  columnWidths.amount = tableWidth - fixedWidth;

  const colStart = {
    sno: left,
    desc: left + columnWidths.sno,
    hsn: left + columnWidths.sno + columnWidths.desc,
    qty: left + columnWidths.sno + columnWidths.desc + columnWidths.hsn,
    rate: left + columnWidths.sno + columnWidths.desc + columnWidths.hsn + columnWidths.qty,
    rateTax: left + columnWidths.sno + columnWidths.desc + columnWidths.hsn + columnWidths.qty + columnWidths.rate,
    amount: left + columnWidths.sno + columnWidths.desc + columnWidths.hsn + columnWidths.qty + columnWidths.rate + columnWidths.rateTax
  };

  const colRight = {
    qty: colStart.qty + columnWidths.qty - 1,
    rate: colStart.rate + columnWidths.rate - 1,
    rateTax: colStart.rateTax + columnWidths.rateTax - 1,
    amount: right
  };
  const colCenter = {
    sno: colStart.sno + (columnWidths.sno / 2),
    hsn: colStart.hsn + (columnWidths.hsn / 2),
    qty: colStart.qty + (columnWidths.qty / 2),
    rate: colStart.rate + (columnWidths.rate / 2),
    rateTax: colStart.rateTax + (columnWidths.rateTax / 2),
    amount: colStart.amount + (columnWidths.amount / 2)
  };

  const drawTableHeader = () => {
    setPdfFont("bold");
    doc.setFontSize(8.4);
    line("S.No", colCenter.sno, y, "center");
    line("Item Description", colStart.desc + 1, y);
    line("HSN/SAC", colCenter.hsn, y, "center");
    line("Qty", colCenter.qty, y, "center");
    line("Rate+Tax", colCenter.rate, y, "center");
    line("Rate", colCenter.rateTax, y, "center");
    line("Amount", colCenter.amount, y, "center");
    y += 2;
    doc.line(left, y, right, y);
    y += 5;
    setPdfFont("normal");
    doc.setFontSize(8.3);
  };

  const ensurePage = (neededHeight) => {
    if (y + neededHeight <= pageH - 14) return;
    doc.addPage();
    y = 14;
    drawTableHeader();
  };

  drawTableHeader();
  invoice.items.forEach((item, index) => {
    const safeItem = ensureInvoiceLineItem(item);
    const qty = safeNumber(item.quantity);
    const rate = safeNumber(item.rate);
    const rateWithTax = rate * 1.18;
    const amount = safeNumber(item.total);
    const descText = `${item.name || "-"}${item.description ? ` - ${item.description}` : ""}`;
    const descLines = doc.splitTextToSize(descText, columnWidths.desc - 2);
    const rowHeight = Math.max(5, descLines.length * 3.8);
    ensurePage(rowHeight + 2);

    line(index + 1, colStart.sno + (columnWidths.sno / 2), y, "center");
    doc.text(descLines, colStart.desc + 1, y);
    line(String(safeItem.hsnSac || "-").slice(0, 18), colStart.hsn + (columnWidths.hsn / 2), y, "center");
    line(qty || "-", colStart.qty + (columnWidths.qty / 2), y, "center");
    line(formatMoneyForPDF(rateWithTax), colStart.rate + (columnWidths.rate / 2), y, "center");
    line(formatMoneyForPDF(rate), colStart.rateTax + (columnWidths.rateTax / 2), y, "center");
    line(formatMoneyForPDF(amount), colStart.amount + (columnWidths.amount / 2), y, "center");
    y += rowHeight;
    doc.setDrawColor(228, 231, 235);
    doc.line(left, y, right, y);
    y += 3;
  });

  y += 2;

  // --- Totals box ---
  const totalsBoxRight = right;
  const totalsRowH = 5.5;
  const totalsBoxPaddingX = 2;
  let totalsBoxLeft = right - 72;
  let totalsLabelX = totalsBoxLeft + totalsBoxPaddingX;
  let totalsAmountX = totalsBoxRight - totalsBoxPaddingX;

  function measurePdfTextWidth(text, fontSize, fontStyle = "normal") {
    const resolvedFontStyle = hasEmbeddedPdfFont
      ? resolvePdfMoneyFontStyle(text, fontStyle)
      : fontStyle;
    if (!hasEmbeddedPdfFont && pdfTextNeedsCanvasRender(text)) {
      return measurePdfCanvasTextWidthMm(text, fontSize, resolvedFontStyle);
    }
    doc.setFontSize(fontSize);
    setPdfFont(resolvedFontStyle);
    return doc.getTextWidth(text);
  }

  function drawPdfTotalsPair(label, amount, baselineY, labelFontStyle = "normal", amountFontStyle = "bold") {
    const labelText = `${label}:`;
    setPdfFont(labelFontStyle);
    doc.text(labelText, totalsLabelX, baselineY);
    const resolvedAmountFontStyle = hasEmbeddedPdfFont
      ? resolvePdfMoneyFontStyle(amount, amountFontStyle)
      : amountFontStyle;
    if (!hasEmbeddedPdfFont && pdfTextNeedsCanvasRender(amount)) {
      drawPdfCanvasText(doc, amount, totalsAmountX, baselineY, {
        align: "right",
        fontSize: doc.getFontSize(),
        fontStyle: resolvedAmountFontStyle
      });
      return;
    }
    setPdfFont(resolvedAmountFontStyle);
    doc.text(amount, totalsAmountX, baselineY, { align: "right" });
  }

  // Build rows
  const totalsRows = [];
  totalsRows.push({ label: 'Subtotal', amount: formatMoneyForPDF(invoice.getSubtotal()) });
  if (isInterState) {
    totalsRows.push({ label: 'IGST (18%)', amount: formatMoneyForPDF(invoice.getIGST()) });
  } else {
    totalsRows.push({ label: 'CGST (9%)', amount: formatMoneyForPDF(invoice.getCGST()) });
    totalsRows.push({ label: 'SGST (9%)', amount: formatMoneyForPDF(invoice.getSGST()) });
  }
  if (invoice.isRoundOffEnabled()) {
    totalsRows.push({ label: 'Total', amount: formatMoneyForPDF(invoice.getPreRoundGrandTotal()) });
    totalsRows.push({ label: 'Round Off', amount: formatMoneyForPDF(invoice.getRoundOffAmount()) });
  }

  const widestRegularLabel = totalsRows.reduce((maxWidth, row) => {
    return Math.max(maxWidth, measurePdfTextWidth(`${row.label}:`, 8.5, "normal"));
  }, 0);
  const widestRegularAmount = totalsRows.reduce((maxWidth, row) => {
    return Math.max(maxWidth, measurePdfTextWidth(row.amount, 8.5, "bold"));
  }, 0);
  const grandTotalLabelWidth = measurePdfTextWidth('Grand Total:', 9, "bold");
  const grandTotalAmountWidth = measurePdfTextWidth(formatMoneyForPDF(invoice.getGrandTotal()), 9, "bold");
  const totalsLabelGap = 6;
  const totalsBoxWidth = Math.max(widestRegularLabel, grandTotalLabelWidth)
    + Math.max(widestRegularAmount, grandTotalAmountWidth)
    + totalsLabelGap
    + totalsBoxPaddingX * 2;
  totalsBoxLeft = totalsBoxRight - totalsBoxWidth;
  totalsLabelX = totalsBoxLeft + totalsBoxPaddingX;
  totalsAmountX = totalsBoxRight - totalsBoxPaddingX;

  const boxHeight = totalsRows.length * totalsRowH + totalsRowH + 1; // rows + grand total row
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.3);
  doc.rect(totalsBoxLeft, y, totalsBoxWidth, boxHeight);

  // Draw regular rows
  setPdfFont("normal");
  doc.setFontSize(8.5);
  totalsRows.forEach((row, i) => {
    const rowY = y + i * totalsRowH;
    // Row separator
    if (i > 0) {
      doc.setDrawColor(220, 220, 220);
      doc.setLineWidth(0.2);
      doc.line(totalsBoxLeft, rowY, totalsBoxRight, rowY);
    }
    doc.setTextColor(30, 30, 30);
    drawPdfTotalsPair(row.label, row.amount, rowY + totalsRowH - 1.5);
  });

  // Grand Total row — double border + grey fill
  const gtY = y + totalsRows.length * totalsRowH;
  doc.setFillColor(241, 245, 249);
  doc.rect(totalsBoxLeft, gtY, totalsBoxWidth, totalsRowH + 1, 'F');
  doc.setDrawColor(31, 41, 55);
  doc.setLineWidth(0.5);
  doc.line(totalsBoxLeft, gtY, totalsBoxRight, gtY);
  doc.line(totalsBoxLeft, gtY + totalsRowH + 1, totalsBoxRight, gtY + totalsRowH + 1);
  setPdfFont("bold");
  doc.setFontSize(9);
  doc.setTextColor(0, 0, 0);
  drawPdfTotalsPair('Grand Total', formatMoneyForPDF(invoice.getGrandTotal()), gtY + totalsRowH - 0.5, "bold", "bold");

  // Reset draw settings
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);
  setPdfFont("normal");
  doc.setTextColor(0, 0, 0);

  y = gtY + totalsRowH + 1 + 5;
  doc.setFontSize(8.4);
  const grandTotalWords = doc.splitTextToSize(`Grand Total in Words: ${numberToIndianWords(invoice.getGrandTotal())}`, right - left);
  doc.text(grandTotalWords, left, y);
  y += grandTotalWords.length * 4 + 3;

  const companySignLine = "For DigiDat InfoSystems";
  const authorizedLine = "Authorised Signatory";
  const termsLines = getInvoiceTermsLines();
  const signWidth = 30;
  const signHeight = 20;
  const signatureBlockHeight = 4 + signHeight + 10;
  const termsBlockHeight = 18;

  if (y + Math.max(signatureBlockHeight, termsBlockHeight) > pageH - 20) {
    doc.addPage();
    y = 18;
  }

  setPdfFont("bold");
  doc.setFontSize(8.5);
  let termsY = y;
  termsLines.forEach((term, index) => {
    setPdfFont(index === 0 ? "bold" : "normal");
    line(term, left, termsY, "left");
    termsY += 4;
  });

  setPdfFont("bold");
  doc.setFontSize(8.5);
  line(companySignLine, right, y, "right");
  y += 4;

  if (signDataUrl) {
    if (y + signHeight > pageH - 20) {
      doc.addPage();
      y = 18;
    }
    try {
      doc.addImage(signDataUrl, getImageTypeForPdf(signDataUrl), right - signWidth, y, signWidth, signHeight);
      y += signHeight + 4;
    } catch (error) {
      console.warn("Signature image could not be embedded in PDF.", error);
    }
  }

  setPdfFont("bold");
  line(authorizedLine, right, y, "right");
  y += 4;

  y = Math.max(y, pageH - 20);
  doc.setFontSize(8);
  setPdfFont("normal");
  line("This is a computer generated invoice", pageW / 2, y, "center");

  doc.save(`${invoice.invoiceNumber || "invoice"}.pdf`);
}

function getInvoiceCopiesMarkup(invoiceHtml) {
  const invLabelMarker = "<strong>INV No:</strong>";
  const originalHtml = invoiceHtml.replace(invLabelMarker, "<strong>ORIGINAL INV No:</strong>");
  const duplicateHtml = invoiceHtml.replace(invLabelMarker, "<strong>DUPLICATE INV No:</strong>");

  return `
    <div class="print-copy">
      ${originalHtml}
    </div>
    <div class="print-copy">
      ${duplicateHtml}
    </div>
  `;
}

async function exportToPDFFallback(sourceElement) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("jsPDF is not available");
  }
  if (typeof html2canvas === "undefined") {
    throw new Error("html2canvas is not available");
  }
  if (!sourceElement) {
    throw new Error("No source element for PDF export");
  }

  const canvas = await html2canvas(sourceElement, {
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor: "#ffffff",
    logging: false
  });

  const imgData = canvas.toDataURL("image/jpeg", 0.98);
  const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 8;
  const usableWidth = pageWidth - margin * 2;
  const imgHeight = (canvas.height * usableWidth) / canvas.width;

  let heightLeft = imgHeight;
  let position = margin;

  doc.addImage(imgData, "JPEG", margin, position, usableWidth, imgHeight);
  heightLeft -= pageHeight - margin * 2;

  while (heightLeft > 0) {
    position = heightLeft - imgHeight + margin;
    doc.addPage();
    doc.addImage(imgData, "JPEG", margin, position, usableWidth, imgHeight);
    heightLeft -= pageHeight - margin * 2;
  }

  doc.save(`${invoice.invoiceNumber || "invoice"}.pdf`);
}

function getCompanyInitials(name) {
  const fallback = "BI";
  if (!name || typeof name !== "string") return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function handleLogoFallback(img) {
  if (!img.dataset.fallbackStep) {
    img.dataset.fallbackStep = "1";
    img.src = "assets/digidat-logo.png";
    return;
  }
  if (img.dataset.fallbackStep === "1") {
    img.dataset.fallbackStep = "2";
    img.src = "assets/logo.png";
    return;
  }
  img.style.display = "none";
  const fallback = img.nextElementSibling;
  if (fallback) fallback.style.display = "flex";
}

function handleStampFallback(img) {
  if (!img.dataset.fallbackStep) {
    img.dataset.fallbackStep = "1";
    img.src = "assets/digidat-stamp.png";
    return;
  }
  if (img.dataset.fallbackStep === "1") {
    img.dataset.fallbackStep = "2";
    img.src = "assets/stamp.png";
    return;
  }
  img.style.display = "none";
}

// Default company data
const defaultCompanyData = {
  "name": "TechPro IT Services",
  "address": "123 Tech Plaza, Business District, Mumbai, 400001",
  "phone": "+91-22-1234-5678",
  "email": "invoices@techpro.com",
  "website": "www.techpro.com",
  "gstin": "27AABCT1234H1Z0",
  "bankName": "",
  "accountNumber": "",
  "ifscCode": ""
};

function applyInvoiceRecordToState(record) {
  const safeRecord = record || {};
  invoice = new Invoice();
  invoice.setCompanyInfo(safeRecord.company || companyData || defaultCompanyData);
  invoice.setCustomer(safeRecord.customer ? ensureCustomerState(safeRecord.customer) : null);
  invoice.items = Array.isArray(safeRecord.items) ? safeRecord.items.map(ensureInvoiceLineItem) : [];
  invoice.setInvoiceNumber(safeRecord.invoiceNumber || '');
  invoice.setInvoiceDate(safeRecord.invoiceDate || new Date().toISOString().split('T')[0]);
  invoice.setCustomerPurchaseOrderId(safeRecord.customerPurchaseOrderId || '');
  invoice.setPONumber(safeRecord.poNumber || safeRecord.dueDate || '');
  invoice.setPODate(safeRecord.poDate || safeRecord.invoiceDate || '');
  invoice.setShippingAddress(safeRecord.shippingAddress || '');
  invoice.setRoundOffEnabled(safeRecord.roundOffEnabled);
  currentInvoiceStatus = safeRecord.status || 'Active';
}

function syncInvoiceFormWithState() {
  const invoiceNumberDisplay = document.getElementById('invoiceNumberDisplay');
  if (invoiceNumberDisplay) invoiceNumberDisplay.textContent = invoice.invoiceNumber;

  const invoiceDateInput = document.getElementById('invoiceDate');
  if (invoiceDateInput) invoiceDateInput.value = invoice.invoiceDate;

  const poNumberInput = document.getElementById('poNumber');
  if (poNumberInput) poNumberInput.value = invoice.poNumber || '';

  const customerSelect = document.getElementById('customerSelect');
  if (customerSelect) customerSelect.value = invoice.customerSelected?.id || '';

  const roundOffSelect = document.getElementById('roundOffSelect');
  if (roundOffSelect) roundOffSelect.value = invoice.isRoundOffEnabled() ? 'Yes' : 'No';

  populateCustomerPurchaseOrderDropdown(invoice.customerSelected?.id || '', invoice.customerPurchaseOrderId || '');

  const customerPoSelect = document.getElementById('customerPoSelect');
  if (customerPoSelect) customerPoSelect.value = invoice.customerPurchaseOrderId || '';

  const poDateInput = document.getElementById('poDate');
  if (poDateInput) poDateInput.value = invoice.poDate || invoice.invoiceDate || '';

  const shippingAddressInput = document.getElementById('shippingAddress');
  if (shippingAddressInput) shippingAddressInput.value = invoice.shippingAddress || '';

  const itemSelectInput = document.getElementById('itemSelectInput');
  if (itemSelectInput) itemSelectInput.value = '';
  if (typeof _invoiceSelectedItem !== 'undefined') _invoiceSelectedItem = null;

  const quantityInput = document.getElementById('quantityInput');
  if (quantityInput) quantityInput.value = '1';

  const rateInput = document.getElementById('rateInput');
  if (rateInput) rateInput.value = '';
}

function setInvoiceSaveButtonLabel() {
  const saveButton = document.getElementById('saveInvoiceBtn');
  const cancelButton = document.getElementById('cancelInvoiceEditBtn');
  if (!saveButton) return;
  saveButton.textContent = editingInvoiceIndex !== null ? "Update Invoice" : "Save Invoice";
  if (cancelButton) {
    cancelButton.style.display = editingInvoiceIndex !== null ? 'inline-block' : 'none';
  }
}

function resetInvoiceEditor() {
  editingInvoiceIndex = null;
  invoice = new Invoice();
  invoice.setCompanyInfo(companyData);
  setTodayDate();
  generateNewInvoiceNumber();

  const customerSelect = document.getElementById('customerSelect');
  if (customerSelect) customerSelect.value = '';

  const customerPoSelect = document.getElementById('customerPoSelect');
  if (customerPoSelect) customerPoSelect.value = '';

  const poNumberInput = document.getElementById('poNumber');
  if (poNumberInput) poNumberInput.value = '';

  const shippingAddressInput = document.getElementById('shippingAddress');
  if (shippingAddressInput) shippingAddressInput.value = '';

  const roundOffSelect = document.getElementById('roundOffSelect');
  if (roundOffSelect) roundOffSelect.value = 'No';

  const itemSelect = document.getElementById('itemSelect');
  if (itemSelect) itemSelect.value = '';

  const quantityInput = document.getElementById('quantityInput');
  if (quantityInput) quantityInput.value = '1';

  const rateInput = document.getElementById('rateInput');
  if (rateInput) rateInput.value = '';

  populateCustomerPurchaseOrderDropdown('');
  renderItemsTable();
  updateInvoicePreview();
  setInvoiceSaveButtonLabel();
}

function cancelInvoiceEdit() {
  resetInvoiceEditor();
}

function restoreCurrentInvoiceDraftIntoEditor() {
  const draftPayload = readCurrentInvoiceDraftPayload();
  if (!draftPayload || !draftPayload.invoice) {
    renderItemsTable();
    updateInvoicePreview();
    setInvoiceSaveButtonLabel();
    return;
  }

  editingInvoiceIndex = normalizeEditingInvoiceIndex(draftPayload.editingInvoiceIndex);
  currentInvoiceStatus = draftPayload.invoiceStatus || 'Active';

  applyInvoiceRecordToState(draftPayload.invoice);
  syncInvoiceFormWithState();
  renderItemsTable();
  updateInvoicePreview();
  setInvoiceSaveButtonLabel();
}

function initializeStandalonePreviewPage() {
  storage = new InvoiceStorage();
  companyData = readStorageJson(STORAGE_KEYS.company, defaultCompanyData) || defaultCompanyData;
  customersData = getSafeStoredList(STORAGE_KEYS.customers).map(ensureCustomerState);
  vendorsData = getSafeStoredList(STORAGE_KEYS.vendors).map(ensureVendorState);
  itemsData = getSafeStoredList(STORAGE_KEYS.items).map(ensureCatalogItem);
  customerPurchaseOrdersData = getSafeCustomerPurchaseOrders();
  organizationPurchaseOrdersData = getSafeOrganizationPurchaseOrders();

  const draftPayload = readCurrentInvoiceDraftPayload();
  const saveButton = document.getElementById('saveInvoiceBtn');
  if (draftPayload && draftPayload.invoice) {
    editingInvoiceIndex = normalizeEditingInvoiceIndex(draftPayload.editingInvoiceIndex);
    currentInvoiceStatus = draftPayload.invoiceStatus || 'Active';
    applyInvoiceRecordToState(draftPayload.invoice);
    if (saveButton) {
      saveButton.style.display = draftPayload.readOnly === true ? 'none' : 'inline-flex';
    }
  } else {
    editingInvoiceIndex = null;
    invoice = new Invoice();
    invoice.setCompanyInfo(companyData);
    if (saveButton) {
      saveButton.style.display = 'inline-flex';
    }
  }

  setInvoiceSaveButtonLabel();
  updateInvoicePreview();
  updateStorageStatusBadge();
}

function returnToInvoiceEditor() {
  const draftPayload = readCurrentInvoiceDraftPayload();
  const shouldResetEditor = localStorage.getItem('invoiceEditorShouldReset') === '1';
  if (draftPayload?.readOnly === true || shouldResetEditor) {
    localStorage.removeItem(STORAGE_KEYS.currentInvoiceDraft);
  }
  if (draftPayload?.readOnly === true) {
    localStorage.setItem('invoiceEditorShouldReset', '1');
  }
  // invoiceEditorShouldReset is set by saveInvoice() when saved from preview
  // If not set, the draft is restored so the user can save from the main page
  window.location.href = "app.html";
}

function openInvoicePreviewPage() {
  syncInvoiceStateFromForm();
  // Opening a normal editor preview should preserve the current draft on return.
  // Clear any stale reset flag left over from an older saved-preview session.
  localStorage.removeItem('invoiceEditorShouldReset');
  persistCurrentInvoiceDraft();
  window.location.href = "invoice-preview.html";
}

// Initialize the application
function initializeApp() {
  invoice = new Invoice();
  storage = new InvoiceStorage();

  // Initialize as empty arrays
  customersData = [];
  vendorsData = [];
  itemsData = [];
  customerPurchaseOrdersData = [];
  organizationPurchaseOrdersData = [];

  // Load company data from localStorage or use default
  const savedCompany = localStorage.getItem(STORAGE_KEYS.company);
  companyData = savedCompany ? JSON.parse(savedCompany) : defaultCompanyData;
  localStorage.setItem(STORAGE_KEYS.company, JSON.stringify(companyData));
  invoice.setCompanyInfo(companyData);

  // Check if customers and items exist in localStorage
  const savedCustomers = localStorage.getItem(STORAGE_KEYS.customers);
  const savedVendors = localStorage.getItem(STORAGE_KEYS.vendors);
  const savedItems = localStorage.getItem(STORAGE_KEYS.items);
  const savedCustomerPurchaseOrders = localStorage.getItem(STORAGE_KEYS.customerPurchaseOrders);
  const savedOrganizationPurchaseOrders = localStorage.getItem(STORAGE_KEYS.organizationPurchaseOrders);

  if (savedCustomers) {
    const parsedCustomers = JSON.parse(savedCustomers);
    customersData = Array.isArray(parsedCustomers) ? parsedCustomers.map(ensureCustomerState) : [];
    localStorage.setItem(STORAGE_KEYS.customers, JSON.stringify(customersData));
  }
  if (savedVendors) {
    const parsedVendors = JSON.parse(savedVendors);
    vendorsData = Array.isArray(parsedVendors) ? parsedVendors.map(ensureVendorState) : [];
    localStorage.setItem(STORAGE_KEYS.vendors, JSON.stringify(vendorsData));
  }
  if (savedItems) {
    const parsedItems = JSON.parse(savedItems);
    itemsData = Array.isArray(parsedItems) ? parsedItems.map(ensureCatalogItem) : [];
    localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(itemsData));
  }
  if (savedCustomerPurchaseOrders) {
    const parsedCustomerPurchaseOrders = JSON.parse(savedCustomerPurchaseOrders);
    customerPurchaseOrdersData = Array.isArray(parsedCustomerPurchaseOrders)
      ? parsedCustomerPurchaseOrders.map(ensureCustomerPurchaseOrder)
      : [];
    persistCustomerPurchaseOrders();
  }
  if (savedOrganizationPurchaseOrders) {
    const parsedOrganizationPurchaseOrders = JSON.parse(savedOrganizationPurchaseOrders);
    organizationPurchaseOrdersData = Array.isArray(parsedOrganizationPurchaseOrders)
      ? parsedOrganizationPurchaseOrders.map(ensureOrganizationPurchaseOrder)
      : [];
    persistOrganizationPurchaseOrders();
  }

  // If both customers and items exist, show main section, otherwise show setup
  if (customersData.length > 0 && itemsData.length > 0) {
    showMainSection();
  } else {
    showSetupSection();
  }

  updateStorageStatusBadge();
}

function refreshAppStateFromStorage() {
  const setupSection = document.getElementById('setupSection');
  const mainSection = document.getElementById('mainSection');
  const wasMainVisible = !!mainSection && mainSection.style.display !== 'none';
  const wasSetupVisible = !!setupSection && setupSection.style.display !== 'none';
  const formSnapshot = {
    customerId: document.getElementById('customerSelect')?.value || '',
    itemId: document.getElementById('itemSelect')?.value || '',
    quantity: document.getElementById('quantityInput')?.value || '',
    rate: document.getElementById('rateInput')?.value || '',
    invoiceDate: document.getElementById('invoiceDate')?.value || '',
    poNumber: document.getElementById('poNumber')?.value || '',
    poDate: document.getElementById('poDate')?.value || '',
    shippingAddress: document.getElementById('shippingAddress')?.value || '',
    roundOff: document.getElementById('roundOffSelect')?.value || 'No',
    customerPoId: document.getElementById('customerPoSelect')?.value || '',
    // Customer PO form
    customerPoCustomer: document.getElementById('customerPoCustomer')?.value || '',
    customerPoNumber: document.getElementById('customerPoNumber')?.value || '',
    customerPoDate: document.getElementById('customerPoDate')?.value || '',
    customerPoStatus: document.getElementById('customerPoStatus')?.value || '',
    customerPoNotes: document.getElementById('customerPoNotes')?.value || '',
    // Org PO form
    organizationOrderVendor: document.getElementById('organizationOrderVendor')?.value || '',
    organizationOrderNumber: document.getElementById('organizationOrderNumber')?.value || '',
    organizationOrderDate: document.getElementById('organizationOrderDate')?.value || '',
    organizationOrderStatus: document.getElementById('organizationOrderStatus')?.value || '',
    organizationOrderNotes: document.getElementById('organizationOrderNotes')?.value || ''
  };

  const savedCompany = readStorageJson(STORAGE_KEYS.company, defaultCompanyData) || defaultCompanyData;
  const nextCustomers = getSafeStoredList(STORAGE_KEYS.customers).map(ensureCustomerState);
  const nextVendors = getSafeStoredList(STORAGE_KEYS.vendors).map(ensureVendorState);
  const nextItems = getSafeStoredList(STORAGE_KEYS.items).map(ensureCatalogItem);
  const nextCustomerPurchaseOrders = getSafeCustomerPurchaseOrders();
  const nextOrganizationPurchaseOrders = getSafeOrganizationPurchaseOrders();

  companyData = savedCompany;
  customersData = nextCustomers;
  vendorsData = nextVendors;
  itemsData = nextItems;
  customerPurchaseOrdersData = nextCustomerPurchaseOrders;
  organizationPurchaseOrdersData = nextOrganizationPurchaseOrders;

  if (invoice && typeof invoice.setCompanyInfo === "function") {
    invoice.setCompanyInfo(companyData);
  }

  if (customersData.length > 0 && itemsData.length > 0) {
    if (wasSetupVisible && !wasMainVisible) {
      showSetupSection();
    } else if (!wasMainVisible) {
      showMainSection();
    } else {
      if (setupSection) setupSection.style.display = 'none';
      if (mainSection) mainSection.style.display = 'block';
    }
  } else {
    showSetupSection();
  }

  if (customersData.length > 0 && itemsData.length > 0 && wasMainVisible) {
    populateCustomerDropdown();
    populateVendorDropdown();
    populateCustomerPurchaseOrderFormCustomers(formSnapshot.customerPoCustomer);
    populateCustomerPurchaseOrderItemDropdown();
    populateOrganizationPurchaseOrderItemDropdown();
    populateItemsDropdown();
    populateItemNameSuggestions();

    const customerSelect = document.getElementById('customerSelect');
    if (customerSelect && formSnapshot.customerId) {
      customerSelect.value = formSnapshot.customerId;
    }

    populateCustomerPurchaseOrderDropdown(formSnapshot.customerId || invoice?.customerSelected?.id || '', formSnapshot.customerPoId);

    const customerPoSelect = document.getElementById('customerPoSelect');
    if (customerPoSelect && formSnapshot.customerPoId) {
      customerPoSelect.value = formSnapshot.customerPoId;
    }

    const itemSelect = document.getElementById('itemSelect');
    if (itemSelect && formSnapshot.itemId) {
      itemSelect.value = formSnapshot.itemId;
    }

    const quantityInput = document.getElementById('quantityInput');
    if (quantityInput) {
      quantityInput.value = formSnapshot.quantity || quantityInput.value || '1';
    }

    const rateInput = document.getElementById('rateInput');
    if (rateInput) {
      rateInput.value = formSnapshot.rate || rateInput.value || '';
    }

    const invoiceDateInput = document.getElementById('invoiceDate');
    if (invoiceDateInput && formSnapshot.invoiceDate) {
      invoiceDateInput.value = formSnapshot.invoiceDate;
    }

    const poNumberInput = document.getElementById('poNumber');
    if (poNumberInput) {
      poNumberInput.value = formSnapshot.poNumber;
    }

    const poDateInput = document.getElementById('poDate');
    if (poDateInput && formSnapshot.poDate) {
      poDateInput.value = formSnapshot.poDate;
    }

    const shippingAddressInput = document.getElementById('shippingAddress');
    if (shippingAddressInput) {
      shippingAddressInput.value = formSnapshot.shippingAddress;
    }

    const roundOffSelect = document.getElementById('roundOffSelect');
    if (roundOffSelect) {
      roundOffSelect.value = formSnapshot.roundOff;
    }

    // Restore Customer PO form fields
    if (editingCustomerPurchaseOrderIndex === null) {
      const cpoNum = document.getElementById('customerPoNumber');
      const cpoDate = document.getElementById('customerPoDate');
      const cpoStatus = document.getElementById('customerPoStatus');
      const cpoNotes = document.getElementById('customerPoNotes');
      if (cpoNum && formSnapshot.customerPoNumber) cpoNum.value = formSnapshot.customerPoNumber;
      if (cpoDate && formSnapshot.customerPoDate) cpoDate.value = formSnapshot.customerPoDate;
      if (cpoStatus && formSnapshot.customerPoStatus) cpoStatus.value = formSnapshot.customerPoStatus;
      if (cpoNotes && formSnapshot.customerPoNotes) cpoNotes.value = formSnapshot.customerPoNotes;
    }

    // Restore Org PO form fields
    if (editingOrganizationPurchaseOrderIndex === null) {
      const orgVendor = document.getElementById('organizationOrderVendor');
      const orgNum = document.getElementById('organizationOrderNumber');
      const orgDate = document.getElementById('organizationOrderDate');
      const orgStatus = document.getElementById('organizationOrderStatus');
      const orgNotes = document.getElementById('organizationOrderNotes');
      if (orgVendor && formSnapshot.organizationOrderVendor) orgVendor.value = formSnapshot.organizationOrderVendor;
      if (orgNum && formSnapshot.organizationOrderNumber) orgNum.value = formSnapshot.organizationOrderNumber;
      if (orgDate && formSnapshot.organizationOrderDate) orgDate.value = formSnapshot.organizationOrderDate;
      if (orgStatus && formSnapshot.organizationOrderStatus) orgStatus.value = formSnapshot.organizationOrderStatus;
      if (orgNotes && formSnapshot.organizationOrderNotes) orgNotes.value = formSnapshot.organizationOrderNotes;
    }
  }

  displayCustomersList();
  displayItemsList();
  displayVendorsList();
  displayCustomerPurchaseOrdersList();
  displayOrganizationPurchaseOrdersList();

  const invoiceHistorySection = document.getElementById('invoiceHistorySection');
  if (invoiceHistorySection && invoiceHistorySection.style.display !== 'none') {
    showInvoiceHistory();
  }

  renderDashboardSummary();
  updateInvoicePreview();
  updateStorageStatusBadge();
}

// Show setup section
function showSetupSection() {
  document.getElementById('setupSection').style.display = 'block';
  document.getElementById('mainSection').style.display = 'none';
  
  // Load company info into form
  document.getElementById('companyName').value = companyData.name || '';
  document.getElementById('companyAddress').value = companyData.address || '';
  document.getElementById('companyPhone').value = companyData.phone || '';
  document.getElementById('companyEmail').value = companyData.email || '';
  document.getElementById('companyGST').value = companyData.gstin || '';
  document.getElementById('companyWebsite').value = companyData.website || '';
  document.getElementById('companyBank').value = companyData.bankName || '';
  document.getElementById('companyAccount').value = companyData.accountNumber || '';
  document.getElementById('companyIFSC').value = companyData.ifscCode || '';
  setCustomerFormMode();
  setVendorFormMode();
  displayCustomersList();
  displayVendorsList();
  displayItemsList();
  populateItemNameSuggestions();
}

// Save company info
function saveCompanyInfo() {
  const name = document.getElementById('companyName').value.trim();
  const address = document.getElementById('companyAddress').value.trim();
  const phone = document.getElementById('companyPhone').value.trim();
  const email = document.getElementById('companyEmail').value.trim();
  const gstin = document.getElementById('companyGST').value.trim();
  const website = document.getElementById('companyWebsite').value.trim();
  const bankName = document.getElementById('companyBank').value.trim();
  const accountNumber = document.getElementById('companyAccount').value.trim();
  const ifscCode = document.getElementById('companyIFSC').value.trim();

  if (!name || !address || !gstin) {
    alert('Please fill Company Name, Address, and GSTIN.');
    return;
  }

  if (!isValidGstin(gstin)) {
    alert('GSTIN format is invalid. It must be 15 characters (e.g. 36AABCU9603R1ZX).');
    document.getElementById('companyGST').focus();
    return;
  }

  companyData = {
    name: name,
    address: address,
    phone: phone,
    email: email,
    website: website,
    gstin: gstin,
    bankName: bankName,
    accountNumber: accountNumber,
    ifscCode: ifscCode
  };

  localStorage.setItem(STORAGE_KEYS.company, JSON.stringify(companyData));
  invoice.setCompanyInfo(companyData);

  alert('Company information saved successfully!');
}

function getDashboardDateRange() {
  const from = document.getElementById('dashboardDateFrom')?.value || '';
  const to = document.getElementById('dashboardDateTo')?.value || '';
  return { from, to };
}

function getFinancialYearBounds(fyLabel) {
  const match = String(fyLabel || '').match(/^(\d{2})-(\d{2})$/);
  if (!match) return null;

  const startYear = 2000 + parseInt(match[1], 10);
  const endYear = 2000 + parseInt(match[2], 10);
  return {
    from: `${startYear}-04-01`,
    to: `${endYear}-03-31`
  };
}

function getAvailableFinancialYears() {
  const labels = new Set();
  const collectLabel = (dateValue) => {
    const label = getFinancialYearLabel(dateValue);
    if (label) labels.add(label);
  };

  getSafeInvoices().forEach((entry) => collectLabel(entry.invoiceDate));
  getSafeCustomerPurchaseOrders().forEach((entry) => collectLabel(entry.poDate));
  getSafeOrganizationPurchaseOrders().forEach((entry) => collectLabel(entry.poDate));

  return Array.from(labels).sort((left, right) => right.localeCompare(left));
}

function populateDashboardFinancialYearOptions() {
  const select = document.getElementById('dashboardFinancialYear');
  if (!select) return;

  const currentValue = select.value || '';
  const years = getAvailableFinancialYears();
  select.innerHTML = '';

  years.forEach((label) => {
    const option = document.createElement('option');
    option.value = label;
    option.textContent = `FY ${label}`;
    select.appendChild(option);
  });

  const todayFy = getFinancialYearLabel(new Date().toISOString().split('T')[0]);

  if (currentValue && years.includes(currentValue)) {
    select.value = currentValue;
  } else if (todayFy && years.includes(todayFy)) {
    select.value = todayFy;
  } else if (years.length > 0) {
    select.value = years[years.length - 1]; // most recent
  }
}

function handleDashboardFinancialYearChange() {
  const fySelect = document.getElementById('dashboardFinancialYear');
  const fromInput = document.getElementById('dashboardDateFrom');
  const toInput = document.getElementById('dashboardDateTo');
  if (!fySelect || !fromInput || !toInput) return;

  if (!fySelect.value) {
    fromInput.value = '';
    toInput.value = '';
    renderDashboardSummary();
    return;
  }

  const bounds = getFinancialYearBounds(fySelect.value);
  if (!bounds) {
    renderDashboardSummary();
    return;
  }

  fromInput.value = bounds.from;
  toInput.value = bounds.to;
  renderDashboardSummary();
}

function syncDashboardFinancialYearWithDateRange() {
  const fySelect = document.getElementById('dashboardFinancialYear');
  const fromInput = document.getElementById('dashboardDateFrom');
  const toInput = document.getElementById('dashboardDateTo');
  if (!fySelect) return;

  const { from, to } = getDashboardDateRange();

  // If date inputs are filled, sync FY dropdown to match
  if (from || to) {
    if (from && to) {
      const matchingYear = getAvailableFinancialYears().find((label) => {
        const bounds = getFinancialYearBounds(label);
        return bounds && bounds.from === from && bounds.to === to;
      });
      fySelect.value = matchingYear || fySelect.value;
    }
    return;
  }

  // Date inputs are empty — if a FY is selected, populate the date inputs from it
  if (fySelect.value) {
    const bounds = getFinancialYearBounds(fySelect.value);
    if (bounds) {
      if (fromInput) fromInput.value = bounds.from;
      if (toInput) toInput.value = bounds.to;
    }
  }
}

function isDateWithinRange(value, range) {
  const dateValue = String(value || '').trim();
  if (!dateValue) return false;
  if (range.from && dateValue < range.from) return false;
  if (range.to && dateValue > range.to) return false;
  return true;
}

function clearDashboardDateRange() {
  const fromInput = document.getElementById('dashboardDateFrom');
  const toInput = document.getElementById('dashboardDateTo');
  const fySelect = document.getElementById('dashboardFinancialYear');
  const todayFy = getFinancialYearLabel(new Date().toISOString().split('T')[0]);
  const years = getAvailableFinancialYears();
  const targetFy = (todayFy && years.includes(todayFy)) ? todayFy : (years[years.length - 1] || '');
  const bounds = targetFy ? getFinancialYearBounds(targetFy) : null;
  if (fySelect) fySelect.value = targetFy;
  if (fromInput) fromInput.value = bounds?.from || '';
  if (toInput) toInput.value = bounds?.to || '';
  renderDashboardSummary();
}

function getDashboardMetrics() {
  const range = getDashboardDateRange();
  const invoices = getSafeInvoices().filter((entry) => entry.status !== 'Cancelled' && isDateWithinRange(entry.invoiceDate, range));
  const customerPurchaseOrders = getSafeCustomerPurchaseOrders().filter((entry) => isDateWithinRange(entry.poDate, range));
  const organizationPurchaseOrders = getSafeOrganizationPurchaseOrders().filter((entry) => isDateWithinRange(entry.poDate, range));
  const totalSales = invoices.reduce((sum, entry) => sum + safeNumber(entry.grandTotal), 0);
  const totalPurchases = organizationPurchaseOrders.reduce((sum, entry) => sum + safeNumber(entry.amount), 0);
  const totalCustomerPoValue = customerPurchaseOrders.reduce((sum, entry) => sum + safeNumber(entry.amount), 0);
  const totalCgst = invoices.reduce((sum, entry) => sum + safeNumber(entry.cgst), 0);
  const totalSgst = invoices.reduce((sum, entry) => sum + safeNumber(entry.sgst), 0);
  const totalIgst = invoices.reduce((sum, entry) => sum + safeNumber(entry.igst), 0);
  const totalPurchaseCgst = organizationPurchaseOrders.reduce((sum, entry) => sum + safeNumber(ensureOrganizationPurchaseOrder(entry).cgst), 0);
  const totalPurchaseSgst = organizationPurchaseOrders.reduce((sum, entry) => sum + safeNumber(ensureOrganizationPurchaseOrder(entry).sgst), 0);
  const totalPurchaseIgst = organizationPurchaseOrders.reduce((sum, entry) => sum + safeNumber(ensureOrganizationPurchaseOrder(entry).igst), 0);

  const customerTotals = new Map();
  invoices.forEach((entry) => {
    const customerName = String(entry?.customer?.name || 'Unknown Customer').trim() || 'Unknown Customer';
    customerTotals.set(customerName, (customerTotals.get(customerName) || 0) + safeNumber(entry.grandTotal));
  });

  const vendorTotals = new Map();
  organizationPurchaseOrders.forEach((entry) => {
    const vendorName = String(entry?.vendorName || 'Unknown Vendor').trim() || 'Unknown Vendor';
    vendorTotals.set(vendorName, (vendorTotals.get(vendorName) || 0) + safeNumber(entry.amount));
  });

  const itemTotals = new Map();
  invoices.forEach((entry) => {
    (Array.isArray(entry?.items) ? entry.items : []).forEach((item) => {
      const itemName = String(item?.name || 'Unknown Item').trim() || 'Unknown Item';
      const amount = safeNumber(item?.total);
      const quantity = safeNumber(item?.quantity);
      const existing = itemTotals.get(itemName) || { value: 0, quantity: 0 };
      itemTotals.set(itemName, {
        value: existing.value + amount,
        quantity: existing.quantity + quantity
      });
    });
  });

  const monthlySalesMap = new Map();
  const monthlyTaxMap = new Map();
  invoices.forEach((entry) => {
    const dateValue = String(entry?.invoiceDate || '').trim();
    if (!dateValue) return;
    const monthKey = dateValue.slice(0, 7);
    monthlySalesMap.set(monthKey, (monthlySalesMap.get(monthKey) || 0) + safeNumber(entry.grandTotal));
    const existingTax = monthlyTaxMap.get(monthKey) || { cgst: 0, sgst: 0, igst: 0 };
    monthlyTaxMap.set(monthKey, {
      cgst: existingTax.cgst + safeNumber(entry.cgst),
      sgst: existingTax.sgst + safeNumber(entry.sgst),
      igst: existingTax.igst + safeNumber(entry.igst)
    });
  });

  const monthlyPurchasesMap = new Map();
  organizationPurchaseOrders.forEach((entry) => {
    const dateValue = String(entry?.poDate || '').trim();
    if (!dateValue) return;
    const monthKey = dateValue.slice(0, 7);
    monthlyPurchasesMap.set(monthKey, (monthlyPurchasesMap.get(monthKey) || 0) + safeNumber(entry.amount));
  });

  const monthKeys = Array.from(new Set([
    ...monthlySalesMap.keys(),
    ...monthlyPurchasesMap.keys()
  ])).sort((left, right) => left.localeCompare(right)).slice(-6);
  const monthlySales = monthKeys.map((month) => ({
    month,
    sales: monthlySalesMap.get(month) || 0,
    purchases: monthlyPurchasesMap.get(month) || 0
  }));
  const monthlyTax = monthKeys.map((month) => {
    const tax = monthlyTaxMap.get(month) || { cgst: 0, sgst: 0, igst: 0 };
    return {
      month,
      cgst: tax.cgst,
      sgst: tax.sgst,
      igst: tax.igst
    };
  });

  const selectedFy = document.getElementById('dashboardFinancialYear')?.value || '';
  let fyComparison = null;
  if (selectedFy) {
    const currentBounds = getFinancialYearBounds(selectedFy);
    const match = String(selectedFy).match(/^(\d{2})-(\d{2})$/);
    if (currentBounds && match) {
      const previousFy = `${String((parseInt(match[1], 10) - 1 + 100) % 100).padStart(2, '0')}-${match[1]}`;
      const previousBounds = getFinancialYearBounds(previousFy);
      if (previousBounds) {
        const previousInvoices = getSafeInvoices().filter((entry) => isDateWithinRange(entry.invoiceDate, previousBounds));
        const previousPurchases = getSafeOrganizationPurchaseOrders().filter((entry) => isDateWithinRange(entry.poDate, previousBounds));
        const previousSalesTotal = previousInvoices.reduce((sum, entry) => sum + safeNumber(entry.grandTotal), 0);
        const previousPurchasesTotal = previousPurchases.reduce((sum, entry) => sum + safeNumber(entry.amount), 0);
        fyComparison = {
          currentFy: selectedFy,
          previousFy,
          currentSales: totalSales,
          previousSales: previousSalesTotal,
          currentPurchases: totalPurchases,
          previousPurchases: previousPurchasesTotal
        };
      }
    }
  }

  return {
    range,
    totalSales,
    totalCustomerPoValue,
    totalPurchases,
    totalCgst,
    totalSgst,
    totalIgst,
    totalPurchaseCgst,
    totalPurchaseSgst,
    totalPurchaseIgst,
    netBusiness: totalSales - totalPurchases,
    openCustomerPoCount: customerPurchaseOrders.filter((entry) => entry.status === 'Open').length,
    openPurchaseCount: organizationPurchaseOrders.filter((entry) => entry.status === 'Placed').length,
    invoiceCount: invoices.length,
    customerPoCount: customerPurchaseOrders.length,
    purchaseCount: organizationPurchaseOrders.length,
    averageInvoiceValue: invoices.length ? totalSales / invoices.length : 0,
    topCustomers: Array.from(customerTotals.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value })),
    topVendors: Array.from(vendorTotals.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value })),
    topItems: Array.from(itemTotals.entries())
      .sort((left, right) => right[1].value - left[1].value)
      .slice(0, 5)
      .map(([name, totals]) => ({ name, value: totals.value, quantity: totals.quantity })),
    monthlySales,
    monthlyTax,
    fyComparison
  };
}

function renderDashboardGraph(metrics) {
  const container = document.getElementById('dashboardGraph');
  if (!container) return;

  const monthlySeries = Array.isArray(metrics.monthlySales) ? metrics.monthlySales : [];
  const monthlyTaxSeries = Array.isArray(metrics.monthlyTax) ? metrics.monthlyTax : [];

  // Pie chart — customer-wise sales
  const PIE_COLORS = ['#2563eb', '#16a34a', '#f97316', '#9333ea', '#0891b2', '#dc2626'];
  const pieData = (metrics.topCustomers || []).filter((c) => c.value > 0);
  const pieTotal = pieData.reduce((s, c) => s + c.value, 0);

  const formatMonthLabel = (key) => {
    const [y, m] = key.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[parseInt(m, 10) - 1] || m} ${String(y).slice(-2)}`;
  };

  let pieSections = '';
  let legendItems = '';
  if (pieData.length > 0) {
    let cumDeg = 0;
    const gradientStops = pieData.map((c, i) => {
      const deg = (c.value / pieTotal) * 360;
      const stop = `${PIE_COLORS[i % PIE_COLORS.length]} ${cumDeg}deg ${cumDeg + deg}deg`;
      cumDeg += deg;
      return stop;
    }).join(', ');

    pieSections = `
      <div class="dashboard-pie-wrap">
        <div class="dashboard-pie" style="background: conic-gradient(${gradientStops});"></div>
      </div>`;

    legendItems = pieData.map((c, i) => `
      <div class="dashboard-pie-legend-row">
        <span class="dashboard-pie-legend-dot" style="background:${PIE_COLORS[i % PIE_COLORS.length]};"></span>
        <span class="dashboard-pie-legend-name">${c.name}</span>
        <span class="dashboard-pie-legend-value">${formatMoney(c.value)} (${((c.value / pieTotal) * 100).toFixed(1)}%)</span>
      </div>`).join('');
  } else {
    pieSections = '<div class="dashboard-empty">No sales data for the selected range.</div>';
  }

  const maxMonthlyValue = Math.max(...monthlySeries.flatMap((entry) => [Math.abs(entry.sales), Math.abs(entry.purchases)]), 1);
  container.innerHTML = `
    <div class="dashboard-graph-grid">
      <section class="dashboard-chart-panel">
        <div class="dashboard-panel-title">Monthly Revenue Trend</div>
        ${monthlySeries.length
          ? `<div class="dashboard-trend-list">
              ${monthlySeries.map((entry) => {
                const salesPct = Math.round((Math.abs(entry.sales) / maxMonthlyValue) * 100);
                const purchPct = Math.round((Math.abs(entry.purchases) / maxMonthlyValue) * 100);
                return `
                  <div class="dashboard-trend-row">
                    <div class="dashboard-trend-label">${formatMonthLabel(entry.month)}</div>
                    <div class="dashboard-trend-bars">
                      <div class="dashboard-trend-bar-wrap">
                        <div class="dashboard-trend-bar dashboard-trend-bar-sales" style="width:${salesPct}%"></div>
                        <span class="dashboard-trend-val">${formatMoney(entry.sales)}</span>
                      </div>
                      <div class="dashboard-trend-bar-wrap">
                        <div class="dashboard-trend-bar dashboard-trend-bar-purchases" style="width:${purchPct}%"></div>
                        <span class="dashboard-trend-val dashboard-trend-val-purchases">${formatMoney(entry.purchases)}</span>
                      </div>
                    </div>
                  </div>`;
              }).join('')}
            </div>
            <div class="dashboard-trend-legend">
              <span class="dashboard-trend-legend-dot" style="background:#0d9488;"></span> Sales &nbsp;
              <span class="dashboard-trend-legend-dot" style="background:#fb923c;"></span> Purchases
            </div>`
          : '<div class="dashboard-empty">No monthly data for the selected range.</div>'}
      </section>
      <section class="dashboard-chart-panel">
        <div class="dashboard-panel-title">Tax Summary By Month</div>
        <div class="dashboard-tax-list">
          ${monthlyTaxSeries.length
            ? monthlyTaxSeries.map((entry) => `
                <div class="dashboard-tax-row">
                  <div class="dashboard-tax-month">${formatMonthLabel(entry.month)}</div>
                  <div class="dashboard-tax-values">
                    <span>CGST ${formatMoney(entry.cgst)}</span>
                    <span>SGST ${formatMoney(entry.sgst)}</span>
                    <span>IGST ${formatMoney(entry.igst)}</span>
                  </div>
                </div>
              `).join('')
            : '<div class="dashboard-empty">No tax data for the selected range.</div>'}
        </div>
      </section>
      <section class="dashboard-chart-panel">
        <div class="dashboard-panel-title">Sales by Customer</div>
        <div class="dashboard-pie-container">
          ${pieSections}
          <div class="dashboard-pie-legend">${legendItems}</div>
        </div>
      </section>
    </div>
  `;
}

function formatDashboardChange(current, previous) {
  const previousValue = safeNumber(previous);
  const currentValue = safeNumber(current);
  if (previousValue === 0) {
    return currentValue === 0 ? 'No change from previous FY' : 'New activity vs previous FY';
  }

  const delta = ((currentValue - previousValue) / previousValue) * 100;
  const direction = delta >= 0 ? 'up' : 'down';
  return `${Math.abs(delta).toFixed(1)}% ${direction} vs previous FY`;
}

function renderDashboardSummary() {
  const container = document.getElementById('dashboardSummary');
  if (!container) return;

  populateDashboardFinancialYearOptions();
  syncDashboardFinancialYearWithDateRange();

  const metrics = getDashboardMetrics();
  const fyLabel = document.getElementById('dashboardFinancialYear')?.value || '';
  const hasRange = metrics.range.from || metrics.range.to;
  const rangeLabel = hasRange
    ? `${metrics.range.from || 'Start'} → ${metrics.range.to || 'Today'}`
    : 'All time';

  const fySuffix = fyLabel ? ` &nbsp;·&nbsp; FY ${fyLabel}` : '';

  container.innerHTML = `
    <div class="dashboard-filter-bar">
      <span class="dashboard-filter-bar-icon">📅</span>
      <span>${rangeLabel}${fySuffix}</span>
    </div>

    <div class="dashboard-section-label">Overview</div>
    <div class="dashboard-grid">
      <article class="dashboard-card dashboard-card-sales">
        <span class="dashboard-card-icon">💰</span>
        <div class="dashboard-card-label">Sales</div>
        <div class="dashboard-card-value">${formatMoney(metrics.totalSales)}</div>
        <div class="dashboard-card-meta">${metrics.invoiceCount} invoice(s)</div>
      </article>
      <article class="dashboard-card dashboard-card-customer-po">
        <span class="dashboard-card-icon">📋</span>
        <div class="dashboard-card-label">Customer POs</div>
        <div class="dashboard-card-value">${formatMoney(metrics.totalCustomerPoValue)}</div>
        <div class="dashboard-card-meta">${metrics.customerPoCount} received, ${metrics.openCustomerPoCount} open</div>
      </article>
      <article class="dashboard-card dashboard-card-purchases">
        <span class="dashboard-card-icon">🛒</span>
        <div class="dashboard-card-label">Purchases</div>
        <div class="dashboard-card-value">${formatMoney(metrics.totalPurchases)}</div>
        <div class="dashboard-card-meta">${metrics.purchaseCount} placed, ${metrics.openPurchaseCount} active</div>
      </article>
      <article class="dashboard-card dashboard-card-net">
        <span class="dashboard-card-icon">📊</span>
        <div class="dashboard-card-label">Net Position</div>
        <div class="dashboard-card-value">${formatMoney(metrics.netBusiness)}</div>
        <div class="dashboard-card-meta">Sales minus purchases</div>
      </article>
    </div>

    <div class="dashboard-section-label">Insights</div>
    <div class="dashboard-insights-grid">
      <article class="dashboard-insight-card">
        <div class="dashboard-panel-title">Avg Invoice Value</div>
        <div class="dashboard-insight-value">${formatMoney(metrics.averageInvoiceValue)}</div>
        <div class="dashboard-card-meta">Across ${metrics.invoiceCount} invoice(s)</div>
      </article>
      <article class="dashboard-insight-card">
        <div class="dashboard-panel-title">Open Commitments</div>
        <div class="dashboard-insight-value">${metrics.openCustomerPoCount + metrics.openPurchaseCount}</div>
        <div class="dashboard-card-meta">${metrics.openCustomerPoCount} customer POs · ${metrics.openPurchaseCount} purchase order(s)</div>
      </article>
      <article class="dashboard-insight-card">
        <div class="dashboard-panel-title">Tax Collected (Sales)</div>
        <div class="dashboard-tax-pill-row">
          <span class="dashboard-tax-pill">CGST ${formatMoney(metrics.totalCgst)}</span>
          <span class="dashboard-tax-pill">SGST ${formatMoney(metrics.totalSgst)}</span>
          <span class="dashboard-tax-pill">IGST ${formatMoney(metrics.totalIgst)}</span>
        </div>
        <div class="dashboard-panel-title" style="margin-top:10px;">Tax Paid (Purchases)</div>
        <div class="dashboard-tax-pill-row">
          <span class="dashboard-tax-pill" style="background:#fff7ed;color:#9a3412;border-color:#fed7aa;">CGST ${formatMoney(metrics.totalPurchaseCgst)}</span>
          <span class="dashboard-tax-pill" style="background:#fff7ed;color:#9a3412;border-color:#fed7aa;">SGST ${formatMoney(metrics.totalPurchaseSgst)}</span>
          <span class="dashboard-tax-pill" style="background:#fff7ed;color:#9a3412;border-color:#fed7aa;">IGST ${formatMoney(metrics.totalPurchaseIgst)}</span>
        </div>
        <div class="dashboard-card-meta" style="margin-top:6px;">For the selected range</div>
      </article>
    </div>

    ${metrics.fyComparison ? `
      <div class="dashboard-section-label">Year on Year</div>
      <div class="dashboard-insights-grid">
        <article class="dashboard-insight-card">
          <div class="dashboard-panel-title">FY Sales</div>
          <div class="dashboard-insight-value">${formatMoney(metrics.fyComparison.currentSales)}</div>
          <div class="dashboard-card-meta">FY ${metrics.fyComparison.currentFy}: ${formatDashboardChange(metrics.fyComparison.currentSales, metrics.fyComparison.previousSales)}</div>
        </article>
        <article class="dashboard-insight-card">
          <div class="dashboard-panel-title">FY Purchases</div>
          <div class="dashboard-insight-value">${formatMoney(metrics.fyComparison.currentPurchases)}</div>
          <div class="dashboard-card-meta">FY ${metrics.fyComparison.currentFy}: ${formatDashboardChange(metrics.fyComparison.currentPurchases, metrics.fyComparison.previousPurchases)}</div>
        </article>
      </div>
    ` : ''}

    <div class="dashboard-section-label">Top Performers</div>
    <div class="dashboard-lists-grid">
      <section class="dashboard-list-card">
        <div class="dashboard-panel-title">Top Customers</div>
        ${metrics.topCustomers.length
          ? metrics.topCustomers.map((entry, index) => `
              <div class="dashboard-list-row">
                <span class="dashboard-list-rank">${index + 1}</span>
                <span class="dashboard-list-name">${entry.name}</span>
                <span class="dashboard-list-value">${formatMoney(entry.value)}</span>
              </div>`).join('')
          : '<div class="dashboard-empty">No customer sales for the selected range.</div>'}
      </section>
      <section class="dashboard-list-card">
        <div class="dashboard-panel-title">Top Vendors</div>
        ${metrics.topVendors.length
          ? metrics.topVendors.map((entry, index) => `
              <div class="dashboard-list-row">
                <span class="dashboard-list-rank">${index + 1}</span>
                <span class="dashboard-list-name">${entry.name}</span>
                <span class="dashboard-list-value">${formatMoney(entry.value)}</span>
              </div>`).join('')
          : '<div class="dashboard-empty">No purchase records for the selected range.</div>'}
      </section>
      <section class="dashboard-list-card">
        <div class="dashboard-panel-title">Top Items / Services</div>
        ${metrics.topItems.length
          ? metrics.topItems.map((entry, index) => `
              <div class="dashboard-list-row">
                <span class="dashboard-list-rank">${index + 1}</span>
                <span class="dashboard-list-name">${entry.name}</span>
                <span class="dashboard-list-value">${formatMoney(entry.value)}</span>
              </div>`).join('')
          : '<div class="dashboard-empty">No item sales for the selected range.</div>'}
      </section>
    </div>
  `;

  renderDashboardGraph(metrics);
}

function showWorkspaceView(view) {
  currentWorkspaceView = view;

  const panelMap = {
    invoice: 'invoiceWorkspace',
    'customer-pos': 'customerPoWorkspace',
    purchases: 'purchaseWorkspace',
    dashboard: 'dashboardWorkspace',
    quotation: 'quotationWorkspace'
  };

  const tabMap = {
    invoice: 'workspaceTabInvoice',
    'customer-pos': 'workspaceTabCustomerPos',
    purchases: 'workspaceTabPurchases',
    dashboard: 'workspaceTabDashboard',
    quotation: 'workspaceTabQuotation'
  };

  Object.entries(panelMap).forEach(([key, id]) => {
    const panel = document.getElementById(id);
    if (panel) {
      panel.classList.toggle('active', key === view);
    }
  });

  Object.entries(tabMap).forEach(([key, id]) => {
    const tab = document.getElementById(id);
    if (tab) {
      tab.classList.toggle('active', key === view);
    }
  });

  if (view === 'dashboard') {
    renderDashboardSummary();
  }

  if (view === 'quotation' && typeof window.refreshQuotationWorkspace === 'function') {
    try { window.refreshQuotationWorkspace(); } catch(e) { console.error('refreshQuotationWorkspace failed:', e); }
  }
}

function populateCustomerPurchaseOrderFormCustomers(selectedCustomerId = '') {
  const select = document.getElementById('customerPoCustomer');
  if (!select) return;

  select.innerHTML = '<option value="">-- Select Customer --</option>';
  customersData.forEach((customer) => {
    const safeCustomer = ensureCustomerState(customer);
    const option = document.createElement('option');
    option.value = safeCustomer.id;
    option.textContent = safeCustomer.name;
    select.appendChild(option);
  });

  if (selectedCustomerId) {
    select.value = selectedCustomerId;
  }
}

function getCustomerPurchaseOrderDraftTotal() {
  return customerPurchaseOrderDraftItems.reduce((sum, item) => sum + safeNumber(item.total), 0);
}

function syncCustomerPurchaseOrderAmountField() {
  const amountInput = document.getElementById('customerPoAmount');
  if (!amountInput) return;
  amountInput.value = getCustomerPurchaseOrderDraftTotal().toFixed(2);
}

function clearCustomerPurchaseOrderItemEntryFields() {
  const itemInput = document.getElementById('customerPoItemInput');
  const quantityInput = document.getElementById('customerPoItemQuantity');
  const rateInput = document.getElementById('customerPoItemRate');
  const descriptionInput = document.getElementById('customerPoItemDescription');
  if (itemInput) itemInput.value = '';
  if (quantityInput) quantityInput.value = '';
  if (rateInput) rateInput.value = '';
  if (descriptionInput) descriptionInput.value = '';
  const sugg = document.getElementById('customerPoItemSuggestions');
  if (sugg) sugg.style.display = 'none';
}

function populateCustomerPurchaseOrderItemDropdown(selectedItemId = '') {
  // Keep hidden select for legacy compatibility
  let hidden = document.getElementById('customerPoItemSelect');
  if (!hidden) {
    hidden = document.createElement('select');
    hidden.id = 'customerPoItemSelect';
    hidden.style.display = 'none';
    document.body.appendChild(hidden);
  }
  hidden.innerHTML = '<option value=""></option>';
  itemsData.forEach((item) => {
    const safeItem = ensureCatalogItem(item);
    const opt = document.createElement('option');
    opt.value = safeItem.id;
    opt.textContent = safeItem.name;
    opt.dataset.item = JSON.stringify(safeItem);
    hidden.appendChild(opt);
  });
  if (selectedItemId) hidden.value = selectedItemId;
}

function populateOrganizationPurchaseOrderItemDropdown() {
  // Keep hidden select for legacy compatibility
  let hidden = document.getElementById('organizationPoItemSelect');
  if (!hidden) {
    hidden = document.createElement('select');
    hidden.id = 'organizationPoItemSelect';
    hidden.style.display = 'none';
    document.body.appendChild(hidden);
  }
  hidden.innerHTML = '<option value=""></option>';
  itemsData.forEach((item) => {
    const safeItem = ensureCatalogItem(item);
    const opt = document.createElement('option');
    opt.value = safeItem.id;
    opt.textContent = safeItem.name;
    opt.dataset.item = JSON.stringify(safeItem);
    hidden.appendChild(opt);
  });
}

function handleCustomerPurchaseOrderItemSelection() {
  const select = document.getElementById('customerPoItemSelect');
  const rateInput = document.getElementById('customerPoItemRate');
  const descriptionInput = document.getElementById('customerPoItemDescription');
  const quantityInput = document.getElementById('customerPoItemQuantity');
  if (!select || !rateInput || !descriptionInput || !quantityInput) return;

  if (!select.value) {
    rateInput.value = '';
    descriptionInput.value = '';
    quantityInput.value = '';
    return;
  }

  const itemData = JSON.parse(select.options[select.selectedIndex].dataset.item);
  rateInput.value = String(safeNumber(itemData.defaultRate) || '');
  descriptionInput.value = itemData.description || '';
  if (!quantityInput.value) {
    quantityInput.value = '1';
  }
}

function renderCustomerPurchaseOrderItemsTable() {
  const tableBody = document.getElementById('customerPoItemsTableBody');
  if (!tableBody) return;

  tableBody.innerHTML = '';

  if (customerPurchaseOrderDraftItems.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No PO items added yet</td></tr>';
    syncCustomerPurchaseOrderAmountField();
    return;
  }

  customerPurchaseOrderDraftItems.forEach((item, index) => {
    const safeItem = ensureOrderLineItem(item);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>
        <strong>${safeItem.name}</strong>
        <textarea onchange="updateCustomerPurchaseOrderDraftItemDescription(${index}, this.value)">${safeItem.description || ''}</textarea>
      </td>
      <td>${safeItem.hsnSac}</td>
      <td class="text-right">
        <input class="inline-qty-input" type="number" min="1" step="1" value="${safeItem.quantity}" onchange="updateCustomerPurchaseOrderDraftItemQuantity(${index}, this.value)">
      </td>
      <td class="text-right">
        <input class="inline-rate-input" type="number" min="0" step="0.01" value="${safeItem.rate}" onchange="updateCustomerPurchaseOrderDraftItemRate(${index}, this.value)">
      </td>
      <td class="text-right">${formatMoney(safeItem.total)}</td>
      <td class="text-right"><button class="btn btn-danger" onclick="removeCustomerPurchaseOrderDraftItem(${index})">Delete</button></td>
    `;
    tableBody.appendChild(row);
  });

  syncCustomerPurchaseOrderAmountField();
}

// ── Customer PO item combo-box ──
function _updatePoItemSuggestions(inputId, suggestionsId) {
  const input = document.getElementById(inputId);
  const suggestions = document.getElementById(suggestionsId);
  if (!suggestions) return;
  const normalized = String(input?.value || '').trim().toLowerCase();
  const matches = (itemsData || [])
    .map(ensureCatalogItem)
    .filter((i) => i.name && (!normalized || i.name.toLowerCase().startsWith(normalized)))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matches.length === 0) { suggestions.innerHTML = ''; suggestions.style.display = 'none'; return; }
  suggestions.innerHTML = '';
  const clearOpt = document.createElement('option');
  clearOpt.value = ''; clearOpt.textContent = '-- Deselect --';
  suggestions.appendChild(clearOpt);
  matches.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = `${item.name}  —  ${formatMoney(item.defaultRate)}`;
    opt.dataset.item = JSON.stringify(item);
    suggestions.appendChild(opt);
  });
  suggestions.selectedIndex = 0;
  suggestions.style.display = 'block';
}

function _selectPoItem(item, rateInputId, descInputId, qtyInputId, panelId) {
  const rateInput = document.getElementById(rateInputId);
  const descInput = document.getElementById(descInputId);
  const qtyInput = document.getElementById(qtyInputId);
  const panel = document.getElementById(panelId);
  if (rateInput) rateInput.value = item.defaultRate;
  if (descInput && !descInput.value) descInput.value = item.description || '';
  if (qtyInput && !qtyInput.value) qtyInput.value = '1';
  if (panel) panel.style.display = 'none';
}

function handleCpoItemInput(event) {
  const val = String(event?.target?.value || '').trim();
  _updatePoItemSuggestions('customerPoItemInput', 'customerPoItemSuggestions');
  const panel = document.getElementById('cpoNewItemPanel');
  const rateInput = document.getElementById('customerPoItemRate');
  if (!val) { if (panel) panel.style.display = 'none'; if (rateInput) rateInput.value = ''; return; }
  const exact = (itemsData || []).find((i) => ensureCatalogItem(i).name.toLowerCase() === val.toLowerCase());
  if (exact) {
    _selectPoItem(ensureCatalogItem(exact), 'customerPoItemRate', 'customerPoItemDescription', 'customerPoItemQuantity', 'cpoNewItemPanel');
  } else {
    if (panel) panel.style.display = 'block';
    if (rateInput) rateInput.value = '';
  }
}

function handleCpoItemSuggestionChange(event) {
  const suggestions = document.getElementById('customerPoItemSuggestions');
  const input = document.getElementById('customerPoItemInput');
  if (!event.target.value) {
    if (input) input.value = '';
    document.getElementById('customerPoItemRate').value = '';
    document.getElementById('cpoNewItemPanel').style.display = 'none';
    suggestions.style.display = 'none';
    return;
  }
  const opt = suggestions.options[suggestions.selectedIndex];
  const item = opt?.dataset?.item ? ensureCatalogItem(JSON.parse(opt.dataset.item)) : null;
  if (item && input) {
    input.value = item.name;
    _selectPoItem(item, 'customerPoItemRate', 'customerPoItemDescription', 'customerPoItemQuantity', 'cpoNewItemPanel');
  }
  suggestions.style.display = 'none';
  document.getElementById('customerPoItemQuantity')?.focus();
}

function clearCpoItemCombo() {
  const input = document.getElementById('customerPoItemInput');
  if (input) input.value = '';
  document.getElementById('customerPoItemRate').value = '';
  document.getElementById('customerPoItemQuantity').value = '';
  document.getElementById('customerPoItemDescription').value = '';
  const panel = document.getElementById('cpoNewItemPanel');
  if (panel) { panel.style.display = 'none'; document.getElementById('cpoNewItemHsn').value = ''; document.getElementById('cpoNewItemDescription').value = ''; }
  const sugg = document.getElementById('customerPoItemSuggestions');
  if (sugg) sugg.style.display = 'none';
}

async function saveCpoNewItemAndAdd() {
  const name = String(document.getElementById('customerPoItemInput')?.value || '').trim();
  const description = String(document.getElementById('cpoNewItemDescription')?.value || '').trim();
  const hsnSac = normalizeHsnSac(document.getElementById('cpoNewItemHsn')?.value || '');
  const rate = safeNumber(document.getElementById('customerPoItemRate')?.value);
  const quantity = safeNumber(document.getElementById('customerPoItemQuantity')?.value) || 1;

  if (!name) { alert('Item name is required.'); return; }
  if (!description) { alert('Description is required.'); document.getElementById('cpoNewItemDescription').focus(); return; }
  if (rate <= 0) { alert('Rate must be greater than 0.'); document.getElementById('customerPoItemRate').focus(); return; }

  const duplicate = itemsData.find((i) => ensureCatalogItem(i).name.toLowerCase() === name.toLowerCase());
  if (duplicate) { alert(`"${duplicate.name}" already exists. Select it from suggestions.`); return; }

  const item = ensureCatalogItem({ id: getNextEntityId('SRV', itemsData), type: 'Service', name, description, hsnSac, defaultRate: rate });
  itemsData.push(item);
  localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(itemsData));
  try { await persistAppStorageToDisk(); } catch (e) { console.error(e); }
  populateItemsDropdown(); populateCustomerPurchaseOrderItemDropdown(); populateOrganizationPurchaseOrderItemDropdown(); populateItemNameSuggestions(); displayItemsList(); checkIfReadyToStart();

  customerPurchaseOrderDraftItems.push(ensureOrderLineItem({ id: item.id, name: item.name, description, hsnSac: item.hsnSac, quantity, rate }));
  clearCpoItemCombo();
  renderCustomerPurchaseOrderItemsTable();
  syncCustomerPurchaseOrderAmountField();
}

window.handleCpoItemInput = handleCpoItemInput;
window.handleCpoItemSuggestionChange = handleCpoItemSuggestionChange;
window.clearCpoItemCombo = clearCpoItemCombo;
window.saveCpoNewItemAndAdd = saveCpoNewItemAndAdd;

// ── Org PO item combo-box ──
function handleOrgPoItemInput(event) {
  const val = String(event?.target?.value || '').trim();
  _updatePoItemSuggestions('organizationPoItemInput', 'organizationPoItemSuggestions');
  const panel = document.getElementById('orgPoNewItemPanel');
  const rateInput = document.getElementById('organizationPoItemRate');
  if (!val) { if (panel) panel.style.display = 'none'; if (rateInput) rateInput.value = ''; return; }
  const exact = (itemsData || []).find((i) => ensureCatalogItem(i).name.toLowerCase() === val.toLowerCase());
  if (exact) {
    _selectPoItem(ensureCatalogItem(exact), 'organizationPoItemRate', 'organizationPoItemDescription', 'organizationPoItemQuantity', 'orgPoNewItemPanel');
  } else {
    if (panel) panel.style.display = 'block';
    if (rateInput) rateInput.value = '';
  }
}

function handleOrgPoItemSuggestionChange(event) {
  const suggestions = document.getElementById('organizationPoItemSuggestions');
  const input = document.getElementById('organizationPoItemInput');
  if (!event.target.value) {
    if (input) input.value = '';
    document.getElementById('organizationPoItemRate').value = '';
    document.getElementById('orgPoNewItemPanel').style.display = 'none';
    suggestions.style.display = 'none';
    return;
  }
  const opt = suggestions.options[suggestions.selectedIndex];
  const item = opt?.dataset?.item ? ensureCatalogItem(JSON.parse(opt.dataset.item)) : null;
  if (item && input) {
    input.value = item.name;
    _selectPoItem(item, 'organizationPoItemRate', 'organizationPoItemDescription', 'organizationPoItemQuantity', 'orgPoNewItemPanel');
  }
  suggestions.style.display = 'none';
  document.getElementById('organizationPoItemQuantity')?.focus();
}

function clearOrgPoItemCombo() {
  const input = document.getElementById('organizationPoItemInput');
  if (input) input.value = '';
  document.getElementById('organizationPoItemRate').value = '';
  document.getElementById('organizationPoItemQuantity').value = '';
  document.getElementById('organizationPoItemDescription').value = '';
  const panel = document.getElementById('orgPoNewItemPanel');
  if (panel) { panel.style.display = 'none'; document.getElementById('orgPoNewItemHsn').value = ''; document.getElementById('orgPoNewItemDescription').value = ''; }
  const sugg = document.getElementById('organizationPoItemSuggestions');
  if (sugg) sugg.style.display = 'none';
}

async function saveOrgPoNewItemAndAdd() {
  const name = String(document.getElementById('organizationPoItemInput')?.value || '').trim();
  const description = String(document.getElementById('orgPoNewItemDescription')?.value || '').trim();
  const hsnSac = normalizeHsnSac(document.getElementById('orgPoNewItemHsn')?.value || '');
  const rate = safeNumber(document.getElementById('organizationPoItemRate')?.value);
  const quantity = safeNumber(document.getElementById('organizationPoItemQuantity')?.value) || 1;

  if (!name) { alert('Item name is required.'); return; }
  if (!description) { alert('Description is required.'); document.getElementById('orgPoNewItemDescription').focus(); return; }
  if (rate <= 0) { alert('Rate must be greater than 0.'); document.getElementById('organizationPoItemRate').focus(); return; }

  const duplicate = itemsData.find((i) => ensureCatalogItem(i).name.toLowerCase() === name.toLowerCase());
  if (duplicate) { alert(`"${duplicate.name}" already exists. Select it from suggestions.`); return; }

  const item = ensureCatalogItem({ id: getNextEntityId('SRV', itemsData), type: 'Service', name, description, hsnSac, defaultRate: rate });
  itemsData.push(item);
  localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(itemsData));
  try { await persistAppStorageToDisk(); } catch (e) { console.error(e); }
  populateItemsDropdown(); populateCustomerPurchaseOrderItemDropdown(); populateOrganizationPurchaseOrderItemDropdown(); populateItemNameSuggestions(); displayItemsList(); checkIfReadyToStart();

  organizationPurchaseOrderDraftItems.push(ensureOrderLineItem({ id: item.id, name: item.name, description, hsnSac: item.hsnSac, quantity, rate }));
  clearOrgPoItemCombo();
  renderOrganizationPurchaseOrderItemsTable();
}

window.handleOrgPoItemInput = handleOrgPoItemInput;
window.handleOrgPoItemSuggestionChange = handleOrgPoItemSuggestionChange;
window.clearOrgPoItemCombo = clearOrgPoItemCombo;
window.saveOrgPoNewItemAndAdd = saveOrgPoNewItemAndAdd;

// Document click handler to hide PO item suggestions when clicking outside
document.addEventListener('click', (e) => {
  [['customerPoItemInput','customerPoItemSuggestions'],['organizationPoItemInput','organizationPoItemSuggestions']].forEach(([inId, suId]) => {
    const inp = document.getElementById(inId);
    const su = document.getElementById(suId);
    if (inp && su && !inp.contains(e.target) && !su.contains(e.target)) su.style.display = 'none';
  });
});

function addItemToCustomerPurchaseOrderDraft() {
  const itemInput = document.getElementById('customerPoItemInput');
  const quantityInput = document.getElementById('customerPoItemQuantity');
  const rateInput = document.getElementById('customerPoItemRate');
  const descriptionInput = document.getElementById('customerPoItemDescription');

  const typedName = String(itemInput?.value || '').trim();
  const selectedItem = ensureCatalogItem(
    itemsData.find((item) => ensureCatalogItem(item).name.toLowerCase() === typedName.toLowerCase()) || {}
  );
  const quantity = safeNumber(quantityInput?.value);
  const rate = safeNumber(rateInput?.value);
  const description = String(descriptionInput?.value || '').trim();

  if (!selectedItem.id) {
    alert('Select an item from the list or save a new item first.');
    itemInput?.focus();
    return;
  }

  if (quantity <= 0 || rate <= 0) {
    alert('Enter a valid quantity and rate for the PO item.');
    return;
  }

  customerPurchaseOrderDraftItems.push(ensureOrderLineItem({
    id: selectedItem.id,
    name: selectedItem.name,
    description: description || selectedItem.description || '',
    hsnSac: selectedItem.hsnSac,
    quantity,
    rate
  }));

  clearCpoItemCombo();
  renderCustomerPurchaseOrderItemsTable();
}

function updateCustomerPurchaseOrderDraftItemDescription(index, value) {
  const item = customerPurchaseOrderDraftItems[index];
  if (!item) return;
  item.description = String(value || '').trim();
  renderCustomerPurchaseOrderItemsTable();
}

function updateCustomerPurchaseOrderDraftItemQuantity(index, value) {
  const item = customerPurchaseOrderDraftItems[index];
  if (!item) return;

  const quantity = safeNumber(value);
  if (quantity <= 0) {
    alert('Quantity must be greater than 0.');
    renderCustomerPurchaseOrderItemsTable();
    return;
  }

  item.quantity = quantity;
  item.total = quantity * safeNumber(item.rate);
  renderCustomerPurchaseOrderItemsTable();
}

function updateCustomerPurchaseOrderDraftItemRate(index, value) {
  const item = customerPurchaseOrderDraftItems[index];
  if (!item) return;

  const rate = safeNumber(value);
  if (rate <= 0) {
    alert('Rate must be greater than 0.');
    renderCustomerPurchaseOrderItemsTable();
    return;
  }

  item.rate = rate;
  item.total = safeNumber(item.quantity) * rate;
  renderCustomerPurchaseOrderItemsTable();
}

function removeCustomerPurchaseOrderDraftItem(index) {
  if (index < 0 || index >= customerPurchaseOrderDraftItems.length) return;
  customerPurchaseOrderDraftItems.splice(index, 1);
  renderCustomerPurchaseOrderItemsTable();
}

function clearCustomerPurchaseOrderFormFields() {
  const today = new Date().toISOString().split('T')[0];
  customerPurchaseOrderDraftItems = [];
  populateCustomerPurchaseOrderFormCustomers();
  populateCustomerPurchaseOrderItemDropdown();
    populateOrganizationPurchaseOrderItemDropdown();
  document.getElementById('customerPoNumber').value = '';
  document.getElementById('customerPoDate').value = today;
  document.getElementById('customerPoAmount').value = '0.00';
  document.getElementById('customerPoStatus').value = 'Open';
  document.getElementById('customerPoNotes').value = '';
  clearCustomerPurchaseOrderItemEntryFields();
  renderCustomerPurchaseOrderItemsTable();
}

function setCustomerPurchaseOrderFormMode() {
  const actionBtn = document.getElementById('customerPoActionBtn');
  const cancelBtn = document.getElementById('cancelCustomerPoEditBtn');
  if (!actionBtn || !cancelBtn) return;

  const isEditing = editingCustomerPurchaseOrderIndex !== null;
  actionBtn.textContent = isEditing ? 'Update Customer PO' : '+ Add Customer PO';
  actionBtn.classList.toggle('btn-success', !isEditing);
  actionBtn.classList.toggle('btn-primary', isEditing);
  cancelBtn.style.display = isEditing ? 'inline-block' : 'none';
}

function cancelCustomerPurchaseOrderEdit() {
  editingCustomerPurchaseOrderIndex = null;
  clearCustomerPurchaseOrderFormFields();
  setCustomerPurchaseOrderFormMode();
}

function saveCustomerPurchaseOrder() {
  const customerId = document.getElementById('customerPoCustomer').value;
  const poNumber = document.getElementById('customerPoNumber').value.trim();
  const poDate = document.getElementById('customerPoDate').value;
  const amount = getCustomerPurchaseOrderDraftTotal();
  const status = document.getElementById('customerPoStatus').value;
  const notes = document.getElementById('customerPoNotes').value.trim();

  if (!customerId || !poNumber || !poDate || amount <= 0) {
    alert('Select a customer, enter PO number and date, and add at least one PO item.');
    // Restore after alert — background refresh may have fired during the dialog
    document.getElementById('customerPoCustomer').value = customerId;
    document.getElementById('customerPoNumber').value = poNumber;
    document.getElementById('customerPoDate').value = poDate;
    document.getElementById('customerPoStatus').value = status;
    document.getElementById('customerPoNotes').value = notes;
    document.getElementById(customerId ? 'customerPoNumber' : 'customerPoCustomer').focus();
    return;
  }

  const customer = customersData.find((entry) => entry.id === customerId);
  if (!customer) {
    alert('Selected customer is unavailable. Refresh and try again.');
    return;
  }

  const isEditing = editingCustomerPurchaseOrderIndex !== null && !!customerPurchaseOrdersData[editingCustomerPurchaseOrderIndex];
  const existingRecord = isEditing ? ensureCustomerPurchaseOrder(customerPurchaseOrdersData[editingCustomerPurchaseOrderIndex]) : null;
  const record = ensureCustomerPurchaseOrder({
    id: existingRecord?.id || getNextEntityId('CPO', customerPurchaseOrdersData),
    customerId,
    customerName: ensureCustomerState(customer).name,
    poNumber,
    poDate,
    amount,
    status,
    notes,
    items: customerPurchaseOrderDraftItems.map(ensureOrderLineItem),
    linkedInvoiceNumber: existingRecord?.linkedInvoiceNumber || ''
  });

  if (isEditing) {
    customerPurchaseOrdersData[editingCustomerPurchaseOrderIndex] = record;
  } else {
    customerPurchaseOrdersData.push(record);
  }

  persistCustomerPurchaseOrders();
  editingCustomerPurchaseOrderIndex = null;

  if (invoice.customerPurchaseOrderId === record.id) {
    document.getElementById('poNumber').value = record.poNumber;
    document.getElementById('poDate').value = record.poDate;
    invoice.setPONumber(record.poNumber);
    invoice.setPODate(record.poDate);
  }

  clearCustomerPurchaseOrderFormFields();
  setCustomerPurchaseOrderFormMode();
  displayCustomerPurchaseOrdersList();
  populateCustomerPurchaseOrderDropdown(invoice.customerSelected?.id || '', invoice.customerPurchaseOrderId || '');
  renderDashboardSummary();
  updateInvoicePreview();
}

function editCustomerPurchaseOrder(index) {
  const record = customerPurchaseOrdersData[index];
  if (!record) return;
  const safeRecord = ensureCustomerPurchaseOrder(record);

  editingCustomerPurchaseOrderIndex = index;
  customerPurchaseOrderDraftItems = Array.isArray(safeRecord.items) ? safeRecord.items.map(ensureOrderLineItem) : [];
  populateCustomerPurchaseOrderFormCustomers(safeRecord.customerId);
  populateCustomerPurchaseOrderItemDropdown();
    populateOrganizationPurchaseOrderItemDropdown();
  document.getElementById('customerPoNumber').value = safeRecord.poNumber;
  document.getElementById('customerPoDate').value = safeRecord.poDate;
  document.getElementById('customerPoAmount').value = safeNumber(safeRecord.amount).toFixed(2);
  document.getElementById('customerPoStatus').value = safeRecord.status;
  document.getElementById('customerPoNotes').value = safeRecord.notes;
  clearCustomerPurchaseOrderItemEntryFields();
  renderCustomerPurchaseOrderItemsTable();
  setCustomerPurchaseOrderFormMode();

  const select = document.getElementById('customerPurchaseOrdersDropdown');
  if (select) select.value = String(index);
}

function editSelectedCustomerPurchaseOrder() {
  const select = document.getElementById('customerPurchaseOrdersDropdown');
  if (!select || select.value === '') return;
  editCustomerPurchaseOrder(parseInt(select.value, 10));
}

function displayCustomerPurchaseOrdersList() {
  const container = document.getElementById('customerPurchaseOrdersList');
  if (!container) return;

  if (!customerPurchaseOrdersData || customerPurchaseOrdersData.length === 0) {
    container.innerHTML = '<p class="setup-empty">No customer purchase orders added yet</p>';
    setCustomerPurchaseOrderFormMode();
    return;
  }

  let options = '';
  customerPurchaseOrdersData.forEach((record, index) => {
    const safeRecord = ensureCustomerPurchaseOrder(record);
    const selected = editingCustomerPurchaseOrderIndex === index ? ' selected' : '';
    const invoiceRef = safeRecord.linkedInvoiceNumber ? ` | Invoice: ${safeRecord.linkedInvoiceNumber}` : '';
    options += `<option value="${index}"${selected}>${safeRecord.customerName} | ${safeRecord.poNumber} | ${safeRecord.items.length} item(s) | ${formatMoney(safeRecord.amount)} | ${safeRecord.status}${invoiceRef}</option>`;
  });

  container.innerHTML = `
    <div class="setup-dropdown-wrap">
      <select id="customerPurchaseOrdersDropdown" class="setup-dropdown">${options}</select>
      <div class="setup-dropdown-actions">
        <button class="btn btn-primary" onclick="editSelectedCustomerPurchaseOrder()">Edit Selected</button>
        <button class="btn btn-danger" onclick="deleteSelectedCustomerPurchaseOrder()">Delete Selected</button>
      </div>
    </div>
  `;
  setCustomerPurchaseOrderFormMode();
}

function deleteCustomerPurchaseOrder(index) {
  const record = customerPurchaseOrdersData[index];
  if (!record) return;

  if (!confirm('Are you sure you want to delete this customer purchase order?')) {
    return;
  }

  const removedRecord = ensureCustomerPurchaseOrder(record);
  customerPurchaseOrdersData.splice(index, 1);
  persistCustomerPurchaseOrders();

  if (editingCustomerPurchaseOrderIndex === index) {
    editingCustomerPurchaseOrderIndex = null;
    clearCustomerPurchaseOrderFormFields();
  } else if (editingCustomerPurchaseOrderIndex !== null && editingCustomerPurchaseOrderIndex > index) {
    editingCustomerPurchaseOrderIndex -= 1;
  }

  if (invoice.customerPurchaseOrderId === removedRecord.id) {
    invoice.setCustomerPurchaseOrderId('');
    document.getElementById('customerPoSelect').value = '';
    document.getElementById('poDate').value = document.getElementById('invoiceDate').value || '';
    invoice.setPONumber('');
    invoice.setPODate(document.getElementById('poDate').value || '');
    updateInvoicePreview();
  }

  displayCustomerPurchaseOrdersList();
  populateCustomerPurchaseOrderDropdown(invoice.customerSelected?.id || '', invoice.customerPurchaseOrderId || '');
  renderDashboardSummary();
}

function deleteSelectedCustomerPurchaseOrder() {
  const select = document.getElementById('customerPurchaseOrdersDropdown');
  if (!select || select.value === '') return;
  deleteCustomerPurchaseOrder(parseInt(select.value, 10));
}

function replaceInvoiceItemsFromCustomerPurchaseOrder(record, skipConfirm = false) {
  const safeRecord = ensureCustomerPurchaseOrder(record);
  const shouldConfirm = !skipConfirm && invoice.items.length > 0 && invoice.customerPurchaseOrderId !== safeRecord.id;
  if (shouldConfirm) {
    const proceed = confirm('Replace current invoice items with the selected customer PO items?');
    if (!proceed) {
      return false;
    }
  }

  invoice.clearItems();
  invoice.items = safeRecord.items.map(ensureInvoiceLineItem);
  const itemSelect = document.getElementById('itemSelect');
  const quantityInput = document.getElementById('quantityInput');
  const rateInput = document.getElementById('rateInput');
  if (itemSelect) itemSelect.value = '';
  if (quantityInput) quantityInput.value = '1';
  if (rateInput) rateInput.value = '';
  renderItemsTable();
  updateInvoicePreview();
  return true;
}

function populateCustomerPurchaseOrderDropdown(customerId = '', selectedRecordId = '') {
  const select = document.getElementById('customerPoSelect');
  if (!select) return;

  const safeCustomerId = String(customerId || '').trim();
  const availableRecords = customerPurchaseOrdersData
    .map(ensureCustomerPurchaseOrder)
    .filter((record) => record.customerId === safeCustomerId);
  const currentValue = selectedRecordId || invoice.customerPurchaseOrderId || '';

  select.onchange = handleCustomerPurchaseOrderSelection;

  if (!safeCustomerId) {
    select.disabled = true;
    select.innerHTML = '<option value="">-- Select Customer First --</option>';
    return;
  }

  select.disabled = false;
  if (availableRecords.length === 0) {
    select.disabled = true;
    select.innerHTML = '<option value="">-- No Saved Customer POs --</option>';
    return;
  }

  let options = '<option value="">-- Select Saved Customer PO --</option>';
  availableRecords.forEach((record) => {
    options += `<option value="${record.id}">${record.poNumber} | ${record.items.length} item(s) | ${formatMoney(record.amount)} | ${record.status}</option>`;
  });
  select.innerHTML = options;

  if (currentValue && availableRecords.some((record) => record.id === currentValue)) {
    select.value = currentValue;
  } else {
    select.value = '';
  }
}

function handleCustomerPurchaseOrderSelection() {
  const select = document.getElementById('customerPoSelect');
  const poNumberInput = document.getElementById('poNumber');
  const poDateInput = document.getElementById('poDate');
  if (!select || !poNumberInput || !poDateInput) return;

  if (!select.value) {
    invoice.setCustomerPurchaseOrderId('');
    poNumberInput.value = '';
    poDateInput.value = document.getElementById('invoiceDate').value || '';
    invoice.setPONumber('');
    invoice.setPODate(poDateInput.value || '');
    updateInvoicePreview();
    return;
  }

  const record = customerPurchaseOrdersData
    .map(ensureCustomerPurchaseOrder)
    .find((entry) => entry.id === select.value);
  if (!record) {
    select.value = '';
    invoice.setCustomerPurchaseOrderId('');
    return;
  }

  const previousPoId = invoice.customerPurchaseOrderId || '';
  const previousPoNumber = invoice.poNumber || '';
  const previousPoDate = invoice.poDate || '';
  poNumberInput.value = record.poNumber;
  poDateInput.value = record.poDate;
  invoice.setPONumber(record.poNumber);
  invoice.setPODate(record.poDate);
  if (record.items && record.items.length > 0) {
    const replaced = replaceInvoiceItemsFromCustomerPurchaseOrder(record);
    if (!replaced) {
      select.value = previousPoId;
      poNumberInput.value = previousPoNumber;
      poDateInput.value = previousPoDate;
      invoice.setPONumber(previousPoNumber);
      invoice.setPODate(previousPoDate);
      return;
    }
  }
  invoice.setCustomerPurchaseOrderId(record.id);
  updateInvoicePreview();
}

// --- Organization Purchase Order Line Items ---
function getOrganizationPurchaseOrderDraftTotal() {
  return organizationPurchaseOrderDraftItems.reduce((sum, item) => sum + safeNumber(item.total), 0);
}

function syncOrganizationPurchaseOrderAmountField() {
  if (organizationPurchaseOrderDraftItems.length > 0) {
    const vendorName = document.getElementById('organizationOrderVendor')?.value?.trim() || '';
    const vendor = vendorsData.find((v) => ensureVendorState(v).name === vendorName);
    const vendorStateRaw = vendor ? ensureVendorState(vendor).state : '';
    const vendorState = normalizeState(vendorStateRaw) || DEFAULT_LOCAL_STATE;
    const companyGstinState = inferStateFromGstin(companyData?.gstin);
    const companyState = normalizeState(companyGstinState || DEFAULT_LOCAL_STATE);
    const isIgst = vendorState.toLowerCase() !== companyState.toLowerCase();
    const subtotal = getOrganizationPurchaseOrderDraftTotal();
    const totalTax = organizationPurchaseOrderDraftItems.reduce(
      (sum, item) => sum + safeNumber(item.total) * (safeNumber(item.taxRate) / 100), 0
    );
    const grandTotal = subtotal + totalTax;

    const taxSummary = document.getElementById('organizationPoTaxSummary');
    if (taxSummary) {
      const cgst = isIgst ? 0 : totalTax / 2;
      const sgst = isIgst ? 0 : totalTax / 2;
      const igst = isIgst ? totalTax : 0;
      taxSummary.innerHTML = `
        <div class="po-tax-summary">
          <span>Subtotal: <strong>${formatMoney(subtotal)}</strong></span>
          ${isIgst
            ? `<span>IGST: <strong>${formatMoney(igst)}</strong></span>`
            : `<span>CGST: <strong>${formatMoney(cgst)}</strong></span>
               <span>SGST: <strong>${formatMoney(sgst)}</strong></span>`}
          <span class="po-tax-grand">Grand Total: <strong>${formatMoney(grandTotal)}</strong></span>
          <span class="po-tax-type">${isIgst ? 'Inter-state (IGST)' : 'Intra-state (CGST+SGST)'}</span>
        </div>`;
    }
  } else {
    const taxSummary = document.getElementById('organizationPoTaxSummary');
    if (taxSummary) taxSummary.innerHTML = '';
  }
}

function renderOrganizationPurchaseOrderItemsTable() {
  const tableBody = document.getElementById('organizationPoItemsTableBody');
  if (!tableBody) return;
  tableBody.innerHTML = '';

  if (organizationPurchaseOrderDraftItems.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="9" style="text-align:center;">No items added yet</td></tr>';
    syncOrganizationPurchaseOrderAmountField();
    return;
  }

  const TAX_RATES = [0, 5, 12, 18, 28];

  organizationPurchaseOrderDraftItems.forEach((item, index) => {
    const safeItem = ensureOrderLineItem(item);
    const taxAmt = safeItem.total * (safeItem.taxRate / 100);
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>
        <strong>${safeItem.name}</strong>
        <br><input type="text" value="${safeItem.description}" placeholder="Description"
          style="width:100%;font-size:0.85rem;margin-top:2px;"
          onchange="updateOrganizationPurchaseOrderDraftItemDescription(${index}, this.value)">
      </td>
      <td style="text-align:center;">${safeItem.hsnSac}</td>
      <td style="text-align:right;">
        <input type="number" value="${safeItem.quantity}" min="0.01" step="0.01" style="width:70px;text-align:right;"
          onchange="updateOrganizationPurchaseOrderDraftItemQuantity(${index}, this.value)">
      </td>
      <td style="text-align:right;">
        <input type="number" value="${safeItem.rate}" min="0" step="0.01" style="width:90px;text-align:right;"
          onchange="updateOrganizationPurchaseOrderDraftItemRate(${index}, this.value)">
      </td>
      <td style="text-align:center;">
        <select style="width:70px;" onchange="updateOrganizationPurchaseOrderDraftItemTaxRate(${index}, this.value)">
          ${TAX_RATES.map((r) => `<option value="${r}"${r === safeItem.taxRate ? ' selected' : ''}>${r}%</option>`).join('')}
        </select>
      </td>
      <td style="text-align:right;">${formatMoney(safeItem.total)}</td>
      <td style="text-align:right;color:#0f766e;">${formatMoney(taxAmt)}</td>
      <td style="text-align:center;">
        <button class="btn btn-danger btn-sm" onclick="removeOrganizationPurchaseOrderDraftItem(${index})">✕</button>
      </td>`;
    tableBody.appendChild(row);
  });

  syncOrganizationPurchaseOrderAmountField();
}

function addItemToOrganizationPurchaseOrderDraft() {
  const itemInput = document.getElementById('organizationPoItemInput');
  const quantityInput = document.getElementById('organizationPoItemQuantity');
  const rateInput = document.getElementById('organizationPoItemRate');
  const descriptionInput = document.getElementById('organizationPoItemDescription');

  const typedName = String(itemInput?.value || '').trim();
  const selectedItem = ensureCatalogItem(
    itemsData.find((item) => ensureCatalogItem(item).name.toLowerCase() === typedName.toLowerCase()) || {}
  );
  const quantity = safeNumber(quantityInput?.value);
  const rate = safeNumber(rateInput?.value);
  const description = String(descriptionInput?.value || '').trim();

  if (!selectedItem.id) {
    alert('Select an item from the list or save a new item first.');
    itemInput?.focus();
    return;
  }
  if (quantity <= 0 || rate <= 0) {
    alert('Enter a valid quantity and rate.');
    return;
  }

  organizationPurchaseOrderDraftItems.push(ensureOrderLineItem({
    id: selectedItem.id,
    name: selectedItem.name,
    description: description || selectedItem.description || '',
    hsnSac: selectedItem.hsnSac,
    quantity,
    rate
  }));

  clearOrgPoItemCombo();
  renderOrganizationPurchaseOrderItemsTable();
}

function updateOrganizationPurchaseOrderDraftItemDescription(index, value) {
  const item = organizationPurchaseOrderDraftItems[index];
  if (!item) return;
  item.description = String(value || '').trim();
}

function updateOrganizationPurchaseOrderDraftItemQuantity(index, value) {
  const item = organizationPurchaseOrderDraftItems[index];
  if (!item) return;
  const qty = safeNumber(value);
  if (qty <= 0) { renderOrganizationPurchaseOrderItemsTable(); return; }
  item.quantity = qty;
  item.total = qty * safeNumber(item.rate);
  renderOrganizationPurchaseOrderItemsTable();
}

function updateOrganizationPurchaseOrderDraftItemRate(index, value) {
  const item = organizationPurchaseOrderDraftItems[index];
  if (!item) return;
  const rate = safeNumber(value);
  if (rate < 0) { renderOrganizationPurchaseOrderItemsTable(); return; }
  item.rate = rate;
  item.total = safeNumber(item.quantity) * rate;
  renderOrganizationPurchaseOrderItemsTable();
}

function removeOrganizationPurchaseOrderDraftItem(index) {
  if (index < 0 || index >= organizationPurchaseOrderDraftItems.length) return;
  organizationPurchaseOrderDraftItems.splice(index, 1);
  renderOrganizationPurchaseOrderItemsTable();
}

window.addItemToOrganizationPurchaseOrderDraft = addItemToOrganizationPurchaseOrderDraft;
window.removeOrganizationPurchaseOrderDraftItem = removeOrganizationPurchaseOrderDraftItem;
window.updateOrganizationPurchaseOrderDraftItemDescription = updateOrganizationPurchaseOrderDraftItemDescription;
window.updateOrganizationPurchaseOrderDraftItemQuantity = updateOrganizationPurchaseOrderDraftItemQuantity;
window.updateOrganizationPurchaseOrderDraftItemRate = updateOrganizationPurchaseOrderDraftItemRate;

function updateOrganizationPurchaseOrderDraftItemTaxRate(index, value) {
  const item = organizationPurchaseOrderDraftItems[index];
  if (!item) return;
  item.taxRate = safeNumber(value);
  renderOrganizationPurchaseOrderItemsTable();
}
window.updateOrganizationPurchaseOrderDraftItemTaxRate = updateOrganizationPurchaseOrderDraftItemTaxRate;

function clearOrganizationPurchaseOrderFormFields() {
  const today = new Date().toISOString().split('T')[0];
  organizationPurchaseOrderDraftItems = [];
  populateVendorDropdown('');
  document.getElementById('organizationOrderVendor').value = '';
  document.getElementById('organizationOrderNumber').value = '';
  document.getElementById('organizationOrderDate').value = today;
  document.getElementById('organizationOrderStatus').value = 'Placed';
  document.getElementById('organizationOrderNotes').value = '';
  renderOrganizationPurchaseOrderItemsTable();
  updateOrganizationVendorSummary();
}

function setOrganizationPurchaseOrderFormMode() {
  const actionBtn = document.getElementById('organizationOrderActionBtn');
  const cancelBtn = document.getElementById('cancelOrganizationOrderEditBtn');
  if (!actionBtn || !cancelBtn) return;

  const isEditing = editingOrganizationPurchaseOrderIndex !== null;
  actionBtn.textContent = isEditing ? 'Update Purchase Order' : '+ Add Purchase Order';
  actionBtn.classList.toggle('btn-success', !isEditing);
  actionBtn.classList.toggle('btn-primary', isEditing);
  cancelBtn.style.display = isEditing ? 'inline-block' : 'none';
}

function cancelOrganizationPurchaseOrderEdit() {
  editingOrganizationPurchaseOrderIndex = null;
  clearOrganizationPurchaseOrderFormFields();
  setOrganizationPurchaseOrderFormMode();
}

function saveOrganizationPurchaseOrder() {
  const vendorName = document.getElementById('organizationOrderVendor').value.trim();
  const poNumber = document.getElementById('organizationOrderNumber').value.trim();
  const poDate = document.getElementById('organizationOrderDate').value;
  const status = document.getElementById('organizationOrderStatus').value;
  const notes = document.getElementById('organizationOrderNotes').value.trim();

  const manualAmount = 0;
  const itemsTotal = organizationPurchaseOrderDraftItems.reduce((s, i) => s + safeNumber(i.total), 0);
  const hasItems = organizationPurchaseOrderDraftItems.length > 0;
  const subtotal = hasItems ? itemsTotal : manualAmount;

  if (!vendorName || !poNumber || !poDate || subtotal <= 0) {
    alert('Enter vendor, invoice number, date, and at least one item (or a manual amount).');
    // Restore after alert — background refresh may have fired during the dialog
    document.getElementById('organizationOrderVendor').value = vendorName;
    document.getElementById('organizationOrderNumber').value = poNumber;
    document.getElementById('organizationOrderDate').value = poDate;
    document.getElementById('organizationOrderStatus').value = status;
    document.getElementById('organizationOrderNotes').value = notes;
    document.getElementById(vendorName ? (poNumber ? (poDate ? 'organizationOrderStatus' : 'organizationOrderDate') : 'organizationOrderNumber') : 'organizationOrderVendor').focus();
    return;
  }

  // Determine IGST vs CGST+SGST from vendor state vs company state
  const vendor = vendorsData.find((v) => ensureVendorState(v).name === vendorName);
  const vendorStateRaw = vendor ? ensureVendorState(vendor).state : '';
  const vendorState = normalizeState(vendorStateRaw) || DEFAULT_LOCAL_STATE;
  const companyGstinState = inferStateFromGstin(companyData?.gstin);
  const companyState = normalizeState(companyGstinState || DEFAULT_LOCAL_STATE);
  const taxType = vendorState.toLowerCase() !== companyState.toLowerCase() ? 'IGST' : 'CGST_SGST';

  const isEditing = editingOrganizationPurchaseOrderIndex !== null && !!organizationPurchaseOrdersData[editingOrganizationPurchaseOrderIndex];
  const existingRecord = isEditing ? ensureOrganizationPurchaseOrder(organizationPurchaseOrdersData[editingOrganizationPurchaseOrderIndex]) : null;
  const record = ensureOrganizationPurchaseOrder({
    id: existingRecord?.id || getNextEntityId('PPO', organizationPurchaseOrdersData),
    vendorName,
    poNumber,
    poDate,
    subtotal,
    taxType,
    items: organizationPurchaseOrderDraftItems.map(ensureOrderLineItem),
    status,
    notes
  });

  if (isEditing) {
    organizationPurchaseOrdersData[editingOrganizationPurchaseOrderIndex] = record;
  } else {
    organizationPurchaseOrdersData.push(record);
  }

  persistOrganizationPurchaseOrders();
  editingOrganizationPurchaseOrderIndex = null;
  clearOrganizationPurchaseOrderFormFields();
  setOrganizationPurchaseOrderFormMode();
  displayOrganizationPurchaseOrdersList();
  renderDashboardSummary();
}

function editOrganizationPurchaseOrder(index) {
  const record = organizationPurchaseOrdersData[index];
  if (!record) return;
  const safeRecord = ensureOrganizationPurchaseOrder(record);

  editingOrganizationPurchaseOrderIndex = index;
  organizationPurchaseOrderDraftItems = Array.isArray(safeRecord.items) ? safeRecord.items.map(ensureOrderLineItem) : [];
  populateVendorDropdown(safeRecord.vendorName);
  document.getElementById('organizationOrderVendor').value = safeRecord.vendorName;
  document.getElementById('organizationOrderNumber').value = safeRecord.poNumber;
  document.getElementById('organizationOrderDate').value = safeRecord.poDate;
  document.getElementById('organizationOrderStatus').value = safeRecord.status;
  document.getElementById('organizationOrderNotes').value = safeRecord.notes;
  renderOrganizationPurchaseOrderItemsTable();
  syncOrganizationPurchaseOrderAmountField();
  updateOrganizationVendorSummary();
  setOrganizationPurchaseOrderFormMode();

  const select = document.getElementById('organizationPurchaseOrdersDropdown');
  if (select) select.value = String(index);
}

function editSelectedOrganizationPurchaseOrder() {
  const select = document.getElementById('organizationPurchaseOrdersDropdown');
  if (!select || select.value === '') return;
  editOrganizationPurchaseOrder(parseInt(select.value, 10));
}

function displayOrganizationPurchaseOrdersList() {
  const container = document.getElementById('organizationPurchaseOrdersList');
  if (!container) return;

  if (!organizationPurchaseOrdersData || organizationPurchaseOrdersData.length === 0) {
    container.innerHTML = '<p class="setup-empty">No organization purchase orders added yet</p>';
    setOrganizationPurchaseOrderFormMode();
    return;
  }

  let options = '';
  organizationPurchaseOrdersData.forEach((record, index) => {
    const safeRecord = ensureOrganizationPurchaseOrder(record);
    const selected = editingOrganizationPurchaseOrderIndex === index ? ' selected' : '';
    const itemCount = safeRecord.items.length > 0 ? ` | ${safeRecord.items.length} item(s)` : '';
    options += `<option value="${index}"${selected}>${safeRecord.vendorName} | Invoice: ${safeRecord.poNumber} | ${formatDateDisplay(safeRecord.poDate)} | ${formatMoney(safeRecord.amount)}${itemCount} | ${safeRecord.status}</option>`;
  });

  container.innerHTML = `
    <div class="setup-dropdown-wrap">
      <select id="organizationPurchaseOrdersDropdown" class="setup-dropdown">${options}</select>
      <div class="setup-dropdown-actions">
        <button class="btn btn-primary" onclick="editSelectedOrganizationPurchaseOrder()">Edit Selected</button>
        <button class="btn btn-danger" onclick="deleteSelectedOrganizationPurchaseOrder()">Delete Selected</button>
      </div>
    </div>
  `;
  setOrganizationPurchaseOrderFormMode();
  updateOrganizationVendorSummary();
}

function deleteOrganizationPurchaseOrder(index) {
  const record = organizationPurchaseOrdersData[index];
  if (!record) return;

  if (!confirm('Are you sure you want to delete this organization purchase order?')) {
    return;
  }

  organizationPurchaseOrdersData.splice(index, 1);
  persistOrganizationPurchaseOrders();

  if (editingOrganizationPurchaseOrderIndex === index) {
    editingOrganizationPurchaseOrderIndex = null;
    clearOrganizationPurchaseOrderFormFields();
  } else if (editingOrganizationPurchaseOrderIndex !== null && editingOrganizationPurchaseOrderIndex > index) {
    editingOrganizationPurchaseOrderIndex -= 1;
  }

  displayOrganizationPurchaseOrdersList();
  renderDashboardSummary();
}

function deleteSelectedOrganizationPurchaseOrder() {
  const select = document.getElementById('organizationPurchaseOrdersDropdown');
  if (!select || select.value === '') return;
  deleteOrganizationPurchaseOrder(parseInt(select.value, 10));
}

function linkCustomerPurchaseOrderToInvoice(poId, invoiceNumber) {
  const index = customerPurchaseOrdersData.findIndex((entry) => ensureCustomerPurchaseOrder(entry).id === poId);
  if (index < 0) return;

  const record = ensureCustomerPurchaseOrder(customerPurchaseOrdersData[index]);
  customerPurchaseOrdersData[index] = {
    ...record,
    linkedInvoiceNumber: invoiceNumber,
    status: record.status === 'Closed' ? 'Closed' : 'Invoiced'
  };
  persistCustomerPurchaseOrders();
  displayCustomerPurchaseOrdersList();
  populateCustomerPurchaseOrderDropdown(invoice.customerSelected?.id || '', poId);
  renderDashboardSummary();
}

function unlinkCustomerPurchaseOrderFromInvoice(poId, invoiceNumber = '') {
  const index = customerPurchaseOrdersData.findIndex((entry) => ensureCustomerPurchaseOrder(entry).id === poId);
  if (index < 0) return;

  const record = ensureCustomerPurchaseOrder(customerPurchaseOrdersData[index]);
  if (invoiceNumber && record.linkedInvoiceNumber && record.linkedInvoiceNumber !== invoiceNumber) {
    return;
  }

  customerPurchaseOrdersData[index] = {
    ...record,
    linkedInvoiceNumber: '',
    status: record.status === 'Invoiced' ? 'Open' : record.status
  };
  persistCustomerPurchaseOrders();
  displayCustomerPurchaseOrdersList();
  populateCustomerPurchaseOrderDropdown(invoice.customerSelected?.id || '', invoice.customerPurchaseOrderId || '');
  renderDashboardSummary();
}

function syncCustomerPurchaseOrdersForCustomer(customer) {
  let hasChanges = false;
  customerPurchaseOrdersData = customerPurchaseOrdersData.map((entry) => {
    const record = ensureCustomerPurchaseOrder(entry);
    if (record.customerId !== customer.id || record.customerName === customer.name) {
      return record;
    }
    hasChanges = true;
    return {
      ...record,
      customerName: customer.name
    };
  });

  if (!hasChanges) return;
  persistCustomerPurchaseOrders();
  displayCustomerPurchaseOrdersList();
  populateCustomerPurchaseOrderDropdown(invoice.customerSelected?.id || '', invoice.customerPurchaseOrderId || '');
}

function removeCustomerPurchaseOrdersForCustomer(customerId) {
  const previousLength = customerPurchaseOrdersData.length;
  const removedIds = customerPurchaseOrdersData
    .map(ensureCustomerPurchaseOrder)
    .filter((entry) => entry.customerId === customerId)
    .map((entry) => entry.id);

  customerPurchaseOrdersData = customerPurchaseOrdersData
    .map(ensureCustomerPurchaseOrder)
    .filter((entry) => entry.customerId !== customerId);

  if (customerPurchaseOrdersData.length === previousLength) return;

  persistCustomerPurchaseOrders();
  if (removedIds.includes(invoice.customerPurchaseOrderId)) {
    invoice.setCustomerPurchaseOrderId('');
    const customerPoSelect = document.getElementById('customerPoSelect');
    if (customerPoSelect) customerPoSelect.value = '';
    const poNumberInput = document.getElementById('poNumber');
    const poDateInput = document.getElementById('poDate');
    if (poNumberInput) poNumberInput.value = '';
    if (poDateInput) {
      poDateInput.value = document.getElementById('invoiceDate').value || '';
      invoice.setPODate(poDateInput.value || '');
    }
    invoice.setPONumber('');
    updateInvoicePreview();
  }
  displayCustomerPurchaseOrdersList();
  populateCustomerPurchaseOrderDropdown(invoice.customerSelected?.id || '', invoice.customerPurchaseOrderId || '');
  renderDashboardSummary();
}

// Show main invoice creation section
function showMainSection() {
  document.getElementById('setupSection').style.display = 'none';
  document.getElementById('mainSection').style.display = 'block';
  generateNewInvoiceNumber();
  populateCustomerDropdown();
  populateVendorDropdown();
  populateCustomerPurchaseOrderFormCustomers(document.getElementById('customerPoCustomer')?.value || '');
  populateCustomerPurchaseOrderItemDropdown();
    populateOrganizationPurchaseOrderItemDropdown();
  populateCustomerPurchaseOrderDropdown();
  populateItemsDropdown();
  setTodayDate();
  attachFormListeners();
  displayCustomerPurchaseOrdersList();
  displayOrganizationPurchaseOrdersList();
  setCustomerPurchaseOrderFormMode();
  setOrganizationPurchaseOrderFormMode();
  displayVendorsList();
  setVendorFormMode();
  if (editingCustomerPurchaseOrderIndex === null) clearCustomerPurchaseOrderFormFields();
  if (editingOrganizationPurchaseOrderIndex === null) clearOrganizationPurchaseOrderFormFields();
  if (editingVendorIndex === null) clearVendorFormFields();
  renderDashboardSummary();
  // If returning after a save from preview, start fresh — don't restore old draft
  if (localStorage.getItem('invoiceEditorShouldReset') === '1') {
    localStorage.removeItem('invoiceEditorShouldReset');
    localStorage.removeItem(STORAGE_KEYS.currentInvoiceDraft);
    resetInvoiceEditor();
  } else {
    restoreCurrentInvoiceDraftIntoEditor();
  }
  showWorkspaceView('invoice');
  if (typeof window.initQuotationWorkspace === 'function') {
    try { window.initQuotationWorkspace(); } catch(e) { console.error('initQuotationWorkspace failed:', e); }
  }
}

function attachFormListeners() {
  if (formListenersAttached) return;

  const poNumberInput = document.getElementById('poNumber');
  const poDateInput = document.getElementById('poDate');

  if (poNumberInput) {
    poNumberInput.addEventListener('input', handlePONumberChange);
  }

  if (poDateInput) {
    poDateInput.addEventListener('change', handlePODateChange);
  }

  formListenersAttached = true;
}

function clearCustomerFormFields() {
  document.getElementById('customerName').value = '';
  document.getElementById('customerEmail').value = '';
  document.getElementById('customerPhone').value = '';
  document.getElementById('customerAddress').value = '';
  document.getElementById('customerGST').value = '';
  populateStateDropdown('customerState', DEFAULT_LOCAL_STATE);
  hideCustomerNameSuggestions();
}

function clearVendorFormFields() {
  document.getElementById('vendorName').value = '';
  document.getElementById('vendorEmail').value = '';
  document.getElementById('vendorPhone').value = '';
  document.getElementById('vendorAddress').value = '';
  document.getElementById('vendorGST').value = '';
  populateStateDropdown('vendorState', DEFAULT_LOCAL_STATE);
  hideVendorNameSuggestions();
}

function setCustomerFormMode() {
  const actionBtn = document.getElementById('customerActionBtn');
  const cancelBtn = document.getElementById('cancelCustomerEditBtn');
  if (!actionBtn || !cancelBtn) return;

  const isEditing = editingCustomerIndex !== null;
  actionBtn.textContent = isEditing ? 'Update Customer' : '+ Add Customer';
  actionBtn.classList.toggle('btn-success', !isEditing);
  actionBtn.classList.toggle('btn-primary', isEditing);
  cancelBtn.style.display = isEditing ? 'inline-block' : 'none';
}

function setVendorFormMode() {
  const actionBtn = document.getElementById('vendorActionBtn');
  const cancelBtn = document.getElementById('cancelVendorEditBtn');
  if (!actionBtn || !cancelBtn) return;

  const isEditing = editingVendorIndex !== null;
  actionBtn.textContent = isEditing ? 'Update Vendor' : '+ Add Vendor';
  actionBtn.classList.toggle('btn-success', !isEditing);
  actionBtn.classList.toggle('btn-primary', isEditing);
  cancelBtn.style.display = isEditing ? 'inline-block' : 'none';
}

function clearItemFormFields() {
  document.getElementById('itemType').value = 'Service';
  document.getElementById('itemName').value = '';
  document.getElementById('itemDescription').value = '';
  document.getElementById('itemHsn').value = '';
  document.getElementById('itemRate').value = '';
  populateItemNameSuggestions();
}

function setItemFormMode() {
  const actionBtn = document.getElementById('itemActionBtn');
  const cancelBtn = document.getElementById('cancelItemEditBtn');
  if (!actionBtn || !cancelBtn) return;

  const isEditing = editingItemIndex !== null;
  actionBtn.textContent = isEditing ? 'Update Item/Service' : '+ Add Item/Service';
  actionBtn.classList.toggle('btn-success', !isEditing);
  actionBtn.classList.toggle('btn-primary', isEditing);
  cancelBtn.style.display = isEditing ? 'inline-block' : 'none';
}

function cancelCustomerEdit() {
  editingCustomerIndex = null;
  clearCustomerFormFields();
  setCustomerFormMode();
}

function cancelVendorEdit() {
  editingVendorIndex = null;
  clearVendorFormFields();
  setVendorFormMode();
}

function cancelItemEdit() {
  editingItemIndex = null;
  clearItemFormFields();
  setItemFormMode();
}

function populateItemNameSuggestions() {
  updateItemNameSuggestions('');
}

function updateItemNameSuggestions(filterValue = '') {
  const suggestions = document.getElementById('itemNameSuggestions');
  if (!suggestions) return;

  const normalizedFilter = String(filterValue || '').trim().toLowerCase();
  const names = Array.from(new Set(
    (itemsData || [])
      .map((item) => ensureCatalogItem(item).name)
      .filter((name) => {
        if (!name) return false;
        if (!normalizedFilter) return true;
        return name.toLowerCase().startsWith(normalizedFilter);
      })
  )).sort((a, b) => a.localeCompare(b));

  if (!normalizedFilter || names.length === 0) {
    suggestions.innerHTML = '';
    suggestions.style.display = 'none';
    return;
  }

  suggestions.innerHTML = '';
  const clearOption = document.createElement('option');
  clearOption.value = '';
  clearOption.textContent = '-- Deselect --';
  suggestions.appendChild(clearOption);

  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    suggestions.appendChild(option);
  });

  suggestions.selectedIndex = 0;
  suggestions.style.display = 'block';
}

function hideItemNameSuggestions() {
  const suggestions = document.getElementById('itemNameSuggestions');
  if (!suggestions) return;
  suggestions.style.display = 'none';
}

function selectItemNameSuggestion(name) {
  const itemNameInput = document.getElementById('itemName');
  if (!itemNameInput) return;

  itemNameInput.value = String(name || '');
  if (!name) {
    hideItemNameSuggestions();
    itemNameInput.focus();
    return;
  }
  itemNameInput.focus();
}

function handleItemNameInput(event) {
  const typedValue = String(event?.target?.value || '').trim();
  updateItemNameSuggestions(typedValue);
}

function handleItemNameSuggestionChange(event) {
  const selectedName = String(event?.target?.value || '');
  selectItemNameSuggestion(selectedName);
  if (!selectedName) {
    const itemNameInputField = document.getElementById('itemName');
    if (itemNameInputField) {
      itemNameInputField.value = '';
    }
  }
}

window.handleItemNameInput = handleItemNameInput;
window.handleItemNameSuggestionChange = handleItemNameSuggestionChange;

// --- Customer Name Autocomplete ---
function updateCustomerNameSuggestions(filterValue = '') {
  const suggestions = document.getElementById('customerNameSuggestions');
  if (!suggestions) return;
  const normalized = String(filterValue || '').trim().toLowerCase();
  const names = Array.from(new Set(
    (customersData || [])
      .map((c) => ensureCustomerState(c).name)
      .filter((n) => n && (!normalized || n.toLowerCase().startsWith(normalized)))
  )).sort((a, b) => a.localeCompare(b));

  if (!normalized || names.length === 0) {
    suggestions.innerHTML = '';
    suggestions.style.display = 'none';
    return;
  }
  suggestions.innerHTML = '';
  const clearOpt = document.createElement('option');
  clearOpt.value = '';
  clearOpt.textContent = '-- Deselect --';
  suggestions.appendChild(clearOpt);
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    suggestions.appendChild(opt);
  });
  suggestions.selectedIndex = 0;
  suggestions.style.display = 'block';
}

function hideCustomerNameSuggestions() {
  const suggestions = document.getElementById('customerNameSuggestions');
  if (suggestions) suggestions.style.display = 'none';
}

function selectCustomerNameSuggestion(name) {
  const input = document.getElementById('customerName');
  if (!input) return;
  if (!name) { hideCustomerNameSuggestions(); input.focus(); return; }
  // Autofill all fields from the matching customer record
  const match = (customersData || []).find((c) => ensureCustomerState(c).name.toLowerCase() === name.toLowerCase());
  if (match) {
    const c = ensureCustomerState(match);
    input.value = c.name;
    document.getElementById('customerEmail').value = c.email || '';
    document.getElementById('customerPhone').value = c.phone || '';
    document.getElementById('customerAddress').value = c.address || '';
    document.getElementById('customerGST').value = c.gstin || '';
    populateStateDropdown('customerState', c.state);
  } else {
    input.value = name;
  }
  hideCustomerNameSuggestions();
  input.focus();
}

function handleCustomerNameInput(event) {
  updateCustomerNameSuggestions(String(event?.target?.value || '').trim());
}

function handleCustomerNameSuggestionChange(event) {
  selectCustomerNameSuggestion(String(event?.target?.value || ''));
}

window.handleCustomerNameInput = handleCustomerNameInput;
window.handleCustomerNameSuggestionChange = handleCustomerNameSuggestionChange;
window.hideCustomerNameSuggestions = hideCustomerNameSuggestions;

function handleCustomerGstinInput(event) {
  const gstin = String(event?.target?.value || '').trim();
  const inferredState = inferStateFromGstin(gstin);
  if (inferredState) populateStateDropdown('customerState', inferredState);
}
window.handleCustomerGstinInput = handleCustomerGstinInput;

// --- Vendor Name Autocomplete ---
function updateVendorNameSuggestions(filterValue = '') {
  const suggestions = document.getElementById('vendorNameSuggestions');
  if (!suggestions) return;
  const normalized = String(filterValue || '').trim().toLowerCase();
  const names = Array.from(new Set(
    (vendorsData || [])
      .map((v) => ensureVendorState(v).name)
      .filter((n) => n && (!normalized || n.toLowerCase().startsWith(normalized)))
  )).sort((a, b) => a.localeCompare(b));

  if (!normalized || names.length === 0) {
    suggestions.innerHTML = '';
    suggestions.style.display = 'none';
    return;
  }
  suggestions.innerHTML = '';
  const clearOpt = document.createElement('option');
  clearOpt.value = '';
  clearOpt.textContent = '-- Deselect --';
  suggestions.appendChild(clearOpt);
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    suggestions.appendChild(opt);
  });
  suggestions.selectedIndex = 0;
  suggestions.style.display = 'block';
}

function hideVendorNameSuggestions() {
  const suggestions = document.getElementById('vendorNameSuggestions');
  if (suggestions) suggestions.style.display = 'none';
}

function selectVendorNameSuggestion(name) {
  const input = document.getElementById('vendorName');
  if (!input) return;
  if (!name) { hideVendorNameSuggestions(); input.focus(); return; }
  const match = (vendorsData || []).find((v) => ensureVendorState(v).name.toLowerCase() === name.toLowerCase());
  if (match) {
    const v = ensureVendorState(match);
    input.value = v.name;
    document.getElementById('vendorEmail').value = v.email || '';
    document.getElementById('vendorPhone').value = v.phone || '';
    document.getElementById('vendorAddress').value = v.address || '';
    document.getElementById('vendorGST').value = v.gstin || '';
    populateStateDropdown('vendorState', v.state);
  } else {
    input.value = name;
  }
  hideVendorNameSuggestions();
  input.focus();
}

function handleVendorNameInput(event) {
  updateVendorNameSuggestions(String(event?.target?.value || '').trim());
}

function handleVendorNameSuggestionChange(event) {
  selectVendorNameSuggestion(String(event?.target?.value || ''));
}

window.handleVendorNameInput = handleVendorNameInput;
window.handleVendorNameSuggestionChange = handleVendorNameSuggestionChange;
window.hideVendorNameSuggestions = hideVendorNameSuggestions;

function handleVendorGstinInput(event) {
  const gstin = String(event?.target?.value || '').trim();
  const inferredState = inferStateFromGstin(gstin);
  if (inferredState) populateStateDropdown('vendorState', inferredState);
}
window.handleVendorGstinInput = handleVendorGstinInput;

async function addVendor() {
  const name = toTitleCase(document.getElementById('vendorName').value.trim());
  const email = document.getElementById('vendorEmail').value.trim().toLowerCase();
  const phone = document.getElementById('vendorPhone').value.trim();
  const address = toSentenceCase(document.getElementById('vendorAddress').value.trim());
  const gstin = document.getElementById('vendorGST').value.trim().toUpperCase();
  const state = normalizeState(document.getElementById('vendorState').value);

  if (!name || !gstin) {
    // Restore form values BEFORE showing alert
    document.getElementById('vendorName').value = name;
    document.getElementById('vendorEmail').value = email;
    document.getElementById('vendorPhone').value = phone;
    document.getElementById('vendorAddress').value = address;
    document.getElementById('vendorGST').value = gstin;
    populateStateDropdown('vendorState', state);
    alert('Please fill Vendor Name and GST (GSTIN).');
    document.getElementById('vendorName').focus();
    return;
  }

  if (!isValidGstin(gstin)) {
    document.getElementById('vendorName').value = name;
    document.getElementById('vendorEmail').value = email;
    document.getElementById('vendorPhone').value = phone;
    document.getElementById('vendorAddress').value = address;
    document.getElementById('vendorGST').value = gstin;
    populateStateDropdown('vendorState', state);
    alert('GSTIN format is invalid. It must be 15 characters (e.g. 36AABCU9603R1ZX).');
    document.getElementById('vendorGST').focus();
    return;
  }

  const isEditing = editingVendorIndex !== null && !!vendorsData[editingVendorIndex];
  const existingVendor = isEditing ? vendorsData[editingVendorIndex] : null;

  const duplicateVendor = vendorsData.find((v, idx) => {
    if (isEditing && idx === editingVendorIndex) return false;
    return ensureVendorState(v).name.toLowerCase() === name.toLowerCase();
  });
  if (duplicateVendor) {
    document.getElementById('vendorName').value = name;
    document.getElementById('vendorEmail').value = email;
    document.getElementById('vendorPhone').value = phone;
    document.getElementById('vendorAddress').value = address;
    document.getElementById('vendorGST').value = gstin;
    populateStateDropdown('vendorState', state);
    alert(`A vendor named "${duplicateVendor.name}" already exists.`);
    document.getElementById('vendorName').focus();
    return;
  }

  const vendor = ensureVendorState({
    id: existingVendor?.id || getNextEntityId('VEND', vendorsData),
    name,
    email,
    phone,
    address,
    gstin,
    state
  });

  if (isEditing) {
    const previousName = ensureVendorState(existingVendor).name;
    vendorsData[editingVendorIndex] = vendor;
    organizationPurchaseOrdersData = organizationPurchaseOrdersData.map((entry) => {
      const record = ensureOrganizationPurchaseOrder(entry);
      return record.vendorName === previousName ? { ...record, vendorName: vendor.name } : record;
    });
    persistOrganizationPurchaseOrders();
  } else {
    vendorsData.push(vendor);
  }

  persistVendors();
  try {
    await persistAppStorageToDisk();
  } catch (persistError) {
    console.error("Vendor disk sync failed:", persistError);
    alert(`Vendor save did not reach disk.\n\n${persistError.message || 'Unknown disk sync error.'}`);
    return;
  }
  editingVendorIndex = null;
  const actionType = isEditing ? 'updated' : 'added';
  setVendorFormMode();
  displayVendorsList();
  populateVendorDropdown();
  displayOrganizationPurchaseOrdersList();
  renderDashboardSummary();
  setTimeout(() => {
    alert(`Vendor ${actionType} successfully!`);
    clearVendorFormFields();
  }, 50);
}

function editVendor(index) {
  const existingVendor = vendorsData[index];
  if (!existingVendor) return;
  const vendor = ensureVendorState(existingVendor);

  editingVendorIndex = index;
  document.getElementById('vendorName').value = vendor.name || '';
  document.getElementById('vendorEmail').value = vendor.email || '';
  document.getElementById('vendorPhone').value = vendor.phone || '';
  document.getElementById('vendorAddress').value = vendor.address || '';
  document.getElementById('vendorGST').value = vendor.gstin || '';
  populateStateDropdown('vendorState', vendor.state || DEFAULT_LOCAL_STATE);

  setVendorFormMode();
  const select = document.getElementById('vendorsDropdown');
  if (select) select.value = String(index);
}

function editSelectedVendor() {
  const select = document.getElementById('vendorsDropdown');
  if (!select || select.value === '') return;
  editVendor(parseInt(select.value, 10));
}

function displayVendorsList() {
  const container = document.getElementById('vendorsList');
  if (!container) return;

  if (!vendorsData || vendorsData.length === 0) {
    container.innerHTML = '<p class="setup-empty">No vendors added yet</p>';
    setVendorFormMode();
    return;
  }

  let options = '';
  vendorsData.forEach((vendor, index) => {
    const safeVendor = ensureVendorState(vendor);
    const selected = editingVendorIndex === index ? ' selected' : '';
    options += `<option value="${index}"${selected}>${safeVendor.name} | ${safeVendor.state || DEFAULT_LOCAL_STATE} | GSTIN: ${displayOptional(safeVendor.gstin)} | Phone: ${displayOptional(safeVendor.phone)}</option>`;
  });

  container.innerHTML = `
    <div class="setup-dropdown-wrap">
      <select id="vendorsDropdown" class="setup-dropdown">${options}</select>
      <div class="setup-dropdown-actions">
        <button class="btn btn-primary" onclick="editSelectedVendor()">Edit Selected</button>
        <button class="btn btn-danger" onclick="deleteSelectedVendor()">Delete Selected</button>
      </div>
    </div>
  `;
  setVendorFormMode();
}

function deleteVendor(index) {
  const vendor = vendorsData[index];
  if (!vendor) return;
  const safeVendor = ensureVendorState(vendor);

  if (organizationPurchaseOrdersData.some((entry) => ensureOrganizationPurchaseOrder(entry).vendorName === safeVendor.name)) {
    alert('This vendor is used in purchase orders. Update or delete those purchase orders first.');
    return;
  }

  if (confirm('Are you sure you want to delete this vendor?')) {
    vendorsData.splice(index, 1);
    if (editingVendorIndex === index) {
      editingVendorIndex = null;
      clearVendorFormFields();
      setVendorFormMode();
    } else if (editingVendorIndex !== null && index < editingVendorIndex) {
      editingVendorIndex -= 1;
    }
    persistVendors();
    displayVendorsList();
    populateVendorDropdown();
  }
}

function deleteSelectedVendor() {
  const select = document.getElementById('vendorsDropdown');
  if (!select || select.value === '') return;
  deleteVendor(parseInt(select.value, 10));
}

// Add or update Customer
async function addCustomer() {
  const name = toTitleCase(document.getElementById('customerName').value.trim());
  const email = document.getElementById('customerEmail').value.trim().toLowerCase();
  const phone = document.getElementById('customerPhone').value.trim();
  const address = toSentenceCase(document.getElementById('customerAddress').value.trim());
  const gstin = document.getElementById('customerGST').value.trim().toUpperCase();
  const state = normalizeState(document.getElementById('customerState').value);

  if (!name || !address) {
    // Restore form values BEFORE showing alert
    document.getElementById('customerName').value = name;
    document.getElementById('customerEmail').value = email;
    document.getElementById('customerPhone').value = phone;
    document.getElementById('customerAddress').value = address;
    document.getElementById('customerGST').value = gstin;
    populateStateDropdown('customerState', state);
    alert('Please fill Customer Name and Address.');
    document.getElementById('customerName').focus();
    return;
  }

  if (gstin && !isValidGstin(gstin)) {
    document.getElementById('customerName').value = name;
    document.getElementById('customerEmail').value = email;
    document.getElementById('customerPhone').value = phone;
    document.getElementById('customerAddress').value = address;
    document.getElementById('customerGST').value = gstin;
    populateStateDropdown('customerState', state);
    alert('GSTIN format is invalid. It must be 15 characters (e.g. 36AABCU9603R1ZX).');
    document.getElementById('customerGST').focus();
    return;
  }

  const isEditing = editingCustomerIndex !== null && !!customersData[editingCustomerIndex];
  const existingCustomer = isEditing ? customersData[editingCustomerIndex] : null;

  const duplicateCustomer = customersData.find((c, idx) => {
    if (isEditing && idx === editingCustomerIndex) return false;
    return ensureCustomerState(c).name.toLowerCase() === name.toLowerCase();
  });
  if (duplicateCustomer) {
    document.getElementById('customerName').value = name;
    document.getElementById('customerEmail').value = email;
    document.getElementById('customerPhone').value = phone;
    document.getElementById('customerAddress').value = address;
    document.getElementById('customerGST').value = gstin;
    populateStateDropdown('customerState', state);
    alert(`A customer named "${duplicateCustomer.name}" already exists.`);
    document.getElementById('customerName').focus();
    return;
  }

  const customer = ensureCustomerState({
    id: existingCustomer?.id || getNextEntityId('CUST', customersData),
    name,
    email,
    phone,
    address,
    gstin,
    state
  });

  if (isEditing) {
    customersData[editingCustomerIndex] = customer;
  } else {
    customersData.push(customer);
  }
  localStorage.setItem(STORAGE_KEYS.customers, JSON.stringify(customersData));
  try {
    await persistAppStorageToDisk();
  } catch (persistError) {
    console.error("Customer disk sync failed:", persistError);
    alert(`Customer save did not reach disk.\n\n${persistError.message || 'Unknown disk sync error.'}`);
    return;
  }
  syncCustomerPurchaseOrdersForCustomer(customer);

  if (invoice.customerSelected?.id === customer.id) {
    invoice.setCustomer(customer);
    updateInvoicePreview();
  }

  editingCustomerIndex = null;
  const actionType = isEditing ? 'updated' : 'added';
  displayCustomersList();
  setCustomerFormMode();
  populateCustomerDropdown();
  populateCustomerPurchaseOrderFormCustomers();
  checkIfReadyToStart();
  setTimeout(() => {
    alert(`Customer ${actionType} successfully!`);
    clearCustomerFormFields();
  }, 50);
}

function editCustomer(index) {
  const existingCustomer = customersData[index];
  if (!existingCustomer) return;
  const customer = ensureCustomerState(existingCustomer);

  editingCustomerIndex = index;
  document.getElementById('customerName').value = customer.name || '';
  document.getElementById('customerEmail').value = customer.email || '';
  document.getElementById('customerPhone').value = customer.phone || '';
  document.getElementById('customerAddress').value = customer.address || '';
  document.getElementById('customerGST').value = customer.gstin || '';
  populateStateDropdown('customerState', customer.state || DEFAULT_LOCAL_STATE);

  setCustomerFormMode();
  const select = document.getElementById('customersDropdown');
  if (select) select.value = String(index);
}

function editSelectedCustomer() {
  const select = document.getElementById('customersDropdown');
  if (!select || select.value === '') return;
  editCustomer(parseInt(select.value, 10));
}

// Display Customers List
function displayCustomersList() {
  const container = document.getElementById('customersList');

  if (!customersData || customersData.length === 0) {
    container.innerHTML = '<p class="setup-empty">No customers added yet</p>';
    setCustomerFormMode();
    return;
  }

  let options = '';
  customersData.forEach((customer, index) => {
    const safeCustomer = ensureCustomerState(customer);
    const selected = editingCustomerIndex === index ? ' selected' : '';
    options += `<option value="${index}"${selected}>${safeCustomer.name} | ${safeCustomer.state || DEFAULT_LOCAL_STATE} | GSTIN: ${displayOptional(safeCustomer.gstin)} | Phone: ${displayOptional(safeCustomer.phone)}</option>`;
  });

  container.innerHTML = `
    <div class="setup-dropdown-wrap">
      <select id="customersDropdown" class="setup-dropdown">${options}</select>
      <div class="setup-dropdown-actions">
        <button class="btn btn-primary" onclick="editSelectedCustomer()">Edit Selected</button>
        <button class="btn btn-danger" onclick="deleteSelectedCustomer()">Delete Selected</button>
      </div>
    </div>
  `;
  setCustomerFormMode();
}

// Delete Customer
function deleteCustomer(index) {
  const customer = customersData[index];
  if (!customer) return;

  if (confirm('Are you sure you want to delete this customer?')) {
    customersData.splice(index, 1);

    if (editingCustomerIndex === index) {
      editingCustomerIndex = null;
      clearCustomerFormFields();
    } else if (editingCustomerIndex !== null && editingCustomerIndex > index) {
      editingCustomerIndex -= 1;
    }

    if (invoice.customerSelected?.id === customer.id) {
      invoice.setCustomer(null);
      const customerSelect = document.getElementById('customerSelect');
      if (customerSelect) customerSelect.value = '';
      updateInvoicePreview();
    }

    localStorage.setItem(STORAGE_KEYS.customers, JSON.stringify(customersData));
    removeCustomerPurchaseOrdersForCustomer(customer.id);
    displayCustomersList();
    populateCustomerDropdown();
    populateCustomerPurchaseOrderFormCustomers();
    checkIfReadyToStart();
  }
}

function deleteSelectedCustomer() {
  const select = document.getElementById('customersDropdown');
  if (!select || select.value === '') return;
  deleteCustomer(parseInt(select.value, 10));
}

// Add or update Item
async function addItem() {
  const type = document.getElementById('itemType').value;
  const name = toTitleCase(document.getElementById('itemName').value.trim());
  const description = toSentenceCase(document.getElementById('itemDescription').value.trim());
  const hsnSac = normalizeHsnSac(document.getElementById('itemHsn').value);
  const rate = document.getElementById('itemRate').value.trim();

  if (!name || !description || !rate) {
    // Restore form values BEFORE showing alert
    document.getElementById('itemType').value = type;
    document.getElementById('itemName').value = name;
    document.getElementById('itemDescription').value = description;
    document.getElementById('itemHsn').value = hsnSac;
    document.getElementById('itemRate').value = rate;
    alert('Please fill in all item fields');
    document.getElementById('itemName').focus();
    return;
  }

  if (parseFloat(rate) <= 0) {
    // Restore form values BEFORE showing alert
    document.getElementById('itemType').value = type;
    document.getElementById('itemName').value = name;
    document.getElementById('itemDescription').value = description;
    document.getElementById('itemHsn').value = hsnSac;
    document.getElementById('itemRate').value = rate;
    alert('Rate must be greater than 0');
    document.getElementById('itemName').focus();
    return;
  }

  const isEditing = editingItemIndex !== null && !!itemsData[editingItemIndex];
  const existingItem = isEditing ? ensureCatalogItem(itemsData[editingItemIndex]) : null;

  const duplicateItem = itemsData.find((item, idx) => {
    if (isEditing && idx === editingItemIndex) return false;
    return ensureCatalogItem(item).name.toLowerCase() === name.toLowerCase();
  });
  if (duplicateItem) {
    document.getElementById('itemType').value = type;
    document.getElementById('itemName').value = name;
    document.getElementById('itemDescription').value = description;
    document.getElementById('itemHsn').value = hsnSac;
    document.getElementById('itemRate').value = rate;
    alert(`An item/service named "${duplicateItem.name}" already exists.`);
    document.getElementById('itemName').focus();
    return;
  }

  const item = ensureCatalogItem({
    id: existingItem?.id || getNextEntityId('SRV', itemsData),
    type,
    name,
    description,
    hsnSac,
    defaultRate: parseFloat(rate)
  });

  if (isEditing) {
    itemsData[editingItemIndex] = item;
  } else {
    itemsData.push(item);
  }
  localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(itemsData));
  try {
    await persistAppStorageToDisk();
  } catch (persistError) {
    console.error("Item disk sync failed:", persistError);
    alert(`Item save did not reach disk.\n\n${persistError.message || 'Unknown disk sync error.'}`);
    return;
  }

  invoice.items = invoice.items.map((lineItem) => {
    if (lineItem.id !== item.id) return lineItem;
    return {
      ...lineItem,
      name: item.name,
      description: item.description,
      hsnSac: item.hsnSac
    };
  });
  
  const actionType = isEditing ? 'updated' : 'added';

  customerPurchaseOrderDraftItems = customerPurchaseOrderDraftItems.map((lineItem) => {
    if (lineItem.id !== item.id) return lineItem;
    return {
      ...lineItem,
      name: item.name,
      hsnSac: item.hsnSac
    };
  });

  editingItemIndex = null;
  setItemFormMode();
  displayItemsList();
  populateItemsDropdown();
  populateCustomerPurchaseOrderItemDropdown();
    populateOrganizationPurchaseOrderItemDropdown();
  populateItemNameSuggestions();
  renderCustomerPurchaseOrderItemsTable();
  renderItemsTable();
  updateInvoicePreview();
  checkIfReadyToStart();
  setTimeout(() => {
    alert(`Item ${actionType} successfully!`);
    clearItemFormFields();
  }, 50);
}

function editItem(index) {
  const existingItem = itemsData[index];
  if (!existingItem) return;
  const item = ensureCatalogItem(existingItem);

  editingItemIndex = index;
  document.getElementById('itemType').value = item.type || 'Service';
  document.getElementById('itemName').value = item.name || '';
  document.getElementById('itemDescription').value = item.description || '';
  document.getElementById('itemHsn').value = item.hsnSac || '';
  document.getElementById('itemRate').value = String(safeNumber(item.defaultRate) || '');

  setItemFormMode();
  const select = document.getElementById('itemsDropdown');
  if (select) select.value = String(index);
}

function editSelectedItem() {
  const select = document.getElementById('itemsDropdown');
  if (!select || select.value === '') return;
  editItem(parseInt(select.value, 10));
}

// Display Items List
function displayItemsList() {
  const container = document.getElementById('itemsList');

  if (!itemsData || itemsData.length === 0) {
    container.innerHTML = '<p class="setup-empty">No items added yet</p>';
    setItemFormMode();
    return;
  }

  let options = '';
  itemsData.forEach((item, index) => {
    const safeItem = ensureCatalogItem(item);
    const selected = editingItemIndex === index ? ' selected' : '';
    options += `<option value="${index}"${selected}>${safeItem.name} | HSN/SAC: ${safeItem.hsnSac} | ${formatMoney(safeItem.defaultRate)}</option>`;
  });

  container.innerHTML = `
    <div class="setup-dropdown-wrap">
      <select id="itemsDropdown" class="setup-dropdown">${options}</select>
      <div class="setup-dropdown-actions">
        <button class="btn btn-primary" onclick="editSelectedItem()">Edit Selected</button>
        <button class="btn btn-danger" onclick="deleteSelectedItem()">Delete Selected</button>
      </div>
    </div>
  `;
  setItemFormMode();
}

// Delete Item
function deleteItem(index) {
  const item = itemsData[index];
  if (!item) return;

  if (confirm('Are you sure you want to delete this item?')) {
    itemsData.splice(index, 1);

    if (editingItemIndex === index) {
      editingItemIndex = null;
      clearItemFormFields();
    } else if (editingItemIndex !== null && editingItemIndex > index) {
      editingItemIndex -= 1;
    }

    localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(itemsData));
    displayItemsList();
    populateItemsDropdown();
    populateCustomerPurchaseOrderItemDropdown();
    populateOrganizationPurchaseOrderItemDropdown();
    populateItemNameSuggestions();
    checkIfReadyToStart();
  }
}

function deleteSelectedItem() {
  const select = document.getElementById('itemsDropdown');
  if (!select || select.value === '') return;
  deleteItem(parseInt(select.value, 10));
}

// Check if ready to start invoice creation
function checkIfReadyToStart() {
  const startBtn = document.querySelector('[onclick="startInvoiceCreation()"]');
  if (startBtn) {
    if (customersData && customersData.length > 0 && itemsData && itemsData.length > 0) {
      startBtn.disabled = false;
      startBtn.style.opacity = '1';
    } else {
      startBtn.disabled = true;
      startBtn.style.opacity = '0.5';
    }
  }
}

// Start invoice creation
function startInvoiceCreation() {
  if (!customersData || customersData.length === 0 || !itemsData || itemsData.length === 0) {
    alert('Please add at least one customer and one item before continuing');
    return;
  }
  showMainSection();
}

// Back to setup
function backToSetup() {
  showSetupSection();
}

// Populate customer dropdown
function populateCustomerDropdown() {
  const select = document.getElementById('customerSelect');
  const currentValue = invoice.customerSelected?.id || '';
  if (!select) return;
  select.innerHTML = '<option value="">-- Select Customer --</option>';

  customersData.forEach((customer) => {
    const safeCustomer = ensureCustomerState(customer);
    const option = document.createElement('option');
    option.value = safeCustomer.id;
    option.textContent = safeCustomer.name;
    option.dataset.customer = JSON.stringify(safeCustomer);
    select.appendChild(option);
  });

  if (currentValue) {
    select.value = currentValue;
  }

  select.onchange = handleCustomerChange;
}

function populateVendorDropdown(selectedVendorName = '') {
  const select = document.getElementById('organizationOrderVendor');
  if (!select) return;

  const currentValue = selectedVendorName || select.value || '';
  select.innerHTML = '<option value="">-- Select Vendor --</option>';

  vendorsData.forEach((vendor) => {
    const safeVendor = ensureVendorState(vendor);
    const option = document.createElement('option');
    option.value = safeVendor.name;
    option.textContent = safeVendor.name;
    select.appendChild(option);
  });

  if (currentValue) {
    const hasMatch = Array.from(select.options).some((option) => option.value === currentValue);
    if (!hasMatch) {
      const option = document.createElement('option');
      option.value = currentValue;
      option.textContent = `${currentValue} (Saved in PO)`;
      select.appendChild(option);
    }
    select.value = currentValue;
  }

  updateOrganizationVendorSummary();
}

function updateOrganizationVendorSummary() {
  const select = document.getElementById('organizationOrderVendor');
  const summary = document.getElementById('organizationVendorSummary');
  if (!summary) return;

  const vendorName = String(select?.value || '').trim();
  if (!vendorName) {
    summary.textContent = 'Select a vendor to view total invoices and total amount.';
    return;
  }

  const vendorOrders = organizationPurchaseOrdersData
    .map(ensureOrganizationPurchaseOrder)
    .filter((entry) => entry.vendorName === vendorName);

  const totalInvoices = vendorOrders.length;
  const totalAmount = vendorOrders.reduce((sum, entry) => sum + safeNumber(entry.amount), 0);
  summary.textContent = `Total invoices: ${totalInvoices} | Total amount: ${formatMoney(totalAmount)}`;
}

// Handle customer change
function handleCustomerChange() {
  const select = document.getElementById('customerSelect');
  const previousCustomerId = invoice.customerSelected?.id || '';
  if (select.value) {
    const customerData = JSON.parse(select.options[select.selectedIndex].dataset.customer);
    invoice.setCustomer(customerData);
  } else {
    invoice.setCustomer(null);
  }

  if (!select.value || select.value !== previousCustomerId) {
    invoice.setCustomerPurchaseOrderId('');
    document.getElementById('poDate').value = document.getElementById('invoiceDate').value || '';
    invoice.setPONumber('');
    invoice.setPODate(document.getElementById('poDate').value || '');
  }

  populateCustomerPurchaseOrderDropdown(select.value || '');
  updateInvoicePreview();
}

// Populate items dropdown
function populateItemsDropdown() {
  // Keep a hidden select for legacy draft-restore compatibility
  let hidden = document.getElementById('itemSelect');
  if (!hidden) {
    hidden = document.createElement('select');
    hidden.id = 'itemSelect';
    hidden.style.display = 'none';
    document.body.appendChild(hidden);
  }
  hidden.innerHTML = '<option value=""></option>';
  itemsData.forEach((item) => {
    const safeItem = ensureCatalogItem(item);
    const option = document.createElement('option');
    option.value = safeItem.id;
    option.textContent = safeItem.name;
    option.dataset.item = JSON.stringify(safeItem);
    hidden.appendChild(option);
  });
}

// Handle item change
function handleItemChange() {
  // Legacy — item selection now handled by handleInvoiceItemSuggestionChange
}

// Set today's date
function setTodayDate() {
  const today = new Date().toISOString().split('T')[0];
  const invoiceDateInput = document.getElementById('invoiceDate');
  const poDateInput = document.getElementById('poDate');
  if (invoiceDateInput) invoiceDateInput.value = today;
  if (poDateInput) poDateInput.value = today;
  invoice.setInvoiceDate(today);
  invoice.setPODate(today);
}

function getFinancialYearLabel(dateValue) {
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  const year = parsed.getFullYear();
  const month = parsed.getMonth();
  const startYear = month >= 3 ? year : year - 1;
  const startYearShort = String(startYear % 100).padStart(2, '0');
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYearShort}-${endYearShort}`;
}

function generateInvoiceNumberForDate(dateValue) {
  const safeDate = String(dateValue || '').trim() || new Date().toISOString().split('T')[0];
  const fyLabel = getFinancialYearLabel(safeDate);
  const invoices = getSafeInvoices();
  const matchingInvoices = invoices.filter((entry) => getFinancialYearLabel(entry.invoiceDate) === fyLabel);
  let nextNumber = 1;

  matchingInvoices.forEach((entry) => {
    const match = String(entry.invoiceNumber || '').match(/(\d+)(?!.*\d)/);
    if (!match) return;
    nextNumber = Math.max(nextNumber, parseInt(match[1], 10) + 1);
  });

  return `${fyLabel}/${String(nextNumber).padStart(4, '0')}`;
}

// Generate new invoice number
function generateNewInvoiceNumber() {
  const invoiceDateInput = document.getElementById('invoiceDate');
  const sourceDate = invoiceDateInput?.value || invoice.invoiceDate || new Date().toISOString().split('T')[0];
  const formattedNumber = generateInvoiceNumberForDate(sourceDate);

  const invoiceNumberDisplay = document.getElementById('invoiceNumberDisplay');
  if (invoiceNumberDisplay) {
    invoiceNumberDisplay.textContent = formattedNumber;
  }
  invoice.setInvoiceNumber(formattedNumber);
}

// Handle date change
function handleDateChange(event) {
  invoice.setInvoiceDate(event.target.value);
  if (editingInvoiceIndex === null) {
    generateNewInvoiceNumber();
  }
  updateInvoicePreview();
}

function handlePODateChange(event) {
  invoice.setPODate(event.target.value);
  updateInvoicePreview();
}

function handlePONumberChange(event) {
  invoice.setPONumber(event.target.value.trim());
  updateInvoicePreview();
}

function handleShippingAddressChange(event) {
  invoice.setShippingAddress(event.target.value);
  updateInvoicePreview();
}

function handleRoundOffChange(event) {
  invoice.setRoundOffEnabled(event.target.value);
  updateInvoicePreview();
}

function syncInvoiceStateFromForm() {
  const invoiceNumberDisplay = document.getElementById('invoiceNumberDisplay');
  if (invoiceNumberDisplay) {
    invoice.setInvoiceNumber(String(invoiceNumberDisplay.textContent || '').trim());
  }

  const invoiceDateInput = document.getElementById('invoiceDate');
  if (invoiceDateInput?.value) {
    invoice.setInvoiceDate(invoiceDateInput.value);
  }

  const poNumberInput = document.getElementById('poNumber');
  if (poNumberInput) {
    invoice.setPONumber(poNumberInput.value.trim());
  }

  const poDateInput = document.getElementById('poDate');
  if (poDateInput) {
    invoice.setPODate(poDateInput.value || '');
  }

  const shippingAddressInput = document.getElementById('shippingAddress');
  if (shippingAddressInput) {
    invoice.setShippingAddress(shippingAddressInput.value || '');
  }

  const customerPoSelect = document.getElementById('customerPoSelect');
  if (customerPoSelect) {
    invoice.setCustomerPurchaseOrderId(customerPoSelect.value || '');
  }

  const roundOffSelect = document.getElementById('roundOffSelect');
  if (roundOffSelect) {
    invoice.setRoundOffEnabled(roundOffSelect.value);
  }
}

// Validate form inputs
function validateInputs() {
  const customerSelect = document.getElementById('customerSelect').value;
  const itemInput = document.getElementById('itemSelectInput');
  const quantity = document.getElementById('quantityInput').value;
  const rate = document.getElementById('rateInput').value;

  if (!customerSelect) {
    alert('Please select a customer');
    return false;
  }

  if (!itemInput || !itemInput.value.trim()) {
    alert('Please select or enter a service/item');
    itemInput?.focus();
    return false;
  }

  if (!quantity || parseFloat(quantity) <= 0) {
    alert('Please enter a valid quantity');
    return false;
  }

  if (!rate || parseFloat(rate) <= 0) {
    alert('Please enter a valid rate');
    return false;
  }

  return true;
}

// Add item to invoice
// --- Invoice item combo-box ---
// Tracks the currently selected catalog item from the suggestion list
let _invoiceSelectedItem = null;

function updateInvoiceItemSuggestions(filterValue) {
  const suggestions = document.getElementById('itemSelectSuggestions');
  if (!suggestions) return;
  const normalized = String(filterValue || '').trim().toLowerCase();

  const matches = (itemsData || [])
    .map(ensureCatalogItem)
    .filter((i) => i.name && (!normalized || i.name.toLowerCase().startsWith(normalized)))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (matches.length === 0) {
    suggestions.innerHTML = '';
    suggestions.style.display = 'none';
    return;
  }

  suggestions.innerHTML = '';
  const clearOpt = document.createElement('option');
  clearOpt.value = '';
  clearOpt.textContent = '-- Deselect --';
  suggestions.appendChild(clearOpt);
  matches.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = `${item.name}  —  ${formatMoney(item.defaultRate)}`;
    opt.dataset.item = JSON.stringify(item);
    suggestions.appendChild(opt);
  });
  suggestions.selectedIndex = 0;
  suggestions.style.display = 'block';
}

function hideInvoiceItemSuggestions() {
  const suggestions = document.getElementById('itemSelectSuggestions');
  if (suggestions) suggestions.style.display = 'none';
}

function handleInvoiceItemInput(event) {
  const val = String(event?.target?.value || '').trim();
  _invoiceSelectedItem = null;
  updateInvoiceItemSuggestions(val);

  const panel = document.getElementById('newItemPanel');
  const rateInput = document.getElementById('rateInput');

  if (!val) {
    if (rateInput) rateInput.value = '';
    if (panel) panel.style.display = 'none';
    return;
  }

  // Check if typed text matches an existing item exactly
  const exactMatch = (itemsData || []).find(
    (i) => ensureCatalogItem(i).name.toLowerCase() === val.toLowerCase()
  );

  if (exactMatch) {
    _invoiceSelectedItem = ensureCatalogItem(exactMatch);
    if (rateInput) rateInput.value = _invoiceSelectedItem.defaultRate;
    if (panel) panel.style.display = 'none';
  } else {
    if (rateInput) rateInput.value = '';
    if (panel) panel.style.display = 'block';
  }
}

function handleInvoiceItemSuggestionChange(event) {
  const suggestions = document.getElementById('itemSelectSuggestions');
  const input = document.getElementById('itemSelectInput');
  const rateInput = document.getElementById('rateInput');
  const panel = document.getElementById('newItemPanel');

  if (!event.target.value) {
    if (input) input.value = '';
    _invoiceSelectedItem = null;
    if (rateInput) rateInput.value = '';
    if (panel) panel.style.display = 'none';
    hideInvoiceItemSuggestions();
    return;
  }

  const selectedOpt = suggestions.options[suggestions.selectedIndex];
  const item = selectedOpt?.dataset?.item ? ensureCatalogItem(JSON.parse(selectedOpt.dataset.item)) : null;
  if (item) {
    _invoiceSelectedItem = item;
    if (input) input.value = item.name;
    if (rateInput) rateInput.value = item.defaultRate;
    if (panel) panel.style.display = 'none';
  }
  hideInvoiceItemSuggestions();
  document.getElementById('quantityInput')?.focus();
}

function syncNewItemRateToInvoice() {
  const newRate = document.getElementById('newItemRate')?.value;
  const rateInput = document.getElementById('rateInput');
  if (rateInput && newRate) rateInput.value = newRate;
}

function clearInvoiceItemCombo() {
  const input = document.getElementById('itemSelectInput');
  const rateInput = document.getElementById('rateInput');
  const qtyInput = document.getElementById('quantityInput');
  const panel = document.getElementById('newItemPanel');
  if (input) input.value = '';
  if (rateInput) rateInput.value = '';
  if (qtyInput) qtyInput.value = '1';
  if (panel) {
    panel.style.display = 'none';
    document.getElementById('newItemHsn').value = '';
    document.getElementById('newItemRate').value = '';
    document.getElementById('newItemDescription').value = '';
  }
  hideInvoiceItemSuggestions();
  _invoiceSelectedItem = null;
}

async function saveNewItemAndAddToInvoice() {
  const customerSelect = document.getElementById('customerSelect').value;
  if (!customerSelect) {
    alert('Please select a customer first.');
    return;
  }

  const name = document.getElementById('itemSelectInput').value.trim();
  const description = document.getElementById('newItemDescription').value.trim();
  const hsnSac = normalizeHsnSac(document.getElementById('newItemHsn').value);
  const rateVal = document.getElementById('newItemRate').value.trim();
  const quantity = parseFloat(document.getElementById('quantityInput').value) || 1;

  if (!name) { alert('Item name is required.'); document.getElementById('itemSelectInput').focus(); return; }
  if (!description) { alert('Description is required.'); document.getElementById('newItemDescription').focus(); return; }
  if (!rateVal || parseFloat(rateVal) <= 0) { alert('Rate must be greater than 0.'); document.getElementById('newItemRate').focus(); return; }

  const rate = parseFloat(rateVal);

  const duplicate = itemsData.find((i) => ensureCatalogItem(i).name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    alert(`"${duplicate.name}" already exists. Select it from the suggestions.`);
    return;
  }

  const item = ensureCatalogItem({
    id: getNextEntityId('SRV', itemsData),
    type: 'Service',
    name,
    description,
    hsnSac,
    defaultRate: rate
  });

  itemsData.push(item);
  localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(itemsData));
  try { await persistAppStorageToDisk(); } catch (e) { console.error('New item disk sync failed:', e); }

  populateItemsDropdown();
  populateCustomerPurchaseOrderItemDropdown();
  populateOrganizationPurchaseOrderItemDropdown();
  populateItemNameSuggestions();
  displayItemsList();
  checkIfReadyToStart();

  const result = invoice.addItem(item, quantity, rate);
  if (result.merged) {
    alert(`"${item.name}" already exists in the invoice. Quantity updated to ${result.lineItem.quantity}.`);
  }

  clearInvoiceItemCombo();
  updateInvoicePreview();
  renderItemsTable();
}

window.handleInvoiceItemInput = handleInvoiceItemInput;
window.handleInvoiceItemSuggestionChange = handleInvoiceItemSuggestionChange;
window.hideInvoiceItemSuggestions = hideInvoiceItemSuggestions;
window.syncNewItemRateToInvoice = syncNewItemRateToInvoice;
window.clearInvoiceItemCombo = clearInvoiceItemCombo;
window.saveNewItemAndAddToInvoice = saveNewItemAndAddToInvoice;

// Hide invoice item suggestions when clicking outside the combo
document.addEventListener('click', (e) => {
  const input = document.getElementById('itemSelectInput');
  const suggestions = document.getElementById('itemSelectSuggestions');
  if (!input || !suggestions) return;
  if (!input.contains(e.target) && !suggestions.contains(e.target)) {
    hideInvoiceItemSuggestions();
  }
});

function addItemToInvoice() {
  if (!validateInputs()) return;

  const itemInput = document.getElementById('itemSelectInput');
  const quantityInput = document.getElementById('quantityInput');
  const rateInput = document.getElementById('rateInput');
  const typedName = itemInput.value.trim();

  // Find matching catalog item by name (case-insensitive)
  const selectedItem = ensureCatalogItem(
    itemsData.find((i) => ensureCatalogItem(i).name.toLowerCase() === typedName.toLowerCase()) || {}
  );

  if (!selectedItem.id) {
    alert('Item not found in catalog. Please use the "Save & Add to Invoice" button to add a new item.');
    itemInput.focus();
    return;
  }

  const quantity = quantityInput.value;
  const rate = rateInput.value;

  const result = invoice.addItem(selectedItem, quantity, rate);
  if (result.merged) {
    alert(`"${selectedItem.name}" already exists in the invoice. Quantity updated to ${result.lineItem.quantity}.`);
  }

  clearInvoiceItemCombo();
  updateInvoicePreview();
  renderItemsTable();
}

// Render items table
function renderItemsTable() {
  const tableBody = document.getElementById('invoiceItemsTableBody');
  tableBody.innerHTML = '';

  if (invoice.items.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No items added yet</td></tr>';
    return;
  }

  invoice.items.forEach((item, index) => {
    const safeItem = ensureInvoiceLineItem(item);
    const rateWithTax = item.rate * 1.18;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>
        <strong>${item.name}</strong>
        <textarea onchange="updateItemDescription(${index}, this.value)">${safeItem.description || ''}</textarea>
      </td>
      <td>${safeItem.hsnSac}</td>
      <td class="text-right">
        <input
          class="inline-qty-input"
          type="number"
          value="${safeItem.quantity}"
          min="1"
          step="1"
          onchange="updateQuantity(${index}, this.value)">
      </td>
      <td class="text-right">${invoice.formatCurrency(rateWithTax)}</td>
      <td class="text-right">
        <input
          class="inline-rate-input"
          type="number"
          value="${safeItem.rate}"
          min="0"
          step="0.01"
          onchange="updateItemRate(${index}, this.value)">
      </td>
      <td class="text-right">${invoice.formatCurrency(safeItem.total)}</td>
      <td class="text-right"><button class="btn btn-danger" onclick="removeItem(${index})">Delete</button></td>
    `;
    tableBody.appendChild(row);
  });
}

// Remove item from invoice
function removeItem(index) {
  invoice.removeItem(index);
  renderItemsTable();
  updateInvoicePreview();
}
function updateQuantity(index, newQty) {

  const qty = parseFloat(newQty);

  if (!qty || qty <= 0) {
    alert("Quantity must be greater than 0");
    renderItemsTable();
    return;
  }

  const item = invoice.items[index];

  item.quantity = qty;
  item.total = qty * item.rate;

  renderItemsTable();
  updateInvoicePreview();
}

function updateItemRate(index, newRate) {
  const rate = safeNumber(newRate);
  if (rate <= 0) {
    alert("Rate must be greater than 0");
    renderItemsTable();
    return;
  }

  const item = invoice.items[index];
  if (!item) return;

  item.rate = rate;
  item.total = safeNumber(item.quantity) * rate;

  renderItemsTable();
  updateInvoicePreview();
}

function updateItemDescription(index, newDescription) {
  const item = invoice.items[index];
  if (!item) return;

  item.description = String(newDescription || '').trim();
  updateInvoicePreview();
}

// Update invoice preview
function updateInvoicePreview() {
  const preview = document.getElementById('invoicePreview');
  persistCurrentInvoiceDraft();

  if (!preview) {
    return;
  }

  if (invoice.isEmpty() || !invoice.customerSelected) {
    const emptyMessage = isStandalonePreviewPage()
      ? 'Open an invoice from the editor to see the preview here.'
      : 'Select a customer and add items to preview invoice';
    preview.innerHTML = `<div class="empty-state"><p>${emptyMessage}</p></div>`;
    return;
  }

  const companyInfo = invoice.companyInfo;
  const customer = ensureCustomerState(invoice.customerSelected);
  const subtotal = invoice.getSubtotal();
  const cgst = invoice.getCGST();
  const sgst = invoice.getSGST();
  const igst = invoice.getIGST();
  const totalBeforeRoundOff = invoice.getPreRoundGrandTotal();
  const roundOffAmount = invoice.getRoundOffAmount();
  const grandTotal = invoice.getGrandTotal();
  const grandTotalWords = numberToIndianWords(grandTotal);
  const buildTotalsRowMarkup = (label, amount, rowClass = 'totals-row', rowStyle = 'border-bottom:1px solid #e5e7eb;', cellPadding = '4px 10px') =>
    `<tr class="${rowClass}" style="${rowStyle}"><td class="totals-label-cell" style="padding:${cellPadding};padding-right:8px;text-align:left;white-space:nowrap;"><span class="total-label" style="font-size:inherit;line-height:1.2;font-weight:600;color:#111827;white-space:nowrap;">${label}:</span></td><td class="totals-amount-cell" style="padding:${cellPadding};padding-left:8px;text-align:right;white-space:nowrap;"><span class="total-amount" style="font-size:inherit;line-height:1.2;font-weight:700;color:#000;text-align:right;white-space:nowrap;">${amount}</span></td></tr>`;
  const isInterState = invoice.isInterStateSale();
  const poDateDisplay = invoice.poDate ? invoice.formatDate(invoice.poDate) : '-';
  const shippingAddress = String(invoice.shippingAddress || '').trim();

  let itemsHTML = '';
  invoice.items.forEach((item, index) => {
    const safeItem = ensureInvoiceLineItem(item);
    const rateWithTax = item.rate * 1.18;
    itemsHTML += `
      <tr>
        <td>${index + 1}</td>
        <td><strong>${item.name}</strong><br><span class="item-subtext">${item.description || '-'}</span></td>
        <td>${safeItem.hsnSac}</td>
        <td class="text-right">${item.quantity}</td>
        <td class="text-right">${invoice.formatCurrency(rateWithTax)}</td>
        <td class="text-right">${invoice.formatCurrency(item.rate)}</td>
        <td class="text-right">${invoice.formatCurrency(item.total)}</td>
      </tr>
    `;
  });

  const taxRowsHTML = isInterState
    ? buildTotalsRowMarkup('IGST (18%)', invoice.formatCurrency(igst))
    : `${buildTotalsRowMarkup('CGST (9%)', invoice.formatCurrency(cgst))}
      ${buildTotalsRowMarkup('SGST (9%)', invoice.formatCurrency(sgst))}`;
  const roundOffRowHTML = invoice.isRoundOffEnabled()
    ? buildTotalsRowMarkup('Round Off', invoice.formatCurrency(roundOffAmount))
    : '';
  const totalBeforeRoundOffRowHTML = invoice.isRoundOffEnabled()
    ? buildTotalsRowMarkup('Total', invoice.formatCurrency(totalBeforeRoundOff), 'totals-row total-before-roundoff-row')
    : '';

  const cancelledBanner = currentInvoiceStatus === 'Cancelled'
    ? '<div style="text-align: center; font-weight: bold; color: #d32f2f; font-size: 14px; margin-bottom: 8px; letter-spacing: 1px; padding: 6px; border: 2px solid #d32f2f; background-color: #ffebee;">CANCELLED</div>'
    : '';

  preview.innerHTML = `
    <div class="invoice-preview">
      ${cancelledBanner}
      <div class="invoice-header">
        <div class="invoice-title-center">Tax Invoice</div>
        <div class="invoice-header-row">
          <div class="company-brand">
            <div class="company-brand-top">
              <img
                class="invoice-logo-image"
                src="assets/Logo.jpeg"
                alt="Digidat Info Systems Logo"
                onerror="handleLogoFallback(this)"
              >
              <div class="invoice-logo-fallback">${getCompanyInitials(companyInfo.name)}</div>
              <div class="company-info">
                <p>${companyInfo.address}</p>
                <p>Phone: ${displayOptional(companyInfo.phone)}</p>
                <p>Email: ${displayOptional(companyInfo.email)}</p>
                <p>GSTIN: ${displayOptional(companyInfo.gstin)}</p>
              </div>
            </div>
          </div>
          <div class="customer-info buyer-info-block">
            <div class="section-title">Buyer (Bill To):</div>
            <p><strong>${customer.name}</strong></p>
            <p class="buyer-address-line">${customer.address}</p>
            <p>State: ${customer.state || DEFAULT_LOCAL_STATE} | GSTIN: ${displayOptional(customer.gstin)}</p>
            <p>Phone: ${displayOptional(customer.phone)} | Email: ${displayOptional(customer.email)}</p>
            ${shippingAddress ? `<div class="section-title shipping-title">Shipping Address:</div><p class="buyer-address-line">${shippingAddress}</p>` : ''}
          </div>
          <div class="invoice-meta-right">
            <div class="invoice-details">
              <div><strong>INV No:</strong> ${invoice.invoiceNumber}</div>
              <div><strong>Invoice Date:</strong> ${invoice.formatDate(invoice.invoiceDate)}</div>
              <p><strong>PO No:</strong> ${invoice.poNumber || '-'}</p>
              <p><strong>PO Date:</strong> ${poDateDisplay}</p>
            </div>
          </div>
        </div>
      </div>

      <div class="invoice-preview-table-wrap">
        <table class="invoice-table">
          <thead>
            <tr>
              <th>S.No</th>
              <th>Item Description</th>
              <th>HSN/SAC</th>
              <th>Qty</th>
              <th>Rate with Tax</th>
              <th>Rate</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHTML}
          </tbody>
        </table>
      </div>

      <table class="totals-section" style="border-collapse:collapse;margin-left:auto;font-size:10.5px;line-height:1.2;border:1px solid #d1d5db;border-radius:4px;overflow:hidden;">
        ${buildTotalsRowMarkup('Subtotal', invoice.formatCurrency(subtotal))}
        ${taxRowsHTML}
        ${totalBeforeRoundOffRowHTML}
        ${roundOffRowHTML}
        <tr class="grand-total-row" style="border-top:2px solid #1f2937;border-bottom:2px solid #1f2937;background-color:#f1f5f9;">
          <td class="totals-label-cell" style="padding:6px 10px;padding-right:8px;text-align:left;white-space:nowrap;">
            <span class="total-label" style="font-size:inherit;line-height:1.2;font-weight:700;color:#000;white-space:nowrap;">Grand Total:</span>
          </td>
          <td class="totals-amount-cell" style="padding:6px 10px;padding-left:8px;text-align:right;white-space:nowrap;">
            <span class="total-amount" style="font-size:inherit;line-height:1.2;font-weight:700;color:#000;text-align:right;white-space:nowrap;">${invoice.formatCurrency(grandTotal)}</span>
          </td>
        </tr>
      </table>
      ${getInvoiceBottomSectionMarkup(grandTotalWords)}
      <div class="invoice-footer">
        <p>This is a computer generated invoice</p>
      </div>
    </div>
  `;
  fitBuyerAddressLineElements(preview, window);
}

// Save invoice to storage
async function saveInvoice() {
  const saveBtn = document.getElementById('saveInvoiceBtn');
  if (saveBtn?.disabled) return; // prevent double-click
  if (saveBtn) saveBtn.disabled = true;

  try {
    const previewMode = isStandalonePreviewPage();
    syncInvoiceStateFromForm();

    if (invoice.isEmpty()) {
      alert('Please add at least one item');
      return;
    }

    if (!invoice.customerSelected) {
      alert('Please select a customer');
      return;
    }

    const invoiceData = invoice.toJSON();
    let invoices = getSafeInvoices();
    const canUpdateExisting = Number.isInteger(editingInvoiceIndex)
      && editingInvoiceIndex >= 0
      && editingInvoiceIndex < invoices.length;

    // Check for a duplicate invoice number when not in edit mode
    const duplicateIndex = !canUpdateExisting
      ? invoices.findIndex((inv) => inv.invoiceNumber && inv.invoiceNumber === invoiceData.invoiceNumber)
      : -1;

    if (duplicateIndex >= 0) {
      const dup = invoices[duplicateIndex];
      // Compare key fields to detect actual changes
      const hasChanges =
        JSON.stringify(dup.items) !== JSON.stringify(invoiceData.items) ||
        dup.customer?.id !== invoiceData.customer?.id ||
        dup.invoiceDate !== invoiceData.invoiceDate ||
        dup.poNumber !== invoiceData.poNumber ||
        dup.poDate !== invoiceData.poDate ||
        dup.shippingAddress !== invoiceData.shippingAddress ||
        dup.roundOffEnabled !== invoiceData.roundOffEnabled ||
        safeNumber(dup.grandTotal) !== safeNumber(invoiceData.grandTotal);

      if (!hasChanges) {
        alert(`Invoice ${invoiceData.invoiceNumber} is already saved. No changes detected.`);
        return;
      }

      const choice = window.confirm(
        `Invoice ${invoiceData.invoiceNumber} already exists but has changes.\n\nClick OK to update it, or Cancel to abort.`
      );
      if (!choice) return;
    }

    const resolvedIndex = canUpdateExisting ? editingInvoiceIndex : duplicateIndex;
    const previousInvoice = resolvedIndex >= 0 ? invoices[resolvedIndex] : null;
    const successMessage = previousInvoice ? "Invoice updated successfully!" : "Invoice saved successfully!";
    invoiceData.status = previousInvoice?.status || 'Active';
    invoiceData.cancelledAt = previousInvoice?.cancelledAt || null;

    if (resolvedIndex >= 0) {
      invoices[resolvedIndex] = invoiceData;
    } else {
      invoices.push(invoiceData);
    }

    localStorage.setItem(STORAGE_KEYS.invoices, JSON.stringify(invoices));
    try {
      const synced = await persistAppStorageToDisk();
      if (window.ShakerFileStorage?.isFileBacked?.() === true && !synced) {
        throw new Error("Disk-backed storage is active, but the invoice was not written to disk.");
      }
    } catch (persistError) {
      console.error("Invoice disk sync failed:", persistError);
      alert(`Invoice save did not reach disk.\n\n${persistError.message || 'Unknown disk sync error.'}`);
      return;
    }

    if (previousInvoice?.customerPurchaseOrderId && previousInvoice.customerPurchaseOrderId !== invoiceData.customerPurchaseOrderId) {
      unlinkCustomerPurchaseOrderFromInvoice(previousInvoice.customerPurchaseOrderId, previousInvoice.invoiceNumber || '');
    }    if (invoiceData.customerPurchaseOrderId) {
      linkCustomerPurchaseOrderToInvoice(invoiceData.customerPurchaseOrderId, invoiceData.invoiceNumber);
    }

    alert(successMessage);

    if (previewMode) {
      // Stay on preview page — just mark that editor should reset when Back is clicked
      localStorage.setItem('invoiceEditorShouldReset', '1');
      updateStorageStatusBadge();
      return;
    }
    resetInvoiceEditor();
    persistCurrentInvoiceDraft();
    renderDashboardSummary();
    updateStorageStatusBadge();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// Export to PDF
async function exportToPDF() {

  if (!isStandalonePreviewPage() && (invoice.isEmpty() || !invoice.customerSelected)) {
    alert('Please complete the invoice first');
    return;
  }
  
  if (currentInvoiceStatus === 'Cancelled') {
    const proceed = window.confirm('This is a CANCELLED invoice. Are you sure you want to download it as PDF?\n\nThe PDF will be marked as CANCELLED.');
    if (!proceed) return;
  }

  // On standalone preview page, don't call updateInvoicePreview() — it would clear the rendered preview
  if (!isStandalonePreviewPage()) {
    updateInvoicePreview();
  }
  const preview = document.querySelector('.invoice-preview');
  if (!preview) {
    alert('Invoice preview is not available for PDF export.');
    return;
  }
  
  if (!currentInvoiceStatus || currentInvoiceStatus !== invoice.status) {
    updateInvoicePreview();
  }

  if (typeof html2canvas === 'undefined' || !window.jspdf || !window.jspdf.jsPDF) {
    try {
      await exportBasicPdfData();
      return;
    } catch (primaryError) {
      console.error('Primary PDF export failed:', primaryError);
      alert('Download PDF failed. Please try again after refreshing the page.');
      return;
    }
  }

  const invoiceHtml = preview.outerHTML;
  const exportRoot = document.createElement('div');
  exportRoot.id = 'pdfRenderRoot';
  exportRoot.style.position = 'absolute';
  exportRoot.style.top = '0';
  exportRoot.style.left = '-100000px';
  exportRoot.style.width = '194mm';
  exportRoot.style.boxSizing = 'border-box';
  exportRoot.style.background = '#fff';
  exportRoot.style.padding = '0';
  exportRoot.innerHTML = getInvoiceCopiesMarkup(invoiceHtml);

  document.body.appendChild(exportRoot);
  document.body.classList.add('pdf-export-mode');

  try {
    await waitForInvoiceImages(exportRoot);
    await inlineImages(exportRoot);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const canvas = await html2canvas(exportRoot, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      logging: false,
      width: exportRoot.scrollWidth,
      height: exportRoot.scrollHeight,
      windowWidth: exportRoot.scrollWidth,
      windowHeight: exportRoot.scrollHeight,
      scrollX: 0,
      scrollY: 0
    });

    if (!canvas.width || !canvas.height || canvasLooksBlank(canvas)) {
      throw new Error('Rendered invoice canvas was blank');
    }

    const imgData = canvas.toDataURL('image/jpeg', 0.98);
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 8;
    const contentW = pageW - margin * 2;
    const imgH = (canvas.height * contentW) / canvas.width;
    const pageUsableH = pageH - margin * 2;

    let heightLeft = imgH;
    let y = margin;
    doc.addImage(imgData, 'JPEG', margin, y, contentW, imgH);
    heightLeft -= pageUsableH;

    while (heightLeft > 0) {
      y = heightLeft - imgH + margin;
      doc.addPage();
      doc.addImage(imgData, 'JPEG', margin, y, contentW, imgH);
      heightLeft -= pageUsableH;
    }

    doc.save(`${invoice.invoiceNumber}.pdf`);
  } catch (error) {
    console.error('PDF export failed:', error);
    try {
      await exportBasicPdfData();
    } catch (basicError) {
      console.error('Basic PDF export failed:', basicError);
      alert('Download PDF failed. Please try again after refreshing the page.');
    }
  } finally {
    document.body.classList.remove('pdf-export-mode');
    if (exportRoot.parentNode) exportRoot.parentNode.removeChild(exportRoot);
  }
}

function canvasLooksBlank(sourceCanvas) {
  const probe = document.createElement('canvas');
  probe.width = 64;
  probe.height = 64;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  if (!probeCtx) return false;

  probeCtx.fillStyle = '#ffffff';
  probeCtx.fillRect(0, 0, probe.width, probe.height);
  probeCtx.drawImage(sourceCanvas, 0, 0, probe.width, probe.height);

  const { data } = probeCtx.getImageData(0, 0, probe.width, probe.height);
  let nonBlankPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    if (red < 248 || green < 248 || blue < 248) {
      nonBlankPixels += 1;
      if (nonBlankPixels >= 8) return false;
    }
  }

  return true;
}

// Print invoice
function printInvoice() {
  const preview = document.querySelector('.invoice-preview');
  if (!preview) {
    alert('Invoice preview is not available for printing');
    return;
  }

  // On standalone preview page, the invoice object may be empty after save — check the rendered preview instead
  if (!isStandalonePreviewPage()) {
    if (invoice.isEmpty()) {
      alert('Please add at least one item to the invoice');
      return;
    }
    if (!invoice.customerSelected) {
      alert('Please select a customer');
      return;
    }
  }

  if (currentInvoiceStatus === 'Cancelled') {
    const proceed = window.confirm('This is a CANCELLED invoice. Are you sure you want to print it?\n\nThe printout will be marked as CANCELLED at the top.');
    if (!proceed) return;
  }

  const invoiceHtml = preview.outerHTML;
  const printWindow = window.open('', '_blank', 'width=1000,height=900');
  if (!printWindow) {
    alert('Popup blocked. Please allow popups to print invoice copies.');
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${invoice.invoiceNumber} - Print</title>
      <base href="${window.location.href}">
      <link rel="stylesheet" href="css/styles.css">
      <style>
        body { margin: 0; padding: 0mm; background: #fff; font-family: "Manrope", "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
        .print-copy { margin-bottom: 10mm; page-break-after: always; page-break-inside: auto; }
        .print-copy:last-child { page-break-after: auto; margin-bottom: 0; }
        .copy-label { text-align: right; font-weight: 700; margin-bottom: 4mm; letter-spacing: 0.4px; }
        .item-subtext { color: #4b5563; font-size: 10px; }
        .invoice-header { display: block; margin-bottom: 6px; padding-bottom: 6px; }
        .invoice-title-center { text-align: center; font-weight: 700; font-size: 14px; letter-spacing: 0.4px; margin-bottom: 2px; line-height: 1.05; }
        .invoice-header-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.1fr) minmax(150px, 0.78fr); align-items: flex-start; gap: 9px; }
        .company-brand, .buyer-info-block, .invoice-meta-right { min-width: 0; }
        .company-brand { display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; }
        .company-brand-top { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-top: -2px; width: 100%; text-align: left; }
        .invoice-logo-image { display: block; margin: 0 auto 0 0 !important; width: 95px; align-self: flex-start; }
        .invoice-meta-right { margin-left: 0; margin-right: 2.5mm; width: 100%; min-width: 0; max-width: 190px; justify-self: end; display: block; }
        .invoice-meta-right .invoice-details { width: 100%; max-width: 100%; text-align: right; font-size: 9.5px; line-height: 1.15; overflow-wrap: anywhere; word-break: break-word; }
        .copy-label-inline { text-align: right; font-weight: 700; letter-spacing: 0.4px; margin-bottom: 4px; }
        .buyer-info-block { margin-bottom: 0; text-align: left; }
        .buyer-info-block .section-title { margin-top: 0; text-align: left; }
        .company-info { text-align: left; }
        .company-info p, .buyer-info-block p { margin-bottom: 2px; font-size: 10px; line-height: 1.2; overflow-wrap: anywhere; }
        .invoice-details div, .invoice-details p { margin-bottom: 2px; font-size: 9.5px; line-height: 1.15; overflow-wrap: anywhere; word-break: break-word; }
        .buyer-info-block .section-title { font-size: 0.85rem; margin-bottom: 4px; }
        .buyer-address-line {
          display: block;
          white-space: normal;
          overflow: visible;
          text-overflow: unset;
          overflow-wrap: anywhere;
          word-break: break-word;
          line-height: 1.2;
        }
        .invoice-table { width: 100%; table-layout: auto; border-collapse: collapse; }
        .invoice-table thead th { text-align: center !important; white-space: nowrap; }
        .invoice-table th:nth-child(1), .invoice-table td:nth-child(1) { width: 6% !important; text-align: center !important; }
        .invoice-table th:nth-child(2), .invoice-table td:nth-child(2) { width: 36% !important; text-align: left !important; overflow-wrap: anywhere; }
        .invoice-table th:nth-child(3), .invoice-table td:nth-child(3) { width: 12% !important; text-align: center !important; white-space: nowrap; }
        .invoice-table th:nth-child(4),
        .invoice-table th:nth-child(5),
        .invoice-table th:nth-child(6),
        .invoice-table th:nth-child(7) {
          width: 11.5% !important;
          text-align: center !important;
          white-space: nowrap;
        }
        .invoice-table td:nth-child(4),
        .invoice-table td:nth-child(5),
        .invoice-table td:nth-child(6),
        .invoice-table td:nth-child(7) {
          width: 11.5% !important;
          text-align: center !important;
          white-space: nowrap;
        }
        .totals-section { margin-left: auto; width: auto; min-width: 0; font-size: 10.5px; line-height: 1.2; }
        .invoice-preview .totals-row,
        .invoice-preview .grand-total-row,
        .invoice-preview .totals-inline-cell,
        .invoice-preview .total-label,
        .invoice-preview .total-amount {
          font-family: "Source Serif 4", Georgia, "Times New Roman", serif;
          font-size: 10.5px;
          line-height: 1.2;
          letter-spacing: 0;
        }
        .invoice-preview .grand-total-row,
        .invoice-preview .grand-total-row .totals-inline-cell,
        .invoice-preview .grand-total-row .total-label,
        .invoice-preview .grand-total-row .total-amount {
          font-family: "Source Serif 4", Georgia, "Times New Roman", serif;
          font-size: 10.5px;
          line-height: 1.2;
          letter-spacing: 0;
        }
        .totals-row, .grand-total-row { display: table-row; }
        .totals-inline-cell { text-align: right; white-space: nowrap; }
        .total-label { text-align: right; }
        .total-amount { text-align: right; }
        .grand-total-words { margin-top: 8px; font-size: 10px; }
        .invoice-bottom-row { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 16px; align-items: start; margin-top: 10px; }
        .invoice-terms { text-align: left; font-size: 10px; }
        .invoice-terms p { margin: 0 0 4px; white-space: nowrap; }
        .totals-signature { width: 220px; justify-self: end; display: flex; flex-direction: column; align-items: flex-end; text-align: right; }
        .totals-signature .invoice-stamp { width: 95px; margin: 2px 0; align-self: flex-end; }
        .signature-company { width: 100%; text-align: right; margin: 0; }
        @media print {
          body { visibility: visible !important; }
          .invoice-preview { position: static !important; visibility: visible !important; width: 100% !important; box-sizing: border-box !important; padding-right: 3mm !important; page-break-inside: auto !important; }
        }
      </style>
    </head>
    <body>
      ${getInvoiceCopiesMarkup(invoiceHtml)}
    </body>
    </html>
  `);

  printWindow.document.close();
  printWindow.focus();
  printWindow.onload = () => {
    try {
      fitBuyerAddressLineElements(printWindow.document, printWindow);
    } catch (error) {
      console.warn('Could not auto-fit buyer address for print.', error);
    }
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 120);
  };
}

// Clear form
function clearForm() {
  resetInvoiceEditor();
}
function exportAllInvoicesToExcel() {
  const range = getDashboardDateRange();
  const invoices = getSafeInvoices().filter((inv) =>
    inv.status !== 'Cancelled' && isDateWithinRange(inv.invoiceDate, range)
  );

  if (invoices.length === 0) {
    const rangeDesc = (range.from || range.to) ? ` for the selected range` : '';
    alert(`No invoices found${rangeDesc}.`);
    return;
  }

  if (typeof XLSX === 'undefined') {
    alert("Excel export library is not loaded. Please refresh and try again.");
    return;
  }

  try {
    const headers = [
      "INV No", "Date", "Customer Name", "Customer GSTIN", "Customer State", "No of Products",
      "Subtotal", "CGST", "SGST", "IGST", "Round Off Applied",
      "Round Off Amount", "Tax Type", "Grand Total",
      "Invoice Number Ref", "PO Date", "Shipping Address"
    ];

    const numericCols = new Set([6, 7, 8, 9, 11, 13]); // shifted +1 for new GSTIN column

    const rows = invoices.map((inv) => {
      const subtotal = safeNumber(inv.subtotal);
      const cgst = safeNumber(inv.cgst);
      const sgst = safeNumber(inv.sgst);
      const igst = safeNumber(inv.igst);
      const roundOffAmount = safeNumber(inv.roundOffAmount);
      const taxType = inv.taxType || (igst > 0 ? 'IGST' : 'CGST_SGST');
      return [
        inv.invoiceNumber || "-",
        inv.invoiceDate || "-",
        inv.customer?.name || "Unknown Customer",
        inv.customer?.gstin || "-",
        inv.customer?.state || DEFAULT_LOCAL_STATE,
        Array.isArray(inv.items) ? inv.items.length : 0,
        subtotal, cgst, sgst, igst,
        inv.roundOffEnabled ? "Yes" : "No",
        roundOffAmount, taxType,
        safeNumber(inv.grandTotal),
        inv.poNumber || inv.dueDate || "-",
        inv.poDate || inv.invoiceDate || "-",
        inv.shippingAddress || "-"
      ];
    });

    // Build totals row
    const totalRow = headers.map((_, i) => {
      if (i === 0) return 'TOTAL';
      if (numericCols.has(i)) return rows.reduce((sum, r) => sum + safeNumber(r[i]), 0);
      return '';
    });

    // Styles
    const headerStyle = 'background:#1e40af;color:#ffffff;font-weight:bold;border:1px solid #1e3a8a;padding:6px 10px;white-space:nowrap;';
    const totalStyle  = 'background:#166534;color:#ffffff;font-weight:bold;border:1px solid #14532d;padding:6px 10px;';
    const cellStyle   = 'border:1px solid #d1d5db;padding:5px 10px;';
    const numStyle    = 'border:1px solid #d1d5db;padding:5px 10px;text-align:right;';
    const altStyle    = 'background:#f0f9ff;border:1px solid #d1d5db;padding:5px 10px;';
    const altNumStyle = 'background:#f0f9ff;border:1px solid #d1d5db;padding:5px 10px;text-align:right;';

    const headerCells = headers.map((h) => `<th style="${headerStyle}">${h}</th>`).join('');

    const dataCells = rows.map((row, ri) => {
      const isAlt = ri % 2 === 1;
      const cells = row.map((val, ci) => {
        const isNum = numericCols.has(ci);
        const style = isNum ? (isAlt ? altNumStyle : numStyle) : (isAlt ? altStyle : cellStyle);
        const display = isNum && typeof val === 'number' ? val.toFixed(2) : val;
        return `<td style="${style}">${display}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    const totalCells = totalRow.map((val, ci) => {
      const display = numericCols.has(ci) && typeof val === 'number' ? val.toFixed(2) : val;
      return `<td style="${totalStyle}">${display}</td>`;
    }).join('');

    const html = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:x="urn:schemas-microsoft-com:office:excel"
            xmlns="http://www.w3.org/TR/REC-html40">
      <head><meta charset="UTF-8">
        <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>
          <x:ExcelWorksheet><x:Name>Invoice Summary</x:Name>
          <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
          </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
      </head>
      <body>
        <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:12px;">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${dataCells}</tbody>
          <tfoot><tr>${totalCells}</tr></tfoot>
        </table>
      </body></html>`;

    const rangeTag = (range.from || range.to) ? `_${range.from || 'start'}_to_${range.to || 'today'}` : '';
    const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Invoices${rangeTag}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Export failed:", error);
    alert("Export failed. Please check saved invoice data and try again.");
  }
}

function exportPlacedOrdersToExcel() {
  const range = getDashboardDateRange();
  const orders = getSafeOrganizationPurchaseOrders().filter((o) =>
    isDateWithinRange(ensureOrganizationPurchaseOrder(o).poDate, range)
  );

  if (orders.length === 0) {
    const rangeDesc = (range.from || range.to) ? ` for the selected range` : '';
    alert(`No placed orders found${rangeDesc}.`);
    return;
  }

  if (typeof XLSX === 'undefined') {
    alert("Excel export library is not loaded. Please refresh and try again.");
    return;
  }

  try {
    const headers = [
      "Vendor Name", "Vendor GSTIN", "Invoice Number", "Order Date", "Status", "Notes",
      "Item Name", "Description", "HSN/SAC", "Quantity", "Rate", "Tax %", "Taxable Amt", "Tax Amt", "Item Grand Total", "Order Subtotal", "Order CGST", "Order SGST", "Order IGST", "Order Grand Total", "Tax Type"
    ];

    const numericCols = new Set([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    // Columns to sum in the totals row (order-level totals only, not per-item)
    const totalCols = new Set([12, 13, 14, 15, 16, 17, 18, 19]);

    const rows = [];
    orders.forEach((order) => {
      const safeOrder = ensureOrganizationPurchaseOrder(order);
      const vendor = vendorsData.find((v) => ensureVendorState(v).name === safeOrder.vendorName);
      const vendorGstin = vendor ? ensureVendorState(vendor).gstin || '-' : '-';
      if (safeOrder.items.length > 0) {
        safeOrder.items.forEach((item, idx) => {
          const safeItem = ensureOrderLineItem(item);
          const taxAmt = safeItem.total * (safeItem.taxRate / 100);
          rows.push([
            safeOrder.vendorName || '-',
            idx === 0 ? vendorGstin : '',
            safeOrder.poNumber || '-',
            safeOrder.poDate || '-',
            safeOrder.status || '-',
            idx === 0 ? (safeOrder.notes || '-') : '',
            safeItem.name || '-',
            safeItem.description || '-',
            safeItem.hsnSac || '-',
            safeItem.quantity,
            safeItem.rate,
            safeItem.taxRate,
            safeItem.total,
            taxAmt,
            safeItem.total + taxAmt,
            idx === 0 ? safeOrder.subtotal : '',
            idx === 0 ? safeOrder.cgst : '',
            idx === 0 ? safeOrder.sgst : '',
            idx === 0 ? safeOrder.igst : '',
            idx === 0 ? safeOrder.amount : '',
            idx === 0 ? safeOrder.taxType : ''
          ]);
        });
      } else {
        rows.push([
          safeOrder.vendorName || '-', vendorGstin,
          safeOrder.poNumber || '-', safeOrder.poDate || '-',
          safeOrder.status || '-', safeOrder.notes || '-',
          '-', '-', '-', '-', '-', '-', '-', '-', '-',
          safeOrder.subtotal, safeOrder.cgst, safeOrder.sgst, safeOrder.igst, safeOrder.amount, safeOrder.taxType
        ]);
      }
    });

    // Build totals row — sum only order-level numeric columns, skip per-item rows
    const totalRow = headers.map((_, i) => {
      if (i === 0) return 'TOTAL';
      if (!totalCols.has(i)) return '';
      // Sum only first-item rows (where order-level values appear)
      return rows.reduce((sum, r) => sum + (typeof r[i] === 'number' ? r[i] : 0), 0);
    });

    const headerStyle = 'background:#1e40af;color:#ffffff;font-weight:bold;border:1px solid #1e3a8a;padding:6px 10px;white-space:nowrap;';
    const totalStyle  = 'background:#166534;color:#ffffff;font-weight:bold;border:1px solid #14532d;padding:6px 10px;';
    const cellStyle   = 'border:1px solid #d1d5db;padding:5px 10px;';
    const numStyle    = 'border:1px solid #d1d5db;padding:5px 10px;text-align:right;';
    const altStyle    = 'background:#f0f9ff;border:1px solid #d1d5db;padding:5px 10px;';
    const altNumStyle = 'background:#f0f9ff;border:1px solid #d1d5db;padding:5px 10px;text-align:right;';

    const headerCells = headers.map((h) => `<th style="${headerStyle}">${h}</th>`).join('');
    const dataCells = rows.map((row, ri) => {
      const isAlt = ri % 2 === 1;
      const cells = row.map((val, ci) => {
        const isNum = numericCols.has(ci) && typeof val === 'number';
        const style = isNum ? (isAlt ? altNumStyle : numStyle) : (isAlt ? altStyle : cellStyle);
        const display = isNum ? val.toFixed(2) : (val === '' ? '' : val);
        return `<td style="${style}">${display}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    const totalCells = totalRow.map((val, ci) => {
      const display = totalCols.has(ci) && typeof val === 'number' ? val.toFixed(2) : val;
      return `<td style="${totalStyle}">${display}</td>`;
    }).join('');

    const html = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:x="urn:schemas-microsoft-com:office:excel"
            xmlns="http://www.w3.org/TR/REC-html40">
      <head><meta charset="UTF-8">
        <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>
          <x:ExcelWorksheet><x:Name>Purchases</x:Name>
          <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
          </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
      </head>
      <body>
        <table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:12px;">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${dataCells}</tbody>
          <tfoot><tr>${totalCells}</tr></tfoot>
        </table>
      </body></html>`;

    const rangeTag = (range.from || range.to) ? `_${range.from || 'start'}_to_${range.to || 'today'}` : '';
    const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Purchases${rangeTag}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Placed order export failed:", error);
    alert("Placed order export failed. Please try again.");
  }
}


function showInvoiceHistory() {
  showWorkspaceView('invoice');

  const section = document.getElementById('invoiceHistorySection');
  const container = document.getElementById('invoiceHistoryList');
  section.style.display = 'block';

  const allInvoices = getSafeInvoices();
  if (allInvoices.length === 0) {
    container.innerHTML = '<p>No invoices saved yet.</p>';
    return;
  }

  // Build FY options from invoice dates only
  const fyLabels = Array.from(new Set(
    allInvoices.map((inv) => getFinancialYearLabel(inv.invoiceDate)).filter(Boolean)
  )).sort((a, b) => b.localeCompare(a));

  const currentFy = getFinancialYearLabel(new Date().toISOString().split('T')[0]);
  const selectedFy = container.dataset.selectedFy ||
    (fyLabels.includes(currentFy) ? currentFy : (fyLabels[0] || ''));

  // Filter invoices by selected FY
  const invoices = allInvoices.filter((inv) => getFinancialYearLabel(inv.invoiceDate) === selectedFy);

  const indexMap = [];
  allInvoices.forEach((inv, i) => {
    if (getFinancialYearLabel(inv.invoiceDate) === selectedFy) indexMap.push(i);
  });

  const fyOptions = fyLabels.map((fy) => `<option value="${fy}"${fy === selectedFy ? ' selected' : ''}>FY ${fy}</option>`).join('');

  let options = '';
  // Reverse to show latest first
  [...invoices].reverse().forEach((inv, i) => {
    const originalIndex = indexMap[indexMap.length - 1 - i];
    const statusLabel = inv.status === 'Cancelled' ? ' | Cancelled' : '';
    options += `<option value="${originalIndex}">${inv.invoiceNumber || 'Invoice'} | ${inv.invoiceDate || '-'} | ${inv.customer?.name || 'Unknown'} | ${formatMoney(inv.grandTotal)}${statusLabel}</option>`;
  });

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
      <label style="font-weight:700;font-size:0.9rem;">Financial Year:</label>
      <select id="invoiceHistoryFySelect" style="min-width:140px;" onchange="handleInvoiceHistoryFyChange(this.value)">${fyOptions}</select>
      <span style="font-size:0.85rem;color:#64748b;">${invoices.length} invoice(s)</span>
    </div>
    <div class="setup-dropdown-wrap">
      <select id="savedInvoicesDropdown" class="setup-dropdown">${options || '<option value="">No invoices for this FY</option>'}</select>
      <div class="setup-dropdown-actions">
        <button type="button" class="btn btn-success history-view-btn" onclick="loadSelectedSavedInvoice()">Load Selected Invoice</button>
        <button type="button" class="btn btn-primary history-view-btn" onclick="previewSelectedSavedInvoice()">Preview Selected Invoice</button>
        <button type="button" class="btn btn-warning history-view-btn" onclick="cancelSelectedSavedInvoice()">Cancel Selected Invoice</button>
        <button type="button" class="btn btn-danger history-view-btn" onclick="deleteSelectedSavedInvoice()">Delete Selected Invoice</button>
      </div>
    </div>
  `;
}

function handleInvoiceHistoryFyChange(fy) {
  const container = document.getElementById('invoiceHistoryList');
  if (container) container.dataset.selectedFy = fy;
  showInvoiceHistory();
}

window.handleInvoiceHistoryFyChange = handleInvoiceHistoryFyChange;

function loadSelectedSavedInvoice() {
  const select = document.getElementById('savedInvoicesDropdown');
  if (!select || select.value === '') return;
  loadInvoice(parseInt(select.value, 10));
}

function previewSelectedSavedInvoice() {
  const select = document.getElementById('savedInvoicesDropdown');
  if (!select || select.value === '') return;

  const selectedIndex = parseInt(select.value, 10);
  openSavedInvoicePreview(selectedIndex);
}

function openSavedInvoicePreview(selectedIndex) {
  const invoices = getSafeInvoices();
  const savedInvoice = invoices[selectedIndex];
  if (!savedInvoice) {
    alert("Invoice not found.");
    return;
  }

  localStorage.setItem(STORAGE_KEYS.currentInvoiceDraft, JSON.stringify({
    invoice: savedInvoice,
    editingInvoiceIndex: null,
    readOnly: true,
    invoiceStatus: savedInvoice.status || 'Active'
  }));
  window.location.href = "invoice-preview.html";
}

function deleteSelectedSavedInvoice() {
  const select = document.getElementById('savedInvoicesDropdown');
  if (!select || select.value === '') return;

  const selectedIndex = parseInt(select.value, 10);
  const invoices = getSafeInvoices();
  const savedInvoice = invoices[selectedIndex];

  if (!savedInvoice) {
    alert("Invoice not found.");
    return;
  }

  const invoiceNumber = savedInvoice.invoiceNumber || "this invoice";
  const shouldDelete = window.confirm(`Delete ${invoiceNumber}? This cannot be undone.`);
  if (!shouldDelete) {
    return;
  }

  invoices.splice(selectedIndex, 1);
  localStorage.setItem(STORAGE_KEYS.invoices, JSON.stringify(invoices));

  if (savedInvoice.customerPurchaseOrderId) {
    unlinkCustomerPurchaseOrderFromInvoice(savedInvoice.customerPurchaseOrderId, savedInvoice.invoiceNumber || '');
  }

  if (editingInvoiceIndex === selectedIndex) {
    resetInvoiceEditor();
    persistCurrentInvoiceDraft();
  } else if (Number.isInteger(editingInvoiceIndex) && editingInvoiceIndex > selectedIndex) {
    editingInvoiceIndex -= 1;
    persistCurrentInvoiceDraft();
  }

  renderDashboardSummary();
  showInvoiceHistory();
  alert("Invoice deleted successfully.");
}

async function cancelSelectedSavedInvoice() {
  const select = document.getElementById('savedInvoicesDropdown');
  if (!select || select.value === '') return;

  const selectedIndex = parseInt(select.value, 10);
  const invoices = getSafeInvoices();
  const savedInvoice = invoices[selectedIndex];

  if (!savedInvoice) {
    alert("Invoice not found.");
    return;
  }

  if (savedInvoice.status === 'Cancelled') {
    alert("This invoice is already cancelled.");
    return;
  }

  const invoiceNumber = savedInvoice.invoiceNumber || "this invoice";
  const shouldCancel = window.confirm(`Cancel ${invoiceNumber}? The number will stay reserved and the invoice will no longer count in active totals.`);
  if (!shouldCancel) {
    return;
  }

  invoices[selectedIndex] = {
    ...savedInvoice,
    status: 'Cancelled',
    cancelledAt: new Date().toISOString()
  };
  localStorage.setItem(STORAGE_KEYS.invoices, JSON.stringify(invoices));

  try {
    const synced = await persistAppStorageToDisk();
    if (window.ShakerFileStorage?.isFileBacked?.() === true && !synced) {
      throw new Error("Disk-backed storage is active, but the cancellation was not written to disk.");
    }
  } catch (persistError) {
    console.error("Invoice cancel disk sync failed:", persistError);
    alert(`Invoice cancel did not reach disk.\n\n${persistError.message || 'Unknown disk sync error.'}`);
    return;
  }

  if (savedInvoice.customerPurchaseOrderId) {
    unlinkCustomerPurchaseOrderFromInvoice(savedInvoice.customerPurchaseOrderId, savedInvoice.invoiceNumber || '');
  }

  if (editingInvoiceIndex === selectedIndex) {
    resetInvoiceEditor();
    persistCurrentInvoiceDraft();
  }

  renderDashboardSummary();
  showInvoiceHistory();
  alert("Invoice cancelled successfully.");
}

function loadInvoice(index) {

  const invoices = getSafeInvoices();
  const savedInvoice = invoices[index];

  if (!savedInvoice) {
    alert("Invoice not found.");
    return;
  }

  if (savedInvoice.status === 'Cancelled') {
    alert("This is a cancelled invoice and cannot be edited. Use 'Preview Selected Invoice' to view it.");
    return;
  }

  if (!canEditInvoiceRecord(savedInvoice)) {
    const d = savedInvoice.invoiceDate || '';
    alert(`Invoice ${savedInvoice.invoiceNumber || ''} (${d}) is locked and cannot be edited.\n\nInvoices are locked from the 10th of the following month.\n\nUse 'Preview Selected Invoice' to view it.`);
    return;
  }

  editingInvoiceIndex = index;
  applyInvoiceRecordToState(savedInvoice);
  syncInvoiceFormWithState();

  renderItemsTable();
  updateInvoicePreview();

  setInvoiceSaveButtonLabel();
  document.getElementById('invoiceHistorySection').style.display = "none";
  showWorkspaceView('invoice');
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  if (!ensureAuthenticated()) return;
  window.addEventListener('beforeprint', () => {
    fitBuyerAddressLineElements(document, window);
  });
  window.addEventListener('shaker-storage-status-changed', () => {
    updateStorageStatusBadge();
  });
  window.addEventListener('focus', () => {
    scheduleStorageRefresh();
    updateStorageStatusBadge();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      scheduleStorageRefresh();
      updateStorageStatusBadge();
    }
  });
  document.addEventListener('click', (event) => {
    const autocompleteRoot = event.target.closest('.item-name-autocomplete');
    if (!autocompleteRoot) {
      hideItemNameSuggestions();
    }
  });
  try {
    if (isStandalonePreviewPage()) {
      initializeStandalonePreviewPage();
      return;
    }
    initializeApp();
    window.setTimeout(updateStorageStatusBadge, 1500);
    window.setTimeout(updateStorageStatusBadge, 3500);
  } catch (error) {
    console.error('App initialization failed:', error);
    const previewPage = isStandalonePreviewPage();
    const setup = document.getElementById('setupSection');
    const main = document.getElementById('mainSection');
    if (setup) setup.style.display = 'block';
    if (main) main.style.display = 'none';
    alert(previewPage
      ? 'Something went wrong while loading the invoice preview.'
      : 'Something went wrong while loading the app. Error: ' + (error && error.message ? error.message : String(error)));
  }
});
