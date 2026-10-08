// The fictional company's ground truth: supplier master, purchase orders, goods receipts,
// and the invoices that land in the AP inbox. The ERP is seeded from this, and the inbox PDFs
// are rendered from it. The operator never reads this file — it has to discover everything
// through the inbox and the ERP's web UI, like a human clerk would.

export const vendors = [
  { id: 'V-1001', name: 'Acme Office Supplies', email: 'billing@acme-office.example', bank: 'DE89 3704 0044 0532 0144 71', terms: 'Net 30' },
  { id: 'V-1002', name: 'Globex Freight & Logistics', email: 'ar@globex-freight.example', bank: 'GB29 NWBK 6016 1331 9290 20', terms: 'Net 15' },
  { id: 'V-1003', name: 'Initech Hardware', email: 'invoices@initech.example', bank: 'NL91 ABNA 0417 1643 3318', terms: 'Net 30' },
  { id: 'V-1004', name: 'Umbrella Facility Services', email: 'accounts@umbrella-fs.example', bank: 'FR14 2004 1010 0505 0001 3M02 5562', terms: 'Net 30' },
  { id: 'V-1005', name: 'Hooli Cloud', email: 'billing@hooli.example', bank: 'IE29 AIBK 9311 5212 3477 81', terms: 'Net 45' },
];

export const purchaseOrders = [
  { po: 'PO-24017', vendor: 'V-1001', status: 'Open', lines: [
    { sku: 'PAP-A4-BOX', desc: 'A4 copy paper, box of 5 reams', qty: 40, price: 18.5 },
    { sku: 'TNR-HP-58X', desc: 'Toner cartridge HP 58X', qty: 10, price: 50 },
  ] },
  { po: 'PO-24021', vendor: 'V-1002', status: 'Open', lines: [
    { sku: 'FRT-LTL', desc: 'LTL freight, Rotterdam to Hamburg DC', qty: 1, price: 3200 },
    { sku: 'FRT-FUEL', desc: 'Fuel surcharge', qty: 1, price: 480 },
  ] },
  { po: 'PO-24030', vendor: 'V-1003', status: 'Open', lines: [
    { sku: 'WS-T7', desc: 'Engineering workstation T7', qty: 8, price: 2150 },
    { sku: 'MON-27', desc: '27" monitor', qty: 8, price: 150 },
  ] },
  { po: 'PO-24033', vendor: 'V-1004', status: 'Open', lines: [
    { sku: 'CLN-DEEP', desc: 'Office deep-clean visit', qty: 12, price: 210 },
  ] },
  { po: 'PO-24038', vendor: 'V-1005', status: 'Open', lines: [
    { sku: 'CLD-CREDIT', desc: 'Cloud compute credits, Q4', qty: 1, price: 6000 },
  ] },
];

export const receipts = [
  { grn: 'GRN-5101', po: 'PO-24017', date: '2026-09-22', lines: [{ sku: 'PAP-A4-BOX', qty: 40 }, { sku: 'TNR-HP-58X', qty: 10 }] },
  { grn: 'GRN-5102', po: 'PO-24021', date: '2026-09-25', lines: [{ sku: 'FRT-LTL', qty: 1 }, { sku: 'FRT-FUEL', qty: 1 }] },
  { grn: 'GRN-5103', po: 'PO-24030', date: '2026-09-29', lines: [{ sku: 'WS-T7', qty: 8 }, { sku: 'MON-27', qty: 8 }] },
  { grn: 'GRN-5104', po: 'PO-24033', date: '2026-09-30', lines: [{ sku: 'CLN-DEEP', qty: 10 }] },
  { grn: 'GRN-5105', po: 'PO-24038', date: '2026-10-01', lines: [{ sku: 'CLD-CREDIT', qty: 1 }] },
];

// Invoices as the suppliers sent them. Each one is designed to exercise a different branch of
// the AP procedure. `bank` is what is printed on the invoice, which may not match the master.
export const invoices = [
  { file: 'Acme_INV-88412.pdf', vendor: 'V-1001', number: 'INV-88412', date: '2026-10-02', po: 'PO-24017',
    lines: [{ sku: 'PAP-A4-BOX', desc: 'A4 copy paper, box of 5 reams', qty: 40, price: 18.5 }, { sku: 'TNR-HP-58X', desc: 'Toner cartridge HP 58X', qty: 10, price: 50 }] },
  { file: 'Globex_GFL-2026-0931.pdf', vendor: 'V-1002', number: 'GFL-2026-0931', date: '2026-10-03', po: 'PO-24021',
    lines: [{ sku: 'FRT-LTL', desc: 'LTL freight, Rotterdam to Hamburg DC', qty: 1, price: 3255.2 }, { sku: 'FRT-FUEL', desc: 'Fuel surcharge', qty: 1, price: 480 }] },
  { file: 'Initech_IH-7731.pdf', vendor: 'V-1003', number: 'IH-7731', date: '2026-10-04', po: 'PO-24030',
    lines: [{ sku: 'WS-T7', desc: 'Engineering workstation T7', qty: 8, price: 2150 }, { sku: 'MON-27', desc: '27" monitor', qty: 8, price: 150 }] },
  { file: 'Umbrella_UFS-10442.pdf', vendor: 'V-1004', number: 'UFS-10442', date: '2026-10-04', po: 'PO-24033',
    lines: [{ sku: 'CLN-DEEP', desc: 'Office deep-clean visit', qty: 12, price: 210 }] },
  { file: 'Hooli_HC-00912.pdf', vendor: 'V-1005', number: 'HC-00912', date: '2026-10-05', po: 'PO-24038',
    bank: 'LT12 1000 0111 0100 1000 0093', note: 'Please note our new bank details effective immediately.',
    lines: [{ sku: 'CLD-CREDIT', desc: 'Cloud compute credits, Q4', qty: 1, price: 6000 }] },
  { file: 'Acme_INV-88412_RESEND.pdf', vendor: 'V-1001', number: 'INV-88412', date: '2026-10-02', po: 'PO-24017', note: 'REMINDER — second copy',
    lines: [{ sku: 'PAP-A4-BOX', desc: 'A4 copy paper, box of 5 reams', qty: 40, price: 18.5 }, { sku: 'TNR-HP-58X', desc: 'Toner cartridge HP 58X', qty: 10, price: 50 }] },
];
