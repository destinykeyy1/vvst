"""Document import/export and registry audit helpers."""

from __future__ import annotations

import math
import re
from copy import deepcopy
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from io import BytesIO
from typing import Any
from zipfile import BadZipFile, ZipFile

from psycopg.types.json import Jsonb

from .models import RUSSIAN_FIELD_NAMES, ValidationError, _iso_date

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


CURRENT_HOURS_HEADER = 'Текущие показания МОТОЧАСОВ'


def _current_hours_field(field):
    if field.get('header') == 'meta:motoHours':
        return True
    key = _document_key(field.get('header', ''))
    if key in ('103', 'n103'):
        return True
    if re.search(r'\d|сначала|норм|загод|замесяц|засутки|запериод|остаток', key):
        return False
    return 'моточас' in key and (
        'текущ' in key or str(field.get('ordinal')) == '103'
        or key == 'показаниясчетчикамоточасов'
    )


def _passport_hours_value(value):
    if type(value) not in (int, float, str):
        return None
    token = re.sub(r'\s+', '', str(value).casefold()).replace(',', '.')
    token = re.sub(r'(?:моточас(?:ов|а)?|моточ|мч|м\.ч\.?|ч\.?)$', '', token)
    if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?', token):
        return None
    try:
        number = float(token)
    except ValueError:
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _passport_current_hours(vehicle):
    values = (_passport_hours_value(field.get('value'))
              for field in vehicle.get('passportData') or [] if _current_hours_field(field))
    # In legacy records an empty or smaller shadow value may have been added after import.
    return max((value for value in values if value is not None), default=None)


def _vehicle_with_current_hours(vehicle):
    hours = _passport_current_hours(vehicle)
    if hours is None:
        return vehicle
    return {
        **vehicle,
        'passportData': [
            {**field, 'value': hours} if _current_hours_field(field) else field
            for field in vehicle['passportData']
        ],
    }


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


def _registry_cells(vehicle):
    """Effective stored values, independent of the order of passportData entries."""
    if not vehicle:
        return {}
    labels = {
        'meta:type': 'Тип машины', 'meta:year': 'Год выпуска',
        'meta:commissionDate': 'Дата ввода в эксплуатацию',
        'meta:order': 'Наряд на получение (передачу) ВВСТ',
        'meta:status': 'Техническое состояние', 'meta:statusReason': 'Характер неисправности',
    }
    cells = {}
    for field in vehicle.get('passportData') or []:
        header = field['header']
        if _current_hours_field(field):
            continue
        label = labels.get(header, header)
        if not header.startswith('meta:'):
            label = f"{label} (столбец {field['column']})"
        # Repeated passport headings refer to different physical columns.
        key = header if header.startswith('meta:') else ('passport', field['column'])
        cells[key] = (label, field['value'])
    for key, label in {
        'id': 'Идентификатор машины', 'brand': 'Марка машины',
        'regNumber': 'Государственный регистрационный знак (строевой номер)',
        'usageType': 'Группа эксплуатации', 'driver': 'Закреплённый водитель',
        'location': 'Подразделение', 'currentMileage': 'Текущие показания СПИДОМЕТРА',
        'mileageAtDec1': 'Пробег на 1 декабря', 'yearlyNorm': 'Годовая норма, км',
    }.items():
        cells[key] = (label, vehicle.get(key))
    for key in ('batteryStatus', 'tireStatus', 'hasCertificate', 'hasHistory'):
        cells[key] = (RUSSIAN_FIELD_NAMES[key], vehicle.get(key))
    maintenance = vehicle.get('maintenanceInfo') or {}
    cells['maintenanceText'] = ('Сведения о техническом обслуживании', maintenance.get('text'))
    cells['maintenanceStatus'] = ('Статус технического обслуживания', maintenance.get('status'))
    cells['hours'] = (CURRENT_HOURS_HEADER, _passport_current_hours(vehicle))
    return cells


def _record_registry_changes(db, before, after):
    changes = []
    for vehicle_id in sorted(before.keys() | after.keys()):
        old, new = before.get(vehicle_id), after.get(vehicle_id)
        if old == new:
            continue
        vehicle = new or old
        left, right = _registry_cells(old), _registry_cells(new)
        for key in dict.fromkeys((*left, *right)):
            label, previous = left.get(key, (None, None))
            label, current = right.get(key, (label, None))
            if previous != current or isinstance(previous, bool) != isinstance(current, bool):
                changes.append((vehicle['id'], vehicle['regNumber'], label,
                                Jsonb(previous), Jsonb(current)))
    if changes:
        db.cursor().executemany(
            'INSERT INTO planner_registry_changes '
            '(vehicle_id, reg_number, column_name, old_value, new_value) VALUES (%s,%s,%s,%s,%s)',
            changes,
        )


def _audit_registry_replacement(db, items):
    rows = db.execute("SELECT item_id, payload FROM planner_items WHERE collection = 'vehicles' "
                      "ORDER BY item_id FOR UPDATE").fetchall()
    _record_registry_changes(db, dict(rows), {item['id']: item for item in items})


