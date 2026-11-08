---
name: http-api-hurl
description: Call and test HTTP/REST APIs with hurl files - requests, asserts, captured values, chained calls. Use when the user wants to call an API, test an endpoint, or write API tests.
---

# HTTP API testing (hurl)

`hurl` is pre-installed (8.1). It uses the Windows certificate store, so internal HTTPS certificates usually just work.

## Rules

- Write requests into a `.hurl` file and run it; do not build long `curl` one-liners.
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

## Run

```bash
hurl --test --variable base=http://api.internal:8080 --variable token="$API_TOKEN" tests/api.hurl
hurl --test --variables-file env/dev.properties tests/*.hurl     # name=value per line
hurl --variable base=... call.hurl | jq .                        # print the last response body
hurl --very-verbose call.hurl                                    # debug headers/body
hurl --test --report-junit build/hurl.xml tests/*.hurl           # CI report
```

`--test` prints a pass/fail summary and exits non-zero on failure. Without `--test`, hurl prints the last response body.
