class InvoiceStorage {
  constructor() {
    this.storageKey = 'invoices';
    this.counterKey = 'invoiceCounter';
  }

  getNextInvoiceNumber() {
    let counter = localStorage.getItem(this.counterKey);
    counter = counter ? parseInt(counter) + 1 : 1;
    localStorage.setItem(this.counterKey, counter);
    return `INV-${String(counter).padStart(4, '0')}`;
  }

  saveInvoice(invoiceObject) {
    let invoices = this.getAllInvoices();
    invoices.push(invoiceObject);
    localStorage.setItem(this.storageKey, JSON.stringify(invoices));
    return invoiceObject;
  }

  getAllInvoices() {
    const data = localStorage.getItem(this.storageKey);
    return data ? JSON.parse(data) : [];
  }

  getInvoiceByNumber(invoiceNumber) {
    const invoices = this.getAllInvoices();
    return invoices.find(inv => inv.invoiceNumber === invoiceNumber);
  }

  deleteInvoice(invoiceNumber) {
    let invoices = this.getAllInvoices();
    invoices = invoices.filter(inv => inv.invoiceNumber !== invoiceNumber);
    localStorage.setItem(this.storageKey, JSON.stringify(invoices));
  }

  exportToPDF(invoice, jsPDF) {
    const { jsPDF: JsPDF } = window;
    const doc = new JsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    let yPosition = 15;

    // Company Header
    doc.setFontSize(18);
    doc.setFont(undefined, 'bold');
    doc.text(invoice.company.name, 15, yPosition);
    yPosition += 8;

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.text(`Address: ${invoice.company.address}`, 15, yPosition);
    yPosition += 5;
    doc.text(`Phone: ${invoice.company.phone} | Email: ${invoice.company.email}`, 15, yPosition);
    yPosition += 5;
    doc.text(`GSTIN: ${invoice.company.gstin}`, 15, yPosition);
    yPosition += 8;

    // Invoice Details
    doc.setFont(undefined, 'bold');
    doc.text(`Invoice Number: ${invoice.invoiceNumber}`, 15, yPosition);
    doc.text(`Date: ${invoice.invoiceDate}`, pageWidth - 60, yPosition);
    yPosition += 8;

    // Customer Info
    doc.setFont(undefined, 'bold');
    doc.text('Bill To:', 15, yPosition);
    yPosition += 5;
    doc.setFont(undefined, 'normal');
    doc.text(invoice.customer.name, 15, yPosition);
    yPosition += 4;
    doc.text(`Address: ${invoice.customer.address}`, 15, yPosition);
    yPosition += 4;
    doc.text(`Phone: ${invoice.customer.phone}`, 15, yPosition);
    yPosition += 4;
    doc.text(`GSTIN: ${invoice.customer.gstin}`, 15, yPosition);
    yPosition += 8;

    // Items Table
    const headers = ['Item', 'Description', 'Qty', 'Rate', 'Amount'];
    const rows = invoice.items.map(item => [
      item.name,
      item.description,
      item.quantity.toString(),
      `₹${item.rate.toFixed(2)}`,
      `₹${item.total.toFixed(2)}`
    ]);

    doc.autoTable({
      head: [headers],
      body: rows,
      startY: yPosition,
      margin: 15,
      didDrawPage: function(data) {
        yPosition = data.cursor.y;
      }
    });

    yPosition = doc.lastAutoTable.finalY + 10;

    // Totals
    doc.setFont(undefined, 'normal');
    doc.text(`Subtotal: ₹${invoice.subtotal.toFixed(2)}`, pageWidth - 60, yPosition);
    yPosition += 6;

    doc.text(`CGST (9%): ₹${invoice.cgst.toFixed(2)}`, pageWidth - 60, yPosition);
    yPosition += 6;

    doc.text(`SGST (9%): ₹${invoice.sgst.toFixed(2)}`, pageWidth - 60, yPosition);
    yPosition += 8;

    doc.setFont(undefined, 'bold');
    doc.text(`Grand Total: ₹${invoice.grandTotal.toFixed(2)}`, pageWidth - 60, yPosition);

    // Save PDF
    doc.save(`${invoice.invoiceNumber}.pdf`);
  }
}
