import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the browser talks only to Vite (same origin), and Vite forwards
// API and legal-page requests to Flask. That keeps session cookies first-party,
// so you do not need CORS or SameSite=None while developing.
const FLASK = 'http://localhost:5000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': FLASK,
      '/privacy': FLASK,
      '/terms': FLASK,
      '/refunds': FLASK,
      '/cookies': FLASK,
      '/verify-email': FLASK,
      '/unsubscribe': FLASK,
    },
  },
});
