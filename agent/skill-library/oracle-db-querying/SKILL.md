---
name: oracle-db-querying
description: Query and inspect an Oracle database with the `sql` (SQLcl) command. Use when the user asks to look up table data, check a schema, column, index or DDL, read PL/SQL source, or run a .sql script against Oracle.
---

# Oracle SQLcl

`sql` runs Oracle SQLcl (the wrapper handles Git Bash path issues and disables update checks).
SQLcl is an **optional component** (Oracle license, not bundled). If `sql` prints "SQLcl is not installed", stop and tell the user; do not try to install it.

## Rules

- Connect with a **saved connection name**: `sql -S -L -name <conn>`. Never put passwords on the command line and never print them.
  If you do not know the connection name, run `connmgr list` (below) or ask the user.
- Run SQL **only through a quoted heredoc** (`<<'SQL'`) or an `@script.sql` file. **Never use `-e`**: it fails without a console.
- Always end the input with `exit`, and put `whenever sqlerror exit failure` first so ORA- errors give a non-zero exit code.
  Client errors such as `SP2-0640` (not connected) still exit 0, so **always read the output** for `ORA-` / `SP2-` lines.
- Limit result size: add `fetch first 50 rows only` (or a WHERE clause) to every SELECT on large tables.
- INSERT / UPDATE / DELETE / MERGE / DDL / COMMIT / PL/SQL blocks need the user's explicit approval. Show the SQL first.

## Query template

```bash
sql -S -L -name mydb <<'SQL'
whenever sqlerror exit failure
set sqlformat csv
set feedback off
select owner, table_name from all_tables where owner = 'HR' fetch first 50 rows only;
exit
SQL
```

`set sqlformat` options: `csv` (compact, best for reading), `json`, `ansiconsole` (aligned table), `default`.

## Inspect objects

```bash
sql -S -L -name mydb <<'SQL'
whenever sqlerror exit failure
info hr.employees
ddl hr.employees
exit
SQL
```

- `info <table>`: columns, types, PK, indexes.
- `ddl <object>`: CREATE statement of a table, view, package, etc.
- Source of PL/SQL: `select text from all_source where owner='HR' and name='PKG' and type='PACKAGE BODY' order by line;`

## Saved connections

```bash
sql -S /nolog <<'SQL'
connmgr list
connmgr test mydb
exit
SQL
```

Creating a saved connection needs a password, so **the user does it** in their own terminal:
`sql /nolog` then `conn -save mydb -savepwd user@//host:1521/service_name`.

## Run a script file

```bash
sql -S -L -name mydb @path/to/script.sql
```

The script itself must end with `exit`. Relative `@` paths resolve from the current directory.

## Errors

- `ORA-xxxxx`: database error; read the message and fix the SQL.
- `Unknown connection <name>` (exit 1): no saved connection with that name → `connmgr list`.
- `SP2-0640: 접속되지 않음` (not connected, exit 0): the login failed or the DB is unreachable → `connmgr test <conn>`.
- Messages may be in Korean; error codes are the same.
