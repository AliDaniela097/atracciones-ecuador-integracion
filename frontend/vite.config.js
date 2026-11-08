import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// En desarrollo, las llamadas a /api se reenvían al backend local. En producción la web se sirve desde el mismo dominio del backend.
export default defineConfig({ plugins: [react()], server: { proxy: { '/api': { target: process.env.VITE_API_TARGET ?? 'http://localhost:3150', changeOrigin: true } } }, build: { outDir: 'dist', sourcemap: false } });
