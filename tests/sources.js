// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const dir = GLib.dir_make_tmp('app-uninstaller-test-XXXXXX');
const home = `${dir}/home`;
const localData = `${home}/.local/share`;
for (const [key, value] of Object.entries({
    HOME: home,
    XDG_DATA_HOME: localData,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_STATE_HOME: `${home}/.local/state`,
    XDG_DATA_DIRS: `${dir}/system-data`,
}))
    GLib.setenv(key, value, true);

GLib.mkdir_with_parents(`${home}/.config`, 0o755);
GLib.file_set_contents(`${home}/.config/user-dirs.dirs`, 'XDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n');
GLib.reload_user_special_dirs_cache();

const {buildUninstall, checkLocalUninstall, describeSource, detectSource, isProtected,
    nativeUninstall, previewImpact, supportsDeleteData} = await import('../sources.js');
const {run} = await import('../utils.js');
const {default: appInfoNamespace} = await import('gi://GioUnix').catch(() => ({default: Gio}));

function equal(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}\nExpected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const queries = `${dir}/queries`;

function write(name, text, executable = false) {
    const path = `${dir}/${name}`;
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, text);
    if (executable) {
        Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', 0o755,
            Gio.FileQueryInfoFlags.NONE, null);
    }
    return path;
}

function command(name, body) {
    return write(name, `#!/bin/sh\n${body}\n`, true);
}

function desktop(name, exec, extra = '') {
    const path = write(`${name}.desktop`,
        `[Desktop Entry]\nName=Fixture\nType=Application\nExec=${exec}\n${extra}`);
    return appInfoNamespace.DesktopAppInfo.new_from_filename(path);
}

try {
    GLib.setenv('PATH', `${dir}:${GLib.getenv('PATH')}`, true);
    GLib.setenv('APP_UNINSTALLER_TEST_QUERIES', queries, true);
    GLib.unsetenv('WINEPREFIX');
    GLib.unsetenv('WINEARCH');
    GLib.file_set_contents(queries, '');

    command('readlink', `printf '%s\n' "$2" >> "$APP_UNINSTALLER_TEST_QUERIES"
printf '%s\n' "$2"`);
    for (const name of ['pacman', 'rpm', 'apk', 'xbps-query', 'qfile'])
        command(name, 'exit 1');
    command('dpkg', `
case "$2" in
    */owned.desktop) printf 'fixture:amd64: %s\n' "$2" ;;
    */fixture-exec|/bin/sh) printf 'fixture-exec: %s\n' "$2" ;;
    *) exit 1 ;;
esac`);
    command('apt-get', `
case "$1 $2" in
    '-s remove') printf 'Remv fixture\nRemv extra\nRemv extra\n' ;;
    '-s purge') printf 'E: solver failure\n' >&2; exit 1 ;;
    *) exit 2 ;;
esac`);
    const deployment = `${dir}/flatpak deployment`;
    command('flatpak', `
case "$*" in
    'info --system org.example.Fixture') printf 'Origin: fixture-remote\n' ;;
    'info --user --show-ref --show-location org.example.Wrapped')
        printf '%s %s\n' 'app/org.example.Wrapped/x86_64/stable' '${deployment}' ;;
    'info --user app/org.example.Wrapped/x86_64/stable') printf 'Origin: user-remote\n' ;;
    'uninstall --noninteractive -y --user app/org.example.Wrapped/x86_64/stable') exit 0 ;;
    *) exit 1 ;;
esac`);

    const executable = command('fixture-exec', 'exit 0');
    const owned = desktop('owned', executable);
    const ownedSource = await detectSource(owned);
    equal([ownedSource.kind, ownedSource.manager, ownedSource.pkg, ownedSource.inferred],
        ['package', 'apt', 'fixture', false], 'The launcher owner takes precedence');
    const [, readlinkQueries] = GLib.file_get_contents(queries);
    equal(new TextDecoder().decode(readlinkQueries).trim().split('\n'), [owned.get_filename()],
        'An owned launcher needs no executable lookup');

    const inferred = await detectSource(desktop('unowned', executable));
    equal([inferred.kind, inferred.manager, inferred.pkg, inferred.inferred],
        ['package', 'apt', 'fixture-exec', true], 'An unowned launcher falls back to the executable');
    const manual = await detectSource(desktop('manual', '/bin/sh'));
    equal(manual.kind, 'manual', 'A generic executable does not identify the app package');

    const flatpak = await detectSource(desktop('flatpak', executable, 'X-Flatpak=org.example.Fixture\n'));
    equal([flatpak.scope, flatpak.origin], ['system', 'fixture-remote'], 'Flatpak scope and origin');
    const plan = buildUninstall(flatpak, {deleteData: true, removeUnused: true});
    equal(plan.commands.map(argv => argv.slice(1)), [
        ['uninstall', '--noninteractive', '-y', '--system', '--delete-data', 'org.example.Fixture'],
        ['uninstall', '--unused', '--noninteractive', '-y', '--system'],
    ], 'Flatpak removal and cleanup use the same scope');
    equal(plan.root, true, 'System Flatpak requires confirmation');
    equal(buildUninstall({...flatpak, id: '--all'}).error, 'Invalid package or app ID.', 'Invalid ID');
    equal(isProtected(ownedSource, [' Fixture.desktop '], false),
        'This app is on your protected list.', 'Protected names are normalized');

    const impact = await previewImpact(ownedSource);
    equal(impact.packages, ['extra'], 'APT preview excludes the target and removes duplicates');
    const failedImpact = await previewImpact(ownedSource, {deleteData: true});
    equal(failedImpact.warning, 'E: solver failure', 'APT preview retains the useful error');

    const launchers = 'home/.local/share/applications';
    const wrapper = command(`${launchers}/Example Program`, 'exit 0');
    command('flatpak deployment/files/bin/Example Program', 'exit 0');
    const wrapperInfo = desktop(`${launchers}/org.example.Wrapped`, `"${wrapper}"`);
    const wrapperSource = await detectSource(wrapperInfo);
    const wrapperPlan = buildUninstall(wrapperSource);
    equal([wrapperSource.kind, wrapperSource.scope, wrapperPlan.commands[0].slice(1)],
        ['flatpak', 'user', ['uninstall', '--noninteractive', '-y', '--user', 'app/org.example.Wrapped/x86_64/stable']],
        'A verified Flatpak wrapper selects the exact installed app ref and scope');
    equal(wrapperPlan.files?.map(entry => entry.path), [wrapper], 'The wrapper is also listed for cleanup');
    command(`${launchers}/Example Program`, 'exit 1');
    equal(Boolean(checkLocalUninstall(wrapperSource, wrapperInfo, wrapperPlan.files)), true,
        'A wrapper change invalidates the plan before the Flatpak is removed');
    equal((await detectSource(wrapperInfo)).kind, 'launcher',
        'A launcher ID alone does not identify a differently backed Flatpak wrapper');
    command(`${launchers}/Example Program`, 'exit 0');
    const verifiedWrapper = await detectSource(wrapperInfo);
    const verifiedPlan = buildUninstall(verifiedWrapper);
    equal((await run(verifiedPlan.commands[0])).ok, true, 'The Flatpak plan runs against the expected mock command');
    equal(nativeUninstall(verifiedWrapper, wrapperInfo, {files: verifiedPlan.files}).removed,
        [wrapper, wrapperInfo.get_filename()], 'Local cleanup removes the verified wrapper and shortcut');

    command('python3', 'exit 1');
    const pythonRoot = `${localData}/event-hub/app`;
    write('home/.local/share/event-hub/app/eventhub/gui/__main__.py', '');
    const backup = write('home/.local/share/event-hub/backups/profile', 'saved');
    const pythonConfig = write('home/.config/event-hub/settings', 'saved');
    const pythonExec = `env "PYTHONPATH=${pythonRoot}" python3 -m eventhub.gui`;
    const pythonInfo = desktop(`${launchers}/event-hub`, pythonExec);
    const startup = desktop('home/.config/autostart/event-hub', `${pythonExec} --tray`).get_filename();
    const pythonSource = await detectSource(pythonInfo);
    const pythonPlan = buildUninstall(pythonSource);
    equal(pythonPlan.files?.map(entry => entry.path), [pythonRoot, startup],
        'A Python launcher identifies the dedicated module tree and matching autostart file');
    equal(buildUninstall(pythonSource, {deleteData: true}).files.map(entry => entry.path),
        [pythonRoot, startup, GLib.path_get_dirname(pythonConfig)], 'Settings can be selected for removal');
    const sharedPython = desktop(`${launchers}/shared-python`,
        `env "PYTHONPATH=${home}/other:${pythonRoot}" python3 -m other.gui`);
    equal(buildUninstall(await detectSource(pythonInfo)).files, undefined,
        'A second launcher referencing the module tree protects it');
    Gio.File.new_for_path(sharedPython.get_filename()).delete(null);
    equal(nativeUninstall(pythonSource, pythonInfo, {files: pythonPlan.files}).removed,
        [pythonRoot, startup, pythonInfo.get_filename()], 'The approved Python plan removes app files and shortcuts');
    equal([backup, pythonConfig].map(path => GLib.file_test(path, GLib.FileTest.EXISTS)), [true, true],
        'Python app backups and settings survive the default removal');

    const wine = command('wine', 'exit 0');
    const wine64 = command('runners/wine64', `printf '%s\n' "$WINEPREFIX" "$WINEARCH" "$@"`);
    write('home/.wine/system.reg', '');
    GLib.mkdir_with_parents(`${home}/.wine/dosdevices`, 0o755);
    const defaultWine = await detectSource(desktop(`${launchers}/wine/draw`,
        String.raw`wine "C:\\Program Files\\Draw\\draw.exe" %f`));
    equal([defaultWine.kind, defaultWine.wine?.runner, defaultWine.wine?.prefix], ['wine', wine, `${home}/.wine`],
        'Direct Windows executables use the default prefix and the launcher’s Wine runtime');

    const customPrefix = `${home}/Wine apps/Studio ; test`;
    write('home/Wine apps/Studio ; test/system.reg', '');
    GLib.mkdir_with_parents(`${customPrefix}/dosdevices`, 0o755);
    const customWine = await detectSource(desktop(`${launchers}/wine/studio`,
        `env "WINEPREFIX=${customPrefix}" WINEARCH=win64 "${wine64}" start /Unix "${customPrefix}/Studio.lnk" %U`));
    const winePlan = buildUninstall(customWine);
    equal([customWine.kind, winePlan.external], ['wine', true], 'Wine shortcuts use the Wine control panel');
    equal(describeSource(customWine).includes(`Wine prefix: ${customPrefix}`), true,
        'The confirmation identifies the selected Wine prefix');
    equal(winePlan.commands[0].slice(1), [`WINEPREFIX=${customPrefix}`, 'WINEARCH=win64', wine64, 'control', 'appwiz.cpl'],
        'A custom runner and prefix open the applet without executing the launcher’s Windows application');
    const wineResult = await run(winePlan.commands[0]);
    equal([wineResult.ok, wineResult.stdout.trim().split('\n')], [true, [customPrefix, 'win64', 'control', 'appwiz.cpl']],
        'The prefix is passed intact as an environment variable');

    GLib.setenv('WINEPREFIX', customPrefix, true);
    const inheritedWine = await detectSource(desktop(`${launchers}/wine/inherited`, 'wine setup.exe'));
    equal(inheritedWine.wine?.prefix, customPrefix, 'The session prefix is used when the launcher has no override');
    GLib.unsetenv('WINEPREFIX');
    const handler = await detectSource(desktop(`${launchers}/wine-handler`, 'wine start /unix %f'));
    const tool = await detectSource(desktop(`${launchers}/wine-settings`, 'wine winecfg.exe'));
    equal([handler.kind, tool.kind], ['launcher', 'launcher'], 'Wine handlers and built-in tools are not Windows apps');
    Gio.File.new_for_path(`${customPrefix}/dosdevices`).delete(null);
    equal(Boolean(buildUninstall(customWine).error), true, 'A stale Wine plan cannot initialize a missing prefix');
    const missingWine = await detectSource(desktop(`${launchers}/wine/missing`,
        `env "WINEPREFIX=${customPrefix}" wine missing.exe`));
    equal([missingWine.kind, buildUninstall(missingWine).native], ['launcher', true],
        'A stale Wine shortcut can still be removed locally');

    const bundle = `${home}/Applications/Studio-1.2`;
    const studio = command('home/Applications/Studio-1.2/bin/studio', 'exit 0');
    write('home/Applications/Studio-1.2/assets/theme.css', '');
    const alias = `${home}/.local/bin/studio`;
    GLib.mkdir_with_parents(GLib.path_get_dirname(alias), 0o755);
    Gio.File.new_for_path(alias).make_symbolic_link('../../Applications/Studio-1.2/bin/studio', null);
    const config = `${home}/.config/org.example.Studio`;
    const preferences = write('home/.config/org.example.Studio/settings', 'retained');
    const icon = write('home/.local/share/icons/hicolor/48x48/apps/studio.svg', '');
    const studioInfo = desktop(`${launchers}/org.example.Studio`, `env FEATURE=1 "${alias}" %F`,
        `Icon=${icon}\n`);
    const studioSource = await detectSource(studioInfo);
    const studioPlan = buildUninstall(studioSource);
    equal(studioPlan.files?.map(entry => entry.path), [bundle, alias, icon],
        'A local launcher identifies its dedicated directory, executable symlink and icon');
    equal(supportsDeleteData(studioSource), true, 'Matching XDG data is offered as an option');
    equal(buildUninstall(studioSource, {deleteData: true}).files.map(entry => entry.path),
        [bundle, alias, icon, config], 'The data option adds the matching directory to the preview');

    const sharedIcon = desktop(`${launchers}/uses-studio-icon`, '/bin/sh', 'Icon=studio\n');
    const studioWithoutIcon = await detectSource(studioInfo);
    equal(buildUninstall(studioWithoutIcon).files.map(entry => entry.path), [bundle, alias],
        'A themed icon in use by another launcher is left alone');
    Gio.File.new_for_path(sharedIcon.get_filename()).delete(null);

    const sharedInfo = desktop(`${launchers}/studio-settings`, '/bin/sh',
        `Actions=Edit;\n[Desktop Action Edit]\nName=Edit\nExec=${studio}\n`);
    const sharedSource = await detectSource(studioInfo);
    equal(buildUninstall(sharedSource).files, undefined, 'A second desktop action protects a shared bundle');
    const sharedResult = nativeUninstall(studioSource, studioInfo, {files: studioPlan.files});
    equal([sharedResult.ok, sharedResult.removed], [false, []],
        'A new launcher sharing the bundle invalidates a previously approved plan');
    Gio.File.new_for_path(sharedInfo.get_filename()).delete(null);

    const result = nativeUninstall(studioSource, studioInfo, {files: studioPlan.files});
    equal([result.ok, result.removed], [true, [bundle, alias, icon, studioInfo.get_filename()]],
        `The confirmed plan moves the app, link, icon and launcher to the Trash: ${result.errors.join(', ')}`);
    equal(GLib.file_test(preferences, GLib.FileTest.EXISTS), true, 'App settings survive by default');
    equal(GLib.file_test(`${localData}/Trash/files/Studio-1.2/assets/theme.css`, GLib.FileTest.EXISTS),
        true, 'Bundle assets are moved together');

    const editor = command('home/.local/bin/editor.sh', 'exit 0');
    const editorInfo = desktop(`${launchers}/editor`, editor);
    const editorData = write('home/.local/state/editor/session', '');
    const editorSource = await detectSource(editorInfo);
    const editorPlan = buildUninstall(editorSource, {deleteData: true});
    equal(editorPlan.files?.map(entry => entry.path), [editor, GLib.path_get_dirname(editorData)],
        'A standalone executable and opted-in app state are identified');
    const saved = Gio.File.new_for_path(`${editor}.original`);
    Gio.File.new_for_path(editor).move(saved, Gio.FileCopyFlags.NONE, null, null);
    command('home/.local/bin/editor.sh', 'exit 1');
    equal(nativeUninstall(editorSource, editorInfo, {files: editorPlan.files}).removed, [],
        'A replacement executable invalidates the preview before any removal');
    const currentEditor = await detectSource(editorInfo);
    const currentPlan = buildUninstall(currentEditor, {deleteData: true});
    equal(nativeUninstall(currentEditor, editorInfo, {files: currentPlan.files}).ok, true,
        'The updated plan removes the standalone executable and chosen data');
    equal(GLib.file_test(editorData, GLib.FileTest.EXISTS), false,
        'Opted-in data is moved to the Trash');

    const unrelated = command('home/Documents/archiver', 'exit 0');
    const launcherOnly = await detectSource(desktop(`${launchers}/archiver`, unrelated));
    equal(buildUninstall(launcherOnly).files, undefined, 'Executables in documents are left alone');
    const downloadFolder = `${home}/Téléchargements/viewer-2.4-linux-x86_64`;
    const viewer = command('home/Téléchargements/viewer-2.4-linux-x86_64/viewer', 'exit 0');
    const downloaded = await detectSource(desktop(`${launchers}/viewer`, `"${viewer}"`));
    equal([downloaded.label, buildUninstall(downloaded).files?.map(entry => entry.path)],
        ['Standalone installation', [downloadFolder]],
        'An extracted download is recognized when its name and executable match the launcher');
    const unrelatedDownload = command('home/Téléchargements/ambiguous-linux-arm64/run.sh', 'exit 0');
    const ambiguous = await detectSource(desktop(`${launchers}/ambiguous`, `"${unrelatedDownload}"`));
    equal(buildUninstall(ambiguous).files, undefined,
        'A matching download folder alone does not identify the application files');
    const managed = command('home/.local/bin/fixture-exec', 'exit 0');
    const managedShortcut = await detectSource(desktop(`${launchers}/fixture-exec`, managed));
    equal(buildUninstall(managedShortcut).files, undefined, 'A package-owned executable is left alone');
    const vendorApp = command('home/opt/vendor/vendor', 'exit 0');
    command('home/opt/vendor/uninstall.sh', 'exit 0');
    const vendorShortcut = await detectSource(desktop(`${launchers}/vendor`, vendorApp));
    equal(vendorShortcut.supported, false, 'A vendor uninstaller takes precedence over smart cleanup');

    const signal = new Gio.Cancellable();
    const pending = run(['/bin/sleep', '30'], {timeout: 0, signal});
    signal.cancel();
    equal((await pending).status, -1, 'Cancellation stops an active subprocess');
    equal((await run(['/bin/true'], {signal})).ok, false, 'A cancelled request never starts');

    print('Source detection, Wine handoff, standalone cleanup, uninstall plans, preview and subprocess cancellation passed');
} finally {
    const cleanup = await run(['/bin/rm', '-r', '--', dir]);
    if (!cleanup.ok)
        printerr(cleanup.stderr);
}
