"""PostgreSQL persistence and domain operations."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from .config import (
    ACCESS_PASSWORD_HASH_ITERATIONS,
    ACCESS_PASSWORD_MAX_LENGTH,
    ACCESS_SESSION_TTL_SECONDS,
    MAX_DATABASE_ID,
    database_url,
)
from .documents import (
    CURRENT_HOURS_HEADER,
    _audit_registry_replacement,
    _current_hours_field,
    _document_key,
    _passport_current_hours,
    _record_registry_changes,
    _vehicle_with_current_hours,
)
from .models import (
    ConflictError,
    ExploitationDTO,
    JournalEntryDTO,
    JournalNotFoundError,
    JournalPermissionError,
    PublishedOrderDTO,
    ValidationError,
    VehicleDTO,
    VehicleDetailsDTO,
    _JOURNAL_ARRIVAL_FIELDS,
    _JOURNAL_ARRIVAL_ONLY_FIELDS,
    _JOURNAL_DEFAULT_ENTRY,
    _JOURNAL_DEPARTURE_FIELDS,
    _exact_fields,
    _iso_date,
    _journal_closed,
    _nonnegative_int,
    _nonnegative_number,
    _string,
    _validate_journal_arrival,
)

class PlannerStore:
    '''Owns the frontend PostgreSQL collection table.'''

    def __init__(self, url: 'str | None'=None, connect_kwargs: 'dict[str, Any] | None'=None):
        self.url = database_url() if url is None else url
        self.connect_kwargs = connect_kwargs or {}
        self.connect_kwargs.setdefault('connect_timeout', 10)
        with self.connect() as db:
            db.execute('\n                CREATE TABLE IF NOT EXISTS planner_items (\n                    collection TEXT NOT NULL,\n                    item_id BIGINT NOT NULL,\n                    payload JSONB NOT NULL,\n                    PRIMARY KEY (collection, item_id)\n                )\n            ')
            db.execute("\n                CREATE TABLE IF NOT EXISTS planner_access_credentials (\n                    scope TEXT PRIMARY KEY CHECK (scope IN ('orders', 'passport', 'general')),\n                    password_salt BYTEA NOT NULL,\n                    password_hash BYTEA NOT NULL,\n                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()\n                )\n            ")
            db.execute("\n                ALTER TABLE planner_access_credentials\n                DROP CONSTRAINT IF EXISTS planner_access_credentials_scope_check\n            ")
            db.execute("\n                ALTER TABLE planner_access_credentials\n                ADD CONSTRAINT planner_access_credentials_scope_check\n                CHECK (scope IN ('orders', 'passport', 'general'))\n            ")
            db.execute('\n                CREATE TABLE IF NOT EXISTS planner_access_sessions (\n                    token_hash TEXT PRIMARY KEY,\n                    scope TEXT NOT NULL REFERENCES planner_access_credentials(scope)\n                        ON DELETE CASCADE,\n                    expires_at TIMESTAMPTZ NOT NULL\n                )\n            ')
            db.execute('\n                CREATE INDEX IF NOT EXISTS planner_access_sessions_scope_expiry\n                ON planner_access_sessions (scope, expires_at)\n            ')

            db.execute("""
                CREATE TABLE IF NOT EXISTS planner_registry_changes (
                    id BIGSERIAL PRIMARY KEY,
                    changed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
                    vehicle_id BIGINT NOT NULL,
                    reg_number TEXT NOT NULL,
                    column_name TEXT NOT NULL,
                    old_value JSONB NOT NULL,
                    new_value JSONB NOT NULL
                )
            """)

    def list_registry_changes(self, before):
        query = ("SELECT id, changed_at, vehicle_id, reg_number, column_name, old_value, new_value "
                 "FROM planner_registry_changes ")
        args = ()
        if before is not None:
            query += "WHERE id < %s "
            args = (before,)
        with self.connect() as db:
            rows = db.execute(query + "ORDER BY id DESC LIMIT 101", args).fetchall()
        return {
            'items': [
                {'id': str(row[0]), 'changedAt': row[1].isoformat(), 'vehicleId': str(row[2]),
                 'regNumber': row[3], 'column': row[4], 'old': row[5], 'new': row[6]}
                for row in rows[:100]
            ],
            'next': str(rows[99][0]) if len(rows) > 100 else None,
        }

    def connect(self) -> 'psycopg.Connection':
        return psycopg.connect(self.url, **self.connect_kwargs)

    def check_ready(self) -> 'None':
        with self.connect() as db:
            db.execute('SELECT 1')

    def set_access_password(self, scope: 'str', password: 'str') -> 'bool':
        salt = secrets.token_bytes(16)
        password_hash = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, ACCESS_PASSWORD_HASH_ITERATIONS)
        with self.connect() as db:
            row = db.execute('\n                INSERT INTO planner_access_credentials\n                    (scope, password_salt, password_hash)\n                VALUES (%s, %s, %s)\n                ON CONFLICT (scope) DO NOTHING\n                RETURNING scope\n                ', (scope, salt, password_hash)).fetchone()
        return row is not None

    def verify_access_password(self, scope: 'str', password: 'str') -> 'bool':
        with self.connect() as db:
            row = db.execute('\n                SELECT password_salt, password_hash\n                FROM planner_access_credentials\n                WHERE scope = %s\n                ', (scope,)).fetchone()
        if row is None:
            return False
        candidate = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes(row[0]), ACCESS_PASSWORD_HASH_ITERATIONS)
        return hmac.compare_digest(candidate, bytes(row[1]))

    def create_access_session(self, scope: 'str') -> 'str':
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
        with self.connect() as db:
            db.execute("\n                INSERT INTO planner_access_sessions\n                    (token_hash, scope, expires_at)\n                VALUES (%s, %s, now() + (%s * interval '1 second'))\n                ", (token_hash, scope, ACCESS_SESSION_TTL_SECONDS))
        return token

    def is_access_session_valid(self, scope: 'str', token: 'str | None') -> 'bool':
        if not token:
            return False
        try:
            token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
        except UnicodeEncodeError:
            return False
        with self.connect() as db:
            db.execute('DELETE FROM planner_access_sessions WHERE expires_at <= now()')
            row = db.execute('\n                SELECT 1 FROM planner_access_sessions\n                WHERE token_hash = %s AND scope = %s AND expires_at > now()\n                ', (token_hash, scope)).fetchone()
        return row is not None

    def revoke_access_session(self, scope: 'str', token: 'str | None') -> 'None':
        if not token:
            return
        try:
            token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
        except UnicodeEncodeError:
            return
        with self.connect() as db:
            db.execute('DELETE FROM planner_access_sessions WHERE token_hash = %s AND scope = %s', (token_hash, scope))

    def access_password_configured(self, scope: 'str') -> 'bool':
        with self.connect() as db:
            row = db.execute('SELECT 1 FROM planner_access_credentials WHERE scope = %s', (scope,)).fetchone()
        return row is not None

    @staticmethod
    def _journal_vehicle(entry, vehicles):
        number = _document_key(entry['regNumber'])
        if not number:
            return None
        matches = [vehicle for vehicle in vehicles if _document_key(vehicle['regNumber']) == number]
        if len(matches) > 1:
            matches = [vehicle for vehicle in matches
                       if _document_key(vehicle['brand']) == _document_key(entry['brand'])]
        return matches[0] if len(matches) == 1 else None

    @staticmethod
    def _write_vehicle_readings(db, vehicle, km, hours):
        updated = dict(vehicle)
        if km is not None:
            updated['currentMileage'] = km
        fields = [dict(field) for field in vehicle.get('passportData') or []]
        odometer = next((field for field in fields
                         if _document_key(field['header']) == 'текущиепоказанияспидометра'), None)
        if odometer is not None and km is not None:
            odometer['value'] = km
        if hours is not None:
            matches = [field for field in fields if _current_hours_field(field)]
            if not matches:
                field = {'header': CURRENT_HOURS_HEADER,
                         'column': max((field['column'] for field in fields), default=0) + 1}
                fields.append(field)
                matches.append(field)
            for field in matches:
                field['value'] = hours
        if odometer is not None or hours is not None:
            updated['passportData'] = fields
        VehicleDTO.parse(updated)
        _record_registry_changes(db, {vehicle['id']: vehicle}, {updated['id']: updated})
        db.execute(
            "UPDATE planner_items SET payload = %s WHERE collection = 'vehicles' AND item_id = %s",
            (Jsonb(updated), vehicle['id']),
        )

    @staticmethod
    def _append_exploitation(db, reading):
        next_id = db.execute(
            "SELECT COALESCE(MAX(item_id), 0) + 1 FROM planner_items WHERE collection = 'exploitation'"
        ).fetchone()[0]
        db.execute(
            "INSERT INTO planner_items (collection, item_id, payload) VALUES ('exploitation', %s, %s)",
            (next_id, Jsonb(ExploitationDTO.parse(reading))),
        )

    def save_duty_readings(self, body):
        _exact_fields(body, {'vehicleId', 'date', 'startKm', 'startHours', 'endKm', 'endHours'})
        vehicle_id = body['vehicleId']
        if type(vehicle_id) is not int or not 1 <= vehicle_id <= MAX_DATABASE_ID:
            raise ValidationError('Некорректный идентификатор машины')
        _iso_date(body['date'], 'date')
        _nonnegative_int(body['startKm'], 'km')
        start_hours, end_hours = body['startHours'], body['endHours']
        end_km = body['endKm']
        for value in (start_hours, end_hours):
            if value is not None:
                _nonnegative_number(value, 'engineHours')
        if end_km is not None:
            _nonnegative_int(end_km, 'km')
        if end_km is None and end_hours is None:
            raise ValidationError('Введите конечные показания')
        with self.connect() as db:
            self._lock_journal(db)
            row = db.execute(
                "SELECT payload FROM planner_items WHERE collection = 'vehicles' AND item_id = %s FOR UPDATE",
                (vehicle_id,),
            ).fetchone()
            if row is None:
                raise ValidationError('Машина не найдена в перечне ВВСТ')
            vehicle = row[0]
            start_km = vehicle['currentMileage']
            if body['startKm'] != start_km or start_hours != _passport_current_hours(vehicle):
                raise ConflictError('Показания изменились. Проверьте новые начальные значения.')
            if end_hours is not None and start_hours is None:
                raise ValidationError('Сначала внесите начальные моточасы в Перечне ВВСТ')
            if end_km is not None and end_km < start_km or (
                end_hours is not None and start_hours is not None and end_hours < start_hours
            ):
                raise ValidationError('Конечные показания не могут быть меньше начальных')
            self._write_vehicle_readings(db, vehicle, end_km, end_hours)
            km = end_km - start_km if end_km is not None else None
            hours = float(Decimal(str(end_hours)) - Decimal(str(start_hours))) if end_hours is not None else None
            if km is not None or hours is not None:
                self._append_exploitation(db, {
                    'vehicleId': vehicle_id, 'date': body['date'],
                    'km': km if km is not None else 0, 'engineHours': hours,
                })

    def _journal_exploitation_entry(self, entry, vehicles):
        if not entry.get('arrivalDate') or not entry.get('arrivalTime'):
            return None

        def difference(start, end):
            first, last = entry.get(start), entry.get(end)
            if first is None or last is None or last < first:
                return None
            return last - first

        km = difference('departureOdometer', 'arrivalOdometer')
        hours = difference('departureEngineHours', 'arrivalEngineHours')
        if km is None and hours is None:
            return None

        vehicle = self._journal_vehicle(entry, vehicles)
        if vehicle is None:
            return None
        return ExploitationDTO.parse({
            'vehicleId': vehicle['id'],
            'date': entry['arrivalDate'],
            'km': km if km is not None else 0,
            'engineHours': hours,
            'journalEntryId': entry['id'],
        })

    def _sync_journal_exploitation(self, db, entry, previous=None):
        rows = db.execute("SELECT payload FROM planner_items WHERE collection = 'vehicles' ORDER BY item_id FOR UPDATE").fetchall()
        vehicles = [payload for (payload,) in rows]
        vehicle = self._journal_vehicle(entry, vehicles)
        same_vehicle = previous is not None and all(
            _document_key(entry[key]) == _document_key(previous[key]) for key in ('regNumber', 'brand')
        )
        if vehicle is not None and entry.get('arrivalDate') and entry.get('arrivalTime'):
            km, hours = entry.get('arrivalOdometer'), entry.get('arrivalEngineHours')
            current_km, current_hours = vehicle['currentMileage'], _passport_current_hours(vehicle)
            if km is not None and km < current_km and not (
                same_vehicle and current_km == previous.get('arrivalOdometer')
            ):
                km = None
            if hours is not None and current_hours is not None and hours < current_hours and not (
                same_vehicle and current_hours == previous.get('arrivalEngineHours')
            ):
                hours = None
            if km is not None or hours is not None:
                self._write_vehicle_readings(db, vehicle, km, hours)

        reading = self._journal_exploitation_entry(entry, vehicles)
        db.execute(
            "DELETE FROM planner_items WHERE collection = 'exploitation' AND payload->'journalEntryId' = to_jsonb(%s::bigint)",
            (entry['id'],),
        )
        if reading is not None:
            self._append_exploitation(db, reading)

    def replace_mileage_state(self, raw: 'Any') -> 'dict[str, list[dict[str, Any]]]':
        _exact_fields(raw, {'journal', 'vehicles', 'exploitation'})
        definitions = {'vehicles': (VehicleDTO, 'id'), 'journal': (JournalEntryDTO, 'id'), 'exploitation': (ExploitationDTO, None)}
        parsed = {}
        for collection, (dto, key) in definitions.items():
            values = raw[collection]
            if not isinstance(values, list):
                raise ValidationError('Раздел данных должен быть массивом')
            items = [dto.parse(value) for value in values]
            if key is not None:
                ids = [item[key] for item in items]
                if len(ids) != len(set(ids)):
                    raise ValidationError('Идентификаторы в разделе данных должны быть уникальными')
            parsed[collection] = items
        with self.connect() as db:
            self._lock_journal(db)
            self._validate_journal_replacement(db, parsed['journal'])
            readings = {
                entry['id']: reading for entry in parsed['journal']
                if (reading := self._journal_exploitation_entry(entry, parsed['vehicles'])) is not None
            }
            parsed['exploitation'] = [
                item for item in parsed['exploitation'] if item.get('journalEntryId') not in readings
            ] + list(readings.values())
            _audit_registry_replacement(db, parsed['vehicles'])
            for collection, items in parsed.items():
                db.execute('DELETE FROM planner_items WHERE collection = %s', (collection,))
                key = definitions[collection][1]
                if key is None:
                    rows = [(collection, index, Jsonb(item)) for index, item in enumerate(items, start=1)]
                else:
                    rows = [(collection, item[key], Jsonb(item)) for item in items]
                db.cursor().executemany('\n                    INSERT INTO planner_items (collection, item_id, payload)\n                    VALUES (%s, %s, %s)\n                    ', rows)
        return parsed

    def list_items(self, collection: 'str') -> 'list[dict[str, Any]]':
        with self.connect() as db:
            rows = db.execute('SELECT payload FROM planner_items WHERE collection = %s ORDER BY item_id', (collection,)).fetchall()
        return [_vehicle_with_current_hours(row[0]) if collection == 'vehicles' else row[0] for row in rows]

    def delete_published_order(self, order_id):
        with self.connect() as db:
            db.execute('SELECT pg_advisory_xact_lock(%s, %s)', (1297108050, 2))
            result = db.execute(
                "DELETE FROM planner_items WHERE collection = 'orders' AND item_id = %s",
                (order_id,),
            )
            return result.rowcount == 1

    def publish_order_draft(self, body):
        _exact_fields(body, {'id'})
        draft_id = body['id']
        if type(draft_id) is not int or not 1 <= draft_id <= MAX_DATABASE_ID:
            raise ValidationError('Некорректный идентификатор черновика')
        with self.connect() as db:
            db.execute('SELECT pg_advisory_xact_lock(%s, %s)', (1297108050, 2))
            row = db.execute(
                "SELECT payload FROM planner_items WHERE collection = 'order_drafts' AND item_id = %s FOR UPDATE",
                (draft_id,),
            ).fetchone()
            published = db.execute(
                "SELECT payload FROM planner_items WHERE collection = 'orders' AND item_id = %s",
                (draft_id,),
            ).fetchone()
            if row is None:
                if published is not None:
                    return published[0]
                raise ConflictError('Черновик уже удалён')
            if published is not None:
                raise ConflictError('Наряд с таким идентификатором уже существует')
            draft = row[0]
            if not draft['lines']:
                raise ValidationError('В черновике нет строк')
            number = db.execute(
                "SELECT COALESCE(MAX((payload->>'orderNumber')::bigint), 0) + 1 "
                "FROM planner_items WHERE collection = 'orders'"
            ).fetchone()[0]
            order = PublishedOrderDTO.parse({**draft, 'orderNumber': number})
            db.execute(
                "INSERT INTO planner_items (collection, item_id, payload) VALUES ('orders', %s, %s)",
                (draft_id, Jsonb(order)),
            )
            db.execute(
                "DELETE FROM planner_items WHERE collection = 'order_drafts' AND item_id = %s",
                (draft_id,),
            )
        return order

    def replace_items(self, collection: 'str', values: 'Any', dto: 'type') -> 'list[dict[str, Any]]':
        if not isinstance(values, list):
            raise ValidationError('Тело запроса должно быть массивом')
        parsed = [dto.parse(value) for value in values]
        if dto is ExploitationDTO:
            with self.connect() as db:
                self._lock_journal(db)
                db.execute('DELETE FROM planner_items WHERE collection = %s', (collection,))
                db.cursor().executemany('INSERT INTO planner_items (collection, item_id, payload) VALUES (%s, %s, %s)', [(collection, index, Jsonb(item)) for index, item in enumerate(parsed, start=1)])
            return parsed
        key = 'vehicleId' if dto is VehicleDetailsDTO else 'id'
        ids = [item[key] for item in parsed]
        if len(ids) != len(set(ids)):
            raise ValidationError('Идентификаторы должны быть уникальными')
        with self.connect() as db:
            if collection == 'vehicles':
                self._lock_journal(db)
                _audit_registry_replacement(db, parsed)
            if collection == 'journal':
                self._lock_journal(db)
                self._validate_journal_replacement(db, parsed)
            db.execute('DELETE FROM planner_items WHERE collection = %s', (collection,))
            db.cursor().executemany('INSERT INTO planner_items (collection, item_id, payload) VALUES (%s, %s, %s)', [(collection, item[key], Jsonb(item)) for item in parsed])
        return parsed

    @staticmethod
    def _lock_journal(db: 'psycopg.Connection') -> 'None':
        # Serialize journal actions and bulk replacements until the transaction ends.
        db.execute('SELECT pg_advisory_xact_lock(%s, %s)', (1297108050, 1))

    @staticmethod
    def _validate_journal_replacement(db: 'psycopg.Connection', parsed: 'list[dict[str, Any]]') -> 'None':
        rows = db.execute("SELECT item_id, payload FROM planner_items WHERE collection = 'journal'").fetchall()
        existing = {item_id: payload for item_id, payload in rows}
        incoming_ids = set()
        for item in parsed:
            incoming_ids.add(item['id'])
            old = existing.get(item['id'])
            _validate_journal_arrival(item, old)
            if old is None:
                if item.get('closedAt') is not None:
                    raise ValidationError('Нельзя создать уже закрытую запись журнала через общий PUT')
                continue
            if _journal_closed(old):
                if item != old:
                    raise ConflictError('Закрытую запись журнала можно изменить только действием с паролем')
            elif item.get('closedAt') is not None:
                raise ValidationError('Нельзя закрыть запись журнала через общий PUT')
        for item_id, payload in existing.items():
            if item_id not in incoming_ids and _journal_closed(payload):
                raise ConflictError('Закрытую запись журнала можно удалить только действием с паролем')

    @staticmethod
    def _journal_row(db: 'psycopg.Connection', item_id: 'int', for_update: 'bool'=False) -> 'dict[str, Any] | None':
        suffix = ' FOR UPDATE' if for_update else ''
        row = db.execute(f"SELECT payload FROM planner_items WHERE collection = 'journal' AND item_id = %s{suffix}", (item_id,)).fetchone()
        return row[0] if row is not None else None

    @staticmethod
    def _journal_password_matches(db: 'psycopg.Connection', password: 'str | None') -> 'bool':
        if not password:
            return False
        try:
            password_bytes = password.encode('utf-8')
        except UnicodeEncodeError:
            return False
        row = db.execute(
            """
            SELECT password_salt, password_hash
            FROM planner_access_credentials
            WHERE scope IN ('general', 'orders')
            ORDER BY CASE WHEN scope = 'general' THEN 0 ELSE 1 END
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            return False
        candidate = hashlib.pbkdf2_hmac('sha256', password_bytes, bytes(row[0]), ACCESS_PASSWORD_HASH_ITERATIONS)
        return hmac.compare_digest(candidate, bytes(row[1]))

    def journal_save_signature(self, body):
        _exact_fields(body, {'date', 'name'})
        _iso_date(body['date'], 'date')
        _string(body['name'], 'name')
        name = body['name'].strip()
        if not name or len(name) > 250:
            raise ValidationError('Укажите фамилию и инициалы дежурного')
        with self.connect() as db:
            self._lock_journal(db)
            result = db.execute("""
                UPDATE planner_items
                SET payload = jsonb_set(payload, '{dutySignature}', to_jsonb(%s::text))
                WHERE collection = 'journal'
                  AND COALESCE(NULLIF(payload->>'arrivalDate', ''), payload->>'date') = %s
                  AND COALESCE(payload->>'dutySignature', '') !~ '[^[:space:]]'
                  AND (NULLIF(payload->>'closedAt', '') IS NOT NULL OR payload->'closed' = 'true'::jsonb)
            """, (name, body['date']))
            return {'updated': result.rowcount}

    def journal_month_report(self, body, archive=False):
        _exact_fields(body, {'month', 'snapshot', 'password'} if archive else {'month', 'password'})
        month = body['month']
        if not isinstance(month, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}', month):
            raise ValidationError('Некорректный месяц отчёта')
        _iso_date(month + '-01', 'date')
        with self.connect() as db:
            self._lock_journal(db)
            password = body['password']
            _string(password, 'password')
            if len(password) > ACCESS_PASSWORD_MAX_LENGTH or not self._journal_password_matches(db, password):
                raise JournalPermissionError('Неверный пароль журнала')
            if archive:
                _string(body['snapshot'], 'snapshot')
            items = db.execute("""
                SELECT item_id, payload FROM planner_items
                WHERE collection = 'journal'
                ORDER BY payload->>'date', item_id
            """).fetchall()
            rows = []
            removable = []
            for item_id, entry in items:
                if not (entry.get('dutySignature') or '').strip():
                    continue
                departure = (entry.get('date') or '')[:7]
                arrival = (entry.get('arrivalDate') or '')[:7]
                returned = _journal_closed(entry) or entry.get('closed') is True
                if not returned or (arrival or departure) > month or month not in (departure, arrival):
                    continue
                rows.append((item_id, entry))
                removable.append(item_id)
            snapshot = hashlib.sha256(json.dumps(rows, sort_keys=True).encode('utf-8')).hexdigest()
            if archive:
                if snapshot != body['snapshot']:
                    raise ConflictError('Журнал изменился. Сформируйте PDF заново перед удалением.')
                if removable:
                    db.execute("DELETE FROM planner_items WHERE collection = 'journal' AND item_id = ANY(%s)",
                               (removable,))
                return {'deleted': len(removable)}
            return {'snapshot': snapshot, 'items': [entry for _, entry in rows],
                    'removable': len(removable)}

    def journal_create(self, fields: 'Any') -> 'dict[str, Any]':
        _exact_fields(fields, set(), _JOURNAL_DEPARTURE_FIELDS)
        with self.connect() as db:
            self._lock_journal(db)
            # Archived journal rows may still be referenced by exploitation records.
            next_id = db.execute("""
                SELECT GREATEST(
                    (SELECT COALESCE(MAX(item_id), 0) FROM planner_items WHERE collection = 'journal'),
                    (SELECT COALESCE(MAX((payload->>'journalEntryId')::bigint), 0)
                     FROM planner_items WHERE collection = 'exploitation')
                ) + 1
            """).fetchone()[0]
            payload = {**_JOURNAL_DEFAULT_ENTRY, **fields, 'id': next_id, 'closedAt': None, 'dutySignature': ''}
            parsed = JournalEntryDTO.parse(payload)
            if not parsed['regNumber'].strip():
                raise ValidationError('Регистрационный знак обязателен')
            db.execute("INSERT INTO planner_items (collection, item_id, payload) VALUES ('journal', %s, %s)", (next_id, Jsonb(parsed)))
        return parsed

    def journal_return(self, item_id: 'int', fields: 'Any') -> 'dict[str, Any]':
        _exact_fields(fields, set(), _JOURNAL_ARRIVAL_FIELDS)
        with self.connect() as db:
            self._lock_journal(db)
            payload = self._journal_row(db, item_id, for_update=True)
            if payload is None:
                raise JournalNotFoundError('Запись журнала не найдена')
            if _journal_closed(payload):
                raise ConflictError('Запись журнала уже закрыта')
            updated = {**payload, **fields, 'closedAt': datetime.now(timezone.utc).isoformat()}
            if (payload.get('dutySignature') or '').strip():
                updated['dutySignature'] = payload['dutySignature']
            if not updated.get('arrivalDate') or not updated.get('arrivalTime'):
                raise ValidationError('Заполните дату и время прибытия')
            parsed = JournalEntryDTO.parse(updated)
            _validate_journal_arrival(parsed)
            db.execute("UPDATE planner_items SET payload = %s WHERE collection = 'journal' AND item_id = %s", (Jsonb(parsed), item_id))
            self._sync_journal_exploitation(db, parsed)
        return parsed

    def journal_edit(self, item_id: 'int', fields: 'Any', password: 'str | None'=None) -> 'dict[str, Any]':
        _exact_fields(fields, set(), _JOURNAL_DEPARTURE_FIELDS | _JOURNAL_ARRIVAL_FIELDS)
        with self.connect() as db:
            self._lock_journal(db)
            payload = self._journal_row(db, item_id, for_update=True)
            if payload is None:
                raise JournalNotFoundError('Запись журнала не найдена')
            closed = _journal_closed(payload)
            if closed:
                if not self._journal_password_matches(db, password):
                    raise JournalPermissionError('Для изменения закрытой записи журнала нужен верный пароль')
            elif fields.keys() & _JOURNAL_ARRIVAL_ONLY_FIELDS:
                raise ValidationError('Поля прибытия можно изменить только при закрытии записи')
            updated = {**payload, **fields}
            updated['dutySignature'] = payload.get('dutySignature', '') if closed else ''
            parsed = JournalEntryDTO.parse(updated)
            _validate_journal_arrival(parsed, payload)
            db.execute("UPDATE planner_items SET payload = %s WHERE collection = 'journal' AND item_id = %s", (Jsonb(parsed), item_id))
            if closed:
                self._sync_journal_exploitation(db, parsed, payload)
        return parsed

    def journal_delete(self, item_id: 'int', password: 'str | None'=None) -> 'bool':
        with self.connect() as db:
            self._lock_journal(db)
            payload = self._journal_row(db, item_id, for_update=True)
            if payload is None:
                raise JournalNotFoundError('Запись журнала не найдена')
            if _journal_closed(payload) and not self._journal_password_matches(db, password):
                raise JournalPermissionError('Для удаления закрытой записи журнала нужен верный пароль')
            db.execute("DELETE FROM planner_items WHERE collection = 'journal' AND item_id = %s", (item_id,))
            db.execute(
                "DELETE FROM planner_items WHERE collection = 'exploitation' AND payload->'journalEntryId' = to_jsonb(%s::bigint)",
                (item_id,),
            )
        return True

    def list_standing_ids(self) -> 'list[int]':
        with self.connect() as db:
            rows = db.execute('SELECT payload FROM planner_items WHERE collection = %s ORDER BY item_id', ('standing_vehicles',)).fetchall()
        return [row[0] for row in rows]

    def replace_standing_ids(self, values: 'Any') -> 'list[int]':
        if isinstance(values, list):
            if any((type(value) is not int or value < 1 for value in values)):
                raise ValidationError('Идентификаторы стоящих машин должны быть положительными целыми числами')
        if len(values) != len(set(values)):
            raise ValidationError('Идентификаторы стоящих машин должны быть уникальными')
        with self.connect() as db:
            db.execute('DELETE FROM planner_items WHERE collection = %s', ('standing_vehicles',))
            db.cursor().executemany('INSERT INTO planner_items (collection, item_id, payload) VALUES (%s, %s, %s)', [('standing_vehicles', position, Jsonb(vehicle_id)) for position, vehicle_id in enumerate(values, start=1)])
        return values

    def update_vehicle_id(self, old_id: 'int', new_id: 'int') -> 'bool':
        with self.connect() as db:
            self._lock_journal(db)
            row = db.execute('SELECT payload FROM planner_items WHERE collection = %s AND item_id = %s FOR UPDATE', ('vehicles', old_id)).fetchone()
            if row is None:
                return False
            if old_id == new_id:
                return True
            duplicate = db.execute('SELECT 1 FROM planner_items WHERE collection = %s AND item_id = %s', ('vehicles', new_id)).fetchone()
            if duplicate is not None:
                raise ConflictError('Такой идентификатор машины уже существует')
            archived = db.execute("SELECT 1 FROM planner_items WHERE collection IN (%s, %s) AND payload->>'vehicleId' = %s LIMIT 1", ('exploitation', 'vehicle_details', str(new_id))).fetchone()
            if archived is not None:
                raise ConflictError('Такой идентификатор машины закреплен за сохраненной историей')
            vehicle = {**row[0], 'id': new_id}
            db.execute('UPDATE planner_items SET item_id = %s, payload = %s WHERE collection = %s AND item_id = %s', (new_id, Jsonb(vehicle), 'vehicles', old_id))
            _record_registry_changes(db, {new_id: row[0]}, {new_id: vehicle})
            for collection in ('unavailable', 'exploitation'):
                db.execute("UPDATE planner_items SET payload = jsonb_set(payload, '{vehicleId}', to_jsonb(%s::bigint), false) WHERE collection = %s AND payload->>'vehicleId' = %s", (new_id, collection, str(old_id)))
            db.execute("UPDATE planner_items SET item_id = %s, payload = jsonb_set(payload, '{vehicleId}', to_jsonb(%s::bigint), false) WHERE collection = %s AND item_id = %s", (new_id, new_id, 'vehicle_details', old_id))
            db.execute('UPDATE planner_items SET payload = %s WHERE collection = %s AND payload = %s', (Jsonb(new_id), 'standing_vehicles', Jsonb(old_id)))
        return True

    def delete_vehicle(self, vehicle_id: 'int') -> 'bool':
        return self.delete_vehicles([vehicle_id])

    def delete_vehicles(self, vehicle_ids: 'list[int]') -> 'bool':
        if vehicle_ids:
            if any((type(vehicle_id) is not int or vehicle_id < 1 or vehicle_id > MAX_DATABASE_ID for vehicle_id in vehicle_ids)) or len(set(vehicle_ids)) != len(vehicle_ids):
                raise ValidationError('Идентификаторы машин должны быть уникальными положительными целыми числами')
        with self.connect() as db:
            self._lock_journal(db)
            rows = db.execute('SELECT item_id, payload FROM planner_items WHERE collection = %s AND item_id = ANY(%s) ORDER BY item_id FOR UPDATE', ('vehicles', vehicle_ids)).fetchall()
            if len(rows) != len(vehicle_ids):
                return False
            _record_registry_changes(db, dict(rows), {})
            db.execute('DELETE FROM planner_items WHERE collection = %s AND item_id = ANY(%s)', ('vehicles', vehicle_ids))
            db.execute("DELETE FROM planner_items WHERE collection = %s AND payload->>'vehicleId' = ANY(%s)", ('unavailable', [str(vehicle_id) for vehicle_id in vehicle_ids]))
            for vehicle_id in vehicle_ids:
                db.execute('DELETE FROM planner_items WHERE collection = %s AND payload = %s', ('standing_vehicles', Jsonb(vehicle_id)))
                details = db.execute('SELECT payload FROM planner_items WHERE collection = %s AND item_id = %s FOR UPDATE', ('vehicle_details', vehicle_id)).fetchone()
                if details is not None:
                    preserved = {**details[0], 'certificate': None, 'batteries': [], 'tires': [], 'maintenance': []}
                    db.execute('UPDATE planner_items SET payload = %s WHERE collection = %s AND item_id = %s', (Jsonb(preserved), 'vehicle_details', vehicle_id))
        return True


