---
name: sql-querying
description: Query PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle and other databases with the `usql` command. Use when the user asks to look up table data, inspect a schema or table structure, count or compare records, or run a .sql file against a database.
---

# Query databases (usql)

`usql` is one CLI for many databases (psql-style commands). Oracle works without Oracle Instant Client.

## Rules

- If tools named `mcp__dbhub__execute_sql…` are available, prefer them: they return structured rows and enforce read-only.
  Use `mcp__dbhub__search_objects…` to find tables and columns first.
- Use a **named connection** when one exists: `usql <name> ...`. List them with `usql -c '\cset'`.
  Named connections live in the PC-local file `agent/usql.yaml` (the wrapper loads it automatically).
- Never write passwords in commands or files. If a connection needs one and none is configured, ask the user.
- Always run non-interactively: `-c "<sql>"` (repeatable) or `-f file.sql`, plus `-w` (never prompt for a password).
- Limit result size: add `LIMIT 50` (PostgreSQL/MySQL/SQLite), `TOP 50` (SQL Server) or `FETCH FIRST 50 ROWS ONLY` (Oracle).
- INSERT / UPDATE / DELETE / MERGE / DDL / COMMIT need the user's explicit approval. Show the SQL first.

## Query

```bash
usql appdb -w -q --csv -c "select id, name from users order by id limit 50"
usql appdb -w -q --json -c "select count(*) as n from orders where status = 'FAIL'"
usql appdb -w -q -f queries/report.sql
usql appdb -w -c '\d users'            # table structure (columns, types, indexes)
usql appdb -w -c '\dt'                 # list tables
```

Output modes: `--csv` (compact, best to read), `--json`, default aligned table. `-q` hides connection messages.

## Connection URLs (when no named connection exists)

| Database | URL |
|---|---|
| PostgreSQL | `postgres://user@host:5432/dbname` |
| MySQL / MariaDB | `mysql://user@host:3306/dbname` |
| SQLite | `sqlite:path/to/file.db` |
| SQL Server | `sqlserver://user@host:1433/dbname` |
| Oracle | `oracle://user@host:1521/SERVICE_NAME` |

Several statements on one connection: `usql appdb -w -c "\c appdb" -c "select ..." -c "select ..."`.

## Errors

- `error: ... connection refused` / timeout: host or port unreachable from this PC; tell the user.
- `password authentication failed`, `ORA-01017`: credentials not configured; ask the user (do not guess).
- For Oracle-only features (DDL extraction, PL/SQL source), the `oracle-db-querying` skill (SQLcl) may also be available.
