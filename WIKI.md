# Wiki de funcionamiento

Este documento describe el comportamiento implementado actualmente en la app. El codigo fuente es la referencia final si hay diferencias. Cuando una modificacion cambie la interfaz, las reglas del modelo, los datos, el acceso, el almacenamiento o la operacion, actualizar la seccion correspondiente y el historial de cambios en el mismo trabajo.

## Proposito y arquitectura

Aplicacion web React construida con Vite para revisar y mantener el flujo de caja de Celes. El arranque de `src/main.jsx` monta `AuthGate`; la aplicacion principal solo se muestra tras validar la sesion y cargar el registro del miembro (rol y modulos) desde `allowed_users` en Supabase.

Tras iniciar sesion se muestra una portada de modulos con el logo oficial de Celes Technologies, servido como asset local `public/celes-logo.png`, y una estetica alineada con `celes.ai` (fondo blanco, tipografia sans, tinta azul marino, acento azul y detalles verdes). `Cashflow` aplica la misma identidad a su navegacion, tarjetas, acciones, tablas y graficos; en pantallas de hasta 760 px la barra lateral se convierte en encabezado y navegacion horizontal. `Board` contiene `Legal Docs Series A`, `Series A Tasks` y el grupo expandible `Local entities`, con `Celes (US)`, `Biai (Colombia)`, `Xeles (Mexico)` y `Celes (Chile)`. Series A Tasks sigue el closing record con tareas puntuales y recurrentes, y admite adjuntos privados; las cuatro vistas de entidad muestran estado vacio hasta tener contenido. `People` permanece en `En construcción`. `Administración` contiene `Miembros` y solo aparece para Super Admin. La portada solo muestra los modulos a los que el miembro tiene acceso y marca `Abrir · Solo lectura` cuando solo puede ver. Desde Cashflow se vuelve a la portada con `Módulos` en la barra lateral. La seleccion del modulo es local a la sesion y no cambia ni guarda datos de negocio.

La interfaz, el estado principal y los calculos derivados viven en `src/App.jsx`. Los datos de respaldo iniciales vienen de `src/seed.js`; la persistencia se delega en `src/storage.js`; la conexion y las operaciones de acceso al equipo estan en `src/supabaseClient.js`. El esquema y las politicas de base de datos estan en `supabase/schema.sql`.

## Acceso

- La pantalla de acceso ofrece Google, enlace magico por correo y correo/contraseña. El enlace magico se envia con redireccion al origen actual; el registro por contraseña depende de la confirmacion que tenga configurada Supabase.
- Despues de autenticar, la app carga el registro del miembro en `allowed_users` (correo, nombre, rol, modulos). Si no existe o no se puede cargar, cierra la sesion y muestra un aviso (falla de forma cerrada). El codigo de la app no impone por si mismo un dominio de correo.
- Roles (`role`) y acceso por modulo (`modules`, objeto `{modulo: "view"|"edit"}`; modulos `cashflow`, `board`, `people`):

| Rol | Acceso |
| --- | --- |
| Super Admin (`super_admin`) | Ve y edita todos los modulos; unico rol que ve `Administración` y gestiona miembros. |
| Admin (`admin`) | Por cada modulo elegido: `Ver` o `Ver y editar`. |
| Colaborador (`colaborador`) | Solo ve los modulos elegidos. |
| Board Member (`board_member`) | Solo lectura de Board. |

- La misma regla esta implementada en `public.module_access()` (SQL), en `moduleAccess()` de las funciones de Netlify y en `src/access.js` (interfaz). Al guardar, los modulos se normalizan segun el rol.
- `Administración → Miembros` (antes `Team Access` en Cashflow) permite a Super Admin buscar, agregar, editar (nombre, rol, modulos) y quitar miembros. Nadie puede editar su propio registro ni quitarse a si mismo, para evitar quedarse sin administradores; el correo no se edita (se quita y se vuelve a agregar). Los cambios aplican de inmediato en base de datos y funciones; la interfaz del miembro afectado se actualiza al recargar.
- En Cashflow, un miembro con acceso de solo lectura ve un aviso, no tiene botones de alta/edicion/pago/borrado/backup/reset, los campos de Outflows y Assumptions quedan deshabilitados y no se ejecuta el autosave. En Board, quien solo puede ver no tiene botones de crear/editar/borrar tareas, cambiar estado ni adjuntar o quitar archivos.
- `supabase/security-hardening.sql` define la barrera en base de datos: agrega `role`, `modules`, `full_name`, `updated_at` y `updated_by` a `allowed_users`; `app_state` solo admite el registro `celes-cashflow-v1`, legible con acceso de lectura a Cashflow y modificable solo con acceso de edicion (los datos de Board solo se leen/escriben via funciones server-side); `anon` no tiene privilegios; cada miembro solo ve su propia fila de `allowed_users` y solo Super Admin ve, agrega, edita o quita miembros (excepto a si mismo). En su primera ejecucion asigna Super Admin a `oscar@celes.ai` y `admin@biai.tech`, y Admin con edicion de Cashflow y Board al resto de miembros existentes. Tambien define `hook_before_user_created`, que rechaza la creacion de cuentas para correos fuera de `allowed_users`. El SQL se ejecuto en produccion el 2026-10-22; elimina antes todas las politicas previas de `app_state` y `allowed_users` (produccion tenia una politica adicional `allow all for authenticated users`). Se verifico con usuarios simulados: Super Admin ve datos y los 8 miembros, Admin ve datos y solo su fila, un correo externo no ve nada; `anon` recibe 401. El hook `Before User Created` esta activo (`pg-functions://postgres/public/hook_before_user_created`), el proveedor Azure esta desactivado (quedan Google y correo) y la contraseña minima en Supabase es de 12 caracteres para contraseñas nuevas. No se probo una creacion de cuenta real contra el hook; queda pendiente de confirmar con un correo fuera de la lista.
- Las funciones server-side exigen JWT valido, correo confirmado (`email_confirmed_at`) y acceso a Board segun el rol: lectura para listar documentos/tareas y abrir adjuntos; edicion para crear, editar, borrar, cambiar estado y subir o quitar adjuntos.
- El sitio publica headers de seguridad desde `netlify.toml`: CSP restringida al propio sitio y al proyecto Supabase, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP y `noindex`; `public/robots.txt` bloquea indexacion.

## Secciones de la aplicacion

| Seccion | Funcion actual |
| --- | --- |
| Dashboard | Indicadores, runway proyectado, saldos, cobros vencidos y proximos, concentracion por cliente y grafico mensual. Enlaces rapidos a facturas. |
| Reports | Reporte anual 2026/2027 con facturacion por fecha de factura, facturacion programada, acumulado YTD y MRR/ARR por mes. Cada mes se puede desplegar para ver el desglose por cliente. |
| Investment | Alta, edicion y eliminacion de inversiones con tercero/inversionista, monto y fecha. Muestra el total registrado. |
| Master Clients | Consulta y edicion de clientes y terminos de contrato; alta de cliente con generacion de facturas futuras. |
| Invoice Schedule | Busqueda por cliente/numero, filtros por estado, cliente y año; alta y edicion manual; marcar pagada, deshacer pago y eliminar facturas impagas. |
| Weekly Cash Flow | Vista semanal de 2026 o 2027 con cobros, egresos, neto y saldo proyectado/real. |
| Monthly Summary | Resumen y grafico mensual de cobrado, pendiente, egresos y saldos. |
| Outflow Schedule | Edicion de los egresos mensuales de 2026 por area; 2027 se deriva aplicando la escalacion. |
| Deferred Income | Distribucion mensual del ingreso de cada factura a lo largo de su periodo de servicio; no depende de la fecha de cobro. |
| AR Aging | Cuentas por cobrar no pagadas cuya fecha de factura ya llego, agrupadas por dias respecto de la fecha esperada de pago. |
| Assumptions | Fecha de referencia, caja inicial, escalacion 2027, demora predeterminada visible, descarga JSON y reinicio a los datos iniciales. |

### Board · Legal Docs Series A

La lista actual contiene 13 documentos PDF. Los archivos originales permanecen en almacenamiento privado de Supabase, bucket `board-legal-docs`; no se incluyen en el repositorio ni en el directorio publico del sitio. La funcion server-side `netlify/functions/series-a-documents.cjs` valida el JWT contra Supabase Auth y vuelve a comprobar en `allowed_users` que el miembro tenga acceso (al menos lectura) a Board. Solo despues entrega una URL firmada con vigencia de 5 minutos. El lector usa PDF.js para renderizar la pagina seleccionada en un canvas dentro de Board, con controles de pagina y zoom, y ofrece busqueda por nombre sin un boton de descarga. Las URLs firmadas son credenciales temporales: un usuario autorizado aun podria copiarlas durante su vigencia; el lector no es DRM ni impide capturas o guardado desde las herramientas del navegador. Las funciones leen la URL y la clave anon de Supabase (`SUPABASE_URL`/`SUPABASE_ANON_KEY` o, en su defecto, `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`) y `SUPABASE_SERVICE_ROLE_KEY` desde las variables de entorno del sitio en Netlify; no se empaquetan credenciales con las funciones. En el plan actual de Netlify la clave service role no puede marcarse como secreta, por lo que es visible para quien tenga acceso al panel del sitio; no se expone al navegador porque solo las variables `VITE_` entran al bundle.

### Board · Series A Tasks

 El estado inicial se basa en los follow-ups fechados y obligaciones recurrentes/event-driven de `Celes_Series_A_Closing_Record.pdf`. Cada tarea conserva dueño, fecha o cadencia, fuente contractual, detalles, estado (`Open`, `In progress`, `Done`) y adjuntos. La lista se guarda en `app_state` con ID independiente `board-series-a-tasks`, sin mezclarse con el modelo de Cashflow. Se pueden crear, editar, completar o eliminar tareas. Los adjuntos admiten hasta 25 MB en PDF, Word, Excel, PowerPoint, CSV, TXT e imágenes comunes y se almacenan en el bucket privado `board-legal-docs`; la función `netlify/functions/series-a-tasks.cjs` valida sesión, correo confirmado y allowlist y firma las cargas/lecturas (URLs de lectura de 5 minutos). Solo acepta rutas de adjunto con forma `series-a-tasks/<tarea>/<uuid>-<nombre>` (sin `..`), verifica en Storage que el archivo exista y toma de ahí tipo y tamaño, normaliza el nombre y registra quién subió o editó (`uploadedBy`, `updatedBy`). Las tareas nuevas reciben ID generado por el servidor y las fechas deben tener formato `AAAA-MM-DD`. PDF e imágenes pueden previsualizarse en Board. Las tareas derivadas del closing record son una lista de seguimiento operativo, no asesoría legal; las condiciones y confirmaciones pendientes se conservan en sus detalles.

## Datos y reglas de calculo

El estado compartido contiene `clients`, `invoices`, `investments`, `outflows` y `assumptions`. El respaldo inicial se construye desde `SEED`; las facturas iniciales con monto cero se excluyen y las inversiones inician vacias. La proyeccion cubre enero de 2026 a diciembre de 2027.

- Cada factura tiene cliente, periodo de servicio, fecha de factura, monto, fecha esperada, estado de pago y, si corresponde, fecha real de pago.
- El ingreso se asigna a la fecha real de pago cuando la factura esta pagada y tiene `adate`; de lo contrario, se asigna a la fecha esperada `edate`.
- Los estados son `Paid`, `Overdue`, `Due Soon`, `Issued` y `Scheduled`. La fecha de referencia de Assumptions determina vencidos y proximos a vencer; `Due Soon` significa fecha esperada dentro de los siguientes 30 dias. Por defecto se usa la fecha local actual, se actualiza al abrir/sincronizar y al llegar la medianoche local mientras la app esta abierta. Se puede desactivar `Use current date automatically` para fijar manualmente una fecha.
- Las facturas de un contrato se generan segun su periodicidad (mensual, trimestral, semestral o anual), ARR del año contractual y demora de pago. El monto por factura es el ARR del año dividido por el numero de periodos de facturacion.
- Al crear un cliente se generan facturas que intersectan el horizonte desde 2026 hasta el final de 2027. Al editarlo se puede regenerar el calendario futuro: se reemplazan facturas impagas con fecha de factura desde la fecha de referencia, mientras se conservan las pagadas y las anteriores.
- El flag `active` afecta el conteo de clientes activos y la presentacion de la lista; no impide por si solo que se generen o se proyecten facturas.
- El saldo proyectado suma ingresos programados menos egresos. El saldo real suma solo facturas pagadas menos egresos. Ambos parten de la caja inicial definida en Assumptions.
- Las inversiones se agregan como entradas de efectivo en su fecha. Todas las inversiones dentro del horizonte suman al saldo proyectado; las que ya llegaron a su fecha (no posterior a `today`) tambien suman al saldo real. Se muestran separadas de la facturacion, no alteran cartera, DSO, cobros de clientes ni ingresos diferidos. Las fechas fuera de 2026-2027 se conservan en el registro, pero quedan fuera de los calculos del flujo mostrado.
- Los egresos de 2027 se calculan como el egreso mensual de 2026 multiplicado por `1 + escalation`. En el flujo semanal, el egreso mensual se reparte uniformemente entre los dias del mes.
- AR Aging incluye facturas no pagadas con fecha de factura en o antes de la fecha de referencia. Los grupos se calculan comparando `edate` con esa fecha: vigente, 1-30, 31-60, 61-90 y mas de 90 dias.
- El DSO mostrado es el promedio de dias entre fecha de factura y fecha real de pago, solo para facturas pagadas que tienen fecha real.
- Deferred Income distribuye cada monto de factura uniformemente por los meses aproximados de su periodo de servicio. Es una vista de devengo aproximada, independiente del flujo de caja.
- Reports agrupa facturacion por `idate`. Considera facturado real lo emitido hasta `today` y muestra por separado como programadas las facturas con fecha futura. El YTD suma la facturacion real desde enero hasta el mes de referencia; para un año anterior al de referencia muestra el total anual y para un año futuro queda en cero.
- El MRR de Reports normaliza cada factura por la cantidad aproximada de meses de su periodo (`ps`-`pe`) y suma el valor mensual de las facturas cuyo servicio esta activo durante cada mes del reporte. El ARR mostrado por mes es `MRR × 12`. Son metricas calculadas desde el calendario de facturas y periodos de servicio, no del efectivo recibido; periodos superpuestos pueden sumar varias facturas del mismo cliente.

## Edicion y efectos

### Clientes

El nombre es inmutable desde el formulario de edicion. Se pueden cambiar pais, entidades legales, periodicidad, fechas del contrato, ARR, demora y estado activo. En una edicion, la opcion de regenerar facturas futuras esta activa inicialmente; revisar esa casilla antes de guardar si no se desea reemplazar facturas impagas futuras.

### Facturas

Marcar como pagada establece `adate` a la fecha `assumptions.today`, no necesariamente a la fecha real del sistema. El formulario permite modificar fechas, monto y estado. La accion de eliminar solo aparece para facturas impagas; las pagadas se pueden revertir con `Undo`.

### Inversiones

La seccion `Investment` permite registrar tercero/inversionista, monto positivo y fecha. Las inversiones se pueden editar o eliminar con confirmacion. El cambio se guarda junto al estado compartido existente. Una inversion futura afecta la proyeccion desde su fecha, pero se incorpora al balance real solo cuando la fecha llega; las metricas de cobro de facturas permanecen separadas.

### Reports

El selector permite ver 2026 o 2027. La tabla y el grafico separan importes de facturas emitidas hasta la fecha de referencia de facturas con fecha futura. Cada mes de la tabla se puede expandir para mostrar importes facturados y programados, agrupados por cliente, junto con el numero de facturas. `Billed YTD` acumula solo la facturacion real del año seleccionado hasta el periodo de referencia. MRR representa la tasa mensual normalizada de facturas cuyo servicio cubre ese mes; ARR es su equivalente anual (`MRR × 12`). La tarjeta superior usa el mes de referencia para el año actual, diciembre para un año futuro o diciembre para un año pasado.

### Egresos y supuestos

Los campos de egreso editables son los 12 meses de 2026 para cada area existente. La caja inicial, la fecha de referencia y la escalacion recalculan las vistas derivadas. La fecha actual automatica esta activada por defecto, incluso al cargar estados compartidos creados antes de esta opcion; al desactivarla, la fecha se conserva hasta que se vuelva a activar. `defaultDelay` se muestra como supuesto, pero el formulario actual de nuevo cliente inicializa la demora en 30 dias de forma fija.

### Respaldo y reinicio

`Download backup (JSON)` descarga el estado visible en el navegador. `Reset to Excel data` borra el registro compartido `celes-cashflow-v1` y vuelve a construir el estado inicial desde `SEED`; el autosave posterior puede volver a guardar ese estado como registro compartido.

## Guardado y sincronizacion

- `src/storage.js` carga, guarda y elimina un unico registro JSONB en `app_state`, con id `celes-cashflow-v1`.
- La app intenta cargar el estado compartido al abrir. Si la carga falla o no existe un estado que contenga `clients` e `invoices`, continua con los datos iniciales en memoria.
- Cada cambio del estado se guarda automaticamente con un debounce de 800 ms. Un error de guardado deja la app en memoria y cambia el indicador a no sincronizado.
- `Sync latest changes` vuelve a leer Supabase y, si encuentra estado valido, lo coloca en memoria. Conviene sincronizar antes de editar; una sincronizacion puede reemplazar cambios locales aun no guardados.
- El registro compartido se guarda como un documento completo. No hay bloqueo, fusion de cambios ni historial de versiones: si varias personas editan a la vez, prevalece el ultimo documento guardado.

## Desarrollo y despliegue

Requisitos y comandos de desarrollo/despliegue estan en [README.md](README.md). Para desarrollo local, se usa `npm run dev`; para validar la compilacion, `npm run build`. El cliente necesita `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`. No documentar ni copiar valores secretos en este wiki.

## Historial del wiki

- 2026-10-22: primera version basada en el comportamiento actual de la app, la autenticacion, la persistencia y el esquema de Supabase.
- 2026-10-22: la fecha de referencia se actualiza automaticamente al cargar/sincronizar y cada medianoche local; se puede desactivar para fijar una fecha manual.
- 2026-10-22: se agrego `Investment` para administrar aportes por tercero, monto y fecha, integrados por separado al flujo y saldos proyectados/reales.
- 2026-10-22: se agrego `Reports` con facturacion mensual real/programada, acumulado YTD y MRR/ARR mensual derivados de los periodos de servicio de las facturas.
- 2026-10-22: las filas mensuales de `Reports` se pueden desplegar para consultar el desglose de facturacion real y programada por cliente.
- 2026-10-22: se agrego una portada de modulos con `Cashflow`, `Board` y `People`; `Board` y `People` muestran `En construcción` y Cashflow conserva las secciones existentes.
- 2026-10-22: se incorporo el logo oficial de Celes Technologies en la portada y en la barra lateral de Cashflow mediante un asset local.
- 2026-10-22: se alineo la portada del workspace y los placeholders Board/People con la estetica web de Celes: fondo blanco, tipografia sans y paleta azul marino/azul/verde.
- 2026-10-22: se extendio la identidad visual Celes a Cashflow, con fondo y sidebar claros, acento azul oficial, tipografia sans, estilos compartidos actualizados y navegacion responsive para movil.
- 2026-10-22: Board incorpora `Legal Docs Series A`, lector PDF integrado y 13 archivos en bucket privado Supabase; el acceso se valida en funcion server-side y las URLs firmadas vencen en 15 minutos.
- 2026-10-22: se reemplazo el iframe PDF nativo de Board por PDF.js, con render de pagina en canvas y controles de pagina/zoom para corregir la vista gris en el lector interno.
- 2026-10-22: Board se organizo en subsecciones `Legal Docs Series A`, `Series A Tasks` y `Local entities`, con accesos a Celes (US), Biai (Colombia), Xeles (Mexico) y Celes (Chile); las secciones nuevas muestran estado vacio hasta tener contenido y Board aparece como disponible en la portada.
- 2026-10-22: Series A Tasks se sembró desde el calendario y las obligaciones recurrentes/event-driven de `Celes_Series_A_Closing_Record.pdf`; se añadieron creación/edición/estado y adjuntos privados de hasta 25 MB por tarea.
- 2026-10-22: README actualizado con la estructura de Board y la advertencia de despliegue: las funciones de Board requieren credenciales server-side que hoy solo empaqueta `scripts/deploy-production.mjs`; un build automatico desde GitHub sin variables de entorno las deja en 503 (deducido del codigo, pendiente de confirmar en Netlify).
- 2026-10-22: PDF.js y su worker se cargan bajo demanda al abrir un documento en Board; el bundle principal baja de ~1.38 MB a ~0.89 MB (sin cambios de comportamiento del lector).
- 2026-10-22: endurecimiento de seguridad: SQL de RLS por allowlist y hook de registro (`supabase/security-hardening.sql`, pendiente de ejecutar), headers de seguridad/CSP en `netlify.toml`, robots `noindex`, validacion estricta de rutas y metadatos de adjuntos (corrige traversal que permitia apuntar a otros archivos del bucket), correo confirmado obligatorio, URLs firmadas de 5 minutos, PDF.js sin eval y verificacion de acceso fail-closed en el cliente.
- 2026-10-22: se agrego el modulo `Administración → Miembros` (reemplaza `Team Access` de Cashflow) con roles Super Admin, Admin, Colaborador y Board Member y acceso por modulo (ver/editar), aplicado en RLS, funciones de Board e interfaz (modo solo lectura en Cashflow y Board).
- 2026-10-22: se ejecuto `supabase/security-hardening.sql` en produccion (roles asignados a los 8 miembros existentes); el script ahora elimina cualquier politica previa de `app_state`/`allowed_users` antes de crear las nuevas.
- 2026-10-22: Supabase Auth: hook `Before User Created` activado, proveedor Azure desactivado y contraseña minima de 12 caracteres.
- 2026-10-22: las funciones de Board ya no usan el archivo temporal de credenciales (rompia el build automatico de Netlify desde GitHub); toman las credenciales de las variables de entorno del sitio. `scripts/deploy-production.mjs` ya no genera ese archivo.
- 2026-10-22: las funciones de Netlify pasan a `.cjs` (son CommonJS y el `package.json` declara `"type": "module"`), lo que hacia fallar el build automatico desde GitHub; las rutas `/.netlify/functions/series-a-documents` y `series-a-tasks` no cambian.
