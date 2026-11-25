'''Loopback-only HTTP API backed by PostgreSQL.'''

from __future__ import annotations
import json
import hashlib
import hmac
import math
import mimetypes
import os
import secrets
import threading
import time
import webbrowser
from dataclasses import dataclass
from datetime import date
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import (unquote, urlparse, urlsplit)
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

RUSSIAN_FIELD_NAMES = {'vehicleId': 'Идентификатор машины', 'vehicle id': 'Идентификатор машины', 'id': 'Идентификатор', 'brand': 'Марка', 'regNumber': 'Государственный номер', 'usageType': 'Назначение', 'driver': 'Водитель', 'location': 'Место дислокации', 'mileageAtDec1': 'Пробег на 1 декабря', 'currentMileage': 'Текущий пробег', 'yearlyNorm': 'Годовая норма', 'maintenanceInfo': 'Сведения о техническом обслуживании', 'batteryStatus': 'Состояние АКБ', 'tireStatus': 'Состояние шин', 'hasCertificate': 'Наличие паспорта', 'hasHistory': 'Наличие истории', 'passportData': 'Паспортные данные', 'date': 'Дата', 'startDate': 'Дата начала', 'endDate': 'Дата окончания', 'reason': 'Причина', 'customReason': 'Другая причина', 'notes': 'Примечания', 'orderId': 'Номер наряда', 'orderNumber': 'Номер наряда', 'lines': 'Строки наряда', 'scheduleRowId': 'Строка расписания', 'scheduleDates': 'Даты расписания', 'requiredQuantity': 'Требуемое количество', 'startTime': 'Время отправления', 'endTime': 'Время прибытия', 'km': 'Километраж', 'journalEntryId': 'Номер записи журнала', 'departureTime': 'Время отправления', 'arrivalTime': 'Время прибытия', 'arrivalDate': 'Дата прибытия', 'departureEngineHours': 'Показания счетчика моточасов при выезде', 'arrivalEngineHours': 'Показания счетчика моточасов при возвращении', 'engineHours': 'Наработка, моточасы', 'name': 'Название', 'password': 'Пароль', 'ids': 'Идентификаторы', 'certificate.type': 'Тип паспорта', 'certificate.regNumber': 'Государственный номер', 'certificate.brandModel': 'Марка и модель', 'certificate.issueDate': 'Дата выдачи паспорта', 'certificate.issuedBy': 'Кем выдан паспорт', 'certificate.vehicleType': 'Тип машины', 'certificate.yearOfManufacture': 'Год выпуска', 'certificate.vin': 'VIN', 'certificate.factoryNumber': 'Заводской номер', 'certificate.bodyNumber': 'Номер кузова', 'certificate.chassisNumber': 'Номер шасси', 'certificate.engineNumber': 'Номер двигателя', 'certificate.transmissionNumber': 'Номер трансмиссии', 'certificate.color': 'Цвет', 'certificate.enginePower': 'Мощность двигателя', 'certificate.engineDisplacement': 'Рабочий объем двигателя', 'certificate.maxMass': 'Максимальная масса', 'certificate.unladenMass': 'Масса без нагрузки', 'certificate.serialNumber': 'Серийный номер', 'certificate.usageGroup': 'Группа эксплуатации', 'certificate.subdivision': 'Подразделение', 'certificate.hullNumber': 'Номер корпуса', 'certificate.turretNumber': 'Номер башни', 'certificate.engineBrand': 'Марка двигателя', 'formula reference header': 'Заголовок ссылки формулы', 'formula reference registration': 'Регистрационный номер ссылки формулы', 'calculation expression': 'Выражение расчета'}

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
    @classmethod
    def parse(cls, raw: 'Any') -> 'dict[str, Any]':
        fields = set(cls.__dataclass_fields__)
        engine_hour_fields = {'departureEngineHours', 'arrivalEngineHours'}
        _exact_fields(raw, fields - engine_hour_fields, engine_hour_fields)
        if type(raw['id']) is not int or raw['id'] < 1:
            raise ValidationError('Идентификатор записи журнала должен быть положительным целым числом')
        for field in ('date', 'arrivalDate'):
            _iso_date(raw[field], field)
        for field in fields - {'id', 'date', 'arrivalDate', 'returnDeadline', 'arrivalOdometer', 'departureOdometer', 'arrivalEngineHours', 'departureEngineHours'}:
            _string(raw[field], field)
        for field in ('departureOdometer', 'arrivalOdometer'):
            if raw[field] is not None:
                _nonnegative_int(raw[field], field)
        for field in engine_hour_fields:
            if raw.get(field) is not None:
                _nonnegative_number(raw[field], field)
        _choice(raw['returnDeadline'], {'15:00', '18:00'}, 'returnDeadline')
        for field in ('departureTime', 'arrivalTime'):
            value = raw[field]
            if not value:
                continue
            if len(value) == 5 and value[2] == ':' and value[:2].isdigit() and value[3:].isdigit():
                if 0 <= int(value[:2]) <= 23:
                    if 0 <= int(value[3:]):
                        if int(value[3:]) <= 59:
                            continue
                    else:
                        int(value[:2])
            raise ValidationError(f'{_russian_field(field)} должен использовать формат ЧЧ:ММ')
        return raw


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

class PlannerStore:
    '''Owns the frontend PostgreSQL collection table.'''

    def __init__(self, url: 'str | None'=None, connect_kwargs: 'dict[str, Any] | None'=None):
        self.url = database_url() if url is None else url
        self.connect_kwargs = connect_kwargs or {}
        self.connect_kwargs.setdefault('connect_timeout', 10)
        with self.connect() as db:
            db.execute('\n                CREATE TABLE IF NOT EXISTS planner_items (\n                    collection TEXT NOT NULL,\n                    item_id BIGINT NOT NULL,\n                    payload JSONB NOT NULL,\n                    PRIMARY KEY (collection, item_id)\n                )\n            ')
            db.execute("\n                CREATE TABLE IF NOT EXISTS planner_access_credentials (\n                    scope TEXT PRIMARY KEY CHECK (scope IN ('orders', 'passport')),\n                    password_salt BYTEA NOT NULL,\n                    password_hash BYTEA NOT NULL,\n                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()\n                )\n            ")
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

    def replace_items(self, collection: 'str', values: 'Any', dto: 'type') -> 'list[dict[str, Any]]':
        if not isinstance(values, list):
            raise ValidationError('Тело запроса должно быть массивом')
        parsed = [dto.parse(value) for value in values]
        if dto is ExploitationDTO:
            with self.connect() as db:
                db.execute('DELETE FROM planner_items WHERE collection = %s', (collection,))
                db.cursor().executemany('INSERT INTO planner_items (collection, item_id, payload) VALUES (%s, %s, %s)', [(collection, index, Jsonb(item)) for index, item in enumerate(parsed, start=1)])
            return parsed
        key = 'vehicleId' if dto is VehicleDetailsDTO else 'id'
        ids = [item[key] for item in parsed]
        if len(ids) != len(set(ids)):
            raise ValidationError('Идентификаторы должны быть уникальными')
        with self.connect() as db:
            db.execute('DELETE FROM planner_items WHERE collection = %s', (collection,))
            db.cursor().executemany('INSERT INTO planner_items (collection, item_id, payload) VALUES (%s, %s, %s)', [(collection, item[key], Jsonb(item)) for item in parsed])
        return parsed

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
                allowed_hosts.add('host.docker.internal')
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
            # Check authentication for protected endpoints
            protected_paths = {
                '/api/vehicles', '/api/unavailable', '/api/order-drafts', '/api/orders',
                '/api/order-section-lines', '/api/schedules', '/api/household-schedules',
                '/api/other-schedules', '/api/exploitation', '/api/vehicle-details',
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

        def do_POST(self) -> 'None':
            path = urlparse(self.path).path
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
            # Check authentication for protected endpoints
            protected_paths = {
                '/api/vehicles', '/api/unavailable', '/api/order-drafts', '/api/orders',
                '/api/order-section-lines', '/api/schedules', '/api/household-schedules',
                '/api/other-schedules', '/api/exploitation', '/api/vehicle-details',
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
                except psycopg.errors.UniqueViolation:
                    self.send_json(409, {'error': 'duplicate id'})
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
                self.send_json(200, state)
                return
            if path == '/api/standing-vehicles':
                try:
                    ids = store.replace_standing_ids(self.read_body())
                except ValidationError as exc:
                    self.send_json(400, {'error': str(exc)})
                except psycopg.Error:
                    self.send_json(503, {'error': 'database unavailable'})
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
            except psycopg.errors.UniqueViolation:
                self.send_json(409, {'error': 'duplicate id'})
            except psycopg.Error:
                self.send_json(503, {'error': 'database unavailable'})
            self.send_json(200, items)

        def do_PATCH(self) -> 'None':
            path = urlparse(self.path).path
            # Check authentication for protected endpoints
            if path.startswith('/api/vehicles/'):
                if not self.check_authentication():
                    self.send_json(401, {'error': 'Authentication required'})
                    return
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
            # Check authentication for protected endpoints
            if path == '/api/vehicles':
                if not self.check_authentication():
                    self.send_json(401, {'error': 'Authentication required'})
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
