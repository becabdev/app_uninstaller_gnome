// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DONATION_URL = 'https://buymeacoffee.com/becabdev';

export default class AppUninstallerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 780);

        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'user-trash-symbolic',
        });
        window.add(page);

        const supportGroup = new Adw.PreferencesGroup();
        const supportRow = new Adw.ActionRow({
            title: _('Support App Uninstaller'),
            subtitle: _('Your donation helps maintain and improve the extension.'),
        });
        supportRow.add_prefix(new Gtk.Image({
            icon_name: 'emblem-favorite-symbolic',
            pixel_size: 24,
            valign: Gtk.Align.CENTER,
            css_classes: ['accent'],
        }));

        const donate = new Gtk.LinkButton({
            uri: DONATION_URL,
            label: _('Buy me a coffee'),
            sensitive: Boolean(DONATION_URL),
            valign: Gtk.Align.CENTER,
        });
        donate.remove_css_class('link');
        donate.add_css_class('suggested-action');
        donate.add_css_class('pill');
        supportRow.add_suffix(donate);
        supportGroup.add(supportRow);
        page.add(supportGroup);

        const addSwitch = (group, key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        };

        const menuGroup = new Adw.PreferencesGroup({
            title: _('App menu'),
        });
        page.add(menuGroup);

        addSwitch(menuGroup, 'show-source-in-label',
            _('Show the source in the menu'),
            _('For example: “Uninstall (Flatpak)”.'));
        addSwitch(menuGroup, 'hide-unsupported',
            _('Hide the menu item when uninstalling is unavailable'),
            _("If shown, the item explains why the app can't be removed."));

        const positions = ['before-details', 'bottom'];
        const posRow = new Adw.ComboRow({
            title: _('Menu item position'),
            model: Gtk.StringList.new([_('Before app details'), _('At the bottom')]),
        });
        posRow.selected = Math.max(0, positions.indexOf(settings.get_string('item-position')));
        posRow.connect('notify::selected', () => {
            settings.set_string('item-position', positions[posRow.selected] ?? positions[0]);
        });
        menuGroup.add(posRow);

        const confirmGroup = new Adw.PreferencesGroup({title: _('Confirmation')});
        page.add(confirmGroup);

        addSwitch(confirmGroup, 'confirm-before-uninstall',
            _('Ask before uninstalling'));
        addSwitch(confirmGroup, 'show-dependents-preview',
            _('Preview affected packages'),
            _('APT and Pacman show what else will be removed. RPM shows packages that depend on the app.'));
        addSwitch(confirmGroup, 'show-command',
            _('Show commands in the confirmation dialog'));

        const actionGroup = new Adw.PreferencesGroup({
            title: _('Uninstall options'),
            description: _('You can change the removal options each time you confirm an uninstall.'),
        });
        page.add(actionGroup);

        addSwitch(actionGroup, 'delete-user-data',
            _('Also delete data and settings'));
        addSwitch(actionGroup, 'remove-unused-deps',
            _('Also remove unused dependencies'));
        addSwitch(actionGroup, 'use-trash',
            _('Move AppImage files to the Trash'));
        addSwitch(actionGroup, 'allow-launcher-removal',
            _('Allow removal of local launchers'),
            _('Remove local shortcuts and, when identified, their standalone app files.'));
        addSwitch(actionGroup, 'remove-from-favorites',
            _('Remove from Favorites after uninstalling'));
        addSwitch(actionGroup, 'notify-progress',
            _('Show uninstall progress and completion'));

        const safeGroup = new Adw.PreferencesGroup({
            title: _('Safety'),
        });
        page.add(safeGroup);

        addSwitch(safeGroup, 'protect-system-apps',
            _('Protect essential system components'));

        this._buildProtectedList(page, settings);
    }

    _buildProtectedList(page, settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Protected apps'),
            description: _('Enter a package name, a Flatpak or Snap ID, or a .desktop filename.'),
        });
        page.add(group);

        const addRow = new Adw.EntryRow({title: _('Add an app to protect')});
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Add'),
        });
        addRow.add_suffix(addButton);
        group.add(addRow);

        const rows = [];

        const rebuild = () => {
            for (const row of rows)
                group.remove(row);
            rows.length = 0;
            for (const entry of settings.get_strv('protected-apps')) {
                const row = new Adw.ActionRow({title: entry, use_markup: false});
                const remove = new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: _('Remove'),
                });
                remove.connect('clicked', () => {
                    settings.set_strv('protected-apps',
                        settings.get_strv('protected-apps').filter(item => item !== entry));
                });
                row.add_suffix(remove);
                group.add(row);
                rows.push(row);
            }
        };

        const add = () => {
            const value = addRow.text.trim();
            if (!value)
                return;
            const current = settings.get_strv('protected-apps');
            if (!current.includes(value))
                settings.set_strv('protected-apps', [...current, value]);
            addRow.text = '';
        };

        addButton.connect('clicked', add);
        addRow.connect('entry-activated', add);
        let changedId = 0;
        addRow.connect('realize', () => {
            changedId = settings.connect('changed::protected-apps', rebuild);
            rebuild();
        });
        addRow.connect('unrealize', () => settings.disconnect(changedId));
    }
}
