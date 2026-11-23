import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BIN = '/usr/local/bin/tabletmode';

// install.sh thay @LOG_DIR@ bằng thư mục logs của dự án. Nếu chưa thay thì chỉ
// ghi ra journal (journalctl -b /usr/bin/gnome-shell | grep tabletmode).
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
        console.error(`tabletmode: không ghi được log: ${e}`);
    }
}

// Cảm biến của GPD Pocket 4 báo "right-up" khi máy đặt thẳng (hướng ngang
// bình thường), nên phải bù lệch. Giá trị là transform của Mutter
// (0 = bình thường, 1 = 90, 2 = 180, 3 = 270).
const ORIENTATION_TO_TRANSFORM = {
    'right-up': 0,
    'normal': 1,
    'left-up': 2,
    'bottom-up': 3,
};

const DEBOUNCE_MS = 400;

const SENSOR_NAME = 'net.hadess.SensorProxy';
const SENSOR_PATH = '/net/hadess/SensorProxy';
const DISPLAY_NAME = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_PATH = '/org/gnome/Mutter/DisplayConfig';

// Tự xoay màn hình theo cảm biến khi ở tablet mode. Khi bật, khóa xoay của
// GNOME được đặt true để GNOME không tự xoay lệch; khi tắt, khôi phục khóa cũ
// và đưa màn hình về hướng ngang.
class RotationController {
    constructor() {
        this._active = false;
        this._sensor = null;
        this._sensorId = 0;
        this._settings = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.peripherals.touchscreen',
        });
        this._savedLock = null;
        this._current = null;
        this._timer = 0;
        this._busy = false;
        this._queued = null;
        this.locked = false;
    }

    setLocked(locked) {
        log(`khóa xoay: ${locked ? 'BẬT' : 'tắt'}`);
        this.locked = locked;
        if (!locked)
            this._update();
    }

    start() {
        if (this._active)
            return;
        log('RotationController.start');
        this._active = true;
        this._current = null;
        this._savedLock = this._settings.get_boolean('orientation-lock');
        this._settings.set_boolean('orientation-lock', true);

        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            SENSOR_NAME, SENSOR_PATH, SENSOR_NAME, null, (_o, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    if (!this._active) {
                        return;
                    }
                    this._sensor = proxy;
                    log(`đã kết nối iio-sensor-proxy, hướng hiện tại: ${proxy.get_cached_property('AccelerometerOrientation')?.unpack()}`);
                    this._sensorId = proxy.connect('g-properties-changed', () => this._update());
                    proxy.call('ClaimAccelerometer', null, Gio.DBusCallFlags.NONE, -1, null,
                        () => {
                            log('đã claim accelerometer');
                            this._update();
                        });
                } catch (e) {
                    log(`LỖI: không mở được iio-sensor-proxy: ${e}`);
                }
            });
    }

    stop() {
        if (!this._active)
            return;
        log('RotationController.stop');
        this._active = false;
        this._clearTimer();
        this._queued = null;
        if (this._sensor) {
            this._sensor.disconnect(this._sensorId);
            this._sensor.call('ReleaseAccelerometer', null, Gio.DBusCallFlags.NONE, -1, null, null);
            this._sensor = null;
        }
        if (this._savedLock !== null)
            this._settings.set_boolean('orientation-lock', this._savedLock);
        this._savedLock = null;
        this._apply(0);
    }

    _clearTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
    }

    // Cảm biến mới được claim thường báo hướng tạm thời trước khi ổn định, nên
    // chỉ áp dụng sau khi giá trị không đổi trong DEBOUNCE_MS.
    _update() {
        if (!this._active || !this._sensor || this.locked)
            return;
        this._clearTimer();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._timer = 0;
            if (!this._active || !this._sensor || this.locked)
                return GLib.SOURCE_REMOVE;
            const v = this._sensor.get_cached_property('AccelerometerOrientation');
            const t = ORIENTATION_TO_TRANSFORM[v?.unpack()];
            log(`cảm biến ổn định: ${v?.unpack()} -> transform ${t} (đang là ${this._current})`);
            if (t !== undefined)
                this._apply(t);
            return GLib.SOURCE_REMOVE;
        });
    }

    _apply(transform) {
        if (this._busy) {
            log(`đang bận, xếp hàng transform ${transform}`);
            this._queued = transform;
            return;
        }
        if (this._current === transform)
            return;
        this._busy = true;
        const done = () => {
            this._busy = false;
            const q = this._queued;
            this._queued = null;
            if (q !== null && q !== this._current)
                this._apply(q);
        };
        Gio.DBus.session.call(DISPLAY_NAME, DISPLAY_PATH, DISPLAY_NAME, 'GetCurrentState',
            null, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    const [serial, monitors, logical] = conn.call_finish(res).recursiveUnpack();
                    const modeOf = new Map();
                    for (const [[connector], modes] of monitors) {
                        for (const mode of modes) {
                            if (mode[6]['is-current'])
                                modeOf.set(connector, mode[0]);
                        }
                    }
                    const out = logical.map(([x, y, scale, , primary, mons]) => {
                        const list = mons.map(([c]) => [c, modeOf.get(c), {}]);
                        return [x, y, scale, transform, primary, list];
                    });
                    const args = new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, out, {}]);
                    Gio.DBus.session.call(DISPLAY_NAME, DISPLAY_PATH, DISPLAY_NAME,
                        'ApplyMonitorsConfig', args, null, Gio.DBusCallFlags.NONE, -1, null,
                        (c2, r2) => {
                            try {
                                c2.call_finish(r2);
                                this._current = transform;
                                log(`đã xoay màn hình: transform ${transform}`);
                            } catch (e) {
                                log(`LỖI: không xoay được màn hình: ${e}`);
                            }
                            done();
                        });
                } catch (e) {
                    log(`LỖI: đọc cấu hình màn hình lỗi: ${e}`);
                    done();
                }
            });
    }
}

function run(cmd, callback) {
    if (cmd !== 'status')
        log(`chạy: tabletmode ${cmd}`);
    try {
        const proc = Gio.Subprocess.new(
            [BIN, cmd],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                const ok = p.get_successful();
                if (cmd !== 'status' || !ok)
                    log(`tabletmode ${cmd} -> ${ok ? stdout.trim() : 'THẤT BẠI'}`);
                callback(ok ? stdout.trim() : null);
            } catch (e) {
                log(`LỖI: ${e}`);
                callback(null);
            }
        });
    } catch (e) {
        log(`LỖI: ${e}`);
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
        this.connect('clicked', () => {
            run('toggle', out => this._apply(out));
        });
    }

    refresh(quiet = false) {
        run('status', out => this._apply(out, quiet));
    }

    _apply(out, quiet = false) {
        if (out === 'on' || out === 'off')
            this.checked = out === 'on';
        else if (!quiet)
            Main.notify('Tablet Mode', 'Không điều khiển được dịch vụ tabletmode.');
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
        const lock = new RotationLockToggle(this._rotation);
        toggle.bind_property('checked', lock, 'visible', GObject.BindingFlags.SYNC_CREATE);
        // Nút Auto Rotate gốc của GNOME không còn đúng (tool tự quản lý khóa
        // xoay), nên ẩn hẳn và giữ ẩn mỗi khi GNOME cố hiện lại.
        this._stock = this._findStockRotation(lock);
        log(`nút Auto Rotate gốc: ${this._stock ? `tìm thấy (${this._stock.constructor.name}, title=${this._stock.title}, icon=${this._stock.iconName})` : 'KHÔNG tìm thấy'}`);
        if (this._stock) {
            this._stock.hide();
            log('đã ẩn nút Auto Rotate gốc');
            this._stockId = this._stock.connect('notify::visible', () => {
                if (this._stock.visible) {
                    log('GNOME hiện lại nút Auto Rotate gốc, ẩn lại');
                    this._stock.hide();
                }
            });
        }
        toggle.connect('notify::checked', () => {
            log(`tablet mode đổi sang: ${toggle.checked ? 'on' : 'off'}`);
            if (toggle.checked) {
                this._rotation.start();
            } else {
                this._rotation.stop();
                lock.checked = false;
            }
        });
        // Theo dõi cả khi tablet mode được đổi từ dòng lệnh.
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
        log(`tìm nút gốc: _autoRotate=${!!qs._autoRotate} _rotation=${!!qs._rotation}`);
        if (item)
            return item;
        log(`quét lưới: ${qs.menu._grid.get_children().map(c => `${c.constructor.name}[${c.title ?? ''}|${c.iconName ?? ''}]`).join(', ')}`);
        // Dự phòng: tìm trong lưới quick settings theo icon/tiêu đề.
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
        this._rotation.stop();
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
