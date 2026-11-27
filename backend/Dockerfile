FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Preserve the backend package layout expected by its imports.
COPY . ./backend/

# Expose port
EXPOSE 8000

# Run the API only — the web service serves the frontend.
CMD ["python", "-m", "backend.server"]
