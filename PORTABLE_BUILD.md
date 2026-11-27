# Portable Windows build

The Windows packaging script creates a self-contained folder with the
application executable, PostgreSQL, frontend, document templates, icon, and
shortcut.

## Requirements

- 64-bit Windows and Python
- A PostgreSQL installation or portable PostgreSQL folder containing `bin`,
  `lib`, and `share`
- Bun (the frontend dependencies are pinned by `frontend/bun.lock`)

By default, the script builds the frontend from `frontend/` and packages a
fresh static build of the current route components:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build_portable.ps1
```

By default, the script reads PostgreSQL from the adjacent
`..\MilitaryPlanner\postgres` folder and writes the package to
`portable\MilitaryPlanner`. To use another PostgreSQL distribution:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build_portable.ps1 -PostgresRoot 'C:\PostgreSQL\17'
```

To package the existing static `release/` folder without rebuilding the
frontend, pass:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build_portable.ps1 -UseExistingFrontend
```

## Running and stopping

Double-click `Планирование ВВСТ.lnk` or `MilitaryPlanner.exe`. The launcher
starts a detached background service, writes its output to
`%LOCALAPPDATA%\MilitaryPlanner\logs\service.log`, opens the browser, and
closes its own console after startup. PostgreSQL data is kept separately in
`%LOCALAPPDATA%\MilitaryPlanner\postgres-data`.

To stop the application and its PostgreSQL instance, run:

```powershell
.\MilitaryPlanner.exe --stop
```

`launcher.log` records launcher errors; PostgreSQL writes its server log into
its data directory. Closing the startup console does not stop either service.
