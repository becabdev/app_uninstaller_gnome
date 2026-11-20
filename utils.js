// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const HOME = GLib.get_home_dir();

// répertoires supplementaires : le path du shell est parfois réduit (alpine/fedora/nixos et compagnies...)
const EXTRA_BIN_DIRS = [
    '/run/wrappers/bin',
    '/run/current-system/sw/bin',
    '/usr/local/bin', '/usr/bin', '/bin',
    '/usr/local/sbin', '/usr/sbin', '/sbin',
    '/snap/bin', '/var/lib/snapd/snap/bin',
    '/var/lib/flatpak/exports/bin',
    `${HOME}/.nix-profile/bin`,
    '/nix/var/nix/profiles/default/bin',
    `${HOME}/.guix-profile/bin`,
    '/run/current-system/profile/bin',
    `${HOME}/.local/bin`,
];

export function findBin(name) {
    const inPath = GLib.find_program_in_path(name);
    if (inPath)
        return inPath;
    for (const dir of EXTRA_BIN_DIRS) {
        const path = `${dir}/${name}`;
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) &&
            !GLib.file_test(path, GLib.FileTest.IS_DIR))
            return path;
    }
    return null;
}

const SYSTEM_BIN_DIRS = [
    '/run/wrappers/bin',
    '/run/current-system/sw/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/usr/local/sbin',
];

export function systemPath(path, symlinks = 0) {
    if (!GLib.path_is_absolute(path) || symlinks >= 40)
        return null;

    let current = '/';
    const parts = path.split('/').filter(Boolean);
    try {
        for (const [index, part] of parts.entries()) {
            current = GLib.build_filenamev([current, part]);
            const file = Gio.File.new_for_path(current);
            const info = file.query_info('standard::symlink-target,access::can-write,unix::uid,unix::mode',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (!info.has_attribute('unix::uid') || info.get_attribute_uint32('unix::uid') !== 0)
                return null;
            const target = info.has_attribute('standard::symlink-target')
                ? info.get_symlink_target() : null;
            if (target) {
                const absoluteTarget = GLib.path_is_absolute(target)
                    ? target : GLib.build_filenamev([GLib.path_get_dirname(current), target]);
                return systemPath(GLib.build_filenamev([absoluteTarget, ...parts.slice(index + 1)]),
                    symlinks + 1);
            }
            if (!info.has_attribute('unix::mode') ||
                info.get_attribute_boolean('access::can-write') ||
                (info.get_attribute_uint32('unix::mode') & 0o022))
                return null;
        }
    } catch (_error) {
        return null;
    }
    return current;
}

export function findSystemBin(name) {
    for (const dir of SYSTEM_BIN_DIRS) {
        const path = `${dir}/${name}`;
        if (systemPath(path) &&
            GLib.file_test(path, GLib.FileTest.IS_REGULAR) &&
            GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }
    return null;
}

export async function run(argv, {timeout = 20, signal = null} = {}) {
    if (signal?.is_cancelled())
        return {ok: false, status: -1, stdout: '', stderr: ''};

    let timeoutId = 0;
    let cancelId = 0;
    const cancellable = new Gio.Cancellable();
    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.setenv('LC_ALL', 'C', true);
        launcher.setenv('LANGUAGE', 'C', true);
        const proc = launcher.spawnv(argv);

        const stop = () => {
            if (cancellable.is_cancelled())
                return;
            cancellable.cancel();
            proc.force_exit();
        };
        if (timeout > 0) {
            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
                timeoutId = 0;
                stop();
                return GLib.SOURCE_REMOVE;
            });
        }
        if (signal)
            cancelId = signal.connect(stop);

        const [stdout, stderr] = await new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, cancellable, (subprocess, result) => {
                try {
                    const [, out, err] = subprocess.communicate_utf8_finish(result);
                    resolve([out, err]);
                } catch (error) {
                    reject(error);
                }
            });
        });
        return {
            ok: proc.get_successful(),
            status: proc.get_if_exited() ? proc.get_exit_status() : -1,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
        };
    } catch (error) {
        return {ok: false, status: -1, stdout: '', stderr: String(error?.message ?? error)};
    } finally {
        if (cancelId)
            signal.disconnect(cancelId);
        if (timeoutId)
            GLib.Source.remove(timeoutId);
    }
}

export function quoteArg(arg) {
    return /^[\w@%+=:,./-]+$/.test(arg) ? arg : GLib.shell_quote(arg);
}

export function formatCommand(argv) {
    return argv.map(quoteArg).join(' ');
}

export function fmt(template, ...values) {
    return template.replace(/\{(\d+)\}/g, (match, index) =>
        Number(index) < values.length ? String(values[Number(index)]) : match);
}

export function osReleaseIds() {
    for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
        try {
            const [ok, bytes] = GLib.file_get_contents(file);
            if (!ok)
                continue;
            const text = new TextDecoder().decode(bytes);
            const ids = [];
            for (const line of text.split('\n')) {
                const m = line.match(/^(ID|ID_LIKE)=(.*)$/);
                if (m) {
                    ids.push(...m[2].replace(/["']/g, '').toLowerCase()
                        .split(/\s+/).filter(Boolean));
                }
            }
            return ids;
        } catch (_error) {
        }
    }
    return [];
}

export async function realPath(path, signal) {
    const bin = findBin('readlink');
    if (!bin)
        return path;
    const res = await run([bin, '-f', path], {timeout: 5, signal});
    const out = res.stdout.trim();
    return res.ok && out ? out : path;
}
