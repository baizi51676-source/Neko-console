#!/bin/bash
# Remove every PostgreSQL test database and role left by verification runs.
#
# Written as a file because the nested quoting (su -> psql -> SQL identifiers)
# is unmanageable inline, and getting it wrong silently leaves state behind that
# makes later runs fail with "already exists".
set -uo pipefail

echo "--- before ---"
su -s /bin/bash postgres -c "cd / && psql -tAc \"SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')\"" 2>/dev/null

su -s /bin/bash postgres -c "cd / && psql -tAc \"SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')\"" 2>/dev/null |
while IFS= read -r db; do
  [ -z "$db" ] && continue
  echo "drop database: $db"
  su -s /bin/bash postgres -c "cd / && psql -q -tAc \"DROP DATABASE IF EXISTS \\\"$db\\\"\"" 2>&1
done

su -s /bin/bash postgres -c "cd / && psql -tAc \"SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' AND rolname <> 'postgres'\"" 2>/dev/null |
while IFS= read -r role; do
  [ -z "$role" ] && continue
  echo "drop role: $role"
  su -s /bin/bash postgres -c "cd / && psql -q -tAc \"DROP ROLE IF EXISTS \\\"$role\\\"\"" 2>&1
done

echo "--- after ---"
su -s /bin/bash postgres -c "cd / && psql -tAc \"SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')\"" 2>/dev/null
su -s /bin/bash postgres -c "cd / && psql -tAc \"SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' AND rolname <> 'postgres'\"" 2>/dev/null
echo "--- done ---"
