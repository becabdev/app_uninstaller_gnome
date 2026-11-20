// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {HOME, findBin} from './utils.js';

const home = GLib.canonicalize_filename(HOME, null);
const dataHome = GLib.get_user_data_dir();
const applications = `${dataHome}/applications`;
const autostart = `${GLib.get_user_config_dir()}/autostart`;
const downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ?? `${home}/Downloads`;
const portableRoots = ['Applications', 'Apps', 'apps', 'opt', '.local/opt']
    .map(dir => `${home}/${dir}`);
const bundleRoots = [...portableRoots, dataHome, downloads];
const binRoots = [`${home}/bin`, `${home}/.local/bin`];
const iconRoot = `${dataHome}/icons`;
const dataRoots = new Set([GLib.get_user_config_dir(), GLib.get_user_cache_dir(),
    GLib.get_user_state_dir(), dataHome]);
const protectedRoots = [...bundleRoots, ...binRoots, ...dataRoots];
const fileAttributes = 'standard::type,standard::symlink-target,unix::uid,unix::device,unix::inode,etag::value';
const noFollow = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;
const {DIRECTORY, REGULAR, SYMBOLIC_LINK} = Gio.FileType;
const sharedNames = new Set([
    'applications', 'appimages', 'bin', 'cache', 'config', 'containers', 'dbus-1',
    'desktop', 'documents', 'downloads', 'flatpak', 'fonts', 'gnome-shell', 'icons',
    'lib', 'mime', 'nix', 'share', 'snap', 'steam', 'systemd', 'themes', 'trash', 'wine',
]);

const inside = (path, parent) => path.startsWith(`${parent}/`);
const covers = (parent, path) => path === parent || inside(path, parent);
const normalize = name => name.toLowerCase().replace(/[-_.]/g, '');
const iconName = path => GLib.path_get_basename(path).replace(/\.(?:png|svg|xpm)$/i, '');
const executableName = path => GLib.path_get_basename(path).replace(/\.(?:sh|bin|run)$/i, '');
const linuxArchiveSuffix = /[-_]linux(?:[-_](?:x86[-_]64|amd64|x64|i[3-6]86|aarch64|arm64))?$/i;

function query(path, flags = noFollow) {
    try {
        return Gio.File.new_for_path(path).query_info(fileAttributes, flags, null);
    } catch (_error) {
        return null;
    }
}

function fileId(info) {
    if (!info?.has_attribute('unix::device') || !info.has_attribute('unix::inode'))
        return null;
    return `${info.get_attribute_uint32('unix::device')}:${info.get_attribute_as_string('unix::inode')}`;
}

function ownedPath(path, trackChanges = false) {
    if (!inside(path, home) || GLib.canonicalize_filename(path, null) !== path)
        return null;
    for (let dir = GLib.path_get_dirname(path); dir !== home; dir = GLib.path_get_dirname(dir)) {
        if (query(dir)?.get_file_type() !== DIRECTORY)
            return null;
    }
    const info = query(path);
    const id = fileId(info);
    if (!id || !info.has_attribute('unix::uid') ||
        info.get_attribute_uint32('unix::uid') !== Gio.Credentials.new().get_unix_user())
        return null;
    return {
        path,
        id,
        type: info.get_file_type(),
        link: info.has_attribute('standard::symlink-target') ? info.get_symlink_target() : null,
        etag: trackChanges ? info.get_etag() : null,
    };
}

function parseArgs(line) {
    if (line) {
        try {
            return GLib.shell_parse_argv(line)[1];
        } catch (_error) {
        }
    }
    return [];
}

function commandSpec(argv) {
    let i = 0;
    const env = new Map();
    const envPaths = ['/usr/bin/env', '/bin/env'];
    if (envPaths.includes(argv[0]) || (argv[0] === 'env' && envPaths.includes(findBin('env')))) {
        i++;
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? '')) {
            const value = argv[i++];
            const separator = value.indexOf('=');
            env.set(value.slice(0, separator), value.slice(separator + 1));
        }
        if (argv[i] === '--')
            i++;
    }
    const program = argv[i];
    if (!program || /^[-%]/.test(program))
        return null;
    const path = GLib.path_is_absolute(program) ? program
        : !program.includes('/') && !env.has('PATH') ? findBin(program) : null;
    return path ? {path, args: argv.slice(i + 1), env} : null;
}

function linkTarget(entry) {
    const parent = GLib.path_get_dirname(entry.path);
    const path = GLib.canonicalize_filename(entry.link, parent);
    const target = ownedPath(path);
    return target?.id === fileId(query(entry.path, Gio.FileQueryInfoFlags.NONE)) ? target : null;
}

function addReferences(paths, line) {
    const argv = parseArgs(line);
    for (const arg of argv) {
        if (arg.startsWith('PYTHONPATH=')) {
            for (const path of arg.slice('PYTHONPATH='.length).split(':')) {
                if (GLib.path_is_absolute(path))
                    paths.add(path);
            }
            continue;
        }
        const path = arg.match(/^(?:[\w-]+=)?(\/.*)$/)?.[1];
        if (path)
            paths.add(path);
    }
    const command = commandSpec(argv);
    if (command)
        paths.add(command.path);
}

function desktopFiles() {
    const files = new Set();
    for (const app of Gio.AppInfo.get_all()) {
        const path = app.get_filename?.();
        if (path)
            files.add(path);
    }

    const dirs = [applications, autostart].map(path => Gio.File.new_for_path(path));
    while (dirs.length) {
        const dir = dirs.pop();
        let children;
        try {
            children = dir.enumerate_children('standard::name,standard::type', noFollow, null);
        } catch (_error) {
            continue;
        }
        try {
            let child;
            while ((child = children.next_file(null)) !== null) {
                const file = dir.get_child(child.get_name());
                if (child.get_file_type() === DIRECTORY)
                    dirs.push(file);
                else if (child.get_name().endsWith('.desktop'))
                    files.add(file.get_path());
            }
        } finally {
            children.close(null);
        }
    }
    return files;
}

function sharedPaths(launcher, candidates, appInfoClass) {
    const shared = new Set();
    for (const filename of desktopFiles()) {
        if (filename === launcher || candidates.some(entry => entry.path === filename))
            continue;
        const app = appInfoClass.new_from_filename(filename);
        if (!app)
            continue;
        const paths = new Set([filename]);
        addReferences(paths, app.get_commandline());
        const icon = app.get_string('Icon');
        if (icon && !GLib.path_is_absolute(icon)) {
            for (const candidate of candidates) {
                if (inside(candidate.path, iconRoot) && iconName(candidate.path) === icon)
                    shared.add(candidate.path);
            }
        }
        for (const key of ['Path', 'Icon', 'TryExec']) {
            const path = app.get_string(key);
            if (path && GLib.path_is_absolute(path))
                paths.add(path);
        }
        if (app.list_actions().length > 0) {
            const desktop = new GLib.KeyFile();
            try {
                desktop.load_from_file(filename, GLib.KeyFileFlags.NONE);
                for (const action of app.list_actions()) {
                    const group = `Desktop Action ${action}`;
                    if (desktop.has_group(group) && desktop.get_keys(group)[0].includes('Exec'))
                        addReferences(paths, desktop.get_string(group, 'Exec'));
                }
            } catch (_error) {
            }
        }
        for (const path of paths) {
            const absolute = GLib.canonicalize_filename(path, null);
            const ids = new Set();
            for (let entry = absolute; inside(entry, home); entry = GLib.path_get_dirname(entry))
                ids.add(fileId(query(entry, Gio.FileQueryInfoFlags.NONE)));
            for (const candidate of candidates) {
                if (covers(candidate.path, absolute) || ids.has(candidate.id))
                    shared.add(candidate.path);
            }
        }
    }
    return shared;
}

function currentLauncher(info) {
    const launcher = ownedPath(info.get_filename(), true);
    if (launcher?.type !== REGULAR)
        return null;
    const live = info.constructor.new_from_filename(launcher.path);
    if (!live || live.get_commandline() !== info.get_commandline() ||
        ['Icon', 'X-Flatpak', 'X-SnapInstanceName'].some(key => live.get_string(key) !== info.get_string(key)))
        return null;
    return {launcher, live};
}

export function findLocalWrapper(info) {
    const current = currentLauncher(info);
    if (!current || GLib.path_get_dirname(current.launcher.path) !== applications)
        return null;
    const [path, ...args] = parseArgs(current.live.get_commandline());
    if (!path || GLib.path_get_dirname(path) !== applications || path.endsWith('.desktop') ||
        args.some(arg => !/^%[fFuU]$/.test(arg)))
        return null;
    const wrapper = ownedPath(path, true);
    if (wrapper?.type !== REGULAR || !GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) ||
        sharedPaths(current.launcher.path, [wrapper], info.constructor).size)
        return null;
    return {launcher: current.launcher, installation: [wrapper], data: []};
}

function pythonInstallation(command, matches) {
    if (!command || !/^python3(?:\.\d+)?$/.test(GLib.path_get_basename(command.path)))
        return null;
    const [option, module] = command.args;
    const root = command.env.get('PYTHONPATH');
    if (option !== '-m' || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(module ?? '') ||
        !matches(module.split('.')[0]) || !root || root.includes(':') || !inside(root, dataHome))
        return null;
    const [app, subdir, ...rest] = root.slice(dataHome.length + 1).split('/');
    if (!matches(app) || !['app', 'src'].includes(subdir) || rest.length)
        return null;
    const payload = ownedPath(root);
    if (payload?.type !== DIRECTORY)
        return null;
    const modulePath = `${root}/${module.replaceAll('.', '/')}`;
    const entry = [`${modulePath}.py`, `${modulePath}/__main__.py`]
        .map(path => ownedPath(path)).find(file => file?.type === REGULAR);
    return entry ? {payload, entry} : null;
}

function matchingAutostart(live, appId, command) {
    const entry = ownedPath(`${autostart}/${appId}.desktop`, true);
    if (entry?.type !== REGULAR)
        return null;
    const app = live.constructor.new_from_filename(entry.path);
    const startup = commandSpec(parseArgs(app?.get_commandline()));
    return startup?.path === command.path && startup.args[0] === command.args[0] &&
        startup.args[1] === command.args[1] && startup.env.get('PYTHONPATH') === command.env.get('PYTHONPATH')
        ? entry : null;
}

export function findLauncherFiles(info, appId) {
    if (!/^[\w][\w.-]*$/.test(appId) || sharedNames.has(appId.toLowerCase()))
        return null;
    const current = currentLauncher(info);
    if (!current)
        return null;
    const {launcher, live} = current;

    const parts = appId.split('.');
    const names = [normalize(appId)];
    if (parts.length >= 3)
        names.push(normalize(parts.at(-1)));
    const matches = name => !sharedNames.has(name.toLowerCase()) && names.includes(normalize(name));

    const spec = commandSpec(parseArgs(live.get_commandline()));
    const python = pythonInstallation(spec, matches);
    const command = !python && spec ? ownedPath(spec.path) : null;
    const executable = python?.entry ?? (command?.link ? linkTarget(command) : command);
    if (executable?.type !== REGULAR || (!python && !GLib.file_test(executable.path, GLib.FileTest.IS_EXECUTABLE)))
        return null;

    let payload = python?.payload ?? null;
    for (const root of bundleRoots) {
        if (payload)
            break;
        if (!inside(root, home) || !inside(executable.path, root))
            continue;
        const [dir] = executable.path.slice(root.length + 1).split('/');
        const name = root === downloads ? dir.replace(linuxArchiveSuffix, '') : dir;
        if (!matches(name.replace(/-\d+(?:\.\d+)+$/, '')) ||
            (root === downloads && !matches(executableName(executable.path))))
            continue;
        const bundle = ownedPath(`${root}/${dir}`);
        if (bundle?.type === DIRECTORY) {
            payload = bundle;
            break;
        }
    }
    if (!payload && [...binRoots, ...portableRoots].includes(GLib.path_get_dirname(executable.path)) &&
        matches(executableName(executable.path)))
        payload = executable;
    if (!payload || covers(payload.path, launcher.path) || protectedRoots.some(root => covers(payload.path, root)))
        return null;

    const installation = [payload];
    if (python) {
        const startup = matchingAutostart(live, appId, spec);
        if (startup)
            installation.push(startup);
    }
    if (command?.type === SYMBOLIC_LINK && !covers(payload.path, command.path)) {
        if (!binRoots.includes(GLib.path_get_dirname(command.path)) ||
            !matches(executableName(command.path)))
            return null;
        installation.push(command);
    }

    const icon = live.get_string('Icon');
    if (icon && GLib.path_is_absolute(icon) && inside(icon, iconRoot) && matches(iconName(icon))) {
        const image = ownedPath(icon);
        if (image?.type === REGULAR && !installation.some(entry => covers(entry.path, image.path)))
            installation.push(image);
    }

    const data = [];
    for (const root of dataRoots) {
        if (!inside(root, home))
            continue;
        const entry = ownedPath(`${root}/${appId}`);
        if (entry?.type === DIRECTORY && !covers(entry.path, launcher.path) &&
            !protectedRoots.some(dir => covers(entry.path, dir)) &&
            !installation.some(file => covers(file.path, entry.path) || covers(entry.path, file.path)))
            data.push(entry);
    }

    const shared = sharedPaths(launcher.path, [...installation, ...data], info.constructor);
    if (shared.has(payload.path) || shared.has(command?.path))
        return null;
    return {
        launcher,
        executable: executable.path,
        installation: installation.filter(entry => !shared.has(entry.path)),
        data: data.filter(entry => !shared.has(entry.path)),
    };
}

function entryMatches(entry) {
    const current = ownedPath(entry.path, entry.etag !== null);
    return current?.id === entry.id && current.type === entry.type &&
        current.link === entry.link && current.etag === entry.etag;
}

export function checkLauncherFiles(launcher, entries, appInfoClass, changedMessage) {
    const changed = [...entries, launcher].find(entry => !entryMatches(entry));
    if (changed)
        return `${changed.path}: ${changedMessage}`;

    const shared = sharedPaths(launcher.path, entries, appInfoClass);
    return shared.size ? `${[...shared][0]}: ${changedMessage}` : null;
}

export function trashLauncherFiles(launcher, entries, appInfoClass, changedMessage) {
    const removed = [];
    const errors = [];
    const changed = checkLauncherFiles(launcher, entries, appInfoClass, changedMessage);
    if (changed)
        return {ok: false, removed, errors: [changed]};

    for (const entry of [...entries, launcher]) {
        if (!entryMatches(entry)) {
            errors.push(`${entry.path}: ${changedMessage}`);
            break;
        }
        try {
            Gio.File.new_for_path(entry.path).trash(null);
            removed.push(entry.path);
        } catch (error) {
            errors.push(`${entry.path}: ${error.message}`);
            break;
        }
    }
    return {ok: errors.length === 0, removed, errors};
}
