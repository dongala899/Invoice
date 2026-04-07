# Invoice Project Guide

## Project Summary

This project is a local invoice management application for creating, previewing, saving, exporting, and tracking invoices, customer purchase orders, vendor purchase orders, and dashboard summaries.

The app now runs through a local server and stores live data on disk in:

- [data/storage.json](C:/my%20projects/Invoice/data/storage.json)

Main goals of the project:

- maintain company, customer, vendor, and item master data
- create GST invoices
- preview and export invoices
- track customer POs and purchase orders
- review sales and purchase trends in the dashboard
- keep data shared across browsers on the same machine

## How To Start

Use:

- [Launch Shaker.cmd](C:/my%20projects/Invoice/Launch%20Shaker.cmd)

This starts the local server and opens the app in the browser.

Preferred URL:

- `http://digidatinfosystems/`

## Data Storage

Live project data is stored in:

- [data/storage.json](C:/my%20projects/Invoice/data/storage.json)

What this means:

- data is not browser-only anymore
- Chrome and Edge can use the same project data
- backup and restore work against the same storage keys

## Main Pages

### Login

Files:

- [index.html](C:/my%20projects/Invoice/index.html)
- [login.html](C:/my%20projects/Invoice/login.html)

Purpose:

- sign in to access the app

### Main Application

File:

- [app.html](C:/my%20projects/Invoice/app.html)

Purpose:

- manage master data
- create invoices
- manage customer POs
- manage purchases
- view dashboard analysis

### Invoice Preview

File:

- [invoice-preview.html](C:/my%20projects/Invoice/invoice-preview.html)

Purpose:

- open invoice preview separately before export or print

### Change Password

File:

- [change-password.html](C:/my%20projects/Invoice/change-password.html)

Purpose:

- change login password

## Top Toolbar Buttons

### `Create Invoice`

Starts invoice creation after setup data exists.

### `Add Company`

Saves company details such as:

- name
- address
- phone
- email
- website
- GSTIN
- bank details

### `+ Add Customer`

Adds a new customer master record.

When editing an existing customer, this button changes to update mode.

### `Cancel Edit`

Shown during edit mode. Cancels the current edit and returns to add mode.

### `+ Add Vendor`

Adds a vendor or supplier record.

### `+ Add Item/Service`

Adds a service or item master record used in invoices and customer POs.

### `Manage Data`

Returns from invoice area to setup/master-data area.

### `Change Password`

Opens the password update page.

### `Backup Data`

Exports app data to a JSON backup file.

### `Restore Data`

Imports data from a backup JSON file.

### `Logout`

Logs out and returns to login page.

## Workspace Tabs

### `Invoice`

Used to create and manage invoices.

### `Customer POs`

Used to save and track customer purchase orders.

### `Purchases`

Used to save and track purchase orders placed with vendors.

### `Dashboard`

Used to view sales, purchase, tax, customer, vendor, and trend analysis.

## Invoice Section Buttons And Functions

### `+ Add Item/Service`

Adds the selected item to the current invoice using:

- selected customer
- selected item
- quantity
- rate

### `Clear Form`

Clears the current invoice editor and resets it for a new invoice.

### `Export All Invoices (Excel)`

Exports all saved invoices into Excel format.

### `Save Invoice`

Saves the current invoice.

If editing an existing invoice within the allowed period, it updates that invoice.

### `Cancel Edit`

Visible when editing an invoice. Cancels edit mode and resets the editor.

### `Open Preview`

Opens the invoice preview page.

### `Saved Invoices`

Shows the saved invoice list with actions.

## Saved Invoice Actions

### `Load Selected Invoice`

Loads an invoice into the editor for editing, but only if:

- it is not cancelled
- it is still within the monthly edit window

### `Cancel Selected Invoice`

Marks an invoice as cancelled.

Effects:

- invoice number remains reserved
- invoice is blocked from editing
- cancelled invoice should not count in active dashboard totals

### `Delete Selected Invoice`

Permanently deletes the selected invoice from storage.

Use carefully because deletion removes the record entirely.

## Customer PO Section

### `+ Add Customer PO`

Saves a customer purchase order.

### `Cancel Edit`

Cancels PO edit mode.

### `+ Add PO Item`

Adds an item line into the PO draft table before saving the PO.

## Purchase Section

### `+ Add Purchase Order`

Saves a purchase/vendor order.

### `Cancel Edit`

Cancels purchase edit mode.

### `Export to Excel`

Exports placed purchase orders to Excel.

## Dashboard Features

The dashboard currently includes:

- financial year filter
- from/to date range
- sales summary
- customer PO summary
- purchases summary
- net position
- average invoice value
- open commitments
- top customers
- top vendors
- top items/services
- monthly sales vs purchases trend
- FY comparison
- tax summary
- tax summary by month

### Dashboard Filters

#### `Financial Year`

Shows only years available from actual data.

Selecting a financial year automatically fills:

- from date
- to date

#### `From Date`

Filters dashboard data from the selected date onward.

#### `To Date`

Filters dashboard data up to the selected date.

#### `Clear Range`

Clears the current dashboard date filters.

## Important Rules In Current Project

### Invoice Edit Window

Invoice editing follows a monthly business cutoff:

- invoices dated 1–9 of any month are editable until the 9th of that same month, locked from the 10th
- invoices dated 10–31 of any month are editable until the 9th of the following month, locked from the 10th of the following month

Example:

- April 1–9 invoices → editable until April 9, locked from April 10
- April 10–30 invoices → editable until May 9, locked from May 10

### Cancelled Invoices

Cancelled invoices:

- remain in records
- cannot be edited
- keep their invoice number reserved

### Shared Storage

The app uses disk-backed storage, so data should be shared across supported browsers on the same machine when the app is opened through the local server.

## Important Files

- [app.html](C:/my%20projects/Invoice/app.html): main application UI
- [js/app.js](C:/my%20projects/Invoice/js/app.js): main application logic
- [css/styles.css](C:/my%20projects/Invoice/css/styles.css): application styles
- [js/file-storage-bridge.js](C:/my%20projects/Invoice/js/file-storage-bridge.js): browser-to-disk sync bridge
- [js/server-session.js](C:/my%20projects/Invoice/js/server-session.js): managed localhost session handling
- [scripts/start-localhost.ps1](C:/my%20projects/Invoice/scripts/start-localhost.ps1): local server
- [Launch Shaker.cmd](C:/my%20projects/Invoice/Launch%20Shaker.cmd): launcher
- [data/storage.json](C:/my%20projects/Invoice/data/storage.json): live stored data

## Typical Workflow

1. Launch the app using [Launch Shaker.cmd](C:/my%20projects/Invoice/Launch%20Shaker.cmd)
2. Log in
3. Maintain company, customers, vendors, and items
4. Create invoice
5. Preview invoice
6. Save invoice
7. Export invoice or reports when needed
8. Review dashboard for analysis
9. Backup data regularly

## Notes

- Open the app through the local launcher, not `file:///`
- Use backup before major changes
- Use cancel for rejected invoices when needed
- Use delete only when you truly want to remove the invoice record

---

## Release Notes

### April 1, 2026 — v1.2.0

#### Bug Fixes
- Totals and grand total rows converted from CSS grid to table-native layout — removed `display:grid`, `gap`, and `justify-self` overrides that conflicted with `<table>` rendering; added `white-space:nowrap` on label/amount cells and `print-color-adjust:exact` on the grand total row to preserve background colour in print/PDF
- Invoice totals table cell padding reduced on the right side of label and amount columns (`4px 2px 4px 10px` / `4px 10px 4px 2px`) to prevent amount text from being clipped on narrow values
- Print invoice on standalone preview page no longer requires a valid in-memory invoice object — validation is skipped when on the preview page, so locked/cancelled invoices can be printed directly from `invoice-preview.html`
- Invoice edit window logic corrected for early-month invoices — invoices dated 1–9 now lock on the 10th of the same month (previously locked on the 10th of the following month)
- Totals block label/amount columns now use `auto` width instead of fixed `140px`, with tighter gap (6px) and padding (4px 10px) to prevent overflow on narrow amounts
- Totals section width changed from fixed `max-width: 280px` to `fit-content` with `min-width: 200px`, and column gap increased to 16px for better label/amount spacing

#### Features
- Invoice/quotation totals block styled as a bordered card with row separators, padding, and a highlighted grand total row (double border, slate background)

#### Bug Fixes
- Quotation form line item entry reverted to a single "Description" field — the separate "Item / Service Name" + editable "Description" two-field layout introduced earlier today has been removed
- Quotation grand total display now shows rounded amount with round-off annotation (e.g. "Round off: +0.50") when the raw total differs from the rounded value by ≥ 0.01

#### Features
- Quotation form line item entry now has a separate "Item / Service Name" field (datalist-backed) and an editable "Description" field, allowing the item name and its full description to be set independently

#### Bug Fixes
- `app.js` restored with full quotation integration — `showWorkspaceView` now handles the `quotation` case, `showMainSection` calls `window.initQuotationWorkspace()` on load, and backup/restore payload includes the `quotations` key; convert-to-invoice and quotation workspace switching now work correctly
- Truncated error message in `DOMContentLoaded` error handler restored — alert now shows the full message for both invoice preview and app load failure cases
- Form data no longer vanishes after validation failure — background storage refresh was clearing in-progress forms on every timer tick
- PDF export (jsPDF path) now shows the company name banner — it was drawing address/phone/GSTIN but skipping the name
- Cancelled invoice banner now appears in the jsPDF download path, not just the HTML preview
- Suggestion dropdown selection fixed in all browsers — blur/onchange race condition resolved
- `async function addVendor()` declaration that was accidentally dropped (causing blank page) restored
- Null guard added on purchase order record items to prevent crash on malformed data
- Customer PO and Purchase form fields no longer reset when validation fails
- All buttons missing `type="button"` fixed — were defaulting to `type="submit"` causing page reloads
- Truncated footer version script in `app.html` restored — file was missing closing `</script>`, `</body>`, and `</html>` tags causing a broken page

#### Features
- GSTIN optional for customers — supports individuals and unregistered businesses
- Purchase order line items with per-item tax rate (0/5/12/18/28%), live CGST/SGST/IGST calculation
- Tax type (IGST vs CGST+SGST) auto-determined from vendor vs company state
- Amount field removed from purchase form — grand total shown in tax summary strip only
- Dashboard Tax insight shows Tax Collected (Sales) and Tax Paid (Purchases) separately
- Clear Form button added to Customer POs and Purchases pages
- Create Invoice form layout updated to consistent 6-col grid — Customer and Shipping Address on their own row, Service/Item in a wider dedicated row
- Customer PO and Purchases page layout updated — 6-col proportional grid, notes as single-line inputs, item description as single-line input
- Quotation workspace panel `display:none` removed — panel now visible by default on tab activation
- `window.getInvoice` accessor exposed on `app.js` so external modules (e.g. `quotation.js`) can access the active invoice object
- `window.refreshItemCatalogFromStorage` exposed on `app.js` so external modules can reload the item catalog from storage and sync all item dropdowns after adding new items
- Quotation Generator — new Quotation tab with form, saved list, and one-click preview
- Saved Quotations list replaced with a dropdown selector + detail card UI — selecting a quotation shows ref, customer, date, total, and status inline with Preview / Convert to Invoice / Delete action buttons
- Quotation reference number auto-generated as `DDIS/[seq]/[customer-code]/[FY]`, sequence resets each financial year
- Quotation preview opens a formatted A4 letterhead page (covering letter on page 1, quotation table on page 2) with Print / Save as PDF
- Convert to Invoice — populates customer, date, and all line items directly into the invoice editor; items missing from the catalog are auto-added as Service entries before populating the invoice form
- Item description field in quotation form uses datalist from item master with auto-fill of default rate on selection
- Quotations included in backup and restore
- Customer code auto-filled from most recent quotation when selecting a customer in the quotation form
- Quotation reference number preview now updates live as the customer code is typed or when the customer selection changes

#### Bug Fixes
- `returnToInvoiceEditor()` no longer resets the invoice editor when returning from a non-read-only preview — `invoiceEditorShouldReset` is now only set when the draft was opened read-only (locked/cancelled), so in-progress drafts are correctly restored on return to `app.html`

---

### March 31, 2026

#### Features
- Dashboard defaults to current financial year on load
- "All Years" option removed from FY dropdown — always shows a year
- "Clear Range" renamed to "Reset to Current FY"
- Export buttons moved from Invoice and Purchases pages to Dashboard — exports now filter by dashboard date range
- Filename includes date range (e.g. `Invoices_2026-04-01_to_2026-03-31.xls`)

---

### March 30, 2026

#### Bug Fixes
- Fixed Excel format warning — added MSO XML namespace block and UTF-8 BOM to both exports

#### Features
- Customer GSTIN and Vendor GSTIN columns added to respective Excel exports
- TOTAL row added to both exports (green, bold)
- "Performance Snapshot" bar chart replaced with "Monthly Revenue Trend" horizontal bars
- Pie chart "Sales by Customer" added to dashboard
- KPI cards updated with coloured accent stripes and icons
- Section labels added to dashboard (Overview, Insights, Top Performers, Year on Year)
- Month labels changed from ISO format to readable format (e.g. `Mar 26`)
- Invoice item "Select Service/Item" replaced with combo-box — type to search, or enter new item name to reveal inline save form
- Same combo-box pattern applied to Customer PO and Purchase item entry fields
- Case-insensitive duplicate detection added to Add Customer, Add Vendor, Add Item/Service
- Customer and Vendor name fields now autocomplete from existing records
- GSTIN format validated on save for customers, vendors, and company
- Typing a GSTIN auto-selects the correct state in the dropdown
- App version bumped to `1.2.0` with footer display

---

### March 29, 2026

#### Features
- Preview of locked/cancelled invoices added
- Excel export with borders, styled header row (blue), alternating row colours, TOTAL row

---

### March 28, 2026

#### Features
- Dashboard added with sales, purchases, tax, customer/vendor/item trends, FY comparison, monthly chart
- Local server integration — data stored on disk in `data/storage.json`, shared across browsers on same machine

---

### March 27, 2026

#### Features
- Service/Item dropdown added to invoice creation
- Invoice delete option added to saved invoices list

---

### March 20–21, 2026 — Initial Build

#### Features
- Company, customer, vendor, and item master data management
- GST invoice creation with CGST/SGST/IGST calculation
- Invoice preview and PDF export
- Customer PO tracking
- Purchase order tracking
- Backup and restore
- Invoice number format with financial year (e.g. `INV-25-26/0001`)
- Vendor list management

---

### April 3, 2026 - v1.2.0

#### Bug Fixes
- Invoice PDF export no longer generates blank pages in the HTML-to-canvas path; export now uses a safer off-screen render root with blank-canvas detection before saving
- Direct invoice PDF export now renders rupee amounts correctly and consistently, including totals, by using embedded Arial fonts instead of unreliable built-in font glyphs
- Invoice PDF totals box width is now sized to content instead of a fixed oversized width
- Invoice preview, print, and PDF totals rows were aligned so labels start from a consistent left edge while amounts remain right-aligned
- Invoice preview, print, and PDF table alignment was tightened so `Item Description` stays left-aligned while the adjusted amount columns remain consistent
- Quotation grand total no longer shows a double rupee symbol in the editor after save
- Quotation preview and print now show the rupee symbol correctly in item amounts, round-off, and grand total
- Quotation saved dropdown and detail totals now use consistent rupee formatting
- Footer version label display cleaned up to avoid the visible garbled separator text
- Duplicate `type="button"` attributes removed from dashboard action buttons in `app.html`

#### Features
- Invoice numbers now use the simplified financial-year format without the `INV-` prefix, while older stored values are normalized on display
- Invoice payable text updated to `Make all cheques/DD payable to "DIGIDAT INFO SYSTEMS"`
- Shared UI polish pass applied across the main app shell with cleaner card depth, better toolbar and tab presentation, improved list and table readability, and clearer empty-state styling
