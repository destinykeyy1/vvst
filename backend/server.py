'''Loopback-only HTTP API backed by PostgreSQL.'''

from __future__ import annotations
import json
import hashlib
import hmac
import math
import mimetypes
import os
import re
import secrets
import threading
import time
import webbrowser
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import (unquote, urlparse, urlsplit)
from zipfile import BadZipFile, ZipFile

import psycopg
from psycopg.types.json import Jsonb
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

class ValidationError(ValueError):
    '''Request payload is not a valid frontend DTO.'''

class ConflictError(ValueError):
    '''Request conflicts with an existing or archived vehicle id.'''

class JournalNotFoundError(LookupError):
    '''Journal entry does not exist.'''

class JournalPermissionError(PermissionError):
    '''Journal entry is closed and the supplied password is missing or wrong.'''

RUSSIAN_FIELD_NAMES = {'closedAt': 'Дата и время закрытия записи', 'vehicleId': 'Идентификатор машины', 'vehicle id': 'Идентификатор машины', 'id': 'Идентификатор', 'brand': 'Марка', 'regNumber': 'Государственный номер', 'usageType': 'Назначение', 'driver': 'Водитель', 'location': 'Место дислокации', 'mileageAtDec1': 'Пробег на 1 декабря', 'currentMileage': 'Текущий пробег', 'yearlyNorm': 'Годовая норма', 'maintenanceInfo': 'Сведения о техническом обслуживании', 'batteryStatus': 'Состояние АКБ', 'tireStatus': 'Состояние шин', 'hasCertificate': 'Наличие паспорта', 'hasHistory': 'Наличие истории', 'passportData': 'Паспортные данные', 'date': 'Дата', 'startDate': 'Дата начала', 'endDate': 'Дата окончания', 'reason': 'Причина', 'customReason': 'Другая причина', 'notes': 'Примечания', 'orderId': 'Номер наряда', 'orderNumber': 'Номер наряда', 'lines': 'Строки наряда', 'scheduleRowId': 'Строка расписания', 'scheduleDates': 'Даты расписания', 'requiredQuantity': 'Требуемое количество', 'startTime': 'Время отправления', 'endTime': 'Время прибытия', 'km': 'Километраж', 'journalEntryId': 'Номер записи журнала', 'departureTime': 'Время отправления', 'arrivalTime': 'Время прибытия', 'arrivalDate': 'Дата прибытия', 'departureEngineHours': 'Показания счетчика моточасов при выезде', 'arrivalEngineHours': 'Показания счетчика моточасов при возвращении', 'engineHours': 'Наработка, моточасы', 'name': 'Название', 'password': 'Пароль', 'ids': 'Идентификаторы', 'certificate.type': 'Тип паспорта', 'certificate.regNumber': 'Государственный номер', 'certificate.brandModel': 'Марка и модель', 'certificate.issueDate': 'Дата выдачи паспорта', 'certificate.issuedBy': 'Кем выдан паспорт', 'certificate.vehicleType': 'Тип машины', 'certificate.yearOfManufacture': 'Год выпуска', 'certificate.vin': 'VIN', 'certificate.factoryNumber': 'Заводской номер', 'certificate.bodyNumber': 'Номер кузова', 'certificate.chassisNumber': 'Номер шасси', 'certificate.engineNumber': 'Номер двигателя', 'certificate.transmissionNumber': 'Номер трансмиссии', 'certificate.color': 'Цвет', 'certificate.enginePower': 'Мощность двигателя', 'certificate.engineDisplacement': 'Рабочий объем двигателя', 'certificate.maxMass': 'Максимальная масса', 'certificate.unladenMass': 'Масса без нагрузки', 'certificate.serialNumber': 'Серийный номер', 'certificate.usageGroup': 'Группа эксплуатации', 'certificate.subdivision': 'Подразделение', 'certificate.hullNumber': 'Номер корпуса', 'certificate.turretNumber': 'Номер башни', 'certificate.engineBrand': 'Марка двигателя', 'formula reference header': 'Заголовок ссылки формулы', 'formula reference registration': 'Регистрационный номер ссылки формулы', 'calculation expression': 'Выражение расчета'}

def _russian_field(field: 'str') -> 'str':
    if field in RUSSIAN_FIELD_NAMES:
        return RUSSIAN_FIELD_NAMES[field]
    for prefix, russian_prefix in (('certificate.', 'Сведения о паспорте.'), ('certificate.individualCardFields.', 'Поле индивидуальной карточки №'), ('line.', 'Строка наряда.'), ('tire.', 'Шины.'), ('battery.', 'АКБ.'), ('weapon.', 'Вооружение.'), ('maintenance.', 'Техническое обслуживание.'), ('history.', 'История.'), ('extraField.', 'Дополнительное поле.'), ('passportData.', 'Паспортные данные.')):
        if field.startswith(prefix):
            suffix = field[len(prefix):]
            return f'{russian_prefix}{suffix}'
    return RUSSIAN_FIELD_NAMES.get(field, field)

def _validate_passport_calculation(raw: 'Any') -> 'None':
    def reference(value: 'Any') -> 'None':
        if not isinstance(value, dict):
            raise ValidationError('Ссылка формулы должна быть объектом')
        if 'value' in value:
            _exact_fields(value, {'value'})
            number = value['value']
            if type(number) not in {int, float} or not math.isfinite(number):
                raise ValidationError('Константа формулы должна быть конечным числом')
            return
        _exact_fields(value, {'header'}, optional={'semanticColumn', 'regNumber'})
        _string(value['header'], 'formula reference header')
        if not value['header'].strip():
            raise ValidationError('Заголовок ссылки формулы не может быть пустым')
        if 'semanticColumn' in value and (type(value['semanticColumn']) is not int or not 1 <= value['semanticColumn'] <= 512):
            raise ValidationError('Недопустимый столбец семантической формулы')
        if 'regNumber' in value:
            _string(value['regNumber'], 'formula reference registration')

    if not isinstance(raw, dict):
        raise ValidationError('Расчет должен быть объектом')
    if raw.get('kind') == 'age':
        _exact_fields(raw, {'kind', 'start'})
        reference(raw['start'])
        return
    if raw.get('kind') == 'arithmetic':
        _exact_fields(raw, {'kind', 'expression', 'references'})
        _string(raw['expression'], 'calculation expression')
        if not 0 < len(raw['expression']) <= 2048:
            raise ValidationError('Выражение расчета слишком длинное')
        references = raw['references']
        if not isinstance(references, dict) or len(references) > 64:
            raise ValidationError('Недопустимые ссылки формулы')
        for name, value in references.items():
            if not (name.startswith('r') and name[1:].isdigit()):
                raise ValidationError('Недопустимое имя ссылки формулы')
            reference(value)
        return
    raise ValidationError('Неподдерживаемый тип расчета')

@dataclass(frozen=True)
class VehicleDTO:
    id: 'int'
    brand: 'str'
    regNumber: 'str'
    usageType: 'str'
    driver: 'str'
    location: 'str'
    mileageAtDec1: 'int'
    currentMileage: 'int'
    yearlyNorm: 'int'
    maintenanceInfo: 'dict[str, str]'
    batteryStatus: 'str'
    tireStatus: 'str'
    hasCertificate: 'bool'
    hasHistory: 'bool'
    passportData: 'list[dict[str, Any]] | None' = None
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        fields = {'id', 'brand', 'driver', 'location', 'regNumber', 'usageType', 'hasHistory', 'tireStatus', 'yearlyNorm', 'passportData', 'batteryStatus', 'mileageAtDec1', 'currentMileage', 'hasCertificate', 'maintenanceInfo'}
        _exact_fields(raw, fields - {'passportData'}, optional={'passportData'})
        if type(raw['id']) is not int or raw['id'] < 1:
            raise ValidationError('Идентификатор транспортного средства должен быть положительным целым числом')
        for field in ('brand', 'regNumber', 'usageType', 'driver', 'location'):
            _string(raw[field], field)
        for field in ('mileageAtDec1', 'currentMileage', 'yearlyNorm'):
            _nonnegative_int(raw[field], field)
        _exact_fields(raw['maintenanceInfo'], {'text', 'status'})
        _string(raw['maintenanceInfo']['text'], 'maintenanceInfo.text')
        _choice(raw['maintenanceInfo']['status'], {'ok', 'warn', 'danger'}, 'maintenanceInfo.status')
        _choice(raw['batteryStatus'], {'ok', 'none', 'warn', 'danger'}, 'batteryStatus')
        _choice(raw['tireStatus'], {'ok', 'none', 'warn', 'danger'}, 'tireStatus')
        for field in ('hasCertificate', 'hasHistory'):
            if type(raw[field]) is bool:
                continue
            raise ValidationError(f'{_russian_field(field)} должно быть логическим значением')
        if 'passportData' in raw:
            data = raw['passportData']
            if not isinstance(data, list) or len(data) > MAX_PASSPORT_FIELDS:
                raise ValidationError(f'passportData должен содержать не более {MAX_PASSPORT_FIELDS} полей')
            seen_columns = set()
            for item in data:
                _exact_fields(item, {'value', 'column', 'header'}, optional={'ordinal', 'calculation'})
                if item.get('calculation') is not None:
                    _validate_passport_calculation(item['calculation'])
                if type(item['column']) is not int or item['column'] < 1:
                    raise ValidationError('Столбец passportData должен быть положительным целым числом')
                if 'ordinal' in item:
                    if type(item['ordinal']) is int:
                        if not 1 <= item['ordinal'] <= MAX_NUMBERED_PASSPORT_FIELDS:
                            raise ValidationError(f'Порядковый номер passportData должен быть от 1 до {MAX_NUMBERED_PASSPORT_FIELDS}')
                if item['column'] in seen_columns:
                    raise ValidationError('Столбцы passportData должны быть уникальными')
                seen_columns.add(item['column'])
                _string(item['header'], 'passportData.header')
                if not item['header'].strip():
                    raise ValidationError('passportData.header не может быть пустым')
                value = item['value']
                if value is not None and not isinstance(value, (str, int, float, bool)):
                    raise ValidationError('passportData.value должно быть простым значением или null')
                if not isinstance(value, float):
                    continue
                if math.isfinite(value):
                    continue
                raise ValidationError('passportData.value должно быть конечным числом')
        return raw


@dataclass(frozen=True)
class UnavailableDTO:
    id: 'int'
    vehicleId: 'int'
    startDate: 'str'
    endDate: 'str'
    reason: 'str'
    customReason: 'str | None' = None
    notes: 'str | None' = None
    orderId: 'int | None' = None
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        fields = {'id', 'notes', 'reason', 'endDate', 'orderId', 'startDate', 'vehicleId', 'customReason'}
        _exact_fields(raw, fields - {'notes', 'orderId', 'customReason'}, optional={'notes', 'orderId', 'customReason'})
        for field in ('id', 'vehicleId'):
            if type(raw[field]) is int:
                if not raw[field] < 1:
                    continue
            raise ValidationError(f'{_russian_field(field)} должен быть положительным целым числом')
        for field in ('startDate', 'endDate'):
            _string(raw[field], field)
            try:
                date.fromisoformat(raw[field])
            except ValueError as exc:
                raise ValidationError(f'{_russian_field(field)} должна быть датой в формате ISO') from exc
        if raw['startDate'] > raw['endDate']:
            raise ValidationError('startDate не может быть позже endDate')
        _choice(raw['reason'], {'Ремонт', 'Учения', 'Командировка', 'Техническое обслуживание', 'Другое'}, 'reason')
        for field in ('customReason', 'notes'):
            if raw.get(field) is not None:
                _string(raw[field], field)
        if raw.get('orderId') is not None:
            if type(raw['orderId']) is not int or raw['orderId'] < 1:
                raise ValidationError('orderId должен быть положительным целым числом')
        return raw


@dataclass(frozen=True)
class OrderLineDTO:
    id: 'int'
    section: 'str'
    brand: 'str'
    regNumber: 'str'
    usageGroup: 'str'
    driver: 'str'
    route: 'str'
    purpose: 'str'
    departureTime: 'str'
    returnTime: 'str'
    responsible: 'str'
    note: 'str'
    date: 'str | None' = None
    scheduleRowId: 'int | None' = None
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        fields = set(cls.__dataclass_fields__)
        _exact_fields(raw, fields - {'date', 'scheduleRowId'}, {'date', 'scheduleRowId'})
        if type(raw['id']) is not int or raw['id'] < 1:
            raise ValidationError('Идентификатор строки наряда должен быть положительным целым числом')
        for field in fields - {'id'}:
            if field in ('date', 'scheduleRowId'):
                continue
            _string(raw[field], f'line.{field}')
        if 'date' in raw:
            _iso_date(raw['date'], 'line.date')
        if raw.get('scheduleRowId') is not None:
            if type(raw['scheduleRowId']) is not int or raw['scheduleRowId'] < 1:
                raise ValidationError('line.scheduleRowId должен быть положительным целым числом')
        return raw


@dataclass(frozen=True)
class OrderDraftDTO:
    id: 'int'
    date: 'str'
    lines: 'list[dict[str, Any]]'
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        _exact_fields(raw, {'id', 'date', 'lines'})
        if type(raw['id']) is not int or raw['id'] < 1:
            raise ValidationError('Идентификатор черновика должен быть положительным целым числом')
        _iso_date(raw['date'], 'date')
        if not isinstance(raw['lines'], list):
            raise ValidationError('lines должен быть массивом')
        lines = set()
        for line in raw['lines']:
            OrderLineDTO.parse(line)
            if line['id'] in lines:
                raise ValidationError('Идентификаторы строк наряда должны быть уникальными положительными целыми числами')
            lines.add(line['id'])
        return raw


@dataclass(frozen=True)
class PublishedOrderDTO:
    id: 'int'
    orderNumber: 'int'
    date: 'str'
    lines: 'list[dict[str, Any]]'
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        _exact_fields(raw, {'id', 'date', 'lines', 'orderNumber'})
        for field in ('id', 'orderNumber'):
            if type(raw[field]) is int:
                if not raw[field] < 1:
                    continue
            raise ValidationError(f'{_russian_field(field)} должен быть положительным целым числом')
        _string(raw['date'], 'date')
        try:
            date.fromisoformat(raw['date'])
        except ValueError as exc:
            raise ValidationError('date должна быть датой в формате ISO') from exc
        if not isinstance(raw['lines'], list):
            raise ValidationError('lines должен быть массивом')
        line_fields = {field for field in OrderLineDTO.__dataclass_fields__}
        lines = []
        seen_ids = set()
        for line in raw['lines']:
            OrderLineDTO.parse(line)
            if line['id'] in seen_ids:
                raise ValidationError('Идентификаторы строк наряда должны быть уникальными положительными целыми числами')
            seen_ids.add(line['id'])
            lines.append(line)
        return raw


@dataclass(frozen=True)
class ScheduleItemDTO:
    id: 'int'
    date: 'str'
    title: 'str'
    location: 'str'
    route: 'str'
    requiredBrand: 'str'
    requiredQuantity: 'int'
    startTime: 'str'
    endTime: 'str'
    instructor: 'str'
    teacher: 'str | None' = None
    scheduleRowId: 'int | None' = None
    scheduleDates: 'list[str] | None' = None
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        fields = set(cls.__dataclass_fields__)
        optional = {'teacher', 'scheduleDates', 'scheduleRowId'}
        _exact_fields(raw, fields - optional, optional=optional)
        if type(raw['id']) is not int or raw['id'] < 1:
            raise ValidationError('Идентификатор записи расписания должен быть положительным целым числом')
        _string(raw['date'], 'date')
        try:
            date.fromisoformat(raw['date'])
        except ValueError as exc:
            raise ValidationError('date должна быть датой в формате ISO') from exc
        _nonnegative_int(raw['requiredQuantity'], 'requiredQuantity')
        if 'scheduleRowId' in raw:
            if type(raw['scheduleRowId']) is not int or raw['scheduleRowId'] < 1:
                raise ValidationError('scheduleRowId должен быть положительным целым числом')
        if 'scheduleDates' in raw:
            if not isinstance(raw['scheduleDates'], list):
                raise ValidationError('scheduleDates должен быть массивом')
            for schedule_date in raw['scheduleDates']:
                _string(schedule_date, 'scheduleDate')
                try:
                    date.fromisoformat(schedule_date)
                except ValueError as exc:
                    raise ValidationError('scheduleDates должен содержать даты в формате ISO') from exc
        for field in fields - {'id', 'date', 'scheduleDates', 'scheduleRowId', 'requiredQuantity'}:
            if field not in raw:
                continue
            _string(raw[field], field)
        for field in ('startTime', 'endTime'):
            if raw[field] == '':
                continue
            if len(raw[field]) == 5 and raw[field][2] == ':':
                if raw[field].replace(':', '').isdigit():
                    continue
            raise ValidationError(f'{_russian_field(field)} должен использовать формат ЧЧ:ММ')
        return raw


@dataclass(frozen=True)
class ExploitationDTO:
    vehicleId: 'int'
    date: 'str'
    km: 'int'
    orderId: 'int | None' = None
    journalEntryId: 'int | None' = None
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        _exact_fields(raw, {'km', 'date', 'vehicleId'}, optional={'orderId', 'engineHours', 'journalEntryId'})
        for field in ('vehicleId', 'km'):
            _nonnegative_int(raw[field], field)
        if raw['vehicleId'] < 1:
            raise ValidationError('vehicleId должен быть положительным целым числом')
        _string(raw['date'], 'date')
        try:
            date.fromisoformat(raw['date'])
        except ValueError as exc:
            raise ValidationError('date должна быть датой в формате ISO') from exc
        if raw.get('orderId') is not None:
            if type(raw['orderId']) is not int or raw['orderId'] < 1:
                raise ValidationError('orderId должен быть положительным целым числом')
        if raw.get('journalEntryId') is not None:
            if type(raw['journalEntryId']) is not int or raw['journalEntryId'] < 1:
                raise ValidationError('journalEntryId должен быть положительным целым числом')
        if raw.get('engineHours') is not None:
            _nonnegative_number(raw['engineHours'], 'engineHours')
        return raw


@dataclass(frozen=True)
class JournalEntryDTO:
    id: 'int'
    date: 'str'
    subdivision: 'str'
    driver: 'str'
    waybillNumber: 'str'
    brand: 'str'
    regNumber: 'str'
    departureCondition: 'str'
    departureSeal: 'str'
    departureOdometer: 'int | None'
    departureTime: 'str'
    purpose: 'str'
    authority: 'str'
    returnDeadline: 'str'
    arrivalDate: 'str'
    arrivalTime: 'str'
    arrivalCondition: 'str'
    arrivalSeal: 'str'
    arrivalOdometer: 'int | None'
    remarks: 'str'
    dutySignature: 'str'
    departureEngineHours: 'float | None' = None
    arrivalEngineHours: 'float | None' = None
    speedometer: 'str | None' = None
    closedAt: 'str | None' = None
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        fields = set(cls.__dataclass_fields__)
        optional_fields = {'departureEngineHours', 'arrivalEngineHours', 'speedometer', 'closedAt'}
        _exact_fields(raw, fields - optional_fields, optional_fields)
        if raw.get('speedometer') is not None:
            _string(raw['speedometer'], 'speedometer')
        if raw.get('closedAt') is not None:
            _iso_datetime(raw['closedAt'], 'closedAt')
        if type(raw['id']) is not int or not 1 <= raw['id'] <= MAX_DATABASE_ID:
            raise ValidationError('Идентификатор записи журнала должен быть положительным целым числом в диапазоне BIGINT')
        _iso_date(raw['date'], 'date')
        if raw['arrivalDate']:
            _iso_date(raw['arrivalDate'], 'arrivalDate')
        else:
            _string(raw['arrivalDate'], 'arrivalDate')
        for field in fields - {'id', 'date', 'arrivalDate', 'returnDeadline', 'arrivalOdometer', 'departureOdometer', 'arrivalEngineHours', 'departureEngineHours', 'speedometer', 'closedAt'}:
            _string(raw[field], field)
        for field in ('departureOdometer', 'arrivalOdometer'):
            if raw[field] is not None:
                _nonnegative_int(raw[field], field)
        for field in {'departureEngineHours', 'arrivalEngineHours'}:
            if raw.get(field) is not None:
                _nonnegative_number(raw[field], field)
        _choice(raw['returnDeadline'], {'15:00', '18:00'}, 'returnDeadline')
        for field in ('departureTime', 'arrivalTime'):
            value = raw[field]
            if not value:
                continue
            if re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', value):
                continue
            raise ValidationError(f'{_russian_field(field)} должен использовать формат ЧЧ:ММ')
        return raw


_JOURNAL_DEPARTURE_FIELDS = {'date', 'subdivision', 'driver', 'waybillNumber', 'brand', 'regNumber', 'departureCondition', 'departureSeal', 'departureOdometer', 'departureEngineHours', 'departureTime', 'purpose', 'authority', 'returnDeadline', 'dutySignature'}
_JOURNAL_ARRIVAL_FIELDS = {'arrivalDate', 'arrivalTime', 'arrivalCondition', 'arrivalSeal', 'arrivalOdometer', 'arrivalEngineHours', 'remarks', 'dutySignature'}
_JOURNAL_ARRIVAL_ONLY_FIELDS = _JOURNAL_ARRIVAL_FIELDS - _JOURNAL_DEPARTURE_FIELDS
_JOURNAL_DEFAULT_ENTRY = {'date': '', 'subdivision': '', 'driver': '', 'waybillNumber': '', 'brand': '', 'regNumber': '', 'departureCondition': 'ТИ', 'departureSeal': 'ОПЛ', 'departureOdometer': None, 'departureTime': '', 'purpose': '', 'authority': '', 'returnDeadline': '18:00', 'arrivalDate': '', 'arrivalTime': '', 'arrivalCondition': '', 'arrivalSeal': '', 'arrivalOdometer': None, 'remarks': '', 'dutySignature': '', 'departureEngineHours': None, 'arrivalEngineHours': None, 'speedometer': None, 'closedAt': None}

_JOURNAL_READING_FIELDS = (
    'date', 'arrivalDate', 'departureTime', 'arrivalTime',
    'departureOdometer', 'arrivalOdometer', 'departureEngineHours', 'arrivalEngineHours',
)


def _validate_journal_arrival(entry, previous=None):
    if previous is not None and all(
        entry.get(field) == previous.get(field) for field in _JOURNAL_READING_FIELDS
    ):
        return

    arrival_date = entry['arrivalDate']
    if arrival_date and arrival_date < entry['date']:
        raise ValidationError('Дата прибытия не может быть раньше даты выезда')
    if (arrival_date == entry['date'] and entry['departureTime'] and entry['arrivalTime']
            and entry['arrivalTime'] < entry['departureTime']):
        raise ValidationError('Время прибытия в день выезда не может быть раньше времени выезда')
    for start, end, label in (
        ('departureOdometer', 'arrivalOdometer', 'спидометра'),
        ('departureEngineHours', 'arrivalEngineHours', 'моточасов'),
    ):
        first, last = entry.get(start), entry.get(end)
        if first is not None and last is not None and last < first:
            raise ValidationError(f'Показание {label} при прибытии не может быть меньше показания при выезде')


def _journal_closed(payload: 'dict[str, Any]') -> 'bool':
    return bool(payload.get('closedAt'))


@dataclass(frozen=True)
class JournalDutyDTO:
    id: 'int'
    date: 'str'
    name: 'str'
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        _exact_fields(raw, set(cls.__dataclass_fields__))
        if type(raw['id']) is not int or raw['id'] < 1:
            raise ValidationError('Идентификатор дежурства должен быть положительным целым числом')
        _iso_date(raw['date'], 'date')
        _string(raw['name'], 'name')
        if not raw['name'].strip():
            raise ValidationError('Название не может быть пустым')
        return raw


@dataclass(frozen=True)
class VehicleDetailsDTO:
    vehicleId: 'int'
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        _exact_fields(raw, {'tires', 'history', 'batteries', 'vehicleId', 'certificate', 'maintenance'})
        if type(raw['vehicleId']) is not int or raw['vehicleId'] < 1:
            raise ValidationError('Идентификатор машины должен быть положительным целым числом')
        certificate = raw['certificate']
        if certificate is not None:
            certificate_fields = {'vin', 'type', 'color', 'maxMass', 'weapons', 'issuedBy', 'issueDate', 'regNumber', 'bodyNumber', 'brandModel', 'hullNumber', 'usageGroup', 'engineBrand', 'enginePower', 'extraFields', 'subdivision', 'unladenMass', 'vehicleType', 'engineNumber', 'serialNumber', 'turretNumber', 'chassisNumber', 'factoryNumber', 'yearOfManufacture', 'engineDisplacement', 'transmissionNumber', 'individualCardFields'}
            required = {'type', 'weapons', 'issuedBy', 'issueDate', 'regNumber', 'brandModel', 'extraFields'}
            _exact_fields(certificate, required, certificate_fields - required)
            _choice(certificate['type'], {'AT', 'BT'}, 'certificate.type')
            for field in ('regNumber', 'brandModel', 'issuedBy'):
                _string(certificate[field], f'certificate.{field}')
            if certificate['issueDate'] != '':
                _iso_date(certificate['issueDate'], 'certificate.issueDate')
            for field in {'vin', 'color', 'bodyNumber', 'hullNumber', 'usageGroup', 'engineBrand', 'enginePower', 'subdivision', 'vehicleType', 'engineNumber', 'serialNumber', 'turretNumber', 'chassisNumber', 'factoryNumber', 'transmissionNumber'}:
                if field in certificate:
                    _string(certificate[field], f'certificate.{field}')
            for field in {'maxMass', 'unladenMass', 'yearOfManufacture', 'engineDisplacement'}:
                if field in certificate:
                    _nonnegative_int(certificate[field], f'certificate.{field}')
            _validate_detail_array(certificate['weapons'], {'id', 'type', 'model', 'number', 'quantity'}, 'certificate.weapons', (lambda item: _validate_weapon(item)))
            _validate_detail_array(certificate['extraFields'], {'id', 'name', 'value'}, 'certificate.extraFields', (lambda item: _validate_extra_field(item)))
            if 'individualCardFields' in certificate:
                card_fields = certificate['individualCardFields']
                allowed_card_keys = {str(number) for number in range(1, 42) if number != 18}
                if not isinstance(card_fields, dict) or len(card_fields) > 40:
                    raise ValidationError('Поля индивидуальной карточки должны быть объектом максимум с 40 записями')
                for key, value in card_fields.items():
                    if not isinstance(key, str) or key not in allowed_card_keys:
                        raise ValidationError('В индивидуальной карточке указано недопустимое поле')
                    _string(value, f'certificate.individualCardFields.{key}')
        _validate_detail_array(raw['history'], {'id', 'date', 'description'}, 'history', (lambda item: _validate_history(item)))
        _validate_detail_array(raw['batteries'], {'id', 'brand', 'number', 'installDate', 'serviceLifeYears'}, 'batteries', (lambda item: _validate_battery(item)))
        _validate_detail_array(raw['tires'], {'id', 'size', 'brand', 'model', 'normKm', 'season', 'quantity', 'installDate', 'serialNumbers', 'mileageAtInstall'}, 'tires', (lambda item: _validate_tire(item)))
        _validate_detail_array(raw['maintenance'], {'id', 'isActive', 'lastDate', 'typeName', 'intervalKm', 'lastMileage', 'intervalDays'}, 'maintenance', (lambda item: _validate_maintenance(item)))
        return raw


def _iso_date(value: 'Any', field: 'str', nullable: 'bool'=False) -> 'None':
    if nullable and value is None:
        return
    _string(value, field)
    try:
        date.fromisoformat(value)
        return
    except ValueError as exc:
        raise ValidationError(f'{_russian_field(field)} должна быть датой в формате ISO') from exc

def _iso_datetime(value: 'Any', field: 'str') -> 'None':
    _string(value, field)
    try:
        datetime.fromisoformat(value)
        return
    except ValueError as exc:
        raise ValidationError(f'{_russian_field(field)} должна быть датой и временем в формате ISO') from exc

def _validate_detail_array(values: 'Any', fields: 'set[str]', label: 'str', validate: 'Any') -> 'None':
    if not isinstance(values, list):
        raise ValidationError(f'{label} должен быть массивом')
    seen = set()
    for item in values:
        _exact_fields(item, fields)
        if type(item['id']) is not int or item['id'] < 1 or item['id'] in seen:
            raise ValidationError(f'Идентификаторы {label} должны быть уникальными положительными целыми числами')
        seen.add(item['id'])
        validate(item)

def _validate_weapon(item: 'dict[str, Any]') -> 'None':
    _choice(item['type'], {'Пушка', 'Пулемет', 'Радиостанция', 'Другое'}, 'weapon.type')
    _string(item['model'], 'weapon.model')
    _string(item['number'], 'weapon.number')
    if type(item['quantity']) is not int or item['quantity'] < 1:
        raise ValidationError('Количество вооружения должно быть положительным целым числом')

def _validate_extra_field(item: 'dict[str, Any]') -> 'None':
    _string(item['name'], 'extraField.name')
    _string(item['value'], 'extraField.value')

def _validate_history(item: 'dict[str, Any]') -> 'None':
    _iso_date(item['date'], 'history.date')
    _string(item['description'], 'history.description')

def _validate_battery(item: 'dict[str, Any]') -> 'None':
    _string(item['number'], 'battery.number')
    _string(item['brand'], 'battery.brand')
    _iso_date(item['installDate'], 'battery.installDate')
    if type(item['serviceLifeYears']) is not int or item['serviceLifeYears'] < 1:
        raise ValidationError('Срок службы АКБ должен быть положительным целым числом')

def _validate_tire(item: 'dict[str, Any]') -> 'None':
    for field in ('brand', 'model', 'size', 'serialNumbers'):
        _string(item[field], f'tire.{field}')
    _iso_date(item['installDate'], 'tire.installDate')
    for field in ('quantity', 'normKm'):
        if type(item[field]) is not int or item[field] < 1:
            raise ValidationError(f"{('Количество' if field == 'quantity' else 'Норма пробега')} шин должно быть положительным целым числом")
    _nonnegative_int(item['mileageAtInstall'], 'tire.mileageAtInstall')
    _choice(item['season'], {'Зима', 'Лето', 'Всесезонная'}, 'tire.season')

def _validate_maintenance(item: 'dict[str, Any]') -> 'None':
    _string(item['typeName'], 'maintenance.typeName')
    _iso_date(item['lastDate'], 'maintenance.lastDate', nullable=True)
    for field in ('lastMileage', 'intervalKm', 'intervalDays'):
        if item[field] is not None:
            _nonnegative_int(item[field], f'maintenance.{field}')
    if type(item['isActive']) is not bool:
        raise ValidationError('Признак активности технического обслуживания должен быть логическим значением')

def _exact_fields(value: 'Any', required: 'set[str]', optional: 'set[str]'=frozenset()) -> 'None':
    if not isinstance(value, dict):
        raise ValidationError('Каждый элемент должен быть объектом')
    keys = set(value)
    if not required.issubset(keys) or keys - required - optional:
        raise ValidationError('Объект содержит отсутствующие или недопустимые поля')

def _string(value: 'Any', field: 'str') -> 'None':
    if not isinstance(value, str):
        raise ValidationError(f'{_russian_field(field)} должно быть текстом')

def _nonnegative_int(value: 'Any', field: 'str') -> 'None':
    if type(value) is not int or value < 0:
        raise ValidationError(f'{_russian_field(field)} должно быть неотрицательным целым числом')

def _nonnegative_number(value: 'Any', field: 'str') -> 'None':
    if type(value) not in {int, float} or not math.isfinite(value) or value < 0:
        raise ValidationError(f'{_russian_field(field)} должно быть неотрицательным числом')

def _choice(value: 'Any', choices: 'set[str]', field: 'str') -> 'None':
    if not isinstance(value, str) or value not in choices:
        raise ValidationError(f'{_russian_field(field)} содержит недопустимое значение')

DOCUMENT_TEMPLATES = {
    'battery-change': 'battery-act-template.docx',
    'tire-change': 'tire-act-template.docx',
    'condition': 'condition-act-template.docx',
    'order': 'order-template.xlsm',
    **{f'{item}-{action}': f'{item}-{action}-act-template.docx'
       for item in ('battery', 'tire', 'tarp', 'tshl', 'tshz')
       for action in ('change', 'writeoff')
       if action == 'writeoff' or item not in ('battery', 'tire')},
}
DOCUMENT_APPROVAL_PARAGRAPHS = {
    'battery-change': 31, 'tire-change': 30, 'tarp-change': 24,
    'tshl-change': 26, 'tshz-change': 26,
}
DOCUMENT_LIMIT = 16 * 1024 * 1024
CHANGE_FIELDS = ('material', 'code', 'norm', 'actual', 'unit', 'category',
                 'quantity', 'reason', 'newCategory', 'notes')
WRITEOFF_FIELDS = ('material', 'code', 'unit', 'norm', 'quantity', 'price',
                   'amount', 'direction', 'debit', 'credit')
CONDITION_FIELDS = ('material', 'factoryNumber', 'manufacturer', 'passportNumber',
                    'code', 'norm', 'actual', 'category', 'unit', 'quantity')
ORDER_FIELDS = ('brand', 'regNumber', 'usageGroup', 'purpose', 'route',
                'responsible', 'departureTime', 'returnTime', 'note')
ORDER_SHEET = 'Лист формирования НАРЯДА'
ORDER_SECTIONS = (
    ('Дежурные силы и средства', 13, 21),
    ('Для обеспечения служебной деятельности', 23, 23),
    ('Для обеспечения плана подготовки', 25, 59),
    ('Для обеспечения хозяйственной деятельности', 61, 81),
    ('Для обеспечения иных мероприятий', 83, 85),
)


def _document_text(value):
    if value is None:
        return ''
    if type(value) not in (str, int, float) or len(str(value)) > 4000:
        raise ValidationError('Поле документа должно быть текстом или числом до 4000 знаков')
    result = str(value)
    if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]', result):
        raise ValidationError('Поле документа содержит недопустимые символы')
    return result


def _document_key(value):
    return ''.join(char for char in str(value).casefold().replace('ё', 'е')
                   if char.isalnum())


def _document_vehicle_values(vehicle, details, *, condition=False):
    certificate = details.get('certificate') or {}
    by_header = {}
    for item in vehicle.get('passportData') or []:
        key = _document_key(item['header'])
        value = item['value']
        if value is not None and value != '':
            by_header.setdefault(key, set()).add(str(value))

    def field(*names):
        for name in names:
            values = by_header.get(_document_key(name), set())
            if len(values) > 1:
                raise ValidationError(f'В перечне ВВСТ несколько значений для поля «{name}»')
            if values:
                return next(iter(values))
        return ''

    values = {
        'brand': vehicle['brand'],
        'regNumber': vehicle['regNumber'],
        'usageGroup': field('Группа эксплуатации') or certificate.get('usageGroup') or '',
        'factoryNumber': field('Заводской номер машины', 'Заводской номер', 'Заводской №', 'VIN')
                         or certificate.get('factoryNumber') or certificate.get('vin') or '',
        'vin': field('VIN', 'Идентификационный номер (VIN)') or certificate.get('vin') or '',
        'passportNumber': field('Серия и номер паспорта (формуляра)', 'Номер паспорта (формуляра)', 'Номер паспорта',
                                'Номер формуляра', 'Паспорт (формуляр)'),
        'manufacturer': field('Завод-изготовитель', 'Изготовитель'),
        'chassisNumber': field('Номер шасси', 'Шасси №') or certificate.get('chassisNumber') or '',
        'engineNumber': field('Номер двигателя', 'Двигатель №') or certificate.get('engineNumber') or '',
        'bodyNumber': field('Номер кузова', 'Номер кабины') or certificate.get('bodyNumber') or '',
        'category': field('Категория', 'Категория машины'),
        'mileage': vehicle['currentMileage'],
    }

    if condition:
        values['field'] = field
        values['passport'] = vehicle.get('passportData') or []
    return values


def _document_vehicle_label(values):
    result = [values['brand']]
    for label, field in (('в/н', 'regNumber'), ('заводской №', 'factoryNumber'),
                         ('паспорт (формуляр) №', 'passportNumber'),
                         ('шасси №', 'chassisNumber'), ('двигатель №', 'engineNumber')):
        if values[field]:
            result.append(f'{label} {values[field]}')
    return ', '.join(result)


def _document_archive(data, part):
    try:
        with ZipFile(BytesIO(data)) as archive:
            names = archive.namelist()
            if (part not in names or len(names) > 3000 or len(names) != len(set(names))
                    or sum(info.file_size for info in archive.infolist()) > 96 * 1024 * 1024):
                raise ValidationError('Документ не соответствует формату или слишком велик')
    except BadZipFile as exc:
        raise ValidationError('Ожидается документ Word или Excel по шаблону') from exc


def _document_word(data):
    from lxml import etree

    from docx import Document
    _document_archive(data, 'word/document.xml')
    try:
        return Document(BytesIO(data))
    except (ValueError, KeyError, OSError, RuntimeError, etree.XMLSyntaxError) as exc:
        raise ValidationError('Не удалось прочитать документ Word') from exc


def _document_table(doc, kind):
    condition = kind == 'condition'
    writeoff = kind.endswith('-writeoff')
    index = 1 if condition else 2
    first = 2 if condition else 4 if writeoff else 3
    signature = ('Заводской номер' if condition else
                 'Материальные запасы' if writeoff else 'Наименование материальных ценностей')
    if len(doc.tables) <= index:
        raise ValidationError('В документе отсутствует таблица по шаблону')
    table = doc.tables[index]
    if (len(table.columns) != 11 or len(table.rows) <= first or
            not any(_document_key(cell.text) == _document_key(signature)
                    for cell in table.rows[0].cells)):
        raise ValidationError('Заголовок таблицы не соответствует шаблону')
    return table, first


def _document_unique_cells(row):
    return list({cell._tc: cell for cell in row.cells}.values())


def _document_set_cells(cells, values):
    for cell, value in zip(cells, values, strict=True):
        text = _document_text(value)
        paragraph = cell.paragraphs[0]
        runs = paragraph.runs
        if runs:
            runs[0].text = text
            for run in runs[1:]:
                run.text = ''
        else:
            paragraph.add_run(text)
        for extra in cell.paragraphs[1:]:
            extra._element.getparent().remove(extra._element)


def _document_add_row(table, prototype, values):
    table._tbl.append(deepcopy(prototype._tr))
    _document_set_cells(_document_unique_cells(table.rows[-1]), values)


def _document_decimal(value, field):
    try:
        number = Decimal(_document_text(value).replace(' ', '').replace(',', '.'))
        if not number.is_finite() or number < 0 or number > 10**12:
            raise InvalidOperation
        return number
    except InvalidOperation as exc:
        raise ValidationError(f'Укажите число в поле «{field}»') from exc


def _condition_date(value):
    text = str(value or '').strip().removesuffix('г.').strip()
    for pattern in ('%Y-%m-%d', '%d.%m.%Y', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


def _condition_number(value):
    try:
        return _document_decimal(re.sub(r'\s+|км', '', str(value), flags=re.I), 'Наработка')
    except ValidationError:
        return None


def _condition_months(value):
    number = _condition_number(value)
    if number is not None and number == int(number):
        return int(number) * 12
    years = re.search(r'(\d+)\s*(?:лет|год)', str(value), re.I)
    months = re.search(r'(\d+)\s*мес', str(value), re.I)
    if years or months:
        return (int(years[1]) * 12 if years else 0) + (int(months[1]) if months else 0)
    return None


def _condition_elapsed(start, end):
    if start is None or end < start:
        return None
    return (end.year - start.year) * 12 + end.month - start.month - (end.day < start.day)


def _condition_duration(months):
    if months is None:
        return ''
    years, rest = divmod(abs(months), 12)
    if years % 100 in range(11, 15):
        year_word = 'лет'
    else:
        year_word = {1: 'год', 2: 'года', 3: 'года', 4: 'года'}.get(years % 10, 'лет')
    text = ' '.join(part for part in (f'{years} {year_word}' if years else '',
                                      f'{rest} мес.' if rest or not years else '') if part)
    return ('−' if months < 0 else '') + text


def _condition_km(value):
    if value is None:
        return ''
    return f'{value:,.0f}'.replace(',', ' ').replace('-', '−') + ' км'


def _condition_performance(data, item, act_date):
    field = data['field']
    supplied = item.get('performance', {})
    if not isinstance(supplied, dict) or set(supplied) - {str(i) for i in range(1, 15)}:
        raise ValidationError('Допустимые графы показателей: 1–14')

    commissioned = _condition_date(field('Дата ввода в эксплуатацию') or supplied.get('1'))
    elapsed = _condition_elapsed(commissioned, act_date)
    initial = _condition_number(field('Показания спидометра при вводе в эксплуатацию',
                                      'Начальные показания спидометра'))
    current = _condition_number(data['mileage'])
    baseline = {}
    for entry in data['passport']:
        match = re.search(r'(\d{2}\.\d{2}\.\d{4})', entry['header'])
        if not match:
            continue
        stamp = _condition_date(match[1])
        name = _document_key(entry['header'])
        if name.startswith('показанияспидометрана'):
            baseline.setdefault(stamp, {})['odometer'] = _condition_number(entry['value'])
        elif name.startswith('наработкамашинысначалаэксплуатациина'):
            baseline.setdefault(stamp, {})['work'] = _condition_number(entry['value'])

    worked = current - initial if current is not None and initial is not None and current >= initial else None
    if worked is None and current is not None:
        complete = [stamp for stamp, row in baseline.items() if stamp is not None and stamp <= act_date
                    and row.get('work') is not None and row.get('odometer') is not None
                    and current >= row['odometer']]
        if complete:
            row = baseline[max(complete)]
            worked = row['work'] + current - row['odometer']
    if worked is None:
        worked = _condition_number(field('Наработка машины с начала эксплуатации на текущую дату, км'))

    resource = _condition_number(field('Назначенный ресурс',
        'Скорректированная норма наработки на списание машины, км',
        'Норма наработки на списание машины, км') or supplied.get('4'))
    term = _condition_months(field('Назначенный срок эксплуатации', 'Срок эксплуатации',
                                   'Срок службы по норме') or supplied.get('5') or item.get('norm'))
    warranty_km, warranty_months = 50000, 15 * 12
    repair_date = _condition_date(field('Дата последнего ремонта', 'Дата ремонта'))
    repair_name = field('Вид последнего ремонта', 'Произведен ремонт')

    def remaining(total, used, format_value):
        return format_value(total - used) if total is not None and used is not None else ''

    repair_start = _condition_number(field('Показания спидометра при последнем ремонте'))
    return [
        commissioned.strftime('%d.%m.%Y г.') if commissioned else '',
        _condition_duration(elapsed), _condition_km(worked), _condition_km(resource),
        _condition_duration(term), _condition_km(warranty_km), '15 лет',
        ', '.join(part for part in (repair_name, repair_date.strftime('%d.%m.%Y') if repair_date else '') if part)
        or supplied.get('8', ''),
        _condition_duration(_condition_elapsed(repair_date, act_date)) or supplied.get('9', ''),
        _condition_km(current - repair_start) if current is not None and repair_start is not None
        and current >= repair_start else supplied.get('10', ''),
        remaining(resource, worked, _condition_km), remaining(term, elapsed, _condition_duration),
        remaining(warranty_km, worked, _condition_km), remaining(warranty_months, elapsed, _condition_duration),
    ]


def _document_word_export(kind, template, body, vehicles, details):
    doc = _document_word(template)
    table, first = _document_table(doc, kind)
    rows = list(table.rows[first:])
    items = body['rows']
    is_writeoff = kind.endswith('-writeoff')
    is_tarp = kind.startswith('tarp-')
    from_inventory = body.get('source') == 'inventory'
    fill_inventory = is_tarp or from_inventory
    number = _document_text(body.get('number'))
    stamp = ''
    if 'date' in body:
        _iso_date(body['date'], 'date')
        stamp = date.fromisoformat(body['date']).strftime('%d.%m.%Y')
    for paragraph in doc.paragraphs:
        if re.match(r'^\s*АКТ\s*№\s*_+', paragraph.text):
            paragraph.text = f'АКТ № {number or "________"}'
    metadata = doc.tables[0 if kind == 'condition' else 1]
    date_rows = metadata.rows[2:3] if kind == 'condition' else metadata.rows
    for row in date_rows:
        cells = _document_unique_cells(row)
        if any(_document_key(cell.text) in ('дата', 'датапоокпо') for cell in cells[:-1]):
            _document_set_cells(cells[-1:], [stamp])
            break

    if kind == 'condition':
        if len(items) != 1:
            raise ValidationError('Для акта технического состояния выберите одну машину')
        item = items[0]
        vehicle, card = _document_find_vehicle(item, vehicles, details)
        data = _document_vehicle_values(vehicle, card, condition=True)
        doc.paragraphs[11].text = _document_vehicle_label(data)
        for index, label, key in ((19, 'Комплектность', 'completeness'),
                                  (20, 'Техническое состояние', 'condition'),
                                  (21, 'Причины досрочного износа или повреждения', 'reason'),
                                  (22, 'Заключение комиссии', 'conclusion')):
            doc.paragraphs[index].text = f'{label}: {_document_text(item.get(key))}'
        act_date = date.fromisoformat(body['date']) if stamp else date.today()
        field = data['field']
        performance = _condition_performance(data, item, act_date)
        _document_set_cells(_document_unique_cells(doc.tables[2].rows[3]),
                            [value if _document_text(value).strip() else '—' for value in performance])
        entries = [{**item, 'material': data['brand'], 'factoryNumber': data['factoryNumber'],
                    'passportNumber': data['passportNumber'], 'manufacturer': data['manufacturer'],
                    'code': field('Код по КВТ МО') or item.get('code'),
                    'norm': performance[4], 'actual': performance[1],
                    'category': data['category'] or item.get('category'), 'unit': 'ед.', 'quantity': 1}]
        for label, serial, model in (
            ('Шасси', data['chassisNumber'], ''),
            ('Двигатель', data['engineNumber'], field('Марка двигателя')),
            ('Кузов / кабина', field('Кабина №', 'Кузов №') or data['bodyNumber'], ''),
        ):
            if serial or model:
                entries.append({'material': ' '.join(part for part in (label, model) if part),
                                'factoryNumber': serial, 'actual': performance[1],
                                'unit': 'шт.', 'quantity': 1})
        for battery in card.get('batteries', []):
            entries.append({'material': f"АКБ {battery['brand']}",
                            'factoryNumber': battery['number'],
                            'norm': _condition_duration(_condition_months(battery['serviceLifeYears'])),
                            'actual': _condition_duration(_condition_elapsed(_condition_date(battery['installDate']), act_date)),
                            'unit': 'шт.', 'quantity': 1})
        for tire in card.get('tires', []):
            entries.append({'material': _document_tire_name(tire),
                            'factoryNumber': tire['serialNumbers'],
                            'actual': _condition_duration(_condition_elapsed(_condition_date(tire['installDate']), act_date)),
                            'unit': 'шт.', 'quantity': tire['quantity']})
        for records, names, label in (
            (card.get('batteries'), ('Марка АКБ', 'Номер АКБ', 'Количество АКБ',
              'Дата приведения (установки) АКБ', 'Завод изготовитель АКБ'), 'АКБ'),
            (card.get('tires'), ('Марка, модель и размер шин (гусениц)', 'Номера шин (гусениц)',
              'Количество шин (гусениц)', 'Дата установки шин (гусениц)', ''), 'Шины'),
        ):
            if records:
                continue
            model, serial, quantity, installed, manufacturer = [field(name) if name else '' for name in names]
            if model or serial:
                entries.append({'material': f'{label} {model}'.strip(), 'factoryNumber': serial,
                                'quantity': quantity, 'unit': 'шт.', 'manufacturer': manufacturer,
                                'actual': _condition_duration(_condition_elapsed(_condition_date(installed), act_date))})
        for row in rows:
            table._tbl.remove(row._tr)
        for index, entry in enumerate(entries, 1):
            _document_add_row(table, rows[0], [f'{index}.', *(entry.get(key) for key in CONDITION_FIELDS)])
    else:
        group, material = next((r for r in rows if len(_document_unique_cells(r)) == (1 if is_writeoff else 2)), None), next(
            (r for r in rows if len(_document_unique_cells(r)) == (10 if is_writeoff else 11)), None)
        total = next((r for r in rows if r.cells[0].text.strip().startswith('Итого')), None)
        if group is None or material is None:
            raise ValidationError('В шаблоне отсутствуют образцы строк')
        for row in rows:
            table._tbl.remove(row._tr)
        quantity_sum = amount_sum = Decimal(0)
        incomplete_amount = False
        incomplete_quantity = False
        for index, item in enumerate(items, 1):
            vehicle, card = _document_find_vehicle(item, vehicles, details)
            values = _document_material(kind, item, card)
            label = _document_vehicle_label(_document_vehicle_values(vehicle, card))
            if fill_inventory:
                captions = (
                    ('Дата установки', 'installed'),
                    ('Норма наработки, км' if kind.startswith('tire-') else 'Срок службы по норме', 'norm'),
                    ('Фактический пробег, км' if kind.startswith('tire-') else 'Фактический срок службы', 'actual'),
                )
                if values.get('manufactured'):
                    captions = (('Дата изготовления', 'manufactured'), *captions)
                for caption, key in captions:
                    label += f"\n{caption}: {_document_text(values.get(key)).strip() or '—'}"
                if is_writeoff and _document_text(values.get('reason')).strip() not in ('', '—'):
                    label += f"\nОснование: {_document_text(values['reason'])}"
            _document_add_row(table, group, [label] if is_writeoff else [index, label])
            if is_writeoff:
                quantity = None
                if from_inventory and not _document_text(values.get('quantity')).strip():
                    incomplete_quantity = True
                else:
                    quantity = _document_decimal(values.get('quantity'), 'Количество')
                    quantity_sum += quantity
                if quantity is None or (fill_inventory and not _document_text(values.get('price')).strip()):
                    incomplete_amount = True
                    values['amount'] = '—'
                else:
                    price = _document_decimal(values.get('price'), 'Цена')
                    amount = (quantity * price).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                    amount_sum += amount
                    values['amount'] = f'{amount:.2f}'.replace('.', ',')
                if from_inventory and kind.startswith('tire-'):
                    values['norm'] = '—'
                values.setdefault('direction', 'Списание')
                output = [values.get(key) for key in WRITEOFF_FIELDS]
            else:
                output = [index, *(values.get(key) for key in CHANGE_FIELDS)]
            if fill_inventory:
                output = [value if _document_text(value).strip() else '—' for value in output]
            _document_add_row(table, material, output)
        notes = body.get('notes', {})
        if not isinstance(notes, dict):
            raise ValidationError('Примечания к акту должны быть объектом')
        amount_text = '—' if incomplete_amount else f'{amount_sum:.2f}'.replace('.', ',')
        approval_index = DOCUMENT_APPROVAL_PARAGRAPHS.get(kind)
        for index, paragraph in enumerate(doc.paragraphs):
            text = paragraph.text.strip()
            if text.startswith('Всего по настоящему акту списано'):
                paragraph.text = f'Всего по настоящему акту списано материалов на общую сумму: {amount_text} руб.'
            elif text.startswith('Заключение комиссии:'):
                paragraph.text = f"Заключение комиссии: {_document_text(notes.get('conclusion'))}"
            elif text.startswith('В результате выбытия'):
                paragraph.text = _document_text(notes.get('disposal'))
            elif text.startswith('Заключение: Правильность указанной'):
                paragraph.text = f"Заключение: {_document_text(notes.get('accounting'))}"
            elif text.startswith('Заключение: Правильность оформления'):
                paragraph.text = f"Заключение: {_document_text(notes.get('approval'))}"
            elif index == approval_index:
                paragraph.text = _document_text(notes.get('approval'))
        if is_writeoff and total is not None:
            quantity_text = '—' if incomplete_quantity else format(quantity_sum.normalize(), 'f')
            amounts = ['—', amount_text] if from_inventory else [amount_text, amount_text if is_tarp else '']
            _document_add_row(table, total, ['Итого', quantity_text, *amounts, '—' if fill_inventory else ''])
    stream = BytesIO()
    doc.save(stream)
    return stream.getvalue()


def _document_tire_name(tire):
    return ' '.join(filter(None, ('АШ', tire['size'], tire['brand'], tire['model'])))


def _document_material(kind, item, card):
    values = dict(item)
    group = kind.split('-')[0]
    if 'assetId' in values:
        collection = {'battery': 'batteries', 'tire': 'tires'}.get(group)
        if not collection:
            raise ValidationError('Для этого имущества укажите наименование в форме')
        asset = next((row for row in card.get(collection, []) if row['id'] == values['assetId']), None)
        if asset is None:
            raise ValidationError('Позиция имущества отсутствует в карточке выбранной машины')
        if group == 'battery':
            values['material'] = f"АКБ {asset['brand']}"
            if asset['number']:
                values['material'] += f"\n№ {asset['number']}"
            values.setdefault('norm', f"{asset['serviceLifeYears']} лет")
            values.setdefault('quantity', 1)
        else:
            values['material'] = '\n'.join((_document_tire_name(asset),
                                            asset['serialNumbers']))
            values.setdefault('norm', f"{asset['normKm']} км")
            values.setdefault('quantity', asset['quantity'])
    if not _document_text(values.get('material')).strip():
        raise ValidationError('Укажите наименование имущества')
    values.setdefault('unit', 'шт.')
    return values


def _document_find_vehicle(item, vehicles, details):
    vehicle_id = item.get('vehicleId')
    if type(vehicle_id) is not int or vehicle_id not in vehicles:
        raise ValidationError('Выберите машину из перечня ВВСТ')
    return vehicles[vehicle_id], details.get(vehicle_id, {})


def _document_match(label, vehicles, details, exact=False):
    key = _document_key(label)
    if not key:
        return []
    matches = []
    for vehicle in vehicles.values():
        card = _document_vehicle_values(vehicle, details.get(vehicle['id'], {}))
        identifiers = {_document_key(card[field]) for field in
                       ('regNumber', 'factoryNumber', 'vin', 'passportNumber', 'chassisNumber')}
        identifiers.discard('')
        if exact:
            found = key in identifiers
        else:
            tokens = re.split(r'[,;\n.]|\s+(?=паспорт|формуляр|шасси|двигатель|срок)', label, flags=re.I)
            groups = [_document_key(token) for token in tokens]
            found = any(len(value) >= 5 and any(part.endswith(value) or re.search(re.escape(value) + r'[0-9]{2,3}(?:rus|рус)$', part) or part == value for part in groups)
                        for value in identifiers)
        if found:
            matches.append(vehicle['id'])
    return matches


def _document_import(kind, data, vehicles, details):
    rows = []
    if kind == 'order':
        from lxml import etree
        from openpyxl import load_workbook
        _document_archive(data, 'xl/workbook.xml')
        try:
            book = load_workbook(BytesIO(data), read_only=True, data_only=True, keep_links=False)
            try:
                sheet = book[ORDER_SHEET]
                header = next(sheet.iter_rows(min_row=10, max_row=10, max_col=9, values_only=True))
                if _document_key(header[1]) != _document_key('Государственный регистрационный знак'):
                    raise ValidationError('Заголовки наряда не соответствуют шаблону')
                for section, start, end in ORDER_SECTIONS:
                    for values in sheet.iter_rows(min_row=start, max_row=end, max_col=9, values_only=True):
                        if not any(value is not None for value in values):
                            continue
                        row = dict(zip(ORDER_FIELDS, (str(value) if value is not None else '' for value in values)))
                        rows.append({**row, 'section': section, 'vehicleMatches': _document_match(
                            row['regNumber'], vehicles, details, exact=True)})
            finally:
                book.close()
        except (ValueError, KeyError, OSError, RuntimeError, TypeError, BadZipFile, etree.XMLSyntaxError) as exc:
            raise ValidationError('Не удалось прочитать лист формирования наряда') from exc
        return rows
    doc = _document_word(data)
    table, first = _document_table(doc, kind)
    if kind == 'condition':
        cells = _document_unique_cells(table.rows[first])
        if len(cells) != 11:
            raise ValidationError('Строка машины не соответствует шаблону акта')
        row = dict(zip(CONDITION_FIELDS, (cell.text.strip() for cell in cells[1:])))
        label = row['factoryNumber'] or (doc.paragraphs[11].text if len(doc.paragraphs) > 11 else '')
        row['components'] = [
            dict(zip(CONDITION_FIELDS, (cell.text.strip() for cell in record.cells[1:])))
            for record in table.rows[first + 1:] if len(record.cells) == 11
        ]
        if len(doc.tables) > 2 and len(doc.tables[2].rows) > 3:
            row['performance'] = {str(index): cell.text.strip() for index, cell in
                                  enumerate(doc.tables[2].rows[3].cells, 1)}
        for paragraph in doc.paragraphs:
            label_text, _, value = paragraph.text.partition(':')
            key = {'Комплектность': 'completeness', 'Техническое состояние': 'condition',
                   'Причины досрочного износа или повреждения': 'reason',
                   'Заключение комиссии': 'conclusion'}.get(label_text.strip())
            if key:
                row[key] = value.strip()
        rows.append({**row, 'vehicleMatches': _document_match(label, vehicles, details, exact=bool(row['factoryNumber']))})
        return rows
    writeoff = kind.endswith('-writeoff')
    label = ''
    for record in table.rows[first:]:
        cells = _document_unique_cells(record)
        if cells[0].text.strip().startswith('Итого'):
            continue
        if len(cells) == (1 if writeoff else 2):
            candidate = cells[-1].text.strip()
            if not candidate.startswith('№ '):
                label = candidate
        elif len(cells) == (10 if writeoff else 11):
            fields = WRITEOFF_FIELDS if writeoff else CHANGE_FIELDS
            values = cells if writeoff else cells[1:]
            row = dict(zip(fields, (cell.text.strip() for cell in values)))
            if row['material']:
                rows.append({**row, 'vehicleLabel': label,
                             'vehicleMatches': _document_match(label, vehicles, details)})
    return rows


def _document_order_resize(sheet, namespace, counts):
    sheet_data = sheet.find(namespace + 'sheetData')
    source_rows = {int(row.get('r')): row for row in sheet_data}
    duty, duty_start, _ = ORDER_SECTIONS[0]
    service, service_start, _ = ORDER_SECTIONS[1]
    omitted = {duty_start - 1} if not counts[duty] else set()
    extra = {}
    retained = {}
    for label, start, end in ORDER_SECTIONS:
        # The last row for other events is a spacer before the signatures.
        if label == ORDER_SECTIONS[-1][0]:
            end -= 1
        count = counts[label] + int(label == service)
        keep = min(count, end - start + 1)
        omitted.update(range(start + keep, end + 1))
        if keep:
            retained[label] = (start, start + keep - 1)
            extra[start + keep - 1] = count - keep
    mapping = {}
    next_row = 1
    for old in range(1, max(source_rows) + 1):
        if old in omitted:
            continue
        mapping[old] = next_row
        next_row += 1 + extra.get(old, 0)

    def set_row_number(row, number):
        row.set('r', str(number))
        for cell in row.findall(namespace + 'c'):
            cell.set('r', re.sub(r'\d+$', str(number), cell.get('r')))

    for old, row in source_rows.items():
        if old in omitted:
            sheet_data.remove(row)
            continue
        number = mapping[old]
        set_row_number(row, number)
        anchor = sheet_data.index(row) if extra.get(old) else 0
        for offset in range(1, extra.get(old, 0) + 1):
            clone = deepcopy(row)
            set_row_number(clone, number + offset)
            sheet_data.insert(anchor + offset, clone)

    def translate(ref):
        def replace(match):
            column, row = match.groups()
            old = int(row)
            new = mapping.get(old)
            if old in omitted:
                next_visible = next(number for number in range(old + 1, max(mapping) + 1) if number in mapping)
                new = mapping[next_visible]
            return column + str(old if new is None else new)
        return re.sub(r'(\$?[A-Z]+\$?)(\d+)', replace, ref)

    merges = sheet.find(namespace + 'mergeCells')
    if merges is not None:
        for merge in list(merges):
            ref = merge.get('ref')
            row_numbers = [int(number) for number in re.findall(r'\d+', ref)]
            if row_numbers and all(number in omitted for number in row_numbers):
                merges.remove(merge)
            else:
                merge.set('ref', translate(ref))
        merges.set('count', str(len(merges)))

    for node in sheet.iter():
        if not isinstance(node.tag, str) or node.tag == namespace + 'mergeCell':
            continue
        for attr in ('ref', 'sqref', 'activeCell', 'topLeftCell'):
            if attr in node.attrib:
                node.set(attr, translate(node.get(attr)))
        if node.tag.endswith('}sqref') and node.text:
            node.text = translate(node.text)
    slots = {
        label: range(mapping[start] + int(start == service_start),
                     mapping[end] + extra[end] + 1)
        for label, (start, end) in retained.items()
    }
    return mapping, slots


def _document_order_date(day):
    months = ('января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
              'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря')
    return f'{day.day:02d}', months[day.month - 1], day.year


def _document_order_export(template, body, vehicles, details):
    from lxml import etree

    updates = {}
    order_number = _document_text(body.get('number'))
    updates['A6'] = f'Наряд № {order_number or "________"}'
    order_date = None
    if 'date' in body:
        _iso_date(body['date'], 'date')
        order_date = date.fromisoformat(body['date'])
        day, month, year = _document_order_date(order_date)
        previous_day, previous_month, previous_year = _document_order_date(order_date - timedelta(days=1))
        previous = f'«{previous_day}» {previous_month} {previous_year} года'
        updates.update(A4=previous, E4=previous, A8=f'на {day} {month} {year} года',
                       A89=f'«{day}» {month} {year} г.')
    section_names = {
        'duty': ORDER_SECTIONS[0][0],
        'training': ORDER_SECTIONS[2][0],
        'household': ORDER_SECTIONS[3][0],
        'other': ORDER_SECTIONS[4][0],
    }
    grouped = {label: [] for label, _, _ in ORDER_SECTIONS}
    for item in body['rows']:
        key = _document_text(item.get('section'))
        section = section_names.get(key, key)
        if section not in grouped:
            raise ValidationError('Выберите раздел наряда из шаблона')
        # Camry already has a fixed row in the template.
        plate = _document_key(item.get('regNumber') or '')
        brand = _document_key(item.get('brand') or '')
        if 'vehicleId' in item:
            vehicle, _ = _document_find_vehicle(item, vehicles, details)
            plate = _document_key(vehicle.get('regNumber') or '')
            brand = _document_key(vehicle.get('brand') or '')
        if plate in ('5757ак', '5757ak') and brand in ('тойотакамри', 'toyotacamry'):
            continue
        grouped[section].append(item)
    part = 'xl/worksheets/sheet1.xml'
    namespace = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
    output = BytesIO()
    with ZipFile(BytesIO(template)) as source, ZipFile(output, 'w') as target:
        sheet = etree.fromstring(source.read(part))
        mapping, slots = _document_order_resize(
            sheet, namespace, {label: len(items) for label, items in grouped.items()},
        )
        updates = {f'{address[0]}{mapping[int(address[1:])]}': value for address, value in updates.items()}
        for section, row_numbers in slots.items():
            for row, item in zip(row_numbers, grouped[section]):
                if 'vehicleId' in item:
                    vehicle, card = _document_find_vehicle(item, vehicles, details)
                    passport = _document_vehicle_values(vehicle, card)
                    values = {**item, **{field: passport[field] for field in ORDER_FIELDS[:3]}}
                else:
                    values = dict(item)
                values['responsible'] = values.get('responsible') or values.get('driver')
                values.update(departureTime='08.00', returnTime='18.00', note='')
                if section == ORDER_SECTIONS[0][0] and order_date is not None:
                    values['note'] = (order_date + timedelta(days=1)).strftime('%d.%m.%Y')
                for column, field in zip('ABCDEFGHI', ORDER_FIELDS):
                    updates[f'{column}{row}'] = _document_text(values.get(field))
        sheet_data = sheet.find(namespace + 'sheetData')
        xml_rows = {int(row.get('r')): row for row in sheet_data}
        for address, value in updates.items():
            row_number = int(address[1:])
            row = xml_rows.get(row_number)
            if row is None:
                if not value:
                    continue
                row = etree.Element(namespace + 'row', r=str(row_number))
                position = next((i for i, node in enumerate(sheet_data)
                                 if int(node.get('r')) > row_number), len(sheet_data))
                sheet_data.insert(position, row)
                xml_rows[row_number] = row
            cell = row.find(f'{namespace}c[@r="{address}"]')
            if cell is None:
                if not value:
                    continue
                cell = etree.Element(namespace + 'c', r=address)
                column = re.match(r'[A-Z]+', address).group()
                position = next((i for i, node in enumerate(row)
                                 if node.tag == namespace + 'c' and
                                 (len(re.match(r'[A-Z]+', node.get('r')).group()),
                                  re.match(r'[A-Z]+', node.get('r')).group()) > (len(column), column)), len(row))
                row.insert(position, cell)
            for child in list(cell):
                if child.tag in {namespace + 'f', namespace + 'v', namespace + 'is'}:
                    cell.remove(child)
            cell.attrib.pop('t', None)
            if value:
                cell.set('t', 'inlineStr')
                inline = etree.SubElement(cell, namespace + 'is')
                node = etree.SubElement(inline, namespace + 't')
                node.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
                node.text = value
        for item in source.infolist():
            target.writestr(item, etree.tostring(sheet, encoding='UTF-8', xml_declaration=True)
                            if item.filename == part else source.read(item))
    return output.getvalue()


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
    def _vehicle_hours(vehicle):
        field = next((item for item in vehicle.get('passportData') or []
                      if _document_key(item['header']) == 'текущиепоказаниямоточасов'), None)
        value = field['value'] if field is not None else None
        if value is None or isinstance(value, bool):
            return None
        try:
            number = float(''.join(str(value).split()).replace(',', '.'))
        except ValueError:
            return None
        return number if math.isfinite(number) and number >= 0 else None

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
            field = next((field for field in fields
                          if _document_key(field['header']) == 'текущиепоказаниямоточасов'), None)
            if field is None:
                field = {'header': 'Текущие показания МОТОЧАСОВ',
                         'column': max((field['column'] for field in fields), default=0) + 1}
                fields.append(field)
            field['value'] = hours
        if odometer is not None or hours is not None:
            updated['passportData'] = fields
        VehicleDTO.parse(updated)
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
            if body['startKm'] != start_km or start_hours != self._vehicle_hours(vehicle):
                raise ConflictError('Показания изменились. Проверьте новые начальные значения.')
            if end_km is not None and end_km < start_km or (
                end_hours is not None and start_hours is not None and end_hours < start_hours
            ):
                raise ValidationError('Конечные показания не могут быть меньше начальных')
            self._write_vehicle_readings(db, vehicle, end_km, end_hours)
            km = end_km - start_km if end_km is not None else None
            hours = end_hours - start_hours if end_hours is not None and start_hours is not None else None
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
            current_km, current_hours = vehicle['currentMileage'], self._vehicle_hours(vehicle)
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
        return [row[0] for row in rows]

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

    def journal_create(self, fields: 'Any') -> 'dict[str, Any]':
        _exact_fields(fields, set(), _JOURNAL_DEPARTURE_FIELDS)
        with self.connect() as db:
            self._lock_journal(db)
            next_id = db.execute("SELECT COALESCE(MAX(item_id), 0) + 1 FROM planner_items WHERE collection = 'journal'").fetchone()[0]
            payload = {**_JOURNAL_DEFAULT_ENTRY, **fields, 'id': next_id, 'closedAt': None}
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
            parsed = JournalEntryDTO.parse({**payload, **fields})
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
            rows = db.execute('SELECT item_id FROM planner_items WHERE collection = %s AND item_id = ANY(%s) ORDER BY item_id FOR UPDATE', ('vehicles', vehicle_ids)).fetchall()
            if len(rows) != len(vehicle_ids):
                return False
            db.execute('DELETE FROM planner_items WHERE collection = %s AND item_id = ANY(%s)', ('vehicles', vehicle_ids))
            db.execute("DELETE FROM planner_items WHERE collection = %s AND payload->>'vehicleId' = ANY(%s)", ('unavailable', [str(vehicle_id) for vehicle_id in vehicle_ids]))
            for vehicle_id in vehicle_ids:
                db.execute('DELETE FROM planner_items WHERE collection = %s AND payload = %s', ('standing_vehicles', Jsonb(vehicle_id)))
                details = db.execute('SELECT payload FROM planner_items WHERE collection = %s AND item_id = %s FOR UPDATE', ('vehicle_details', vehicle_id)).fetchone()
                if details is not None:
                    preserved = {**details[0], 'certificate': None, 'batteries': [], 'tires': [], 'maintenance': []}
                    db.execute('UPDATE planner_items SET payload = %s WHERE collection = %s AND item_id = %s', (Jsonb(preserved), 'vehicle_details', vehicle_id))
        return True


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
                if action == 'setup':
                    if not store.set_access_password(scope, password):
                        self.send_json(409, {'error': 'Пароль уже настроен.'})
                        return
                if not login_attempt_allowed(attempt_key):
                    self.send_json(429, {'error': 'Слишком много попыток. Повторите позже.'}, {'Retry-After': str(login_window_seconds)})
                    return
                if not store.verify_access_password(scope, password):
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
