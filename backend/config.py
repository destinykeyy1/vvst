"""Runtime configuration and shared application settings."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

import psycopg

DEFAULT_DATABASE_URL = 'postgresql://planner_app@localhost:5432/military_planner'
MAX_DATABASE_ID = 9223372036854775807
MAX_PASSPORT_FIELDS = 512
MAX_NUMBERED_PASSPORT_FIELDS = 130
ACCESS_SCOPES = {'orders', 'passport', 'general'}
ACCESS_PASSWORD_MIN_LENGTH = 8
ACCESS_PASSWORD_MAX_LENGTH = 128
ACCESS_PASSWORD_HASH_ITERATIONS = 310000
ACCESS_SESSION_TTL_SECONDS = 28800
STATIC_MIME_TYPES = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.txt': 'text/plain'}

def _static_content_type(file_name: 'str') -> 'str':
    extension = Path(file_name).suffix.lower()
    known = STATIC_MIME_TYPES.get(extension)
    if known is not None:
        return known
    return mimetypes.guess_type(file_name)[0] or 'application/octet-stream'

def database_url() -> 'str':
    configured = os.environ.get('MILITARY_PLANNER_DATABASE_URL')
    if configured is not None:
        if not configured.strip():
            raise ValueError('MILITARY_PLANNER_DATABASE_URL must not be empty')
        return configured
    db_host = os.environ.get('MILITARY_PLANNER_DB_HOST')
    if db_host:
        return psycopg.conninfo.make_conninfo(host=db_host, port=os.environ.get('MILITARY_PLANNER_DB_PORT', '5432'), dbname=os.environ.get('MILITARY_PLANNER_DB_NAME', 'military_planner'), user=os.environ.get('MILITARY_PLANNER_DB_USER', 'postgres'), password=os.environ.get('MILITARY_PLANNER_DB_PASSWORD', ''))
    return DEFAULT_DATABASE_URL

