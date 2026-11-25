'''Unified entry point of Military Planner: start and stop.

The HTTP server and its PostgreSQL run in a detached service process that
survives the console window: closing the window never kills the application
and never triggers database crash recovery on the next start.

Usage (from Windows: MilitaryPlanner.bat, which forwards here):

    launcher.py              start the service if it is not running and
                             open the site in the browser; wait until ready
    launcher.py --stop       stop the service and the local database
    launcher.py --serve      internal mode of the detached service
                             (not meant to be run by hand)
    launcher.py --foreground run the server in this console (development,
                             Ctrl+C stops the service this window owns)
'''

from __future__ import annotations
import base64
import ctypes
import os
import subprocess
import sys
import time
import traceback
import urllib.error
CREATE_NO_WINDOW = 134217728
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path
ROOT = Path(__file__).resolve().parent if not getattr(sys, 'frozen', False) else Path(sys.executable).resolve().parent
_DETACHED_FLAGS = 16777736
START_TIMEOUT_SECONDS = 180
TAKEOVER_GRACE_SECONDS = 20

def _application_root() -> 'Path':
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent

def _configure_bundle(application_root: 'Path') -> 'None':
    if not getattr(sys, 'frozen', False):
        return
    postgres_bin = application_root / 'postgres' / 'bin'
    if not postgres_bin.is_dir():
        raise RuntimeError(f'Bundled PostgreSQL binaries not found: {postgres_bin}')
    os.environ['MILITARY_PLANNER_PG_BIN'] = str(postgres_bin)
    os.environ.pop('MILITARY_PLANNER_DATABASE_URL', None)
    os.environ.pop('MILITARY_PLANNER_SEED_DUMP', None)
    seed_dump = application_root / 'initial-data.dump'
    if seed_dump.is_file():
        os.environ['MILITARY_PLANNER_SEED_DUMP'] = str(seed_dump)

def _runtime_dir() -> 'Path':
    local_app_data = os.environ.get('LOCALAPPDATA')
    root = Path(local_app_data) if local_app_data else Path.home() / 'AppData' / 'Local'
    directory = root / 'MilitaryPlanner'
    directory.mkdir(parents=True, exist_ok=True)
    return directory

def _log_directory() -> 'Path':
    directory = _runtime_dir() / 'logs'
    directory.mkdir(parents=True, exist_ok=True)
    return directory

def _pid_file() -> 'Path':
    return _runtime_dir() / 'server.pid'

def _service_log() -> 'Path':
    return _log_directory() / 'service.log'

def _log_startup_error(exc: 'BaseException') -> 'None':
    '''Persist the failure reason: the console window closes too fast
    for users to report what went wrong on machines without a developer.'''

    try:
        log_path = _log_directory() / 'launcher.log'
        stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with log_path.open('a', encoding='utf-8') as log_file:
            log_file.write(f'\n===== {stamp} =====\n')
            log_file.write(''.join(traceback.format_exception(exc)))
    except OSError:
        return

def _trace(message: 'str') -> 'None':
    '''Step-by-step diagnostics: enabled by MILITARY_PLANNER_LAUNCHER_DEBUG.'''

    if os.environ.get('MILITARY_PLANNER_LAUNCHER_DEBUG'):
        print(f'[launcher {os.getpid()}] {message}', file=sys.stderr, flush=True)

def _server_port() -> 'int':
    return int(os.environ.get('MILITARY_PLANNER_PORT', '8000'))

def _server_url() -> 'str':
    return f'http://127.0.0.1:{_server_port()}/'

def _health_url() -> 'str':
    return f'http://127.0.0.1:{_server_port()}/api/health'

def _healthy() -> 'bool':
    '''True when the application server AND the database are reachable.

    ``/`` is served by the SPA fallback even when the database is dead, so
    it cannot be trusted: a service process left alive with a killed
    PostgreSQL would look healthy forever. ``/api/health`` checks the real
    store (503 on database failure); anything except 200 is unhealthy.
    '''

    try:
        with urllib.request.urlopen(_health_url(), timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False

def _process_alive(pid: 'int | None') -> 'bool':
    if pid is None:
        return False
    from backend.postgres_runtime import process_alive
    return process_alive(pid)

SHORTCUT_NAME = 'Планирование ВВСТ.lnk'

def _ensure_shortcut() -> 'None':
    '''Create or refresh the desktop shortcut next to the .bat.

    A .lnk stores absolute paths, so the one created by the build is
    stale until the first start here, and the folder may be moved. Simply
    (re)write the shortcut on every successful start: it is cheap and
    keeps it always pointing at this copy, wherever it lives. The icon
    path is absolute and always points at the icon next to the .lnk.
    '''

    try:
        _ensure_shortcut_inner()
        return
    except Exception as exc:
        _ensure_shortcut_debug(f'shortcut update crashed: {exc}')

def _ensure_shortcut_debug(message: 'str') -> 'None':
    try:
        log_path = _log_directory() / 'launcher.log'
        stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with log_path.open('a', encoding='utf-8') as log_file:
            log_file.write(f'===== shortcut {stamp} =====' + '\n' + message + '\n')
    except OSError:
        return

_SHORTCUT_VBS = 'Set sh = WScript.CreateObject("WScript.Shell")\nSet w = sh.CreateShortcut(WScript.Arguments(0))\nw.TargetPath = WScript.Arguments(1)\nw.WorkingDirectory = WScript.Arguments(2)\nw.IconLocation = WScript.Arguments(3) & ",0"\nw.Save\nWScript.Echo "SHORTCUT_OK"\n'

def _write_shortcut(link_path, target: 'Path', workdir: 'Path') -> 'bool':
    """(Re)build the .lnk via WSH (cscript + a temporary .vbs file).

    Hand-rolled COM vtables crash, and PowerShell's -EncodedCommand
    failed from the frozen exe; WScript.Shell driven from a plain script
    file is the same engine Explorer itself uses and proved reliable.
    Folder names travel as process arguments (UTF-16), so Cyrillic
    paths survive without any encoding tricks. The icon is the one the
    package keeps next to the .lnk; the path is stored ABSOLUTE (a
    relative 'icon.ico' is not resolved by the shell), so it always
    points at the local folder where the shortcut itself lives. The
    target, working directory and icon are absolute and are (re)written
    on every successful start, healing a shortcut carried over from
    another folder.
    Returns True when the shortcut file was written.
    """

    if not str(target).strip():
        return False
    icon = Path(link_path).parent / 'icon.ico'
    script_path = _runtime_dir() / '_fix-shortcut.vbs'
    try:
        script_path.write_text(_SHORTCUT_VBS, encoding='ascii')
        result = subprocess.run(['cscript.exe', '//nologo', str(script_path), str(link_path), str(target), str(workdir), str(icon)], capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
        ok = result.returncode == 0 and b'SHORTCUT_OK' in result.stdout
        if not ok:
            detail = (result.stdout + result.stderr).decode('mbcs', 'replace').strip()[:200]
            _ensure_shortcut_debug(f'cscript rc={result.returncode}: {detail}')
        return ok
    except Exception as exc:
        _ensure_shortcut_debug(f'shortcut rebuild failed: {exc}')
        return False

def _ensure_shortcut_inner() -> 'None':
    bat = ROOT / 'MilitaryPlanner.bat'
    icon = ROOT / 'icon.ico'
    if not (bat.is_file() and icon.is_file()):
        return
    written = _write_shortcut(ROOT / SHORTCUT_NAME, bat, ROOT)
    if not written:
        _ensure_shortcut_debug('shortcut save failed')

def _close_console_window(delay_seconds: 'float'=2.0) -> 'None':
    """Close the launcher's own console window after a successful start.

    The service is already running detached, so the window has no job
    left. Only close a console created for this program itself (a double
    click on the .exe hosts exactly the PyInstaller bootloader + child):
    a console shared with a shell (cmd, PowerShell, the .bat window)
    belongs to someone else and is left alone.
    """

    if getattr(sys, '_mp_closing', False):
        return
    sys._mp_closing = True
    try:
        import ctypes
        from ctypes import wintypes
        buffer = (wintypes.DWORD * 64)()
        attached = int(ctypes.windll.kernel32.GetConsoleProcessList(buffer, 64))
        window = int(ctypes.windll.kernel32.GetConsoleWindow())
        if not window or attached != 2:
            return
        time.sleep(delay_seconds)
        WM_CLOSE = 16
        ctypes.windll.user32.PostMessageW(wintypes.HWND(window), wintypes.UINT(WM_CLOSE), 0, 0)
        return
    except Exception:
        return

def _spawn_service() -> 'int | None':
    '''Start the detached service process; return its PID.'''

    if getattr(sys, 'frozen', False):
        command = [sys.executable, '--serve']
    else:
        command = [sys.executable, str(ROOT / 'launcher.py'), '--serve']
    environment = os.environ.copy()
    environment['MILITARY_PLANNER_AUTOPEN'] = '0'
    log_file = _service_log().open('ab')
    try:
        for creationflags in _DETACHED_FLAGS, _DETACHED_FLAGS & -16777217:
            try:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log_file, stderr=log_file, env=environment, creationflags=creationflags, close_fds=True)
            except (OSError, ValueError):
                continue
            process.pid
            log_file.close()
            return
    finally:
        log_file.close()
    try:
        raise RuntimeError('Windows did not allow starting the detached background service.')
    finally:
        log_file.close()

def _service_lock(retry_seconds: 'float'=0.0):
    '''Exclusive, self-releasing lock of the service/start instance.

    Two double-clicks seconds apart must not race each other into two
    services. A file lock tied to the process handle disappears when the
    process dies, including taskkill - no stale marker can block a start.
    Returns the open handle: closing (or process death) releases the lock.
    '''

    import msvcrt
    lock_path = _runtime_dir() / 'service.lock'
    handle = open(lock_path, 'a+b')
    deadline = time.monotonic() + retry_seconds
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        return handle
    except OSError:
        if time.monotonic() >= deadline:
            handle.close()
            raise
        time.sleep(0.2)

def _run_service() -> 'None':
    '''Body of the detached service process (--serve).'''

    _trace('serve: begin')
    if _healthy():
        _trace('serve: already healthy, exiting')
        return
    try:
        lock = _service_lock()
        _trace('serve: lock acquired')
    except OSError:
        return
    try:
        if _healthy():
            _release_lock(lock)
            return
    finally:
        _release_lock(lock)
    try:
        from backend.postgres_runtime import PostgresRuntime
        from backend.server import run as run_server
        frontend_root = ROOT / 'release'
        if not (frontend_root / 'index.html').is_file():
            raise RuntimeError(f'Frontend build not found in {frontend_root}. Run `npm run build` before starting the app.')
        runtime = PostgresRuntime()
        _trace('serve: starting PostgreSQL...')
        runtime._start()
        _trace('serve: PostgreSQL ready')
        try:
            try:
                os.environ['MILITARY_PLANNER_DATABASE_URL'] = runtime.database_url
                with _pid_file().open('w', encoding='ascii') as pid_file:
                    pid_file.write(str(os.getpid()))
            finally:
                run_server(static_root=frontend_root)
        finally:
            os.environ.pop('MILITARY_PLANNER_DATABASE_URL', None)
            try:
                _pid_file().unlink()
            except OSError:
                pass
            _release_lock(lock)
    finally:
        _release_lock(lock)

def _military_planner_processes() -> 'list[tuple[int, str]]':
    '''(pid, command line) of every MilitaryPlanner.exe on the machine.

    Used only by the sweep below; [] when the query fails.
    '''

    try:
        result = subprocess.run(['powershell', '-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'MilitaryPlanner.exe\'" | ForEach-Object { \'{0}|{1}\' -f $_.ProcessId, $_.CommandLine }'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30, check=False, creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode:
        return []
    pairs = []
    for line in result.stdout.splitlines():
        parts = line.split('|', 1)
        if len(parts) != 2:
            continue
        if parts[0].strip().isdigit():
            pairs.append((int(parts[0]), parts[1]))
    return pairs

def _running_service_pids() -> 'list[int]':
    '''PIDs of the service process(es) of this application.

    The authoritative source is the pid file the running service wrote.
    The portable EXE additionally sweeps stray MilitaryPlanner.exe instances
    by image name - but only ones whose command line carries `--serve`: a
    start or stop invocation never matches, so the command never kills
    itself.
    '''

    pids = []
    try:
        pids.append(int(_pid_file().read_text(encoding='ascii').strip()))
    except (OSError, ValueError):
        pass
    if getattr(sys, 'frozen', False):
        for pid, command_line in _military_planner_processes():
            if '--serve' not in command_line:
                continue
            if pid != os.getpid():
                pids.append(pid)
    return sorted({pid for pid in pids if pid != os.getpid()})

def _kill(pids: 'list[int]') -> 'None':
    for pid in pids:
        subprocess.run(['taskkill', '/F', '/PID', str(pid)], capture_output=True, text=True, errors='replace', timeout=15, check=False, creationflags=CREATE_NO_WINDOW)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if all((not _process_alive(pid) for pid in pids)):
            return
        time.sleep(0.5)

def _stop_postgres_quietly() -> 'bool':
    try:
        from backend.postgres_runtime import (_data_directory, _postgres_bin, stop_running_server)
        return stop_running_server(_postgres_bin(), _data_directory())
    except Exception:
        return False

def _do_stop() -> 'bool':
    '''Stop the service process, then the database. Returns app-server state.'''

    _trace('stop: querying service pids')
    pids = _running_service_pids()
    was_running = bool(pids) or _healthy()
    if was_running:
        print('Останавливаю Military Planner...', flush=True)
    _trace(f'stop: pids={pids}, killing')
    _kill(pids)
    _trace('stop: killed')
    try:
        _pid_file().unlink()
    except OSError:
        pass
    stopped = _stop_postgres_quietly()
    _trace(f'stop: postgres stopped={stopped}')
    if stopped:
        print('База данных остановлена.', flush=True)
    return was_running

def _wait_health(deadline_seconds: 'float') -> 'bool':
    '''Poll health only (no process tracking): True when the HTTP service
    answers. Used for the grace period on an existing service.'''

    started = time.monotonic()
    while time.monotonic() - started < deadline_seconds:
        if _healthy():
            return True
        time.sleep(1)
    return _healthy()

def _cleanup_broken_service() -> 'None':
    '''Remove a service that is alive but cannot serve.

    A serving process keeps the port AND the service lock for its whole
    life, even when its database is dead: every new start then exits
    instantly (lock busy) and the broken state never heals on its own.
    Called only after the grace period showed the service stays down, so
    a legitimately starting service is never touched.
    '''

    pids = _running_service_pids()
    if not pids:
        return
    _kill(pids)
    _stop_postgres_quietly()
    try:
        _pid_file().unlink()
        return
    except OSError:
        return

def _wait_ready(pid: 'int | None', timeout: 'float', announce_slow_after: 'float'=60.0) -> 'bool':
    '''Poll health until the service is up, the timeout hits, or the child
    process died (fail fast instead of a silent multi-minute wait).'''

    started = time.monotonic()
    slow_announced = False
    while time.monotonic() - started < timeout:
        if _healthy():
            return True
        elapsed = time.monotonic() - started
        if elapsed > 5:
            if pid is not None and not _process_alive(pid):
                for _ in range(5):
                    if _healthy():
                        return True
                    time.sleep(1)
                return False
        if not slow_announced and elapsed >= announce_slow_after:
            slow_announced = True
            print('\nПервый запуск может занять больше минуты: инициализация базы и импорт начальных данных.', flush=True)
        time.sleep(1)
    return _healthy()

def _release_lock(lock) -> 'None':
    try:
        import msvcrt
        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    lock.close()

def cmd_start() -> 'int':
    _trace(f'start: begin, healthy={_healthy()}')
    if _healthy():
        print(f'Приложение уже запущено: {_server_url()}')
        webbrowser.open(_server_url())
        _ensure_shortcut()
        _close_console_window()
        return 0
    pids = _running_service_pids()
    if pids:
        print('Найден уже идущий запуск - ожидаю его готовности...', flush=True)
        if _wait_health(TAKEOVER_GRACE_SECONDS):
            print(f'Готово: {_server_url()}')
            webbrowser.open(_server_url())
            _ensure_shortcut()
            _close_console_window()
            return 0
        print('Запуск остановился на полпути - снимаю его и начинаю заново...', flush=True)
        _cleanup_broken_service()
    print('Запускаю Military Planner (в фоновом режиме)...', flush=True)
    print('----------------------------------------------')
    started = time.monotonic()
    pid = None
    lock = None
    pid = _spawn_service()
    _trace(f'start: spawned service pid={pid}')
    _release_lock(lock)
    lock = None
    if _wait_ready(pid, START_TIMEOUT_SECONDS):
        try:
            lock = _service_lock()
        except OSError:
            pid = None
            print('Обнаружен уже идущий запуск - ожидаю его готовности...', flush=True)
        else:
            elapsed = time.monotonic() - started
            print(f'Готово за {elapsed:.0f} сек: {_server_url()}')
            webbrowser.open(_server_url())
            print('----------------------------------------------')
            print('Служба работает в фоне, приложение продолжит работу.')
            print('Полная остановка: MilitaryPlanner.bat --stop.')
            _ensure_shortcut()
            _close_console_window()
        finally:
            if lock is not None:
                _release_lock(lock)
        return 0
        return 0
    if lock is not None:
        _release_lock(lock)
    print(f'\nПриложение не запустилось за {time.monotonic() - started:.0f} сек.')
    if pid is not None and not _process_alive(pid):
        print('Фоновая служба завершилась с ошибкой.')
    print(f'Журналы: {_log_directory()}')
    return 1

def cmd_stop() -> 'int':
    was_running = _do_stop()
    if was_running:
        print('Готово.')
        return 0
    print('Приложение и база не были запущены.')
    return 0

def cmd_foreground() -> 'int':
    '''Development mode: everything in this console (Ctrl+C stops the app).'''

    from backend.postgres_runtime import PostgresRuntime
    from backend.server import run as run_server
    frontend_root = ROOT / 'release'
    if not (frontend_root / 'index.html').is_file():
        raise RuntimeError(f'Frontend build not found in {frontend_root}. Run `npm run build` before starting the app.')
    os.environ['MILITARY_PLANNER_AUTOPEN'] = '0'
    if 'MILITARY_PLANNER_DATABASE_URL' in os.environ:
        run_server(static_root=frontend_root)
        return 0
    with PostgresRuntime() as database_url:
        os.environ['MILITARY_PLANNER_DATABASE_URL'] = database_url
        try:
            run_server(static_root=frontend_root)
        finally:
            os.environ.pop('MILITARY_PLANNER_DATABASE_URL', None)
    return 0

def main() -> 'int':
    arguments = sys.argv[1:]
    application_root = _application_root()
    _configure_bundle(application_root)
    if not arguments:
        return cmd_start()
    first = arguments[0].lower()
    if first in ('--serve', '-serve', 'serve'):
        try:
            _run_service()
        except Exception as exc:
            _log_startup_error(exc)
            raise
        return 0
    if first in ('--stop', '-stop', 'stop'):
        return cmd_stop()
    if first in ('--foreground', '-foreground', 'foreground', '--fg'):
        return cmd_foreground()
    if first in ('--help', '-h', 'help', '/?'):
        print(__doc__)
        return 0
    print(f'Unknown argument: {arguments[0]}. Use: (nothing) | --stop | --foreground')
    return 2

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as exc:
        _log_startup_error(exc)
        print(f'Military Planner не удалось запустить: {exc}', file=sys.stderr)
        print(f'Подробности записаны в {_log_directory() / 'launcher.log'}', file=sys.stderr)
        if getattr(sys, 'frozen', False):
            try:
                input('Нажмите Enter для выхода...')
            except EOFError:
                pass
        raise SystemExit(1) from exc
# WARNING: Decompyle incomplete
