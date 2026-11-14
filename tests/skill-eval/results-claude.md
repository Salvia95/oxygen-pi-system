| # | 종류 | 기대 | before-r2 | after-r2 |
|---|---|---|---|---|
| 1 | P | find-code | ✗ bash | ✓ find-code |
| 2 | N | not find-code | ✓ bash | ✓ bash |
| 3 | P | structural-code-search | ✓ structural-code-search | ✓ structural-code-search |
| 4 | N | not structural-code-search | ✓ bash | ✓ bash |
| 5 | P | terminal-session-control | ✓ terminal-session-control | ✓ terminal-session-control |
| 6 | N | not terminal-session-control | ✓ bash | ✓ bash |
| 7 | P | project-task-running | ✗ bash | ✓ project-task-running |
| 8 | N | not project-task-running | ✓ bash | ✓ background |
| 9 | P | json-querying | ✗ bash | ✓ json-querying |
| 10 | N | not json-querying | ✓ read | ✓ read |
| 11 | P | gitlab-workflow | ✓ gitlab-workflow | ✓ gitlab-workflow |
| 12 | N | not gitlab-workflow/github-workflow | ✓ bash | ✓ bash |
| 13 | P | github-workflow | ✓ github-workflow | ✓ github-workflow |
| 14 | N | not github-workflow | ✓ gitlab-workflow | ✓ gitlab-workflow |
| 15 | P | sql-querying | ✓ sql-querying | ✓ sql-querying |
| 16 | N | not sql-querying | ✓ oracle-db-querying | ✓ oracle-db-querying |
| 17 | P | oracle-db-querying | ✓ oracle-db-querying | ✓ oracle-db-querying |
| 18 | N | not oracle-db-querying | ✓ sql-querying | ✓ sql-querying |
| 19 | P | http-api-testing | ✓ http-api-testing | ✓ http-api-testing |
| 20 | N | not http-api-testing | ✓ web-page-reading | ✓ web-page-reading |
| 21 | P | web-page-reading | ✓ web-page-reading | ✓ web-page-reading |
| 22 | N | not web-page-reading | ✓ web-page-automation | ✓ web-page-automation |
| 23 | P | web-page-automation | ✓ web-page-automation | ✓ web-page-automation |
| 24 | N | not web-page-automation | ✓ http-api-testing | ✓ http-api-testing |
| 25 | G | skill 없음 | ✓ 답변 | ✓ 답변 |
| 26 | G | skill 없음 | ✓ read | ✓ read |
| 27 | G | skill 없음 | ✓ 답변 | ✓ 답변 |
| 28 | G | skill 없음 | ✓ read | ✓ read,bash |
| 29 | P | http-api-testing | ✓ http-api-testing | ✓ http-api-testing |
| 30 | P | http-api-testing | ✓ http-api-testing | ✓ http-api-testing |
| 31 | P | sql-querying | ✓ sql-querying | ✓ sql-querying |
| 32 | N | not structural-code-search | ✓ bash | ✓ bash |
| 33 | G | skill 없음 | ✓ read | ✓ read |
| 34 | G | skill 없음 | ✓ grep | ✓ grep |
| 35 | N | not http-api-testing | ✓ web-page-automation | ✓ web-page-automation |
| 36 | N | not http-api-testing/terminal-session-control | ✓ bash | ✓ background |

before-r2: 전체 33/36 · P 12/15 · N 15/15 · G 6/6 · N 의 대체 skill 적중 7/7

after-r2: 전체 36/36 · P 15/15 · N 15/15 · G 6/6 · N 의 대체 skill 적중 7/7
