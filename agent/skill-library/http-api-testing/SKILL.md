---
name: http-api-testing
description: Send and check HTTP requests with `hurl` (instead of curl) and keep them as a re-runnable `.hurl` file. Use whenever you call an endpoint or URL to see what it returns, your own dev server too (status code, redirect, JSON or HTML body, a form post with session cookie and CSRF token), reproduce an API bug, or leave a check to run again. Not for screenshots or clicking through a UI (web-page-automation).
---

# HTTP API testing (hurl)

`hurl` is pre-installed (8.1). It uses the Windows certificate store, so internal HTTPS certificates usually just work.

## Rules

- Write requests into a `.hurl` file and run it; do not build long `curl` one-liners. Keep using hurl for the follow-up requests of the same check.
- Your own dev server counts too (`http://127.0.0.1:<port>`): check pages, redirects and form posts with hurl.
- Put hosts and secrets in variables (`{{base}}`, `{{token}}`), passed with `--variable` or `--variables-file`. Never hardcode tokens in files you commit.
- Only internal hosts are reachable (no internet).
- Requests that change data (POST/PUT/PATCH/DELETE on a real system) need the user's approval.

## File format

```hurl
# 1. GET with auth, assert, capture
GET {{base}}/api/users?limit=5
Authorization: Bearer {{token}}
HTTP 200
[Asserts]
header "Content-Type" contains "json"
jsonpath "$.items" count <= 5
jsonpath "$.items[0].id" exists
[Captures]
user_id: jsonpath "$.items[0].id"

# 2. Use the captured value
GET {{base}}/api/users/{{user_id}}
Authorization: Bearer {{token}}
HTTP 200
[Asserts]
jsonpath "$.id" == {{user_id}}

# 3. POST JSON
POST {{base}}/api/items
Content-Type: application/json
{
  "name": "test"
}
HTTP 201
```

Entries run top to bottom and stop at the first failure. Each entry: request line, headers, optional body, then `HTTP <status>` and optional `[Asserts]` / `[Captures]`.
Other asserts: `status == 200`, `body contains "ok"`, `jsonpath "$.a" matches "^x"`, `duration < 1000`.
Form body: `[Form]` section with `key: value` lines. Query params: `[Query]` section.

## HTML form with session cookie and CSRF token

Server-rendered apps (Spring Security, Django, Rails) need the session cookie and the hidden `_csrf` value from the form page.
One `.hurl` file keeps cookies between its entries, so open the form, post it and open the redirect target in the same file:

```hurl
# 1. open the form: the server sets the session cookie, capture the hidden CSRF token
GET {{base}}/orders/new
HTTP 200
[Captures]
csrf: xpath "string(//input[@name='_csrf']/@value)"

# 2. post it (same file = same cookie jar)
POST {{base}}/orders
[Form]
_csrf: {{csrf}}
productId: 3
qty: 1
HTTP 302
[Captures]
next: header "Location"

# 3. open the page it redirects to, still with the session cookie
GET {{base}}{{next}}
HTTP 200
[Asserts]
xpath "string(//h1)" exists
```

Run it without `--test` to print the last page. To report each status code, redirect and captured value, add `-v` (they go to stderr):

```bash
hurl -v --variable base=http://127.0.0.1:8080 form.hurl 2>&1 >/dev/null | grep -E '^< (HTTP|location)|^\* [a-z_]+:'
```

A separate `curl` call does not have the session cookie.

## Run

```bash
hurl --test --variable base=http://api.internal:8080 --variable token="$API_TOKEN" tests/api.hurl
hurl --test --variables-file env/dev.properties tests/*.hurl     # name=value per line
hurl --variable base=... call.hurl | jq .                        # print the last response body
hurl --very-verbose call.hurl                                    # debug headers/body
hurl --test --report-junit build/hurl.xml tests/*.hurl           # CI report
```

`--test` prints a pass/fail summary and exits non-zero on failure. Without `--test`, hurl prints the last response body.
