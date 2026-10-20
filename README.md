# BlueMart

## Run locally
Backend:  cd backend && pip install -r requirements.txt && FLASK_ENV=development python app.py
Frontend: cd frontend && npm install && npm run dev   (http://localhost:5173)

### Windows PowerShell

Run the backend and frontend in separate terminals. Set `DATABASE_URL` to a
PostgreSQL connection string before starting the backend if you want database-backed
features such as the product catalog.

```powershell
cd backend
python -m pip install -r requirements.txt
$env:FLASK_ENV = "development"
python app.py
```

```powershell
cd frontend
npm install
npm run dev
```

The frontend uses Vite's proxy to send API and legal-page requests to the local
Flask server on port 5000. Set `VITE_API_URL` only when the API is hosted at a
different origin.
