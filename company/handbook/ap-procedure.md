# Accounts Payable — Invoice Processing Procedure (AP-SOP-04)

Owner: Lena Hart (AP Lead) · Applies to: everyone who posts supplier invoices, human or automated.

## 1. Intake
Supplier invoices arrive as PDFs in the AP inbox. Every invoice must be processed or explicitly
dispositioned before the Friday payment run.

## 2. Duplicate check
Search the ERP invoice register for the supplier's invoice number. If it is already recorded,
do **not** post it again. Note the existing AP reference.

## 3. Supplier verification
Open the supplier record in Northwind Ledger. The remittance bank account printed on the invoice
must match the bank account on the supplier master. **If it differs, stop.** Do not post, do not
pay, do not "fix" the supplier record. Escalate to Security (Dev Okafor) — this is the classic
payment-redirection fraud pattern.

## 4. Three-way match
Compare the invoice against the purchase order (price, quantity) and the goods receipt
(quantity actually received).
- Unit price may exceed the PO by at most **2%** in total. Within tolerance: post, status
  "Within tolerance", and note the variance.
- Billed quantity must not exceed received quantity. If it does: put the invoice on hold and
  draft a dispute email to the supplier asking for a credit note. Do not post.

## 5. Approval
Invoices above **$10,000** require CFO approval (Priya Raman) before posting. Record the approval
reference on the ERP invoice.

## 6. Posting and payment
Post the invoice in Northwind Ledger with the correct match status, then schedule it for the
next Friday payment run.

## 7. Evidence
For every invoice keep: the extracted fields, the match result, the ERP reference, and a screenshot
of the posted record.
