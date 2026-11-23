#!/usr/bin/env bash
# Cài tabletmode: file nhị phân, dịch vụ systemd, extension GNOME (cho mọi user).
# Chạy: ./install.sh   (sẽ tự hỏi sudo)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(id -u)" -ne 0 ]; then
    exec sudo "$0" "$@"
fi

UUID="tabletmode@local"
[ -x "$DIR/tabletmode" ] || { echo "Chưa có file $DIR/tabletmode. Build trước: CGO_ENABLED=0 go build -o tabletmode ."; exit 1; }

LOG_DIR="$DIR/logs"
# 0777: daemon (root) và extension (user trong gnome-shell) cùng ghi được.
install -d -m 0777 "$LOG_DIR"
chmod 0777 "$LOG_DIR"

install -m 0755 "$DIR/tabletmode" /usr/local/bin/tabletmode
sed "s|@LOG_DIR@|$LOG_DIR|g" "$DIR/tabletmode.service" > /etc/systemd/system/tabletmode.service
chmod 0644 /etc/systemd/system/tabletmode.service
install -d -m 0755 "/usr/share/gnome-shell/extensions/$UUID"
install -m 0644 "$DIR/extension/metadata.json" "/usr/share/gnome-shell/extensions/$UUID/"
sed "s|@LOG_DIR@|$LOG_DIR|g" "$DIR/extension/extension.js" \
    > "/usr/share/gnome-shell/extensions/$UUID/extension.js"
chmod 0644 "/usr/share/gnome-shell/extensions/$UUID/extension.js"

systemctl daemon-reload
systemctl enable --now tabletmode.service

echo
echo "Đã cài xong."
echo "  Log: $LOG_DIR (daemon.log, extension.log)"
echo "  Dịch vụ: $(systemctl is-active tabletmode.service)"
echo "  Thử nhanh: tabletmode status | tabletmode on | tabletmode off"
echo "Để hiện nút trong GNOME: ĐĂNG XUẤT rồi đăng nhập lại (Wayland cần việc này để nhận extension mới),"
echo "sau đó chạy:  gnome-extensions enable $UUID"
echo "(mỗi user cần bật extension một lần, hoặc bật trong ứng dụng Extensions)."
