# Tenant email templates (signature request + completion)

These are the emails your **signers** and **document owner** receive. They are stored
per tenant in the database (`partners_Tenant.RequestBody` / `CompletionBody`), not in the
application code, so they can be changed without touching the platform.

Shipped defaults live here:

| File | Used for |
|------|----------|
| `deploy/tenant/RequestBody.html` | "A signature has been requested" — sent to each signer when a document is sent for signature |
| `deploy/tenant/CompletionBody.html` | "All parties have signed" — sent to the sender when the last party finishes |
| `assets/mail/rapid-lodgements-logo.png`, `assets/mail/fbaa-accredited.png` | Signature logos, published under `/mail/` on the platform so no third-party CDN is involved |

The subject lines are stored in the same row and use `{{sender_name}}`,
`{{receiver_name}}` and `{{document_title}}`:

```
{{sender_name}} has requested you to sign {{document_title}}
Document {{document_title}} has been signed by all parties
```

## Apply them

```bash
./scripts/apply-tenant-templates.sh                # single-tenant install
./scripts/apply-tenant-templates.sh <TENANT_OBJ_ID> # specific tenant
```

The script:

1. writes a **rollback JSON** of the current subjects/bodies to `~/esign-patches/tenant-templates/`
2. publishes the signature logos under `…/mail/` on the client container
3. writes both HTML bodies into `partners_Tenant`
4. reads the row back and reports the character counts

Re-running it is a no-op when the values already match, so it is safe in a cron or
repeat deployment.

## Editing for your own business

This is **tenant customisation** and is expected: organisation name, signature block,
phone numbers, address, accreditation logos and disclaimer belong to the tenant.
Replace the text in `deploy/tenant/*.html`, drop your own logos into `assets/mail/`,
and re-run the script.

Product branding (the HEXSign name, logo, header bar and footer) is **not** tenant
customisable — see `LICENSE` and `NOTICE`.

## Notes

- Keep the HTML table-based and inline-styled; Outlook ignores `<style>` blocks and flexbox.
- Keep `{{signing_url}}` inside the button **and** as a plain link underneath — some
  mail clients strip or block button links.
- Do not reference images on `googleusercontent.com` or any CDN: those URLs expire or are
  blocked in Outlook. Serve everything from `/mail/` on the platform itself.
- The "one of two has signed" interim notice is a **system** email built in
  `server/cloud/parsefunction/pdf/PDF.js`, not from these templates.
