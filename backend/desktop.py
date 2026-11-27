"""Portable desktop launcher and detached service lifecycle."""

from __future__ import annotations

import ctypes
import os
import signal
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from pathlib import Path

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
START_TIMEOUT_SECONDS = 180
LAUNCH_LOCK_TIMEOUT_SECONDS = START_TIMEOUT_SECONDS + 30
SHORTCUT_NAME = 'Планирование ВВСТ.lnk'


def _application_root() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


ROOT = _application_root()


def _configure_bundle() -> None:
    if not getattr(sys, 'frozen', False):
        return
    postgres_bin = ROOT / 'postgres' / 'bin'
    if not postgres_bin.is_dir():
        raise RuntimeError(f'В сборке не найдены бинарные файлы PostgreSQL: {postgres_bin}')
    os.environ['MILITARY_PLANNER_PG_BIN'] = str(postgres_bin)
    os.environ['MILITARY_PLANNER_FRONTEND_DIR'] = str(ROOT / 'release')
    os.environ.pop('MILITARY_PLANNER_DATABASE_URL', None)
    os.environ.pop('MILITARY_PLANNER_SEED_DUMP', None)
    seed_dump = ROOT / 'initial-data.dump'
    if seed_dump.is_file():
        os.environ['MILITARY_PLANNER_SEED_DUMP'] = str(seed_dump)


def _runtime_dir() -> Path:
    local_app_data = os.environ.get('LOCALAPPDATA')
    root = Path(local_app_data) if local_app_data else Path.home() / 'AppData' / 'Local'
    directory = root / 'MilitaryPlanner'
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _log_directory() -> Path:
    directory = _runtime_dir() / 'logs'
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _pid_file() -> Path:
    return _runtime_dir() / 'server.pid'


def _service_log() -> Path:
    return _log_directory() / 'service.log'


def _append_log(message: str) -> None:
    stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with (_log_directory() / 'launcher.log').open('a', encoding='utf-8') as log_file:
        log_file.write(f'[{stamp}] {message}\n')


def _log_exception(exc: BaseException) -> None:
    stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with (_log_directory() / 'launcher.log').open('a', encoding='utf-8') as log_file:
        log_file.write(f'\n===== {stamp} =====\n')
        log_file.write(''.join(traceback.format_exception(exc)))


def _server_url() -> str:
    port = int(os.environ.get('MILITARY_PLANNER_PORT', '8000'))
    return f'http://127.0.0.1:{port}/'


def _healthy() -> bool:
    try:
        with urllib.request.urlopen(_server_url() + 'api/health', timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _acquire_lock(path: Path, timeout: float):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open('a+b')
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(b'\0')
        handle.flush()
    deadline = time.monotonic() + timeout
    while True:
        try:
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                raise TimeoutError(f'Не удалось получить блокировку запуска: {path}')
            time.sleep(0.2)


def _release_lock(handle) -> None:
    try:
        if os.name == 'nt':
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def _spawn_service() -> int:
    if getattr(sys, 'frozen', False):
        command = [sys.executable, '--serve']
    else:
        command = [sys.executable, '-m', 'backend.desktop', '--serve']

    environment = os.environ.copy()
    environment['MILITARY_PLANNER_AUTOPEN'] = '0'
    log_file = _service_log().open('ab')
    try:
        if os.name == 'nt':
            flags = (
                DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
                DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                DETACHED_PROCESS,
            )
            for creationflags in flags:
                try:
                    process = subprocess.Popen(
                        command,
                        cwd=ROOT,
                        stdin=subprocess.DEVNULL,
                        stdout=log_file,
                        stderr=subprocess.STDOUT,
                        env=environment,
                        creationflags=creationflags,
                        close_fds=True,
                    )
                    return process.pid
                except (OSError, ValueError):
                    continue
        else:
            process = subprocess.Popen(
                command,
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                env=environment,
                start_new_session=True,
                close_fds=True,
            )
            return process.pid
    finally:
        log_file.close()
    raise RuntimeError('Не удалось создать отдельный фоновый процесс приложения.')


def _write_pid(pid: int) -> None:
    _pid_file().write_text(str(pid), encoding='ascii')


def _read_pid() -> int | None:
    try:
        return int(_pid_file().read_text(encoding='ascii').strip())
    except (OSError, ValueError):
        return None


def _wait_ready(pid: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _healthy():
            return True
        if not _process_alive(pid):
            time.sleep(1)
            return _healthy()
        time.sleep(1)
    return _healthy()


def _process_alive(pid: int) -> bool:
    try:
        if os.name == 'nt':
            kernel32 = ctypes.windll.kernel32
            kernel32.OpenProcess.restype = ctypes.c_void_p
            kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
            kernel32.GetExitCodeProcess.restype = ctypes.c_int
            kernel32.GetExitCodeProcess.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_ulong),
            ]
            kernel32.CloseHandle.restype = ctypes.c_int
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if not handle:
                return False
            try:
                exit_code = ctypes.c_ulong()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return False
                return exit_code.value == 259
            finally:
                kernel32.CloseHandle(handle)
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def _is_service_process(pid: int) -> bool | None:
    if os.name != 'nt':
        try:
            command_line = Path(f'/proc/{pid}/cmdline').read_bytes().decode(errors='replace')
            return '--serve' in command_line
        except OSError:
            return False

    command = (
        '$p = Get-CimInstance Win32_Process -Filter "ProcessId = '
        + str(pid)
        + '"; if ($p -and $p.CommandLine -match \'--serve\') { $p.ProcessId }'
    )
    try:
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=10,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode:
        return None
    return result.stdout.strip() == str(pid)


def _stop_service(pid: int) -> bool:
    if _is_service_process(pid) is not True:
        return False
    if os.name == 'nt':
        result = subprocess.run(
            ['taskkill.exe', '/F', '/PID', str(pid)],
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=15,
            check=False,
            creationflags=CREATE_NO_WINDOW,
        )
        if result.returncode and _process_alive(pid):
            return False
    else:
        os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if not _process_alive(pid):
            return True
        time.sleep(0.25)
    return not _process_alive(pid)


def _stop_database() -> bool:
    from backend.postgres_runtime import _data_directory, _postgres_bin, stop_running_server

    return stop_running_server(_postgres_bin(), _data_directory())


def _run_service() -> None:
    lock = _acquire_lock(_runtime_dir() / 'service.lock', timeout=0)
    runtime = None
    try:
        if _healthy():
            return
        _write_pid(os.getpid())
        from backend.postgres_runtime import PostgresRuntime, stop_running_server
        from backend.server import run as run_server

        frontend_root = Path(os.environ.get('MILITARY_PLANNER_FRONTEND_DIR', ROOT / 'release')).resolve()
        if not (frontend_root / 'index.html').is_file():
            raise RuntimeError(f'Не найдена собранная frontend-версия: {frontend_root}')

        runtime = PostgresRuntime()
        runtime._start()
        os.environ['MILITARY_PLANNER_DATABASE_URL'] = runtime.database_url
        run_server(static_root=frontend_root)
    finally:
        try:
            if runtime is not None:
                if runtime._running:
                    runtime._stop()
                else:
                    stop_running_server(runtime.bin_directory, runtime.data_directory)
        finally:
            try:
                if _read_pid() == os.getpid():
                    _pid_file().unlink()
            except OSError:
                pass
            _release_lock(lock)


def _ensure_shortcut() -> None:
    if not getattr(sys, 'frozen', False):
        return
    target = ROOT / Path(sys.executable).name
    icon = ROOT / 'icon.ico'
    if not target.is_file() or not icon.is_file():
        return
    script = (
        'Set sh = WScript.CreateObject("WScript.Shell")\n'
        'Set w = sh.CreateShortcut(WScript.Arguments(0))\n'
        'w.TargetPath = WScript.Arguments(1)\n'
        'w.WorkingDirectory = WScript.Arguments(2)\n'
        'w.IconLocation = WScript.Arguments(3) & ",0"\n'
        'w.Save\n'
    )
    script_path = _runtime_dir() / 'create-shortcut.vbs'
    script_path.write_text(script, encoding='ascii')
    try:
        subprocess.run(
            [
                'cscript.exe',
                '//nologo',
                str(script_path),
                str(ROOT / SHORTCUT_NAME),
                str(target),
                str(ROOT),
                str(icon),
            ],
            capture_output=True,
            timeout=30,
            check=True,
            creationflags=CREATE_NO_WINDOW,
        )
    finally:
        script_path.unlink(missing_ok=True)


def _open_browser() -> None:
    if os.environ.get('MILITARY_PLANNER_AUTOPEN', '1') == '0':
        return
    try:
        webbrowser.open(_server_url())
    except OSError as exc:
        _append_log(f'Не удалось открыть браузер: {exc}')


def _detach_console_after_start() -> None:
    if os.name == 'nt':
        time.sleep(1)
        ctypes.windll.kernel32.FreeConsole()


def _cmd_start() -> int:
    lock = _acquire_lock(_runtime_dir() / 'launch.lock', LAUNCH_LOCK_TIMEOUT_SECONDS)
    try:
        if _healthy():
            print(f'Приложение уже запущено: {_server_url()}', flush=True)
            _open_browser()
            try:
                _ensure_shortcut()
            except (OSError, subprocess.SubprocessError) as exc:
                _append_log(f'Не удалось обновить ярлык: {exc}')
            _detach_console_after_start()
            return 0

        pid = _read_pid()
        if pid is not None and _is_service_process(pid) is True:
            print('Обнаружена работающая фоновая служба, ожидаю запуска...', flush=True)
        else:
            print('Запускаю приложение в отдельном фоновом процессе...', flush=True)
            pid = _spawn_service()

        if not _wait_ready(pid, START_TIMEOUT_SECONDS):
            _append_log(f'Служба не запустилась за {START_TIMEOUT_SECONDS} секунд; PID={pid}')
            log_path = _service_log()
            print(f'Не удалось запустить приложение. Журнал: {log_path}', flush=True)
            process_state = _is_service_process(pid)
            if process_state is None:
                print('Не удалось проверить фоновый процесс; база оставлена без изменений.', flush=True)
                return 1
            if process_state and not _stop_service(pid):
                print('Не удалось завершить фоновый процесс; база оставлена без изменений.', flush=True)
                return 1
            if _stop_database():
                print('Остановлена база данных незавершённого запуска.', flush=True)
            try:
                if _read_pid() == pid:
                    _pid_file().unlink()
            except OSError:
                pass
            return 1

        _append_log(f'Приложение запущено: {_server_url()}, PID={pid}')
        print(f'Приложение готово: {_server_url()}', flush=True)
        _open_browser()
        try:
            _ensure_shortcut()
        except (OSError, subprocess.SubprocessError) as exc:
            _append_log(f'Не удалось обновить ярлык: {exc}')
        _detach_console_after_start()
        return 0
    finally:
        _release_lock(lock)


def _cmd_stop() -> int:
    pid = _read_pid()
    service_stopped = False
    if pid is not None:
        process_state = _is_service_process(pid)
        if process_state is None:
            print('Не удалось проверить процесс службы; база оставлена без изменений.', flush=True)
            return 1
        if process_state:
            print('Останавливаю приложение...', flush=True)
            service_stopped = _stop_service(pid)
            if not service_stopped:
                print('Не удалось остановить процесс приложения; база оставлена без изменений.', flush=True)
                return 1
        try:
            if _read_pid() == pid:
                _pid_file().unlink()
        except OSError:
            pass
    elif _healthy():
        print('Служба отвечает, но её PID-файл отсутствует. База оставлена без изменений.', flush=True)
        return 1

    if _stop_database():
        print('База данных остановлена.', flush=True)
    elif service_stopped:
        print('Приложение остановлено; база данных уже не работала.', flush=True)
    else:
        print('Приложение и база данных не были запущены.', flush=True)
    return 0


def _cmd_foreground() -> int:
    from backend.postgres_runtime import PostgresRuntime
    from backend.server import run as run_server

    frontend_root = Path(os.environ.get('MILITARY_PLANNER_FRONTEND_DIR', ROOT / 'release')).resolve()
    if not (frontend_root / 'index.html').is_file():
        raise RuntimeError(f'Не найдена собранная frontend-версия: {frontend_root}')
    os.environ['MILITARY_PLANNER_AUTOPEN'] = '0'
    if os.environ.get('MILITARY_PLANNER_DATABASE_URL'):
        run_server(static_root=frontend_root)
        return 0
    with PostgresRuntime() as database_url:
        os.environ['MILITARY_PLANNER_DATABASE_URL'] = database_url
        try:
            run_server(static_root=frontend_root)
        finally:
            os.environ.pop('MILITARY_PLANNER_DATABASE_URL', None)
    return 0


def main(arguments: list[str] | None = None) -> int:
    try:
        _configure_bundle()
        args = list(sys.argv[1:] if arguments is None else arguments)
        command = args[0].lower() if args else ''
        if command in {'--serve', 'serve'}:
            _run_service()
            return 0
        if command in {'--stop', 'stop'}:
            return _cmd_stop()
        if command in {'--foreground', '--fg', 'foreground'}:
            return _cmd_foreground()
        if command in {'', '--start', 'start'}:
            return _cmd_start()
        if command in {'--help', '-h', 'help', '/?'}:
            print(
                'Запуск: MilitaryPlanner.exe [--start]\n'
                'Остановка: MilitaryPlanner.exe --stop\n'
                'Режим разработки: python launcher.py --foreground'
            )
            return 0
        print(
            f'Неизвестный параметр: {args[0]}. '
            'Используйте --start, --stop, --foreground или --help.'
        )
        return 2
    except Exception as exc:
        try:
            _log_exception(exc)
            log_path = _log_directory() / 'launcher.log'
        except OSError:
            log_path = Path('launcher.log')
        print(f'Не удалось запустить Military Planner: {exc}', file=sys.stderr, flush=True)
        print(f'Подробности: {log_path}', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
