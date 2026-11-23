#!/usr/bin/env bash
# Completely remove tabletmode: service, binary, extension and socket.
# The source directory (and its logs/ folder) is left untouched.
# Usage: ./uninstall.sh   (asks for sudo when needed)
set -uo pipefail

UUID="tabletmode@local"

# Disable the extension for the current user (if a GNOME session exists); optional.
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

echo "tabletmode removed (service, binary, extension)."
echo "The virtual device disappears as soon as the service stops."
echo "Log out and back in for GNOME to drop the toggle completely."
