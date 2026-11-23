import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BIN = '/usr/local/bin/tabletmode';

function run(cmd, callback) {
    try {
        const proc = Gio.Subprocess.new(
            [BIN, cmd],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                callback(p.get_successful() ? stdout.trim() : null);
            } catch (e) {
                console.error(`tabletmode: ${e}`);
                callback(null);
            }
        });
    } catch (e) {
        console.error(`tabletmode: ${e}`);
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

    refresh() {
        run('status', out => this._apply(out));
    }

    _apply(out) {
        if (out === 'on' || out === 'off')
            this.checked = out === 'on';
        else
            Main.notify('Tablet Mode', 'Không điều khiển được dịch vụ tabletmode.');
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
        this.quickSettingsItems.push(toggle);
        this._toggle = toggle;
    }

    refresh() {
        this._toggle.refresh();
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class TabletModeExtension extends Extension {
    enable() {
        this._indicator = new TabletIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._indicator.refresh();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
