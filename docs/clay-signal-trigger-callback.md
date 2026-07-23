# Clay to /api/trigger callback spec: Pallet New Hires + News & Fundraising

Status: spec only, not yet built in Clay. Two HTTP API columns to be entered manually, one per
signal output table, both on `pallet_clay_named_accounts` (386 rows). Auto-run must stay OFF until
the single-row tests below pass and are reviewed.

This closes the loop for Pallet's New Hires and News & Fundraising signals by reusing the existing
live `POST /api/trigger` endpoint. No new endpoint, no new auth. Each column produces the same
18-field JSON body the Pallet trigger table already sends successfully.

## Endpoint and auth (unchanged, do not modify)

- Method / URL: `POST https://<pallet-backend-host>/api/trigger` (same host the existing Pallet
  trigger table posts to).
- Auth: the body must include `token` equal to the shared `WEBHOOK_SECRET`. Validation is
  `token === process.env.WEBHOOK_SECRET` in `src/middleware/validateWebhook.js`. There is no
  header-based auth on this endpoint. Use the same secret value the existing Pallet trigger column
  already sends.
- Content-Type: `application/json`.

## The 18 fields (exact order and names)

`token`, `client_id`, `company_name`, `company_linkedin`, `company_website`,
`company_headcount`, `funding_stage`, `total_funding`, `trigger_type`, `trigger_score`,
`primary_first_name`, `primary_last_name`, `primary_email`, `primary_linkedin`,
`primary_direct_dial`, `primary_title`, `additional_contacts`, `context`.

- `client_id` is Pallet's client id: `a0c67977-2817-4308-ac76-deed4e6c0911`.
- `additional_contacts` must be a JSON array (the endpoint rejects a non-array with HTTP 400). If
  the signal has no additional contacts, send `[]`, not `null` and not an object.
- Every value must come from Clay's `/` column reference picker pointing at a real output column,
  except the two deliberately static values called out below (`trigger_type` on New Hires, and
  `trigger_score`). No hand-typed text standing in for a dynamic field.

## trigger_score: fixed placeholder 5

Neither signal output table exposes a confidence/score column (confirmed by Ali, including hidden
columns). Send a flat integer `5` on both columns.

- `5` is the agreed marker for "auto-fired from Clay, no confidence data available."
- This is deliberately distinct from the hand-typed `9 / 8 / 6` on the three TAP-loaded accounts
  (Echo, Lineage, C.H. Robinson). Those were manually seeded review payloads, not real Clay-fired
  triggers, so there is no proven Clay score format to mirror - `5` is a new, intentional default.
- If a real confidence column is added to either signal later, repoint `trigger_score` at it via
  the `/` picker and drop the placeholder.

## trigger_type strings (exact, from v4 system prompt)

Pulled verbatim from `system_prompts` row `bb91b895-dc85-47ed-8d6b-932c98285472` (Pallet v4,
status approved). These must be character-for-character correct, including the parenthetical
suffixes.

| Signal category | Exact trigger_type string |
| --- | --- |
| New hire (CIO/CTO/VP Technology) | `New CIO/CTO/VP Technology hired (last 90 days)` |
| Merger / acquisition | `Acquisition/merger announced` |
| Business expansion | `Business expansion` |
| Supply chain disruption | `Supply chain disruption` |
| Employee dispute / strike | `Labor disruption (strike, labor dispute)` |
| Customer loss/growth decline | `Commercial performance shift (customer loss or growth initiative)` |

Note on the labor disruption string: it intentionally contains "(strike, labor dispute)". That is
an internal categorization value only. The backend never surfaces `trigger_type` verbatim in
generated outreach, and as of this build it maps labor disruption to a sanitized prompt-facing
label ("Operational resilience opportunity") before the value ever reaches Claude
(`src/services/triggerTypes.js`). So sending the full literal string from Clay is correct and
safe. The separate `context` scrub below is still required.

---

## Column 1: New Hires signal output table

The new hire is the primary contact (person-level signal).

Field-by-field mapping:

| Field | Source |
| --- | --- |
| `token` | `WEBHOOK_SECRET` value (same as existing Pallet trigger column) |
| `client_id` | static `a0c67977-2817-4308-ac76-deed4e6c0911` |
| `company_name` | `/` base `pallet_clay_named_accounts` row: company name |
| `company_linkedin` | `/` base row: company LinkedIn |
| `company_website` | `/` base row: company website |
| `company_headcount` | `/` base row: headcount |
| `funding_stage` | `/` base row: funding stage |
| `total_funding` | `/` base row: total funding |
| `trigger_type` | static `New CIO/CTO/VP Technology hired (last 90 days)` |
| `trigger_score` | static `5` |
| `primary_first_name` | `/` New Hire signal output: person first name |
| `primary_last_name` | `/` New Hire signal output: person last name |
| `primary_email` | `/` New Hire signal output: person email |
| `primary_linkedin` | `/` New Hire signal output: person LinkedIn |
| `primary_direct_dial` | `/` New Hire signal output: person direct dial (or empty string if none) |
| `primary_title` | `/` New Hire signal output: person title |
| `additional_contacts` | `[]` (New Hires is single-person; send empty array) |
| `context` | `/` New Hire signal output: event / summary column |

JSON body (replace each `{{ / ... }}` with a real Clay column reference; keep the two static
values and the empty array literal exactly as written):

```json
{
  "token": "{{ / WEBHOOK_SECRET }}",
  "client_id": "a0c67977-2817-4308-ac76-deed4e6c0911",
  "company_name": "{{ / base: Company Name }}",
  "company_linkedin": "{{ / base: Company LinkedIn }}",
  "company_website": "{{ / base: Company Website }}",
  "company_headcount": "{{ / base: Headcount }}",
  "funding_stage": "{{ / base: Funding Stage }}",
  "total_funding": "{{ / base: Total Funding }}",
  "trigger_type": "New CIO/CTO/VP Technology hired (last 90 days)",
  "trigger_score": 5,
  "primary_first_name": "{{ / New Hire: First Name }}",
  "primary_last_name": "{{ / New Hire: Last Name }}",
  "primary_email": "{{ / New Hire: Email }}",
  "primary_linkedin": "{{ / New Hire: LinkedIn }}",
  "primary_direct_dial": "{{ / New Hire: Direct Dial }}",
  "primary_title": "{{ / New Hire: Title }}",
  "additional_contacts": [],
  "context": "{{ / New Hire: Event Summary }}"
}
```

---

## Column 2: News & Fundraising signal output table

Company-level signal, so the primary contact is the account's existing primary contact from the
base row (not a person the signal returns).

`trigger_type` is conditional on which of the 5 Clay categories fired. Build this as ONE
conditional/lookup formula against the signal's category output field, not five separate columns.

### trigger_type conditional (category -> exact v4 string)

VERIFY BEFORE GOING LIVE: the left-hand category values below are placeholders. No rows have been
confirmed fired on the narrowed 386-company list, and this environment has no access to Clay to
read real cell text, so the exact casing/wording Clay emits in its category output field is not yet
known. Before enabling this column, fire one real row (see test plan) and replace each left-hand
value with the category string Clay actually outputs, character-for-character. Do not guess casing.

| Clay category output value (PLACEHOLDER - verify) | Maps to trigger_type (exact, do not edit) |
| --- | --- |
| `merger/acquisition` | `Acquisition/merger announced` |
| `business expansion` | `Business expansion` |
| `supply chain disruption` | `Supply chain disruption` |
| `employee dispute/strike` | `Labor disruption (strike, labor dispute)` |
| `Customer loss/growth decline` | `Commercial performance shift (customer loss or growth initiative)` |

Clay formula shape (lookup/switch on the category output column; adjust the exact function name to
Clay's formula syntax, keep the mapping):

```
switch(
  lower(trim( / News: Category )),
  "merger/acquisition",              "Acquisition/merger announced",
  "business expansion",              "Business expansion",
  "supply chain disruption",         "Supply chain disruption",
  "employee dispute/strike",         "Labor disruption (strike, labor dispute)",
  "customer loss/growth decline",   "Commercial performance shift (customer loss or growth initiative)"
)
```

### context field (CRITICAL: labor disruption scrub)

For every category EXCEPT employee dispute/strike, `context` is the signal's own event/summary
output column via `/`, same as New Hires.

For the employee dispute/strike category, `context` must NOT pass through Clay's raw news text. The
raw text will contain the words strike / walkout / labor dispute and the specifics of the event.
Instead, when the category is employee dispute/strike, `context` must be a fixed
operational-resilience framing string with zero reference to the actual situation. Build this as a
conditional on the same category field, not a pass-through:

```
if(
  lower(trim( / News: Category )) == "employee dispute/strike",
  "Operational environment where manual, labor-intensive back-office processes are under strain and resilience through automation is timely. Frame around reducing dependency on manual processes and freeing existing staff, not around any specific event.",
  / News: Event Summary
)
```

This is a second, independent layer from the backend `trigger_type` sanitizer: the backend scrubs
the `trigger_type` channel, and this Clay formula scrubs the `context` channel. Both are needed -
`context` is passed into the Claude prompt raw (`Trigger Context: ${account.context}`), so if the
raw news text reaches `context`, the backend does not filter it.

### Field-by-field mapping

| Field | Source |
| --- | --- |
| `token` | `WEBHOOK_SECRET` value (same as existing Pallet trigger column) |
| `client_id` | static `a0c67977-2817-4308-ac76-deed4e6c0911` |
| `company_name` | `/` base row: company name |
| `company_linkedin` | `/` base row: company LinkedIn |
| `company_website` | `/` base row: company website |
| `company_headcount` | `/` base row: headcount |
| `funding_stage` | `/` base row: funding stage |
| `total_funding` | `/` base row: total funding |
| `trigger_type` | conditional formula above (category -> exact v4 string) |
| `trigger_score` | static `5` |
| `primary_first_name` | `/` base row: primary first name |
| `primary_last_name` | `/` base row: primary last name |
| `primary_email` | `/` base row: primary email |
| `primary_linkedin` | `/` base row: primary LinkedIn |
| `primary_direct_dial` | `/` base row: primary direct dial |
| `primary_title` | `/` base row: primary title |
| `additional_contacts` | `/` base row: additional_contacts array (send `[]` if none) |
| `context` | conditional formula above (scrubbed for labor disruption) |

JSON body:

```json
{
  "token": "{{ / WEBHOOK_SECRET }}",
  "client_id": "a0c67977-2817-4308-ac76-deed4e6c0911",
  "company_name": "{{ / base: Company Name }}",
  "company_linkedin": "{{ / base: Company LinkedIn }}",
  "company_website": "{{ / base: Company Website }}",
  "company_headcount": "{{ / base: Headcount }}",
  "funding_stage": "{{ / base: Funding Stage }}",
  "total_funding": "{{ / base: Total Funding }}",
  "trigger_type": "{{ / formula: trigger_type conditional }}",
  "trigger_score": 5,
  "primary_first_name": "{{ / base: Primary First Name }}",
  "primary_last_name": "{{ / base: Primary Last Name }}",
  "primary_email": "{{ / base: Primary Email }}",
  "primary_linkedin": "{{ / base: Primary LinkedIn }}",
  "primary_direct_dial": "{{ / base: Primary Direct Dial }}",
  "primary_title": "{{ / base: Primary Title }}",
  "additional_contacts": "{{ / base: additional_contacts }}",
  "context": "{{ / formula: context conditional }}"
}
```

---

## Test plan (do this before Auto-run)

1. New Hires column: manually run the column on exactly ONE row. Confirm:
   - HTTP 200 with `{ "status": "success" }`.
   - A new row lands in `accounts` for `client_id = a0c67977-2817-4308-ac76-deed4e6c0911` with
     `trigger_type = "New CIO/CTO/VP Technology hired (last 90 days)"`, `trigger_score = 5`, the
     new hire as the primary contact, and company fields populated from the base row.
   - An asset is generated the same way existing Pallet triggers generate one.
2. News & Fundraising column: first replace the placeholder category values with the real Clay
   category strings from the fired row, then manually run on exactly ONE row (ideally test the
   employee dispute/strike branch specifically if a row is available). Confirm the same success
   criteria, plus:
   - `trigger_type` resolved to the correct exact v4 string for that category.
   - For an employee dispute/strike row: the stored `context` contains the resilience framing and
     none of strike / walkout / labor dispute, AND the generated asset copy references no labor
     situation.
3. Only after BOTH single-row tests are confirmed clean should Auto-run be considered. Do NOT
   enable Auto-run as part of this build. Leaving it off is intentional; enabling it is a separate
   manual decision for after test review (each hit spends Claude generation cost).
