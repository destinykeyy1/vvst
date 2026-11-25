'''Manage a private loopback-only PostgreSQL instance for the desktop app.'''

from __future__ import annotations
import ctypes
import getpass
import os
import re
from ctypes import wintypes
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
import psycopg
from psycopg import sql
DATABASE_NAME = 'military_planner'
DATABASE_USER = 'planner_app'
DEFAULT_PG_PORT = 5432
PG_PORT_MIN = 1024
PG_PORT_MAX = 65535
CREATE_NO_WINDOW = 134217728
_REQUIRED_POSTGRES_TOOLS = ('initdb.exe', 'pg_ctl.exe', 'postgres.exe')
ASCII_MIRROR_MARKER = 'mirror-source.txt'

def _postgres_bin() -> 'Path':
    configured = os.environ.get('MILITARY_PLANNER_PG_BIN')
    candidates = [Path(configured)] if configured else []
    install_root = Path(os.environ.get('ProgramFiles', 'C:\\Program Files')) / 'PostgreSQL'
    if install_root.is_dir():
        versions = sorted((path for path in install_root.iterdir() if path.is_dir()), key=(lambda path: tuple((int(part) if part.isdigit() else 0 for part in path.name.split('.')))), reverse=True)
        candidates.extend((path / 'bin' for path in versions))
    for candidate in candidates:
        if all(((candidate / name).is_file() for name in _REQUIRED_POSTGRES_TOOLS)):
            resolved = candidate.resolve()
            if _is_ascii_path(resolved):
                return resolved
            return _mirror_postgres_to_ascii(resolved)
    raise RuntimeError('PostgreSQL 14 or newer must be installed. Set MILITARY_PLANNER_PG_BIN to its bin folder.')

def _is_ascii_path(path: 'Path') -> 'bool':
    try:
        str(path).encode('ascii')
    except UnicodeEncodeError:
        return False
    return True

def _mirror_postgres_to_ascii(bin_directory: 'Path') -> 'Path':
    '''Copy a PostgreSQL tree that lives in a non-ASCII path to ProgramData.

    Only the directories a working server needs (bin, lib, share) are
    copied - exactly what the portable build already ships next to the
    binaries. A previous mirror is reused only when it was made from the
    same source tree, tracked in a small marker file.
    '''

    source_root = bin_directory.parent
    program_data = Path(os.environ.get('ProgramData', 'C:\\ProgramData'))
    mirror_root = program_data / 'MilitaryPlanner' / 'postgres'
    mirror_bin = mirror_root / 'bin'
    if _mirror_is_current(mirror_root, source_root):
        return mirror_bin.resolve()
    print('PostgreSQL установлен в папке с нечитаемыми для базы символами:', f'{source_root}', 'Выполняется одноразовое копирование в ASCII-путь:', f'{mirror_root}...', flush=True)
    if mirror_root.exists():
        shutil.rmtree(mirror_root, ignore_errors=True)
    try:
        for directory in ('bin', 'lib', 'share'):
            source = source_root / directory
            if source.is_dir():
                shutil.copytree(source, mirror_root / directory)
    except OSError as exc:
        raise RuntimeError(f'Не удалось скопировать PostgreSQL в путь без кириллицы ({mirror_root}): {exc}. Перенесите приложение целиком в папку без русских букв (например C:\\MilitaryPlanner) и запустите снова.') from exc
    if not all(((mirror_bin / name).is_file() for name in _REQUIRED_POSTGRES_TOOLS)):
        raise RuntimeError(f'Скопированный набор PostgreSQL неполон: {mirror_bin}. Перенесите приложение целиком в папку без русских букв (например C:\\MilitaryPlanner) и запустите снова.')
    try:
        (mirror_root / ASCII_MIRROR_MARKER).write_text(str(source_root), encoding='utf-8')
    except OSError:
        pass
    return mirror_bin.resolve()

def _mirror_is_current(mirror_root: 'Path', source_root: 'Path') -> 'bool':
    try:
        current_source = (mirror_root / ASCII_MIRROR_MARKER).read_text(encoding='utf-8').strip()
        return current_source.lower() == str(source_root).lower()
    except OSError:
        return False

def _data_directory() -> 'Path':
    configured = os.environ.get('MILITARY_PLANNER_DATA_DIR')
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get('LOCALAPPDATA')
    root = Path(local_app_data) if local_app_data else Path.home() / 'AppData' / 'Local'
    candidate = root / 'MilitaryPlanner' / 'postgres-data'
    if _is_ascii_path(candidate):
        return candidate
    program_data = os.environ.get('ProgramData', 'C:\\ProgramData')
    return Path(program_data) / 'MilitaryPlanner' / 'postgres-data'

def _valid_port(port: 'int', source: 'str') -> 'int':
    if not PG_PORT_MIN <= port <= PG_PORT_MAX:
        raise RuntimeError(f'{source} must be between {PG_PORT_MIN} and {PG_PORT_MAX}: {port}')
    return port

def configured_port() -> 'int':
    """The port this application's PostgreSQL must listen on.

    Order of precedence:
      1. MILITARY_PLANNER_PG_PORT environment variable;
      2. DEFAULT_PG_PORT (5432).
    """

    configured = os.environ.get('MILITARY_PLANNER_PG_PORT')
    if configured:
        try:
            port = int(configured)
        except ValueError as exc:
            raise RuntimeError('MILITARY_PLANNER_PG_PORT must be a valid TCP port.') from exc
        return _valid_port(port, 'MILITARY_PLANNER_PG_PORT')
    return DEFAULT_PG_PORT

def _running_port(data_directory: 'Path') -> 'int | None':
    '''Port of a PostgreSQL server that is running right now, else None.'''

    try:
        text = (data_directory / 'postmaster.opts').read_text(encoding='utf-8', errors='replace')
    except OSError:
        return
    match = re.search('-p\\s+(\\d+)', text)
    if not match:
        return
    try:
        return _valid_port(int(match.group(1)), 'Port in postmaster.opts')
    except RuntimeError:
        return

def process_alive(pid: 'int') -> 'bool':
    """True only when the process is actually executing.

    OpenProcess alone is not enough: Windows keeps a killed process's PID
    reserved (and OpenProcess to it succeeding) until every inherited
    handle to it is released, which happens exquisitely often with the
    console-attached PostgreSQL tree. GetExitCodeProcess distinguishes a
    still-running process from a terminated one.
    """

    if pid == os.getpid():
        return True
    PROCESS_QUERY_LIMITED_INFORMATION = 4096
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            kernel32.CloseHandle(handle)
            return exit_code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)
    return True

def clean_stale_pid_file(data_directory: 'Path') -> 'None':
    '''Remove postmaster.pid left behind by a killed PostgreSQL server.

    A crashed postmaster leaves the file and pg_ctl then claims another
    server "might be running". The file lists its data directory on the
    second line, so a stale file can be told apart from a live server even
    after PID reuse.
    '''

    pid_file = data_directory / 'postmaster.pid'
    try:
        lines = pid_file.read_text(encoding='ascii').splitlines()
        pid = int(lines[0])
        recorded_directory = Path(lines[1])
    except (OSError, ValueError, IndexError):
        return
    if process_alive(pid) and recorded_directory.resolve() == data_directory.resolve():
        return
    try:
        pid_file.unlink()
    except OSError:
        return

def stop_running_server(bin_directory: 'Path', data_directory: 'Path', timeout: 'int'=30) -> 'bool':
    '''Gracefully stop this app's PostgreSQL cluster, whoever started it.

    Fast ("smart, but don't wait for open transactions") shutdown keeps the
    restart well within a minute and, unlike a hard kill, never dirties WAL.
    Returns True when pg_ctl confirmed the server stopped; False when there
    was nothing to stop (no binaries, dead cluster).
    '''

    pg_ctl = bin_directory / 'pg_ctl.exe'
    if not (pg_ctl.is_file() and (data_directory / 'PG_VERSION').is_file()):
        return False
    try:
        result = subprocess.run([str(pg_ctl), '-D', str(data_directory), '-m', 'fast', '-w', '-t', str(timeout), 'stop'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout + 15, check=False, creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0

def writable_server_log(data_directory: 'Path') -> 'Path':
    '''A server log file this process is allowed to create and append to.

    A previous killed instance sometimes leaves server.log holding a leak
    lock, and PostgreSQL refuses to start when it cannot open its log.
    '''

    default = data_directory / 'server.log'
    try:
        with default.open('ab'):
            return default
    except OSError:
        return data_directory / f'server-{time.strftime('%Y%m%d-%H%M%S')}.log'

def _query_postgres_processes() -> 'list[tuple[int, int | None, str]]':
    '''(pid, parent pid, command line) of every running postgres.exe.

    The parent pid is the authoritative link to the owning postmaster; the
    --forkchild command-line argument is an internal id, not a PID, and
    must never be used for matching. ([] when detection fails.)
    '''

    try:
        result = subprocess.run(['powershell', '-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'postgres.exe\'" | ForEach-Object { \'{0}|{1}|{2}\' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30, check=False, creationflags=CREATE_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode:
        return []
    processes = []
    for line in result.stdout.splitlines():
        parts = line.split('|', 2)
        if len(parts) != 3:
            continue
        if not parts[0].strip().isdigit():
            continue
        parent = int(parts[1].strip()) if parts[1].strip().isdigit() else None
        processes.append((int(parts[0].strip()), parent, parts[2].strip()))
    return processes

def _is_elevated() -> 'bool':
    '''True when this process carries an elevated administrator token.

    PostgreSQL refuses to start under one, so the postmaster must be
    launched through a de-elevated parent instead. Any failure of the
    check keeps the ordinary direct-spawn path: only a positively
    detected elevation triggers the workaround.
    '''

    try:
        import ctypes
        advapi32 = ctypes.windll.advapi32
        kernel32 = ctypes.windll.kernel32
        token = ctypes.c_void_p()
        if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 8, ctypes.byref(token)):
            return False
        elevation = ctypes.c_ulong()
        returned = ctypes.c_ulong()
        ok = advapi32.GetTokenInformation(token, 20, ctypes.byref(elevation), ctypes.sizeof(elevation), ctypes.byref(returned))
        kernel32.CloseHandle(token)
        return bool(ok and elevation.value)
    except Exception:
        return False

def _double_quotes(value: 'object') -> 'str':
    '''A double-quoted argument for VBS / cmd, inner quotes doubled.'''

    return '"' + str(value).replace('"', '""') + '"'

_TOKEN_QUERY = 8
_TOKEN_DUPLICATE = 2
_MAXIMUM_ALLOWED = 33554432
_SECURITY_IMPERSONATION = 2
_TOKEN_PRIMARY = 1
_TOKEN_LINKED_TOKEN = 19
_STARTF_USESHOWWINDOW = 1
_STARTF_USESTDHANDLES = 256
_SW_HIDE = 0
_WAIT_OBJECT_0 = 0
_STILL_ACTIVE = 259
_WAIT_TIMEOUT = 258
_GENERIC_WRITE = 1073741824
_FILE_SHARE_READ = 1
_OPEN_ALWAYS = 4
_FILE_ATTRIBUTE_NORMAL = 128
_INVALID_HANDLE = ctypes.c_void_p(-1).value

class _STARTUPINFOW(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('lpReserved', wintypes.LPWSTR), ('lpDesktop', wintypes.LPWSTR), ('lpTitle', wintypes.LPWSTR), ('dwX', wintypes.DWORD), ('dwY', wintypes.DWORD), ('dwXSize', wintypes.DWORD), ('dwYSize', wintypes.DWORD), ('dwXCountChars', wintypes.DWORD), ('dwYCountChars', wintypes.DWORD), ('dwFillAttribute', wintypes.DWORD), ('dwFlags', wintypes.DWORD), ('wShowWindow', wintypes.WORD), ('cbReserved2', wintypes.WORD), ('lpReserved2', wintypes.LPVOID), ('hStdInput', wintypes.HANDLE), ('hStdOutput', wintypes.HANDLE), ('hStdError', wintypes.HANDLE)]

class _PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [('hProcess', wintypes.HANDLE), ('hThread', wintypes.HANDLE), ('dwProcessId', wintypes.DWORD), ('dwThreadId', wintypes.DWORD)]

class _SECURITY_ATTRIBUTES(ctypes.Structure):
    _fields_ = [('nLength', wintypes.DWORD), ('lpSecurityDescriptor', wintypes.LPVOID), ('bInheritHandle', wintypes.BOOL)]

class _ProcessHandle:
    '''poll()-compatible wrapper around a raw Windows process handle.'''

    __slots__ = ('_handle',)
    def __init__(self, handle: 'int') -> 'None':
        self._handle = handle

    def poll(self) -> 'int | None':
        kernel32 = ctypes.windll.kernel32
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(self._handle, ctypes.byref(code)):
            return 0
        if code.value == _STILL_ACTIVE:
            return
        return code.value


def _filtered_primary_token() -> 'int | None':
    '''Duplicate of this process's non-elevated token, or None.

    Every UAC-elevated process keeps its pre-elevation token as the
    "linked token". Duplicating it as a primary token produces a
    basic-user token that PostgreSQL accepts; the caller owns the
    returned handle and must CloseHandle it.
    '''

    advapi32 = ctypes.windll.advapi32
    kernel32 = ctypes.windll.kernel32
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi32.DuplicateTokenEx.restype = wintypes.BOOL
    advapi32.DuplicateTokenEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, ctypes.c_int, ctypes.c_int, ctypes.POINTER(wintypes.HANDLE)]
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    process_token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), _TOKEN_QUERY | _TOKEN_DUPLICATE, ctypes.byref(process_token)):
        return
    try:
        needed = wintypes.DWORD()
        advapi32.GetTokenInformation(process_token, _TOKEN_LINKED_TOKEN, None, 0, ctypes.byref(needed))
        if not needed.value or needed.value > 4096:
            return
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi32.GetTokenInformation(process_token, _TOKEN_LINKED_TOKEN, buffer, needed.value, ctypes.byref(needed)):
            return
        linked = ctypes.cast(buffer, ctypes.POINTER(wintypes.HANDLE)).contents.value
        if not linked:
            return
        primary = wintypes.HANDLE()
        if not advapi32.DuplicateTokenEx(linked, _MAXIMUM_ALLOWED, None, _SECURITY_IMPERSONATION, _TOKEN_PRIMARY, ctypes.byref(primary)):
            return
        kernel32.CloseHandle(linked)
        return primary.value or None
    finally:
        kernel32.CloseHandle(process_token)

def _create_unelevated_process(command_line: 'str', stdout_path: 'Path | None'=None) -> 'tuple[int, int] | None':
    """Spawn command_line under the filtered token.

    Returns (process_handle, pid) on success, None when the de-elevated
    spawn is unavailable or fails. stdout_path, when given, receives the
    child's stdout+stderr through an inheritable file handle.
    """

    token = _filtered_primary_token()
    if token is None:
        return
    advapi32 = ctypes.windll.advapi32
    kernel32 = ctypes.windll.kernel32
    advapi32.CreateProcessAsUserW.restype = wintypes.BOOL
    advapi32.CreateProcessAsUserW.argtypes = [wintypes.HANDLE, wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.LPVOID, wintypes.LPVOID, wintypes.BOOL, wintypes.DWORD, wintypes.LPVOID, wintypes.LPCWSTR, ctypes.POINTER(_STARTUPINFOW), ctypes.POINTER(_PROCESS_INFORMATION)]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_SECURITY_ATTRIBUTES), wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    si = _STARTUPINFOW()
    si.cb = ctypes.sizeof(_STARTUPINFOW)
    si.dwFlags = _STARTF_USESHOWWINDOW
    si.wShowWindow = _SW_HIDE
    file_handle = None
    if stdout_path is not None:
        attributes = _SECURITY_ATTRIBUTES()
        attributes.nLength = ctypes.sizeof(attributes)
        attributes.bInheritHandle = True
        file_handle = kernel32.CreateFileW(str(stdout_path), _GENERIC_WRITE, _FILE_SHARE_READ, ctypes.byref(attributes), _OPEN_ALWAYS, _FILE_ATTRIBUTE_NORMAL, None)
        if not file_handle or file_handle == _INVALID_HANDLE:
            kernel32.CloseHandle(token)
            return
        si.dwFlags |= _STARTF_USESTDHANDLES
        si.hStdOutput = file_handle
        si.hStdError = file_handle
    pi = _PROCESS_INFORMATION()
    command_buffer = ctypes.create_unicode_buffer(command_line)
    try:
        ok = advapi32.CreateProcessAsUserW(token, None, command_buffer, None, None, bool(file_handle), CREATE_NO_WINDOW, None, None, ctypes.byref(si), ctypes.byref(pi))
    finally:
        if file_handle:
            kernel32.CloseHandle(file_handle)
        kernel32.CloseHandle(token)
    if not ok:
        return
    kernel32.CloseHandle(pi.hThread)
    return pi.hProcess, pi.dwProcessId

def _wait_unelevated(process_handle: 'int', timeout_ms: 'int') -> 'int | None':
    '''Wait for an unelevated child; exit code, or None on timeout.'''

    kernel32 = ctypes.windll.kernel32
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    result = kernel32.WaitForSingleObject(process_handle, timeout_ms)
    if result == _WAIT_TIMEOUT:
        kernel32.TerminateProcess(process_handle, 1)
        kernel32.WaitForSingleObject(process_handle, 5000)
        kernel32.CloseHandle(process_handle)
        return
    code = wintypes.DWORD()
    kernel32.GetExitCodeProcess(process_handle, ctypes.byref(code))
    kernel32.CloseHandle(process_handle)
    if result == _WAIT_OBJECT_0:
        return code.value

def _server_log_reports_admin_refusal(path: 'Path') -> 'bool':
    '''True when the PostgreSQL log shows the administrator-token refusal.'''

    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return False
    return 'administrative permissions' in text[-20000:].lower()

def _is_elevated() -> 'bool':
    '''True when this process carries an elevated administrator token.

    PostgreSQL refuses to start under one, so the postmaster must be
    launched through a de-elevated parent instead. Any failure of the
    check keeps the ordinary direct-spawn path: only a positively
    detected elevation triggers the workaround.
    '''

    try:
        import ctypes
        advapi32 = ctypes.windll.advapi32
        kernel32 = ctypes.windll.kernel32
        token = ctypes.c_void_p()
        if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 8, ctypes.byref(token)):
            return False
        elevation = ctypes.c_ulong()
        returned = ctypes.c_ulong()
        ok = advapi32.GetTokenInformation(token, 20, ctypes.byref(elevation), ctypes.sizeof(elevation), ctypes.byref(returned))
        kernel32.CloseHandle(token)
        return bool(ok and elevation.value)
    except Exception:
        return False

class PostgresRuntime:
    '''Starts PostgreSQL for the app.

    The server is started detached from this process (pg_ctl spawns the
    postmaster without a console), so it deliberately outlives the launcher
    and the console window: closing the window never kills the database and
    never triggers WAL crash recovery on the next start. An explicit
    stop_running_server() shuts it down gracefully.
    '''

    def __init__(self) -> 'None':
        self.bin_directory = _postgres_bin()
        self.data_directory = _data_directory()
        self.port = configured_port()
        self.database_url = f'postgresql://{DATABASE_USER}@127.0.0.1:{self.port}/{DATABASE_NAME}'
        seed_dump = os.environ.get('MILITARY_PLANNER_SEED_DUMP')
        self.seed_dump = Path(seed_dump).expanduser().resolve() if seed_dump else None
        if self.seed_dump is not None and not self.seed_dump.is_file():
            raise RuntimeError(f'Initial database backup not found: {self.seed_dump}')
        self._running = False
        self._postmaster_process = None

    def _seed_should_be_applied(self) -> 'bool':
        '''True when the existing database looks like it never received the
        seed dump: no application tables at all, or the items and users are
        both empty. A database with real data is never touched.'''

        try:
            with psycopg.connect(self.database_url, connect_timeout=5) as app_db:
                schema_present = app_db.execute("SELECT to_regclass('public.planner_items') IS NOT NULL").fetchone()[0]
                if not schema_present:
                    return True
                items_empty = app_db.execute('SELECT NOT EXISTS (SELECT 1 FROM public.planner_items LIMIT 1)').fetchone()[0]
                users_empty = app_db.execute('SELECT NOT EXISTS (SELECT 1 FROM public.planner_users LIMIT 1)').fetchone()[0]
        except psycopg.Error:
            return True
        return items_empty and users_empty

    def _create_database_if_needed(self, db: 'psycopg.Connection') -> 'None':
        exists = db.execute('SELECT 1 FROM pg_database WHERE datname = %s', (DATABASE_NAME,)).fetchone()
        created = False
        if exists:
            if self.seed_dump is None:
                return
            if not self._seed_should_be_applied():
                return
            print(f'Database exists but has no usable data; importing {self.seed_dump.name}...')
        else:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DATABASE_NAME)))
            created = True
            if self.seed_dump is None:
                return
        try:
            self._run_tool('pg_restore.exe', '--exit-on-error', '--single-transaction', '--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', self.database_url, str(self.seed_dump))
            return
        except RuntimeError as restore_error:
            if not created:
                print(f'Warning: could not import initial data; the existing database is left as it was ({restore_error})')

    def _set_port(self, port: 'int') -> 'None':
        '''Recalculate self.port and self.database_url after port resolution.'''

        self.port = port
        self.database_url = f'postgresql://{DATABASE_USER}@127.0.0.1:{self.port}/{DATABASE_NAME}'

    def _terminate_leftover_postgres(self) -> 'None':
        '''Kill PostgreSQL processes left over from this app's instances.

        A power cut (or an explicit /F kill of the postmaster) can kill
        PostgreSQL outside its shutdown routine: its forkchildren survive
        and keep holding the shared memory block, so the next start fails
        with "pre-existing shared memory block is still in use". Only
        processes that provably belong to this application are touched:

        - command line mentions this app's data directory (postmaster);
        - (portable EXE) started from this bundle's postgres binaries;
        - parent process is dead (an orphaned forkchild - such a process
          serves nobody and only blocks the next start).

        Everything else - Windows service, Docker, other projects - whose
        postmaster is alive is never affected.
        '''

        data_directory = str(self.data_directory).replace('\\', '/').lower().rstrip('/')
        bundle_bin = str(self.bin_directory).replace('\\', '/').lower().rstrip('/') if getattr(sys, 'frozen', False) else None
        for pid, parent_pid, command_line in _query_postgres_processes():
            normalized = command_line.replace('\\', '/').lower()
            parent_gone = parent_pid is None or not process_alive(parent_pid)
            ours = data_directory in normalized or bundle_bin is not None and bundle_bin in normalized or parent_gone
            if ours:
                subprocess.run(['taskkill', '/F', '/PID', str(pid)], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15, check=False, creationflags=CREATE_NO_WINDOW)

    def _find_free_port(self) -> 'int':
        '''First free loopback port starting at the configured one.

        Port 5432 is often taken on machines that already run another
        PostgreSQL service or Docker; instead of failing, the app moves to
        the next free port in a small range.
        '''

        base_port = configured_port()
        for offset in range(10):
            port = base_port + offset
            if port > PG_PORT_MAX:
                break
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                try:
                    listener.bind(('127.0.0.1', port))
                except OSError:
                    continue
            return port
        raise RuntimeError(f'Порты PostgreSQL {base_port}–{min(base_port + 9, PG_PORT_MAX)} заняты другими программами (обычно это системный сервис PostgreSQL или Docker). Остановите её либо установите переменную окружения MILITARY_PLANNER_PG_PORT на свободный порт.')

    def _start_postmaster(self, server_log: 'Path') -> 'None':
        '''Start the postmaster directly, in its own hidden console.

        Two requirements drive the flags and both are essential:

        1. The console must NOT be the user's console. DETACHED_PROCESS
           gives the postmaster no console at all, and then every backend
           worker PostgreSQL forks creates its own NEW VISIBLE console
           window - a screen full of postgres windows.
        2. The console must exist but be hidden: CREATE_NO_WINDOW gives
           the postmaster a private invisible console, and every worker
           silently inherits that same hidden console - no windows.

        Being a private console (not the one of any opened window), it
        never receives the CTRL_C/close events of a window the user
        closes - the database outlives windows, the app and tool
        processes alike. Readiness is confirmed with a real handshake
        below.

        Additionally, PostgreSQL refuses to run with an administrator
        token ("not allowed under a user with administrator rights").
        When the launcher itself was started elevated (console run as
        administrator), the postmaster is launched de-elevated instead of
        inheriting the unusable token: see
        _spawn_postmaster_deelevated.
        '''

        if _is_elevated():
            self._spawn_postmaster_deelevated(server_log)
            return
        hidden = CREATE_NO_WINDOW | 512
        with server_log.open('ab') as log:
            self._postmaster_process = subprocess.Popen([str(self.bin_directory / 'postgres.exe'), '-D', str(self.data_directory), '-h', '127.0.0.1', '-p', str(self.port)], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, creationflags=hidden, close_fds=True)

    def _spawn_postmaster_linked_token(self, server_log: 'Path') -> 'bool':
        '''Spawn the postmaster via CreateProcessAsUserW + linked token.

        Deterministic de-elevation: no runas, no wscript, no scripts on
        disk. Returns False when the API path is unavailable so the
        caller can fall back to the runas/VBS workaround.
        '''

        command_line = ' '.join(_double_quotes(self.bin_directory / 'postgres.exe'), '-D', _double_quotes(self.data_directory), '-h', '127.0.0.1', '-p', str(self.port), '-l', _double_quotes(server_log))
        spawned = _create_unelevated_process(command_line)
        if spawned is None:
            return False
        process_handle, _pid = spawned
        self._postmaster_process = _ProcessHandle(process_handle)
        return True

    def _spawn_postmaster_deelevated(self, server_log: 'Path') -> 'None':
        '''Launch the postmaster with a stripped (Basic User) token.

        First choice is the linked-token CreateProcessAsUserW path (see
        _spawn_postmaster_linked_token). Fallback: runas
        /trustlevel:0x20000 needs no credentials and stays fully silent.
        wscript.exe is a GUI program (no console of its own) and
        WshShell.Run with style 0 starts the postmaster in a hidden
        console that its workers then inherit - same effect as the
        direct path. The postmaster writes into the server log via its
        own -l option, so no cmd redirection is involved. Force with
        MILITARY_PLANNER_FORCE_DEELEVATED=1 for tests on machines that
        are not elevated (e.g. the build host).
        '''

        if self._spawn_postmaster_linked_token(server_log):
            return
        vbs_path = self.data_directory.parent / 'start-postgres.vbs'
        command_line = ' '.join(_double_quotes(self.bin_directory / 'postgres.exe'), '-D', _double_quotes(self.data_directory), '-h', '127.0.0.1', '-p', str(self.port), '-l', _double_quotes(server_log))
        run_line = '"""' + command_line.replace('"', '""') + '"""'
        vbs_content = 'Set sh = CreateObject("WScript.Shell")' + f'\r\nsh.Run {run_line}, 0, False' + '\r\n'
        vbs_path.write_text(vbs_content, encoding='utf-8')
        subprocess.Popen(['runas', '/trustlevel:0x20000', f'wscript.exe "{vbs_path}"'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW, close_fds=True)

    def _wait_until_listening(self, server_log: 'Path', attempts: 'int'=120) -> 'None':
        '''Verify the server accepts connections; fail fast when it died.

        Crash recovery (replaying WAL after an unclean exit) can
        legitimately take about a minute, so the polling window is wide -
        but a postmaster that terminated at once fails immediately.
        '''

        for _ in range(attempts):
            process = self._postmaster_process
            if process is not None and process.poll() is not None:
                raise RuntimeError(f'PostgreSQL завершился во время запуска; журнал сервера: {server_log}.')
            try:
                self._run_tool('pg_isready.exe', '--host=127.0.0.1', f'--port={self.port}', '--username=' + DATABASE_USER, '--dbname=postgres')
            except RuntimeError:
                time.sleep(1)
                continue
            return
        raise RuntimeError(f'PostgreSQL не принял подключения на порту {self.port}. Журнал сервера: {server_log}.')

    def _run_tool_unelevated(self, name: 'str', *arguments: 'str', capture_output: 'bool'=True) -> 'str | None':
        '''Run a PostgreSQL tool under the filtered token.

        initdb bootstraps through `postgres --boot` and pg_ctl talks to
        the postmaster: both must see the same non-elevated token as the
        server itself, so under an elevated launcher every tool goes
        through CreateProcessAsUserW as well. Output is captured via an
        inherited file handle. Returns None when the de-elevated spawn
        is unavailable so the caller can fall back to running elevated.
        '''

        executable = self.bin_directory / name
        command_line = ' '.join([_double_quotes(executable)] + [_double_quotes(argument) for argument in arguments])
        output_path = self.data_directory.parent / f'.tool-{name}-{os.getpid()}.log'
        spawned = _create_unelevated_process(command_line, stdout_path=output_path if capture_output else None)
        if spawned is None:
            return
        process_handle, _pid = spawned
        exit_code = _wait_unelevated(process_handle, 60000)
        output = ''
        if capture_output:
            try:
                output = output_path.read_text(encoding='utf-8', errors='replace')
            except OSError:
                output = ''
            try:
                output_path.unlink()
            except OSError:
                pass
        if exit_code != 0:
            detail = output.strip()
            if detail:
                raise RuntimeError(f'PostgreSQL tool {name} failed' + f': {detail}')
            raise RuntimeError(f'PostgreSQL tool {name} failed (exit code {exit_code})')
        return output

    def _run_tool(self, name: 'str', *arguments: 'str', capture_output: 'bool'=True) -> 'subprocess.CompletedProcess[str]':
        if _is_elevated():
            output = self._run_tool_unelevated(name, *arguments, capture_output=capture_output)
            if output is not None:
                return subprocess.CompletedProcess([str(self.bin_directory / name), *arguments], 0, output, '')
        output_options = {'capture_output': True} if capture_output else {'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}
        try:
            result = subprocess.run([str(self.bin_directory / name), *arguments], text=True, encoding='utf-8', errors='replace', timeout=60, check=False, creationflags=CREATE_NO_WINDOW, **output_options)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f'Unable to run PostgreSQL tool {name}: {exc}') from exc
        if result.returncode:
            detail = (result.stderr or result.stdout or '').strip()
            if detail:
                raise RuntimeError(f'PostgreSQL tool {name} failed' + f': {detail}')
            raise RuntimeError(f'PostgreSQL tool {name} failed (exit code {result.returncode})')
        return result

    def _initialize_if_needed(self) -> 'None':
        version_file = self.data_directory / 'PG_VERSION'
        if version_file.is_file():
            return
        if self.data_directory.exists() and any(self.data_directory.iterdir()):
            raise RuntimeError(f'Refusing to initialize a non-empty PostgreSQL directory: {self.data_directory}')
        self.data_directory.mkdir(parents=True, exist_ok=True)
        self._run_tool('initdb.exe', '-D', str(self.data_directory), '-U', DATABASE_USER, '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--no-locale', '--no-instructions')

    def _start(self) -> 'None':
        self._initialize_if_needed()
        status = subprocess.run([str(self.bin_directory / 'pg_ctl.exe'), '-D', str(self.data_directory), 'status'], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15, check=False, creationflags=CREATE_NO_WINDOW)
        if status.returncode:
            self._terminate_leftover_postgres()
            clean_stale_pid_file(self.data_directory)
            port = self._find_free_port()
            self._set_port(port)
            server_log = writable_server_log(self.data_directory)
            try:
                self._start_postmaster(server_log)
            except RuntimeError:
                self._terminate_leftover_postgres()
                clean_stale_pid_file(self.data_directory)
                time.sleep(2)
                server_log = writable_server_log(self.data_directory)
                try:
                    try:
                        if _is_elevated() or _server_log_reports_admin_refusal(server_log):
                            self._spawn_postmaster_deelevated(server_log)
                        else:
                            self._start_postmaster(server_log)
                    except RuntimeError:
                        print('PostgreSQL восстанавливается после аварийного завершения; это может занять около минуты...', flush=True)
                except Exception:
                    pass
                try:
                    self._wait_until_listening(server_log)
                except RuntimeError as wait_error:
                    if _server_log_reports_admin_refusal(server_log):
                        raise RuntimeError('PostgreSQL отказывается запускаться от имени пользователя с правами администратора, а непривилегированный запуск на этом компьютере недоступен (вероятно, отключён UAC). Запустите MilitaryPlanner.exe обычным способом, без «Запуск от имени администратора», либо под учётной записью без прав администратора.') from wait_error
                    raise
            self._wait_until_listening(server_log)
        else:
            self._set_port(_running_port(self.data_directory) or configured_port())
        self._running = True
        try:
            self._ensure_database_role()
            with psycopg.connect(f'postgresql://{DATABASE_USER}@127.0.0.1:{self.port}/postgres', connect_timeout=5, autocommit=True) as db:
                self._create_database_if_needed(db)
        except psycopg.Error as exc:
            raise RuntimeError(f'Unable to prepare the local PostgreSQL database: {exc}') from exc

    def _ensure_database_role(self) -> 'None':
        '''Make sure the planner_app login role exists in the cluster.

        A data directory left behind by an older build (or initialized by
        a plain initdb without -U) can have a different superuser - for
        example the Windows account name. auth-local/host is trust, so
        any existing role can log in without a password: probe the known
        candidates, then create planner_app as a superuser so the rest of
        the startup (CREATE DATABASE, seed restore, the app itself) works
        unchanged.
        '''

        candidates = []
        for user in DATABASE_USER, 'postgres', getpass.getuser():
            if not user:
                continue
            if user not in candidates:
                candidates.append(user)
        errors = []
        for user in candidates:
            try:
                with psycopg.connect(f'postgresql://{user}@127.0.0.1:{self.port}/postgres', connect_timeout=5, autocommit=True) as db:
                    exists = db.execute('SELECT 1 FROM pg_roles WHERE rolname = %s', (DATABASE_USER,)).fetchone()
                    if exists:
                        db.execute(sql.SQL('ALTER ROLE {} WITH LOGIN SUPERUSER').format(sql.Identifier(DATABASE_USER)))
                    else:
                        db.execute(sql.SQL('CREATE ROLE {} WITH LOGIN SUPERUSER').format(sql.Identifier(DATABASE_USER)))
                        print(f'Создана роль {DATABASE_USER} в существующем кластере PostgreSQL.')
            except psycopg.Error as exc:
                errors.append(f'{user}: {exc}')
            return
        raise psycopg.OperationalError('Cannot connect to the local PostgreSQL cluster as any known role: ' + '; '.join(errors))

    def _stop(self) -> 'None':
        if not self._running:
            return
        self._running = False
        try:
            self._run_tool('pg_ctl.exe', '-D', str(self.data_directory), '-m', 'fast', '-w', '-t', '30', 'stop')
        finally:
            pass

    def __enter__(self) -> 'str':
        try:
            self._start()
        except Exception:
            self._stop()
            raise
        return self.database_url

    def __exit__(self, exc_type: 'object', exc: 'object', traceback: 'object') -> 'None':
        try:
            self._stop()
            return
        except Exception:
            if exc_type is None:
                raise


# WARNING: Decompyle incomplete
