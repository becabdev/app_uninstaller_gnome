// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {checkLauncherFiles, findLauncherFiles, findLocalWrapper, trashLauncherFiles} from './launcher.js';
import {HOME, findBin, findSystemBin, systemPath, run, realPath, osReleaseIds, fmt} from './utils.js';

let translate = s => s;
export function setTranslator(fn) {
    translate = fn;
}
const _ = s => translate(s);

export const MANAGER_LABELS = {
    'apt': 'APT (dpkg)',
    'dpkg': 'dpkg',
    'dnf': 'DNF (RPM)',
    'yum': 'YUM (RPM)',
    'zypper': 'Zypper (RPM)',
    'rpm': 'RPM',
    'rpm-ostree': 'rpm-ostree',
    'pacman': 'Pacman',
    'apk': 'APK',
    'xbps': 'XBPS',
    'portage': 'Portage',
};

// packages dont la suppression peut rendre le systeme littéralement inutilisalbe
//au cas où l'utilisateur est assez stupide pour désinstaller un composant critique du systeme on lui interdit de le faire mdr
export const BUILTIN_PROTECTED = new Set([
    'gnome-shell', 'gnome-session', 'gnome-session-bin', 'gnome-settings-daemon',
    'gnome-control-center', 'gnome-initial-setup', 'mutter', 'gdm', 'gdm3',
    'nautilus', 'org.gnome.nautilus', 'org.gnome.settings', 'org.gnome.shell',
    'xdg-desktop-portal', 'xdg-desktop-portal-gnome', 'xdg-desktop-portal-gtk',
    'xorg', 'xorg-server', 'xwayland', 'xserver-xorg',
    'ubuntu-desktop', 'ubuntu-desktop-minimal', 'ubuntu-session',
    'fedora-release', 'fedora-workstation-desktop',
    'systemd', 'polkit', 'polkitd', 'policykit-1', 'pkexec',
    'networkmanager', 'network-manager', 'pipewire', 'wireplumber', 'pulseaudio',
    'sudo', 'bash', 'coreutils', 'glibc', 'libc6', 'apt', 'dpkg', 'dnf', 'rpm',
    'pacman', 'flatpak', 'snapd', 'grub', 'grub2', 'linux', 'linux-image-generic',
    'kernel', 'kernel-core',
]);

// exécs géneriques : posseder python3 ne dit rien sur l'application (merci chatgpt pour le regex j'en aurais sué sans lui)
const GENERIC_BINARIES = /^(python[\d.]*|perl|ruby|node(js)?|java|bash|sh|dash|zsh|env|wine(64)?|mono|dotnet|electron[\d]*|php|lua|xdg-open|gtk-launch|flatpak|snap|steam|sudo|pkexec|xterm|x-terminal-emulator|gnome-terminal|konsole|distrobox-enter|toolbox)$/;
const WINE_RUNNER = /^wine(?:64)?(?:-stable|-development)?$/;
const WINE_TOOL = /^(?:cmd|control|explorer|iexplore|msiexec|notepad|reg(?:edit)?|rundll32|taskmgr|uninstaller|wineboot|winebrowser|winecfg|wineconsole|winemenubuilder|winemine|wordpad)(?:\.exe)?$/i;
const WINE_START_OPTIONS = new Set(['/unix', '/wait', '/min', '/max', '/b',
    '/low', '/normal', '/high', '/realtime', '/abovenormal', '/belownormal']);

// répertoires trop géneriques pour y chercher un désinstalleur
const SKIP_DIRS = new Set([
    '/', '/usr', '/usr/bin', '/usr/sbin', '/usr/local', '/usr/local/bin', '/usr/local/sbin',
    '/bin', '/sbin', '/opt', '/usr/lib', '/usr/lib64', '/usr/libexec', '/usr/share',
    '/usr/share/applications', '/etc', '/var', '/nix', '/gnu', HOME,
    `${HOME}/.local`, `${HOME}/.local/bin`, `${HOME}/.local/share`,
    `${HOME}/.local/share/applications`,
]);

function newSource(desktopFile, desktopId, baseName) {
    return {
        kind: 'unknown',
        manager: null,
        label: _('Unknown source'),
        id: baseName,
        pkg: null,
        desktopFile,
        desktopId,
        scope: null,
        origin: null,
        appImagePath: null,
        steamId: null,
        container: null,
        uninstaller: null,
        inferred: false,
        supported: false,
        reason: null,
        experimental: false,
    };
}

function unsupported(src, reason) {
    src.supported = false;
    src.reason = reason;
    return src;
}

function parseDpkgOwner(stdout) {
    for (const line of stdout.split('\n')) {
        if (!line || line.startsWith('diversion'))
            continue;
        const m = line.match(/^(.*?): \//);
        if (!m)
            continue;
        return m[1].split(',')[0].trim().split(':')[0];
    }
    return null;
}

function firstLine(stdout) {
    return stdout.split('\n').map(l => l.trim()).find(Boolean) ?? null;
}

const OWNER_QUERIES = [
    {tool: 'pacman', type: 'pacman', args: p => ['-Qoq', p], parse: firstLine},
    {tool: 'dpkg', type: 'dpkg', args: p => ['-S', p], parse: parseDpkgOwner},
    {tool: 'rpm', type: 'rpm', args: p => ['-qf', '--qf', '%{NAME}\\n', p], parse: firstLine},
    {
        tool: 'apk', type: 'apk', args: p => ['info', '-W', p],
        parse: out => {
            const m = out.match(/is owned by (\S+)/);
            return m ? m[1].replace(/-\d[^-]*-r\d+$/, '') : null;
        },
    },
    {
        tool: 'xbps-query', type: 'xbps', args: p => ['-o', p],
        parse: out => {
            const m = out.match(/^(\S+):\s/m);
            return m ? m[1].replace(/-[^-]+$/, '') : null;
        },
    },
    {tool: 'qfile', type: 'portage', args: p => ['-Cq', p], parse: firstLine},
];

async function findOwner(paths, signal) {
    for (const path of paths) {
        for (const query of OWNER_QUERIES) {
            if (signal?.is_cancelled())
                return null;
            const bin = findBin(query.tool);
            if (!bin)
                continue;
            const res = await run([bin, ...query.args(path)], {timeout: 15, signal});
            if (!res.ok)
                continue;
            const pkg = query.parse(res.stdout);
            if (pkg)
                return {type: query.type, pkg};
        }
    }
    return null;
}

function pickPackageManager(ownerType) {
    switch (ownerType) {
    case 'dpkg':
        return findBin('apt-get') ? 'apt' : 'dpkg';
    case 'pacman':
    case 'apk':
    case 'xbps':
    case 'portage':
        return ownerType;
    case 'rpm': {
        if (GLib.file_test('/run/ostree-booted', GLib.FileTest.EXISTS) && findBin('rpm-ostree'))
            return 'rpm-ostree';
        const suse = osReleaseIds().some(i => i.includes('suse') || i === 'sles');
        const order = suse ? ['zypper', 'dnf', 'yum'] : ['dnf', 'yum', 'zypper'];
        for (const m of order) {
            if (findBin(m))
                return m;
        }
        return 'rpm';
    }
    default:
        return null;
    }
}

function nixLikeName(realFile, storeRoot) {
    const dir = realFile.slice(storeRoot.length).split('/')[0] ?? '';
    return dir.replace(/^[0-9a-z]{32}-/, '').replace(/^(.+?)-\d.*$/, '$1');
}

/** premier vrai programme de la ligne */
async function resolveExecBinary(argv, signal) {
    const wrappers = new Set(['env', 'sh', 'bash', 'dash', 'zsh', 'nohup', 'setsid', 'exec',
        'nice', 'time', 'stdbuf', 'sudo', 'pkexec']);
    for (const a of argv) {
        if (!a || a.startsWith('-') || a.startsWith('%'))
            continue;
        if (a.includes('=') && !a.startsWith('/'))
            continue;
        if (wrappers.has(GLib.path_get_basename(a)))
            continue;
        const path = a.startsWith('/') ? a : findBin(a);
        if (!path)
            return null;
        return {path, real: await realPath(path, signal)};
    }
    return null;
}

function findVendorUninstaller(dirs) {
    for (const dir of dirs) {
        if (!dir || SKIP_DIRS.has(dir))
            continue;
        let files;
        try {
            files = Gio.File.new_for_path(dir).enumerate_children(
                'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        } catch (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
                !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_DIRECTORY))
                console.warn(`[App Uninstaller] ${dir}: ${error.message}`);
            continue;
        }
        const hits = [];
        try {
            let child;
            while ((child = files.next_file(null)) !== null) {
                const name = child.get_name();
                const path = `${dir}/${name}`;
                if (/uninstall/i.test(name) && child.get_file_type() === Gio.FileType.REGULAR &&
                    GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
                    hits.push(path);
            }
        } finally {
            files.close(null);
        }
        if (hits.length > 0)
            return hits.sort()[0];
    }
    return null;
}

const uniq = list => [...new Set(list.filter(Boolean))];
const flatpakIdPattern = /^[A-Za-z_][\w-]*(?:\.[\w-]+){2,}$/;

function validFlatpakRef(ref, id) {
    const parts = ref.split('/');
    return parts.length === 4 && parts[0] === 'app' && parts[1] === id &&
        parts.slice(2).every(part => /^[\w.-]+$/.test(part));
}

async function findWrappedFlatpak(info, id, flatpak, signal) {
    const cmp = findBin('cmp');
    const files = cmp && findLocalWrapper(info);
    if (!files)
        return null;

    const [{path}] = files.installation;
    for (const scope of ['user', 'system']) {
        const result = await run([flatpak, 'info', `--${scope}`, '--show-ref', '--show-location', id],
            {timeout: 10, signal});
        const match = result.ok && result.stdout.trimEnd().match(/^(\S+)[ \t]+(\/.+)$/);
        if (!match || !validFlatpakRef(match[1], id))
            continue;
        const [ , ref, location] = match;
        const installed = `${location}/files/bin/${GLib.path_get_basename(path)}`;
        if (!GLib.file_test(installed, GLib.FileTest.IS_REGULAR))
            continue;
        // Match the deployed executable without running the launcher script.
        const same = await run([cmp, '-s', '--', path, installed], {timeout: 5, signal});
        if (same.ok)
            return {scope, ref, files};
    }
    return null;
}

function wineLauncher(argv) {
    let index = 0;
    const env = new Map();
    if (['env', '/usr/bin/env', '/bin/env'].includes(argv[0])) {
        index++;
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index] ?? '')) {
            const assignment = argv[index++];
            const separator = assignment.indexOf('=');
            env.set(assignment.slice(0, separator), assignment.slice(separator + 1));
        }
        if (argv[index] === '--')
            index++;
    }

    const program = argv[index++];
    if (!program || !WINE_RUNNER.test(GLib.path_get_basename(program)))
        return null;

    if (/^start(?:\.exe)?$/i.test(argv[index] ?? '')) {
        index++;
        while (argv[index] === '' || WINE_START_OPTIONS.has(argv[index]?.toLowerCase()))
            index++;
    }
    const target = argv[index] ?? '';
    const filename = target.split(/[\\/]/).at(-1);
    const systemTarget = filename === target ||
        /(?:^|[\\/])windows[\\/](?:(?:system32|syswow64)[\\/])?[^\\/]+$/i.test(target);
    // Ignore Wine tools and generic launchers that only open the file passed as %f.
    if (!/\.(?:exe|lnk|com|bat)$/i.test(target) || target.startsWith('%') ||
        (systemTarget && WINE_TOOL.test(filename)))
        return null;

    const runner = GLib.path_is_absolute(program) ? program
        : !program.includes('/') && !env.has('PATH') ? findBin(program) : null;
    return {
        runner,
        prefix: env.get('WINEPREFIX') ?? GLib.getenv('WINEPREFIX') ?? `${HOME}/.wine`,
        arch: env.get('WINEARCH') ?? null,
    };
}

function wineError({runner, prefix}) {
    if (!runner || !GLib.file_test(runner, GLib.FileTest.IS_EXECUTABLE) ||
        GLib.file_test(runner, GLib.FileTest.IS_DIR))
        return _('Could not find the Wine executable used by this launcher.');
    if (!GLib.path_is_absolute(prefix) ||
        !GLib.file_test(`${prefix}/system.reg`, GLib.FileTest.IS_REGULAR) ||
        !GLib.file_test(`${prefix}/dosdevices`, GLib.FileTest.IS_DIR))
        return fmt(_('Could not find an existing Wine prefix at {0}.'), prefix || '—');
    return null;
}

//analyse une application (Gio.DesktopAppInfo) et renvoie la description de sa source d installation

export async function detectSource(info, signal) {
    const desktopFile = info.get_filename() ?? '';
    const desktopId = info.get_id() ?? '';
    const baseName = GLib.path_get_basename(desktopFile).replace(/\.desktop$/, '');
    const execLine = info.get_commandline() ?? '';
    let argv = [];
    try {
        [, argv] = GLib.shell_parse_argv(execLine);
    } catch (_e) {
        argv = execLine.split(/\s+/).filter(Boolean);
    }

    const src = newSource(desktopFile, desktopId, baseName);
    const inHome = desktopFile.startsWith(`${HOME}/`);

    const flatpakKey = info.get_string('X-Flatpak');
    const flatpakExport = /\/flatpak\/exports\/share\/applications\//.test(desktopFile) || flatpakKey;
    const flatpak = flatpakExport || (inHome && flatpakIdPattern.test(baseName)) ? findBin('flatpak') : null;
    const wrapped = !flatpakExport && flatpak ? await findWrappedFlatpak(info, baseName, flatpak, signal) : null;
    if (signal?.is_cancelled())
        return src;
    if (flatpakExport || wrapped) {
        src.kind = 'flatpak';
        src.id = flatpakKey || baseName;
        src.pkg = src.id;
        src.scope = wrapped?.scope ?? (inHome ? 'user' : 'system');
        if (!flatpak) {
            src.label = 'Flatpak';
            return unsupported(src, _('Flatpak was not found.'));
        }
        if (wrapped) {
            src.flatpakRef = wrapped.ref;
            src.localFiles = wrapped.files;
        }
        for (const scope of wrapped ? [wrapped.scope] : ['user', 'system']) {
            if (signal?.is_cancelled())
                return src;
            const res = await run([flatpak, 'info', `--${scope}`, wrapped?.ref ?? src.id], {timeout: 10, signal});
            if (res.ok) {
                src.scope = scope;
                src.origin = res.stdout.match(/^\s*Origin:\s*(.+)$/m)?.[1]?.trim() ?? null;
                break;
            }
        }
        if (src.origin) {
            src.label = src.scope === 'user'
                ? fmt(_('Flatpak · {0} (user)'), src.origin)
                : fmt(_('Flatpak · {0} (system)'), src.origin);
        } else {
            src.label = src.scope === 'user' ? _('Flatpak (user)') : _('Flatpak (system)');
        }
        src.supported = true;
        return src;
    }

    const snapKey = info.get_string('X-SnapInstanceName');
    if (snapKey || /\/snapd\/desktop\/applications\//.test(desktopFile) ||
        argv[0]?.startsWith('/snap/bin/')) {
        src.kind = 'snap';
        src.id = snapKey || baseName.split('_')[0];
        src.pkg = src.id;
        src.label = 'Snap';
        if (!findBin('snap'))
            return unsupported(src, _('Snap was not found.'));
        src.supported = true;
        return src;
    }

    const wine = wineLauncher(argv);
    if (wine) {
        const error = wineError(wine);
        if (error && inHome) {
            src.kind = 'launcher';
            src.label = _('Local launcher');
            src.launcherNote = error;
        } else {
            src.kind = 'wine';
            src.label = 'Wine';
            src.wine = wine;
            if (error)
                return unsupported(src, error);
        }
        src.supported = true;
        return src;
    }

    const steam = execLine.match(/steam:\/\/rungameid\/(\d+)/);
    if (steam) {
        src.kind = 'steam';
        src.steamId = steam[1];
        src.id = steam[1];
        src.label = fmt(_('Steam (game #{0})'), steam[1]);
        if (!findBin('steam') && !findBin('xdg-open'))
            return unsupported(src, _('Could not find Steam or xdg-open.'));
        src.supported = true;
        return src;
    }

    const waydroid = execLine.match(/waydroid\s+app\s+launch\s+(\S+)/);
    if (waydroid) {
        src.kind = 'waydroid';
        src.pkg = waydroid[1];
        src.id = waydroid[1];
        src.label = _('Waydroid (Android app)');
        if (!findBin('waydroid'))
            return unsupported(src, _('Waydroid was not found.'));
        src.supported = true;
        return src;
    }

    if (/distrobox-enter|distrobox\s+enter|toolbox\s+run/.test(execLine)) {
        const name = execLine.match(/(?:-n|--name|-c|--container)\s+"?([\w.-]+)/)?.[1] ?? '?';
        src.kind = 'container';
        src.container = name;
        src.label = fmt(_('Container “{0}” (Distrobox or Toolbox)'), name);
        src.supported = inHome;
        if (!inHome)
            src.reason = _('The launcher is not in your home directory.');
        return src;
    }

    const imageToken = argv.find(a => /\.appimage$/i.test(a) &&
        GLib.path_is_absolute(a) && GLib.file_test(a, GLib.FileTest.IS_REGULAR));
    if (imageToken) {
        src.kind = 'appimage';
        src.appImagePath = imageToken;
        src.label = 'AppImage';
        src.supported = true;
        return src;
    }

    const real = await realPath(desktopFile, signal);
    if (signal?.is_cancelled())
        return src;

    if (real.startsWith('/nix/store/') || desktopFile.startsWith('/nix/') ||
        desktopFile.includes('/.nix-profile/') || desktopFile.startsWith('/run/current-system/') ||
        desktopFile.startsWith('/etc/profiles/')) {
        src.kind = 'nix';
        src.label = 'Nix';
        src.experimental = true;
        src.pkg = real.startsWith('/nix/store/') ? nixLikeName(real, '/nix/store/') : baseName;
        if (desktopFile.startsWith('/run/current-system/') || desktopFile.startsWith('/etc/profiles/')) {
            src.label = _('NixOS configuration');
            return unsupported(src, _('Remove this app from your NixOS configuration and rebuild the system.'));
        }
        if (!findBin('nix') && !findBin('nix-env'))
            return unsupported(src, _('Could not find nix or nix-env.'));
        src.supported = true;
        return src;
    }

    if (real.startsWith('/gnu/store/') || desktopFile.includes('.guix-profile') ||
        desktopFile.includes('/guix-home')) {
        src.kind = 'guix';
        src.label = 'GNU Guix';
        src.experimental = true;
        src.pkg = real.startsWith('/gnu/store/') ? nixLikeName(real, '/gnu/store/') : baseName;
        if (!findBin('guix'))
            return unsupported(src, _('Guix was not found.'));
        src.supported = true;
        return src;
    }

    if (inHome) {
        src.kind = 'launcher';
        src.label = _('Local launcher');
        src.supported = true;
        const files = findLauncherFiles(info, baseName);
        if (files) {
            const ownershipPaths = uniq([desktopFile, files.executable,
                ...files.installation.map(entry => entry.path), ...files.data.map(entry => entry.path)]);
            const owner = await findOwner(ownershipPaths, signal);
            if (!owner && !signal?.is_cancelled()) {
                const bundle = files.installation[0];
                if (bundle.type === Gio.FileType.DIRECTORY)
                    src.uninstaller = findVendorUninstaller(uniq([GLib.path_get_dirname(files.executable), bundle.path]));
                if (src.uninstaller)
                    return unsupported(src, fmt(_('Run the vendor uninstaller yourself: {0}'), src.uninstaller));
                src.label = _('Standalone installation');
                src.localFiles = files;
            }
        }
        return src;
    }

    let owner = await findOwner(uniq([desktopFile, real]), signal);
    if (signal?.is_cancelled())
        return src;

    let exec = null;
    let inferred = false;
    if (!owner) {
        // certains lanceurs sont crees après linstallation et n'ont pas de paquet proprios
        exec = await resolveExecBinary(argv, signal);
        if (exec && !WINE_RUNNER.test(GLib.path_get_basename(exec.path)) &&
            !GENERIC_BINARIES.test(GLib.path_get_basename(exec.real))) {
            owner = await findOwner(uniq([exec.real, exec.path]), signal);
            inferred = Boolean(owner);
        }
    }
    if (signal?.is_cancelled())
        return src;
    if (owner) {
        src.kind = 'package';
        src.pkg = owner.pkg;
        src.inferred = inferred;
        src.manager = pickPackageManager(owner.type);
        src.label = fmt(_('{0} package'), MANAGER_LABELS[src.manager] ?? owner.type);
        src.supported = Boolean(src.manager);
        if (!src.supported)
            src.reason = _('Could not find a compatible package manager.');
        return src;
    }

    src.kind = 'manual';
    src.label = _('Manual installation');
    const execDir = exec ? GLib.path_get_dirname(exec.real) : null;
    const dirs = uniq([
        execDir,
        execDir ? GLib.path_get_dirname(execDir) : null,
        info.get_string('Path'),
        GLib.path_get_dirname(real),
    ]);
    src.uninstaller = findVendorUninstaller(dirs);
    if (src.uninstaller)
        return unsupported(src, fmt(_('Run the vendor uninstaller yourself: {0}'), src.uninstaller));
    src.supported = true;
    return src;
}

export function sourceNames(src) {
    const names = new Set();
    for (const n of [src.pkg, src.id, src.desktopId?.replace(/\.desktop$/, '')]) {
        if (n)
            names.add(n.toLowerCase());
    }
    return names;
}

export function isProtected(src, customList, protectBuiltin) {
    const names = sourceNames(src);
    const custom = new Set(customList.map(s => s.trim().toLowerCase().replace(/\.desktop$/, ''))
        .filter(Boolean));
    for (const n of names) {
        if (custom.has(n))
            return _('This app is on your protected list.');
        if (protectBuiltin && BUILTIN_PROTECTED.has(n))
            return _('System protection is on for this component.');
    }
    return null;
}

function asRoot(steps) {
    const pkexec = findSystemBin('pkexec');
    if (!pkexec)
        return {error: _('Could not find a system copy of pkexec.')};

    const commands = [];
    for (const [name, ...args] of steps) {
        const executable = findSystemBin(name);
        if (!executable)
            return {error: fmt(_('Could not find a system copy of {0}.'), name)};
        commands.push([pkexec, executable, ...args]);
    }
    return {commands, root: true};
}

// Construit la liste de commandes a exec
export function buildUninstall(src, {deleteData = false, removeUnused = false} = {}) {
    const bin = n => findBin(n) ?? n;
    const pkg = src.pkg;
    const id = ['snap', 'flatpak'].includes(src.kind) ? src.id : pkg;
    const idPattern = src.manager === 'portage'
        ? /^\w[\w.+-]*\/\w[\w.+-]*$/
        : /^\w[\w.+:@~-]*$/;
    if (['package', 'snap', 'flatpak', 'waydroid', 'nix', 'guix'].includes(src.kind) &&
        !idPattern.test(id ?? ''))
        return {error: _('Invalid package or app ID.')};

    switch (src.kind) {
    case 'flatpak': {
        const flatpak = bin('flatpak');
        const scope = src.scope === 'user' ? '--user' : '--system';
        if (src.flatpakRef && !validFlatpakRef(src.flatpakRef, src.id))
            return {error: _('Invalid package or app ID.')};
        const commands = [[
            flatpak, 'uninstall', '--noninteractive', '-y', scope,
            ...(deleteData ? ['--delete-data'] : []), src.flatpakRef ?? src.id,
        ]];
        if (removeUnused)
            commands.push([flatpak, 'uninstall', '--unused', '--noninteractive', '-y', scope]);
        return {commands, root: scope === '--system', files: src.localFiles?.installation};
    }

    case 'snap':
        return asRoot([['snap', 'remove', ...(deleteData ? ['--purge'] : []), src.id]]);

    case 'steam':
        return {
            commands: [[findBin('steam') ?? bin('xdg-open'), `steam://uninstall/${src.steamId}`]],
            external: true,
            note: _('Confirm the uninstall in Steam.'),
        };

    case 'wine': {
        const error = wineError(src.wine);
        if (error)
            return {error};
        const env = findBin('env');
        if (!env)
            return {error: _('Could not find env to start Wine.')};
        const {runner, prefix, arch} = src.wine;
        return {
            commands: [[env, `WINEPREFIX=${prefix}`, ...(arch === null ? [] : [`WINEARCH=${arch}`]),
                runner, 'control', 'appwiz.cpl']],
            external: true,
            notifyOnStart: true,
            note: _('Select this app in Wine’s list of installed programs to uninstall it.'),
        };
    }

    case 'waydroid':
        return {commands: [[bin('waydroid'), 'app', 'remove', pkg]]};

    case 'nix': {
        const script = 'if [ -n "$2" ] && "$2" profile remove "$1" >/dev/null 2>&1; then exit 0; fi; ' +
            'if [ -n "$3" ]; then "$3" -e "$1"; else echo "nix-env not found" >&2; exit 1; fi';
        return {
            commands: [[bin('sh'), '-c', script, 'sh', pkg, findBin('nix') ?? '', findBin('nix-env') ?? '']],
            note: _('For packages managed by Home Manager, edit your configuration.'),
        };
    }

    case 'guix':
        return {commands: [[bin('guix'), 'remove', pkg]]};

    case 'launcher':
        if (src.localFiles) {
            const {installation, data} = src.localFiles;
            return {native: true, files: deleteData ? [...installation, ...data] : installation};
        }
        return {native: true, note: src.launcherNote};

    case 'appimage':
        return {native: true};

    case 'container':
        return {native: true,
            note: _('Only the launcher will be removed. The app stays in the container.')};

    case 'manual': {
        if (src.uninstaller)
            return {error: fmt(_('Run the vendor uninstaller yourself: {0}'), src.uninstaller)};
        if (!src.desktopFile.endsWith('.desktop') || !systemPath(GLib.path_get_dirname(src.desktopFile)))
            return {error: _('The system launcher cannot be removed safely.')};
        return asRoot([['rm', '-f', '--', src.desktopFile]]);
    }

    case 'package':
        break;

    default:
        return {error: src.reason ?? _('This installation source is unsupported.')};
    }

    let steps;
    switch (src.manager) {
    case 'apt': {
        steps = [['apt-get', deleteData ? 'purge' : 'remove', '-y', '--', pkg]];
        if (removeUnused)
            steps.push(['apt-get', 'autoremove', '-y', ...(deleteData ? ['--purge'] : [])]);
        break;
    }
    case 'dpkg':
        steps = [['dpkg', deleteData ? '--purge' : '--remove', pkg]];
        break;
    case 'dnf':
    case 'yum':
        steps = [[src.manager, 'remove', '-y', pkg]];
        break;
    case 'zypper':
        steps = [['zypper', '--non-interactive', 'remove',
            ...(removeUnused ? ['--clean-deps'] : []), pkg]];
        break;
    case 'rpm':
        steps = [['rpm', '-e', pkg]];
        break;
    case 'rpm-ostree':
        return {
            commands: [[bin('rpm-ostree'), 'uninstall', pkg]],
            note: _('Restart to apply the change. Packages in the base image stay installed.'),
        };
    case 'pacman':
        steps = [['pacman', `-R${removeUnused ? 's' : ''}${deleteData ? 'n' : ''}`, '--noconfirm', pkg]];
        break;
    case 'apk':
        steps = [['apk', 'del', ...(deleteData ? ['--purge'] : []), pkg]];
        break;
    case 'xbps':
        steps = [['xbps-remove', '-y', ...(removeUnused ? ['-R'] : []), pkg]];
        break;
    case 'portage':
        steps = [['emerge', '--ask=n', '--unmerge', pkg]];
        break;
    default:
        return {error: _('Unsupported package manager.')};
    }

    return asRoot(steps);
}

export async function previewImpact(src, {deleteData = false, removeUnused = false} = {}, signal) {
    const none = {available: false, packages: [], warning: null};
    if (src.kind !== 'package' || !src.pkg)
        return none;

    const others = list => [...new Set(list)].filter(n => n && n !== src.pkg);

    switch (src.manager) {
    case 'apt': {
        const apt = findBin('apt-get');
        if (!apt)
            return none;
        const res = await run([apt, '-s', deleteData ? 'purge' : 'remove', src.pkg], {timeout: 30, signal});
        if (!res.ok) {
            return {available: true, mode: 'removed', packages: [],
                warning: res.stderr.split('\n').find(l => /^E:/.test(l)) ?? null};
        }
        const names = [...res.stdout.matchAll(/^(?:Remv|Purg) (\S+)/gm)].map(m => m[1]);
        return {available: true, mode: 'removed', packages: others(names), warning: null};
    }
    case 'pacman': {
        const pacman = findBin('pacman');
        if (!pacman)
            return none;
        const res = await run([pacman, `-R${removeUnused ? 's' : ''}p`,
            '--print-format', '%n', src.pkg], {timeout: 30, signal});
        if (!res.ok) {
            const msg = res.stderr.split('\n').filter(Boolean).slice(-2).join(' ').trim();
            return {available: true, mode: 'removed', packages: [], warning: msg || null};
        }
        return {available: true, mode: 'removed',
            packages: others(res.stdout.split('\n').map(l => l.trim())), warning: null};
    }
    case 'dnf':
    case 'yum':
    case 'zypper':
    case 'rpm':
    case 'rpm-ostree': {
        const rpm = findBin('rpm');
        if (!rpm)
            return none;
        const res = await run([rpm, '-q', '--whatrequires', '--qf', '%{NAME}\\n', src.pkg], {timeout: 30, signal});
        const names = res.ok ? res.stdout.split('\n').map(l => l.trim()) : [];
        return {available: true, mode: 'dependents', packages: others(names), warning: null};
    }
    default:
        return none;
    }
}

function removeFile(path, useTrash, removed, errors) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return;
    try {
        if (useTrash)
            file.trash(null);
        else
            file.delete(null);
        removed.push(path);
    } catch (e) {
        errors.push(`${path}: ${e.message}`);
    }
}

function removeUserIcons(iconName, removed, errors) {
    const base = `${HOME}/.local/share/icons/hicolor`;
    let sizes;
    try {
        sizes = Gio.File.new_for_path(base).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
            !error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_DIRECTORY))
            console.warn(`[App Uninstaller] ${base}: ${error.message}`);
        return;
    }
    try {
        let child;
        while ((child = sizes.next_file(null)) !== null) {
            for (const ext of ['png', 'svg', 'xpm'])
                removeFile(`${base}/${child.get_name()}/apps/${iconName}.${ext}`, false, removed, errors);
        }
    } catch (error) {
        errors.push(`${base}: ${error.message}`);
    } finally {
        sizes.close(null);
    }
}

const changedFilesMessage = () => _('The files have changed. Reopen the uninstall menu to review them.');

export function checkLocalUninstall(src, info, files) {
    return checkLauncherFiles(src.localFiles.launcher, files, info.constructor, changedFilesMessage());
}

// supprime les fichiers d'un appimage ou d'un lanceur local
export function nativeUninstall(src, info, {useTrash = true, files = src.localFiles?.installation} = {}) {
    if (src.localFiles) {
        return trashLauncherFiles(src.localFiles.launcher, files, info.constructor, changedFilesMessage());
    }
    const removed = [];
    const errors = [];

    if (src.kind === 'appimage' && src.appImagePath) {
        removeFile(src.appImagePath, useTrash, removed, errors);
        if (errors.length)
            return {ok: false, removed, errors};
    }

    removeFile(src.desktopFile, false, removed, errors);

    const icon = info?.get_string('Icon') ?? '';
    if (src.kind === 'appimage' && icon && !icon.includes('/') && icon.startsWith('appimagekit'))
        removeUserIcons(icon, removed, errors);

    return {ok: errors.length === 0 && removed.length > 0, removed, errors};
}

export function describeSource(src) {
    const lines = [fmt(_('Source: {0}'), src.label)];
    switch (src.kind) {
    case 'wine':
        lines.push(fmt(_('Wine prefix: {0}'), src.wine.prefix));
        break;
    case 'flatpak':
        lines.push(fmt(_('Identifier: {0}'), src.id));
        break;
    case 'snap':
        lines.push(fmt(_('Snap: {0}'), src.id));
        break;
    case 'package':
        lines.push(fmt(_('Package: {0}'), src.pkg));
        if (src.inferred)
            lines.push(_('The package was identified from the executable.'));
        break;
    case 'nix':
    case 'guix':
        lines.push(fmt(_('Likely package: {0}'), src.pkg));
        break;
    case 'appimage':
        lines.push(fmt(_('File: {0}'), src.appImagePath));
        break;
    case 'manual':
    case 'launcher':
        if (!src.localFiles)
            lines.push(_('Only the launcher will be removed. The app files stay in place.'));
        break;
    default:
        break;
    }
    if (src.desktopFile)
        lines.push(fmt(_('Launcher: {0}'), src.desktopFile));
    return lines;
}

export function supportsDeleteData(src) {
    if (src.kind === 'flatpak' || src.kind === 'snap')
        return true;
    if (src.localFiles)
        return src.localFiles.data.length > 0;
    return src.kind === 'package' && ['apt', 'dpkg', 'pacman', 'apk'].includes(src.manager);
}

export function supportsRemoveUnused(src) {
    if (src.kind === 'flatpak')
        return true;
    return src.kind === 'package' && ['apt', 'zypper', 'pacman', 'xbps'].includes(src.manager);
}
