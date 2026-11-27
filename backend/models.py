"""Request DTOs and payload validation."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from .config import MAX_DATABASE_ID, MAX_NUMBERED_PASSPORT_FIELDS, MAX_PASSPORT_FIELDS

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

