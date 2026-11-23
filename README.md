# tabletmode

A virtual **Tablet Mode switch** for Linux convertibles whose hardware switch is missing or not exposed. It was built and tested on the **GPD Pocket 4**, and is designed to work on other Linux touchscreen devices too (see [Compatibility](#compatibility)).

Flip the switch from GNOME Quick Settings or from the command line. GNOME then behaves as it does on a real tablet: the screen auto-rotates with the accelerometer (if the device has one) and the on-screen keyboard is enabled.

![GNOME](https://img.shields.io/badge/GNOME-46%20%7C%2047%20%7C%2048-4a86cf) ![Go](https://img.shields.io/badge/Go-stdlib%20only-00add8) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Virtual `SW_TABLET_MODE` input device** created through `/dev/uinput`. libinput, mutter and GNOME Shell see it as real hardware.
- **Quick Settings toggles**:
  - **Tablet Mode** turns tablet mode on or off.
  - **Rotation Lock** keeps the current orientation. It is shown only while tablet mode is on.
- **Correct rotation from the start.** Turning tablet mode on does not briefly flip the screen to portrait (see [How it works](#how-it-works)).
- **Command-line control**: `tabletmode on | off | toggle | status`.
- **On-screen keyboard** is enabled with tablet mode and disabled when you leave it.
- **Small and hardened**:
  - A single static Go binary with no dependencies outside the standard library.
  - A sandboxed systemd unit: `ProtectSystem=strict`, access to `/dev/uinput` only, `AF_UNIX` sockets only.
  - Only users with an active **local** login session can change the mode. Commands from SSH sessions are rejected.
  - Switching tablet mode on is rate-limited. Switching it off always works.

## Requirements

| Component | Version |
|-----------|---------|
| Linux kernel | with `uinput` (`/dev/uinput`) |
| systemd | with `systemd-logind` |
| GNOME Shell | 46, 47 or 48 (Wayland recommended) |
| iio-sensor-proxy | for auto-rotation |
| Go | 1.27 or newer, **only to build from source** |

## Compatibility

tabletmode does not check the device model. It runs on **any Linux machine** with GNOME 46–48 and systemd. How useful it is depends on the hardware.

| Device | What works |
|--------|------------|
| Touchscreen **and** accelerometer (2-in-1, tablet, GPD Pocket 4) | Everything: auto-rotation, Rotation Lock, on-screen keyboard |
| Touchscreen, **no** accelerometer (laptop with a touch panel, external touch monitor) | Toggle and on-screen keyboard only. The screen does not rotate, so Rotation Lock does nothing. |
| No touchscreen | Installs and runs, but there is little reason to use it |

**Does auto-rotation work on my device?** Check these two things:

1. **The device has an accelerometer.** Run `monitor-sensor` (from `iio-sensor-proxy`) and tilt the device. You should see `Accelerometer orientation changed`.
2. **The rotation direction is correct.** Rotation is done by mutter. It depends on two settings for your device:
   - the accelerometer mount matrix (udev hwdb);
   - the panel orientation that the kernel reports (`panel_orientation`).

   If GNOME's own Auto Rotate already rotates the screen the right way on your device, tabletmode will too. If the screen rotates the wrong way, fix the sensor setup first. tabletmode does not remap orientations.

**Not supported:**

- Windows. Windows has its own tablet mode.
- Desktops other than GNOME, such as KDE Plasma or XFCE. The virtual switch may still be detected there, but the Quick Settings extension is GNOME-only and this setup is untested.
- Systems without systemd.

**Tested devices:**

| Device | Distro / GNOME | Status |
|--------|----------------|--------|
| GPD Pocket 4 | GNOME 46, Wayland | ✅ Fully working |

Tested on another device? Please open an issue or a pull request to add it to this table.

## Installation

### From source

```bash
git clone https://github.com/nguyenminh0511/linux-tablet-mode-switch.git
cd linux-tablet-mode-switch
./install.sh          # builds the binary, then asks for sudo to install
```

### From a release tarball

Download `tabletmode-<version>.tar.gz` from the [Releases page](https://github.com/nguyenminh0511/linux-tablet-mode-switch/releases). It contains a prebuilt binary, so you do not need Go:

```bash
tar xzf tabletmode-<version>.tar.gz
cd tabletmode-<version>
./install.sh
```

### Enable the GNOME extension

GNOME Shell on Wayland loads new extensions only at login, so:

1. **Log out and log back in.**
2. Enable the extension once per user:

   ```bash
   gnome-extensions enable tabletmode@local
   ```

   You can also enable it in the **Extensions** app.

A **Tablet Mode** toggle now appears in Quick Settings.

### What gets installed

| Path | Purpose |
|------|---------|
| `/usr/local/bin/tabletmode` | daemon and CLI |
| `/etc/systemd/system/tabletmode.service` | system service that owns the virtual device |
| `/usr/share/gnome-shell/extensions/tabletmode@local/` | Quick Settings extension |
| `<source dir>/logs/` | `daemon.log` and `extension.log`, rotated at 5 MB |

## Usage

```bash
tabletmode status     # prints "on" or "off"
tabletmode on         # enter tablet mode
tabletmode off        # leave tablet mode
tabletmode toggle
```

In Quick Settings:

- **Tablet Mode** turns tablet mode on or off.
- **Rotation Lock** freezes the screen in its current orientation. Switch it off to follow the accelerometer again.

GNOME's stock *Auto Rotate* toggle is hidden while the extension is enabled, because it does the same thing as **Rotation Lock**. It comes back when you disable the extension.

## How it works

```
┌──────────────┐  unix socket   ┌────────────────────┐  uinput   ┌──────────────┐
│ CLI / GNOME  │ ─────────────► │ tabletmode daemon  │ ────────► │ SW_TABLET_   │
│  extension   │ on/off/status  │ (root, systemd)    │           │ MODE device  │
└──────────────┘                └────────────────────┘           └──────┬───────┘
                                                                        │ libinput
                                                                        ▼
                                                          mutter: rotation, OSK, ...
```

- **Daemon.** `tabletmode daemon` runs as root under systemd. It creates the virtual switch and listens on `/run/tabletmode/tabletmode.sock`. For every request it:
  1. reads the caller's UID with `SO_PEERCRED`;
  2. checks that the UID has an active session on a local seat, using the `systemd-logind` files in `/run/systemd/sessions`;
  3. logs the request.
- **Rotation.** Mutter rotates the screen itself once tablet mode is on. However, mutter reads the accelerometer only while `orientation-lock` is `false`. If the lock was on when tablet mode started, mutter applies a stale orientation: `UNDEFINED`, treated as *normal*, which shows up as portrait on panels mounted sideways. The extension prevents this:
  - it keeps `orientation-lock` off;
  - before sending the switch, it waits 300 ms so mutter can re-read the sensor;
  - it uses `orientation-lock` for its own **Rotation Lock** toggle;
  - when you leave tablet mode, it restores landscape.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| `cannot connect to the service` | `systemctl status tabletmode` and `journalctl -u tabletmode` |
| `permission denied (an active local login session is required)` | Run the command from your desktop session, not over SSH or from another TTY. |
| `too fast, try again in N s` | Switching on is rate-limited to once every 3 seconds. |
| No toggle in Quick Settings | Log out and back in, then run `gnome-extensions info tabletmode@local` and enable it. |
| Screen does not rotate | Check that `iio-sensor-proxy` is running (`monitor-sensor`) and that **Rotation Lock** is off. |

Logs:

```bash
tail -f logs/daemon.log logs/extension.log
journalctl -b /usr/bin/gnome-shell | grep tabletmode
```

## Uninstall

```bash
./uninstall.sh
```

This removes the service, the binary and the extension. The source directory, including `logs/`, is left untouched. Log out and back in to remove the toggle from GNOME completely.

## Development

```bash
make build    # static binary ./tabletmode
make test     # unit tests
make vet
make dist     # dist/tabletmode-<version>.tar.gz with a prebuilt binary
```

The project layout:

- `main.go`: daemon and CLI
- `logger.go`: file logging
- `extension/`: the GNOME Shell extension, plain GJS with no build step
- `install.sh`: replaces `@LOG_DIR@` in the service file and in the extension with the real log directory

Contributions are welcome, especially reports from other devices. Please include:

- the device model;
- the GNOME version;
- the output of `monitor-sensor` while the device is held upright.

## License

[MIT](LICENSE)
