set -e
cd /app
python3 - <<'PY'
import calc
assert calc.sum_first(1) == 1, f"sum_first(1) = {calc.sum_first(1)}"
assert calc.sum_first(100) == 5050, f"sum_first(100) = {calc.sum_first(100)}"
print("OK")
PY
