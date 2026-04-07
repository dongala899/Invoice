class Invoice {
  constructor() {
    this.items = [];
    this.invoiceNumber = '';
    this.invoiceDate = new Date().toISOString().split('T')[0];
    this.customerSelected = null;
    this.companyInfo = null;
    this.poNumber = '';
    this.poDate = '';
    this.shippingAddress = '';
    this.customerPurchaseOrderId = '';
    this.roundOffEnabled = false;
  }

  static normalizeInvoiceNumber(number) {
    return String(number || '').trim().replace(/^INV-\s*/i, '');
  }

  static normalizeStateName(state) {
    return String(state || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  static isTelanganaState(state) {
    const normalized = Invoice.normalizeStateName(state);
    return normalized === 'telangana' || normalized === 'telangana state' || normalized === 'tg';
  }

  setPONumber(poNumber) {
    this.poNumber = poNumber;
  }

  setPODate(date) {
    this.poDate = date;
  }

  setShippingAddress(address) {
    this.shippingAddress = String(address || '').trim();
  }

  setCustomerPurchaseOrderId(customerPurchaseOrderId) {
    this.customerPurchaseOrderId = String(customerPurchaseOrderId || '').trim();
  }

  setRoundOffEnabled(enabled) {
    this.roundOffEnabled = enabled === true || String(enabled || '').trim().toLowerCase() === 'yes';
  }

  isRoundOffEnabled() {
    return this.roundOffEnabled === true;
  }

  setDueDate(date) {
    // Backward compatibility with older code paths.
    this.poNumber = date;
  }

  setCompanyInfo(company) {
    this.companyInfo = company;
  }

  setCustomer(customer) {
    if (!customer) {
      this.customerSelected = null;
      return;
    }

    this.customerSelected = {
      ...customer,
      state: String(customer.state || '').trim()
    };
  }

  addItem(item, quantity, rate) {
    const parsedQty = parseFloat(quantity);
    const parsedRate = parseFloat(rate);
    const hsnSac = item.hsnSac || item.hsn || item.sac || '-';

    const existingItem = this.items.find((i) => i.id === item.id && (i.hsnSac || '-') === hsnSac);

    if (existingItem) {
      existingItem.quantity += parsedQty;
      existingItem.total = existingItem.quantity * existingItem.rate;
      return { lineItem: existingItem, merged: true };
    }

    const lineItem = {
      id: item.id,
      name: item.name,
      description: item.description,
      hsnSac,
      quantity: parsedQty,
      rate: parsedRate,
      total: parsedQty * parsedRate
    };

    this.items.push(lineItem);
    return { lineItem, merged: false };
  }

  removeItem(index) {
    if (index >= 0 && index < this.items.length) {
      this.items.splice(index, 1);
    }
  }

  getSubtotal() {
    return this.items.reduce((sum, item) => sum + item.total, 0);
  }

  getCustomerState() {
    return String(this.customerSelected?.state || '').trim();
  }

  isIntraStateSale() {
    const state = this.getCustomerState();
    if (!state) return true;
    return Invoice.isTelanganaState(state);
  }

  isInterStateSale() {
    return !this.isIntraStateSale();
  }

  getCGST() {
    return this.isIntraStateSale() ? this.getSubtotal() * 0.09 : 0;
  }

  getSGST() {
    return this.isIntraStateSale() ? this.getSubtotal() * 0.09 : 0;
  }

  getIGST() {
    return this.isInterStateSale() ? this.getSubtotal() * 0.18 : 0;
  }

  getTotalTax() {
    return this.getCGST() + this.getSGST() + this.getIGST();
  }

  getPreRoundGrandTotal() {
    return this.getSubtotal() + this.getTotalTax();
  }

  getRoundOffAmount() {
    if (!this.isRoundOffEnabled()) return 0;
    return Math.round(this.getPreRoundGrandTotal()) - this.getPreRoundGrandTotal();
  }

  getGrandTotal() {
    return this.getPreRoundGrandTotal() + this.getRoundOffAmount();
  }

  formatCurrency(amount) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  formatDate(dateString) {
    if (!dateString) return '-';

    const parts = dateString.split('-');
    if (parts.length !== 3) return '-';

    const year = parts[0];
    const month = parts[1];
    const day = parts[2];
    return `${day}/${month}/${year}`;
  }

  setInvoiceNumber(number) {
    this.invoiceNumber = Invoice.normalizeInvoiceNumber(number);
  }

  setInvoiceDate(date) {
    this.invoiceDate = date;
  }

  clearItems() {
    this.items = [];
  }

  isEmpty() {
    return this.items.length === 0;
  }

  toJSON() {
    return {
      invoiceNumber: this.invoiceNumber,
      invoiceDate: this.invoiceDate,
      company: this.companyInfo,
      customer: this.customerSelected,
      items: this.items,
      subtotal: this.getSubtotal(),
      cgst: this.getCGST(),
      sgst: this.getSGST(),
      igst: this.getIGST(),
      totalTax: this.getTotalTax(),
      grandTotal: this.getGrandTotal(),
      createdAt: new Date().toISOString(),
      poNumber: this.poNumber,
      poDate: this.poDate,
      shippingAddress: this.shippingAddress,
      customerPurchaseOrderId: this.customerPurchaseOrderId,
      roundOffEnabled: this.isRoundOffEnabled(),
      roundOffAmount: this.getRoundOffAmount(),
      taxType: this.isInterStateSale() ? 'IGST' : 'CGST_SGST'
    };
  }
}
