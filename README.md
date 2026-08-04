# Celes — Cash Flow Command Center

App web construida a partir de `Celes_CashFlow_Tracker_v3.xlsx`. Incluye Dashboard,
Master Clients, Invoice Schedule, Weekly/Monthly Cash Flow, Outflow Schedule,
Deferred Income, AR Aging y Assumptions. Todo se recalcula en tiempo real.

## Estructura

```
src/App.jsx           → toda la aplicación (UI + motor de cálculo)
src/seed.js           → datos iniciales extraídos del Excel (25 clientes, 210 facturas, presupuesto de egresos)
src/storage.js        → ÚNICO archivo a modificar para cambiar dónde se guardan los datos
src/supabaseClient.js → cliente de Supabase + funciones para leer/agregar/quitar el allowlist del equipo
src/Auth.jsx          → pantalla de login (magic link o contraseña) y verificación de acceso
src/main.jsx          → punto de entrada de React
supabase/schema.sql   → SQL para crear las tablas app_state / allowed_users y sus políticas RLS
```

La pestaña **Team Access** dentro de la app permite agregar o quitar personas
del equipo sin tocar código: la lista vive en la tabla `allowed_users` de
Supabase, y cualquier persona que ya tenga acceso puede administrarla.

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

`src/Auth.jsx` muestra una pantalla de login antes de renderizar `App`, con
tres métodos:

- **Google** (recomendado): OAuth con el consentimiento configurado como
  **Internal** en Google Cloud, así que solo cuentas `@celes.ai` de Workspace
  pueden iniciar sesión. No depende del envío de correo, así que no le afecta
  el límite de envíos de Supabase.
- **Magic link**: solo correo, sin contraseña. Requiere que el SMTP de
  Supabase esté configurado (ver nota abajo) o quedará limitado a ~2
  correos/hora con el servicio de envío por defecto de Supabase.
- **Contraseña**: iniciar sesión o crear cuenta con correo + contraseña.

El usuario puede alternar entre magic link y contraseña con el link debajo
del formulario; Google siempre está disponible arriba.

> **Nota sobre envío de correo**: el servicio de email por defecto de
> Supabase es solo para pruebas (~2 correos/hora, compartido entre todos los
> métodos que envían correo). Para producción, configura un SMTP propio en
> Supabase → Authentication → Emails → SMTP Settings (por ejemplo, un buzón
> de Google Workspace con verificación en 2 pasos + contraseña de aplicación).

La URL de la app (localhost en dev, la de producción tras el deploy) debe
estar agregada en **Supabase → Authentication → URL Configuration** (Site
URL / Redirect URLs) para que el enlace del correo redirija correctamente.

Solo los correos en la tabla `allowed_users` pueden entrar, sin importar el
método de login. Si alguien fuera de la lista inicia sesión, se cierra su
sesión automáticamente y ve un mensaje de acceso denegado. Para agregar o
quitar gente del equipo, usa la pestaña **Team Access** dentro de la app
(no requiere redeploy).

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
