set -e
mkdir -p /app
cat > /app/calc.py <<'PY'
def sum_first(n):
    total = 0
    for i in range(1, n):
        total += i
    return total
PY
echo "环境就绪"
