.DEFAULT_GOAL := help

PORTABLE_OUTPUT ?= portable\MilitaryPlanner
PORTABLE_EXE = $(PORTABLE_OUTPUT)\MilitaryPlanner.exe

.PHONY: help build run compile portable stop docker-run docker-stop portable-stop

help:
	@echo "make build                 Build Docker images"
	@echo "make run                   Start the Docker application"
	@echo "make run PORTABLE=1        Start the portable application"
	@echo "make compile               Build the portable application"
	@echo "make portable              Start the portable application"
	@echo "make stop                  Stop Docker services"
	@echo "make stop PORTABLE=1       Stop the portable application"

build:
	docker compose build

run:
	docker compose up --build -d

stop:
	docker compose down

compile:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build_portable.ps1 -OutputPath "$(PORTABLE_OUTPUT)"

portable:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$exe = '$(PORTABLE_EXE)'; if (-not (Test-Path -LiteralPath $$exe -PathType Leaf)) { throw 'Portable executable not found. Run make compile first.' }; $$exe = (Resolve-Path -LiteralPath $$exe).Path; Start-Process -FilePath $$exe -WorkingDirectory (Split-Path -Parent $$exe) -WindowStyle Hidden"

portable-stop:
	powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$exe = '$(PORTABLE_EXE)'; if (-not (Test-Path -LiteralPath $$exe -PathType Leaf)) { throw 'Portable executable not found. Run make compile first.' }; & $$exe --stop; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }"

ifeq ($(PORTABLE),1)
run: portable
stop: portable-stop
else
run: docker-run
stop: docker-stop
endif
