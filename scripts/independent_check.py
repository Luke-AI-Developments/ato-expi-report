"""Independent check of the sample expected-output files.

Works out each row's next step (and so its `actions` cell, e.g.
"20 to Edge and drill", or that the row is dropped) straight from db/data/stock-sheet.csv and
db/data/routing.csv. Deliberately does NOT import or run anything from the
workflow JSON, so the samples aren't checked against the code under test.

Usage (from repo root, needs `pip install openpyxl`):
  python scripts/independent_check.py sample/input.xlsx sample/expected-output.xlsx
      -> compares, exits 1 on any mismatch
  python scripts/independent_check.py IN.xlsx OUT.xlsx --write
      -> (re)generates OUT.xlsx from IN.xlsx
"""
import csv
import sys
from pathlib import Path

import openpyxl

REPO = Path(__file__).resolve().parent.parent

# The business rule, written out by hand: finished (300) stock that covers the
# qty asked for means nothing to do, and the row is dropped from the result;
# otherwise edged (310), then cut (400), first with stock > 0 wins, otherwise
# cut from raw.
RULES = [("300", "Finished, no action"), ("310", "Drill"), ("400", "Edge and drill")]
FALLBACK = "Cut, edge and drill"
NOT_FOUND = "SKU NOT FOUND"


def check_rules_match_csv():
    with open(REPO / "db/data/routing.csv", newline="") as f:
        rows = sorted(list(csv.reader(f))[1:], key=lambda r: int(r[3]))
    got = [(r[0].strip(), r[2].strip()) for r in rows]
    if got != RULES + [("none", FALLBACK)]:
        sys.exit(f"routing.csv disagrees with the hand-written rule: {got}")


def load_stock():
    """8-digit body -> {"300": qty, "310": qty, "400": qty}."""
    stock = {}
    with open(REPO / "db/data/stock-sheet.csv", newline="") as f:
        for row in list(csv.reader(f))[1:]:
            for sku, _desc, qty in (row[0:3], row[3:6], row[6:9]):
                sku = sku.strip()
                stock.setdefault(sku[3:], {})[sku[:3]] = int(qty)
    return stock


def next_step(sku, qty, stock):
    levels = stock.get(str(sku).strip()[3:])
    if levels is None:
        return NOT_FOUND
    finished = levels.get("300", 0)
    if finished > 0 and finished >= (qty or 0):
        return RULES[0][1]
    for prefix, step in RULES[1:]:
        if levels.get(prefix, 0) > 0:
            return step
    return FALLBACK


def main():
    args = [a for a in sys.argv[1:] if a != "--write"]
    if len(args) != 2:
        sys.exit(__doc__)
    in_path, out_path = args
    check_rules_match_csv()
    stock = load_stock()

    rows = list(openpyxl.load_workbook(in_path).active.iter_rows(values_only=True))[1:]
    steps = [(sku, desc, qty, next_step(sku, qty, stock)) for sku, desc, qty in rows]
    for sku, _desc, qty, step in steps:
        if step == RULES[0][1]:
            print(f"{sku}  dropped: finished stock covers qty {qty}")
    expected = [(sku, desc, qty, step if step == NOT_FOUND else f"{qty} to {step}")
                for sku, desc, qty, step in steps if step != RULES[0][1]]

    if "--write" in sys.argv:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Results"
        ws.append(["sku", "description", "qty", "actions"])
        for r in expected:
            ws.append(list(r))
        wb.save(out_path)
        print(f"wrote {out_path} ({len(expected)} rows)")
        return

    actual = list(openpyxl.load_workbook(out_path).active.iter_rows(values_only=True))[1:]
    bad = 0
    for exp, act in zip(expected, actual):
        ok = tuple(act) == exp
        bad += not ok
        print(f"{exp[0]}  {exp[3]:28}  {'OK' if ok else f'MISMATCH (file says {act[3]!r})'}")
    if len(expected) != len(actual):
        bad += 1
        print(f"row count differs: input {len(expected)}, expected-output {len(actual)}")
    print("ALL MATCH" if not bad else f"{bad} MISMATCH(ES)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
