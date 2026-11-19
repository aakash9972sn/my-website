# Automatic seller order alerts

The merchant recipients are fixed in `data/store.json` → `sellerNotifications`:

- Email: **sdhanpal778@gmail.com**
- SMS: **+919910113972**
- WhatsApp: **+919910113972**

These are the **seller's destinations**, not customer fields. Checkout input cannot
change them. Customers enter their own contact details and delivery address,
then confirm checkout on the website. They do not have to open a messaging app.

## What triggers a notification

A successful COD submission writes the order, inventory reservation and seller
notification jobs in one SQLite transaction. Online purchases notify only after
the server verifies a captured payment, including a signed webhook when the
browser is closed. Repeated checkout or duplicate payment events reuse the same
jobs. Failed or abandoned unpaid checkouts do not create packing alerts.

The seller receives the order reference, each product/pack/quantity, line prices,
discount/delivery/total, payment method/status, customer name/phone/email, full
address and optional map directions. COD alerts explicitly say payment has not
been collected. Cancellation, COD expiry and full refunds produce updates;
queued outdated packing alerts are superseded. Check the latest order before
sending goods. SMS includes product lines and address; an overlong message is
marked failed rather than silently dropping items. Email is recommended for the
complete delivery manifest and as the primary channel.

## Activate email using the existing Gmail account

1. Deploy this Node application with persistent SQLite storage, using the existing
   Docker/Render setup. GitHub Pages only serves files and cannot run this worker.
2. In the Google account that owns `sdhanpal778@gmail.com`, enable 2-Step
   Verification and create an [App Password](https://myaccount.google.com/apppasswords).
   If the account disallows App Passwords, use a transactional SMTP provider.
3. Set hosting secrets/settings: `SELLER_NOTIFICATION_CHANNELS=email`,
   `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`,
   `SMTP_USER=sdhanpal778@gmail.com`, `SMTP_FROM=sdhanpal778@gmail.com`,
   and `SMTP_PASS` to that App Password. **Do not paste it into chat or commit it.**
4. Complete the existing real stock, seller identity and delivery setup, then set
   `STORE_ENABLED=true`. Startup refuses to open without at least one configured
   seller-notification channel. If keeping GitHub Pages, set the hosted API URL in
   `store-config.js` and the matching CORS origin as described in the README.
5. Place one owner-controlled order and check both the inbox and the notification
   queue. SMTP acceptance does not prove inbox delivery; check spam and provider
   logs. No real email has been sent by the automated tests.

## Optional SMS and WhatsApp

Use an activated Twilio account with a registered SMS sender and/or a WhatsApp
Business sender. Delivery, templates and India-specific sender requirements must
be approved by the provider; messaging can incur charges. The receiving seller
number does not automatically become an approved sending number.

Add `sms` and/or `whatsapp` to `SELLER_NOTIFICATION_CHANNELS`, then set
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM` and/or
`TWILIO_WHATSAPP_FROM` as applicable. Use E.164 numbers including `+`.

WhatsApp notifications outside an active service conversation require an approved
Content Template, configured as `TWILIO_WHATSAPP_CONTENT_SID`. Create a template
with these eight variables:

| Variable | Value                                            |
| -------- | ------------------------------------------------ |
| 1        | Order reference                                  |
| 2        | Order status and fulfilment instruction          |
| 3        | Product names, packs, quantities and line totals |
| 4        | Order total in INR                               |
| 5        | Customer name                                    |
| 6        | Customer phone                                   |
| 7        | Full delivery address                            |
| 8        | Map link or no-map note                          |

Suggested template text: `Blunder seller alert: {{1}}. {{2}} Items: {{3}}.
Total: {{4}}. Deliver to {{5}}, phone {{6}}, address {{7}}. Map: {{8}}.`
Obtain any required recipient opt-in and template approval in the provider account.

## Inspect and recover

```sh
npm run store -- notifications
npm run store -- order BL-ORDERREFERENCE
# After fixing credentials/provider errors, or checking ambiguous delivery:
npm run store -- retry-notification JOB_ID
```

Jobs survive server restarts. Explicit transient failures retry with bounded
backoff up to eight attempts. Authentication/rejected-recipient failures need
operator attention. An interrupted or ambiguous send is marked `review`, because
the provider may already have accepted it. Check provider logs before retrying.
`accepted` means accepted by SMTP/Twilio, not guaranteed delivery or read status.
The server never rolls back a saved order because a sending provider is offline.
Protect the database and hosting shell; queue payloads contain delivery details.
