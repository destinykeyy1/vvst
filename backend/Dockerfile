FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY . .

# Create directory for frontend build
RUN mkdir -p /app/frontend/dist

# Expose port
EXPOSE 8000

# Set environment variables
ENV MILITARY_PLANNER_FRONTEND_DIR=/app/frontend/dist

# Run the server
CMD ["python", "server.py"]
