from pathlib import Path
import re
import shutil

SCRIPT = Path("script.js")
BACKUP = Path("script.js.bulk-migration-backup")

text = SCRIPT.read_text()

# Never overwrite the original migration backup.
if not BACKUP.exists():
    shutil.copy2(SCRIPT, BACKUP)

print("========================================")
print("OweMe Supabase Bulk Migration Preview")
print("========================================")
print()
print(f"script.js lines: {len(text.splitlines())}")
print()

# Existing Supabase tables that the migrated frontend can use.
TABLES = {
    "profiles",
    "groups",
    "group_members",
    "invitations",
    "expenses",
    "expense_participants",
    "settlements",
    "payment_providers",
    "payment_details",
    "payment_submissions",
}

# Find every Supabase table reference already present.
referenced_tables = set(
    re.findall(
        r'\.from\(["\']([^"\']+)["\']\)',
        text
    )
)

print("Already referenced Supabase tables:")
for table in sorted(referenced_tables):
    print(f"  ✓ {table}")

print()

print("Tables available for the bulk migration:")
for table in sorted(TABLES):
    marker = "✓" if table in referenced_tables else "→"
    print(f"  {marker} {table}")

print()

# Find remaining Apps Script API dependencies.
api_lines = []

for line_number, line in enumerate(text.splitlines(), 1):
    if re.search(r'\bapi\(', line):
        api_lines.append((line_number, line.strip()))

print(f"Remaining api() occurrences: {len(api_lines)}")
print()

for line_number, line in api_lines:
    print(f"{line_number}: {line[:180]}")

print()
print("========================================")
print("NO FILE WAS MODIFIED.")
print("========================================")
print()
print("This preview confirms the migration inputs.")
print("The next step will replace the remaining API-dependent")
print("feature blocks while preserving the existing UI.")
