// SPDX-License-Identifier: GPL-3.0-or-later
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {CheckBox} from 'resource:///org/gnome/shell/ui/checkBox.js';
import {MessageDialogContent} from 'resource:///org/gnome/shell/ui/dialog.js';
import {ModalDialog} from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {buildUninstall, describeSource, previewImpact, supportsDeleteData, supportsRemoveUnused} from './sources.js';
import {fmt, formatCommand} from './utils.js';

export function confirmUninstall(name, src, opts, initialPlan, settings, dialogs) {
    const showCommand = settings.get_boolean('show-command');
    const wantPreview = settings.get_boolean('show-dependents-preview') && src.kind === 'package';

    return new Promise(resolve => {
        const dialog = new ModalDialog({destroyOnClose: true});
        let plan = initialPlan;
        let preview = wantPreview ? new Gio.Cancellable() : null;
        let impact = null;
        let closed = false;

        const finish = accepted => {
            if (closed)
                return;
            closed = true;
            preview?.cancel();
            resolve(accepted);
        };
        dialogs.add(dialog);
        dialog.connect('destroy', () => {
            dialogs.delete(dialog);
            finish(false);
        });

        const content = new MessageDialogContent({
            title: fmt(_('Uninstall “{0}”?'), name),
            description: '',
        });
        dialog.contentLayout.add_child(content);

        const render = () => {
            const lines = describeSource(src);
            if (plan.files)
                lines.push('', _('The launcher and these files will be moved to the Trash.'),
                    ...plan.files.map(entry => entry.path));
            if (plan.root)
                lines.push('', _('Administrator approval is required.'));
            if (plan.note)
                lines.push('', plan.note);
            if (plan.error)
                lines.push('', `⚠ ${plan.error}`);

            if (preview) {
                lines.push('', _('Checking affected packages…'));
            } else if (impact?.available) {
                if (impact.warning)
                    lines.push('', `⚠ ${impact.warning}`);
                const count = impact.packages.length;
                if (count > 0) {
                    const shown = impact.packages.slice(0, 12).join(', ');
                    const more = count > 12 ? ` … (+${count - 12})` : '';
                    const heading = impact.mode === 'dependents'
                        ? fmt(_('Dependent packages that may be removed ({0})'), count)
                        : fmt(_('Other packages to be removed ({0})'), count);
                    lines.push('', heading, `${shown}${more}`);
                }
            }

            if (showCommand && plan.commands)
                lines.push('', _('Commands:'), ...plan.commands.map(formatCommand));
            content.description = lines.join('\n');
            confirmButton.reactive = !preview && !plan.error;
            confirmButton.can_focus = confirmButton.reactive;
            confirmButton.opacity = confirmButton.reactive ? 255 : 120;
        };

        const checkImpact = async signal => {
            let result = null;
            try {
                result = await previewImpact(src, opts, signal);
            } catch (error) {
                console.error(`App Uninstaller preview failed ${error}`);
            }
            if (signal.is_cancelled())
                return;
            impact = result;
            preview = null;
            render();
        };

        const boxes = [];
        const addOption = (title, key, manager) => {
            const box = new CheckBox(title);
            box.checked = opts[key];
            box.connect('notify::checked', () => {
                if (closed)
                    return;
                opts[key] = box.checked;
                plan = buildUninstall(src, opts);
                if (wantPreview && src.manager === manager) {
                    preview?.cancel();
                    preview = new Gio.Cancellable();
                    checkImpact(preview);
                }
                render();
            });
            boxes.push(box);
        };
        if (supportsDeleteData(src))
            addOption(_('Also delete data and settings'), 'deleteData', 'apt');
        if (supportsRemoveUnused(src))
            addOption(_('Also remove unused dependencies'), 'removeUnused', 'pacman');
        if (boxes.length > 0) {
            const layout = new St.BoxLayout({
                x_expand: true,
                style: 'spacing: 8px; padding-top: 6px;',
            });
            if ('orientation' in layout)
                layout.orientation = Clutter.Orientation.VERTICAL;
            else
                layout.vertical = true;
            for (const box of boxes)
                layout.add_child(box);
            dialog.contentLayout.add_child(layout);
        }

        dialog.addButton({
            label: _('Cancel'),
            action: () => {
                finish(false);
                dialog.close();
            },
            key: Clutter.KEY_Escape,
        });
        const confirmButton = dialog.addButton({
            label: _('Uninstall'),
            action: () => {
                if (closed || preview || plan.error)
                    return;
                finish(true);
                dialog.close();
            },
        });
        confirmButton.add_style_class_name('destructive-action');

        render();
        if (!dialog.open())
            dialog.destroy();
        else if (preview)
            checkImpact(preview);
    });
}
