set -e
test -f /etc/myapp.conf || { echo "文件不存在"; exit 1; }
expected=$(printf 'host=127.0.0.1\nport=8080\nmode=prod')
actual=$(sed -e '$ { /^$/d }' /etc/myapp.conf)
[ "$actual" = "$expected" ] || { echo "内容不符"; printf '%s\n' "$actual"; exit 1; }
echo "OK"
