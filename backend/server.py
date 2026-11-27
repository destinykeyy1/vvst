"""Local persistence API for the military planner frontend."""

from __future__ import annotations

import os
import sys
import threading
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path

import psycopg

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.config import (
    ACCESS_PASSWORD_HASH_ITERATIONS,
    ACCESS_PASSWORD_MAX_LENGTH,
    ACCESS_PASSWORD_MIN_LENGTH,
    ACCESS_SCOPES,
    ACCESS_SESSION_TTL_SECONDS,
    DEFAULT_DATABASE_URL,
    MAX_DATABASE_ID,
    MAX_NUMBERED_PASSPORT_FIELDS,
    MAX_PASSPORT_FIELDS,
    STATIC_MIME_TYPES,
    _static_content_type,
    database_url,
)
from backend.documents import (
    CHANGE_FIELDS,
    CONDITION_FIELDS,
    CURRENT_HOURS_HEADER,
    DOCUMENT_APPROVAL_PARAGRAPHS,
    DOCUMENT_LIMIT,
    DOCUMENT_TEMPLATES,
    ORDER_FIELDS,
    ORDER_SECTIONS,
    ORDER_SHEET,
    WRITEOFF_FIELDS,
)
from backend.http_api import make_handler
from backend.models import (
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
)
from backend.store import PlannerStore

def run(static_root: 'str | Path | None'=None) -> 'None':
    host = os.environ.get('MILITARY_PLANNER_HOST', '127.0.0.1')
    if host not in {'localhost', '0.0.0.0', '127.0.0.1'}:
        raise RuntimeError('The planner API host must be loopback or all interfaces')
    if host == 'localhost':
        host = '127.0.0.1'
    port = int(os.environ.get('MILITARY_PLANNER_PORT', '8000'))
    
    # Check for frontend directory from environment variable
    if static_root is None:
        frontend_dir = os.environ.get('MILITARY_PLANNER_FRONTEND_DIR')
        if frontend_dir:
            static_root = Path(frontend_dir).resolve()
    
    if static_root is not None:
        static_root = Path(static_root).resolve()
    if static_root is not None and not (static_root / 'index.html').is_file():
        raise RuntimeError(f'Frontend build not found in {static_root}. Run npm run build first.')
    try:
        store = PlannerStore()
    except (psycopg.Error, ValueError) as exc:
        raise RuntimeError('Cannot connect to PostgreSQL. Start the PostgreSQL service, create the Military Planner database/role, and configure MILITARY_PLANNER_DATABASE_URL.') from exc
    try:
        server = ThreadingHTTPServer((host, port), make_handler(store, static_root))
    except OSError as exc:
        raise RuntimeError(f'Cannot start Military Planner on {host}:{port}. The port may already be in use; close the other application and try again.') from exc
    print(f'Military Planner API: http://{host}:{port} (PostgreSQL)')
    autopen = os.environ.get('MILITARY_PLANNER_AUTOPEN', '1') != '0'
    if static_root is not None and host != '0.0.0.0' and autopen:
        threading.Timer(0.7, webbrowser.open, args=(f'http://{host}:{port}/',)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()

if __name__ == '__main__':
    run()
