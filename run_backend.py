"""Dev runner: start bundled PostgreSQL + the planner API (no static frontend).

The Vite dev server proxies /api to http://127.0.0.1:8000.
"""

import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

BUNDLE = os.path.join(os.path.dirname(ROOT), "MilitaryPlanner")
os.environ.setdefault("MILITARY_PLANNER_PG_BIN", os.path.join(BUNDLE, "postgres", "bin"))
os.environ.setdefault("MILITARY_PLANNER_SEED_DUMP", os.path.join(BUNDLE, "initial-data.dump"))
os.environ["MILITARY_PLANNER_AUTOPEN"] = "0"

from backend.postgres_runtime import PostgresRuntime
from backend.server import run as run_server


def main() -> None:
    runtime = PostgresRuntime()
    runtime._start()
    os.environ["MILITARY_PLANNER_DATABASE_URL"] = runtime.database_url
    print(f"database: {runtime.database_url}", flush=True)
    try:
        run_server(static_root=None)
    finally:
        runtime._stop()


if __name__ == "__main__":
    main()
