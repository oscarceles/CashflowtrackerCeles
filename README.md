# Celes — Cash Flow Command Center

App web construida a partir de `Celes_CashFlow_Tracker_v3.xlsx`. Incluye Dashboard,
Master Clients, Invoice Schedule, Weekly/Monthly Cash Flow, Outflow Schedule,
Deferred Income, AR Aging y Assumptions. Todo se recalcula en tiempo real.

## Estructura

```
src/App.jsx           → toda la aplicación (UI + motor de cálculo)
src/seed.js           → datos iniciales extraídos del Excel (25 clientes, 210 facturas, presupuesto de egresos)
src/storage.js        → ÚNICO archivo a modificar para cambiar dónde se guardan los datos
src/supabaseClient.js → cliente de Supabase + lista de correos permitidos (ALLOWED_EMAILS)
src/Auth.jsx          → pantalla de login (magic link por email) y verificación de acceso
src/main.jsx          → punto de entrada de React
supabase/schema.sql   → SQL para crear la tabla app_state y sus políticas RLS
```

## Correr en local

```bash
npm install
npm run dev      # abre http://localhost:5173
```

Necesitas un archivo `.env` (no se sube a git) con:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

## Estado actual del guardado

`src/storage.js` usa **Supabase**: todo el equipo comparte los mismos datos
(tabla `app_state`, ver `supabase/schema.sql`). Antes de tener datos reales,
corre ese SQL una vez en el SQL Editor de tu proyecto Supabase.

## Autenticación

`src/Auth.jsx` muestra una pantalla de login antes de renderizar `App`:
correo por magic link (sin contraseña), vía Supabase Auth nativo. No
requiere configurar ningún provider externo.

La URL de la app (localhost en dev, la de producción tras el deploy) debe
estar agregada en **Supabase → Authentication → URL Configuration** (Site
URL / Redirect URLs) para que el enlace del correo redirija correctamente.

Solo los correos en `ALLOWED_EMAILS` (`src/supabaseClient.js`) pueden entrar,
sin importar el método de login. Si alguien fuera de la lista inicia sesión,
se cierra su sesión automáticamente y ve un mensaje de acceso denegado. Para
agregar o quitar gente del equipo, edita ese arreglo y vuelve a desplegar.

## Deploy (GitHub → Netlify o Vercel)

1. Subir esta carpeta a un repositorio de GitHub.
2. En Netlify/Vercel: importar el repo. Build command: `npm run build`. Publish dir: `dist`.
3. Definir las variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` en la
   configuración de entorno del hosting.
4. Agregar la URL final (Netlify/Vercel) en Supabase → Authentication → URL
   Configuration para que el magic link redirija bien.

## Notas de diseño

- Fecha "as of": por defecto es el día real; se puede fijar en Assumptions.
- Balance proyectado = asume que todo lo facturado se cobra en la fecha esperada.
  Balance real = solo cuenta lo ya cobrado. La brecha entre ambos es la cartera.
- Los egresos 2027 = 2026 × (1 + escalación definida en Assumptions).
- Guardado: último en escribir gana. Con Supabase se puede evolucionar a
  filas por factura si el equipo crece.
