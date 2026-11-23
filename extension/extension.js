import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BIN = '/usr/local/bin/tabletmode';

// install.sh replaces @LOG_DIR@ with the project's logs directory. If it was not
// replaced, messages only go to the journal (journalctl -b /usr/bin/gnome-shell | grep tabletmode).
const LOG_DIR = '@LOG_DIR@';
const MAX_LOG_SIZE = 5 * 1024 * 1024;

function log(msg) {
    console.log(`tabletmode: ${msg}`);
    if (LOG_DIR.startsWith('@'))
        return;
    try {
        const dir = Gio.File.new_for_path(LOG_DIR);
        const file = dir.get_child('extension.log');
        if (file.query_exists(null) &&
            file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size() > MAX_LOG_SIZE)
            file.move(dir.get_child('extension.log.1'), Gio.FileCopyFlags.OVERWRITE, null, null);
        const out = file.append_to(Gio.FileCreateFlags.NONE, null);
        const ts = GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M:%S');
        out.write_all(`${ts} [extension] ${msg}\n`, null);
        out.close(null);
    } catch (e) {
        console.error(`tabletmode: cannot write log: ${e}`);
    }
}

const LOCK_KEY = 'orientation-lock';
// Time to let mutter pick up the orientation-lock change and re-read the sensor
// before the tablet mode switch is sent.
const UNLOCK_SYNC_MS = 300;

const DISPLAY_NAME = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_PATH = '/org/gnome/Mutter/DisplayConfig';

// Screen rotation in tablet mode is done by mutter itself. The kernel declares
// panel_orientation=right_side_up for eDP-1, so mutter maps the sensor
// orientation correctly: right-up -> landscape (transform 0), normal -> 1,
// left-up -> 2, bottom-up -> 3.
//
// Mutter only tracks the sensor orientation while orientation-lock=false. If
// the lock is on when tablet mode is entered, mutter applies the orientation it
// remembered earlier; if the lock has been on since login, that orientation is
// UNDEFINED, treated as "normal", and the screen wrongly rotates to portrait.
// So the extension keeps orientation-lock=false and only sets it when the user
// presses Rotation Lock (mutter then keeps the current orientation).
class RotationController {
    constructor() {
        this._settings = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.peripherals.touchscreen',
        });
        this._timer = 0;
    }

    setLocked(locked) {
        if (this._settings.get_boolean(LOCK_KEY) === locked)
            return;
        this._settings.set_boolean(LOCK_KEY, locked);
        log(`orientation-lock=${locked}`);
    }

    // Called before enabling tablet mode: unlock and wait for mutter to re-read the sensor.
    prepare(callback) {
        this._clearTimer();
        if (!this._settings.get_boolean(LOCK_KEY)) {
            callback();
            return;
        }
        this.setLocked(false);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UNLOCK_SYNC_MS, () => {
            this._timer = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Called when tablet mode is turned off: unlock and restore landscape if the
    // screen is rotated (mutter does not rotate back when leaving tablet mode).
    stop() {
        this._clearTimer();
        this.setLocked(false);
        this._resetTransform();
    }

    // Called when the extension is disabled (including at logout): restore the
    // GNOME default so mutter keeps tracking the sensor on the next login.
    destroy() {
        this._clearTimer();
        this.setLocked(false);
    }

    _clearTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    _resetTransform() {
        Gio.DBus.session.call(DISPLAY_NAME, DISPLAY_PATH, DISPLAY_NAME, 'GetCurrentState',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    const [serial, monitors, logical] = conn.call_finish(res).recursiveUnpack();
                    if (logical.every(lm => lm[3] === 0))
                        return;
                    const modeOf = new Map();
                    for (const [[connector], modes] of monitors) {
                        for (const mode of modes) {
                            if (mode[6]['is-current'])
                                modeOf.set(connector, mode[0]);
                        }
                    }
                    const out = logical.map(([x, y, scale, , primary, mons]) => {
                        const list = mons.map(([c]) => [c, modeOf.get(c), {}]);
                        return [x, y, scale, 0, primary, list];
                    });
                    const args = new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, out, {}]);
                    Gio.DBus.session.call(DISPLAY_NAME, DISPLAY_PATH, DISPLAY_NAME,
                        'ApplyMonitorsConfig', args, null, Gio.DBusCallFlags.NONE, -1, null,
                        (c2, r2) => {
                            try {
                                c2.call_finish(r2);
                                log('restored landscape (transform 0)');
                            } catch (e) {
                                log(`ERROR: cannot rotate the screen: ${e}`);
                            }
                        });
                } catch (e) {
                    log(`ERROR: cannot read the display configuration: ${e}`);
                }
            });
    }
}

function run(cmd, callback) {
    if (cmd !== 'status')
        log(`running: tabletmode ${cmd}`);
    try {
        const proc = Gio.Subprocess.new(
            [BIN, cmd],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                const ok = p.get_successful();
                if (cmd !== 'status' || !ok)
                    log(`tabletmode ${cmd} -> ${ok ? stdout.trim() : 'FAILED'}`);
                callback(ok ? stdout.trim() : null);
            } catch (e) {
                log(`ERROR: ${e}`);
                callback(null);
            }
        });
    } catch (e) {
        log(`ERROR: ${e}`);
        callback(null);
    }
}

const TabletToggle = GObject.registerClass(
class TabletToggle extends QuickToggle {
    _init() {
        super._init({
            title: 'Tablet Mode',
            iconName: 'input-tablet-symbolic',
            toggleMode: false,
        });
        this.beforeOn = null;
        this.connect('clicked', () => {
            const send = () => run('toggle', out => this._apply(out));
            if (!this.checked && this.beforeOn)
                this.beforeOn(send);
            else
                send();
        });
    }

    refresh(quiet = false) {
        run('status', out => this._apply(out, quiet));
    }

    _apply(out, quiet = false) {
        if (out === 'on' || out === 'off')
            this.checked = out === 'on';
        else if (!quiet)
            Main.notify('Tablet Mode', 'Cannot control the tabletmode service.');
    }
});

const RotationLockToggle = GObject.registerClass(
class RotationLockToggle extends QuickToggle {
    _init(rotation) {
        super._init({
            title: 'Rotation Lock',
            iconName: 'rotation-locked-symbolic',
            toggleMode: true,
        });
        this.connect('notify::checked', () => rotation.setLocked(this.checked));
    }
});

const TabletIndicator = GObject.registerClass(
class TabletIndicator extends SystemIndicator {
    _init() {
        super._init();
        this._indicator = this._addIndicator();
        this._indicator.iconName = 'input-tablet-symbolic';

        const toggle = new TabletToggle();
        toggle.bind_property('checked', this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this._rotation = new RotationController();
        // Unlock right away so mutter always knows the real sensor orientation,
        // even when tablet mode is turned on from the command line.
        this._rotation.setLocked(false);
        toggle.beforeOn = send => this._rotation.prepare(send);
        const lock = new RotationLockToggle(this._rotation);
        toggle.bind_property('checked', lock, 'visible', GObject.BindingFlags.SYNC_CREATE);
        // GNOME's stock Auto Rotate toggle duplicates our Rotation Lock toggle
        // (both change orientation-lock), so hide it and keep it hidden whenever
        // GNOME tries to show it again.
        this._stock = this._findStockRotation(lock);
        log(`stock Auto Rotate toggle: ${this._stock ? `found (${this._stock.constructor.name}, title=${this._stock.title}, icon=${this._stock.iconName})` : 'NOT found'}`);
        if (this._stock) {
            this._stock.hide();
            log('hid the stock Auto Rotate toggle');
            this._stockId = this._stock.connect('notify::visible', () => {
                if (this._stock.visible) {
                    log('GNOME showed the stock Auto Rotate toggle again, hiding it');
                    this._stock.hide();
                }
            });
        }
        toggle.connect('notify::checked', () => {
            log(`tablet mode changed to: ${toggle.checked ? 'on' : 'off'}`);
            if (!toggle.checked) {
                lock.checked = false;
                this._rotation.stop();
            }
        });
        // Also track changes made from the command line.
        this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            toggle.refresh(true);
            return GLib.SOURCE_CONTINUE;
        });
        this.quickSettingsItems.push(toggle, lock);
        this._toggle = toggle;
    }

    _findStockRotation(ours) {
        const qs = Main.panel.statusArea.quickSettings;
        const named = qs._autoRotate ?? qs._rotation;
        const item = named?.quickSettingsItems?.[0];
        log(`looking for stock toggle: _autoRotate=${!!qs._autoRotate} _rotation=${!!qs._rotation}`);
        if (item)
            return item;
        log(`scanning grid: ${qs.menu._grid.get_children().map(c => `${c.constructor.name}[${c.title ?? ''}|${c.iconName ?? ''}]`).join(', ')}`);
        // Fallback: search the quick settings grid by icon/title.
        const icons = ['rotation-allowed-symbolic', 'rotation-locked-symbolic'];
        return qs.menu._grid.get_children().find(c =>
            c !== ours && c instanceof QuickToggle &&
            (c.title === 'Auto Rotate' || icons.includes(c.iconName))) ?? null;
    }

    refresh() {
        this._toggle.refresh();
    }

    destroy() {
        if (this._poll)
            GLib.source_remove(this._poll);
        this._poll = 0;
        this._rotation.destroy();
        if (this._stock) {
            this._stock.disconnect(this._stockId);
            this._stock.show();
            this._stock = null;
        }
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class TabletModeExtension extends Extension {
    enable() {
        log('extension enable');
        this._indicator = new TabletIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._indicator.refresh();
    }

    disable() {
        log('extension disable');
        this._indicator?.destroy();
        this._indicator = null;
    }
}
