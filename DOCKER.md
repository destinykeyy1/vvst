# Инструкция по запуску Military Planner с Docker

## Требования
- Docker Desktop для Windows
- Docker Compose

## Быстрый запуск

С GNU Make можно собрать и запустить Docker-версию командами из корня проекта:

```powershell
make build
make run
make stop
```

Для portable-сборки используйте `make compile`, затем `make portable`.
Остановить её можно через `make stop PORTABLE=1`. Команда
`make run PORTABLE=1` также запускает portable-приложение.

1. **Установите Docker Desktop** с https://www.docker.com/products/docker-desktop

2. **Запустите Docker Desktop** и дождитесь его готовности

3. **Перейдите в папку проекта:**
```bash
cd C:\Users\WwW\Desktop\MilitaryPlanner-portable\fullstack-proj
```

4. **Запустите контейнеры:**
```bash
docker-compose up -d
```

5. **Дождитесь запуска** (первый раз может занять 2-3 минуты):
```bash
docker-compose logs -f
```

6. **Откройте приложение:**
   - Бэкенд API: http://localhost:8000
   - Проверка здоровья: http://localhost:8000/api/health

## Остановка

```bash
docker-compose down
```

## Перезапуск

```bash
docker-compose restart
```

## Просмотр логов

```bash
# Все сервисы
docker-compose logs -f

# Только PostgreSQL
docker-compose logs -f postgres

# Только backend
docker-compose logs -f backend
```

## Сборка фронтенда

Если нужно собрать React-фронтенд:

```bash
cd frontend
npm install
npm run build
cd ..
docker-compose up -d
```

Собранный фронтенд будет доступен на http://localhost:8000/

## Структура

- `postgres` — база данных PostgreSQL 15
- `backend` — Python HTTP сервер с API
- `frontend` — React приложение (опционально, можно собрать локально)

## База данных

Данные хранятся в Docker volume `postgres_data`. Они сохраняются между перезапусками.

Для удаления всех данных:
```bash
docker-compose down -v
```

## Переменные окружения

Можно изменить в `docker-compose.yml`:
- `POSTGRES_DB` — имя базы данных
- `POSTGRES_USER` — пользователь
- `POSTGRES_PASSWORD` — пароль
- `MILITARY_PLANNER_DATABASE_URL` — строка подключения

## Проблемы

Если порт 8000 занят:
```bash
# Найдите процесс
netstat -ano | findstr :8000

# Или измените порт в docker-compose.yml
```

Если нужно пересобрать:
```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```
