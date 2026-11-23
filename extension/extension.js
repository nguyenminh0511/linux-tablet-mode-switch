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

const LOCK_KEY = 'orientation-lock';
// Thời gian chờ để mutter nhận thay đổi orientation-lock và đọc lại cảm biến
// trước khi công tắc tablet mode được gửi đi.
const UNLOCK_SYNC_MS = 300;

const DISPLAY_NAME = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_PATH = '/org/gnome/Mutter/DisplayConfig';

// Việc xoay màn hình trong tablet mode do chính mutter làm. Kernel đã khai báo
// panel_orientation=right_side_up cho eDP-1, nên mutter quy đổi đúng hướng cảm
// biến: right-up -> ngang (transform 0), normal -> 1, left-up -> 2, bottom-up -> 3.
//
// Mutter chỉ cập nhật hướng cảm biến khi orientation-lock=false. Nếu khóa đang
// bật lúc vào tablet mode, mutter áp hướng nó nhớ từ trước; khóa từ lúc đăng
// nhập thì hướng đó là UNDEFINED, coi như "normal", nên màn hình xoay dọc sai.
// Vì vậy extension giữ orientation-lock=false, chỉ bật khi người dùng bấm
// Rotation Lock (mutter giữ nguyên hướng hiện tại).
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

    // Gọi trước khi bật tablet mode: mở khóa và chờ mutter đọc lại cảm biến.
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

    // Gọi khi tắt tablet mode: mở khóa và đưa màn hình về ngang nếu đang xoay
    // (mutter không tự xoay lại khi ra khỏi tablet mode).
    stop() {
        this._clearTimer();
        this.setLocked(false);
        this._resetTransform();
    }

    // Khi extension bị tắt (kể cả lúc đăng xuất): trả khóa về mặc định của
    // GNOME để lần đăng nhập sau mutter vẫn theo dõi cảm biến.
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
                                log('đã đưa màn hình về ngang (transform 0)');
                            } catch (e) {
                                log(`LỖI: không xoay được màn hình: ${e}`);
                            }
                        });
                } catch (e) {
                    log(`LỖI: đọc cấu hình màn hình lỗi: ${e}`);
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
        // Mở khóa ngay từ đầu để mutter luôn biết hướng thật của cảm biến, kể
        // cả khi tablet mode được bật từ dòng lệnh.
        this._rotation.setLocked(false);
        toggle.beforeOn = send => this._rotation.prepare(send);
        const lock = new RotationLockToggle(this._rotation);
        toggle.bind_property('checked', lock, 'visible', GObject.BindingFlags.SYNC_CREATE);
        // Nút Auto Rotate gốc của GNOME trùng chức năng với nút Rotation Lock
        // (cùng đổi orientation-lock), nên ẩn hẳn và giữ ẩn mỗi khi GNOME cố
        // hiện lại.
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
            if (!toggle.checked) {
                lock.checked = false;
                this._rotation.stop();
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
