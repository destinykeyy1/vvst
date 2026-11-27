"""HTTP request handling and API routes."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse, urlsplit

import psycopg

from .config import (
    ACCESS_PASSWORD_MAX_LENGTH,
    ACCESS_PASSWORD_MIN_LENGTH,
    ACCESS_SCOPES,
    ACCESS_SESSION_TTL_SECONDS,
    MAX_DATABASE_ID,
    _static_content_type,
)
from .documents import (
    DOCUMENT_LIMIT,
    DOCUMENT_TEMPLATES,
    _document_import,
    _document_order_export,
    _document_word_export,
)
from .models import (
    ConflictError,
    ExploitationDTO,
    JournalDutyDTO,
    JournalEntryDTO,
    JournalNotFoundError,
    JournalPermissionError,
    OrderDraftDTO,
    OrderLineDTO,
    PublishedOrderDTO,
    ScheduleItemDTO,
    UnavailableDTO,
    ValidationError,
    VehicleDTO,
    VehicleDetailsDTO,
    _choice,
    _exact_fields,
    _string,
)

def make_handler(store: 'PlannerStore', static_root: 'str | Path | None'=None) -> 'type[BaseHTTPRequestHandler]':
    frontend_root = Path(static_root).resolve() if static_root is not None else None
    cookie_secure = '; Secure' if os.environ.get('MILITARY_PLANNER_COOKIE_SECURE', '').lower() in {'1', 'yes', 'true'} else ''
    login_attempts = {}
    login_attempts_lock = threading.Lock()
    login_limit = 10
    login_window_seconds = 60
    def login_attempt_allowed(key: 'str') -> 'bool':
        now = time.monotonic()
        with login_attempts_lock:
            for attempt_key in list(login_attempts):
                recent = [timestamp for timestamp in login_attempts[attempt_key]
                     if now - timestamp < login_window_seconds]
                if recent:
                    login_attempts[attempt_key] = recent
                else:
                    del login_attempts[attempt_key]
            return len(login_attempts.get(key, [])) < login_limit

    def record_login_failure(key: 'str') -> 'None':
        now = time.monotonic()
        with login_attempts_lock:
            login_attempts.setdefault(key, []).append(now)

    def clear_login_failures(key: 'str') -> 'None':
        with login_attempts_lock:
            login_attempts.pop(key, None)

    def access_cookie_name(scope: 'str') -> 'str':
        if scope == 'passport':
            return 'planner_access_passport_session'
        return f'planner_access_{scope}'

    collections = {'/api/vehicles': ('vehicles', VehicleDTO), '/api/unavailable': ('unavailable', UnavailableDTO), '/api/order-drafts': ('order_drafts', OrderDraftDTO), '/api/orders': ('orders', PublishedOrderDTO), '/api/order-section-lines': ('order_section_lines', OrderLineDTO), '/api/schedules': ('schedules', ScheduleItemDTO), '/api/household-schedules': ('household_schedules', ScheduleItemDTO), '/api/other-schedules': ('other_schedules', ScheduleItemDTO), '/api/exploitation': ('exploitation', ExploitationDTO), '/api/journal': ('journal', JournalEntryDTO), '/api/journal-duty': ('journal_duty', JournalDutyDTO), '/api/vehicle-details': ('vehicle_details', VehicleDetailsDTO)}
    class Handler(BaseHTTPRequestHandler):
        server_version = 'MilitaryPlannerAPI/1.0'
        def parse_request(self) -> 'bool':
            if not super().parse_request():
                return False
            host_header = self.headers.get('Host', '')
            try:
                parsed_host = urlsplit(f'//{host_header}')
                host = (parsed_host.hostname or '').lower()
                port = parsed_host.port
            except ValueError:
                parsed_host = urlsplit('//')
                host, port = '', None
            expected_port = self.server.server_port
            # Allow Docker host access and port mapping
            allowed_hosts = {'localhost', '127.0.0.1', '0.0.0.0'}
            if os.environ.get('MILITARY_PLANNER_HOST') == '0.0.0.0':
                allowed_hosts.update({'host.docker.internal', 'backend', 'web'})
            # Allow any port when running in Docker (external port may differ)
            if os.environ.get('MILITARY_PLANNER_HOST') == '0.0.0.0':
                port_check = True
            else:
                port_check = port in {expected_port, None} or (port is None and expected_port != 80)
            if parsed_host.username is not None or parsed_host.password is not None or parsed_host.path or parsed_host.query or parsed_host.fragment or host not in allowed_hosts or not port_check:
                self.send_error(403, 'Host must be this local server')
                return False
            return True

        def send_json(self, status: 'int', payload: 'Any', headers: 'dict[str, str] | None'=None) -> 'None':
            data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)

        def read_body(self) -> 'Any':
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if size > 67108864:
                    raise ValidationError('Тело запроса слишком велико')
                return json.loads(self.rfile.read(size))
            except (ValueError, json.JSONDecodeError) as exc:
                raise ValidationError('Тело запроса должно содержать корректный JSON') from exc

        def serve_frontend(self, head_only: 'bool'=False) -> 'None':
            if frontend_root is None:
                self.send_error(404, 'not found')
                return
            request_path = unquote(urlparse(self.path).path)
            if '\x00' in request_path or '\\' in request_path:
                self.send_error(404, 'not found')
                return
            relative = request_path.lstrip('/')
            if any((part in {'..', '.'} for part in relative.split('/'))):
                self.send_error(404, 'not found')
                return
            candidate = (frontend_root / relative).resolve()
            try:
                candidate.relative_to(frontend_root)
            except ValueError:
                self.send_error(404, 'not found')
            if candidate.is_dir():
                candidate = candidate / 'index.html'
            if not candidate.is_file():
                if request_path != '/' and Path(request_path).suffix:
                    self.send_error(404, 'not found')
                    return
                candidate = frontend_root / 'index.html'
            candidate = candidate.resolve()
            try:
                candidate.relative_to(frontend_root)
            except ValueError:
                self.send_error(404, 'not found')
            if not candidate.is_file():
                self.send_error(404, 'not found')
                return
            try:
                stat = candidate.stat()
                etag = f'"{int(stat.st_mtime):x}-{stat.st_size:x}"'
            except OSError:
                etag = ''
            if etag and self.headers.get('If-None-Match') == etag:
                self.send_response(304)
                self.send_header('ETag', etag)
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                return
            try:
                data = candidate.read_bytes()
            except OSError:
                self.send_error(500, 'unable to read frontend asset')
            content_type = _static_content_type(candidate.name)
            if content_type.startswith('text/') or content_type in {'application/javascript', 'image/svg+xml', 'application/json'}:
                content_type += '; charset=utf-8'
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            if etag:
                self.send_header('ETag', etag)
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            if not head_only:
                self.wfile.write(data)

        def check_authentication(self) -> 'bool':
            """Check if the request is authenticated for protected endpoints."""
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            morsel = cookie.get('planner_access_general')
            try:
                return store.is_access_session_valid('general', morsel.value if morsel else None)
            except psycopg.Error:
                return False

        def do_GET(self) -> 'None':
            path = urlparse(self.path).path
            if not path.startswith('/api/'):
                if path != '/api':
                    self.serve_frontend()
                    return
            access_parts = path.strip('/').split('/')
            if len(access_parts) == 3 and access_parts[:2] == ['api', 'access'] and access_parts[2] in ACCESS_SCOPES:
                scope = access_parts[2]
                cookie = SimpleCookie(self.headers.get('Cookie', ''))
                morsel = cookie.get(access_cookie_name(scope))
                try:
                    authenticated = store.is_access_session_valid(scope, morsel.value if morsel else None)
                    configured = store.access_password_configured(scope)
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
                legacy_cookie = cookie.get('planner_access_passport') if scope == 'passport' else None
                headers = None
                if legacy_cookie:
                    headers = {'Set-Cookie': f'planner_access_passport=; HttpOnly; SameSite=Strict{cookie_secure}; Path=/api/access/passport; Max-Age=0'}
                self.send_json(200, {'configured': configured, 'authenticated': authenticated}, headers)
                return
            if path == '/api/registry-changes':
                try:
                    if not self.check_authentication():
                        self.send_json(401, {'error': 'Введите пароль перечня ВВСТ'})
                        return
                    cursor = parse_qs(urlparse(self.path).query).get('before', [None])[0]
                    if cursor is not None and (not re.fullmatch(r'[0-9]{1,19}', cursor)
                                               or not 1 <= int(cursor) <= MAX_DATABASE_ID):
                        self.send_json(400, {'error': 'Некорректный номер записи'})
                        return
                    self.send_json(200, store.list_registry_changes(int(cursor) if cursor else None))
                except psycopg.Error:
                    self.send_json(503, {'error': 'База данных недоступна'})
                return
            if path == '/api/health':
                try:
                    store.check_ready()
                except psycopg.Error:
                    self.send_json(503, {'status': 'unavailable', 'error': 'database unavailable'})
                self.send_json(200, {'status': 'ok'})
                return
            # Check authentication for protected endpoints (write-only for vehicles, full for others)
            protected_paths = {
                '/api/unavailable', '/api/order-drafts', '/api/orders',
                '/api/order-section-lines', '/api/schedules', '/api/household-schedules',
                '/api/other-schedules', 
                '/api/standing-vehicles'
            }
            if path in protected_paths:
                if not self.check_authentication():
                    self.send_json(401, {'error': 'Authentication required'})
                    return
            try:
                if path == '/api/standing-vehicles':
                    self.send_json(200, store.list_standing_ids())
                    return
                collection = collections.get(path)
                if collection is None:
                    self.send_json(404, {'error': 'not found'})
                    return
                self.send_json(200, store.list_items(collection[0]))
            except psycopg.Error:
                self.send_json(503, {'error': 'database unavailable'})

        def handle_document(self, path):
            pieces = path.split('/')
            if len(pieces) != 5:
                self.send_json(404, {'error': 'Маршрут документов не найден'})
                return
            kind, action = pieces[3:]
            if kind not in DOCUMENT_TEMPLATES or action not in {'import', 'export'}:
                self.send_json(404, {'error': 'Операция или вид документа не найдены'})
                return
            if not self.check_authentication():
                self.send_json(401, {'error': 'Требуется вход в приложение'})
                return
            try:
                content_type = self.headers.get_content_type()
                expected = 'application/octet-stream' if action == 'import' else 'application/json'
                if content_type != expected or self.headers.get('Transfer-Encoding'):
                    self.send_json(415, {'error': f'Ожидается Content-Type: {expected}'})
                    return
                length = self.headers.get('Content-Length', '')
                if not length.isascii() or not length.isdigit() or len(length) > 8:
                    raise ValidationError('Укажите корректный размер запроса')
                size = int(length)
                if size > DOCUMENT_LIMIT:
                    self.send_json(413, {'error': 'Допустимый размер запроса — 16 МБ'})
                    return
                self.connection.settimeout(30)
                data = self.rfile.read(size)
                if len(data) != size or not data:
                    raise ValidationError('Пустое или неполное тело запроса')
                vehicles = {item['id']: item for item in store.list_items('vehicles')}
                details = {item['vehicleId']: item for item in store.list_items('vehicle_details')}
                if action == 'import':
                    rows = _document_import(kind, data, vehicles, details)
                    if not rows:
                        raise ValidationError('Документ не содержит заполненных строк')
                    self.send_json(200, {'kind': kind, 'rows': rows})
                    return
                try:
                    body = json.loads(data)
                except (ValueError, UnicodeError, RecursionError) as exc:
                    raise ValidationError('Некорректный JSON') from exc
                _exact_fields(body, {'rows'}, {'number', 'date', 'notes', 'source'})
                if 'source' in body:
                    _choice(body['source'], {'inventory'}, 'Источник документа')
                rows = body['rows']
                if not isinstance(rows, list) or not 1 <= len(rows) <= 300 or not all(
                        isinstance(item, dict) for item in rows):
                    raise ValidationError('Передайте от 1 до 300 строк документа')
                name = DOCUMENT_TEMPLATES[kind]
                root = Path(os.environ.get('MILITARY_PLANNER_DOCUMENT_DIR',
                                           str(Path(__file__).resolve().parent / 'document-templates')))
                template = (root / name).read_bytes()
                payload = (_document_order_export(template, body, vehicles, details) if kind == 'order'
                           else _document_word_export(kind, template, body, vehicles, details))
                filename = f'{kind}{Path(name).suffix}'
                self.send_response(200)
                self.send_header('Content-Type', _static_content_type(filename))
                self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except ValidationError as exc:
                self.send_json(400, {'error': str(exc)})
            except FileNotFoundError:
                self.send_json(503, {'error': 'Шаблон документа отсутствует на сервере'})
            except psycopg.Error:
                self.send_json(503, {'error': 'База данных недоступна'})
            except TimeoutError:
                self.close_connection = True
                self.send_json(408, {'error': 'Истекло время загрузки файла'})

        def do_POST(self) -> 'None':
            path = urlparse(self.path).path
            if path.startswith('/api/documents/'):
                self.handle_document(path)
                return
            if path == '/api/order-drafts/publish':
                if not self.check_authentication():
                    self.send_json(401, {'error': 'Требуется вход в приложение'})
                    return
                try:
                    order = store.publish_order_draft(self.read_body())
                    self.send_json(200, order)
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                except (ConflictError, psycopg.errors.UniqueViolation) as exc:
                    self.send_json(409, {'error': str(exc) if isinstance(exc, ConflictError) else 'Наряд уже существует'})
                except psycopg.Error:
                    self.send_json(503, {'error': 'База данных недоступна'})
                return
            if path == '/api/duty/readings':
                if not self.check_authentication():
                    self.send_json(401, {'error': 'Требуется вход в приложение'})
                    return
                try:
                    store.save_duty_readings(self.read_body())
                    self.send_json(200, {'ok': True})
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                except ConflictError as exc:
                    self.send_json(409, {'error': str(exc)})
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
                return
            if path in {'/api/journal/save-signature', '/api/journal/month-report', '/api/journal/archive-month'}:
                attempt_key = f'{self.client_address[0]}:journal'
                report_action = path != '/api/journal/save-signature'
                if report_action and not login_attempt_allowed(attempt_key):
                    self.send_json(429, {'error': 'Слишком много попыток. Попробуйте позже.'})
                    return
                try:
                    body = self.read_body()
                    if path == '/api/journal/save-signature':
                        result = store.journal_save_signature(body)
                    else:
                        result = store.journal_month_report(body, archive=path == '/api/journal/archive-month')
                    if report_action:
                        clear_login_failures(attempt_key)
                    self.send_json(200, result, {'Cache-Control': 'no-store'})
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                except JournalPermissionError as exc:
                    record_login_failure(attempt_key)
                    self.send_json(403, {'error': str(exc)})
                except ConflictError as exc:
                    self.send_json(409, {'error': str(exc)})
                except psycopg.Error:
                    self.send_json(503, {'error': 'База данных недоступна'})
                return
            if path == '/api/journal/verify-password':
                try:
                    body = self.read_body()
                    _exact_fields(body, {'password'})
                    password = body['password']
                    _string(password, 'password')
                    if len(password) > ACCESS_PASSWORD_MAX_LENGTH:
                        raise ValidationError('Пароль слишком длинный')
                    attempt_key = f'{self.client_address[0]}:journal'
                    if not login_attempt_allowed(attempt_key):
                        self.send_json(429, {'error': 'Слишком много попыток. Попробуйте позже.'})
                        return
                    with store.connect() as db:
                        allowed = store._journal_password_matches(db, password)
                    if not allowed:
                        record_login_failure(attempt_key)
                        self.send_json(403, {'error': 'Неверный пароль'})
                        return
                    clear_login_failures(attempt_key)
                    self.send_json(200, {'ok': True})
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
                return
            if path == '/api/journal/actions':
                try:
                    body = self.read_body()
                    if not isinstance(body, dict):
                        raise ValidationError('Тело запроса должно быть объектом')
                    action = body.get('action')
                    if action == 'create':
                        _exact_fields(body, {'action', 'fields'})
                        store.journal_create(body['fields'])
                    elif action == 'return':
                        _exact_fields(body, {'action', 'id', 'fields'})
                        item_id = body['id']
                        if type(item_id) is not int or not 1 <= item_id <= MAX_DATABASE_ID:
                            raise ValidationError('id должен быть положительным целым числом')
                        store.journal_return(item_id, body['fields'])
                    elif action == 'edit':
                        _exact_fields(body, {'action', 'id', 'fields'}, {'password'})
                        item_id = body['id']
                        if type(item_id) is not int or not 1 <= item_id <= MAX_DATABASE_ID:
                            raise ValidationError('id должен быть положительным целым числом')
                        password = body.get('password')
                        if password is not None:
                            _string(password, 'password')
                            if len(password) > ACCESS_PASSWORD_MAX_LENGTH:
                                raise ValidationError('Пароль слишком длинный')
                        store.journal_edit(item_id, body['fields'], password)
                    elif action == 'delete':
                        _exact_fields(body, {'action', 'id'}, {'password'})
                        item_id = body['id']
                        if type(item_id) is not int or not 1 <= item_id <= MAX_DATABASE_ID:
                            raise ValidationError('id должен быть положительным целым числом')
                        password = body.get('password')
                        if password is not None:
                            _string(password, 'password')
                            if len(password) > ACCESS_PASSWORD_MAX_LENGTH:
                                raise ValidationError('Пароль слишком длинный')
                        store.journal_delete(item_id, password)
                    else:
                        raise ValidationError('Неизвестное действие журнала')
                    items = store.list_items('journal')
                    self.send_json(200, items)
                    return
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                except JournalNotFoundError as exc:
                    self.send_json(404, {'error': str(exc)})
                except JournalPermissionError as exc:
                    self.send_json(403, {'error': str(exc)})
                except ConflictError as exc:
                    self.send_json(409, {'error': str(exc)})
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
                return
            access_parts = path.strip('/').split('/')
            if len(access_parts) != 4 or access_parts[:2] != ['api', 'access'] or access_parts[2] not in ACCESS_SCOPES or access_parts[3] not in {'login', 'setup', 'logout'}:
                self.send_json(404, {'error': 'not found'})
                return
            scope = access_parts[2]
            action = access_parts[3]
            attempt_key = f'{self.client_address[0]}:{scope}'
            cookie_name = access_cookie_name(scope)
            cookie_path = '/api'
            try:
                cookie = SimpleCookie(self.headers.get('Cookie', ''))
                morsel = cookie.get(cookie_name)
                current_token = morsel.value if morsel else None
                if action == 'logout':
                    store.revoke_access_session(scope, current_token)
                    self.send_json(200, {'configured': store.access_password_configured(scope), 'authenticated': False}, {'Set-Cookie': f'{cookie_name}=; HttpOnly; SameSite=Strict{cookie_secure}; Path={cookie_path}; Max-Age=0'})
                    return
                body = self.read_body()
                _exact_fields(body, {'password'})
                password = body['password']
                _string(password, 'password')
                if len(password) < ACCESS_PASSWORD_MIN_LENGTH or len(password) > ACCESS_PASSWORD_MAX_LENGTH or not password.strip():
                    raise ValidationError(f'Пароль должен содержать от {ACCESS_PASSWORD_MIN_LENGTH} до {ACCESS_PASSWORD_MAX_LENGTH} символов')
                if not login_attempt_allowed(attempt_key):
                    self.send_json(429, {'error': 'Слишком много попыток. Повторите позже.'}, {'Retry-After': str(login_window_seconds)})
                    return
                if action == 'setup':
                    if not store.set_access_password(scope, password):
                        self.send_json(409, {'error': 'Пароль уже настроен.'})
                        return
                elif not store.verify_access_password(scope, password):
                    record_login_failure(attempt_key)
                    self.send_json(401, {'error': 'Неверный пароль.'})
                    return
                clear_login_failures(attempt_key)
                token = store.create_access_session(scope)
                cookie_lifetime = '' if scope == 'passport' else f'; Max-Age={ACCESS_SESSION_TTL_SECONDS}'
                self.send_json(200, {'configured': True, 'authenticated': True}, {'Set-Cookie': f'{cookie_name}={token}; HttpOnly; SameSite=Strict{cookie_secure}; Path={cookie_path}{cookie_lifetime}'})
                return
            except ValidationError as exc:
                self.send_json(400, {'error': str(exc)})
            except psycopg.Error:
                self.send_json(503, {'error': 'database unavailable'})

        def do_HEAD(self) -> 'None':
            path = urlparse(self.path).path
            if path.startswith('/api/') or path == '/api':
                self.send_error(405, 'HEAD is not supported for API endpoints')
                return
            self.serve_frontend(head_only=True)

        def do_PUT(self) -> 'None':
            path = urlparse(self.path).path
            # Check authentication for protected endpoints (write-only for vehicles, full for others)
            protected_paths = {
                '/api/unavailable', '/api/order-drafts', '/api/orders',
                '/api/order-section-lines', '/api/schedules', '/api/household-schedules',
                '/api/other-schedules', 
                '/api/standing-vehicles', '/api/mileage-sync'
            }
            if path in protected_paths:
                if not self.check_authentication():
                    self.send_json(401, {'error': 'Authentication required'})
                    return
            if path == '/api/mileage-sync':
                try:
                    state = store.replace_mileage_state(self.read_body())
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                    return
                except ConflictError as exc:
                    self.send_json(409, {'error': str(exc)})
                    return
                except psycopg.errors.UniqueViolation:
                    self.send_json(409, {'error': 'duplicate id'})
                    return
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
                    return
                self.send_json(200, state)
                return
            if path == '/api/standing-vehicles':
                try:
                    ids = store.replace_standing_ids(self.read_body())
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                    return
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
                    return
                self.send_json(200, ids)
                return
            collection = collections.get(path)
            if collection is None:
                self.send_json(404, {'error': 'not found'})
                return
            try:
                items = store.replace_items(collection[0], self.read_body(), collection[1])
            except ValidationError as exc:
                self.send_json(400, {'error': str(exc)})
                return
            except ConflictError as exc:
                self.send_json(409, {'error': str(exc)})
                return
            except psycopg.errors.UniqueViolation:
                self.send_json(409, {'error': 'duplicate id'})
                return
            except psycopg.Error:
                self.send_json(503, {'error': 'database unavailable'})
                return
            self.send_json(200, items)

        def do_PATCH(self) -> 'None':
            path = urlparse(self.path).path
            prefix = '/api/vehicles/'
            vehicle_id_text = path[len(prefix):] if path.startswith(prefix) else ''
            if not vehicle_id_text.isdecimal():
                self.send_json(404, {'error': 'not found'})
                return
            try:
                old_id = int(vehicle_id_text)
                body = self.read_body()
                _exact_fields(body, {'id'})
                new_id = body['id']
                if type(new_id) is not int or new_id < 1 or new_id > MAX_DATABASE_ID:
                    raise ValidationError('Идентификатор машины должен быть положительным целым числом')
                if old_id > MAX_DATABASE_ID:
                    raise ValidationError('Идентификатор машины выходит за допустимый диапазон')
                if not store.update_vehicle_id(old_id, new_id):
                    self.send_json(404, {'error': 'vehicle not found'})
                    return
            except ValidationError as exc:
                self.send_json(400, {'error': str(exc)})
            except ConflictError as exc:
                self.send_json(409, {'error': str(exc)})
            except psycopg.errors.UniqueViolation:
                self.send_json(409, {'error': 'duplicate id'})
            except psycopg.Error:
                self.send_json(503, {'error': 'database unavailable'})
            self.send_json(200, {'id': new_id})

        def do_DELETE(self) -> 'None':
            path = urlparse(self.path).path
            order_match = re.fullmatch(r'/api/orders/([1-9][0-9]{0,18})', path)
            if order_match:
                if not self.check_authentication():
                    self.send_json(401, {'error': 'Требуется вход в приложение'})
                    return
                order_id = int(order_match[1])
                if order_id > MAX_DATABASE_ID:
                    self.send_json(400, {'error': 'Некорректный идентификатор наряда'})
                    return
                try:
                    deleted = store.delete_published_order(order_id)
                except psycopg.Error:
                    self.send_json(503, {'error': 'База данных недоступна'})
                    return
                if not deleted:
                    self.send_json(404, {'error': 'Опубликованный наряд не найден'})
                    return
                self.send_json(200, {'deleted': True})
                return
            if path == '/api/vehicles':
                try:
                    body = self.read_body()
                    if not (isinstance(body, dict) and isinstance(body.get('ids'), list)):
                        raise ValidationError('Список идентификаторов должен быть массивом')
                    vehicle_ids = body['ids']
                    if vehicle_ids:
                        if any((type(vehicle_id) is not int or vehicle_id < 1 or vehicle_id > MAX_DATABASE_ID for vehicle_id in vehicle_ids)) or len(set(vehicle_ids)) != len(vehicle_ids):
                            raise ValidationError('Идентификаторы машин должны быть уникальными положительными целыми числами')
                    deleted = store.delete_vehicles(vehicle_ids)
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
                if not deleted:
                    self.send_json(404, {'error': 'one or more vehicles not found'})
                    return
                self.send_json(200, {'deleted': True, 'count': len(vehicle_ids)})
                return
            prefix = '/api/vehicles/'
            vehicle_id_text = path[len(prefix):] if path.startswith(prefix) else ''
            if not vehicle_id_text.isdecimal():
                self.send_json(404, {'error': 'not found'})
                return
            try:
                deleted = store.delete_vehicle(int(vehicle_id_text))
            except psycopg.Error:
                self.send_json(503, {'error': 'database unavailable'})
            if not deleted:
                self.send_json(404, {'error': 'vehicle not found'})
                return
            self.send_json(200, {'deleted': True})

        def log_message(self, _format: 'str', *_args: 'Any') -> 'None':
            pass


    return Handler

