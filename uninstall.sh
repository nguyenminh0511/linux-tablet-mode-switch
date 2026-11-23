#!/usr/bin/env bash
# Gỡ hoàn toàn tabletmode: dịch vụ, file nhị phân, extension, socket.
# Không xóa thư mục mã nguồn ~/tablet-mode (xóa tay nếu muốn).
# Chạy: ./uninstall.sh   (sẽ tự hỏi sudo)
set -uo pipefail

UUID="tabletmode@local"

# Tắt extension cho user đang chạy (nếu có phiên GNOME), không bắt buộc.
if [ "$(id -u)" -ne 0 ]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    exec sudo "$0" "$@"
fi
if [ -n "${SUDO_USER:-}" ]; then
    sudo -u "$SUDO_USER" gnome-extensions disable "$UUID" 2>/dev/null || true
fi

systemctl disable --now tabletmode.service 2>/dev/null || true
rm -f /etc/systemd/system/tabletmode.service
rm -f /usr/local/bin/tabletmode
rm -rf "/usr/share/gnome-shell/extensions/$UUID"
rm -rf /run/tabletmode
systemctl daemon-reload

echo "Đã gỡ tabletmode (dịch vụ, binary, extension)."
echo "Thiết bị ảo biến mất ngay khi dịch vụ dừng. Đăng xuất/đăng nhập lại để GNOME bỏ hẳn nút."
echo "Nếu muốn xóa cả mã nguồn: rm -rf ~/tablet-mode"
