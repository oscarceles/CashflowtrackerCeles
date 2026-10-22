# Celes — Cash Flow Command Center

App web construida a partir de `Celes_CashFlow_Tracker_v3.xlsx`. La portada organiza
el producto en los modulos Cashflow, Board y People. Cashflow contiene Dashboard,
Reports, Investment, Master Clients, Invoice Schedule, Weekly/Monthly Cash Flow,
Outflow Schedule, Deferred Income, AR Aging y Assumptions. Board
contiene Legal Docs Series A (lector PDF privado), Series A Tasks (con adjuntos
privados) y Local entities; People muestra "En construcción"; Administración
(solo Super Admin) gestiona miembros, roles y acceso por módulo. Los calculos se
actualizan en tiempo real.

Consulta [WIKI.md](WIKI.md) para el funcionamiento actual detallado. Mantenerlo
actualizado junto con cada modificacion o fix del producto.

## Estructura

```
src/App.jsx           → toda la aplicación (UI + motor de cálculo)
src/seed.js           → datos iniciales extraídos del Excel (25 clientes, 210 facturas, presupuesto de egresos)
src/storage.js        → ÚNICO archivo a modificar para cambiar dónde se guardan los datos
src/supabaseClient.js → cliente de Supabase + funciones para leer/agregar/quitar el allowlist del equipo
src/Auth.jsx          → pantalla de login (magic link o contraseña) y verificación de acceso
src/main.jsx          → punto de entrada de React
src/cashflow.css      → estilos con la identidad visual de Celes
supabase/schema.sql   → SQL para crear las tablas app_state / allowed_users y sus políticas RLS
supabase/security-hardening.sql → roles de miembros, RLS por rol/módulo + hook que bloquea registros fuera de la lista (correr después de schema.sql)
netlify.toml          → build, funciones y headers de seguridad (CSP, HSTS, anti-iframe)
netlify/functions/    → funciones server-side de Board (documentos Series A y tareas/adjuntos)
scripts/deploy-production.mjs → deploy a producción con las credenciales server-side de Board
```

El módulo **Administración → Miembros** permite a un Super Admin agregar,
editar o quitar miembros y asignarles rol (Super Admin, Admin, Colaborador,
Board Member) y acceso por módulo (ver/editar), sin tocar código. La lista vive
en la tabla `allowed_users` de Supabase; las reglas se aplican en la base de
datos (RLS), en las funciones de Board y en la interfaz. Ver [WIKI.md](WIKI.md).

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
quitar gente del equipo, usa **Administración → Miembros** dentro de la app
(no requiere redeploy).

## Deploy (GitHub → Netlify o Vercel)

1. Subir esta carpeta a un repositorio de GitHub.
2. En Netlify/Vercel: importar el repo. Build command: `npm run build`. Publish dir: `dist`.
3. Definir las variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` en la
   configuración de entorno del hosting.
4. Agregar la URL final (Netlify/Vercel) en Supabase → Authentication → URL
   Configuration para que el magic link redirija bien.

Las funciones de Board (`netlify/functions/`) necesitan además
`SUPABASE_SERVICE_ROLE_KEY` en las variables de entorno del sitio (y usan
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` si no hay `SUPABASE_URL` /
`SUPABASE_ANON_KEY`). Sin esa clave responden "not configured" (503).

## Notas de diseño

- Fecha "as of": por defecto sigue la fecha local actual (al abrir, sincronizar y cada medianoche); desactiva "Use current date automatically" en Assumptions para fijar una fecha histórica.
- Balance proyectado = asume que todo lo facturado se cobra en la fecha esperada.
  Balance real = solo cuenta lo ya cobrado. La brecha entre ambos es la cartera.
- Los egresos 2027 = 2026 × (1 + escalación definida en Assumptions).
- Guardado: último en escribir gana. Con Supabase se puede evolucionar a
  filas por factura si el equipo crece.
