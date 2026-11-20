// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

import {confirmUninstall} from './confirmation.js';
import {run, fmt} from './utils.js';
import {
    MANAGER_LABELS,
    setTranslator,
    detectSource,
    isProtected,
    buildUninstall,
    checkLocalUninstall,
    nativeUninstall,
    supportsDeleteData,
    supportsRemoveUnused,
} from './sources.js';

const LOG = 'App Uninstaller - BecabDev';

function shortLabel(src) {
    switch (src.kind) {
    case 'flatpak': return 'Flatpak';
    case 'snap': return 'Snap';
    case 'appimage': return 'AppImage';
    case 'steam': return 'Steam';
    case 'wine': return 'Wine';
    case 'waydroid': return 'Waydroid';
    case 'nix': return 'Nix';
    case 'guix': return 'Guix';
    case 'container': return _('container');
    case 'launcher': return src.localFiles ? _('standalone installation') : _('local launcher');
    case 'manual': return _('manual installation');
    case 'package': return MANAGER_LABELS[src.manager]?.split(' ')[0] ?? _('package');
    default: return null;
    }
}

const actorOf = item => item.actor ?? item;

export default class AppUninstallerExtension extends Extension {
    //package command can still be running when the extension is reenabled
    _busy = new Set();

    enable() {
        this._session = new Gio.Cancellable();
        this._settings = this.getSettings();
        this._sourceCache = new Map();
        this._menus = new Map();
        this._dialogs = new Set();

        setTranslator(s => this.gettext(s));
        this._patchAppMenu();

        this._settingsChangedId = this._settings.connect('changed', () => this._refreshAll());
        this._appSystem = Shell.AppSystem.get_default();
        this._installedChangedId = this._appSystem.connect('installed-changed',
            () => this._sourceCache.clear());
    }

    disable() {
        this._session.cancel();
        this._session = null;

        const proto = AppMenu.prototype;
        if (this._patchedOpen && proto.open === this._patchedOpen) {
            if (this._hadOwnOpen)
                proto.open = this._originalOpen;
            else
                delete proto.open;
        }
        this._patchedOpen = null;
        this._originalOpen = null;

        for (const dialog of this._dialogs) {
            dialog.close();
            if (this._dialogs.has(dialog))
                dialog.destroy();
        }

        for (const [menu, state] of this._menus) {
            menu.disconnect(state.destroyId);
            state.item?.destroy();
        }
        this._menus.clear();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._installedChangedId) {
            this._appSystem.disconnect(this._installedChangedId);
            this._installedChangedId = 0;
        }

        setTranslator(s => s);
        this._appSystem = null;
        this._settings = null;
        this._sourceCache = null;
        this._dialogs = null;
        this._menus = null;
    }

    _patchAppMenu() {
        const proto = AppMenu.prototype;
        const self = this;
        const session = this._session;
        const original = proto.open;

        // app icons can retain menu created befores the extension has enabled
        this._hadOwnOpen = Object.hasOwn(proto, 'open');
        this._originalOpen = original;
        this._patchedOpen = function (...args) {
            if (!session.is_cancelled()) {
                try {
                    self._decorate(this, this._app);
                } catch (e) {
                    console.error(`${LOG} ${e}\n${e.stack ?? ''}`);
                }
            }
            return original.apply(this, args);
        };
        proto.open = this._patchedOpen;
    }

    _decorate(menu, app) {
        const menus = this._menus;
        let state = menus.get(menu);
        if (!state) {
            if (!app)
                return;
            const destroyId = menu.connect('destroy', () => menus.delete(menu));
            state = {app, item: null, revision: 0, destroyId};
            menus.set(menu, state);
        }
        state.app = app;

        if (state.item && menu.box && !menu.box.contains(actorOf(state.item)))
            state.item.destroy();
        if (!state.item) {
            if (!app)
                return;
            const item = new PopupMenu.PopupMenuItem(_('Uninstall'));
            const session = this._session;
            item.connect('activate', () => {
                this._onActivate(state.app).catch(e => {
                    console.error(`${LOG} ${e}\n${e.stack ?? ''}`);
                    if (!session.is_cancelled())
                        Main.notifyError(_('Uninstall'), String(e.message ?? e));
                });
            });
            item.connect('destroy', () => {
                state.item = null;
            });
            menu.addMenuItem(item);
            state.item = item;
        }
        this._refresh(menu, state);
    }

    _place(menu, item) {
        const box = menu.box;
        if (!box)
            return;
        try {
            const mode = this._settings.get_string('item-position');
            const details = menu._detailsItem ? actorOf(menu._detailsItem) : null;
            if (mode === 'before-details' && details && box.contains(details))
                box.set_child_below_sibling(actorOf(item), details);
            else
                box.set_child_above_sibling(actorOf(item), null);
        } catch (e) {
            console.warn(`${LOG} cannot position the item: ${e}`);
        }
    }

    _refreshAll() {
        this._sourceCache.clear();
        for (const [menu, state] of this._menus)
            this._refresh(menu, state);
    }

    _refresh(menu, state) {
        const {item, app} = state;
        if (!item)
            return;
        this._place(menu, item);

        const revision = ++state.revision;
        const info = app?.get_app_info?.();
        if (!info?.get_filename?.()) {
            item.visible = false;
            return;
        }

        item.label.text = _('Uninstall');
        item.visible = true;
        item.setSensitive(true);

        this._getSource(app.get_id(), info).then(src => {
            if (this._menus?.get(menu) !== state || state.item !== item || state.revision !== revision)
                return;
            this._applyToItem(item, src);
        }).catch(e => console.error(`${LOG} ${e}`));
    }

    _applyToItem(item, src) {
        const {allowed} = this._evaluate(src);
        if (!allowed) {
            item.visible = !this._settings.get_boolean('hide-unsupported');
            if (item.visible)
                item.label.text = _('Uninstall (unavailable)');
            return;
        }
        const short = this._settings.get_boolean('show-source-in-label') ? shortLabel(src) : null;
        item.visible = true;
        item.label.text = short ? fmt(_('Uninstall ({0})'), short) : _('Uninstall');
    }

    _getSource(id, info) {
        let promise = this._sourceCache.get(id);
        if (!promise) {
            const session = this._session;
            promise = detectSource(info, session).then(src => {
                if (!session.is_cancelled() && this._settings.get_boolean('debug-log'))
                    console.log(`${LOG} ${id}: ${JSON.stringify(src)}`);
                return src;
            }).catch(e => {
                console.error(`${LOG} detection failed for ${id}: ${e}\n${e.stack ?? ''}`);
                return {
                    kind: 'unknown', manager: null, label: _('Unknown source'), id, pkg: null,
                    desktopFile: info?.get_filename?.() ?? '', desktopId: id,
                    supported: false, reason: fmt(_('Detection error: {0}'), e.message ?? e),
                };
            });
            this._sourceCache.set(id, promise);
        }
        return promise;
    }

    _evaluate(src) {
        if (!src.supported)
            return {allowed: false, reason: src.reason ?? _('This installation source is unsupported.')};

        const blocked = isProtected(src,
            this._settings.get_strv('protected-apps'),
            this._settings.get_boolean('protect-system-apps'));
        if (blocked)
            return {allowed: false, reason: blocked};

        if (src.kind === 'launcher' && !this._settings.get_boolean('allow-launcher-removal')) {
            return {allowed: false,
                reason: _('Local launcher removal is off in Settings.')};
        }
        if (src.kind === 'manual' && !src.uninstaller &&
            !this._settings.get_boolean('allow-system-launcher-removal')) {
            return {allowed: false,
                reason: _('System launcher removal is off in Settings.')};
        }
        return {allowed: true, reason: null};
    }

    _canUninstall(src, name) {
        const {allowed, reason} = this._evaluate(src);
        if (!allowed) {
            Main.notifyError(fmt(_('Cannot uninstall “{0}”'), name),
                `${reason}\n${src.desktopFile ?? ''}`);
        }
        return allowed;
    }

    async _onActivate(app) {
        const session = this._session;
        if (!app || !session)
            return;

        const id = app.get_id();
        const name = app.get_name();
        if (this._busy.has(id)) {
            Main.notify(name, _('This app is already being uninstalled.'));
            return;
        }

        this._busy.add(id);
        try {
            const info = app.get_app_info();
            const src = await this._getSource(id, info);
            if (session.is_cancelled() || !this._canUninstall(src, name))
                return;

            const settings = this._settings;
            const opts = {
                deleteData: settings.get_boolean('delete-user-data') && supportsDeleteData(src),
                removeUnused: settings.get_boolean('remove-unused-deps') && supportsRemoveUnused(src),
            };
            let plan = buildUninstall(src, opts);
            if (settings.get_boolean('confirm-before-uninstall') || plan.root || plan.files) {
                const accepted = await confirmUninstall(name, src, opts, plan, settings, this._dialogs);
                if (!accepted || session.is_cancelled() || !this._canUninstall(src, name))
                    return;
                plan = buildUninstall(src, opts);
            }

            await this._uninstall(app, info, src, plan);
        } finally {
            this._busy.delete(id);
        }
    }

    async _runCommands(commands) {
        for (const argv of commands) {
            const res = await run(argv, {timeout: 0});
            if (!res.ok) {
                const viaPkexec = argv[0]?.endsWith('pkexec');
                if (viaPkexec && (res.status === 126 || res.status === 127))
                    return {ok: false, message: _('Authentication cancelled or denied.')};
                const text = (res.stderr || res.stdout || fmt(_('exit code {0}'), res.status)).trim();
                const lines = text.split('\n').filter(Boolean);
                return {ok: false, message: lines.slice(-4).join('\n').slice(0, 500)};
            }
        }
        return {ok: true, message: ''};
    }

    async _uninstall(app, info, src, plan) {
        const name = app.get_name();
        const id = app.get_id();
        const session = this._session;
        const sourceCache = this._sourceCache;
        const notifyProgress = this._settings.get_boolean('notify-progress');
        const useTrash = this._settings.get_boolean('use-trash');

        if (plan.error) {
            Main.notifyError(fmt(_('Cannot uninstall “{0}”'), name), plan.error);
            return;
        }

        try {
            const removeLocal = () => {
                const {ok, errors} = nativeUninstall(src, info, {
                    useTrash,
                    files: plan.files,
                });
                return {ok, message: errors.join('\n')};
            };
            if (notifyProgress) {
                if (plan.notifyOnStart)
                    Main.notify(name, plan.note);
                else
                    Main.notify(fmt(_('Uninstalling “{0}”…'), name), src.label);
            }

            let result;
            if (plan.native) {
                result = removeLocal();
            } else {
                const changed = plan.files && checkLocalUninstall(src, info, plan.files);
                if (changed) {
                    result = {ok: false, message: changed};
                } else {
                    result = await this._runCommands(plan.commands);
                    if (result.ok && plan.files)
                        result = removeLocal();
                }
            }

            if (session.is_cancelled())
                return;

            if (!result.ok) {
                Main.notifyError(fmt(_('Failed to uninstall “{0}”'), name),
                    result.message || _('Unknown error.'));
                return;
            }

            if (plan.external) {
                if (notifyProgress && plan.note && !plan.notifyOnStart)
                    Main.notify(name, plan.note);
                return;
            }

            const staged = src.manager === 'rpm-ostree';
            if (!staged && GLib.file_test(src.desktopFile, GLib.FileTest.EXISTS)) {
                Main.notifyError(fmt(_('“{0}” still appears to be installed'), name),
                    _('The launcher is still present. Check the installation source.'));
                return;
            }

            this._afterSuccess(id);
            if (notifyProgress) {
                Main.notify(fmt(_('“{0}” uninstalled'), name),
                    staged ? _('Restart to apply the change.') : src.label);
            }
        } finally {
            sourceCache.delete(id);
        }
    }

    _afterSuccess(id) {
        if (!this._settings.get_boolean('remove-from-favorites'))
            return;
        try {
            const favorites = AppFavorites.getAppFavorites();
            if (favorites.isFavorite(id))
                favorites.removeFavorite(id);
        } catch (e) {
            console.warn(`${LOG} cannot remove from favorites: ${e}`);
        }
    }
}
