#!/usr/bin/env bash
# Install tabletmode: the binary, the systemd service and the GNOME Shell
# extension (system-wide, for all users).
# Usage: ./install.sh   (asks for sudo when needed)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="tabletmode@local"

# Build as the regular user, before escalating to root.
if [ ! -x "$DIR/tabletmode" ]; then
    if [ "$(id -u)" -eq 0 ]; then
        echo "Missing $DIR/tabletmode. Build it first as a regular user: make build" >&2
        exit 1
    fi
    command -v go >/dev/null || { echo "Go is required to build tabletmode (https://go.dev/dl/)." >&2; exit 1; }
    echo "Building tabletmode..."
    (cd "$DIR" && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o tabletmode .)
fi

if [ "$(id -u)" -ne 0 ]; then
    exec sudo "$0" "$@"
fi

LOG_DIR="$DIR/logs"
# 0777: both the daemon (root) and the extension (the user's gnome-shell) write here.
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
echo "Installation complete."
echo "  Logs:    $LOG_DIR (daemon.log, extension.log)"
echo "  Service: $(systemctl is-active tabletmode.service)"
echo "  Try it:  tabletmode status | tabletmode on | tabletmode off"
echo
echo "To show the toggle in GNOME: LOG OUT and log back in (required on Wayland"
echo "for GNOME Shell to load a new extension), then run:"
echo "  gnome-extensions enable $UUID"
echo "(each user enables it once, or use the Extensions app)."
