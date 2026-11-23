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

install -m 0755 "$DIR/tabletmode" /usr/local/bin/tabletmode
install -m 0644 "$DIR/tabletmode.service" /etc/systemd/system/tabletmode.service
install -d -m 0755 "/usr/share/gnome-shell/extensions/$UUID"
install -m 0644 "$DIR/extension/metadata.json" "$DIR/extension/extension.js" \
    "/usr/share/gnome-shell/extensions/$UUID/"

systemctl daemon-reload
systemctl enable --now tabletmode.service

echo
echo "Đã cài xong."
echo "  Dịch vụ: $(systemctl is-active tabletmode.service)"
echo "  Thử nhanh: tabletmode status | tabletmode on | tabletmode off"
echo "Để hiện nút trong GNOME: ĐĂNG XUẤT rồi đăng nhập lại (Wayland cần việc này để nhận extension mới),"
echo "sau đó chạy:  gnome-extensions enable $UUID"
echo "(mỗi user cần bật extension một lần, hoặc bật trong ứng dụng Extensions)."
